// Skeleton — loading placeholders that read every list's idle state. The
// shimmer rides between hover-wash and ink at 10%.
export function Skeleton({ className = '' }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-xl bg-ink/10 ${className}`} />;
}

export function SkeletonRow({ className = '' }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 4, className = '' }) {
  return (
    <div className={`space-y-4 ${className}`}>
      {Array.from({ length: rows }, (_row, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

export function SkeletonGrid({ cols = 3, className = '' }) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${className}`}>
      {Array.from({ length: cols * 2 }, (_item, index) => (
        <Skeleton key={index} className="h-40" />
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

export default Skeleton;
