import test from 'node:test';
import assert from 'node:assert/strict';
import { isCloudflareErrorUrl } from './upstream/trawl-detect.mjs';

test('recognizes Cloudflare error paths and corroborated error codes', () => {
  for (const url of ['https://site.test/cdn-cgi/error/', 'https://site.test/cdn-cgi/error/1020', 'https://site.test/cdn-cgi/error']) {
    assert.equal(isCloudflareErrorUrl(url, 200, {}), true);
  }
  assert.equal(isCloudflareErrorUrl('https://site.test/?error=1020', 403, { 'Cf-Ray': 'fixture' }), true);
  assert.equal(isCloudflareErrorUrl('https://site.test/?error=1015', 429, { Server: 'cloudflare' }), true);
});

test('does not mistake unrelated paths and query parameters for blocks', () => {
  for (const [url, status, headers] of [
    ['https://site.test/search?error=1020', 200, { 'cf-ray': 'fixture' }],
    ['https://site.test/search?error=1020', 403, {}],
    ['https://site.test/search?error=10200', 403, { 'cf-ray': 'fixture' }],
    ['https://site.test/cdn-cgi/error-page', 403, {}],
    ['https://site.test/search?next=/cdn-cgi/error/', 200, {}],
    ['not a url', 403, { 'cf-ray': 'fixture' }],
  ]) assert.equal(isCloudflareErrorUrl(url, status, headers), false, url);
});
