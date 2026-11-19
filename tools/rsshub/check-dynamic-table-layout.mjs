// Isolated Moli regression probe: compare static and script-inserted table rows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const root = path.resolve(import.meta.dirname, '../..');
const fixture = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<button id="insert">Insert</button>
    <table><tbody><tr id="static"><td>Static row</td></tr></tbody></table>
    <table id="dynamic-table"><tbody></tbody></table>
    <div id="existing-block" style="width:20px;height:20px">Existing</div>
    <div id="block-container"></div>
    <script>document.getElementById('insert').onclick = () => {
      document.querySelector('#dynamic-table tbody').innerHTML = '<tr id="dynamic"><td>Dynamic row</td></tr>';
      document.getElementById('block-container').innerHTML = '<div id="dynamic-block" style="width:80px;height:20px">Dynamic block</div>';
      document.getElementById('existing-block').style.width = '100px';
    };</script>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env, MOLI_BIN: moli, CDP_PORT: String(port) };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[key];
const gateway = spawn(process.execPath, ['flaresolverr-bridge/cdp-gateway.mjs'], { cwd: root, env, stdio: 'ignore' });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await delay(50);
  }
  assert.ok(ready, 'gateway did not become ready');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await browser.contexts()[0].newPage();
  await page.goto(`http://127.0.0.1:${fixture.address().port}/`);
  await page.click('#insert');
  await page.waitForSelector('#dynamic', { state: 'attached' });
  await page.waitForTimeout(500);
  const measure = target => target.evaluate(() => {
    const measure = id => {
      const element = document.getElementById(id);
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height, text: element.textContent.trim() };
    };
    return { static: measure('static'), dynamic: measure('dynamic'), existingBlock: measure('existing-block'), dynamicBlock: measure('dynamic-block') };
  });
  const metrics = await measure(page);
  assert.equal(metrics.static.text, 'Static row');
  assert.equal(metrics.dynamic.text, 'Dynamic row');
  assert.equal(metrics.dynamicBlock.text, 'Dynamic block');
  assert.ok(metrics.static.width > 0 && metrics.static.height > 0, 'static control must have layout');
  const dynamicVisible = metrics.dynamic.width > 0 && metrics.dynamic.height > 0;
  const dynamicUpdatesVisible = dynamicVisible && metrics.dynamicBlock.width === 80 && metrics.existingBlock.width === 100;
  let visibilityPoll;
  if (process.argv.includes('--poll-visibility')) {
    try {
      await page.waitForSelector('#dynamic', { state: 'visible', timeout: 1500 });
      visibilityPoll = true;
    } catch (error) {
      if (!/timeout/i.test(error.message)) throw error;
      visibilityPoll = false;
    }
  }
  let afterAnimationFrame;
  if (process.argv.includes('--after-animation-frame')) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    afterAnimationFrame = await measure(page);
  }
  let afterLayoutMetrics;
  if (process.argv.includes('--after-layout-metrics')) {
    const session = await page.context().newCDPSession(page);
    try { await session.send('Page.getLayoutMetrics'); } finally { await session.detach(); }
    afterLayoutMetrics = await measure(page);
  }
  let afterScreenshot;
  if (process.argv.includes('--after-small-screenshot')) {
    const session = await page.context().newCDPSession(page);
    try { await session.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }); }
    finally { await session.detach(); }
    afterScreenshot = await measure(page);
  }
  if (process.argv.includes('--after-screenshot')) {
    await page.screenshot();
    afterScreenshot = await measure(page);
  }
  if (afterScreenshot) {
    assert.ok(afterScreenshot.dynamic.width > 0 && afterScreenshot.dynamic.height > 0, 'screenshot should publish the dynamic row');
    assert.equal(afterScreenshot.dynamicBlock.width, 80, 'screenshot should publish the dynamic block');
    assert.equal(afterScreenshot.existingBlock.width, 100, 'screenshot should publish the changed width');
  }
  let chromiumReference;
  if (process.argv.includes('--chromium-reference')) {
    const executablePath = process.env.CHROMIUM_TEST_BINARY;
    if (!executablePath || !path.isAbsolute(executablePath)) throw new Error('Set CHROMIUM_TEST_BINARY to an absolute Chromium executable path');
    const reference = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    try {
      const referencePage = await reference.newPage();
      await referencePage.goto(`http://127.0.0.1:${fixture.address().port}/`);
      await referencePage.click('#insert');
      chromiumReference = await measure(referencePage);
      assert.ok(chromiumReference.static.width > 0 && chromiumReference.static.height > 0 &&
        chromiumReference.dynamic.width > 0 && chromiumReference.dynamic.height > 0, 'Chromium control rows must have layout');
      assert.equal(chromiumReference.existingBlock.width, 100);
      assert.equal(chromiumReference.dynamicBlock.width, 80);
    } finally { await reference.close(); }
  }
  console.log(JSON.stringify({ dynamicVisible, dynamicUpdatesVisible, ...metrics, ...(visibilityPoll !== undefined && { visibilityPoll }), ...(afterLayoutMetrics && { afterLayoutMetrics }),
    ...(afterAnimationFrame && { afterAnimationFrame }), ...(afterScreenshot && { afterScreenshot }), ...(chromiumReference && { chromiumReference }) }));
  if (process.argv.includes('--expect-fixed')) assert.ok(dynamicUpdatesVisible, 'DOM changes are missing from the published layout');
  if (process.argv.includes('--expect-poll-visible')) assert.equal(visibilityPoll, true, 'dynamic row did not become visible while polling');
  if (process.argv.includes('--expect-after-animation-frame')) {
    assert.ok(afterAnimationFrame, 'also pass --after-animation-frame');
    assert.ok(afterAnimationFrame.dynamic.width > 0 && afterAnimationFrame.dynamic.height > 0 &&
      afterAnimationFrame.dynamicBlock.width === 80 && afterAnimationFrame.existingBlock.width === 100,
    'DOM changes are missing from layout after animation frames');
  }
} finally {
  await browser?.close().catch(() => {});
  gateway.kill('SIGTERM');
  if (gateway.exitCode === null && gateway.signalCode === null) await new Promise(resolve => gateway.once('exit', resolve));
  await new Promise(resolve => fixture.close(resolve));
}
