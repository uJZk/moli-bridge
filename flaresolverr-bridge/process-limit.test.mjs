import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processLimit } from './process-limit.mjs';

test('process limits default to eight and accept positive integers', () => {
  assert.equal(processLimit(undefined, 'LIMIT'), 8);
  assert.equal(processLimit('4', 'LIMIT'), 4);
  assert.equal(processLimit('1', 'LIMIT'), 1);
});

test('invalid limits are rejected rather than disabling capacity checks', () => {
  for (const value of ['', '0', '-1', '1.5', 'not-a-number', 'Infinity', '9007199254740992']) {
    assert.throws(() => processLimit(value, 'LIMIT'), /LIMIT must be a positive safe integer/, value);
  }
});

test('both services fail startup with a malformed capacity', async () => {
  for (const [script, name] of [['server.mjs', 'BRIDGE_MAX_SESSIONS'], ['cdp-gateway.mjs', 'CDP_MAX_BROWSERS']]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      env: { ...process.env, BRIDGE_MAX_SESSIONS: '8', CDP_MAX_BROWSERS: '8', [name]: 'invalid' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} did not exit promptly`)); }, 3000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    assert.notEqual(status, 0, `${script} accepted an invalid capacity`);
    assert.match(stderr, new RegExp(`${name} must be a positive safe integer`));
  }
});
