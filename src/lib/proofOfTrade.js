import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { scopedGet, scopedSet } from './storage.js';
import { ORDER_STATUS, RECEIPT_OUTCOMES } from './paymentState.js';

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
    outcome: RECEIPT_OUTCOMES.includes(input.outcome) ? input.outcome : '',
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
      } catch (error) {
        console.error('[orders] The public view was not co-signed:', error);
        published = payload.published;
      }
    }
    return { receipt, added: !already, published };
  } catch (error) {
    console.error('[orders] The buyer signature was not added:', error);
    return null;
  }
}

// The relay always serves the vendor's original, vendor-only receipt, so
// acceptPayment reports a new signature on every history fetch. The buyer's
// signature goes back once per receipt, and again only if that send failed.
export function countersignToSend(accepted, sentHash) {
  if (!accepted?.added || !accepted.receipt?.hash) return false;
  return accepted.receipt.hash !== sentHash;
}

const countersignsInFlight = new Set();

// The mark is written only after the send succeeds, so a failed send is tried
// again on the next history fetch, and onFailure tells the buyer it failed.
export async function sendCountersignOnce({ sendDM, counterparty, orderId, accepted, onFailure }) {
  const sentKey = `countersign_sent_${orderId}`;
  const hash = accepted?.receipt?.hash;
  if (!countersignToSend(accepted, scopedGet(sentKey, '')) || countersignsInFlight.has(hash)) return false;
  countersignsInFlight.add(hash);
  try {
    let result;
    try {
      result = await sendDM(counterparty, {
        type: 'order_update',
        orderId,
        status: ORDER_STATUS.PAID,
        receipt: accepted.receipt,
        ...(accepted.published ? { published: accepted.published } : {}),
      });
    } catch (error) {
      result = { success: false, error: error?.message };
    }
    if (result?.success) {
      scopedSet(sentKey, hash);
      return true;
    }
    onFailure?.(result?.error || 'The signature did not send.');
    return false;
  } finally {
    countersignsInFlight.delete(hash);
  }
}

// The binding decision for an incoming receipt. A receipt is stored and
// cosigned only when it names exactly the order this device tracks and paid
// into: the same orderId on the receipt and on the update, the order's coin
// amount (a larger single output may cover the order, a smaller one never),
// the payment address this device issued, and the two parties of this chat.
// Any mismatch fails closed, so a fabricated update can never plant a
// receipt or harvest this device's signature.
export function receiptBindsOrder({ receipt, orderId, orderCoinAmount, issuedAddress, orderCurrency, buyerPubkey, vendorPubkey, update } = {}) {
  const body = receipt?.body || null;
  if (!body) return false;
  if (!orderId || String(body.orderId ?? '') !== String(orderId)) return false;
  if (update?.orderId != null && String(update.orderId) !== String(orderId)) return false;
  const currency = String(orderCurrency ?? '').toLowerCase();
  if (!currency) return false;
  if (String(body.currency ?? '').toLowerCase() !== currency) return false;
  const got = amountUnits(body.amount, currency);
  const need = amountUnits(orderCoinAmount, currency);
  if (got == null || need == null || got < need) return false;
  const issued = String(issuedAddress ?? '');
  if (!issued.trim()) return false;
  if (String(body.address ?? '') !== issued) return false;
  if (update?.address != null && String(update.address) !== issued) return false;
  const buyer = String(buyerPubkey ?? '').toLowerCase();
  const vendor = String(vendorPubkey ?? '').toLowerCase();
  if (buyer && String(body.buyer ?? '').toLowerCase() !== buyer) return false;
  if (vendor && String(body.vendor ?? '').toLowerCase() !== vendor) return false;
  return true;
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

export function rememberPublicView(view) {
  if (!view?.hash || !view.vendor) return;
  const current = scopedGet('public_views', []);
  const rows = Array.isArray(current) ? current.filter((row) => row && row.hash !== view.hash) : [];
  rows.push(view);
  scopedSet('public_views', rows.slice(-200));
}

export function readPublicViews() {
  const current = scopedGet('public_views', []);
  return Array.isArray(current) ? current : [];
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
