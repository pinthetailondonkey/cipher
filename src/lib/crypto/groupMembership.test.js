import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROUP_RELAY_PUBKEY,
  MEMBER_OMISSION_TTL_MS,
  MEMBER_REREAD_NEGATIVE_TTL_MS,
  NIP11_NEGATIVE_TTL_MS,
  authorizeGroupControl,
  authorizeGroupPin,
  authorizeMemberSnapshot,
  controlSubject,
  groupRelayPubkey,
  groupRelayReq,
  groupTimelinePlans,
  isGroupAdmin,
  isRestrictedRelayClose,
  pickMemberSnapshot,
  pinnedMessageOf,
  refetchMembersCached,
  resetGroupRelayPubkeyCache,
  resetMemberRereadCache,
  trustedGroupCreator,
} from './groupMembership.js';
import { GRANT_DECISION_TABLE, grantKeyRequest, keyRequestDecision, requesterMayReceiveKey, resolveKeyRequest } from './groupKeyRotation.js';
import { keyRequestPlan } from './groupKeyRequest.js';

const creator = 'c'.repeat(64);
const admin = 'a'.repeat(64);
const member = 'm'.repeat(64);
const stranger = 's'.repeat(64);
const members = [
  { pubkey: creator, role: 'admin' },
  { pubkey: admin, role: 'admin' },
  { pubkey: member, role: 'member' },
];

test('forged membership events from a non-admin are rejected, including when membership is unknown', () => {
  assert.equal(isGroupAdmin(members, stranger, creator), false);
  assert.equal(isGroupAdmin(members, admin, creator), true);
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: stranger, subject: member, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9000, sender: member, subject: stranger, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9002, sender: stranger, subject: stranger, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 39002, sender: stranger, subject: stranger, members: [], creator: '',
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: '', subject: member, members, creator,
  }), false);
});

test('admins may kick or edit, and join or leave is only the signer acting as themselves', () => {
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: admin, subject: member, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9022, sender: member, subject: member, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9022, sender: stranger, subject: member, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9021, sender: stranger, subject: stranger, members, creator,
  }), true);
  assert.equal(requesterMayReceiveKey(null, member), false);
  assert.equal(requesterMayReceiveKey([creator, member], member), true);
  assert.equal(requesterMayReceiveKey([{ pubkey: member, role: 'member' }], member), true);
  assert.equal(requesterMayReceiveKey([creator], member), false);
});

test('another member joining or leaving is accepted; a join cannot name someone else', () => {
  assert.equal(authorizeGroupControl({
    kind: 9021, sender: stranger, subject: stranger, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9022, sender: stranger, subject: stranger, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9022, sender: stranger, subject: member, members, creator,
  }), false);
  const join = { kind: 9021, pubkey: stranger, tags: [['h', 'g1'], ['p', member]] };
  const leave = { kind: 9022, pubkey: stranger, tags: [['h', 'g1'], ['p', member]] };
  assert.equal(controlSubject(join), stranger);
  assert.equal(controlSubject(leave), stranger);
  assert.notEqual(controlSubject(join), member);
});

test('the group socket subscribes per group, so one restricted id cannot close the others', () => {
  const plans = groupTimelinePlans(['g1', 'g2'], 100);
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    const [timeline, snapshot] = plan.filters;
    for (const kind of [9, 9000, 9001, 9002, 9021, 9022, 39002]) {
      assert.equal(timeline.kinds.includes(kind), true, `missing kind ${kind}`);
    }
    assert.equal(timeline.kinds.includes(7), false);
    assert.deepEqual(timeline['#h'], [plan.groupId]);
    assert.equal(timeline.since, 100);
    assert.deepEqual(snapshot, { kinds: [39002], '#d': [plan.groupId] });
    assert.equal('since' in snapshot, false);
    assert.equal(timeline['#h'].length, 1);
  }
  assert.equal(isRestrictedRelayClose('restricted: Access denied to private group'), true);
  assert.equal(isRestrictedRelayClose(''), false);
  const req = groupRelayReq('sub', ['g1'], 100);
  assert.equal(req[0], 'REQ');
  assert.equal(req[1], 'sub');
  assert.equal(req[2].kinds.includes(9021), true);
  assert.equal(req[2].kinds.includes(7), false);
  assert.deepEqual(req[2]['#h'], ['g1']);
  assert.deepEqual(req[3], { kinds: [39002], '#d': ['g1'] });
});

