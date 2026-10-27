import { pressable } from './Button';

// Switch — one 44x26 track, accent when on (§1). role=switch so screen
// readers read state; 44px hit area around the visual track.
//
// API: <Switch checked onChange label? ariaLabel? disabled?>
export default function Switch({ checked, onChange, ariaLabel, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex h-[26px] w-11 shrink-0 touch-target items-center rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-accent' : 'bg-ink/15'} ${pressable}`}
    >
      <span
        aria-hidden="true"
        className={`absolute h-5 w-5 rounded-full bg-accentInk shadow transition-all ${checked ? 'left-[22px]' : 'left-[2px]'}`}
      />
    </button>
  );
}
