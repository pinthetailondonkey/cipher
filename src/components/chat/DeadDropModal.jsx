import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { createNoteLink } from '../../lib/deadDrop';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { haptic } from '../../lib/haptics';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';

// Dead-drop note writer: type it, get one link. The link carries the key in
// its fragment, so anyone who can see the link can open the note; that is why
// the surface says nothing beyond the label.
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
      // The host is asked first: when it is the one-read carrier, the host
      // deletes the note on the first fetch. Without it the relay copy is
      // still made, exactly as before.
      const { url } = await createNoteLink({ identity, text, pool, relays: generalRelays });
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
    <Sheet open={show} onClose={close} title="Burn note">
      {link ? (
        <div className="pb-2">
          <div className="max-h-32 overflow-y-auto break-all rounded-2xl border border-line bg-panelStrong p-3 font-mono text-[12px] text-accentText">{link}</div>
          <Button fullWidth className="mt-3" onClick={copy}>
            {copied ? <><Check size={16} className="mr-1 inline" /> Copied</> : <><Copy size={16} className="mr-1 inline" /> Copy link</>}
          </Button>
        </div>
      ) : (
        <div className="pb-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={8000}
            rows={5}
            className="w-full resize-none rounded-2xl border border-line bg-panelStrong p-3 text-[14px] text-ink placeholder-ink/30 outline-none focus:border-accent"
            autoFocus
          />
          <div className="mt-1 flex items-center justify-between pb-1">
            <span className="text-[11px] text-inkSubtle">{text.length}/8000</span>
            <Button onClick={make} loading={busy} disabled={!text.trim() || busy}>
              {busy ? 'Sealing…' : 'Make the link'}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
