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

export function scopeKey(key) {
  const pk = getActivePubkey();
  const safePk = typeof pk === 'string' && pk.length > 0 ? pk : 'guest';
  return `cipher_${safePk.slice(0, 8)}_${key}`;
}

const scopedCache = new Map();

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

