import { useEffect, useState } from 'react';
import { ArrowLeft, Info, Phone } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { startCall } from '../../lib/voiceCall';
import { shortNpub } from '../../lib/npub';

export default function ChatHeader({ mode }) {
  const setView = useChatStore((state) => state.setView);
  const activeDm = useChatStore((state) => state.activeDm);
  const activeGroup = useChatStore((state) => state.activeGroup);
  const setProfilePubkey = useChatStore((state) => state.setProfilePubkey);
  const setShowGroupInfo = useChatStore((state) => state.setShowGroupInfo);
  const setToast = useChatStore((state) => state.setToast);
  const profile = useChatStore((state) => (activeDm ? state.profiles[activeDm] : undefined));
  const typingAt = useChatStore((state) => (activeDm ? state.typingUsers[activeDm] : 0));
  const groupTyping = useChatStore((state) => state.groupTypingUsers);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(timer);
  }, []);

  const title = mode === 'dm'
    ? (profile?.displayName || profile?.name || shortNpub(activeDm) || 'Chat')
    : activeGroup?.name || 'Group';
  const someoneTyping = mode === 'dm'
    ? Boolean(typingAt && now - typingAt < 6000)
    : Object.values(groupTyping || {}).some((stamp) => now - stamp < 6000);
  const subtitle = someoneTyping ? 'typing' : (mode === 'dm' ? 'encrypted' : 'group');

  const placeCall = async () => {
    const result = await startCall({ peer: activeDm, name: title });
    if (!result.ok) setToast({ type: 'error', message: result.error });
  };

  return (
    <div className="sticky top-0 z-40 flex items-center justify-between border-b border-white/10 bg-[#0A0A0A]/60 px-2 py-3 shadow-2xl backdrop-blur-2xl pt-[env(safe-area-inset-top)]">
      <div className="flex min-w-0 items-center gap-2">
        <button onClick={() => setView('list')} className="p-2 text-white" aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <button type="button" className="min-w-0 text-left" onClick={() => mode === 'dm' && setProfilePubkey(activeDm)}>
          <h2 className="truncate text-2xl font-bold tracking-tight text-white">{title}</h2>
          <p className={`flex items-center gap-1 text-[13px] ${someoneTyping ? 'text-blue-400' : 'text-white/40'}`}>
            {someoneTyping ? (
              <>
                typing
                <span className="inline-flex gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-blue-400 [animation-delay:120ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-blue-400 [animation-delay:240ms]" />
                </span>
              </>
            ) : subtitle}
          </p>
        </button>
      </div>
      <div className="flex items-center">
        {mode === 'group' && <button type="button" onClick={() => setShowGroupInfo(true)} aria-label="Group information and pinned listing" className="p-2 text-white/50 hover:text-white"><Info size={19} /></button>}
        {mode === 'dm' && <button type="button" onClick={placeCall} aria-label="Voice call" className="p-2 text-white/70 hover:text-white"><Phone size={18} /></button>}
      </div>
    </div>
  );
}
