import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDataDomeChallengeHeader } from './upstream/trawl-detect.mjs';
import { hasDataDomeDeviceCheck, hasDataDomeHardBlock, isExplicitHtmlChallenge } from './upstream/trawl-challenge-evidence.mjs';
import { PostReplay } from './upstream/post-replay.mjs';

test('recognizes the block-specific DataDome header without treating passive headers as blocks', () => {
  assert.equal(hasDataDomeChallengeHeader({ 'X-DD-B': '1' }), true);
  assert.equal(hasDataDomeChallengeHeader({ 'x-dd-b': '' }), true);
  assert.equal(hasDataDomeChallengeHeader({ 'x-datadome': 'protected', 'x-datadome-cid': 'fixture' }), false);
  assert.equal(hasDataDomeChallengeHeader({}), false);
  assert.equal(isExplicitHtmlChallenge(403, '<title>DataDome</title>'), false, 'DataDome evidence does not authorize POST replay');
});

test('recognizes an active DataDome hard-block object on an error response', () => {
  const script = '<script>var dd={"rt":"c","t":"bv","host":"geo.captcha-delivery.com"}</script>';
  assert.equal(hasDataDomeHardBlock(403, script), true);
  assert.equal(hasDataDomeHardBlock(429, script), true);
  assert.equal(hasDataDomeHardBlock(200, script), false);
  assert.equal(isExplicitHtmlChallenge(403, script), false, 'hard-block evidence does not authorize POST replay');
  for (const html of [
    `<template>${script}</template>`,
    `<noscript>${script}</noscript>`,
    '<script type="application/json">var dd={"t":"bv","host":"geo.captcha-delivery.com"}</script>',
    '<script src="https://example.test/a.js">var dd={"t":"bv","host":"geo.captcha-delivery.com"}</script>',
    '<script>var dd={"t":"fe","host":"geo.captcha-delivery.com"}</script>',
    '<script>var dd={"t":"bv","host":"geo.captcha-delivery.com.evil.test"}</script>',
    '<script>var dd={"t":"bv","host":"evil@geo.captcha-delivery.com"}</script>',
    `<script>var text="dd={'t':'bv','host':'geo.captcha-delivery.com'}";</script>`,
    `<script>// var dd={'t':'bv','host':'geo.captcha-delivery.com'}</script>`,
    '<p>dd={"t":"bv","host":"geo.captcha-delivery.com"}</p>',
  ]) assert.equal(hasDataDomeHardBlock(403, html), false, html);
});

test('recognizes Device Check without mistaking sliders and hard blocks for it', () => {
  const device = '<script>var dd={"rt":"i","host":"geo.captcha-delivery.com"}</script>';
  assert.equal(hasDataDomeDeviceCheck(device), true);
  assert.equal(hasDataDomeDeviceCheck(device.replace('"i"', '"c"')), false);
  assert.equal(hasDataDomeDeviceCheck(device.replace('"i"', '"i","t":"bv"')), false);
  assert.equal(hasDataDomeDeviceCheck('<template>' + device + '</template>'), false);
  assert.equal(hasDataDomeDeviceCheck(device.replace('geo.captcha-delivery.com', 'geo.captcha-delivery.com.evil.test')), false);
});

test('DataDome block headers do not authorize POST replay', async () => {
  const guard = new PostReplay();
  const request = {};
  guard.beginAttempt();
  assert.equal(await guard.submit(request), true);
  guard.observe({ request: () => request, status: () => 403, headers: () => ({ 'x-dd-b': '1' }) });
  assert.equal(await guard.canRetry(), false);
  assert.equal(await guard.submit({}), false);
  assert.throws(() => guard.check(), /POST replay blocked/);
});
