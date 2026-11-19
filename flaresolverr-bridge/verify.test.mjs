import test from 'node:test';
import assert from 'node:assert/strict';
import { clickVerify } from './upstream/verify.mjs';

test('uses keyboard and clicks the visible verification button', async () => {
  const actions = [];
  const button = { isVisible: async () => true, click: async () => actions.push('click') };
  const page = {
    keyboard: { press: async key => actions.push(key) },
    locator: selector => {
      assert.equal(selector, 'input[type="button"][value="Verify you are human"]');
      return { first: () => button };
    },
  };
  await clickVerify(page);
  assert.deepEqual(actions, ['Tab', 'Space', 'click']);
});

test('uses the requested number of tabs before pressing space', async () => {
  const actions = [];
  const page = { keyboard: { press: async key => actions.push(key) },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }) };
  await clickVerify(page, 3);
  assert.deepEqual(actions, ['Tab', 'Tab', 'Tab', 'Space']);
});

test('does not click a button after the page navigates during keyboard interaction', async () => {
  let current = true;
  const actions = [];
  const page = {
    keyboard: { press: async key => { actions.push(key); if (key === 'Space') current = false; } },
    locator: () => { throw new Error('new document must not be queried'); },
  };
  await clickVerify(page, 1, () => current);
  assert.deepEqual(actions, ['Tab', 'Space']);
});

test('does not click a button if navigation starts during visibility check', async () => {
  let current = true;
  const actions = [];
  const page = {
    keyboard: { press: async key => actions.push(key) },
    locator: () => ({ first: () => ({
      isVisible: async () => { current = false; return true; },
      click: async () => actions.push('click'),
    }) }),
  };
  await clickVerify(page, 1, () => current);
  assert.deepEqual(actions, ['Tab', 'Space']);
});

test('automatic verification does not press keys on an unrelated page', async () => {
  const { clickAutomaticVerify } = await import('./upstream/verify.mjs');
  const page = {
    locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
    frames: () => [{ url: () => 'https://unrelated.test/' }],
    url: () => 'https://example.test/',
    keyboard: { press: async () => { throw new Error('must not press unrelated control'); } },
  };
  assert.equal(await clickAutomaticVerify(page), false);
});

test('automatic keyboard fallback only presses Space for the recognized focused iframe', async () => {
  const { clickAutomaticVerify } = await import('./upstream/verify.mjs');
  const presses = [];
  const page = {
    locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
    frames: () => [{ url: () => 'https://challenges.cloudflare.com/frame' }],
    url: () => 'https://example.test/',
    keyboard: { press: async key => presses.push(key) },
    evaluate: async () => 'https://unrelated.test/',
  };
  assert.equal(await clickAutomaticVerify(page), false);
  assert.deepEqual(presses, ['Tab']);
  presses.length = 0;
  page.evaluate = async () => 'https://challenges.cloudflare.com/frame';
  assert.equal(await clickAutomaticVerify(page), true);
  assert.deepEqual(presses, ['Tab', 'Space']);
});

test('recognizes a focused HTML iframe without relying on its constructor', async () => {
  const { clickAutomaticVerify } = await import('./upstream/verify.mjs');
  const frameUrl = 'https://challenges.cloudflare.com/frame';
  const presses = [];
  let active = { namespaceURI: 'http://www.w3.org/1999/xhtml', localName: 'iframe', src: frameUrl };
  const page = {
    locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
    frames: () => [{ url: () => frameUrl }],
    url: () => 'https://example.test/',
    keyboard: { press: async key => presses.push(key) },
    evaluate: async callback => {
      const previous = globalThis.document;
      try {
        globalThis.document = { activeElement: active };
        return callback();
      } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
      }
    },
  };
  assert.equal(await clickAutomaticVerify(page), true);
  assert.deepEqual(presses, ['Tab', 'Space']);
  presses.length = 0;
  active = { namespaceURI: 'http://www.w3.org/1999/xhtml', localName: 'div', src: frameUrl };
  assert.equal(await clickAutomaticVerify(page), false);
  assert.deepEqual(presses, ['Tab']);
  presses.length = 0;
  active = { namespaceURI: 'http://www.w3.org/2000/svg', localName: 'iframe', src: frameUrl };
  assert.equal(await clickAutomaticVerify(page), false);
  assert.deepEqual(presses, ['Tab']);
});

test('automatic keyboard fallback rejects an iframe that navigated away', async () => {
  const { clickAutomaticVerify } = await import('./upstream/verify.mjs');
  let currentFrame = 'https://challenges.cloudflare.com/frame';
  const presses = [];
  const page = {
    locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
    frames: () => [{ url: () => currentFrame }],
    url: () => 'https://example.test/',
    keyboard: { press: async key => presses.push(key) },
    evaluate: async () => { currentFrame = 'https://unrelated.test/'; return 'https://challenges.cloudflare.com/frame'; },
  };
  assert.equal(await clickAutomaticVerify(page), false);
  assert.deepEqual(presses, ['Tab']);
});
