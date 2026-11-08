import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicKey, nip44, nip59 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { conversationKey } from './dmKeys.js';
import { openDmTransportEvent } from './giftUnwrap.js';
import { rumorTags, sealAndWrap } from './giftWrap.js';

test('historical NIP-44/NIP-59 attachment and commerce payloads remain readable as-is', () => {
  const senderSecret = generateSecretKey();
  const recipientSecret = generateSecretKey();
  const senderPubkey = getPublicKey(senderSecret);
  const recipientPubkey = getPublicKey(recipientSecret);
  const legacyPayload = {
    type: 'order_request',
    orderId: 'legacy-order-27',
    item: { title: 'Encrypted attachment order' },
    attachment: { url: 'https://blob.example/legacy-ciphertext', key: 'historical-message-key' },
    coinAmount: '0.12500000',
    coin: 'BTC',
  };
  const content = nip44.v2.encrypt(
    JSON.stringify(legacyPayload),
    conversationKey(senderSecret, recipientPubkey),
  );
  const rumor = nip59.createRumor({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags({ recipient: recipientPubkey, clientId: 'legacy-client-event-27' }),
    content,
  }, senderSecret);
  const { wrap } = sealAndWrap(rumor, { senderSk: senderSecret, recipientPubkey });

  const opened = openDmTransportEvent(wrap, recipientSecret);
  assert.equal(opened?.id, rumor.id);
  assert.equal(opened?.pubkey, senderPubkey);
  assert.equal(opened?.tags.find(([name]) => name === 'client')?.[1], 'legacy-client-event-27');
  assert.deepEqual(
    JSON.parse(nip44.v2.decrypt(opened.content, conversationKey(recipientSecret, senderPubkey))),
    legacyPayload,
  );

  const historicalBare = finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags({ recipient: recipientPubkey, clientId: 'legacy-bare-28' }),
    content: nip44.v2.encrypt(JSON.stringify({ type: 'receipt', orderId: 'legacy-order-28' }),
      conversationKey(senderSecret, recipientPubkey)),
  }, senderSecret);
  const openedBare = openDmTransportEvent(historicalBare, recipientSecret);
  assert.ok(openedBare, 'historical signed kind-4 events remain readable');
  assert.deepEqual(
    JSON.parse(nip44.v2.decrypt(openedBare.content, conversationKey(recipientSecret, senderPubkey))),
    { type: 'receipt', orderId: 'legacy-order-28' },
  );
});
