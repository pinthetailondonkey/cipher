import { X } from 'lucide-react';

// What a message said before. addMessageEdit records the previous text under
// msg_edits each time an edit is confirmed; this sheet is the ledger that
// reads it, newest version first, each stamped with when it was displaced.
// Skeleton D: grabber, title, scrolling content, actions pinned at the
// bottom — flat panel (bg-panel, border-line, radius 16), one floating shadow.
function stampAt(ms) {
  const time = Number(ms);
  if (!Number.isFinite(time) || time <= 0) return '';
  return new Date(time).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function EditHistorySheet({ versions = [], onClose }) {
  const history = [...versions].reverse().filter((row) => row?.previousText !== undefined);
  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-scrim/70 p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Edit history"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="mb-safe flex max-h-[80vh] w-full max-w-sm flex-col rounded-2xl border border-line bg-panel p-4 shadow-2xl">
        <span className="mx-auto block h-1 w-10 shrink-0 rounded-full bg-ink/20" />
        <div className="mt-3 flex shrink-0 items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Edit history</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target -mr-1 flex items-center justify-center text-ink/45 hover:text-ink active:scale-95">
            <X size={18} />
          </button>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-[13px] text-ink/50">No earlier versions of this message.</p>
            </div>
          ) : (
            <div className="divide-y divide-ink/5">
              {history.map((row, index) => (
                <div key={`${row.timestamp}-${index}`} className="py-3">
                  <p className="whitespace-pre-wrap break-words text-[14px] text-ink">{row.previousText || <span className="text-inkSubtle">Empty message</span>}</p>
                  <p className="mt-1 text-[11px] text-inkMuted">{stampAt(row.timestamp) || 'No time recorded'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-3 flex shrink-0 gap-3">
          <button type="button" onClick={onClose} className="touch-target flex-1 rounded-xl py-3 text-sm font-semibold text-accentInk bg-accent active:scale-[0.98]">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
