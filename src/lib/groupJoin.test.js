import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PENDING_JOIN, duplicateClaimed, heldGroupRow, joinGroup, joinRefusal, mergeGroupProfile, relayCopyOverRow } from './groupJoin.js';
import { getMyGroups } from './myGroups.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32) };

test('a join publishes kind 9021 before the group is saved on this device', async () => {
  globalThis.localStorage = memoryStorage();
  const steps = [];
  const nip29 = {
    parseGroupReference: (raw) => ({ id: String(raw).trim() }),
    loadGroupProfile: async (_identity, id, name) => { steps.push('profile'); return { id, name: name || 'Room', creator: 'cd'.repeat(32) }; },
    publishGroupJoin: async (_identity, id) => { steps.push(`join:${id}`); assert.equal(getMyGroups(identity.pk).length, 0); },
    fetchMemberRosterOutcome: async () => ({ status: 'found', members: [{ pubkey: identity.pk, role: 'member' }], why: '' }),
  };
  const group = await joinGroup(identity, ' room1 ', { name: 'Room', nip29 });
  assert.deepEqual(steps, ['profile', 'join:room1']);
  assert.deepEqual(getMyGroups(identity.pk).map((item) => item.id), ['room1']);
  assert.equal(group.isChannel, false);
});

test('a join the relay refuses saves nothing', async () => {
  globalThis.localStorage = memoryStorage();
  const nip29 = {
    parseGroupReference: (raw) => ({ id: raw }),
    loadGroupProfile: async (_identity, id) => ({ id, name: 'Room' }),
    publishGroupJoin: async () => { throw new Error('Group relay AUTH timed out'); },
  };
  await assert.rejects(() => joinGroup(identity, 'room2', { nip29 }), /AUTH timed out/);
  assert.deepEqual(getMyGroups(identity.pk), []);
  await assert.rejects(() => joinGroup(identity, '', { nip29: { ...nip29, parseGroupReference: () => ({ id: '' }) } }), /could not be read/);
});

// AUDITOR, EXECUTED 2/2: a member following the same ?g= link was told
// "duplicate: User is already a member" in the relay's own words, no row
// saved, no chat opened. But the relay's claim is not the verdict: the join
// is opened only when an authenticated read of the group confirms the person
// can get in, so a relay that lies cannot force a chat open.
const DUPLICATE = 'duplicate: User is already a member';

// The proof, as the relay answers it: a relay-signed member roster. `mine`
// says whether this account is in it.
const rosterSays = (found, calls = []) => async (_identity, id) => {
  calls.push(id);
  if (!found) return { status: 'unavailable', members: null, why: 'auth-required: not admitted' };
  return { status: 'found', members: found === 'me' ? [{ pubkey: identity.pk, role: 'member' }] : [{ pubkey: 'cd'.repeat(32), role: 'admin' }], why: '' };
};

function joinThatSays(reason, found, calls = []) {
  return {
    parseGroupReference: (raw) => ({ id: raw }),
    loadGroupProfile: async (_identity, id) => ({ id, name: 'AUDL' }),
    publishGroupJoin: async () => { throw new Error(reason); },
    fetchMemberRosterOutcome: rosterSays(found, calls),
  };
}

test('a member the relay already counts is walked in on a read that confirms it', async () => {
  globalThis.localStorage = memoryStorage();
  const calls = [];
  const group = await joinGroup(identity, 'room1', { nip29: joinThatSays(DUPLICATE, 'me', calls) });
  assert.equal(group.id, 'room1');
  assert.equal(group.membership, undefined, 'a confirmed member carries no pending mark');
  assert.deepEqual(getMyGroups(identity.pk).map((item) => item.id), ['room1'], 'the row is held');
  assert.deepEqual(calls, ['room1'], 'the claim is checked, not taken');
});

test('the relay saying "duplicate" is not the verdict: a roster without me is a request, not a room', async () => {
  for (const found of ['someone-else', null]) {
    globalThis.localStorage = memoryStorage();
    const row = await joinGroup(identity, 'room9', { nip29: joinThatSays(DUPLICATE, found) });
    assert.equal(row.membership, 'pending', `a roster that says ${found} must not open the door`);
    assert.deepEqual(getMyGroups(identity.pk).map((item) => [item.id, item.membership]), [['room9', 'pending']],
      'the request is held so a reload does not lose it');
  }
  // A read that throws is the same as a read that did not confirm.
  globalThis.localStorage = memoryStorage();
  const broken = joinThatSays(DUPLICATE, 'me');
  broken.fetchMemberRosterOutcome = async () => { throw new Error('relay gone'); };
  const row = await joinGroup(identity, 'room9', { nip29: broken });
  assert.equal(row.membership, 'pending');
});

