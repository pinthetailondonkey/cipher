// One account's entry in this device's vault table. Restoring by handle and
// PIN re-admits an account the device already has, so the entry must come
// back with everything it carried before: the encrypted 12 words
// (mnemonicEnc), any device envelope, and the metadata the account screens
// read. Rebuilding the entry from the four fields a restore knows used to
// drop the rest — the account opened, and its recovery words were gone from
// this device. Only the fields a restore actually owns are overwritten.
export function mergeRestoredEntry(prior, { vault, handle, now }) {
  const previous = prior && typeof prior === 'object' ? prior : {};
  return {
    ...previous,
    // The vault is the one thing the restore re-reads, from the entry or the
    // legacy single-vault key, after the PIN opened it.
    vault,
    handle: handle || previous.handle || '',
    displayName: previous.displayName || handle || '',
    createdAt: previous.createdAt || now,
    // This path only re-admits accounts the user can already PIN-unlock on
    // this device, so an entry is never downgraded back to a draft.
    confirmed: true,
  };
}