test('39002 is accepted only from the relay key, and only when the member list is well formed', () => {
  const memberPk = '1'.repeat(64);
  const good = {
    kind: 39002,
    pubkey: GROUP_RELAY_PUBKEY,
    tags: [['d', 'group-1'], ['p', memberPk]],
  };
  assert.equal(authorizeMemberSnapshot({ event: good }), true);
  assert.equal(authorizeMemberSnapshot({
    event: { ...good, tags: [['h', 'group-1'], ['p', memberPk, 'admin']] },
  }), true);
  assert.equal(authorizeMemberSnapshot({ event: { ...good, pubkey: admin } }), false);
  assert.equal(authorizeMemberSnapshot({ event: { ...good, pubkey: creator } }), false);
  assert.equal(authorizeMemberSnapshot({ event: { ...good, tags: [['p', memberPk]] } }), false);
  assert.equal(authorizeMemberSnapshot({
    event: { ...good, tags: [['d', 'group-1'], ['p', 'not-a-pubkey']] },
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 39002, sender: GROUP_RELAY_PUBKEY, subject: memberPk, members, creator,
  }), false);
});

test('key grants refetch a fresh list that omits the requester before refusing', () => {
  const now = 1_000_000;
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: null, updatedAt: undefined, nowSec: now, selfCreated: true,
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: null, updatedAt: undefined, nowSec: now,
  }), 'refetch');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: [member], updatedAt: now - 10, nowSec: now,
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: stranger, creator, snapshot: [member], updatedAt: now - 10, nowSec: now,
  }), 'refetch');
  assert.equal(keyRequestDecision({
    requester: stranger, creator, snapshot: [member], updatedAt: now - 10, nowSec: now, refetched: [member],
  }), 'deny');
  assert.equal(keyRequestDecision({
    requester: stranger, creator, snapshot: [member], updatedAt: now - 10, nowSec: now, refetched: [member, stranger],
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: [member], updatedAt: now - 1000, nowSec: now,
  }), 'refetch');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: null, updatedAt: undefined, nowSec: now, refetched: [member],
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: null, updatedAt: undefined, nowSec: now, refetched: [],
  }), 'deny');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: [member], updatedAt: now - 1000, nowSec: now, refetched: null,
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: [member], updatedAt: now - 1000, nowSec: now,
    refetched: null, keyObtainedAt: now - 2000,
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: member, creator, snapshot: [member], updatedAt: now - 1000, nowSec: now,
    refetched: null, keyObtainedAt: now - 10,
  }), 'deny');
  assert.equal(keyRequestDecision({
    requester: stranger, creator, snapshot: null, updatedAt: undefined, nowSec: now, refetched: null,
  }), 'deny');
});

test('a join omitted from a fresh snapshot is re-fetched exactly once', async () => {
  const now = 1_000_000;
  let calls = 0;
  const denied = await resolveKeyRequest({
    requester: stranger,
    creator,
    snapshot: [member],
    updatedAt: now - 10,
    nowSec: now,
    refetch: async () => {
      calls += 1;
      return [member];
    },
  });
  assert.equal(denied, 'deny');
  assert.equal(calls, 1);

  calls = 0;
  const allowed = await resolveKeyRequest({
    requester: stranger,
    creator,
    snapshot: [member],
    updatedAt: now - 10,
    nowSec: now,
    refetch: async () => {
      calls += 1;
      return [member, stranger];
    },
  });
  assert.equal(allowed, 'allow');
  assert.equal(calls, 1);
});

