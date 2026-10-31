// The idle screen: one icon, one title, one line, and the one action the
// user should take next. No card around it — an empty list is quiet, not
// boxed. Screens do not hand-roll an empty state.
export default function EmptyState({ icon = null, title, line = null, action = null, className = '' }) {
  return (
    <div className={`flex flex-col items-center px-[var(--gutter)] py-12 text-center ${className}`}>
      {icon && (
        <span className="mb-3 text-inkSubtle [&_svg]:h-7 [&_svg]:w-7" aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {line && <p className="mt-1 max-w-[16rem] text-[13px] text-inkMuted">{line}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
