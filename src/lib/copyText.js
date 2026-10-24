import { haptic } from './haptics';
import { useChatStore } from '../store/chatStore';

export async function copyText(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    useChatStore.getState().setToast({ type: 'error', message: 'Nothing to copy.' });
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    haptic('light');
    useChatStore.getState().setToast({ type: 'success', message: 'Copied!' });
    return true;
  } catch (error) {
    console.error('[copy] Clipboard write failed:', error);
    useChatStore.getState().setToast({ type: 'error', message: 'Could not copy.' });
    return false;
  }
}
