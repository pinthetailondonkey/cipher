// EmptyState — icon in an accent-soft circle, title, one line, optional
// action (§1). Used by every list's empty branch.
//
// API: <EmptyState icon? title line? action={{ label, onClick }}>
export default function EmptyState({ icon: Icon, title, line, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {Icon && (
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accentSoft">
          <Icon size={24} className="text-accentText" aria-hidden="true" />
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {line && <p className="max-w-xs text-[13px] text-inkMuted">{line}</p>}
      {action?.label && action?.onClick && (
        <button
          type="button"
          onClick={action.onClick}
          className="touch-target rounded-xl border border-line bg-panelStrong px-4 py-2.5 text-[14px] font-semibold text-accentText"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
