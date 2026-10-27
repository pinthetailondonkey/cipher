import { db, deleteMessageForGood } from '../../db';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { useChatStore } from '../../store/chatStore';
import { copyText } from '../../lib/copyText';
import { haptic } from '../../lib/haptics';
import { retrySecuringGroup } from '../../hooks/useNIP29Group';

function readableText(msg) {
  const data = msg?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (typeof data?.message === 'string' && data.message.trim() && data.message !== 'Message unavailable') return data.message.trim();
  if (typeof data?.caption === 'string' && data.caption.trim()) return data.caption.trim();
  if (typeof data?.title === 'string' && data.title.trim()) return data.title.trim();
  if (typeof msg?.text === 'string' && msg.text.trim() && msg.text !== 'Message unavailable') return msg.text.trim();
  if (typeof msg?.rawContent === 'string' && msg.rawContent.trim() && !msg.rawContent.trim().startsWith('{')) return msg.rawContent.trim();
  try {
    const parsed = JSON.parse(msg?.rawContent || '');
    return parsed.message || parsed.caption || parsed.title || '';
  } catch {
    return '';
  }
}

export function useMessageCommands({
  identity,
  sendReaction,
  pinMessage,
  handleOrderAction,
  startOrderWithVendor,
}) {
  const selectedMessage = useChatStore((s) => s.selectedMessage);
  const setSelectedMessage = useChatStore((s) => s.setSelectedMessage);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const setToast = useChatStore((s) => s.setToast);
  const activeGroup = useChatStore((s) => s.activeGroup);
  const activeDm = useChatStore((s) => s.activeDm);
  const setDms = useChatStore((s) => s.setDms);
  const setGroupMessages = useChatStore((s) => s.setGroupMessages);
  const setVendorStorefrontPubkey = useChatStore((s) => s.setVendorStorefrontPubkey);
  const setBroadcastProduct = useChatStore((s) => s.setBroadcastProduct);
  const setEditingProduct = useChatStore((s) => s.setEditingProduct);

  const handleMessageAction = async (action, secondArg = null) => {
    let msg;
    let emojiOverride = null;
    if (secondArg && typeof secondArg === 'object' && secondArg.id) {
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
    if (action === 'retry_secure') {
      const groupId = activeGroup?.id || msg.chatId;
      if (!groupId) return;
      haptic('light');
      const since = Date.now();
      setGroupMessages((prev) => ({
        ...prev,
        [groupId]: (prev[groupId] || []).map((item) => (
          item.deliveryStatus === 'securing' ? { ...item, securingSince: since } : item
        )),
      }));
      try {
        await retrySecuringGroup(identity, groupId);
        setToast({ type: 'success', message: 'Retrying…' });
      } catch (error) {
        console.error('[group] retry failed:', error);
        setToast({ type: 'error', message: 'Could not retry.' });
      }
      setSelectedMessage(null);
      return;
    }
    if (action === 'reply') { setReplyingTo(msg); setSelectedMessage(null); return; }
    if (action === 'copy') {
      await copyText(readableText(msg));
      setSelectedMessage(null);
      return;
    }
    if (action === 'bookmark') {
      const chatId = activeDm || activeGroup?.id;
      if (!chatId || !msg.id) {
        setToast({ type: 'error', message: 'Could not save that message.' });
      } else {
        useChatStore.getState().toggleBookmark(chatId, msg.id);
        const isBm = useChatStore.getState().isBookmarked(chatId, msg.id);
        setToast({ type: 'success', message: isBm ? 'Saved' : 'Unsaved' });
      }
      setSelectedMessage(null);
      return;
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
    if (action === 'edit_history') {
      useChatStore.getState().setEditHistoryMsg(msg?.id || null);
      setSelectedMessage(null);
      return;
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
        if (!(await deleteMessageForGood(id, activeDm || activeGroup?.id))) {
          setToast({ type: 'error', message: 'Removed from the screen, but not from this device. It may come back after a refresh.' });
          return;
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
      try {
        await pinMessage(activeGroup.id, msg.id);
        setToast({ type: 'success', message: 'Pinned' });
      } catch (error) {
        // S9: the hook refuses a pin from a member; say so instead of a dead click.
        console.error('[Chat] Pin refused:', error);
        setToast({ type: 'error', message: error?.message || 'Could not pin that.' });
      }
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
    // Order actions delegated to handleOrderAction
    if (await handleOrderAction(action, msg)) return;
    setSelectedMessage(null);
  };

  return { handleMessageAction };
}
