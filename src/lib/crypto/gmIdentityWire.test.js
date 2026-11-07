import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';

// Step 2 (MEMBERSHIP-DESIGN.md): the wire shape. Every act on a group box is
// signed by the per-group actor key and encrypted under the SAME key's pin —
// the AAD binds event.pubkey, which after Step 2 IS the pin. These tests run
// the real round trip through the real cipher: a sender resolves one signer,
// encodes with that pin folded into the AAD plus its account key inside the
// sealed body; a receiver opens it and reads the account fact from inside.

import { setSessionKey, clearSessionKey } from '../sessionKey.js';
import { setAtRestKeyProvider } from '../messageAtRest.js';
import { openDBFor } from '../../db.js';
import {
  __setGroupKeyStoreForTests, putGroupKey, getCurrentGroupKey,
} from './groupKeyStore.js';
import { generateGroupKey } from './groupCipher.js';
import { encodeGroupPayload, decodeGroupEvent } from './groupMessageCodec.js';
import {
  resolveActorSigner, buildSignedAct, signActProof, GM_ACT_KIND, GM_PROOF_KIND,
} from './gmIdentityWire.js';
import { forgetActors, actSignedByKnownActor } from './gmIdentity.js';

// In-memory stand-in for the Dexie groupKeys table behind the store seam
// (the unique [groupId+epoch] rule the real table enforces).
function fakeKeyTable() {
  const rows = [];
  let nextId = 1;
  const collection = (index, v) => ({
    first: async () => {
      const r = rows.find((x) => (index === 'groupId' ? x.groupId === v : x.groupId === v[0] && x.epoch === v[1]));
      return r ? structuredClone(r) : undefined;
    },
    toArray: async () => rows.filter((x) => (index === 'groupId' ? x.groupId === v : x.groupId === v[0] && x.epoch === v[1])).map((r) => structuredClone(r)),
    modify: async (fn) => { rows.filter((x) => (index === 'groupId' ? x.groupId === v : x.groupId === v[0] && x.epoch === v[1])).forEach((r) => fn(r)); },
  });
  return {
    rows,
    where: (index) => ({ equals: (v) => collection(index, v) }),
    get: async (id) => { const r = rows.find((x) => x.id === id); return r ? structuredClone(r) : undefined; },
    toArray: async () => rows.map((r) => structuredClone(r)),
    put: async (row) => {
      const copy = structuredClone(row);
      const dupe = rows.find((r) => r.groupId === copy.groupId && r.epoch === copy.epoch && r.id !== copy.id);
      if (dupe) throw new Error('ConstraintError');
      const at = copy.id != null ? rows.findIndex((r) => r.id === copy.id) : -1;
      if (at >= 0) rows[at] = copy; else { copy.id = nextId++; rows.push(copy); }
    },
  };
}
function fakeKeyDb(keyTable) {
  return { groupKeys: keyTable, transaction: async (_mode, _table, fn) => fn() };
}

const lsStore = new Map();
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };
}

const SESSION = new Uint8Array(32).fill(9);

