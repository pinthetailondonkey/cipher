const NEXT = {
  created: { issue: 'address_issued' },
  address_issued: { see: 'seen' },
  seen: { confirm: 'confirmed' },
};

export function nextPaymentState(current, event) {
  const next = NEXT[current]?.[event];
  if (!next) throw new Error(`A payment that is ${current || 'missing'} cannot ${event}.`);
  return next;
}

// The vendor's phone must not call this. A watcher you run is the only caller.
// There is no fetch here, and an empty watcher URL is a hard stop.
export function applyWatcherReport({ state, watcherUrl, report } = {}) {
  if (!String(watcherUrl || '').trim()) {
    throw new Error('No payment watcher is set. This device does not check a block explorer.');
  }
  if (!report || report.source !== 'watcher' || !report.txid) {
    throw new Error('Only a watcher report can move a payment to seen or confirmed.');
  }
  let current = state;
  if (current === 'address_issued') current = nextPaymentState(current, 'see');
  const confirmed = report.confirmed === true || Number(report.confirmations) >= 10;
  if (confirmed) {
    if (current !== 'seen') throw new Error('A payment has to be seen before it can be confirmed.');
    current = nextPaymentState(current, 'confirm');
  }
  if (current === state) throw new Error('The watcher report did not move the payment.');
  return current;
}
