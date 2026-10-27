import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// PR2 ui primitive, local stub (merge composes). THE bottom sheet of the
// rebuild: rounded-t-[28px], 36x4 drag handle, scrim/60 backdrop, slide-up
// spring 380/34, drag-to-dismiss at 120px; on md+ a centered max-w-md panel.
// role=dialog + aria-modal, Escape closes, focus returns to the opener.
function prefersReduced() {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export default function Sheet({ open = false, onClose, title = '', children, footer = null, className = '' }) {
  const panelRef = useRef(null);
  const openerRef = useRef(null);
  const closeRef = useRef(null);
  closeRef.current = onClose;
  const reduced = prefersReduced();

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    const focusTarget = panelRef.current?.querySelector('input, button, [tabindex]');
    (focusTarget || panelRef.current)?.focus?.();
    return () => {
      document.removeEventListener('keydown', onKey);
      openerRef.current?.focus?.();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="z-sheet fixed inset-0 flex items-end justify-center bg-scrim/60 md:items-center md:p-6"
          onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title || undefined}
            tabIndex={-1}
            initial={{ y: reduced ? 0 : '100%', opacity: reduced ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { y: '100%', opacity: 0 }}
            transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 380, damping: 34 }}
            drag={reduced ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(event, info) => { if (info.offset.y > 120) onClose?.(); }}
            className={`z-sheet w-full max-w-md rounded-t-[28px] border border-line bg-panel pb-sheet shadow-lg outline-none md:rounded-[28px] ${className}`}
          >
            <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-ink/20 md:hidden" aria-hidden="true" />
            {title && (
              <div className="flex items-center justify-between px-5 pb-1 pt-3">
                <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
              </div>
            )}
            {children}
            {footer}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
