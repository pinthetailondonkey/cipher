<<<<<<< HEAD
// Sheet — THE bottom surface. Phone: rounded-top panel pulled over a scrim,
// drag-to-dismiss past 120px from the handle, handle 36x4, slide-up spring
// (380/34); on md+ the same body renders as a centred max-w-md panel. It
// carries role=dialog, aria-modal, Escape (topmost open sheet only), backdrop
// tap, focus trap and focus restore, and it locks the page behind itself.
// Presentation only: nothing here touches app state beyond onClose.
// `label`/`heading` are aliases of `ariaLabel`/`title` — earlier converted
// screens call them by the first pair.
import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion';
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// Open Sheet registry: Escape (and Tab trapping) applies to the topmost
// open Sheet only, so a Sheet opened on top of a Sheet does not take both
// down with one key press.
let sheetUid = 0;
const openSheets = [];

export default function Sheet({
  open,
  onClose,
  title = null,
  heading = null,
  label = null,
  ariaLabel = null,
  glassHeader = false,
  footer = null,
  className = '',
  bodyClassName = '',
  stretch = false,
  children,
}) {
  const reduced = useReducedMotion();
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const dragControls = useDragControls();
  const headingText = title || heading;
  const spokenLabel = ariaLabel || label || headingText;

  const uid = useRef(null);

  const dropFromStack = () => {
    const at = openSheets.indexOf(uid.current);
    if (at !== -1) openSheets.splice(at, 1);
  };

  useEffect(() => {
    if (!open) {
      if (uid.current) {
        dropFromStack();
        uid.current = null;
      }
      return undefined;
    }
    if (!uid.current) {
      sheetUid += 1;
      uid.current = sheetUid;
      openSheets.push(uid.current);
    }
    // Lock the page behind the sheet; the sheet itself scrolls.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const wasFocused = document.activeElement;
    restoreRef.current = wasFocused instanceof HTMLElement ? wasFocused : null;
    const id = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (openSheets[openSheets.length - 1] !== uid.current) return;
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === panel || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.({ preventScroll: true });
      restoreRef.current = null;
    };
  }, [open, onClose]);

  // If the whole component unmounts while open, leave the stack clean.
  useEffect(() => () => {
    if (uid.current) {
      dropFromStack();
      uid.current = null;
    }
  }, []);

  const dismissByDrag = (_event, info) => {
    if (info.offset.y > 120) onClose?.();
  };
=======
import { AnimatePresence, motion } from 'framer-motion';
import { useModalA11y } from './modal';

// THE bottom sheet. Phones anchor it to the bottom with the drag handle;
// md+ screens center it as a max-w-md panel. One surface replaces the app's
// hand-rolled modal shells — DeadDrop, product editor, profile card, onboarding.
export default function Sheet({
  open,
  onClose,
  title,
  children,
  labelledBy,
  label,
  className = '',
  bodyClassName = '',
}) {
  const panelRef = useModalA11y(open, onClose);
>>>>>>> origin/feat/rebuild-pr2

  return (
    <AnimatePresence>
      {open && (
        <motion.div
<<<<<<< HEAD
          className={`fixed inset-0 z-sheet flex items-end justify-center bg-scrim/60 p-0 sm:items-center sm:p-4 ${className}`}
          role="presentation"
          initial={reduced ? { opacity: 0 } : { opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0.01 } : { duration: 0.18 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose?.();
          }}
=======
          key="sheet-veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose?.();
          }}
          className="fixed inset-0 z-sheet flex items-end justify-center bg-scrim/60 md:items-center md:p-6"
>>>>>>> origin/feat/rebuild-pr2
        >
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
<<<<<<< HEAD
            aria-label={typeof spokenLabel === 'string' ? spokenLabel : undefined}
            initial={{ y: reduced ? 0 : '100%', opacity: reduced ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: reduced ? 0 : '100%', opacity: reduced ? 0 : 1 }}
            transition={reduced ? { duration: 0.01 } : { type: 'spring', stiffness: 380, damping: 34 }}
            drag={reduced ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            dragListener={false}
            dragControls={dragControls}
            onDragEnd={dismissByDrag}
            className={`flex w-full flex-col overflow-hidden rounded-t-[28px] border border-line bg-panel shadow-2xl outline-none sm:rounded-[28px] sm:max-w-md ${stretch ? 'h-[calc(100dvh-2rem)] md:h-[calc(100dvh-4rem)]' : 'max-h-[92dvh]'} ${footer ? 'pb-0' : 'pb-sheet'} ${bodyClassName}`}
          >
            <div
              className="flex shrink-0 cursor-grab touch-none items-center justify-center pt-3 active:cursor-grabbing sm:cursor-default"
              onPointerDown={(event) => {
                if (reduced) return;
                dragControls.start(event, { snapToEndpoint: false });
              }}
              data-sheet-handle="true"
            >
              <span className="h-1 w-9 rounded-full bg-ink/20" aria-hidden="true" />
            </div>
            {headingText ? (
              <header className={`shrink-0 border-b border-line px-4 py-3 ${glassHeader ? 'glass-header' : ''}`}>
                <h2 className="text-[17px] font-bold tracking-tight text-ink">{headingText}</h2>
              </header>
            ) : null}
            <div className={`min-h-0 flex-1 overflow-y-auto ${footer ? 'pb-2' : ''}`}>{children}</div>
            {footer ? (
              <footer className="shrink-0 border-t border-line bg-panel px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
                {footer}
              </footer>
            ) : null}
=======
            aria-labelledby={labelledBy}
            aria-label={!labelledBy ? label : undefined}
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
            {title && (
              <div className="flex items-center gap-3 px-5 pt-3">
                <h2 id={labelledBy} className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{title}</h2>
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
>>>>>>> origin/feat/rebuild-pr2
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
