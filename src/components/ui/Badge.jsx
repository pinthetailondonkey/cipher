// Badge — a small status pill. tone: neutral (panel fill), soft (accent-soft
// fill), outline (escrow-fee-chip style), success, danger.
const tones = {
  neutral: 'bg-panelStrong text-inkMuted',
  soft: 'bg-accentSoft text-accentText',
  outline: 'border border-line text-inkMuted',
  success: 'bg-accentSoft text-success',
  danger: 'bg-accentSoft text-danger',
};

export default function Badge({ tone = 'neutral', className = '', children, ...props }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ${tones[tone] || tones.neutral} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
