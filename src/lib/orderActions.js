import { ORDER_STATUS as S, isOrderStatus, PAYMENT_STATES } from './paymentState.js';

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

// A payment state an update claims is worth exactly the evidence it carries.
// 'confirmed' shows only with the watcher behind it (paymentSeenBy 'watcher');
// a stranger's crafted update cannot display their own word as a confirmation.
// A bare 'seen' claim, with nobody's name on it, stands only as far as an
// issued address. An unknown state is not a state at all.
const PAYMENT_RANK = { created: 0, address_issued: 1, seen: 2, confirmed: 3 };
export function paymentClaim(state, seenBy) {
  if (!PAYMENT_STATES.includes(state)) return null;
  if (state === 'confirmed' && seenBy !== 'watcher') return 'seen';
  if (state === 'seen' && !seenBy) return 'address_issued';
  return state;
}

// The order's state is the newest update either side sent for it, over what
// this device changed on the request card itself. A payment display never
// walks back: a newer update claiming less than an evidenced state, or
// claiming a state it has no evidence for, is ignored.
export function orderState(messages, orderId, request) {
  const updates = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.data?.type === 'order_update' && message.data.orderId === orderId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  const latest = updates[updates.length - 1] || null;
  let state = paymentClaim(request?.data?.paymentState, request?.data?.paymentSeenBy) || 'created';
  let seenBy = request?.data?.paymentSeenBy || '';
  for (const update of updates) {
    const claimed = paymentClaim(update.data.paymentState, update.data.paymentSeenBy);
    if (!claimed || PAYMENT_RANK[claimed] < PAYMENT_RANK[state]) continue;
    const by = update.data.paymentSeenBy || '';
    // On an even rank, only a watcher claim un-sees the vendor's word.
    if (PAYMENT_RANK[claimed] === PAYMENT_RANK[state] && claimed === state
      && !(claimed === 'seen' && seenBy === 'vendor' && by !== 'vendor')) continue;
    state = claimed;
    seenBy = by || seenBy;
  }
  return {
    status: latest?.data?.status || request?.data?.status || S.PENDING,
    paymentState: state,
    paymentSeenBy: seenBy,
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
