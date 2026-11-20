import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiagnostics } from './diagnostics.mjs';

test('diagnostics report bounded, categorized events without URL, cookie or error contents', () => {
  const lines = [];
  const diagnostic = createDiagnostics(true, line => lines.push(line), () => 100);
  const page = new EventEmitter();
  const mainFrame = {};
  page.mainFrame = () => mainFrame;
  diagnostic.attach(page, 'https://target.test/private?token=secret');
  const request = {
    frame: () => mainFrame, isNavigationRequest: () => true, resourceType: () => 'document',
    url: () => 'https://target.test/private?token=secret',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET token=secret' }),
  };
  page.emit('response', { request: () => request, status: () => 403, url: request.url });
  page.emit('requestfailed', request);
  page.emit('pageerror', Object.assign(new Error('cookie=secret'), { name: 'TypeError' }));
  const records = lines.map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.event), ['response', 'request-failed', 'page-error']);
  assert.equal(records[0].location, 'target-origin');
  assert.equal(records[0].status, 403);
  assert.equal(records[1].code, 'net::ERR_CONNECTION_RESET');
  assert.equal(records[2].name, 'TypeError');
  assert.ok(!lines.join('\n').includes('secret'));
  for (let i = 0; i < 300; i++) diagnostic.report('phase', { phase: 'checking page' });
  assert.equal(lines.length, 200);
});

test('disabled diagnostics do not attach event listeners or emit records', () => {
  const page = new EventEmitter();
  const diagnostic = createDiagnostics(false, () => assert.fail('unexpected diagnostic'));
  diagnostic.attach(page, 'https://target.test/');
  diagnostic.report('phase');
  assert.equal(page.eventNames().length, 0);
});
