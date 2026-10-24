import React, { useState, useEffect } from 'react';
import { Search, Users, Megaphone, Loader2 } from 'lucide-react';
import { useChatStore } from './store/chatStore';
import { loadGroupProfile } from './hooks/useNIP29Group';
import { getMyGroups, setMyGroups } from './lib/myGroups';

export default function Discover({ identity, onJoined }) {
  const [query, setQuery] = useState('');
  const [realGroups, setRealGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState('');
  const [error, setError] = useState('');
  const storeGroups = useChatStore((s) => s.groups);
  const groupKey = (storeGroups || []).map((group) => group.id).sort().join('|');

  useEffect(() => {
    const groups = useChatStore.getState().groups || [];
    const fetchGroups = async () => {
      setLoading(true);
      try {
        const { SimplePool } = await import('nostr-tools');
        const pool = new SimplePool();
        
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Relay timeout')), 4000)
        );

        const fetchPromise = pool.querySync(
          ['wss://groups.aegispayhq.com'],
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
          };
        });

        const unique = Array.from(new Map(parsed.map(g => [g.id, g])).values());
        setRealGroups(unique);
      } catch (err) {
        console.error("Failed to fetch groups:", err);
        setRealGroups(useChatStore.getState().groups || []);
      } finally {
        setLoading(false);
      }
    };

    if (groups.length > 0) {
      setRealGroups(groups);
      setLoading(false);
    } else {
      fetchGroups();
    }
  }, [groupKey]);

  const displayGroups = realGroups.filter(g => 
    (g.name || '').toLowerCase().includes(query.toLowerCase()) || 
    (g.about || '').toLowerCase().includes(query.toLowerCase())
  );

  const join = async (group) => {
    if (!identity?.pk || joiningId) return;
    setJoiningId(group.id);
    setError('');
    try {
      const profile = await loadGroupProfile(identity, group.id, group.name);
      const local = getMyGroups(identity.pk);
      const next = local.some((item) => item.id === profile.id)
        ? local.map((item) => item.id === profile.id ? { ...item, ...profile, isChannel: group.isChannel } : item)
        : [...local, { ...profile, isChannel: !!group.isChannel }];
      setMyGroups(identity.pk, next);
      useChatStore.getState().setGroups((groups) => [profile, ...(groups || []).filter((item) => item.id !== profile.id)]);
      useChatStore.getState().openChat('group', profile.id, { ...profile, isChannel: !!group.isChannel });
      onJoined?.();
    } catch (joinError) {
      console.error('[Discover] Could not join group:', joinError);
      setError(joinError?.message || 'Could not join that group.');
    } finally {
      setJoiningId('');
    }
  };

  return (
    <div className="relative flex h-full w-full flex-col bg-black">
      <div className="px-4 pb-2 pt-4">
        <h1 className="text-2xl font-bold tracking-tight text-white">Groups</h1>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-[#111] px-4 py-3">
          <Search size={16} className="text-white/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent text-[15px] text-white placeholder-white/30 focus:outline-none"
          />
        </div>
      </div>

      {error && <p role="alert" className="px-4 text-sm text-red-400">{error}</p>}
      <div className="flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center mt-20 text-white/40">
            <Loader2 size={32} className="animate-spin mb-4 text-blue-500" />
            <p className="text-sm">Searching the network...</p>
          </div>
        ) : displayGroups.length === 0 ? (
          <div className="text-center text-white/30 mt-20">
            <Users size={48} className="mx-auto mb-4 opacity-50" />
            <p>No groups found</p>
          </div>
        ) : (
          <div className="mx-4 overflow-hidden rounded-2xl border border-white/10 bg-[#111]">
          {displayGroups.map((group) => {
            const Icon = group.isChannel ? Megaphone : Users;
            return (
              <button
                type="button"
                key={group.id}
                onClick={() => join(group)}
                disabled={joiningId === group.id}
                className="flex w-full items-center justify-between border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5 disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black text-blue-500">
                    <Icon size={22} />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-semibold text-white">{group.name}</h3>
                    <p className="text-[13px] text-white/40 line-clamp-1">{group.about}</p>
                  </div>
                </div>
                <span className="rounded-2xl bg-blue-600 px-3 py-1.5 text-[13px] font-bold text-white">{joiningId === group.id ? '…' : 'Join'}</span>
              </button>
            );
          })}
          </div>
        )}
      </div>
    </div>
  );
}
