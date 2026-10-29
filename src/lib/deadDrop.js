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

// The promise the reader makes is to the DEVICE — "This note opens once on
// this device" — so the ledger is read and written for the device as well as
// for the account. Scoped alone it broke in two ways a person would see: a
// stranger with no account spent a note under the guest scope and the same
// link opened again as soon as they made an account, and a second account on
// the same device opened a note the first had already spent. The scoped copy
// stays written so ledgers from before this change are still read.
const DEVICE_CONSUMED_KEY = 'cipher_device_dead_drop_consumed';

function deviceLedger() {
  try {
    const raw = globalThis.localStorage?.getItem(DEVICE_CONSUMED_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDeviceLedger(ledger) {
  try {
    globalThis.localStorage?.setItem(DEVICE_CONSUMED_KEY, JSON.stringify(ledger));
  } catch { /* no storage: the scoped copy below still holds it */ }
}

export function deadDropConsumed(hashHex) {
  if (deviceLedger()[hashHex]) return true;
  const ledger = scopedGet(CONSUMED_KEY, {});
  return !!(ledger && ledger[hashHex]);
}

export function markDeadDropConsumed(hashHex) {
  const when = Math.floor(Date.now() / 1000);
  const device = deviceLedger();
  if (!device[hashHex]) {
    device[hashHex] = when;
    writeDeviceLedger(device);
  }
  const ledger = scopedGet(CONSUMED_KEY, {}) || {};
  if (ledger[hashHex]) return;
  ledger[hashHex] = when;
  scopedSet(CONSUMED_KEY, ledger);
}

export function noteOrigin(config = undefined) {
  return activeUrl(entryById('dead-drop'), config) || '';
}

export function noteUrl(fragment, origin = noteOrigin()) {
  return `${origin}/note#${fragment}`;
}

// ————— the one-read carrier (S4) —————
// A carrier note is a second transport for the same idea, and the only one
// where "burns on read" is true off this device: the ciphertext is posted to
// the note host and fetched back exactly once, and the server deletes it on
// that fetch. The server holds no key and is sent no fragment.
//
// The fragment is a different shape, told apart by its first byte:
//   [version 0x02][id 16][key 32][iv 12]  — 61 bytes, base64url
// The id is 16 random bytes and says nothing about the key. It is bound into
// the ciphertext as AES-GCM's additional data, so this host cannot swap one
// note into another note's place under the same link.
const CARRIER_VERSION = 2;
const CARRIER_ID_LEN = 16;
const CARRIER_FRAGMENT_LEN = 1 + CARRIER_ID_LEN + KEY_LEN + IV_LEN;

export function packCarrierFragment(idBytes, keyBytes, ivBytes) {
  return toB64Url(concatBytes(Uint8Array.from([CARRIER_VERSION]), idBytes, keyBytes, ivBytes));
}

export function unpackCarrierFragment(fragment) {
  let raw;
  try { raw = fromB64Url(fragment); } catch { return null; }
  if (raw.length !== CARRIER_FRAGMENT_LEN || raw[0] !== CARRIER_VERSION) return null;
  return {
    id: raw.slice(1, 1 + CARRIER_ID_LEN),
    key: raw.slice(1 + CARRIER_ID_LEN, 1 + CARRIER_ID_LEN + KEY_LEN),
    iv: raw.slice(1 + CARRIER_ID_LEN + KEY_LEN),
  };
}

export function isCarrierFragment(fragment) {
  return unpackCarrierFragment(fragment) !== null;
}

const carrierBase = (origin) => String(origin || '').replace(/\/+$/, '');

// Seal a note and hand it to the one-read host. The url is the whole secret;
// it is shown once and never stored. Nothing here signs anything: the carrier
// has no authors and no accounts, which is what "no app" means.
export async function createCarrierNote({ text, origin = noteOrigin(), fetchImpl = globalThis.fetch } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The note is empty.');
  if (text.length > 8000) throw new Error('The note is too long (8000 characters max).');
  const base = carrierBase(origin);
  if (!base) throw new Error('The note host is not set, so a note that reads once cannot be made yet.');
  if (typeof fetchImpl !== 'function') throw new Error('This device cannot reach the note host.');

  const id = crypto.getRandomValues(new Uint8Array(CARRIER_ID_LEN));
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  const ivBytes = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const aesKey = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify({ t: text }));
  const ciphertext = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: id },
    aesKey,
    plaintext,
  ));

  let response;
  try {
    response = await fetchImpl(`${base}/api/notes/${toB64Url(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: ciphertext,
      credentials: 'omit',
    });
  } catch {
    throw new Error('The note host could not be reached. The note was not stored.');
  }
  if (!response.ok) throw new Error('The note host refused the note. Nothing was stored.');
  const fragment = packCarrierFragment(id, keyBytes, ivBytes);
  return { url: `${base}/note#${fragment}`, id: toB64Url(id) };
}

// Open a carrier note. There is no local hold and no second attempt: the host
// hands it over once, and this call is that one time.
export async function openCarrierNote({ fragment, origin = noteOrigin(), fetchImpl = globalThis.fetch } = {}) {
  const parts = unpackCarrierFragment(fragment);
  if (!parts) throw new Error('That link is not a valid note link.');
  const base = carrierBase(origin);
  if (!base) throw new Error('The note host is not set, so this note cannot be opened here.');
  if (typeof fetchImpl !== 'function') throw new Error('This device cannot reach the note host.');

  let response;
  try {
    response = await fetchImpl(`${base}/api/notes/${toB64Url(parts.id)}`, { cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new Error('The note host could not be reached. The note was not opened.');
  }
  // A 404 says the host does not have it, and nothing more. It cannot say who
  // read it: a reader whose own fetch crossed the deadline and burned the note
  // gets this same answer, and telling them it "has already been read" claims a
  // read they never had, about a note they will never see. The relay path
  // already carries the line that is true in every case, so this one uses it.
  if (response.status === 404) throw new Error('The note is gone or was never here.');
  if (!response.ok) throw new Error('The note host refused the note. It was not opened.');
  const sealed = new Uint8Array(await response.arrayBuffer());
  const aesKey = await subtle().importKey('raw', parts.key, 'AES-GCM', false, ['decrypt']);
  let plaintext;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: parts.iv, additionalData: parts.id },
      aesKey,
      sealed,
    );
  } catch {
    throw new Error('This note could not be opened — the link was altered.');
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(plaintext)); } catch { payload = null; }
  return { text: payload && typeof payload.t === 'string' ? payload.t : '', id: toB64Url(parts.id) };
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
  // A carrier link is a different fragment and opens through the host that
  // deletes it on read. The local ledger still records it, so a second tap
  // on this device says the honest thing without a round trip.
  const carried = unpackCarrierFragment(fragment);
  if (carried) {
    const idText = toB64Url(carried.id);
    if (isConsumed ? await isConsumed(idText) : deadDropConsumed(idText)) {
      throw new Error('This note was already opened on this device.');
    }
    const opened = await openCarrierNote({ fragment });
    const burn = async () => { markDeadDropConsumed(idText); };
    if (hold) return { text: opened.text, hash: idText, burn };
    await burn();
    return { text: opened.text, hash: idText };
  }
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


