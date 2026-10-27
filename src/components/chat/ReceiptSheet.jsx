import { useState } from 'react';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { verifyReceipt } from '../../lib/proofOfTrade';
import { writeClipboard } from '../../lib/copyText';
import { scopedGet } from '../../lib/storage';

// Skeleton D: grabber, title, scrolling content, actions pinned at the bottom.
// The panel is flat (bg-panel, border-line, radius 16); the sheet keeps its
// one floating shadow. Reads the stored receipt keys directly —
// receipt_<orderId> — and puts verifyReceipt's verdict on the panel, so the
// buyer reads signed terms, not a vendor's word.
function shortHex(text) {
  const value = String(text || '');
  if (!value) return '';
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function stampAt(seconds) {
  const time = Number(seconds);
  if (!Number.isFinite(time) || time <= 0) return '';
  return new Date(time * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function Row({ label, children }) {
  return (
    <div className="py-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted">{label}</p>
      <div className="mt-0.5 min-w-0 break-all text-[13px] text-ink">{children}</div>
    </div>
  );
}

export default function ReceiptSheet({ orderId, onClose }) {
  const setToast = useChatStore((state) => state.setToast);
  const [copied, setCopied] = useState(false);
  const receipt = orderId ? scopedGet(`receipt_${orderId}`, null) : null;
  const body = receipt?.body || null;
  const verified = Boolean(receipt && verifyReceipt(receipt));
  const txid = String(body?.txid || '');
  const amount = body ? `${body.amount} ${String(body.currency || '').toUpperCase()}` : '';
  const outcome = String(body?.outcome || '');

  const copyTxid = async () => {
    const ok = await writeClipboard(txid);
    if (!ok) {
      setToast({ type: 'error', message: 'Clipboard is unavailable.' });
      return;
    }
    setCopied(true);
    setToast({ type: 'success', message: 'Txid copied' });
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-scrim/70 p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Order receipt"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="mb-safe flex max-h-[80vh] w-full max-w-sm flex-col rounded-2xl border border-line bg-panel p-4 shadow-2xl">
        <span className="mx-auto block h-1 w-10 shrink-0 rounded-full bg-ink/20" />
        <div className="mt-3 flex shrink-0 items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Receipt</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target -mr-1 flex items-center justify-center text-ink/45 hover:text-ink active:scale-95">
            <X size={18} />
          </button>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {!body ? (
            <div className="py-6 text-center">
              <h3 className="text-[15px] font-semibold text-ink">No receipt yet</h3>
              <p className="mx-auto mt-1 max-w-[240px] text-[13px] text-ink/50">
                The vendor has not signed a receipt for this order. One appears here when the payment is signed.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-ink/5">
              <div className="pb-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted">Outcome</p>
                {outcome ? (
                  <span className="mt-1.5 inline-block rounded-full border border-accentText bg-transparent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-accentText">{outcome}</span>
                ) : (
                  <span className="mt-1.5 inline-block text-[13px] text-ink/50">Not stated</span>
                )}
              </div>
              <Row label="Amount"><p className="text-[15px] font-bold text-accentText">{amount}</p></Row>
              <Row label="Paid to"><span className="font-mono text-[12px] text-ink">{body.address || 'Not stated'}</span></Row>
              <Row label="Txid"><span className="select-all font-mono text-[12px] text-ink">{shortHex(txid) || 'Not stated'}</span></Row>
              <Row label="Time">{stampAt(body.at) || 'Not stated'}</Row>
              <Row label="Order"><span className="select-all font-mono text-[12px] text-ink">{shortHex(body.orderId)}</span></Row>
              <div className="py-2">
                <p className="flex items-center gap-1.5 text-[13px] font-semibold">
                  {verified ? (
                    <><Check size={14} className="text-success" /> <span className="text-success">Both signatures check.</span></>
                  ) : (
                    <><AlertTriangle size={14} className="text-danger" /> <span className="text-danger">The signatures do not check out.</span></>
                  )}
                </p>
                <div className="mt-1 divide-y divide-ink/5">
                  <p className="flex items-center justify-between gap-2 py-1.5">
                    <span className="text-[12px] text-inkMuted">Buyer signature</span>
                    <span className="select-all font-mono text-[12px] text-ink/70">{shortHex(receipt.sigs?.buyer) || 'None'}</span>
                  </p>
                  <p className="flex items-center justify-between gap-2 py-1.5">
                    <span className="text-[12px] text-inkMuted">Vendor signature</span>
                    <span className="select-all font-mono text-[12px] text-ink/70">{shortHex(receipt.sigs?.vendor) || 'None'}</span>
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 flex shrink-0 gap-3">
          {txid && (
            <button type="button" onClick={copyTxid} className="touch-target flex flex-1 items-center justify-center gap-2 rounded-xl border border-line py-3 text-sm font-semibold text-ink/70 hover:bg-ink/5 active:scale-[0.98]">
              <Copy size={15} /> {copied ? 'Copied' : 'Copy txid'}
            </button>
          )}
          <button type="button" onClick={onClose} className={`touch-target flex-1 rounded-xl py-3 text-sm font-semibold text-accentInk active:scale-[0.98] bg-accent`}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
