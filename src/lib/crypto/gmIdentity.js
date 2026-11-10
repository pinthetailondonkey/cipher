// The group actor key (Step 2 of docs/MEMBERSHIP-DESIGN.md).
//
// One decision recorded at Step 0 now pays its second bill: the per-group
// authority key that signs the member-set document also signs everything else
// this account puts on a group box. After Step 2 the identity key signs
// nothing on the group relays, so an observer collating boxes can no longer
// read which accounts sit together behind one person (finding N3):
//
//   before: kind 22242 proofs, kind-9 messages and control kinds all carry
//           the account pubkey itself, so two groups on one box name the
//           same npub side by side.
//   after:  every act on a group box is signed by HKDF(account secret,
//           cipher-gid:<gid>) — groupAuthority.js's own derivation — so the
//           author name on group A and group B shares no visible key, and
//           neither names the account key.
//
// What still binds the pseudonym to membership, deliberately:
//   - the pin (the compressed pubkey) rides every act in an `author` tag, and
//     members hold it out of band from the invite link, so received acts are
//     checked against a learned value rather than believed from the wire;
//   - the member-set document names ACTOR pins beside account pubkeys, so
//     standing checks keep working on devices that know nobody yet;
//   - the owner's own device also proves itself this way: same derivation,
//     so nothing is special-cased.
//
// Residuals carried in MEMBERSHIP-DESIGN.md section 6 stand unchanged: the
// key cannot be revoked without rotating the account key (H5 residual (a)),
// and whether the pseudonym is per-account or per-device stays open (B5) —
// both are questions about THIS derivation, and neither answer changes any
// call-site below.

import { groupAuthorityKey } from './groupAuthority';
import { getSessionKey } from '../sessionKey';

const HEX64 = /^[0-9a-f]{64}$/;

// Pins come in two shapes and BOTH are legitimate:
//   - the compressed 66-hex the invite link carries and authorityPins.js
//     stores (Step 1 chain: groupAuthority.js getPublicKey(sk, true));
//   - the x-only 64-hex a Nostr event's own pubkey field names.
// The receive-side matcher must therefore fold the two-byte compression
// prefix before comparing, or a device holding the out-of-band pin refuses
// every legitimate act. Anything else is not one of these shapes and is
// refused.
const COMPRESSED_PIN = /^0[23]([0-9a-f]{64})$/;

function pinXonly(value) {
  const text = String(value || '').toLowerCase().trim();
  const compressed = COMPRESSED_PIN.exec(text);
  if (compressed) return compressed[1];
  return HEX64.test(text) ? text : '';
}

function normalizePubkey(value) {
  const text = String(value || '').toLowerCase();
  return HEX64.test(text) ? text : '';
}

// Memoize only the DERIVED PAIR, never the account secret: the account half
// is read fresh through getSessionKey() on every resolve, so a locked tab
// stops proving and signing immediately, and re-locking can never serve a
// stale signer. Entries are keyed by account pubkey, so parallel accounts on
// one tab do not lend keys to each other.
const actors = new Map();

function cacheSlot(ownerPk) {
  return normalizePubkey(ownerPk) || '';
}

// Resolve this account's signing actor for one group. Returns
// { privateKeyBytes, pin, ownerPk } or null when there is nothing to sign
// with: callers refuse rather than improvise (the publishDocOp discipline).
export async function actorForGroup(ownerPk, groupId) {
  const slot = cacheSlot(ownerPk);
  if (!slot) return null;
  const accountSk = getSessionKey();
  if (!accountSk || accountSk.length !== 32) return null;
  const slotKey = `${slot}|${groupId}`;
  let actor = actors.get(slotKey);
  if (!actor) {
    // Same derivation, same salt string, same curve as Step 1b: this IS the
    // doc authority key. A fork here would split one pinned identity into two.
    const { privateKeyBytes, pin } = await groupAuthorityKey(accountSk, groupId);
    // HKDF yields asynchronously. Lock or account replacement can happen
    // while it runs, so do not cache its result unless the exact session-key
    // object that began the derivation is still installed.
    if (getSessionKey() !== accountSk) {
      privateKeyBytes.fill(0);
      return null;
    }
    actor = { privateKeyBytes, pin, ownerPk: slot };
    actors.set(slotKey, actor);
  }
  return actor;
}

// Drop every held derivation. Called when a vault closes so a re-opened
// account re-derives against whatever secret answers then; never trusts the
// cache across a lock boundary.
export function forgetActors() {
  actors.clear();
}

// Where the signing pin rides on a wire event. Every act this module builds
// carries exactly one of these tags; verifiers read it back instead of
// guessing who sent what.
export function actorTag(pin) {
  const value = String(pin || '').toLowerCase().trim();
  if (!value) return [];
  return [['author', value]];
}

export function actAuthorPin(event) {
  const raw = event?.tags?.find((tag) => tag[0] === 'author')?.[1] || '';
  const text = String(raw || '').toLowerCase().trim();
  return text || '';
}

// The receive-side check: an act counts as signed by this group's known actor
// only when its event pubkey IS the pin the verifier holds out of band (the
// invite-link pin the device stamped at join, or the roster/doc record). The
// pin may arrive compressed (invite-link shape) or x-only (wire shape); both
// name the same key and both count. A verified NIP-01 signature alone never
// promotes a stranger to an actor.
export function actSignedByKnownActor(event, expectedPins) {
  const signer = normalizePubkey(event?.pubkey);
  if (!signer) return false;
  const list = Array.isArray(expectedPins) ? expectedPins : [expectedPins];
  return list.some((pin) => pinXonly(pin) === signer);
}
