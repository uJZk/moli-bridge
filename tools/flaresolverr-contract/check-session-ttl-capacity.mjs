// Verify TTL rotation with a single backend slot using only loopback targets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', ...(req.url === '/set' ? { 'set-cookie': 'old_session=yes; Path=/' } : {}) });
  res.end(`<title>Ready</title><body>cookie=${req.headers.cookie ?? ''}</body>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${fixture.address().port}`;
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: moli, BRIDGE_PORT: String(port), BRIDGE_MAX_SESSIONS: '1' }, stdio: 'ignore',
});
async function until(predicate, label) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
const call = async payload => (await fetch(`http://127.0.0.1:${port}/v1`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json();
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'bridge');
  assert.equal((await call({ cmd: 'sessions.create', session: 'rotate', maxTimeout: 5000 })).status, 'ok');
  const set = await call({ cmd: 'request.get', session: 'rotate', url: `${target}/set`, maxTimeout: 5000 });
  assert.equal(set.status, 'ok', set.message);
  assert.ok(set.solution.cookies.some(cookie => cookie.name === 'old_session'));
  const rotated = await call({ cmd: 'request.get', session: 'rotate', url: `${target}/echo`, session_ttl_minutes: 0.000001, maxTimeout: 5000 });
  assert.equal(rotated.status, 'ok', rotated.message);
  assert.doesNotMatch(rotated.solution.response, /old_session=yes/);
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'rotate' })).status, 'ok');
  console.log('PASS TTL session rotation within a single backend slot');
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.once('exit', resolve));
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
