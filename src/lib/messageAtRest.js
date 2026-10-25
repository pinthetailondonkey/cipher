// Message history at rest: every message row is sealed with AES-GCM under the
// account's existing vault key before it reaches IndexedDB. The key is the
// session copy of the vault key (sessionStorage 'cipher_session_sk'), set and
// cleared by lock/unlock (src/useIdentity.js). No new key material exists.
//
// The group envelope itself is untouched: group messages are already sealed by
// their own rotating keys inside src/lib/crypto/groupCipher.js. This wrapper
// adds one outer seal around the stored row, so the row's other fields —
// sender, timestamps, clientId — can never be read from disk without the
// vault key.
//
// Rows written before this change carry no `sealed` field and pass through
// unchanged, so old plaintext history stays readable next to sealed rows.
//
// With the vault locked the key is gone: writes that still land (a relay
// callback finishing just after lock) are held in memory only, never touching
// disk, and are written the next time that account unlocks. Reads of sealed
// rows return the row without its payload — well formed, so history still
// renders without crashing.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const AT_REST_VERSION = 1;
const MAX_PENDING = 500;

// Fields that stay plaintext: the schema indexes (so queries keep working)
// and cheap routing flags the UI reads before decryption. Everything else is
// sealed.
const PUBLIC_FIELDS = new Set([
  'id', 'chatId', 'pubkey', 'timestamp', 'clientId', 'type',
  'isSender', 'isGroup', 'local_timestamp',
]);

export function setAtRestKeyProvider(provider) {
  if (typeof provider !== 'function') return;
  getSkBytes = provider;
}

function aadFor(chatId, id, version) {
  return enc.encode(`cipher-history-${version}|${chatId ?? ''}|${id ?? ''}`);
}

async function importKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

let getSkBytes = () => {
  try {
    const raw = sessionStorage.getItem('cipher_session_sk');
    return raw ? Uint8Array.from(JSON.parse(raw)) : null;
  } catch { return null; }
};

let keyCache = { hex: null, key: null };

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function vaultKey() {
  const sk = getSkBytes();
  if (!sk) { keyCache = { hex: null, key: null }; return null; }
  const hex = toHex(sk);
  if (keyCache.hex === hex) return keyCache.key;
  keyCache = { hex, key: await importKey(sk) };
  return keyCache.key;
}

export function isSealedRow(row) {
  return !!row && typeof row === 'object'
    && !!row.sealed && typeof row.sealed.ct === 'string';
}

// Returns the row with the secret payload moved into `sealed`, or null when
// the vault key is unavailable (the caller must not write plaintext). Rows
// already sealed, or rows with nothing to protect, pass through unchanged.
export async function trySealMessageRow(row) {
  if (!row || typeof row !== 'object' || isSealedRow(row)) return row;
  const payload = {};
  for (const [field, value] of Object.entries(row)) {
    if (!PUBLIC_FIELDS.has(field)) payload[field] = value;
  }
  if (!Object.keys(payload).length) return row;
  const key = await vaultKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(row.chatId, row.id, AT_REST_VERSION) },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  const exposed = {};
  for (const field of PUBLIC_FIELDS) {
    if (field in row) exposed[field] = row[field];
  }
  exposed.sealed = {
    v: AT_REST_VERSION,
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
  };
  return exposed;
}

// Returns the full decrypted row. A legacy plaintext row passes through as it
// is stored. A sealed row without the vault key, or one that cannot be opened,
// returns only the public fields — the source shape is a truthy object, so
// `if (!message)` call sites keep working and history renders without the
// payload instead of crashing.
export async function openMessageRow(row) {
  if (!isSealedRow(row)) return row;
  const exposed = {};
  for (const field of PUBLIC_FIELDS) {
    if (field in row) exposed[field] = row[field];
  }
  const key = await vaultKey();
  if (!key) return exposed;
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(row.sealed.iv), additionalData: aadFor(row.chatId, row.id, row.sealed.v) },
      key,
      unb64(row.sealed.ct),
    );
    return { ...exposed, ...JSON.parse(dec.decode(pt)) };
  } catch (error) {
    console.error('[at-rest] A stored message could not be opened:', error?.name || error);
    return exposed;
  }
}

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Writes that reach a table with no vault key wait here — in memory, never on
// disk — until the same account unlocks again.
const pendingByOwner = new Map();

export function queueAtRestWrite(owner, row) {
  if (!owner) return;
  const list = pendingByOwner.get(owner) || [];
  if (list.length >= MAX_PENDING) list.shift();
  list.push(row);
  pendingByOwner.set(owner, list);
}

export function takeAtRestWrites(owner) {
  const list = pendingByOwner.get(owner) || [];
  pendingByOwner.set(owner, []);
  return list;
}

// Called when an account's database is deleted: those rows can never be
// written, so do not keep their plaintext in memory waiting.
export function dropAtRestWrites(owner) {
  if (owner) pendingByOwner.delete(owner);
}
