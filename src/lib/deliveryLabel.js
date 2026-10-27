// The Twin-Key Parcel delivery label (invention design #3, founder card
// 2026-10-27): the word a packed parcel carries so it can be PROVEN to
// belong to THIS funded order — one photo, one digest compare, and a brick
// in a box is falsified. Pure: no network, no storage, no clock.
//
// The label is minted, never chosen: the ECDH point of the two per-order
// escrow keys, folded with the funding txid. Nobody pre-shared it and no
// one could have — the private halves never leave their devices, and the
// txid does not exist until the deposit is mined. So a label cannot
// pre-date the money it claims to travel with: only a funded order can
// produce these bytes, which is why a shipping photo showing them cannot
// be a loaned or rehearsed brick. Buyer and vendor each mint the same
// label from their own half — symmetric ECDH — and the honest one is the
// one the events already agree on.

import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const LABEL_PATTERN = /^[0-9a-f]{64}$/; // 32 bytes, hex — the full digest
const TXID_PATTERN = /^[0-9a-f]{64}$/; // 32 bytes, hex — a Bitcoin txid

function hexBytes(hex, what) {
  const clean = String(hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`The ${what} is not even hex.`);
  }
  return Uint8Array.from(clean.match(/../g).map((pair) => parseInt(pair, 16)));
}

// The label: sha256(sharedPointX || fundingTxid). The txid bytes make the
// label per-order, the shared point makes it per-pair — and unmakeable by
// anyone not one of the two order keys.
export function mintDeliveryLabel({ privateKeyBytes, peerPubHex, fundingTxidHex }) {
  if (privateKeyBytes instanceof Uint8Array !== true || privateKeyBytes.length !== 32
    || privateKeyBytes.every((b) => b === 0)) {
    throw new Error('The label mints from a 32-byte per-order secret.');
  }
  // The peer half is the public per-order key ON THE CARD (33-byte
  // compressed). An invalid point refuses before any math: a label
  // minted against a key that is not a key is a collision someone
  // planned, not a delivery word.
  let peerPub;
  try {
    const pub = hexBytes(peerPubHex, 'peer per-order key');
    if (pub.length !== 33 || pub[0] !== 0x02 && pub[0] !== 0x03) {
      throw new Error('The peer per-order key is not a 33-byte compressed point.');
    }
    peerPub = secp256k1.Point.fromBytes(pub);
  } catch (err) {
    if (/peer per-order key/.test(err.message)) throw err;
    throw new Error('The peer per-order key is not a 33-byte compressed point.');
  }
  const txid = hexBytes(fundingTxidHex, 'funding txid');
  if (!TXID_PATTERN.test(String(fundingTxidHex ?? '').trim().toLowerCase())) {
    throw new Error('The label folds the 64-hex funding txid, not anything else.');
  }
  const shared = secp256k1.getSharedSecret(privateKeyBytes, peerPub.toBytes());
  // strip the 0x04 byte-pair header to the 32-byte X: THE shared point,
  // same on both sides by ECDH symmetry
  const sharedX = shared.slice(1, 33);
  const parts = new Uint8Array(sharedX.length + txid.length);
  parts.set(sharedX, 0);
  parts.set(txid, sharedX.length);
  return [...sha256(parts)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function deliveryLabelOf(label) {
  const clean = String(label ?? '').trim().toLowerCase();
  return LABEL_PATTERN.test(clean) ? clean : null;
}