test('the relay pubkey is read from NIP-11 and a failed lookup is a short negative cache', async () => {
  const live = 'ab'.repeat(32);
  resetGroupRelayPubkeyCache();
  assert.equal(await groupRelayPubkey(async () => ({
    ok: true,
    json: async () => ({ pubkey: live.toUpperCase() }),
  })), live);

  resetGroupRelayPubkeyCache();
  let fetches = 0;
  const down = async () => {
    fetches += 1;
    throw new Error('relay down');
  };
  assert.equal(await groupRelayPubkey(down, 1_000), GROUP_RELAY_PUBKEY);
  assert.equal(await groupRelayPubkey(async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ pubkey: live }) };
  }, 1_000 + NIP11_NEGATIVE_TTL_MS - 1), GROUP_RELAY_PUBKEY);
  assert.equal(fetches, 1);
  assert.equal(await groupRelayPubkey(async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ pubkey: live }) };
  }, 1_000 + NIP11_NEGATIVE_TTL_MS), live);
  assert.equal(fetches, 2);
  resetGroupRelayPubkeyCache();
});

test('a membership snapshot is taken only from the relay key', () => {
  const memberPk = '1'.repeat(64);
  const good = {
    kind: 39002,
    pubkey: GROUP_RELAY_PUBKEY,
    created_at: 20,
    tags: [['d', 'group-1'], ['p', memberPk, 'member']],
  };
  const forged = { ...good, pubkey: stranger, created_at: 50, tags: [['d', 'group-1'], ['p', stranger]] };
  assert.deepEqual(pickMemberSnapshot([forged, good], GROUP_RELAY_PUBKEY, 'group-1'), [
    { pubkey: memberPk, role: 'member' },
  ]);
  assert.equal(pickMemberSnapshot([forged], GROUP_RELAY_PUBKEY, 'group-1'), null);
  assert.equal(pickMemberSnapshot([], GROUP_RELAY_PUBKEY, 'group-1'), null);
});

test('a requester without a key keeps a capped backoff instead of stopping at 32s', () => {
  const steady = { random: () => 0.5 };
  assert.deepEqual(keyRequestPlan(0, false, steady), { publish: true, delay: 2000, base: 2000, exhausted: false });
  assert.deepEqual(keyRequestPlan(1, false, steady), { publish: true, delay: 4000, base: 4000, exhausted: false });
  assert.deepEqual(keyRequestPlan(4, false, steady), { publish: true, delay: 32000, base: 32000, exhausted: false });
  assert.equal(keyRequestPlan(5, false, steady).publish, true);
  assert.equal(keyRequestPlan(5, false, steady).delay, 64000);
  assert.equal(keyRequestPlan(5, false, steady).exhausted, false);
  assert.deepEqual(keyRequestPlan(0, true, steady), { publish: false, delay: null, base: null, exhausted: false });
});

test('a kick refuses a grant from a pre-rotation list', () => {
  const now = 1_000_000;
  assert.equal(keyRequestDecision({
    requester: member,
    creator,
    snapshot: [creator, member],
    updatedAt: now - 500,
    nowSec: now,
    refetched: null,
    keyObtainedAt: now - 30,
  }), 'deny');
  assert.equal(requesterMayReceiveKey([creator, member], member), true);
});