test('a real refusal never reaches the membership read, and "not a member" is never a claim', async () => {
  globalThis.localStorage = memoryStorage();
  let read = 0;
  const refusal = (reason) => ({
    parseGroupReference: (raw) => ({ id: raw }),
    loadGroupProfile: async (_identity, id) => ({ id, name: 'Room' }),
    publishGroupJoin: async () => { throw new Error(reason); },
    fetchMemberRosterOutcome: async () => { read += 1; return { status: 'found', members: [{ pubkey: identity.pk }] }; },
  });
  await assert.rejects(() => joinGroup(identity, 'room2', { nip29: refusal('restricted: Access denied to private group') }), /restricted/);
  await assert.rejects(() => joinGroup(identity, 'room2', { nip29: refusal('blocked: user is not a member') }), /blocked/);
  assert.equal(read, 0, 'a refusal is not worth a membership read');
  assert.deepEqual(getMyGroups(identity.pk), [], 'nothing is held for a refusal');
  assert.equal(duplicateClaimed(new Error(DUPLICATE)), true);
  assert.equal(duplicateClaimed(new Error('blocked: user is not a member')), false, 'a negation is not a claim');
  assert.equal(duplicateClaimed(new Error('restricted: Access denied to private group')), false);
  assert.equal(duplicateClaimed(new Error('')), false);
  assert.equal(duplicateClaimed(null), false);
});

// The relay's reason is machine text in lower case. It is a log line, not a
// sentence for the person holding the phone.
test('no relay reason reaches the screen in the relay\'s own words', () => {
  const reasons = [
    DUPLICATE,
    'restricted: Access denied to private group',
    'invalid: event could not be verified',
    'Group relay AUTH timed out',
    'Group relay OK timed out',
    'Group relay socket closed',
    'Group relay requires a signed-in key',
    '',
  ];
  for (const reason of reasons) {
    const text = joinRefusal(new Error(reason));
    assert.ok(text.length > 0, 'always says something');
    assert.match(text, /^[A-Z]/, `a sentence, not a relay string: ${reason}`);
    assert.match(text, /\.$/, `ends like a sentence: ${reason}`);
    assert.equal(text.includes('duplicate'), false, `never repeats the relay: ${reason}`);
    assert.equal(text.includes('restricted'), false, `never repeats the relay: ${reason}`);
    assert.equal(text.toLowerCase().includes('auth'), false, `no protocol word: ${reason}`);
  }
  assert.equal(joinRefusal(new Error('')), 'Could not join that group.');
  assert.equal(joinRefusal(null), 'Could not join that group.');
  // A sentence this code wrote is shown as written, not flattened to the fallback.
  assert.equal(joinRefusal(Object.assign(new Error('That group address could not be read.'), { said: true })), 'That group address could not be read.');
  // The join path prints this sentence and never the error's own words.
  const directory = fs.readFileSync(new URL('../features/chat/useGroupDirectory.js', import.meta.url), 'utf8');
  assert.match(directory, /message: joinRefusal\(err\)/);
  assert.doesNotMatch(directory, /err(or)?\?\.message \|\| 'Could not join that group\.'/);
});

