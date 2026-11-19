import test from 'node:test';
import assert from 'node:assert/strict';
import { translateLaunchParams } from './rsshub-launch.mjs';
import { parseProfile } from './cdp-profile.mjs';
const parse = (launch, extra = '') => parseProfile(translateLaunchParams(new URLSearchParams(`launch=${encodeURIComponent(JSON.stringify(launch))}${extra}`)));

test('accepts RSSHub CDP options and maps supported behavior', () => {
  const profile = parse({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=0,0'], headless: true, stealth: true });
  assert.equal(profile.automation, false);
  assert.equal(parse({ args: ['--proxy-server=http://127.0.0.1:8080'], headless: true }).proxy, 'http://127.0.0.1:8080/');
  assert.equal(parse({ args: ['--proxy-server=socks5://127.0.0.1:1080'], headless: true }).proxy, 'socks5://127.0.0.1:1080/');
});

test('preserves percent-escaped credentials in an authenticated launch proxy', () => {
  const launch = { args: ['--proxy-server=http://fixture%2540user:p%40ss%3Aword%2540@127.0.0.1:8080'], headless: true };
  const proxy = new URL(parse(launch).proxy);
  assert.equal(decodeURIComponent(proxy.username), 'fixture%40user');
  assert.equal(decodeURIComponent(proxy.password), 'p@ss:word%40');
});

test('rejects unsupported launch options without silently dropping them', () => {
  for (const launch of [{ headless: false }, { stealth: 'yes' }, { args: ['--proxy-pac-url=http://example.test/pac'] }, { args: ['--no-sandbox;bad'] }, { proxy: { server: 'http://example.test' } }, { args: ['--proxy-server=file:///tmp/a'] }, { args: ['--proxy-server=http://127.0.0.1', '--proxy-server=http://127.0.0.2'] }]) {
    assert.throws(() => parse(launch));
  }
  assert.throws(() => parse({ stealth: true }, '&automation=true'));
  assert.throws(() => translateLaunchParams(new URLSearchParams('launch=%7B&launch=%7B')));
});
