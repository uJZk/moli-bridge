// Compare automatic challenge-frame keyboard delivery in Moli and optional Chromium.
// The local frame is allowlisted as a same-origin challenge frame; no external site is contacted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';
import { clickAutomaticVerify } from '../../flaresolverr-bridge/upstream/verify.mjs';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const root = path.resolve(import.meta.dirname, '../..');
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/cdn-cgi/challenge-platform/keyboard') {
    res.end(`<button id="target" onclick="parent.postMessage('verified','*')">Verify</button><script>
      window.events=[];for(const type of ['keydown','keyup','click','focus'])
      document.addEventListener(type,e=>events.push({type,key:e.key,target:e.target.tagName}),true);
    </script>`);
  } else {
    // Explicit tabindex isolates keyboard delivery from Moli 1.1.26's iframe Tab-order bug.
    res.end('<input type="hidden" tabindex="-1"><iframe tabindex="0" src="/cdn-cgi/challenge-platform/keyboard"></iframe>');
  }
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const reserve = http.createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env, MOLI_BIN: moli, CDP_PORT: String(port) };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[key];
const gateway = spawn(process.execPath, ['flaresolverr-bridge/cdp-gateway.mjs'], { cwd: root, env, stdio: 'ignore' });
let browser;
let reference;
async function exercise(page) {
  await page.goto(`http://127.0.0.1:${fixture.address().port}/`);
  await page.waitForTimeout(300);
  const attempted = await clickAutomaticVerify(page);
  const active = await page.evaluate(() => ({ tag: document.activeElement.tagName,
    iframeInstance: document.activeElement instanceof HTMLIFrameElement }));
  const frame = page.frames().find(item => item.url().includes('/cdn-cgi/challenge-platform/keyboard'));
  assert.ok(frame, 'fixture frame should be present');
  const frameState = await frame.evaluate(() => ({ active: document.activeElement.tagName, events: window.events }));
  return { attempted, active, frameState, clicked: frameState.events.some(event => event.type === 'click') };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(50);
  }
  assert.ok(ready, 'gateway did not become ready');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const moliResult = await exercise(await browser.contexts()[0].newPage());
  assert.equal(moliResult.active.tag, 'IFRAME', 'fixture iframe should receive parent focus');
  assert.equal(moliResult.attempted, true, 'bridge should recognize the focused challenge iframe');
  let chromiumResult;
  if (process.env.CHROMIUM_TEST_BINARY) {
    if (!path.isAbsolute(process.env.CHROMIUM_TEST_BINARY)) throw new Error('CHROMIUM_TEST_BINARY must be an absolute path');
    reference = await chromium.launch({ executablePath: process.env.CHROMIUM_TEST_BINARY, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    chromiumResult = await exercise(await reference.newPage());
    assert.equal(chromiumResult.clicked, true, 'Chromium control should activate the focused child button');
  }
  console.log(JSON.stringify({ moli: moliResult, ...(chromiumResult && { chromium: chromiumResult }) }, null, 2));
  if (process.argv.includes('--expect-fixed')) assert.equal(moliResult.clicked, true, 'Moli should deliver Space to the focused frame button');
} finally {
  await reference?.close();
  await browser?.close();
  if (gateway.exitCode === null && gateway.signalCode === null) { gateway.kill('SIGTERM'); await once(gateway, 'exit'); }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
