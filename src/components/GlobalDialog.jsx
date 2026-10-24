import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { useChatStore } from '../store/chatStore';

export default function GlobalDialog() {
  const dialog = useChatStore((state) => state.dialog);
  const closeDialog = useChatStore((state) => state.closeDialog);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(dialog?.inputDefault || '');
    setError('');
    setBusy(false);
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
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="presentation">
      <form onSubmit={confirm} role="dialog" aria-modal="true" aria-labelledby="global-dialog-title" className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-6">
        <div className="flex items-start gap-3">
          {dialog.type === 'danger' && <AlertTriangle size={21} className="mt-1 shrink-0 text-red-400" />}
          <div className="min-w-0 flex-1">
            <h2 id="global-dialog-title" className="text-xl font-bold text-white">{dialog.title || 'Confirm'}</h2>
            {dialog.message && <p className="mt-2 whitespace-pre-wrap text-[13px] text-white/55">{dialog.message}</p>}
          </div>
          <button type="button" onClick={closeDialog} aria-label="Close" className="p-1 text-white/45 hover:text-white"><X size={19} /></button>
        </div>
        {dialog.hasInput && (
          <textarea
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={dialog.placeholder || ''}
            rows={dialog.inputRows || 4}
            className="mt-4 w-full resize-y rounded-xl border border-white/10 bg-[#111] p-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-blue-500"
          />
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={closeDialog} disabled={busy} className="flex-1 rounded-xl border border-white/10 py-3 text-sm font-semibold text-white/70 hover:bg-white/5">Cancel</button>
          <button type="submit" disabled={busy} className={`flex-1 rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50 ${dialog.type === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}>
            {busy ? 'Working…' : <>{dialog.confirmText || 'Continue'} <Check className="ml-1 inline" size={15} /></>}
          </button>
        </div>
      </form>
    </div>
  );
}
