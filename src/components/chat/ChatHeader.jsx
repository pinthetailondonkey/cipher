import { useEffect, useState } from 'react';
import { ArrowLeft, Hourglass, Info, Phone } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { startCall } from '../../lib/voiceCall';
import { shortNpub } from '../../lib/npub';

// Timed messages: what the sender stamps at send; receivers honor
// expires_at on arrival and the local sweep drops them after.
const TIMER_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: '24h', label: '1 day' },
  { value: '7d', label: '1 week' },
  { value: '30d', label: '1 month' },
];

function TimerPicker({ chatId, timer, onPick }) {
  return (
    <div className="flex justify-end gap-1 px-4 pb-2" role="group" aria-label="Message timer">
      {TIMER_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          onClick={() => onPick(choice.value)}
          className={`rounded-full border px-3 py-1.5 text-[12px] font-medium ${timer === choice.value ? 'border-accent bg-accent text-accentInk' : 'border-line text-ink/60'}`}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

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
  const timer = useChatStore((state) => {
    const chatId = mode === 'dm' ? activeDm : activeGroup?.id;
    return chatId ? state.disappearingTimers[chatId] : undefined;
  });
  const [showTimer, setShowTimer] = useState(false);
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
    <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-base px-2 py-3 shadow-lg pt-[env(safe-area-inset-top)]">
      <div className="flex min-w-0 items-center gap-2">
        <button onClick={() => setView('list')} className="p-2 text-ink" aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <button type="button" className="min-w-0 text-left" onClick={() => mode === 'dm' && setProfilePubkey(activeDm)}>
          <h2 className="truncate text-2xl font-bold tracking-tight text-ink">{title}</h2>
          <p className={`flex items-center gap-1 text-[13px] ${someoneTyping ? 'text-accent' : 'text-ink/40'}`}>
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
        {mode === 'dm' && (
          <button
            type="button"
            onClick={() => setShowTimer((open) => !open)}
            aria-label="Message timer"
            aria-expanded={showTimer}
            className={`p-2 ${timer && timer !== 'off' ? 'text-accent' : 'text-ink/70 hover:text-ink'}`}
          >
            <Hourglass size={17} />
          </button>
        )}
        {mode === 'group' && <button type="button" onClick={() => setShowGroupInfo(true)} aria-label="Group information and pinned listing" className="p-2 text-ink/50 hover:text-ink"><Info size={19} /></button>}
        {mode === 'dm' && <button type="button" onClick={placeCall} aria-label="Voice call" className="p-2 text-ink/70 hover:text-ink"><Phone size={18} /></button>}
      </div>
      {showTimer && mode === 'dm' && (
        <TimerPicker
          chatId={activeDm}
          timer={timer}
          onPick={(value) => {
            useChatStore.getState().setDisappearingTimer(activeDm, value);
            setShowTimer(false);
          }}
        />
      )}
    </div>
  );
}
