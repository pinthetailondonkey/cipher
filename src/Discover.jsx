import React, { useState, useEffect } from 'react';
import { Search, Users, Loader2 } from 'lucide-react';
import { useChatStore } from './store/chatStore';
import { joinGroup } from './lib/groupJoin';
import { groupOnlyRelays } from './lib/relays';

// One row of the public directory. A menu's body opens the vendor's menu
// home and its pill keeps the join / open-chat action; a group row opens
// or joins on tap. Anything without a menu to open falls back whole-row.
function DiscoverRow({ group, joined, joining, onOpen, onOpenMenu }) {
  const initials = group.name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0].toUpperCase()).join('') || '?';
  const label = joining ? '…' : joined ? 'Open' : 'Join';
  const bodyAction = onOpenMenu || onOpen;
  return (
    <div className="flex min-h-[64px] w-full items-center justify-between gap-2 border-b border-line px-4 py-2 last:border-0">
      <button
        type="button"
        onClick={() => bodyAction(group)}
        disabled={joining}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 pr-2 text-left active:bg-ink/5 disabled:opacity-50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-panelAlt text-[13px] font-semibold text-accentText">
          {initials}
        </span>
        <span className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{group.name}</h3>
          <p className="text-[13px] text-inkMuted line-clamp-1">{group.about}</p>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpen(group)}
        disabled={joining}
        className={`shrink-0 rounded-2xl px-3 py-1.5 text-[13px] font-bold disabled:opacity-50 ${joined ? 'text-accentText' : 'bg-accent text-accentInk'}`}
      >
        {label}
      </button>
    </div>
  );
}

