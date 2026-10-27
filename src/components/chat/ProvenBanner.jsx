import { provenLinesOf } from '../../lib/vendorReviews';

// The proven-deals banner, in the data contract's phrasing words and
// nothing else:
//   phrasing 'proven'   -> "N deals proven. One tap shows the txids."
//   phrasing 'recorded' -> "N deals recorded on chain."
// The tap-through to txids rides the contract's txids list; until that
// display lands the line renders static — no fake affordance.
// Vendor-reported numbers never render here: the data layer excludes them
// by kind, and nothing in this component can admit one.
//
// `proven` is the contract object keyed by rail ({ btc: { count, txids,
// phrasing }, ... }, or a list of such entries). The band renders one line
// per rail in the contract's stable order — btc, xmr, then whatever rails
// the data layer adds — and never sums rails into one figure: a vendor can
// be proven on one rail and recorded on another, and the words are per
// rail. An unrecognized rail arrives with no wording of this file's
// making; the lib's neutral pass-through names it and counts it, and the
// copy is pending the conductor's ruling.
export default function ProvenBanner({ proven, className = '' }) {
  const lines = provenLinesOf(proven);
  if (lines.length === 0) return null;
  return (
    <div className={className}>
      {lines.map((line, index) => (
        <p
          key={`${index}-${line}`}
          className={index === 0 ? 'rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[14px] font-semibold leading-snug text-ink' : 'mt-2 rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[14px] font-semibold leading-snug text-ink'}
        >
          {line}
        </p>
      ))}
    </div>
  );
}
