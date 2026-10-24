import { db } from '../../db';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { useChatStore } from '../../store/chatStore';
import { copyToClipboard } from './media';

export function useMessageCommands({
  identity,
  sendReaction,
  pinMessage,
  sendGroupMessage,
  sendDM,
  handleOrderAction,
  startOrderWithVendor,
}) {
  const selectedMessage = useChatStore((s) => s.selectedMessage);
  const setSelectedMessage = useChatStore((s) => s.setSelectedMessage);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const setToast = useChatStore((s) => s.setToast);
  const profiles = useChatStore((s) => s.profiles);
  const activeGroup = useChatStore((s) => s.activeGroup);
  const activeDm = useChatStore((s) => s.activeDm);
  const setForwardingMsg = useChatStore((s) => s.setForwardingMsg);
  const setDms = useChatStore((s) => s.setDms);
  const setGroupMessages = useChatStore((s) => s.setGroupMessages);
  const setDeletedMsgs = useChatStore((s) => s.setDeletedMsgs);
  const setVendorStorefrontPubkey = useChatStore((s) => s.setVendorStorefrontPubkey);
  const setBroadcastProduct = useChatStore((s) => s.setBroadcastProduct);
  const setEditingProduct = useChatStore((s) => s.setEditingProduct);
  const forwardingMsg = useChatStore((s) => s.forwardingMsg);
  const dms = useChatStore((s) => s.dms);
  const groupMessages = useChatStore((s) => s.groupMessages);

  const handleMessageAction = async (action, secondArg = null) => {
    let msg;
    let emojiOverride = null;
    if (secondArg && typeof secondArg === 'object' && secondArg.id && secondArg.pubkey) {
      msg = secondArg;
    } else if (typeof secondArg === 'string') {
      emojiOverride = secondArg;
      msg = selectedMessage;
    } else {
      msg = selectedMessage;
    }
    if (!msg) return;

    if (action === 'react' && emojiOverride) {
      await sendReaction(msg.id, emojiOverride, !!activeGroup, activeGroup?.id, msg.pubkey);
      setSelectedMessage(null); return;
    }
    if (action === 'reply') { setReplyingTo(msg); setSelectedMessage(null); return; }
    if (action === 'copy') {
      copyToClipboard(msg.data?.message || msg.rawContent || msg.text || '');
      setToast({ type: 'success', message: 'Copied' });
      setSelectedMessage(null); return;
    }
    if (action === 'forward') {
      const senderName = profiles[msg.pubkey]?.displayName || profiles[msg.pubkey]?.name || (msg.pubkey === identity.pk ? 'You' : `User ${msg.pubkey.slice(0, 4)}`);
      setForwardingMsg({ data: msg.data || { type: 'text', message: msg.rawContent }, originalSenderName: senderName, id: msg.id });
      setSelectedMessage(null); return;
    }
    if (action === 'bookmark') {
      const chatId = activeDm || activeGroup?.id;
      if (chatId) {
        useChatStore.getState().toggleBookmark(chatId, msg.id);
        const isBm = useChatStore.getState().isBookmarked(chatId, msg.id);
        setToast({ type: 'success', message: isBm ? 'Saved' : 'Unsaved' });
      }
      setSelectedMessage(null); return;
    }
    if (action === 'select') {
      useChatStore.getState().toggleSelectionMode();
      useChatStore.getState().toggleSelectedMsg(msg.id);
      setSelectedMessage(null); return;
    }
    if (action === 'edit') {
      useChatStore.getState().openDialog({
        title: 'Edit Message', hasInput: true, inputDefault: msg.text || msg.data?.message || '',
        onConfirm: async (newText) => {
          if (!newText || newText === msg.text) return;
          useChatStore.getState().addMessageEdit(msg.id, { previousText: msg.text || msg.data?.message || '' });
          try {
            const original = await db.messages.get(msg.id);
            if (original) {
              const updated = { ...original, data: { ...original.data, message: newText, edited: true }, edited: true };
              await db.messages.put(updated);
              if (activeDm) setDms(prev => ({ ...prev, [activeDm]: (prev[activeDm] || []).map(m => m.id === msg.id ? updated : m) }));
              else if (activeGroup) setGroupMessages(prev => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || []).map(m => m.id === msg.id ? updated : m) }));
            }
          } catch (e) { console.error(e); }
        },
      });
      setSelectedMessage(null); return;
    }
    if (action === 'delete') {
      try {
        await db.messages.delete(msg.id);
        setDeletedMsgs(prev => new Set(prev).add(msg.id));
        if (msg.pubkey === identity.pk) {
          const { finalizeEvent } = await import('nostr-tools');
          const pool = await getAuthenticatedPool(identity);
          const deletionEvent = finalizeEvent({
            kind: 5,
            tags: [['e', msg.id]],
            content: 'Deleted',
          }, identity.sk);
          const results = await Promise.allSettled(pool.publish(generalRelays, deletionEvent));
          const published = results.some((result) => result.status === 'fulfilled');
          setToast({
            type: published ? 'success' : 'error',
            message: published ? 'Deleted for everyone' : 'Deleted locally; relay sync failed',
          });
        } else {
          setToast({ type: 'success', message: 'Deleted locally' });
        }
      } catch (e) {
        console.error('[Chat] Message deletion failed:', e);
        setToast({ type: 'error', message: 'Deleted locally; relay sync failed' });
      }
      setSelectedMessage(null); return;
    }
    if (action === 'pin' && activeGroup) {
      await pinMessage(activeGroup.id, msg.id);
      setToast({ type: 'success', message: 'Pinned' });
      setSelectedMessage(null); return;
    }
    if (action === 'report_scam' || action === 'report') {
      setToast({ type: 'success', message: 'Report submitted' });
      setSelectedMessage(null); return;
    }
    if (action === 'view_vendor') {
      setVendorStorefrontPubkey(msg.pubkey);
      setSelectedMessage(null); return;
    }
    if (action === 'buy_product') {
      setSelectedMessage(null);
      await startOrderWithVendor(msg.pubkey, msg.data || {}, msg.id);
      return;
    }
    if (action === 'broadcast_product') { setBroadcastProduct(msg.data); setSelectedMessage(null); return; }
    if (action === 'edit_product') { setEditingProduct({ msg, product: msg.data }); setSelectedMessage(null); return; }
    if (action === 'mark_sold_out') {
      try {
        const updatedPayload = { ...(msg.data || {}), soldOut: true };
        if (activeGroup) await sendGroupMessage(activeGroup.id, updatedPayload);
        setToast({ type: 'success', message: 'Marked sold out' });
      } catch (e) { setToast({ type: 'error', message: 'Failed' }); }
      setSelectedMessage(null); return;
    }
    // Order actions delegated to handleOrderAction
    if (await handleOrderAction(action, msg)) return;
    setSelectedMessage(null);
  };

  const handleForwardSubmit = async (targetId, isGroup) => {
    if (!forwardingMsg) return;
    const data = forwardingMsg.data || {};
    try {
      if (isGroup) await sendGroupMessage(targetId, data, null, null);
      else await sendDM(targetId, data, null, null);
      setToast({ type: 'success', message: 'Message forwarded!' });
      setForwardingMsg(null);
    } catch (e) {
      console.error('Forward failed:', e);
      setToast({ type: 'error', message: 'Failed to forward message' });
    }
  };
  const handleBulkForward = () => {
    const selectedIds = useChatStore.getState().selectedMsgs;
    if (selectedIds.length === 0) return;
    setToast({ type: 'info', message: 'Select a chat to forward ' + selectedIds.length + ' messages' });
    const firstId = selectedIds[0];
    const msgs = activeDm ? (dms[activeDm] || []) : (groupMessages[activeGroup?.id] || []);
    const msg = msgs.find(m => m.id === firstId);
    if (msg) {
      setForwardingMsg({ data: msg.data || { type: 'text', message: msg.rawContent }, originalSenderName: 'You', id: msg.id });
    }
    useChatStore.getState().clearSelection();
  };

  const handleBulkDelete = () => {
    const selectedIds = useChatStore.getState().selectedMsgs;
    if (selectedIds.length === 0) return;
    useChatStore.getState().openDialog({
      title: 'Delete Messages',
      message: `Delete ${selectedIds.length} message${selectedIds.length !== 1 ? 's' : ''}? This cannot be undone.`,
      type: 'danger', confirmText: 'Delete',
      onConfirm: async () => {
        const chatId = activeDm || activeGroup?.id;
        if (!chatId) return;
        for (const id of selectedIds) await db.messages.delete(id);
        useChatStore.getState().setDeletedMsgs(new Set([...useChatStore.getState().deletedMsgs, ...selectedIds]));
        useChatStore.getState().clearSelection();
        setToast({ type: 'success', message: 'Messages deleted' });
      },
    });
  };
  return { handleMessageAction, handleForwardSubmit, handleBulkForward, handleBulkDelete };
}
