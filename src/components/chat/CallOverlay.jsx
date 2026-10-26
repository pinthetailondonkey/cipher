import { useEffect, useState, useSyncExternalStore } from 'react';
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { acceptCall, getCallSnapshot, hangup, subscribeCall, toggleMute } from '../../lib/voiceCall';
import { useChatStore } from '../../store/chatStore';
import { haptic } from '../../lib/haptics';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';

const EMPTY_PROFILE = {};

function formatDuration(startedAt, now) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

export default function CallOverlay() {
  const call = useSyncExternalStore(subscribeCall, getCallSnapshot, getCallSnapshot);
  const profile = useChatStore((state) => (call?.peer ? state.profiles[call.peer] : undefined)) || EMPTY_PROFILE;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!call?.callId) return undefined;
    haptic('medium');
    return undefined;
  }, [call?.callId]);

  useEffect(() => {
    if (call?.status !== 'active') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call?.status, call?.callId]);

  if (!call) return null;
  const name = profile.displayName || profile.name || call.name || 'Voice call';
  const status = {
    calling: 'Calling…',
    ringing: 'Incoming voice call',
    connecting: 'Connecting…',
    active: formatDuration(call.startedAt || now, now),
    declined: 'Call declined',
    busy: 'User is busy',
    restricted: 'This person is not accepting calls',
    ended: 'Call ended',
  }[call.status] || 'Voice call';
  const live = call.status === 'calling' || call.status === 'ringing' || call.status === 'connecting' || call.status === 'active';
  const answer = () => {
    haptic('medium');
    acceptCall();
  };
  const decline = () => {
    haptic('heavy');
    hangup();
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <Avatar src={profile.picture} name={name} className={`!h-32 !w-32 text-4xl ${call.status === 'ringing' || call.status === 'calling' ? 'animate-pulse' : ''}`} />
        <h2 className="mt-5 max-w-full truncate text-2xl font-bold tracking-tight text-white">{name}</h2>
        <p className="mt-1 text-[15px] text-white/50">{status}</p>
      </div>
      <div className={`flex items-end justify-center gap-14 px-8 pb-16 ${call.status === 'ringing' && call.direction === 'in' ? '' : ''}`}>
        {call.status === 'active' && (
          <button type="button" onClick={toggleMute} className="flex flex-col items-center gap-2 text-white" aria-label={call.muted ? 'Unmute' : 'Mute'}>
            <span className={`flex h-16 w-16 items-center justify-center rounded-full border border-line bg-panelStrong shadow-lg active:bg-white/20 ${pressable}`}>{call.muted ? <MicOff size={24} /> : <Mic size={24} />}</span>
            <span className="text-[13px] text-white/70">{call.muted ? 'Unmute' : 'Mute'}</span>
          </button>
        )}
        {call.status === 'ringing' && call.direction === 'in' && (
          <button type="button" onClick={decline} className="flex flex-col items-center gap-2" aria-label="Decline call">
            <span className={`flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white active:bg-red-700 ${pressable}`}><PhoneOff size={26} /></span>
            <span className="text-[13px] text-white/70">Decline</span>
          </button>
        )}
        {call.status === 'ringing' && call.direction === 'in' && (
          <button type="button" onClick={answer} className="flex flex-col items-center gap-2" aria-label="Accept call">
            <span className={`flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white active:bg-emerald-600 ${pressable}`}><Phone size={26} /></span>
            <span className="text-[13px] text-white/70">Accept</span>
          </button>
        )}
        {live && !(call.status === 'ringing' && call.direction === 'in') && (
          <button type="button" onClick={decline} className="flex flex-col items-center gap-2" aria-label="End call">
            <span className={`flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white active:bg-red-700 ${pressable}`}><PhoneOff size={26} /></span>
            <span className="text-[13px] text-white/70">End</span>
          </button>
        )}
      </div>
    </div>
  );
}
