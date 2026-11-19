import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDdosGuardChallenge, isExplicitHtmlChallenge } from './upstream/trawl-challenge-evidence.mjs';

test('recognizes active DDoS-Guard interstitial markers', () => {
  for (const html of [
    '<h1 id="ddg-l10n-title">Checking</h1>',
    '<div id="ddg-img-loading"></div>',
    '<script src="/.well-known/ddos-guard/js-challenge/view.js"></script>',
    '<script src="https://check.ddos-guard.net/check.js"></script>',
  ]) {
    assert.equal(hasDdosGuardChallenge(html), true, html);
    assert.equal(isExplicitHtmlChallenge(200, html), false, 'DDoS-Guard evidence must not authorize POST replay');
  }
});

test('does not mistake passive DDoS-Guard mentions and inert markup for a wall', () => {
  for (const html of [
    '<p>Protected by ddos-guard.net</p>',
    '<!-- <h1 id="ddg-l10n-title">Checking</h1> -->',
    '<template><div id="ddg-img-loading"></div></template>',
    '<noscript><script src="https://check.ddos-guard.net/check.js"></script></noscript>',
    '<script type="application/json" src="https://check.ddos-guard.net/check.js"></script>',
    '<script src="https://check.ddos-guard.net.evil.test/check.js"></script>',
  ]) assert.equal(hasDdosGuardChallenge(html), false, html);
});
