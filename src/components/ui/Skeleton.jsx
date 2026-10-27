// Shimmer placeholder for every loading surface. The shimmer steps between
// the hover-wash token and ink at 10% — no hex, no motion library needed;
// prefers-reduced-motion flattens it in the stylesheet. Superset of both
// landings: bare Skeleton plus Row / List / Grid presets.
export default function Skeleton({ className = '', ...props }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} {...props} />;
}

// One list row placeholder: 64px min, 40px avatar slot, two text lines.
export function SkeletonRow({ className = '' }) {
  return (
    <div className={`flex min-h-[64px] items-center gap-3 px-4 py-2 ${className}`}>
      <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 3, className = '' }) {
  return (
    <div className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

// A card grid that fills as many columns as the width allows, so the skeleton
// shows the real layout before the real cards arrive.
export function SkeletonGrid({ items = 4, min = 172, itemClass = '', className = '' }) {
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}
    >
      {Array.from({ length: items }, (_, index) => (
        <Skeleton key={index} className={itemClass} />
      ))}
    </div>
  );
}
