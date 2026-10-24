import { ArrowLeft, MessageCircle, User } from 'lucide-react';

export default function MessageRequests({ dms = {}, profiles = {}, onBack, onOpenChat }) {
  const requests = Object.entries(dms)
    .filter(([, messages]) => messages.some((message) => !message.isSender) && !messages.some((message) => message.isSender))
    .map(([pubkey, messages]) => ({
      pubkey,
      message: messages.filter((item) => !item.isSender).sort((a, b) => b.timestamp - a.timestamp)[0],
    }))
    .sort((a, b) => b.message.timestamp - a.message.timestamp);

  return (
    <div className="h-full overflow-y-auto pb-safe">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/5 bg-black/90 px-4 py-4 backdrop-blur-xl">
        <button type="button" onClick={onBack} className="touch-target -ml-2 p-2 text-white/50 hover:text-white" aria-label="Back to profile"><ArrowLeft size={20} /></button>
        <div>
          <h1 className="text-xl font-bold text-white">Message Requests</h1>
          <p className="text-[13px] text-white/40">Messages from people you haven’t replied to</p>
        </div>
      </header>
      {requests.length === 0 ? (
        <div className="flex flex-col items-center px-8 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-[#111] text-white/45"><MessageCircle size={24} /></span>
          <h2 className="mt-4 text-base font-semibold text-white">No message requests</h2>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-white/45">New conversations from people you haven’t replied to will show up here.</p>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {requests.map(({ pubkey, message }) => {
            const profile = profiles[pubkey] || {};
            const preview = message.data?.message || message.rawContent || 'New message';
            return (
              <button type="button" key={pubkey} onClick={() => onOpenChat?.(pubkey)} className="flex min-h-[80px] w-full items-center gap-3 px-4 py-4 text-left hover:bg-white/5">
                {profile.picture ? <img src={profile.picture} alt="" loading="lazy" className="h-11 w-11 shrink-0 rounded-full object-cover" /> : <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#111] text-white/45"><User size={18} /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">{profile.displayName || profile.name || pubkey.slice(0, 12)}</span>
                  <span className="mt-1 block truncate text-xs text-white/45">{preview}</span>
                </span>
                <span className="shrink-0 rounded-full bg-blue-600/15 px-3 py-1.5 text-xs font-semibold text-blue-400">Review</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
