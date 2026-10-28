// Which saved account the Unlock screen opens, and which one a wrong PIN is
// counted against. A draft (confirmed === false) is an account still being
// made: it is never the target of an unlock and never carries the wipe counter.
// If the device-wide pointer names a draft or a missing account, the newest
// finished account is used instead, so abandoning "Add account" can never
// lock the real account out.

export const isDraftEntry = (entry) => !!entry && entry.confirmed === false;

export function pickUnlockAccount(vaults, activePk, legacyVaultStr = null) {
  const table = vaults && typeof vaults === 'object' ? vaults : {};
  const finished = Object.entries(table).filter(([, entry]) => entry && entry.vault && !isDraftEntry(entry));
  const active = activePk && activePk !== 'guest' ? table[activePk] : null;
  if (active && active.vault && !isDraftEntry(active)) return { pk: activePk, vault: active.vault };
  if (finished.length > 0) {
    finished.sort((a, b) => (Number(b[1].createdAt) || 0) - (Number(a[1].createdAt) || 0));
    return { pk: finished[0][0], vault: finished[0][1].vault };
  }
  // A table with only drafts has no account to open. The single-vault slot
  // speaks only for installs that never had a table.
  if (Object.keys(table).length === 0 && legacyVaultStr) {
    try { return { pk: null, vault: JSON.parse(legacyVaultStr) }; } catch { return null; }
  }
  return null;
}

function readTable(storage) {
  try { return JSON.parse(storage.getItem('cipher_vaults') || '{}') || {}; } catch { return {}; }
}

// The 12 words were confirmed: the newest draft becomes a finished account
// and only now takes the device: the active pointer and the single-vault
// mirror (byte-identical to the entry's vault, which removeAccountVault
// matches by string) and the handle. Returns the account, or null.
export function confirmDraftAccount(storage) {
  const vaults = readTable(storage);
  const draft = Object.entries(vaults)
    .filter(([, entry]) => isDraftEntry(entry))
    .sort((x, y) => (Number(y[1].createdAt) || 0) - (Number(x[1].createdAt) || 0))[0];
  if (!draft) return null;
  const [pk, entry] = draft;
  vaults[pk] = { ...entry, confirmed: true };
  storage.setItem('cipher_vaults', JSON.stringify(vaults));
  storage.setItem('cipher_active_pubkey', pk);
  storage.setItem('cipher_vault', JSON.stringify(entry.vault));
  if (entry.handle) storage.setItem('cipher_handle', entry.handle);
  return { pk, entry: vaults[pk] };
}

// Whether the Unlock screen may count a saved passkey as a way in. A passkey
// whose account was never finished is not one.
export function passkeyOffered(storage) {
  if (storage.getItem('cipher_biometric_enabled') !== 'true') return false;
  const pk = storage.getItem('cipher_biometric_pubkey');
  return !(pk && isDraftEntry(readTable(storage)[pk]));
}
