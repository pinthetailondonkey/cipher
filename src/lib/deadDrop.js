// Dead-drop notes: self-destructing encrypted messages shared by link.
//
// Shape (user-specified, verbatim): <note-origin>/note#<payload> — the origin
// is the egress registry's 'dead-drop' entry. The URL FRAGMENT carries
// everything needed to decrypt — base64url of
// [key (32b) | iv (12b) | note hash (32b)] — so the key never appears in the
// path, query, or any server log. The path is just /note.
//
// The encrypted blob is a relay event (kind 30100) whose `d` tag is the note
// hash = sha256(key) — so the URL carries no way to FIND the event without
// the key, and relays that never see the fragment still store only ciphertext.
// Anyone with the relay and no fragment can neither find nor read the note.
//
// One-open is a LOCAL rule: the reader marks the hash spent on its own device
// and refuses the link there a second time. A relay delete (kind 5) can only
// come from the key that signed the note (NIP-09), so only the writer opening
// its own note can ask relays to drop it; a reader's delete would be ignored
// and is not sent. The note stays on the relay as ciphertext, and the link
// still opens on any other device that has not spent it. The real boundary is
// that without the fragment key the ciphertext is unreadable and unfindable.
//
// Groups deep links (user-specified): <note-origin>/<groupid> is handled in
// useChatBootstrap — same behavior as ?g=, new shape.

const NOTE_KIND = 30100;

// ————— bytes helpers —————

function toB64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto unavailable');
  return globalThis.crypto.subtle;
}

// ————— fragment format —————
// fragment = base64url( key[32] || iv[12] || hash[32] )
// Everything after the first 44 bytes identifies the relay event; the first
// 44 decrypt it. One blob, no separators, fixed offsets.

const KEY_LEN = 32;
const IV_LEN = 12;
const HASH_LEN = 32;

async function deriveNoteHash(keyBytes) {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return sha256(keyBytes);
}

function packFragment(keyBytes, ivBytes, hashBytes) {
  return toB64Url(concatBytes(keyBytes, ivBytes, hashBytes));
}

function unpackFragment(fragment) {
  let raw;
  try { raw = fromB64Url(fragment); } catch { return null; }
  if (raw.length !== KEY_LEN + IV_LEN + HASH_LEN) return null;
  return {
    key: raw.slice(0, KEY_LEN),
    iv: raw.slice(KEY_LEN, KEY_LEN + IV_LEN),
    hash: raw.slice(KEY_LEN + IV_LEN),
  };
}

// The link host lives in the egress registry (id 'dead-drop'), like every
// other outbound host this app can contact.
import { entryById, activeUrl } from './egress.js';
import { scopedGet, scopedSet } from './storage.js';

// ————— burn ledger —————
// The one-open promise is held by THIS device, not the relays: a kind-5
// delete is a request relays may ignore, and the ciphertext stays fetchable
// until every relay forgets it. Before this ledger the app path never
// wired isConsumed at all, so the same link opened forever locally. The
// ledger is scoped to the active account (storage.js), like every other
// private state here — a second account on the same device holds its own
// copy of the promise, and the holder of the URL is the reader either way.
const CONSUMED_KEY = 'dead_drop_consumed';

export function deadDropConsumed(hashHex) {
  const ledger = scopedGet(CONSUMED_KEY, {});
  return !!(ledger && ledger[hashHex]);
}

export function markDeadDropConsumed(hashHex) {
  const ledger = scopedGet(CONSUMED_KEY, {}) || {};
  if (ledger[hashHex]) return;
  ledger[hashHex] = Math.floor(Date.now() / 1000);
  scopedSet(CONSUMED_KEY, ledger);
}

export function noteOrigin(config = undefined) {
  return activeUrl(entryById('dead-drop'), config) || '';
}

export function noteUrl(fragment, origin = noteOrigin()) {
  return `${origin}/note#${fragment}`;
}

// ————— create —————

// Seal and publish a dead-drop note. Returns { url, hash } — the url is the
// whole secret; the caller shows it once and never stores it.
export async function createDeadDropNote({ identity, text, pool, relays }) {
  if (!identity?.sk) throw new Error('An identity is required to sign the note event.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The note is empty.');
  if (text.length > 8000) throw new Error('The note is too long (8000 characters max).');

  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  const ivBytes = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const aesKey = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify({ t: text }));
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: ivBytes }, aesKey, plaintext),
  );
  const hash = await deriveNoteHash(keyBytes);
  const hashHex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');

  const { finalizeEvent } = await import('nostr-tools');
  const event = finalizeEvent({
    kind: NOTE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', hashHex]],
    content: toB64Url(ciphertext),
  }, identity.sk);

  const results = await Promise.allSettled(pool.publish(relays, event));
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  if (okCount === 0) throw new Error('No relay accepted the note. It was not sent.');

  const fragment = packFragment(keyBytes, ivBytes, hash);
  return { url: noteUrl(fragment), hash: hashHex, relayCount: okCount };
}

