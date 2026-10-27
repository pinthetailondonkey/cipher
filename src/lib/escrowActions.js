// Escrow on the order card (commit 5 of docs/ESCROW.md). Pure: no
// network, no storage, no clock. The FSM owns the money math, the
// script module owns the bytes, the PSBT module owns the address; this
// file walks an order card — what a received quote must prove, what the
// buttons offer, and the per-order key derivation that keeps every
// escrow fact non-custodial by construction.
//
// Custody and trust rules this file lives by (docs/ESCROW.md):
// - Each side's per-order key is derived from that side's own secret
//   plus the order's public salt (HKDF). The private half is never
//   stored and never sent; only the public half travels, and it rides
//   the order card where it is already public data.
// - A received escrow quote is the vendor's word, not money math. A
//   reader on this device redoes the fee split and the deposit address
//   locally and adopts the quote only when both match exactly. Wrong
//   script shape, lying timer, hand-tuned fee, dust order: the quote
//   reads back as "no escrow on this card" and nothing renders.
// - The buyer's deposit address is only safe to pay when the script's
//   refund key is the buyer's OWN slot key. A script whose buyer key is
//   a stranger's would take the deposit and lock the buyer out of the
//   refund, so the payment row checks the script's key against the
//   order's slot before it renders at all.

import { quoteEscrow, canEscrow, MIN_ORDER_SATS, BLOCKS_PER_DAY, DEFAULT_DELAY_BLOCKS } from './escrowFsm.js';
import { assembleClockClaimScript, decodeOrderScript, hexToScript, scriptToHex } from './escrowScript.js';
import { escrowAddress } from './escrowPsbt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { satsFromString, satsToCoins } from './orderMembrane.js';
import { ORDER_STATUS, coinUnits, orderCoinAmount, unitsToCoins } from './paymentState.js';
import { orderState } from './orderActions.js';
import { paymentUri } from './paymentUri.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const SALT_PATTERN = /^[0-9a-f]{64}$/; // 32 bytes, hex
const PUBKEY_PATTERN = /^[0-9a-f]{66}$/; // compressed secp256k1 point, hex
const NONCE_PATTERN = /^[0-9a-f]{64}$/; // the delivery nonce: 32 bytes, hex

// The escrow action table — the account of everything escrow adds to
// the order action vocabulary. Listed side by side with ORDER_ACTIONS
// (orderActions.js); useCommerce takes both or nothing.
export const ESCROW_ORDER_ACTIONS = Object.freeze(['accept_with_escrow']);

const bytesToHex = (bytes) => scriptToHex(bytes ?? new Uint8Array());

// The order's escrow slot: a fresh 32-byte salt made when the buyer
// places the order. Public data on its own — the salt only picks WHICH
// key the vault derives for this order, never what the key is.
export function newEscrowSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function escrowSaltOf(data) {
  const salt = String(data?.escrowSalt ?? '').trim().toLowerCase();
  return SALT_PATTERN.test(salt) ? salt : null;
}

// The Dead Drop's delivery nonce (founder-approved wiring): one crypto-
// random 32-byte value per order, made by the VENDOR at acceptance. Its
// sha256 rides the acceptance (the commitment the script embeds); the
// nonce itself is a local-only fact — it goes to the order's local
// patch, which patchMessage writes to the device database and survives
// the next history fetch — and never rides the wire (re-attack vector
// 9: reusing one nonce across orders is dead by construction here).
export function newDeliveryNonce() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function deliveryNonceOf(data) {
  const nonce = String(data?.deliveryNonceHex ?? '').trim().toLowerCase();
  return NONCE_PATTERN.test(nonce) ? nonce : null;
}

// The spoken commitment: sha256 of the delivery nonce, hex. This is the
// only part of the nonce that is ever public before the vendor chooses
// to fire the dead drop.
export function overtHashHexOf(deliveryNonceHex) {
  const nonce = String(deliveryNonceHex ?? '').trim().toLowerCase();
  if (!NONCE_PATTERN.test(nonce)) throw new Error('The delivery nonce is not a 32-byte hex string.');
  return bytesToHex(sha256(hexToScript(nonce))); // hexToScript reads hex to bytes
}

const ESCROW_HKDF_INFO = new TextEncoder().encode('cipher-escrow-order-key-v1');

