import { haptic } from '../../lib/haptics';

// The pill filter row: the active segment wears the accent fill, the rest sit
// ink-muted on the panel. One row covers Menus/Groups and the later
// All/Menus/Vendors split — no screen hand-rolls this anatomy again.
export default function Segmented({
  options = [],
  value,
  onChange,
  ariaLabel,
  className = '',
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex rounded-2xl border border-line bg-panelStrong p-1 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              haptic('light');
              onChange?.(option.value);
            }}
            className={`min-h-[44px] flex-1 rounded-xl px-3 py-2 text-[13px] font-bold transition-colors ${
              active ? 'bg-accent text-accentInk' : 'text-inkMuted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
