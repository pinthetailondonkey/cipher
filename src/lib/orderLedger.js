// The orders ledger's two jobs that both sides of the counter must agree on:
// taking a rejected order back out of everywhere it was written, and reading
// one account's orders as two ledgers — the ones it placed and the ones it
// received. Both live here, away from either screen, so a test can drive them.

// The types that make an order, in the shape both composers write.
export const ORDER_KINDS = ['order_request', 'cipher_order'];

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

// One side of the ledger, newest first. Which side a row is on comes from the
// wire's own direction flag — a message this account sent is a purchase, a
// message it received is an incoming order — so a row's buyer/seller reading
// never depends on the mode the account happens to be in.
export function orderRows(rows, { side } = {}) {
  if (side !== 'incoming' && side !== 'purchases') return [];
  const incoming = side === 'incoming';
  return Object.entries(rows || {}).flatMap(([peerPubkey, messages]) => (
    (messages || [])
      .filter((message) => Boolean(message?.isSender) === !incoming && ORDER_KINDS.includes(message?.data?.type))
      .map((message) => ({ message, peerPubkey, isBuyer: Boolean(message?.isSender) }))
  )).sort((a, b) => (b.message.timestamp || 0) - (a.message.timestamp || 0));
}

// Who the other side of a row is, said plainly. The direction decides it, not
// the screen's mode.
export function peerRole(isBuyer) {
  return isBuyer ? 'Seller' : 'Buyer';
}
