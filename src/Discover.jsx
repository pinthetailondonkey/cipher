import React, { useState, useEffect } from 'react';
import { Search, Users, Megaphone, Loader2 } from 'lucide-react';
import Logo from './components/Logo';
import { useChatStore } from './store/chatStore';

export default function Discover() {
  const [query, setQuery] = useState('');
  const [realGroups, setRealGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const storeGroups = useChatStore((s) => s.groups) || [];

  useEffect(() => {
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
        setRealGroups(storeGroups);
      } finally {
        setLoading(false);
      }
    };

    if (storeGroups.length > 0) {
      setRealGroups(storeGroups);
      setLoading(false);
    } else {
      fetchGroups();
    }
  }, [storeGroups]);

  const displayGroups = realGroups.filter(g => 
    g.name.toLowerCase().includes(query.toLowerCase()) || 
    g.about.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full w-full relative">
      <div className="flex items-center gap-3 px-4 pt-4 pb-2 sticky top-0 z-10">
        <Logo size={32} />
        <h1 className="text-2xl font-bold tracking-tight text-white">Discover</h1>
      </div>

      <div className="px-4 py-3 sticky top-[60px] z-10">
        <div className="flex items-center gap-2 bg-[#111] border border-white/5 rounded-xl px-4 py-3 focus-within:border-blue-500/50 transition-colors">
          <Search size={18} className="text-white/40" />
          <input 
            type="text" 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search public groups..." 
            className="flex-1 bg-transparent text-[15px] text-white placeholder-white/40 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {loading ? (
          <div className="flex flex-col items-center justify-center mt-20 text-white/40">
            <Loader2 size={32} className="animate-spin mb-4 text-blue-500" />
            <p className="text-sm">Searching the network...</p>
          </div>
        ) : displayGroups.length === 0 ? (
          <div className="text-center text-white/30 mt-20">
            <Users size={48} className="mx-auto mb-4 opacity-50" />
            <p>No groups found on the network.</p>
          </div>
        ) : (
          displayGroups.map((group, i) => {
            const Icon = group.isChannel ? Megaphone : Users;
            return (
              <div 
                key={group.id} 
                className={`flex items-center justify-between px-4 py-3 hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer ${i !== displayGroups.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-[#111] border border-white/10 flex items-center justify-center text-blue-500 shrink-0">
                    <Icon size={22} />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-semibold text-white">{group.name}</h3>
                    <p className="text-[13px] text-white/40 line-clamp-1">{group.about}</p>
                  </div>
                </div>
                <button className="px-4 py-1.5 rounded-full border border-blue-500/50 text-blue-500 text-[13px] font-semibold hover:bg-blue-500/10 transition-colors">
                  Join
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
