import { useMemo, useState } from 'react';
import Sheet from '../ui/Sheet';
import { useChatStore } from '../../store/chatStore';
import { shortNpub, noHexName } from '../../lib/npub';
import Avatar from '../ui/Avatar';

// The forward peer-picker: existing DM peers only, because a forward re-sends
// through the direct message actor. Groups stay forward targets for a later
// pass — the payload would need the group's own send actor.
export default function ForwardPicker({ open, onClose, onPick, selectedCount = 1 }) {
  const dms = useChatStore((s) => s.dms);
  const profiles = useChatStore((s) => s.profiles);
  const [filter, setFilter] = useState('');

  const peers = useMemo(() => (
    Object.keys(dms || {})
      .map((pubkey) => {
        const profile = profiles[pubkey];
        // The name the picker shows is the lib's own private-safe composer.
        const name = noHexName(profile, pubkey);
        return { pubkey, name, picture: profile?.picture || '', searchable: `${name} ${shortNpub(pubkey)}` };
      })
      .filter((peer) => !filter.trim() || peer.searchable.toLowerCase().includes(filter.trim().toLowerCase()))
  ), [dms, profiles, filter]);

  return (
    <Sheet open={open} onClose={onClose} title={`Forward${selectedCount > 1 ? ` ${selectedCount} messages` : ''}`}>
      <div className="px-4 pb-2">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find a person"
          aria-label="Find a person"
          className="min-h-[44px] w-full rounded-xl border border-line bg-panelStrong px-3 text-[15px] text-ink outline-none placeholder:text-inkSubtle"
        />
      </div>
      <div className="max-h-80 overflow-y-auto overscroll-contain px-1 pb-2">
        {peers.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-inkMuted">No one to forward to yet.</p>}
        {peers.map(({ pubkey, name, picture }) => (
          <button
            key={pubkey}
            type="button"
            onClick={() => onPick(pubkey)}
            className="flex min-h-[44px] w-full items-center gap-3 rounded-2xl px-3 py-2 text-left active:bg-ink/10"
          >
            <Avatar name={name} src={picture} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{name}</span>
            <span className="text-[12px] font-semibold text-accentText">Send</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
