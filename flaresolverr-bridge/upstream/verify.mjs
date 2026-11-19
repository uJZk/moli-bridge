// Adapted from click_verify in FlareSolverr's src/flaresolverr_service.py at
// cc2224b21e31c09a713eb25690a8e8dcdf50d8d8 (MIT); see FlareSolverr-LICENSE.
// The caller bounds the entire operation by the request deadline.
import { isChallengeFrame } from './trawl-turnstile-frame.mjs';
export async function clickVerify(page, tabs = 1, isCurrent = () => true) {
  for (let i = 0; i < tabs; i++) {
    if (!isCurrent()) return;
    await page.keyboard.press('Tab');
  }
  if (!isCurrent()) return;
  await page.keyboard.press('Space');
  if (!isCurrent()) return;
  const button = page.locator('input[type="button"][value="Verify you are human"]').first();
  if (await button.isVisible() && isCurrent()) await button.click({ timeout: 1000 });
}

// Automatic verification must not press Space on an unrelated focused control.
// Explicit tabs_till_verify remains handled by clickVerify above.
export async function clickAutomaticVerify(page, isCurrent = () => true) {
  let button;
  try {
    button = await page.locator('input[type="button"][value="Verify you are human"]').first()
      .elementHandle({ timeout: 400 });
    if (button && await button.isVisible() && isCurrent()) {
      await button.click({ timeout: 1000 });
      return true;
    }
  } catch (error) {
    if (!isCurrent()) return false;
    if (!/timeout|element is not attached/i.test(error?.message ?? '')) throw error;
  } finally {
    await button?.dispose().catch(() => {});
  }
  if (!isCurrent() || !page.frames().some(frame => isChallengeFrame(frame.url(), page.url()))) return false;
  await page.keyboard.press('Tab');
  if (!isCurrent()) return false;
  const activeSrc = await page.evaluate(() => {
    const active = document.activeElement;
    // Moli 1.1.26 can expose an iframe element whose HTMLIFrameElement
    // instanceof check is false. Check the actual HTML element instead.
    return active?.namespaceURI === 'http://www.w3.org/1999/xhtml' && active.localName === 'iframe' ? active.src : null;
  });
  if (!isCurrent() || !activeSrc || !isChallengeFrame(activeSrc, page.url()) ||
      !page.frames().some(frame => frame.url() === activeSrc)) return false;
  await page.keyboard.press('Space');
  return true;
}
