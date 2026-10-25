import assert from 'node:assert/strict';
import test from 'node:test';
import { dmTargets, parseRelayList, partitionWriteRelay, relayListTags } from './nip65.js';

test('a relay list marks read and write without sending one conversation everywhere', () => {
  const parsed = parseRelayList({
    tags: [
      ['r', 'wss://a.example'],
      ['r', 'wss://b.example', 'read'],
      ['r', 'wss://c.example', 'write'],
    ],
  });
  assert.deepEqual(parsed.read, ['wss://a.example', 'wss://b.example']);
  assert.deepEqual(parsed.write, ['wss://a.example', 'wss://c.example']);
  assert.deepEqual(relayListTags(parsed.read, parsed.write), [
    ['r', 'wss://a.example'],
    ['r', 'wss://b.example', 'read'],
    ['r', 'wss://c.example', 'write'],
  ]);
  const peer = 'ab'.repeat(32);
  const first = partitionWriteRelay(peer, ['wss://a.example', 'wss://c.example']);
  const second = partitionWriteRelay(peer, ['wss://a.example', 'wss://c.example']);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.deepEqual(dmTargets({ peer, ourWrite: ['wss://a.example', 'wss://c.example'], theirRead: [] }), ['wss://a.example']);
  const split = dmTargets({ peer, ourWrite: ['wss://a.example', 'wss://c.example'], theirRead: ['wss://b.example'] });
  assert.equal(split.includes('wss://b.example'), true);
  assert.equal(split.filter((url) => url !== 'wss://b.example').length, 1);
});
