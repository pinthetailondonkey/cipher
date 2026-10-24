import { useEffect, useState } from 'react';
import { ArrowLeft, Info, MoreVertical, Phone } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { startCall } from '../../lib/voiceCall';

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
    ? (profile?.displayName || profile?.name || activeDm?.slice(0, 8) || 'Chat')
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
    <div className="sticky top-0 z-40 flex items-center justify-between border-b border-white/10 bg-[#0a0a0a]/90 px-3 py-2 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2">
        <button onClick={() => setView('list')} className="p-2 -ml-1 text-white/70 hover:text-white" aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <button type="button" className="min-w-0 text-left" onClick={() => mode === 'dm' && setProfilePubkey(activeDm)}>
          <h2 className="truncate text-[16px] font-semibold leading-tight text-white">{title}</h2>
          <p className={`flex items-center gap-1 text-[11px] font-medium ${someoneTyping ? 'text-blue-400' : 'text-blue-500'}`}>
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
        <button type="button" onClick={() => mode === 'group' ? setShowGroupInfo(true) : setProfilePubkey(activeDm)} aria-label={mode === 'group' ? 'More group details' : 'More contact details'} className="p-2 text-white/50 hover:text-white"><MoreVertical size={20} /></button>
      </div>
    </div>
  );
}
