import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { listeningAddress } from './moli-listen.mjs';
import { collectPageResult, navigateInitial, observeNavigation } from './page-result.mjs';
import { DeadlineError, RequestBudget, RequestCancelledError } from './upstream/request-budget.mjs';
import { PostReplay } from './upstream/post-replay.mjs';
import { resolveTurnstileToken } from './upstream/turnstile-token.mjs';
import { ClearanceRecovery } from './upstream/trawl-clearance-recovery.mjs';
import { processLimit } from './process-limit.mjs';
import { waitForProcessExit } from './process-exit.mjs';
import { normalizeProxy } from './proxy-url.mjs';
import { createDiagnostics } from './diagnostics.mjs';

const port = Number(process.env.BRIDGE_PORT ?? 8191);
const host = process.env.BRIDGE_HOST ?? '127.0.0.1';
const moli = process.env.MOLI_BIN ?? 'moli';
const userAgent = process.env.MOLI_USER_AGENT;
const maxSessions = processLimit(process.env.BRIDGE_MAX_SESSIONS, 'BRIDGE_MAX_SESSIONS');
const sessions = new Map();
const retiring = new Set();
const VERSION = 'moli-bridge/0.1.0';
const defaultTimeout = 60000;
const maxBody = 1024 * 1024;
let stopping = false;

