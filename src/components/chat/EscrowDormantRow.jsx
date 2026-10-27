// The funded-phase escrow taps, DORMANT. When the escrow card has money
// in it but the order-membrane reroute has not landed, nothing here may
// click: Approve release, Request refund and Admit refund wire to
// escrow_release / escrow_refund admission inside the membrane's journal
// door, and that commit does not exist yet (grep the log — it is absent).
// So the positives render disabled with their caption until then. No
// onClick is attached — grep the diff, these buttons reach nothing.
//
// The taps do not exist in useCommerce either — same reroute line owns
// both. This component renders the SPEC placeholders only: buyer gets
// Approve release (the buyer's tap completes the 2-of-2 release, the
// vendor's half-signature already waits), the vendor gets Request refund
// and Admit refund (vendor co-signs the refund early, before the timer)
// — split exactly as the FSM's own comments say who signs what.
import React from 'react';
import { escrowForCard } from '../../lib/escrowActions';

const MEMBRANE_REROUTE_LANDED = false;
const REQUEST_TYPES = new Set(['order_request', 'cipher_order']);
// "Funded but unconfirmed": the watcher has seen the deposit land, the
// confirm leg has not sealed it. (After a confirm with the reroute still
// missing, the row stays dormant too — the caption stays true.)
const FUNDED_SEEN = new Set(['seen', 'confirmed']);
const DORMANT_COPY = 'available once your watcher confirms funding';

export default function EscrowDormantRow({ content, isBuyer = false }) {
  if (!content || !REQUEST_TYPES.has(content.type)) return null;
  if (!escrowForCard(content)) return null;
  if (MEMBRANE_REROUTE_LANDED) return null; // the real buttons take over
  if (!FUNDED_SEEN.has(String(content.paymentState || '').toLowerCase())) return null;
  const taps = isBuyer ? ['Approve release'] : ['Request refund', 'Admit refund'];
  return (
    <div className="mt-1 space-y-0.5 text-left">
      {taps.map((tap) => (
        <button
          key={tap}
          type="button"
          disabled
          aria-disabled="true"
          className="mb-0.5 block min-h-[44px] w-full cursor-not-allowed rounded-full border border-line px-3 py-2 text-left text-[15px] font-semibold text-inkMuted"
        >
          {tap}
        </button>
      ))}
      <p className="text-[11px] text-inkSubtle">{DORMANT_COPY}</p>
    </div>
  );
}
