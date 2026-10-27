import { useEffect, useRef } from 'react';

// Centered confirm for destructive + money moments. Variants: default /
// danger. role=dialog, aria-modal, Escape, focus trap and focus restore are
// owned here; the store-driven GlobalDialog keeps its own flow and can adopt
// this shell in place without its callers changing.
export default function Dialog({ open, onClose, label, heading, danger = false, children, className = '' }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-scrim/80 p-4" style={{ zIndex: 'var(--z-sheet)' }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label || heading || 'Dialog'}
        tabIndex={-1}
        className={`w-full max-w-sm rounded-3xl border border-line bg-panel p-6 outline-none ${danger ? 'ring-1 ring-danger/40' : ''} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
