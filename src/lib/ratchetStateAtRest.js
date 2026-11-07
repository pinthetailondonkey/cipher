// Ratchet pickles are an additional cryptographic state store, not message
// history. Seal them under the unlocked vault secret with a separate HKDF
// domain, random nonce and database/record-bound AAD. A missing vault secret
// is an error: never write a raw ratchet pickle or invent a replacement key.
import { atRestSecretBytes } from './messageAtRest.js';

const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_INFO = encoder.encode('cipher-dm-ratchet-state-aes-gcm-v1');

function toBase64(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function aadFor(owner, collection, id, version) {
  return encoder.encode(`cipher-ratchet-state-${version}|${owner}|${collection}|${id}`);
}

async function storageKey() {
  const secret = atRestSecretBytes();
  if (!(secret instanceof Uint8Array) || secret.length !== 32) {
    throw new Error('Unlock this account before reading or writing ratchet state.');
  }
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode('cipher-ratchet-state-salt-v1'),
    info: KEY_INFO,
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealRatchetState({ owner, collection, id, value }) {
  if (!owner || !collection || !id) throw new Error('Ratchet state needs an account and record identity.');
  const key = await storageKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  let ciphertext;
  try {
    ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: aadFor(owner, collection, id, VERSION),
    }, key, plaintext);
  } finally {
    plaintext.fill(0);
  }
  return { v: VERSION, iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) };
}

export async function openRatchetState({ owner, collection, id, sealed }) {
  if (!owner || !collection || !id || sealed?.v !== VERSION
    || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
    throw new Error('Ratchet state is malformed or uses an unsupported version.');
  }
  const key = await storageKey();
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: fromBase64(sealed.iv),
    additionalData: aadFor(owner, collection, id, VERSION),
  }, key, fromBase64(sealed.ct));
  try {
    return JSON.parse(decoder.decode(plaintext));
  } finally {
    new Uint8Array(plaintext).fill(0);
  }
}