test('invite links, search, and Discover all join the same way, and nobody sends a join request', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const discover = read('../Discover.jsx');
  const directory = read('../features/chat/useGroupDirectory.js');
  const bootstrap = read('../features/chat/useChatBootstrap.js');
  assert.match(discover, /await joinGroup\(identity, group\.id/);
  assert.match(directory, /await joinGroup\(identity, groupId/);
  // A deep link joins only on relay evidence and carries no name: a forged
  // address used to silent-join a phantom row named out of the URL.
  assert.match(bootstrap, /joinGroupById\(joinId\);/);
  assert.match(bootstrap, /No group found at that address/);
  assert.match(bootstrap, /fetchGroupMetadata/);
  assert.doesNotMatch(bootstrap, /get\('name'\)/);
  for (const source of [discover, directory, bootstrap]) {
    assert.equal(source.includes('join_request'), false);
    assert.equal(source.includes('requestToJoinGroup'), false);
  }
});

// The join branch, not only the duplicate one. An `OK true` for a 9021 means
// the relay received a request; it says nothing about whether this account is
// in the group, and the screen may not promise a room the relay has not
// confirmed.
test('a join the relay accepted but has not put this account in is a request, and it is saved', async () => {
  globalThis.localStorage = memoryStorage();
  const accepted = {
    parseGroupReference: (raw) => ({ id: raw }),
    loadGroupProfile: async (_identity, id) => ({ id, name: 'Closed Room' }),
    publishGroupJoin: async () => {},
    fetchMemberRosterOutcome: rosterSays('someone-else'),
  };
  const row = await joinGroup(identity, 'closed1', { nip29: accepted });
  assert.equal(row.membership, 'pending');
  assert.deepEqual(getMyGroups(identity.pk).map((item) => [item.id, item.membership]), [['closed1', 'pending']],
    'the state survives a reload because it is saved, not held in memory');
  // And a later proof that puts this account in the roster clears it: the
  // same call, the same branch, the state is what the relay now says.
  const confirmed = await joinGroup(identity, 'closed1', { nip29: { ...accepted, fetchMemberRosterOutcome: rosterSays('me') } });
  assert.equal(confirmed.membership, undefined);
  assert.equal(getMyGroups(identity.pk)[0].membership, undefined, 'the pending mark is cleared, not stacked');
});

// The state has to survive both rebuilds, or it is decoration: the directory
// rebuild (heldGroupRow) and the chat list's history fetch laying the relay's
// copy of the row over the device's (relayCopyOverRow).
test('a pending join survives a directory rebuild and a history fetch re-saving the row', () => {
  const local = { id: 'g1', name: 'Held', creator: 'ab'.repeat(32), membership: 'pending' };
  const fromRelay = { id: 'g1', name: 'Relay Copy', about: '', creator: 'aa'.repeat(32), isChannel: false };
  assert.equal(heldGroupRow(local, fromRelay).membership, 'pending', 'the directory rebuild keeps it');
  assert.equal(relayCopyOverRow(local, fromRelay).membership, 'pending', 'the history fetch keeps it');
  // And the relay's words still win there, which is the whole point of that merge.
  assert.equal(relayCopyOverRow(local, fromRelay).name, 'Relay Copy');
  assert.equal(relayCopyOverRow(local, fromRelay).creator, 'ab'.repeat(32), 'the creator stays the device\'s');
  // A row with no pending state gains none.
  assert.equal(relayCopyOverRow({ id: 'g2' }, { id: 'g2' }).membership, undefined);
});

// The waiting state, at the screen. A pending row opens the waiting panel and
// not GroupView — mounting GroupView is what starts the message, roster,
// reaction and pin reads the relay refuses.
test('a pending join draws the waiting state, and the waiting state mounts no group read', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const chat = read('../Chat.jsx');
  const waiting = read('../components/chat/GroupWaiting.jsx');
  assert.match(chat, /activeGroup\.membership === 'pending'/, 'Chat.jsx has the branch');
  assert.match(chat, /<GroupWaiting group=\{activeGroup\}/, 'and draws the waiting panel in it');
  assert.equal(PENDING_JOIN, "Request sent. Waiting on the owner's approval.", 'the approved sentence, verbatim');
  assert.match(waiting, /\{PENDING_JOIN\}/, 'and the panel speaks the one sentence, from the one place');
  assert.doesNotMatch(waiting, /^import .*(useNIP29Group|relayDirectoryRead|GroupView|MessageInput)/m,
    'the waiting panel imports no group read and no composer');
  // And the sentence never promises the room.
  for (const promise of ['Joined group', "You're in", 'You are in']) {
    assert.equal(waiting.includes(promise), false, `the waiting state must not say ${promise}`);
  }
});

