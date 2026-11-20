// Adapted from TRAWL packages/tiers/src/utils/challengeWait.ts at
// 38e4b21de1061ea531cf711fec5efa5ac46ef9ee (AGPL-3.0); see TRAWL-LICENSE.
// DDoS-Guard and DataDome cookie rules are from utils/ddosGuardWait.ts and datadomeWait.ts.
// This variant only permits one same-origin GET recovery after a new cookie.
const key = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.value]);

export class ClearanceRecovery {
  constructor(url, cookies, { now = Date.now, delay = 5000, matches = cookie => cookie.name === 'cf_clearance' && Boolean(cookie.value), fingerprint = key } = {}) {
    this.url = url;
    this.origin = new URL(url).origin;
    this.matches = matches;
    this.fingerprint = fingerprint;
    this.original = new Set(cookies.filter(matches).map(fingerprint));
    this.now = now;
    this.delay = delay;
    this.observed = undefined;
    this.attempted = false;
  }

  async ready(currentUrl, context) {
    if (this.attempted || new URL(currentUrl).origin !== this.origin) return false;
    const cookies = await context.cookies(this.url);
    const candidate = cookies.find(cookie => this.matches(cookie) && !this.original.has(this.fingerprint(cookie)));
    if (!candidate) { this.observed = undefined; return false; }
    const value = this.fingerprint(candidate);
    if (this.observed?.value !== value) this.observed = { value, at: this.now() };
    return this.now() - this.observed.at >= this.delay;
  }

  markAttempted() { this.attempted = true; }
}
