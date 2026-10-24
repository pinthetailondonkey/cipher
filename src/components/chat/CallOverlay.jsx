import { useEffect, useState, useSyncExternalStore } from 'react';
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { acceptCall, getCallSnapshot, hangup, subscribeCall, toggleMute } from '../../lib/voiceCall';
import { useChatStore } from '../../store/chatStore';

const EMPTY_PROFILE = {};

function formatDuration(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

export default function CallOverlay() {
  const call = useSyncExternalStore(subscribeCall, getCallSnapshot, getCallSnapshot);
  const profile = useChatStore((state) => (call?.peer ? state.profiles[call.peer] : undefined)) || EMPTY_PROFILE;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (call?.status !== 'active') return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [call?.status, call?.callId]);

  if (!call) return null;
  const name = profile.displayName || profile.name || call.name || 'Voice call';
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const status = {
    calling: 'Calling…',
    ringing: 'Incoming voice call',
    active: formatDuration(call.startedAt || Date.now()),
    declined: 'Call declined',
    busy: 'Busy',
    restricted: 'This person is not accepting calls',
    ended: 'Call ended',
  }[call.status] || 'Voice call';
  const live = call.status === 'calling' || call.status === 'ringing' || call.status === 'active';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 px-6 backdrop-blur-md">
      <div className="flex w-full max-w-sm flex-col items-center rounded-[28px] border border-white/10 bg-[#0A0A0A] px-6 py-8">
        {profile.picture ? (
          <img src={profile.picture} alt="" className={`h-24 w-24 rounded-full object-cover ${call.status === 'ringing' || call.status === 'calling' ? 'animate-pulse' : ''}`} />
        ) : (
          <div className={`flex h-24 w-24 items-center justify-center rounded-full bg-blue-600 text-3xl font-semibold text-white ${call.status === 'ringing' || call.status === 'calling' ? 'animate-pulse' : ''}`}>{initial}</div>
        )}
        <h2 className="mt-4 max-w-full truncate text-xl font-semibold text-white">{name}</h2>
        <p className="mt-1 text-sm text-blue-400">{status}</p>
        <div className="mt-8 flex items-center gap-4">
          {call.status === 'ringing' && call.direction === 'in' && (
            <button type="button" onClick={acceptCall} className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white" aria-label="Accept call"><Phone size={22} /></button>
          )}
          {call.status === 'active' && (
            <button type="button" onClick={toggleMute} className="flex h-14 w-14 items-center justify-center rounded-full bg-[#111] text-white" aria-label={call.muted ? 'Unmute' : 'Mute'}>
              {call.muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
          )}
          {live && (
            <button type="button" onClick={hangup} className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white" aria-label={call.status === 'ringing' && call.direction === 'in' ? 'Decline call' : 'End call'}><PhoneOff size={22} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
