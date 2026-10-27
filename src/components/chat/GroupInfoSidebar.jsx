import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Heart, Link2, LogOut, Package, Pencil, ShieldCheck, ShoppingCart, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Picture from '../ui/Picture';
import Sheet from '../ui/Sheet';
import { MediaImage } from '../ui/PrivateMedia';
import { copyText } from '../../lib/copyText';
import { shortNpub, noHexName } from '../../lib/npub';
import { haptic } from '../../lib/haptics';
import { useVouchCount } from '../../hooks/useVouchCount';
import { useReputation } from '../../hooks/useReputation';
import { readPublicViews } from '../../lib/proofOfTrade';
import { attachmentsFor } from '../../lib/mediaCrypto';
import { denyPendingJoin, dropPendingJoin, pendingJoinsFor, subscribeJoinRequests, withoutDenied } from '../../lib/groupJoinQueue.js';
import { patchMemberSnapshot } from '../../lib/crypto/groupKeyRotation.js';

const EMPTY_MESSAGES = [];

function messagePayload(message) {
  if (message.data) return message.data;
  try {
    return JSON.parse(message.rawContent || '');
  } catch {
    return null;
  }
}

// Telegram's GroupInfo, on a Sheet. The component stays mount-safe for the
// future md+ docked pane: it renders into ui/Sheet and owns no layout of
// its own beyond the scroll body. Not a banner anywhere — starts right at
// the identity row. Every handler below is the pre-existing one.
function MemberRowAvatar({ profile, pubkey, name, size = 40, className = '' }) {
  return (
    <Avatar
      src={profile?.picture || profile?.avatar}
      name={name || shortNpub(pubkey)}
      size={size}
      className={className}
    />
  );
}

