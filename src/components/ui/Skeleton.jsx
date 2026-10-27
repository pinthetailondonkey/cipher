// Shimmer placeholder for every loading surface. The shimmer steps between
// the hover-wash token and ink at 10% — no hex, no motion library needed;
// prefers-reduced-motion flattens it in the stylesheet.
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

// Grid preset dressed for card grids: repeat(auto-fill, minmax) so it holds
// the 172px card rhythm without knowing the screen width.
export function SkeletonGrid({ items = 6, min = 172, className = '', itemClass = 'aspect-[4/5]' }) {
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}
    >
      {Array.from({ length: items }, (_, index) => (
        <Skeleton key={index} className={`w-full ${itemClass}`} />
      ))}
    </div>
  );
}
