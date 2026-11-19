import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { supervise } from './container-supervisor.mjs';

function fixture() {
  const runtime = Object.assign(new EventEmitter(), { execPath: '/node', env: {}, exitCode: undefined });
  const children = [];
  const spawnChild = (_node, args) => {
    const child = Object.assign(new EventEmitter(), { file: args[0], signals: [], kill(signal) { this.signals.push(signal); } });
    children.push(child);
    return child;
  };
  supervise({ spawnChild, runtime });
  return { runtime, children };
}

test('stops both services and exits cleanly on termination', () => {
  const { runtime, children } = fixture();
  runtime.emit('SIGTERM');
  assert.deepEqual(children.map(child => child.signals), [['SIGTERM'], ['SIGTERM']]);
  for (const child of children) child.emit('close', 0, null);
  assert.equal(runtime.exitCode, 0);
});

test('stops the remaining service and fails if one exits unexpectedly', () => {
  const { runtime, children } = fixture();
  children[0].emit('close', 0, null);
  assert.deepEqual(children[1].signals, ['SIGTERM']);
  children[1].emit('close', 0, null);
  assert.equal(runtime.exitCode, 1);
});

test('fails and cleans up after a child startup error', () => {
  const { runtime, children } = fixture();
  children[0].emit('error', new Error('failed to spawn'));
  assert.deepEqual(children.map(child => child.signals), [['SIGTERM'], ['SIGTERM']]);
  for (const child of children) child.emit('close', null, null);
  assert.equal(runtime.exitCode, 1);
});
