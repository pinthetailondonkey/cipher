import { haptic } from '../../lib/haptics';

// One 44x26 track; on wears the accent. role=switch plus ariaLabel so the
// state change is announced and named; an invisible reach span stretches the
// tap target to 44x44 without drawing anything.
export default function Switch({ checked = false, onChange, disabled = false, ariaLabel, className = '' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        haptic('light');
        onChange?.(!checked);
      }}
      className={`relative h-[26px] w-11 shrink-0 rounded-full border transition-colors ${
        checked ? 'border-transparent bg-accent' : 'border-line bg-ink/15'
      } ${disabled ? 'opacity-40' : ''} ${className}`}
    >
      <span aria-hidden="true" className="absolute inset-x-0 -top-[9px] -bottom-[9px]" />
      <span
        aria-hidden="true"
        className={`absolute left-[2px] top-1/2 h-[22px] w-[22px] -translate-y-1/2 rounded-full bg-ink shadow transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : ''
        }`}
      />
    </button>
  );
}
