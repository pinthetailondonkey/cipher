import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DENIED_PER_GROUP_MAX, JOIN_REQUESTS_EVENT, PENDING_PER_GROUP_MAX, PENDING_TOTAL_MAX, admitRelayRoster, clearJoinDenial, joinRequestDecision, denyPendingJoin, dropPendingJoin, forgetJoinsNotOwned, hasPendingJoin, isJoinDenied,
  loadPendingJoins, pendingJoinsFor, queuePendingJoin, subscribeJoinRequests,
  withoutDenied,
} from './groupJoinQueue.js';
import { getActivePubkey } from './storage.js';
import { deniedJoinsFor } from './groupJoinQueue.js';
const deniedRows = () => deniedJoinsFor(GROUP);

// The queue writes through the scoped storage shim, which reads live
// localStorage. A fixed store stands in for it, per account.
function withStorage(run) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  return Promise.resolve(run()).finally(() => { delete globalThis.localStorage; });
}

const PK = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const GROUP = 'join-group';

test('a first-time 9021 sender queues once, and a repeat does not stack rows', () => {
  withStorage(() => {
    assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev1', at: 100 }), true);
    assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev2', at: 200 }), false);
    assert.deepEqual(pendingJoinsFor(GROUP), [{ pubkey: PK, eventId: 'ev1', at: 100 }]);
    assert.deepEqual(loadPendingJoins()[OTHER] ?? [], []);
  });
});

test('a join request is written to storage, and a stored one reads back after a reopen', () => {
  withStorage(() => {
    queuePendingJoin(GROUP, { pubkey: OTHER, eventId: 'ev9', at: 42 });
    // The write went to storage, not to a hook's state.
    const raw = globalThis.localStorage.getItem(`cipher_${getActivePubkey().slice(0, 8)}_join_pending`);
    assert.match(raw, /"pubkey":"b+"/);
    // A reopen reads back the stored rows through the same shim.
    globalThis.localStorage.setItem(`cipher_${getActivePubkey().slice(0, 8)}_join_pending`, raw);
    assert.deepEqual(loadPendingJoins()[GROUP], [{ pubkey: OTHER, eventId: 'ev9', at: 42 }]);
  });
});

test('a denied sender stays denied: the 9021 replay cannot re-queue them', () => {
  withStorage(() => {
    queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev3', at: 10 });
    assert.equal(denyPendingJoin(GROUP, PK), true);
    assert.equal(isJoinDenied(GROUP, PK), true);
    assert.deepEqual(pendingJoinsFor(GROUP), []);
    // A deny was recorded in per-account storage before the row went.
    const raw = globalThis.localStorage.getItem(`cipher_${getActivePubkey().slice(0, 8)}_join_denied`);
    assert.match(raw, /"a+"/);
    // The replayed 9021 runs through the same queue call from fresh state.
    assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev3', at: 20 }), false);
    assert.equal(loadPendingJoins()[GROUP], undefined);
  });
});

test('nothing is queued without a pubkey worth reading, and drop removes exactly one row', () => {
  withStorage(() => {
    assert.equal(queuePendingJoin(GROUP, { pubkey: 'not-a-key' }), false);
    assert.equal(queuePendingJoin('', { pubkey: PK }), false);
    assert.deepEqual(pendingJoinsFor(GROUP), []);
    queuePendingJoin(GROUP, { pubkey: PK });
    queuePendingJoin(GROUP, { pubkey: OTHER });
    assert.equal(dropPendingJoin(GROUP, PK), true);
    assert.equal(dropPendingJoin(GROUP, PK), false);
    assert.deepEqual(pendingJoinsFor(GROUP).map((row) => row.pubkey), [OTHER]);
    dropPendingJoin(GROUP, OTHER);
    assert.deepEqual(pendingJoinsFor(GROUP), []);
    assert.equal(loadPendingJoins()[GROUP], undefined);
  });
});

