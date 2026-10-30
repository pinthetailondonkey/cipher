import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';

export default function BroadcastModal({ isOpen, onClose, product, groups = [], onBroadcast }) {
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (isOpen) setSelectedGroups([]);
  }, [isOpen, product]);

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
    <Sheet open={Boolean(isOpen && product)} onClose={onClose} title="Broadcast">
      <div className="pb-4">
        <div className="mb-3 flex items-center gap-2">
          <Radio size={16} className="shrink-0 text-accentText" />
          <p className="min-w-0 truncate text-[13px] text-inkMuted">{product?.title || product?.name || 'Product'}</p>
        </div>
        <p className="mb-3 text-sm text-inkMuted">Choose the groups where you want to post this listing.</p>
        <div className="max-h-64 space-y-1.5 overflow-y-auto pb-1">
          {groups.length === 0 && <p className="rounded-xl bg-ink/5 p-4 text-sm text-inkMuted">You have not joined any groups yet.</p>}
          {groups.map((group) => (
            <label key={group.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-ink/[0.03] px-3 py-3 hover:bg-ink/[0.07]">
              <input
                type="checkbox"
                checked={selectedGroups.includes(group.id)}
                onChange={() => toggleGroup(group.id)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{group.name || group.id}</span>
              <span className="truncate text-[10px] text-inkSubtle">{group.id.slice(0, 8)}</span>
            </label>
          ))}
        </div>
        <Button
          onClick={broadcast}
          loading={sending}
          disabled={selectedGroups.length === 0}
          fullWidth
          className="mt-5"
        >
          {sending ? 'Broadcasting…' : `Post to ${selectedGroups.length} group${selectedGroups.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Sheet>
  );
}
