// A stored message is the event as received, plus `localPatch`: the fields this
// device changed afterwards, such as an order's status, coin amount, and
// payment addresses. A history fetch brings the original event back, so the
// patch is laid over it again. Otherwise a reload undoes what the vendor did.
export function mergeStoredMessage(existing, incoming, chatId) {
  const merged = { ...existing, ...incoming, chatId };
  if (incoming?.deliveryStatus === undefined && existing?.deliveryStatus) {
    merged.deliveryStatus = existing.deliveryStatus;
  }
  const patch = { ...(existing?.localPatch || {}), ...(incoming?.localPatch || {}) };
  if (Object.keys(patch).length) {
    merged.localPatch = patch;
    merged.data = { ...(incoming?.data ?? existing?.data ?? {}), ...patch };
  }
  return merged;
}

export function patchStoredMessage(existing, patch) {
  if (!existing) return null;
  return mergeStoredMessage(existing, { localPatch: patch }, existing.chatId);
}
