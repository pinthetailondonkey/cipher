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

test('a stranger\'s relay list cannot aim our publishes at loopback, the LAN, or a plain-text socket', () => {
  const peer = 'cd'.repeat(32);
  const ours = ['wss://relay.primal.net'];
  const hostile = [
    'ws://127.0.0.1:6379', 'wss://127.0.0.1', 'wss://localhost', 'wss://db.localhost', 'ws://192.168.1.1/',
    'wss://10.0.0.5', 'wss://169.254.169.254', 'wss://[::1]', 'wss://2130706433', 'wss://0x7f000001',
    'wss://router', 'wss://localhost.', 'wss://127.0.0.1.', 'wss://printer.local', 'ws://attacker.example', 'wss://user:pw@attacker.example',
    'http://attacker.example', 'not a url', '',
  ];
  const good = 'wss://relay.good.example';
  const targets = dmTargets({ peer, ourWrite: ours, theirRead: [...hostile, good] });
  assert.deepEqual(targets, ['wss://relay.primal.net', good]);
  assert.deepEqual(dmTargets({ peer, ourWrite: ours, theirRead: hostile }), ['wss://relay.primal.net']);
});

test('a stranger\'s relay list is capped, deduped, and never displaces our own relays', () => {
  const peer = 'ef'.repeat(32);
  const ours = ['wss://relay.primal.net', 'wss://groups.example'];
  const many = Array.from({ length: 2000 }, (_, i) => `wss://r${i}.example`);
  const targets = dmTargets({ peer, ourWrite: ours, theirRead: ['WSS://Relay.Primal.net/', 'wss://dup.example', 'wss://dup.example/', ...many] });
  assert.equal(targets.length, 1 + 5);
  assert.equal(targets.filter((url) => ours.includes(url)).length, 1);
  assert.equal(targets.filter((url) => url === 'wss://dup.example').length, 1);
});

test('an onion relay is allowed, and a Tor-only setup refuses a stranger\'s clearnet relay', () => {
  const peer = 'ab'.repeat(32);
  const onion = 'ws://abcdefghijklmnop.onion';
  assert.deepEqual(dmTargets({ peer, ourWrite: ['wss://relay.primal.net'], theirRead: [onion] }), ['wss://relay.primal.net', onion]);
  const torOnly = dmTargets({ peer, ourWrite: ['ws://ourrelay.onion'], theirRead: ['wss://clear.example', onion] });
  assert.deepEqual(torOnly, ['ws://ourrelay.onion', onion]);
});
