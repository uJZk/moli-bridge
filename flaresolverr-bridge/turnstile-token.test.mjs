import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnstileToken } from './upstream/turnstile-token.mjs';

const withHiddenInputCompatibility = page => ({
  evaluateHandle: async () => ({ evaluate: async () => {}, dispose: async () => {} }),
  ...page,
});

function input(type, initial) {
  let tabindex = initial;
  return {
    type,
    getAttribute: () => tabindex,
    setAttribute: (_name, value) => { tabindex = value; },
    removeAttribute: () => { tabindex = null; },
  };
}

function hiddenInputsHandle(elements) {
  return async callback => {
    const previous = globalThis.document;
    try {
      globalThis.document = { querySelectorAll: () => elements };
      const entries = callback();
      return { evaluate: async fn => fn(entries), dispose: async () => {} };
    } finally {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    }
  };
}

test('temporarily skips hidden inputs and preserves page changes to tabindex', async () => {
  const hidden = input('hidden', null);
  const changedByPage = input('hidden', '4');
  const untouched = input('text', '3');
  let token = '';
  const page = {
    evaluateHandle: hiddenInputsHandle([hidden, changedByPage, untouched]),
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => 1, inputValue: async () => token }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async key => {
      assert.equal(hidden.getAttribute(), '-1');
      assert.equal(untouched.getAttribute(), '3');
      if (key === 'Space') { changedByPage.setAttribute('tabindex', '9'); token = 'new-token'; }
    } },
  };
  assert.equal(await resolveTurnstileToken(page, 1), 'new-token');
  assert.equal(hidden.getAttribute(), null);
  assert.equal(changedByPage.getAttribute(), '9');
  assert.equal(untouched.getAttribute(), '3');
});

test('restores hidden inputs when keyboard interaction fails', async () => {
  const hidden = input('hidden', '4');
  const page = {
    evaluateHandle: hiddenInputsHandle([hidden]),
    locator: () => ({ first: () => ({ count: async () => 1, inputValue: async () => '' }) }),
    frames: () => [],
    keyboard: { press: async () => { throw new Error('keyboard failed'); } },
  };
  await assert.rejects(resolveTurnstileToken(page, 1), /keyboard failed/);
  assert.equal(hidden.getAttribute(), '4');
});

test('does not alter tab order when no Tab presses are requested', async () => {
  let token = '';
  const page = {
    evaluateHandle: async () => { throw new Error('must not change tab order'); },
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => 1, inputValue: async () => token }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async key => { if (key === 'Space') token = 'space-token'; } },
  };
  assert.equal(await resolveTurnstileToken(page, 0), 'space-token');
});

test('disposes the old document handle if navigation interrupts restoration', async () => {
  let token = '';
  let disposed = false;
  const page = {
    evaluateHandle: async () => ({
      evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); },
      dispose: async () => { disposed = true; },
    }),
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => 1, inputValue: async () => token }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async key => { if (key === 'Space') token = 'new-token'; } },
  };
  assert.equal(await resolveTurnstileToken(page, 1), 'new-token');
  assert.equal(disposed, true);
});

test('returns null when the page has no token field', async () => {
  const page = { locator: () => ({ first: () => ({ count: async () => 0 }) }) };
  assert.equal(await resolveTurnstileToken(page, 1), null);
});

test('returns the changed token after verification', async () => {
  let value = '';
  const actions = [];
  const page = {
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => 1, inputValue: async () => value }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async key => { actions.push(key); if (key === 'Space') value = 'test-token'; } },
  };
  assert.equal(await resolveTurnstileToken(withHiddenInputCompatibility(page), 2), 'test-token');
  assert.deepEqual(actions, ['Tab', 'Tab', 'Space']);
});

test('retries reading the token after a navigation invalidates the context', async () => {
  let reads = 0;
  const page = {
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => 1, inputValue: async () => {
        reads++;
        if (reads === 1) return '';
        if (reads === 2) throw new Error('Execution context was destroyed, most likely because of a navigation');
        return 'new-token';
      } }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
  assert.equal(await resolveTurnstileToken(withHiddenInputCompatibility(page), 1), 'new-token');
});

test('reports when the token field disappears after an attempt', async () => {
  let present = true;
  const page = {
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => Number(present), inputValue: async () => '' }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async () => {} },
    evaluate: async () => { present = false; },
    waitForTimeout: async () => {},
  };
  await assert.rejects(resolveTurnstileToken(withHiddenInputCompatibility(page), 1), /field disappeared/);
});

test('rechecks the token in the replacement document after a navigation', async () => {
  let value = '';
  const state = { generation: 1, pending: false };
  const page = {
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => 1, inputValue: async () => value }
      : { isVisible: async () => { throw new Error('must not inspect a replaced document'); } } }),
    frames: () => [],
    keyboard: { press: async key => { if (key === 'Space') { state.generation++; value = 'new-token'; } } },
    waitForTimeout: async () => {},
  };
  assert.equal(await resolveTurnstileToken(withHiddenInputCompatibility(page), 1, state), 'new-token');
});

test('does not conclude the field is absent while the document is replaced', async () => {
  const state = { generation: 1, pending: false };
  let checks = 0;
  let value = '';
  const page = {
    locator: selector => ({ first: () => selector.includes('cf-turnstile-response')
      ? { count: async () => { if (!checks++) { state.generation++; return 0; } return 1; }, inputValue: async () => value }
      : { isVisible: async () => false } }),
    frames: () => [],
    keyboard: { press: async key => { if (key === 'Space') value = 'replacement-token'; } },
    waitForTimeout: async () => {},
  };
  assert.equal(await resolveTurnstileToken(withHiddenInputCompatibility(page), 1, state), 'replacement-token');
});
