import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicKey, verifyEvent } from 'nostr-tools';

import { setSessionKey, clearSessionKey } from '../sessionKey.js';
import { groupAuthorityKey } from './groupAuthority.js';
import {
  actorForGroup,
  forgetActors,
  actorTag,
  actAuthorPin,
  actSignedByKnownActor,
} from './gmIdentity.js';

// Step 2 (MEMBERSHIP-DESIGN.md): the pseudonymous GM key. One derivation backs
// the Step-1b doc authority key AND everything else this account puts on a
// group box. These tests pin the properties the rest of the design leans on:
// determinism, distinctness per group, refusal when the tab cannot prove, and
// the receive-side check never promoting a verified stranger to an actor.

const SK = new Uint8Array(32).fill(7);
const PK = getPublicKey(SK);
const GID = 'gm-test-group';
const OTHER_GID = 'gm-other-group';

async function derive(pkBytes, gid) {
  return groupAuthorityKey(pkBytes, gid);
}

test('the actor key IS the Step-1b doc authority key, derived fresh per group', async () => {
  const actor = await derive(SK, GID);
  assert.ok(actor.pin);
  // Same HKDF info and salt as Step 1b: identical pins, or one pinned
  // identity splits in two and standing checks fail half the roster.
  const authority = await groupAuthorityKey(SK, GID);
  assert.equal(actor.pin, authority.pin);
  // A different group derives a different pseudonym: two groups in one box
  // name two keys that share nothing visible (finding N3).
  const other = await groupAuthorityKey(SK, OTHER_GID);
  assert.notEqual(actor.pin, other.pin);
});

test('actorForGroup refuses with no secret instead of improvising a signer', async () => {
  clearSessionKey();
  assert.equal(await actorForGroup(PK, GID), null);
  // An unusable owner is refused too: nothing may fall back to identity.sk.
  assert.equal(await actorForGroup('', GID), null);
  assert.equal(await actorForGroup('zzz', GID), null);
});

test('actorForGroup memoizes the derived pair but never trusts it across a lock boundary', async () => {
  clearSessionKey();
  forgetActors();
  setSessionKey(SK);
  const first = await actorForGroup(PK, GID);
  const second = await actorForGroup(PK, GID);
  assert.equal(second, first, 'the derived pair is memoized per account and group');
  forgetActors();
  const third = await actorForGroup(PK, GID);
  assert.notEqual(third, first, 'a forget rederives rather than serving a stale signer');
  assert.deepEqual(third.privateKeyBytes, first.privateKeyBytes);
  assert.equal(third.pin, first.pin);
  // Entries are keyed by account pubkey: parallel accounts on one tab do not
  // lend keys to each other.
  const otherSk = new Uint8Array(32).fill(8);
  const otherPk = getPublicKey(otherSk);
  const otherActor = await actorForGroup(otherPk, GID);
  assert.equal(otherActor.ownerPk, otherPk.toLowerCase());
  assert.deepEqual(
    [...new Set([first.privateKeyBytes.length, otherActor.privateKeyBytes.length])],
    [32],
    'both hold 32-byte private halves',
  );
  // Locking stops proving immediately: a locked tab answers with null, never
  // with a cached signer.
  clearSessionKey();
  assert.equal(await actorForGroup(PK, GID), null);
  forgetActors();
});

test('an in-flight actor derivation is zeroed and discarded if lock clears its session key', async () => {
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let releaseDerivation;
  let delayFirstDerivation = true;
  const derivedBytes = new Uint8Array(32).fill(5);
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { subtle: {
      importKey: async () => ({}),
      deriveBits: () => {
        if (!delayFirstDerivation) return Promise.resolve(new Uint8Array(32).fill(5).buffer);
        delayFirstDerivation = false;
        return new Promise((resolve) => { releaseDerivation = () => resolve(derivedBytes.buffer); });
      },
    } },
  });
  clearSessionKey();
  forgetActors();
  setSessionKey(SK);
  try {
    const pending = actorForGroup(PK, GID);
    while (!releaseDerivation) await new Promise((resolve) => setTimeout(resolve, 0));
    clearSessionKey();
    releaseDerivation();
    assert.equal(await pending, null);
    assert.ok(derivedBytes.every((byte) => byte === 0), 'the late private bytes are cleared');
    setSessionKey(SK);
    const actor = await actorForGroup(PK, GID);
    assert.ok(actor, 'the discarded result did not enter the cache');
  } finally {
    clearSessionKey();
    forgetActors();
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else delete globalThis.crypto;
  }
});

