// The orders ledger's two jobs that both sides of the counter must agree on:
// taking a rejected order back out of everywhere it was written, and reading
// one account's orders as two ledgers — the ones it placed and the ones it
// received. Both live here, away from either screen, so a test can drive them.
import { issuedPaymentMethods } from './orderActions.js';

// The types that make an order, in the shape both composers write.
export const ORDER_KINDS = ['order_request', 'cipher_order'];

// Every kind the thread draws a card for. The ledger reads the same set: an
// order whose only saved rows are updates — a peer's reply on a device that
// never kept the request, or a history fetch that returned the tail — is
// still an order on screen, and the tab must not say "No orders yet" about a
// card the thread is drawing.
const ORDER_ROW_KINDS = [...ORDER_KINDS, 'order_update'];

// Which ledger opens first: a vendor opens on what comes in, a buyer on what
// they placed. It is a view choice only — it never turns a mode on or off.
export function defaultLedgerSide(isVendor) {
  return isVendor ? 'incoming' : 'purchases';
}

// A rejected send had written the order twice: once into the visible chat
// list and once into the database. Dropping only the visible copy let the
// next reload read the saved row back onto the screen as if the order still
// existed. This removes both, visible copy first. A row that will not go is
// reported to the caller — never swallowed, because a quiet failure is the
// same lie the reload told.
export async function discardRejectedOrder({ vendorPubkey, tempId, setDms, removeStored }) {
  setDms((current) => ({
    ...(current || {}),
    [vendorPubkey]: (current?.[vendorPubkey] || []).filter((message) => message.clientId !== tempId),
  }));
  try {
    await removeStored(tempId);
    return { cleared: true };
  } catch (error) {
    console.error('[orders] Could not remove the failed order from this device:', error);
    return { cleared: false, error };
  }
}

// One side of the ledger, newest first, one row per ORDER — never one per
// update. The thread draws a card for every kind in ORDER_ROW_KINDS and files
// it under the same id this function uses: an update names its order inline,
// every other kind IS the order.

// Which message stands for an order when it has several rows. The rule, in
// full, so it never depends on the order Object.entries happens to return:
//   1. a request (ORDER_KINDS) beats any update — the request is the order;
//   2. between two requests, the earlier timestamp wins;
//   3. a tie on timestamp is broken by kind name ('cipher_order' before
//      'order_request'), then by message id;
//   4. between two updates, the earlier timestamp wins, then the message id.
// The earlier update is the one that says what the order first was.
function anchorBeats(candidate, current) {
  const aRequest = ORDER_KINDS.includes(candidate.message?.data?.type);
  const bRequest = ORDER_KINDS.includes(current.message?.data?.type);
  if (aRequest !== bRequest) return aRequest;
  const at = candidate.message?.timestamp || 0;
  const bt = current.message?.timestamp || 0;
  if (at !== bt) return at < bt;
  if (aRequest) {
    const ak = String(candidate.message?.data?.type);
    const bk = String(current.message?.data?.type);
    if (ak !== bk) return ak < bk;
  }
  return String(candidate.message?.id ?? '').localeCompare(String(current.message?.id ?? ''));
}

// Who bought the order a row stands for. When the row anchors on a request the
// requester is the buyer — settled, and unchanged. An order known only by its
// updates has no request to ask, and the updates that survive when a request
// is gone are usually the OTHER party's, so the anchored message's own flag
// would file a buyer's purchase under "incoming". The direction is read from
// what the rows themselves prove, in this order:
//   1. a receipt names both sides — its buyer field decides;
//   2. the update that issued the payment pair was sent by the vendor, so a
//      received one is a purchase and a sent one is an incoming order;
//   3. nothing proves it: fall back to the anchored message's own flag. A row
//      slightly unsure is better than a row dropped.
function isBuyerOf(anchor, messages, ownPubkey) {
  if (ORDER_KINDS.includes(anchor.message?.data?.type)) return Boolean(anchor.message.isSender);
  const me = String(ownPubkey || '').toLowerCase();
  if (me) {
    const receipted = messages.find((message) => {
      const body = message?.data?.receipt?.body;
      return Boolean(body && body.buyer && body.vendor);
    });
    if (receipted) return String(receipted.data.receipt.body.buyer).toLowerCase() === me;
  }
  const issuer = messages.find((message) => (
    message?.data?.type === 'order_update' && issuedPaymentMethods(message.data)
  ));
  if (issuer) return !Boolean(issuer.isSender);
  return Boolean(anchor.message?.isSender);
}

// One side of the ledger. Which side a row is on comes from isBuyerOf — the
// request's own flag, or the proof the order's updates carry — so a row's
// buyer/seller reading never depends on the mode the account happens to be in
// and never moves when the peer replies.
export function orderRows(rows, { side, ownPubkey } = {}) {
  if (side !== 'incoming' && side !== 'purchases') return [];
  const incoming = side === 'incoming';
  const groups = new Map();
  Object.entries(rows || {}).forEach(([peerPubkey, messages]) => {
    (messages || []).forEach((message, index) => {
      const type = message?.data?.type;
      if (!ORDER_ROW_KINDS.includes(type)) return;
      const orderId = type === 'order_update' ? (message.data.orderId || message.id) : message.id;
      // A row with no order id at all is still listed, never dropped: it is
      // filed under where it sits, so the tab shows what the thread draws.
      // The key is scoped by chat: two peers may use the same order id, and a
      // row is one chat's order, never a merge of two.
      const filedAs = orderId || `${message?.timestamp ?? ''}:${index}`;
      const key = `${peerPubkey}\u0000${filedAs}`;
      const candidate = { message, peerPubkey, orderId: filedAs };
      const group = groups.get(key) || { peerPubkey, orderId: filedAs, messages: [], anchor: null };
      group.messages.push(message);
      if (!group.anchor || anchorBeats(candidate, group.anchor)) group.anchor = candidate;
      groups.set(key, group);
    });
  });
  return [...groups.values()]
    .map((group) => ({
      message: group.anchor.message,
      peerPubkey: group.peerPubkey,
      orderId: group.orderId,
      isBuyer: isBuyerOf(group.anchor, group.messages, ownPubkey),
    }))
    .filter((row) => row.isBuyer === !incoming)
    .sort((a, b) => (b.message.timestamp || 0) - (a.message.timestamp || 0));
}

// Who the other side of a row is, said plainly. The direction decides it, not
// the screen's mode.
export function peerRole(isBuyer) {
  return isBuyer ? 'Seller' : 'Buyer';
}
