// Empty state: icon in an accent-soft circle, title, one line, optional
// action. Slang may live in the line (copy only), never in the action.
export default function EmptyState({ icon: Icon, title, children, action, className = '' }) {
  return (
    <div className={`mx-4 flex flex-col items-center justify-center rounded-2xl border border-line bg-panel px-4 py-16 text-center ${className}`}>
      {Icon && (
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accentSoft text-accentText" aria-hidden="true">
          <Icon size={22} />
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children && <p className="mt-1 max-w-[26ch] text-[13px] text-inkMuted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
