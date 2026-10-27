<<<<<<< HEAD
import { useEffect, useRef } from 'react';

// Centered confirm for destructive + money moments. Variants: default /
// danger. role=dialog, aria-modal, Escape, focus trap and focus restore are
// owned here; the store-driven GlobalDialog keeps its own flow and can adopt
// this shell in place without its callers changing.
export default function Dialog({ open, onClose, label, heading, danger = false, children, className = '' }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-scrim/80 p-4" style={{ zIndex: 'var(--z-sheet)' }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label || heading || 'Dialog'}
        tabIndex={-1}
        className={`w-full max-w-sm rounded-3xl border border-line bg-panel p-6 outline-none ${danger ? 'ring-1 ring-danger/40' : ''} ${className}`}
      >
        {children}
      </div>
    </div>
=======
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import Button from './Button';
import { useModalA11y } from './modal';

// The centered confirm surface — destructive and money moments. Escape and the
// veil close it, focus is trapped and restored, and while a confirm handler is
// running the dialog cannot be double-fired.
export default function Dialog({
  open,
  onClose,
  title,
  message,
  children,
  danger = false,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  hasInput = false,
  inputDefault = '',
  inputLocked = false,
  inputRows = 4,
  inputPlaceholder = '',
}) {
  const [value, setValue] = useState(inputDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useModalA11y(open, onClose);

  useEffect(() => {
    if (!open) return;
    setValue(inputDefault);
    setError('');
    setBusy(false);
  }, [open, inputDefault]);

  if (!open) return null;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm?.(hasInput ? value : undefined);
      onClose?.();
    } catch (confirmError) {
      setError(confirmError?.message || 'Could not complete this action.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <motion.div
        key="dialog-veil"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose?.();
        }}
        className="fixed inset-0 z-sheet flex items-center justify-center bg-scrim/60 p-4"
      >
        <motion.form
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title || 'Confirm'}
          initial={{ scale: 0.94, y: 8, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 28 }}
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
          className="w-full max-w-sm rounded-3xl border border-line bg-panel p-6 shadow-2xl outline-none"
        >
          <div className="flex items-start gap-3">
            {danger && <AlertTriangle size={21} className="mt-1 shrink-0 text-danger" />}
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-bold text-ink">{title || 'Confirm'}</h2>
              {message && <p className="mt-2 whitespace-pre-wrap text-[13px] text-inkMuted">{message}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-2 text-ink/45 hover:text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {children}
          {hasInput && (
            <textarea
              autoFocus={!inputLocked}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              readOnly={Boolean(inputLocked)}
              placeholder={inputPlaceholder}
              rows={inputRows}
              className={`mt-4 w-full resize-y rounded-2xl border border-line bg-panelStrong p-3 text-sm outline-none placeholder:text-ink/35 focus:border-accent ${inputLocked ? 'text-inkMuted' : 'text-ink'}`}
            />
          )}
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <div className="mt-5 flex gap-3">
            <Button variant="ghost" onClick={onClose} disabled={busy} className="border border-line flex-1">{cancelText}</Button>
            <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy} className="flex-1">
              {busy ? 'Working…' : confirmText}
            </Button>
          </div>
        </motion.form>
      </motion.div>
    </>
>>>>>>> origin/feat/rebuild-pr2
  );
}