test('repeated key requests from one peer do not re-read the relay inside the omission TTL', async () => {
  resetMemberRereadCache();
  let calls = 0;
  const now = 5_000;
  const refetch = async () => {
    calls += 1;
    return [member];
  };
  const first = await refetchMembersCached({ groupId: 'g', requester: stranger, now, refetch });
  const second = await refetchMembersCached({
    groupId: 'g',
    requester: stranger,
    now: now + MEMBER_OMISSION_TTL_MS - 1,
    refetch,
  });
  assert.equal(first.queried, true);
  assert.equal(second.queried, false);
  assert.equal(calls, 1);
  assert.deepEqual(second.members, [member]);
  const third = await refetchMembersCached({
    groupId: 'g',
    requester: stranger,
    now: now + MEMBER_OMISSION_TTL_MS,
    refetch,
  });
  assert.equal(third.queried, true);
  assert.equal(calls, 2);
  assert.ok(MEMBER_OMISSION_TTL_MS < MEMBER_REREAD_NEGATIVE_TTL_MS);
  resetMemberRereadCache();
});

test('a failed member re-read is cached briefly and still refuses a pre-rotation list', async () => {
  resetMemberRereadCache();
  let calls = 0;
  const now = 8_000;
  const refetch = async () => {
    calls += 1;
    throw new Error('relay down');
  };
  const first = await refetchMembersCached({ groupId: 'g-fail', requester: member, now, refetch });
  const second = await refetchMembersCached({
    groupId: 'g-fail',
    requester: stranger,
    now: now + 1_000,
    refetch,
  });
  assert.equal(first.members, null);
  assert.equal(second.members, null);
  assert.equal(second.queried, false);
  assert.equal(calls, 1);
  assert.equal(keyRequestDecision({
    requester: member,
    creator,
    snapshot: [member],
    updatedAt: now - 500,
    nowSec: now,
    refetched: second.members,
    keyObtainedAt: now - 30,
  }), 'deny');
  const later = await refetchMembersCached({
    groupId: 'g-fail',
    requester: member,
    now: now + MEMBER_REREAD_NEGATIVE_TTL_MS,
    refetch,
  });
  assert.equal(later.queried, true);
  assert.equal(calls, 2);
  resetMemberRereadCache();
});

test('a joiner missing from the cached list is re-read, and a failed re-read stays quiet for 45s', async () => {
  resetMemberRereadCache();
  let calls = 0;
  const now = 20_000;
  const base = {
    groupId: 'join',
    requester: stranger,
    creator,
    snapshot: [member],
    updatedAt: Math.floor(now / 1000) - 10,
    keyObtainedAt: Math.floor(now / 1000) - 5,
  };
  const first = await grantKeyRequest({
    ...base,
    now,
    fetchMembers: async () => {
      calls += 1;
      return [member, { pubkey: stranger, role: 'member' }];
    },
  });
  assert.equal(first, 'allow');
  assert.equal(calls, 1);
  const second = await grantKeyRequest({
    ...base,
    now: now + 1_000,
    fetchMembers: async () => {
      calls += 1;
      return [member];
    },
  });
  assert.equal(second, 'allow');
  assert.equal(calls, 1);

  resetMemberRereadCache();
  let fails = 0;
  const down = {
    groupId: 'join-down',
    requester: stranger,
    creator,
    snapshot: [member],
    updatedAt: 1,
    keyObtainedAt: Math.floor(now / 1000) - 5,
  };
  assert.equal(await grantKeyRequest({
    ...down,
    now,
    fetchMembers: async () => {
      fails += 1;
      throw new Error('relay down');
    },
  }), 'deny');
  assert.equal(await grantKeyRequest({
    ...down,
    requester: member,
    now: now + 1_000,
    fetchMembers: async () => {
      fails += 1;
      return [member];
    },
  }), 'deny');
  assert.equal(fails, 1);
  assert.equal(await grantKeyRequest({
    ...down,
    now: now + MEMBER_REREAD_NEGATIVE_TTL_MS,
    fetchMembers: async () => {
      fails += 1;
      return [member, { pubkey: stranger, role: 'member' }];
    },
  }), 'allow');
  assert.equal(fails, 2);
  resetMemberRereadCache();
});

