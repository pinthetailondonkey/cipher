// The idle screen: icon in the accent-soft circle, one title, one line, and
// the one action the user should take next. Slang may flavor this copy.
export default function EmptyState({ icon = null, title, line = null, action = null, className = '' }) {
  return (
    <div className={`flex flex-col items-center rounded-2xl border border-line bg-panel px-6 py-12 text-center ${className}`}>
      {icon && (
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accentSoft text-accentText">
          {icon}
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {line && <p className="mt-1 max-w-[16rem] text-[13px] text-inkMuted">{line}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
