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

export function scopedGet(key, defaultValue = null) {
  try {
    const v = safeStorage.getItem(scopeKey(key));
    return v !== null ? JSON.parse(v) : defaultValue;
  } catch { return defaultValue; }
}

export function scopedSet(key, value) {
  try { safeStorage.setItem(scopeKey(key), JSON.stringify(value)); } catch {}
}

export function scopedRemove(key) {
  try { safeStorage.removeItem(scopeKey(key)); } catch {}
}

// One-time migration from global keys -> scoped keys.
// Runs after login (pubkey known). Idempotent.
export function migrateGlobalKeys() {
  const pk = getActivePubkey();
  if (!pk || pk === 'guest') return;

  const marker = `cipher_migrated_v1_${pk.slice(0, 8)}`;
  if (safeStorage.getItem(marker)) return;

  const keys = [
    'pinned', 'archived', 'muted', 'muted_until',
    'blocked', 'bookmarks', 'msg_edits', 'join_requests',
    'accepted_reqs', 'is_vendor', 'my_products', 'cached_products',
    'btc_address', 'xmr_address', 'my_username', 'rep_profile_cache',
  ];

  for (const k of keys) {
    const g = `cipher_${k}`;
    const val = safeStorage.getItem(g);
    if (val !== null) {
      const scoped = `cipher_${pk.slice(0, 8)}_${k}`;
      if (!safeStorage.getItem(scoped)) {
        safeStorage.setItem(scoped, val);
      }
      safeStorage.removeItem(g);
    }
  }

  // Migrate drafts
  const toMove = [];
  for (let i = 0; i < safeStorage.length; i++) {
    const k = safeStorage.key(i);
    if (k && (k.startsWith('draft-dm-') || k.startsWith('draft-group-'))) {
      toMove.push(k);
    }
  }
  for (const k of toMove) {
    const val = safeStorage.getItem(k);
    const scoped = `cipher_${pk.slice(0, 8)}_${k}`;
    if (val !== null && !safeStorage.getItem(scoped)) {
      safeStorage.setItem(scoped, val);
    }
    safeStorage.removeItem(k);
  }

  safeStorage.setItem(marker, '1');
  console.log('[storage] migrated global keys for', pk.slice(0, 8));
}
