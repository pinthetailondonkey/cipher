import { useState } from 'react';
<<<<<<< HEAD
import { Copy, Check } from 'lucide-react';
import Sheet from '../ui/Sheet';
=======
import { Check, Copy } from 'lucide-react';
>>>>>>> origin/feat/rebuild-pr2
import { useChatStore } from '../../store/chatStore';
import { createDeadDropNote } from '../../lib/deadDrop';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { haptic } from '../../lib/haptics';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';

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
<<<<<<< HEAD
    <Sheet open={show} onClose={close} label="Burn note" heading="Burn note">
      <div className="px-5 pb-5 pt-2">
        <p className="mb-3 text-[13px] leading-relaxed text-ink/50">
          Write it, get one link, send it however you want. The note opens once — after that it is gone. Whoever has the link can read it, so send it to the right chat.
        </p>
=======
    <Sheet open={show} onClose={close} title="Burn note">
      <p className="mb-3 text-[13px] leading-relaxed text-inkMuted">
        Write it, get one link, send it however you want. The note opens once — after that it is gone. Whoever has the link can read it, so send it to the right chat.
      </p>
>>>>>>> origin/feat/rebuild-pr2

      {link ? (
        <div className="pb-2">
          <div className="max-h-32 overflow-y-auto break-all rounded-2xl border border-line bg-panelStrong p-3 font-mono text-[12px] text-accentText">{link}</div>
          <Button fullWidth className="mt-3" onClick={copy}>
            {copied ? <><Check size={16} className="mr-1 inline" /> Copied</> : <><Copy size={16} className="mr-1 inline" /> Copy link</>}
          </Button>
          <p className="mt-2 text-center text-[11px] text-inkSubtle">This link shows once. It is not saved anywhere.</p>
        </div>
      ) : (
        <div className="pb-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={8000}
            rows={5}
            placeholder="Say it once."
            className="w-full resize-none rounded-2xl border border-line bg-panelStrong p-3 text-[14px] text-ink placeholder-ink/30 outline-none focus:border-accent"
            autoFocus
          />
          <div className="mt-1 flex items-center justify-between pb-1">
            <span className="text-[11px] text-inkSubtle">{text.length}/8000</span>
            <Button onClick={make} loading={busy} disabled={!text.trim() || busy}>
              {busy ? 'Sealing…' : 'Make the link'}
            </Button>
          </div>
<<<<<<< HEAD
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
=======
        </div>
      )}
>>>>>>> origin/feat/rebuild-pr2
    </Sheet>
  );
}
