import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, MoreVertical, Shield, ShieldAlert } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { haptic } from '../../lib/haptics';
import { safetyNumberFor, verifySafetyNumber } from '../../lib/safetyNumber';
import { shortNpub } from '../../lib/npub';
import Avatar from '../ui/Avatar';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';
import { orderState } from '../../lib/orderActions';
import { ORDER_STATUS } from '../../lib/paymentState';
import { jumpToMessage } from './threadMotion';

// Timed messages: what the sender stamps at send; receivers honor
// expires_at on arrival and the local sweep drops them after.
const TIMER_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: '24h', label: '1 day' },
  { value: '3d', label: '3 days' },
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

// The header's Order pill: one open payable deal per chat is enough for a
// short list of anchors — the pill names it and jumps; anything else stays
// a ledger question, and MyOrders is the ledger.
const PAYABLE_ANCHOR_STATES = new Set([
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.PAID,
]);

// The latest address-bearing card for one chat's thread and order request:
// the accepted update that carries an address for the coin it names. A
// peer-typed coin name such as '__proto__' resolves on any object keyed
// lookup would build, so the pair is checked with the table the rails
// themselves define and the address string has to be non-empty. Null when
// nothing has been issued yet or when the only issued pair carries no
// address at all.
export function payableOrderAnchorOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const request = [...list].reverse()
    .find((message) => message?.id && ['order_request', 'cipher_order'].includes(message.data?.type));
  if (!request) return null;
  const orderId = request.id;
  if (!PAYABLE_ANCHOR_STATES.has(orderState(list, orderId, request, '', '').status)) return null;
  const issue = [...list].reverse().find((message) => {
    if (message?.data?.type !== 'order_update' || String(message.data.orderId) !== String(orderId)) return false;
    const methods = message.data.paymentMethods;
    if (!methods || typeof methods !== 'object') return false;
    const coin = String(message.data.coinCurrency || '').trim().toLowerCase();
    if (!coin || !Object.hasOwn(methods, coin)) return false;
    return String(methods[coin] || '').trim() !== '';
  });
  return issue || null;
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
  // One picker serves both kinds of chat: the send path already reads the
  // timer keyed by chat id (groups included) and stamps expires_at. The
  // toggle rows below key off the same id.
  const activeChatId = mode === 'dm' ? activeDm : activeGroup?.id;
  // The presentation toggles read their current state per render so each
  // menu row shows what tapping it would do. The muted read mirrors the
  // chat-list badge predicate exactly: on the mute list, or muted until a
  // future time (or forever). Persisted writes belong to the store.
  const pinned = useChatStore((state) => (activeChatId ? state.pinnedChats.includes(activeChatId) : false));
  const muted = useChatStore((state) => {
    if (!activeChatId) return false;
    const until = state.mutedUntil[activeChatId];
    return state.mutedChats.includes(activeChatId) || until === 'forever' || (typeof until === 'number' && until > Date.now());
  });
  const archived = useChatStore((state) => (activeChatId ? state.archivedChats.includes(activeChatId) : false));
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
  const someoneTyping = mode === 'dm'
    ? Boolean(typingAt && now - typingAt < 6000)
    : Object.values(groupTyping || {}).some((stamp) => now - stamp < 6000);
  // The safety-engine flag, read per render: the 400ms clock below re-renders
  // this header, so a real key change is led with within a beat of it
  // landing — the flag is sticky in the safety record until re-verified.
  const safety = mode === 'dm' && activeDm ? safetyNumberFor(activeDm) : null;
  const keyChanged = Boolean(safety?.changed);
  const subtitle = keyChanged ? 'key changed — re-verify' : (mode === 'dm' ? 'encrypted' : 'group');
  // The Order pill reads the DM thread only. The latest address-bearing
  // card for the newest open request is what a jump can anchor on; before
  // an address exists, or after the deal closed, there is nothing to jump
  // to and no pill — MyOrders already carries the whole ledger.
  // Subscribed, not getState(): a refund or merge landing while the header
  // sits parked must retire the pill without waiting for some other
  // re-render. Same selector shape DmView uses for its own thread read.
  // The Hook runs on every render; the ternary only guards what it reads.
  const subscribedDm = useChatStore((state) => (state.activeDm ? state.dms[state.activeDm] : null));
  const dmThread = mode === 'dm' ? subscribedDm : null;
  const orderAnchor = payableOrderAnchorOf(dmThread);

  // Header: 56px bar with back left, peer mark centred, kebab right. Timer
  // and group info ride in the kebab so the row never crowds.
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
      {/* Name and status sit in one bounded column so a long name can only
          ever shorten itself, never reach across the controls. The avatar on
          the right repeats the title's door: a tap opens what it names. */}
      <div className="flex h-14 items-center gap-1 px-1">
        <button onClick={() => setView('list')} className="touch-target flex shrink-0 items-center justify-center text-ink" aria-label="Back">
          <ChevronLeft size={24} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start justify-center text-left"
          onClick={() => {
            // The title is the door to what it names: a person's profile, or
            // the group's own information. The long press stays for people
            // who reach for it, but an ordinary tap must not do nothing.
            if (mode === 'dm') setProfilePubkey(activeDm);
            else setShowGroupInfo(true);
          }}
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
          <h2 className="w-full truncate text-[16px] font-semibold leading-tight text-ink">{title}</h2>
          <span className={`w-full truncate text-[12px] leading-tight ${keyChanged ? 'text-danger' : someoneTyping ? 'text-accentText' : 'text-inkSubtle'}`}>
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
          </span>
        </button>
        <button
          type="button"
          aria-label={mode === 'dm' ? 'Profile' : 'Group information'}
          onClick={() => {
            if (mode === 'dm') setProfilePubkey(activeDm);
            else setShowGroupInfo(true);
          }}
          className="touch-target flex shrink-0 items-center justify-center"
        >
          <Avatar
            src={picture}
            name={mode === 'dm' ? profile?.displayName : activeGroup?.name}
            pubkey={mode === 'dm' ? activeDm : ''}
            size="sm"
            className="h-8 w-8 rounded-full object-cover"
          />
        </button>
        {orderAnchor && (
          // The Order pill: the payable deal has an anchor in the thread, so
          // the header carries the one-tap door back to it. The jump is the
          // reply-quote machinery — same scroll, same glow ring; when the
          // card is virtualized away or deleted the honest fallback fires
          // and nothing happens (threadMotion's own contract).
          <button
            type="button"
            aria-label="Jump to the order payment card"
            onClick={() => { haptic('light'); jumpToMessage(orderAnchor.id); }}
            className="touch-target flex shrink-0 items-center rounded-full border border-accentText px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-accentText active:bg-ink/10"
          >
            Order
          </button>
        )}
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Chat options"
            aria-expanded={menuOpen}
            className={`touch-target -mr-1 flex items-center justify-center ${timer && timer !== 'off' ? 'text-accentText' : 'text-ink/70 hover:text-ink'}`}
          >
            <MoreVertical size={20} />
          </button>
        </div>
      </div>
      {/* The verify-contact row, DM only and only once a safety record exists:
          the 15 digits live here on the header (read via safetyNumberFor) and
          the row is the door to the comparison sheet. When the safety engine
          flags a changed key, the same row becomes the red banner — the first
          thing a returned chat sees — still one tap from the read-out. The
          sticky parent keeps it pinned under the title bar. */}
      {mode === 'dm' && safety && (
        <button
          type="button"
          aria-label={keyChanged ? 'Security check required' : 'Verify contact codes'}
          onClick={() => { haptic('light'); setSafetyOpen(true); }}
          className={`flex w-full items-center justify-between gap-2 border-t border-line px-3 py-2 text-left active:bg-ink/5 ${keyChanged ? 'bg-danger/10' : 'bg-panel/50'}`}
        >
          <span className={`flex min-w-0 items-center gap-1.5 text-[12px] font-semibold ${keyChanged ? 'text-danger' : 'text-inkSubtle'}`}>
            {keyChanged ? <ShieldAlert size={14} /> : <Shield size={14} />}
            <span className="truncate">{keyChanged ? 'Key changed — verify with your contact' : 'Verify codes'}</span>
          </span>
          <span className={`mono shrink-0 text-[12px] tracking-widest ${keyChanged ? 'text-danger' : 'text-ink'}`}>{safety.number}</span>
        </button>
      )}
      {menuOpen && activeChatId && (
        <div className="absolute right-2 top-full z-fab mt-1 w-56 rounded-2xl border border-line bg-panel p-1">
          {/* The presentation toggles live here because this is where a
              conversation is being looked at: mute, pin, archive persist
              through scoped storage (the store owns the write), and each
              row shows its current state so the door is its own answer. */}
          <button
            type="button"
            onClick={() => { haptic('light'); useChatStore.getState().togglePinChat(activeChatId); }}
            className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-[14px] text-ink"
          >
            {pinned ? 'Unpin chat' : 'Pin chat'}
          </button>
          <button
            type="button"
            onClick={() => { haptic('light'); useChatStore.getState().toggleMuteChat(activeChatId); }}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-[14px] ${muted ? 'text-accentText' : 'text-ink'}`}
          >
            {muted ? 'Unmute notifications' : 'Mute notifications'}
          </button>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); haptic('light'); useChatStore.getState().toggleArchiveChat(activeChatId); if (!archived) setView('list'); }}
            className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-[14px] text-ink"
          >
            {archived ? 'Unarchive chat' : 'Archive chat'}
          </button>
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
                Read these 15 numbers with {title} in person. If they match, this chat is between you two and nobody else.
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
