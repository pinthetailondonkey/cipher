// The orders ledger's two jobs that both sides of the counter must agree on:
// taking a rejected order back out of everywhere it was written, and reading
// one account's orders as two ledgers — the ones it placed and the ones it
// received. Both live here, away from either screen, so a test can drive them.

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
