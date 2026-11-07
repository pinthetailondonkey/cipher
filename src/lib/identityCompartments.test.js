import assert from 'node:assert/strict';
import test from 'node:test';
import { nip59 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { setSessionKey, clearSessionKey } from './sessionKey.js';
import { buildVendorCardEvent } from './vendorCard.js';
import { createDeviceCredential, buildDeviceRegistryEvent } from './deviceEnrollment.js';
import { buildSignedAct } from './crypto/gmIdentityWire.js';
import { forgetActors } from './crypto/gmIdentity.js';
import { rumorTags, sealAndWrap } from './giftWrap.js';

const ACCOUNT_SECRET = new Uint8Array(32).fill(23);
const ACCOUNT = getPublicKey(ACCOUNT_SECRET);

test('group relay signatures use distinct group actors and omit the account key', async () => {
  clearSessionKey();
  forgetActors();
  setSessionKey(ACCOUNT_SECRET);
  try {
    const makeEvent = (groupId) => buildSignedAct({
      identity: { sk: ACCOUNT_SECRET, pk: ACCOUNT },
      groupId,
      content: 'sealed-group-body',
      tags: [['h', groupId]],
      createdAt: 1_800_000_000,
    });
    const alpha = await makeEvent('privacy-alpha');
    const beta = await makeEvent('privacy-beta');
    assert.ok(alpha && beta);
    assert.notEqual(alpha.pubkey, beta.pubkey, 'two groups expose separate actor keys');
    assert.notEqual(alpha.pubkey, ACCOUNT, 'a group event is not account-signed');
    assert.notEqual(beta.pubkey, ACCOUNT, 'a second group event is not account-signed');
    assert.equal(JSON.stringify(alpha).includes(ACCOUNT), false);
    assert.equal(JSON.stringify(beta).includes(ACCOUNT), false);
  } finally {
    clearSessionKey();
    forgetActors();
  }
});

test('a DM relay sees the recipient account key but not the sender account key', () => {
  const recipientSecret = generateSecretKey();
  const recipient = getPublicKey(recipientSecret);
  const rumor = nip59.createRumor({
    kind: 4,
    created_at: 1_800_000_000,
    tags: rumorTags({ recipient }),
    content: 'encrypted-rumor-body',
  }, ACCOUNT_SECRET);
  const { wrap } = sealAndWrap(rumor, { senderSk: ACCOUNT_SECRET, recipientPubkey: recipient });
  const wire = JSON.stringify(wrap);
  assert.equal(wrap.kind, 1059);
  assert.notEqual(wrap.pubkey, ACCOUNT, 'the outer wrap uses its throwaway signing key');
  assert.deepEqual(wrap.tags.map(([name]) => name).sort(), ['expiration', 'p']);
  assert.ok(wire.includes(recipient), 'the relay needs the recipient routing address');
  assert.equal(wire.includes(ACCOUNT), false, 'the sender identity stays inside the seal');
});

test('public merchant events intentionally identify the account; device registries must stay private', async () => {
  const card = await buildVendorCardEvent({ name: 'Public shop' }, ACCOUNT_SECRET, 1_800_000_000_000);
  assert.equal(card.pubkey, ACCOUNT, 'the current storefront is intentionally account-linked');

  const device = createDeviceCredential();
  const registry = buildDeviceRegistryEvent({
    accountSecret: ACCOUNT_SECRET,
    generation: 1,
    devices: [{
      deviceId: device.deviceId,
      pubkey: device.devicePubkey,
      status: 'active',
      enrolledAt: 1_800_000_000,
    }],
  }, 1_800_000_000);
  assert.equal(registry.pubkey, ACCOUNT);
  assert.ok(registry.content.includes(device.devicePubkey));
  assert.ok(registry.content.includes(ACCOUNT));
  assert.equal(registry.kind, 30082);
  // The registry is currently local protocol data. Publishing this signed
  // record to an ordinary relay would create a direct account↔device join.
  assert.notEqual(device.devicePubkey, ACCOUNT);
  device.deviceSecret.fill(0);
});
