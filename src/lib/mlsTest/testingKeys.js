// Shared Ed25519 test keys for the MLS test profile unit tests. Fixed but
// freshly generated per run; determinism for vectors lives in the vector
// generator, not here.
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function newKey() {
  const { secretKey } = ed25519.keygen();
  return { secretKey, publicKey: bytesToHex(ed25519.getPublicKey(secretKey)) };
}

export function hexToBytes(hex) {
  return new Uint8Array(String(hex).match(/.{2}/g).map((h) => parseInt(h, 16)));
}
