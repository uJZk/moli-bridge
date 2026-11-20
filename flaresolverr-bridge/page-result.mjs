import { accessDeniedTitles, accessDeniedSelectors, challengeTitles, challengeSelectors } from './upstream/challenges.mjs';
import { clickAutomaticVerify } from './upstream/verify.mjs';
import { clickChallengeFrame } from './upstream/trawl-turnstile-frame.mjs';
import { clickClosedChallengeFrame } from './closed-challenge-frame.mjs';
import { getAwsWafAction, hasCloudflareChallengeHeader, hasDataDomeChallengeHeader, isCloudflareChallengeTitle, isCloudflareErrorUrl } from './upstream/trawl-detect.mjs';
import { getAwsWafHtmlAction, hasDataDomeDeviceCheck, hasDataDomeHardBlock, hasDdosGuardChallenge, isExplicitHtmlChallenge } from './upstream/trawl-challenge-evidence.mjs';
import { metaRefreshTarget } from './upstream/trawl-meta-refresh.mjs';

import { isNavigationError } from './navigation-error.mjs';

export function observeNavigation(page) {
  const state = { generation: 0, navigationRequests: 0, response: null, request: null, pending: false, failure: null };
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      state.generation++;
      state.navigationRequests++;
      state.request = request;
      state.failure = null;
      state.response = null;
      state.pending = true;
    }
  });
  page.on('response', response => {
    if (response.request() === state.request) state.response = response;
  });
  page.on('requestfailed', request => {
    if (request === state.request) {
      state.pending = false;
      state.failure = request.failure()?.errorText || 'unknown navigation error';
    }
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      state.generation++;
      state.failure = null;
      state.pending = false;
    }
  });
  return state;
}

// Some CDP implementations reject goto when a newer main-frame navigation
// replaces its original document before the load event. Only recover when a
// replacement request was actually observed; ordinary failures remain errors.
export async function navigateInitial(page, url, timeout, state) {
  const before = state.navigationRequests;
  try {
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    if (!isNavigationError(error) && !/net::ERR_ABORTED|interrupted by another navigation/i.test(error?.message ?? '')) throw error;
    await page.waitForTimeout(50);
    if (state.navigationRequests - before < 2) throw error;
    return null;
  }
}

