import { nip44 } from 'nostr-tools';

// A DM conversation key is a deterministic NIP-44 derivation from (secret,
// peer): the same pair always gives the same key. Deriving it costs an ECDH
// point multiply, so replaying a chat's history or a busy relay flood pays
// that cost once per message — the main-thread stall behind slow launches
// and taps that queue behind it (worst on Safari's slower big-integer math).
//
// This memoizes the derived key per secret-peer pair only: the algorithm is
// untouched, nothing new is stored or sent, the cache holds a handful of
// entries in memory, and locking wipes it together with the session key.
const derived = new Map();
const MAX_KEYS = 64;

const asHex = (value) => (typeof value === 'string' ? value : Array.from(value, (b) => b.toString(16).padStart(2, '0')).join(''));

let derive = nip44.v2.utils.getConversationKey;

// Tests stub the derivation so the memo can be checked without real crypto.
export function _setDeriverForTest(fn) {
  derive = fn;
  return () => { derive = nip44.v2.utils.getConversationKey; };
}

export function conversationKey(sk, peerPubkey) {
  const cacheKey = `${asHex(sk).slice(0, 16)}:${peerPubkey}`;
  const cached = derived.get(cacheKey);
  if (cached) return cached;
  const key = derive(sk, peerPubkey);
  if (derived.size >= MAX_KEYS) derived.delete(derived.keys().next().value);
  derived.set(cacheKey, key);
  return key;
}

export const clearConversationKeyCache = () => derived.clear();
