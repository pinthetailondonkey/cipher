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
  const latest = (prop) => [...updates].reverse().find((update) => update.data?.[prop] != null && update.data?.[prop] !== '');
  const coinCurrency = latest('coinCurrency')?.data.coinCurrency || request.data.coinCurrency || '';
  const coinAmount = latest('coinAmount')?.data.coinAmount ?? request.data.coinAmount ?? '';
  const methods = [...updates].reverse().find((update) => update.data?.paymentMethods)?.data.paymentMethods
    || request.data.paymentMethods || null;
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
    if (status === S.PAID) actions.push('mark_shipped');
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