test('the queue tells the screen it changed', () => {
  withStorage(() => {
    const seen = [];
    const stop = subscribeJoinRequests(() => seen.push(JOIN_REQUESTS_EVENT));
    try {
      if (typeof window !== 'undefined') {
        queuePendingJoin(GROUP, { pubkey: PK });
        dropPendingJoin(GROUP, PK);
        assert.deepEqual(seen, [JOIN_REQUESTS_EVENT, JOIN_REQUESTS_EVENT]);
      }
    } finally {
      stop();
    }
  });
});

test('a deny strips the sender from a relay roster: an open-join relay cannot bring them back', () => {
  withStorage(() => {
    assert.equal(denyPendingJoin(GROUP, PK), true);
    const roster = [{ pubkey: PK, role: 'member' }, { pubkey: OTHER, role: 'admin' }, OTHER];
    assert.deepEqual(withoutDenied(GROUP, roster), [{ pubkey: OTHER, role: 'admin' }, OTHER]);
    // A group with nothing denied hands the rows back untouched.
    const OTHER_GROUP = 'open-group';
    assert.deepEqual(withoutDenied(OTHER_GROUP, roster), roster);
    // No groupId or no rows at all: nothing to strip.
    assert.deepEqual(withoutDenied('', roster), roster);
    assert.deepEqual(withoutDenied(GROUP, null), []);
  });
});

test('a pending row outvotes the relay roster on the grant path (drills D1-B/D1-D)', () => {
  withStorage(() => {
    queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev1', at: 10 });
    // A relay can name the queued sender; the pending row says nobody has
    // approved them yet, so the grant path must refuse outright.
    assert.equal(hasPendingJoin(GROUP, PK), true);
    // A peer who was never queued decides from the roster as before.
    assert.equal(hasPendingJoin(GROUP, OTHER), false);
    // The owner's approval drops the row; a roster naming them then stands.
    dropPendingJoin(GROUP, PK);
    assert.equal(hasPendingJoin(GROUP, PK), false);
    // Case-blind: the attacker's own casing buys nothing.
    queuePendingJoin(GROUP, { pubkey: PK, at: 10 });
    assert.equal(hasPendingJoin(GROUP, PK.toUpperCase()), true);
    assert.equal(hasPendingJoin('', PK), false);
  });
});

test('the owner clears the denial and the sender becomes grantable again (drills D1-E)', () => {
  withStorage(() => {
    denyPendingJoin(GROUP, PK);
    assert.equal(isJoinDenied(GROUP, PK), true);
    // Owner-initiated re-add clears the record — the relay's word never does.
    assert.equal(clearJoinDenial(GROUP, PK), true);
    assert.equal(isJoinDenied(GROUP, PK), false);
    // Clearing an absent denial is a no-op, not an error.
    assert.equal(clearJoinDenial(GROUP, PK), false);
    assert.equal(clearJoinDenial('', PK), false);
    // Deny survives through the same call shape as before, and re-add still works.
    denyPendingJoin(GROUP, OTHER);
    clearJoinDenial(GROUP, OTHER);
    assert.equal(isJoinDenied(GROUP, OTHER), false);
  });
});

// Audit finding: a relay 39002 naming a stranger landed on the owner's
// roster, and the stranger's own 9021 then read "already a member" and never
// reached the approval queue.
const OWNER = 'o'.repeat(64);
const MEMBER = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);
const decide = (over) => joinRequestDecision({ allowsJoins: true, ...over });

test('on the owner device a relay roster naming a stranger queues them instead of admitting them', () => {
  withStorage(() => {
    const previous = [{ pubkey: OWNER, role: 'admin' }, { pubkey: MEMBER, role: 'member' }];
    const incoming = [...previous, { pubkey: STRANGER, role: 'member' }];
    const { members, unapproved } = admitRelayRoster({ previous, incoming, isOwner: true, selfPk: OWNER });
    assert.deepEqual(members, previous);
    assert.deepEqual(unapproved, [STRANGER]);
    // The unapproved name goes to the queue the owner reads.
    assert.equal(queuePendingJoin(GROUP, { pubkey: STRANGER, eventId: 'snap1', at: 5 }), true);
    // The stranger's later 9021 now stops at the queue: it is NOT a known member.
    const inSnapshot = members.some((row) => row.pubkey === STRANGER);
    assert.equal(inSnapshot, false);
    assert.equal(decide({ pending: hasPendingJoin(GROUP, STRANGER), inSnapshot }), 'ignore');
    // Even a roster that did name them would not approve them over the queue row.
    assert.equal(decide({ pending: hasPendingJoin(GROUP, STRANGER), inSnapshot: true }), 'ignore');
    assert.equal(decide({ denied: true, inSnapshot: true }), 'ignore');
  });
});

