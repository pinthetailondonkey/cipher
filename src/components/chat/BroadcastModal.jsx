import { useEffect, useState } from 'react';
import { Radio, X } from 'lucide-react';

export default function BroadcastModal({ isOpen, onClose, product, groups = [], onBroadcast }) {
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (isOpen) setSelectedGroups([]);
  }, [isOpen, product]);

  if (!isOpen || !product) return null;

  const toggleGroup = (groupId) => {
    setSelectedGroups((current) => current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId]);
  };

  const broadcast = async () => {
    if (sending || selectedGroups.length === 0) return;
    setSending(true);
    try {
      await onBroadcast(selectedGroups, product);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[950] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Broadcast product" className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A] p-5">
        <header className="mb-4 flex items-center gap-3">
          <Radio size={19} className="text-blue-400" />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-white">Broadcast listing</h2>
            <p className="truncate text-xs text-white/45">{product.title || product.name || 'Product'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close broadcast" className="p-2 text-white/45 hover:text-white"><X size={19} /></button>
        </header>
        <p className="mb-3 text-sm text-white/55">Choose the groups where you want to post this listing.</p>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {groups.length === 0 && <p className="rounded-xl bg-white/5 p-4 text-sm text-white/45">You have not joined any groups yet.</p>}
          {groups.map((group) => (
            <label key={group.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 hover:bg-white/[0.07]">
              <input
                type="checkbox"
                checked={selectedGroups.includes(group.id)}
                onChange={() => toggleGroup(group.id)}
                className="h-4 w-4 accent-blue-500"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-white">{group.name || group.id}</span>
              <span className="truncate text-[10px] text-white/35">{group.id.slice(0, 8)}</span>
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={broadcast}
          disabled={sending || selectedGroups.length === 0}
          className="mt-5 w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Broadcasting…' : `Post to ${selectedGroups.length} group${selectedGroups.length === 1 ? '' : 's'}`}
        </button>
      </section>
    </div>
  );
}
