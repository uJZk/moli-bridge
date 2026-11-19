// Adapted from _resolve_turnstile_captcha and _get_turnstile_token in
// FlareSolverr src/flaresolverr_service.py at cc2224b21e31c09a713eb25690a8e8dcdf50d8d8
// (MIT); see FlareSolverr-LICENSE. The caller enforces the overall deadline.
import { clickVerify } from './verify.mjs';
import { clickChallengeFrame } from './trawl-turnstile-frame.mjs';
import { clickClosedChallengeFrame } from '../closed-challenge-frame.mjs';
import { isNavigationError } from '../navigation-error.mjs';
import { withHiddenInputsSkipped } from '../hidden-input-focus.mjs';

export async function resolveTurnstileToken(page, tabs, state) {
  const tokenInput = page.locator('input[name="cf-turnstile-response"]').first();
  let original;
  let found = false;
  while (true) {
    try {
      if (state?.pending) { await page.waitForTimeout(50); continue; }
      const generation = state?.generation;
      const isCurrent = () => !state || (!state.pending && generation === state.generation);
      const count = await tokenInput.count();
      if (!isCurrent()) continue;
      if (!count) {
        if (found) throw new Error('Turnstile response field disappeared during verification');
        return null;
      }
      if (!found) {
        const token = await tokenInput.inputValue({ timeout: 1000 });
        if (!isCurrent()) continue;
        original = token;
        found = true;
      } else {
        const token = await tokenInput.inputValue({ timeout: 1000 });
        if (!isCurrent()) continue;
        if (token && token !== original) return token;
      }
      if (!await clickChallengeFrame(page, isCurrent) && !await clickClosedChallengeFrame(page, isCurrent)) {
        if (tabs) await withHiddenInputsSkipped(page, isCurrent, () => clickVerify(page, tabs, isCurrent));
        else await clickVerify(page, tabs, isCurrent);
      }
      if (!isCurrent()) {
        await page.waitForTimeout(50);
        continue;
      }
      const token = await tokenInput.inputValue({ timeout: 1000 });
      if (!isCurrent()) continue;
      if (token && token !== original) return token;
      await page.evaluate(() => {
        document.getElementById('__focus_helper')?.remove();
        const button = document.createElement('button');
        button.id = '__focus_helper';
        button.style.cssText = 'position:fixed;top:0;left:0;opacity:0.01;pointer-events:none';
        document.body.prepend(button);
        button.focus();
      });
      await page.waitForTimeout(1000);
    } catch (error) {
      if (!isNavigationError(error)) throw error;
      await page.waitForTimeout(50);
    }
  }
}
