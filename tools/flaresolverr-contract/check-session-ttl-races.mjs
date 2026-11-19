// Exercise TTL rotation under slow process exit, contention and request deadlines.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const temp = await mkdtemp(path.join(os.tmpdir(), 'moli-ttl-race-'));
const marker = path.join(temp, 'events');
const wrapper = path.join(temp, 'moli');
await writeFile(wrapper, `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');const args=process.argv.slice(2);const log=(event)=>fs.appendFileSync(process.env.TEST_MARKER,JSON.stringify({event,pid:process.pid,args})+'\\n');log('start');const child=spawn(process.env.REAL_MOLI,args,{stdio:'inherit'});let stopping=false;process.on('SIGTERM',()=>{if(stopping)return;stopping=true;log('stop');child.kill('SIGTERM')});child.on('exit',(code)=>{if(!stopping)process.exit(code??1)});setInterval(()=>{},1000);`, { mode: 0o755 });
const respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Ready</title><body>fixture</body>'); };
const fixture = http.createServer(respond);
const proxy = http.createServer(respond);
await Promise.all([new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)), new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))]);
const target = `http://127.0.0.1:${fixture.address().port}/`;
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: wrapper, REAL_MOLI: moli, TEST_MARKER: marker, BRIDGE_PORT: String(port), BRIDGE_MAX_SESSIONS: '1' }, stdio: 'ignore',
});
let secondBridge;
async function until(predicate, label) {
  for (let i = 0; i < 240; i++) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function events(kind) {
  try { return (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.event === kind); } catch { return []; }
}
async function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }
const call = async payload => (await fetch(`http://127.0.0.1:${port}/v1`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json();
const create = session => call({ cmd: 'sessions.create', session, proxy: { url: proxyUrl }, maxTimeout: 5000 });
const rotate = (session, maxTimeout) => call({ cmd: 'request.get', session, url: target, session_ttl_minutes: 0.000001, maxTimeout });
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'bridge');
  assert.equal((await create('race')).status, 'ok');
  const rotation = rotate('race', 6000);
  await until(async () => (await events('stop')).length === 1, 'old backend termination');
  const concurrentCreate = await call({ cmd: 'sessions.create', session: 'race', maxTimeout: 1000 });
  const concurrentRequest = await call({ cmd: 'request.get', session: 'race', url: target, maxTimeout: 1000 });
  assert.match(concurrentCreate.message, /busy/i);
  assert.match(concurrentRequest.message, /busy/i);
  assert.equal((await events('start')).length, 1, 'no replacement may start before old process exit');
  const rotated = await rotation;
  assert.equal(rotated.status, 'ok', rotated.message);
  const starts = await events('start');
  assert.equal(starts.length, 2);
  for (const start of starts) {
    const index = start.args.indexOf('--http-proxy');
    assert.ok(index >= 0);
    assert.equal(start.args[index + 1], `${proxyUrl}/`, 'replacement must retain the session proxy');
  }
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'race' })).status, 'ok');
  await until(() => exited(starts[1].pid), 'replacement exit');

  assert.equal((await create('timeout')).status, 'ok');
  const before = Date.now();
  const timed = await rotate('timeout', 500);
  assert.equal(timed.status, 'error');
  assert.match(timed.message, /timeout/i);
  assert.ok(Date.now() - before < 1600, 'rotation must respect the request timeout');
  assert.ok(!(await call({ cmd: 'sessions.list' })).sessions.includes('timeout'));
  assert.equal((await events('start')).length, 3, 'timed-out rotation must not start a replacement');
  const blocked = await create('blocked');
  assert.equal(blocked.status, 'error');
  assert.match(blocked.message, /session limit/i);
  const timedStart = (await events('start'))[2];
  await until(() => exited(timedStart.pid), 'timed-out backend exit');
  assert.equal((await events('start')).length, 3, 'timed-out rotation must stay cancelled after exit');

  assert.equal((await create('destroy')).status, 'ok');
  const destroyRotation = rotate('destroy', 6000);
  await until(async () => (await events('stop')).length === 4, 'destroy rotation');
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'destroy' })).status, 'ok');
  assert.match((await create('blocked-destroy')).message, /session limit/i);
  const destroyed = await destroyRotation;
  assert.equal(destroyed.status, 'error');
  assert.match(destroyed.message, /closed/i);
  assert.equal((await events('start')).length, 4, 'destroy must not recreate the session');
  const destroyStart = (await events('start'))[3];
  await until(() => exited(destroyStart.pid), 'destroyed backend exit');

  assert.equal((await create('cancel')).status, 'ok');
  const controller = new AbortController();
  const cancelledRotation = fetch(`http://127.0.0.1:${port}/v1`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
    body: JSON.stringify({ cmd: 'request.get', session: 'cancel', url: target, session_ttl_minutes: 0.000001, maxTimeout: 6000 }),
  }).catch(() => {});
  await until(async () => (await events('stop')).length === 5, 'cancel rotation');
  controller.abort();
  await cancelledRotation;
  await until(async () => !(await call({ cmd: 'sessions.list' })).sessions.includes('cancel'), 'cancelled rotation cleanup');
  assert.match((await create('blocked-cancel')).message, /session limit/i);
  const cancelStart = (await events('start'))[4];
  await until(() => exited(cancelStart.pid), 'cancelled backend exit');
  assert.equal((await events('start')).length, 5, 'cancel must not recreate the session');

  const reserveSecond = http.createServer();
  await new Promise(resolve => reserveSecond.listen(0, '127.0.0.1', resolve));
  const secondPort = reserveSecond.address().port;
  await new Promise(resolve => reserveSecond.close(resolve));
  secondBridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
    cwd: process.cwd(), env: { ...process.env, MOLI_BIN: wrapper, REAL_MOLI: moli, TEST_MARKER: marker, BRIDGE_PORT: String(secondPort), BRIDGE_MAX_SESSIONS: '2' }, stdio: 'ignore',
  });
  const secondCall = async payload => (await fetch(`http://127.0.0.1:${secondPort}/v1`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })).json();
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${secondPort}/health`)).ok; } catch { return false; } }, 'second bridge');
  assert.equal((await secondCall({ cmd: 'sessions.create', session: 'same', proxy: { url: proxyUrl }, maxTimeout: 5000 })).status, 'ok');
  const oldRotation = secondCall({ cmd: 'request.get', session: 'same', url: target, session_ttl_minutes: 0.000001, maxTimeout: 6000 });
  await until(async () => (await events('stop')).length === 6, 'rotation before recreate');
  assert.equal((await secondCall({ cmd: 'sessions.destroy', session: 'same' })).status, 'ok');
  const newProxy = `http://127.0.0.1:${fixture.address().port}`;
  assert.equal((await secondCall({ cmd: 'sessions.create', session: 'same', proxy: { url: newProxy }, maxTimeout: 5000 })).status, 'ok');
  const stale = await oldRotation;
  assert.equal(stale.status, 'error');
  assert.match(stale.message, /closed/i);
  assert.ok((await secondCall({ cmd: 'sessions.list' })).sessions.includes('same'), 'old rotation must not remove the new session');
  const current = await secondCall({ cmd: 'request.get', session: 'same', url: target, maxTimeout: 5000 });
  assert.equal(current.status, 'ok', current.message);
  const newStart = (await events('start'))[6];
  assert.equal(newStart.args[newStart.args.indexOf('--http-proxy') + 1], `${newProxy}/`);
  assert.equal((await secondCall({ cmd: 'sessions.destroy', session: 'same' })).status, 'ok');
  console.log('PASS TTL rotation preserves capacity, proxy, concurrent isolation and deadlines');
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.once('exit', resolve));
  if (secondBridge) {
    secondBridge.kill('SIGTERM');
    await new Promise(resolve => secondBridge.once('exit', resolve));
  }
  fixture.closeAllConnections(); proxy.closeAllConnections();
  await Promise.all([new Promise(resolve => fixture.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  await rm(temp, { recursive: true, force: true });
}
