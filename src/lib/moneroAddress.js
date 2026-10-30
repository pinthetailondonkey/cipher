import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';

// Mainnet prefixes. 0x12 is a standard address (starts with 4). 0x2a is a subaddress (starts with 8).
const MAINNET_ADDRESS = 0x12;
const MAINNET_SUBADDRESS = 0x2a;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENCODED_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const L = ed25519.Point.Fn.ORDER;

function bytesToNumberLE(bytes) {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) value |= BigInt(bytes[i]) << (8n * BigInt(i));
  return value;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function encodeBlock(bytes) {
  let num = 0n;
  for (const byte of bytes) num = (num << 8n) | BigInt(byte);
  const size = ENCODED_BLOCK[bytes.length];
  const chars = Array(size);
  for (let i = size - 1; i >= 0; i -= 1) {
    chars[i] = ALPHABET[Number(num % 58n)];
    num /= 58n;
  }
  return chars.join('');
}

function decodeBlock(text, size) {
  if (text.length !== ENCODED_BLOCK[size]) throw new Error('That is not a Monero address.');
  let num = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('That is not a Monero address.');
    num = num * 58n + BigInt(digit);
  }
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n) throw new Error('That is not a Monero address.');
  return out;
}

export function encodeMoneroAddress(payload) {
  let out = '';
  for (let i = 0; i < payload.length; i += 8) out += encodeBlock(payload.subarray(i, Math.min(i + 8, payload.length)));
  return out;
}

export function decodeMoneroAddress(address) {
  const text = String(address || '').trim();
  if (text.length !== 95) throw new Error('A Monero mainnet address is 95 characters.');
  const raw = new Uint8Array(69);
  let offset = 0;
  for (let i = 0; i < text.length;) {
    const remaining = 69 - offset;
    const size = remaining >= 8 ? 8 : remaining;
    const block = decodeBlock(text.slice(i, i + ENCODED_BLOCK[size]), size);
    raw.set(block, offset);
    offset += size;
    i += ENCODED_BLOCK[size];
  }
  const payload = raw.subarray(0, 65);
  const checksum = raw.subarray(65);
  if (!equalBytes(keccak_256(payload).subarray(0, 4), checksum)) throw new Error('That Monero address has a bad checksum.');
  return {
    prefix: payload[0],
    spend: payload.slice(1, 33),
    view: payload.slice(33, 65),
  };
}

function hashToScalar(data) {
  return ed25519.Point.Fn.create(bytesToNumberLE(keccak_256(data)));
}

function viewScalar(privateViewKey) {
  const hex = String(privateViewKey || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('The Monero private view key must be 64 hexadecimal characters.');
  const scalar = bytesToNumberLE(hexToBytes(hex));
  if (scalar <= 0n || scalar >= L) throw new Error('The Monero private view key is not a valid scalar.');
  return scalar;
}

function uint32LE(value) {
  const out = new Uint8Array(4);
  const number = value >>> 0;
  out[0] = number & 255;
  out[1] = (number >>> 8) & 255;
  out[2] = (number >>> 16) & 255;
  out[3] = (number >>> 24) & 255;
  return out;
}

function addressFromKeys(prefix, spendPoint, viewPoint) {
  const payload = new Uint8Array(65);
  payload[0] = prefix;
  payload.set(spendPoint.toBytes(), 1);
  payload.set(viewPoint.toBytes(), 33);
  const full = new Uint8Array(69);
  full.set(payload);
  full.set(keccak_256(payload).subarray(0, 4), 65);
  return encodeMoneroAddress(full);
}

export function deriveMoneroAddress({ primaryAddress, privateViewKey, account = 0, index = 0 } = {}) {
  if (!Number.isInteger(account) || account < 0 || !Number.isInteger(index) || index < 0) {
    throw new Error('Monero subaddress indexes must be whole numbers.');
  }
  const decoded = decodeMoneroAddress(primaryAddress);
  if (decoded.prefix !== MAINNET_ADDRESS) throw new Error('Use a standard mainnet Monero address, not a subaddress.');
  const scalar = viewScalar(privateViewKey);
  const spend = ed25519.Point.fromBytes(decoded.spend);
  const view = ed25519.Point.fromBytes(decoded.view);
  if (!equalBytes(ed25519.Point.BASE.multiply(scalar).toBytes(), view.toBytes())) {
    throw new Error('That view key does not belong to this Monero address.');
  }
  if (account === 0 && index === 0) return String(primaryAddress).trim();

  const material = new Uint8Array(48);
  material.set(new TextEncoder().encode('SubAddr'));
  material.set(hexToBytes(String(privateViewKey).trim().toLowerCase()), 8);
  material.set(uint32LE(account), 40);
  material.set(uint32LE(index), 44);
  const spendPublic = spend.add(ed25519.Point.BASE.multiply(hashToScalar(material)));
  const viewPublic = spendPublic.multiply(scalar);
  return addressFromKeys(MAINNET_SUBADDRESS, spendPublic, viewPublic);
}
