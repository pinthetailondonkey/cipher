import { motion } from 'framer-motion';
import { Delete } from 'lucide-react';
import { haptic } from '../../lib/haptics';

// The numeric keypad — 3x4, 64px keys, light haptic per press. Bottom-left is
// the biometric slot, bottom-right is erase, and a wrong turn shakes the
// whole block instead of flashing a separate error sign.
const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function Keypad({
  onDigit,
  onErase,
  onBiometric,
  biometricIcon = null,
  biometricLabel = 'Unlock with biometrics',
  disabled = false,
  error = false,
  shakeNonce = 0,
  className = '',
}) {
  return (
    <motion.div
      key={`${shakeNonce}-${error ? 'err' : 'ok'}`}
      animate={{ x: error || shakeNonce ? [0, -8, 8, -6, 6, -3, 0] : 0 }}
      transition={{ duration: 0.4 }}
      className={`mx-auto grid max-w-[280px] grid-cols-3 gap-2 ${className}`}
    >
      {KEYS.map((digit) => (
        <button
          key={digit}
          type="button"
          disabled={disabled}
          onClick={() => {
            haptic('light');
            onDigit?.(digit);
          }}
          className="flex h-16 w-full items-center justify-center rounded-2xl border border-line bg-panelStrong text-[22px] font-semibold text-ink transition-colors active:bg-ink/10"
        >
          {digit}
        </button>
      ))}
      <button
        type="button"
        aria-label={biometricLabel}
        disabled={disabled || !onBiometric}
        onClick={() => {
          haptic('light');
          onBiometric?.();
        }}
        className={`flex h-16 w-full items-center justify-center rounded-2xl text-accentText transition-colors active:bg-ink/10 ${onBiometric ? 'bg-ink/5' : 'bg-transparent'}`}
      >
        {biometricIcon}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          haptic('light');
          onDigit?.(0);
        }}
        className="flex h-16 w-full items-center justify-center rounded-2xl border border-line bg-panelStrong text-[22px] font-semibold text-ink transition-colors active:bg-ink/10"
      >
        0
      </button>
      <button
        type="button"
        aria-label="Erase"
        disabled={disabled}
        onClick={() => {
          haptic('light');
          onErase?.();
        }}
        className="flex h-16 w-full items-center justify-center rounded-2xl text-inkMuted transition-colors hover:text-ink active:bg-ink/10"
      >
        <Delete size={22} />
      </button>
    </motion.div>
  );
}