test('owner-approved members, a restored device and non-owner devices are not disturbed', () => {
  const previous = [{ pubkey: OWNER, role: 'admin' }, { pubkey: MEMBER, role: 'member' }];
  // The owner approved STRANGER (addMember wrote them to the stored roster): the relay's list passes whole.
  const approved = [...previous, { pubkey: STRANGER, role: 'member' }];
  const afterApproval = admitRelayRoster({ previous: approved, incoming: approved, isOwner: true, selfPk: OWNER });
  assert.deepEqual(afterApproval, { members: approved, unapproved: [] });
  // The relay may drop a name; that is not an admission.
  assert.deepEqual(admitRelayRoster({ previous: approved, incoming: previous, isOwner: true, selfPk: OWNER }),
    { members: previous, unapproved: [] });
  // A device with no stored roster (fresh device, even the owner's) takes the relay's roster as its baseline.
  assert.deepEqual(admitRelayRoster({ previous: null, incoming: approved, isOwner: true, selfPk: OWNER }),
    { members: approved, unapproved: [] });
  // A member's device cannot approve anyone: the relay roster is its evidence, unchanged.
  assert.deepEqual(admitRelayRoster({ previous, incoming: approved, isOwner: false, selfPk: MEMBER }),
    { members: approved, unapproved: [] });
  // The owner's own row is never a request, even when the stored roster lost it.
  assert.deepEqual(admitRelayRoster({ previous: [{ pubkey: MEMBER }], incoming: previous, isOwner: true, selfPk: OWNER }).unapproved, []);
});

test('the 9021 decision keeps its order: self, denied or queued, joins off, then roster presence', () => {
  assert.equal(decide({ isSelf: true }), 'self');
  assert.equal(decide({ denied: true }), 'ignore');
  assert.equal(decide({ pending: true, inSnapshot: true }), 'ignore');
  assert.equal(decide({ allowsJoins: false, inSnapshot: false }), 'deny');
  assert.equal(decide({ inSnapshot: true }), 'known');
  assert.equal(decide({ isOwner: true, inSnapshot: false }), 'queue');
});

test('a join request is queued on the owner device only', () => {
  // Only the owner can approve or deny, so only the owner holds the queue.
  // A member device that wrote the row could never act on it, and the row
  // is not inert: the key grant path reads it (grantKeyRequest) and would
  // deny the sender a key on that device even after the owner approves
  // them. Membership reaches a member device with the relay's roster.
  assert.equal(decide({ isOwner: true, inSnapshot: false }), 'queue');
  assert.equal(decide({ isOwner: false, inSnapshot: false }), 'pass');
  // A device that does not say it is the owner is not the owner.
  assert.equal(decide({ inSnapshot: false }), 'pass');
  // Owner or not, a member of record re-stating a join is known.
  assert.equal(decide({ isOwner: false, inSnapshot: true }), 'known');
});

// Rows the old rule wrote on devices that cannot approve anyone. The sweep
// clears them once per load; the owner's own queue is never touched.
const ME = 'e'.repeat(64);
const MY_GROUP = 'mine';
const JOINED_GROUP = 'theirs';

