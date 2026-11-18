import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { listeningAddress } from './moli-listen.mjs';
import { accessDeniedTitles, accessDeniedSelectors, challengeTitles, challengeSelectors } from './upstream/challenges.mjs';

const port = Number(process.env.BRIDGE_PORT ?? 8191);
const host = process.env.BRIDGE_HOST ?? '127.0.0.1';
const moli = process.env.MOLI_BIN ?? 'moli';
const userAgent = process.env.MOLI_USER_AGENT;
const maxSessions = Number(process.env.BRIDGE_MAX_SESSIONS ?? 8);
const sessions = new Map();
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
function normalizeProxy(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string') throw new Error('Invalid proxy');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('Invalid proxy URL'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname) throw new Error('Unsupported proxy URL');
  if (value.username !== undefined) url.username = value.username;
  if (value.password !== undefined) url.password = value.password;
  return url.href;
}
function deadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function stop(entry) {
  if (entry.closed) return;
  entry.closed = true;
  entry.child?.kill('SIGTERM');
  if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
    const child = entry.child;
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
  // The subprocess owns the connection; killing it is sufficient and avoids hanging on CDP cleanup.
}
async function remove(id, entry) {
  if (sessions.get(id) === entry) sessions.delete(id);
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
    await deadline(entry.ready, ms);
    if (entry.closed) throw new Error('Session closed');
    return [id, entry];
  }
  if (sessions.size >= maxSessions) throw new Error('Session limit reached');
  const entry = { id, created: Date.now(), queue: Promise.resolve(), closed: false, proxy };
  sessions.set(id, entry);
  entry.ready = launch(entry, proxy, ms);
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
async function browse(entry, req, url, ms) {
  const context = entry.context;
  const cookies = inputCookies(req.cookies, url);
  if (cookies.length) await context.addCookies(cookies);
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(ms);
    page.setDefaultNavigationTimeout(ms);
    if (req.headers !== undefined) {
      if (!req.headers || typeof req.headers !== 'object' || Array.isArray(req.headers) || Object.values(req.headers).some(v => typeof v !== 'string')) throw new Error('headers must be an object of strings');
      await page.setExtraHTTPHeaders(req.headers);
    }
    if (req.cmd === 'request.post' || req.disableMedia) {
      let postPending = req.cmd === 'request.post';
      if (postPending && typeof req.postData !== 'string') throw new Error('postData must be a string');
      const headers = { ...(req.headers ?? {}) };
      if (postPending && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
      await page.route('**/*', async route => {
        if (postPending && route.request().isNavigationRequest() && route.request().url() === url) {
          postPending = false;
          await route.continue({ method: 'POST', postData: req.postData, headers: { ...route.request().headers(), ...headers } });
        } else if (req.disableMedia && ['image', 'stylesheet', 'font', 'media'].includes(route.request().resourceType())) {
          await route.abort();
        } else await route.continue();
      });
    }
    const response = await page.goto(url, { waitUntil: 'load', timeout: ms });
    // Detection patterns follow FlareSolverr; this does not implement its solvers.
    while (true) {
      const title = await page.title();
      if (accessDeniedTitles.includes(title) || await page.locator(accessDeniedSelectors.join(',')).count()) {
        throw new Error('The site denied access');
      }
      if (!challengeTitles.includes(title) && !(await page.locator(challengeSelectors.join(',')).count())) break;
      await page.waitForTimeout(250);
    }
    if (req.waitInSeconds) await page.waitForTimeout(req.waitInSeconds * 1000);
    const result = {
      url: page.url(), status: response?.status() ?? 0,
      headers: response ? await response.allHeaders() : {},
      cookies: await context.cookies(page.url()), userAgent: await page.evaluate(() => navigator.userAgent),
    };
    if (!req.returnOnlyCookies) result.response = await page.content();
    if (req.returnScreenshot) result.screenshot = (await page.screenshot()).toString('base64');
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
async function execute(req) {
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
  const ms = duration(req.maxTimeout);
  const started = Date.now();
  const url = requestUrl(req.url);
  if (req.waitInSeconds !== undefined && (!Number.isFinite(req.waitInSeconds) || req.waitInSeconds < 0 || req.waitInSeconds > 600)) throw new Error('Invalid waitInSeconds');
  if (req.tabs_till_verify !== undefined) throw new Error('tabs_till_verify is not supported');
  if (req.session_ttl_minutes !== undefined && (!Number.isFinite(req.session_ttl_minutes) || req.session_ttl_minutes <= 0)) throw new Error('Invalid session TTL');
  const temporary = !req.session;
  let id = req.session ? idValid(req.session) : randomUUID();
  let entry = sessions.get(id);
  let expiredProxy;
  if (entry && req.session_ttl_minutes !== undefined) {
    if (Date.now() - entry.created > req.session_ttl_minutes * 60000) {
      expiredProxy = entry.proxy;
      await remove(id, entry);
      entry = undefined;
    }
  }
  if (!entry) [id, entry] = await create(id, temporary ? normalizeProxy(req.proxy) : expiredProxy, ms);
  try {
    const startupRemaining = ms - (Date.now() - started);
    if (startupRemaining <= 0) throw new Error('Timeout while starting session');
    await deadline(entry.ready, startupRemaining);
    if (entry.closed) throw new Error('Session closed');
  } catch (error) {
    if (temporary) await remove(id, entry);
    throw error;
  }
  let startedOperation = false;
  const operation = entry.queue.then(() => {
    if (entry.closed) throw new Error('Session closed');
    const remaining = ms - (Date.now() - started);
    if (remaining <= 0) throw new Error('Timeout while waiting for session');
    startedOperation = true;
    return browse(entry, req, url, remaining);
  });
  entry.queue = operation.catch(() => {});
  try {
    const remaining = ms - (Date.now() - started);
    if (remaining <= 0) throw new Error('Timeout while starting session');
    return { solution: await deadline(operation, remaining) };
  } catch (error) {
    // A timed-out browser operation may still be running; retire its entire process.
    if (startedOperation && /Timeout/i.test(error.message)) await remove(id, entry);
    throw error;
  } finally {
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
  let result;
  try { result = { status: 'ok', message: '', ...await execute(await readBody(req)) }; }
  catch (error) { result = { status: 'error', message: error.message || 'Unknown error' }; }
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
