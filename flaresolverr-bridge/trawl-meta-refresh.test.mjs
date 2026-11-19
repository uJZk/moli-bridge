import test from 'node:test';
import assert from 'node:assert/strict';
import { metaRefreshTarget } from './upstream/trawl-meta-refresh.mjs';

const url = 'https://example.test/start';

test('recognizes short refreshes, relative bases, mixed-case attributes and quoted destinations', () => {
  const html = `<base href="/section/"><meta HTTP-EQUIV="REFRESH" content="1.5; URL='/final'">`;
  assert.deepEqual(metaRefreshTarget(html, url), { delayMs: 1500, url: 'https://example.test/final' });
  assert.deepEqual(metaRefreshTarget('<base href="/section/"><meta http-equiv="refresh" content="0; next">', url),
    { delayMs: 0, url: 'https://example.test/section/next' });
});

test('ignores inert, unsupported, same-document and long refreshes', () => {
  for (const html of [
    '<template><meta http-equiv="refresh" content="0;url=/bad"></template>',
    '<noscript><meta http-equiv="refresh" content="0;url=/bad"></noscript>',
    '<svg><meta http-equiv="refresh" content="0;url=/bad"></meta></svg>',
    '<textarea><meta http-equiv="refresh" content="0;url=/bad"></textarea>',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<meta http-equiv="refresh" content="0;url=/start">',
    '<meta http-equiv="refresh" content="11;url=/next">',
    '<meta http-equiv="refresh" content="1">',
  ]) assert.equal(metaRefreshTarget(html, url), undefined, html);
});
