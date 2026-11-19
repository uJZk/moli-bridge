// Local-only end-to-end probe of FlareSolverr proxy credentials and DNS.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSocks5Fixture } from '../rsshub/socks5-proxy-fixture.mjs';

const binary = process.env.MOLI_TEST_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const proxyKind = process.env.MOLI_TEST_PROXY_KIND ?? 'socks5';
const untrustedProxy = process.env.MOLI_TEST_UNTRUSTED_PROXY === '1';
if (!['socks5', 'https'].includes(proxyKind) || (untrustedProxy && proxyKind !== 'https')) throw new Error('Invalid proxy fixture configuration');
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'moli-flaresolverr-proxy-'));
const cert = path.join(temporary, 'cert.pem');
const key = path.join(temporary, 'key.pem');
const untrustedCert = path.join(temporary, 'untrusted-cert.pem');
const untrustedKey = path.join(temporary, 'untrusted-key.pem');
const wrapper = path.join(temporary, 'moli-wrapper');
const launches = path.join(temporary, 'launches');
const hostname = 'proxy-fixture.test';
const username = 'fixture-user';
const password = 'p@ss:word%40';
let hits = 0;
let connected = 0;
let authFailures = 0;
let proxyConnections = 0;
let bridge;
let target;
let proxy;
const proxySockets = new Set();

