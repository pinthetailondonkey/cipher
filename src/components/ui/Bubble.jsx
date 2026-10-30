// One message bubble (DESIGN.md): max 78% wide, radius 18, the group's last
// bubble gets a 6px tail corner, 16px text, the time inside at bottom-right
// at 11px and 70% opacity, double ticks on outgoing.
// Grouping (2px inside a group, 8px between) is the list's job — this
// component only draws one bubble and knows whether it ends its group.
function Ticks({ state = 'sent' }) {
  if (state === 'read') {
    return (
      <svg width="16" height="11" viewBox="0 0 16 11" fill="none" aria-label="Read" className="shrink-0">
        <path d="M1 6.2 4 9l4.6-6.4M6.5 6.2 9.5 9 15 1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="11" viewBox="0 0 12 11" fill="none" aria-label="Sent" className="shrink-0">
      <path d="M1 6.2 4 9l6.4-7.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Bubble({ mine = false, last = true, time = '', ticks = null, children, className = '' }) {
  const tail = last ? (mine ? 'rounded-br-[6px]' : 'rounded-bl-[6px]') : '';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'} ${className}`}>
      <div
        className={`max-w-[78%] rounded-[18px] px-3 py-2 text-[16px] leading-snug ${mine ? 'bg-bubbleOut text-white' : 'bg-bubbleIn text-ink'} ${tail}`}
      >
        <span className="block whitespace-pre-wrap break-words">{children}</span>
        {(time || ticks) && (
          <span className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] opacity-70 ${mine ? 'text-white' : 'text-inkMuted'}`}>
            {time}
            {mine && ticks ? <Ticks state={ticks} /> : null}
          </span>
        )}
      </div>
    </div>
  );
}
