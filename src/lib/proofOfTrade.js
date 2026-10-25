import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Spec: docs live in the README under "Proof of trade".
// The signature is BIP-340 over the canonical JSON bytes.
// What gets published by default is only sha256 of those bytes.

function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const text = String(hex || '');
  if (text.length % 2) throw new Error('The receipt signature is not valid.');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function canonicalReceipt(input = {}) {
  return {
    v: 1,
    orderId: String(input.orderId || ''),
    buyer: String(input.buyer || '').toLowerCase(),
    vendor: String(input.vendor || '').toLowerCase(),
    currency: String(input.currency || '').toLowerCase(),
    address: String(input.address || ''),
    amount: String(input.amount ?? ''),
    txid: String(input.txid || ''),
  };
}

export function receiptBytes(body) {
  return new TextEncoder().encode(JSON.stringify(canonicalReceipt(body)));
}

export function receiptHash(body) {
  return bytesToHex(sha256(receiptBytes(body)));
}

export function signReceipt(secretKey, body) {
  const message = receiptBytes(body);
  const sk = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
  const sig = schnorr.sign(message, sk);
  return {
    hash: bytesToHex(sha256(message)),
    sig: bytesToHex(sig),
    pub: bytesToHex(schnorr.getPublicKey(sk)),
    body: canonicalReceipt(body),
  };
}

export function verifyReceipt(signed) {
  if (!signed?.body || !signed.sig || !signed.pub) return false;
  const message = receiptBytes(signed.body);
  if (bytesToHex(sha256(message)) !== signed.hash) return false;
  try {
    return schnorr.verify(hexToBytes(signed.sig), message, hexToBytes(signed.pub));
  } catch {
    return false;
  }
}

export function publicReceipt(signed) {
  return { v: 1, hash: signed?.hash || '' };
}
