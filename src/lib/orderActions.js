import { ORDER_STATUS as S, isOrderStatus } from './paymentState.js';

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

// The order's state is the newest update either side sent for it, over what
// this device changed on the request card itself.
export function orderState(messages, orderId, request) {
  const updates = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.data?.type === 'order_update' && message.data.orderId === orderId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  const latest = updates[updates.length - 1] || null;
  const withPayment = [...updates].reverse().find((update) => update.data.paymentState);
  return {
    status: latest?.data?.status || request?.data?.status || S.PENDING,
    paymentState: withPayment?.data.paymentState || request?.data?.paymentState || 'created',
    paymentSeenBy: withPayment?.data.paymentSeenBy || request?.data?.paymentSeenBy || '',
  };
}

// The payment details a chain check reads for an order, for either party. The
// buyer's own card never carried an address (the buyer wrote the request), so
// the acceptance the vendor sent — an update in this chat — is where the
// address and the coin amount come from. Both sides read the same updates.
export function orderPaymentDetails(messages, orderId) {
  const list = Array.isArray(messages) ? messages : [];
  const request = list.find((message) => message?.id === orderId && isRequest(message.data));
  if (!request) return null;
  const state = orderState(list, orderId, request);
  const updates = list.filter((m) => m?.data?.type === 'order_update' && m.data.orderId === orderId);
  const latest = (prop) => [...updates].reverse().find((update) => update.data?.[prop] != null && update.data?.[prop] !== '');
  return {
    status: state.status,
    paymentState: state.paymentState,
    paymentSeenBy: state.paymentSeenBy,
    paymentMethods: latest('paymentMethods')?.data.paymentMethods || request.data.paymentMethods || null,
    coinCurrency: latest('coinCurrency')?.data.coinCurrency || request.data.coinCurrency || '',
    coinAmount: latest('coinAmount')?.data.coinAmount ?? request.data.coinAmount ?? '',
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

// What a disputed order returns to when this side reopens it. Not history:
// the payment state the order already reached decides it. Money seen or
// confirmed puts the order back to paid; anything else back to accepted, so
// the address stays issued (security S5) and the chain check can run again.
export function reopenedStatus(paymentState) {
  return paymentState === 'seen' || paymentState === 'confirmed' ? S.PAID : S.ACCEPTED;
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
  const request = list.find((message) => message?.id === orderId && isRequest(message.data));
  if (!request) return null;
  const status = orderState(list, orderId, request).status;
  if (!RECEIPT_STATUSES.has(status)) return null;
  const details = orderPaymentDetails(list, orderId);
  return {
    status,
    coinAmount: details.coinAmount,
    coinCurrency: details.coinCurrency,
    issuedAddress: details.coinCurrency && details.paymentMethods
      ? String(details.paymentMethods[details.coinCurrency] || '')
      : '',
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
    // A dispute is not a dead end (security S6): the vendor pays it back or
    // reopens the order, and both stay visible on both sides' cards.
    if (status === S.DISPUTED) return named('mark_refunded', 'resume_order');
    if (status === S.REFUNDED || status === S.CANCELLED || status === S.COMPLETED) return [];
    const actions = [];
    if (status === S.ACCEPTED && paymentSeenBy !== 'vendor' && paymentState !== 'confirmed') actions.push('confirm_payment');
    if ((status === S.ACCEPTED || status === S.PAID) && paymentState !== 'confirmed') actions.push('check_chain');
    if (status === S.PAID) actions.push('mark_shipped');
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
