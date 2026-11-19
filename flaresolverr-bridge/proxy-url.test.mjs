import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProxy } from './proxy-url.mjs';

test('separate proxy credentials retain reserved characters and literal percent escapes', () => {
  const input = { url: 'http://proxy.test:8080', username: 'user%40name', password: 'p@ss:word%40' };
  const url = new URL(normalizeProxy(input));
  assert.equal(decodeURIComponent(url.username), input.username);
  assert.equal(decodeURIComponent(url.password), input.password);
  assert.match(url.href, /user%2540name:p%40ss%3Aword%2540@/);
});

test('proxy URL credentials are not encoded a second time', () => {
  const url = new URL(normalizeProxy({ url: 'http://user:p%2540@proxy.test:8080' }));
  assert.equal(decodeURIComponent(url.password), 'p%40');
});

test('normalizes the SOCKS5 remote-DNS alias and preserves credentials', () => {
  const proxy = normalizeProxy({ url: 'socks5h://user:p%2540@proxy.test:1080' });
  assert.equal(proxy, 'socks5://user:p%2540@proxy.test:1080');
});

test('invalid proxy values and non-string credentials are rejected', () => {
  assert.equal(normalizeProxy(undefined), undefined);
  for (const value of [{ url: 'file:///tmp/proxy' }, { url: 'http://proxy.test', username: 1 },
    { url: 'http://proxy.test', password: null }, { url: 'http://proxy.test', password: '\ud800' }]) {
    assert.throws(() => normalizeProxy(value));
  }
});
