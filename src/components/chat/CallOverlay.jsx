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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black px-6">
      <div className="flex w-full max-w-sm flex-col items-center rounded-3xl border border-white/10 bg-[#0A0A0A] px-6 py-8">
        <Avatar src={profile.picture} name={name} className={`!h-24 !w-24 text-3xl ${call.status === 'ringing' || call.status === 'calling' ? 'animate-pulse' : ''}`} />
        <h2 className="mt-4 max-w-full truncate text-2xl font-bold tracking-tight text-white">{name}</h2>
        <p className="mt-1 text-[13px] text-blue-500">{status}</p>
        <div className="mt-8 flex items-center gap-4">
          {call.status === 'ringing' && call.direction === 'in' && (
            <button type="button" onClick={answer} className={`flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white active:bg-emerald-600 ${pressable}`} aria-label="Accept call"><Phone size={22} /></button>
          )}
          {call.status === 'active' && (
            <button type="button" onClick={toggleMute} className={`flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-[#111] text-white active:bg-white/10 ${pressable}`} aria-label={call.muted ? 'Unmute' : 'Mute'}>
              {call.muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
          )}
          {live && (
            <button type="button" onClick={decline} className={`flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white active:bg-red-700 ${pressable}`} aria-label={call.direction === 'in' && call.status !== 'active' ? 'Decline call' : 'End call'}><PhoneOff size={22} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
