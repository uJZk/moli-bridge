import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiagnostics } from './diagnostics.mjs';

test('diagnostics report bounded, categorized events without URL, cookie or error contents', async () => {
  const lines = [];
  const diagnostic = createDiagnostics(true, line => lines.push(line), () => 100);
  const page = new EventEmitter();
  const mainFrame = {};
  page.mainFrame = () => mainFrame;
  let marker;
  page.addInitScript = async (_script, args) => { marker = args.marker; };
  await diagnostic.attach(page, 'https://target.test/private?token=secret');
  const request = {
    frame: () => mainFrame, isNavigationRequest: () => true, resourceType: () => 'document',
    url: () => 'https://target.test/private?token=secret',
    allHeaders: async () => ({ cookie: 'session=secret; cf_clearance=secret' }),
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET token=secret' }),
  };
  page.emit('request', request);
  await Promise.resolve();
  page.emit('response', { request: () => request, status: () => 403, url: request.url });
  page.emit('requestfailed', request);
  page.emit('pageerror', Object.assign(new Error('cookie=secret'), { name: 'TypeError' }));
  page.emit('console', { type: () => 'error', text: () => `${marker}:ReferenceError` });
  const records = lines.map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.event), ['navigation-cookie', 'response', 'request-failed', 'page-error', 'window-error']);
  assert.equal(records[0].clearance, 'nonempty');
  assert.equal(records[1].location, 'target-origin');
  assert.equal(records[1].status, 403);
  assert.equal(records[0].navigation, records[1].navigation);
  assert.equal(records[2].code, 'net::ERR_CONNECTION_RESET');
  assert.equal(records[3].name, 'TypeError');
  assert.equal(records[4].name, 'ReferenceError');
  assert.ok(!lines.join('\n').includes('secret'));
  for (let i = 0; i < 300; i++) diagnostic.report('phase', { phase: 'checking page' });
  assert.equal(lines.length, 200);
});

test('distinguishes an absent or empty clearance cookie from unavailable headers', async () => {
  const lines = [];
  const diagnostic = createDiagnostics(true, line => lines.push(JSON.parse(line)));
  const page = new EventEmitter();
  const frame = {};
  page.mainFrame = () => frame;
  page.addInitScript = async () => {};
  await diagnostic.attach(page, 'https://target.test/');
  for (const headers of [{ cookie: 'sid=1' }, { cookie: 'cf_clearance=; sid=1' }, null]) {
    page.emit('request', { frame: () => frame, isNavigationRequest: () => true,
      allHeaders: async () => { if (!headers) throw new Error('secret'); return headers; } });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lines.map(record => record.clearance), ['absent', 'empty', 'unavailable']);
  assert.deepEqual(lines.map(record => record.navigation), [1, 2, 3]);
  assert.ok(!JSON.stringify(lines).includes('secret'));
});

test('disabled diagnostics do not attach event listeners or emit records', () => {
  const page = new EventEmitter();
  const diagnostic = createDiagnostics(false, () => assert.fail('unexpected diagnostic'));
  diagnostic.attach(page, 'https://target.test/');
  diagnostic.report('phase');
  assert.equal(page.eventNames().length, 0);
});
