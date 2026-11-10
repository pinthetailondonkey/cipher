import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProtocolTestRelayAllowed, deleteProtocolTestDatabase, listProtocolTestDatabases, parseProtocolTestRelayAllowlist,
  startProtocolTestMode } from './protocolTestMode.js';

test('protocol test relay configuration accepts only explicit loopback WebSocket endpoints', () => {
  assert.deepEqual(parseProtocolTestRelayAllowlist(''), []);
  assert.deepEqual(parseProtocolTestRelayAllowlist('ws://127.0.0.1:18888 ws://localhost:18889'), [
    'ws://127.0.0.1:18888', 'ws://localhost:18889',
  ]);
  for (const value of ['wss://relay.example:443', 'ws://relay.example:18888',
    'ws://127.0.0.1', 'ws://127.0.0.1:0', 'ws://127.0.0.1:18888/path', 'ws://user@127.0.0.1:18888']) {
    assert.throws(() => parseProtocolTestRelayAllowlist(value), /local WebSocket|loopback/);
  }
});

test('protocol test relay sends reject missing config and every non-allowlisted endpoint', () => {
  assert.throws(() => assertProtocolTestRelayAllowed('ws://127.0.0.1:18888', []), /allowlist is missing/);
  assert.throws(() => assertProtocolTestRelayAllowed('wss://relay.example', ['ws://127.0.0.1:18888']), /outside|loopback/);
  assert.throws(() => assertProtocolTestRelayAllowed('ws://user@127.0.0.1:18888', ['ws://127.0.0.1:18888']), /credentials/);
  assert.throws(() => assertProtocolTestRelayAllowed('ws://127.0.0.1:18888/path', ['ws://127.0.0.1:18888']), /credentials/);
  assert.equal(assertProtocolTestRelayAllowed('ws://127.0.0.1:18888', ['ws://127.0.0.1:18888']), 'ws://127.0.0.1:18888');
});

test('test mode refuses a shipping build and a missing relay config before creating identity or database', async () => {
  let opened = false;
  const options = { databaseFactory: () => { opened = true; throw new Error('must not open'); } };
  await assert.rejects(startProtocolTestMode({ ...options, buildEnabled: false,
    relayAllowlist: 'ws://127.0.0.1:18888' }), /does not include/);
  let generatedKeys = 0;
  await assert.rejects(startProtocolTestMode({ ...options, buildEnabled: true, relayAllowlist: '',
    keyFactory: () => { generatedKeys += 1; return new Uint8Array(32); } }), /allowlist is missing/);
  assert.equal(generatedKeys, 0, 'missing relay config must fail before creating identity or device keys');
  assert.equal(opened, false);
});

test('started test mode uses a separate disposable namespace and kill switch holds state', async () => {
  const databases = new Map();
  const runTable = {
    async put(value) { databases.get(this.name).run.push(value); },
    async update(id, patch) { Object.assign(databases.get(this.name).run[0], patch); },
  };
  const deviceTable = { async put(value) { databases.get(this.name).devices.push(value); } };
  let sequence = 0;
  const controller = await startProtocolTestMode({
    buildEnabled: true,
    relayAllowlist: 'ws://127.0.0.1:18888',
    cryptoImpl: { getRandomValues(bytes) { bytes.fill(++sequence); return bytes; } },
    keyFactory: () => new Uint8Array(32).fill(++sequence),
    publicKeyFor: (secret) => `pub-${secret[0]}`,
    databaseFactory: (name) => {
      const data = { run: [], devices: [], opened: false, closed: false };
      databases.set(name, data);
      const db = { name, run: { ...runTable, name }, devices: { ...deviceTable, name },
        version() { return { stores() {} }; }, async open() { data.opened = true; },
        async transaction(_mode, ...args) { return args.at(-1)(); }, close() { data.closed = true; } };
      return db;
    },
    now: () => 123,
  });
  assert.match(controller.databaseName, /^CipherProtocolTest_v1_/);
  assert.equal(controller.identity.kind, 'disposable-test-identity');
  assert.equal(databases.get(controller.databaseName).devices.length, 1);
  assert.equal(controller.assertRelayAllowed('ws://127.0.0.1:18888'), 'ws://127.0.0.1:18888');
  const stopped = await controller.stop();
  assert.deepEqual(stopped, { disabled: true, held: true });
  assert.equal(databases.get(controller.databaseName).run[0].status, 'held');
  assert.throws(() => controller.assertRelayAllowed('ws://127.0.0.1:18888'), /disabled/);
  assert.equal(databases.get(controller.databaseName).closed, true);
});

test('test cleanup lists and deletes only databases inside the disposable namespace', async () => {
  const calls = [];
  const indexedDb = {
    async databases() { return [
      { name: 'CipherProtocolTest_v1_0123456789abcdef0123456789abcdef' },
      { name: 'CipherDB_v7_0123456789abcdef' },
      { name: 'CipherProtocolTest_v1_bad' },
    ]; },
    deleteDatabase(name) {
      calls.push(name);
      const request = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  assert.deepEqual(await listProtocolTestDatabases(indexedDb), [
    'CipherProtocolTest_v1_0123456789abcdef0123456789abcdef',
  ]);
  await assert.rejects(deleteProtocolTestDatabase('CipherDB_v7_0123456789abcdef', indexedDb), /outside the protocol test namespace/);
  await deleteProtocolTestDatabase('CipherProtocolTest_v1_0123456789abcdef0123456789abcdef', indexedDb);
  assert.deepEqual(calls, ['CipherProtocolTest_v1_0123456789abcdef0123456789abcdef']);
});
