import test from 'node:test';
import assert from 'node:assert/strict';
import { clickChallengeFrame, isChallengeFrame } from './upstream/trawl-turnstile-frame.mjs';

test('accepts only Cloudflare hosts or same-origin challenge paths', () => {
  const page = 'https://example.test/search';
  assert.equal(isChallengeFrame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x', page), true);
  assert.equal(isChallengeFrame('https://example.test/cdn-cgi/challenge-platform/x', page), true);
  for (const url of ['http://challenges.cloudflare.com/a', 'https://challenges.cloudflare.com.evil.test/a',
    'https://evil.test/?url=challenges.cloudflare.com', 'https://evil.test/cdn-cgi/challenge-platform/x',
    'https://example.test/other', 'about:blank']) assert.equal(isChallengeFrame(url, page), false, url);
});

test('clicks the first visible checkbox in a recognized challenge frame', async () => {
  const clicks = [];
  const frame = { url: () => 'https://challenges.cloudflare.com/verify', locator: selector => ({ first: () => ({
    elementHandle: async () => ({ isVisible: async () => selector === '[role="checkbox"]',
      isEnabled: async () => true, isChecked: async () => false,
      click: async () => clicks.push(selector), dispose: async () => {} }),
  }) }) };
  const page = { url: () => 'https://example.test/', frames: () => [frame] };
  assert.equal(await clickChallengeFrame(page), true);
  assert.deepEqual(clicks, ['[role="checkbox"]']);
});

test('does not click unrelated frames or after navigation starts', async () => {
  const unrelated = { url: () => 'https://evil.test/', locator: () => { throw new Error('unexpected'); } };
  const page = { url: () => 'https://example.test/', frames: () => [unrelated] };
  assert.equal(await clickChallengeFrame(page), false);
  let current = true;
  let disposed = false;
  const frame = { url: () => 'https://challenges.cloudflare.com/', locator: () => ({ first: () => ({
    elementHandle: async () => ({
      isVisible: async () => { current = false; return true; },
      click: async () => { throw new Error('must not click'); },
      dispose: async () => { disposed = true; },
    }),
  }) }) };
  page.frames = () => [frame];
  assert.equal(await clickChallengeFrame(page, () => current), false);
  assert.equal(disposed, true);
});

test('does not click a replacement child frame after its URL changes', async () => {
  let url = 'https://challenges.cloudflare.com/verify';
  let disposed = false;
  const frame = { url: () => url, locator: () => ({ first: () => ({
    elementHandle: async () => ({
      isVisible: async () => { url = 'https://unrelated.test/'; return true; },
      click: async () => { throw new Error('must not click replacement frame'); },
      dispose: async () => { disposed = true; },
    }),
  }) }) };
  const page = { url: () => 'https://example.test/', frames: () => [frame] };
  assert.equal(await clickChallengeFrame(page), false);
  assert.equal(disposed, true);
});

test('leaves checked and disabled controls untouched without keyboard fallback', async () => {
  for (const [enabled, checked] of [[false, false], [true, true]]) {
    let clicks = 0;
    const frame = { url: () => 'https://challenges.cloudflare.com/verify', locator: () => ({ first: () => ({
      elementHandle: async () => ({ isVisible: async () => true, isEnabled: async () => enabled,
        isChecked: async () => checked, click: async () => { clicks++; }, dispose: async () => {} }),
    }) }) };
    const page = { url: () => 'https://example.test/', frames: () => [frame] };
    assert.equal(await clickChallengeFrame(page), true);
    assert.equal(clicks, 0);
  }
});
