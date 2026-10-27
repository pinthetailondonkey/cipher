import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { useChatStore } from '../store/chatStore';
import useDialogA11y from './ui/dialogA11y';

export default function GlobalDialog() {
  const dialog = useChatStore((state) => state.dialog);
  const closeDialog = useChatStore((state) => state.closeDialog);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const panelRef = useRef(null);

  useEffect(() => {
    setValue(dialog?.inputDefault || '');
    setError('');
    setBusy(false);
  }, [dialog]);
  useDialogA11y(Boolean(dialog), closeDialog, panelRef);
  useEffect(() => {
    if (!dialog) return undefined;
    const focusable = panelRef.current?.querySelector('textarea, button');
    focusable?.focus();
    return undefined;
  }, [dialog]);

  if (!dialog) return null;

  const confirm = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await dialog.onConfirm?.(dialog.hasInput ? value : undefined);
      closeDialog();
    } catch (confirmError) {
      console.error('[GlobalDialog] Action failed:', confirmError);
      setError(confirmError?.message || 'Could not complete this action.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-call flex items-center justify-center bg-scrim/80 p-4" role="presentation">
      <form ref={panelRef} onSubmit={confirm} role="dialog" aria-modal="true" aria-labelledby="global-dialog-title" className="w-full max-w-sm rounded-3xl border border-line bg-panel p-6">
        <div className="flex items-start gap-3">
          {dialog.type === 'danger' && <AlertTriangle size={21} className="mt-1 shrink-0 text-danger" />}
          <div className="min-w-0 flex-1">
            <h2 id="global-dialog-title" className="text-xl font-bold text-ink">{dialog.title || 'Confirm'}</h2>
            {dialog.message && <p className="mt-2 whitespace-pre-wrap text-[13px] text-ink/55">{dialog.message}</p>}
          </div>
          <button type="button" onClick={closeDialog} aria-label="Close" className="p-1 text-ink/45 hover:text-ink"><X size={19} /></button>
        </div>
        {dialog.hasInput && (
          <textarea
            autoFocus={!dialog.inputLocked}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            readOnly={Boolean(dialog.inputLocked)}
            placeholder={dialog.placeholder || ''}
            rows={dialog.inputRows || 4}
            className={`mt-4 w-full resize-y rounded-xl border border-line bg-panelStrong p-3 text-sm outline-none placeholder:text-ink/35 focus:border-lineStrong ${dialog.inputLocked ? 'text-ink/55' : 'text-ink'}`}
          />
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={closeDialog} disabled={busy} className="flex-1 rounded-xl border border-line py-3 text-sm font-semibold text-ink/70 hover:bg-ink/5">Cancel</button>
          <button type="submit" disabled={busy} className={`flex-1 rounded-xl py-3 text-sm font-semibold text-ink disabled:opacity-50 ${dialog.type === 'danger' ? 'bg-danger hover:bg-danger' : 'bg-accent hover:bg-accent'}`}>
            {busy ? 'Working…' : <>{dialog.confirmText || 'Continue'} <Check className="ml-1 inline" size={15} /></>}
          </button>
        </div>
      </form>
    </div>
  );
}
