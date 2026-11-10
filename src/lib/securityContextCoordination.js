// Cross-database ordering gate for account-incarnation retirement. Every
// standalone store operation and every retirement for an owner takes the same
// Web Lock; the durable marker remains until all per-database retirements
// complete. A crash releases the lock but leaves the marker for recovery.
export const SECURITY_CONTEXT_COORDINATION_DB = 'CipherSecurityContextCoordinationV1';
const DB_NAME = SECURITY_CONTEXT_COORDINATION_DB;
const STORE = 'contexts';
const inProcessQueues = new Map();

function rowFor(context) {
  if (!/^[0-9a-f]{64}$/i.test(context?.owner || '')
    || typeof context?.incarnation !== 'string' || context.incarnation.length < 16) {
    throw new Error('A valid account security context is required.');
  }
  return { id: `${context.owner}:${context.incarnation}`, owner: context.owner, incarnation: context.incarnation };
}

function database(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.reject(new Error('Durable security context coordination is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('owner', 'owner');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open security context coordination storage.'));
    request.onblocked = () => reject(new Error('Security context coordination storage is blocked by another tab.'));
  });
}

function transact(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    try { result = operation(tx.objectStore(STORE), tx); }
    catch (error) { try { tx.abort(); } catch { /* already settled */ } reject(error); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Security context coordination transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Security context coordination transaction was interrupted.'));
  });
}

async function withOwnerLock(owner, callback, { locks = globalThis.navigator?.locks } = {}) {
  const name = `cipher-security-context:${owner}`;
  if (locks?.request) return locks.request(name, { mode: 'exclusive' }, callback);
  // Node unit tests have no browser tabs. Do not use this fallback in a
  // browser: cross-tab safety there requires the platform Web Locks API.
  if (typeof window !== 'undefined') throw new Error('Cross-tab security context coordination is unavailable.');
  const previous = inProcessQueues.get(name) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  inProcessQueues.set(name, previous.then(() => current));
  await previous;
  try { return await callback(); }
  finally { release(); }
}

async function readRow(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read the security context marker.'));
    tx.onabort = () => reject(tx.error || new Error('Security context marker read was interrupted.'));
  });
}

export async function activateSharedSecurityContext(securityFence, options = {}) {
  const row = rowFor(securityFence?.context);
  if (typeof securityFence?.assertCurrent !== 'function') {
    throw new Error('A live account security context is required for activation.');
  }
  return withOwnerLock(row.owner, async () => {
    securityFence.assertCurrent();
    const db = await database(options.indexedDBImpl);
    try {
      await transact(db, 'readwrite', (store) => store.put(row));
      try { securityFence.assertCurrent(); }
      catch (error) {
        await transact(db, 'readwrite', (store) => store.delete(row.id));
        throw error;
      }
      return { active: true, id: row.id };
    } finally { db.close(); }
  }, options);
}

export async function withSharedSecurityContext(securityFence, callback, options = {}) {
  const row = rowFor(securityFence?.context);
  if (typeof securityFence?.assertCurrent !== 'function' || typeof callback !== 'function') {
    throw new Error('A live account security context and operation are required.');
  }
  return withOwnerLock(row.owner, async () => {
    securityFence.assertCurrent();
    const db = await database(options.indexedDBImpl);
    try {
      const current = await readRow(db, row.id);
      securityFence.assertCurrent();
      if (current?.owner !== row.owner || current?.incarnation !== row.incarnation) {
        throw Object.assign(new Error('The account incarnation has been durably retired.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
      }
      return await callback();
    } finally { db.close(); }
  }, options);
}

export async function retireSharedSecurityContext(context, retireResources, options = {}) {
  const row = rowFor(context);
  return withOwnerLock(row.owner, async () => {
    const result = await retireResources();
    if (result?.retired === false) return { retired: false, result };
    const db = await database(options.indexedDBImpl);
    try {
      await transact(db, 'readwrite', (store) => store.delete(row.id));
      return { retired: true, result };
    } finally { db.close(); }
  }, options);
}

export async function retireOwnerSharedSecurityContexts(owner, retireResources, options = {}) {
  if (!/^[0-9a-f]{64}$/i.test(owner || '')) throw new Error('A valid account owner is required.');
  return withOwnerLock(owner, async () => {
    const resources = await retireResources();
    if (resources?.retired === false) return { retired: false, resources };
    const db = await database(options.indexedDBImpl);
    try {
      const contexts = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).index('owner').getAll(owner);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Could not list retired account contexts.'));
        tx.onabort = () => reject(tx.error || new Error('Account context list was interrupted.'));
      });
      await transact(db, 'readwrite', (store) => {
        for (const context of contexts) store.delete(context.id);
      });
      return { retired: true, count: contexts.length, resources };
    } finally { db.close(); }
  }, options);
}

export const securityContextCoordinationInternals = Object.freeze({ rowFor, withOwnerLock });
