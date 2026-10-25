import assert from 'node:assert/strict';
import test from 'node:test';
import {
  setAtRestKeyProvider, isSealedRow, trySealMessageRow, openMessageRow,
  queueAtRestWrite, takeAtRestWrites, requeueAtRestWrites, dropAtRestWrites,
} from './messageAtRest.js';

const SK = Uint8Array.from({ length: 32 }, (_, i) => i);

const row = () => ({
  id: 'm1',
  chatId: 'dm:peer',
  pubkey: 'peerpk',
  timestamp: 100,
  isSender: false,
  data: { type: 'text', message: 'the secret note' },
  deliveryStatus: 'sent',
});

test('a sealed row round-trips and its stored bytes never contain the plaintext', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await trySealMessageRow(row());
  assert.ok(isSealedRow(stored), 'the stored row carries a sealed envelope');
  // The schema indexes stay plaintext so queries keep working.
  assert.equal(stored.id, 'm1');
  assert.equal(stored.chatId, 'dm:peer');
  assert.equal(stored.timestamp, 100);
  assert.equal(stored.sealed.v, 1);
  // No plaintext anywhere in the stored form.
  const bytes = JSON.stringify(stored);
  for (const secret of ['the secret note', 'secret', 'sent']) {
    assert.equal(bytes.includes(secret), false, `stored bytes must not contain "${secret}"`);
  }
  const opened = await openMessageRow(stored);
  assert.equal(opened.data.message, 'the secret note');
  assert.equal(opened.deliveryStatus, 'sent');
  assert.equal('sealed' in opened, false, 'an opened row reads like the original row');
  assert.equal(opened.id, 'm1');
  assert.equal(opened.isSender, false);
});

test('a row with only indexed fields is written as it is', async () => {
  const bare = { id: 'b1', chatId: 'dm:x', timestamp: 1, isSender: true };
  assert.equal(await trySealMessageRow(bare), bare);
});

test('without the vault key nothing is sealed', async () => {
  setAtRestKeyProvider(() => null);
  assert.equal(await trySealMessageRow(row()), null, 'no sealing without the key — the caller must not write plaintext');
  const sealedBefore = await (async () => {
    setAtRestKeyProvider(() => SK);
    const sealed = await trySealMessageRow(row());
    setAtRestKeyProvider(() => null);
    return sealed;
  })();
  const locked = await openMessageRow(sealedBefore);
  assert.equal(locked.data, undefined, 'a locked row opens without its payload');
  assert.equal(locked.id, 'm1');
  assert.equal(locked.chatId, 'dm:peer');
  assert.equal(JSON.stringify(locked).includes('the secret note'), false);
  assert.ok(locked, 'a locked row is still a well-formed object, never a throw');
});

test('rows written before this change pass through unchanged', async () => {
  setAtRestKeyProvider(() => SK);
  const legacy = {
    id: 'old', chatId: 'dm:peer', timestamp: 1, isSender: false,
    data: { type: 'text', message: 'an old plaintext row' },
  };
  const seen = await openMessageRow(legacy);
  assert.equal(seen, legacy, 'a legacy row is handed back as stored');
  assert.equal(await trySealMessageRow(legacy) !== legacy, true, 'a re-saved legacy row gets sealed');
});

test('the seal is bound to the row: a moved or tampered row stays closed', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await trySealMessageRow(row());

  const moved = await openMessageRow({ ...stored, chatId: 'dm:other' });
  assert.equal(moved.data, undefined, 'a row moved to another chat cannot be opened');

  const tampered = await openMessageRow({
    ...stored,
    sealed: { ...stored.sealed, ct: stored.sealed.ct.slice(0, -4) + 'AAAA' },
  });
  assert.equal(tampered.data, undefined, 'a tampered row cannot be opened');
  assert.equal(tampered.id, 'm1', 'a locked row still identifies itself');
});

test('an interrupted flush puts its un-written rows back at the front', async () => {
  setAtRestKeyProvider(() => null);
  dropAtRestWrites('pk-r');
  queueAtRestWrite('pk-r', { id: 'w1' });
  queueAtRestWrite('pk-r', { id: 'w2' });
  const taken = takeAtRestWrites('pk-r');
  assert.deepEqual(taken, [{ id: 'w1' }, { id: 'w2' }], 'the take is consuming');
  // The flush requeues what it could not write (src/db.js flushAtRestWrites).
  requeueAtRestWrites('pk-r', taken.slice(1));
  queueAtRestWrite('pk-r', { id: 'w3' });
  assert.deepEqual(takeAtRestWrites('pk-r'), [{ id: 'w2' }, { id: 'w3' }],
    'requeued rows go ahead of rows written after the interruption');
  dropAtRestWrites('pk-r');
});

test('a requeue keeps the queue capped, never writes plaintext to disk', async () => {
  setAtRestKeyProvider(() => null);
  dropAtRestWrites('pk-cap');
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}` }));
  requeueAtRestWrites('pk-cap', rows);
  queueAtRestWrite('pk-cap', { id: 'after' });
  const taken = takeAtRestWrites('pk-cap');
  assert.equal(taken.length, 500, 'the queue stays at its cap');
  assert.equal(taken[0].id, 'c1', 'the cap drops the oldest waiting row, as a fresh write does');
  assert.equal(taken.at(-1).id, 'after', 'a write after the requeue still lands last');
  dropAtRestWrites('pk-cap');
});

test('writes that arrive with the vault locked wait in memory, per account', async () => {
  dropAtRestWrites('pk-a');
  dropAtRestWrites('pk-b');
  setAtRestKeyProvider(() => null);
  const blockedRow = { id: 'r1', chatId: 'dm:x', data: { message: 'in flight' } };
  queueAtRestWrite('pk-a', blockedRow);
  assert.deepEqual(takeAtRestWrites('pk-b'), [], 'another account never gets this row');
  assert.deepEqual(takeAtRestWrites('pk-a'), [blockedRow], 'the same account flushes it on unlock');
  assert.deepEqual(takeAtRestWrites('pk-a'), [], 'a flush is consuming');
  dropAtRestWrites('pk-a');
  queueAtRestWrite('pk-a', { id: 'r2' });
  dropAtRestWrites('pk-a');
  assert.deepEqual(takeAtRestWrites('pk-a'), [], 'deleting the account database drops its pending rows');
});
