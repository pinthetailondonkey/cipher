import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import Button, { pressable } from './Button';

// Dialog — centered confirm for destructive + money moments (§1). Danger
// variant fills the confirm button red. role=dialog + aria-modal + Escape +
// focus restore. The confirm button reuses ui Button.
//
// API: <Dialog open onClose title children confirmLabel cancelLabel danger busy onConfirm>
//   open          boolean — render when true
//   onClose       () => void — backdrop tap, Escape, cancel button
//   title         string
//   children      body copy
//   confirmLabel  string — confirm button text
//   cancelLabel   string — default 'Cancel'
//   danger        boolean — red confirm button
//   busy          boolean — disables both buttons while confirming
//   onConfirm     async () => void
export default function Dialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
}) {
  const panelRef = useRef(null);
  const lastFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    lastFocused.current = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    const focusable = panelRef.current?.querySelector('button');
    focusable?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (lastFocused.current && typeof lastFocused.current.focus === 'function') lastFocused.current.focus();
    };
  }, [open, onClose, busy]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 'var(--z-sheet)' }}>
      <motion.button
        type="button"
        aria-label="Close"
        onClick={() => { if (!busy) onClose?.(); }}
        className="absolute inset-0 bg-scrim/80"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        className="relative w-full max-w-sm rounded-2xl border border-line bg-panel p-6"
      >
        <h2 className="mb-2 text-xl font-bold text-ink">{title}</h2>
        <div className="mb-6 text-sm text-ink/70">{children}</div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`flex-1 rounded-xl border border-line bg-panelStrong py-3 font-bold text-ink disabled:opacity-40 ${pressable}`}
          >
            {cancelLabel}
          </button>
          {confirmLabel && (
            <Button
              type="button"
              variant={danger ? 'danger' : 'primary'}
              onClick={onConfirm}
              disabled={busy}
              className="flex-1"
            >
              {confirmLabel}
            </Button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
