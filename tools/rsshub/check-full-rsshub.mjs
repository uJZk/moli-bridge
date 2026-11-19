// Runs inside a network-isolated container with a built RSSHub and Moli bridge.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSocks5Fixture } from './socks5-proxy-fixture.mjs';

const certificate = '/fixture/cert.pem';
const privateKey = '/fixture/key.pem';
for (const name of ['MOLI_TEST_SOCKS5H_ALIAS', 'MOLI_TEST_UNTRUSTED_PROXY', 'MOLI_TEST_DIRECT_CDP', 'MOLI_TEST_BILIBILI_RETRY', 'MOLI_TEST_EXPECT_NODE_RETRY']) {
  if (!['0', '1'].includes(process.env[name] ?? '0')) throw new Error(`Invalid ${name}`);
}
const proxyKind = process.env.MOLI_TEST_PROXY_KIND ?? 'http';
const alias = process.env.MOLI_TEST_SOCKS5H_ALIAS === '1';
const untrustedProxy = process.env.MOLI_TEST_UNTRUSTED_PROXY === '1';
const directCdp = process.env.MOLI_TEST_DIRECT_CDP === '1';
if (!['http', 'https', 'socks5'].includes(proxyKind) || (alias && proxyKind !== 'socks5') || (untrustedProxy && proxyKind !== 'https')) {
  throw new Error('Invalid proxy fixture configuration');
}
const username = 'fixture-user';
const password = 'p@ss:word%40';
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'moli-full-rsshub-'));
let target;
let proxy;
let gateway;
let rsshub;
let originHits = 0;
let biliHits = 0;
let authenticatedConnections = 0;
let authenticationFailures = 0;
let proxyConnections = 0;
let blockedImages = 0;
const sockets = new Set();
const diagnostics = [];

