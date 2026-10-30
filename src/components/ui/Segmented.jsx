import { haptic } from '../../lib/haptics';

// The one segment row (telegram-pass §7): 32px segments on a `--panel-strong`
// track, radius 8, the active segment in `--accent`. One row covers
// Menus/Groups and Orders' Incoming/Purchases — the segments are small and
// deliberately not a second tab bar, so no screen hand-rolls this anatomy
// again (MyOrders drops its own tablist). The pill is the 32px span; the
// button around it keeps the 44px hit target the shell's tap-target law
// measures, so a thumb still lands where it aims while the row stays slim.
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
      className={`flex rounded-lg border border-line bg-panelStrong ${className}`}
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
            className="flex min-h-11 flex-1 items-center justify-center p-1"
          >
            <span
              className={`flex h-8 w-full items-center justify-center rounded-lg px-3 text-[13px] font-bold transition-colors ${
                active ? 'bg-accent text-accentInk' : 'text-inkMuted hover:text-ink'
              }`}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
