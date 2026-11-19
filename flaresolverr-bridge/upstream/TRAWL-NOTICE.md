# TRAWL code notice

The following bridge files adapt code from [TRAWL](https://github.com/germondai/trawl),
commit `38e4b21de1061ea531cf711fec5efa5ac46ef9ee`, licensed under the GNU
Affero General Public License version 3. See [TRAWL-LICENSE](TRAWL-LICENSE).

- `request-budget.mjs` adapts `packages/tiers/src/utils/deadline.ts` from
  TypeScript to JavaScript, changes the timeout error message, and adds
  request cancellation and owned-resource cleanup.
- `post-replay.mjs` adapts `packages/tiers/src/utils/postReplay.ts` and
  header-based challenge checks from `detect.ts`. It supports a narrower set
  of rejection evidence and is connected to main-frame POSTs to the original URL.
- `trawl-challenge-evidence.mjs` adapts active Cloudflare and AWS WAF script,
  DDoS-Guard challenge markers, restricted DataDome hard-block and Device Check
  objects, and Anubis metadata detection from `detect.ts` and `anubis.ts`. The AWS,
  DDoS-Guard and DataDome HTML evidence is not used to authorize POST replay.
- `trawl-clearance-recovery.mjs` adapts the clearance-cookie recovery idea
  from `packages/tiers/src/utils/challengeWait.ts`, restricted to a new cookie
  and a single same-origin GET recovery. DDoS-Guard cookie names and the
  eight-second grace are adapted from `packages/tiers/src/utils/ddosGuardWait.ts`.
  DataDome's changed-cookie check and three-second grace are adapted from
  `packages/tiers/src/utils/datadomeWait.ts`, limited to explicit Device Check pages.
- `trawl-meta-refresh.mjs` adapts the short meta-refresh destination parser
  from `packages/tiers/src/utils/metaRefresh.ts`; the bridge waits for the
  browser's own navigation rather than initiating a fallback navigation.
- `trawl-turnstile-frame.mjs` adapts the accessible iframe checkbox
  approach from `packages/tiers/src/utils/challengeWait.ts`, with stricter
  frame URL checks and document-bound element handles.
- `trawl-detect.mjs` adapts the Cloudflare title, error URL and challenge-header
  matchers, DataDome block-header signal and AWS WAF action check from
  `packages/tiers/src/utils/detect.ts`.
  Query-only error codes require an error status and Cloudflare response evidence.
- `../server.mjs` adopts the busy-session expiration safeguard from
  `packages/tiers/src/browserSessions.ts`.
- `../page-result.mjs` adapts the two-clear-observation approach in
  `packages/tiers/src/utils/challengeWait.ts` to the Moli bridge.

The bridge package is marked AGPL-3.0-only. Other components, including Moli
and FlareSolverr-derived code, retain their own licenses and notices. Operators
and distributors must comply with the applicable corresponding-source terms;
the source provided must match the version actually deployed.
