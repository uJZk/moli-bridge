import test from 'node:test';
import assert from 'node:assert/strict';
import { ClearanceRecovery } from './upstream/trawl-clearance-recovery.mjs';

const url = 'https://example.test/search';
const cookie = value => ({ name: 'cf_clearance', value, domain: 'example.test', path: '/' });

test('requires a new clearance cookie to remain stable before one recovery', async () => {
  let now = 0;
  let cookies = [cookie('old')];
  const context = { cookies: async () => cookies };
  const recovery = new ClearanceRecovery(url, cookies, { now: () => now, delay: 5000 });
  now = 10000;
  assert.equal(await recovery.ready(url, context), false);
  cookies = [cookie('new')];
  assert.equal(await recovery.ready(url, context), false);
  now += 4999;
  assert.equal(await recovery.ready(url, context), false);
  now++;
  assert.equal(await recovery.ready(url, context), true);
  recovery.markAttempted();
  assert.equal(await recovery.ready(url, context), false);
});

test('does not navigate for other origins and resets the timer when a cookie changes', async () => {
  let now = 0;
  let cookies = [cookie('one')];
  const context = { cookies: async () => cookies };
  const recovery = new ClearanceRecovery(url, [], { now: () => now, delay: 5000 });
  assert.equal(await recovery.ready('https://elsewhere.test/', context), false);
  assert.equal(await recovery.ready(url, context), false);
  now = 4000;
  cookies = [cookie('two')];
  assert.equal(await recovery.ready(url, context), false);
  now = 5000;
  assert.equal(await recovery.ready(url, context), false);
  now = 9000;
  assert.equal(await recovery.ready(url, context), true);
});

test('DDoS-Guard recovery requires a new matching cookie and an eight-second grace', async () => {
  let now = 0;
  const ddg = (name, value) => ({ name, value, domain: 'example.test', path: '/' });
  let cookies = [ddg('__ddg2_fixture', 'old')];
  const context = { cookies: async () => cookies };
  const recovery = new ClearanceRecovery(url, cookies, {
    now: () => now, delay: 8000, matches: item => /^__ddg[25]_/.test(item.name),
  });
  now = 10000;
  assert.equal(await recovery.ready(url, context), false, 'an existing cookie is not new clearance');
  cookies = [ddg('__ddg3_fixture', 'irrelevant')];
  assert.equal(await recovery.ready(url, context), false, 'other DDoS-Guard cookies do not qualify');
  cookies = [ddg('__ddg5_fixture', 'fresh')];
  assert.equal(await recovery.ready(url, context), false);
  now += 7999;
  assert.equal(await recovery.ready(url, context), false);
  now++;
  assert.equal(await recovery.ready('https://other.test/', context), false);
  assert.equal(await recovery.ready(url, context), true);
  recovery.markAttempted();
  assert.equal(await recovery.ready(url, context), false);
});

test('DataDome recovery requires a changed nonempty cookie value, not merely a different path', async () => {
  let now = 0;
  let cookies = [{ name: 'datadome', value: 'old', domain: 'example.test', path: '/' }];
  const context = { cookies: async () => cookies };
  const recovery = new ClearanceRecovery(url, cookies, {
    now: () => now, delay: 3000, matches: item => item.name === 'datadome' && Boolean(item.value),
    fingerprint: item => JSON.stringify([item.domain, item.value]),
  });
  cookies = [{ ...cookies[0], path: '/search' }];
  now = 5000;
  assert.equal(await recovery.ready(url, context), false);
  cookies = [{ ...cookies[0], value: '' }];
  assert.equal(await recovery.ready(url, context), false);
  cookies = [{ ...cookies[0], value: 'fresh' }];
  assert.equal(await recovery.ready(url, context), false);
  now += 2999;
  assert.equal(await recovery.ready(url, context), false);
  now++;
  assert.equal(await recovery.ready('https://elsewhere.test/', context), false);
  assert.equal(await recovery.ready(url, context), true);
  recovery.markAttempted();
  assert.equal(await recovery.ready(url, context), false);
});
