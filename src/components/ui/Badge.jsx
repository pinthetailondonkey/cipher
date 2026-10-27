const tones = {
  accent: 'bg-accent text-accentInk',
  soft: 'bg-accentSoft text-accentText',
  success: 'bg-success/15 text-success',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-ink/15 text-inkMuted',
  outline: 'border border-line text-inkMuted',
};

// The state pill that rides rows and order cards.
export default function Badge({ tone = 'neutral', className = '', children, ...rest }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold leading-4 ${tones[tone] || tones.neutral} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
