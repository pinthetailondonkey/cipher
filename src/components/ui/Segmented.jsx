<<<<<<< HEAD
import { pressable } from './Button';

// Local stand-in for the PR2 segmented filter: the three-pill row
// (All/Menus/Vendors, Shop/Groups per master-prompt §1).
export default function Segmented({ options = [], value, onChange, ariaLabel, className = '' }) {
  return (
    <div className={`flex gap-1 rounded-full bg-panel p-1 ${className}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
          className={`min-h-[36px] flex-1 rounded-full px-3 py-1.5 text-[13px] font-bold active:bg-ink/5 ${pressable} ${value === option.key ? 'bg-accent text-accentInk' : 'text-inkMuted'}`}
        >
          {option.label}
        </button>
      ))}
=======
import { haptic } from '../../lib/haptics';

// The pill filter row: the active segment wears the accent fill, the rest sit
// ink-muted on the panel. One row covers Shop/Groups and the later
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
      className={`flex rounded-2xl border border-line bg-panelStrong p-1 shadow-lg ${className}`}
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
              active ? 'bg-accent text-accentInk shadow-lg' : 'text-inkMuted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
>>>>>>> origin/feat/rebuild-pr2
    </div>
  );
}
