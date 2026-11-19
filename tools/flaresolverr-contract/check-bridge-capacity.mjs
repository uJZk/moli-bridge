// A destroyed session must retain process capacity until its backend exits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const temp = await mkdtemp(path.join(os.tmpdir(), 'moli-bridge-capacity-'));
const marker = path.join(temp, 'starts');
const ready = path.join(temp, 'stubborn');
const fake = path.join(temp, 'moli');
await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_MARKER,'start\\n');const count=fs.readFileSync(process.env.TEST_MARKER,'utf8').trim().split('\\n').length;if(count===1){process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.TEST_READY,'ready');}setInterval(()=>{},1000);`, { mode: 0o755 });
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
  cwd: process.cwd(), env: { ...process.env, MOLI_BIN: fake, BRIDGE_PORT: String(port), BRIDGE_MAX_SESSIONS: '1', TEST_MARKER: marker, TEST_READY: ready }, stdio: 'ignore',
});
let brokenBridge;
async function until(predicate, label) {
  for (let i = 0; i < 120; i++) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function count() { try { return (await readFile(marker, 'utf8')).trim().split('\n').length; } catch { return 0; } }
const call = async payload => (await fetch(`http://127.0.0.1:${port}/v1`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json();
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 'bridge');
  const first = call({ cmd: 'sessions.create', session: 'first', maxTimeout: 5000 });
  await until(async () => { try { return await readFile(ready, 'utf8') === 'ready'; } catch { return false; } }, 'stubborn backend');
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'first' })).status, 'ok');
  assert.ok(!(await call({ cmd: 'sessions.list' })).sessions.includes('first'), 'destroyed session must not remain visible');
  const premature = await call({ cmd: 'sessions.create', session: 'second', maxTimeout: 500 });
  assert.equal(premature.status, 'error');
  assert.match(premature.message, /session limit reached/i);
  assert.equal(await count(), 1, 'a backend still exiting must retain its capacity slot');
  assert.equal((await first).status, 'error');
  const second = call({ cmd: 'sessions.create', session: 'second', maxTimeout: 5000 });
  await until(async () => await count() === 2, 'backend after forced exit');
  assert.equal((await call({ cmd: 'sessions.destroy', session: 'second' })).status, 'ok');
  assert.equal((await second).status, 'error');
  const brokenReserve = http.createServer();
  await new Promise(resolve => brokenReserve.listen(0, '127.0.0.1', resolve));
  const brokenPort = brokenReserve.address().port;
  await new Promise(resolve => brokenReserve.close(resolve));
  brokenBridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], {
    cwd: process.cwd(), env: { ...process.env, MOLI_BIN: path.join(temp, 'missing-moli'), BRIDGE_PORT: String(brokenPort), BRIDGE_MAX_SESSIONS: '1' }, stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${brokenPort}/health`)).ok; } catch { return false; } }, 'missing-binary bridge');
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${brokenPort}/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'sessions.create', maxTimeout: 1000 }),
    });
    const result = await response.json();
    assert.equal(result.status, 'error');
    assert.doesNotMatch(result.message, /session limit reached/i, 'a failed spawn must not retain capacity');
  }
  console.log('PASS retiring bridge backends retain capacity until exit');
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.once('exit', resolve));
  if (brokenBridge) {
    brokenBridge.kill('SIGTERM');
    await new Promise(resolve => brokenBridge.once('exit', resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
