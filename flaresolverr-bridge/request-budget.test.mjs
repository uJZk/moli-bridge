import test from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineError, RequestBudget, RequestCancelledError } from './upstream/request-budget.mjs';

test('timeout waits for owned cleanup and does not return the late result', async () => {
  const budget = new RequestBudget(20);
  let cleaned = false;
  budget.own(async () => { await new Promise(resolve => setTimeout(resolve, 5)); cleaned = true; });
  try {
    await assert.rejects(budget.run(() => new Promise(resolve => setTimeout(() => resolve('late'), 70))), DeadlineError);
    assert.equal(cleaned, true);
  } finally { budget.dispose(); }
});

test('successful operations preserve results and do not clean resources', async () => {
  const budget = new RequestBudget(1000);
  let cleaned = false;
  budget.own(async () => { cleaned = true; });
  try {
    assert.equal(await budget.run(async () => 42), 42);
    assert.equal(cleaned, false);
  } finally { budget.dispose(); }
});

test('client cancellation waits for owned cleanup and does not return a late result', async () => {
  const controller = new AbortController();
  const budget = new RequestBudget(1000, controller.signal);
  let cleaned = false;
  budget.own(async () => { await new Promise(resolve => setTimeout(resolve, 5)); cleaned = true; });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(budget.run(() => new Promise(resolve => setTimeout(() => resolve('late'), 70))), RequestCancelledError);
    assert.equal(cleaned, true);
  } finally { clearTimeout(timer); budget.dispose(); }
});

test('a cancellation before execution prevents the operation from starting', async () => {
  const controller = new AbortController();
  controller.abort();
  const budget = new RequestBudget(1000, controller.signal);
  let started = false;
  try {
    await assert.rejects(budget.run(async () => { started = true; }), RequestCancelledError);
    assert.equal(started, false);
  } finally { budget.dispose(); }
});

test('disposing a completed budget removes the cancellation listener', () => {
  const controller = new AbortController();
  const budget = new RequestBudget(1000, controller.signal);
  budget.dispose();
  controller.abort();
  assert.equal(budget.signal.aborted, false);
});
