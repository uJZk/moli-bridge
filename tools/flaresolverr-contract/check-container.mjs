// Run on stdin inside the appropriate service container with Node.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from '/app/node_modules/playwright-core/index.mjs';

const role = process.env.MOLI_TEST_ROLE ?? process.env.MOLI_MODE ?? 'bridge';
let clearanceHits = 0;
let ddosClearanceHits = 0;
const dataDomeHits = new Map();
let disconnectStarted = false;
const fixture = http.createServer((request, response) => {
  if (request.url === '/hold-disconnect') { disconnectStarted = true; return; }
  if (request.url === '/keyboard') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<button>Before</button><iframe src="/keyboard-child"></iframe><script>window.addEventListener("message",e=>{if(e.data==="activated")document.body.dataset.activated="yes"})</script>');
    return;
  }
  if (request.url === '/keyboard-child') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<button onclick="parent.postMessage(&quot;activated&quot;,&quot;*&quot;)">Activate</button>');
    return;
  }
  if (request.url === '/cf-error-entry') {
    response.writeHead(302, { location: '/cdn-cgi/error/1020' }); response.end(); return;
  }
  if (request.url === '/cdn-cgi/error/1020') {
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Working</title><body>blocked</body>'); return;
  }
  if (request.url === '/cf-query?error=1015') {
    response.writeHead(429, { 'content-type': 'text/html', 'cf-ray': 'fixture' }); response.end('<title>Working</title><body>rate limited</body>'); return;
  }
  if (request.url === '/ordinary-query?error=1020') {
    response.writeHead(200, { 'content-type': 'text/html', 'cf-ray': 'fixture' }); response.end('<title>Ready</title><body>ordinary search</body>'); return;
  }
  if (request.url === '/ddos-cookie-wall') {
    ddosClearanceHits++;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.headers.cookie?.includes('__ddg2_fixture=fresh')
      ? '<title>Ready</title><body>ddos clearance recovered</body>'
      : '<title>Please wait</title><h1 id="ddg-l10n-title">Checking</h1><script>setTimeout(()=>{document.cookie="__ddg2_fixture=fresh; path=/"},100)</script>');
    return;
  }
  if (request.url === '/cookie-wall') {
    clearanceHits++;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.headers.cookie?.includes('cf_clearance=container-fresh')
      ? '<title>Ready</title><body>clearance recovered</body>'
      : '<title>Just a moment...</title><script>setTimeout(()=>{document.cookie="cf_clearance=container-fresh; path=/"},100)</script>');
    return;
  }
  if (request.url === '/frame-wall' || request.url === '/frame-wall-closed') {
    response.writeHead(200, { 'content-type': 'text/html' });
    const source = request.url === '/frame-wall-closed' ? 'closed' : 'frame';
    response.end(`<title>Just a moment...</title><iframe src="/cdn-cgi/challenge-platform/${source}"></iframe><script>window.addEventListener("message",e=>{if(e.data==="frame-cleared"){document.title="Ready";document.querySelector("iframe").remove();document.body.append(" frame cleared")}})</script>`);
    return;
  }
  if (request.url === '/cdn-cgi/challenge-platform/frame') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<input type="checkbox" onclick="parent.postMessage(&quot;frame-cleared&quot;,&quot;*&quot;)">');
    return;
  }
  if (request.url === '/cdn-cgi/challenge-platform/closed') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<div id="host"></div><script>const r=document.getElementById("host").attachShadow({mode:"closed"});r.innerHTML="<input type=checkbox>";r.querySelector("input").addEventListener("click",()=>parent.postMessage("frame-cleared","*"))</script>');
    return;
  }
  if (request.url === '/header-wall') {
    response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    response.end('<title>Working</title><body>header-only wall</body>');
    return;
  }
  if (['/dd-header-wall', '/dd-header-redirect', '/dd-header-ordinary'].includes(request.url)) {
    const ordinary = request.url === '/dd-header-ordinary';
    const redirect = request.url === '/dd-header-redirect';
    response.writeHead(ordinary ? 200 : 403, { 'content-type': 'text/html', [ordinary ? 'x-datadome' : 'x-dd-b']: '1' });
    response.end(`<title>Ready</title><body>${ordinary ? 'ordinary DataDome header' : 'DataDome interstitial'}${redirect ? '<script>setTimeout(() => location.href="/final", 750)</script>' : ''}</body>`);
    return;
  }
  if (['/dd-hard-header', '/dd-hard-no-header', '/dd-hard-ordinary'].includes(request.url)) {
    const ordinary = request.url === '/dd-hard-ordinary';
    response.writeHead(ordinary ? 200 : 403, { 'content-type': 'text/html', ...(request.url === '/dd-hard-header' ? { 'x-dd-b': '2' } : {}) });
    response.end('<title>Ready</title><body>DataDome fixture<script>var dd={"rt":"c","t":"bv","host":"geo.captcha-delivery.com"}</script></body>');
    return;
  }
  if (['/dd-device-recovery', '/dd-device-stale', '/dd-device-captcha', '/dd-device-post'].includes(request.url)) {
    dataDomeHits.set(request.url, (dataDomeHits.get(request.url) ?? 0) + 1);
    if (request.url === '/dd-device-recovery' && request.headers.cookie?.includes('datadome=fresh')) {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Ready</title><body>DataDome recovery succeeded</body>'); return;
    }
    const kind = request.url === '/dd-device-captcha' ? 'c' : 'i';
    const setCookie = request.url === '/dd-device-stale' ? '' : 'setTimeout(() => {document.cookie="datadome=fresh; path=/";},100);';
    response.writeHead(403, { 'content-type': 'text/html', 'x-dd-b': '1' });
    response.end(`<title>Ready</title><body><script>var dd={"rt":"${kind}","host":"geo.captcha-delivery.com"};${setCookie}</script></body>`);
    return;
  }
  if (['/aws-script-wall', '/aws-script-transient', '/aws-script-captcha', '/aws-script-ordinary'].includes(request.url)) {
    const isCaptcha = request.url === '/aws-script-captcha' || request.url === '/aws-script-ordinary';
    const transient = request.url === '/aws-script-transient';
    const ordinary = request.url === '/aws-script-ordinary';
    const script = isCaptcha ? 'captcha' : 'challenge';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<html><head><title>Ready</title><script id="waf-config">window.gokuProps = { key: 'fixture' };</script><script id="waf-script" type="application/json" src="https://fixture.token.awswaf.com/test/${script}.js"></script></head><body>${ordinary ? '<main>Ordinary sign-in</main>' : ''}<script>document.getElementById('waf-script').removeAttribute('type');${transient ? "setTimeout(() => { document.getElementById('waf-config').remove(); document.getElementById('waf-script').remove(); document.body.append(' AWS challenge cleared'); }, 1200);" : ''}</script></body></html>`);
    return;
  }
  if (request.url === '/challenge') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Just a moment...</title><script>setTimeout(() => location.href="/final",100)</script>');
    return;
  }
  if (request.url === '/normal-redirect') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Ready</title><body>initial content<script>setTimeout(() => location.href="/final",350)</script></body>');
    return;
  }
  if (request.url === '/meta-refresh') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Ready</title><meta http-equiv="refresh" content="1;url=/final"><body>intermediate</body>');
    return;
  }
  if (request.url === '/ddos-wall') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Ready</title><h1 id="ddg-l10n-title">Checking</h1>');
    return;
  }
  if (request.url === '/final') {
    response.writeHead(201, { 'content-type': 'text/html', 'set-cookie': 'final=ok; Path=/' });
    response.end('<title>Ready</title><body>final content</body>');
    return;
  }
  if (request.url === '/post') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<body>post=${body}</body>`); });
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html', ...(request.url === '/set' ? { 'set-cookie': 'container_test=retained; Path=/; HttpOnly' } : {}) });
  response.end(`<html><body>cookie=${request.headers.cookie ?? ''}; header=${request.headers['x-test'] ?? ''}</body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${fixture.address().port}`;
try {
  if (role === 'bridge') {
    const call = async body => {
      const response = await fetch('http://127.0.0.1:8191/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    };
    const invalidSession = `invalid_${Date.now()}`;
    const invalidGet = await call({ cmd: 'request.get', session: invalidSession, url: target, postData: 'unexpected' });
    const invalidPost = await call({ cmd: 'request.post', session: invalidSession, url: target });
    assert.equal(invalidGet.status, 'error'); assert.match(invalidGet.message, /postData/);
    assert.equal(invalidPost.status, 'error'); assert.match(invalidPost.message, /postData/);
    assert.ok(!(await call({ cmd: 'sessions.list' })).sessions.includes(invalidSession));
    const first = await call({ cmd: 'sessions.create' });
    const second = await call({ cmd: 'sessions.create' });
    assert.equal(first.status, 'ok'); assert.equal(second.status, 'ok');
    try {
      const set = await call({ cmd: 'request.get', session: first.session, url: `${target}/set`, headers: { 'X-Test': 'ok' } });
      assert.equal(set.status, 'ok', set.message);
      assert.match(set.solution.response, /header=ok/);
      assert.ok(set.solution.cookies.some(cookie => cookie.name === 'container_test'));
      const a = await call({ cmd: 'request.get', session: first.session, url: `${target}/echo` });
      const b = await call({ cmd: 'request.get', session: second.session, url: `${target}/echo` });
      assert.match(a.solution.response, /container_test=retained/);
      assert.doesNotMatch(b.solution.response, /container_test=retained/);
      const post = await call({ cmd: 'request.post', session: first.session, url: `${target}/post`, postData: 'answer=test' });
      assert.equal(post.status, 'ok', post.message);
      assert.match(post.solution.response, /post=answer=test/);
      const redirected = await call({ cmd: 'request.get', session: first.session, url: `${target}/challenge`, maxTimeout: 10000 });
      assert.equal(redirected.status, 'ok', redirected.message);
      assert.equal(redirected.solution.status, 201);
      assert.match(redirected.solution.url, /\/final$/);
      assert.match(redirected.solution.response, /final content/);
      assert.ok(redirected.solution.cookies.some(cookie => cookie.name === 'final' && cookie.value === 'ok'));
      const delayedRedirect = await call({ cmd: 'request.get', session: first.session, url: `${target}/normal-redirect`, maxTimeout: 10000 });
      assert.equal(delayedRedirect.status, 'ok', delayedRedirect.message);
      assert.equal(delayedRedirect.solution.status, 201);
      assert.match(delayedRedirect.solution.url, /\/final$/);
      assert.match(delayedRedirect.solution.response, /final content/);
      const metaRedirect = await call({ cmd: 'request.get', session: first.session, url: `${target}/meta-refresh`, maxTimeout: 10000 });
      assert.equal(metaRedirect.status, 'ok', metaRedirect.message);
      assert.equal(metaRedirect.solution.status, 201);
      assert.match(metaRedirect.solution.url, /\/final$/);
      const ddosWall = await call({ cmd: 'request.get', url: `${target}/ddos-wall`, maxTimeout: 1200 });
      assert.equal(ddosWall.status, 'error', JSON.stringify(ddosWall));
      assert.match(ddosWall.message, /timeout/i);
      const ddosRecovered = await call({ cmd: 'request.get', url: `${target}/ddos-cookie-wall`, maxTimeout: 15000 });
      assert.equal(ddosRecovered.status, 'ok', ddosRecovered.message);
      assert.match(ddosRecovered.solution.response, /ddos clearance recovered/);
      assert.equal(ddosClearanceHits, 2);
      const frameWall = await call({ cmd: 'request.get', url: `${target}/frame-wall`, maxTimeout: 15000 });
      assert.equal(frameWall.status, 'ok', frameWall.message);
      assert.match(frameWall.solution.response, /frame cleared/);
      const closedWall = await call({ cmd: 'request.get', url: `${target}/frame-wall-closed`, maxTimeout: 15000 });
      assert.equal(closedWall.status, 'ok', closedWall.message);
      assert.match(closedWall.solution.response, /frame cleared/);
      const recovered = await call({ cmd: 'request.get', url: `${target}/cookie-wall`, maxTimeout: 15000 });
      assert.equal(recovered.status, 'ok', recovered.message);
      assert.match(recovered.solution.response, /clearance recovered/);
      assert.equal(clearanceHits, 2);
      const wall = await call({ cmd: 'request.get', url: `${target}/header-wall`, maxTimeout: 1200 });
      assert.equal(wall.status, 'error', JSON.stringify(wall));
      assert.match(wall.message, /timeout/i);
      const ddWall = await call({ cmd: 'request.get', url: `${target}/dd-header-wall`, maxTimeout: 1200 });
      assert.equal(ddWall.status, 'error', JSON.stringify(ddWall));
      assert.match(ddWall.message, /timeout/i);
      const ddRedirect = await call({ cmd: 'request.get', url: `${target}/dd-header-redirect`, maxTimeout: 8000 });
      assert.equal(ddRedirect.status, 'ok', ddRedirect.message);
      assert.match(ddRedirect.solution.url, /\/final$/);
      assert.match(ddRedirect.solution.response, /final content/);
      const ddOrdinary = await call({ cmd: 'request.get', url: `${target}/dd-header-ordinary`, maxTimeout: 5000 });
      assert.equal(ddOrdinary.status, 'ok', ddOrdinary.message);
      assert.match(ddOrdinary.solution.response, /ordinary DataDome header/);
      for (const path of ['/dd-hard-header', '/dd-hard-no-header']) {
        const blocked = await call({ cmd: 'request.get', url: `${target}${path}`, maxTimeout: 5000 });
        assert.equal(blocked.status, 'error', JSON.stringify(blocked));
        assert.match(blocked.message, /DataDome hard block/i);
      }
      const ddPostBlocked = await call({ cmd: 'request.post', url: `${target}/dd-hard-header`, postData: 'fixture', maxTimeout: 5000 });
      assert.equal(ddPostBlocked.status, 'error', JSON.stringify(ddPostBlocked));
      assert.match(ddPostBlocked.message, /DataDome hard block/i);
      const ddHardOrdinary = await call({ cmd: 'request.get', url: `${target}/dd-hard-ordinary`, maxTimeout: 5000 });
      assert.equal(ddHardOrdinary.status, 'ok', ddHardOrdinary.message);
      const ddRecovered = await call({ cmd: 'request.get', url: `${target}/dd-device-recovery`, maxTimeout: 12000 });
      assert.equal(ddRecovered.status, 'ok', ddRecovered.message);
      assert.match(ddRecovered.solution.response, /DataDome recovery succeeded/);
      assert.equal(dataDomeHits.get('/dd-device-recovery'), 2);
      const ddStale = await call({ cmd: 'request.get', url: `${target}/dd-device-stale`, maxTimeout: 4200,
        cookies: [{ name: 'datadome', value: 'old' }] });
      assert.equal(ddStale.status, 'error', JSON.stringify(ddStale));
      assert.match(ddStale.message, /timeout/i);
      assert.equal(dataDomeHits.get('/dd-device-stale'), 1);
      const ddCaptcha = await call({ cmd: 'request.get', url: `${target}/dd-device-captcha`, maxTimeout: 4200 });
      assert.equal(ddCaptcha.status, 'error', JSON.stringify(ddCaptcha));
      assert.match(ddCaptcha.message, /timeout/i);
      assert.equal(dataDomeHits.get('/dd-device-captcha'), 1);
      const ddDevicePost = await call({ cmd: 'request.post', url: `${target}/dd-device-post`, postData: 'fixture', maxTimeout: 4200 });
      assert.equal(ddDevicePost.status, 'error', JSON.stringify(ddDevicePost));
      assert.match(ddDevicePost.message, /timeout/i);
      assert.equal(dataDomeHits.get('/dd-device-post'), 1);
      for (const path of ['/cf-error-entry', '/cf-query?error=1015']) {
        const blocked = await call({ cmd: 'request.get', url: `${target}${path}`, maxTimeout: 5000 });
        assert.equal(blocked.status, 'error', JSON.stringify(blocked));
        assert.match(blocked.message, /denied access/i);
      }
      const ordinaryQuery = await call({ cmd: 'request.get', url: `${target}/ordinary-query?error=1020`, maxTimeout: 5000 });
      assert.equal(ordinaryQuery.status, 'ok', ordinaryQuery.message);
      assert.match(ordinaryQuery.solution.response, /ordinary search/);
      const awsWall = await call({ cmd: 'request.get', url: `${target}/aws-script-wall`, maxTimeout: 1200 });
      assert.equal(awsWall.status, 'error', JSON.stringify(awsWall));
      assert.match(awsWall.message, /timeout/i);
      const awsCaptcha = await call({ cmd: 'request.get', url: `${target}/aws-script-captcha`, maxTimeout: 5000 });
      assert.equal(awsCaptcha.status, 'error', JSON.stringify(awsCaptcha));
      assert.match(awsCaptcha.message, /AWS WAF CAPTCHA/i);
      const awsTransient = await call({ cmd: 'request.get', url: `${target}/aws-script-transient`, maxTimeout: 8000 });
      assert.equal(awsTransient.status, 'ok', awsTransient.message);
      assert.match(awsTransient.solution.response, /AWS challenge cleared/);
      const awsOrdinary = await call({ cmd: 'request.get', url: `${target}/aws-script-ordinary`, maxTimeout: 5000 });
      assert.equal(awsOrdinary.status, 'ok', awsOrdinary.message);
      assert.match(awsOrdinary.solution.response, /Ordinary sign-in/);
      const disconnectSession = await call({ cmd: 'sessions.create' });
      assert.equal(disconnectSession.status, 'ok', disconnectSession.message);
      try {
        const controller = new AbortController();
        const interrupted = fetch('http://127.0.0.1:8191/v1', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ cmd: 'request.get', session: disconnectSession.session, url: `${target}/hold-disconnect`, maxTimeout: 30000 }),
        }).catch(() => {});
        for (let i = 0; i < 100 && !disconnectStarted; i++) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(disconnectStarted, true, 'disconnect fixture must receive the browser request');
        controller.abort();
        await interrupted;
        let removed = false;
        for (let i = 0; i < 100 && !removed; i++) {
          removed = !(await call({ cmd: 'sessions.list' })).sessions.includes(disconnectSession.session);
          if (!removed) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(removed, true, 'disconnect must retire the active session');
      } finally {
        await call({ cmd: 'sessions.destroy', session: disconnectSession.session });
      }
      assert.ok((await call({ cmd: 'sessions.list' })).sessions.includes(first.session));
      console.log('PASS bridge container: sessions, POST, challenges, redirects and disconnect cleanup');
    } finally {
      await call({ cmd: 'sessions.destroy', session: first.session });
      await call({ cmd: 'sessions.destroy', session: second.session });
    }
  } else if (role === 'cdp') {
    const params = new URLSearchParams({ timezone: 'Asia/Shanghai', locale: 'zh-CN', platform: 'windows', brand: 'Edge', 'hardware-concurrency': '10', 'viewport-width': '1280', 'screen-width': '1440' });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:9222?${params}`);
    try {
      const page = await browser.contexts()[0].newPage();
      await page.goto(target);
      const state = await page.evaluate(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, platform: navigator.platform, userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, width: innerWidth, screen: screen.width }));
      assert.equal(state.timezone, 'Asia/Shanghai'); assert.equal(state.language, 'zh-CN');
      assert.equal(state.platform, 'Win32'); assert.match(state.userAgent, /\bEdg\//);
      assert.equal(state.cores, 10); assert.equal(state.width, 1280); assert.equal(state.screen, 1440);
      await page.goto(`${target}/keyboard`);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.body.dataset.activated === 'yes');
      console.log('PASS CDP container: connection, URL profile and iframe keyboard navigation');
    } finally { await browser.close(); }
    const launch = { args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=0,0'], headless: true, stealth: true };
    const rsshubEndpoint = new URL('ws://127.0.0.1:9222/chromium');
    rsshubEndpoint.searchParams.set('launch', JSON.stringify(launch));
    const rsshub = await chromium.connectOverCDP(rsshubEndpoint.href);
    try {
      const context = await rsshub.newContext({ userAgent: 'RSSHub-container-test' });
      const page = await context.newPage();
      await page.goto(target);
      assert.equal(await page.evaluate(() => navigator.userAgent), 'RSSHub-container-test');
      assert.equal(await page.evaluate(() => navigator.webdriver), false);
      console.log('PASS CDP container: RSSHub-style direct WebSocket launch');
    } finally { await rsshub.close(); }
  } else throw new Error('Unknown role');
} finally {
  await new Promise(resolve => fixture.close(resolve));
}
