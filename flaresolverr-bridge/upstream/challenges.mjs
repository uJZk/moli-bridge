// Detection patterns from FlareSolverr's flaresolverr_service.py at
// cc2224b21e31c09a713eb25690a8e8dcdf50d8d8, MIT licensed; see FlareSolverr-LICENSE.
export const accessDeniedTitles = ['Access denied', 'Attention Required! | Cloudflare'];
export const accessDeniedSelectors = [
  'div.cf-error-title span.cf-code-label span', '#cf-error-details div.cf-error-overview h1',
];
export const challengeTitles = ['Just a moment...', 'DDoS-Guard'];
export const challengeSelectors = [
  '#cf-challenge-running', '.ray_id', '.attack-box', '#cf-please-wait', '#challenge-spinner',
  '#trk_jschal_js', '#turnstile-wrapper', '.lds-ring', 'td.info #js_info', 'div.vc div.text-box h2',
];
