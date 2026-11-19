// Local TLS fixture for a cross-origin Cloudflare-named challenge frame.
// The Moli test process resolves the name to loopback and trusts only this fixture's certificate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const moli = process.env.MOLI_TEST_BINARY;
if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
const root = path.resolve(import.meta.dirname, '../..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'moli-cf-frame-'));
const keyPath = path.join(temp, 'key.pem');
const certPath = path.join(temp, 'cert.pem');
const wrapper = path.join(temp, 'moli-wrapper');
let bridge;
let parent;
let child;
try {
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=challenges.cloudflare.com', '-addext', 'subjectAltName=DNS:challenges.cloudflare.com',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  if (openssl.status !== 0) throw new Error('Failed to generate local test certificate');
  await writeFile(wrapper, '#!/bin/sh\nexec "$MOLI_TEST_BINARY" "$@" --ca-cert "$TEST_CA_CERT" --http-host-resolve "challenges.cloudflare.com:$TEST_HTTPS_PORT:127.0.0.1"\n', { mode: 0o755 });
  child = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const variant = req.url?.slice(1) ?? 'open';
    if (variant === 'keyboard') {
      res.end('<html><body><button onclick="parent.postMessage(&quot;cross-origin-verified&quot;,&quot;*&quot;)">Verify</button></body></html>');
      return;
    }
    const mode = variant === 'open' || variant === 'open-overlay' ? 'open' : 'closed';
    const aria = variant.startsWith('aria');
    const inner = variant === 'aria-child' ? '<span style="display:block;width:24px;height:24px"></span>'
      : variant === 'aria-child-button' ? '<button style="width:24px;height:24px"></button>' : '';
    const markup = aria
      ? `<div role="checkbox" aria-checked="${variant === 'aria-checked' ? 'true' : 'false'}" ${variant === 'aria-disabled' ? 'aria-disabled="true"' : ''} style="width:24px;height:24px;background:black">${inner}</div>`
      : variant === 'overlay' || variant === 'open-overlay'
        ? '<style>#cover{position:fixed;inset:0;z-index:9999;background:white}</style><input type=checkbox><div id=cover></div>'
        : '<input type=checkbox>';
    const checked = variant === 'checked' ? 'control.checked=true;' : '';
    const selector = aria ? '[role=checkbox]' : 'input';
    res.end(`<html><body><div id="host"></div><script>const root=document.getElementById("host").attachShadow({mode:"${mode}"});root.innerHTML=${JSON.stringify(markup)};const control=root.querySelector(${JSON.stringify(selector)});${checked}control.addEventListener("click",()=>parent.postMessage("cross-origin-verified","*"));root.querySelector('#cover')?.addEventListener('click',()=>parent.postMessage('cross-origin-verified','*'));</script></body></html>`);
  });
  await new Promise(resolve => child.listen(0, '127.0.0.1', resolve));
  const childOrigin = `https://challenges.cloudflare.com:${child.address().port}`;
  parent = http.createServer((req, res) => {
    const token = req.url?.startsWith('/token');
    const mode = ['aria-child-button', 'aria-child', 'aria-checked', 'aria-disabled', 'open-overlay', 'keyboard', 'closed', 'checked', 'overlay', 'aria'].find(value => req.url?.endsWith(`-${value}`)) ?? 'open';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>${token ? 'Ready' : 'Just a moment...'}</title></head><body>${token ? '<input type="hidden" name="cf-turnstile-response" value="">' : ''}<iframe src="${childOrigin}/${mode}"></iframe><script>window.addEventListener('message', event => {if(event.origin===${JSON.stringify(childOrigin)} && event.data==='cross-origin-verified'){ ${token ? 'document.querySelector("input").value="cross-origin-token";' : 'document.title="Ready";document.body.append(" cross-origin cleared");'} document.querySelector('iframe').remove();}});</script></body></html>`);
  });
  await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  bridge = spawn(process.execPath, ['flaresolverr-bridge/server.mjs'], { cwd: root, stdio: 'ignore',
    env: { ...process.env, MOLI_BIN: wrapper, MOLI_TEST_BINARY: moli, TEST_CA_CERT: certPath,
      TEST_HTTPS_PORT: String(child.address().port), BRIDGE_PORT: String(port) } });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await delay(25);
  }
  if (!ready) throw new Error('Bridge did not start');
  const call = async (target, options = {}) => (await fetch(`http://127.0.0.1:${port}/v1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url: `http://127.0.0.1:${parent.address().port}${target}`, maxTimeout: 15000, ...options }),
  })).json();
  const keyboardOnly = process.env.MOLI_TEST_KEYBOARD_ONLY === '1';
  for (const mode of keyboardOnly ? ['keyboard'] : ['open', 'closed', 'aria', 'aria-child', 'keyboard']) {
    const wall = await call(`/wall-${mode}`);
    assert.equal(wall.status, 'ok', wall.message);
    assert.match(wall.solution.response, /cross-origin cleared/);
    assert.doesNotMatch(wall.solution.response, /<iframe/);
    const token = await call(`/token-${mode}`, { tabs_till_verify: 1 });
    assert.equal(token.status, 'ok', token.message);
    assert.equal(token.solution.turnstile_token, 'cross-origin-token');
  }
  for (const mode of keyboardOnly ? [] : ['checked', 'overlay', 'open-overlay', 'aria-checked', 'aria-disabled', 'aria-child-button']) {
    const blocked = await call(`/wall-${mode}`, { maxTimeout: 7500 });
    assert.equal(blocked.status, 'error', JSON.stringify(blocked));
    assert.match(blocked.message, /timeout/i);
  }
  console.log(keyboardOnly
    ? 'PASS local TLS cross-origin keyboard challenge and token handoff'
    : 'PASS local TLS cross-origin keyboard, open/closed shadow and ARIA controls, token handoff, checked/disabled/overlay/interactive child safety');
} finally {
  if (bridge) {
    bridge.kill('SIGTERM');
    if (bridge.exitCode === null && bridge.signalCode === null) await new Promise(resolve => bridge.once('exit', resolve));
  }
  if (parent) await new Promise(resolve => parent.close(resolve));
  if (child) await new Promise(resolve => child.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
