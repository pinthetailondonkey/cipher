import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

// Sheet — THE bottom sheet (§1). rounded-t-[28px], pb-sheet safe-area pad,
// 36x4 drag handle, backdrop scrim/60, slide-up spring (stiffness 380,
// damping 34), drag-to-dismiss past 120px. On md+ it becomes a centered
// max-w-md panel. role=dialog + aria-modal + Escape + focus restore.
//
// API: <Sheet open onClose title children>
//   open       boolean — render when true
//   onClose    () => void — backdrop tap, Escape, drag past 120px
//   title      string — small header line above the handle content
//   children   sheet body
export default function Sheet({ open, onClose, title, children }) {
  const panelRef = useRef(null);
  const lastFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    lastFocused.current = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    const focusable = panelRef.current?.querySelector('button, input, textarea, select, [href]');
    focusable?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (lastFocused.current && typeof lastFocused.current.focus === 'function') lastFocused.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 flex items-end justify-center md:items-center" style={{ zIndex: 'var(--z-sheet)' }}>
      <motion.button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-scrim/60"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 120) onClose?.();
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        className="relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-[28px] border border-line bg-panel md:max-w-md md:rounded-3xl"
      >
        <div className="flex shrink-0 flex-col items-center pt-3">
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-ink/20" />
          {title && <h2 className="px-6 pt-3 text-[15px] font-semibold text-ink">{title}</h2>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-sheet pt-4">{children}</div>
      </motion.div>
    </div>
  );
}
