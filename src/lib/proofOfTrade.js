import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Spec: docs/proof-of-trade.md, version 1.

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
    amount: normalizeAmount(input.amount ?? '0'),
    txid: String(input.txid || ''),
    at: Number.isInteger(input.at) && input.at >= 0 ? input.at : 0,
    outcome: ['confirmed', 'disputed', 'rugged', 'refunded'].includes(input.outcome) ? input.outcome : '',
  };
}

export function receiptBytes(body) {
  return new TextEncoder().encode(JSON.stringify(canonicalReceipt(body)));
}

export function normalizeAmount(value) {
  const raw = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : String(value ?? '').trim().replace(/[$,]/g, '');
  if (!raw || /e/i.test(raw) || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('The amount must be a decimal string.');
  }
  const [whole, frac = ''] = raw.split('.');
  const digits = whole.replace(/^0+(?=\d)/, '') || '0';
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${digits}.${trimmed}` : digits;
}

export function receiptHash(body) {
  return bytesToHex(sha256(receiptBytes(body)));
}

export function signReceipt(secretKey, input, prior = null) {
  const body = canonicalReceipt(input?.body || input);
  const message = receiptBytes(body);
  const hash = bytesToHex(sha256(message));
  const sk = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
  const pub = bytesToHex(schnorr.getPublicKey(sk));
  const role = pub === body.buyer ? 'buyer' : pub === body.vendor ? 'vendor' : '';
  if (!role) throw new Error('That key is neither the buyer nor the vendor.');
  if (prior?.hash && prior.hash !== hash) throw new Error('The co-signature is over a different receipt.');
  const sigs = { ...(prior?.sigs || {}) };
  sigs[role] = bytesToHex(schnorr.sign(message, sk));
  return { v: 1, hash, body, sigs };
}

export function verifyReceipt(signed) {
  if (!signed?.body || !signed?.sigs?.buyer || !signed?.sigs?.vendor) return false;
  const body = canonicalReceipt(signed.body);
  const message = receiptBytes(body);
  if (bytesToHex(sha256(message)) !== signed.hash) return false;
  if (body.buyer === body.vendor) return false;
  try {
    const buyerOk = schnorr.verify(hexToBytes(signed.sigs.buyer), message, hexToBytes(body.buyer));
    const vendorOk = schnorr.verify(hexToBytes(signed.sigs.vendor), message, hexToBytes(body.vendor));
    return buyerOk && vendorOk;
  } catch {
    return false;
  }
}

export function publicReceipt(signed) {
  const body = canonicalReceipt(signed?.body || {});
  return {
    v: 1,
    hash: signed?.hash || receiptHash(body),
    amount: body.amount,
    currency: body.currency,
    buyer: body.buyer,
    vendor: body.vendor,
  };
}

function amountUnits(amount) {
  let text;
  try {
    text = normalizeAmount(amount);
  } catch {
    return null;
  }
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 100000000n + BigInt((frac + '00000000').slice(0, 8));
}

function unitsToAmount(units) {
  const whole = units / 100000000n;
  const frac = (units % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function rankVolume(events) {
  const totals = new Map();
  for (const event of events || []) {
    if (!event || event.address || event.txid) continue;
    const units = amountUnits(event.amount);
    if (units == null || !event.vendor || !event.currency) continue;
    const key = `${event.vendor}|${event.currency}`;
    const row = totals.get(key) || { vendor: event.vendor, currency: event.currency, units: 0n };
    row.units += units;
    totals.set(key, row);
  }
  return [...totals.values()]
    .sort((a, b) => (a.units > b.units ? -1 : a.units < b.units ? 1 : a.vendor.localeCompare(b.vendor)))
    .map(({ vendor, currency, units }) => ({ vendor, currency, volume: unitsToAmount(units) }));
}
