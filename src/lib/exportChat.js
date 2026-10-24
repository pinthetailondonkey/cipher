export const exportChatAsText = (messages, chatName, profiles) => {
  const lines = [];
  lines.push('=== ' + chatName + ' ===');
  lines.push('Exported: ' + new Date().toLocaleString());
  lines.push('');
  
  messages.forEach(msg => {
    const date = new Date(msg.timestamp * 1000).toLocaleString();
    const sender = msg.isSender ? 'Me' : (profiles[msg.pubkey]?.displayName || msg.pubkey.slice(0, 8));
    let text = '';
    if (msg.rawContent) {
      try {
        const p = JSON.parse(msg.rawContent);
        text = p.message || `[${p.type}] ${p.title || p.url || ''}`;
      } catch { text = msg.rawContent; }
    } else if (msg.data) {
      text = msg.data.message || `[${msg.data.type}] ${msg.data.title || msg.data.url || ''}`;
    }
    lines.push(`[${date}] ${sender}: ${text}`);
  });
  
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${chatName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};