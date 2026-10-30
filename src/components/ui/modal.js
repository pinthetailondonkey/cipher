import { useEffect, useRef } from 'react';

// Shared modal reachability: Escape closes, Tab stays inside the panel, and
// the focus that existed before the surface opened is handed back when it
// unwinds. Every sheet and dialog mounts this once — nothing else needed.
export function useModalA11y(open, onClose) {
  const panelRef = useRef(null);

  // The close callback reaches the listener through a ref so the focus
  // effect runs for the life of the surface, not once per caller render.
  // With onClose in that effect's deps, every keystroke in a modal's input
  // re-ran the effect, and its panel.focus() pulled focus off the input —
  // one character, then the mobile keyboard was gone (live 2026-10-30).
  // Same pattern as dialogA11y.js: refs only move in effects, never render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusables = panel.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open]);

  return panelRef;
}
