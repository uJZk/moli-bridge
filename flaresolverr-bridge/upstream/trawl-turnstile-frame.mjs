// Adapted from attemptTurnstileClick/clickInFrame in TRAWL
// packages/tiers/src/utils/challengeWait.ts at 38e4b21de1061ea531cf711fec5efa5ac46ef9ee
// (AGPL-3.0); see TRAWL-LICENSE. This supports accessible checkboxes only.
import { isNavigationError } from '../navigation-error.mjs';

export function isChallengeFrame(frameUrl, pageUrl) {
  try {
    const frame = new URL(frameUrl);
    const page = new URL(pageUrl);
    if (!['http:', 'https:'].includes(frame.protocol)) return false;
    if (frame.hostname === 'challenges.cloudflare.com') return frame.protocol === 'https:';
    return frame.origin === page.origin && frame.pathname.startsWith('/cdn-cgi/challenge-platform/');
  } catch {
    return false;
  }
}

export async function clickChallengeFrame(page, isCurrent = () => true) {
  let foundControl = false;
  for (const frame of page.frames()) {
    if (!isCurrent()) return false;
    const frameUrl = frame.url();
    const pageUrl = page.url();
    if (!isChallengeFrame(frameUrl, pageUrl)) continue;
    for (const selector of ['input[type="checkbox"]', '[role="checkbox"]']) {
      let checkbox;
      try {
        // A handle is bound to this document; a locator could resolve again
        // against a replacement iframe after navigation.
        checkbox = await frame.locator(selector).first().elementHandle({ timeout: 400 });
        if (!checkbox || !await checkbox.isVisible()) continue;
        foundControl = true;
        if (!isCurrent() || frame.url() !== frameUrl || page.url() !== pageUrl) return false;
        if (!await checkbox.isEnabled() || await checkbox.isChecked()) continue;
        if (!isCurrent() || frame.url() !== frameUrl || page.url() !== pageUrl) return false;
        await checkbox.click({ timeout: 1500 });
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        if (isNavigationError(error)) throw error;
        if (/timeout|frame was detached|element is not attached/i.test(error?.message ?? '')) continue;
        throw error;
      } finally {
        await checkbox?.dispose().catch(() => {});
      }
    }
  }
  return foundControl;
}