function MemberSheet({
  member,
  group,
  identity,
  profiles,
  canManage,
  pending,
  onClose,
  onKick,
}) {
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const profile = profiles[member.pubkey] || {};
  const name = noHexName(profile, member.pubkey);
  const isSelf = member.pubkey === identity?.pk;
  const role = member.role || (member.pubkey === group?.creator ? 'owner' : 'member');
  const { vouchCount, loading: vouchesLoading, hasVouched, refresh } = useVouchCount({ identity, targetPubkey: member.pubkey });
  const { sendVouch } = useReputation({ identity });

  const vouchFor = async () => {
    haptic('light');
    setSending(true);
    setError('');
    setNotice('');
    // S8: a vouch binds to the receipt hash of a trade with this person that
    // this device holds a public view of. Never been traded, no vouch.
    const traded = readPublicViews().find((view) => view?.hash && (
      view.vendor === member.pubkey || view.buyer === member.pubkey
    ));
    const result = await sendVouch(member.pubkey, traded?.hash || '', traded ? { vendor: traded.vendor, buyer: traded.buyer } : null);
    setSending(false);
    if (!result.success) {
      setError(result.error || 'Could not publish your vouch.');
      return;
    }
    setNotice(result.queued ? 'Your vouch is saved and will publish when connected.' : 'Your vouch was published.');
    refresh();
  };

  return (
    <Sheet open onClose={onClose} ariaLabel={`${name} in this group`}>
      <div className="flex items-center gap-3 px-4 py-4">
        <MemberRowAvatar profile={profile} pubkey={member.pubkey} name={name} size={52} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink">{name}</p>
          <p className="mono truncate text-[12px] text-inkSubtle">{shortNpub(member.pubkey, 16)}</p>
        </div>
        {role === 'owner' ? <Badge tone="soft"><ShieldCheck size={12} /> Owner</Badge> : role === 'admin' ? <Badge tone="soft">Admin</Badge> : null}
      </div>
      {vouchesLoading && <p className="px-4 pb-2 text-[13px] text-inkMuted">Checking vouches…</p>}
      {!vouchesLoading && (
        <button
          type="button"
          onClick={vouchFor}
          disabled={sending || hasVouched || isSelf}
          className="flex w-full items-center gap-3 border-t border-line px-4 py-4 text-left text-[15px] font-semibold text-accentText disabled:opacity-40"
        >
          <Heart size={18} />
          {hasVouched ? 'You vouched' : sending ? 'Publishing…' : `Vouch (${vouchCount})`}
        </button>
      )}
      {notice && <p role="status" className="px-4 pb-2 text-[13px] text-success">{notice}</p>}
      {error && <p role="alert" className="px-4 pb-2 text-[13px] text-danger">{error}</p>}
      {canManage && !isSelf && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onKick?.(member.pubkey);
          }}
          disabled={pending}
          className="flex w-full items-center gap-3 border-t border-line px-4 py-4 text-left text-[15px] font-semibold text-danger disabled:opacity-40"
        >
          <UserMinus size={18} /> Remove from group
        </button>
      )}
    </Sheet>
  );
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
  const [pickedMember, setPickedMember] = useState(null);
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

  const products = useMemo(() => messages
    .map((message) => ({ message, product: messagePayload(message) }))
    .filter(({ message, product }) => !message.pending && product?.type === 'product')
    .sort((a, b) => (b.message.timestamp || 0) - (a.message.timestamp || 0)), [messages]);

  // Shared media: every image or album attachment, newest first.
  const mediaStrip = useMemo(() => messages
    .map((message) => ({
      message,
      attachments: message.pending ? null : attachmentsFor(messagePayload(message)),
    }))
    .filter(({ message, attachments }) => message.id !== pinnedId && attachments?.items?.length > 0)
    .flatMap(({ message, attachments }) => attachments.items.map((item) => ({ key: `${message.id}-${item.entry?.url || ''}`, item })))
    .slice(-12), [messages, pinnedId]);

  const shareGroup = async () => {
    if (!group?.id) return;
    haptic('light');
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

  const addMember = () => {
    useChatStore.getState().openDialog({
      title: 'Add a member',
      message: 'Paste their npub. They get the next key the group sends.',
      hasInput: true,
      inputRows: 2,
      placeholder: 'npub1…',
      confirmText: 'Add',
      onConfirm: async (value) => {
        const raw = String(value || '').trim();
        let pubkey = '';
        if (/^[0-9a-f]{64}$/i.test(raw)) {
          pubkey = raw.toLowerCase();
        } else {
          try {
            const { nip19 } = await import('nostr-tools');
            const decoded = nip19.decode(raw);
            if (decoded.type !== 'npub') throw new Error('That is not an npub.');
            pubkey = decoded.data;
          } catch {
            throw new Error('Paste a valid npub to add.');
          }
        }
        if (!pubkey || pubkey === identity?.pk) throw new Error('Paste a different person\'s npub.');
        if (memberList.some((member) => member.pubkey === pubkey)) throw new Error('They are already in the group.');
        await approveJoin?.(group.id, pubkey);
      },
    });
  };

  const kick = (pubkey) => {
    setPickedMember(null);
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
      onConfirm: async () => {
        // H1 fix (round-three re-hack): denying also strips the peer from
        // the stored member snapshot on this account — a row that landed
        // before the deny must not survive to feed a grant or a rotation.
        const denied = denyPendingJoin(group.id, row.pubkey);
        if (denied) await patchMemberSnapshot(group.id, (rows) => withoutDenied(group.id, rows));
      },
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

  const pinnedProduct = products.find(({ message }) => message.id === pinnedId);
  const actionRow = (icon, label, onClick, { danger = false, ghost = false } = {}) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex w-full flex-col items-center gap-1.5 rounded-2xl border border-line bg-panelStrong px-2 py-3 text-[12px] font-semibold text-accentText ${ghost ? 'text-ink' : ''} ${danger ? 'text-danger' : ''}`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <Sheet
      open={isOpen && Boolean(group)}
      onClose={onClose}
      stretch={false}
      ariaLabel={`${group?.name || 'Group'} information`}
    >
      {/* The identity row. Name carries the 22px scale, the count is a chip. */}
      <div className="flex items-center gap-3 px-4 pb-3 pt-2">
        <Avatar src={group?.picture} name={group?.name || 'Group'} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[22px] font-bold tracking-tight text-ink">{group?.name || 'Group'}</h2>
          <Badge tone="outline" className="mt-1">
            <Users size={11} />
            {memberList.length || 1} {memberList.length === 1 ? 'member' : 'members'}
          </Badge>
        </div>
        <button type="button" onClick={onClose} aria-label="Close group information" className="touch-target flex items-center justify-center text-inkSubtle hover:text-ink">
          <X size={20} />
        </button>
      </div>

      {/* Action row: invite, add, leave — the three taps people open this for. */}
      <div className="grid grid-cols-3 gap-2 px-4 pb-3">
        {actionRow(<Link2 size={20} />, copied ? 'Copied' : 'Invite link', shareGroup)}
        {canManage && actionRow(<UserPlus size={20} />, 'Add member', addMember)}
        {canManage && actionRow(<Pencil size={20} />, 'Edit group', editGroup)}
        {actionRow(<LogOut size={20} />, 'Leave', leave, { danger: true })}
      </div>

      <div className="space-y-3 px-4 pb-4">
        {group?.about && <p className="rounded-2xl border border-line bg-panelStrong p-3 text-[13px] text-inkMuted">{group.about}</p>}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}

        {isOwner && pendingJoins.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-line bg-panelStrong">
            <p className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] text-inkMuted"><UserPlus size={15} /> Join requests</p>
            {pendingJoins.map((row) => {
              const profile = profiles[row.pubkey] || {};
              const name = noHexName(profile, row.pubkey);
              return (
                <div key={row.pubkey} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                  <MemberRowAvatar profile={profile} pubkey={row.pubkey} name={name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-ink">{name}</span>
                    <span className="block truncate text-[13px] text-inkMuted">wants to join</span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => denyPending(row)} disabled={pending}>Deny</Button>
                  <Button size="sm" onClick={() => approvePending(row)} disabled={pending} aria-label={`Approve ${name}`}>Approve</Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Members grid: 5-up avatars, role chips under admins and the owner. */}
        <div className="rounded-2xl border border-line bg-panelStrong p-3">
          <div className="grid grid-cols-5 gap-2">
            {memberList.map((member) => {
              const profile = profiles[member.pubkey] || {};
              const name = noHexName(profile, member.pubkey);
              const role = member.role || (member.pubkey === group?.creator ? 'owner' : 'member');
              return (
                <button
                  key={member.pubkey}
                  type="button"
                  onClick={() => setPickedMember(member)}
                  aria-label={`${name}${role === 'owner' ? ' — Owner' : role === 'admin' ? ' — Admin' : ''}`}
                  className="flex min-w-0 flex-col items-center gap-1 rounded-xl pt-1.5 pb-1 text-center active:bg-white/5"
                >
                  <MemberRowAvatar profile={profile} pubkey={member.pubkey} name={name} size={40} />
                  <span className="w-full truncate text-[11px] font-semibold text-inkMuted">{name}</span>
                  {(role === 'owner' || role === 'admin') && (
                    <Badge tone="soft" className="max-w-full">
                      {role === 'owner' ? <><ShieldCheck size={10} /> Owner</> : 'Admin'}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          {memberList.length === 0 && <p className="px-2 pb-2 text-[13px] text-inkMuted">Looking up members…</p>}
        </div>

        {/* Shared media strip: photos and album entries that crossed the chat. */}
        {mediaStrip.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-line bg-panelStrong">
            <p className="border-b border-line px-4 py-2.5 text-[13px] text-inkMuted">Shared media</p>
            <div className="flex gap-1.5 overflow-x-auto p-2">
              {mediaStrip.map((entry) => (
                <div key={entry.key} className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-panelAlt">
                  <MediaImage item={entry.item} className="h-16 w-16 object-cover" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pinned listing exposed as its own row; the rest of the products ride on. */}
        <div className="overflow-hidden rounded-2xl border border-line bg-panelStrong">
          <p className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] text-inkMuted"><ShoppingCart size={15} /> Products</p>
          {pinnedProduct && (
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <Picture src={pinnedProduct.product.image} alt="" loading="lazy" className="h-10 w-10 rounded-xl object-cover" fallback={<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-panelAlt text-inkSubtle"><Package size={16} /></span>} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-ink">{pinnedProduct.product.title || pinnedProduct.product.name || 'Item'}</p>
                <p className="mono truncate text-[13px] text-accentText">{pinnedProduct.product.price || pinnedProduct.product.priceUsd || 'Ask'}</p>
              </div>
              <Badge tone="soft"><BadgeCheck size={11} /> Pinned</Badge>
              {canManage && <Button size="sm" variant="ghost" onClick={removePin} disabled={pending}>Unpin</Button>}
            </div>
          )}
          {products.length === 0 && <p className="px-4 py-3 text-[13px] text-inkMuted">Nothing on the menu yet.</p>}
          {products.filter(({ message }) => message.id !== pinnedId).map(({ message, product }) => (
            <div key={message.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
              <Picture src={product.image} alt="" loading="lazy" className="h-10 w-10 rounded-xl object-cover" fallback={<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-panelAlt text-inkSubtle"><Package size={16} /></span>} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-ink">{product.title || product.name || 'Item'}</p>
                <p className="mono truncate text-[13px] text-accentText">{product.price || product.priceUsd || 'Ask'}</p>
              </div>
              {canManage && (
                <Button size="sm" variant="ghost" onClick={() => setPin(message.id)} disabled={pending}>Pin</Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {pickedMember && (
        <MemberSheet
          member={pickedMember}
          group={group}
          identity={identity}
          profiles={profiles}
          canManage={canManage}
          pending={pending}
          onClose={() => setPickedMember(null)}
          onKick={kick}
        />
      )}
    </Sheet>
  );
}
