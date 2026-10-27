import { ChevronRight } from 'lucide-react';
import { pressable } from './Button';

// ListRow — 64px min setting/list row (§1). Icon slot 24, title 15px
// semibold, subtitle 13px inkMuted, trailing slot (defaults to a chevron
// when the row navigates). Rows group inside a rounded bordered panel and
// get their hairline separators from the group's divide utilities.
//
// API: <ListRow icon? title subtitle? trailing? onClick? danger? ariaLabel?>
//   icon      lucide component
//   trailing  node — replaces the default chevron (e.g. ui Switch)
//   danger    red title/icon for danger-zone rows
//   onClick   absent renders a static row (no chevron)
export default function ListRow({ icon: Icon, title, subtitle, trailing, onClick, danger = false, ariaLabel }) {
  const body = (
    <>
      {Icon && <Icon size={24} className={`shrink-0 ${danger ? 'text-danger' : 'text-inkSubtle'}`} aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className={`block text-[15px] font-semibold ${danger ? 'text-danger' : 'text-ink'}`}>{title}</span>
        {subtitle && <span className="block text-[13px] text-inkMuted">{subtitle}</span>}
      </span>
      {trailing !== undefined ? (
        trailing
      ) : (
        onClick && <ChevronRight size={18} className="shrink-0 text-inkSubtle" aria-hidden="true" />
      )}
    </>
  );
  if (!onClick) {
    return <div className="flex min-h-[64px] items-center gap-3 px-4 py-3 text-left">{body}</div>;
  }
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={`flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left ${pressable}`}>
      {body}
    </button>
  );
}

// Card — the iOS-style grouped panel rows sit in: bg-panel, border-line,
// radius 16, hairline row separators.
export function Card({ label, children, className = '' }) {
  return (
    <section className={className}>
      {label && <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle">{label}</h3>}
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">{children}</div>
    </section>
  );
}
