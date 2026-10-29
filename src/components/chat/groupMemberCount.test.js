import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { memberCountOf, useChatStore } from '../../store/chatStore.js';

// The rule this file exists for: a member count may only be shown for a group
// whose member list this device actually read from the relay's signed roster.
// Unknown is not zero, and it is certainly not one — the header used to print
// "1 member" whenever the list had not loaded, a number nothing had measured.

const disk = new Map();
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => disk.set(key, String(value)),
  removeItem: (key) => disk.delete(key),
  clear: () => disk.clear(),
};

const TEN = Array.from({ length: 10 }, (_, i) => ({ pubkey: `${i}`.repeat(8), role: 'member' }));

// ---- Direction one: a list that was read produces its count --------------
test('a roster this device read produces its measured count', () => {
  const state = { groupMembers: TEN, groupMembersKnown: { g1: true } };
  assert.equal(memberCountOf(state, 'g1'), 10);
});

test('a one-member group says one member, and a two-member group says two', () => {
  assert.equal(memberCountOf({ groupMembers: [TEN[0]], groupMembersKnown: { g1: true } }, 'g1'), 1);
  assert.equal(memberCountOf({ groupMembers: TEN.slice(0, 2), groupMembersKnown: { g1: true } }, 'g1'), 2);
});

// ---- Direction two: no roster read produces NO count, never zero ---------
test('an unread group has no count at all — not zero, and not one', () => {
  // The state that used to render "1 member": members not yet loaded.
  assert.equal(memberCountOf({ groupMembers: [], groupMembersKnown: {} }, 'g1'), null);
  // A previous group's list must not answer for this one.
  assert.equal(memberCountOf({ groupMembers: TEN, groupMembersKnown: { g2: true } }, 'g1'), null);
  // No group open at all.
  assert.equal(memberCountOf({ groupMembers: TEN, groupMembersKnown: { g1: true } }, null), null);
  assert.equal(memberCountOf({}, 'g1'), null);
  assert.equal(memberCountOf(null, 'g1'), null);
});

// A read that failed leaves no marker behind, which is what makes the two
// directions distinct: the engine marks only on success.
test('a failed read leaves the group unknown, and the count stays absent', () => {
  useChatStore.getState().reload();
  assert.equal(memberCountOf(useChatStore.getState(), 'g1'), null);
  // What a successful read does, and the only thing that changes the answer.
  useChatStore.getState().setGroupMembersKnown('g1');
  useChatStore.setState({ groupMembers: TEN });
  assert.equal(memberCountOf(useChatStore.getState(), 'g1'), 10);
  // A reload is a fresh app: the roster did not survive it, so neither does
  // the count, rather than showing a number from before the reload.
  useChatStore.getState().reload();
  assert.equal(memberCountOf(useChatStore.getState(), 'g1'), null);
});

test('a roster read marks only the group it was read for', () => {
  useChatStore.getState().reload();
  useChatStore.getState().setGroupMembersKnown('g1');
  assert.equal(useChatStore.getState().groupMembersKnown.g1, true);
  assert.equal(useChatStore.getState().groupMembersKnown.g2, undefined,
    'a second group is still unknown, so it shows no count');
  useChatStore.getState().setGroupMembersKnown('');
  useChatStore.getState().setGroupMembersKnown(null);
  assert.deepEqual(useChatStore.getState().groupMembersKnown, { g1: true }, 'an empty id marks nothing');
  const first = useChatStore.getState().groupMembersKnown;
  useChatStore.getState().setGroupMembersKnown('g1');
  assert.equal(useChatStore.getState().groupMembersKnown, first, 'no new object on a repeat frame');
});

// The screen, at the shape that carries the rule: the chip is behind the
// count, the count is the measured one, and no fallback number stands in.
test('the header renders no chip for an unread roster', () => {
  const sidebar = fs.readFileSync(new URL('./GroupInfoSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /memberCountOf\(state, group\?\.id\)/, 'the count comes from the one rule');
  assert.match(sidebar, /\{memberCount !== null && \(/, 'the chip is gated on a measured count');
  assert.doesNotMatch(sidebar, /memberList\.length \|\| 1/, 'the invented "1 member" is gone');
  assert.match(sidebar, /\{memberCount\} \{memberCount === 1 \? 'member' : 'members'\}/,
    'the number shown is the measured one, nothing else');
  assert.match(sidebar, /\{!rosterKnown && memberList\.length === 0 &&/,
    'the waiting line is only for the unknown case');
});
