import { createElement, isValidElement } from 'react'

// The 64px list row: 40px leading slot, 15px semibold title, 13px muted
// subtitle, 11px subtle meta on the right, trailing slot for badge or kebab.
// Renders a button when wired to a handler, a plain row otherwise.
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
      {isValidElement(lead) && <span className="shrink-0">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-[13px] text-inkMuted">{subtitle}</span>}
      </span>
      {meta && <span className="shrink-0 text-[11px] text-inkSubtle">{meta}</span>}
      {isValidElement(trailing) && <span className="shrink-0">{trailing}</span>}
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
  );
}

// Card — the iOS-style grouped panel rows sit in: bg-panel, border-line,
// radius 16, hairline dividers between rows. `label` renders the group
// caption above the rows.
export function Card({ label, children, className = '' }) {
  return (
    <div className={className}>
      {label && <p className="pb-1.5 pl-1 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle">{label}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">{children}</div>
    </div>
  );
}
