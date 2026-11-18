// Experimental standalone CDP gateway. Run in an isolation boundary separate
// from the FlareSolverr bridge; see README.md.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { parseProfile } from './cdp-profile.mjs';
import { listeningAddress } from './moli-listen.mjs';

const host = process.env.CDP_HOST ?? '127.0.0.1';
const port = Number(process.env.CDP_PORT ?? 9222);
const moli = process.env.MOLI_BIN ?? 'moli';
const capacity = Number(process.env.CDP_MAX_BROWSERS ?? 8);
const entries = new Map();
const platforms = { windows: ['Win32', 'Windows NT 10.0; Win64; x64', 'Windows'], linux: ['Linux x86_64', 'X11; Linux x86_64', 'Linux'], macos: ['MacIntel', 'Macintosh; Intel Mac OS X 10_15_7', 'macOS'] };
function close(entry) {
  if (entry.closed) return;
  entry.closed = true;
  entries.delete(entry.token);
  clearTimeout(entry.timer);
  entry.cancelPending?.();
  entry.client?.terminate();
  entry.upstream?.terminate();
  if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill('SIGTERM');
    const timer = setTimeout(() => entry.child.kill('SIGKILL'), 2000);
    timer.unref();
    entry.child.once('exit', () => clearTimeout(timer));
  }
}
async function start(profile) {
  if (entries.size >= capacity) throw new Error('Browser capacity reached');
  const entry = { token: randomUUID(), profile, closed: false };
  entries.set(entry.token, entry);
  const args = ['serve', '--host', '127.0.0.1', '--port', '0'];
  if (profile.layout !== false) args.push('--layout');
  const resourceFlags = [['load-images', '--image'], ['load-fonts', '--font'], ['load-audio', '--audio'], ['load-video', '--video'], ['load-media', '--media'], ['load-text-tracks', '--text-track']];
  const enabled = resourceFlags.filter(([key]) => profile[key] ?? profile['load-resources'] ?? true);
  if (enabled.length === resourceFlags.length) args.push('--resource');
  else args.push(...enabled.map(([, flag]) => flag));
  if (profile.subframes === false) args.push('--disable-subframes');
  if (profile.proxy) args.push('--http-proxy', profile.proxy, '--http-no-proxy', profile['proxy-bypass'] ?? '');
  else if (profile['proxy-bypass']) args.push('--http-no-proxy', profile['proxy-bypass']);
  const child = spawn(moli, args, {
    env: { ...process.env, RUST_LOG: 'info', ...(profile.timezone ? { TZ: profile.timezone } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  entry.child = child;
  child.once('exit', () => close(entry));
  try {
    const address = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Moli startup timed out')), 10000);
      const done = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      const read = chunk => {
        output = (output + chunk.toString()).slice(-16384);
        const address = listeningAddress(output);
        if (address) done(null, address);
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', error => done(error));
      child.once('exit', () => done(new Error('Moli exited before startup')));
    });
    const response = await fetch(`${address}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Moli discovery failed');
    entry.version = await response.json();
    if (entry.closed || !entry.version.webSocketDebuggerUrl) throw new Error('Moli is unavailable');
    entry.timer = setTimeout(() => close(entry), 30000);
    entry.timer.unref();
    return entry;
  } catch (error) { close(entry); throw error; }
}
function uaSettings(profile, version) {
  if (!['locale', 'platform', 'brand', 'user-agent', 'accept-language', 'platform-version', 'architecture', 'bitness', 'model', 'browser-version', 'wow64', 'form-factors', 'ua-brands', 'ua-full-version-list'].some(key => key in profile)) return undefined;
  const base = version['User-Agent'];
  if (typeof base !== 'string') throw new Error('Moli did not return its user agent');
  const match = (profile['user-agent'] ?? base).match(/Chrome\/(\d+(?:\.\d+){0,3})/) ?? base.match(/Chrome\/(\d+(?:\.\d+){0,3})/);
  if (!match) throw new Error('Unsupported Moli user-agent format');
  const fullVersion = profile['browser-version'] ?? match[1];
  const major = fullVersion.split('.')[0];
  const custom = profile['user-agent'] ?? '';
  const inferredPlatform = /Windows NT/i.test(custom) ? 'windows' : /Macintosh/i.test(custom) ? 'macos' : /Linux/i.test(custom) ? 'linux' : 'windows';
  const platform = platforms[profile.platform ?? inferredPlatform];
  let userAgent = profile['user-agent'] ?? base.replace(/\([^)]*\)/, `(${platform[1]})`).replace(/\s+Edg\/[^\s]+/g, '').replace(/Chrome\/\d+(?:\.\d+)*/g, `Chrome/${fullVersion}`);
  if (!profile['user-agent'] && profile.brand === 'edge') userAgent += ` Edg/${fullVersion}`;
  const chosenBrand = profile.brand ?? (/\bEdg\//.test(custom) ? 'edge' : 'chrome');
  const brand = chosenBrand === 'edge' ? 'Microsoft Edge' : chosenBrand === 'chromium' ? 'Chromium' : 'Google Chrome';
  const brands = [{ brand: 'Chromium', version: major }, { brand: 'Not:A-Brand', version: '8' }];
  const fullVersionList = [{ brand: 'Chromium', version: fullVersion }, { brand: 'Not:A-Brand', version: '8.0.0.0' }];
  if (brand !== 'Chromium') {
    brands.push({ brand, version: major });
    fullVersionList.push({ brand, version: fullVersion });
  }
  return {
    userAgent, platform: platform[0], ...((profile['accept-language'] ?? profile.locale) ? { acceptLanguage: profile['accept-language'] ?? profile.locale } : {}),
    userAgentMetadata: { brands: profile['ua-brands'] ?? brands, fullVersionList: profile['ua-full-version-list'] ?? fullVersionList, fullVersion, platform: platform[2], platformVersion: profile['platform-version'] ?? (platform[2] === 'Windows' ? '19.0.0' : ''), architecture: profile.architecture ?? 'x86', model: profile.model ?? '', mobile: false, bitness: profile.bitness ?? '64', wow64: profile.wow64 ?? false, ...(profile['form-factors'] ? { formFactors: profile['form-factors'] } : {}) },
  };
}
function gpuScript(profile) {
  if (!profile['gpu-vendor'] && !profile['gpu-renderer']) return undefined;
  const vendor = JSON.stringify(profile['gpu-vendor'] ?? null);
  const renderer = JSON.stringify(profile['gpu-renderer'] ?? null);
  return `(() => { const vendor = ${vendor}, renderer = ${renderer};
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const proto = globalThis[name]?.prototype;
      if (!proto || typeof proto.getParameter !== 'function') continue;
      const original = proto.getParameter;
      Object.defineProperty(proto, 'getParameter', { configurable: true, writable: true, value: function(parameter) {
        const actual = original.call(this, parameter);
        if (parameter === 0x9245 && vendor !== null) return vendor;
        if (parameter === 0x9246 && renderer !== null) return renderer;
        return actual;
      }});
    }
  })();`;
}
function relay(entry, client) {
  entry.client = client;
  const upstream = new WebSocket(entry.version.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
  entry.upstream = upstream;
  const waiting = [];
  const commands = new Map();
  const pending = new Map();
  const pages = new Set();
  const initialMedia = new Set();
  const initialFocus = new Set();
  const configuredTargets = new Set();
  const targetReplies = new Map();
  let localeOwner;
  let localeClaim;
  let autoAttach = false;
  let nextId = 1;
  entry.cancelPending = () => {
    for (const command of commands.values()) {
      if (command.timer) clearTimeout(command.timer);
      if (command.reject) command.reject(new Error('CDP connection closed'));
    }
    commands.clear();
    for (const reply of targetReplies.values()) clearTimeout(reply.timer);
    targetReplies.clear();
  };
  function sendBackend(message) { upstream.send(JSON.stringify(message)); }
  function sendClient(message) { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); }
  function internal(sessionId, method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { commands.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
      commands.set(id, { resolve, reject, timer });
      sendBackend({ id, sessionId, method, params });
    });
  }
  async function configure(sessionId, type) {
    const isWorker = type === 'worker' || type === 'shared_worker' || type === 'service_worker';
    if (isWorker) {
      if (entry.profile['hardware-concurrency']) await internal(sessionId, 'Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: entry.profile['hardware-concurrency'] });
      if ('data-saver' in entry.profile) await internal(sessionId, 'Emulation.setDataSaverOverride', { dataSaverEnabled: entry.profile['data-saver'] });
      if ('automation' in entry.profile) await internal(sessionId, 'Emulation.setAutomationOverride', { enabled: entry.profile.automation });
      const ua = uaSettings(entry.profile, entry.version);
      if (ua) await internal(sessionId, 'Emulation.setUserAgentOverride', ua);
      const source = gpuScript(entry.profile);
      if (source) await internal(sessionId, 'Runtime.evaluate', { expression: source });
      return;
    }
    if (type !== 'page' && type !== 'iframe') return;
    pages.add(sessionId);
    const p = entry.profile;
    if (p.locale) {
      // Moli's ICU locale is process-wide and only one session can own it.
      if (!localeClaim) {
        localeClaim = internal(sessionId, 'Emulation.setLocaleOverride', { locale: p.locale }).then(() => { localeOwner = sessionId; });
      }
      await localeClaim;
    }
    if (p['hardware-concurrency']) await internal(sessionId, 'Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: p['hardware-concurrency'] });
    if (p.metrics) await internal(sessionId, 'Emulation.setDeviceMetricsOverride', p.metrics);
    if (p.touchSettings) await internal(sessionId, 'Emulation.setTouchEmulationEnabled', p.touchSettings);
    if (p.geolocation) await internal(sessionId, 'Emulation.setGeolocationOverride', p.geolocation);
    if ('data-saver' in p) await internal(sessionId, 'Emulation.setDataSaverOverride', { dataSaverEnabled: p['data-saver'] });
    if ('automation' in p) await internal(sessionId, 'Emulation.setAutomationOverride', { enabled: p.automation });
    if ('javascript' in p) await internal(sessionId, 'Emulation.setScriptExecutionDisabled', { value: !p.javascript });
    if ('focus-emulation' in p) {
      await internal(sessionId, 'Emulation.setFocusEmulationEnabled', { enabled: p['focus-emulation'] });
      initialFocus.add(sessionId);
    }
    if ('emit-touch-for-mouse' in p) await internal(sessionId, 'Emulation.setEmitTouchEventsForMouse', { enabled: p['emit-touch-for-mouse'] });
    if (p.scrollbars) await internal(sessionId, 'Emulation.setScrollbarsHidden', { hidden: p.scrollbars === 'hidden' });
    if ('offline' in p) await internal(sessionId, 'Network.emulateNetworkConditions', { offline: p.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if ('bypass-service-worker' in p) await internal(sessionId, 'Network.setBypassServiceWorker', { bypass: p['bypass-service-worker'] });
    if (p.mediaSettings) {
      await internal(sessionId, 'Emulation.setEmulatedMedia', p.mediaSettings);
      initialMedia.add(sessionId);
    }
    const ua = uaSettings(p, entry.version);
    if (ua) await internal(sessionId, 'Emulation.setUserAgentOverride', ua);
    const source = gpuScript(p);
    if (source) await internal(sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true });
  }
  function forwardClient(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { console.error('Invalid client CDP message'); close(entry); return; }
    if (!Number.isSafeInteger(message.id) || message.id < 0) { console.error('Invalid client CDP id'); close(entry); return; }
    const forward = () => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      const id = nextId++;
      commands.set(id, { original: message.id, method: message.method });
      if (!message.sessionId && message.method === 'Target.setAutoAttach') autoAttach = Boolean(message.params?.autoAttach);
      // Playwright sends default media settings while attaching. Preserve the
      // URL defaults on that first initialization; later client changes win.
      if (message.method === 'Emulation.setEmulatedMedia' && initialMedia.delete(message.sessionId)) {
        const settings = entry.profile.mediaSettings;
        const features = new Map((message.params?.features ?? []).map(feature => [feature.name, feature]));
        for (const feature of settings.features) features.set(feature.name, feature);
        message.params = { ...(message.params ?? {}), ...('media' in settings ? { media: settings.media } : {}), features: [...features.values()] };
      }
      if (message.method === 'Emulation.setFocusEmulationEnabled' && initialFocus.delete(message.sessionId)) {
        message.params = { ...message.params, enabled: entry.profile['focus-emulation'] };
      }
      sendBackend({ ...message, id });
    };
    const target = pending.get(message.sessionId);
    if (target) target.ready.then(forward, () => close(entry));
    else forward();
  }
  client.on('message', raw => upstream.readyState === WebSocket.OPEN ? forwardClient(raw) : waiting.push(raw));
  client.on('close', () => close(entry));
  client.on('error', () => close(entry));
  upstream.on('open', () => { for (const raw of waiting.splice(0)) forwardClient(raw); });
  upstream.on('close', () => close(entry));
  upstream.on('error', () => close(entry));
  upstream.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { close(entry); return; }
    if (message.id !== undefined) {
      const command = commands.get(message.id);
      if (!command) { console.error(`Unexpected CDP response id ${message.id}`); close(entry); return; }
      commands.delete(message.id);
      if (command.resolve) {
        clearTimeout(command.timer);
        if (message.error) command.reject(new Error(message.error.message));
        else command.resolve(message.result);
      } else {
        const response = { ...message, id: command.original };
        const targetId = command.method === 'Target.createTarget' && autoAttach && message.result?.targetId;
        if (targetId && !configuredTargets.has(targetId)) {
          const timer = setTimeout(() => {
            targetReplies.delete(targetId);
            sendClient({ id: response.id, error: { code: -32000, message: 'Timed out applying CDP profile to target' } });
          }, 12000);
          targetReplies.set(targetId, { response, timer });
        }
        else sendClient(response);
      }
      return;
    }
    if (message.method === 'Target.attachedToTarget' && message.params?.sessionId) {
      const sid = message.params.sessionId;
      const buffer = [];
      const state = { buffer };
      pending.set(sid, state);
      state.ready = configure(sid, message.params.targetInfo?.type).then(() => {
        pending.delete(sid);
        sendClient(message);
        for (const event of buffer) sendClient(event);
        const targetId = message.params.targetInfo?.targetId;
        if (targetId) {
          configuredTargets.add(targetId);
          const reply = targetReplies.get(targetId);
          if (reply) { clearTimeout(reply.timer); targetReplies.delete(targetId); sendClient(reply.response); }
        }
      });
      state.ready.catch(error => { if (!entry.closed) console.error(`CDP configuration failed: ${error.message}`); close(entry); });
      return;
    }
    if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
      const sid = message.params.sessionId;
      pages.delete(sid);
      initialMedia.delete(sid);
      initialFocus.delete(sid);
      if (sid === localeOwner) {
        localeOwner = undefined;
        localeClaim = undefined;
        const replacement = pages.values().next().value;
        if (replacement) {
          localeClaim = internal(replacement, 'Emulation.setLocaleOverride', { locale: entry.profile.locale }).then(() => { localeOwner = replacement; });
          localeClaim.then(() => sendClient(message), error => { console.error(`CDP locale transfer failed: ${error.message}`); close(entry); });
          return;
        }
      }
    }
    const state = pending.get(message.sessionId);
    if (state) state.buffer.push(message);
    else sendClient(message);
  });
}
const ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'GET' || !['/json/version', '/json/version/'].includes(url.pathname)) { res.writeHead(404).end(); return; }
  try {
    const profile = parseProfile(url.searchParams);
    const entry = await start(profile);
    const authority = req.headers.host;
    if (!authority || /[\s/@\\]/.test(authority)) { close(entry); throw new Error('Invalid Host'); }
    const result = { ...entry.version, webSocketDebuggerUrl: `ws://${authority}/devtools/browser/${entry.token}` };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.on('upgrade', (req, socket, head) => {
  const match = req.url?.match(/^\/devtools\/browser\/([0-9a-f-]+)$/);
  const entry = match && entries.get(match[1]);
  if (!entry || entry.client || entry.closed) { socket.destroy(); return; }
  clearTimeout(entry.timer);
  ws.handleUpgrade(req, socket, head, client => relay(entry, client));
});
server.listen(port, host, () => console.log(`CDP gateway listening on ${host}:${port}`));
function shutdown() {
  server.close();
  for (const entry of entries.values()) close(entry);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
