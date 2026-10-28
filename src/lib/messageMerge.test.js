import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeStoredMessage, patchStoredMessage, markReadThrough, receiptTime } from './messageMerge.js';

const relayCopy = () => ({
  id: 'order-event',
  isSender: false,
  pubkey: 'buyer',
  timestamp: 100,
  data: { type: 'order_request', status: 'pending', paymentState: 'created', paymentMethod: 'btc', product: { title: 'Tee', priceUsd: '40' } },
});

test('a vendor order change survives the history fetch that rebuilds the chat', () => {
  const received = mergeStoredMessage(undefined, relayCopy(), 'buyer');
  const accepted = patchStoredMessage(received, {
    status: 'accepted',
    paymentState: 'address_issued',
    paymentMethods: { btc: 'bc1qorder' },
    coinAmount: '0.001',
    coinCurrency: 'btc',
  });
  const seen = patchStoredMessage(accepted, { paymentState: 'seen', paymentSeenBy: 'watcher' });
  // fetchDMs saves the event from the relay again, with its original data.
  const reloaded = mergeStoredMessage(seen, { ...relayCopy(), deliveryStatus: undefined, isGroup: false }, 'buyer');
  assert.equal(reloaded.data.type, 'order_request');
  assert.equal(reloaded.data.status, 'accepted');
  assert.equal(reloaded.data.paymentState, 'seen');
  assert.equal(reloaded.data.coinAmount, '0.001');
  assert.equal(reloaded.data.coinCurrency, 'btc');
  assert.deepEqual(reloaded.data.paymentMethods, { btc: 'bc1qorder' });
  assert.deepEqual(reloaded.data.product, { title: 'Tee', priceUsd: '40' });
  assert.equal(reloaded.chatId, 'buyer');
});

test('a message this device never changed is stored exactly as before', () => {
  const first = mergeStoredMessage(undefined, { id: 'm', data: { type: 'text', message: 'hi' }, deliveryStatus: 'sent' }, 'peer');
  const again = mergeStoredMessage(first, { id: 'm', data: { type: 'text', message: 'hi' } }, 'peer');
  assert.equal('localPatch' in again, false);
  assert.equal(again.deliveryStatus, 'sent');
  assert.deepEqual(again.data, { type: 'text', message: 'hi' });
  assert.equal(patchStoredMessage(undefined, { status: 'accepted' }), null);
});

test('signing in never clears the message table: each account has its own database', async () => {
  const fs = await import('node:fs');
  const bootstrap = fs.readFileSync(new URL('../features/chat/useChatBootstrap.js', import.meta.url), 'utf8');
  assert.equal(/db\.messages\.clear\(/.test(bootstrap), false);
  assert.equal(/db\.chatReads\.clear\(/.test(bootstrap), false);
  assert.equal(bootstrap.includes('cipher_last_user'), false);
});

test('a deleted message is not written again when the relay copy is re-saved', async () => {
  const relay = { id: 'gone', isSender: false, timestamp: 5, data: { type: 'text', message: 'delete me' } };
  assert.equal(mergeStoredMessage(undefined, relay, 'peer', { tombstoned: true }), null);
  assert.equal(mergeStoredMessage({ ...relay, chatId: 'peer' }, relay, 'peer', { tombstoned: true }), null);
  assert.ok(mergeStoredMessage(undefined, relay, 'peer'));
  const fs = await import('node:fs');
  const db = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  const commands = fs.readFileSync(new URL('../features/chat/useMessageCommands.js', import.meta.url), 'utf8');
  const bootstrap = fs.readFileSync(new URL('../features/chat/useChatBootstrap.js', import.meta.url), 'utf8');
  assert.match(db, /tombstones: 'id, chatId'/);
  assert.match(db, /mergeStoredMessage\(existing, msg, chatId, \{ tombstoned: !!tombstone \}\)/);
  assert.match(db, /db\.tombstones\.put\(\{ id, chatId/);
  assert.match(commands, /await deleteMessageForGood\(id,/);
  assert.equal(/db\.messages\.delete\(id\)/.test(commands), false);
  assert.match(bootstrap, /kinds: \[5\], authors: \[identity\.pk\]/);
  assert.match(bootstrap, /\(await deletedMessageIds\(\)\)\.forEach\(\(id\) => deleted\.add\(id\)\)/);
});

test('a local edit survives the history fetch that serves the original text again', async () => {
  const original = () => ({ id: 'm-edit', isSender: true, pubkey: 'me', timestamp: 10, data: { type: 'text', message: 'original' } });
  const stored = mergeStoredMessage(undefined, original(), 'peer');
  const edited = patchStoredMessage(stored, { message: 'EDITED', edited: true });
  assert.equal(edited.data.message, 'EDITED');
  assert.equal(edited.edited, true);
  const refetched = mergeStoredMessage(edited, original(), 'peer');
  assert.equal(refetched.data.message, 'EDITED');
  assert.equal(refetched.data.edited, true);
  assert.equal(refetched.edited, true);
  const fs = await import('node:fs');
  const commands = fs.readFileSync(new URL('../features/chat/useMessageCommands.js', import.meta.url), 'utf8');
  assert.match(commands, /patchMessage\(msg\.id, \{ message: newText, edited: true \}\)/);
  assert.equal(/db\.messages\.put\(updated\)/.test(commands), false);
});

test('a read tick survives the history fetch that re-saves our message as sent', () => {
  const relay = () => ({ id: 'm-read', isSender: true, pubkey: 'me', timestamp: 10, data: { type: 'text', message: 'hi' }, deliveryStatus: 'sent' });
  const [ticked] = markReadThrough([mergeStoredMessage(undefined, relay(), 'peer')], 20);
  assert.equal(ticked.deliveryStatus, 'read');
  const refetched = mergeStoredMessage(ticked, relay(), 'peer');
  assert.equal(refetched.deliveryStatus, 'read');
  assert.equal(refetched.read, true);
});

test('a read receipt covers only our messages at or before its time', () => {
  const rows = [
    { id: 'a', isSender: true, timestamp: 10, deliveryStatus: 'sent' },
    { id: 'b', isSender: true, timestamp: 20, deliveryStatus: 'sent' },
    { id: 'c', isSender: true, timestamp: 21, deliveryStatus: 'sent' },
    { id: 'd', isSender: false, timestamp: 5 },
    { id: 'e', isSender: true, timestamp: 1, deliveryStatus: 'failed' },
  ];
  assert.deepEqual(markReadThrough(rows, 20).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(markReadThrough(rows, NaN), []);
  assert.equal(receiptTime({ at: 50 }, 40), 40);
  assert.equal(receiptTime({ at: 30 }, 40), 30);
  assert.equal(receiptTime({}, 40), 40);
});
