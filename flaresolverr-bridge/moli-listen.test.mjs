import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listeningAddress } from './moli-listen.mjs';
test('finds Moli listen address in plain and ANSI tracing output', () => {
  assert.equal(listeningAddress('INFO protocol server listening addr=127.0.0.1:44333\n'), 'http://127.0.0.1:44333');
  assert.equal(listeningAddress('\x1b[2m2026-11-18\x1b[0m \x1b[32mINFO\x1b[0m protocol server listening \x1b[3maddr\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:44333\n'), 'http://127.0.0.1:44333');
  assert.equal(listeningAddress('INFO starting'), undefined);
});
