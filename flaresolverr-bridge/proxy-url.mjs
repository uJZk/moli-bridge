export function normalizeProxy(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string') throw new Error('Invalid proxy');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('Invalid proxy URL'); }
  if (url.protocol === 'socks5h:') url.protocol = 'socks5:';
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname) throw new Error('Unsupported proxy URL');
  for (const key of ['username', 'password']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string') throw new Error('Invalid proxy credentials');
    try { url[key] = encodeURIComponent(value[key]); } catch { throw new Error('Invalid proxy credentials'); }
  }
  return url.href;
}
