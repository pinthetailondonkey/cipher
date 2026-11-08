import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { finalizeEvent } from 'nostr-tools/pure';
import { db, openDBFor, saveMessageOnce } from '../db.js';
import { setAtRestKeyProvider } from './messageAtRest.js';

const owner = `dm-effect-test-${Date.now()}`;
const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index + 41);

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};

function signedEvent(content, kind = 1059) {
  return finalizeEvent({ kind, created_at: 1_700_000_000, tags: [], content }, secretKey);
}

test('cross-tab retries reserve one immutable signed event atomically and recover it after interruption', async () => {
  openDBFor(owner);
  await db.open();
  setAtRestKeyProvider(() => vaultKey);
  const [tabA, tabB] = await Promise.all([
    import('./idempotentMessageEffect.js?tab=a'),
    import('./idempotentMessageEffect.js?tab=b'),
  ]);
  const firstEvent = signedEvent('first signed application effect');
  const competingEvent = signedEvent('competing second effect');
  const key = 'receipt-countersign-v1|peer|order|receipt-hash';

  const [first, second] = await Promise.all([
    tabA.reserveMessageEffect({ owner, idempotencyKey: key, intent: 'same receipt effect', event: firstEvent, relays: ['wss://relay.invalid'] }),
    tabB.reserveMessageEffect({ owner, idempotencyKey: key, intent: 'same receipt effect', event: competingEvent, relays: ['wss://relay.invalid'] }),
  ]);
  assert.equal(first.eventId, second.eventId);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal([first.event, second.event].filter((event) => event?.id === firstEvent.id).length, 2);
  assert.equal(await db.messageEffects.count(), 1);
  assert.equal(await db.outbox.count(), 1);

  // A reload/retry after the network may have been interrupted retrieves the
  // same event from durable state instead of signing a replacement.
  const retry = await tabB.reserveMessageEffect({ owner, idempotencyKey: key, intent: 'same receipt effect', event: competingEvent });
  assert.equal(retry.event.id, firstEvent.id);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.created, false);
  await assert.rejects(tabB.reserveMessageEffect({
    owner, idempotencyKey: key, intent: 'different receipt effect', event: competingEvent,
  }), /reused for a different message effect/);

  await tabA.completeMessageEffect({ owner, eventId: first.eventId });
  const deliveredRetry = await tabB.reserveMessageEffect({ owner, idempotencyKey: key, intent: 'same receipt effect', event: competingEvent });
  assert.equal(deliveredRetry.status, 'sent');
  assert.equal(deliveredRetry.event, null);
  assert.equal(await db.outbox.count(), 0);
});

test('group sends also reserve one immutable signed kind-9 event per client id', async () => {
  const [tabA, tabB] = await Promise.all([
    import('./idempotentMessageEffect.js?group=a'),
    import('./idempotentMessageEffect.js?group=b'),
  ]);
  const key = 'group-message-v1|account|group|client-id';
  const firstCandidate = signedEvent('group ciphertext A', 9);
  const secondCandidate = signedEvent('group ciphertext B', 9);
  const [first, second] = await Promise.all([
    tabA.reserveMessageEffect({ owner, idempotencyKey: key, intent: 'same group message', event: firstCandidate, relays: ['wss://group.invalid'] }),
    tabB.reserveMessageEffect({ owner, idempotencyKey: key, intent: 'same group message', event: secondCandidate, relays: ['wss://group.invalid'] }),
  ]);
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.event.kind, 9);
  assert.equal(second.event.id, first.eventId);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  await tabA.completeMessageEffect({ owner, eventId: first.eventId });
});

test('duplicate incoming event insertion is atomic across independent tab realms and respects tombstones', async () => {
  const [tabA, tabB] = await Promise.all([
    import('../db.js?message-tab=a'),
    import('../db.js?message-tab=b'),
  ]);
  const message = { id: 'incoming-once', timestamp: 7, pubkey: 'peer', data: { type: 'text', message: 'hello' } };
  const [a, b] = await Promise.all([
    tabA.saveMessageOnce('peer', message),
    tabB.saveMessageOnce('peer', message),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['exists', 'inserted']);
  assert.equal((await db.messages.where('id').equals(message.id).count()), 1);

  await db.tombstones.put({ id: 'deleted-before-delivery', chatId: 'peer', at: Date.now() });
  assert.equal((await saveMessageOnce('peer', { ...message, id: 'deleted-before-delivery' })).status, 'tombstoned');
});

test('a write-ahead failure cannot leave an effect reservation without its event', async () => {
  const [tab] = await Promise.all([import('./idempotentMessageEffect.js?failure=tab')]);
  const effectsBefore = await db.messageEffects.count();
  const outboxBefore = await db.outbox.count();
  const originalAdd = db.outbox.add;
  db.outbox.add = async () => { throw new Error('simulated outbox write failure'); };
  try {
    await assert.rejects(tab.reserveMessageEffect({
      owner,
      idempotencyKey: 'failure-atomicity',
      intent: 'failure-atomicity',
      event: signedEvent('must roll back'),
    }), /simulated outbox write failure/);
  } finally {
    db.outbox.add = originalAdd;
  }
  assert.equal(await db.messageEffects.count(), effectsBefore, 'the failed transaction leaves no partial journal row');
  assert.equal(await db.outbox.count(), outboxBefore, 'the failed transaction leaves no partial outbox event');
});
