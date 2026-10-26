import { ORDER_STATUS as S, isOrderStatus, orderCoinAmount } from './paymentState.js';
import { canonicalReceipt, verifyReceipt } from './proofOfTrade.js';

const REQUEST_TYPES = new Set(['order_request', 'cipher_order']);

const ACTION = {
  accept_order: 'Accept order',
  decline_order: 'Decline',
  confirm_payment: 'I saw the payment',
  check_chain: 'Check the chain',
  mark_shipped: 'Mark shipped',
  cancel_order: 'Cancel order',
  confirm_delivery: 'Confirm delivery',
  report_issue: 'Report an issue',
  resume_order: 'Reopen the order',
  mark_refunded: 'Mark refunded',
};

export const ORDER_ACTIONS = Object.freeze(Object.keys(ACTION));

function isRequest(data) {
  return REQUEST_TYPES.has(data?.type);
}

// F7: the payment facts on an order are earned on this device, not asserted
// by the peer. A received card or update can name any paymentState or
// paymentSeenBy it likes, so none of those fields count as evidence unless
// (a) this device set them — a localPatch, or a message this device sent —
// or (b) the update carries a two-sided verified receipt that names this
// order, the one artifact both parties signed. The lifecycle status still
// reads as the newest update states it; the gates on actions decide what a
// claim alone is allowed to do.
const PAYMENT_RANK = ['created', 'address_issued', 'seen', 'confirmed'];

// A receipt verifies whoever signed it; it counts as payment only when the
// parties it names are the two of this chat. Two keys the attacker holds
// both verify, so the body must name the counterparty — and this device,
// when the caller can name itself, or at least the role the direction of
// the chat implies. (security F7)
function receiptIsOfThisChat(receipt, orderId, request, ownPubkey) {
  try {
    if (!receipt?.body || String(receipt.body.orderId) !== String(orderId)) return false;
    const body = canonicalReceipt(receipt.body);
    const buyer = String(body.buyer || '').toLowerCase();
    const vendor = String(body.vendor || '').toLowerCase();
    if (!buyer || !vendor) return false;
    const counterparty = String(request?.pubkey || '').toLowerCase();
    if (ownPubkey) {
      const chat = [counterparty, String(ownPubkey).toLowerCase()].sort().join();
      return [buyer, vendor].sort().join() === chat;
    }
    if (!counterparty) return false;
    const role = request.isSender ? vendor : buyer;
    return role === counterparty;
  } catch {
    return false;
  }
}

function paymentEvidence(messages, orderId, request, ownPubkey) {
  const rank = (state) => Math.max(0, PAYMENT_RANK.indexOf(state));
  let paymentState = '';
  let paymentSeenBy = '';
  const adopt = (source) => {
    if (!source) return;
    const state = PAYMENT_RANK.includes(source.paymentState) ? source.paymentState : '';
    if (state && rank(state) > rank(paymentState)) paymentState = state;
    if (!paymentSeenBy && source.paymentSeenBy) paymentSeenBy = source.paymentSeenBy;
  };
  if (request?.isSender) {
    adopt(request.data);
    // A local patch on this device's own card is its own write too — the
    // buyer's watcher check lands there (security S6).
    if (request.localPatch) adopt(request.localPatch);
  } else {
    adopt(request?.localPatch || null);
  }
  // A receipt counts through the same gate the ledger's ✓ reads (below).
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.data?.type !== 'order_update' || message.data.orderId !== orderId) continue;
    if (message.isSender) {
      adopt(message.data);
      continue;
    }
    adopt(message.localPatch || null);
    const receipt = message.data.receipt;
    if (receipt && receiptIsOfThisChat(receipt, orderId, request, ownPubkey) && verifyReceipt(receipt)) {
      // A receipt the device never verified rows no payment. A signed one
      // names what the watcher saw: confirmed, or back to the payer.
      adopt({ paymentState: receipt.body.outcome === 'confirmed' ? 'confirmed' : 'seen' });
    }
  }
  return { paymentState: paymentState || 'created', paymentSeenBy };
}

// The order's state is the newest update either side sent for it, over what
// this device changed on the request card itself. Payment facts are evidence,
// never the newest claim (F7 above).
export function orderState(messages, orderId, request, ownPubkey) {
  const updates = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.data?.type === 'order_update' && message.data.orderId === orderId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  const latest = updates[updates.length - 1] || null;
  const payment = paymentEvidence(messages, orderId, request, ownPubkey);
  return {
    status: latest?.data?.status || request?.data?.status || S.PENDING,
    paymentState: payment.paymentState,
    paymentSeenBy: payment.paymentSeenBy,
  };
}

// An incoming receipt binds only an order this device tracks that is accepted
// or further along. A pending order never agreed to anything and a cancelled
// or disputed one stays closed, so neither stores nor signs a receipt.
const RECEIPT_STATUSES = new Set([S.ACCEPTED, S.PAID, S.SHIPPED, S.COMPLETED]);

