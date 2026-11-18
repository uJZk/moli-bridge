// Integration checks against a disposable, independently running CDP gateway.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
const requests = [];
const fixture = http.createServer((req, res) => {
  requests.push(req.headers);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<html><head><script>window.early = [navigator.language, navigator.hardwareConcurrency, document.createElement('canvas').getContext('webgl').getParameter(0x9245)]</script></head><body></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
const profiles = [
  { timezone: 'America/New_York', locale: 'fr-FR', platform: 'linux', brand: 'Edge', 'gpu-vendor': 'vendor-A', 'gpu-renderer': 'renderer-A', 'hardware-concurrency': '10' },
  { timezone: 'Asia/Tokyo', locale: 'ja-JP', platform: 'macos', brand: 'Chrome', 'gpu-vendor': 'vendor-B', 'gpu-renderer': 'renderer-B', 'hardware-concurrency': '5' },
];
const browserUrl = profile => `${endpoint}?${new URLSearchParams(profile)}`;
const browsers = [];
const snapshot = page => page.evaluate(async () => {
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    language: navigator.language,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands?.map(entry => entry.brand) ?? [],
    hardware: navigator.hardwareConcurrency,
    vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
    renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
    early: window.early,
  };
});
async function verify(page, profile, navigation = false) {
  const actual = await snapshot(page);
  assert.equal(actual.timezone, profile.timezone);
  assert.equal(actual.locale, profile.locale);
  assert.equal(actual.language, profile.locale);
  assert.equal(actual.platform, profile.platform === 'linux' ? 'Linux x86_64' : 'MacIntel');
  assert.equal(actual.hardware, Number(profile['hardware-concurrency']));
  assert.equal(actual.vendor, profile['gpu-vendor']);
  assert.equal(actual.renderer, profile['gpu-renderer']);
  if (profile.brand === 'Edge') assert.match(actual.userAgent, /\bEdg\//);
  else assert.doesNotMatch(actual.userAgent, /\bEdg\//);
  if (navigation) {
    assert.deepEqual(actual.early, [profile.locale, Number(profile['hardware-concurrency']), profile['gpu-vendor']]);
    assert.ok(actual.brands.includes(profile.brand === 'Edge' ? 'Microsoft Edge' : 'Google Chrome'));
  }
}
try {
  for (const query of ['timezone=Not%2FAZone', 'hardware-concurrency=0', 'platform=unknown', 'brand=unknown', 'unknown=1', 'locale=fr-FR&locale=ja-JP']) {
    const response = await fetch(`${endpoint}/json/version?${query}`);
    assert.equal(response.status, 400, query);
  }
  browsers.push(...await Promise.all(profiles.map(profile => chromium.connectOverCDP(browserUrl(profile)))));
  const [a, b] = browsers;
  const [a1, a2, b1] = await Promise.all([a.contexts()[0].newPage(), a.contexts()[0].newPage(), b.contexts()[0].newPage()]);
  await Promise.all([verify(a1, profiles[0]), verify(a2, profiles[0]), verify(b1, profiles[1])]);
  await Promise.all([a1.goto(url), b1.goto(url)]);
  await Promise.all([verify(a1, profiles[0], true), verify(b1, profiles[1], true)]);
  assert.ok(requests.some(headers => headers['user-agent']?.includes('Edg/') && headers['accept-language']?.startsWith('fr-FR')));
  assert.ok(requests.some(headers => !headers['user-agent']?.includes('Edg/') && headers['accept-language']?.startsWith('ja-JP')));
  await a1.evaluate(() => new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.onload = resolve;
    frame.srcdoc = '<html><body>frame</body></html>';
    document.body.appendChild(frame);
  }));
  const frameValues = await a1.frames()[1].evaluate(() => [
    navigator.language, navigator.hardwareConcurrency,
    document.createElement('canvas').getContext('webgl').getParameter(0x9245),
  ]);
  assert.deepEqual(frameValues, ['fr-FR', 10, 'vendor-A']);
  const worker = await a1.evaluate(() => new Promise((resolve, reject) => {
    const source = `const gl = new OffscreenCanvas(1, 1).getContext('webgl'); postMessage([navigator.language, navigator.hardwareConcurrency, gl.getParameter(0x9245)]);`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = event => resolve(event.data);
    worker.onerror = event => reject(new Error(event.message));
  }));
  assert.deepEqual(worker, ['fr-FR', 10, 'vendor-A']);
  // Close every page except a2, including the session which first owned the ICU locale.
  for (const page of a.contexts()[0].pages().filter(page => page !== a2)) await page.close();
  await verify(a2, profiles[0]);
  await a.close();
  await verify(b1, profiles[1], true);
  console.log('PASS invalid input, concurrent profiles, initial scripts, UA metadata, navigation, worker, locale transfer, and browser close isolation');
} finally {
  await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
  await new Promise(resolve => fixture.close(resolve));
}
