<<<<<<< HEAD
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
=======
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
>>>>>>> origin/feat/rebuild-pr2
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 4, className = '' }) {
  return (
<<<<<<< HEAD
    <div className={`space-y-1 ${className}`}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} />
=======
    <div className={`overflow-hidden rounded-2xl border border-line bg-panel ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} className="border-b border-line last:border-0" />
>>>>>>> origin/feat/rebuild-pr2
      ))}
    </div>
  );
}

<<<<<<< HEAD
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
=======
export function SkeletonGrid({ cards = 6, cardClassName = 'aspect-[4/5]', className = '' }) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${className}`} aria-hidden="true">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={`overflow-hidden rounded-2xl border border-line bg-panel ${cardClassName}`}>
          <Skeleton className="h-full w-full rounded-none" />
        </div>
>>>>>>> origin/feat/rebuild-pr2
      ))}
    </div>
  );
}

<<<<<<< HEAD
export function SkeletonStatCard({ className = '' }) {
  return (
    <div className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="mt-2 h-7 w-20" />
=======
export function SkeletonCard({ className = '' }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-line bg-panel ${className}`} aria-hidden="true">
      <Skeleton className="aspect-[4/5] w-full rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
>>>>>>> origin/feat/rebuild-pr2
    </div>
  );
}
