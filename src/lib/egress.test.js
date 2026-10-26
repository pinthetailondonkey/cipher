import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EGRESS, groupRelayHttp, iceServers, isOnionUrl, listEgress, readNetworkConfig, urlsFor } from './egress.js';

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

test('every outbound host is listed, and nowhere else', () => {
  const hostOf = (url) => {
    if (/^stuns?:/i.test(url)) return url.replace(/^stuns?:/i, '').split(':')[0];
    try { return new URL(url).hostname; } catch { return ''; }
  };
  const hosts = new Set(EGRESS.map((entry) => hostOf(entry.url)).filter(Boolean));
  assert.ok(hosts.has('groups.aegispayhq.com'));
  assert.ok(hosts.has('api.microlink.io'));
  assert.ok(hosts.has('stun.l.google.com'));
  const re = /(?:(?:wss?|https?):\/\/|stuns?:)[a-z0-9.-]+/gi;
  const leaked = [];
  for (const file of walk(path.resolve('src'))) {
    if (file.endsWith(`${path.sep}egress.js`) || file.endsWith('.test.js')) continue;
    const hits = fs.readFileSync(file, 'utf8').match(re);
    if (hits) leaked.push(`${path.relative(path.resolve('src'), file)}: ${[...new Set(hits)].join(', ')}`);
  }
  assert.deepEqual(leaked, []);
  const rows = listEgress({ overrides: {} });
  assert.equal(rows.length, EGRESS.length);
  assert.ok(rows.some((row) => row.transport === 'clearnet'));
  assert.ok(rows.some((row) => row.transport === 'unused'));
  assert.ok(rows.some((row) => row.id === 'nip05' && row.transport === 'depends'));
});

test('defaults work with no config, and an onion replaces only that row', () => {
  const onion = 'ws://exampleexampleexampleexampleexampleexampleexampleex.onion';
  assert.equal(isOnionUrl(onion), true);
  assert.deepEqual(urlsFor('group', { overrides: {}, lists: {} }), ['wss://groups.aegispayhq.com']);
  assert.deepEqual(urlsFor('general', { overrides: {}, lists: {} }), ['wss://relay.primal.net']);
  assert.deepEqual(urlsFor('profile', { overrides: {}, lists: {} }).includes('wss://nos.lol'), true);
  assert.ok(iceServers({ overrides: {}, lists: {} }).some((item) => String(item.urls).startsWith('stun:')));
  assert.deepEqual(urlsFor('group-only', { overrides: { 'group-relay': onion }, lists: {} }), [onion]);
  assert.equal(groupRelayHttp({ overrides: { 'group-relay': onion }, lists: {} }).startsWith('http://'), true);
  assert.deepEqual(urlsFor('general', { overrides: { 'group-relay': onion }, lists: {} }), ['wss://relay.primal.net']);
  assert.deepEqual(urlsFor('group', { torOnly: true, overrides: {}, lists: {} }), ['wss://groups.aegispayhq.com']);
  assert.deepEqual(urlsFor('stun', { torOnly: true, overrides: {}, lists: {} }).length > 0, true);
  assert.deepEqual(urlsFor('general', {
    overrides: { 'dm-relay': 'off' },
    lists: { dm: ['wss://inbox.example'] },
  }), ['wss://inbox.example']);
  assert.equal(urlsFor('group', {
    overrides: {},
    lists: { dm: ['wss://inbox.example'] },
  }).includes('wss://inbox.example'), false);
  const removed = listEgress({ overrides: { 'blossom-primal': 'off' }, lists: {} }).find((row) => row.id === 'blossom-primal');
  assert.equal(removed.transport, 'off');
  const turnRow = listEgress({ overrides: {}, lists: {} }).find((row) => row.id === 'turn');
  assert.equal(turnRow.transport, 'clearnet');
  const turnServer = iceServers({ overrides: {}, lists: {} }).find((item) => String(item.urls).startsWith('turn:'));
  assert.equal(turnServer.username, 'openrelayproject');
  assert.equal(String(turnServer.urls).includes('@'), false);
  assert.equal(listEgress({ overrides: {}, lists: {} }).find((row) => row.id === 'explorer').transport, 'unset');
  const kept = listEgress({ overrides: { 'group-relay': onion }, lists: {} }).find((row) => row.id === 'group-relay');
  assert.equal(kept.transport, 'tor');
  assert.equal(kept.active, onion);
});

test('a pasted call relay keeps its login, and pictures are not blocked', () => {
  const relay = 'turns://user:p%40ss@call.example:5349?transport=tcp';
  const withRelay = iceServers({ overrides: { turn: relay }, lists: {} });
  const turn = withRelay.find((item) => String(item.urls).startsWith('turns:'));
  assert.equal(turn.username, 'user');
  assert.equal(turn.credential, 'p@ss');
  assert.equal(String(turn.urls).includes('user'), false);
  assert.equal(String(turn.urls).includes('@'), false);
  assert.ok(withRelay.some((item) => String(item.urls).startsWith('stun:')));
  const onionTurn = 'turns://user:pass@abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrst.onion:5349';
  const torCall = iceServers({ overrides: { turn: onionTurn }, lists: {} });
  const onionServer = torCall.find((item) => String(item.urls).includes('.onion'));
  assert.equal(onionServer.username, 'user');
  assert.ok(torCall.some((item) => String(item.urls).startsWith('stun:')));
});

test('the network snapshot stays the same object until storage changes', () => {
  const first = readNetworkConfig();
  assert.equal(readNetworkConfig(), first);
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    store.set('cipher_network', JSON.stringify({ torOnly: true, onion: 'ws://ignored.onion', overrides: {}, lists: {} }));
    const changed = readNetworkConfig();
    assert.notEqual(changed, first);
    assert.equal(changed.torOnly, undefined);
    assert.equal(changed.onion, undefined);
    assert.deepEqual(urlsFor('group', changed), ['wss://groups.aegispayhq.com']);
    assert.equal(readNetworkConfig(), changed);
  } finally {
    if (previous) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
    readNetworkConfig();
  }
});

test('people search publishes nothing, and its text goes only to the search rows', () => {
  const search = fs.readFileSync(new URL('../features/chat/usePeopleSearch.js', import.meta.url), 'utf8');
  assert.equal(/finalizeEvent|\.publish\(|5315/.test(search), false);
  const searchCalls = search.match(/\n[^\n]*\n[^\n]*search: (rawQuery|usernameToFind)/g) || [];
  assert.ok(searchCalls.length >= 2);
  for (const call of searchCalls) assert.match(call, /searchRelays|publicSearchRelays/);
  assert.match(search, /const publicSearchRelays = searchRelays;/);
  assert.deepEqual(urlsFor('search'), ['wss://relay.primal.net', 'wss://relay.vertexlab.io', 'wss://relay.noswhere.com']);
});
