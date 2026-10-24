import { useState, useEffect } from 'react'
import { db, saveProfile } from './db'

let listeners = new Set();

export function updateProfileCache(pubkey, data) {
  saveProfile({ pubkey, ...data }).then(() => {
    listeners.forEach(listener => listener());
  });
}

export function useProfiles(pubkeys) {
  const [profiles, setProfiles] = useState({})

  useEffect(() => {
    const loadLocal = async () => {
      const localData = {};
      for (const pk of pubkeys) {
        if (!pk) continue;
        const p = await db.profiles.get(pk);
        if (p) localData[pk] = p;
      }
      setProfiles(prev => ({ ...prev, ...localData }));
    };
    if (pubkeys.length > 0) loadLocal();
  }, [pubkeys.join(',')])

  useEffect(() => {
    const listener = () => {
      const loadAll = async () => {
        const localData = {};
        for (const pk of pubkeys) {
          const p = await db.profiles.get(pk);
          if (p) localData[pk] = p;
        }
        setProfiles(localData);
      };
      loadAll();
    }
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [pubkeys.join(',')])

  useEffect(() => {
    if (!pubkeys || pubkeys.length === 0) return

    let active = true;
    let pool;
    const relays = ['wss://purplepag.es', 'wss://nos.lol', 'wss://relay.primal.net'];
    const fetchProfiles = async () => {
      const validPubkeys = pubkeys.filter(pk => typeof pk === 'string' && pk.length >= 8)
      const missing = [];
      for (const pk of validPubkeys) {
        const exists = await db.profiles.get(pk);
        if (!exists) missing.push(pk);
      }
      
      if (missing.length === 0) return

      try {
        const { SimplePool } = await import('nostr-tools')
        if (!active) return;
        pool = new SimplePool({ enablePing: true, enableReconnect: true })

        const events = await Promise.race([
          pool.querySync(relays, { kinds: [0], authors: missing }),
          new Promise(resolve => setTimeout(() => resolve([]), 4000))
        ]);
        
        // If no profiles found, DON'T create fake fallback profiles
        if (!active || events.length === 0) return;

        for (const ev of events) {
          try {
            const data = JSON.parse(ev.content)
            const profileData = {
              pubkey: ev.pubkey,
              name: data.display_name || data.name || ev.pubkey.slice(0, 8),
              displayName: data.display_name || data.name || ev.pubkey.slice(0, 8),
              picture: data.picture || null,
              about: data.about || ''
            }
            await saveProfile(profileData);
          } catch (e) {}
        }
        
        if (active) listeners.forEach(l => l());
      } catch (err) { console.error("Profile fetch error", err) }
      finally { pool?.close(relays); }
    }

    fetchProfiles()
    return () => {
      active = false;
      pool?.close(relays);
    };
  }, [pubkeys.join(',')])

  return profiles
}
