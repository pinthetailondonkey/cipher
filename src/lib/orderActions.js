import { ORDER_STATUS as S, isOrderStatus, orderCoinAmount } from './paymentState.js';
import { verifyReceipt } from './proofOfTrade.js';

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

function paymentEvidence(messages, orderId, request) {
  const rank = (state) => Math.max(0, PAYMENT_RANK.indexOf(state));
  let paymentState = '';
  let paymentSeenBy = '';
  const adopt = (source) => {
    if (!source) return;
    const state = PAYMENT_RANK.includes(source.paymentState) ? source.paymentState : '';
    if (state && rank(state) > rank(paymentState)) paymentState = state;
    if (!paymentSeenBy && source.paymentSeenBy) paymentSeenBy = source.paymentSeenBy;
  };
  if (request?.isSender) adopt(request.data);
  else adopt(request?.localPatch || null);
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.data?.type !== 'order_update' || message.data.orderId !== orderId) continue;
    if (message.isSender) {
      adopt(message.data);
      continue;
    }
    adopt(message.localPatch || null);
    const receipt = message.data.receipt;
    if (receipt?.body && String(receipt.body.orderId) === String(orderId) && verifyReceipt(receipt)) {
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
export function orderState(messages, orderId, request) {
  const updates = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.data?.type === 'order_update' && message.data.orderId === orderId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  const latest = updates[updates.length - 1] || null;
  const payment = paymentEvidence(messages, orderId, request);
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

// The order record a receipt must bind to: the request card on this device,
// the latest coin amount either side put on the order, and the address this
// device issued for it. Null when the order is missing or not open to a
// receipt yet.
export function orderRecordForReceipt(messages, orderId) {
  const list = Array.isArray(messages) ? messages : [];
  const request = list.find((message) => message?.id === orderId
    && (message.data?.type === 'order_request' || message.data?.type === 'cipher_order'));
  if (!request) return null;
  const status = orderState(list, orderId, request).status;
  if (!RECEIPT_STATUSES.has(status)) return null;
  const updates = (list.filter((m) => m?.data?.type === 'order_update' && m.data.orderId === orderId))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
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
  const peerValue = (prop) => {
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

// The one table of what each side may do with an order in each state. Every
// order button renders from this. A status it does not know is an error.
export function allowedActionsFor(order, viewer) {
  const { status, paymentState = 'created', paymentSeenBy = '' } = order || {};
  if (!isOrderStatus(status)) throw new Error(`Unknown order status: ${status}`);
  const named = (...actions) => actions.map((action) => ({ action, label: ACTION[action] }));
  if (viewer === 'vendor') {
    if (status === S.PENDING) return named('accept_order', 'decline_order');
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
    if (status === S.SHIPPED) return named('confirm_delivery', 'report_issue');
    if (status === S.ACCEPTED || status === S.PAID) return named('report_issue');
    return [];
  }
  throw new Error(`Unknown order viewer: ${viewer}`);
}

// Buttons for one card. Only the request card carries them, so each order
// has one place to act. The vendor's actions go to the buyer, msg.pubkey on
// that card; the buyer's go to the vendor, the chat peer.
export function orderActionsFor(message, messages) {
  if (!isRequest(message?.data)) return [];
  const viewer = message.isSender ? 'buyer' : 'vendor';
  try {
    return allowedActionsFor(orderState(messages, message.id, message), viewer)
      .map((item) => ({ ...item, target: viewer === 'vendor' ? 'request' : 'peer' }));
  } catch (error) {
    console.warn('[orders] No actions for this order:', error.message);
    return [];
  }
}