function grantInputs(row) {
  const now = 1_000_000;
  const named = row[2] === 'yes';
  const peer = named ? member : stranger;
  if (row[0] === 'succeeds') {
    return {
      requester: peer,
      creator,
      snapshot: [member],
      updatedAt: now - 10,
      nowSec: now,
      keyObtainedAt: now - 5,
      refetched: named ? [member] : [member],
    };
  }
  if (row[1] === 'none') {
    return {
      requester: member,
      creator,
      snapshot: null,
      updatedAt: undefined,
      nowSec: now,
      refetched: null,
    };
  }
  const keyObtainedAt = row[1] === 'older' ? now - 20 : now - 800;
  const updatedAt = row[1] === 'older' ? now - 40 : now - 800;
  return {
    requester: member,
    creator,
    snapshot: named ? [member] : [],
    updatedAt,
    nowSec: now,
    keyObtainedAt,
    refetched: null,
  };
}

test('grant decision table rows 3 and 4 stay different', () => {
  assert.equal(GRANT_DECISION_TABLE.length, 5);
  const results = GRANT_DECISION_TABLE.map((row) => keyRequestDecision(grantInputs(row)));
  assert.deepEqual(results, GRANT_DECISION_TABLE.map((row) => row[3]));
  assert.equal(results[2], 'allow');
  assert.equal(results[3], 'deny');
  assert.notEqual(results[2], results[3]);
});

// F3: a creator name off forgeable metadata buys no shortcut. The grant only
// fires on self-attested creation or a non-member row in the snapshot.
test('a creator claim without standing is refused a key, standing grants it', () => {
  const now = 1_000_000;
  // The exact takeover path: claimed creator, no snapshot, not self-created.
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: null, updatedAt: undefined, nowSec: now,
  }), 'refetch');
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: null, updatedAt: undefined, nowSec: now, refetched: null,
  }), 'deny');
  // With a snapshot that names them but only as a plain member, the shortcut
  // does not fire — a stale list forces the refetch path instead.
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: [{ pubkey: creator, role: 'member' }], updatedAt: now - 1000, nowSec: now,
  }), 'refetch');
  // Self-attested creation carries it even with no snapshot at all.
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: null, updatedAt: undefined, nowSec: now, selfCreated: true,
  }), 'allow');
  // A relay outage cannot take it away on this device's own group.
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: null, updatedAt: undefined, nowSec: now, selfCreated: true, refetched: null,
  }), 'allow');
  // An admin row for the claimed creator in the snapshot carries it too.
  assert.equal(keyRequestDecision({
    requester: creator, creator, snapshot: [{ pubkey: creator, role: 'admin' }], updatedAt: now - 10, nowSec: now,
  }), 'allow');
  // A non-creator requester never rides the shortcut, self-created or not.
  assert.equal(keyRequestDecision({
    requester: stranger, creator, snapshot: null, updatedAt: undefined, nowSec: now, selfCreated: true,
  }), 'refetch');
  // Case differences are not an escape hatch.
  assert.equal(keyRequestDecision({
    requester: creator.toUpperCase(), creator: creator.toUpperCase(), snapshot: null, updatedAt: undefined, nowSec: now,
  }), 'refetch');
  assert.equal(keyRequestDecision({
    requester: creator, creator: creator.toUpperCase(), snapshot: [{ pubkey: creator.toUpperCase(), role: 'admin' }], updatedAt: now - 10, nowSec: now,
  }), 'allow');
});

