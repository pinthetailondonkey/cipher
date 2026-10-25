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

function requireAt(value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error('The receipt needs a time.');
  return value;
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
    at: requireAt(input.at),
    outcome: ['confirmed', 'rugged', 'refunded'].includes(input.outcome) ? input.outcome : '',
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

export function coSignPayment(receipt, secretKey) {
  if (verifyReceipt(receipt)) return receipt;
  return signReceipt(secretKey, receipt?.body, receipt);
}

export function acceptPayment(payload, secretKey) {
  if (!payload || payload.type !== 'order_update' || !payload.receipt?.body) return null;
  if (payload.status !== 'paid' && payload.status !== 'disputed') return null;
  try {
    const already = verifyReceipt(payload.receipt);
    const receipt = already ? payload.receipt : coSignPayment(payload.receipt, secretKey);
    if (!verifyReceipt(receipt)) return null;
    let published = payload.published || null;
    if (published) {
      try {
        published = signPublicView(secretKey, published);
      } catch {
        published = payload.published;
      }
    }
    return { receipt, added: !already, published };
  } catch {
    return null;
  }
}

export function verifyReceipt(signed) {
  try {
    if (!signed?.body || !signed?.sigs?.buyer || !signed?.sigs?.vendor) return false;
    const body = canonicalReceipt(signed.body);
    const message = receiptBytes(body);
    if (bytesToHex(sha256(message)) !== signed.hash) return false;
    if (body.buyer === body.vendor) return false;
    const buyerOk = schnorr.verify(hexToBytes(signed.sigs.buyer), message, hexToBytes(body.buyer));
    const vendorOk = schnorr.verify(hexToBytes(signed.sigs.vendor), message, hexToBytes(body.vendor));
    return buyerOk && vendorOk;
  } catch {
    return false;
  }
}

function publicBody(input = {}) {
  return {
    v: 1,
    hash: String(input.hash || ''),
    amount: normalizeAmount(input.amount),
    currency: String(input.currency || '').toLowerCase(),
    buyer: String(input.buyer || '').toLowerCase(),
    vendor: String(input.vendor || '').toLowerCase(),
  };
}

export function publicReceipt(signed) {
  try {
    const body = signed?.body ? canonicalReceipt(signed.body) : {};
    return publicBody({
      hash: signed?.hash || (signed?.body ? receiptHash(body) : ''),
      amount: signed?.amount || body.amount,
      currency: signed?.currency || body.currency,
      buyer: signed?.buyer || body.buyer,
      vendor: signed?.vendor || body.vendor,
    });
  } catch {
    return null;
  }
}

function publicMessage(body) {
  return new TextEncoder().encode(JSON.stringify(body));
}

export function signPublicView(secretKey, view) {
  const body = publicBody(view);
  const message = publicMessage(body);
  const sk = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
  const pub = bytesToHex(schnorr.getPublicKey(sk));
  const role = pub === body.buyer ? 'buyer' : pub === body.vendor ? 'vendor' : '';
  if (!role) throw new Error('That key is neither the buyer nor the vendor.');
  const sigs = { ...(view?.sigs || {}) };
  if (view?.sig && !sigs.vendor) sigs.vendor = view.sig;
  sigs[role] = bytesToHex(schnorr.sign(message, sk));
  const out = { ...body, sigs };
  if (!sigs.buyer && sigs.vendor) out.sig = sigs.vendor;
  return out;
}

function signatureHolds(sig, message, pubkey) {
  if (!sig || !pubkey) return false;
  return schnorr.verify(hexToBytes(sig), message, hexToBytes(pubkey));
}

export function verifyPublicView(view) {
  if (!view?.sigs?.buyer || !view?.sigs?.vendor) return false;
  if (view.address || view.txid || view.body) return false;
  if (String(view.buyer || '').toLowerCase() === String(view.vendor || '').toLowerCase()) return false;
  try {
    const body = publicBody(view);
    const message = publicMessage(body);
    const buyerOk = signatureHolds(view.sigs.buyer, message, body.buyer);
    const vendorOk = signatureHolds(view.sigs.vendor, message, body.vendor);
    return buyerOk && vendorOk;
  } catch {
    return false;
  }
}

export function verifyVendorView(view) {
  if (!view || view.sigs?.buyer) return false;
  if (view.address || view.txid || view.body) return false;
  const sig = view.sigs?.vendor || view.sig;
  try {
    const body = publicBody(view);
    return signatureHolds(sig, publicMessage(body), body.vendor);
  } catch {
    return false;
  }
}

const AMOUNT_SCALE = { btc: 8, xmr: 12 };

function amountUnits(amount, currency) {
  const scale = AMOUNT_SCALE[String(currency || '').toLowerCase()];
  if (scale == null) return null;
  let text;
  try {
    text = normalizeAmount(amount);
  } catch {
    return null;
  }
  const [whole, frac = ''] = text.split('.');
  const factor = 10n ** BigInt(scale);
  if (frac.length <= scale) {
    return BigInt(whole) * factor + BigInt((frac || '0').padEnd(scale, '0'));
  }
  let units = BigInt(whole) * factor + BigInt(frac.slice(0, scale) || '0');
  if (Number(frac[scale]) >= 5) units += 1n;
  return units;
}

function unitsToAmount(units, currency) {
  const scale = AMOUNT_SCALE[String(currency || '').toLowerCase()];
  const factor = 10n ** BigInt(scale);
  const whole = units / factor;
  const frac = (units % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function rankVolume(events) {
  const totals = new Map();
  for (const event of events || []) {
    if (!event || event.address || event.txid) continue;
    const units = amountUnits(event.amount, event.currency);
    if (units == null || !event.vendor || !event.currency) continue;
    const key = `${event.vendor}|${event.currency}`;
    const row = totals.get(key) || { vendor: event.vendor, currency: event.currency, units: 0n };
    row.units += units;
    totals.set(key, row);
  }
  return [...totals.values()]
    .sort((a, b) => (a.units > b.units ? -1 : a.units < b.units ? 1 : a.vendor.localeCompare(b.vendor)))
    .map(({ vendor, currency, units }) => ({ vendor, currency, volume: unitsToAmount(units, currency) }));
}

const standingCache = new Map();
let standingMisses = 0;

function viewKey(event) {
  if (!event || typeof event !== 'object') return '';
  const sigs = event.sigs || {};
  return [
    event.v ?? '', event.hash || '', event.amount || '', event.currency || '',
    event.buyer || '', event.vendor || '', sigs.buyer || '', sigs.vendor || '', event.sig || '',
    event.address ? 'a' : '', event.txid ? 't' : '', event.body ? 'b' : '',
  ].join('|');
}

export function publicViewChecks() {
  return standingMisses;
}

function standingOf(event) {
  const key = viewKey(event);
  if (!key.replace(/\|/g, '')) return '';
  const cached = standingCache.get(key);
  if (cached != null) return cached;
  standingMisses += 1;
  const standing = verifyPublicView(event) ? 'countersigned' : verifyVendorView(event) ? 'vendor' : '';
  if (standingCache.size > 2000) standingCache.clear();
  standingCache.set(key, standing);
  return standing;
}

export function rankVolumeByStanding(events) {
  const countersigned = [];
  const vendor = [];
  for (const event of events || []) {
    const standing = standingOf(event);
    if (standing === 'countersigned') countersigned.push(event);
    else if (standing === 'vendor') vendor.push(event);
  }
  return { countersigned: rankVolume(countersigned), vendor: rankVolume(vendor) };
}
