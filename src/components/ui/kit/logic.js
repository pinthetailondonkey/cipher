// Pure logic behind the kit: no React, no DOM, so node tests can run it.
// Everything that decides what a card says or does is derived from the real
// order model (paymentState.js, orderActions.js). Nothing here invents a
// status, an action or a number.
import { ORDER_STATUS as S, PAYMENT_STATES } from '../../../lib/paymentState.js';
import { allowedActionsFor } from '../../../lib/orderActions.js';

// ---------------------------------------------------------------- counts

// A tab or row badge: nothing at zero, the number to 99, then "99+".
export function capBadge(count, cap = 99) {
  const n = Math.trunc(Number(count));
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > cap ? `${cap}+` : String(n);
}

// ---------------------------------------------------------------- amounts

// Decimals shown per currency. Bitcoin 8, Monero 12 (the chains' own
// precision), dollars 2. Rounding is half up, done on the digit string.
// A float is not a coin amount: numbers are read through String() and
// anything that is not a plain non-negative decimal shows nothing.
const DECIMALS = { USD: 2, BTC: 8, XMR: 12 };
const PLAIN_DECIMAL = /^(\d+)(?:\.(\d*))?$/;

export function amountParts(amount, currency) {
  if (typeof amount === 'number' && !Number.isFinite(amount)) return null;
  if (amount === null || amount === undefined || typeof amount === 'object') return null;
  const match = PLAIN_DECIMAL.exec(String(amount).trim());
  if (!match) return null;
  const unit = String(currency || 'USD').trim().toUpperCase();
  let whole = match[1];
  let fraction = match[2] || '';
  const places = DECIMALS[unit];
  if (places !== undefined) {
    if (fraction.length > places) {
      const roundUp = fraction.charCodeAt(places) >= 53; // '5'
      let scaled = BigInt(whole + fraction.slice(0, places));
      if (roundUp) scaled += 1n;
      const digits = scaled.toString().padStart(places + 1, '0');
      whole = digits.slice(0, digits.length - places);
      fraction = digits.slice(digits.length - places);
    }
    whole = BigInt(whole).toString();
  } else {
    whole = whole.replace(/^0+(?=\d)/, '');
  }
  fraction = fraction.replace(/0+$/, '');
  if (unit === 'USD') {
    if (fraction) fraction = fraction.padEnd(2, '0');
    whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return { prefix: '$', value: fraction ? `${whole}.${fraction}` : whole, unit: '' };
  }
  return { prefix: '', value: fraction ? `${whole}.${fraction}` : whole, unit };
}

export function formatAmount(amount, currency) {
  const parts = amountParts(amount, currency);
  if (!parts) return '';
  return `${parts.prefix}${parts.value}${parts.unit ? ` ${parts.unit}` : ''}`;
}

// A short, stable label for an order card, from the order's own event id.
export function shortOrderId(id, length = 6) {
  const clean = String(id ?? '').toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, length);
  return clean ? `#${clean}` : '';
}

// ---------------------------------------------------------------- order view

// Words are the ones the order card already speaks (MessageBubble's
// orderLabel), with one difference in order: lifecycle first, payment
// second, so a shipped order whose payment is confirmed says Shipped, not
// Confirmed. "Waiting" is new (an unanswered request); it is awaiting
// founder approval.
export function orderStatusLabel(state) {
  const { status, paymentState = 'created', paymentSeenBy = '' } = state || {};
  if (status === S.DISPUTED) return { text: 'Disputed', tone: 'danger' };
  if (status === S.REFUNDED) return { text: 'Refunded', tone: 'neutral' };
  if (status === S.CANCELLED) return { text: 'Cancelled', tone: 'neutral' };
  if (status === S.COMPLETED) return { text: 'Delivered', tone: 'success' };
  if (status === S.SHIPPED) return { text: 'Shipped', tone: 'blue' };
  if (status === S.PENDING) return { text: 'Waiting', tone: 'neutral' };
  if (paymentState === 'confirmed') return { text: 'Confirmed', tone: 'success' };
  if (paymentState === 'seen' && paymentSeenBy !== 'vendor') return { text: 'Seen on-chain', tone: 'blue' };
  // Only the vendor's own wallet, or a bare "paid" claim: not a chain fact.
  if (status === S.PAID || paymentSeenBy === 'vendor') return { text: 'Marked paid', tone: 'warning' };
  if (status === S.ACCEPTED || paymentState === 'address_issued') return { text: 'Address sent', tone: 'blue' };
  return { text: 'Awaiting payment', tone: 'neutral' };
}

