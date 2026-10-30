import { haptic } from '../../lib/haptics';

// The outline pill — filter chips, the escrow fee chips. Selected wears the
// accent-soft wash; tappable chips tick the light haptic.
export default function Chip({ children, selected = false, onClick, className = '', ...rest }) {
  if (!onClick) {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-ink/5 px-3 py-1 text-[11px] font-semibold leading-4 text-inkMuted ${selected ? 'border-accent/40 bg-accentSoft text-accentText' : ''} ${className}`}
        {...rest}
      >
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-ink/5 px-3 py-1 text-[11px] font-semibold leading-4 text-inkMuted transition-colors active:bg-ink/10 ${selected ? 'border-accent/40 bg-accentSoft text-accentText' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
