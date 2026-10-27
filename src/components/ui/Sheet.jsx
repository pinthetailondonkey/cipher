import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';

// The one bottom sheet. rounded-t-[28px] panel, 36x4 drag handle, scrim/60
// backdrop, slide-up spring (stiffness 380, damping 34), drag-to-dismiss past
// 120px; on md+ it centers as a max-w-md panel. role=dialog, aria-modal,
// Escape, backdrop tap, focus trap and focus restore come from here, so no
// surface hand-rolls that again.
export default function Sheet({ open, onClose, label, heading, children, className = '' }) {
  const dragControls = useDragControls();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Lock the page behind the sheet; the sheet itself scrolls.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const opener = document.activeElement;
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = panel?.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 flex items-end justify-center md:items-center" style={{ zIndex: 'var(--z-sheet)' }}>
          <motion.div
            className="absolute inset-0 bg-scrim/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label || heading || 'Dialog'}
            tabIndex={-1}
            drag="y"
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.35 }}
            onDragEnd={(event, info) => {
              if (info.offset.y > 120 || info.velocity.y > 500) onClose?.();
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className={`relative flex w-full max-w-md flex-col overflow-y-auto rounded-t-[28px] border border-line bg-panel pb-sheet max-h-[92dvh] shadow-2xl outline-none md:rounded-3xl md:max-h-[85dvh] ${className}`}
          >
            {/* The handle and an optional heading carry the drag region, so a
                long scrollable body never fights the dismissal gesture. */}
            <div
              className="shrink-0 touch-none select-none px-4 pt-3"
              onPointerDown={(event) => dragControls.start(event)}
            >
              <div className="mx-auto h-1 w-9 rounded-full bg-ink/20" aria-hidden="true" />
              {heading && <h2 className="mt-3 text-[22px] font-bold tracking-tight text-ink">{heading}</h2>}
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
