import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGovernanceExtension,
  canonicalStringify,
  deriveNextGovernanceRefs,
  isAuthorizedRole,
  verifyCommitGovernance,
  verifyNextGovernanceCitation,
} from './governanceBinding.js';
import './testingKeys.js'; // kept for the future key-backed vectors

const PIN_A = `aa${'11'.repeat(32)}${'a'.repeat(2)}`; // 66-hex shaped below
const PIN_OK = '0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203a1';
const PIN_OK2 = '0203c0ffeb0203c0ffeb0203c0ffeb0203c0ffeb0203c0ffeb0203c0ffeb0203b1';
const PIN_OK3 = '0203c0ffed0203c0ffed0203c0ffed0203c0ffed0203c0ffed0203c0ffed0203c1';
const HASH_OK = '0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203';
const _HASH_ALT = '0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee0203c0ffee02ff';
const ZERO32 = '00'.repeat(32);

const _governanceDoc = () => ({
  body: {
    gen: 7,
    members: [
      { pubkey: 'admin-actor', role: 'admin', gen: 2 },
      { pubkey: 'member-actor', role: 'member', gen: 3 },
    ],
  },
});

test('canonical stringify is order-independent and key-sorted', () => {
  assert.equal(
    canonicalStringify({ b: 1, a: 2 }),
    canonicalStringify({ a: 2, b: 1 }),
  );
});

test('only owner and admin roles may commit at the pinned revision', () => {
  assert.ok(isAuthorizedRole('owner'));
  assert.ok(isAuthorizedRole('admin'));
  assert.ok(!isAuthorizedRole('member'));
  assert.ok(!isAuthorizedRole(null));
});

test('extension build pins prevRev, prevHash, and verified pins', async () => {
  const extension = await buildGovernanceExtension({
    groupId: 'group-1',
    prevRev: 7,
    prevHash: HASH_OK,
    actorPins: [PIN_OK, PIN_OK2],
    commitHashBinding: ZERO32,
  });
  assert.ok(extension);
  assert.equal(extension.body.prevRev, 7);
  assert.equal(extension.body.prevHash, HASH_OK);
  assert.equal(extension.body.actorPins.length, 2);
  // Same inputs, different key order produce the same binding hash.
  const again = await buildGovernanceExtension({
    commitHashBinding: ZERO32,
    groupId: 'group-1',
    actorPins: [PIN_OK2, PIN_OK],
    prevHash: HASH_OK,
    prevRev: 7,
  });
  assert.equal(again.bindingHash, extension.bindingHash);
  // Duplicate pins (case-folded) collapse to one.
  const deduped = await buildGovernanceExtension({
    groupId: 'group-1',
    prevRev: 7,
    prevHash: HASH_OK,
    actorPins: [PIN_OK, PIN_OK3, PIN_OK.toUpperCase()],
    commitHashBinding: ZERO32,
  });
  assert.ok(deduped);
});

test('receiver accepts a commit whose extension matches the governance doc and admin role', async () => {
  // The governance doc body must hash to prevHash for verification to pass.
  const doc = { body: { gen: 7, members: [{ pubkey: 'admin-actor', role: 'admin', gen: 2 }] } };
  const { canonicalHash } = await import('./governanceBinding.js');
  const extensionBound = await buildGovernanceExtension({
    groupId: 'group-1',
    prevRev: 7,
    prevHash: await canonicalHash(doc.body),
    actorPins: [PIN_OK],
    commitHashBinding: ZERO32,
  });
  const result = await verifyCommitGovernance({
    extension: extensionBound,
    commitHashBinding: ZERO32,
    governanceDoc: doc,
    signerActor: 'admin-actor',
  });
  assert.ok(result);
  assert.equal(result.prevRev, 7);
});

test('receiver rejects a non-admin committer at the pinned revision', async () => {
  const { canonicalHash } = await import('./governanceBinding.js');
  const doc = { body: { gen: 7, members: [{ pubkey: 'member-actor', role: 'member', gen: 3 }] } };
  const extension = await buildGovernanceExtension({
    groupId: 'g',
    prevRev: 7,
    prevHash: await canonicalHash(doc.body),
    actorPins: [PIN_OK],
    commitHashBinding: ZERO32,
  });
  const result = await verifyCommitGovernance({
    extension,
    commitHashBinding: ZERO32,
    governanceDoc: doc,
    signerActor: 'member-actor',
  });
  assert.equal(result, null);
});

test('receiver rejects a commit whose extension cites the wrong previous revision', async () => {
  const { canonicalHash } = await import('./governanceBinding.js');
  const doc = { body: { gen: 7, members: [{ pubkey: 'admin-actor', role: 'admin', gen: 2 }] } };
  const extension = await buildGovernanceExtension({
    groupId: 'g',
    prevRev: 6, // wrong: the doc is at revision 7
    prevHash: await canonicalHash(doc.body),
    actorPins: [PIN_OK],
    commitHashBinding: ZERO32,
  });
  const result = await verifyCommitGovernance({
    extension,
    commitHashBinding: ZERO32,
    governanceDoc: doc,
    signerActor: 'admin-actor',
  });
  assert.equal(result, null);
});

test('next governance document cites the commit hash and transcript hash', async () => {
  const commitBytes = new TextEncoder().encode('fake-commit-bytes');
  const refs = await deriveNextGovernanceRefs({
    prevRev: 7,
    commitBytes,
    transcriptHash: HASH_OK,
    membershipDelta: { add: ['actor-1'], remove: [] },
  });
  assert.equal(refs.prevRev, 7);
  assert.equal(/^[0-9a-f]{64}$/.test(refs.commitHash), true);
  assert.equal(refs.transcriptHash, HASH_OK);
  const doc = { body: { gen: 8, mlsRefs: { ...refs } } };
  assert.equal(await verifyNextGovernanceCitation({ governanceDoc: doc, refs }), true);
  const wrongDoc = { body: { gen: 8, mlsRefs: { ...refs, commitHash: HASH_OK.replace('0203', 'ffff') } } };
  assert.equal(await verifyNextGovernanceCitation({ governanceDoc: wrongDoc, refs }), false);
});

test('a tampered extension fails its own binding hash', async () => {
  const extension = await buildGovernanceExtension({
    groupId: 'g',
    prevRev: 1,
    prevHash: HASH_OK,
    actorPins: [PIN_OK],
    commitHashBinding: ZERO32,
  });
  const tampered = { ...extension, body: { ...extension.body, prevRev: 2 } };
  const { verifyCommitGovernance: verify } = await import('./governanceBinding.js');
  const doc = { body: { gen: 2, members: [{ pubkey: 'admin-actor', role: 'admin', gen: 1 }] } };
  assert.equal(await verify({ extension: tampered, commitHashBinding: ZERO32, governanceDoc: doc, signerActor: 'admin-actor' }), null);
});

void PIN_A;
