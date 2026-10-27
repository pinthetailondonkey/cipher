// Tap a reply quote and the parent bubble scrolls to center and wears a
// 2 s glow ring (keyframe in thread.css, accent-soft). Honest fallback: no
// anchor — nothing happens rather than a wrong scroll.
export function jumpToMessage(id) {
  const anchor = typeof document !== 'undefined' && id ? document.getElementById(`msg-${id}`) : null;
  if (!anchor) return;
  let reduced = false;
  try {
    reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch { /* motion stays smooth */ }
  anchor.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  anchor.classList.remove('msg-jump');
  // Force a reflow so a repeat tap restarts the ring.
  void anchor.offsetWidth;
  anchor.classList.add('msg-jump');
  window.setTimeout(() => anchor.classList.remove('msg-jump'), 2000);
}
