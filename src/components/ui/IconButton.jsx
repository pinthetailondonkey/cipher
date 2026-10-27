import { pressable } from './Button';

// Local stand-in for the PR2 primitive (master-prompt §1: 44px minimum,
// mandatory aria-label). Written against the agreed interface, so the merge
// resolves to the real one with identical props.
export default function IconButton({ icon, label, onClick, className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex touch-target items-center justify-center text-inkMuted hover:text-ink active:bg-ink/5 ${pressable} ${className}`}
      {...props}
    >
      {typeof icon === 'function' ? icon({ size: 20 }) : icon}
    </button>
  );
}
