import { useChatStore } from '../../store/chatStore';

export default function ToastBanner() {
  const toast = useChatStore((state) => state.toast);
  if (!toast) return null;
  return (
    <div className="fixed top-safe left-1/2 z-[200] flex -translate-x-1/2 animate-slide-up items-center gap-3 rounded-2xl border border-ink/10 bg-surfaceLight px-5 py-3 shadow-2xl">
      <div className={`h-2 w-2 rounded-full ${toast.type === 'error' ? 'bg-red-500' : 'bg-green-500'}`} />
      <span className="text-sm font-semibold text-ink">{toast.message}</span>
    </div>
  );
}
