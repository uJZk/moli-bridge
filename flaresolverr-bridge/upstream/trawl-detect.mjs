// Adapted from TRAWL packages/tiers/src/utils/detect.ts at
// 38e4b21de1061ea531cf711fec5efa5ac46ef9ee, AGPL-3.0; see TRAWL-LICENSE.
export const isCloudflareChallengeTitle = title =>
  /^(?:just a moment|please wait|checking your browser(?: before accessing .*)?|attention required|verify you are human)[.!…]*(?:\s*[|-]\s*cloudflare)?$/i.test(title.trim());

// Adapted from TRAWL detect.ts. Query-only error codes need a matching status
// and Cloudflare response evidence so ordinary application URLs are not blocks.
export function isCloudflareErrorUrl(value, status, headers = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.pathname === '/cdn-cgi/error' || url.pathname.startsWith('/cdn-cgi/error/')) return true;
  if (![403, 429].includes(status) || !url.searchParams.getAll('error').some(code => code === '1015' || code === '1020')) return false;
  return Object.entries(headers).some(([name, header]) =>
    name.toLowerCase() === 'cf-ray' || (name.toLowerCase() === 'server' && /\bcloudflare\b/i.test(header)));
}

// Header rules adapted from the same TRAWL detect.ts revision.
export function hasCloudflareChallengeHeader(headers = {}) {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'cf-mitigated')?.[1];
  return value?.toLowerCase() === 'challenge';
}

// TRAWL treats x-dd-b as block-only; x-datadome is also present on normal pages.
export function hasDataDomeChallengeHeader(headers = {}) {
  return Object.keys(headers).some(name => name.toLowerCase() === 'x-dd-b');
}

export function getAwsWafAction(status, headers = {}) {
  const action = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-amzn-waf-action')?.[1]?.trim().toLowerCase();
  if (status === 202 && action === 'challenge') return 'challenge';
  if (status === 405 && action === 'captcha') return 'captcha';
  return undefined;
}
