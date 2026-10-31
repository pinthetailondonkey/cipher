import { bech32, bech32m, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// Local string math only: a checksum and a shape, never a network call. A
// value that passes here is a well-formed address for the coin; whether it
// has ever been used is the chain's answer, not this file's.

const b58check = base58check(sha256);

// Bitcoin. Bech32 carries its own checksum; base58check is double-SHA256.
// Testnet and regtest share the base58 version bytes.
const BTC_NETWORKS = {
  bc: { hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 },
  tb: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  bcrt: { hrp: 'bcrt', p2pkh: 0x6f, p2sh: 0xc4 },
};
const BTC_HRPS = new Set(['bc', 'tb', 'bcrt']);
const BTC_TEST_VERSIONS = new Set([0x6f, 0xc4]);

// Monero. Monero base58 packs 8 bytes into 11 characters, with a fixed
// encoded size per block; the checksum is the first 4 bytes of keccak-256
// over the payload.
const XMR_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const XMR_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const XMR_LENGTH = { 95: 69, 106: 77 };
const XMR_KINDS = { 0x12: 'standard', 0x2a: 'subaddress', 0x13: 'integrated' };
const XMR_TEST_PREFIXES = new Set([0x35, 0x36, 0x3f]);

const COIN = { BTC: 'Bitcoin', XMR: 'Monero' };

function fail(currency, reason, message) {
  return { ok: false, currency, reason, message };
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function decodeXmrBlock(text, size) {
  if (text.length !== XMR_BLOCK[size]) throw new Error('That is not a valid Monero address.');
  let value = 0n;
  for (const char of text) {
    const digit = XMR_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('That is not a valid Monero address.');
    value = value * 58n + BigInt(digit);
  }
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  // A block that does not fit its width is not a canonical encoding.
  if (value !== 0n) throw new Error('That is not a valid Monero address.');
  return out;
}

function decodeXmr(text, size) {
  const raw = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < text.length;) {
    const remaining = size - offset;
    const blockSize = remaining >= 8 ? 8 : remaining;
    const block = decodeXmrBlock(text.slice(i, i + XMR_BLOCK[blockSize]), blockSize);
    raw.set(block, offset);
    offset += blockSize;
    i += XMR_BLOCK[blockSize];
  }
  return raw;
}

function checkMonero(text) {
  const name = COIN.XMR;
  if (/\s/.test(text)) return fail('XMR', 'format', `That is not a valid ${name} address.`);
  const size = XMR_LENGTH[text.length];
  if (!size) return fail('XMR', 'format', `That is not a valid ${name} address.`);
  let raw;
  try {
    raw = decodeXmr(text, size);
  } catch {
    return fail('XMR', 'format', `That is not a valid ${name} address.`);
  }
  const checksum = raw.subarray(size - 4);
  if (!equalBytes(keccak_256(raw.subarray(0, size - 4)).subarray(0, 4), checksum)) {
    return fail('XMR', 'checksum', `That is not a valid ${name} address.`);
  }
  const prefix = raw[0];
  if (XMR_TEST_PREFIXES.has(prefix)) {
    return fail('XMR', 'network', `That is a ${name} testnet address, not a mainnet one.`);
  }
  const kind = XMR_KINDS[prefix];
  if (!kind) return fail('XMR', 'format', `That is not a valid ${name} address.`);
  // An integrated address carries 8 extra bytes for the payment id.
  if ((kind === 'integrated') !== (size === 77)) {
    return fail('XMR', 'format', `That is not a valid ${name} address.`);
  }
  return { ok: true, currency: 'XMR', kind };
}

function checkBitcoin(text, network) {
  const name = COIN.BTC;
  const broken = `That is not a valid ${name} address.`;
  if (/\s/.test(text)) return fail('BTC', 'format', broken);
  const lower = text.toLowerCase();
  if (/^(bc|tb|bcrt)1/.test(lower)) {
    // Bech32 is one case or the other, never both at once.
    if (text !== lower && text !== text.toUpperCase()) return fail('BTC', 'format', broken);
    let decoded;
    let variant = '';
    try {
      decoded = bech32.decode(lower);
      variant = 'bech32';
    } catch {
      decoded = null;
    }
    if (!decoded) {
      try {
        decoded = bech32m.decode(lower);
        variant = 'bech32m';
      } catch {
        decoded = null;
      }
    }
    if (!decoded) return fail('BTC', 'checksum', broken);
    const spec = BTC_NETWORKS[network];
    if (!BTC_HRPS.has(decoded.prefix)) return fail('BTC', 'format', broken);
    if (spec && decoded.prefix !== spec.hrp) {
      return fail('BTC', 'network', 'That address is on a different Bitcoin network. Pick the matching network.');
    }
    const version = decoded.words[0];
    if (!(version >= 0 && version <= 16)) return fail('BTC', 'format', broken);
    // BIP350: version 0 is bech32, every later version is bech32m.
    if (version === 0 ? variant !== 'bech32' : variant !== 'bech32m') return fail('BTC', 'format', broken);
    let program;
    try {
      program = bech32.fromWords(decoded.words.slice(1));
    } catch {
      return fail('BTC', 'format', broken);
    }
    if (program.length < 2 || program.length > 40) return fail('BTC', 'format', broken);
    if (version === 0 && program.length !== 20 && program.length !== 32) return fail('BTC', 'format', broken);
    return { ok: true, currency: 'BTC', kind: 'bech32' };
  }
  let payload;
  try {
    payload = b58check.decode(text);
  } catch {
    return fail('BTC', 'checksum', broken);
  }
  if (payload.length !== 21) return fail('BTC', 'format', broken);
  const version = payload[0];
  const mainnet = version === 0x00 || version === 0x05;
  const testnet = BTC_TEST_VERSIONS.has(version);
  if (!mainnet && !testnet) return fail('BTC', 'format', broken);
  const spec = BTC_NETWORKS[network];
  if (spec && version !== spec.p2pkh && version !== spec.p2sh) {
    return fail('BTC', 'network', 'That address is on a different Bitcoin network. Pick the matching network.');
  }
  return { ok: true, currency: 'BTC', kind: 'legacy' };
}

// checkPaymentAddress(currency, address, { network })
// network is the Bitcoin network the app is set to ('bc', 'tb' or 'bcrt').
// Left out, any Bitcoin network is accepted; Monero is mainnet only.
export function checkPaymentAddress(currency, address, { network } = {}) {
  const coin = String(currency || '').toUpperCase() === 'XMR' ? 'XMR' : 'BTC';
  const text = String(address == null ? '' : address).trim();
  if (!text) return fail(coin, 'empty', `Enter a ${COIN[coin]} address.`);
  return coin === 'XMR' ? checkMonero(text) : checkBitcoin(text, network);
}

export function isValidPaymentAddress(currency, address, options) {
  return checkPaymentAddress(currency, address, options).ok;
}

// The first bad address in a pair, or null when both are usable. An empty
// slot is not a failure: a vendor may take one coin or both.
export function paymentAddressesProblem({ btc = '', xmr = '' } = {}, options = {}) {
  if (btc) {
    const result = checkPaymentAddress('BTC', btc, options);
    if (!result.ok) return result;
  }
  if (xmr) {
    const result = checkPaymentAddress('XMR', xmr, options);
    if (!result.ok) return result;
  }
  return null;
}
