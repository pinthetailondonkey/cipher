import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EGRESS, blossomServers, entryById, groupRelayHttp, isOnionUrl, listEgress, readNetworkConfig, urlsFor } from './egress.js';

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

// The no-IP-leak law, half in the row and half here: a clearnet row the founder
// never named does not ship. The rows below were on the wall before the law and
// are frozen by id AND address; anything else clearnet needs gate: 'founder',
// which only lands after the founder names the host. Overriding the address
// behind a grandfathered id counts as a new row and fails the gate.
const GRANDFATHERED_CLEARNET = new Map([
  ['group-relay', 'wss://groups.ciphertele.com'],
  ['dm-relay', 'wss://relay.primal.net'],
  ['profile-nos', 'wss://nos.lol'],
  ['profile-damus', 'wss://relay.damus.io'],
  ['profile-purple', 'wss://purplepag.es'],
  ['search-vertex', 'wss://relay.vertexlab.io'],
  ['search-noswhere', 'wss://relay.noswhere.com'],
  ['blossom-primal', 'https://blossom.primal.net'],
  ['blossom-nostr-build', 'https://nostr.build'],
  ['blossom-band', 'https://blossom.band'],
  ['link-preview', 'https://api.microlink.io'],
]);

// The burn-note row was grandfathered on a placeholder address that never
// resolved, so every link it built was dead on arrival. It now names the app
// host, which serves /note — the page that actually opens a note — and like
// every other clearnet row the founder named, it carries the gate.
test('the burn-note link points at the app host that serves the note page', () => {
  const note = entryById('dead-drop');
  const app = entryById('app-host');
  assert.ok(note && app);
  assert.equal(note.url, app.url);
  assert.equal(note.gate, 'founder');
  assert.equal(new URL(note.url).hostname, 'www.ciphermessenger.org');
});

test('a clearnet row the founder never named does not ship', () => {
  for (const entry of EGRESS) {
    if (entry.called === false) continue;
    const url = String(entry.url || '').trim();
    if (!url || entry.dynamic) continue;
    if (isOnionUrl(url)) continue;
    const grandfathered = GRANDFATHERED_CLEARNET.get(entry.id);
    if (grandfathered) {
      assert.equal(url, grandfathered,
        `row ${entry.id} changed the address the founder reviewed (${grandfathered} -> ${url})`);
      continue;
    }
    assert.equal(entry.gate, 'founder',
      `${entry.id} reaches the clear internet without gate: 'founder'`);
  }
});

test('every outbound host is listed, and nowhere else', () => {
  const hostOf = (url) => {
    if (/^stuns?:/i.test(url)) return url.replace(/^stuns?:/i, '').split(':')[0];
    try { return new URL(url).hostname; } catch { return ''; }
  };
  const hosts = new Set(EGRESS.map((entry) => hostOf(entry.url)).filter(Boolean));
  assert.ok(hosts.has('groups.ciphertele.com'));
  assert.ok(hosts.has('api.microlink.io'));
  assert.ok(!hosts.has('stun.l.google.com'), 'call routing is off — no stun row may return');
  const re = /(?:(?:wss?|https?):\/\/|stuns?:)[a-z0-9.-]+/gi;
  // The test relay wall names this machine, and this machine is not an
  // outbound host — but a loopback address is still a URL, so it is named in
  // exactly one file rather than exempted by pattern. The same loopback
  // address in any other file is still a finding, and a real host here is
  // still a finding, because only a loopback literal is forgiven and only in
  // that file.
  const WALL_FILE = `${path.sep}testRelayOverride.js`;
  const loopbackOnly = (hit) => /^(?:wss?|https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])$/i.test(hit);
  const leaked = [];
  for (const file of walk(path.resolve('src'))) {
    if (file.endsWith(`${path.sep}egress.js`) || file.endsWith('.test.js')) continue;
    const hits = [...new Set(fs.readFileSync(file, 'utf8').match(re) || [])]
      .filter((hit) => !(file.endsWith(WALL_FILE) && loopbackOnly(hit)));
    if (hits.length) leaked.push(`${path.relative(path.resolve('src'), file)}: ${hits.join(', ')}`);
  }
  assert.deepEqual(leaked, []);
  const rows = listEgress({ overrides: {} });
  assert.equal(rows.length, EGRESS.length);
  assert.ok(rows.some((row) => row.transport === 'clearnet'));
  assert.ok(rows.some((row) => row.transport === 'unused'));
  assert.ok(rows.some((row) => row.id === 'nip05' && row.transport === 'depends'));
});

