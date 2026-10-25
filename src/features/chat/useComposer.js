import { useEffect, useRef } from 'react';
import { db, saveMessage } from '../../db';
import { useChatStore } from '../../store/chatStore';
import { scopedRemove } from '../../lib/storage';
import { haptic } from '../../lib/haptics';
import { compressImage } from '../../lib/imageCompression';
import { sortMessages } from './media';
import { uploadPrivateMedia } from '../../lib/mediaCrypto';
import { blossomServers } from '../../lib/egress';

export function useComposer({ identity, sendDM, sendGroupMessage }) {
  const view = useChatStore((s) => s.view);
  const activeDm = useChatStore((s) => s.activeDm);
  const activeGroup = useChatStore((s) => s.activeGroup);
  const newMessage = useChatStore((s) => s.newMessage);
  const setNewMessage = useChatStore((s) => s.setNewMessage);
  const replyingTo = useChatStore((s) => s.replyingTo);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const setDms = useChatStore((s) => s.setDms);
  const setToast = useChatStore((s) => s.setToast);
  const setUploadingImage = useChatStore((s) => s.setUploadingImage);
  const isRecording = useChatStore((s) => s.isRecording);
  const setIsRecording = useChatStore((s) => s.setIsRecording);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const chatMountedRef = useRef(false);

  useEffect(() => {
    chatMountedRef.current = true;
    return () => {
      chatMountedRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorder.stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
    };
  }, []);

  const sendMessage = async (text, customPayload = null) => {
    if (!text.trim() && !customPayload) return;
    haptic('light');
    const tempId = `temp-${Date.now()}`;
    let msgPayload = customPayload || { type: 'text', message: text };
    const _chatIdForTimer = (view === 'dm' ? activeDm : activeGroup?.id);
    const _timerStr = useChatStore.getState().disappearingTimers?.[_chatIdForTimer];
    const _secs = (() => {
      if (!_timerStr || _timerStr === 'off') return 0;
      if (_timerStr.endsWith('m')) return parseInt(_timerStr) * 60 || 0;
      if (_timerStr === '1h') return 3600;
      if (_timerStr === '24h') return 86400;
      if (_timerStr === '7d') return 604800;
      return 0;
    })();
    if (_secs > 0 && !msgPayload.expires_at) msgPayload.expires_at = Math.floor(Date.now() / 1000) + _secs;
    const replyId = replyingTo ? replyingTo.id : null;
    const isDmView = view === 'dm';
    const chatId = isDmView ? activeDm : activeGroup?.id;
    const newMsg = {
      id: tempId, clientId: tempId, isSender: true, pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000), local_timestamp: Date.now(), replyTo: replyId,
      deliveryStatus: 'sending',
    };
    if (isDmView && activeDm) {
      newMsg.data = msgPayload;
      newMsg.isGroup = false;
      setDms(prev => {
        const messages = prev[activeDm] || [];
        if (messages.some((message) => message.id === tempId || message.clientId === tempId)) return prev;
        return { ...prev, [activeDm]: [...messages, newMsg].sort(sortMessages) };
      });
    } else if (activeGroup) {
      newMsg.rawContent = JSON.stringify(msgPayload);
      newMsg.isGroup = true;
      useChatStore.getState().setGroupMessages(prev => {
        const msgs = prev[activeGroup.id] || [];
        if (msgs.some((message) => message.id === tempId || message.clientId === tempId)) return prev;
        return { ...prev, [activeGroup.id]: [...msgs, newMsg] };
      });
      await saveMessage(activeGroup.id, newMsg);
      const result = await sendGroupMessage(activeGroup.id, msgPayload, tempId, replyId);
      if (!result.success) {
        if (result.error === 'NO_KEY') {
          const securing = { ...newMsg, deliveryStatus: 'securing', securingSince: Date.now(), pending: false };
          useChatStore.getState().setGroupMessages(prev => ({
            ...prev,
            [activeGroup.id]: (prev[activeGroup.id] || []).map((message) => (
              message.id === tempId || message.clientId === tempId ? securing : message
            )),
          }));
          await saveMessage(activeGroup.id, securing);
        } else {
          useChatStore.getState().setGroupMessages(prev => ({
            ...prev,
            [activeGroup.id]: (prev[activeGroup.id] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
          }));
          try {
            await db.messages.delete(tempId);
          } catch (error) {
            console.error('[Chat] Failed to remove unsent group message:', error);
          }
          setToast({ type: 'error', message: 'Failed to send to group' });
        }
      } else if (result.event?.id) {
        const outboxEntry = result.queued ? await db.outbox.get(result.event.id) : null;
        const deliveryStatus = result.queued && outboxEntry ? 'queued' : 'sent';
        let confirmedMessage;
        useChatStore.getState().setGroupMessages(prev => ({
          ...prev,
          [activeGroup.id]: (prev[activeGroup.id] || []).map((message) => {
            if (message.clientId !== tempId) return message;
            confirmedMessage = {
              ...message,
              id: result.event.id,
              timestamp: result.event.created_at,
              deliveryStatus,
            };
            return confirmedMessage;
          }),
        }));
        await saveMessage(activeGroup.id, confirmedMessage || {
          ...newMsg,
          id: result.event.id,
          timestamp: result.event.created_at,
          deliveryStatus,
        });
      }
    }
    if (isDmView && activeDm) await saveMessage(activeDm, newMsg);
    setReplyingTo(null);
    if (activeDm) scopedRemove(`draft-dm-${activeDm}`);
    if (activeGroup) scopedRemove(`draft-group-${activeGroup.id}`);
    if (activeDm) {
      const result = await sendDM(activeDm, msgPayload, tempId, replyId);
      if (!result.success) {
        setDms(prev => ({
          ...prev,
          [activeDm]: (prev[activeDm] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
        }));
        try {
          await db.messages.delete(tempId);
        } catch (error) {
          console.error('[Chat] Failed to remove unsent direct message:', error);
        }
        setToast({ type: 'error', message: 'Failed to send: ' + (result.error || 'unknown') });
      } else if (result.event?.id) {
        const outboxEntry = result.queued ? await db.outbox.get(result.event.id) : null;
        const deliveryStatus = result.queued && outboxEntry ? 'queued' : 'sent';
        let confirmedMessage;
        setDms(prev => ({
          ...prev,
          [activeDm]: (prev[activeDm] || []).map((message) => {
            if (message.clientId !== tempId) return message;
            confirmedMessage = {
              ...message,
              id: result.event.id,
              timestamp: result.event.created_at,
              deliveryStatus,
            };
            return confirmedMessage;
          }),
        }));
        await saveMessage(activeDm, confirmedMessage || {
          ...newMsg,
          id: result.event.id,
          timestamp: result.event.created_at,
          deliveryStatus,
        });
      }
    }
  };
  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingImage(true);
    const caption = newMessage;
    setNewMessage('');
    try {
      const media = [];
      for (const file of files) {
        const compressedFile = await compressImage(file);
        media.push(await uploadPrivateMedia(compressedFile, blossomServers()));
      }
      await sendMessage(caption, { type: 'album', media, message: caption });
      setToast({ type: 'success', message: media.length > 1 ? 'Album sent!' : 'Image sent!' });
    } catch (err) {
      console.error('[media] Encrypted photo upload failed:', err);
      setToast({ type: 'error', message: 'The photo was not sent. No media host took the encrypted file.' });
    } finally {
      setUploadingImage(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!chatMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.onstop = async () => {
        if (!chatMountedRef.current) return;
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([audioBlob], 'voice_note.webm', { type: 'audio/webm' });
        setUploadingImage(true);
        setToast({ type: 'success', message: 'Uploading voice note...' });
        try {
          const entry = await uploadPrivateMedia(file, blossomServers());
          await sendMessage('', { type: 'audio', ...entry });
          setToast({ type: 'success', message: 'Voice note sent!' });
        } catch (err) {
          console.error('[media] Encrypted voice upload failed:', err);
          setToast({ type: 'error', message: 'The voice note was not sent. No media host took the encrypted file.' });
        } finally {
          if (chatMountedRef.current) setUploadingImage(false);
        }
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      if (chatMountedRef.current) setToast({ type: 'error', message: 'Microphone access denied' });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      mediaRecorderRef.current = null;
      setIsRecording(false);
    }
  };
  return { sendMessage, handleImageUpload, startRecording, stopRecording };
}
