import test from 'node:test';
import assert from 'node:assert/strict';
import { PostReplay } from './upstream/post-replay.mjs';

test('normal POST cannot be resubmitted after a successful response', async () => {
  const guard = new PostReplay();
  const first = {};
  guard.beginAttempt();
  assert.equal(await guard.submit(first), true);
  guard.observe({ request: () => first, status: () => 200, headers: () => ({}) });
  assert.equal(await guard.submit({}), false);
  assert.throws(() => guard.check(), /POST replay blocked/);
});

test('one explicit rejection permits at most one concurrent retry', async () => {
  const guard = new PostReplay();
  const first = {};
  guard.beginAttempt();
  assert.equal(await guard.submit(first), true);
  guard.observe({ request: () => first, status: () => 403, headers: () => ({ 'CF-Mitigated': 'challenge' }) });
  assert.deepEqual(await Promise.all([guard.submit({}), guard.submit({})]), [true, false]);
  assert.equal(await guard.canRetry(), false);
});

test('a title or HTTP failure alone never authorizes resubmission', async () => {
  const guard = new PostReplay();
  const first = {};
  guard.beginAttempt();
  assert.equal(await guard.submit(first), true);
  guard.observe({ request: () => first, status: () => 403, headers: () => ({}) });
  assert.equal(await guard.canRetry(), false);
});

test('AWS challenge authorization is restricted to status 202', async () => {
  for (const status of [202, 403]) {
    const guard = new PostReplay();
    const first = {};
    guard.beginAttempt();
    await guard.submit(first);
    guard.observe({ request: () => first, status: () => status,
      headers: () => ({ 'X-Amzn-Waf-Action': 'challenge' }) });
    assert.equal(await guard.canRetry(), status === 202);
  }
});

test('an unrelated response cannot authorize the submitted request', async () => {
  const guard = new PostReplay();
  guard.beginAttempt();
  await guard.submit({});
  guard.observe({ request: () => ({}), status: () => 403,
    headers: () => ({ 'cf-mitigated': 'challenge' }) });
  assert.equal(await guard.canRetry(), false);
});

async function mayRetryHtml(html, { status = 403, type = 'text/html', length, fail = false } = {}) {
  const guard = new PostReplay();
  const first = {};
  const body = Buffer.from(html);
  guard.beginAttempt();
  await guard.submit(first);
  guard.observe({ request: () => first, status: () => status,
    headers: () => ({ 'content-type': type, 'content-length': length ?? String(body.length) }),
    body: async () => { if (fail) throw new Error('response unavailable'); return body; },
  });
  return guard.canRetry();
}

test('HTML evidence allows only active Cloudflare or valid Anubis challenge markers', async () => {
  assert.equal(await mayRetryHtml('<script>window._cf_chl_opt={}</script>'), true);
  assert.equal(await mayRetryHtml('<template><script>window._cf_chl_opt={}</script></template>'), false);
  assert.equal(await mayRetryHtml('<script type="application/json">window._cf_chl_opt={}</script>'), false);
  assert.equal(await mayRetryHtml('<script>window._cf_chl_opt={}</script>', { status: 200 }), false);
  const anubis = '<script type="application/json" id="anubis_challenge">{"rules":{"algorithm":"fast"},"challenge":{"id":"a","randomData":"b"}}</script>';
  assert.equal(await mayRetryHtml(anubis), true);
  assert.equal(await mayRetryHtml('<template>' + anubis + '</template>'), false);
});

test('HTML evidence fails closed when content is unavailable, oversized, or not HTML', async () => {
  const wall = '<script>window._cf_chl_opt={}</script>';
  assert.equal(await mayRetryHtml(wall, { fail: true }), false);
  assert.equal(await mayRetryHtml(wall, { type: 'application/json' }), false);
  assert.equal(await mayRetryHtml(wall, { length: '262145' }), false);
  assert.equal(await mayRetryHtml(wall, { length: 'invalid' }), false);
  assert.equal(await mayRetryHtml(wall + ' '.repeat(262145), { length: '100' }), false);
});

test('one asynchronous HTML rejection allows only one concurrent retry', async () => {
  const guard = new PostReplay();
  const first = {};
  const wall = Buffer.from('<script>window._cf_chl_opt={}</script>');
  guard.beginAttempt();
  await guard.submit(first);
  guard.observe({ request: () => first, status: () => 403,
    headers: () => ({ 'content-type': 'text/html', 'content-length': String(wall.length) }),
    body: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return wall; },
  });
  assert.deepEqual(await Promise.all([guard.submit({}), guard.submit({})]), [true, false]);
});
