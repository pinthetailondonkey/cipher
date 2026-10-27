import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { useModalA11y } from './modal';

// Open Sheet registry so Escape only takes down the topmost open sheet —
// a sheet opened on top of another sheet does not swallow its parent with it.
let sheetUid = 0;
const openSheets = [];

// THE bottom sheet. Phones anchor it to the bottom with the drag handle;
// md+ screens center it as a max-w-md panel. One surface replaces the app's
// hand-rolled modal shells — DeadDrop, product editor, profile card, onboarding.
// `heading` and `ariaLabel` are aliases of `title` and `label`: the earlier
// converted screens call them by the first pair.
export default function Sheet({
  open,
  onClose,
  title,
  heading = null,
  children,
  labelledBy,
  label = null,
  ariaLabel = null,
  className = '',
  bodyClassName = '',
}) {
  const headingText = title || heading;
  const spokenLabel = label || ariaLabel || headingText;
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

  return (
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
          className="fixed inset-0 z-sheet flex items-end justify-center bg-scrim/60 md:items-center md:p-6"
        >
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-label={!labelledBy ? (typeof spokenLabel === 'string' ? spokenLabel : undefined) : undefined}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            dragMomentum={false}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120) onClose?.();
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%', opacity: 0.9 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className={`w-full max-w-md overflow-hidden rounded-t-[28px] border-b-0 border-x border-t border-line bg-panel pb-sheet shadow-2xl outline-none md:rounded-[28px] md:border-b ${className}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-ink/20" aria-hidden="true" />
            {headingText && (
              <div className="flex items-center gap-3 px-5 pt-3">
                <h2 id={labelledBy} className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{headingText}</h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-inkMuted hover:bg-ink/5 hover:text-ink"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            <div className={`px-5 pt-3 ${bodyClassName}`}>{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
