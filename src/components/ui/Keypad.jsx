import React from 'react';
import { Delete, Fingerprint } from 'lucide-react';
import { haptic } from '../../lib/haptics';

// The numeric keypad (MASTER-PROMPT §1 / §10): 3×4 numeric, 64px keys,
// haptic light per press, eraser bottom-right, optional biometric checkmark
// bottom-left, eight dots above the grid. The lock screen (PR10) owns the
// visual dressing; this keeps the floor priced once.
export default function Keypad({
  value = '',
  onDigit,
  onErase,
  onBiometric,
  max = 8,
  disabled = false,
  className = '',
}) {
  const count = String(value ?? '').replace(/\D/g, '').length;

  const press = (digit) => {
    if (disabled || String(value ?? '').replace(/\D/g, '').length >= max) return;
    haptic('light');
    onDigit?.(digit);
  };

  const erase = () => {
    if (disabled) return;
    haptic('light');
    onErase?.();
  };

  const key = (digit) => (
    <button
      key={digit}
      type="button"
      disabled={disabled}
      aria-label={`${digit}`}
      onClick={() => press(digit)}
      className="flex h-16 min-h-[44px] w-full items-center justify-center rounded-2xl border border-line bg-panelStrong text-xl font-semibold text-ink active:bg-ink/10 disabled:opacity-40"
    >
      {digit}
    </button>
  );

  return (
    <div className={`w-full flex flex-col items-center gap-4 ${className}`}>
      <div role="group" aria-label="PIN digits entered" className="flex items-center gap-3">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            data-dot=""
            data-filled={i < count ? 'true' : 'false'}
            aria-hidden="true"
            className={`h-3 w-3 rounded-full border border-ink/30 transition-colors ${i < count ? 'border-accent bg-accent' : 'bg-transparent'}`}
          />
        ))}
      </div>
      <div role="group" aria-label="Number pad" className="grid w-full max-w-[300px] grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => key(digit))}
        {onBiometric ? (
          <button
            type="button"
            onClick={onBiometric}
            disabled={disabled}
            aria-label="Unlock with biometrics"
            className="flex h-16 min-h-[44px] w-full items-center justify-center rounded-2xl text-inkSubtle active:bg-ink/5"
          >
            <Fingerprint size={24} />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        {key('0')}
        <button
          type="button"
          disabled={disabled}
          aria-label="Erase last digit"
          onClick={erase}
          className="flex h-16 min-h-[44px] w-full items-center justify-center rounded-2xl text-inkSubtle active:bg-ink/5"
        >
          <Delete size={22} />
        </button>
      </div>
    </div>
  );
}
