<<<<<<< HEAD
import { pressable } from './Button';

// Local stand-in for the PR2 primitive (master-prompt §1: 44px minimum,
// mandatory aria-label). Written against the agreed interface, so the merge
// resolves to the real one with identical props.
export default function IconButton({ icon, label, onClick, className = '', type = 'button', ...props }) {
=======
import { useEffect } from 'react';

// 44px square tap target for one icon. The aria-label is part of the contract:
// a screen-reader user must get the same words the visual icon gives everyone
// else, and the label is what the click automation greps for.
export default function IconButton({ label, children, className = '', type = 'button', ...props }) {
  useEffect(() => {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.DEV && !label) {
      console.warn('[IconButton] aria-label is required — the tap target is 44px but the actor is invisible to screen readers.');
    }
  }, [label]);
>>>>>>> origin/feat/rebuild-pr2
  return (
    <button
      type={type}
      aria-label={label}
<<<<<<< HEAD
      onClick={onClick}
      className={`inline-flex touch-target items-center justify-center text-inkMuted hover:text-ink active:bg-ink/5 ${pressable} ${className}`}
      {...props}
    >
      {typeof icon === 'function' ? icon({ size: 20 }) : icon}
=======
      className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink ${className}`}
      {...props}
    >
      {children}
>>>>>>> origin/feat/rebuild-pr2
    </button>
  );
}
