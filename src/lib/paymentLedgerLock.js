// Payment consumption must be serialized across tabs in one account. Browser
// engines without the Web Locks API cannot safely perform the ledger's
// read/check/append sequence, so confirmation fails closed there.
export function withPaymentLedgerLock(run, { scope = '', locks = globalThis.navigator?.locks } = {}) {
  if (typeof run !== 'function') throw new TypeError('A payment ledger operation is required.');
  if (!locks || typeof locks.request !== 'function') {
    return Promise.reject(new Error('This browser cannot safely coordinate payment checks across tabs. Update the browser before confirming a payment.'));
  }
  const name = scope ? `cipher-consumed-ledger:${scope}` : 'cipher-consumed-ledger';
  return locks.request(name, { mode: 'exclusive' }, run);
}
