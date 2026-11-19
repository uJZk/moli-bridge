// Exercise RSSHub's Browserless-style CDP launch with a disposable gateway.
// Set RSSHUB_PATCHRIGHT_PATH to RSSHub's installed patchright/index.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const clientPath = process.env.RSSHUB_PATCHRIGHT_PATH;
if (!clientPath) throw new Error('Set RSSHUB_PATCHRIGHT_PATH to the RSSHub patchright index.mjs');
const { chromium } = await import(pathToFileURL(clientPath).href);
const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
let redirectLeaks = 0;
const fixture = http.createServer((req, res) => {
  if (req.url === '/replay-redirect') {
    req.resume();
    res.writeHead(307, { location: '/redirect-target' });
    res.end();
    return;
  }
  if (req.url === '/redirect-target') {
    redirectLeaks++;
    res.writeHead(200); res.end('unexpected');
    return;
  }
  if (req.url === '/replay') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-fixture': 'response-header' });
      res.end(JSON.stringify({ method: req.method, header: req.headers['x-fixture'], body }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><main>rsshub fixture</main><script>window.__rsshub_fixture=123;document.body.setAttribute("data-script-ran","yes")</script></body></html>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
let proxyHits = 0;
const proxy = http.createServer((req, res) => {
  if (req.url !== 'http://rsshub-fixture.invalid/') { res.writeHead(403); res.end(); return; }
  proxyHits++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><main>proxied rsshub fixture</main></body></html>');
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${fixture.address().port}/`;
const launch = { args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=0,0'], headless: true, stealth: true };
const browsers = [];
try {
  for (const mode of ['http', 'ws-chromium', 'ws-root']) {
    const direct = mode !== 'http';
    const url = new URL(endpoint);
    if (direct) { url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = mode === 'ws-root' ? '/' : '/chromium'; }
    url.searchParams.set('launch', JSON.stringify(launch));
    const browser = await chromium.connectOverCDP(url.href, { timeout: 15000 });
    browsers.push(browser);
    const context = await browser.newContext({ userAgent: 'RSSHub-compat-test', javaScriptEnabled: !direct });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('main').textContent(), 'rsshub fixture');
    assert.equal(await page.evaluate(() => navigator.userAgent), 'RSSHub-compat-test');
    assert.equal(await page.evaluate(() => navigator.webdriver), false);
    assert.equal(await page.locator('body').getAttribute('data-script-ran'), direct ? null : 'yes');
    // RSSHub's Patchright evaluates in an isolated world, as on Chromium.
    assert.equal(await page.evaluate(() => window.__rsshub_fixture), undefined);
  }
  const invalidUrl = new URL(endpoint);
  invalidUrl.protocol = invalidUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  invalidUrl.pathname = '/chromium';
  invalidUrl.searchParams.set('launch', JSON.stringify({ ...launch, args: ['--proxy-pac-url=http://fixture.invalid/pac'] }));
  await assert.rejects(chromium.connectOverCDP(invalidUrl.href, { timeout: 5000 }));
  // RSSHub playwright-fetch.ts uses raw CDP Fetch interception for its retry.
  const replayContext = browsers[1].contexts().at(-1);
  const replayPage = await replayContext.newPage();
  const session = await replayContext.newCDPSession(replayPage);
  const { frameTree } = await session.send('Page.getFrameTree');
  const replayUrl = `${target}replay`;
  let replayed = false;
  let handlerError;
  session.on('Fetch.requestPaused', event => {
    const handle = async () => {
      if (replayed || event.redirectedRequestId || event.resourceType !== 'Document' || event.frameId !== frameTree.frame.id || event.request.url !== replayUrl) {
        await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      replayed = true;
      await session.send('Fetch.continueRequest', {
        requestId: event.requestId, method: 'POST',
        headers: [{ name: 'content-type', value: 'application/x-www-form-urlencoded' }, { name: 'x-fixture', value: 'replay-header' }],
        postData: Buffer.from('answer=hello%20world').toString('base64'),
      });
    };
    void handle().catch(error => { handlerError = error; });
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: false });
  const replayResponse = await replayPage.goto(replayUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
  if (handlerError) throw handlerError;
  assert.ok(replayed);
  assert.equal(replayResponse.status(), 201);
  assert.equal((await replayResponse.headersArray()).find(header => header.name.toLowerCase() === 'x-fixture')?.value, 'response-header');
  assert.deepEqual(JSON.parse((await replayResponse.body()).toString()), { method: 'POST', header: 'replay-header', body: 'answer=hello%20world' });
  await session.detach();
  await replayPage.close();

  // RSSHub rejects redirected replay hops so credentials and form bodies stay on the original URL.
  const redirectPage = await replayContext.newPage();
  const redirectSession = await replayContext.newCDPSession(redirectPage);
  const redirectUrl = `${target}replay-redirect`;
  let redirectSeen = false;
  let firstSeen = false;
  let redirectHandlerError;
  redirectSession.on('Fetch.requestPaused', event => {
    const handle = async () => {
      if (event.redirectedRequestId || firstSeen || event.request.url !== redirectUrl) {
        redirectSeen = Boolean(event.redirectedRequestId);
        await redirectSession.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      firstSeen = true;
      await redirectSession.send('Fetch.continueRequest', { requestId: event.requestId, method: 'POST',
        headers: [{ name: 'x-fixture', value: 'private-header' }], postData: Buffer.from('private-form').toString('base64') });
    };
    void handle().catch(error => { redirectHandlerError = error; });
  });
  await redirectSession.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: false });
  await redirectPage.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  if (redirectHandlerError) throw redirectHandlerError;
  assert.equal(firstSeen, true);
  assert.equal(redirectSeen, true, 'redirect request was not exposed to the RSSHub guard');
  assert.equal(redirectLeaks, 0, 'redirect target received the replayed request');
  await redirectSession.detach();
  await redirectPage.close();
  const proxied = new URL(endpoint);
  proxied.searchParams.set('launch', JSON.stringify({ ...launch, args: [...launch.args, `--proxy-server=http://127.0.0.1:${proxy.address().port}`] }));
  const proxyBrowser = await chromium.connectOverCDP(proxied.href, { timeout: 15000 });
  browsers.push(proxyBrowser);
  const proxyContext = await proxyBrowser.newContext();
  const proxyPage = await proxyContext.newPage();
  await proxyPage.goto('http://rsshub-fixture.invalid/', { waitUntil: 'domcontentloaded' });
  assert.equal(await proxyPage.locator('main').textContent(), 'proxied rsshub fixture');
  assert.ok(proxyHits > 0, 'request did not reach the proxy specified in launch args');
  await browsers[0].close();
  const other = browsers[1].contexts().at(-1).pages()[0];
  assert.equal(await other.locator('main').textContent(), 'rsshub fixture');
  console.log('PASS RSSHub Patchright HTTP and direct WebSocket CDP launch, contexts, UA, JavaScript, Fetch replay, proxy and isolation');
} finally {
  await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
  await Promise.all([new Promise(resolve => fixture.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
}
