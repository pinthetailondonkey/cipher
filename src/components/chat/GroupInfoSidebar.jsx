import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, Link2, LogOut, Package, Pencil, Store, UserPlus, Users, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import Picture from '../ui/Picture';
import { pressable } from '../ui/Button';
import { copyText } from '../../lib/copyText';
import { denyPendingJoin, dropPendingJoin, pendingJoinsFor, subscribeJoinRequests } from '../../lib/groupJoinQueue.js';

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
  approveJoin,
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
  const isOwner = group?.creator === identity?.pk;
  const [pendingJoins, setPendingJoins] = useState(() => (group?.id ? pendingJoinsFor(group.id) : []));

  useEffect(() => {
    if (!group?.id) return undefined;
    const refresh = () => setPendingJoins(pendingJoinsFor(group.id));
    refresh();
    return subscribeJoinRequests(refresh);
  }, [group?.id]);
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

  const editGroup = () => {
    useChatStore.getState().openDialog({
      title: 'Group name',
      hasInput: true,
      inputDefault: group?.name || '',
      inputRows: 1,
      confirmText: 'Save',
      onConfirm: async (nextName) => {
        if (!nextName || !nextName.trim() || nextName.trim() === group?.name) return;
        await updateGroupSettings?.(group.id, { name: nextName.trim() });
        const current = useChatStore.getState().activeGroup;
        if (current?.id === group.id) useChatStore.getState().setActiveGroup({ ...current, name: nextName.trim() });
      },
    });
  };

  const kick = (pubkey) => {
    useChatStore.getState().openDialog({
      title: 'Remove member',
      message: 'They will lose access to new messages.',
      type: 'danger',
      confirmText: 'Remove',
      onConfirm: () => kickMember?.(group.id, pubkey),
    });
  };

  const approvePending = async (row) => {
    if (!group?.id) return;
    setPending(true);
    setError('');
    try {
      await approveJoin?.(group.id, row.pubkey);
      dropPendingJoin(group.id, row.pubkey);
    } catch (approveError) {
      console.error('[GroupInfoSidebar] Could not approve the join request:', approveError);
      setError(approveError?.message || 'Could not approve the join request.');
    } finally {
      setPending(false);
    }
  };

  const denyPending = (row) => {
    if (!group?.id) return;
    useChatStore.getState().openDialog({
      title: 'Deny join request',
      message: 'They stay out of the group and never receive its key.',
      type: 'danger',
      confirmText: 'Deny',
      onConfirm: () => denyPendingJoin(group.id, row.pubkey),
    });
  };

  const leave = () => {
    useChatStore.getState().openDialog({
      title: 'Leave group',
      message: 'You can rejoin later with an invite.',
      type: 'danger',
      confirmText: 'Leave',
      onConfirm: async () => {
        await leaveGroup?.(group.id);
        useChatStore.getState().closeChat();
        onClose?.();
      },
    });
  };

  return (
    <AnimatePresence>
      {isOpen && group && (
        <motion.div
          className="fixed inset-0 z-[980] flex justify-end bg-black/50 backdrop-blur-sm"
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
            className="flex h-full w-full max-w-sm flex-col border-l border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl"
          >
            <header className="flex items-center gap-3 border-b border-white/5 bg-[#0A0A0A]/60 backdrop-blur-2xl px-4 py-4">
              <Avatar src={group.picture} name={group.name || 'Group'} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-2xl font-bold tracking-tight text-white">{group.name || 'Group'}</h2>
                <p className="truncate text-[13px] text-white/40">{memberList.length || 1} members</p>
              </div>
              <button type="button" onClick={onClose} aria-label="Close group information" className={`p-2 text-white/45 hover:text-white ${pressable}`}><X size={20} /></button>
            </header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[#0A0A0A]/60 backdrop-blur-2xl p-4">
              {group.about && <p className="rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4 text-[13px] text-white/50">{group.about}</p>}
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
                <button type="button" onClick={shareGroup} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left text-[15px] font-semibold text-white active:bg-white/5"><Link2 size={18} className="text-white/40" /> {copied ? 'Copied' : 'Invite'}</button>
                {canManage && <button type="button" onClick={editGroup} disabled={pending} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left text-[15px] font-semibold text-white disabled:opacity-40 active:bg-white/5"><Pencil size={18} className="text-white/40" /> Edit group</button>}
                <button type="button" onClick={leave} disabled={pending} className="flex w-full items-center gap-3 p-4 text-left text-[15px] font-semibold text-red-400 disabled:opacity-40 active:bg-white/5"><LogOut size={18} /> Leave group</button>
              </div>
              {isOwner && pendingJoins.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
                  <p className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-[13px] text-white/40"><UserPlus size={16} /> Join requests</p>
                  {pendingJoins.map((row) => {
                    const profile = profiles[row.pubkey] || {};
                    const name = profile.displayName || profile.name || `${row.pubkey.slice(0, 8)}…`;
                    return (
                      <div key={row.pubkey} className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0">
                        <Avatar src={profile.picture} name={name} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold text-white">{name}</span>
                          <span className="block truncate text-[13px] text-white/40">wants to join</span>
                        </span>
                        <button type="button" onClick={() => denyPending(row)} disabled={pending} className={`text-[13px] font-semibold text-white/60 disabled:opacity-50 ${pressable}`}>Deny</button>
                        <button type="button" onClick={() => approvePending(row)} disabled={pending} aria-label={`Approve ${name}`} className={`text-[13px] font-semibold text-blue-500 disabled:opacity-50 ${pressable}`}>Approve</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
                <p className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-[13px] text-white/40"><Users size={16} /> Members</p>
                {memberList.length === 0 && <p className="px-4 py-3 text-[13px] text-white/40">Looking up members…</p>}
                {memberList.map((member) => {
                  const profile = profiles[member.pubkey] || {};
                  const name = profile.displayName || profile.name || `${member.pubkey.slice(0, 8)}…`;
                  const role = member.role || (member.pubkey === group.creator ? 'admin' : 'member');
                  return (
                    <div key={member.pubkey} className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0">
                      <Avatar src={profile.picture} name={name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold text-white">{name}</p>
                        <p className="mt-0.5 text-[13px] text-blue-500">{role === 'admin' || role === 'owner' ? 'Admin' : 'Member'}</p>
                      </div>
                      {canManage && member.pubkey !== identity?.pk && (
                        <button type="button" onClick={() => kick(member.pubkey)} disabled={pending} aria-label={`Kick ${name}`} className={`text-[13px] font-semibold text-red-400 disabled:opacity-50 ${pressable}`}>Remove</button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
                <p className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-[13px] text-white/40"><Store size={16} /> Shop</p>
                {pinnedId && (
                  <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-[13px] text-amber-200">
                    <BadgeCheck size={16} /> Pinned
                    {canManage && <button type="button" onClick={removePin} disabled={pending} className="ml-auto text-blue-500 disabled:opacity-50">Unpin</button>}
                  </div>
                )}
                {error && <p role="alert" className="px-4 py-3 text-[13px] text-red-400">{error}</p>}
                {products.length === 0 && <p className="px-4 py-3 text-[13px] text-white/40">No listings yet.</p>}
                {products.map(({ message, product }) => {
                  const isPinned = pinnedId === message.id;
                  return (
                    <div key={message.id} className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0">
                      <Picture src={product.image} alt="" loading="lazy" className="h-10 w-10 rounded-xl object-cover" fallback={<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-black text-white/30"><Package size={16} /></span>} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold text-white">{product.title || product.name || 'Product'}</p>
                        <p className="truncate text-[13px] text-blue-500">{product.price || product.priceUsd || 'Ask'}</p>
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
