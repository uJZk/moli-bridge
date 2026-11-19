import test from 'node:test';
import assert from 'node:assert/strict';
import { clickClosedChallengeFrame } from './closed-challenge-frame.mjs';

function fixture({ hit = 42, type = 'checkbox', disabled = false, checked = false, aria = false, safeDescendant = false } = {}) {
  const url = 'https://challenges.cloudflare.com/frame';
  const child = aria
    ? { nodeName: 'DIV', backendNodeId: 42, attributes: ['role', 'checkbox', 'aria-checked', checked ? 'true' : 'false'] }
    : { nodeName: 'INPUT', backendNodeId: 42, attributes: ['type', type, ...(disabled ? ['disabled', ''] : [])] };
  const document = { documentURL: url, children: [{ nodeName: 'DIV', shadowRoots: [{ shadowRootType: 'closed', children: [child] }] }] };
  const frameTree = { childFrames: [{ frame: { id: 'child-frame', url } }] };
  const calls = [];
  const session = { send: async (method, params) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { frameTree };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') return { result: { objectId: 'document-object' } };
    if (method === 'DOM.describeNode') return { node: document };
    if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: params.arguments ? safeDescendant : !checked && !disabled } };
    if (method === 'Runtime.releaseObject') return {};

    if (method === 'DOM.getBoxModel') return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: hit, frameId: 'child-frame' };
    throw new Error(`unexpected ${method}`);
  }, detach: async () => calls.push(['detach']) };
  const page = { url: () => 'https://example.test/', frames: () => [{ url: () => url }],
    context: () => ({ newCDPSession: async () => session }), mouse: { click: async (x, y) => calls.push(['click', x, y]) } };
  return { page, calls, child, document };
}

test('clicks only an exact hit in a closed challenge-frame checkbox', async () => {
  const f = fixture();
  assert.equal(await clickClosedChallengeFrame(f.page), true);
  assert.ok(f.calls.some(call => call[0] === 'click' && call[1] === 20 && call[2] === 30));
  assert.equal(f.calls.at(-1)[0], 'detach');
});

test('accepts only a verified safe ARIA descendant as the hit target', async () => {
  for (const safeDescendant of [true, false]) {
    const f = fixture({ aria: true, hit: 43, safeDescendant });
    assert.equal(await clickClosedChallengeFrame(f.page), true);
    assert.equal(f.calls.some(call => call[0] === 'click'), safeDescendant);
    assert.ok(f.calls.some(call => call[0] === 'Runtime.releaseObject' && call[1].objectId === 'node-43'));
  }
});

test('does not click an overlay, disabled input or unrelated frame', async () => {
  for (const options of [{ hit: 99 }, { disabled: true }, { type: 'button' }, { checked: true }]) {
    const f = fixture(options);
    assert.equal(await clickClosedChallengeFrame(f.page), options.type !== 'button');
    assert.ok(!f.calls.some(call => call[0] === 'click'));
  }
  const f = fixture();
  f.document.documentURL = 'https://unrelated.test/';
  assert.equal(await clickClosedChallengeFrame(f.page), false);
  assert.ok(!f.calls.some(call => call[0] === 'click'));
});

test('does not click after the top page or child frame changes', async () => {
  const f = fixture();
  let current = true;
  const original = f.page.context().newCDPSession;
  f.page.context = () => ({ newCDPSession: async () => {
    const session = await original();
    const send = session.send;
    session.send = async (...args) => { const result = await send(...args); if (args[0] === 'DOM.getNodeForLocation') current = false; return result; };
    return session;
  } });
  assert.equal(await clickClosedChallengeFrame(f.page, () => current), false);
  assert.ok(!f.calls.some(call => call[0] === 'click'));
  assert.equal(f.calls.at(-1)[0], 'detach');
});

test('supports an ARIA checkbox while still rejecting checked or disabled controls', async () => {
  const ready = fixture({ aria: true });
  assert.equal(await clickClosedChallengeFrame(ready.page), true);
  assert.ok(ready.calls.some(call => call[0] === 'click'));
  for (const options of [{ aria: true, checked: true }, { aria: true, disabled: true }]) {
    const blocked = fixture(options);
    assert.equal(await clickClosedChallengeFrame(blocked.page), true);
    assert.ok(!blocked.calls.some(call => call[0] === 'click'));
  }
});
