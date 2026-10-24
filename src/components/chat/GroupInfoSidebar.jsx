import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';
import { copyText } from '../../lib/copyText';

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
      const link = `${window.location.origin}${window.location.pathname}?g=${encodeURIComponent(group.id)}`;
      const ok = await copyText(link);
      if (!ok) return;
      setCopied(true);
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
            <div className="min-h-0 flex-1 overflow-y-auto bg-[#0A0A0A]">
              {group.about && <p className="border-b border-white/5 px-4 py-3 text-[13px] text-white/40">{group.about}</p>}
              <button type="button" onClick={shareGroup} className="w-full border-b border-white/5 px-4 py-4 text-left text-[15px] font-semibold text-blue-500 active:bg-white/10">{copied ? 'Copied' : 'Invite'}</button>
              {canManage && <button type="button" onClick={editGroup} disabled={pending} className="w-full border-b border-white/5 px-4 py-4 text-left text-[15px] font-semibold text-white disabled:opacity-40 active:bg-white/10">Edit group</button>}
              <button type="button" onClick={leave} disabled={pending} className="w-full border-b border-white/5 px-4 py-4 text-left text-[15px] font-semibold text-red-400 disabled:opacity-40 active:bg-white/10">Leave group</button>
              <p className="px-4 pb-1 pt-4 text-[13px] text-white/40">Members</p>
              <div className="mb-5">
                {memberList.length === 0 && <p className="border-b border-white/5 px-4 py-3 text-[13px] text-white/40">Looking up members…</p>}
                {memberList.map((member) => {
                  const profile = profiles[member.pubkey] || {};
                  const name = profile.displayName || profile.name || `${member.pubkey.slice(0, 8)}…`;
                  const role = member.role || (member.pubkey === group.creator ? 'admin' : 'member');
                  return (
                    <div key={member.pubkey} className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
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
              <p className="px-4 pb-1 pt-4 text-[13px] text-white/40">Shop</p>
              {pinnedId && (
                <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-[13px] text-amber-200">
                  <BadgeCheck size={16} /> Pinned
                  {canManage && <button type="button" onClick={removePin} disabled={pending} className="ml-auto text-blue-500 disabled:opacity-50">Unpin</button>}
                </div>
              )}
              {error && <p role="alert" className="px-4 py-3 text-[13px] text-red-400">{error}</p>}
              {products.length === 0 && <p className="border-b border-white/5 px-4 py-3 text-[13px] text-white/40">No listings yet.</p>}
              <div>
                {products.map(({ message, product }) => {
                  const isPinned = pinnedId === message.id;
                  return (
                    <div key={message.id} className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
                      {product.image && <img src={product.image} alt="" loading="lazy" className="h-10 w-10 object-cover" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold text-white">{product.title || product.name || 'Product'}</p>
                        <p className="truncate text-[13px] text-white/40">{product.price || product.priceUsd || ''}</p>
                      </div>
                      {canManage && (
                        <button type="button" onClick={() => isPinned ? removePin() : setPin(message.id)} disabled={pending || isPinned} className="text-[13px] font-semibold text-blue-500 disabled:opacity-40">{isPinned ? 'Pinned' : 'Pin'}</button>
                      )}
                    </div>
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
