import { MessageCircle } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Avatar from '../ui/Avatar';

export default function MessageRequests({ dms = {}, profiles = {}, onBack, onOpenChat }) {
  const requests = Object.entries(dms)
    .filter(([, messages]) => messages.some((message) => !message.isSender) && !messages.some((message) => message.isSender))
    .map(([pubkey, messages]) => ({
      pubkey,
      message: messages.filter((item) => !item.isSender).sort((a, b) => b.timestamp - a.timestamp)[0],
    }))
    .sort((a, b) => b.message.timestamp - a.message.timestamp);

  return (
    <div className="h-full overflow-y-auto bg-black pb-safe">
      <ScreenHeader title="Message Requests" onBack={onBack} />
      {requests.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <MessageCircle size={28} className="mx-auto text-white/30" />
          <h2 className="mt-3 text-[15px] font-semibold text-white">No message requests</h2>
          <p className="mt-1 text-[13px] text-white/40">New conversations you have not answered show up here.</p>
        </div>
      ) : (
        <div>
          {requests.map(({ pubkey, message }) => {
            const profile = profiles[pubkey] || {};
            const name = profile.displayName || profile.name || pubkey.slice(0, 12);
            return (
              <button type="button" key={pubkey} onClick={() => onOpenChat?.(pubkey)} className="flex w-full items-center gap-3 border-b border-white/5 px-4 py-3 text-left active:bg-white/10">
                <Avatar src={profile.picture} name={name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">{name}</span>
                  <span className="block truncate text-[13px] text-white/40">{message.data?.message || 'New message'}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
