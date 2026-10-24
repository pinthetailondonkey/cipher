import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Pin, PinOff, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

const EMPTY_MESSAGES = [];

function messagePayload(message) {
  if (message.data) return message.data;
  try {
    return JSON.parse(message.rawContent || '');
  } catch {
    return null;
  }
}

export default function GroupInfoSidebar({ isOpen, onClose, identity, fetchGroupMembers, fetchPinnedMessage, onPin, onUnpin }) {
  const group = useChatStore((state) => state.activeGroup);
  const messages = useChatStore((state) => state.groupMessages[state.activeGroup?.id] || EMPTY_MESSAGES);
  const members = useChatStore((state) => state.groupMembers);
  const pinnedMessages = useChatStore((state) => state.pinnedMessages);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !group?.id) return;
    let active = true;
    Promise.all([fetchGroupMembers?.(group.id), fetchPinnedMessage?.(group.id)])
      .catch((fetchError) => {
        console.error('[GroupInfoSidebar] Could not load group details:', fetchError);
        if (active) setError('Could not refresh group details.');
      });
    return () => { active = false; };
  }, [isOpen, group?.id, fetchGroupMembers, fetchPinnedMessage]);

  const products = useMemo(() => messages
    .map((message) => ({ message, product: messagePayload(message) }))
    .filter(({ message, product }) => !message.pending && product?.type === 'product')
    .sort((a, b) => (b.message.timestamp || 0) - (a.message.timestamp || 0)), [messages]);
  const canManage = group?.creator === identity?.pk || members.some((member) => (
    member.pubkey === identity?.pk && ['admin', 'owner'].includes(member.role)
  ));
  const pinnedId = pinnedMessages[group?.id];

  if (!isOpen || !group) return null;

  const setPin = async (messageId) => {
    setPending(true);
    setError('');
    try {
      await onPin(group.id, messageId);
    } catch (pinError) {
      console.error('[GroupInfoSidebar] Could not pin listing:', pinError);
      setError(pinError?.message || 'Could not pin this listing.');
    } finally {
      setPending(false);
    }
  };

  const removePin = async () => {
    setPending(true);
    setError('');
    try {
      await onUnpin(group.id);
    } catch (unpinError) {
      console.error('[GroupInfoSidebar] Could not unpin listing:', unpinError);
      setError(unpinError?.message || 'Could not remove the pinned listing.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[980] flex justify-end bg-black/70 backdrop-blur-sm" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside role="dialog" aria-modal="true" aria-label={`${group.name || 'Group'} information`} className="flex h-full w-full max-w-sm flex-col border-l border-white/10 bg-[#0A0A0A]">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-white">{group.name || 'Group information'}</h2>
            <p className="truncate text-xs text-white/40">{group.id}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close group information" className="p-2 text-white/45 hover:text-white"><X size={20} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-semibold text-white">Pinned listing slot</p>
            <p className="mt-1 text-xs leading-relaxed text-white/45">Pin one product card to feature it at the top of the group chat. Group admins can replace or remove it.</p>
            {!canManage && <p className="mt-3 text-xs text-white/35">Only group admins can manage the pinned listing.</p>}
          </div>
          {pinnedId && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-3 text-xs font-semibold text-amber-200">
              <BadgeCheck size={16} /> An endorsed listing is pinned
              {canManage && <button type="button" onClick={removePin} disabled={pending} className="ml-auto flex items-center gap-1 text-amber-100/75 hover:text-white disabled:opacity-50"><PinOff size={14} /> Unpin</button>}
            </div>
          )}
          {error && <p role="alert" className="mb-3 rounded-lg bg-red-500/10 p-3 text-xs text-red-300">{error}</p>}
          {products.length === 0 && <p className="py-8 text-center text-sm text-white/40">No product cards are available in this group yet.</p>}
          <div className="space-y-2">
            {products.map(({ message, product }) => {
              const isPinned = pinnedId === message.id;
              return (
                <article key={message.id} className={`rounded-xl border p-3 ${isPinned ? 'border-amber-400/30 bg-amber-400/[0.06]' : 'border-white/10 bg-white/[0.03]'}`}>
                  <div className="flex items-center gap-3">
                    {product.image && <img src={product.image} alt="" loading="lazy" className="h-11 w-11 rounded-lg object-cover" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">{product.title || product.name || 'Product'}</p>
                      <p className="truncate text-xs text-white/45">{product.price || product.priceUsd || ''} {product.currency || 'USD'}</p>
                      <p className="mt-0.5 text-[10px] text-white/35">Vendor {message.pubkey?.slice(0, 8)}</p>
                    </div>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => isPinned ? removePin() : setPin(message.id)}
                        disabled={pending || isPinned}
                        aria-label={isPinned ? 'Listing is pinned' : 'Pin listing'}
                        className="rounded-lg border border-white/10 p-2 text-white/70 hover:border-amber-300/40 hover:text-amber-200 disabled:opacity-50"
                      >
                        {isPinned ? <BadgeCheck size={16} /> : <Pin size={16} />}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