export async function collectPageResult(page, context, req, initialResponse, state, replay, recovery, setPhase = () => {}, report = () => {}) {
  let waited = false;
  let nextVerify = 0;
  let stableDocument;
  let waitedForLoadGeneration;
  let phaseGeneration;
  let challengeGeneration;
  let lastClearance;
  // TRAWL challengeWait.ts requires two normal observations after a wall.
  let challengeSeen = false;
  let inactiveSamples = 0;
  while (true) {
    replay?.check();
    const generation = state.generation;
    try {
      if (state.failure) {
        // A replacement navigation may start just after the previous one aborts.
        await page.waitForTimeout(50);
        if (state.failure && generation === state.generation) {
          throw new Error(`Navigation failed: ${state.failure}`);
        }
        continue;
      }
      if (state.pending) {
        setPhase('waiting for navigation');
        await page.waitForTimeout(50);
        continue;
      }
      if (phaseGeneration !== generation) {
        phaseGeneration = generation;
        setPhase('checking page');
      }
      await page.waitForLoadState('domcontentloaded');
      // Nonessential resources can keep the load event pending indefinitely.
      // Give them a short grace period once per document, then inspect the DOM
      // and challenges under the same overall request deadline.
      if (waitedForLoadGeneration !== generation) {
        try { await page.waitForLoadState('load', { timeout: 2000 }); }
        catch (error) { if (error?.name !== 'TimeoutError') throw error; }
        if (state.pending || generation !== state.generation) continue;
        waitedForLoadGeneration = generation;
      }
      if (page.url().startsWith('chrome-error:')) throw new Error('Navigation failed: browser returned an error page');
      const title = await page.title();
      const response = state.response ?? initialResponse;
      const status = response?.status() ?? 0;
      const headers = response?.headers?.() ?? {};
      let wafAction = getAwsWafAction(status, headers);
      const dataDomeHeader = hasDataDomeChallengeHeader(headers);
      const denied = isCloudflareErrorUrl(page.url(), status, headers) || accessDeniedTitles.some(value => title.startsWith(value)) || await page.locator(accessDeniedSelectors.join(',')).count();
      let ddosGuard = title.trim().toLowerCase() === 'ddos-guard';
      let challenged = hasCloudflareChallengeHeader(headers) || dataDomeHeader || wafAction === 'challenge' || isCloudflareChallengeTitle(title) || challengeTitles.some(value => value.toLowerCase() === title.toLowerCase()) || await page.locator(challengeSelectors.join(',')).count();
      let dataDomeBlocked = false;
      let html;
      // Generic titles such as "Please wait" are shared by multiple providers.
      // Inspect their markup as well when a GET recovery may be available.
      if (!denied && wafAction !== 'captcha' && (!challenged || ((recovery || dataDomeHeader) && !hasCloudflareChallengeHeader(headers)))) {
        html = await page.content();
        if (Buffer.byteLength(html) <= 262144) {
          wafAction ??= getAwsWafHtmlAction(status, html);
          dataDomeBlocked = hasDataDomeHardBlock(status, html);
          ddosGuard ||= hasDdosGuardChallenge(html);
          challenged ||= wafAction === 'challenge' || isExplicitHtmlChallenge(status, html) || ddosGuard;
        }
      }
      if (generation !== state.generation) continue;
      if (denied) throw new Error('The site denied access');
      if (dataDomeBlocked) throw new Error('The site denied access (DataDome hard block)');
      if (wafAction === 'captcha') throw new Error('The site requires an AWS WAF CAPTCHA');
      if (challenged) {
        setPhase('waiting for challenge clearance');
        if (challengeGeneration !== generation) {
          challengeGeneration = generation;
          report('challenge', { cloudflareHeader: hasCloudflareChallengeHeader(headers), cloudflareTitle: isCloudflareChallengeTitle(title), status });
        }
        stableDocument = undefined;
        const candidate = hasCloudflareChallengeHeader(headers) ? recovery?.cloudflare
          : dataDomeHeader ? (html && hasDataDomeDeviceCheck(html) ? recovery?.dataDome : undefined)
          : ddosGuard ? recovery?.ddosGuard : isCloudflareChallengeTitle(title) ? recovery?.cloudflare : undefined;
        if (candidate) {
          const ready = await candidate.ready(page.url(), context);
          const clearanceObserved = Boolean(candidate.observed);
          if (lastClearance !== clearanceObserved) {
            lastClearance = clearanceObserved;
            report('clearance', { newCookieObserved: clearanceObserved });
          }
          if (state.pending || generation !== state.generation) continue;
          if (ready) {
            // At most one recovery across all challenge types per request.
            for (const item of Object.values(recovery)) item.markAttempted();
            const provider = candidate === recovery.cloudflare ? 'cloudflare'
              : candidate === recovery.dataDome ? 'datadome' : 'ddos-guard';
            report('recovery-attempt', { provider });
            try { await page.goto(candidate.url, { waitUntil: 'domcontentloaded' }); }
            catch (error) {
              if (!state.pending && generation === state.generation) throw error;
            }
            continue;
          }
        }
        challengeSeen = true;
        inactiveSamples = 0;
        if (!nextVerify) nextVerify = Date.now() + 5000;
        if (Date.now() >= nextVerify) {
          // A fresh check is required after any interaction or navigation.
          nextVerify = Date.now() + 5000;
          const isCurrent = () => !state.pending && generation === state.generation;
          const accessible = await clickChallengeFrame(page, isCurrent);
          const closed = !accessible && await clickClosedChallengeFrame(page, isCurrent);
          const automatic = !accessible && !closed && await clickAutomaticVerify(page, isCurrent);
          report('verification', { accessibleControlFound: Boolean(accessible), closedControlFound: Boolean(closed), automaticAction: Boolean(automatic) });
        }
        await page.waitForTimeout(250);
        continue;
      }
      nextVerify = 0;
      setPhase('collecting page result');
      if (challengeSeen && ++inactiveSamples < 2) {
        await page.waitForTimeout(300);
        continue;
      }
      if (!waited && req.waitInSeconds) {
        waited = true;
        await page.waitForTimeout(req.waitInSeconds * 1000);
        continue;
      }
      const url = page.url();
      if (url.startsWith('chrome-error:')) throw new Error('Navigation failed: browser returned an error page');
      // A page may insert a refresh while the quiet window is in progress.
      // TRAWL recognizes short meta refreshes; wait for the browser itself to
      // follow them so that an initial POST is never replayed by us.
      const refresh = html && Buffer.byteLength(html) <= 262144 ? metaRefreshTarget(html, url) : undefined;
      if (refresh) {
        const until = Date.now() + refresh.delayMs + 2000;
        while (!state.pending && !state.failure && generation === state.generation && url === page.url() && Date.now() < until) {
          replay?.check();
          await page.waitForTimeout(Math.min(250, Math.max(1, until - Date.now())));
        }
        if (!state.pending && !state.failure && generation === state.generation && url === page.url()) {
          throw new Error('Meta refresh navigation did not occur');
        }
        continue;
      }
      // A normal title can precede a short script-driven redirect or reload.
      // Recheck after a quiet window; the request budget bounds this wait.
      if (stableDocument?.generation !== generation || stableDocument.url !== url) {
        stableDocument = { generation, url };
        await page.waitForTimeout(500);
        continue;
      }
      const result = {
        url, status: response?.status() ?? 0,
        headers: response ? await response.allHeaders() : {},
        cookies: await context.cookies(url), userAgent: await page.evaluate(() => navigator.userAgent),
      };
      if (!req.returnOnlyCookies) result.response = await page.content();
      if (req.returnScreenshot) result.screenshot = (await page.screenshot()).toString('base64');
      if (state.pending || generation !== state.generation || url !== page.url()) continue;
      replay?.check();
      report('finished', { result: 'ok', status: result.status });
      return result;
    } catch (error) {
      if (!isNavigationError(error)) throw error;
      await page.waitForTimeout(50);
    }
  }
}
