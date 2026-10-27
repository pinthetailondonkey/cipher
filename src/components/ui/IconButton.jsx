import { useEffect } from 'react';

// 44px square tap target for one icon. The aria-label is part of the contract:
// a screen-reader user must get the same words the visual icon gives everyone
// else, and the label is what the click automation greps for. `icon` is the
// node form (icon={<X size={18} />}); children win when both are passed.
export default function IconButton({ label, icon, children, className = '', type = 'button', ...props }) {
  useEffect(() => {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.DEV && !label) {
      console.warn('[IconButton] aria-label is required — the tap target is 44px but the actor is invisible to screen readers.');
    }
  }, [label]);
  return (
    <button
      type={type}
      aria-label={label}
      className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink ${className}`}
      {...props}
    >
      {children !== null && children !== undefined ? children : icon}
    </button>
  );
}
