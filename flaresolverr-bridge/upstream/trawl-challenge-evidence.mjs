// Adapted from TRAWL packages/tiers/src/utils/{detect,anubis}.ts at
// 38e4b21de1061ea531cf711fec5efa5ac46ef9ee (AGPL-3.0); see TRAWL-LICENSE.
import { parseHTML } from 'linkedom';

const attribute = (node, name) => [...node.attributes].find(attr => attr.name.toLowerCase() === name)?.value;
const active = node => !node.closest('template,noscript,textarea,style');
const executable = script => {
  const type = attribute(script, 'type')?.trim().toLowerCase();
  return !type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type);
};

// TRAWL recognizes DataDome's t=bv as a hard block. Restrict this variant to
// an error response and an active inline dd object with a provider hostname.
function dataDomeObjects(html) {
  if (!/captcha-delivery\.com/i.test(html)) return [];
  const { document } = parseHTML(html);
  const objects = [];
  for (const script of document.querySelectorAll('script:not([src])')) {
    if (!active(script) || script.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !executable(script)) continue;
    const text = script.textContent ?? '';
    const start = /(?:^|[;}\n])\s*(?:(?:var|let|const)\s+|window\s*\.\s*)?dd\s*=\s*\{/i.exec(text)?.index;
    if (start === undefined) continue;
    const object = text.slice(start, start + 600);
    const host = /["']host["']\s*:\s*["']([^"']+)["']/i.exec(object)?.[1]?.toLowerCase();
    if (/^(?:[a-z0-9-]+\.)*captcha-delivery\.com$/i.test(host ?? '')) objects.push(object);
  }
  return objects;
}

export function hasDataDomeHardBlock(status, html) {
  return [403, 429].includes(status) && dataDomeObjects(html).some(object => /["']t["']\s*:\s*["']bv["']/i.test(object));
}

// Only an explicit Device Check can use cookie recovery; sliders cannot.
export function hasDataDomeDeviceCheck(html) {
  return dataDomeObjects(html).some(object => /["']rt["']\s*:\s*["']i["']/i.test(object) && !/["']t["']\s*:\s*["']bv["']/i.test(object));
}

// Adapted from TRAWL's AWS WAF script detection. Require active scripts and,
// on successful HTTP responses, a lean interstitial rather than an ordinary
// page that merely embeds the provider's widget.
export function getAwsWafHtmlAction(status, html) {
  if (!/gokuProps/i.test(html) || !/token\.awswaf\.com/i.test(html)) return undefined;
  const { document } = parseHTML(html);
  let configuration = false;
  let challenge = false;
  let captcha = false;
  for (const script of document.querySelectorAll('script')) {
    if (!active(script) || script.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !executable(script)) continue;
    if (!attribute(script, 'src') && /\bwindow\s*\.\s*gokuProps\s*=/.test(script.textContent ?? '')) configuration = true;
    try {
      const src = new URL(attribute(script, 'src'));
      if (src.protocol !== 'https:' || !(src.hostname === 'token.awswaf.com' || src.hostname.endsWith('.token.awswaf.com'))) continue;
      if (/(?:^|\/)challenge\.js$/i.test(src.pathname)) challenge = true;
      if (/(?:^|\/)captcha\.js$/i.test(src.pathname)) captcha = true;
    } catch { /* Inline or malformed script. */ }
  }
  if (!configuration || (!challenge && !captcha)) return undefined;
  if (![202, 403, 405, 429, 503].includes(status)) {
    const body = document.body?.cloneNode(true);
    if (!body) return undefined;
    for (const node of body.querySelectorAll('script,noscript,template,style')) node.remove();
    if (body.textContent.trim() || body.querySelector('input,button,form,iframe,img,video,canvas')) return undefined;
  }
  return captcha ? 'captcha' : 'challenge';
}

// DDoS-Guard markers adapted from TRAWL detect.ts. Restrict script evidence
// to active executable sources and markup to live HTML elements.
export function hasDdosGuardChallenge(html) {
  if (!/ddg-l10n-(?:title|description)|ddg-img-loading|ddos-guard/i.test(html)) return false;
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll('[id]')) {
    if (node.namespaceURI === 'http://www.w3.org/1999/xhtml' && active(node) &&
        /^(?:ddg-l10n-(?:title|description)|ddg-img-loading)$/i.test(attribute(node, 'id') ?? '')) return true;
  }
  for (const script of document.querySelectorAll('script[src]')) {
    if (!active(script) || script.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const type = attribute(script, 'type')?.trim().toLowerCase();
    if (type && !/^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type)) continue;
    try {
      const src = new URL(attribute(script, 'src'), 'https://moli.invalid/');
      if (['http:', 'https:'].includes(src.protocol) && ((src.hostname === 'check.ddos-guard.net' && src.pathname === '/check.js') ||
          src.pathname.startsWith('/.well-known/ddos-guard/js-challenge/'))) return true;
    } catch { /* malformed script URL */ }
  }
  return false;
}

export function isExplicitHtmlChallenge(status, html) {
  const cloudflare = (status === 403 || status === 503) && /_cf_chl_opt|orchestrate\/chl_page/i.test(html);
  const anubis = /anubis_(?:challenge|version)|\/\.within\.website\/x\/cmd\/anubis\//.test(html);
  if (!cloudflare && !anubis) return false;
  const { document } = parseHTML(html);
  let version = false;
  let challenge = false;
  let bootstrap = false;
  for (const script of document.querySelectorAll('script')) {
    if (!active(script)) continue;
    const type = attribute(script, 'type')?.trim().toLowerCase();
    if (cloudflare && (!type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type)) &&
        (/\/cdn-cgi\/challenge-platform\/.*orchestrate\/chl_page/i.test(attribute(script, 'src') ?? '') ||
         /(?:^|[;{}])\s*(?:window\.)?_cf_chl_opt\s*=\s*\{/i.test(script.textContent ?? ''))) return true;
    if (!anubis) continue;
    if (/\/\.within\.website\/x\/cmd\/anubis\/static\/js\/main\.mjs(?:[?#]|$)/.test(attribute(script, 'src') ?? '')) bootstrap = true;
    const id = attribute(script, 'id');
    if ((id !== 'anubis_challenge' && id !== 'anubis_version') || type !== 'application/json') continue;
    try {
      const data = JSON.parse(script.textContent ?? '');
      if (id === 'anubis_version') version = typeof data === 'string' && data.length > 0;
      else challenge = Boolean(data?.rules?.algorithm && data?.challenge?.id && data?.challenge?.randomData);
    } catch { /* Invalid metadata needs a valid version and bootstrap. */ }
  }
  const rejected = version && [...document.querySelectorAll('img')].some(image => active(image) &&
    /\/\.within\.website\/x\/cmd\/anubis\/static\/img\/reject\.webp(?:[?#]|$)/.test(attribute(image, 'src') ?? ''));
  return !rejected && (challenge || (version && bootstrap));
}
