import { haptic } from './haptics';
import { useChatStore } from '../store/chatStore';

export async function writeClipboard(value) {
  const text = String(value ?? '');
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('[copy] Clipboard API failed:', error);
  }
  try {
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (error) {
    console.error('[copy] Clipboard fallback failed:', error);
    return false;
  }
}

export async function copyText(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    useChatStore.getState().setToast({ type: 'error', message: 'Nothing to copy.' });
    return false;
  }
  try {
    const ok = await writeClipboard(text);
    if (!ok) throw new Error('clipboard denied');
    haptic('light');
    useChatStore.getState().setToast({ type: 'success', message: 'Copied!' });
    return true;
  } catch (error) {
    console.error('[copy] Clipboard write failed:', error);
    useChatStore.getState().setToast({ type: 'error', message: 'Could not copy.' });
    return false;
  }
}
