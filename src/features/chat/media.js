export const copyToClipboard = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('[Clipboard] Modern API failed, trying fallback', err);
  }
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.error('[Clipboard] Fallback failed', err);
    return false;
  }
};

export const blossomSigner = (identity) => ({
  getPublicKey: async () => identity.pk,
  signEvent: async (event) => {
    const { finalizeEvent } = await import('nostr-tools');
    return finalizeEvent(event, identity.sk);
  },
});

export const sortMessages = (a, b) => {
  const timeA = a.local_timestamp || (a.timestamp * 1000);
  const timeB = b.local_timestamp || (b.timestamp * 1000);
  if (timeA !== timeB) return timeA - timeB;
  return (a.id || '').localeCompare(b.id || '');
};
