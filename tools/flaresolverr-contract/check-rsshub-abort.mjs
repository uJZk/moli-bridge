// Verify disconnected CDP clients release their in-flight backend slots.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from '../../flaresolverr-bridge/node_modules/ws/wrapper.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'moli-rsshub-abort-'));
const marker = path.join(tmp, 'starts');
const discoveryMarker = path.join(tmp, 'discovery');
const stubbornMarker = path.join(tmp, 'stubborn');
const fake = path.join(tmp, 'moli');
await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');const http=require('node:http');fs.appendFileSync(process.env.TEST_MARKER,'start\\n');const count=fs.readFileSync(process.env.TEST_MARKER,'utf8').trim().split('\\n').length;if(count===5){const server=http.createServer((_req,_res)=>fs.writeFileSync(process.env.TEST_DISCOVERY_MARKER,'requested'));server.listen(0,'127.0.0.1',()=>console.log('protocol server listening addr=127.0.0.1:'+server.address().port));}else{if(count===7){process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.TEST_STUBBORN_MARKER,'ready');}setInterval(()=>{},1000);}`, { mode: 0o755 });
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const gateway = spawn(process.execPath, ['flaresolverr-bridge/cdp-gateway.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: fake, CDP_PORT: String(port), CDP_MAX_BROWSERS: '1', TEST_MARKER: marker, TEST_DISCOVERY_MARKER: discoveryMarker, TEST_STUBBORN_MARKER: stubbornMarker },
  stdio: 'ignore',
});
let brokenGateway;
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function count() { try { return (await readFile(marker, 'utf8')).trim().split('\n').length; } catch { return 0; } }
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'gateway');
  const invalidHost = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', headers: { host: 'invalid/host' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(invalidHost, 400);
  assert.equal(await count(), 0, 'invalid discovery must not start a backend');
  const first = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  first.on('error', () => {});
  await until(async () => await count() === 1, 'first backend');
  first.terminate();
  // A new connection can start only once the interrupted backend slot was released.
  await delay(100);
  const second = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  second.on('error', () => {});
  await until(async () => await count() === 2, 'replacement backend');
  second.terminate();
  await delay(100);
  const discovery = http.get(`http://127.0.0.1:${port}/json/version`);
  discovery.on('error', () => {});
  await until(async () => await count() === 3, 'HTTP discovery backend');
  discovery.destroy();
  await delay(100);
  const afterDiscovery = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  afterDiscovery.on('error', () => {});
  await until(async () => await count() === 4, 'backend after aborted discovery');
  afterDiscovery.terminate();
  await delay(100);
  const lateDiscovery = http.get(`http://127.0.0.1:${port}/json/version`);
  lateDiscovery.on('error', () => {});
  await until(async () => { try { return await readFile(discoveryMarker, 'utf8') === 'requested'; } catch { return false; } }, 'backend discovery request');
  lateDiscovery.destroy();
  await delay(100);
  const afterLateDiscovery = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  afterLateDiscovery.on('error', () => {});
  await until(async () => await count() === 6, 'backend after aborted backend discovery');
  afterLateDiscovery.terminate();
  await delay(100);
  const stubborn = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  stubborn.on('error', () => {});
  await until(async () => { try { return await readFile(stubbornMarker, 'utf8') === 'ready'; } catch { return false; } }, 'stubborn backend');
  stubborn.terminate();
  await delay(100);
  const premature = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  premature.on('error', () => {});
  await delay(300);
  assert.equal(await count(), 7, 'a backend still exiting must retain its capacity slot');
  premature.terminate();
  await delay(2100);
  const afterExit = new WebSocket(`ws://127.0.0.1:${port}/chromium`);
  afterExit.on('error', () => {});
  await until(async () => await count() === 8, 'backend after forced exit');
  afterExit.terminate();
  assert.equal(await count(), 8);
  const brokenReserve = http.createServer();
  await new Promise(resolve => brokenReserve.listen(0, '127.0.0.1', resolve));
  const brokenPort = brokenReserve.address().port;
  await new Promise(resolve => brokenReserve.close(resolve));
  brokenGateway = spawn(process.execPath, ['flaresolverr-bridge/cdp-gateway.mjs'], {
    cwd: process.cwd(), env: { ...process.env, MOLI_BIN: path.join(tmp, 'missing-moli'), CDP_PORT: String(brokenPort), CDP_MAX_BROWSERS: '1' },
    stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${brokenPort}/health`)).ok; } catch { return false; } }, 'missing-binary gateway');
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${brokenPort}/json/version`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.doesNotMatch(body.error, /capacity/i, 'a failed spawn must not retain capacity');
  }
  console.log('PASS aborted RSSHub WebSocket and HTTP startup release backend capacity');
} finally {
  gateway.kill('SIGTERM');
  await new Promise(resolve => gateway.once('exit', resolve));
  if (brokenGateway) {
    brokenGateway.kill('SIGTERM');
    await new Promise(resolve => brokenGateway.once('exit', resolve));
  }
  await rm(tmp, { recursive: true, force: true });
}