// The orders ledger's ✓: a receipt both parties signed, binding this order
// and this chat, that this device re-verified. Anything else is a claim,
// never proof.
export function orderHasVerifiedReceipt(messages, orderId, request, ownPubkey) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (message?.data?.type !== 'order_update' || message.data.orderId !== orderId) return false;
    const receipt = message.data.receipt;
    return Boolean(receipt && receiptIsOfThisChat(receipt, orderId, request, ownPubkey) && verifyReceipt(receipt));
  });
}

// The payment details a chain check reads for an order, for either party. The
// buyer's own card never carried an address (the buyer wrote the request), so
// the acceptance the vendor sent — an update in this chat — is where the
// address and the coin amount come from. Both sides read the same updates.
export function orderPaymentDetails(messages, orderId, ownPubkey) {
  const list = Array.isArray(messages) ? messages : [];
  const request = list.find((message) => message?.id === orderId && isRequest(message.data));
  if (!request) return null;
  const state = orderState(list, orderId, request, ownPubkey);
  const updates = list.filter((m) => m?.data?.type === 'order_update' && m.data.orderId === orderId);
  const latest = (prop) => [...updates].reverse().find((update) => update.data?.[prop] != null && update.data?.[prop] !== '');
  return {
    status: state.status,
    paymentState: state.paymentState,
    paymentSeenBy: state.paymentSeenBy,
    paymentMethods: latest('paymentMethods')?.data.paymentMethods || request.data.paymentMethods || null,
    coinCurrency: latest('coinCurrency')?.data.coinCurrency || request.data.coinCurrency || '',
    coinAmount: latest('coinAmount')?.data.coinAmount ?? request.data.coinAmount ?? '',
    // When the address this order pays was issued — the acceptance's mark,
    // written when the vendor derived it. The chain check refuses a
    // transfer dated before it. (security S1)
    issuedAt: latest('issuedAt')?.data.issuedAt ?? null,
  };
}

// The order record a receipt must bind to: the request card on this device,
// the latest coin amount either side put on the order, and the address this
// device issued for it. Null when the order is missing or not open to a
// receipt yet.
export function orderRecordForReceipt(messages, orderId, ownPubkey) {
  const list = Array.isArray(messages) ? messages : [];
  const request = list.find((message) => message?.id === orderId && isRequest(message.data));
  if (!request) return null;
  const status = orderState(list, orderId, request, ownPubkey).status;
  if (!RECEIPT_STATUSES.has(status)) return null;
  const updates = (list.filter((m) => m?.data?.type === 'order_update' && m.data.orderId === orderId))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  // The lifecycle status is the newest claim, so on the vendor side the
  // record exists only once this device agreed: an acceptance update of its
  // own. A peer's fake 'paid' claim on a never-accepted order builds no
  // record here, so nothing stores or cosigns a receipt for it. (security F4)
  if (!request.isSender
    && !updates.some((update) => update.isSender && RECEIPT_STATUSES.has(update.data?.status))) return null;
  const newestFirst = [...updates].reverse();
  // F4 re-attack: the amount of record and the issued address are what this
  // device wrote — its own acceptance update, its own request card, its local
  // patches. A received update's fields are the peer's word and never move
  // them, so a fake later update cannot shrink the amount or steal the
  // address slot. Only the buyer's record still reads the vendor's announced
  // payment methods as a fallback: the acceptance is the one announcement of
  // where to pay.
  const ownValue = (prop) => {
    for (const update of newestFirst) {
      if (!update.isSender) continue;
      const value = update.data?.[prop];
      if (value != null && value !== '') return value;
    }
    if (!request.isSender) {
      const value = request.localPatch?.[prop];
      if (value != null && value !== '') return value;
      return null;
    }
    return request.data?.[prop] ?? null;
  };
  // The peer's word fills the record only on the buyer side, where the
  // acceptance — the vendor's announcement of where to pay — is the one
  // announcement the buyer could never have written itself. On the vendor
  // side the record is this device's own write or nothing. (security F4)
  const peerValue = !request.isSender ? (() => null) : (prop) => {
    for (const update of newestFirst) {
      const value = update.data?.[prop];
      if (value != null && value !== '') return value;
    }
    return null;
  };
  const productCurrency = String(request.data.product?.currency || '').toLowerCase();
  // The record's currency: what this device wrote, then the peer's choice,
  // then a coin-priced listing. The currency swap is harmless in the binding
  // arithmetic — the same currency prices both the got and the need — and a
  // swap away from the announced methods only drops the address.
  const coinCurrency = ownValue('coinCurrency')
    || peerValue('coinCurrency')
    || (['btc', 'xmr'].includes(productCurrency) ? productCurrency : '');
  const productPrice = orderCoinAmount(request.data.product, coinCurrency);
  const coinAmount = ownValue('coinAmount')
    ?? (productPrice != null && productPrice !== '' ? productPrice
      : peerValue('coinAmount') ?? request.data.coinAmount ?? '');
  const methods = ownValue('paymentMethods') || peerValue('paymentMethods') || request.data.paymentMethods || null;
  return {
    status,
    coinAmount,
    coinCurrency,
    issuedAddress: coinCurrency && methods ? String(methods[coinCurrency] || '') : '',
    isBuyer: !!request.isSender,
  };
}

