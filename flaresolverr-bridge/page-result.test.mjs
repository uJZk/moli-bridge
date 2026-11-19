import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectPageResult, navigateInitial, observeNavigation } from './page-result.mjs';

function fixture() {
  const state = { generation: 0, response: null };
  const response = status => ({ status: () => status, allHeaders: async () => ({ 'x-status': String(status) }) });
  let url = 'https://example.test/old';
  const page = {
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    title: async () => 'Ready', locator: () => ({ count: async () => 0 }),
    url: () => url, evaluate: async () => 'agent', content: async () => '<html>final</html>',
  };
  const context = { cookies: async () => [{ name: 'session', value: 'final' }] };
  return { page, context, state, response, navigate() { url = 'https://example.test/final'; state.generation++; state.response = response(201); } };
}

test('retries a destroyed context and returns the final document response', async () => {
  const f = fixture();
  let attempts = 0;
  f.page.title = async () => {
    if (!attempts++) { f.navigate(); throw new Error('Execution context was destroyed, most likely because of a navigation'); }
    return 'Ready';
  };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(attempts, 3);
  assert.equal(result.url, 'https://example.test/final');
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-status'], '201');
  assert.equal(result.response, '<html>final</html>');
  assert.equal(result.cookies[0].value, 'final');
});

test('rechecks when navigation occurs while collecting content', async () => {
  const f = fixture();
  let calls = 0;
  f.page.content = async () => { if (!calls++) { f.navigate(); return 'old'; } return 'final'; };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(result.response, 'final');
  assert.equal(result.status, 201);
});

test('requires a new quiet window after a normal page navigates', async () => {
  const f = fixture();
  const waits = [];
  f.page.waitForTimeout = async ms => { waits.push(ms); if (waits.length === 1) f.navigate(); };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.deepEqual(waits, [500, 500]);
  assert.equal(result.url, 'https://example.test/final');
  assert.equal(result.status, 201);
});

test('waits for a short meta refresh and returns the destination response', async () => {
  const f = fixture();
  f.page.content = async () => f.state.generation
    ? '<html>final</html>' : '<meta http-equiv="refresh" content="1; url=/final">';
  let waits = 0;
  f.page.waitForTimeout = async () => { if (!waits++) f.navigate(); };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(result.url, 'https://example.test/final');
  assert.equal(result.status, 201);
  assert.equal(result.response, '<html>final</html>');
  assert.equal(waits, 2);
});

test('notices a meta refresh inserted during the quiet window', async () => {
  const f = fixture();
  let reads = 0;
  f.page.content = async () => f.state.generation ? '<html>final</html>'
    : ++reads === 1 ? '<html>initial</html>' : '<meta http-equiv="refresh" content="1;url=/final">';
  let waits = 0;
  f.page.waitForTimeout = async () => { if (++waits === 2) f.navigate(); };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(result.url, 'https://example.test/final');
  assert.equal(result.status, 201);
  assert.equal(result.response, '<html>final</html>');
  assert.equal(waits, 3);
});

test('returns an error if an advertised meta refresh never navigates', async t => {
  const f = fixture();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  f.page.content = async () => '<meta http-equiv="refresh" content="1;url=/final">';
  f.page.waitForTimeout = async ms => { now += ms; };
  await assert.rejects(collectPageResult(f.page, f.context, {}, f.response(200), f.state),
    /Meta refresh navigation did not occur/);
  assert.equal(now, 4000);
});

test('propagates unrelated failures', async () => {
  const f = fixture();
  f.page.title = async () => { throw new Error('page closed'); };
  await assert.rejects(collectPageResult(f.page, f.context, {}, null, f.state), /page closed/);
});

test('waits for a started navigation and uses only its response', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const frame = {};
  events.mainFrame = () => frame;
  const state = observeNavigation(events);
  const request = { isNavigationRequest: () => true, frame: () => frame };
  events.emit('request', request);
  let waits = 0;
  f.page.waitForTimeout = async () => {
    waits++;
    if (waits !== 1) return;
    const finalResponse = f.response(201);
    finalResponse.request = () => request;
    events.emit('response', finalResponse);
    events.emit('framenavigated', frame);
  };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), state);
  assert.equal(waits, 2);
  assert.equal(result.status, 201);
});

test('recovers an interrupted initial goto only after a replacement main-frame request', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const frame = {};
  events.mainFrame = () => frame;
  const state = observeNavigation(events);
  const first = { isNavigationRequest: () => true, frame: () => frame };
  const next = { isNavigationRequest: () => true, frame: () => frame };
  const finalResponse = f.response(201);
  finalResponse.request = () => next;
  f.page.goto = async () => {
    events.emit('request', first);
    events.emit('request', next);
    events.emit('response', finalResponse);
    events.emit('framenavigated', frame);
    throw new Error('page.goto: Navigation to the page is interrupted by another navigation');
  };
  const initial = await navigateInitial(f.page, 'https://example.test/old', 1000, state);
  f.navigate();
  const result = await collectPageResult(f.page, f.context, {}, initial, state);
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-status'], '201');
  assert.equal(result.cookies[0].value, 'final');
});