// ————— read —————

// Fetch and open a note from a fragment. One readable attempt; consumed
// notes (this device already opened this hash) fail closed. The default
// consume check is this device's own ledger; callers may pass isConsumed
// to consult a different store.
//
// `hold: true` hands the burn to the caller: it returns { text, hash, burn }
// without marking the hash consumed, and `burn()` does it. That exists for the
// delivery-address carrier: the opened text is the buyer's address and it must
// be SAVED into the vendor's order record first — burning before the save
// would destroy the address on a save failure — and once the record is down
// the note is marked spent on this device. Nothing else in this file touches
// encryption (NIP-44, group AAD, outbox are elsewhere).
//
// `author` is the key the note must come from (the buyer who sent the link in
// the chat). With it the query asks only that key's events and any event from
// another key is ignored. Without it (a bare note link, writer unknown) every
// event for the hash is still tried newest first and the first one the link's
// key actually opens wins, so a stranger's newer event on the same d tag, which
// cannot be opened with a key they do not have, cannot shadow the real note.
export async function openDeadDropNote({ identity, fragment, pool, relays, isConsumed = null, hold = false, author = null }) {
  const parts = unpackFragment(fragment);
  if (!parts) throw new Error('That link is not a valid note link.');

  const hashHex = Array.from(parts.hash, (b) => b.toString(16).padStart(2, '0')).join('');
  if (isConsumed ? await isConsumed(hashHex) : deadDropConsumed(hashHex)) {
    throw new Error('This note was already opened on this device.');
  }

  const wanted = typeof author === 'string' && /^[0-9a-f]{64}$/i.test(author) ? author.toLowerCase() : null;
  const filter = { kinds: [NOTE_KIND], '#d': [hashHex] };
  if (wanted) filter.authors = [wanted];
  const found = await pool.querySync(relays, filter);
  // A relay can ignore the authors filter; the check is repeated here.
  const events = (found || [])
    .filter((e) => e && e.kind === NOTE_KIND && (!wanted || String(e.pubkey).toLowerCase() === wanted))
    .sort((a, b) => b.created_at - a.created_at);
  if (!events.length) throw new Error('The note is gone or was never here.');

  // Newest valid wins — a re-uploaded note (destruct failed everywhere)
  // supersedes, and an event that does not open under this link's key is
  // skipped, not trusted. Only when none opens is the link called altered.
  const aesKey = await subtle().importKey('raw', parts.key, 'AES-GCM', false, ['decrypt']);
  let latest = null;
  let payload = null;
  for (const event of events) {
    try {
      const plaintext = await subtle().decrypt(
        { name: 'AES-GCM', iv: parts.iv },
        aesKey,
        fromB64Url(event.content),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plaintext));
      if (parsed && typeof parsed === 'object') { latest = event; payload = parsed; break; }
    } catch { /* not ours; try the next one */ }
  }
  if (!latest) throw new Error('This note could not be opened — the link was altered.');

  // The burn, as one awaited step: mark the ledger so this device refuses the
  // link a second time. That is the whole burn for a reader. A relay honors a
  // delete (NIP-09) only from the key that signed the note, so a delete signed
  // by anyone else would be ignored and is not sent; only the writer opening
  // its own note asks relays to drop it. An unreadable or altered link never
  // reaches this mark, so it still opens once it is fixed.
  const burn = async () => {
    markDeadDropConsumed(hashHex);
    if (identity?.sk) {
      try {
        const { finalizeEvent, getPublicKey } = await import('nostr-tools');
        if (getPublicKey(identity.sk) !== latest.pubkey) return;
        const del = finalizeEvent({
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['e', latest.id]],
          content: '',
        }, identity.sk);
        Promise.allSettled(pool.publish(relays, del)).catch(() => {});
      } catch (error) {
        console.warn('[deadDrop] The delete request could not be published:', error);
      }
    }
  };

  if (hold) {
    return { text: typeof payload.t === 'string' ? payload.t : '', hash: hashHex, burn };
  }
  await burn();
  return { text: typeof payload.t === 'string' ? payload.t : '', hash: hashHex };
}

export const _deadDropInternals = {
  NOTE_KIND, KEY_LEN, IV_LEN, HASH_LEN,
  toB64Url, fromB64Url, packFragment, unpackFragment, deriveNoteHash,
};
