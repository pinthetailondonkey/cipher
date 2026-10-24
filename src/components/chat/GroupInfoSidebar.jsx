import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, Link2, LogOut, Pin, PinOff, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import Button from '../ui/Button';
import { pressable } from '../ui/Button';

const EMPTY_MESSAGES = [];

function messagePayload(message) {
  if (message.data) return message.data;
  try {
    return JSON.parse(message.rawContent || '');
  } catch {
    return null;
  }
}

export default function GroupInfoSidebar({
  isOpen,
  onClose,
  identity,
  fetchGroupMembers,
  fetchPinnedMessage,
  onPin,
  onUnpin,
  leaveGroup,
  kickMember,
  updateGroupSettings,
}) {
  const group = useChatStore((state) => state.activeGroup);
  const messages = useChatStore((state) => state.groupMessages[state.activeGroup?.id] || EMPTY_MESSAGES);
  const members = useChatStore((state) => state.groupMembers);
  const profiles = useChatStore((state) => state.profiles);
  const pinnedMessages = useChatStore((state) => state.pinnedMessages);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const memberList = Array.isArray(members) ? members : [];

  useEffect(() => {
    if (!group?.id) return undefined;
    let active = true;
    Promise.all([fetchGroupMembers?.(group.id), fetchPinnedMessage?.(group.id)])
      .catch((fetchError) => {
        console.error('[GroupInfoSidebar] Could not load group details:', fetchError);
        if (active) setError('Could not refresh group details.');
      });
    return () => { active = false; };
  }, [group?.id, fetchGroupMembers, fetchPinnedMessage]);

  const products = useMemo(() => messages
    .map((message) => ({ message, product: messagePayload(message) }))
    .filter(({ message, product }) => !message.pending && product?.type === 'product')
    .sort((a, b) => (b.message.timestamp || 0) - (a.message.timestamp || 0)), [messages]);
  const canManage = group?.creator === identity?.pk || memberList.some((member) => (
    member.pubkey === identity?.pk && ['admin', 'owner'].includes(member.role)
  ));
  const pinnedId = pinnedMessages[group?.id];

  const shareGroup = async () => {
    if (!group?.id) return;
    setError('');
    try {
      const { nip19 } = await import('nostr-tools');
      const creator = /^[0-9a-f]{64}$/i.test(group.creator || '') ? group.creator : (identity?.pk || '');
      const token = creator
        ? nip19.naddrEncode({ kind: 39000, pubkey: creator, identifier: group.id, relays: ['wss://groups.aegispayhq.com'] })
        : group.id;
      const link = `${window.location.origin}${window.location.pathname}?${String(token).startsWith('naddr') ? 'naddr' : 'group'}=${encodeURIComponent(token)}`;
      await navigator.clipboard.writeText(link);
      setCopied(true);
      useChatStore.getState().setToast({ type: 'success', message: 'Copied!' });
      window.setTimeout(() => setCopied(false), 1600);
    } catch (shareError) {
      console.error('[GroupInfoSidebar] Could not copy invite:', shareError);
      setError('Could not copy the invite link.');
    }
  };

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

  const editGroup = async () => {
    const nextName = window.prompt('Group name', group?.name || '');
    if (!nextName || !nextName.trim() || nextName.trim() === group?.name) return;
    setPending(true);
    setError('');
    try {
      await updateGroupSettings?.(group.id, { name: nextName.trim() });
      const current = useChatStore.getState().activeGroup;
      if (current?.id === group.id) useChatStore.getState().setActiveGroup({ ...current, name: nextName.trim() });
    } catch (editError) {
      console.error('[GroupInfoSidebar] Could not edit group:', editError);
      setError(editError?.message || 'Could not update the group.');
    } finally {
      setPending(false);
    }
  };

  const kick = async (pubkey) => {
    if (!window.confirm('Remove this member from the group?')) return;
    setPending(true);
    setError('');
    try {
      await kickMember?.(group.id, pubkey);
    } catch (kickError) {
      console.error('[GroupInfoSidebar] Could not kick member:', kickError);
      setError(kickError?.message || 'Could not remove that member.');
    } finally {
      setPending(false);
    }
  };

  const leave = async () => {
    if (!window.confirm('Leave this group?')) return;
    setPending(true);
    setError('');
    try {
      await leaveGroup?.(group.id);
      useChatStore.getState().closeChat();
      onClose?.();
    } catch (leaveError) {
      console.error('[GroupInfoSidebar] Could not leave group:', leaveError);
      setError(leaveError?.message || 'Could not leave the group.');
      setPending(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && group && (
        <motion.div
          className="fixed inset-0 z-[980] flex justify-end bg-black/70"
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={`${group.name || 'Group'} information`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.22 }}
            className="flex h-full w-full max-w-sm flex-col border-l border-white/10 bg-[#0A0A0A]"
          >
            <header className="flex items-center gap-3 border-b border-white/5 bg-[#0A0A0A] px-4 py-4">
              <Avatar src={group.picture} name={group.name || 'Group'} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-2xl font-bold tracking-tight text-white">{group.name || 'Group'}</h2>
                <p className="truncate text-[13px] text-white/40">{memberList.length || 1} members</p>
              </div>
              <button type="button" onClick={onClose} aria-label="Close group information" className={`p-2 text-white/45 hover:text-white ${pressable}`}><X size={20} /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto bg-[#0A0A0A] p-4">
              {group.about && <p className="mb-4 text-[13px] leading-relaxed text-white/40">{group.about}</p>}
              <div className="mb-4 flex flex-col gap-2">
                <Button onClick={shareGroup} className="flex w-full items-center justify-center gap-2">
                  <Link2 size={16} /> {copied ? 'Copied!' : 'Invite / Share Group'}
                </Button>
                {canManage && (
                  <Button variant="secondary" onClick={editGroup} disabled={pending} className="w-full">Edit group</Button>
                )}
                <Button variant="danger" onClick={leave} disabled={pending} className="flex w-full items-center justify-center gap-2"><LogOut size={16} /> Leave Group</Button>
              </div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Members</h3>
              <div className="mb-5 space-y-1">
                {memberList.length === 0 && <p className="rounded-xl bg-[#111] px-3 py-3 text-sm text-white/40">Looking up members…</p>}
                {memberList.map((member) => {
                  const profile = profiles[member.pubkey] || {};
                  const name = profile.displayName || profile.name || `${member.pubkey.slice(0, 8)}…`;
                  const role = member.role || (member.pubkey === group.creator ? 'admin' : 'member');
                  return (
                    <div key={member.pubkey} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#111] px-3 py-2">
                      <Avatar src={profile.picture} name={name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold text-white">{name}</p>
                        <p className="mt-0.5 text-[13px] text-blue-500">{role === 'admin' || role === 'owner' ? 'Admin' : 'Member'}</p>
                      </div>
                      {canManage && member.pubkey !== identity?.pk && (
                        <button type="button" onClick={() => kick(member.pubkey)} disabled={pending} aria-label={`Kick ${name}`} className={`rounded-2xl border border-white/10 px-3 py-2 text-[13px] font-semibold text-white/50 hover:text-red-300 disabled:opacity-50 ${pressable}`}>Kick</button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mb-4 rounded-xl border border-white/10 bg-[#111] p-4">
                <p className="text-sm font-semibold text-white">Pinned listing slot</p>
                <p className="mt-1 text-xs leading-relaxed text-white/45">Pin one product card to feature it at the top of the group chat.</p>
              </div>
              {pinnedId && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-3 text-xs font-semibold text-amber-200">
                  <BadgeCheck size={16} /> An endorsed listing is pinned
                  {canManage && <button type="button" onClick={removePin} disabled={pending} className="ml-auto flex items-center gap-1 text-amber-100/75 hover:text-white disabled:opacity-50"><PinOff size={14} /> Unpin</button>}
                </div>
              )}
              {error && <p role="alert" className="mb-3 rounded-lg bg-red-500/10 p-3 text-xs text-red-300">{error}</p>}
              <div className="space-y-2">
                {products.map(({ message, product }) => {
                  const isPinned = pinnedId === message.id;
                  return (
                    <article key={message.id} className={`rounded-xl border p-3 ${isPinned ? 'border-amber-400/30 bg-amber-400/[0.06]' : 'border-white/10 bg-[#111]'}`}>
                      <div className="flex items-center gap-3">
                        {product.image && <img src={product.image} alt="" loading="lazy" className="h-11 w-11 rounded-lg object-cover" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white">{product.title || product.name || 'Product'}</p>
                          <p className="truncate text-xs text-white/45">{product.price || product.priceUsd || ''} {product.currency || 'USD'}</p>
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
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
