// Exercise Moli's CDP emulation primitives on a disposable endpoint.
import assert from 'node:assert/strict';
import { chromium } from '../../flaresolverr-bridge/node_modules/playwright-core/index.mjs';

const endpoint = process.argv[2];
if (!endpoint) {
  console.error('Usage: node tools/flaresolverr-contract/check-cdp-overrides.mjs <CDP-URL>');
  process.exit(2);
}
const browser = await chromium.connectOverCDP(endpoint);
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await cdp.send('Emulation.setLocaleOverride', { locale: 'fr-FR' });
  await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 10 });
  await cdp.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'fr-FR', platform: 'Win32' });
  const actual = await page.evaluate(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    language: navigator.language,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }));
  assert.deepEqual(actual, {
    timezone: 'America/New_York', locale: 'fr-FR', language: 'fr-FR', platform: 'Win32', userAgent, hardwareConcurrency: 10,
  });
  console.log('CDP timezone, locale, language, platform, user-agent and hardware concurrency overrides passed');
  await page.close();
} finally {
  await browser.close();
}
