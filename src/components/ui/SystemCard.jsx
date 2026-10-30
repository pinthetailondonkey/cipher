// The system card a deal rides in (DESIGN.md): never a bubble, always this
// flat panel with a hairline — an order summary line and the five-beat
// escrow rail beneath it: Placed, Address, Seen, Confirmed, Released.
// Beat state is passed in; the card draws, it does not decide.
const DEFAULT_BEATS = ['Placed', 'Address', 'Seen', 'Confirmed', 'Released'];

export default function SystemCard({ title, subtitle = null, beats = DEFAULT_BEATS, active = 0, done = 0, className = '', children }) {
  return (
    <div className={`rounded-2xl border border-line bg-panel px-4 py-3 ${className}`}>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {subtitle && <p className="mt-0.5 text-[13px] text-inkMuted">{subtitle}</p>}
      {children}
      <ol className="mt-3 flex items-start" aria-label="Payment state">
        {beats.map((label, i) => {
          const reached = i < done;
          const current = i === active && !reached;
          return (
            <li key={label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="flex w-full items-center">
                <span className={`h-px flex-1 ${i === 0 ? 'bg-transparent' : reached || current ? 'bg-accent' : 'bg-line'}`} aria-hidden="true" />
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${reached ? 'bg-accent' : current ? 'bg-accent ring-2 ring-accentSoft' : 'bg-panelAlt'}`}
                  aria-hidden="true"
                />
                <span className={`h-px flex-1 ${i === beats.length - 1 ? 'bg-transparent' : reached ? 'bg-accent' : 'bg-line'}`} aria-hidden="true" />
              </span>
              <span className={`truncate text-[11px] ${reached || current ? 'text-ink' : 'text-inkSubtle'}`}>{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
