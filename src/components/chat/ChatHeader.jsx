import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, MoreVertical, Phone, Shield, ShieldAlert } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { startCall } from '../../lib/voiceCall';
import { haptic } from '../../lib/haptics';
import { safetyNumberFor, verifySafetyNumber } from '../../lib/safetyNumber';
import { shortNpub } from '../../lib/npub';
import Picture from '../ui/Picture';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';

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
  // Long avatar hold in a group opens the group information Sheet without
  // fishing in the kebab. A plain tap keeps its existing behavior.
  const holdRef = useRef(null);
  const cancelHold = () => {
    if (holdRef.current) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };
  const startGroupInfoHold = () => {
    if (mode !== 'group') return;
    cancelHold();
    holdRef.current = setTimeout(() => {
      holdRef.current = null;
      haptic('medium');
      setMenuOpen(false);
      setShowGroupInfo(true);
    }, 450);
  };

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
  // The safety-engine flag, read per render: the 400ms clock below re-renders
  // this header, so a real key change is led with within a beat of it
  // landing — the flag is sticky in the safety record until re-verified.
  const safety = mode === 'dm' && activeDm ? safetyNumberFor(activeDm) : null;
  const keyChanged = Boolean(safety?.changed);
  const subtitle = keyChanged ? 'key changed — re-verify' : (mode === 'dm' ? 'encrypted' : 'group');

  const placeCall = async () => {
    const result = await startCall({ peer: activeDm, name: title });
    if (!result.ok) setToast({ type: 'error', message: result.error });
  };

  // Header: 56px bar with back left, peer mark centred, kebab right. The
  // voice call stays a direct tap in DMs — it is not buried in the menu.
  // Timer and group info ride in the kebab so the row never crowds.
  const [menuOpen, setMenuOpen] = useState(false);
  // The comparison door: the kebab row opens the sheet, and the sheet carries
  // the 15 digits, the changed warning and — only while the flag is up — the
  // one button that clears it, after a human says the digits matched.
  const [safetyOpen, setSafetyOpen] = useState(false);
  const openTimer = () => {
    setMenuOpen(false);
    setShowTimer(true);
  };
  const markCompared = () => {
    verifySafetyNumber(activeDm);
    haptic('light');
    setToast({ type: 'success', message: 'Warning cleared.' });
    setSafetyOpen(false);
  };

  return (
    <div className="sticky top-0 z-fab border-b border-line bg-base pt-[env(safe-area-inset-top)]">
      <div className="relative flex h-14 items-center px-3">
        <button onClick={() => setView('list')} className="touch-target -ml-2 flex items-center justify-center text-ink" aria-label="Back">
          <ChevronLeft size={24} />
        </button>
        <button
          type="button"
          className="absolute left-1/2 flex min-w-0 -translate-x-1/2 flex-col items-center gap-0.5"
          onClick={() => mode === 'dm' && setProfilePubkey(activeDm)}
          onPointerDown={startGroupInfoHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(event) => {
            if (mode === 'group') {
              event.preventDefault();
              setMenuOpen(false);
              setShowGroupInfo(true);
            }
          }}
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
      <p className={`pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-[11px] ${keyChanged ? 'text-danger' : someoneTyping ? 'text-accentText' : 'text-inkSubtle'}`}>
        {someoneTyping && !keyChanged ? (
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
        <div className="absolute right-2 top-full z-fab mt-1 w-56 rounded-2xl border border-line bg-panel p-1">
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
              onClick={() => { setMenuOpen(false); haptic('light'); setSafetyOpen(true); }}
              className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-[14px] ${keyChanged ? 'text-danger' : 'text-ink'}`}
            >
              Safety number
              {keyChanged && <ShieldAlert size={16} />}
              {!keyChanged && <Shield size={16} className="text-inkSubtle" />}
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
      <Sheet
        open={safetyOpen}
        onClose={() => setSafetyOpen(false)}
        heading="Safety number"
        ariaLabel="Safety number"
      >
        <div className="pb-4">
          {safety ? (
            <>
              <p className="mono text-center text-2xl font-bold tracking-widest text-ink">{safety.number}</p>
              <p className="mt-3 text-[13px] leading-relaxed text-inkSubtle">
                Read these 15 numbers with {title} on a call or in person. If they match, this chat is between you two and nobody else.
              </p>
              {keyChanged && (
                <div className="mt-3 rounded-xl border border-line bg-panelStrong p-3">
                  <p className="text-[13px] font-semibold text-danger">This contact's key changed.</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-inkSubtle">
                    Do not skip the read-out. A match says the new key is really theirs.
                  </p>
                  <Button variant="danger" size="md" fullWidth className="mt-3" onClick={markCompared}>
                    We compared them
                  </Button>
                </div>
              )}
              <p className="mt-3 text-center text-[11px] text-inkSubtle">
                First seen {new Date(safety.firstSeenAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-inkSubtle">
              No safety number yet — it shows up after your first messages with this contact.
            </p>
          )}
        </div>
      </Sheet>
    </div>
  );
}
