import { Star, X } from 'lucide-react';

export default function ReviewModal({ isOpen = false, onClose, title = 'Review', children, onSubmit }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[960] flex items-end justify-center bg-black/70 p-3" role="presentation" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-3xl border border-white/10 bg-[#0A0A0A] p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-white"><Star size={18} className="text-white/40" /> {title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 text-white/50"><X size={18} /></button>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#111] p-4 text-[15px] text-white">{children}</div>
        {onSubmit && <button type="button" onClick={onSubmit} className="w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500">Save review</button>}
      </section>
    </div>
  );
}
