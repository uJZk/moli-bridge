// Regression test for keyboard navigation through a same-origin iframe.
// Only the local HTTP fixture is used; CHROMIUM_TEST_BINARY enables a control.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const root = path.resolve(import.meta.dirname, '../..');
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/grandchild') {
    res.end('<button id="grand">Grandchild</button>');
    return;
  }
  if (req.url === '/empty-child') {
    res.end('<body><script>window.keys=[];document.addEventListener("keydown", event => keys.push(event.key))</script></body>');
    return;
  }
  if (req.url === '/nested-child') {
    res.end('<button id="first">First</button><iframe id="nested" src="/grandchild"></iframe><button id="second">Second</button>');
    return;
  }
  if (req.url === '/child') {
    res.end('<button id="first">First</button><button id="second" onclick="window.clicked=true">Second</button>');
    return;
  }
  const query = new URL(req.url, 'http://fixture').searchParams;
  const index = query.get('tabindex');
  const attr = index === null ? '' : ` tabindex="${index}"`;
  const child = query.has('nested') ? '/nested-child' : query.has('empty') ? '/empty-child' : '/child';
  const hidden = query.has('hidden') ? ' style="display:none"' : query.has('invisible') ? ' style="visibility:hidden"' : query.has('contents') ? ' style="display:contents"' : '';
  const wrapper = query.has('inert') ? ' inert' : query.has('parenthidden') ? ' style="display:none"' : '';
  const hiddenAttribute = query.has('attrhidden') ? ' hidden' : '';
  res.end(`<input type="hidden" name="cf-turnstile-response"><button id="before">Before</button><div${wrapper}><iframe id="frame"${attr}${hidden}${hiddenAttribute} src="${child}"></iframe></div><button id="after">After</button>`);
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env, MOLI_BIN: moli, CDP_PORT: String(port) };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[key];
const gateway = spawn(process.execPath, ['flaresolverr-bridge/cdp-gateway.mjs'], { cwd: root, env, stdio: 'ignore' });
let browser;
let reference;
async function exercise(page) {
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const active = () => page.evaluate(() => {
    let element = document.activeElement;
    const owners = [];
    while (element.localName === 'iframe') {
      owners.push(element.id);
      element = element.contentDocument.activeElement;
    }
    return [...owners, element.id || element.tagName].join(':');
  });
  const press = async (key, expected) => { await page.keyboard.press(key); assert.equal(await active(), expected, `${key} focus`); };
  await page.goto(`${url}/`);
  await press('Tab', 'before');
  await press('Tab', 'frame:first');
  await press('Tab', 'frame:second');
  await page.keyboard.press('Space');
  assert.equal(await page.frames().find(frame => frame.url().endsWith('/child')).evaluate(() => window.clicked), true, 'Space must activate the focused child button');
  await press('Tab', 'after');
  await press('Shift+Tab', 'frame:second');
  await press('Shift+Tab', 'frame:first');
  await press('Shift+Tab', 'before');
  await page.goto(`${url}/?tabindex=2`);
  await press('Tab', 'frame:first');
  await press('Tab', 'frame:second');
  await press('Tab', 'before');
  await page.goto(`${url}/?tabindex=-1`);
  await press('Tab', 'before');
  await press('Tab', 'after');
  await page.evaluate(() => document.getElementById('frame').contentDocument.getElementById('first').focus());
  assert.equal(await active(), 'frame:first');
  await press('Tab', 'frame:second');
  await press('Tab', 'after');
  await page.goto(`${url}/?tabindex=-1`);
  await page.evaluate(() => document.getElementById('frame').focus());
  assert.equal(await active(), 'frame:BODY');
  await press('Tab', 'frame:first');
  await press('Tab', 'frame:second');
  await press('Tab', 'after');
  for (const mode of ['hidden', 'invisible', 'inert', 'contents', 'attrhidden', 'parenthidden']) {
    await page.goto(`${url}/?${mode}=1`);
    await press('Tab', 'before');
    await press('Tab', 'after');
  }
  await page.goto(`${url}/?nested=1`);
  await press('Tab', 'before');
  await press('Tab', 'frame:first');
  await press('Tab', 'frame:nested:grand');
  await press('Tab', 'frame:second');
  await press('Tab', 'after');
  await press('Shift+Tab', 'frame:second');
  await press('Shift+Tab', 'frame:nested:grand');
  await press('Shift+Tab', 'frame:first');
  await page.goto(`${url}/?empty=1`);
  await press('Tab', 'before');
  await press('Tab', 'frame:BODY');
  await page.keyboard.press('Space');
  const empty = page.frames().find(frame => frame.url().endsWith('/empty-child'));
  assert.deepEqual(await empty.evaluate(() => window.keys), [' '], 'Space must reach an empty focused child document');
  await press('Tab', 'after');
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(50);
  }
  assert.ok(ready, 'gateway did not become ready');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await exercise(await browser.contexts()[0].newPage());
  if (process.env.CHROMIUM_TEST_BINARY) {
    if (!path.isAbsolute(process.env.CHROMIUM_TEST_BINARY)) throw new Error('CHROMIUM_TEST_BINARY must be an absolute path');
    reference = await chromium.launch({ executablePath: process.env.CHROMIUM_TEST_BINARY, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    await exercise(await reference.newPage());
  }
  console.log('PASS iframe Tab order, reverse navigation, focused child Space activation and tabindex scopes');
} finally {
  await reference?.close(); await browser?.close();
  if (gateway.exitCode === null && gateway.signalCode === null) { gateway.kill('SIGTERM'); await once(gateway, 'exit'); }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
