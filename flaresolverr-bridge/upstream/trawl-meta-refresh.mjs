// Adapted from TRAWL packages/tiers/src/utils/metaRefresh.ts at
// 38e4b21de1061ea531cf711fec5efa5ac46ef9ee, AGPL-3.0; see TRAWL-LICENSE.
// This bridge observes the browser's own navigation; it never forces a replay.
import { parseHTML } from 'linkedom';

const MAX_REFRESH_DELAY_MS = 10_000;

export function metaRefreshTarget(html, url) {
  if (!/<meta\b/i.test(html)) return undefined;
  let document;
  try { ({ document } = parseHTML(html)); } catch { return undefined; }
  // Linkedom preserves attribute-name case, unlike a browser HTML DOM.
  const attribute = (element, name) => Array.from(element.attributes)
    .find(attr => attr.name.toLowerCase() === name)?.value;
  const activeHtml = element => element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    !element.closest('template,noscript,textarea,style');
  const base = Array.from(document.querySelectorAll('base'))
    .find(element => activeHtml(element) && attribute(element, 'href') !== undefined);
  let baseUrl = url;
  if (base) {
    try { baseUrl = new URL(attribute(base, 'href'), url).href; } catch { /* use the document URL */ }
  }
  for (const meta of document.querySelectorAll('meta')) {
    if (!activeHtml(meta) || attribute(meta, 'http-equiv')?.trim().toLowerCase() !== 'refresh') continue;
    const match = /^\s*(\d+(?:\.\d+)?)\s*[;,](.*)$/s.exec(attribute(meta, 'content') ?? '');
    if (!match) continue;
    const delayMs = Math.round(Number(match[1]) * 1000);
    if (!Number.isFinite(delayMs) || delayMs > MAX_REFRESH_DELAY_MS) continue;
    const target = match[2].trim().replace(/^url\s*=\s*/i, '').trim().replace(/^(["'])(.*)\1$/s, '$2');
    if (!target) continue;
    try {
      const destination = new URL(target, baseUrl);
      if (['http:', 'https:'].includes(destination.protocol) && destination.href !== url) {
        return { delayMs, url: destination.href };
      }
    } catch { /* invalid destination */ }
  }
  return undefined;
}
