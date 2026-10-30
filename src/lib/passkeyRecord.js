// The saved-passkey door asks one question: would the unlock path find a usable
// passkey record on this device? unlockWithBiometric reads ONE key —
// cipher_passkey_<pubkey> at the active pubkey first, else the biometric
// pointer — so the door tests that exact key and a record-shaped value.
// Not session state: hasBiometric can lag a reload. Not just any
// cipher_passkey_* entry: a record saved for a different account would
// show a door that always fails with "No passkey identity found on this
// device". A record here recovers this device only; a brand-new phone
// needs the 12 words.
export function hasStoredPasskey(storage) {
  try {
    const pk = storage.getItem('cipher_active_pubkey') || storage.getItem('cipher_biometric_pubkey');
    if (!pk) return false;
    const raw = storage.getItem(`cipher_passkey_${pk}`);
    if (!raw) return false;
    try { return !!JSON.parse(raw)?.pubkey; } catch { return false; }
  } catch { /* storage unreadable: no door */ }
  return false;
}

// A record on this device is only half the question. The unlock asks the
// authenticator for a PRF result, so a browser or device that cannot do PRF
// fails no matter what is stored — the door would be a trap that always ends
// in "No passkey identity found". Both halves must hold, and a capability
// check that throws counts as no support, never as support.
export async function canOpenWithPasskey(storage, supportCheck) {
  if (!hasStoredPasskey(storage)) return false;
  try {
    return typeof supportCheck === 'function' ? (await supportCheck()) === true : false;
  } catch {
    return false;
  }
}
