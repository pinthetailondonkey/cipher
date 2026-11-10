// The panic wipe, as steps that cannot hold each other up.
//
// The old wipe ran as one try block: stop the relays, close the database,
// list the databases, delete them, clear storage, then reload from finally.
// A dynamic import that failed (a chunk that never arrives offline, a module
// that throws) jumped straight to the catch and the reload, so nothing was
// deleted and the screen looked like a wipe. Here every step has its own try
// and its own time limit, the destructive ones that cost nothing run first,
// and the reload comes only after every step was attempted. A step that
// fails is logged and listed in the result; it never skips another step.
import { accountDatabaseNames } from './accountDatabaseInventory.js';
import { SECURITY_CONTEXT_COORDINATION_DB } from './securityContextCoordination.js';

export const WIPE_STEP_LIMIT_MS = 3000;
export const WIPE_STOP_LIMIT_MS = 1000;

// Independent security databases must be present even when this browser cannot
// enumerate IndexedDB. Account-scoped databases use the same public prefix.
const FIXED_SECURITY_DATABASES = ['cipher-commerce-wallet-allocator-v1', SECURITY_CONTEXT_COORDINATION_DB];

const settleWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true }), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve({ value }); },
    (error) => { clearTimeout(timer); resolve({ error }); },
  );
});

const deleteDatabase = (indexedDB, name, log) => new Promise((resolve) => {
  let request;
  try {
    request = indexedDB.deleteDatabase(name);
  } catch (error) {
    log.error(`[panicWipe] Could not start deleting ${name}:`, error);
    resolve(false);
    return;
  }
  request.onsuccess = () => resolve(true);
  request.onerror = () => {
    log.error(`[panicWipe] Failed to delete IndexedDB database ${name}:`, request.error);
    resolve(false);
  };
  request.onblocked = () => {
    log.error(`[panicWipe] IndexedDB deletion was blocked for ${name}`);
    resolve(false);
  };
});

// env: { stop: [async fn], localStorage, sessionStorage, indexedDB,
//        serviceWorker, caches, reload, log }
// Every member is optional. Resolves with { failures } and never rejects.
export async function runPanicWipe(env = {}) {
  const log = env.log || console;
  const failures = [];
  const note = (step, detail) => {
    failures.push(step);
    log.error(`[panicWipe] ${step} did not finish:`, detail);
  };
  const attempt = async (step, fn, ms = WIPE_STEP_LIMIT_MS) => {
    let outcome;
    try {
      outcome = await settleWithin(fn(), ms);
    } catch (error) {
      outcome = { error };
    }
    if (outcome.error !== undefined) note(step, outcome.error);
    else if (outcome.timedOut) note(step, `no answer in ${ms} ms`);
    return outcome.value;
  };
  const attemptSync = (step, fn) => {
    try {
      return fn();
    } catch (error) {
      note(step, error);
      return undefined;
    }
  };

  try {
    // Names first: they are read from localStorage, which is cleared next.
    const names = new Set([...FIXED_SECURITY_DATABASES, ...(env.knownDatabaseNames || [])]);
    const accounts = [];
    attemptSync('read account list', () => {
      const owner = env.localStorage?.getItem('cipher_db_owner');
      if (/^[0-9a-f]{64}$/.test(owner || '')) accountDatabaseNames(owner).forEach((name) => names.add(name));
      const vaults = JSON.parse(env.localStorage?.getItem('cipher_vaults') || '{}');
      Object.keys(vaults).forEach((pubkey) => {
        accounts.push(pubkey);
        if (!/^[0-9a-f]{64}$/.test(pubkey)) return;
        accountDatabaseNames(pubkey).forEach((name) => names.add(name));
        // Peer checkpoint DBs are named by the remote account. Enumeration is
        // the only safe way to find them unless the owner supplies an inventory.
      });
    });

    // Peer checkpoint databases do not carry local-owner provenance. Panic
    // wipe relies on global IndexedDB enumeration for them; account removal
    // deliberately does not guess which peer store belongs to which owner.

    // Keys and the vault live in storage; erase them before anything that
    // could be slow. Cleared again at the end in case the app wrote meanwhile.
    attemptSync('clear localStorage', () => env.localStorage?.clear());
    attemptSync('clear sessionStorage', () => env.sessionStorage?.clear());

    // The device key of each saved account, from the list read above (the
    // vaults are already gone from storage, so nothing here can open them).
    // Keys held outside storage (the OS store, the Keystore) need this call.
    await attempt('device keys', async () => {
      if (!env.destroyKeys) return;
      const failed = await env.destroyKeys(accounts);
      if (Array.isArray(failed) && failed.length) throw new Error(`${failed.length} device key(s) could not be confirmed destroyed`);
    });

    // Quiet the app (relays, group sessions, open database). Each is its own
    // step and bounded; none of them gates the deletions below.
    await Promise.all((env.stop || []).map((fn, index) => attempt(`stop ${index + 1}`, fn, WIPE_STOP_LIMIT_MS)));

    await Promise.all([
      attempt('delete databases', async () => {
        if (!env.indexedDB) return;
        let enumerationAvailable = false;
        let enumerationError = null;
        try {
          enumerationAvailable = typeof env.indexedDB.databases === 'function';
          if (!enumerationAvailable) throw new Error('database enumeration is unavailable');
          const listed = typeof env.indexedDB.databases === 'function' ? await env.indexedDB.databases() : [];
          listed.forEach((database) => { if (database.name) names.add(database.name); });
        } catch (error) {
          enumerationError = error;
        }
        const results = await Promise.all(Array.from(names, (name) => deleteDatabase(env.indexedDB, name, log)));
        if (results.some((ok) => !ok)) throw new Error('some databases may remain');
        if (!enumerationAvailable || enumerationError) throw new Error(`Known databases were attempted, but others may remain: ${enumerationError?.message || enumerationError}`);
      }),
      attempt('service workers', async () => {
        if (!env.serviceWorker) return;
        const registrations = await env.serviceWorker.getRegistrations();
        const results = await Promise.allSettled(registrations.map((registration) => registration.unregister()));
        if (results.some((result) => result.status === 'rejected' || result.value === false)) throw new Error('one or more service workers may remain');
      }),
      attempt('caches', async () => {
        if (!env.caches) return;
        const cacheNames = await env.caches.keys();
        const results = await Promise.allSettled(cacheNames.map((name) => env.caches.delete(name)));
        if (results.some((result) => result.status === 'rejected' || result.value === false)) throw new Error('one or more caches may remain');
      }),
    ]);

    attemptSync('clear localStorage (final)', () => env.localStorage?.clear());
    attemptSync('clear sessionStorage (final)', () => env.sessionStorage?.clear());
  } catch (error) {
    note('wipe', error);
  } finally {
    attemptSync('reload', () => env.reload?.());
  }
  return { failures };
}
