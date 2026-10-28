// A stored message is the event as received, plus `localPatch`: the fields this
// device changed afterwards, such as an order's status, coin amount, and
// payment addresses. A history fetch brings the original event back, so the
// patch is laid over it again. Otherwise a reload undoes what the vendor did.
// A tombstoned id was deleted on this device: nothing is written for it,
// whatever copy the relay serves again. The caller skips the write on null.
export function mergeStoredMessage(existing, incoming, chatId, { tombstoned = false } = {}) {
  if (tombstoned) return null;
  const merged = { ...existing, ...incoming, chatId };
  if (incoming?.deliveryStatus === undefined && existing?.deliveryStatus) {
    merged.deliveryStatus = existing.deliveryStatus;
  }
  const patch = { ...(existing?.localPatch || {}), ...(incoming?.localPatch || {}) };
  if (Object.keys(patch).length) {
    merged.localPatch = patch;
    merged.data = { ...(incoming?.data ?? existing?.data ?? {}), ...patch };
    // The bubble reads the top-level flag, so an edit patch carries it up.
    if (patch.edited) merged.edited = true;
  }
  return merged;
}

export function patchStoredMessage(existing, patch) {
  if (!existing) return null;
  return mergeStoredMessage(existing, { localPatch: patch }, existing.chatId);
}
