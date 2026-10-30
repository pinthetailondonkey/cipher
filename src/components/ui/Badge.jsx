const tones = {
  // The unread count: the accent pill that rides a chat row, >=22px high
  // (DESIGN.md), label at 12px.
  unread: 'min-h-[22px] min-w-[22px] bg-accent px-[7px] text-[12px] text-accentInk',
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
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold leading-4 ${tones[tone] || tones.neutral} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