// The per-order escrow key: HKDF(account secret, order salt) -> a fresh
// secp256k1 keypair. The account's stored secret stays put; the result
// is never written anywhere and only the public half leaves this
// function's caller. Async, so only handlers call it — the order card
// itself renders from the keys the request already names.
export async function orderEscrowKey(secretKeyBytes, saltHex) {
  if (!(secretKeyBytes instanceof Uint8Array) || secretKeyBytes.length !== 32) {
    throw new Error('Derive the order key from the account 32-byte secret.');
  }
  const salt = hexToScript(String(saltHex ?? '').trim().toLowerCase()); // reads hex, returns bytes
  if (!SALT_PATTERN.test(scriptToHex(salt))) {
    throw new Error('The escrow slot on this order is not a valid key slot.');
  }
  const base = await crypto.subtle.importKey('raw', secretKeyBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: ESCROW_HKDF_INFO },
    base,
    256,
  );
  const privateKeyBytes = new Uint8Array(bits);
  const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));
  return { privateKeyBytes, publicKeyHex };
}

// The slot a buyer drops onto its own order request: the public keys and
// a salt, nothing private.
export async function escrowRequestSlot(secretKeyBytes) {
  const salt = newEscrowSalt();
  const { publicKeyHex } = await orderEscrowKey(secretKeyBytes, salt);
  return { salt, publicKeyHex };
}

export function escrowDelayDays(delayBlocks) {
  return Math.round(Number(delayBlocks) / BLOCKS_PER_DAY);
}

// The acceptance the vendor sends and keeps: the script, the address,
// and the whole fee table — every sat amount as the decimal string the
// journal and the order card both read. The numbers are computed HERE
// from priceSats; the caller passes keys and a timer, and no fee of its
// own ever, so both sides can decode the same card to the same quote.
export function buildEscrowAcceptance({ priceSats, delayBlocks = DEFAULT_DELAY_BLOCKS, vendorPubHex, buyerPubHex, issuedAt, overtHashHex }) {
  if (typeof priceSats !== 'bigint' || !canEscrow(priceSats)) {
    throw new Error(`Escrow orders run ${satsToCoins(MIN_ORDER_SATS)} BTC or more, so the fee is not dust.`);
  }
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) {
    throw new Error('An escrow acceptance is dated when its address was issued.');
  }
  // Every escrow order is a Dead Drop box: the acceptance REQUIRES the
  // vendor's delivery commitment (overtHashHexOf the local nonce), so
  // the script carries the overt branch from funding onward. An order
  // without a spoken commitment would leave the vendor no unilateral
  // exit and the buyer no chain-grade delivery word.
  const commitment = String(overtHashHex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(commitment)) {
    throw new Error('An escrow acceptance needs the delivery commitment — sha256 of the vendor’s own delivery nonce.');
  }
  const scriptHex = scriptToHex(assembleClockClaimScript({
    vendorPubKey: hexToScript(vendorPubHex),
    buyerPubKey: hexToScript(buyerPubHex),
    delayBlocks,
    overtHash: hexToScript(commitment),
  }));
  const q = quoteEscrow(priceSats);
  const escrow = {
    scriptHex,
    address: escrowAddress(hexToScript(scriptHex)),
    priceSats: priceSats.toString(),
    buyerFeeSats: q.buyerFeeSats.toString(),
    vendorFeeSats: q.vendorFeeSats.toString(),
    feeOutSats: q.feeOutSats.toString(),
    depositSats: q.depositSats.toString(),
    delayBlocks,
    issuedAt,
    overtHashHex: commitment,
  };
  // The acceptance rides the same order_update rail a direct-deal
  // acceptance rides. No paymentMethods line is issued: the deposit
  // goes straight to the escrow address, never a vendor wallet.
  return {
    escrow,
    patch: {
      status: ORDER_STATUS.ACCEPTED,
      paymentState: 'address_issued',
      escrow,
      coinAmount: unitsToCoins(priceSats, 'btc'),
      coinCurrency: 'btc',
      issuedAt,
    },
  };
}