// Consumer witness: the proof is row 24's primitive, so this drives it from
// row 26's own construction — a roster read through the real reader, with a
// pool that answers the way the relay does — rather than calling the reader
// in its own test shape and calling that coverage.
test('the proof is the roster, driven through the real reader: EOSE alone never opens a chat', async () => {
  const { getPublicKey, generateSecretKey, finalizeEvent } = await import('nostr-tools');
  const { fetchMemberRosterOutcome } = await import('../hooks/useNIP29Group.js');
  const sk = generateSecretKey();
  const me = { sk, pk: getPublicKey(sk) };
  const relaySk = generateSecretKey();
  const relayPk = getPublicKey(relaySk);
  const roster = finalizeEvent({ kind: 39002, created_at: 5, tags: [['d', 'g1'], ['p', me.pk]], content: '' }, relaySk);
  const strangerRoster = finalizeEvent({ kind: 39002, created_at: 5, tags: [['d', 'g1'], ['p', 'cd'.repeat(32)]], content: '' }, relaySk);
  const forged = { ...roster, id: 'f'.repeat(64), pubkey: 'ee'.repeat(32), sig: 'ab'.repeat(64) };
  const answered = (events, status = 'ok') => ({
    READ_OK: 'ok',
    READ_UNAVAILABLE: 'unavailable',
    whyUnavailable: () => 'auth-required: not admitted',
    readDirectory: async () => ({ status, events, answers: [{ status: 'auth', reason: 'auth-required' }] }),
  });
  const outcomeOf = (reader) => fetchMemberRosterOutcome(me, 'g1', { reader, pool: {}, relayPubkey: relayPk });

  assert.equal((await outcomeOf(answered([roster]))).status, 'found', 'a relay-signed roster is a proof');
  assert.deepEqual((await outcomeOf(answered([roster]))).members.map((m) => m.pubkey), [me.pk]);
  assert.equal((await outcomeOf(answered([strangerRoster]))).members.some((m) => m.pubkey === me.pk), false,
    'a roster without me does not put me in it');
  assert.equal((await outcomeOf(answered([forged]))).status, 'unavailable', 'a roster signed by anyone else is not a proof');
  // The false green: a completed read that carried events is still not a
  // member list, and the refusal is named rather than read as "done".
  assert.equal((await outcomeOf(answered([{ ...roster, kind: 9 }]))).status, 'unavailable');
  assert.equal((await outcomeOf(answered([], 'unavailable'))).status, 'unavailable', 'CLOSED auth-required is the fallback, not a way in');
});

// Drill residual: the newest signed metadata event can call a held group
// anything. A directory rebuild or a re-join must not splat that claim
// over a row the device already holds — a legitimate rename arrives
// through the admin-authorized kind-9002 announcement path, which is the
// same standing the row's own writes always needed.
test('a held row keeps the words it holds; a new row takes the incoming ones', () => {
  const held = { id: 'g1', name: 'Thursday', about: 'moved to Fridays', isChannel: false, creator: 'ff'.repeat(32) };
  const incoming = { id: 'g1', name: 'REAL-NAME-ATTACKER', about: 'forged meta', isChannel: true, creator: 'aa'.repeat(32) };
  const merged = heldGroupRow(held, incoming);
  assert.equal(merged.name, 'Thursday', 'the held name survives the refresh');
  assert.equal(merged.about, 'moved to Fridays', 'the held about survives too');
  assert.equal(merged.isChannel, false, 'the held shape survives');
  assert.equal(merged.creator, 'aa'.repeat(32), 'creator keeps the F3 hold at the caller, not here');
  // A row with empty held words adopts the incoming ones rather than
  // blanking a group into a nameless row.
  const halfHeld = heldGroupRow({ id: 'g2', name: '' }, { id: 'g2', name: 'Relay Room', about: '', isChannel: null });
  assert.equal(halfHeld.name, 'Relay Room');
  assert.equal(halfHeld.about, '');
  assert.equal(halfHeld.isChannel, null, 'isChannel falls through when the held row says nothing');
  // No held row: the incoming one passes through untouched.
  assert.deepEqual(heldGroupRow(null, incoming), incoming);
});

// Bug #9 root cause: the profile refresh spread creator: '' over the creator
// the device knew, so the owner's group lost its owner and the Join requests
// panel and Approve button vanished.
test('a profile refresh never erases a known creator, and undefined picture equals empty', () => {
  const OWNER = 'ab'.repeat(32);
  // A new group: no picture field at all, creator known.
  const current = { id: 'g1', name: 'Room', about: '', creator: OWNER };
  const profile = { id: 'g1', name: 'Room', about: '', picture: '', isChannel: false, creator: '' };
  const { changed, next } = mergeGroupProfile(current, profile);
  assert.equal(next.creator, OWNER);
  assert.equal(changed, true, 'isChannel is learned once');
  // The old merge, for the witness: the spread wipes the creator.
  assert.equal({ ...current, ...profile }.creator, '');
  // Once settled, the same refresh changes nothing (undefined !== '' no longer loops).
  assert.equal(mergeGroupProfile(next, profile).changed, false);
});

