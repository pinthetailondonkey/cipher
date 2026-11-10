import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProtocolTestRelays, validateProtocolTestBuild } from './protocol-test-build-config.mjs';

const TEST_ENV = {
  VITE_PROTOCOL_TEST_MODE: '1',
  CIPHER_PROTOCOL_TEST_BUILD: '1',
  VITE_TEST_HOOKS: '1',
  CIPHER_UI_TEST_BUILD: '1',
  VITE_PROTOCOL_TEST_RELAYS: 'ws://127.0.0.1:18888 ws://localhost:18889',
};

test('protocol test build needs paired test-only switches and a non-empty allowlist', () => {
  assert.deepEqual(validateProtocolTestBuild({ env: {} }), { enabled: false, relays: [] });
  for (const env of [
    { VITE_PROTOCOL_TEST_MODE: '1' },
    { CIPHER_PROTOCOL_TEST_BUILD: '1' },
    { VITE_PROTOCOL_TEST_RELAYS: TEST_ENV.VITE_PROTOCOL_TEST_RELAYS },
    { ...TEST_ENV, VITE_PROTOCOL_TEST_RELAYS: '' },
    { ...TEST_ENV, VITE_TEST_HOOKS: '0' },
    { ...TEST_ENV, CIPHER_UI_TEST_BUILD: '0' },
  ]) assert.throws(() => validateProtocolTestBuild({ env }), /protocol test mode/);
  assert.throws(() => validateProtocolTestBuild({ env: TEST_ENV, desktopBuild: true }), /cannot be a desktop/);
  assert.deepEqual(validateProtocolTestBuild({ env: TEST_ENV }), {
    enabled: true, relays: ['ws://127.0.0.1:18888', 'ws://localhost:18889'],
  });
});

test('Double Ratchet and MLS remain independently disabled until their review gates pass', () => {
  assert.equal(validateProtocolTestBuild({ env: TEST_ENV }).enabled, true);
  for (const flag of ['VITE_PROTOCOL_TEST_DM', 'VITE_PROTOCOL_TEST_MLS']) {
    assert.throws(() => validateProtocolTestBuild({ env: { ...TEST_ENV, [flag]: '1' } }), /separate review gate/);
    assert.throws(() => validateProtocolTestBuild({ env: { ...TEST_ENV, [flag]: 'true' } }), /must be 0 or 1/);
  }
  assert.doesNotThrow(() => validateProtocolTestBuild({ env: {
    ...TEST_ENV, VITE_PROTOCOL_TEST_DM: '0', VITE_PROTOCOL_TEST_MLS: '0',
  } }));
});

test('protocol test build rejects remote relays, secure endpoints, credentials and path/query escapes', () => {
  for (const relay of ['wss://relay.example:443', 'ws://relay.example:18888', 'ws://127.0.0.1',
    'ws://127.0.0.1:0', 'ws://127.0.0.1:18888/path', 'ws://user@127.0.0.1:18888', 'ws://127.0.0.1:18888/?x=1']) {
    assert.throws(() => parseProtocolTestRelays(relay), /not a loopback/);
  }
});
