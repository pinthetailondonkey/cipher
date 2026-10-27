import { useEffect, useState } from 'react';
import { ChevronLeft, Copy, Fingerprint, MoreVertical, Phone } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { startCall } from '../../lib/voiceCall';
import { safetyNumberFor } from '../../lib/safetyNumber';
import { copyText } from '../../lib/copyText';
import { shortNpub } from '../../lib/npub';
import Picture from '../ui/Picture';

// Timed messages: what the sender stamps at send; receivers honor
// expires_at on arrival and the local sweep drops them after.
const TIMER_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: '24h', label: '1 day' },
  { value: '7d', label: '1 week' },
  { value: '30d', label: '1 month' },
];

function TimerPicker({ timer, onPick }) {
  return (
    <div className="flex justify-end gap-1 px-4 pb-2" role="group" aria-label="Message timer">
      {TIMER_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          onClick={() => onPick(choice.value)}
          className={`rounded-full border px-3 py-1.5 text-[12px] font-medium ${timer === choice.value ? 'border-accent bg-accent text-accentInk' : 'border-line text-inkSubtle'}`}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

// The safety number the engine pins at first contact, shown as it derives:
// five groups of three digits. Comparing it out-of-band is the whole check.
function SafetySheet({ dm, onClose }) {
  const record = dm ? safetyNumberFor(dm) : null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-scrim/60"
      onClick={onClose}
      data-testid="safety-sheet"
    >
      <div
        className="mb-[env(safe-area-inset-bottom)] w-full max-w-md rounded-t-2xl border border-line bg-panel p-4 pb-6 sm:mb-0 sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold text-ink">Safety number</p>
            <p className="mt-1 text-[12px] text-inkSubtle">Check it in person or over another channel. Both people seeing the same number means no one swapped a key.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target -mt-2 -mr-2 flex items-center justify-center text-inkSubtle">
            <span className="text-[18px]">&times;</span>
          </button>
        </div>
        {record ? (
          <>
            <p className="mt-5 text-center text-[22px] font-bold leading-none tracking-[0.08em] text-ink">{record.number}</p>
            {record.changed && (
              <p className="mt-3 text-center text-[12px] text-ink">The key changed since you first saw this person. Compare carefully before trusting anything new.</p>
            )}
            <button
              type="button"
              onClick={() => copyText(record.number)}
              className="mt-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-line bg-panelAlt py-2 text-[14px] font-semibold text-ink"
            >
              <Copy size={16} />
              Copy number
            </button>
          </>
        ) : (
          <p className="mt-5 text-center text-[13px] text-inkSubtle">No safety number yet. It appears here after you chat with this person.</p>
        )}
      </div>
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
  const picture = mode === 'dm' ? profile?.picture : activeGroup?.picture;
  const initial = title.charAt(0) || '?';
  // One picker serves both kinds of chat: the send path already reads the
  // timer keyed by chat id (groups included) and stamps expires_at.
  const activeChatId = mode === 'dm' ? activeDm : activeGroup?.id;
  const someoneTyping = mode === 'dm'
    ? Boolean(typingAt && now - typingAt < 6000)
    : Object.values(groupTyping || {}).some((stamp) => now - stamp < 6000);
  const subtitle = someoneTyping ? 'typing' : (mode === 'dm' ? 'encrypted' : 'group');

  const placeCall = async () => {
    const result = await startCall({ peer: activeDm, name: title });
    if (!result.ok) setToast({ type: 'error', message: result.error });
  };

  // Header: 56px bar with back left, peer mark centred, kebab right. The
  // voice call stays a direct tap in DMs — it is not buried in the menu.
  // Timer and group info ride in the kebab so the row never crowds.
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSafety, setShowSafety] = useState(false);
  const openTimer = () => {
    setMenuOpen(false);
    setShowTimer(true);
  };
  const openSafety = () => {
    setMenuOpen(false);
    setShowSafety(true);
  };

  return (
    <div className="sticky top-0 z-40 border-b border-line bg-base pt-[env(safe-area-inset-top)]">
      <div className="relative flex h-14 items-center px-3">
        <button onClick={() => setView('list')} className="touch-target -ml-2 flex items-center justify-center text-ink" aria-label="Back">
          <ChevronLeft size={24} />
        </button>
        <button
          type="button"
          className="absolute left-1/2 flex min-w-0 -translate-x-1/2 flex-col items-center gap-0.5"
          onClick={() => mode === 'dm' && setProfilePubkey(activeDm)}
        >
          <Picture
            src={picture}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
            fallback={<span className="flex h-7 w-7 items-center justify-center rounded-full bg-panelAlt text-[12px] font-semibold text-accentText">{initial}</span>}
          />
          <h2 className="max-w-[12rem] truncate text-[15px] font-semibold leading-none text-ink">{title}</h2>
        </button>
        <div className="ml-auto flex items-center">
          {mode === 'dm' && (
            <button type="button" onClick={placeCall} aria-label="Voice call" className="touch-target -mr-1 flex items-center justify-center text-ink/70 hover:text-ink">
              <Phone size={19} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Chat options"
            aria-expanded={menuOpen}
            className={`touch-target -mr-2 flex items-center justify-center ${timer && timer !== 'off' ? 'text-accentText' : 'text-ink/70 hover:text-ink'}`}
          >
            <MoreVertical size={20} />
          </button>
        </div>
      </div>
      <p className={`pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-[11px] ${someoneTyping ? 'text-accentText' : 'text-inkSubtle'}`}>
        {someoneTyping ? (
          <>
            typing
            <span className="ml-1 inline-flex gap-0.5 align-middle">
              <span className="h-1 w-1 animate-bounce rounded-full bg-accentText [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-accentText [animation-delay:120ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-accentText [animation-delay:240ms]" />
            </span>
          </>
        ) : subtitle}
      </p>
      {menuOpen && activeChatId && (
        <div className="absolute right-2 top-full z-50 mt-1 w-56 rounded-2xl border border-line bg-panel p-1">
          <button
            type="button"
            onClick={openTimer}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-[14px] ${timer && timer !== 'off' ? 'text-accentText' : 'text-ink'}`}
          >
            Message timer
            <span className="text-[12px] text-inkSubtle">{timer && timer !== 'off' ? timer : 'Off'}</span>
          </button>
          {mode === 'dm' && (
            <button
              type="button"
              onClick={openSafety}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-[14px] text-ink"
            >
              <Fingerprint size={16} className="text-inkSubtle" />
              Verify safety number
            </button>
          )}
          {mode === 'group' && (
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setShowGroupInfo(true); }}
              className="flex w-full items-center rounded-xl px-3 py-3 text-left text-[14px] text-ink"
            >
              Group information
            </button>
          )}
        </div>
      )}
      {showTimer && (
        <TimerPicker
          timer={timer}
          onPick={(value) => {
            useChatStore.getState().setDisappearingTimer(activeChatId, value);
            setShowTimer(false);
          }}
        />
      )}
      {showSafety && (
        <SafetySheet dm={activeDm} onClose={() => setShowSafety(false)} />
      )}
    </div>
  );
}
