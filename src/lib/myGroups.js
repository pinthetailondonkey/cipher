// src/lib/myGroups.js
// Per-pubkey joined-group list. Replaces the global `cipher_my_groups`
// localStorage key that caused cross-account group leakage.

const PREFIX = 'cipher_my_groups_';

export function getMyGroups(pubkey) {
  if (!pubkey) return [];
  try {
    const raw = localStorage.getItem(PREFIX + pubkey.slice(0, 16));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function setMyGroups(pubkey, groups) {
  if (!pubkey) return;
  try {
    localStorage.setItem(PREFIX + pubkey.slice(0, 16), JSON.stringify(groups || []));
  } catch {}
}

// One-time: drop the legacy unscoped key so it stops polluting any account.
try { localStorage.removeItem('cipher_my_groups'); } catch {}
