import test from 'node:test';
import assert from 'node:assert/strict';
import { getAwsWafHtmlAction, isExplicitHtmlChallenge } from './upstream/trawl-challenge-evidence.mjs';

const configuration = '<script>window.gokuProps = { key: "fixture" };</script>';
const asset = type => `<script src="https://region.token.awswaf.com/example/${type}.js"></script>`;
const page = (scripts, body = '') => `<html><head>${scripts}</head><body>${body}</body></html>`;

test('recognizes active AWS WAF script interstitials without authorizing POST replay', () => {
  for (const status of [200, 202, 403, 405, 429, 503]) {
    for (const action of ['challenge', 'captcha']) {
      const html = page(configuration + asset(action));
      assert.equal(getAwsWafHtmlAction(status, html), action, `${status} ${action}`);
      assert.equal(isExplicitHtmlChallenge(status, html), false, 'script evidence alone must not authorize POST replay');
    }
  }
});

test('ignores ordinary pages, inert scripts and untrusted script hosts', () => {
  const ordinary = page(configuration + asset('captcha'), '<main><h1>Sign in</h1></main>');
  const cases = [
    ordinary,
    page(`<template>${configuration + asset('challenge')}</template>`),
    page(`<noscript>${configuration + asset('challenge')}</noscript>`),
    page('<script type="application/json">window.gokuProps = {}</script>' + asset('challenge')),
    page(configuration + '<script type="application/json" src="https://token.awswaf.com/challenge.js"></script>'),
    page(configuration + '<script src="https://token.awswaf.com.attacker.test/challenge.js"></script>'),
    page(configuration + '<script src="http://token.awswaf.com/challenge.js"></script>'),
    page('<script src="https://token.awswaf.com/challenge.js">window.gokuProps = {}</script>'),
    page('<p>window.gokuProps = {}; token.awswaf.com/challenge.js</p>'),
  ];
  for (const html of cases) assert.equal(getAwsWafHtmlAction(200, html), undefined, html);
  assert.equal(getAwsWafHtmlAction(200, page(configuration + asset('challenge'), '<form></form>')), undefined);
});
