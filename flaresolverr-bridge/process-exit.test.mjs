import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { waitForProcessExit } from './process-exit.mjs';
import { RequestCancelledError } from './upstream/request-budget.mjs';

function child() { return Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null }); }

test('waits for an exiting process and releases its listener', async () => {
  const process = child();
  const waiting = waitForProcessExit(process, 1000);
  assert.equal(process.listenerCount('exit'), 1);
  process.signalCode = 'SIGTERM';
  process.emit('exit');
  await waiting;
  assert.equal(process.listenerCount('exit'), 0);
});

test('timeout and cancellation remove process and signal listeners', async () => {
  for (const cancel of [false, true]) {
    const process = child();
    const controller = new AbortController();
    const waiting = waitForProcessExit(process, cancel ? 1000 : 10, controller.signal);
    if (cancel) controller.abort();
    await assert.rejects(waiting, cancel ? RequestCancelledError : /timeout/i);
    assert.equal(process.listenerCount('exit'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('an exited or missing process resolves without a wait', async () => {
  await waitForProcessExit(undefined, 0);
  const process = child();
  process.exitCode = 0;
  await waitForProcessExit(process, 0);
  assert.equal(process.listenerCount('exit'), 0);
});
