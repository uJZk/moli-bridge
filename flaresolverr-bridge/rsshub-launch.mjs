// RSSHub sends Browserless-style launch options when connecting over CDP.
// Accept only options with a defined Moli equivalent; never pass arguments to a shell.
export function translateLaunchParams(params) {
  const translated = new URLSearchParams(params);
  const launches = translated.getAll('launch');
  if (launches.length > 1) throw new Error('Duplicate launch parameter');
  if (!launches.length) return translated;
  translated.delete('launch');
  const raw = launches[0];
  if (raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error('Invalid launch parameter');
  let launch;
  try { launch = JSON.parse(raw); } catch { throw new Error('Invalid launch parameter'); }
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) throw new Error('Invalid launch parameter');
  for (const key of Object.keys(launch)) if (!['args', 'headless', 'stealth'].includes(key)) throw new Error(`Unsupported launch option: ${key}`);
  if (launch.headless !== undefined && launch.headless !== true) throw new Error('Only headless launch is supported');
  if (launch.stealth !== undefined && typeof launch.stealth !== 'boolean') throw new Error('Invalid stealth option');
  if (launch.stealth === true) {
    if (translated.has('automation') && !['false', '0'].includes(translated.get('automation').toLowerCase())) throw new Error('Conflicting automation option');
    if (!translated.has('automation')) translated.set('automation', 'false');
  }
  const args = launch.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\u0000-\u001f\u007f]/.test(arg))) throw new Error('Invalid launch args');
  let proxy;
  for (const arg of args) {
    if (['--no-sandbox', '--disable-setuid-sandbox', '--window-position=0,0'].includes(arg)) continue;
    if (arg.startsWith('--proxy-server=')) {
      if (proxy !== undefined || translated.has('proxy')) throw new Error('Duplicate proxy option');
      proxy = arg.slice('--proxy-server='.length);
      if (!proxy) throw new Error('Invalid proxy option');
      translated.set('proxy', proxy);
      continue;
    }
    throw new Error('Unsupported launch argument');
  }
  return translated;
}
