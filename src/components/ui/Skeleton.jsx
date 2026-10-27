// Skeleton — loading placeholders that read every list's idle state. The
// shimmer steps between the hover-wash token and ink at 10% — no hex, no
// motion library; prefers-reduced-motion flattens it in the stylesheet.
// Superset of the landings in flight: bare Skeleton (default and named) plus
// Row / List / Grid / StatCard presets.
export function Skeleton({ className = '', ...props }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} {...props} />;
}

export default Skeleton;

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

export function SkeletonList({ rows = 4, className = '' }) {
  return (
    <div className={`space-y-1 ${className}`}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

// A card grid that fills as many columns as the width allows, so the skeleton
// shows the real layout before the real cards arrive. `items`/`min` build the
// auto-fill layout Shop and Discover settle into; `cols` is the simple
// fixed-column variant.
export function SkeletonGrid({ items, cols, min = 172, itemClass = '', className = '' }) {
  const count = items ?? (cols ? cols * 2 : 4);
  const style = cols ? undefined : { gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` };
  return (
    <div className={`grid grid-cols-2 gap-3 ${className}`} style={style}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={itemClass || 'h-40'} />
      ))}
    </div>
  );
}

export function SkeletonStatCard({ className = '' }) {
  return (
    <div className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="mt-2 h-7 w-20" />
    </div>
  );
}
