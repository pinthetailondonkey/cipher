import { MessageCircle } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Avatar from '../ui/Avatar';
import { noHexName } from '../../lib/npub';

export default function MessageRequests({ dms = {}, profiles = {}, onBack, onOpenChat }) {
  const requests = Object.entries(dms)
    .filter(([, messages]) => messages.some((message) => !message.isSender) && !messages.some((message) => message.isSender))
    .map(([pubkey, messages]) => ({
      pubkey,
      message: messages.filter((item) => !item.isSender).sort((a, b) => b.timestamp - a.timestamp)[0],
    }))
    .sort((a, b) => b.message.timestamp - a.message.timestamp);

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-safe">
      <ScreenHeader title="Message Requests" onBack={onBack} />
      {requests.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <MessageCircle size={28} className="mx-auto text-ink/30" />
          <h2 className="mt-3 text-[15px] font-semibold text-ink">No message requests</h2>
          <p className="mt-1 text-[13px] text-ink/40">New conversations you have not answered show up here.</p>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          {requests.map(({ pubkey, message }) => {
            const profile = profiles[pubkey] || {};
            const name = noHexName(profile, pubkey);
            return (
              <button type="button" key={pubkey} onClick={() => onOpenChat?.(pubkey)} className="flex w-full items-center gap-3 border-b border-ink/5 p-4 text-left last:border-0 active:bg-ink/5">
                <Avatar src={profile.picture} name={name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">{name}</span>
                  <span className="block truncate text-[13px] text-ink/40">{message.data?.message || 'New message'}</span>
                </span>
              </button>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}