try {
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname},IP:127.0.0.1`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  if (openssl.status !== 0) throw new Error('Unable to generate fixture certificate');
  if (untrustedProxy) {
    const untrusted = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
      '-subj', '/CN=untrusted-proxy', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', untrustedKey, '-out', untrustedCert], { stdio: 'ignore' });
    if (untrusted.status !== 0) throw new Error('Unable to generate untrusted proxy certificate');
  }
  target = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    hits++;
    response.writeHead(201, { 'content-type': 'text/html', 'set-cookie': 'socks_fixture=ok; Path=/' });
    response.end('<title>Ready</title><body>SOCKS fixture</body>');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  if (proxyKind === 'socks5') {
    proxy = createSocks5Fixture({ fixturePort: target.address().port, allowedHosts: [hostname], username, password,
      onConnected: () => { connected++; }, onAuthFailure: () => { authFailures++; } });
  } else {
    proxy = https.createServer({ key: await readFile(untrustedProxy ? untrustedKey : key), cert: await readFile(untrustedProxy ? untrustedCert : cert) },
      (_request, response) => response.writeHead(403).end());
    proxy.on('tlsClientError', () => {});
    proxy.on('connect', (request, client, head) => {
      if (request.url !== `${hostname}:443`) { client.destroy(); return; }
      if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) {
        authFailures++;
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const upstream = net.connect(target.address().port, '127.0.0.1', () => {
        connected++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  }
  proxy.on('connection', socket => { proxyConnections++; proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  // A missing or unexpected proxy prevents Moli from starting, so a failed test
  // cannot fall back to contacting the target domain directly.
  await writeFile(wrapper, '#!/bin/sh\ncase " $* " in *" --http-proxy $MOLI_FIXTURE_PROXY_KIND://"*"@127.0.0.1:$MOLI_FIXTURE_PROXY_PORT "*|*" --http-proxy $MOLI_FIXTURE_PROXY_KIND://"*"@127.0.0.1:$MOLI_FIXTURE_PROXY_PORT/ "*) ;; *) exit 90 ;; esac\nprintf x >> "$MOLI_FIXTURE_LAUNCHES"\nexec "$MOLI_TEST_BINARY" "$@" --ca-cert "$MOLI_FIXTURE_CERT"\n', { mode: 0o755 });
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  bridge = spawn(process.execPath, [path.join(root, 'flaresolverr-bridge/server.mjs')], {
    env: { ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(port), MOLI_BIN: wrapper,
      MOLI_FIXTURE_CERT: cert, MOLI_FIXTURE_PROXY_KIND: proxyKind, MOLI_FIXTURE_PROXY_PORT: String(proxy.address().port), MOLI_FIXTURE_LAUNCHES: launches },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  bridge.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (bridge.exitCode !== null) throw new Error(`Bridge exited before startup: ${stderr}`);
    try { ready = (await fetch(`${base}/health`)).ok; } catch { /* still starting */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('Bridge did not start');
  const call = async body => (await fetch(`${base}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const proxyUrl = `${proxyKind}://127.0.0.1:${proxy.address().port}`;
  const good = await call({ cmd: 'request.get', url: `https://${hostname}/`, maxTimeout: 15000,
    proxy: { url: proxyUrl, username, password } });
  if (untrustedProxy) {
    assert.equal(good.status, 'error', 'untrusted HTTPS proxy certificate must fail');
    assert.equal((await readFile(launches, 'utf8')).length, 1, 'Moli must have started with the configured proxy');
    assert.ok(proxyConnections > 0, `Moli must connect to the proxy: ${good.message}`);
    assert.match(good.message, /ERR_CERT_AUTHORITY_INVALID/, 'Moli must report an untrusted certificate');
    assert.equal(connected, 0, 'untrusted proxy must not receive a CONNECT');
    assert.equal(hits, 0, 'untrusted proxy must not reach the target');
    console.log('PASS FlareSolverr API: rejected untrusted HTTPS proxy certificate before CONNECT');
  } else {
    assert.equal(good.status, 'ok', good.message);
    assert.equal(good.solution.status, 201);
    assert.match(good.solution.response, /SOCKS fixture/);
    assert.ok(good.solution.cookies.some(cookie => cookie.name === 'socks_fixture' && cookie.value === 'ok'));
    assert.ok(connected > 0, 'proxy must receive the domain-name CONNECT');
    const previousHits = hits;
    const bad = await call({ cmd: 'request.get', url: `https://${hostname}/`, maxTimeout: 5000,
      proxy: { url: proxyUrl, username, password: 'wrong' } });
    assert.equal(bad.status, 'error', 'wrong credentials must fail');
    assert.ok(authFailures > 0, 'proxy must reject the supplied credentials');
    assert.equal(hits, previousHits, 'failed authentication must not reach the target');
    const embeddedUrl = `${proxyKind}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${proxy.address().port}`;
    const embedded = await call({ cmd: 'request.get', url: `https://${hostname}/`, maxTimeout: 15000, proxy: { url: embeddedUrl } });
    assert.equal(embedded.status, 'ok', embedded.message);
    if (proxyKind === 'socks5') {
      const alias = await call({ cmd: 'request.get', url: `https://${hostname}/`, maxTimeout: 15000,
        proxy: { url: proxyUrl.replace('socks5:', 'socks5h:'), username, password } });
      assert.equal(alias.status, 'ok', alias.message);
    }
    const session = await call({ cmd: 'sessions.create', maxTimeout: 15000, proxy: { url: proxyUrl, username, password } });
    assert.equal(session.status, 'ok', session.message);
    try {
      const beforeRotation = (await readFile(launches, 'utf8')).length;
      const rotated = await call({ cmd: 'request.get', url: `https://${hostname}/`, session: session.session,
        session_ttl_minutes: 0.00001, maxTimeout: 15000 });
      assert.equal(rotated.status, 'ok', rotated.message);
      assert.equal((await readFile(launches, 'utf8')).length, beforeRotation + 1, 'expired session must start a new proxied process');
    } finally {
      await call({ cmd: 'sessions.destroy', session: session.session });
    }
    console.log(`PASS FlareSolverr API: ${proxyKind} authentication, proxy DNS, credentials, session rotation and failed authentication`);
  }
} finally {
  if (bridge && bridge.exitCode === null) {
    bridge.kill('SIGTERM');
    let timeout;
    await Promise.race([once(bridge, 'exit'), new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]);
    clearTimeout(timeout);
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
  }
  for (const socket of proxySockets) socket.destroy();
  target?.closeAllConnections();
  await Promise.all([proxy, target].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  await rm(temporary, { recursive: true, force: true });
}
