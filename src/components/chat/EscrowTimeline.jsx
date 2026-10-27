// The escrow timeline: five beats down the card's left rail. Every beat
// state is DERIVED (F7) from facts this device holds — the acceptance's
// own update, this device's watcher report — never from what the peer
// wrote on the card. A quote that would not re-derive here (escrowForCard
// returned null) renders no timeline at all.
//
// Honesty floor: our beat states live with the order facts, but the
// release legs do not yet. Until the order-membrane reroute commit
// (escrow_release / escrow_refund admission into the journal gate) lands,
// beats 4 and 5 NEVER name a state — they render a dot over skeleton
// shimmer. The grep decides, not a hope:
//   git log --all --oneline | grep -iE "membrane.*reroute|escrow_release.*admission"
// That grep is empty on today's graph, so the skeleton shows.
import React from 'react';

const DONE_LIFECYCLE = new Set(['accepted', 'paid', 'shipped', 'completed', 'disputed', 'refunded']);
const ADDRESS_SHOWN = new Set(['address_issued', 'seen', 'confirmed']);

export default function EscrowTimeline({ quote, status = '', paymentState = '' }) {
  if (!quote) return null;
  const statusDone = DONE_LIFECYCLE.has(String(status).toLowerCase());
  const addressShown = ADDRESS_SHOWN.has(String(paymentState).toLowerCase());
  const beats = [
    // The order request exists — the card itself is the fact.
    { key: 'requested', label: 'Requested', done: true },
    // The vendor's accept with escrow — status in the lifecycle past
    // acceptance on this device's ledger.
    { key: 'accepted', label: 'Accepted (escrow)', done: statusDone },
    // The deposit address the acceptance issued is what this card shows.
    { key: 'deposit', label: 'Deposit shown', done: statusDone && addressShown },
    // Reroute-gated: never read these from a peer's word.
    { key: 'watcher', label: 'Watcher confirmed', done: false, pending: true },
    { key: 'settled', label: 'Released', done: false, pending: true },
  ];
  // The current beat is the first earned-but-unchecked one: the next
  // thing that is meant to happen. Done beats never pulse.
  const currentIndex = beats.findIndex((beat) => !beat.done);
  return (
    <ol className="mt-2 list-none space-y-1 text-left" aria-label="Escrow progress">
      {beats.map((beat, index) => {
        const current = !beat.done && !beat.pending && index === currentIndex;
        const state = beat.done ? 'done' : current ? 'current' : beat.pending ? 'unknown' : 'future';
        return (
          <li key={beat.key} className="escrow-beat flex">
            <span
              className={`escrow-dot${state === 'current' ? ' escrow-pulse' : ''}`}
              data-state={state}
              aria-hidden="true"
            />
            {state === 'unknown' ? (
              // No word for a state nobody has checked yet.
              <span className="escrow-shimmer h-3 w-28 rounded-full" />
            ) : (
              <span
                className={
                  state === 'done'
                    ? 'text-[12px] font-semibold text-inkMuted'
                    : state === 'current'
                      ? 'text-[12px] font-semibold text-accentText'
                      : 'text-[12px] text-inkSubtle'
                }
              >
                {beat.label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
