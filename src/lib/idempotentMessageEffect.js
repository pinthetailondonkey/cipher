// Durable idempotency for application-level message effects. IndexedDB is the
// cross-tab arbiter. The signed event is immutable once reserved, so retries
// after a crash or uncertain relay acknowledgement can only reuse its id.
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent } from 'nostr-tools/pure';
import { currentOwner, db } from '../db.js';

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function digest(value) {
  return hex(sha256(new TextEncoder().encode(`cipher-message-effect-v1|${value}`)));
}

function outboxRow(event, now, relays, effectKey) {
  return {
    id: event.id,
    kind: event.kind,
    event,
    effectKey,
    attempts: 0,
    nextRetryAt: 0,
    status: 'queued',
    queuedAt: now,
    created_at: event.created_at,
    ...(Array.isArray(relays) && relays.length ? { relays } : {}),
  };
}

export async function reserveMessageEffect({ owner, idempotencyKey, intent = '', event, relays = null, now = Date.now() }) {
  if (!owner || currentOwner() !== owner) throw new Error('The account database is not open.');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 65536) {
    throw new Error('A valid message effect key is required.');
  }
  if (!event || ![9, 1059].includes(event.kind) || !verifyEvent(event)) {
    throw new Error('The message effect must be a valid signed message or gift-wrap event.');
  }
  const effectKey = digest(`${owner}|${idempotencyKey}`);
  const intentHash = digest(String(intent));
  return db.transaction('rw', 'messageEffects', 'outbox', async () => {
    if (currentOwner() !== owner) throw new Error('The account changed before the message effect was reserved.');
    const existing = await db.messageEffects.get(effectKey);
    if (existing) {
      if (existing.intentHash !== intentHash || existing.kind !== event.kind) {
        throw new Error('The idempotency key was reused for a different message effect.');
      }
      if (existing.status === 'sent') return { status: 'sent', eventId: existing.eventId, event: null, relays: existing.relays || [], created: false };
      const queued = await db.outbox.get(existing.eventId);
      if (!queued || queued.effectKey !== effectKey || queued.kind !== existing.kind || queued.event?.id !== existing.eventId) {
        throw new Error('The pending message effect is missing its immutable outbox event; recovery is required.');
      }
      return { status: 'pending', eventId: existing.eventId, event: queued.event, relays: queued.relays || [], created: false };
    }
    await db.messageEffects.add({
      effectKey, eventId: event.id, kind: event.kind, intentHash,
      status: 'pending', createdAt: now, updatedAt: now, relays: relays || [],
    });
    await db.outbox.add(outboxRow(event, now, relays, effectKey));
    return { status: 'pending', eventId: event.id, event, relays: relays || [], created: true };
  });
}

export async function completeMessageEffect({ owner, eventId }) {
  if (!owner || currentOwner() !== owner || !eventId) throw new Error('The account database is not open.');
  return db.transaction('rw', 'messageEffects', 'outbox', async () => {
    if (currentOwner() !== owner) throw new Error('The account changed before the message effect was completed.');
    const row = await db.messageEffects.where('eventId').equals(eventId).first();
    if (!row) throw new Error('The durable message effect reservation is missing.');
    if (row.status !== 'sent') await db.messageEffects.put({ ...row, status: 'sent', updatedAt: Date.now() });
    const queued = await db.outbox.get(eventId);
    if (queued?.effectKey === row.effectKey) await db.outbox.delete(eventId);
    return true;
  });
}

export async function completeQueuedMessageEffect(owner, queued) {
  if (!queued?.effectKey) return false;
  if (!owner || currentOwner() !== owner) throw new Error('The account database is not open.');
  return db.transaction('rw', 'messageEffects', 'outbox', async () => {
    if (currentOwner() !== owner) throw new Error('The account changed before the queued message effect was completed.');
    const row = await db.messageEffects.get(queued.effectKey);
    if (!row || row.eventId !== queued.id || row.eventId !== queued.event?.id || row.kind !== queued.kind) {
      throw new Error('The queued message effect does not match its durable reservation.');
    }
    await db.messageEffects.put({ ...row, status: 'sent', updatedAt: Date.now() });
    const current = await db.outbox.get(queued.id);
    if (current?.effectKey === queued.effectKey) await db.outbox.delete(queued.id);
    return true;
  });
}