function duration(value) {
  if (value === undefined) return defaultTimeout;
  if (!Number.isFinite(value) || value < 1 || value > 600000) throw new Error('maxTimeout must be between 1 and 600000 milliseconds');
  return value;
}
function idValid(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session ID');
  return id;
}
function deadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function abortable(promise, signal) {
  if (!signal) return promise;
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(new RequestCancelledError());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally { signal.removeEventListener('abort', abort); }
}
async function stop(entry) {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.child && entry.child.pid !== undefined && entry.child.exitCode === null && entry.child.signalCode === null) {
    const child = entry.child;
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    child.kill('SIGTERM');
  }
  // The subprocess owns the connection; killing it is sufficient and avoids hanging on CDP cleanup.
}
async function remove(id, entry) {
  if (sessions.get(id) === entry) sessions.delete(id);
  if (entry.child && entry.child.pid !== undefined && entry.child.exitCode === null && entry.child.signalCode === null && !retiring.has(entry)) {
    // Retired sessions disappear from the API immediately, but their process
    // still consumes capacity until the OS reports that it has exited.
    retiring.add(entry);
    entry.child.once('exit', () => retiring.delete(entry));
  }
  await stop(entry);
}
async function launch(entry, proxy, ms) {
  const args = ['serve', '--host', '127.0.0.1', '--port', '0', '--layout', '--resource'];
  if (proxy) args.push('--http-proxy', proxy, '--http-no-proxy', '');
  if (userAgent) args.push('--user-agent', userAgent);
  const env = { ...process.env, RUST_LOG: 'info' };
  // Ambient proxy settings should never silently override the requested proxy.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete env[key];
  const child = spawn(moli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  entry.child = child;
  child.once('exit', () => {
    if (!entry.closed) void remove(entry.id, entry);
  });
  const endpoint = await deadline(new Promise((resolve, reject) => {
    let output = '';
    const read = chunk => {
      output += chunk.toString();
      const address = listeningAddress(output);
      if (address) resolve(address);
      if (output.length > 16384) output = output.slice(-8192);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Moli exited before becoming ready')));
  }), ms);
  if (entry.closed) throw new Error('Session closed');
  entry.browser = await deadline(chromium.connectOverCDP(endpoint, { timeout: ms }), ms);
  if (entry.closed) throw new Error('Session closed');
  entry.context = entry.browser.contexts()[0];
  if (!entry.context) throw new Error('Moli has no default browser context');
}
async function create(id, proxy, ms) {
  if (stopping) throw new Error('Bridge is shutting down');
  id = idValid(id ?? randomUUID());
  if (sessions.has(id)) {
    const entry = sessions.get(id);
    if (entry.rotating) throw new Error('Session is busy; retry after session expiration');
    await deadline(entry.ready, ms);
    if (entry.closed) throw new Error('Session closed');
    return [id, entry];
  }
  if (sessions.size + retiring.size >= maxSessions) throw new Error('Session limit reached');
  const entry = { id, created: Date.now(), queue: Promise.resolve(), closed: false, busy: false, initializing: true, proxy };
  sessions.set(id, entry);
  entry.ready = launch(entry, proxy, ms).finally(() => { entry.initializing = false; });
  try {
    await deadline(entry.ready, ms);
    return [id, entry];
  } catch (error) {
    await remove(id, entry);
    throw error;
  }
}
function inputCookies(cookies, url) {
  if (cookies === undefined) return [];
  if (!Array.isArray(cookies)) throw new Error('cookies must be an array');
  return cookies.map(cookie => {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') throw new Error('Invalid cookie');
    const result = { name: cookie.name, value: cookie.value };
    if (cookie.domain) { result.domain = cookie.domain; result.path = cookie.path || '/'; }
    else result.url = url;
    for (const key of ['secure', 'httpOnly', 'expires']) if (cookie[key] !== undefined) result[key] = cookie[key];
    if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) result.sameSite = cookie.sameSite;
    return result;
  });
}
function requestUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  return url.href;
}
async function browse(entry, req, url, ms, setPhase, diagnostics) {
  const context = entry.context;
  const cookies = inputCookies(req.cookies, url);
  if (cookies.length) await context.addCookies(cookies);
  let recovery;
  if (req.cmd === 'request.get') {
    const existing = await context.cookies(url);
    recovery = {
      cloudflare: new ClearanceRecovery(url, existing),
      ddosGuard: new ClearanceRecovery(url, existing, { delay: 8000, matches: cookie => /^__ddg[25]_/.test(cookie.name) }),
      dataDome: new ClearanceRecovery(url, existing, { delay: 3000,
        matches: cookie => cookie.name === 'datadome' && Boolean(cookie.value),
        fingerprint: cookie => JSON.stringify([cookie.domain, cookie.value]) }),
    };
  }
  const page = await context.newPage();
  try {
    diagnostics.attach(page, url);
    page.setDefaultTimeout(ms);
    page.setDefaultNavigationTimeout(ms);
    if (req.headers !== undefined) {
      if (!req.headers || typeof req.headers !== 'object' || Array.isArray(req.headers) || Object.values(req.headers).some(v => typeof v !== 'string')) throw new Error('headers must be an object of strings');
      await page.setExtraHTTPHeaders(req.headers);
    }
    const postTarget = new URL(url);
    postTarget.hash = '';
    const replay = req.cmd === 'request.post' ? new PostReplay() : null;
    if (replay) { replay.beginAttempt(); page.on('response', replay.observe); }
    if (req.cmd === 'request.post' || req.disableMedia) {
      let postPending = req.cmd === 'request.post';
      const headers = { ...(req.headers ?? {}) };
      if (postPending && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
      await page.route('**/*', async route => {
        const request = route.request();
        const target = request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === postTarget.href;
        if (replay && target && (postPending || request.method() === 'POST')) {
          if (!await replay.submit(request)) { await route.abort('aborted'); return; }
          if (postPending) {
            postPending = false;
            await route.continue({ method: 'POST', postData: req.postData, headers: { ...request.headers(), ...headers } });
          } else await route.continue();
        } else if (req.disableMedia && ['image', 'stylesheet', 'font', 'media'].includes(route.request().resourceType())) {
          await route.abort();
        } else await route.continue();
      });
    }
    const state = observeNavigation(page);
    setPhase('waiting for initial navigation');
    const response = await navigateInitial(page, url, ms, state);
    setPhase('checking page');
    const turnstileToken = req.cmd === 'request.get' && req.tabs_till_verify !== undefined
      ? await resolveTurnstileToken(page, req.tabs_till_verify, state) : null;
    const result = await collectPageResult(page, context, req, response, state, replay, recovery, setPhase, diagnostics.report);
    result.turnstile_token = turnstileToken;
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
async function execute(req, signal) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('Request must be an object');
  const cmd = req.cmd;
  if (cmd === 'sessions.create') {
    const [id] = await create(req.session, normalizeProxy(req.proxy), duration(req.maxTimeout));
    return { session: id, message: 'Session is ready.' };
  }
  if (cmd === 'sessions.list') return { sessions: [...sessions.keys()] };
  if (cmd === 'sessions.destroy') {
    const id = idValid(req.session);
    const entry = sessions.get(id);
    if (!entry) throw new Error('Session does not exist');
    await remove(id, entry);
    return { message: 'The session has been removed.' };
  }
  if (cmd !== 'request.get' && cmd !== 'request.post') throw new Error('Unknown command');
  if (signal?.aborted) throw new RequestCancelledError();
  if (cmd === 'request.get' && req.postData != null) throw new Error('postData cannot be used with request.get');
  if (cmd === 'request.post' && typeof req.postData !== 'string') throw new Error('postData must be a string');
  const ms = duration(req.maxTimeout);
  const started = Date.now();
  const url = requestUrl(req.url);
  if (req.waitInSeconds !== undefined && (!Number.isFinite(req.waitInSeconds) || req.waitInSeconds < 0 || req.waitInSeconds > 600)) throw new Error('Invalid waitInSeconds');
  if (req.tabs_till_verify !== undefined && (!Number.isSafeInteger(req.tabs_till_verify) || req.tabs_till_verify < 0 || req.tabs_till_verify > 100)) throw new Error('tabs_till_verify must be an integer between 0 and 100');
  if (req.session_ttl_minutes !== undefined && (!Number.isFinite(req.session_ttl_minutes) || req.session_ttl_minutes <= 0)) throw new Error('Invalid session TTL');
  const temporary = !req.session;
  let id = req.session ? idValid(req.session) : randomUUID();
  let entry = sessions.get(id);
  let expiredProxy;
  if (entry?.rotating) throw new Error('Session is busy; retry after session expiration');
  if (entry && req.session_ttl_minutes !== undefined) {
    if (Date.now() - entry.created > req.session_ttl_minutes * 60000) {
      // Never retire a process underneath another request. Callers may retry
      // rotation after that request finishes, as in TRAWL's session manager.
      if (entry.busy || entry.initializing) throw new Error('Session is busy; retry session expiration after its request completes');
      expiredProxy = entry.proxy;
      entry.rotating = true;
      try {
        // Keep the old entry reserved while it exits: this keeps the process
        // within the capacity limit and prevents a concurrent unproxied create.
        await stop(entry);
        await waitForProcessExit(entry.child, ms - (Date.now() - started), signal);
        if (sessions.get(id) !== entry) throw new Error('Session closed during expiration');
        sessions.delete(id);
      } catch (error) {
        await remove(id, entry);
        throw error;
      }
      entry = undefined;
    }
  }
  if (signal?.aborted) throw new RequestCancelledError();
  if (!entry) {
    const createRemaining = ms - (Date.now() - started);
    if (createRemaining <= 0) throw new Error('Timeout while starting session');
    try { [id, entry] = await abortable(create(id, temporary ? normalizeProxy(req.proxy) : expiredProxy, createRemaining), signal); }
    catch (error) {
      // A temporary process belongs only to this request. Named sessions may
      // be shared by other callers while startup is in progress.
      if (temporary && signal?.aborted) {
        const created = sessions.get(id);
        if (created) await remove(id, created);
      }
      throw error;
    }
  }
  try {
    const startupRemaining = ms - (Date.now() - started);
    if (startupRemaining <= 0) throw new Error('Timeout while starting session');
    await deadline(abortable(entry.ready, signal), startupRemaining);
    if (entry.closed) throw new Error('Session closed');
  } catch (error) {
    if (temporary) await remove(id, entry);
    throw error;
  }
  const remaining = ms - (Date.now() - started);
  if (remaining <= 0) {
    if (temporary) await remove(id, entry);
    throw new Error('Timeout while starting session');
  }
  const budget = new RequestBudget(remaining, signal);
  const diagnostics = createDiagnostics(process.env.BRIDGE_DIAGNOSTICS === '1');
  let phase = 'waiting for session';
  const setPhase = value => {
    if (phase !== value) { phase = value; diagnostics.report('phase', { phase }); }
  };
  const operation = entry.queue.then(() => {
    budget.check();
    if (entry.closed) throw new Error('Session closed');
    // Retire an active process on timeout; a request still queued owns nothing.
    entry.busy = true;
    budget.own(() => remove(id, entry));
    setPhase('preparing page');
    return browse(entry, req, url, budget.remaining(), setPhase, diagnostics).finally(() => { entry.busy = false; });
  });
  entry.queue = operation.catch(() => {});
  try {
    return { solution: await budget.run(() => operation) };
  } catch (error) {
    diagnostics.report('finished', { result: error instanceof DeadlineError ? 'timeout' : 'error' });
    if (error instanceof DeadlineError) throw new Error(`${error.message} (${phase})`);
    throw error;
  } finally {
    budget.dispose();
    if (temporary) await remove(id, entry);
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > maxBody) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'Moli FlareSolverr bridge', version: VERSION }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1') { res.writeHead(404); res.end(); return; }
  const startTimestamp = Date.now();
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnected);
  let result;
  try { result = { status: 'ok', message: '', ...await execute(await readBody(req), controller.signal) }; }
  catch (error) { result = { status: 'error', message: error.message || 'Unknown error' }; }
  finally { res.removeListener('close', disconnected); }
  if (!res.destroyed) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...result, startTimestamp, endTimestamp: Date.now(), version: VERSION }));
  }
});
server.listen(port, host, () => console.log(`Bridge listening on ${host}:${port}`));
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.all([...sessions].map(([id, entry]) => remove(id, entry)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
