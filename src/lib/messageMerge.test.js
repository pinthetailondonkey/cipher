import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeStoredMessage, patchStoredMessage } from './messageMerge.js';

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
