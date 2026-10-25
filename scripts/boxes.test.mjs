import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNodeVersion, ensureEnvFile, makeWatchToken, pickLanIp, REQUIRED_NODE_MAJOR } from './boxes.mjs';

function envWorkspace(example) {
  const root = mkdtempSync(join(tmpdir(), 'boxes-env-'));
  if (example !== undefined) writeFileSync(join(root, '.env.example'), example);
  return root;
}

test('a wrong Node version fails naming the requirement', () => {
  assert.throws(() => assertNodeVersion('v20.20.2'), /Node 22 or newer/);
  assert.throws(() => assertNodeVersion('v20.20.2'), /WebSocket/);
  assert.throws(() => assertNodeVersion('v18.0.0'), /This is Node v18\.0\.0\./);
  assert.equal(assertNodeVersion('v22.11.0'), 22);
  assert.equal(assertNodeVersion('v24.1.0'), 24);
  assert.throws(() => assertNodeVersion('odd'), /Node 22 or newer/);
  assert.equal(REQUIRED_NODE_MAJOR, 22);
});

test('a fresh clone gets .env from .env.example with a working token', () => {
  const root = envWorkspace('WATCH_TOKEN=\nWATCH_PORT=8788\n');
  const { token, created, changed } = ensureEnvFile(root, 'tok-1');
  assert.equal(created, true);
  assert.equal(changed, true);
  assert.equal(token, 'tok-1');
  const text = readFileSync(join(root, '.env'), 'utf8');
  assert.match(text, /^WATCH_TOKEN=tok-1$/m);
  assert.match(text, /^WATCH_PORT=8788$/m);
  rmSync(root, { recursive: true, force: true });
});

test('a blank WATCH_TOKEN line is filled and a set one is never replaced', () => {
  const root = envWorkspace('XMR_WALLET_RPC=http://127.0.0.1:18083\nWATCH_TOKEN=\n');
  const first = ensureEnvFile(root, 'tok-2');
  assert.equal(first.token, 'tok-2');
  assert.equal(first.changed, true);
  const second = ensureEnvFile(root, 'tok-3');
  assert.deepEqual(second, { token: 'tok-2', created: false, changed: false });
  rmSync(root, { recursive: true, force: true });
});

test('without .env.example the failure says what to write', () => {
  const root = envWorkspace(undefined);
  assert.throws(() => ensureEnvFile(root, 'tok-4'), /WATCH_TOKEN=/);
  rmSync(root, { recursive: true, force: true });
});

test('an existing token survives a rerun untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'boxes-env-'));
  writeFileSync(join(root, '.env'), 'WATCH_TOKEN=already-set\n');
  const result = ensureEnvFile(root, 'tok-5');
  assert.deepEqual(result, { token: 'already-set', created: false, changed: false });
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'WATCH_TOKEN=already-set\n');
  rmSync(root, { recursive: true, force: true });
});

test('tokens are long enough to paste and not equal twice in a row', () => {
  const a = makeWatchToken();
  const b = makeWatchToken();
  assert.ok(a.length >= 24);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('the watcher URL prefers a LAN address and falls back to loopback', () => {
  const lan = pickLanIp({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
  });
  assert.equal(lan, '192.168.1.20');
  const none = pickLanIp({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    docker0: [{ family: 'IPv6', internal: false, address: 'fe80::1' }],
  });
  assert.equal(none, '');
});
