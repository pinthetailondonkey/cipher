import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { finalizeEvent } from 'nostr-tools/pure';
import { db, markSentMessagesRead, openDBFor, patchMessage, retireAccountDatabaseContexts,
  retireDatabaseSecurityContext, saveMessage, saveMessageOnce, waitForSecurityContextActivation } from '../db.js';
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

test('the account database aborts a transaction when its captured context expires before a write', async () => {
  const fencedOwner = 'f'.repeat(64);
  let current = true;
  const fence = {
    context: { owner: fencedOwner, incarnation: 'db-fence-test-incarnation-0001' },
    assertCurrent() {
      if (!current) throw Object.assign(new Error('The account security context has expired.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
    },
  };
  openDBFor(fencedOwner, fence);
  await db.open();
  await assert.rejects(db.transaction('rw', 'profiles', async () => {
    await Promise.resolve();
    current = false;
    await db.profiles.put({ pubkey: 'stale-profile', name: 'must not commit' });
  }), { code: 'SECURITY_CONTEXT_EXPIRED' });
  assert.equal(await db.profiles.get('stale-profile'), undefined);
  openDBFor(owner);
  await db.open();
});

test('live account DB write transactions serialize with context retirement and reject later direct writes', async () => {
  const fencedOwner = 'd'.repeat(64);
  const context = { owner: fencedOwner, incarnation: 'live-db-race-context-0001' };
  const fence = { context, assertCurrent() {} };
  openDBFor(fencedOwner, fence);
  await db.open();

  const firstWrite = db.transaction('rw', 'outbox', async () => {
    await db.outbox.put({ id: 'before-retire', kind: 1059, created_at: 1, queuedAt: 1 });
  });
  const retirement = retireDatabaseSecurityContext(context);
  await firstWrite;
  assert.deepEqual(await retirement, { retired: true });
  await assert.rejects(db.outbox.put({ id: 'after-retire', kind: 1059, created_at: 2, queuedAt: 2 }), {
    code: 'SECURITY_CONTEXT_EXPIRED',
  });
  assert.deepEqual((await db.outbox.toArray()).map(({ id }) => id), ['before-retire']);
  openDBFor(owner);
  await db.open();
});

test('account-wide removal and wipe helper retires every owner marker in the live account database', async () => {
  const fencedOwner = 'b'.repeat(64);
  const context = { owner: fencedOwner, incarnation: 'owner-wide-retire-context-0001' };
  const fence = { context, assertCurrent() {} };
  openDBFor(fencedOwner, fence);
  await db.open();

  const retired = await retireAccountDatabaseContexts(fencedOwner);
  assert.equal(retired.retired, true);
  await assert.rejects(db.transaction('rw', 'outbox', async () => {
    await db.outbox.put({ id: 'must-not-write', kind: 1059, created_at: 3, queuedAt: 3 });
  }), { code: 'SECURITY_CONTEXT_EXPIRED' });
  assert.equal(await db.outbox.get('must-not-write'), undefined);
  openDBFor(owner);
  await db.open();
});

test('message-effect reservation aborts when its account context expires during the IndexedDB read', async () => {
  const fencedOwner = 'c'.repeat(64);
  let assertions = 0;
  const fence = {
    context: { owner: fencedOwner, incarnation: 'message-effect-race-incarnation' },
    assertCurrent() {
      assertions += 1;
      if (assertions >= 5) {
        throw Object.assign(new Error('The account security context has expired.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
      }
    },
  };
  openDBFor(fencedOwner, fence);
  await db.open();
  assertions = 0; // Exclude openDBFor's initial context check.
  const { reserveMessageEffect } = await import('./idempotentMessageEffect.js?expired-reservation');
  const event = signedEvent('retired context must not reserve', 9);
  await assert.rejects(reserveMessageEffect({
    owner: fencedOwner,
    idempotencyKey: 'group-message-v1|race|group|client',
    intent: 'group message',
    event,
    securityFence: fence,
  }), { code: 'SECURITY_CONTEXT_EXPIRED' });
  assert.equal(await db.messageEffects.count(), 0);
  assert.equal(await db.outbox.count(), 0);
  openDBFor(owner);
  await db.open();
});

test('a pending plaintext-at-rest row is not flushed by a later account incarnation', async () => {
  const fencedOwner = 'e'.repeat(64);
  let oldCurrent = true;
  const oldFence = {
    context: { owner: fencedOwner, incarnation: 'old-at-rest-incarnation-0001' },
    assertCurrent() { if (!oldCurrent) throw Object.assign(new Error('expired'), { code: 'SECURITY_CONTEXT_EXPIRED' }); },
  };
  const nextFence = { context: { owner: fencedOwner, incarnation: 'next-at-rest-incarnation-0002' }, assertCurrent() {} };
  openDBFor(fencedOwner, oldFence);
  await db.open();
  setAtRestKeyProvider(() => null);
  await db.messages.put({ id: 'old-incarnation-pending', chatId: 'peer', data: { message: 'private' } });
  oldCurrent = false;
  openDBFor(fencedOwner, nextFence);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await db.messages.get('old-incarnation-pending'), undefined);
  setAtRestKeyProvider(() => vaultKey);
  openDBFor(owner);
  await db.open();
});

test('message merge, patch and read-receipt crypto is prepared outside fenced write transactions', async () => {
  const fencedOwner = '8'.repeat(64);
  const fence = {
    context: { owner: fencedOwner, incarnation: 'message-crypto-incarnation-0001' },
    assertCurrent() {},
  };
  openDBFor(fencedOwner, fence);
  await waitForSecurityContextActivation();
  setAtRestKeyProvider(() => vaultKey);

  const message = { id: 'crypto-commit-message', chatId: 'peer', timestamp: 10, isSender: true,
    deliveryStatus: 'sent', data: { message: 'before patch' } };
  await saveMessage('peer', message);
  const stored = await db.table('messages').get(message.id);
  assert.equal(stored.data, undefined);
  assert.equal(typeof stored.sealed?.ct, 'string');
  assert.equal((await db.messages.get(message.id)).data.message, 'before patch');
  assert.equal(await patchMessage(message.id, { message: 'after patch', edited: true }), true);
  assert.equal((await db.messages.get(message.id)).data.message, 'after patch');
  assert.deepEqual(await markSentMessagesRead('peer', 10), [message.id]);
  const read = await db.messages.get(message.id);
  assert.equal(read.deliveryStatus, 'read');
  assert.equal(read.read, true);
  openDBFor(owner);
  await db.open();
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
  // Each independently imported module realm must open explicitly. Production
  // code cannot infer an authenticated database handle from the owner string.
  tabA.openDBFor(owner);
  tabB.openDBFor(owner);
  await Promise.all([tabA.db.open(), tabB.db.open()]);
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
