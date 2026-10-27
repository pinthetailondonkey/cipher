import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintDeliveryLabel, deliveryLabelOf } from './deliveryLabel.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const TXID = hex(secp256k1.utils.randomSecretKey());
const pub = (priv) => hex(secp256k1.getPublicKey(priv, true));

test('the label is symmetric: buyer mints it and vendor mints the same bytes', () => {
  const buyerPriv = secp256k1.utils.randomSecretKey();
  const vendorPriv = secp256k1.utils.randomSecretKey();
  const fromBuyerSide = mintDeliveryLabel({
    privateKeyBytes: buyerPriv, peerPubHex: pub(vendorPriv), fundingTxidHex: TXID,
  });
  const fromVendorSide = mintDeliveryLabel({
    privateKeyBytes: vendorPriv, peerPubHex: pub(buyerPriv), fundingTxidHex: TXID,
  });
  assert.equal(fromBuyerSide, fromVendorSide, 'ECDH symmetry: one label, minted twice');
  assert.match(fromBuyerSide, /^[0-9a-f]{64}$/);
});

test('the label is per-order: any different fact mints different bytes', () => {
  const buyerPriv = secp256k1.utils.randomSecretKey();
  const vendorPriv = secp256k1.utils.randomSecretKey();
  const otherBuyerPriv = secp256k1.utils.randomSecretKey();
  const one = mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: pub(vendorPriv), fundingTxidHex: TXID });
  // different order, different buyer slot key: different label
  const otherOrder = mintDeliveryLabel({ privateKeyBytes: otherBuyerPriv, peerPubHex: pub(vendorPriv), fundingTxidHex: TXID });
  assert.notEqual(one, otherOrder);
  // different funding txid (never happens for the same escrow, matters
  // for running the digest against a different order's money): different
  const otherTxid = mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: pub(vendorPriv), fundingTxidHex: hex(secp256k1.utils.randomSecretKey()) });
  assert.notEqual(one, otherTxid);
  // and the label really is the digest of the folded facts, so the
  // compare step can redo it locally
  const sharedX = secp256k1.getSharedSecret(buyerPriv, secp256k1.Point.fromHex(pub(vendorPriv)).toBytes());
  const folded = new Uint8Array(64);
  folded.set(sharedX.slice(1, 33), 0);
  folded.set(Uint8Array.from(TXID.match(/../g).map((h) => parseInt(h, 16))), 32);
  assert.equal(one, hex(sha256(folded)));
});

test('the label minter refuses junk before any math', () => {
  const buyerPriv = secp256k1.utils.randomSecretKey();
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: new Uint8Array(31), peerPubHex: pub(buyerPriv), fundingTxidHex: TXID }), /32-byte/);
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: 'zz', fundingTxidHex: TXID }), /peer per-order key/);
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: 'aa'.repeat(33), fundingTxidHex: TXID }), /peer per-order key/);
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: 'ff'.repeat(33), fundingTxidHex: TXID }), /peer per-order key/);
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: pub(buyerPriv), fundingTxidHex: 'aa'.repeat(32) + 'zz' }), /not even hex/);
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: pub(buyerPriv), fundingTxidHex: 'aa'.repeat(31) }), /64-hex funding txid/);
  assert.throws(() => mintDeliveryLabel({ privateKeyBytes: buyerPriv, peerPubHex: pub(buyerPriv), fundingTxidHex: 'aa'.repeat(40) }), /64-hex funding txid/);
});

test('the label shape gate reads only a 32-byte hex digest', () => {
  const good = hex(secp256k1.utils.randomSecretKey()); // 32 bytes, 64 hex chars
  assert.equal(deliveryLabelOf(good), good);
  assert.equal(deliveryLabelOf('short'), null);
  assert.equal(deliveryLabelOf('zz'.repeat(32)), null);
  assert.equal(deliveryLabelOf(undefined), null);
});
