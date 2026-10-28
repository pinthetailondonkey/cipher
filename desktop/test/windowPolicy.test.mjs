import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUiUrl, applyWindowPolicy } = require('../src/windowPolicy.js');

function fakeContents() {
  const handlers = {};
  return {
    handlers,
    policy: null,
    openHandler: null,
    setWindowOpenHandler(fn) { this.openHandler = fn; },
    setWebRTCIPHandlingPolicy(p) { this.policy = p; },
    on(name, fn) { handlers[name] = fn; },
  };
}

function navigate(contents, name, url) {
  let prevented = false;
  contents.handlers[name]({ preventDefault() { prevented = true; } }, url);
  return prevented;
}

test('only the exact UI origin counts as the UI', () => {
  assert.equal(isUiUrl('http://127.0.0.1:9151/', 9151), true);
  assert.equal(isUiUrl('http://127.0.0.1:9151/#/chat?x=1', 9151), true);
  for (const bad of [
    'https://example.com/',
    'http://127.0.0.1:9152/',
    'http://127.0.0.1/',
    'http://localhost:9151/',
    'https://127.0.0.1:9151/',
    'http://127.0.0.1:9151@evil.example/',
    'http://user:pw@127.0.0.1:9151/',
    'http://127.0.0.1.evil.example:9151/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'about:blank',
    'not a url',
    '',
  ]) assert.equal(isUiUrl(bad, 9151), false, bad);
});

test('window.open is denied for every url, UI or not', () => {
  const c = fakeContents();
  applyWindowPolicy(c, { uiPort: 9151 });
  assert.deepEqual(c.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(c.openHandler({ url: 'http://127.0.0.1:9151/' }), { action: 'deny' });
});

test('navigation and redirects off the UI origin are cancelled, on it are not', () => {
  const c = fakeContents();
  applyWindowPolicy(c, { uiPort: 9151 });
  for (const name of ['will-navigate', 'will-redirect']) {
    assert.equal(navigate(c, name, 'https://example.com/'), true, name);
    assert.equal(navigate(c, name, 'file:///etc/passwd'), true, name);
    assert.equal(navigate(c, name, 'http://127.0.0.1:9151/other'), false, name);
  }
  assert.equal(navigate(c, 'will-attach-webview', 'x'), true);
});

test('WebRTC is locked unless the dev hatch is set', () => {
  const locked = fakeContents();
  applyWindowPolicy(locked, { uiPort: 9151 });
  assert.equal(locked.policy, 'disable_non_proxied_udp');
  const dev = fakeContents();
  applyWindowPolicy(dev, { uiPort: 9151, allowCalls: true });
  assert.equal(dev.policy, null);
});