function watch(child, label) {
  const record = chunk => {
    const text = String(chunk).replaceAll(password, '[redacted]').replaceAll(encodeURIComponent(password), '[redacted]');
    diagnostics.push(`${label}: ${text}`);
    if (diagnostics.length > 50) diagnostics.shift();
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  child.on('error', error => record(error.message));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(4000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}

async function waitHealthy(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Process exited before ${url} became healthy`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete env[name];
  return env;
}

try {
  target = https.createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, (request, response) => {
    if (request.headers.host === 'api.bilibili.com' && request.url?.startsWith('/x/web-interface/popular')) {
      biliHits++;
      response.writeHead(biliHits === 1 ? 412 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(biliHits === 1 ? { code: -412 } : { code: 0, data: { list: [{ title: 'Moli Bili Fixture', pic: 'https://example.invalid/fixture.jpg', desc: 'local retry', aid: 123456, bvid: 'BV1xx411c7mD', pubdate: 1760000000, owner: { name: 'Moli Fixture Author' } }] } }));
      return;
    }
    if (request.url === '/blocked-image') { blockedImages++; response.writeHead(200); response.end('image'); return; }
    originHits++;
    const rows = '<tr id="stApp_activitydetails_row0"><td id="stApp_activitiesdateTime0">2026-11-15T10:30:00Z</td><td id="stApp_milestoneActivityLocation0"><strong>Delivered</strong>\nSeattle, WA</td></tr>' +
      '<tr id="stApp_activitydetails_row1"><td id="stApp_activitiesdateTime1">2026-11-14T08:00:00Z</td><td id="stApp_milestoneActivityLocation1">Departed\nPortland, OR</td></tr>';
    const visible = request.url?.includes('VISIBLE');
    const placeholder = visible ? '<tr id="stApp_activitydetails_row0"><td>Loading...</td></tr>' : '';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<title>Fixture tracking</title><button id="st_App_View_Details">Details</button><img src="/blocked-image"><table id="tracking-table"><tbody></tbody></table><script>document.getElementById('st_App_View_Details').addEventListener('click', () => { const table = document.getElementById('tracking-table'); table.style.display = ${JSON.stringify(visible ? '' : 'none')}; table.querySelector('tbody').innerHTML = ${JSON.stringify(placeholder)}; setTimeout(() => { table.querySelector('tbody').innerHTML = ${JSON.stringify(rows)}; table.style.display = ''; }, ${visible ? 1500 : 350}); });</script>`);
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  if (proxyKind === 'socks5') {
    proxy = createSocks5Fixture({ fixturePort: target.address().port, allowedHosts: ['www.ups.com', 'api.bilibili.com'], username, password,
      onConnected: () => { authenticatedConnections++; }, onAuthFailure: () => { authenticationFailures++; } });
  } else {
    const reject = (_request, response) => response.writeHead(403).end();
    proxy = proxyKind === 'https'
      ? https.createServer({ key: await readFile(untrustedProxy ? '/fixture/untrusted-key.pem' : privateKey),
        cert: await readFile(untrustedProxy ? '/fixture/untrusted-cert.pem' : certificate) }, reject)
      : http.createServer(reject);
    if (proxyKind === 'https') proxy.on('tlsClientError', () => {});
    proxy.on('connect', (request, client, head) => {
      if (!['www.ups.com:443', 'api.bilibili.com:443'].includes(request.url)) { client.destroy(); return; }
      if (request.headers['proxy-authorization'] !== authorization) {
        authenticationFailures++;
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const upstream = net.connect(target.address().port, '127.0.0.1', () => {
        authenticatedConnections++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  }
  proxy.on('connection', socket => { proxyConnections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;
  const wrapper = path.join(temporary, 'moli-wrapper');
  // Refuse startup without the fixture proxy; the container also has no external network.
  await writeFile(wrapper, '#!/bin/sh\ncase " $* " in *" --http-proxy $MOLI_FIXTURE_PROXY_KIND://fixture-user:"*"@127.0.0.1:$MOLI_FIXTURE_PROXY_PORT "*|*" --http-proxy $MOLI_FIXTURE_PROXY_KIND://fixture-user:"*"@127.0.0.1:$MOLI_FIXTURE_PROXY_PORT/ "*) ;; *) exit 90 ;; esac\nexec /opt/moli/moli "$@" --ca-cert /fixture/cert.pem\n', { mode: 0o755 });
  const gatewayEnv = { ...cleanEnvironment(), MOLI_BIN: wrapper, MOLI_FIXTURE_PROXY_KIND: proxyKind, MOLI_FIXTURE_PROXY_PORT: String(proxyPort), CDP_HOST: '127.0.0.1', CDP_PORT: '9222' };
  gateway = watch(spawn(process.execPath, ['/app/cdp-gateway.mjs'], { env: gatewayEnv, stdio: ['ignore', 'pipe', 'pipe'] }), 'gateway');
  await waitHealthy('http://127.0.0.1:9222/health', gateway);

  const startRsshub = async suppliedPassword => {
    const env = { ...cleanEnvironment(), NODE_ENV: 'production', PORT: '1200', LISTEN_INADDR_ANY: 'false',
      ENABLE_CLUSTER: 'false', NO_LOGFILES: 'true', CACHE_TYPE: 'memory', NODE_EXTRA_CA_CERTS: certificate,
      PLAYWRIGHT_CDP_ENDPOINT: directCdp ? 'ws://127.0.0.1:9222/chromium' : 'http://127.0.0.1:9222',
      PROXY_URI: `${alias ? 'socks5h' : proxyKind}://${username}:${encodeURIComponent(suppliedPassword)}@127.0.0.1:${proxyPort}`,
      PROXY_URL_REGEX: '^https://(?:www\\.ups\\.com|api\\.bilibili\\.com)/' };
    const child = watch(spawn(process.execPath, ['/rsshub/dist/index.mjs'], { cwd: '/rsshub', env, stdio: ['ignore', 'pipe', 'pipe'] }), 'rsshub');
    await waitHealthy('http://127.0.0.1:1200/healthz', child);
    return child;
  };
  rsshub = await startRsshub(password);
  if (untrustedProxy) {
    const response = await fetch('http://127.0.0.1:1200/ups/track/UNTRUSTED123', { signal: AbortSignal.timeout(25000) });
    const body = await response.text();
    assert.ok(!response.ok, `untrusted HTTPS proxy must return an HTTP error, got ${response.status}`);
    assert.match(body, /ERR_CERT_AUTHORITY_INVALID/);
    assert.ok(proxyConnections > 0, 'Moli must connect to the proxy');
    assert.equal(authenticatedConnections, 0, 'untrusted proxy must not receive a CONNECT');
    assert.equal(originHits, 0, 'untrusted proxy must not reach the target');
    console.log('PASS full RSSHub UPS feed: untrusted HTTPS proxy rejected before CONNECT');
  } else {
    if (process.env.MOLI_TEST_BILIBILI_RETRY === '1') {
      const response = await fetch('http://127.0.0.1:1200/bilibili/popular/all', { signal: AbortSignal.timeout(30000) });
      const body = await response.text();
      if (process.env.MOLI_TEST_EXPECT_NODE_RETRY === '0') {
        assert.ok(!response.ok, `unpatched Node RSSHub unexpectedly succeeded: ${response.status}`);
        assert.equal(biliHits, 1, 'unpatched Node RSSHub should not replay the 412');
      } else {
        assert.equal(response.status, 200, `Bilibili feed returned HTTP ${response.status}: ${body.slice(0, 700)}`);
        assert.match(body, /Moli Bili Fixture/);
        assert.equal(biliHits, 2, 'browser must replay the first 412 once');
      }
      console.log(`PASS full RSSHub Bilibili Node retry expectation: ${process.env.MOLI_TEST_EXPECT_NODE_RETRY}`);
    }
    for (const number of ['HIDDEN123', 'VISIBLE123']) {
      const response = await fetch(`http://127.0.0.1:1200/ups/track/${number}`, { signal: AbortSignal.timeout(25000) });
      const body = await response.text();
      assert.equal(response.status, 200, `RSSHub returned HTTP ${response.status}: ${body.slice(0, 500)}`);
      assert.match(body, /UPS Tracking/);
      assert.match(body, /Delivered/);
      assert.match(body, /Departed/);
      assert.doesNotMatch(body, /Loading\.\.\./);
    }
    assert.ok(authenticatedConnections >= 2, 'each route request must use the authenticated proxy');
    assert.equal(blockedImages, 0, 'UPS route should abort images');
    await stop(rsshub);
    rsshub = await startRsshub('wrong');
    const before = originHits;
    const bad = await fetch('http://127.0.0.1:1200/ups/track/WRONG123', { signal: AbortSignal.timeout(25000) });
    const badBody = await bad.text();
    assert.ok(!bad.ok, `wrong proxy credentials must return an HTTP error, got ${bad.status}`);
    assert.doesNotMatch(badBody, /Delivered|fixture-user|p%40ss%3Aword%2540/);
    assert.ok(authenticationFailures > 0, 'the proxy must reject wrong credentials');
    assert.equal(originHits, before, 'wrong credentials must not reach the target');
    if (process.env.MOLI_TEST_BILIBILI_RETRY === '1') {
      const biliBefore = biliHits;
      const failuresBefore = authenticationFailures;
      const rejected = await fetch('http://127.0.0.1:1200/bilibili/popular/all', { signal: AbortSignal.timeout(25000) });
      const rejectedBody = await rejected.text();
      assert.ok(!rejected.ok, `wrong native proxy credentials must return an HTTP error, got ${rejected.status}`);
      assert.doesNotMatch(rejectedBody, /Moli Bili Fixture|fixture-user|p%40ss%3Aword%2540/);
      assert.ok(authenticationFailures > failuresBefore, 'the proxy must reject native client credentials');
      assert.equal(biliHits, biliBefore, 'wrong native credentials must not reach Bilibili fixture');
    }
    console.log(`PASS full RSSHub UPS feeds: ${alias ? 'socks5h' : proxyKind}, ${directCdp ? 'WebSocket' : 'HTTP'} CDP, dynamic rows and rejected credentials`);
  }
} catch (error) {
  for (const line of diagnostics) process.stderr.write(line);
  throw error;
} finally {
  await stop(rsshub);
  await stop(gateway);
  for (const socket of sockets) socket.destroy();
  target?.closeAllConnections();
  await Promise.all([proxy, target].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  await rm(temporary, { recursive: true, force: true });
}
