<<<<<<< HEAD
// Local stand-in for the PR2 list row (master-prompt §1): 64px minimum,
// avatar slot 40, title 15px semibold, subtitle 13px inkMuted, meta right,
// trailing badge/kebab slot. Slots are free-rendered so dense rows —
// relative time above an unread pill, blurred previews — compose without
// styling the primitive.
export default function ListRow({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  dense = false,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onContextMenu,
  contentClassName = '',
  className = '',
}) {
  return (
    <div className={`relative flex items-stretch ${className}`}>
      <button
        type="button"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        onContextMenu={onContextMenu}
        className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left active:bg-ink/5 ${dense ? 'min-h-[48px]' : 'min-h-[64px]'} ${contentClassName}`}
      >
        {leading && <span className="shrink-0">{leading}</span>}
        <span className="min-w-0 flex-1">
          {title}
          {subtitle}
        </span>
        {meta}
      </button>
      {trailing}
    </div>
=======
// The 64px list row: 40px leading slot, 15px semibold title, 13px muted
// subtitle, 11px subtle meta on the right, trailing slot for badge or kebab.
// Renders a button when wired to a handler, a plain row otherwise.
export default function ListRow({
  leading = null,
  title,
  subtitle = null,
  meta = null,
  trailing = null,
  onClick,
  label,
  className = '',
}) {
  const body = (
    <>
      {leading && typeof leading === 'object' ? <span className="shrink-0">{leading}</span> : leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-[13px] text-inkMuted">{subtitle}</span>}
      </span>
      {meta && <span className="shrink-0 text-[11px] text-inkSubtle">{meta}</span>}
      {trailing && <span className="shrink-0">{trailing}</span>}
    </>
  );

  if (!onClick) {
    return <div className={`flex min-h-[64px] w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-0 ${className}`}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex min-h-[64px] w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-0 active:bg-ink/5 ${className}`}
    >
      {body}
    </button>
>>>>>>> origin/feat/rebuild-pr2
  );
}
