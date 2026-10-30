import { createElement, isValidElement } from 'react'

// The 72px chat row (DESIGN.md): 52px leading slot, 16px/600 title, 15px
// muted preview, 13px muted time, a hairline that starts at the text edge
// (76px in: 16px padding + 52px avatar + 8px gap). Renders a button when
// wired to a handler, a plain row otherwise.
// `icon` is the component form of `leading` (icon={User} renders size 20).
// Lucide icons are forwardRef objects, not functions, so a component is
// detected by render callable, and only a real element may sit in JSX.
const isComponent = (value) =>
  typeof value === 'function' ||
  (value != null && typeof value === 'object' && typeof value.render === 'function')
export default function ListRow({
  leading = null,
  icon = null,
  title,
  subtitle = null,
  meta = null,
  trailing = null,
  onClick,
  label,
  className = '',
}) {
  const lead = leading ?? (isComponent(icon) ? createElement(icon, { size: 20, 'aria-hidden': 'true', className: 'text-inkMuted' }) : null)
  const body = (
    <>
      {isValidElement(lead) && <span className="flex w-[52px] shrink-0 items-center justify-center">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-semibold text-ink">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-[15px] text-inkMuted">{subtitle}</span>}
      </span>
      {meta && <span className="shrink-0 self-start pt-1 text-[13px] text-inkMuted">{meta}</span>}
      {isValidElement(trailing) && <span className="shrink-0">{trailing}</span>}
    </>
  );
  const rowClass = `relative flex min-h-[72px] w-full items-center gap-2 px-4 py-2 text-left ${className}`

  if (!onClick) {
    return (
      <div className={rowClass}>
        {body}
        <span aria-hidden="true" className="absolute bottom-0 left-[76px] right-0 h-px bg-line" />
      </div>
    );
  }

  return (
    <button type="button" onClick={onClick} aria-label={label} className={`${rowClass} active:bg-ink/5`}>
      {body}
      <span aria-hidden="true" className="absolute bottom-0 left-[76px] right-0 h-px bg-line" />
    </button>
  );
}

// Card — the grouped panel rows sit in: bg-panel, border-line, radius 16,
// hairline dividers between rows. `label` renders the group caption above.
export function Card({ label, children, className = '' }) {
  return (
    <div className={className}>
      {label && <p className="pb-1.5 pl-1 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle">{label}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">{children}</div>
    </div>
  );
}
