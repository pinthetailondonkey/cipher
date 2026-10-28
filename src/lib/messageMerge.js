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
  // A read mark only moves forward: the relay copy of our own message is
  // always re-saved as 'sent', and that must not undo a tick the peer earned.
  if (existing?.deliveryStatus === 'read' && incoming?.deliveryStatus !== undefined && incoming.deliveryStatus !== 'read') {
    merged.deliveryStatus = 'read';
    merged.read = true;
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

// The rows a peer's read receipt covers: our own messages in that chat sent at
// or before the receipt's time. A message sent after the receipt is not read
// yet. Returns changed copies only; the caller writes them.
export function markReadThrough(messages, upTo) {
  if (!Array.isArray(messages) || !Number.isFinite(upTo)) return [];
  return messages
    .filter((m) => m && m.isSender && m.deliveryStatus !== 'read' && Number(m.timestamp) <= upTo
      && m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed')
    .map((m) => ({ ...m, deliveryStatus: 'read', read: true }));
}

// The time a receipt speaks for. The event's signed time bounds the sender's
// own claim, so a receipt can never mark messages from its future.
export function receiptTime(data, eventCreatedAt) {
  const claimed = Number(data?.at);
  const signed = Number(eventCreatedAt);
  if (Number.isFinite(claimed) && Number.isFinite(signed)) return Math.min(claimed, signed);
  if (Number.isFinite(signed)) return signed;
  return Number.isFinite(claimed) ? claimed : NaN;
}
