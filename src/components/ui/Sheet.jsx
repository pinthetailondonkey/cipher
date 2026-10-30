import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalA11y } from './modal';

// Open Sheet registry so Escape only takes down the topmost open sheet —
// a sheet opened on top of another sheet does not swallow its parent with it.
let sheetUid = 0;
const openSheets = [];

// THE dialog. Centered as a max-w-md panel on every screen — nothing rises
// from the bottom (founder ruling 2026-10-29: "take out the bottom modals").
// One surface replaces the app's hand-rolled modal shells — DeadDrop, product
// editor, profile card, onboarding.
// `heading` and `ariaLabel` are aliases of `title` and `label`: the earlier
// converted screens call them by the first pair. A sheet that names only its
// spoken label still gets the shared heading bar from that label, so no sheet
// has to draw its own title and dismiss control inside the body. A sheet that
// already draws its own header opts out with `bareHeader`: it gets the drag
// handle and no bar, and names itself through `labelledBy` pointing at the
// heading it renders, or through `label` when it has no heading to point at.
//
// The overlay renders through a portal on document.body, not inside the app
// tree. The shell wraps every tab in <main class="z-fab">, which is a
// stacking context: a sheet mounted inside it could never paint over the
// bottom bar, however high its own z-index. Portalled to the body, the overlay
// takes the one sheet layer (--z-sheet, above the bar) and dims and blocks the
// whole app behind it. The portal is skipped when there is no document (the
// server render in ui.test), so the same markup still renders in place there.
export default function Sheet({
  open,
  onClose,
  title,
  heading = null,
  children,
  labelledBy: labelledByProp,
  label = null,
  ariaLabel = null,
  closeLabel = 'Close',
  bareHeader = false,
  className = '',
  bodyClassName = '',
}) {
  const autoId = useId();
  // A sheet that renders its own header keeps it: no shared bar, and the
  // dialog is named by the heading the sheet points at, or by its label.
  const headingText = bareHeader ? null : (title || heading || (typeof label === 'string' && label ? label : null));
  const labelledBy = labelledByProp || (headingText ? `${autoId}-title` : null);
  const spokenLabel = label || ariaLabel || title || heading;
  const uid = useRef(null);
  // Only the topmost open sheet answers Escape; deeper sheets keep theirs
  // for their own unwinding.
  const guardedClose = () => {
    if (openSheets[openSheets.length - 1] !== uid.current) return;
    onClose?.();
  };
  const panelRef = useModalA11y(open, guardedClose);

  // Lock the page behind the sheet while it is open; the sheet scrolls.
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Join the open-sheet stack for topmost-only Escape; drop on close/unmount.
  useEffect(() => {
    if (!open) {
      const at = openSheets.indexOf(uid.current);
      if (at !== -1) openSheets.splice(at, 1);
      uid.current = null;
      return undefined;
    }
    if (!uid.current) {
      sheetUid += 1;
      uid.current = sheetUid;
      openSheets.push(uid.current);
    }
    return () => {
      const at = openSheets.indexOf(uid.current);
      if (at !== -1) openSheets.splice(at, 1);
      uid.current = null;
    };
  }, [open]);

  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          key="sheet-veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose?.();
          }}
          className="fixed inset-0 z-sheet flex items-center justify-center bg-scrim/60 p-4 sm:p-6"
        >
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            data-centred
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-label={!labelledBy ? (typeof spokenLabel === 'string' ? spokenLabel : undefined) : undefined}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className={`w-full max-w-[420px] overflow-hidden overscroll-contain rounded-[20px] border border-line bg-panel pb-sheet shadow-2xl outline-none ${className}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 bg-panel pt-2">
              {headingText && (
                <div className="flex items-center gap-3 px-5 pt-3">
                  <h2 id={labelledBy} className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{headingText}</h2>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={closeLabel}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-inkMuted hover:bg-ink/5 hover:text-ink"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
            <div className={`px-5 pt-3 ${bodyClassName}`}>{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay;
}
