// Opt-in, bounded diagnostics. Never log URLs, headers, cookie values or page text.
import { randomUUID } from 'node:crypto';

const resourceTypes = new Set(['document', 'script', 'xhr', 'fetch', 'image', 'stylesheet', 'font', 'media', 'websocket']);
const errorNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'SecurityError']);

export function createDiagnostics(enabled, write = line => console.error(line), now = Date.now) {
  if (!enabled) return { report() {}, attach() {} };
  const id = randomUUID();
  const start = now();
  let count = 0;
  function report(event, details = {}) {
    if (count++ >= 200) return;
    write(JSON.stringify({ component: 'bridge-diagnostic', id, elapsedMs: now() - start, event, ...details }));
  }
  async function attach(page, targetUrl) {
    const targetOrigin = new URL(targetUrl).origin;
    function location(value) {
      try {
        const url = new URL(value);
        if (url.hostname === 'challenges.cloudflare.com') return 'cloudflare-challenge';
        return url.origin === targetOrigin ? 'target-origin' : 'other';
      } catch { return 'other'; }
    }
    function type(request) {
      const value = request.resourceType();
      return resourceTypes.has(value) ? value : 'other';
    }
    page.on('response', response => {
      try {
        const request = response.request();
        const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
        const where = location(response.url());
        if (main || (where === 'cloudflare-challenge' && response.status() >= 400)) {
          report('response', { location: where, main, resource: type(request), status: response.status() });
        }
      } catch { /* Diagnostics must not interrupt browsing. */ }
    });
    page.on('requestfailed', request => {
      try {
        const code = request.failure()?.errorText?.match(/\bnet::ERR_[A-Z_]+\b/)?.[0] ?? 'other';
        report('request-failed', { location: location(request.url()), resource: type(request), code });
      } catch { /* Diagnostics must not interrupt browsing. */ }
    });
    page.on('framenavigated', frame => {
      try { if (frame !== page.mainFrame()) report('frame', { location: location(frame.url()) }); }
      catch { /* Diagnostics must not interrupt browsing. */ }
    });
    page.on('pageerror', error => report('page-error', { name: errorNames.has(error?.name) ? error.name : 'Other' }));
    // Moli currently dispatches inline classic-script failures to window.onerror
    // without always emitting CDP Runtime.exceptionThrown. Observe that error
    // event from document start, and transport only its allowlisted name.
    const marker = randomUUID();
    page.on('console', message => {
      try {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!text.startsWith(`${marker}:`)) return;
        const name = text.slice(marker.length + 1);
        report('window-error', { name: errorNames.has(name) ? name : 'Other' });
      } catch { /* Diagnostics must not interrupt browsing. */ }
    });
    await page.addInitScript(({ marker }) => {
      const emit = console.error.bind(console);
      window.addEventListener('error', event => {
        let name = 'Other';
        try {
          if (['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'SecurityError'].includes(event.error?.name)) name = event.error.name;
        } catch { /* An exception's name can itself be a hostile getter. */ }
        emit(`${marker}:${name}`);
      }, true);
    }, { marker });
  }
  return { report, attach };
}