// The founder's own onion door for groups (egress.js) outranks the shipped
// clearnet address, and a device's own paste outranks the door. The address
// is asserted as a literal so a build that loses the door fails here rather
// than quietly serving groups in the clear.
import { FOUNDER_GROUP_ONION, FOUNDER_MEDIA_ONION, FOUNDER_ONION_DOORS } from './egress.js';

const onion = (label, scheme = 'wss') => `${scheme}://${label}.onion`;

// The door is chosen by the build: the desktop build carries the onion, and
// every other build — the web build that becomes production, the iPhone
// build, the browser test build — carries no door, so its own row stands. A
// browser cannot dial an onion: a page served over https may not open ws:// on
// port 80, and the hidden service answers nothing on 443.
test('the address is not in the repo, and no build without the desktop define carries a door', () => {
  // This file runs in node: no desktop define and no build env, which is the
  // web answer — no door, so the shipped clear row stands. The address itself
  // is not asserted here because it is deliberately not in the source.
  assert.equal(FOUNDER_GROUP_ONION, '');
  const source = fs.readFileSync(new URL('./egress.js', import.meta.url), 'utf8');
  assert.equal(/[a-z2-7]{16,56}\.onion/.test(source), false);
});

test('a web build dials the clear group address and never the port that has no listener', () => {
  const active = urlsFor('group', { overrides: {}, lists: {} });
  assert.deepEqual(active, ['wss://groups.ciphertele.com']);
  // 443 is what wss:// means. No :80 suffix, which a page over https may not use.
  assert.equal(active[0].includes(':80'), false);
});

test('defaults work with no config, and an onion replaces only that row', () => {
  const pasted = onion('exampleexampleexample', 'ws');
  assert.equal(isOnionUrl(pasted), true);
  assert.deepEqual(urlsFor('group', { overrides: {}, lists: {} }), ['wss://groups.ciphertele.com']);
  assert.deepEqual(urlsFor('general', { overrides: {}, lists: {} }), ['wss://relay.primal.net']);
  assert.deepEqual(urlsFor('profile', { overrides: {}, lists: {} }).includes('wss://nos.lol'), true);
  // a device's own paste outranks the founder's door
  assert.deepEqual(urlsFor('group-only', { overrides: { 'group-relay': pasted }, lists: {} }), [pasted]);
  assert.equal(groupRelayHttp({ overrides: { 'group-relay': pasted }, lists: {} }).startsWith('http://'), true);
  assert.deepEqual(urlsFor('general', { overrides: { 'group-relay': pasted }, lists: {} }), ['wss://relay.primal.net']);
  assert.deepEqual(urlsFor('group', { torOnly: true, overrides: {}, lists: {} }), ['wss://groups.ciphertele.com']);
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
  assert.equal(listEgress({ overrides: {}, lists: {} }).find((row) => row.id === 'turn'), undefined,
    'the call-relay row is gone — calls are off');
  assert.equal(listEgress({ overrides: {}, lists: {} }).find((row) => row.id === 'explorer').transport, 'unset');
  const kept = listEgress({ overrides: { 'group-relay': pasted }, lists: {} }).find((row) => row.id === 'group-relay');
  assert.equal(kept.transport, 'tor');
  assert.equal(kept.active, pasted);
});

