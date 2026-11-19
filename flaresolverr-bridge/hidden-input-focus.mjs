import { isNavigationError } from './navigation-error.mjs';

// Moli 1.1.26 incorrectly includes hidden inputs in sequential keyboard focus.
export async function withHiddenInputsSkipped(page, isCurrent, operation) {
  const changed = await page.evaluateHandle(() => {
    const entries = [];
    for (const element of document.querySelectorAll('input')) {
      if (element.type !== 'hidden') continue;
      const previous = element.getAttribute('tabindex');
      if (previous === '-1') continue;
      entries.push({ element, previous });
      element.setAttribute('tabindex', '-1');
    }
    return entries;
  });
  try {
    if (isCurrent()) return await operation();
  } finally {
    try {
      await changed.evaluate(entries => {
        for (const { element, previous } of entries) {
          // Do not overwrite a different value set by the page during verification.
          if (element.getAttribute('tabindex') !== '-1') continue;
          if (previous === null) element.removeAttribute('tabindex');
          else element.setAttribute('tabindex', previous);
        }
      });
    } catch (error) {
      if (!isNavigationError(error)) throw error;
    } finally {
      await changed.dispose().catch(() => {});
    }
  }
}
