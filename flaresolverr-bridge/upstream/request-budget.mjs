// Adapted from TRAWL packages/tiers/src/utils/deadline.ts at
// 38e4b21de1061ea531cf711fec5efa5ac46ef9ee, AGPL-3.0; see TRAWL-LICENSE.
// Converted from TypeScript to JavaScript; timeout message adapted for this API.
export class DeadlineError extends Error {
  constructor() {
    super('Request timeout exceeded');
    this.name = 'DeadlineError';
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super('Client disconnected');
    this.name = 'RequestCancelledError';
  }
}

export class RequestBudget {
  constructor(ms, cancellation) {
    this.controller = new AbortController();
    this.cleanups = new Set();
    this.cleaning = undefined;
    this.deadline = Date.now() + Math.max(0, ms);
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new DeadlineError()), Math.max(0, ms));
    this.cancellation = cancellation;
    this.cancel = () => this.controller.abort(new RequestCancelledError());
    cancellation?.addEventListener('abort', this.cancel, { once: true });
    if (cancellation?.aborted) this.cancel();
  }

  remaining() { return Math.max(0, this.deadline - Date.now()); }

  check() {
    if (!this.signal.aborted && this.remaining() <= 0) {
      this.controller.abort(new DeadlineError());
    }
    if (this.signal.aborted) throw this.signal.reason;
  }

  own(cleanup) {
    this.cleanups.add(cleanup);
    if (this.signal.aborted) void cleanup().catch(() => {});
    return () => this.cleanups.delete(cleanup);
  }

  drain() {
    this.cleaning ??= Promise.allSettled([...this.cleanups].map(close => Promise.resolve().then(close))).then(() => {});
    return this.cleaning;
  }

  async run(operation) {
    this.check();
    let abort = () => {};
    try {
      return await Promise.race([
        Promise.resolve().then(operation).then(
          async result => {
            if (this.signal.aborted) { await this.drain(); throw this.signal.reason; }
            this.check();
            return result;
          },
          async error => {
            if (this.signal.aborted || this.remaining() <= 0) {
              this.controller.abort(new DeadlineError());
              await this.drain();
              throw this.signal.reason;
            }
            throw error;
          },
        ),
        new Promise((_, reject) => {
          abort = () => { void this.drain().then(() => reject(this.signal.reason)); };
          this.signal.addEventListener('abort', abort, { once: true });
          if (this.signal.aborted) abort();
        }),
      ]);
    } finally {
      this.signal.removeEventListener('abort', abort);
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.cancellation?.removeEventListener('abort', this.cancel);
  }
}
