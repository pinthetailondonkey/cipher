export default function ChatLoading() {
  return (
    <div className="p-4 h-full animate-fade-in">
      <div className="flex justify-between items-center mb-6 px-2">
        <div className="h-8 w-24 bg-surfaceLight rounded-lg animate-pulse" />
        <div className="flex gap-2">
          <div className="h-8 w-8 bg-surfaceLight rounded-full animate-pulse" />
          <div className="h-8 w-8 bg-surfaceLight rounded-full animate-pulse" />
        </div>
      </div>
      <div className="space-y-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="bg-surface p-4 rounded-2xl border border-white/5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-surfaceLight animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-surfaceLight rounded animate-pulse w-1/3" />
              <div className="h-3 bg-surfaceLight rounded animate-pulse w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
