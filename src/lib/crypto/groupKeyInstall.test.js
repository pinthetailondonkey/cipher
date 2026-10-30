import assert from 'node:assert/strict';
import test from 'node:test';
import { conflictingHeldEpoch, senderAuthorizedForGroupKey, parseGroupKeyBundle, safetyChangeFromInstall } from './groupKeyDistribution.js';

// F1: a kind-4 t:'gkey' DM used to install for ANY sender — key takeover.
// The guard: sender must be named in the relay-signed member snapshot, and
// a non-admin cannot roll the epoch back.

const VICTIM = 'v'.repeat(64);
const ATTACKER = 'a'.repeat(64);
const MEMBER = 'm'.repeat(64);
const ADMIN = 'd'.repeat(64);

const SNAPSHOT = [
  { pubkey: VICTIM, role: 'member' },
  { pubkey: MEMBER, role: 'member' },
  { pubkey: ADMIN, role: 'admin' },
];

test('a sender absent from the snapshot is refused — the takeover path', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: ATTACKER, maxEpoch: 5, currentEpoch: 5 }), false);
});

test('an empty or missing snapshot refuses everyone', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: [], sender: MEMBER, maxEpoch: 5, currentEpoch: 5 }), false);
  assert.equal(senderAuthorizedForGroupKey({ snapshot: null, sender: MEMBER, maxEpoch: 5, currentEpoch: 5 }), false);
});

test('a missing sender is refused', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: null, maxEpoch: 5, currentEpoch: 5 }), false);
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: '', maxEpoch: 5, currentEpoch: 5 }), false);
});

test('a member of record may install a bundle that restates the current epoch', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: MEMBER, maxEpoch: 5, currentEpoch: 5 }), true);
  // Restating the held epoch is fine for a member; moving past it is not (below).
});

// Audit finding: any member of record could install a key at ANY epoch above
// the held one and move the group onto bytes they knew.
test('an ordinary member cannot force a new epoch; only the creator or an admin rotates, one step at a time', () => {
  const CREATOR = 'f'.repeat(64);
  const snap = [...SNAPSHOT, { pubkey: CREATOR, role: 'member' }];
  const base = { snapshot: snap, currentEpoch: 5 };
  // A member forcing epoch 6, or a far-future epoch 99: refused.
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: MEMBER, maxEpoch: 6 }), false);
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: MEMBER, maxEpoch: 99, offeredEpochs: [99] }), false);
  // An admin rotating to exactly current+1: accepted.
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: ADMIN, maxEpoch: 6, offeredEpochs: [6] }), true);
  // The creator (a trusted name, whatever the roster row says) rotates too.
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: CREATOR, maxEpoch: 6, creator: CREATOR, offeredEpochs: [6, 4] }), true);
  // An admin jumping the epoch to a number of their choosing: refused.
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: ADMIN, maxEpoch: 99, offeredEpochs: [99] }), false);
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: ADMIN, maxEpoch: 7, offeredEpochs: [7, 5] }), false);
  // Catching up through a gapless run is fine from an admin.
  assert.equal(senderAuthorizedForGroupKey({ ...base, sender: ADMIN, maxEpoch: 7, offeredEpochs: [7, 6, 5] }), true);
  // The first key a device holds: a member of record, as before.
  assert.equal(senderAuthorizedForGroupKey({ snapshot: snap, sender: MEMBER, maxEpoch: 99, currentEpoch: undefined }), true);
});

test('an epoch already held is never overwritten with different bytes, current or older', () => {
  const held = [{ epoch: 3, hex: 'aa'.repeat(32) }, { epoch: 5, hex: 'bb'.repeat(32) }];
  assert.equal(conflictingHeldEpoch([{ epoch: 5, hex: 'bb'.repeat(32) }, { epoch: 3, hex: 'AA'.repeat(32) }], held), null);
  assert.equal(conflictingHeldEpoch([{ epoch: 5, hex: 'cc'.repeat(32) }], held), 5);
  assert.equal(conflictingHeldEpoch([{ epoch: 3, hex: 'cc'.repeat(32) }, { epoch: 5, hex: 'bb'.repeat(32) }], held), 3);
  assert.equal(conflictingHeldEpoch([{ epoch: 4, hex: 'cc'.repeat(32) }], held), null);
});

