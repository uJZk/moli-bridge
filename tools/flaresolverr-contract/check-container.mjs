// Run on stdin inside the appropriate service container with Node.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from '/app/node_modules/playwright-core/index.mjs';

const role = process.env.MOLI_MODE ?? 'bridge';
const fixture = http.createServer((request, response) => {
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
      assert.ok((await call({ cmd: 'sessions.list' })).sessions.includes(first.session));
      console.log('PASS bridge container: session lifecycle, cookie isolation, headers, GET and POST');
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
      console.log('PASS CDP container: connection, local navigation and URL profile');
    } finally { await browser.close(); }
  } else throw new Error('Unknown role');
} finally {
  await new Promise(resolve => fixture.close(resolve));
}
