<<<<<<< HEAD
// Badge — a small status pill for counts and states that ride rows and
// cards. Not a button: nothing inside is tapped. Superset of the landings in
// flight: `tone` (alias `variant`) carries unread / neutral / soft / outline /
// success / danger / solid; `unread` is the compact accent count pill.
const tones = {
  unread: 'flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accentInk',
  neutral: 'inline-flex items-center gap-1 rounded-full bg-panelStrong px-2 py-0.5 text-[11px] font-semibold tracking-wide text-inkMuted',
  soft: 'inline-flex items-center gap-1 rounded-full bg-accentSoft px-2 py-0.5 text-[11px] font-semibold tracking-wide text-accentText',
  outline: 'inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold tracking-wide text-inkMuted',
  success: 'inline-flex items-center gap-1 rounded-full bg-accentSoft px-2 py-0.5 text-[11px] font-semibold tracking-wide text-success',
  danger: 'inline-flex items-center gap-1 rounded-full bg-accentSoft px-2 py-0.5 text-[11px] font-semibold tracking-wide text-danger',
  solid: 'inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold tracking-wide text-accentInk',
};

export default function Badge({ tone, variant, className = '', children, ...props }) {
  const look = tone || variant || 'neutral';
  return (
    <span className={`${tones[look] || tones.neutral} shrink-0 ${className}`} {...props}>
=======
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
>>>>>>> origin/feat/rebuild-pr2
      {children}
    </span>
  );
}
