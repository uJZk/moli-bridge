import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProfile } from './cdp-profile.mjs';
const parse = query => parseProfile(new URLSearchParams(query));

test('omitted and empty values use Moli defaults without losing zero or false', () => {
  assert.deepEqual(parse('timezone=&locale=&proxy=&viewport-width='), {});
  assert.deepEqual(parse('latitude=0&longitude=0&touch=false&max-touch-points=0&wow64=false').geolocation, { latitude: 0, longitude: 0, accuracy: 100 });
  assert.deepEqual(parse('touch=false&max-touch-points=0').touchSettings, { enabled: false });
});
test('screen and position defaults remain consistent with explicit dimensions', () => {
  assert.deepEqual(parse('screen-width=1280&screen-height=720').metrics, {
    width: 1280, height: 720, screenWidth: 1280, screenHeight: 720, deviceScaleFactor: 1, scale: 1, mobile: false,
    screenOrientation: { type: 'landscapePrimary', angle: 0 }, positionX: 0, positionY: 0,
  });
  assert.equal(parse('viewport-width=2000').metrics.screenWidth, 2000);
  assert.equal(parse('screen-width=700&screen-height=1000').metrics.screenOrientation.type, 'portraitPrimary');
  assert.equal(parse('screen-orientation=landscape-secondary').metrics.screenOrientation.angle, 180);
});
test('partial geolocation, conflicting and invalid parameters fail closed', () => {
  for (const query of ['latitude=1', 'accuracy=1', 'longitude=181&latitude=0', 'heading=360&latitude=0&longitude=0', 'viewport-width=2000&screen-width=1000', 'touch=false&max-touch-points=2', 'proxy=file%3A%2F%2F%2Fetc%2Fpasswd', 'brand=&brand=Edge', 'unknown=', 'hardware-concurrency=0', 'user-agent=bad%0Aheader', 'ua-brands=%5B%7B%7D%5D', 'form-factors=Desktop%2C']) {
    assert.throws(() => parse(query), Error, query);
  }
});
test('normalizes inputs without dropping explicit false', () => {
  const p = parse('brand=EDGE&platform=LINUX&touch=TRUE&data-saver=false&wow64=0&color-scheme=DARK');
  assert.equal(p.brand, 'edge'); assert.equal(p.platform, 'linux');
  assert.equal(p['data-saver'], false); assert.equal(p.wow64, false);
  assert.deepEqual(p.touchSettings, { enabled: true, maxTouchPoints: 1 });
  assert.deepEqual(p.mediaSettings, { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
});
test('accepts SOCKS proxy URLs with or without a trailing slash, while rejecting paths', () => {
  for (const scheme of ['socks4', 'socks5']) {
    for (const suffix of ['', '/']) {
      const params = new URLSearchParams({ proxy: `${scheme}://127.0.0.1:1080${suffix}` });
      assert.equal(parseProfile(params).proxy, `${scheme}://127.0.0.1:1080/`);
    }
    assert.throws(() => parseProfile(new URLSearchParams({ proxy: `${scheme}://127.0.0.1:1080/path` })));
  }
});
test('normalizes the SOCKS5 remote-DNS alias', () => {
  const params = new URLSearchParams({ proxy: 'socks5h://user:p%2540@127.0.0.1:1080' });
  assert.equal(parseProfile(params).proxy, 'socks5://user:p%2540@127.0.0.1:1080/');
});
