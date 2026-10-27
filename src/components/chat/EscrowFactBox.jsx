// The escrow quote on the order card. The strings here are the §0 panel
// copy the card has always worn — kept character-for-character:
//   "Price X BTC · deposit Y BTC · fee Z BTC (2.5% + 2.5%)"
//   "{N}-day timer. If nothing proves the deal, the whole deposit comes back."
// The numbers are this device's own arithmetic — the caller passes a
// quote that only exists after escrowForCard() re-derived the fees and
// the address off the card, so the words under the pill are never the
// peer's math.
import { escrowDelayDays } from '../../lib/escrowActions';
import { unitsToCoins } from '../../lib/paymentState';

export default function EscrowFactBox({ escrow }) {
  if (!escrow) return null;
  return (
    <div className="mt-1 rounded-xl border border-line bg-panelStrong p-2 text-left">
      <p className="text-[11px] font-bold uppercase tracking-wide text-accentText">In escrow</p>
      <p className="mt-0.5 text-[13px] text-ink/75">
        Price {unitsToCoins(escrow.priceSats, 'btc')} BTC · deposit {unitsToCoins(escrow.depositSats, 'btc')} BTC · fee {unitsToCoins(escrow.feeOutSats, 'btc')} BTC (2.5% + 2.5%)
      </p>
      <p className="mt-0.5 text-[13px] text-ink/50">{escrowDelayDays(escrow.delayBlocks)}-day timer. If nothing proves the deal, the whole deposit comes back.</p>
    </div>
  );
}