// The payment methods an order card already carries. Once an address is
// issued for an order it is frozen there (security S5): acceptance reuses
// these and never derives a fresh one, so a buyer who paid the first issued
// address is never strafed by a newer card. Null while nothing is issued.
export function issuedPaymentMethods(orderData) {
  const methods = orderData?.paymentMethods;
  if (!methods || typeof methods !== 'object') return null;
  const btc = String(methods.btc || '').trim();
  const xmr = String(methods.xmr || '').trim();
  return btc || xmr ? { btc: btc || null, xmr: xmr || null } : null;
}

// The issued pair acceptance is allowed to freeze. The card's local patch is
// where this device wrote the pair when it accepted the order before; a pair
// sitting on a fresh received card is the buyer's word — paymentMethods
// authored on an order request was typed by whoever sent it — and never
// freezes. A pair the account's shared address was parked on does not freeze
// either: a re-accept derives fresh instead of serving the shared address
// again, which is what per-order derivation exists to prevent. The compare
// is case-blind, so a mixed-case bech32 twin of the shared address cannot
// slip past it. (security S1, S5)
export function frozenIssuedMethods(request, sharedAddresses) {
  const methods = issuedPaymentMethods(request?.localPatch);
  if (!methods) return null;
  const shared = (coin) => String(sharedAddresses?.[coin] || '').trim().toLowerCase();
  const own = (coin) => String(methods[coin] || '').trim().toLowerCase();
  const btc = own('btc') && shared('btc') && own('btc') === shared('btc') ? null : methods.btc;
  const xmr = own('xmr') && shared('xmr') && own('xmr') === shared('xmr') ? null : methods.xmr;
  return btc || xmr ? { btc: btc || null, xmr: xmr || null } : null;
}

// What a disputed order returns to when this side reopens it. Not history:
// the payment state the order already reached decides it. Money seen or
// confirmed puts the order back to paid; anything else back to accepted, so
// the address stays issued (security S5) and the chain check can run again.
export function reopenedStatus(paymentState) {
  return paymentState === 'seen' || paymentState === 'confirmed' ? S.PAID : S.ACCEPTED;
}

// The one table of what each side may do with an order in each state. Every
// order button renders from this. A status it does not know is an error.
export function allowedActionsFor(order, viewer) {
  const { status, paymentState = 'created', paymentSeenBy = '' } = order || {};
  if (!isOrderStatus(status)) throw new Error(`Unknown order status: ${status}`);
  const named = (...actions) => actions.map((action) => ({ action, label: ACTION[action] }));
  if (viewer === 'vendor') {
    if (status === S.PENDING) return named('accept_order', 'decline_order');
    // A dispute is not a dead end (security S6): the vendor pays it back or
    // reopens the order, and both stay visible on both sides' cards.
    if (status === S.DISPUTED) return named('mark_refunded', 'resume_order');
    if (status === S.REFUNDED || status === S.CANCELLED || status === S.COMPLETED) return [];
    const actions = [];
    if (status === S.ACCEPTED && paymentSeenBy !== 'vendor' && paymentState !== 'confirmed') actions.push('confirm_payment');
    if ((status === S.ACCEPTED || status === S.PAID) && paymentState !== 'confirmed') actions.push('check_chain');
    // F7: shipping stands on payment evidence — the vendor's own wallet
    // sight or a countersigned receipt. A status the peer claimed on its own
    // never opens it.
    if (status === S.PAID && (paymentState === 'seen' || paymentState === 'confirmed')) actions.push('mark_shipped');
    return named(...actions);
  }
  if (viewer === 'buyer') {
    if (status === S.PENDING) return named('cancel_order');
    // The dispute keeps a resolution step (security S6): the buyer may verify
    // the payment from their own watcher, or abandon the deal outright.
    if (status === S.DISPUTED) {
      return paymentState !== 'confirmed' ? named('check_chain', 'cancel_order') : named('cancel_order');
    }
    if (status === S.SHIPPED) return named('confirm_delivery', 'report_issue');
    // A buyer is party to the receiving address by definition (security S6):
    // the same chain check the vendor runs is on their card too, while the
    // payment is not confirmed yet.
    if (status === S.ACCEPTED || status === S.PAID) {
      return paymentState !== 'confirmed' ? named('check_chain', 'report_issue') : named('report_issue');
    }
    return [];
  }
  throw new Error(`Unknown order viewer: ${viewer}`);
}

// Buttons for one card. Only the request card carries them, so each order
// has one place to act. The vendor's actions go to the buyer, msg.pubkey on
// that card; the buyer's go to the vendor, the chat peer.
export function orderActionsFor(message, messages, ownPubkey) {
  if (!isRequest(message?.data)) return [];
  const viewer = message.isSender ? 'buyer' : 'vendor';
  try {
    return allowedActionsFor(orderState(messages, message.id, message, ownPubkey), viewer)
      .map((item) => ({ ...item, target: viewer === 'vendor' ? 'request' : 'peer' }));
  } catch (error) {
    console.warn('[orders] No actions for this order:', error.message);
    return [];
  }
}