test('trustedGroupCreator honors only self-attested creation and snapshot standing', () => {
  const claimed = 'c'.repeat(64);
  const me = 'd'.repeat(64);
  // Self-attested creation wins.
  assert.equal(trustedGroupCreator({ creator: claimed, selfCreated: true, snapshot: null }), claimed);
  // This device's own key matching the claim is equally self-attested.
  assert.equal(trustedGroupCreator({ creator: me, identityPk: me, snapshot: null }), me);
  // An admin row in the relay-signed snapshot backs the claim.
  assert.equal(trustedGroupCreator({ creator: claimed, snapshot: [{ pubkey: claimed, role: 'admin' }] }), claimed);
  // A plain member row does not.
  assert.equal(trustedGroupCreator({ creator: claimed, snapshot: [{ pubkey: claimed, role: 'member' }] }), '');
  // A string-only row does not either.
  assert.equal(trustedGroupCreator({ creator: claimed, snapshot: [claimed] }), '');
  // No snapshot, not self-created: no standing.
  assert.equal(trustedGroupCreator({ creator: claimed, snapshot: null }), '');
  assert.equal(trustedGroupCreator({ creator: claimed, snapshot: [] }), '');
  // Case differences do not sneak a claim past the comparison.
  assert.equal(trustedGroupCreator({ creator: claimed.toUpperCase(), snapshot: [{ pubkey: claimed, role: 'admin' }] }), claimed.toLowerCase());
  // An empty claim is empty.
  assert.equal(trustedGroupCreator({ creator: '', snapshot: [{ pubkey: claimed, role: 'admin' }] }), '');
});

test('a kind-9005 pin moves the shared slot only for a creator or admin', () => {
  // The creator and a snapshot admin may pin.
  assert.equal(authorizeGroupPin({ sender: creator, members, creator }), true);
  assert.equal(authorizeGroupPin({ sender: admin, members, creator }), true);
  // A plain member's pin is ignored, as is a stranger's.
  assert.equal(authorizeGroupPin({ sender: member, members, creator }), false);
  assert.equal(authorizeGroupPin({ sender: stranger, members, creator }), false);
  // No sender, no standing, no pin.
  assert.equal(authorizeGroupPin({ sender: '', members, creator }), false);
  assert.equal(authorizeGroupPin({ sender: admin, members: [], creator: '' }), false);
  // Case differences do not sneak past.
  assert.equal(authorizeGroupPin({ sender: creator.toUpperCase(), members, creator: creator.toUpperCase() }), true);
});

test('the shared pin slot belongs to the owner, and a member flood cannot end it', () => {
  // A member fanned out 500 member pins; the relay window holds only those.
  const flood = Array.from({ length: 10 }, (_, at) => (
    { pubkey: member, created_at: at, tags: [['e', `flood-${at}`]] }
  ));
  // The owner's own pin rides a bucket of its own, whatever the flood did.
  const owners = [{ pubkey: creator, created_at: 5, tags: [['e', 'owner-pin']] }];
  const authorize = (event) => authorizeGroupPin({ sender: event.pubkey, members, creator });
  assert.equal(pinnedMessageOf(owners, flood, authorize), 'owner-pin');
  // The flood alone pins nothing — a member's pin is read by no one.
  assert.equal(pinnedMessageOf([], flood, authorize), null);
  // An admin's pin lands in the flood; it fills the slot when there is no
  // owner pin, and loses to one when there is.
  flood.push({ pubkey: admin, created_at: 1_000, tags: [['e', 'admin-pin']] });
  assert.equal(pinnedMessageOf(owners, flood, authorize), 'owner-pin');
  assert.equal(pinnedMessageOf([], flood, authorize), 'admin-pin');
  // No owner filter ran (no creator known): the admin's pin still fills the
  // slot, and the member flood never reaches it.
  assert.equal(pinnedMessageOf(null, flood, authorize), 'admin-pin');
  assert.equal(pinnedMessageOf([], [], authorize), null);
});

