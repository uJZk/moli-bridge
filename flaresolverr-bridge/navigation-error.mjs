// Playwright can report these transient failures when a document is replaced.
export function isNavigationError(error) {
  return /execution context was destroyed|cannot find context with specified id|most likely because of a navigation|page is navigating and changing the content/i.test(error?.message ?? '');
}
