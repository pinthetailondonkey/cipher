import { db } from '../../db';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { useChatStore } from '../../store/chatStore';
import { copyText } from '../../lib/copyText';
import { haptic } from '../../lib/haptics';

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

    if (action === 'react') {
      const emoji = emojiOverride || msg.emoji;
      if (!emoji || !msg.id) return;
      try {
        haptic('light');
        await sendReaction(msg.id, emoji, !!activeGroup, activeGroup?.id, msg.pubkey);
      } catch (error) {
        console.error('[Chat] Reaction failed:', error);
        setToast({ type: 'error', message: 'Could not add that reaction.' });
      }
      setSelectedMessage(null);
      return;
    }
    if (action === 'reply') { setReplyingTo(msg); setSelectedMessage(null); return; }
    if (action === 'copy') {
      await copyText(msg.data?.message || msg.rawContent || msg.text || '');
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
      const id = msg.id;
      try {
        const state = useChatStore.getState();
        const current = state.deletedMsgs instanceof Set ? state.deletedMsgs : new Set();
        const nextDeleted = new Set(current);
        nextDeleted.add(id);
        state.setDeletedMsgs(nextDeleted);
        if (activeDm) setDms((prev) => ({ ...prev, [activeDm]: (prev[activeDm] || []).filter((item) => item.id !== id) }));
        else if (activeGroup?.id) setGroupMessages((prev) => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || []).filter((item) => item.id !== id) }));
        setSelectedMessage(null);
        try { await db.messages.delete(id); } catch (storageError) {
          console.error('[Chat] Local delete failed:', storageError);
        }
        if (msg.pubkey === identity?.pk && identity?.sk) {
          try {
            const { finalizeEvent } = await import('nostr-tools');
            const pool = await getAuthenticatedPool(identity);
            const deletionEvent = finalizeEvent({
              kind: 5,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['e', id]],
              content: '',
            }, identity.sk);
            const results = await Promise.allSettled(pool.publish(generalRelays, deletionEvent));
            const published = results.some((result) => result.status === 'fulfilled');
            setToast({ type: published ? 'success' : 'error', message: published ? 'Deleted' : 'Removed on this device. It could not sync.' });
          } catch (publishError) {
            console.error('[Chat] Delete sync failed:', publishError);
            setToast({ type: 'error', message: 'Removed on this device. It could not sync.' });
          }
        } else {
          setToast({ type: 'success', message: 'Removed' });
        }
      } catch (error) {
        console.error('[Chat] Message deletion failed:', error);
        setToast({ type: 'error', message: 'Could not delete that message.' });
        setSelectedMessage(null);
      }
      return;
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
    if (data.noforward) {
      setToast({ type: 'info', message: 'This message can’t be forwarded.' });
      setForwardingMsg(null);
      return;
    }
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
        const current = useChatStore.getState().deletedMsgs;
        const nextDeleted = new Set(current instanceof Set ? current : []);
        selectedIds.forEach((id) => nextDeleted.add(id));
        useChatStore.getState().setDeletedMsgs(nextDeleted);
        if (activeDm) setDms((prev) => ({ ...prev, [activeDm]: (prev[activeDm] || []).filter((item) => !selectedIds.includes(item.id)) }));
        else if (activeGroup?.id) setGroupMessages((prev) => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || []).filter((item) => !selectedIds.includes(item.id)) }));
        for (const id of selectedIds) {
          try { await db.messages.delete(id); } catch (error) { console.error('[Chat] Local delete failed:', error); }
        }
        useChatStore.getState().clearSelection();
        setToast({ type: 'success', message: 'Messages deleted' });
      },
    });
  };
  return { handleMessageAction, handleForwardSubmit, handleBulkForward, handleBulkDelete };
}