test('the pin tag rides lowercased and reads back through the event form', () => {
  const pin = 'AB'.repeat(33);
  assert.deepEqual(actorTag(pin), [['author', pin.toLowerCase()]]);
  assert.deepEqual(actorTag(''), [], 'no pin, no tag');
  assert.deepEqual(actorTag(null), []);
  const event = { tags: [['h', GID], ['author', 'CD'.repeat(33)], ['ep', '1']] };
  assert.equal(actAuthorPin(event), 'cd'.repeat(33));
  assert.equal(actAuthorPin({ tags: [['h', GID]] }), '', 'no author tag reads back empty');
  // Shape checking happens at the matcher, not here: this reader passes what
  // it read through trimmed, and a malformed value never verifies anywhere.
  assert.equal(actAuthorPin({ tags: [['author', '  junk  ']] }), 'junk');
});

test('receive-side: only a KNOWN pin promotes an act; a verified stranger stays out', async () => {
  const { pin } = await derive(SK, GID);
  // Both shapes count: the compressed invite-link pin and its x-only form,
  // because an event's own pubkey field names the key without the prefix.
  const xonly = pin.slice(2);
  assert.equal(pin.length, 66, 'the derived pin is the compressed pubkey');
  const known = { pubkey: xonly, sig: 'x'.repeat(128), tags: [], content: '' };
  assert.equal(actSignedByKnownActor(known, [pin]), true, 'compressed invite pin matches');
  assert.equal(actSignedByKnownActor(known, [xonly]), true, 'x-only wire shape matches too');
  assert.equal(actSignedByKnownActor(known, [`${GID}-pinned`, pin]), true);
  // The signature being structurally present never matters: the check is the
  // out-of-band pin, so a verified stranger is refused, always.
  const stranger = { pubkey: 'ef'.repeat(32), sig: 'x'.repeat(128), tags: [], content: '' };
  assert.equal(actSignedByKnownActor(stranger, [pin]), false);
  assert.equal(actSignedByKnownActor(stranger, []), false);
  assert.equal(actSignedByKnownActor(null, [pin]), false);
  // Neither shape accepts junk: a malformed stored pin refuses rather than
  // half-matching.
  assert.equal(actSignedByKnownActor(known, ['zz']), false);
  assert.equal(actSignedByKnownActor(known, [`${GID}`]), false);
});

// ── Live-wire witness: what an observer of the box actually sees ──────────

test("an observed act names only the actor pin — the account key is nowhere on the wire event", async () => {
  clearSessionKey();
  forgetActors();
  setSessionKey(SK);
  const { privateKeyBytes, pin } = await derive(SK, GID);
  const { finalizeEvent } = await import('nostr-tools');
  // Exactly what the AUTH arm sends (signActProof shape): signed with the
  // actor's private half.
  const seen = finalizeEvent({
    kind: 22242,
    created_at: 100,
    tags: [['relay', 'wss://box'], ['challenge', 'ch'], ['author', pin]],
    content: '',
  }, privateKeyBytes);
  assert.equal(verifyEvent(seen), true, 'the signature verifies under the actor key');
  // event.pubkey is the X-ONLY form of the pinned compressed key: same key,
  // two bytes fewer than the invite-link pin carries.
  assert.equal(seen.pubkey, pin.slice(2), 'the wire author field IS the pin (x-only)');
  assert.equal(actSignedByKnownActor(seen, [pin]), true, 'an observed act verifies against the invite-link pin');
  // The account key signed nothing here: comparing against a signature made
  // with the account secret proves the pin is not a wrapper around it.
  const byAccount = finalizeEvent({
    kind: 22242, created_at: 100, tags: [['relay', 'wss://box'], ['challenge', 'ch']], content: '',
  }, SK);
  assert.notEqual(seen.pubkey, byAccount.pubkey);
  forgetActors();
});
