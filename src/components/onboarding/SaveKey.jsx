import React, { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import { copyText } from '../../lib/copyText';

// SaveKey — the 12-word handoff (§10). All twelve words show plainly in one
// numbered column: hidden cells read as empty and the reveal tap was easy to
// miss, so the founder saw positions where the words should be (2026-10-28).
// Copy and Share reuse the backup screen's copy path. The checkbox gates the
// Continue press.
export default function SaveKey({ savedMnemonic, biometricNotice, onContinue }) {
  const words = (savedMnemonic || '').split(' ');
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const copyAll = async () => {
    const ok = await copyText(savedMnemonic || '');
    if (ok) {
      setMessage('Copied. Anyone with these 12 words controls the account.');
      window.setTimeout(() => setMessage(''), 3000);
    }
  };

  const share = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'Your recovery phrase', text: savedMnemonic });
        return;
      } catch (shareError) {
        if (shareError?.name === 'AbortError') return;
        console.warn('[SaveKey] Share sheet failed, falling back to copy:', shareError);
      }
    }
    copyAll();
  };

  const handleContinue = () => {
    if (!mnemonicConfirmed) return;
    setLoading(true);
    onContinue();
  };

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold tracking-tight text-ink">Save Your Recovery Key</h1>
      <p className="mb-5 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Write down these 12 words. They bring this account back on a new device, with a new PIN you choose there. Five wrong PINs delete the copy stored on this device.</p>

      <form onSubmit={(e) => { e.preventDefault(); handleContinue(); }} className="flex w-full flex-col items-center gap-6 rounded-3xl border border-line bg-panel p-6">
        <ol className="flex w-full flex-col gap-1.5">
          {words.map((word, i) => (
            // One numbered column, every word on screen at once. The number is
            // the word's place in the phrase, so writing the phrase down in
            // order is the only reading of this list.
            <li key={i} className="flex items-center gap-3 rounded-xl border border-line bg-panelStrong px-3 py-2.5 font-mono text-[13px] text-ink">
              <span className="w-5 shrink-0 text-right text-inkMuted">{i + 1}</span>
              <span>{word}</span>
            </li>
          ))}
        </ol>
        <div className="flex w-full flex-col gap-2">
          <button type="button" onClick={copyAll} className="rounded-xl border border-line bg-panelStrong py-3 text-sm font-bold text-ink active:bg-ink/10">Copy</button>
          <button type="button" onClick={share} className="rounded-xl border border-line bg-panelStrong py-3 text-sm font-bold text-ink active:bg-ink/10">Share</button>
        </div>
        <label className="flex cursor-pointer items-center gap-3 text-sm text-inkMuted transition-colors hover:text-ink">
          <span className="relative flex h-5 w-5 items-center justify-center">
            <input type="checkbox" checked={mnemonicConfirmed} onChange={(e) => setMnemonicConfirmed(e.target.checked)} className="peer h-5 w-5 appearance-none rounded-md border border-ink/20 bg-ink/5 transition-colors checked:border-accent checked:bg-accent" />
            <Check size={14} strokeWidth={3} className="pointer-events-none absolute text-ink opacity-0 transition-opacity peer-checked:opacity-100" aria-hidden="true" />
          </span>
          I have written down these 12 words.
        </label>
        {biometricNotice && (
          <p role="status" className="rounded-xl border border-line px-3 py-2 text-center text-xs leading-relaxed text-ink/70">{biometricNotice} You can still unlock with your PIN.</p>
        )}
        {message && <p role="status" className="text-center text-xs text-inkMuted">{message}</p>}
        <Button type="submit" disabled={!mnemonicConfirmed || loading} className="mt-2 flex w-full items-center justify-center gap-2">
          {loading ? <RefreshCw size={20} className="animate-spin" /> : (mnemonicConfirmed ? 'Continue' : 'Confirm you saved it')}
        </Button>
      </form>
    </>
  );
}
