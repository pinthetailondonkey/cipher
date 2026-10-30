import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

  // The confirm rides the same portal layer as the sheets (see Sheet.jsx):
  // it answers a button pressed inside a sheet, so it has to paint above it,
  // and a sheet-mounted confirm could never outrank the sheet itself. Without
  // a document (the server render in ui.test) it stays in place.
  const overlay = (
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
  );

  return typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay;
}
