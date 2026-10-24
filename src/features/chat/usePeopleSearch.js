import { db } from '../../db';
import { getAuthenticatedPool } from '../../lib/pool';
import { queryWithTimeout } from '../../lib/relays';
import { useChatStore } from '../../store/chatStore';
import { parseGroupReference, loadGroupProfile } from '../../hooks/useNIP29Group';

export function usePeopleSearch({ identity }) {
  const setToast = useChatStore((s) => s.setToast);
  const setView = useChatStore((s) => s.setView);

  const handleGlobalSearch = async (query) => {
    if (!query.trim()) return;
    const results = [];
    const state = useChatStore.getState();
    Object.entries(state.dms).forEach(([pubkey, msgs]) => {
      msgs.forEach(msg => {
        const text = msg.data?.message || '';
        if (text.toLowerCase().includes(query.toLowerCase())) {
          results.push({ type: 'dm', pubkey, msg, name: state.profiles[pubkey]?.displayName || pubkey.slice(0, 8), text });
        }
      });
    });
    Object.entries(state.groupMessages).forEach(([groupId, msgs]) => {
      msgs.forEach(msg => {
        try {
          const parsed = JSON.parse(msg.rawContent || '{}');
          if ((parsed.message || '').toLowerCase().includes(query.toLowerCase())) {
            const group = state.groups.find(g => g.id === groupId);
            results.push({ type: 'group', groupId, msg, name: group?.name || groupId.slice(0, 8), text: parsed.message });
          }
        } catch (e) {}
      });
    });
    setToast({ type: 'info', message: `Found ${results.length} results for "${query}"` });
    useChatStore.getState().setSearchResults(results);
    setView('search');
  };

  const handleSearch = async () => {
    const state = useChatStore.getState();
    if (!state.searchQuery.trim()) return;
    state.setIsSearching(true);
    state.setSearchResults([]);
    let rawQuery = state.searchQuery.trim();

    try {
      if (rawQuery.startsWith('http')) {
        const url = new URL(rawQuery);
        const gp = url.searchParams.get('group');
        const np = url.searchParams.get('naddr');
        if (gp) { rawQuery = gp; } 
        else if (np) {
          const { nip19 } = await import('nostr-tools');
          const d = nip19.decode(np);
          if (d.type === 'naddr') rawQuery = d.data.identifier;
        }
      }
    } catch (e) {}

    if (rawQuery.startsWith('@')) {
      const usernameToFind = rawQuery.slice(1).toLowerCase().trim();

      const loadExactProfile = async (pool, targetPubkey, fallbackName) => {
        let name = fallbackName;
        let picture = null;
        let profileEvents = await queryWithTimeout(
          pool,
          ['wss://relay.primal.net'],
          { kinds: [0], authors: [targetPubkey] },
          5000
        );
        if (profileEvents.length === 0) {
          profileEvents = await queryWithTimeout(
            pool,
            ['wss://nos.lol'],
            { kinds: [0], authors: [targetPubkey] },
            4000
          );
        }
        if (profileEvents.length > 0) {
          try {
            const parsed = JSON.parse(profileEvents[0].content);
            name = parsed.display_name || parsed.name || fallbackName;
            picture = parsed.picture || null;
          } catch (e) {}
        }
        state.setSearchResults([{ type: 'user', pubkey: targetPubkey, name, picture }]);
        state.setIsSearching(false);
      };

      try {
        const pool = await getAuthenticatedPool(identity);

        // Exact pubkey from the local vault (works even before relays index the new account).
        const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
        for (const [pk, data] of Object.entries(vaults)) {
          if ((data.handle || '').toLowerCase() === usernameToFind) {
            await loadExactProfile(pool, pk, '@' + usernameToFind);
            return;
          }
        }

        // Kind 10003 username registry, published to the same relays as the profile.
        const regEvents = await queryWithTimeout(
          pool,
          ['wss://relay.primal.net', 'wss://nos.lol'],
          { kinds: [10003], '#t': ['cipher_username_' + usernameToFind], limit: 10 },
          5000
        );
        const regMatch = regEvents.find((ev) => {
          const usernameTag = ev.tags?.find((t) => t[0] === 'username')?.[1];
          return !usernameTag || usernameTag.toLowerCase() === usernameToFind;
        });
        if (regMatch) {
          await loadExactProfile(pool, regMatch.pubkey, '@' + usernameToFind);
          return;
        }

        // NIP-50 on Primal, then confirm that hit with an exact author query.
        console.log('🔍 [Search] Using NIP-50 to find profile...');
        const searchEvents = await queryWithTimeout(
          pool,
          ['wss://relay.primal.net'],
          { kinds: [0], search: usernameToFind, limit: 20 },
          5000
        );
        const exact = searchEvents.find((ev) => {
          try {
            const parsed = JSON.parse(ev.content);
            const name = String(parsed.name || '').toLowerCase().replace(/^@/, '');
            const display = String(parsed.display_name || '').toLowerCase().replace(/^@/, '');
            return name === usernameToFind || display === usernameToFind;
          } catch (e) { return false; }
        });
        const chosen = exact || searchEvents[0];
        if (chosen) {
          await loadExactProfile(pool, chosen.pubkey, '@' + usernameToFind);
          return;
        }
      } catch (err) {
        console.error('Username search failed:', err);
      }

      state.setSearchResults([]);
      state.setIsSearching(false);
      return;
    }

    if (/^naddr1/i.test(rawQuery)) {
      try {
        const parsed = parseGroupReference(rawQuery);
        if (parsed.id) {
          const profile = await loadGroupProfile(identity, parsed.id);
          state.setSearchResults([{ type: 'group', id: profile.id, name: profile.name, isChannel: false, creator: profile.creator }]);
          state.setIsSearching(false);
          return;
        }
      } catch (error) {
        console.warn('[search] naddr group lookup failed:', error);
      }
    }

    rawQuery = rawQuery.replace(/^@/, '');
    if (/^[0-9a-f]{64,}$/i.test(rawQuery)) rawQuery = rawQuery.slice(0, 64);
    if (rawQuery.length >= 12 && rawQuery.length <= 20 && /^[a-z0-9_-]+$/i.test(rawQuery) && !rawQuery.includes(' ')) {
      state.setSearchResults([{ type: 'group', id: rawQuery, name: 'Group ' + rawQuery, isChannel: false, creator: '' }]);
      state.setIsSearching(false);
      return;
    }

    const isNpub = rawQuery.startsWith('npub1');
    const isHex = /^[0-9a-f]{64}$/i.test(rawQuery);
    const isPartialHex = /^[0-9a-f]{10,63}$/i.test(rawQuery);
    const isNip05 = rawQuery.includes('@');

    if (isPartialHex) {
      state.setSearchResults([{ type: 'group', id: rawQuery, name: 'Group ' + rawQuery, isChannel: false, creator: '' }]);
      state.setIsSearching(false);
      return;
    }
    
    let pool;
    try {
      const { SimplePool, nip19 } = await import('nostr-tools');
      pool = new SimplePool({ enablePing: true, enableReconnect: true });

      const localMatches = await db.profiles.filter(p => 
        (p.name && p.name.toLowerCase().includes(rawQuery.toLowerCase())) || 
        (p.displayName && p.displayName.toLowerCase().includes(rawQuery.toLowerCase()))
      ).toArray();

      if (localMatches.length > 0) {
        state.setSearchResults(localMatches.map(p => ({ type: 'user', pubkey: p.pubkey, name: p.displayName, picture: p.picture })));
        state.setIsSearching(false); return;
      }

      if (isNip05 && !isNpub) {
        const [name, domain] = rawQuery.split('@');
        try {
          const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
          const data = await res.json();
          const targetPubkey = data.names?.[name];
          if (targetPubkey) {
            state.setSearchResults([{ type: 'user', pubkey: targetPubkey, name, picture: null }]);
            state.setIsSearching(false); return;
          }
        } catch (e) {}
      }

      if (isNpub || isHex) {
        let targetPubkey = rawQuery;
        if (isNpub) {
          const decoded = nip19.decode(rawQuery);
          targetPubkey = decoded.data;
          if (typeof targetPubkey !== 'string') {
            targetPubkey = Array.from(targetPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
          }
        }
        state.setSearchResults([{ type: 'user', pubkey: targetPubkey, name: targetPubkey.slice(0, 8), picture: null }]);

        const profileEvents = await queryWithTimeout(
          pool,
          ['wss://relay.primal.net'],
          { kinds: [0], authors: [targetPubkey] },
          5000
        );

        if (profileEvents.length > 0) {
          try {
            const p = JSON.parse(profileEvents[0].content);
            state.setSearchResults([{ 
              type: 'user', pubkey: targetPubkey, 
              name: p.display_name || p.name || targetPubkey.slice(0, 8), 
              picture: p.picture 
            }]);
          } catch (e) {}
        }
        state.setIsSearching(false); return;
      }

      // --- VERTEX DVM PROFILE SEARCH ---
      let dvmPool;
      try {
        const { finalizeEvent } = await import('nostr-tools');
        dvmPool = new SimplePool();
        const requestEvent = finalizeEvent({
          kind: 5315,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['param', 'search', rawQuery], ['param', 'limit', '10']],
          content: ''
        }, identity.sk);

        await Promise.allSettled(dvmPool.publish(['wss://groups.aegispayhq.com'], requestEvent));

        const responseEvents = await Promise.race([
          dvmPool.querySync(['wss://groups.aegispayhq.com'], { kinds: [6315], '#e': [requestEvent.id] }),
          new Promise(resolve => setTimeout(() => resolve([]), 4000))
        ]);

        if (false && responseEvents.length > 0) {
          const responseEvent = responseEvents[0];
          const pubkeys = JSON.parse(responseEvent.content).map(p => p.pubkey);
          
          if (pubkeys.length > 0) {
            const profileEvents = await pool.querySync(['wss://groups.aegispayhq.com'], { kinds: [0], authors: pubkeys });
            const profiles = profileEvents.map(ev => {
              const data = JSON.parse(ev.content);
              return { type: 'user', pubkey: ev.pubkey, name: data.display_name || data.name || ev.pubkey.slice(0, 8), picture: data.picture };
            });
            state.setSearchResults(profiles);
            state.setIsSearching(false);
            return;
          }
        }
      } catch (dvmError) {
        console.warn("Vertex DVM search failed, falling back to NIP-50...", dvmError);
      } finally {
        dvmPool?.destroy();
      }

      const publicSearchRelays = ['wss://groups.aegispayhq.com'];
      const events = await Promise.race([
        Promise.all([
          pool.querySync(publicSearchRelays, { kinds: [0, 41], search: rawQuery, limit: 30 }),
          pool.querySync(['wss://groups.aegispayhq.com'], { kinds: [9002], limit: 200 })
        ]).then(res => [...res[0], ...res[1]]),
        new Promise(resolve => setTimeout(() => resolve([]), 4000))
      ]);

      const matchedProfiles = [];
      const matchedGroups = [];

      events.forEach(ev => {
        if (ev.kind === 0) {
          try {
            const d = JSON.parse(ev.content);
            matchedProfiles.push({ type: 'user', pubkey: ev.pubkey, name: d.display_name || d.name || ev.pubkey.slice(0, 8), picture: d.picture });
          } catch (e) {}
        } else if (ev.kind === 41) {
          try {
            const d = JSON.parse(ev.content);
            matchedGroups.push({ type: 'group', id: ev.tags.find(t => t[0] === 'd')?.[1], name: d.name, isChannel: d.isChannel, creator: ev.pubkey });
          } catch (e) {}
        } else if (ev.kind === 39000 || ev.kind === 9002) {
          const getTag = (t) => ev.tags.find(x => x[0] === t)?.[1];
          const groupId = getTag('h') || getTag('d');
          const groupName = getTag('name');
          if (groupId && groupName && groupName.toLowerCase().includes(rawQuery.toLowerCase())) {
            matchedGroups.push({
              type: 'group',
              id: groupId,
              name: groupName,
              isChannel: ev.tags.some((tag) => tag[0] === 'channel' || tag[0] === 'broadcast'),
              creator: ev.pubkey,
            });
          }
        }
      });

      const uniqueUsers = Array.from(new Map(matchedProfiles.map(p => [p.pubkey, p])).values());
      const uniqueGroups = Array.from(new Map(matchedGroups.map(g => [g.id, g])).values());
      state.setSearchResults([...uniqueUsers.slice(0, 10), ...uniqueGroups.slice(0, 10)]);
    } catch (err) { 
      console.error("Search failed entirely:", err); 
    } finally { 
      pool?.destroy();
      state.setIsSearching(false); 
    }
  };
  return { handleGlobalSearch, handleSearch };
}
