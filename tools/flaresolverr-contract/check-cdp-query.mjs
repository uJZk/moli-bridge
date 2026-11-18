// Test a disposable CDP endpoint against the CloakBrowser-style URL parameters.
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';

const endpoint = process.argv[2];
if (!endpoint) {
  console.error('Usage: node tools/flaresolverr-contract/check-cdp-query.mjs <CDP-URL>');
  process.exit(2);
}
const params = new URL(endpoint).searchParams;
const supported = new Set(['timezone', 'locale', 'platform', 'brand', 'gpu-vendor', 'gpu-renderer', 'hardware-concurrency']);
if (![...params.keys()].length) throw new Error('At least one fingerprint parameter is required');
for (const key of params.keys()) {
  if (!supported.has(key)) throw new Error(`Unknown parameter: ${key}`);
  if (params.getAll(key).length !== 1) throw new Error(`Duplicate parameter: ${key}`);
}
const browser = await chromium.connectOverCDP(endpoint);
let failed = false;
try {
  const page = await browser.contexts()[0].newPage();
  const observed = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: navigator.language,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData?.brands?.map(item => item.brand) ?? [],
      'gpu-vendor': debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      'gpu-renderer': debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      'hardware-concurrency': navigator.hardwareConcurrency,
    };
  });
  for (const [key, expected] of params) {
    let actual = observed[key];
    let matches;
    if (key === 'platform') {
      const platforms = { windows: 'Win32', linux: 'Linux x86_64', macos: 'MacIntel' };
      matches = actual === (platforms[expected.toLowerCase()] ?? expected);
    } else if (key === 'brand') {
      actual = { userAgent: observed.userAgent, brands: observed.brands };
      matches = expected.toLowerCase() === 'edge'
        ? /\bEdg\//.test(observed.userAgent) || observed.brands.includes('Microsoft Edge')
        : observed.brands.some(brand => brand.toLowerCase() === expected.toLowerCase());
    } else matches = String(actual) === expected;
    if (!matches) failed = true;
    console.log(`${matches ? 'PASS' : 'FAIL'} ${key}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
  await page.close();
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
