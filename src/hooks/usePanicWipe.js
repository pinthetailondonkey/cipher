import { useEffect, useRef } from 'react';
import { createShakeDetector, requestMotionAccess } from '../lib/shakeDetector';
import { runPanicWipe } from '../lib/panicWipe';
import { invalidateAllSecurityContexts } from '../lib/securityContextFence.js';
import { destroyDeviceKeys } from '../lib/deviceLock';
import { ensureDeviceProvider } from '../lib/deviceProvider';

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
          console.error('[panicWipe] Identity wipe failed; invoking the shared wipe coordinator:', error);
        }
      }
      try {
        const invalidation = invalidateAllSecurityContexts();
        const result = await runPanicWipe({
          stop: [
            async () => { const { clearSessionKey } = await import('../lib/sessionKey.js'); clearSessionKey(); },
            async () => { const { clearPool } = await import('../lib/pool.js'); clearPool(); },
            async () => { const { closeGroupSessions } = await import('./useNIP29Group.js'); closeGroupSessions(); },
            async () => { const { closeDB } = await import('../db.js'); closeDB(); },
          ],
          localStorage,
          sessionStorage,
          indexedDB: typeof indexedDB !== 'undefined' ? indexedDB : undefined,
          serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
          caches: 'caches' in window ? window.caches : undefined,
          destroyKeys: async (pubkeys) => destroyDeviceKeys(await ensureDeviceProvider(), pubkeys),
          reload: () => window.location.reload(),
        });
        if (!invalidation.persisted || result.failures.length) {
          console.error('[panicWipe] Shared wipe coordinator reported incomplete cleanup:', {
            invalidation, failures: result.failures,
          });
        }
      } catch (error) {
        console.error('[panicWipe] Shared wipe coordinator could not start:', error);
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
