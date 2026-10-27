import { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { createDeadDropNote } from '../../lib/deadDrop';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { haptic } from '../../lib/haptics';

// Dead-drop note writer: type it, get one link, the note burns after it is
// opened. The link carries the key in its fragment — anyone who can see the
// link can read the note, so it is shown once and never stored.
export default function DeadDropModal({ identity }) {
  const show = useChatStore((s) => s.showDeadDrop);
  const setShow = useChatStore((s) => s.setShowDeadDrop);
  const setToast = useChatStore((s) => s.setToast);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!show) return null;

  const close = () => {
    setShow(false);
    setText('');
    setLink('');
    setCopied(false);
  };

  const make = async () => {
    if (!text.trim() || busy) return;
    haptic('light');
    setBusy(true);
    try {
      const pool = await getAuthenticatedPool(identity);
      const { url } = await createDeadDropNote({ identity, text, pool, relays: generalRelays });
      setLink(url);
      setText('');
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'The note could not be sent.' });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      haptic('light');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setToast({ type: 'error', message: 'Could not copy. Long-press the link to copy it by hand.' });
    }
  };

  return (
    <div className="fixed inset-0 z-sheet flex items-end justify-center bg-scrim/70 p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]" onClick={close}>
      <div
        className="w-full max-w-md rounded-3xl border border-line bg-panelStrong p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">Burn note</h2>
          <button type="button" onClick={close} aria-label="Close" className="p-1.5 text-ink/50 hover:text-ink"><X size={18} /></button>
        </div>
        <p className="mb-3 text-[13px] leading-relaxed text-ink/50">
          Write it, get one link, send it however you want. The note opens once — after that it is gone. Whoever has the link can read it, so send it to the right chat.
        </p>

        {link ? (
          <div>
            <div className="max-h-32 overflow-y-auto break-all rounded-2xl border border-line bg-panel p-3 font-mono text-[12px] text-accentText">{link}</div>
            <button
              type="button"
              onClick={copy}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl bg-accent py-2.5 font-bold text-accentInk active:scale-[0.99]"
            >
              {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy link</>}
            </button>
            <p className="mt-2 text-center text-[11px] text-ink/40">This link shows once. It is not saved anywhere.</p>
          </div>
        ) : (
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={8000}
              rows={5}
              placeholder="Say it once."
              className="w-full resize-none rounded-2xl border border-line bg-panel p-3 text-[14px] text-ink placeholder-ink/30 outline-none focus:border-lineStrong"
              autoFocus
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] text-inkSubtle">{text.length}/8000</span>
              <button
                type="button"
                onClick={make}
                disabled={!text.trim() || busy}
                className="min-h-[44px] rounded-2xl bg-accent px-6 font-bold text-accentInk disabled:opacity-40"
              >
                {busy ? 'Sealing…' : 'Make the link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