// Forward steps get the one blue button, in this order; everything else the
// table allows (decline, cancel, report, refund) stays a quiet second
// action. A card never shows an action the table did not allow.
const PRIMARY_ORDER = ['accept_order', 'mark_shipped', 'confirm_delivery', 'confirm_payment', 'check_chain', 'resume_order'];
const PAYMENT_STEPS = PAYMENT_STATES.length;
const PROGRESS_STATUSES = new Set([S.ACCEPTED, S.PAID, S.SHIPPED, S.COMPLETED]);

export function transactionView(state, viewer) {
  let actions = [];
  let unknown = false;
  try {
    actions = allowedActionsFor(state, viewer);
  } catch {
    unknown = true;
  }
  const primary = PRIMARY_ORDER
    .map((id) => actions.find((item) => item.action === id))
    .find(Boolean) || null;
  const secondary = actions.filter((item) => item !== primary);
  const rank = Math.max(0, PAYMENT_STATES.indexOf(state?.paymentState));
  // Progress is the payment walk (created, address issued, seen, confirmed)
  // and only exists after the vendor accepted: before that nothing is issued
  // and after cancel, refund or dispute the walk is not the story.
  const progress = !unknown && PROGRESS_STATUSES.has(state?.status)
    ? { filled: rank + 1, total: PAYMENT_STEPS }
    : null;
  return {
    unknown,
    label: unknown ? { text: '', tone: 'neutral' } : orderStatusLabel(state),
    group: orderGroupOf(state, viewer),
    progress,
    primary,
    secondary,
    actions,
  };
}

// Needs action = the next move is this viewer's. In progress = waiting on
// someone or something else. Done = the deal is sealed.
export function orderGroupOf(state, viewer) {
  const { status, paymentState = 'created', resurrected = false } = state || {};
  if (status === S.COMPLETED || status === S.CANCELLED || status === S.REFUNDED) return 'done';
  if (viewer === 'vendor') {
    if (status === S.PENDING) return 'needs_action';
    if (resurrected) return 'in_progress';
    if (status === S.PAID && (paymentState === 'seen' || paymentState === 'confirmed')) return 'needs_action';
    if (status === S.DISPUTED) return 'needs_action';
    return 'in_progress';
  }
  if (viewer === 'buyer' && !resurrected) {
    const unpaid = paymentState === 'created' || paymentState === 'address_issued';
    if ((status === S.ACCEPTED || status === S.PAID) && unpaid) return 'needs_action';
    if (status === S.SHIPPED) return 'needs_action';
  }
  return 'in_progress';
}

// ---------------------------------------------------------------- navigation

// The four destinations, in the specced order. Only Chats and Orders carry
// a count.
export const BOTTOM_NAV_ITEMS = Object.freeze([
  Object.freeze({ id: 'chats', label: 'Chats', badge: true }),
  Object.freeze({ id: 'menus', label: 'Menus', badge: false }),
  Object.freeze({ id: 'orders', label: 'Orders', badge: true }),
  Object.freeze({ id: 'profile', label: 'Profile', badge: false }),
]);

// ---------------------------------------------------------------- menu placement

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

// Where the long-press menu goes: the reaction row above the pressed
// bubble, the action list below it. Whatever the bubble's position, both
// pieces stay inside the viewport (minus the safe-area insets and margin):
// they slide away from the edge first, then stack, then overlap the bubble
// before they would ever leave the screen.
export function placeMenu({
  anchor,
  viewport,
  reactions,
  list,
  gap = 8,
  margin = 8,
  align = 'start',
  safe = { top: 0, bottom: 0 },
}) {
  const minTop = margin + (safe.top || 0);
  const maxBottom = viewport.height - margin - (safe.bottom || 0);
  const anchorBottom = anchor.y + anchor.height;
  let reactionsTop = anchor.y - gap - reactions.height;
  let listTop = anchorBottom + gap;
  let shift = 0;
  if (reactionsTop < minTop) shift = minTop - reactionsTop;
  if (listTop + shift + list.height > maxBottom) {
    shift = Math.max(shift - (listTop + shift + list.height - maxBottom), minTop - reactionsTop);
  }
  reactionsTop += shift;
  listTop += shift;
  if (reactionsTop < minTop || listTop + list.height > maxBottom) {
    // Not enough room around the bubble: stack the two pieces at the top.
    reactionsTop = minTop;
    listTop = clamp(reactionsTop + reactions.height + gap, minTop, maxBottom - list.height);
  }
  const place = (size) => clamp(
    align === 'end' ? anchor.x + anchor.width - size.width : anchor.x,
    margin,
    viewport.width - margin - size.width,
  );
  return {
    reactions: { top: reactionsTop, left: place(reactions) },
    list: { top: listTop, left: place(list) },
  };
}