test('the dark doors ship empty, change nothing today, and a lit door outranks the shipped row', () => {
  // Dark: every door ships empty, so every row keeps the address the founder
  // reviewed, and no build contacts a host that is not already on the wall.
  for (const [id, door] of Object.entries(FOUNDER_ONION_DOORS)) {
    assert.equal(door, '', `${id} ships dark until the founder names its door`);
  }
  assert.deepEqual(urlsFor('general', { overrides: {}, lists: {} }), ['wss://relay.primal.net']);
  assert.deepEqual(urlsFor('search', { overrides: {}, lists: {} }), ['wss://relay.primal.net', 'wss://relay.vertexlab.io', 'wss://relay.noswhere.com']);
  assert.deepEqual(blossomServers({ overrides: {}, lists: {} }), ['https://blossom.primal.net', 'https://nostr.build', 'https://blossom.band']);
  // Lit, by the founder's hand in egress.js: the same rank order as the
  // group door — the door outranks the shipped address, a device's own
  // paste outranks the door, and `off` still drops the host entirely. One
  // door serves every row of its kind, so the search pair resolves to one.
  const dmDoor = onion('dmdoordmdoordmdoordm');
  const searchDoor = onion('searchdoorsearchdoor');
  FOUNDER_ONION_DOORS['dm-relay'] = dmDoor;
  FOUNDER_ONION_DOORS['search-vertex'] = searchDoor;
  FOUNDER_ONION_DOORS['search-noswhere'] = searchDoor;
  try {
    assert.deepEqual(urlsFor('general', { overrides: {}, lists: {} }), [dmDoor]);
    assert.deepEqual(urlsFor('search', { overrides: {}, lists: {} }), [dmDoor, searchDoor]);
    assert.deepEqual(urlsFor('general', { overrides: { 'dm-relay': 'off' }, lists: {} }), []);
    assert.deepEqual(urlsFor('general', { overrides: { 'dm-relay': 'wss://inbox.example' }, lists: {} }), ['wss://inbox.example']);
    const row = listEgress({ overrides: {}, lists: {} }).find((r) => r.id === 'dm-relay');
    assert.equal(row.transport, 'tor');
    assert.equal(row.active, dmDoor);
  } finally {
    FOUNDER_ONION_DOORS['dm-relay'] = '';
    FOUNDER_ONION_DOORS['search-vertex'] = '';
    FOUNDER_ONION_DOORS['search-noswhere'] = '';
  }
});

// The media door is the group door's shape: one address from the build, behind
// DESKTOP_BUILD, serving all three media rows at once. Two halves, because a
// door proved only in the lit direction says nothing about the shipped build.
const MEDIA_ROWS = ['blossom-primal', 'blossom-nostr-build', 'blossom-band'];

test('the media door ships dark, so this build resolves the three media rows exactly as before', () => {
  // This file runs with no build env and no desktop define — the web answer,
  // and the state every build is in until the founder's media host exists.
  // The door is empty and the shipped trio stands, unchanged in address,
  // order and count: the inert half of the proof.
  assert.equal(FOUNDER_MEDIA_ONION, '');
  for (const id of MEDIA_ROWS) {
    assert.equal(FOUNDER_ONION_DOORS[id], '', `${id} ships dark until the build carries a media address`);
  }
  assert.deepEqual(blossomServers({ overrides: {}, lists: {} }), [
    'https://blossom.primal.net',
    'https://nostr.build',
    'https://blossom.band',
  ]);
});

test('a lit media door serves all three rows from one address, and the rank order holds', () => {
  // Lit, as a desktop build carrying the address in its untracked env would:
  // the fixture address stands in, because the real one must never be in this
  // file. One door serves every row of its kind, so the trio collapses to one.
  const mediaDoor = onion('mediadoormediadoor', 'http');
  for (const id of MEDIA_ROWS) FOUNDER_ONION_DOORS[id] = mediaDoor;
  try {
    assert.deepEqual(blossomServers({ overrides: {}, lists: {} }), [mediaDoor]);
    // A device's own paste outranks the door.
    assert.deepEqual(
      blossomServers({ overrides: { 'blossom-primal': 'https://media.example' }, lists: {} }),
      ['https://media.example', mediaDoor],
    );
    // `off` still drops the host — every row of the kind, since one door
    // serves them all and a single row left on would keep the host reachable.
    assert.deepEqual(blossomServers({
      overrides: { 'blossom-primal': 'off', 'blossom-nostr-build': 'off', 'blossom-band': 'off' },
      lists: {},
    }), []);
    const row = listEgress({ overrides: {}, lists: {} }).find((r) => r.id === 'blossom-primal');
    assert.equal(row.transport, 'tor');
    assert.equal(row.active, mediaDoor);
  } finally {
    for (const id of MEDIA_ROWS) FOUNDER_ONION_DOORS[id] = '';
  }
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
    assert.deepEqual(urlsFor('group', changed), ['wss://groups.ciphertele.com']);
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
  // Name lookups load as set by the founder: the fetch itself runs, with no
  // refusal row before it (load-all + VPN tip, docs/NO-IP-LEAKS.md).
  assert.equal(/'nip05-off'/.test(search), false);
  const searchCalls = search.match(/\n[^\n]*\n[^\n]*search: (rawQuery|usernameToFind)/g) || [];
  assert.ok(searchCalls.length >= 2);
  for (const call of searchCalls) assert.match(call, /searchRelays|publicSearchRelays/);
  assert.match(search, /const publicSearchRelays = searchRelays;/);
  assert.deepEqual(urlsFor('search'), ['wss://relay.primal.net', 'wss://relay.vertexlab.io', 'wss://relay.noswhere.com']);
});
