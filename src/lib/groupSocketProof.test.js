// SEC-5: multi-group connection correlation.
//
// One WebSocket carries every group this device follows, so a group relay
// learns the whole set of group ids from the REQ frames, correlated to one
// connection and one address. The proof on that socket is the only identity
// fact, and it is signed by ONE owned group's actor pin. These tests pin the
// rule that decides WHICH group proofs (lib/groupSocketProof), drive the real
// seam in the hook from the real tree, and pin the exposure contract itself:
// one socket, one AUTH, the pin on the group host only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import 'fake-indexeddb/auto';

// db.js (reached through the hook's import chain) writes localStorage at
// import time, which node does not have.
const lsStore = new Map();
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: (key) => (lsStore.has(key) ? lsStore.get(key) : null),
    setItem: (key, value) => { lsStore.set(key, String(value)); },
    removeItem: (key) => { lsStore.delete(key); },
  };
}

import { socketProofGroupId } from './groupSocketProof.js';

const HOOK = readFileSync(new URL('../hooks/useNIP29Group.js', import.meta.url), 'utf8');
const POOL = readFileSync(new URL('./pool.js', import.meta.url), 'utf8');
const READER = readFileSync(new URL('./relayDirectoryRead.js', import.meta.url), 'utf8');
const RULE = readFileSync(new URL('./groupSocketProof.js', import.meta.url), 'utf8');

// The lowest id wins: 'aaa' < 'bbb' < 'ccc' in the ids a real group carries.
const G_A = 'aa'.repeat(16);
const G_B = 'bb'.repeat(16);
const G_C = 'cc'.repeat(16);

function subOf(groupId, kinds = [9]) {
  return [{ kinds, '#h': [groupId] }];
}

test('a socket that already proved keeps its pin, whatever it reads later', () => {
  // The relay has already accepted this proof; re-signing would be a second
  // line about the same socket, and a second pseudonym to correlate.
  assert.equal(
    socketProofGroupId({ held: G_C, readable: [G_A, G_B], known: [G_A] }),
    G_C,
    'the held pin stands even when it is not the lowest id and not read now',
  );
});

test('a fresh socket proofs under the lowest group it reads, not the screen', () => {
  // Order in the sub map is subscribe order, which is not id order.
  assert.equal(socketProofGroupId({ readable: [G_B, G_A] }), G_A, 'lowest id, not first seen');
  assert.equal(socketProofGroupId({ readable: [G_C, G_B, G_A] }), G_A, 'three groups, same answer');
});

test('with no subscription yet the held groups decide, deterministically', () => {
  assert.equal(socketProofGroupId({ readable: [], known: [G_B, G_A] }), G_A);
  assert.equal(socketProofGroupId({ known: ['', null, G_C, G_C, G_A] }), G_A, 'junk and repeats drop');
  assert.equal(socketProofGroupId({}), '', 'nothing held, nothing known: the challenge goes unanswered');
  assert.equal(socketProofGroupId({ held: '  ', readable: [] }), '');
});

test('the rule reads no store of its own: the same inputs always give the same pin', () => {
  assert.doesNotMatch(RULE, /chatStore|activeGroup/, 'the rule is pure');
  assert.match(RULE, /export function socketProofGroupId/, 'the rule is the exported door');
});

