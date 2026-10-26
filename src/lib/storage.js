// Per-account scoped localStorage. Fixes cross-account leakage (audit H3).
// All get/set/remove calls are prefixed with the active pubkey.

const safeStorage = {
  getItem(key) {
    try {
      if (!globalThis.localStorage) return null;
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (globalThis.localStorage) globalThis.localStorage.setItem(key, value);
    } catch {}
  },
  removeItem(key) {
    try {
      if (globalThis.localStorage) globalThis.localStorage.removeItem(key);
    } catch {}
  },
  key(index) {
    try {
      if (!globalThis.localStorage) return null;
      return globalThis.localStorage.key(index);
    } catch {
      return null;
    }
  },
  get length() {
    try {
      return globalThis.localStorage ? globalThis.localStorage.length : 0;
    } catch {
      return 0;
    }
  },
};

export function getActivePubkey() {
  const pk =
    safeStorage.getItem('cipher_active_pubkey') ||
    safeStorage.getItem('cipher_db_owner') ||
    'guest';

  return typeof pk === 'string' ? pk : 'guest';
}

const LEGACY_SCOPE_CHARS = 8;

// One-time per account per session: old builds named account drawers with
// the first 8 hex characters of the pubkey. Those 8 characters are the whole
// boundary between accounts — a second account sharing them shares the
// drawer. Scoped keys are now named with the full 64 characters, and this
// moves each legacy key across once. Moving only happens while no saved
// account shares the prefix (as with the legacy address adoption): with a
// prefix-neighbor on the device the drawer cannot say whose contents they
// are, and claiming them could hand one account the other's receipts.
// Keys a full-scope entry already holds stay behind, orphaned, rather than
// overwriting live data. (security A2)
let migratedFor = null;

function legacyScopeSisters(storage, pk) {
  try {
    const vaults = JSON.parse(storage.getItem('cipher_vaults') || '{}') || {};
    return Object.keys(vaults).filter((other) => other && other !== pk
      && other.slice(0, LEGACY_SCOPE_CHARS) === pk.slice(0, LEGACY_SCOPE_CHARS));
  } catch {
    return [];
  }
}

export function migrateLegacyScope(storage = globalThis.localStorage) {
  const pk = getActivePubkey();
  if (!pk || pk === 'guest' || pk.length < LEGACY_SCOPE_CHARS || migratedFor === pk) return;
  migratedFor = pk;
  if (!storage) return;
  if (legacyScopeSisters(storage, pk).length > 0) return;
  const prefix = `cipher_${pk.slice(0, LEGACY_SCOPE_CHARS)}_`;
  let keys = [];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean);
  } catch {
    return;
  }
  for (const legacyKey of keys) {
    if (!legacyKey.startsWith(prefix)) continue;
    const next = `cipher_${pk}_${legacyKey.slice(prefix.length)}`;
    try {
      if (storage.getItem(next) === null) storage.setItem(next, storage.getItem(legacyKey));
      storage.removeItem(legacyKey);
    } catch {}
  }
}

// Tests hand the module a fresh storage between runs; a stale marker would
// skip a move the fresh storage still needs.
export function resetScopeMigration() {
  migratedFor = null;
}

export function scopeKey(key) {
  const pk = getActivePubkey();
  const safePk = typeof pk === 'string' && pk.length > 0 ? pk : 'guest';
  migrateLegacyScope();
  return `cipher_${safePk}_${key}`;
}

const scopedCache = new Map();

// The stored bytes behind a scoped key, for readers that must tell absent
// from corrupt: parsed JSON is not enough for a value where "default" and
// "unreadable" mean different things. (security S1)
export function scopedRaw(key) {
  try { return safeStorage.getItem(scopeKey(key)); } catch { return null; }
}

export function scopedGet(key, defaultValue = null) {
  const storageKey = scopeKey(key);
  let raw = null;
  try { raw = safeStorage.getItem(storageKey); } catch { raw = null; }
  const cached = scopedCache.get(storageKey);
  if (cached && cached.raw === raw) return cached.value;
  let value = defaultValue;
  if (raw !== null) {
    try { value = JSON.parse(raw); } catch { value = defaultValue; }
  }
  scopedCache.set(storageKey, { raw, value });
  return value;
}

export function scopedSet(key, value) {
  const storageKey = scopeKey(key);
  try {
    const raw = JSON.stringify(value);
    safeStorage.setItem(storageKey, raw);
    scopedCache.set(storageKey, { raw, value });
  } catch {}
}

export function scopedRemove(key) {
  const storageKey = scopeKey(key);
  try { safeStorage.removeItem(storageKey); } catch {}
  scopedCache.delete(storageKey);
}