test('the full kind-9 round trip: one signer encrypts and signs; the receiver holding only the group key opens it', async () => {
  setSessionKey(SESSION);
  setAtRestKeyProvider(() => SESSION);
  forgetActors();

  const senderSk = generateSecretKey();
  const receiverSk = generateSecretKey();
  const GROUP = 'act-round-trip-group';
  const EPOCH = 3;
  const KEY = generateGroupKey();

  // Sender side.
  openDBFor(getPublicKey(senderSk));
  __setGroupKeyStoreForTests({ db: fakeKeyDb(fakeKeyTable()), owner: () => getPublicKey(senderSk) });
  await putGroupKey(GROUP, EPOCH, KEY);

  // ONE resolved signer drives both the cipher AAD and the signature:
  // resolving twice would risk two derivations racing into an unopenable mix.
  const sender = { sk: senderSk, pk: getPublicKey(senderSk) };
  const signer = await resolveActorSigner({ identity: sender, groupId: GROUP });
  assert.ok(signer);
  assert.ok(/^[0-9a-f]{66}$/.test(signer.pin), 'the signer pin is the compressed authority key');
  assert.equal(signer.wireSender, signer.pin.slice(2), 'the wire sender is the x-only form of the same key');

  const encoded = await encodeGroupPayload({
    groupId: GROUP,
    payload: { type: 'text', message: 'hello box' },
    // The cipher AAD binds what sits on the wire event, which is X-ONLY:
    // a 66-char compressed pin in this field would make every receiver's
    // decrypt refuse. gmIdentityWire names that value wireSender.
    senderPubkey: signer.wireSender,
    by: sender.pk,
  });
  assert.ok(!encoded.pending, 'the sender holds the key so encoding succeeds');

  const event = await buildSignedAct({
    identity: sender,
    groupId: GROUP,
    content: encoded.content,
    tags: [['h', GROUP], ...encoded.tags],
    createdAt: 1000,
    signer: { skBytes: signer.skBytes, pin: signer.pin },
  });
  assert.ok(event);
  assert.equal(event.kind, GM_ACT_KIND);
  // The wire author field is the X-ONLY form of the pinned compressed key.
  assert.equal(event.pubkey, signer.pin.slice(2), 'the wire author field IS the pinned key (x-only)');
  assert.deepEqual(event.tags.find((t) => t[0] === 'author'), ['author', signer.pin]);
  assert.equal(verifyEvent(event), true, 'the actor signature verifies');

  // Receiver side: a DIFFERENT account, holding only the group key (what a
  // grant DM installs) and the invite-link pin. Its session secret differs —
  // decryption must not care.
  clearSessionKey();
  setSessionKey(new Uint8Array(32).fill(12));
  setAtRestKeyProvider(() => new Uint8Array(32).fill(12));
  openDBFor(getPublicKey(receiverSk));
  __setGroupKeyStoreForTests({ db: fakeKeyDb(fakeKeyTable()), owner: () => getPublicKey(receiverSk) });
  assert.equal(await getCurrentGroupKey(GROUP), null, 'a fresh member starts keyless');
  await putGroupKey(GROUP, EPOCH, KEY);

  const decoded = await decodeGroupEvent({ event, groupId: GROUP, requireMember: false });
  assert.ok(!decoded.refused && !decoded.error && !decoded.pending, `decode refused: ${JSON.stringify(decoded)}`);
  assert.deepEqual(decoded.parsed, { type: 'text', message: 'hello box', by: sender.pk },
    'the sealed body carries the account fact INSIDE the ciphertext');
  assert.equal(actSignedByKnownActor(event, [signer.pin]), true,
    'the received act verifies against the pin learned out of band');

  // The AAD really binds the wire pubkey: replaying the same envelope under
  // any other claimed author refuses instead of showing someone else's text.
  const spoofed = { ...event, pubkey: 'ab'.repeat(32) };
  assert.equal((await decodeGroupEvent({ event: spoofed, groupId: GROUP, requireMember: false })).error, 'decrypt-failed');

  // Pre-Step-2 events keep working: no `by`, encoded under the ACCOUNT pubkey.
  const legacyEncoded = await encodeGroupPayload({
    groupId: GROUP,
    payload: { type: 'text', message: 'old style' },
    senderPubkey: sender.pk,
  });
  const legacyEvent = finalizeEvent(
    { kind: 9, created_at: 999, tags: [['h', GROUP], ...legacyEncoded.tags], content: legacyEncoded.content },
    senderSk,
  );
  const legacyDecoded = await decodeGroupEvent({ event: legacyEvent, groupId: GROUP, requireMember: false });
  assert.deepEqual(legacyDecoded.parsed, { type: 'text', message: 'old style' },
    'a body with no by still opens, attributed to the wire pubkey');
  forgetActors();
});

test('the AUTH proof shape: actor-signed kind 22242 with relay + challenge + author', async () => {
  setSessionKey(SESSION);
  forgetActors();
  const sk = generateSecretKey();
  const identity = { sk, pk: getPublicKey(sk) };
  const signed = await signActProof({
    identity, groupId: 'auth-proof-group', relayUrl: 'wss://box', challenge: 'ch-1', createdAt: 555,
  });
  assert.ok(signed);
  assert.equal(signed.event.kind, GM_PROOF_KIND);
  assert.equal(signed.event.created_at, 555);
  assert.deepEqual(signed.event.tags.find((t) => t[0] === 'relay'), ['relay', 'wss://box']);
  assert.deepEqual(signed.event.tags.find((t) => t[0] === 'challenge'), ['challenge', 'ch-1']);
  assert.deepEqual(signed.event.tags.find((t) => t[0] === 'author'), ['author', signed.pin]);
  assert.equal(signed.event.content, '');
  assert.equal(signed.event.pubkey, signed.pin.slice(2));
  assert.equal(verifyEvent(signed.event), true);
  // No signer (locked tab): refuse rather than fall back to the account key.
  clearSessionKey();
  forgetActors();
  assert.equal(await signActProof({ identity, groupId: 'g', challenge: 'x' }), null);
});
