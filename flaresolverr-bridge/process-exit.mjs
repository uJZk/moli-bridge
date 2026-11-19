import { RequestCancelledError } from './upstream/request-budget.mjs';

// Bound the wait and detach listeners when a caller times out or disconnects.
export function waitForProcessExit(child, ms, signal) {
  if (signal?.aborted) return Promise.reject(new RequestCancelledError());
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (ms <= 0) return Promise.reject(new Error('Timeout while rotating session'));
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      child.removeListener('exit', exited);
      signal?.removeEventListener('abort', cancelled);
      error ? reject(error) : resolve();
    };
    const exited = () => finish();
    const cancelled = () => finish(new RequestCancelledError());
    const timer = setTimeout(() => finish(new Error('Timeout while rotating session')), ms);
    child.once('exit', exited);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    else if (child.exitCode !== null || child.signalCode !== null) exited();
  });
}
