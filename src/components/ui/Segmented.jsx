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
    </div>
  );
}
