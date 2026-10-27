import { pressable } from './Button';

// PR2 ui primitive, local stub (merge composes). IconButton: a square
// touch target, 44px min, aria-label is mandatory — never a bare icon.
export default function IconButton({ icon: Icon = null, label = '', size = 20, className = '', children = null, ...props }) {
  return (
    <button type="button" aria-label={props['aria-label'] || label} className={`touch-target flex shrink-0 items-center justify-center rounded-full ${pressable} ${className}`} {...props}>
      {children !== null ? children : Icon ? <Icon size={size} /> : null}
    </button>
  );
}
