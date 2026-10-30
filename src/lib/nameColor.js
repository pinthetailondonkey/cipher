// Sender-name palette — the one sanctioned hex exception in the rebuild
// (docs/MASTER-PROMPT.md §5). Group sender names tint by a stable hash of the
// author's pubkey. Every other color in the app comes from the token sheet in
// src/index.css; these four hexes live only here, for name colors on dark
// ground — each one is contrast-checked at 4.5:1 or better against #000.
// No amber, no yellow, nothing else reads from this file.
export const NAME_COLORS = ['#60a5fa', '#7dd3fc', '#67e8f9', '#5eead4'];

export function nameColorOf(pubkey = '') {
  const key = String(pubkey);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return NAME_COLORS[hash % NAME_COLORS.length];
}
