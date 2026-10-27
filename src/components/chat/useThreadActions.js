import { useState } from 'react';
import { dmControlAction } from '../../hooks/useGroupKeyMember';
import { useChatStore } from '../../store/chatStore';

// What may leave the chat at all. dmControlAction already filters the
// protocol payloads (group keys, typing, read, pin, call marks) at every
// send path — respected here, plus the order family: an order_update that
// arrived nowhere is a claim, and a receipt belongs to one deal only, so
// orders never forward.
export function forwardableContent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (dmControlAction(payload)) return false;
  const type = String(payload.type || 'text');
  if (type.startsWith('order') || type === 'cipher_order') return false;
  return true;
}

// The payload a forward re-sends: same shape, no reply anchor, and a
// forwarded copy of a timed message stops its old clock.
export function forwardPayloadOf(msg) {
  let payload = null;
  if (msg?.data && typeof msg.data === 'object') payload = { ...msg.data };
  else if (typeof msg?.rawContent === 'string' && msg.rawContent.trim()) {
    try {
      const parsed = JSON.parse(msg.rawContent);
      if (parsed && typeof parsed === 'object') payload = { ...parsed };
      else payload = { type: 'text', message: String(parsed) };
    } catch {
      payload = { type: 'text', message: String(msg.rawContent) };
    }
  }
  if (!payload || !forwardableContent(payload)) return null;
  delete payload.expires_at;
  delete payload.receipt;
  return payload;
}

// Select mode + forward for one thread shell (DM and group share it).
// Forward goes through the existing sendDM actor only, with a fresh client
// id so a forwarded copy dedups as its own message on arrival.
export function useThreadActions({ handleMessageAction, sendDM }) {
  const setToast = useChatStore((s) => s.setToast);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [forwardOpen, setForwardOpen] = useState(false);

  const msgKey = (msg) => msg?.id || msg?.clientId || null;
  const isSelected = (msg) => selectedIds.includes(msgKey(msg));

  const toggleSelect = (msg) => {
    const key = msgKey(msg);
    if (!key) return;
    setSelectedIds((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  };

  const startSelect = (msg) => {
    setSelectMode(true);
    setSelectedIds(msg && msgKey(msg) ? [msgKey(msg)] : []);
  };

  const cancelSelect = () => {
    setSelectMode(false);
    setSelectedIds([]);
  };

  const deleteSelected = async (messagesById) => {
    const keys = selectedIds;
    cancelSelect();
    for (const key of keys) {
      const msg = messagesById?.get?.(key) || null;
      if (msg) await handleMessageAction('delete', { ...msg });
    }
  };

  const openForward = (msg, batch = null) => {
    // Pending group rows carry no payload yet; placeholders stay put.
    const list = batch || [msg];
    const payloads = (list || []).map((item) => forwardPayloadOf(item?.pending ? null : item)).filter(Boolean);
    if (!payloads.length) {
      setToast({ type: 'error', message: 'That can\'t be forwarded.' });
      return;
    }
    setForwardPayloadsCache(payloads);
    setForwardOpen(true);
  };

  const [forwardPayloads, setForwardPayloadsCache] = useState([]);

  const closeForward = () => setForwardOpen(false);

  const forwardTo = async (peer) => {
    const payloads = forwardPayloads;
    setForwardOpen(false);
    if (!peer || !sendDM?.call || !payloads.length) return;
    let sent = 0;
    for (const payload of payloads) {
      const clientId = `fwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await sendDM(peer, payload, clientId);
        if (result?.success || result?.queued) sent += 1;
      } catch (error) {
        console.error('[forward] Could not forward:', error);
      }
    }
    setToast(sent === payloads.length
      ? { type: 'success', message: sent > 1 ? `${sent} messages forwarded` : 'Forwarded' }
      : { type: 'error', message: 'Could not forward all of them.' });
  };

  // Menu router: the thread's own actions first, everything else walks the
  // existing message-command actor untouched.
  const wrapAction = (action, secondArg) => {
    if (action === 'forward') { openForward(secondArg); return; }
    if (action === 'select') { startSelect(secondArg); return; }
    handleMessageAction(action, secondArg);
  };

  return {
    selectMode,
    selectedIds,
    isSelected,
    toggleSelect,
    startSelect,
    cancelSelect,
    deleteSelected,
    forwardOpen,
    openForward,
    closeForward,
    forwardTo,
    forwardPayloads,
    wrapAction,
    msgKey,
  };
}
