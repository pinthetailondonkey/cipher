import { useEffect, useRef } from 'react';

// The Escape + focus-return floor for dialogs and sheet-class surfaces
// (MASTER-PROMPT §12): Escape closes, and focus returns to the control
// that opened the surface. Mount only in a component whose dialog body
// renders while `isOpen` is truthy; the hook remembers what had focus at
// open and hands it back on close.
export default function useDialogA11y(isOpen, onClose, panelRef = null) {
  const openerRef = useRef(null);
  const closeRef = useRef(onClose);
  // Keep the close callback fresh without re-listening: refs only move in
  // effects, never during render.
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    if (!isOpen) return undefined;
    openerRef.current = null;
    const opener = document.activeElement;
    if (opener instanceof HTMLElement) openerRef.current = opener;
    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const back = openerRef.current;
      openerRef.current = null;
      if (back && document.contains(back)) back.focus();
    };
  }, [isOpen, panelRef]);
}
