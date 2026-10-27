// Safety numbers, engine-only. A compact code a human can compare with their
// contact out-of-band to confirm no one has swapped a key underneath them.
//
// Derivation (pinned format 'v1' — changing ANY input invalidates every
// stored comparison, so bump SAFETY_NUMBER_VERSION and re-derive):
//   sha256('cipher-safety-v1' || contactPubkey || firstSeenRelays sorted)
//   → first 5 bytes → 5 groups of 3 digits (0-999) → "XXX XXX XXX XXX XXX"
//
// The first-seen relay set is part of the code because a man-in-the-middle
// who swaps keys on a different relay set produces a different code — that
// difference is the whole point.
//
// State on the contact record (one JSON blob in scoped storage, keyed by
// contact pubkey):
//   relays       — the relay set at first contact (the derivation input)
//   firstSeenAt  — unix seconds when first contacted
//   safetyNumber — the derived code (cached, stable across app versions)
//   changed      — true when key material changed after the code was set

import { sha256 } from '@noble/hashes/sha2.js';

// Bump this when the derivation changes. Every stored comparison dies with it.
const SAFETY_NUMBER_VERSION = 'v1';

const STORAGE_KEY = 'safety_numbers_v1';
const GROUPS = 5;
const DIGITS_PER_GROUP = 3;

const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// Relays differ by trailing slash / scheme; canonicalize so both sides of a
// conversation derive the same code from the same set.
function canonicalRelays(relays) {
  const seen = new Set();
  for (const relay of relays || []) {
    if (typeof relay !== 'string' || !relay) continue;
    const host = relay.trim().toLowerCase().replace(/^wss?:\/\//, '').replace(/\/+$/, '');
    if (host) seen.add(host);
    if (seen.size >= 8) break;
  }
  return [...seen].sort();
}

// Five groups of 3 digits from the first 5 bytes, half-up spread for even
// coverage: byte value * 1000 / 256. Deterministic across JS engines.
function digitsFromBytes(bytes) {
  const groups = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(String(Math.floor((bytes[i] * 1000) / 256)).padStart(DIGITS_PER_GROUP, '0'));
  }
  return groups;
}

export function deriveSafetyNumber(contactPubkey, firstSeenRelays) {
  const versionInput = new TextEncoder().encode(`cipher-safety-${SAFETY_NUMBER_VERSION}`);
  const pkInput = new TextEncoder().encode(String(contactPubkey).trim().toLowerCase());
  const relayInput = new TextEncoder().encode(canonicalRelays(firstSeenRelays).join('\n'));
  const digest = sha256(concatBytes(versionInput, new Uint8Array([0]), pkInput, new Uint8Array([0]), relayInput));
  const groups = digitsFromBytes(digest);
  return groups.join(' ');
}

// ————— contact-record state —————

function loadAll() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
  catch { return {}; }
}

function saveAll(all) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch {}
}

export function safetyRecord(contactPubkey) {
  const all = loadAll();
  return all[contactPubkey] || null;
}

// Record first contact. The relay set is read from the connection the message
// actually came through when the caller knows it; otherwise the app's current
// general relays are the honest "where I first saw this key" answer.
export async function noteFirstSeen(contactPubkey, relays = null, nowSec = Math.floor(Date.now() / 1000)) {
  const all = loadAll();
  const existing = all[contactPubkey];
  if (existing) return existing; // first-seen never moves
  if (!relays) {
    const { generalRelays } = await import('./relays.js');
    relays = generalRelays;
  }
  const record = {
    relays: canonicalRelays(relays),
    firstSeenAt: nowSec,
    safetyNumber: deriveSafetyNumber(contactPubkey, relays),
    changed: false,
  };
  all[contactPubkey] = record;
  saveAll(all);
  return record;
}

// Engine flag: the caller (DM ingestion) calls this when key material for the
// contact changed — e.g. a new group-key bundle or an out-of-band key rotation.
// The stored code itself does NOT change (it is pinned to first-seen); the
// flag tells the future UI to lead with "key changed — re-verify".
export function markSafetyChange(contactPubkey) {
  const all = loadAll();
  const existing = all[contactPubkey];
  if (!existing) return null;
  existing.changed = true;
  saveAll(all);
  return existing;
}

// The banner's own action: the person compared the code out-of-band and it
// still matches, so the change flag drops and the warning strip goes away.
// The pinned number itself never moves — first-seen is frozen.
export function markSafetyVerified(contactPubkey) {
  const all = loadAll();
  const existing = all[contactPubkey];
  if (!existing) return null;
  if (!existing.changed) return existing;
  existing.changed = false;
  saveAll(all);
  return existing;
}

// The single readable surface a future one-line UI row reads:
//   safetyNumberFor(pk) -> { number, changed, firstSeenAt } | null
export function safetyNumberFor(contactPubkey) {
  const record = safetyRecord(contactPubkey);
  if (!record) return null;
  return { number: record.safetyNumber, changed: record.changed, firstSeenAt: record.firstSeenAt };
}

export const _safetyInternals = { SAFETY_NUMBER_VERSION, canonicalRelays, digitsFromBytes, STORAGE_KEY };
