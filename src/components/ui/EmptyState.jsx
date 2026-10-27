// EmptyState — idle list copy. Icon sits in an accent-soft circle, one
// title, one line, optional action row. Buttons stay plain per VOICE.
export default function EmptyState({ icon = null, title, children, action = null, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}>
      {icon ? (
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accentSoft text-accentText">
          {icon}
        </span>
      ) : null}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children ? <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-inkMuted">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
