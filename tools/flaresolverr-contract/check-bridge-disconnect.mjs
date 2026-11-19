// Check disconnect cleanup without contacting external sites.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const held = new Map();
let queuedHits = 0;
const fixture = http.createServer((req, res) => {
  if (req.url?.startsWith('/hold')) { held.set(req.url, res); return; }
  if (req.url === '/queued') queuedHits++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>Ready</title><body>fixture</body>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: moli, BRIDGE_PORT: String(port), BRIDGE_MAX_SESSIONS: '4' }, stdio: 'ignore',
});
async function until(predicate, label) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
const call = async payload => (await fetch(`http://127.0.0.1:${port}/v1`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json();
function abortableCall(payload) {
  const request = http.request({ host: '127.0.0.1', port, path: '/v1', method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify(payload));
  return request;
}
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'bridge');
  assert.equal((await call({ cmd: 'sessions.create', session: 'active', maxTimeout: 5000 })).status, 'ok');
  const active = abortableCall({ cmd: 'request.get', session: 'active', url: `${fixtureUrl}/hold-active`, maxTimeout: 30000 });
  await until(() => held.has('/hold-active'), 'active browser request');
  active.destroy();
  await until(async () => !(await call({ cmd: 'sessions.list' })).sessions.includes('active'), 'cancelled active session retirement');

  assert.equal((await call({ cmd: 'sessions.create', session: 'queued', maxTimeout: 5000 })).status, 'ok');
  const running = call({ cmd: 'request.get', session: 'queued', url: `${fixtureUrl}/hold-queued`, maxTimeout: 10000 });
  await until(() => held.has('/hold-queued'), 'running request ahead of queue');
  const queued = abortableCall({ cmd: 'request.get', session: 'queued', url: `${fixtureUrl}/queued`, maxTimeout: 10000 });
  await new Promise(resolve => queued.once('finish', resolve));
  await delay(100);
  queued.destroy();
  await delay(100);
  held.get('/hold-queued').writeHead(200, { 'content-type': 'text/html' }).end('<title>Ready</title><body>running complete</body>');
  assert.equal((await running).status, 'ok');
  const sentinel = await call({ cmd: 'request.get', session: 'queued', url: `${fixtureUrl}/sentinel`, maxTimeout: 5000 });
  assert.equal(sentinel.status, 'ok', sentinel.message);
  assert.equal(queuedHits, 0, 'a disconnected queued request must never navigate');
  assert.ok((await call({ cmd: 'sessions.list' })).sessions.includes('queued'));
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'queued' })).status, 'ok');
  console.log('PASS active disconnect retires its backend; queued disconnect preserves the active session');
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.once('exit', resolve));
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
