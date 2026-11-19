// Verify TTL expiration never kills another caller's starting session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const temp = await mkdtemp(path.join(os.tmpdir(), 'moli-session-start-'));
const fakeMoli = path.join(temp, 'moli');
await writeFile(fakeMoli, `#!${process.execPath}\nsetInterval(()=>{},1000);`, { mode: 0o755 });
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: fakeMoli, BRIDGE_PORT: String(port) }, stdio: 'ignore',
});
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(25); }
  throw new Error('bridge did not become ready');
}
const call = async payload => (await fetch(`http://127.0.0.1:${port}/v1`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json();
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
  const starting = call({ cmd: 'sessions.create', session: 'starting-fixture', maxTimeout: 5000 });
  await until(async () => (await call({ cmd: 'sessions.list' })).sessions.includes('starting-fixture'));
  await delay(25);
  const rotation = await call({ cmd: 'request.get', session: 'starting-fixture', url: 'http://fixture.invalid/',
    session_ttl_minutes: 0.000001, maxTimeout: 1000 });
  assert.equal(rotation.status, 'error');
  assert.match(rotation.message, /busy/i);
  assert.ok((await call({ cmd: 'sessions.list' })).sessions.includes('starting-fixture'));
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'starting-fixture' })).status, 'ok');
  assert.equal((await starting).status, 'error');
  console.log('PASS expired session startup is not interrupted by another request');
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.once('exit', resolve));
  await rm(temp, { recursive: true, force: true });
}
