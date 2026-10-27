import { motion } from 'framer-motion';

// Shimmer block: a hover-wash band sweeps across an ink/10 block while the
// real content loads. No spinner blobs — the skeleton carries the layout.
export default function Skeleton({ className = '' }) {
  return (
    <span className={`relative block overflow-hidden rounded-xl bg-ink/10 ${className}`} aria-hidden="true">
      <motion.span
        className="absolute inset-0 block bg-ink/[0.06]"
        animate={{ x: ['-100%', '100%'] }}
        transition={{ repeat: Infinity, duration: 1.4, ease: 'linear' }}
      />
    </span>
  );
}

export function SkeletonRow({ className = '' }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${className}`}>
      <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 4, className = '' }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-line bg-panel ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} className="border-b border-line last:border-0" />
      ))}
    </div>
  );
}

// Fills as many columns as the width allows, so the skeleton shows the real
// layout before the real cards arrive (Shop and Discover grids settle at
// min 172px). `cards` renders a simple fixed two-column set instead.
export function SkeletonGrid({ cards, cols, items, min = 172, itemClass = '', className = '' }) {
  if (cards || cols || !items) {
    const count = cards ?? (cols ? cols * 2 : 6);
    const shape = cols ? itemClass || 'h-40' : 'aspect-[4/5]';
    return (
      <div className={`grid grid-cols-2 gap-3 ${className}`} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`overflow-hidden rounded-2xl border border-line bg-panel ${shape}`}>
            <Skeleton className="h-full w-full rounded-none" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}
      aria-hidden="true"
    >
      {Array.from({ length: items }, (_, i) => (
        <Skeleton key={i} className={itemClass} />
      ))}
    </div>
  );
}

// The vendor dashboard's stat tiles while the numbers travel.
export function SkeletonStatCard({ className = '' }) {
  return (
    <div className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="mt-2 h-7 w-20" />
    </div>
  );
}

export function SkeletonCard({ className = '' }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-line bg-panel ${className}`} aria-hidden="true">
      <Skeleton className="aspect-[4/5] w-full rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}