test('does not hide an aborted initial goto without a replacement request', async () => {
  const f = fixture();
  const state = { navigationRequests: 0 };
  f.page.goto = async () => { state.navigationRequests++; throw new Error('page.goto: net::ERR_ABORTED'); };
  await assert.rejects(navigateInitial(f.page, 'https://example.test/', 1000, state), /ERR_ABORTED/);
  f.page.goto = async () => { state.navigationRequests += 2; throw new Error('page.goto: net::ERR_CONNECTION_REFUSED'); };
  await assert.rejects(navigateInitial(f.page, 'https://example.test/', 1000, state), /ERR_CONNECTION_REFUSED/);
});

test('reports failure of the replacement navigation after an interrupted goto', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const frame = {};
  events.mainFrame = () => frame;
  const state = observeNavigation(events);
  const first = { isNavigationRequest: () => true, frame: () => frame };
  const next = { isNavigationRequest: () => true, frame: () => frame,
    failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }) };
  f.page.goto = async () => {
    events.emit('request', first);
    events.emit('request', next);
    events.emit('requestfailed', next);
    throw new Error('page.goto: net::ERR_ABORTED');
  };
  const initial = await navigateInitial(f.page, 'https://example.test/', 1000, state);
  await assert.rejects(collectPageResult(f.page, f.context, {}, initial, state), /Navigation failed: net::ERR_CONNECTION_REFUSED/);
});

test('challenge is rechecked after the page changes', async () => {
  const f = fixture();
  let calls = 0;
  f.page.title = async () => calls++ === 0 ? 'Just a moment...' : 'Ready';
  let navigated = false;
  f.page.waitForTimeout = async () => { if (!navigated) { navigated = true; f.navigate(); } };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(result.status, 201);
  assert.equal(calls, 4);
});

test('access denied titles are matched as prefixes', async () => {
  const f = fixture();
  f.page.title = async () => 'Access denied | example';
  await assert.rejects(collectPageResult(f.page, f.context, {}, null, f.state), /denied access/);
});

test('challenge titles are matched without regard to case', async () => {
  const f = fixture();
  let calls = 0;
  f.page.title = async () => calls++ ? 'Ready' : 'JUST A MOMENT...';
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(calls, 4);
  assert.equal(result.status, 200);
});

test('TRAWL challenge title requires two clear observations', async () => {
  const f = fixture();
  const titles = ['Checking your browser before accessing example', 'Ready', 'Ready'];
  f.page.title = async () => titles.shift() ?? 'Ready';
  await collectPageResult(f.page, f.context, {}, f.response(200), f.state);
  assert.equal(titles.length, 0);
});

test('reports a failed main-frame navigation instead of waiting until timeout', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const frame = {};
  events.mainFrame = () => frame;
  const state = observeNavigation(events);
  const request = { isNavigationRequest: () => true, frame: () => frame,
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
  events.emit('request', request);
  events.emit('requestfailed', request);
  await assert.rejects(collectPageResult(f.page, f.context, {}, null, state), /Navigation failed: net::ERR_CONNECTION_RESET/);
});

test('allows a replacement navigation after an aborted request', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const frame = {};
  events.mainFrame = () => frame;
  const state = observeNavigation(events);
  const failed = { isNavigationRequest: () => true, frame: () => frame,
    failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
  const next = { isNavigationRequest: () => true, frame: () => frame };
  events.emit('request', failed);
  events.emit('requestfailed', failed);
  let navigated = false;
  f.page.waitForTimeout = async () => {
    if (!navigated) { navigated = true; events.emit('request', next); events.emit('framenavigated', frame); }
  };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), state);
  assert.equal(result.status, 200);
});

test('does not return a browser error document as a successful page', async () => {
  const f = fixture();
  f.page.url = () => 'chrome-error://chromewebdata/';
  await assert.rejects(collectPageResult(f.page, f.context, {}, f.response(200), f.state), /Navigation failed/);
});

test('waits when only the main response header identifies a Cloudflare challenge', async () => {
  const f = fixture();
  const initial = f.response(403);
  initial.headers = () => ({ 'Cf-Mitigated': 'challenge' });
  let waits = 0;
  f.page.waitForTimeout = async () => { waits++; if (waits === 1) f.navigate(); };
  const result = await collectPageResult(f.page, f.context, {}, initial, f.state);
  assert.equal(result.status, 201);
  assert.equal(waits, 3); // challenge polling, a clear observation, and the stable window
});

