import React, { useState, useEffect, useCallback } from 'react';
import { Search, Users, Loader2 } from 'lucide-react';
import { useChatStore } from './store/chatStore';
import { joinGroup } from './lib/groupJoin';
import { groupOnlyRelays } from './lib/relays';
import EmptyState from './components/ui/EmptyState';
import Badge from './components/ui/Badge';
import { SkeletonGrid } from './components/ui/Skeleton';
import { haptic } from './lib/haptics';

// One card of the public directory, §6: initials avatar 40, name, two lines
// of about, a badge (member count when this device knows it, the kind word
// when it does not), and the join control — accent while joining is
// offered, ghost "Open" once joined. A joined card opens on tap.
function GroupCard({ group, joined, joining, name, onOpen }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0].toUpperCase()).join('') || '?';
  const label = joining ? <Loader2 size={15} className="animate-spin" /> : joined ? 'Open' : 'Join';
  const members = Array.isArray(group.members) ? group.members.length : 0;
  const badgeText = members > 0 ? `${members} members` : group.isChannel ? 'Menu' : 'Group';
  const openJoined = () => {
    if (!joined || joining) return;
    haptic('light');
    onOpen(group);
  };
  return (
    <div
      className={`flex flex-col justify-between rounded-3xl border border-line bg-panelStrong p-3 shadow-lg ${joined ? 'cursor-pointer' : ''}`}
      onClick={openJoined}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-panelAlt text-[13px] font-semibold text-accentText">
          {initials}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="line-clamp-2 text-[15px] font-semibold text-ink">{group.name}</h3>
          <div className="mt-1.5"><Badge>{badgeText}</Badge></div>
        </div>
      </div>
      {(group.about || group.isCipher) && (
        <p className="mt-2 line-clamp-2 text-[13px] text-inkMuted">{group.about}</p>
      )}
      <button
        type="button"
        disabled={joining}
        onClick={(event) => { event.stopPropagation(); haptic('light'); onOpen(group); }}
        className={`mt-3 flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-[13px] font-bold ${joined ? 'border border-line bg-panel text-accentText active:bg-ink/10' : 'bg-accent text-accentInk active:bg-accent'} disabled:opacity-60`}
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
  const [fetchError, setFetchError] = useState('');
  const storeGroups = useChatStore((s) => s.groups);
  const groupKey = (storeGroups || []).map((group) => group.id).sort().join('|');

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setFetchError('');
    try {
      const { SimplePool } = await import('nostr-tools');
      const pool = new SimplePool();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Relay timeout')), 4000)
      );

      const fetchPromise = pool.querySync(
        groupOnlyRelays,
        { kinds: [39000, 9002], limit: 50 }
      );

      const events = await Promise.race([fetchPromise, timeoutPromise]);

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
          members: group.members,
        }));
      setRealGroups([...cipherGroups, ...mine]);
      pool.close(groupOnlyRelays);
    } catch (err) {
      console.error("Failed to fetch groups:", err);
      setFetchError('Could not reach the group directory.');
      setRealGroups(useChatStore.getState().groups || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The relay directory is always read, even when this account already
    // belongs to groups: discovery exists to show menus and rooms you are
    // NOT in yet — vendors grow through it, so joined chats never replace
    // the public list.
    fetchGroups();
  }, [groupKey, fetchGroups]);

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
      {fetchError && !loading && (
        <div className="mx-4 rounded-2xl border border-line bg-panel px-4 py-10 text-center">
          <p className="text-[15px] font-semibold text-ink">Directory unavailable</p>
          <p className="mt-1 text-[13px] text-ink/40">{fetchError}</p>
          <button
            type="button"
            onClick={() => { haptic('light'); fetchGroups(); }}
            className="mt-4 inline-flex min-h-[44px] items-center rounded-full border border-line px-5 text-[13px] font-bold text-ink active:bg-ink/10"
          >
            Retry
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="px-4 pt-1">
            <SkeletonGrid items={4} min={172} itemClass="h-40" />
          </div>
        ) : displayGroups.length === 0 ? (
          fetchError ? null : (
            <EmptyState icon={Users} title="Nothing here yet">
              You're early. Be the first room on Cipher.
            </EmptyState>
          )
        ) : (
          <>
            {menus.length > 0 && (
              <div className="px-4 pb-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-inkMuted">Menus</p>
                <p className="pb-2 text-[12px] text-inkSubtle">Menus are for buying. Groups are for talking.</p>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))' }}>
                  {menus.map((group) => <GroupCard key={group.id} group={group} name={group.name} joined={joinedIds.has(group.id)} joining={joiningId === group.id} onOpen={join} />)}
                </div>
              </div>
            )}
            {rooms.length > 0 && (
              <div className="px-4 pb-4 pt-3">
                <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-inkMuted">Groups</p>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))' }}>
                  {rooms.map((group) => <GroupCard key={group.id} group={group} name={group.name} joined={joinedIds.has(group.id)} joining={joiningId === group.id} onOpen={join} />)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
