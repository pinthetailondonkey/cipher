import { db, deleteMessageForGood, patchMessage } from '../../db';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { useChatStore } from '../../store/chatStore';
import { copyText } from '../../lib/copyText';
import { haptic } from '../../lib/haptics';
import { retrySecuringGroup } from '../../hooks/useNIP29Group';
import { assertSecurityContextOwner } from '../../lib/securityContextFence';

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
  const captureFence = () => {
    const fence = identity?.securityFence;
    assertSecurityContextOwner(fence, identity?.pk);
    return fence;
  };
  const assertCurrent = (fence) => assertSecurityContextOwner(fence, identity?.pk);

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
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      try {
        haptic('light');
        await sendReaction(msg.id, emoji, !!activeGroup, activeGroup?.id, msg.pubkey);
        assertCurrent(securityFence);
      } catch (error) {
        if (error?.code === 'SECURITY_CONTEXT_EXPIRED' || !securityFence.isCurrent()) return;
        console.error('[Chat] Reaction failed:', error);
        setToast({ type: 'error', message: 'Could not add that reaction.' });
      }
      assertCurrent(securityFence);
      setSelectedMessage(null);
      return;
    }
    if (action === 'retry_secure') {
      const groupId = activeGroup?.id || msg.chatId;
      if (!groupId) return;
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
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
        assertCurrent(securityFence);
        setToast({ type: 'success', message: 'Retrying…' });
      } catch (error) {
        if (error?.code === 'SECURITY_CONTEXT_EXPIRED' || !securityFence.isCurrent()) return;
        console.error('[group] retry failed:', error);
        setToast({ type: 'error', message: 'Could not retry.' });
      }
      assertCurrent(securityFence);
      setSelectedMessage(null);
      return;
    }
    if (action === 'reply') { setReplyingTo(msg); setSelectedMessage(null); return; }
    if (action === 'copy') {
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      await copyText(readableText(msg));
      assertCurrent(securityFence);
      setSelectedMessage(null);
      return;
    }
    if (action === 'bookmark') {
      const chatId = activeDm || activeGroup?.id;
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      if (!chatId || !msg.id) {
        assertCurrent(securityFence);
        setToast({ type: 'error', message: 'Could not save that message.' });
      } else {
        assertCurrent(securityFence);
        useChatStore.getState().toggleBookmark(chatId, msg.id);
        assertCurrent(securityFence);
        const isBm = useChatStore.getState().isBookmarked(chatId, msg.id);
        setToast({ type: 'success', message: isBm ? 'Saved' : 'Unsaved' });
      }
      assertCurrent(securityFence);
      setSelectedMessage(null);
      return;
    }
    if (action === 'edit_history') {
      // The stored record of what the message used to say. Timestamps are in
      // the reader's own locale; the text is shown as it was written, refused
      // or not, because the point of the row is that nothing is hidden.
      const edits = useChatStore.getState().messageEdits?.[msg.id] || [];
      if (!edits.length) {
        setSelectedMessage(null);
        return;
      }
      const lines = edits.map((entry) => {
        const when = Number(entry?.timestamp) > 0 ? new Date(Number(entry.timestamp)).toLocaleString() : '';
        const said = String(entry?.previousText || '').trim() || '(empty)';
        return when ? `${when} — ${said}` : said;
      });
      useChatStore.getState().openDialog({ title: `Edit history (${edits.length})`, message: lines.join('\n') });
      setSelectedMessage(null);
      return;
    }
    if (action === 'edit') {
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      useChatStore.getState().openDialog({
        title: 'Edit Message', hasInput: true, inputDefault: msg.text || msg.data?.message || '',
        onConfirm: async (newText) => {
          if (!newText || newText === msg.text) return;
          try { assertCurrent(securityFence); } catch { return; }
          useChatStore.getState().addMessageEdit(msg.id, { previousText: msg.text || msg.data?.message || '' });
          try {
            // A local patch, not a plain write: the next history fetch serves
            // the original text again and the patch is laid back over it.
            if (await patchMessage(msg.id, { message: newText, edited: true })) {
              assertCurrent(securityFence);
              const updated = await db.messages.get(msg.id);
              assertCurrent(securityFence);
              if (activeDm) setDms(prev => ({ ...prev, [activeDm]: (prev[activeDm] || []).map(m => m.id === msg.id ? updated : m) }));
              else if (activeGroup) setGroupMessages(prev => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || []).map(m => m.id === msg.id ? updated : m) }));
            }
          } catch (e) { if (e?.code !== 'SECURITY_CONTEXT_EXPIRED' && securityFence.isCurrent()) console.error(e); }
        },
      });
      setSelectedMessage(null); return;
    }
    if (action === 'delete') {
      const id = msg.id;
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      try {
        assertCurrent(securityFence);
        const state = useChatStore.getState();
        const current = state.deletedMsgs instanceof Set ? state.deletedMsgs : new Set();
        const nextDeleted = new Set(current);
        nextDeleted.add(id);
        state.setDeletedMsgs(nextDeleted);
        if (activeDm) setDms((prev) => ({ ...prev, [activeDm]: (prev[activeDm] || []).filter((item) => item.id !== id) }));
        else if (activeGroup?.id) setGroupMessages((prev) => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || []).filter((item) => item.id !== id) }));
        setSelectedMessage(null);
        if (!(await deleteMessageForGood(id, activeDm || activeGroup?.id))) {
          assertCurrent(securityFence);
          setToast({ type: 'error', message: 'Removed from the screen, but not from this device. It may come back after a refresh.' });
          return;
        }
        assertCurrent(securityFence);
        if (msg.pubkey === identity?.pk && identity?.sk) {
          try {
            const { finalizeEvent } = await import('nostr-tools');
            assertCurrent(securityFence);
            const pool = await getAuthenticatedPool(identity);
            assertCurrent(securityFence);
            const deletionEvent = finalizeEvent({
              kind: 5,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['e', id]],
              content: '',
            }, identity.sk);
            const results = await Promise.allSettled(pool.publish(generalRelays, deletionEvent));
            assertCurrent(securityFence);
            const published = results.some((result) => result.status === 'fulfilled');
            setToast({ type: published ? 'success' : 'error', message: published ? 'Deleted' : 'Removed on this device. It could not sync.' });
          } catch (publishError) {
            if (publishError?.code === 'SECURITY_CONTEXT_EXPIRED' || !securityFence.isCurrent()) return;
            console.error('[Chat] Delete sync failed:', publishError);
            setToast({ type: 'error', message: 'Removed on this device. It could not sync.' });
          }
        } else {
          setToast({ type: 'success', message: 'Removed' });
        }
      } catch (error) {
        if (error?.code === 'SECURITY_CONTEXT_EXPIRED' || !securityFence.isCurrent()) return;
        console.error('[Chat] Message deletion failed:', error);
        setToast({ type: 'error', message: 'Could not delete that message.' });
        setSelectedMessage(null);
      }
      return;
    }
    if (action === 'pin' && activeGroup) {
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      try {
        await pinMessage(activeGroup.id, msg.id);
        assertCurrent(securityFence);
        setToast({ type: 'success', message: 'Pinned' });
      } catch (error) {
        if (error?.code === 'SECURITY_CONTEXT_EXPIRED' || !securityFence.isCurrent()) return;
        // S9: the hook refuses a pin from a member; say so instead of a dead click.
        console.error('[Chat] Pin refused:', error);
        setToast({ type: 'error', message: error?.message || 'Could not pin that.' });
      }
      assertCurrent(securityFence);
      setSelectedMessage(null); return;
    }
    if (action === 'view_vendor') {
      setVendorStorefrontPubkey(msg.pubkey);
      setSelectedMessage(null); return;
    }
    if (action === 'buy_product') {
      let securityFence;
      try { securityFence = captureFence(); } catch { return; }
      setSelectedMessage(null);
      await startOrderWithVendor(msg.pubkey, msg.data || {}, msg.id);
      assertCurrent(securityFence);
      return;
    }
    if (action === 'broadcast_product') { setBroadcastProduct(msg.data); setSelectedMessage(null); return; }
    if (action === 'edit_product') { setEditingProduct({ msg, product: msg.data }); setSelectedMessage(null); return; }
    // Order actions delegated to handleOrderAction
    let securityFence;
    try { securityFence = captureFence(); } catch { return; }
    try {
      const handled = await handleOrderAction(action, msg);
      assertCurrent(securityFence);
      if (handled) return;
    } catch (error) {
      if (error?.code === 'SECURITY_CONTEXT_EXPIRED' || !securityFence.isCurrent()) return;
      throw error;
    }
    setSelectedMessage(null);
  };

  return { handleMessageAction };
}