test('a member of record may NOT roll the epoch back', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: MEMBER, maxEpoch: 3, currentEpoch: 5 }), false);
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: MEMBER, maxEpoch: 0, currentEpoch: 5 }), false);
});

// H2 fix (round-three re-hack): the old gate gave ANY non-member role a
// free pass — install ANY epoch including a rollback to 0 — and that role
// is one relay-writable roster row. Roles no longer skip the epoch check;
// a genuine rotation is always at or above the current epoch.
test('a roster role is not a license: no role installs a rollback epoch', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: ADMIN, maxEpoch: 3, currentEpoch: 5 }), false);
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: ADMIN, maxEpoch: 0, currentEpoch: 5 }), false);
});

test('case differences in pubkey comparison do not bypass the check', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: SNAPSHOT, sender: ATTACKER.toUpperCase(), maxEpoch: 5, currentEpoch: 5 }), false);
  assert.equal(senderAuthorizedForGroupKey({ snapshot: [{ pubkey: ADMIN.toUpperCase(), role: 'admin' }], sender: ADMIN, maxEpoch: 5, currentEpoch: 5 }), true);
});

test('plain-string snapshot rows are treated as members, not admins', () => {
  assert.equal(senderAuthorizedForGroupKey({ snapshot: [ADMIN], sender: ADMIN, maxEpoch: 3, currentEpoch: 5 }), false);
  // A bare string row has no admin role, so it cannot move the epoch forward.
  assert.equal(senderAuthorizedForGroupKey({ snapshot: [ADMIN], sender: ADMIN, maxEpoch: 6, currentEpoch: 5 }), false);
  assert.equal(senderAuthorizedForGroupKey({ snapshot: [ADMIN], sender: ADMIN, maxEpoch: 5, currentEpoch: 5 }), true);
});

test('a bundle must not mix group ids (partial install of a split bundle refused upstream)', () => {
  const hex = 'ab'.repeat(32);
  const rows = parseGroupKeyBundle({ t: 'gkey', gid: 'g1', keys: [{ ep: 2, k: hex }, { ep: 3, k: hex }] });
  assert.ok(rows.every((row) => row.groupId === 'g1'));
  const mixed = [
    ...parseGroupKeyBundle({ t: 'gkey', gid: 'g1', keys: [{ ep: 2, k: hex }] }),
    ...parseGroupKeyBundle({ t: 'gkey', gid: 'g2', keys: [{ ep: 2, k: hex }] }),
  ];
  assert.equal(new Set(mixed.map((row) => row.groupId)).size > 1, true);
});

// Drill residual: markSafetyChange had zero callers. It fires only from
// installReceivedGroupKey, only after every guard passed, and only when
// this device's key knowledge actually MOVED — the first key or a roll
// forward is the contact changing the key material it may trust; a
// re-delivery, a backfill of a prior epoch, or a rollback (refused
// anyway) moves nothing and flags nothing.
test('the safety flag rides only an install that moved the key forward', () => {
  assert.equal(safetyChangeFromInstall({ currentEpoch: undefined, maxEpoch: 1 }), true, 'the device\'s first key is a change');
  assert.equal(safetyChangeFromInstall({ currentEpoch: undefined, maxEpoch: 0 }), true, 'epoch 0 as a first key still installs');
  assert.equal(safetyChangeFromInstall({ currentEpoch: 5, maxEpoch: 6 }), true, 'a roll forward is the contact changing keys');
  assert.equal(safetyChangeFromInstall({ currentEpoch: 5, maxEpoch: 5 }), false, 're-stating the held epoch flags nothing');
  assert.equal(safetyChangeFromInstall({ currentEpoch: 6, maxEpoch: 5 }), false, 'a refused rollback flags nothing');
  assert.equal(safetyChangeFromInstall({ currentEpoch: 5, maxEpoch: NaN }), false, 'no epoch, no flag');
  assert.equal(safetyChangeFromInstall({ currentEpoch: 5, maxEpoch: '6' }), false, 'a string epoch is no epoch');
});
