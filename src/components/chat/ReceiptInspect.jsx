import Sheet from '../ui/Sheet';
import { verifyReceipt } from '../../lib/proofOfTrade';
import { shortNpub } from '../../lib/npub';

// One receipt row. Values render as the body spells them — the signed
// string is the truth and nothing here re-derives an amount.
function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-0">
      <span className="shrink-0 text-[12px] text-inkSubtle">{label}</span>
      {children}
    </div>
  );
}

// The receipt door: the body both sides signed, shown only after this
// device has run both signatures to the ground. A receipt that does not
// verify is refused as proof — the door shows the refusal, never the
// numbers, so a tampered copy cannot launder itself through a screen that
// looks like a receipt. (backlog 2, receipt inspection)
export default function ReceiptInspect({ receipt, open, onClose }) {
  const ok = Boolean(receipt && verifyReceipt(receipt));
  const body = ok ? receipt.body : null;
  return (
    <Sheet open={open} onClose={onClose} heading="Receipt" ariaLabel="Receipt">
      <div className="pb-4">
        {!receipt && (
          <p className="text-[13px] leading-relaxed text-inkSubtle">
            Nothing is stored on this device yet. A receipt lands once the payment confirms and both sides have signed it.
          </p>
        )}
        {receipt && !ok && (
          <div className="rounded-xl border border-line bg-panelStrong p-3">
            <p className="text-[13px] font-semibold text-danger">This receipt does not verify.</p>
            <p className="mt-1 text-[13px] leading-relaxed text-inkSubtle">
              A receipt counts only when both signatures belong to the buyer and the vendor named in the body. One bad signature and it is nothing.
            </p>
          </div>
        )}
        {ok && (
          <>
            <div className="rounded-2xl border border-line bg-panel px-3">
              <Row label="Order"><span className="mono break-all text-right text-[12px] text-ink select-all">{body.orderId}</span></Row>
              <Row label="Amount"><span className="mono text-[14px] font-bold text-ink">{body.amount} {String(body.currency || '').toUpperCase()}</span></Row>
              <Row label="Paid to"><span className="mono break-all text-right text-[12px] text-ink select-all">{body.address}</span></Row>
              <Row label="Transaction"><span className="mono break-all text-right text-[12px] text-ink select-all">{body.txid}</span></Row>
              <Row label="When"><span className="text-right text-[12px] text-ink">{new Date(body.at * 1000).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></Row>
              <Row label="Outcome"><span className="text-right text-[12px] font-semibold text-ink">{body.outcome || '—'}</span></Row>
              <Row label="Buyer signed"><span className="mono text-right text-[11px] text-inkSubtle select-all">{shortNpub(body.buyer, 14)}</span></Row>
              <Row label="Vendor signed"><span className="mono text-right text-[11px] text-inkSubtle select-all">{shortNpub(body.vendor, 14)}</span></Row>
            </div>
            <p className="mt-2 text-center text-[11px] text-inkSubtle">
              Both signatures checked on this device. Hash {String(receipt.hash || '').slice(0, 12)}…
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
