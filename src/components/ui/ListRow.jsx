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
  );
}