test('every proofer in the tree takes the pin from the one rule', async () => {
  for (const [name, source] of [['hook', HOOK], ['pool', POOL], ['reader', READER]]) {
    assert.match(source, /from '[^']*groupSocketProof'/, `${name} imports the rule`);
    assert.match(source, /socketProofGroupId\(/, `${name} calls the rule`);
    assert.doesNotMatch(
      source,
      /groups\[groups\.length - 1\]/,
      `${name} must not keep its own "newest group" choice`,
    );
  }
  // The store preference that used to decide the pin is gone from all three:
  // a proof that follows the screen tells the relay when the reader switched.
  for (const [name, source] of [['pool', POOL], ['reader', READER]]) {
    assert.doesNotMatch(source, /activeGroup\?\.id/, `${name} no longer prefers the active group`);
  }
});

test('the hook asks the rule with the socket\'s own subs and the held groups', () => {
  const body = HOOK.match(/export function sessionActorGroupId\(session\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'the chooser is exported and present');
  assert.match(body[0], /held: session\.actorGid \|\| session\.proofGroupId \|\| ''/, 'the proved pin takes precedence, with an explicit first-contact group before one exists');
  assert.match(body[0], /readable: groupIdsOnSession\(session\)/, 'the live subs are the readable set');
  assert.match(body[0], /known: \(useChatStore\.getState\(\)\.groups \|\| \[\]\)/, 'the held groups are the fallback');
});

test('the chooser, driven off the real session shape, picks and holds one pin', async () => {
  const { sessionActorGroupId, groupIdsOnSession } = await import('../hooks/useNIP29Group.js');
  const { useChatStore } = await import('../store/chatStore.js');

  useChatStore.getState().setGroups([{ id: G_C, name: 'C' }, { id: G_A, name: 'A' }]);
  // The screen is on the newest group, which is the one the old code proved
  // under: the sub map is the only thing that may decide now.
  useChatStore.setState({ activeGroup: { id: G_C, name: 'C' } });

  const session = { actorGid: '', subs: new Map([['sub-b', subOf(G_B)], ['sub-a', subOf(G_A)]]) };
  assert.deepEqual(groupIdsOnSession(session).sort(), [G_A, G_B], 'each sub names its group');
  assert.equal(sessionActorGroupId(session), G_A, 'the lowest read group proofs, not the open one');

  // Once a socket proved, switching the screen and dropping a sub changes
  // nothing on the wire.
  session.actorGid = G_A;
  session.subs = new Map([['sub-c', subOf(G_C)]]);
  useChatStore.setState({ activeGroup: { id: G_C, name: 'C' } });
  assert.equal(sessionActorGroupId(session), G_A, 'the proved pin is held for the socket\'s life');

  // A fresh socket with no subs and no store groups leaves the challenge
  // unanswered rather than proving under an invented group.
  useChatStore.getState().setGroups([]);
  useChatStore.setState({ activeGroup: null });
  assert.equal(sessionActorGroupId({ actorGid: '', subs: new Map() }), '');
});

test('one socket carries every group: one per account, one sub per group', () => {
  assert.match(HOOK, /const groupSessions = new Map\(\)/, 'sessions are kept per account');
  assert.match(HOOK, /groupSessions\.get\(identity\.pk\)/, 'and looked up by account key');
  const sockets = [...HOOK.matchAll(/new WebSocket\(/g)];
  assert.equal(sockets.length, 1, `exactly one socket construction, found ${sockets.length}`);
  assert.match(HOOK, /session\.subs\.set\(subId, plan\.filters\)/, 'each group is a sub on that socket');
  // The set is what the relay correlates: a REQ per group, all on session.ws.
  assert.match(HOOK, /session\.ws\.send\(JSON\.stringify\(\['REQ', subId,/, 'the REQ goes on the shared socket');
});

test('one AUTH per socket, signed by the pin and never by the account key', () => {
  // The gate is what makes "one AUTH" true: a second challenge on the same
  // socket is not answered again.
  assert.match(HOOK, /if \(!challenge \|\| !session\.identity\?\.sk \|\| session\.authSent\) return;/, 'authSent gates the AUTH');
  assert.match(HOOK, /session\.authSent = true;/, 'and is set when the proof goes out');
  assert.match(HOOK, /signActProof\(\{[\s\S]*?groupId: gid,[\s\S]*?relayUrl: session\.relayUrl/, 'the proof names the relay and the chosen group');
  assert.match(HOOK, /session\.actorGid = gid;/, 'the pin is recorded as held after it signs');
  // Kind 22242 under an actor key: the relay sees the pin, so the pin choice
  // is the whole disclosure. It must not drift back to a per-message group.
  assert.match(HOOK, /const gid = sessionActorGroupId\(session\);/, 'the AUTH asks the chooser');
});

test('the pin reaches a group host and no public relay', () => {
  assert.match(POOL, /if \(!groupHost \|\| host !== groupHost\) return null;/, 'the pool signs for the group host only');
  assert.match(POOL, /installAutoAuth\(pool, \(host\) => \{/, 'through the shared install');
  assert.match(READER, /isGroupHost\(url\) \? signer : null/, 'the directory reader gates the same way');
});

test('the pool and the reader both keep the pin they first proved under', () => {
  assert.match(POOL, /const heldProofGroup = new WeakMap\(\)/, 'the pool holds a pin per pool');
  assert.match(POOL, /socketProofGroupId\(\{[\s\S]*?held,[\s\S]*?readable: pendingProofGroup\.has\(pool\) \? \[pendingProofGroup\.get\(pool\)\] : \[\],[\s\S]*?known: groups\.map/, 'the existing pin stays held; first contact adds only its requested group before held groups as the fallback');
  assert.match(POOL, /if \(!heldProofGroup\.has\(pool\)\) heldProofGroup\.set\(pool, gid\);/, 'set once, never re-picked');
  assert.match(READER, /held = gid; \/\/ one pseudonym per read/, 'the reader holds its pin for the read');
});
