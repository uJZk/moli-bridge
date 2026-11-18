// URL profile parsing and validation for the standalone CDP gateway.
const names = `timezone locale platform brand gpu-vendor gpu-renderer hardware-concurrency
viewport-width viewport-height screen-width screen-height device-scale-factor viewport-scale screen-orientation
screen-orientation-angle position-x position-y touch max-touch-points latitude longitude accuracy
altitude altitude-accuracy heading speed user-agent accept-language platform-version architecture
bitness model browser-version wow64 form-factors ua-brands ua-full-version-list media color-scheme reduced-motion reduced-transparency
forced-colors contrast proxy proxy-bypass data-saver automation javascript focus-emulation
emit-touch-for-mouse scrollbars offline bypass-service-worker layout subframes
load-resources load-images load-fonts load-audio load-video load-media load-text-tracks`.split(/\s+/);
const fields = new Set(names);
const geometry = ['viewport-width', 'viewport-height', 'screen-width', 'screen-height', 'device-scale-factor', 'viewport-scale', 'screen-orientation', 'screen-orientation-angle', 'position-x', 'position-y'];
const location = ['latitude', 'longitude', 'accuracy', 'altitude', 'altitude-accuracy', 'heading', 'speed'];
const choices = {
  platform: ['windows', 'linux', 'macos'], brand: ['edge', 'chrome', 'chromium'],
  'screen-orientation': ['portrait-primary', 'portrait-secondary', 'landscape-primary', 'landscape-secondary'],
  architecture: ['x86', 'arm'], bitness: ['32', '64'],
  media: ['screen', 'print'], 'color-scheme': ['light', 'dark'],
  'reduced-motion': ['reduce', 'no-preference'], 'reduced-transparency': ['reduce', 'no-preference'],
  'forced-colors': ['active', 'none'], contrast: ['more', 'less', 'no-preference', 'custom'], scrollbars: ['visible', 'hidden'],
};
function number(profile, key, min, max, integer = false) {
  if (!(key in profile)) return;
  const raw = profile[key];
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`Invalid ${key}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${key}`);
  profile[key] = value;
}
function boolean(profile, key) {
  if (!(key in profile)) return;
  const value = profile[key].toLowerCase();
  if (!['true', 'false', '1', '0'].includes(value)) throw new Error(`Invalid ${key}`);
  profile[key] = value === 'true' || value === '1';
}
export function parseProfile(params) {
  const profile = {};
  const seen = new Set();
  for (const [key, raw] of params) {
    if (!fields.has(key)) throw new Error(`Unknown parameter: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate parameter: ${key}`);
    seen.add(key);
    if (raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error(`Invalid ${key}`);
    // Empty values mean unspecified; zero and false remain explicit.
    if (raw.trim() !== '') profile[key] = raw;
  }
  if (profile.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: profile.timezone }); } catch { throw new Error('Invalid timezone'); }
  }
  if (profile.locale) {
    try { profile.locale = Intl.getCanonicalLocales(profile.locale)[0]; } catch { throw new Error('Invalid locale'); }
    if (!profile.locale) throw new Error('Invalid locale');
  }
  for (const [key, values] of Object.entries(choices)) {
    if (!(key in profile)) continue;
    const value = profile[key].toLowerCase();
    if (!values.includes(value)) throw new Error(`Invalid ${key}`);
    profile[key] = value;
  }
  for (const key of ['viewport-width', 'viewport-height', 'screen-width', 'screen-height']) number(profile, key, 1, 100000, true);
  number(profile, 'device-scale-factor', 0.1, 10);
  number(profile, 'viewport-scale', 0.1, 10);
  number(profile, 'screen-orientation-angle', 0, 359, true);
  for (const key of ['position-x', 'position-y']) number(profile, key, 0, 100000, true);
  number(profile, 'hardware-concurrency', 1, 256, true);
  number(profile, 'max-touch-points', 0, 16, true);
  for (const key of ['touch', 'wow64', 'data-saver', 'automation', 'javascript', 'focus-emulation', 'emit-touch-for-mouse', 'offline', 'bypass-service-worker', 'layout', 'subframes', 'load-resources', 'load-images', 'load-fonts', 'load-audio', 'load-video', 'load-media', 'load-text-tracks']) boolean(profile, key);
  if (profile.layout === false && profile.scrollbars) throw new Error('scrollbars requires layout');
  if (profile.touch === false && profile['max-touch-points'] > 0) throw new Error('touch=false conflicts with max-touch-points');
  if (profile.touch === true && profile['max-touch-points'] === 0) throw new Error('touch=true conflicts with max-touch-points=0');
  number(profile, 'latitude', -90, 90);
  number(profile, 'longitude', -180, 180);
  number(profile, 'accuracy', 0, Number.MAX_VALUE);
  number(profile, 'altitude', -Number.MAX_VALUE, Number.MAX_VALUE);
  number(profile, 'altitude-accuracy', 0, Number.MAX_VALUE);
  number(profile, 'heading', 0, 360);
  if (profile.heading === 360) throw new Error('Invalid heading');
  number(profile, 'speed', 0, Number.MAX_VALUE);
  if (location.some(key => key in profile) && !('latitude' in profile && 'longitude' in profile)) throw new Error('latitude and longitude must both be provided for geolocation');
  if (profile['browser-version'] && !/^\d+(?:\.\d+){0,3}$/.test(profile['browser-version'])) throw new Error('Invalid browser-version');
  for (const key of ['user-agent', 'accept-language', 'platform-version', 'model']) if (profile[key] && /[^\x20-\x7e]/.test(profile[key])) throw new Error(`Invalid ${key}`);
  if (profile['form-factors']) {
    const items = profile['form-factors'].split(',').map(value => value.trim());
    if (items.length > 16 || items.some(value => !value || /[^\x20-\x7e]/.test(value))) throw new Error('Invalid form-factors');
    profile['form-factors'] = items;
  }
  for (const key of ['ua-brands', 'ua-full-version-list']) {
    if (!(key in profile)) continue;
    let items;
    try { items = JSON.parse(profile[key]); } catch { throw new Error(`Invalid ${key}`); }
    if (!Array.isArray(items) || items.length > 16 || items.some(value => !value || typeof value !== 'object' || Array.isArray(value) || typeof value.brand !== 'string' || typeof value.version !== 'string' || /[^\x20-\x7e]/.test(value.brand + value.version))) throw new Error(`Invalid ${key}`);
    profile[key] = items.map(({ brand, version }) => ({ brand, version }));
  }
  if (profile.proxy) {
    let url;
    try { url = new URL(profile.proxy); } catch { throw new Error('Invalid proxy'); }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid proxy');
    profile.proxy = url.href;
  }
  if (geometry.some(key => key in profile)) {
    const sw = profile['screen-width'] ?? Math.max(1920, profile['viewport-width'] ?? 0);
    const sh = profile['screen-height'] ?? Math.max(1080, profile['viewport-height'] ?? 0);
    const width = profile['viewport-width'] ?? Math.min(1920, sw);
    const height = profile['viewport-height'] ?? Math.min(1080, sh);
    if (width > sw || height > sh) throw new Error('viewport cannot exceed screen size');
    if ((profile['position-x'] ?? 0) > sw || (profile['position-y'] ?? 0) > sh) throw new Error('screen position exceeds screen size');
    const orientations = { 'portrait-primary': 'portraitPrimary', 'portrait-secondary': 'portraitSecondary', 'landscape-primary': 'landscapePrimary', 'landscape-secondary': 'landscapeSecondary' };
    const orientation = profile['screen-orientation'] ?? (sw < sh ? 'portrait-primary' : 'landscape-primary');
    profile.metrics = { width, height, screenWidth: sw, screenHeight: sh, deviceScaleFactor: profile['device-scale-factor'] ?? 1, scale: profile['viewport-scale'] ?? 1, mobile: false,
      screenOrientation: { type: orientations[orientation], angle: profile['screen-orientation-angle'] ?? (orientation.endsWith('secondary') ? 180 : 0) },
      positionX: profile['position-x'] ?? 0, positionY: profile['position-y'] ?? 0 };
  }
  if (location.some(key => key in profile)) {
    profile.geolocation = { latitude: profile.latitude, longitude: profile.longitude, accuracy: profile.accuracy ?? 100 };
    for (const [key, name] of [['altitude', 'altitude'], ['altitude-accuracy', 'altitudeAccuracy'], ['heading', 'heading'], ['speed', 'speed']]) if (key in profile) profile.geolocation[name] = profile[key];
  }
  if ('touch' in profile || 'max-touch-points' in profile) {
    const count = profile['max-touch-points'] ?? (profile.touch ? 1 : 0);
    profile.touchSettings = { enabled: count > 0, ...(count > 0 ? { maxTouchPoints: count } : {}) };
  }
  const features = [];
  for (const [key, name] of [['color-scheme', 'prefers-color-scheme'], ['reduced-motion', 'prefers-reduced-motion'], ['reduced-transparency', 'prefers-reduced-transparency'], ['forced-colors', 'forced-colors'], ['contrast', 'prefers-contrast']]) {
    if (key in profile) features.push({ name, value: profile[key] });
  }
  if (features.length || profile.media) profile.mediaSettings = { ...(profile.media ? { media: profile.media } : {}), features };
  return profile;
}
