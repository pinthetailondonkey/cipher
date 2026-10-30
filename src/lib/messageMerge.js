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
  // The receipt's direction mark is this device's own decision about ONE
  // receipt, written where the order-binding gate accepted it (useNIP44DM).
  // The relay copy never carries it, and `data` is replaced above, so without
  // this the mark would survive only when the gate happens to say yes again on
  // the same history pass — a reload could change an order's tab. Carry it
  // forward for the SAME receipt, by hash: the mark names one receipt, never a
  // slot, and a row that never had one never gains one here.
  const held = existing?.data?.receipt;
  const arriving = incoming?.data?.receipt;
  if (held?.bound === true && arriving?.hash && arriving.hash === held.hash) {
    merged.data = { ...merged.data, receipt: { ...arriving, bound: true } };
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

// A send first lives under a temporary id (`temp-...`, also its clientId) and
// is saved again under the real event id once that is known. The temporary
// row has to go when that happens, or it sits next to the real one as a
// 'sending' bubble for good. Returns the temp id a saved message replaces.
export function replacedTempId(message) {
  const clientId = message?.clientId;
  if (!message?.isSender || typeof clientId !== 'string' || !clientId.startsWith('temp-')) return null;
  return clientId !== message.id ? clientId : null;
}

// Temporary rows left behind by a send that never finished. A row is settled
// by what exists beside it: a real row with its clientId (delete the temp), an
// outbox event carrying its clientId (the retry will deliver it: show
// 'queued'), or nothing (the app closed before the message was signed: show
// 'failed' so Retry is offered). Rows newer than `graceMs` may be sending right
// now and are left alone; 'securing' rows wait for a group key on purpose.
export function planTempSweep(rows, outboxEvents, now = Date.now(), graceMs = 120000) {
  const plan = { remove: [], queued: [], failed: [] };
  const realByClient = new Set();
  for (const row of rows || []) {
    if (row?.clientId && row.id !== row.clientId) realByClient.add(row.clientId);
  }
  const outboxClients = new Set();
  for (const event of outboxEvents || []) {
    const tag = (event?.tags || []).find((t) => t[0] === 'client');
    if (tag?.[1]) outboxClients.add(tag[1]);
  }
  for (const row of rows || []) {
    if (!row?.isSender || typeof row.id !== 'string' || !row.id.startsWith('temp-') || row.clientId !== row.id) continue;
    if (realByClient.has(row.id)) { plan.remove.push(row.id); continue; }
    if (row.deliveryStatus !== 'sending') continue;
    const born = Number(row.local_timestamp) || Number(row.id.split('-')[1]) || 0;
    if (now - born < graceMs) continue;
    if (outboxClients.has(row.id)) plan.queued.push(row.id);
    else plan.failed.push(row.id);
  }
  return plan;
}