test('the one-time sweep clears a member device\'s rows and keeps the owner\'s own queue', () => withStorage(() => {
  queuePendingJoin(MY_GROUP, { pubkey: OTHER, eventId: 'own1', at: 100 });
  queuePendingJoin(JOINED_GROUP, { pubkey: OTHER, eventId: 'their1', at: 100 });
  queuePendingJoin('left-behind', { pubkey: OTHER, eventId: 'gone1', at: 100 });
  const groups = [
    { id: MY_GROUP, creator: ME },
    { id: JOINED_GROUP, creator: OTHER },
    { id: 'creatorless', creator: '' },
  ];
  queuePendingJoin('creatorless', { pubkey: OTHER, eventId: 'hmm1', at: 100 });
  const cleared = forgetJoinsNotOwned({ groups, me: ME });
  assert.equal(pendingJoinsFor(MY_GROUP).length, 1, 'the owner\'s own queue stays');
  assert.equal(pendingJoinsFor(JOINED_GROUP).length, 0, 'a group this account did not create is cleared');
  assert.equal(pendingJoinsFor('left-behind').length, 0, 'a group this account no longer holds is cleared');
  assert.equal(pendingJoinsFor('creatorless').length, 1, 'a group that names no creator is kept, not guessed away');
  assert.equal(cleared, 2);
  // A second pass finds nothing and writes nothing.
  assert.equal(forgetJoinsNotOwned({ groups, me: ME }), 0);
}));

// Audit finding: the pending and deny stores grew without limit, and a full
// drawer was swallowed silently.
const pk = (n) => n.toString(16).padStart(64, '0');

test('the pending queue is capped per group and the oldest row goes first', () => {
  withStorage(() => {
    for (let n = 1; n <= PENDING_PER_GROUP_MAX + 25; n += 1) {
      assert.equal(queuePendingJoin(GROUP, { pubkey: pk(n), eventId: `e${n}`, at: n }), true);
    }
    const rows = pendingJoinsFor(GROUP);
    assert.equal(rows.length, PENDING_PER_GROUP_MAX);
    assert.equal(rows[0].pubkey, pk(26), 'the 25 oldest were dropped');
    assert.equal(rows.at(-1).pubkey, pk(PENDING_PER_GROUP_MAX + 25), 'the newest request is kept');
  });
});

test('the pending queue is capped across groups too', () => {
  withStorage(() => {
    const groups = 6;
    for (let g = 0; g < groups; g += 1) {
      for (let n = 1; n <= PENDING_PER_GROUP_MAX; n += 1) {
        queuePendingJoin(`g${g}`, { pubkey: pk(g * 1000 + n), eventId: 'e', at: g * 1000 + n });
      }
    }
    const total = Object.values(loadPendingJoins()).reduce((sum, rows) => sum + rows.length, 0);
    assert.equal(total, PENDING_TOTAL_MAX);
    assert.equal(pendingJoinsFor('g0').length, 0, 'the oldest group lost its rows first');
  });
});

test('the deny list is capped per group, oldest first, and a fresh deny still lands', () => {
  withStorage(() => {
    const now = Date.now;
    let t = 1_700_000_000_000;
    Date.now = () => { t += 1000; return t; };
    try {
      for (let n = 1; n <= DENIED_PER_GROUP_MAX + 5; n += 1) denyPendingJoin(GROUP, pk(n));
    } finally { Date.now = now; }
    assert.equal(Object.keys(deniedRows()).length, DENIED_PER_GROUP_MAX);
    assert.equal(isJoinDenied(GROUP, pk(1)), false, 'the oldest deny aged out');
    assert.equal(isJoinDenied(GROUP, pk(DENIED_PER_GROUP_MAX + 5)), true, 'the newest deny is held');
  });
});

test('a write the drawer refuses is reported, not swallowed', () => {
  withStorage(() => {
    const real = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    const errors = [];
    const log = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'q1', at: 1 }), false, 'a request that did not save is not reported as queued');
      assert.equal(denyPendingJoin(GROUP, OTHER), false);
    } finally {
      console.error = log;
      globalThis.localStorage.setItem = real;
    }
    assert.equal(errors.length >= 2, true);
    assert.match(errors[0], /could not be saved/);
    assert.deepEqual(pendingJoinsFor(GROUP), [], 'nothing pretends to be stored');
  });
});