// ————— which transport —————
// A note reads once only where the host itself deletes it, so the carrier is
// used when the note host answers as one, and the relay copy is used when it
// does not — that is today's behaviour, unchanged, for a host that is not a
// carrier or is not deployed yet. The probe is one request and is remembered
// for the life of the page.
let carrierKnown = null;

export function forgetCarrierProbe() { carrierKnown = null; }

export async function carrierAvailable(origin = noteOrigin(), fetchImpl = globalThis.fetch) {
  const base = carrierBase(origin);
  if (!base) return false;
  if (carrierKnown !== null && carrierKnown.origin === base) return carrierKnown.ok;
  let ok = false;
  try {
    const response = await fetchImpl(`${base}/healthz`, { cache: 'no-store', credentials: 'omit' });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      ok = Boolean(body && body.ok === true);
    }
  } catch { ok = false; }
  carrierKnown = { origin: base, ok };
  return ok;
}

// The one call the app makes to share a note. It returns what actually
// happened, so no screen has to guess: `carrier: true` means the host will
// hand it over once and delete it; `carrier: false` means the relay copy,
// whose one-open is this device's own rule.
export async function createNoteLink({ identity, text, pool, relays, origin = noteOrigin(), fetchImpl = globalThis.fetch } = {}) {
  if (await carrierAvailable(origin, fetchImpl)) {
    const made = await createCarrierNote({ text, origin, fetchImpl });
    return { url: made.url, hash: made.id, relayCount: 0, carrier: true };
  }
  const made = await createDeadDropNote({ identity, text, pool, relays });
  return { ...made, carrier: false };
}

export const _deadDropInternals = {
  NOTE_KIND, KEY_LEN, IV_LEN, HASH_LEN,
  CARRIER_VERSION, CARRIER_ID_LEN, CARRIER_FRAGMENT_LEN,
  toB64Url, fromB64Url, packFragment, unpackFragment, deriveNoteHash,
  packCarrierFragment, unpackCarrierFragment,
  carrierAvailable, forgetCarrierProbe,
};