// The quote a reader adopts off an order card, or null. Nothing here
// trusts the peer's arithmetic: the price parses, the fees recompute
// from it, the address re-derives from the script, the timer claim
// matches the timer bytes. Any disagreement and the card carries no
// escrow as far as this device is concerned.
export function escrowForCard(data) {
  const escrow = data?.escrow;
  if (!escrow || typeof escrow !== 'object') return null;
  let script;
  try {
    script = hexToScript(String(escrow.scriptHex ?? '').trim().toLowerCase());
  } catch {
    return null;
  }
  const decoded = decodeOrderScript(script);
  if (!decoded) return null;
  const priceSats = satsFromString(escrow.priceSats);
  if (!priceSats || !canEscrow(priceSats)) return null;
  const q = quoteEscrow(priceSats);
  if (satsFromString(escrow.buyerFeeSats) !== q.buyerFeeSats) return null;
  if (satsFromString(escrow.vendorFeeSats) !== q.vendorFeeSats) return null;
  const address = String(escrow.address ?? '').trim().toLowerCase();
  if (!address || escrowAddress(script) !== address) return null;
  if (escrow.delayBlocks !== decoded.delayBlocks) return null;
  if (!Number.isInteger(escrow.issuedAt) || escrow.issuedAt <= 0) return null;
  // The commitment the card SPEAKS must be the one the script EMBEDS
  // (same law the membrane holds at the escrow_open door). A card whose
  // spoken overt hash disagrees with its own script reads back as no
  // escrow. Old plain boxes speak nothing; their quote says so.
  let overtHashHex = null;
  if (decoded.overtHash !== null) {
    const spoken = String(escrow.overtHashHex ?? '').trim().toLowerCase();
    const embedded = scriptToHex(decoded.overtHash);
    if (spoken !== embedded) return null;
    overtHashHex = embedded;
  }
  return {
    scriptHex: scriptToHex(script),
    address,
    vendorPubHex: bytesToHex(decoded.vendorPubKey),
    buyerPubHex: bytesToHex(decoded.buyerPubKey),
    delayBlocks: decoded.delayBlocks,
    priceSats,
    buyerFeeSats: q.buyerFeeSats,
    vendorFeeSats: q.vendorFeeSats,
    feeOutSats: q.feeOutSats,
    depositSats: q.depositSats,
    issuedAt: escrow.issuedAt,
    overtHashHex,
  };
}

// What escrow adds to one card's buttons. Only the vendor, on a pending
// order, gets a tap this phase: "Accept with escrow", beside the direct
// accept that stays the first and default button. The funded-phase taps
// (Approve release / Request refund) turn on with the membrane reroute,
// when watcher reports establish the escrow's money state on these
// cards — the FSM table is already the law for those.
export function escrowActionsFor(message, messages, ownPubkey) {
  const data = message?.data;
  const isRequest = data?.type === 'order_request' || data?.type === 'cipher_order';
  if (!isRequest || message.isSender) return [];
  try {
    if (orderState(messages, message.id, message, ownPubkey).status !== ORDER_STATUS.PENDING) return [];
  } catch {
    return [];
  }
  if (!escrowSaltOf(data)) return [];
  const priceCoins = orderCoinAmount(data.product, 'btc');
  if (!priceCoins) return [];
  if (!canEscrow(coinUnits(priceCoins, 'btc'))) return [];
  return [{ action: 'accept_with_escrow', label: 'Accept with escrow', target: 'request' }];
}

// The Dead Drop receipt words (round-2 card, vectors 7 and 8). An overt
// refund moves money on the vendor's own claim of delivery — the chain
// proves the assertion was made, never that atoms moved, so these words
// upgrade nothing. Whatever renders an overt refund takes them
// verbatim: never "verified", never "confirmed", never "proof".
export const OVERT_REFUND_TITLE = 'Returned in full';
export const OVERT_REFUND_LINE = 'The vendor said they delivered. The money went home on their word, not an inspection.';

// The one payment row an accepted escrow card shows: the deposit, to the
// 2-of-2 address, through the same bitcoin: URI rail a direct deal pays.
export function escrowPaymentRow(quote) {
  if (!quote) return null;
  const amount = unitsToCoins(quote.depositSats, 'btc');
  return {
    currency: 'BTC',
    address: quote.address,
    amount,
    uri: paymentUri('BTC', quote.address, amount, 'BTC'),
  };
}

// Escrow rows on an order card, ready to join the direct-deal payment
// rows. The buyer only ever pays a quote whose refund key is the slot
// key the buyer's own request named — the stranger-key script above
// would eat the deposit and the refund, so it renders no row.
export function escrowRowsFor(message, messages, content) {
  const quote = escrowForCard(content);
  if (!quote || content?.status !== ORDER_STATUS.ACCEPTED) return [];
  if (message?.isSender) return [escrowPaymentRow(quote)];
  const orderId = String(content.orderId || message?.id || '');
  const list = Array.isArray(messages) ? messages : [];
  const request = list.find((m) => m?.id === orderId && (
    m?.data?.type === 'order_request' || m?.data?.type === 'cipher_order'
  ));
  if (!request) return [];
  const slotKey = String(request.data.escrowPubKey ?? '').trim().toLowerCase();
  if (!PUBKEY_PATTERN.test(slotKey) || slotKey !== quote.buyerPubHex) return [];
  return [escrowPaymentRow(quote)];
}
