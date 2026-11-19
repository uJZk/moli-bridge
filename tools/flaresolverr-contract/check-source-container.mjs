// Run inside a disposable, network-isolated bridge container using a mounted Moli binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '/app/node_modules/playwright-core/index.mjs';

const role = process.env.MOLI_MODE;
if (!['bridge', 'cdp'].includes(role)) throw new Error('MOLI_MODE must be bridge or cdp');
const fixture = http.createServer((request, response) => {
  if (request.url === '/start') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Ready</title><script>setTimeout(() => location.href="/final",100)</script>');
  } else if (request.url === '/final') {
    response.writeHead(201, { 'content-type': 'text/html', 'set-cookie': 'fixture=ok; Path=/', 'x-final': 'yes' });
    response.end('<title>Ready</title><body>final page</body>');
  } else if (request.url === '/cdn-cgi/challenge-platform/keyboard') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<button onclick="parent.postMessage(&quot;verified&quot;,&quot;*&quot;)">Verify</button>');
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<title>${request.url === '/wall' ? 'Just a moment...' : 'Ready'}</title><input type="hidden" name="cf-turnstile-response"><iframe src="/cdn-cgi/challenge-platform/keyboard"></iframe><script>window.addEventListener('message',e=>{if(e.data==='verified'){document.title='Ready';document.body.append(' keyboard verified');document.querySelector('iframe').remove();}})</script>`);
  }
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const port = role === 'bridge' ? 8191 : 9222;
const env = { ...process.env, BRIDGE_HOST: '127.0.0.1', CDP_HOST: '127.0.0.1', BRIDGE_PORT: '8191', CDP_PORT: '9222' };
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[name];
const child = spawn(process.execPath, [role === 'bridge' ? '/app/server.mjs' : '/app/cdp-gateway.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostics = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Service exited: ${diagnostics}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(50);
  }
  assert.ok(ready, `service did not become ready: ${diagnostics}`);
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  if (role === 'bridge') {
    const call = async path => (await fetch(`http://127.0.0.1:${port}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: origin + path, maxTimeout: 18000 }) })).json();
    const final = await call('/start');
    assert.equal(final.status, 'ok', final.message);
    assert.equal(final.solution.status, 201);
    assert.equal(final.solution.headers['x-final'], 'yes');
    assert.ok(final.solution.cookies.some(cookie => cookie.name === 'fixture' && cookie.value === 'ok'));
    const wall = await call('/wall');
    assert.equal(wall.status, 'ok', wall.message);
    assert.match(wall.solution.response, /keyboard verified/);
  } else {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await browser.contexts()[0].newPage();
    await page.goto(`${origin}/page`);
    await page.keyboard.press('Tab'); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.body.textContent.includes('keyboard verified'), undefined, { timeout: 5000 });
  }
  console.log(`PASS source Moli container ${role}: ${role === 'bridge' ? 'navigation, response and keyboard challenge' : 'CDP iframe keyboard'}`);
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
