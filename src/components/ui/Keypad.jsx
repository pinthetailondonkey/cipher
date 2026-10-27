import { motion } from 'framer-motion';
import { Delete, Fingerprint } from 'lucide-react';
import { haptic } from '../../lib/haptics';
import { pressable } from './Button';

// Keypad — 3x4 numeric, 64px keys, haptic('light') per press, shake row on
// error, biometric circle bottom-left, erase bottom-right (§1, §10). Renders
// the PIN dots row itself: one dot per slot, filled by the current value.
//
// API: <Keypad value maxLength=8 onChange shake=0 showBiometric onBiometric
//               biometricDisabled disabled>
//   value       current PIN string
//   maxLength   dot slots (Cipher PINs are 8)
//   onChange    (next) => void — appended digit or erased char
//   shake       number — bump on every wrong attempt to replay the shake
//   showBiometric/onBiometric — the bottom-left passkey circle
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export default function Keypad({
  value,
  maxLength = 8,
  onChange,
  shake = 0,
  showBiometric = false,
  onBiometric,
  biometricDisabled = false,
  disabled = false,
}) {
  const press = (digit) => {
    if (disabled) return;
    haptic('light');
    if (value.length < maxLength) onChange(value + digit);
  };
  const erase = () => {
    if (disabled) return;
    haptic('light');
    onChange(value.slice(0, -1));
  };

  const keyClass = `flex h-16 w-16 items-center justify-center rounded-full text-[24px] font-semibold text-ink active:bg-ink/10 ${pressable}`;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <motion.div animate={shake ? { x: [0, -12, 12, -8, 8, -3, 0] } : { x: 0 }} transition={{ duration: 0.45 }} key={shake}>
        {/* The dot row answers as a named group with one marked dot per slot,
            so readers and the lock-screen spec can count PIN fills (§10). */}
        <div role="group" aria-label="PIN digits entered" className="flex items-center gap-3">
          {Array.from({ length: maxLength }, (_, i) => (
            <span
              key={i}
              data-dot=""
              data-filled={i < value.length ? 'true' : 'false'}
              aria-hidden="true"
              className={`h-3 w-3 rounded-full transition-colors ${i < value.length ? 'bg-accent' : 'bg-ink/15'}`}
            />
          ))}
        </div>
      </motion.div>
      {/* The pad itself is a named group — the spec walks its buttons by name,
          so keys keep digit and erase labels no matter the re-dress. */}
      <div role="group" aria-label="Number pad" className="grid grid-cols-3 gap-x-5 gap-y-3">
        {KEYS.map((digit) => (
          <button key={digit} type="button" onClick={() => press(digit)} disabled={disabled} className={keyClass}>
            {digit}
          </button>
        ))}
        {showBiometric ? (
          <button
            type="button"
            onClick={onBiometric}
            disabled={disabled || biometricDisabled}
            aria-label="Unlock with Face ID / fingerprint"
            className={`flex h-16 w-16 items-center justify-center rounded-full text-accentText active:bg-ink/10 disabled:opacity-40 ${pressable}`}
          >
            <Fingerprint size={26} aria-hidden="true" />
          </button>
        ) : (
          <span aria-hidden="true" className="h-16 w-16" />
        )}
        <button type="button" onClick={() => press('0')} disabled={disabled} className={keyClass}>0</button>
        <button type="button" onClick={erase} disabled={disabled || value.length === 0} aria-label="Erase last digit" className={`flex h-16 w-16 items-center justify-center rounded-full text-inkMuted active:bg-ink/10 disabled:opacity-40 ${pressable}`}>
          <Delete size={22} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
