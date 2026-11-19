// A disconnected temporary startup is retired without killing shared startups.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const temp = await mkdtemp(path.join(os.tmpdir(), 'moli-bridge-cancel-start-'));
const marker = path.join(temp, 'events');
const fake = path.join(temp, 'moli');
await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{fs.appendFileSync(process.env.TEST_MARKER,'stop\\n');process.exit(0)});fs.appendFileSync(process.env.TEST_MARKER,'start\\n');setInterval(()=>{},1000);`, { mode: 0o755 });
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: fake, BRIDGE_PORT: String(port), BRIDGE_MAX_SESSIONS: '2', TEST_MARKER: marker }, stdio: 'ignore',
});
async function until(predicate, label) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function count(event) {
  try { return (await readFile(marker, 'utf8')).split('\n').filter(line => line === event).length; } catch { return 0; }
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
  const temporary = abortableCall({ cmd: 'request.get', url: 'http://fixture.invalid/', maxTimeout: 10000 });
  await until(async () => await count('start') === 1, 'temporary startup');
  temporary.destroy();
  await until(async () => await count('stop') === 1, 'temporary backend termination');
  assert.deepEqual((await call({ cmd: 'sessions.list' })).sessions, []);

  const shared = call({ cmd: 'sessions.create', session: 'shared', maxTimeout: 10000 });
  await until(async () => await count('start') === 2, 'shared startup');
  const waiting = abortableCall({ cmd: 'request.get', session: 'shared', url: 'http://fixture.invalid/', maxTimeout: 10000 });
  await new Promise(resolve => waiting.once('finish', resolve));
  await delay(100);
  waiting.destroy();
  await delay(100);
  assert.ok((await call({ cmd: 'sessions.list' })).sessions.includes('shared'));
  assert.equal(await count('stop'), 1, 'cancelling a waiter must not stop the shared startup');
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'shared' })).status, 'ok');
  assert.equal((await shared).status, 'error');
  await until(async () => await count('stop') === 2, 'shared backend termination');
  console.log('PASS temporary startup cancellation and shared startup isolation');
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.once('exit', resolve));
  await rm(temp, { recursive: true, force: true });
}
