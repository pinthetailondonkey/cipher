import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildDeviceRegistryEvent } from './deviceEnrollment.js';
import { buildPrivateDeviceRegistryWrap, openPrivateDeviceRegistryWrap } from './deviceRegistryWire.js';

test('device registry reaches a contact inside a sender-hidden envelope, not in relay-visible fields', () => {
  const senderSecret = generateSecretKey();
  const sender = getPublicKey(senderSecret);
  const recipientSecret = generateSecretKey();
  const recipient = getPublicKey(recipientSecret);
  const devicePubkey = getPublicKey(generateSecretKey());
  const now = Math.floor(Date.now() / 1000);
  const registryEvent = buildDeviceRegistryEvent({
    accountSecret: senderSecret,
    generation: 1,
    devices: [{ deviceId: 'd'.repeat(32), pubkey: devicePubkey, status: 'active', enrolledAt: now - 1 }],
  }, now - 1);
  const wrap = buildPrivateDeviceRegistryWrap({ registryEvent, senderSecret, recipientPubkey: recipient, now });
  const wire = JSON.stringify(wrap);
  assert.equal(wrap.kind, 1059);
  assert.notEqual(wrap.pubkey, sender, 'the relay does not see the sender account key');
  assert.ok(wire.includes(recipient), 'the relay sees the recipient route required for delivery');
  assert.equal(wire.includes(sender), false);
  assert.equal(wire.includes(devicePubkey), false);
  assert.equal(wire.includes(registryEvent.id), false);

  const opened = openPrivateDeviceRegistryWrap({ wrap, recipientSecret, now });
  assert.equal(opened.senderPubkey, sender);
  assert.equal(opened.event.id, registryEvent.id);
  assert.equal(opened.registry.devices[0].pubkey, devicePubkey);
  assert.equal(openPrivateDeviceRegistryWrap({ wrap, recipientSecret: generateSecretKey(), now }), null);
});

test('a registry signed by one account cannot be transported as another account', () => {
  const attackerSecret = generateSecretKey();
  const targetDevice = generateSecretKey();
  const recipient = getPublicKey(generateSecretKey());
  const now = Math.floor(Date.now() / 1000);
  const forgedRegistry = buildDeviceRegistryEvent({
    accountSecret: attackerSecret,
    generation: 1,
    devices: [{
      deviceId: 'f'.repeat(32),
      pubkey: getPublicKey(targetDevice),
      status: 'active',
      enrolledAt: now - 1,
    }],
  }, now - 1);
  assert.throws(() => buildPrivateDeviceRegistryWrap({
    registryEvent: forgedRegistry,
    senderSecret: generateSecretKey(),
    recipientPubkey: recipient,
    now,
  }), /account-signed device registry/);
});
