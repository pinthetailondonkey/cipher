import { useEffect, useRef } from 'react';
import { createShakeDetector, requestMotionAccess } from '../lib/shakeDetector';

export function usePanicWipe(identity, enabled) {
  // useIdentity returns a new object every render; keep it in a ref so the
  // listener (and its arm delay) isn't torn down and re-armed on every render.
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // Ignore motion for 3 seconds after turning it on, so the tap itself does not wipe.
    const shaken = createShakeDetector({ armAt: Date.now() + 3000 });

    const triggerWipe = async () => {
      if (window.__PANIC_WIPING) return;
      window.__PANIC_WIPING = true;

      if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 300]);

      // Full wipe: every account's IndexedDB, caches, service workers, storage.
      const fullWipe = identityRef.current?.panicWipe;
      if (typeof fullWipe === 'function') {
        try {
          await fullWipe();
          return;
        } catch (error) {
          console.error('[panicWipe] Full wipe failed; running local fallback:', error);
        }
      }

      try {
        const names = new Set();
        if (typeof indexedDB !== 'undefined') {
          try {
            const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
            databases.forEach((database) => {
              if (database.name) names.add(database.name);
            });
          } catch (error) {
            console.warn('[panicWipe] IndexedDB enumeration failed:', error);
          }
          const owner = localStorage.getItem('cipher_db_owner');
          if (owner) names.add(`CipherDB_v7_${owner.slice(0, 16)}`);
          try {
            const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
            Object.keys(vaults).forEach((pubkey) => names.add(`CipherDB_v7_${pubkey.slice(0, 16)}`));
          } catch (error) {
            console.warn('[panicWipe] Could not read saved account database names:', error);
          }
          const deleteDatabase = (name) => new Promise((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve(true);
            request.onerror = () => {
              console.error(`[panicWipe] Could not delete ${name}:`, request.error);
              resolve(false);
            };
            request.onblocked = () => {
              console.error(`[panicWipe] Deletion was blocked for ${name}`);
              resolve(false);
            };
          });
          const results = await Promise.race([
            Promise.all(Array.from(names, deleteDatabase)),
            new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
          ]);
          if (results === null || results.some((success) => !success)) {
            console.error('[panicWipe] One or more local databases may remain.');
          }
        }
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.allSettled(registrations.map((registration) => registration.unregister()));
        }
        if ('caches' in window) {
          const cacheNames = await caches.keys();
          await Promise.allSettled(cacheNames.map((name) => caches.delete(name)));
        }
      } catch (error) {
        console.error('[panicWipe] Local fallback failed:', error);
      } finally {
        sessionStorage.clear();
        localStorage.clear();
        window.location.reload();
      }
    };

    const handleMotion = (event) => {
      if (shaken(event.accelerationIncludingGravity || event.acceleration)) triggerWipe();
    };

    const setup = async () => {
      // The Privacy toggle asks for access inside the tap; this covers a reload.
      if (await requestMotionAccess() !== 'granted') {
        console.warn('Motion access is not granted, so shake to wipe is off.');
        return;
      }
      if (!cancelled) window.addEventListener('devicemotion', handleMotion);
    };

    setup();

    return () => {
      cancelled = true;
      window.removeEventListener('devicemotion', handleMotion);
    };
  }, [enabled]);
}
