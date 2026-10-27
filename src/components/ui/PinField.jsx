// PIN display row: dots fill as typed. The lock screen owns the keypad that
// drives it; this only renders the count truthfully.
export default function PinField({ label, length = 4, value = '', className = '' }) {
  const dots = Array.from({ length }, (_, i) => (
    <span
      key={i}
      className={`h-3 w-3 rounded-full border ${i < String(value).length ? 'border-ink bg-ink' : 'border-line bg-transparent'}`}
    />
  ));
  return (
    <div className={`${className}`}>
      {label && <span className="mb-1.5 block text-[12px] font-medium text-inkMuted">{label}</span>}
      <div className="flex items-center justify-center gap-2.5" aria-label={`${String(value).length} of ${length} entered`}>
        {dots}
      </div>
    </div>
  );
}
