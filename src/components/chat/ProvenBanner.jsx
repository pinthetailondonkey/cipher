import { useState } from 'react';
import Sheet from '../ui/Sheet';
import { copyText } from '../../lib/copyText';
import { haptic } from '../../lib/haptics';
import { provenBannerOf, provenEntriesOf } from '../../lib/vendorReviews';

// The proven-deals banner, in the data contract's phrasing words and
// nothing else:
//   phrasing 'proven'   -> "N deals proven. One tap shows the proofs."
//   phrasing 'recorded' -> "N deals recorded on chain."
// The BTC line keeps its founder-law tap: one tap opens its own proof
// list — the receipt hashes (F8), plain mono rows, Copy per hash, nothing
// else on the sheet. A hash checkable against a receipt a party hands
// over; an explorer resolves none of it. The Monero line stays
// existence-only; an unknown rail arrives with no wording of this file's
// making and stays static too. Vendor-reported numbers never render here:
// the data layer excludes them by kind, and nothing in this component can
// admit one.
//
// `proven` is the contract object keyed by rail ({ btc: { count, hashes,
// phrasing }, ... }, or a list of such entries). The band renders one line
// per rail in the contract's stable order — btc, xmr, then whatever rails
// the data layer adds — and never sums rails into one figure: a vendor can
// be proven on one rail and recorded on another, and the words are per
// rail. The copy next to an unrecognized rail is the lib's neutral
// pass-through, pending the conductor's ruling.
export default function ProvenBanner({ proven, className = '' }) {
  const [hashes, setHashes] = useState(null);
  const entries = provenEntriesOf(proven);
  if (entries.length === 0) return null;
  return (
    <div className={className}>
      {entries.map((entry, index) => {
        const words = provenBannerOf(entry);
        if (!words) return null;
        const panel = `rounded-2xl border border-line bg-panelStrong px-4 py-3 text-[14px] font-semibold leading-snug text-ink ${index === 0 ? '' : 'mt-2'}`;
        const list = Array.isArray(entry.hashes) ? entry.hashes : [];
        if (entry.phrasing === 'proven' && list.length > 0) {
          return (
            <button
              key={`tap-${index}-${entry.rail}`}
              type="button"
              onClick={() => { haptic('light'); setHashes(list); }}
              aria-label={words}
              className={`block w-full text-left active:bg-ink/5 ${panel}`}
            >
              {words}
            </button>
          );
        }
        return <p key={`${index}-${words}`} className={panel}>{words}</p>;
      })}

      <Sheet open={Boolean(hashes)} onClose={() => setHashes(null)} heading="Deals proven" ariaLabel="Proven deals">
        <ul className="pb-4">
          {(hashes || []).map((hash) => (
            <li key={hash} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
              <span className="mono min-w-0 flex-1 truncate text-[13px] text-ink">{hash}</span>
              <button
                type="button"
                onClick={() => { haptic('light'); copyText(hash); }}
                className="min-h-[36px] shrink-0 rounded-full border border-line px-3 py-1 text-[13px] font-semibold text-accentText active:bg-ink/5"
              >
                Copy
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
