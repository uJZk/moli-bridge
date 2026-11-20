import test from 'node:test';
import assert from 'node:assert/strict';
import { backendEnvironment } from './backend-env.mjs';

test('uses Los Angeles only when the inherited timezone resolves to UTC', () => {
  const original = { TZ: 'UTC', OTHER: 'unchanged' };
  for (const zone of ['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT']) {
    assert.deepEqual(backendEnvironment(original, zone), { TZ: 'America/Los_Angeles', OTHER: 'unchanged' });
  }
  assert.deepEqual(original, { TZ: 'UTC', OTHER: 'unchanged' });
  assert.deepEqual(backendEnvironment({ TZ: 'Asia/Shanghai' }, 'Asia/Shanghai'), { TZ: 'Asia/Shanghai' });
  assert.deepEqual(backendEnvironment({}, 'Europe/London'), {});
});
