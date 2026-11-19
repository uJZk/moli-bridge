// Adapted from TRAWL packages/tiers/src/utils/postReplay.ts and detect.ts at
// 38e4b21de1061ea531cf711fec5efa5ac46ef9ee (AGPL-3.0); see TRAWL-LICENSE.
// HTML evidence is size-limited and inspected only for responses with a declared length.
import { isExplicitHtmlChallenge } from './trawl-challenge-evidence.mjs';
export class PostReplay {
  constructor() {
    this.submission = undefined;
    this.initial = false;
    this.blocked = false;
  }

  beginAttempt() {
    this.submission = undefined;
    this.initial = true;
  }

  observe = response => {
    const submission = this.submission;
    if (submission?.request !== response.request()) return;
    submission.rejection = this.rejected(response);
  };

  async rejected(response) {
    try {
      const entries = Object.entries(response.headers()).map(([key, value]) => [key.toLowerCase(), value.toLowerCase().trim()]);
      const headers = Object.fromEntries(entries);
      if (headers['cf-mitigated'] === 'challenge' ||
          (response.status() === 202 && headers['x-amzn-waf-action'] === 'challenge')) return true;
      const type = headers['content-type'] ?? '';
      const length = headers['content-length'];
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/.test(type) ||
          !/^\d+$/.test(length ?? '') || Number(length) > 262144) return false;
      const body = await response.body();
      if (body.length > 262144) return false;
      const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1] ?? 'utf-8';
      let decoder;
      try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
      return isExplicitHtmlChallenge(response.status(), decoder.decode(body));
    } catch {
      return false;
    }
  };

  async submit(request) {
    const previous = this.submission;
    if ((!this.initial && !await this.canRetry()) || this.submission !== previous) {
      this.blocked = true;
      return false;
    }
    this.initial = false;
    this.submission = { request };
    return true;
  }

  async canRetry() {
    const submission = this.submission;
    return Boolean(await submission?.rejection) && this.submission === submission;
  }

  check() {
    if (this.blocked) throw new Error('POST replay blocked: no explicit challenge rejection');
  }
}