export default function Discover({ identity, onJoined }) {
  const [query, setQuery] = useState('');
  const [realGroups, setRealGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState('');
  const [error, setError] = useState('');
  // A relay that could not be reached is not a relay that had nothing. The
  // screen keeps the groups this account already has and says which of the
  // two happened, so an empty directory is never claimed on a failed read.
  const [directoryFailed, setDirectoryFailed] = useState(false);
  const storeGroups = useChatStore((s) => s.groups);
  const groupKey = (storeGroups || []).map((group) => group.id).sort().join('|');

  useEffect(() => {
    // The relay directory is always read, even when this account already
    // belongs to groups: discovery exists to show menus and rooms you are
    // NOT in yet — vendors grow through it, so joined chats never replace
    // the public list.
    let alive = true;
    const fetchGroups = async () => {
      setLoading(true);
      setDirectoryFailed(false);
      try {
        const { SimplePool } = await import('nostr-tools');
        const pool = new SimplePool();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Network timeout')), 4000)
        );

        const fetchPromise = pool.querySync(
          groupOnlyRelays,
          { kinds: [39000, 9002], limit: 50 }
        );

        const events = await Promise.race([fetchPromise, timeoutPromise]);
        if (!alive) return;

        const parsed = events.map(ev => {
          const getTag = (name) => ev.tags.find(t => t[0] === name)?.[1];
          return {
            id: getTag('h') || getTag('d') || ev.id,
            name: getTag('name') || getTag('title') || 'Unnamed Group',
            about: getTag('about') || 'No description',
            isChannel: ev.tags.some(t => t[0] === 'channel' || t[0] === 'broadcast'),
            // Spaces created inside this app carry [cipher]; the wider
            // network's groups stay out of this screen.
            isCipher: ev.tags.some(t => t[0] === 'cipher'),
            // The directory event's author is the menu's vendor: the menu
            // home and the profile page read listings and standing from it.
            creator: ev.pubkey,
          };
        });

        const unique = Array.from(new Map(parsed.map(g => [g.id, g])).values());
        const cipherGroups = unique.filter(g => g.isCipher);
        setRealGroups(cipherGroups);
        // Every group this account belongs to stays listed, but only those
        // the relay directory does not publish itself.
        const published = new Set(cipherGroups.map(g => g.id));
        const mine = (useChatStore.getState().groups || [])
          .filter((group) => !published.has(group.id))
          .map((group) => ({
            id: group.id,
            name: group.name || 'Unnamed Group',
            about: group.about || 'No description',
            isChannel: group.isChannel === true,
            isCipher: true,
            creator: group.creator || '',
          }));
        setRealGroups([...cipherGroups, ...mine]);
      } catch (err) {
        console.error("Failed to fetch groups:", err);
        if (!alive) return;
        setDirectoryFailed(true);
        setRealGroups(useChatStore.getState().groups || []);
      } finally {
        if (alive) setLoading(false);
      }
    };

    fetchGroups();
    return () => { alive = false; };
  }, [groupKey]);

  const joinedIds = new Set((storeGroups || []).map((group) => group.id));

  const displayGroups = realGroups.filter(g =>
    (g.name || '').toLowerCase().includes(query.toLowerCase()) ||
    (g.about || '').toLowerCase().includes(query.toLowerCase())
  );
  const menus = displayGroups.filter(g => g.isChannel);
  const rooms = displayGroups.filter(g => !g.isChannel);

  const join = async (group) => {
    if (!identity?.pk || joiningId) return;
    if (joinedIds.has(group.id)) {
      const joined = (storeGroups || []).find((item) => item.id === group.id);
      if (joined) useChatStore.getState().openChat('group', joined.id, joined);
      onJoined?.();
      return;
    }
    setJoiningId(group.id);
    setError('');
    try {
      const joined = await joinGroup(identity, group.id, { name: group.name, channel: group.isChannel });
      useChatStore.getState().setGroups((groups) => [joined, ...(groups || []).filter((item) => item.id !== joined.id)]);
      useChatStore.getState().openChat('group', joined.id, joined);
      onJoined?.();
    } catch (joinError) {
      console.error('[Discover] Could not join group:', joinError);
      setError(joinError?.message || 'Could not join that group.');
    } finally {
      setJoiningId('');
    }
  };

  // A menu row's body enters the vendor's menu home — the vendor's chat
  // stays one tap away from inside it ("Message vendor").
  const openVendorMenu = (group) => {
    if (!group?.creator) return;
    useChatStore.getState().setVendorStorefrontPubkey(group.creator);
  };

  return (
    <div className="relative flex h-full w-full flex-col bg-transparent">
      <div className="px-4 pb-3 pt-2">
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-panelStrong px-4 py-3">
          <Search size={16} className="text-inkMuted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-inkSubtle focus:outline-none"
          />
        </div>
      </div>

      {error && <p role="alert" className="px-4 text-sm text-danger">{error}</p>}
      {directoryFailed && (
        <p role="status" className="px-4 pb-2 text-[13px] text-inkMuted">
          The relay could not be reached. What is listed here is what this account already saved.
        </p>
      )}
      <div className="flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center mt-20 text-inkMuted">
            <Loader2 size={32} className="animate-spin mb-4 text-accentText" />
            <p className="text-sm">Searching the network...</p>
          </div>
        ) : displayGroups.length === 0 ? (
          <div className="mx-4 rounded-2xl border border-line bg-panel px-4 py-16 text-center">
            <Users size={28} className="mx-auto mb-3 text-inkSubtle" />
            <p className="text-[15px] font-semibold text-ink">
              {directoryFailed ? 'Could not reach the relay' : 'No menus or groups yet'}
            </p>
            {directoryFailed && (
              <p className="mt-1 px-4 text-[13px] text-inkMuted">There may be menus and groups, but this screen could not ask.</p>
            )}
          </div>
        ) : (
          <>
            {menus.length > 0 && (
              <div className="mx-4 mb-4 overflow-hidden rounded-2xl border border-line bg-panel">
                <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wider text-inkMuted">Menus</p>
                <p className="px-4 pb-1 text-[12px] text-inkSubtle">Menus are for buying. Groups are for talking.</p>
                {menus.map((group) => (
                  <DiscoverRow
                    key={group.id}
                    group={group}
                    joined={joinedIds.has(group.id)}
                    joining={joiningId === group.id}
                    onOpen={join}
                    onOpenMenu={group.creator ? openVendorMenu : undefined}
                  />
                ))}
              </div>
            )}
            {rooms.length > 0 && (
              <div className="mx-4 overflow-hidden rounded-2xl border border-line bg-panel">
                <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wider text-inkMuted">Groups</p>
                {rooms.map((group) => <DiscoverRow key={group.id} group={group} joined={joinedIds.has(group.id)} joining={joiningId === group.id} onOpen={join} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
