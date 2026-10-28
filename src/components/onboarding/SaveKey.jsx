import React, { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import { copyText } from '../../lib/copyText';

// SaveKey — the 12-word handoff (§10). Every word hides behind its cell and
// reveals on tap; Copy and Share reuse the backup screen's copy path. The
// checkbox gates the Continue press.
export default function SaveKey({ savedMnemonic, biometricNotice, onContinue }) {
  const words = (savedMnemonic || '').split(' ');
  const [revealed, setRevealed] = useState(() => new Set());
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const reveal = (i) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

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
      <p className="mb-8 max-w-[280px] text-center text-[13px] leading-relaxed text-inkMuted">Write down these 12 words. You need them and your PIN to recover this account. Five wrong PINs delete the copy stored on this device.</p>

      <form onSubmit={(e) => { e.preventDefault(); handleContinue(); }} className="flex w-full flex-col items-center gap-6 rounded-3xl border border-line bg-panel p-6">
        <div className="grid w-full grid-cols-3 gap-2">
          {words.map((word, i) => (
            <button
              key={i}
              type="button"
              onClick={() => reveal(i)}
              aria-label={revealed.has(i) ? `Word ${i + 1} revealed` : `Reveal word ${i + 1}`}
              className="rounded-xl border border-line bg-panelStrong p-3 text-center font-mono text-[13px] text-ink active:bg-ink/10"
            >
              {revealed.has(i) ? (
                word
              ) : (
                // The unrevealed cell shows its POSITION, never a word-shaped
                // placeholder: twelve identical chips read as "the generator
                // made the same word twelve times" (the founder's exact read).
                // A number is an index, can't be mistaken for key material,
                // and the tap-to-reveal affordance stays in the aria-label.
                <span className="text-inkMuted">{i + 1}</span>
              )}
            </button>
          ))}
        </div>
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