test('a profile refresh merges only the words the profile has, and a joiner can still learn a creator', () => {
  const OWNER = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);
  const held = { id: 'g1', name: 'Old', about: 'about', picture: 'p.png', creator: OWNER, isChannel: false };
  const renamed = mergeGroupProfile(held, { id: 'g1', name: 'New', about: '', picture: '', creator: '' });
  assert.deepEqual(renamed.next, { ...held, name: 'New' });
  assert.equal(renamed.changed, true);
  // A creator already known is not replaced by a profile's claim.
  assert.equal(mergeGroupProfile(held, { id: 'g1', name: 'Old', creator: OTHER }).next.creator, OWNER);
  // A row with no creator takes one the profile actually carries (an invite author).
  assert.equal(mergeGroupProfile({ id: 'g1', name: 'Old' }, { id: 'g1', name: 'Old', creator: OTHER }).next.creator, OTHER);
  // Nothing in, nothing changed.
  assert.equal(mergeGroupProfile(held, { id: 'g1' }).changed, false);
  assert.deepEqual(mergeGroupProfile(null, null).next, {});
});

test('GroupView refreshes the open group through the merge, not a spread', () => {
  const view = fs.readFileSync(new URL('../components/chat/GroupView.jsx', import.meta.url), 'utf8');
  assert.match(view, /mergeGroupProfile\(current, profile\)/);
  assert.doesNotMatch(view, /\.\.\.current, \.\.\.profile/);
  assert.doesNotMatch(view, /\.\.\.group, \.\.\.profile/);
});

// A deep link asks the relay what it holds for the address. A refusal and an
// empty answer used to arrive as the same `[]`, and the screen named both
// "No group found at that address." — false for a group the reader could not
// see. The lookup now says which of the three things happened.
const fakeReader = ({ metadata, legacy }) => ({
  READ_OK: 'ok',
  whyUnavailable: (answers) => `relay said: ${answers.map((a) => a.reason).join(', ')}`,
  readDirectory: async (_relays, filter) => (filter.kinds[0] === 39000 ? metadata : legacy),
});

const EMPTY = { status: 'ok', events: [], answers: [] };
const REFUSED = { status: 'unavailable', events: [], answers: [{ url: 'wss://groups.example.test', status: 'auth', reason: 'auth-required: not admitted' }] };

test('a relay that refused the lookup is not a group that does not exist', async () => {
  const { fetchGroupMetadataOutcome } = await import('../hooks/useNIP29Group.js');
  const outcome = await fetchGroupMetadataOutcome(identity, 'g1', { reader: fakeReader({ metadata: REFUSED, legacy: REFUSED }), pool: {} });
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.metadata, null);
  assert.match(outcome.why, /auth-required/);
});

test('a completed lookup with nothing in it is a group that does not exist', async () => {
  const { fetchGroupMetadataOutcome } = await import('../hooks/useNIP29Group.js');
  const outcome = await fetchGroupMetadataOutcome(identity, 'g1', { reader: fakeReader({ metadata: EMPTY, legacy: EMPTY }), pool: {} });
  assert.equal(outcome.status, 'absent');
  assert.equal(outcome.metadata, null);
});

test('an event off a proved read is evidence of the group, even when the other lookup was refused', async () => {
  const { fetchGroupMetadataOutcome } = await import('../hooks/useNIP29Group.js');
  const found = { status: 'ok', answers: [], events: [{ id: 'm1', kind: 39000, pubkey: 'ef'.repeat(32), created_at: 5, tags: [['name', 'Room']], content: '' }] };
  const outcome = await fetchGroupMetadataOutcome(identity, 'g1', { reader: fakeReader({ metadata: found, legacy: REFUSED }), pool: {} });
  assert.equal(outcome.status, 'found');
  assert.equal(outcome.metadata.name, 'Room');
});

test('a deep link names a refusal as a refusal and still tries the join', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const bootstrap = read('../features/chat/useChatBootstrap.js');
  assert.match(bootstrap, /fetchGroupMetadataOutcome/);
  assert.match(bootstrap, /read\?\.status === 'absent'/);
  assert.match(bootstrap, /read\?\.status === 'unavailable'/);
  // The join is outside the branch, so a refused lookup still attempts the 9021.
  const branch = bootstrap.slice(bootstrap.indexOf("read?.status === 'unavailable'"));
  assert.match(branch, /joinGroupById\(joinId\);/);
});