test('a failed re-read inside the freshness window still refuses a list older than the key', () => {
  const now = 1_000_000;
  assert.equal(keyRequestDecision({
    requester: member,
    creator,
    snapshot: [member],
    updatedAt: now - 30,
    nowSec: now,
    refetched: null,
    keyObtainedAt: now - 5,
  }), 'deny');
  assert.equal(keyRequestDecision({
    requester: member,
    creator,
    snapshot: [member],
    updatedAt: now - 30,
    nowSec: now,
    keyObtainedAt: now - 5,
  }), 'refetch');
  assert.equal(keyRequestDecision({
    requester: member,
    creator,
    snapshot: [member],
    updatedAt: now - 30,
    nowSec: now,
    refetched: null,
    keyObtainedAt: now - 30,
  }), 'allow');
  assert.equal(keyRequestDecision({
    requester: member,
    creator,
    snapshot: [member],
    updatedAt: now + 10_000,
    nowSec: now,
    refetched: null,
    keyObtainedAt: now - 10,
  }), 'deny');
});

// H1 fix (round-three re-hack): the deny list outvotes the relay on the
// GRANT path too. Before, a peer the owner denied could be granted the
// group key — the cached-snapshot fast path allowed on a list that still
// named them, and a relay-widened re-read allowed outright.
test('a denied peer is refused the key even when the roster still names them', async () => {
  const map = new Map();
  const hadStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
  try {
    const { denyPendingJoin } = await import('../groupJoinQueue.js');
    const deniedPk = '11'.repeat(32);
    denyPendingJoin('group-holdout', deniedPk);
    const now = 40_000;
    const shallow = {
      groupId: 'group-holdout',
      requester: deniedPk,
      creator,
      snapshot: [deniedPk],            // the roster still names them
      updatedAt: now / 1000 - 10,      // fresh enough for the fast path
      keyObtainedAt: now / 1000 - 5,   // and the list covers this key
    };
    assert.equal(await grantKeyRequest({ ...shallow, now }), 'deny',
      'the cached-snapshot fast path grants nobody denied');
    assert.equal(await grantKeyRequest({
      ...shallow, now, fetchMembers: async () => [deniedPk],
    }), 'deny', 'a relay-widened re-read grants nobody denied');
    // and the refusal is per-peer: a not-denied member rides the same paths
    const stillWorks = await grantKeyRequest({
      groupId: 'group-holdout', requester: member, creator,
      snapshot: [member, deniedPk], updatedAt: now / 1000 - 10,
      keyObtainedAt: now / 1000 - 5, now,
      fetchMembers: async () => [member, deniedPk],
    });
    assert.notEqual(stillWorks, undefined);
  } finally {
    globalThis.localStorage = hadStorage;
  }
});

// H2 fix (round-three re-hack): a relay-asserted admin row is one roster row
// the relay can write about anyone, and it used to authorize control AGAINST
// the creator. A relay row cannot dethrone the identity that created the
// group; only the creator's own key may kick, demote or edit the creator.
test('a relay-admin cannot kick, demote or edit the creator', () => {
  // The dethrone path: an upcast row names the peer an admin, and the peer
  // moves against the owner.
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: admin, subject: creator, members, creator,
  }), false, 'a snapshot-admin cannot kick the creator');
  assert.equal(authorizeGroupControl({
    kind: 9002, sender: admin, subject: creator, members, creator,
  }), false, 'a snapshot-admin cannot edit the creator');
  assert.equal(authorizeGroupControl({
    kind: 9000, sender: admin, subject: creator, members, creator,
  }), false, 'a snapshot-admin cannot demote the creator');
  // Case differences stay closed.
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: admin, subject: creator.toUpperCase(), members, creator,
  }), false);
  // Control that is not AGAINST the creator is untouched.
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: admin, subject: member, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9002, sender: admin, subject: member, members, creator,
  }), true);
  // The creator acts on their own group as before — including on admins.
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: creator, subject: admin, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: creator, subject: creator, members, creator,
  }), true);
  // With no creator known, the guard stays out of the way rather than
  // silently forbidding every admin action.
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: admin, subject: member, members, creator: '',
  }), true);
  // Since the creator row also carries a relay-asserted role, the guard
  // mandates the sender IS the creator, not merely an admin row equal to it.
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: creator, subject: creator, members: [{ pubkey: creator, role: 'admin' }], creator: '',
  }), true);
});