test('reports an explicit AWS CAPTCHA rather than returning its page as success', async () => {
  const f = fixture();
  const response = f.response(405);
  response.headers = () => ({ 'X-Amzn-Waf-Action': 'captcha' });
  await assert.rejects(collectPageResult(f.page, f.context, {}, response, f.state), /AWS WAF CAPTCHA/);
});

test('DDoS-Guard recovery consumes the shared single-recovery allowance', async () => {
  const f = fixture();
  f.page.title = async () => f.state.generation ? 'Ready' : 'Please wait';
  f.page.content = async () => f.state.generation ? '<html>final</html>' : '<h1 id="ddg-l10n-title">Checking</h1>';
  let cloudflareUsed = 0;
  let ddosUsed = 0;
  let dataDomeUsed = 0;
  const recovery = {
    cloudflare: { markAttempted: () => { cloudflareUsed++; } },
    ddosGuard: { url: 'https://example.test/old', ready: async () => true, markAttempted: () => { ddosUsed++; } },
    dataDome: { markAttempted: () => { dataDomeUsed++; } },
  };
  f.page.goto = async url => { assert.equal(url, recovery.ddosGuard.url); f.navigate(); };
  const result = await collectPageResult(f.page, f.context, {}, f.response(200), f.state, undefined, recovery);
  assert.equal(result.status, 201);
  assert.equal(cloudflareUsed, 1);
  assert.equal(ddosUsed, 1);
  assert.equal(dataDomeUsed, 1);
});

test('DataDome Device Check consumes the shared single-recovery allowance', async () => {
  const f = fixture();
  const initial = f.response(403);
  initial.headers = () => ({ 'x-dd-b': '1' });
  f.page.content = async () => f.state.generation ? '<html>final</html>'
    : '<script>var dd={"rt":"i","host":"geo.captcha-delivery.com"}</script>';
  const used = [];
  const recovery = {
    cloudflare: { markAttempted: () => used.push('cf') },
    ddosGuard: { markAttempted: () => used.push('ddos') },
    dataDome: { url: 'https://example.test/old', ready: async () => true, markAttempted: () => used.push('dd') },
  };
  f.page.goto = async url => { assert.equal(url, recovery.dataDome.url); f.navigate(); };
  const result = await collectPageResult(f.page, f.context, {}, initial, f.state, undefined, recovery);
  assert.equal(result.status, 201);
  assert.deepEqual(used, ['cf', 'ddos', 'dd']);
});

test('DataDome CAPTCHA does not fall back to a Cloudflare cookie recovery', async () => {
  const f = fixture();
  const initial = f.response(403);
  initial.headers = () => ({ 'x-dd-b': '1' });
  f.page.title = async () => 'Just a moment...';
  f.page.content = async () => '<script>var dd={"rt":"c","host":"geo.captcha-delivery.com"}</script>';
  f.page.waitForTimeout = async () => { throw new Error('end of fixture'); };
  let readyCalls = 0;
  const candidate = { ready: async () => { readyCalls++; return true; }, markAttempted() {} };
  const recovery = { cloudflare: candidate, ddosGuard: candidate, dataDome: candidate };
  await assert.rejects(collectPageResult(f.page, f.context, {}, initial, f.state, undefined, recovery), /end of fixture/);
  assert.equal(readyCalls, 0);
});

test('ordinary responses with an unrelated WAF header remain readable', async () => {
  const f = fixture();
  const response = f.response(200);
  response.headers = () => ({ 'x-amzn-waf-action': 'captcha' });
  assert.equal((await collectPageResult(f.page, f.context, {}, response, f.state)).status, 200);
});

test('ignores challenge headers and failures from subresources and child frames', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const main = {};
  const child = {};
  events.mainFrame = () => main;
  const state = observeNavigation(events);
  const mainRequest = { isNavigationRequest: () => true, frame: () => main };
  const image = { isNavigationRequest: () => false, frame: () => main };
  const childNavigation = { isNavigationRequest: () => true, frame: () => child };
  const mainResponse = { ...f.response(200), request: () => mainRequest, headers: () => ({}) };
  const childResponse = { ...f.response(403), request: () => childNavigation,
    headers: () => ({ 'cf-mitigated': 'challenge' }) };
  events.emit('request', mainRequest);
  events.emit('response', mainResponse);
  events.emit('framenavigated', main);
  events.emit('request', image);
  events.emit('requestfailed', image);
  events.emit('request', childNavigation);
  events.emit('response', childResponse);
  assert.equal(state.response, mainResponse);
  assert.equal(state.failure, null);
  assert.equal((await collectPageResult(f.page, f.context, {}, null, state)).status, 200);
});
