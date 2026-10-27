// Local stand-in for the PR2 skeleton: shimmer presets, chat-list Row / List
// shapes use the .shimmer class from src/index.css (hover-wash to panel-alt).
export function Skeleton({ className = '' }) {
  return <span className={`shimmer rounded-lg ${className}`} />;
}

export function SkeletonRow({ className = '' }) {
  return (
    <div className={`flex items-center gap-3 border-b border-line px-4 py-3 ${className}`}>
      <span className="shimmer h-10 w-10 shrink-0 rounded-full" />
      <span className="flex-1 space-y-2">
        <span className="shimmer block h-3.5 w-1/3 rounded" />
        <span className="shimmer block h-3 w-1/2 rounded" />
      </span>
    </div>
  );
}

export function SkeletonList({ rows = 6, className = '' }) {
  return (
    <div className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}
