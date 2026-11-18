// End-to-end tests of URL profile defaults and Moli's native CDP settings.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';
const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
const browsers = [];
let proxyHits = 0;
let imageHits = 0;
const requests = [];
const fixture = http.createServer((req, res) => {
  requests.push(req.headers);
  if (req.url === '/image.png') {
    imageHits++;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XKp0AAAAASUVORK5CYII=', 'base64'));
    return;
  }
  if (req.url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("self.addEventListener('install', e => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', e => { if (e.request.url.endsWith('/sw-target')) e.respondWith(new Response('from-worker')); });");
    return;
  }
  if (req.url === '/sw-target') { res.writeHead(200); res.end('from-network'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<html><head><script>window.fixtureScriptRan = true</script></head><body>direct-fixture${req.url === '/with-image' ? '<img src="/image.png">' : ''}</body></html>`);
});
const proxy = http.createServer((_req, res) => {
  proxyHits++;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>proxied-fixture</body></html>');
});
for (const server of [fixture, proxy]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${fixture.address().port}/`;
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
async function connect(params) {
  const browser = await chromium.connectOverCDP(`${endpoint}?${new URLSearchParams(params)}`);
  browsers.push(browser);
  return browser;
}
try {
  const defaults = await connect({ timezone: '', locale: '', 'viewport-width': '', 'max-touch-points': '', proxy: '', 'data-saver': '' });
  const defaultPage = await defaults.contexts()[0].newPage();
  const initial = await defaultPage.evaluate(() => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, language: navigator.language, online: navigator.onLine, webdriver: navigator.webdriver, saveData: navigator.connection.saveData }));
  assert.deepEqual(initial, { width: 1920, height: 1080, screenWidth: 1920, screenHeight: 1080, dpr: 1, touch: 0, language: 'en-US', online: true, webdriver: false, saveData: false });

  const profile = {
    'viewport-width': '1200', 'viewport-height': '800', 'screen-width': '1440', 'screen-height': '900',
    'device-scale-factor': '2', 'screen-orientation': 'landscape-secondary', 'screen-orientation-angle': '180',
    'position-x': '10', 'position-y': '20', touch: 'true', 'max-touch-points': '5', latitude: '35', longitude: '139',
    accuracy: '7', altitude: '123', 'altitude-accuracy': '4', heading: '180', speed: '2',
    'color-scheme': 'dark', 'reduced-motion': 'reduce', 'forced-colors': 'active', contrast: 'more',
    'data-saver': 'true', automation: 'true', platform: 'linux', brand: 'edge', 'platform-version': '6.1.2',
    architecture: 'arm', bitness: '64', 'browser-version': '156.0.1.2', 'accept-language': 'fr-FR,fr;q=0.9',
  };
  const browser = await connect(profile);
  const context = browser.contexts()[0];
  await context.grantPermissions(['geolocation'], { origin: target });
  const page = await context.newPage();
  await page.goto(target);
  const values = await page.evaluate(async () => {
    const location = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(p => resolve(p.coords.toJSON()), reject));
    const hint = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']);
    return { width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio,
      orientation: screen.orientation.type, angle: screen.orientation.angle, x: screenX, y: screenY, touch: navigator.maxTouchPoints,
      dark: matchMedia('(prefers-color-scheme: dark)').matches, motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forced: matchMedia('(forced-colors: active)').matches, contrast: matchMedia('(prefers-contrast: more)').matches,
      saveData: navigator.connection.saveData, webdriver: navigator.webdriver, ua: navigator.userAgent, hint, location };
  });
  assert.deepEqual([values.width, values.height, values.screenWidth, values.screenHeight, values.dpr], [1200, 800, 1440, 900, 2]);
  assert.deepEqual([values.orientation, values.angle, values.x, values.y, values.touch], ['landscape-secondary', 180, 10, 20, 5]);
  assert.deepEqual([values.dark, values.motion, values.forced, values.contrast, values.saveData, values.webdriver], [true, true, true, true, true, true]);
  assert.match(values.ua, /Chrome\/156\.0\.1\.2.*Edg\/156\.0\.1\.2/);
  assert.ok(requests.some(headers => headers['user-agent'] === values.ua && headers['accept-language'] === 'fr-FR,fr;q=0.9'));
  assert.deepEqual([values.hint.platformVersion, values.hint.architecture, values.hint.bitness], ['6.1.2', 'arm', '64']);
  assert.ok(values.hint.fullVersionList.some(x => x.brand === 'Microsoft Edge' && x.version === '156.0.1.2'));
  assert.deepEqual(values.location, { latitude: 35, longitude: 139, accuracy: 7, altitude: 123, altitudeAccuracy: 4, heading: 180, speed: 2 });
  const worker = await page.evaluate(() => new Promise((resolve, reject) => {
    const source = `postMessage({ saveData: navigator.connection.saveData, userAgent: navigator.userAgent });`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = event => resolve(event.data);
    worker.onerror = event => reject(new Error(event.message));
  }));
  assert.equal(worker.saveData, true);
  assert.match(worker.userAgent, /Chrome\/156\.0\.1\.2.*Edg\/156\.0\.1\.2/);
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches), true, 'client may override URL media default');

  const noScript = await connect({ javascript: 'false' });
  const silentPage = await noScript.contexts()[0].newPage();
  await silentPage.goto(target);
  assert.equal(await silentPage.evaluate(() => window.fixtureScriptRan ?? false), false);

  const proxied = await connect({ proxy: proxyUrl });
  const proxyPage = await proxied.contexts()[0].newPage();
  await proxyPage.goto(target);
  assert.equal(await proxyPage.locator('body').innerText(), 'proxied-fixture');
  const before = proxyHits;
  assert.ok(before > 0);
  const bypassed = await connect({ proxy: proxyUrl, 'proxy-bypass': '127.0.0.1' });
  const bypassPage = await bypassed.contexts()[0].newPage();
  await bypassPage.goto(target);
  assert.equal(await bypassPage.locator('body').innerText(), 'direct-fixture');
  assert.equal(proxyHits, before);

  const customUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.2.3.4 Safari/537.36 Edg/121.2.3.4';
  const customBrowser = await connect({ 'user-agent': customUa, 'platform-version': '6.8.0', model: 'TestModel', wow64: 'true',
    'form-factors': 'Desktop,Tablet', 'ua-brands': JSON.stringify([{ brand: 'MyBrowser', version: '121' }]),
    'ua-full-version-list': JSON.stringify([{ brand: 'Microsoft Edge', version: '121.2.3.4' }, { brand: 'MyBrowser', version: '121.2.3.4' }]) });
  const customPage = await customBrowser.contexts()[0].newPage();
  await customPage.goto(target);
  const customIdentity = await customPage.evaluate(async () => ({
    ua: navigator.userAgent, platform: navigator.platform,
    metadata: await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'wow64', 'fullVersionList', 'formFactors']),
  }));
  assert.equal(customIdentity.ua, customUa);
  assert.equal(customIdentity.platform, 'Linux x86_64');
  assert.equal(customIdentity.metadata.model, 'TestModel');
  assert.equal(customIdentity.metadata.platformVersion, '6.8.0');
  assert.equal(customIdentity.metadata.wow64, true);
  assert.deepEqual(customIdentity.metadata.formFactors, ['Desktop', 'Tablet']);
  assert.deepEqual(customIdentity.metadata.brands, [{ brand: 'MyBrowser', version: '121' }]);
  assert.ok(customIdentity.metadata.fullVersionList.some(entry => entry.brand === 'Microsoft Edge' && entry.version === '121.2.3.4'));

  const offline = await connect({ offline: 'true', 'bypass-service-worker': 'true' });
  const offlinePage = await offline.contexts()[0].newPage();
  assert.equal(await offlinePage.evaluate(() => navigator.onLine), false);
  await assert.rejects(() => offlinePage.goto(target), /net::ERR|failed|offline/i);

  await defaults.close();
  const resources = await connect({ 'load-resources': 'false', 'load-images': 'true' });
  const resourcesPage = await resources.contexts()[0].newPage();
  const beforeImages = imageHits;
  await resourcesPage.goto(`${target}with-image`);
  assert.ok(imageHits > beforeImages, 'individual resource override should enable images');
  await resources.close();
  const noImages = await connect({ 'load-images': 'false' });
  const noImagesPage = await noImages.contexts()[0].newPage();
  const beforeDisabled = imageHits;
  await noImagesPage.goto(`${target}with-image`);
  assert.equal(imageHits, beforeDisabled, 'disabled images should not be requested');
  await noImages.close();
  const minimal = await connect({ layout: 'false', subframes: 'false' });
  const minimalPage = await minimal.contexts()[0].newPage();
  await minimalPage.goto('data:text/html,<iframe srcdoc="hello"></iframe>');
  assert.equal(minimalPage.frames().length, 1);
  await assert.rejects(() => minimalPage.screenshot(), /layout is disabled/);
  await minimal.close();

  for (const bypass of [false, true]) {
    const workerBrowser = await connect({ 'bypass-service-worker': String(bypass) });
    const workerPage = await workerBrowser.contexts()[0].newPage();
    await workerPage.goto(target);
    await workerPage.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
    await workerPage.reload();
    assert.equal(await workerPage.evaluate(() => fetch('/sw-target').then(response => response.text())), bypass ? 'from-network' : 'from-worker');
    await workerBrowser.close();
  }

  for (const query of ['latitude=0', 'accuracy=7', 'screen-width=100&viewport-width=200', 'max-touch-points=17', 'touch=false&max-touch-points=2', 'proxy=file%3A%2F%2F%2Fetc%2Fpasswd', 'user-agent=x%0Ay', 'locale=&locale=fr-FR', 'layout=false&scrollbars=visible']) {
    const response = await fetch(`${endpoint}/json/version?${query}`);
    assert.equal(response.status, 400, query);
  }
  console.log('PASS empty defaults, native geometry, geolocation, touch, UA hints, media, JavaScript, proxy and validation');
} finally {
  await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
  for (const server of [fixture, proxy]) await new Promise(resolve => server.close(resolve));
}
