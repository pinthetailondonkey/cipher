const DB_NAME = 'cipher-commerce-wallet-allocator-v1';
const DB_VERSION = 3;
const CONTEXTS = 'securityContexts';

function contextRow(context) {
  if (!/^[0-9a-f]{64}$/i.test(context?.owner || '')
    || typeof context?.incarnation !== 'string' || context.incarnation.length < 16) {
    throw Object.assign(new Error('A live account security context is required.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
  }
  return { id: `${context.owner}:${context.incarnation}`, owner: context.owner, incarnation: context.incarnation };
}

function assertFence(securityFence, owner) {
  if (!securityFence) return null;
  if (securityFence.context?.owner !== owner) {
    throw Object.assign(new Error('The wallet allocation context belongs to another account.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
  }
  securityFence.assertCurrent();
  return contextRow(securityFence.context);
}

function assertActiveContext(tx, store, row, securityFence) {
  const request = store.get(row.id);
  request.onsuccess = () => {
    try {
      securityFence?.assertCurrent();
      if (request.result?.owner !== row.owner || request.result?.incarnation !== row.incarnation) {
        throw Object.assign(new Error('The wallet allocation security context is no longer active.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
      }
    } catch (error) {
      tx.__securityContextError = error;
      tx.abort();
    }
  };
  return request;
}

function openAllocator(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) throw Object.assign(new Error('Durable wallet allocation is unavailable on this device.'), { code: 'WALLET_ALLOCATION_UNAVAILABLE' });
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('heads')) db.createObjectStore('heads', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reservations')) {
        const reservations = db.createObjectStore('reservations', { keyPath: 'id' });
        reservations.createIndex('order', 'orderKey', { unique: true });
        reservations.createIndex('slot', 'slotKey', { unique: true });
      }
      // Keep a descriptor tombstone separately from its mutable allocation
      // head. If the head is lost while settings/history still identify this
      // descriptor, a later save must hold for recovery instead of restarting
      // at index 1.
      if (!db.objectStoreNames.contains('descriptors')) db.createObjectStore('descriptors', { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CONTEXTS)) {
        const contexts = db.createObjectStore(CONTEXTS, { keyPath: 'id' });
        contexts.createIndex('owner', 'owner');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function activateBitcoinAllocationContext(securityFence) {
  const row = contextRow(securityFence?.context);
  securityFence.assertCurrent();
  const db = await openAllocator();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CONTEXTS, 'readwrite');
      const store = tx.objectStore(CONTEXTS);
      const request = store.put(row);
      request.onsuccess = () => {
        try { securityFence.assertCurrent(); }
        catch (error) {
          tx.__securityContextError = error;
          tx.abort();
        }
      };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.__securityContextError || tx.error || Object.assign(new Error('Wallet allocation context activation was interrupted.'), { code: 'SECURITY_CONTEXT_EXPIRED' }));
      tx.onerror = () => reject(tx.error || new Error('Wallet allocation context could not be activated.'));
    });
    securityFence.assertCurrent();
    return true;
  } finally { db.close(); }
}

export async function retireBitcoinAllocationContext(context, indexedDBImpl = globalThis.indexedDB) {
  let row;
  try { row = contextRow(context); }
  catch (error) { return { retired: false, error: error.message }; }
  let db;
  try { db = await openAllocator(indexedDBImpl); }
  catch (error) { return { retired: false, error: error?.message || String(error) }; }
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CONTEXTS, 'readwrite');
      const store = tx.objectStore(CONTEXTS);
      const request = store.get(row.id);
      request.onsuccess = () => {
        const active = request.result;
        if (active?.owner === row.owner && active?.incarnation === row.incarnation) store.delete(row.id);
      };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('Wallet allocation context retirement was interrupted.'));
      tx.onerror = () => reject(tx.error || new Error('Wallet allocation context could not be retired.'));
    });
    const remaining = await new Promise((resolve, reject) => {
      const tx = db.transaction(CONTEXTS, 'readonly');
      const request = tx.objectStore(CONTEXTS).get(row.id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Wallet allocation context could not be verified.'));
      tx.onabort = () => reject(tx.error || new Error('Wallet allocation context verification was interrupted.'));
    });
    return { retired: !remaining };
  } catch (error) {
    return { retired: false, error: error?.message || String(error) };
  } finally { db.close(); }
}

export async function retireAccountBitcoinAllocationContexts(owner, indexedDBImpl = globalThis.indexedDB) {
  if (!/^[0-9a-f]{64}$/i.test(owner || '')) return { retired: false, error: 'A valid account identity is required.' };
  let db;
  try { db = await openAllocator(indexedDBImpl); }
  catch (error) { return { retired: false, error: error?.message || String(error) }; }
  try {
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(CONTEXTS, 'readwrite');
      const store = tx.objectStore(CONTEXTS);
      const request = store.index('owner').getAll(owner);
      request.onsuccess = () => {
        for (const row of request.result || []) store.delete(row.id);
      };
      tx.oncomplete = () => resolve((request.result || []).length);
      tx.onabort = () => reject(tx.error || new Error('Account wallet allocation contexts could not be retired.'));
      tx.onerror = () => reject(tx.error || new Error('Account wallet allocation contexts could not be retired.'));
    });
    return { retired: true, count };
  } catch (error) {
    return { retired: false, error: error?.message || String(error) };
  } finally { db.close(); }
}

export async function descriptorId(xpub, network) {
  const data = new TextEncoder().encode(`cipher-bip84-external-v1:${network}:${xpub}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function initializeBitcoinDescriptor({ owner, descriptor, explicitlyNew, securityFence = null }) {
  if (!explicitlyNew) return false;
  const context = assertFence(securityFence, owner);
  const db = await openAllocator();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(context ? ['heads', 'descriptors', CONTEXTS] : ['heads', 'descriptors'], 'readwrite');
      const store = tx.objectStore('heads');
      const descriptors = tx.objectStore('descriptors');
      if (context) assertActiveContext(tx, tx.objectStore(CONTEXTS), context, securityFence);
      const id = composite(owner, descriptor);
      const request = store.get(id);
      const descriptorRequest = descriptors.get(id);
      let created = false;
      let failure = null;
      let headValue;
      let descriptorValue;
      let reads = 0;
      const initialize = () => {
        reads += 1;
        if (reads !== 2) return;
        const head = headValue;
        if (head && !descriptorValue) {
          descriptors.add({ id, owner, descriptorId: descriptor, registeredAt: Date.now() });
        } else if (!head && descriptorValue) {
          failure = Object.assign(new Error('Wallet allocation history is missing. Restore from the authoritative allocation device or choose a fresh wallet descriptor.'), { code: 'WALLET_ALLOCATION_RECOVERY_REQUIRED' });
          tx.abort();
        } else if (!head) {
          store.add({ id, owner, descriptorId: descriptor, nextIndex: 1, revision: 0 });
          descriptors.add({ id, owner, descriptorId: descriptor, registeredAt: Date.now() });
          created = true;
        }
      };
      request.onsuccess = () => { headValue = request.result; initialize(); };
      descriptorRequest.onsuccess = () => { descriptorValue = descriptorRequest.result; initialize(); };
      tx.oncomplete = () => resolve(created);
      tx.onabort = () => reject(tx.__securityContextError || failure || tx.error || new Error('Wallet allocation initialization was interrupted.'));
      tx.onerror = () => reject(tx.error || new Error('Wallet allocation initialization failed.'));
    });
  } finally { db.close(); }
}

const composite = (...parts) => parts.map((part) => `${String(part).length}:${part}`).join('|');

export async function reserveBitcoinIndex({ owner, descriptor, orderId, securityFence = null }) {
  const context = assertFence(securityFence, owner);
  const db = await openAllocator();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(context ? ['heads', 'reservations', CONTEXTS] : ['heads', 'reservations'], 'readwrite');
      const heads = tx.objectStore('heads');
      const reservations = tx.objectStore('reservations');
      if (context) assertActiveContext(tx, tx.objectStore(CONTEXTS), context, securityFence);
      const headId = composite(owner, descriptor);
      const orderKey = composite(owner, orderId, 'btc');
      let result;
      const existingRequest = reservations.index('order').get(orderKey);
      existingRequest.onerror = () => tx.abort();
      existingRequest.onsuccess = () => {
        const existing = existingRequest.result;
        if (existing) {
          if (existing.owner !== owner || existing.descriptorId !== descriptor || existing.orderId !== orderId
            || !Number.isSafeInteger(existing.index) || existing.index < 1
            || existing.slotKey !== composite(owner, descriptor, existing.index)) {
            tx.abort();
            reject(Object.assign(new Error('Wallet allocation record is damaged. Restore from the authoritative allocation device or choose a fresh wallet descriptor.'), { code: 'WALLET_ALLOCATION_RECOVERY_REQUIRED' }));
            return;
          }
          result = existing;
          return;
        }
        const headRequest = heads.get(headId);
        headRequest.onerror = () => tx.abort();
        headRequest.onsuccess = () => {
          const head = headRequest.result;
          if (!head || head.id !== headId || head.owner !== owner || head.descriptorId !== descriptor
            || !Number.isSafeInteger(head.nextIndex) || head.nextIndex < 1) {
            tx.abort();
            reject(Object.assign(new Error('Wallet allocation history is missing or damaged. Restore from the authoritative allocation device or choose a fresh wallet descriptor.'), { code: 'WALLET_ALLOCATION_RECOVERY_REQUIRED' }));
            return;
          }
          const index = head.nextIndex;
          const next = { id: headId, owner, descriptorId: descriptor, nextIndex: index + 1, revision: (head.revision || 0) + 1 };
          result = { id: orderKey, orderKey, slotKey: composite(owner, descriptor, index), owner, descriptorId: descriptor, orderId, index, state: 'reserved' };
          heads.put(next);
          reservations.add(result);
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.__securityContextError || tx.error || new Error('Wallet reservation transaction was interrupted.'));
      tx.onerror = () => reject(tx.error || new Error('Wallet reservation transaction failed.'));
    });
  } finally { db.close(); }
}

export async function markBitcoinReservationReady({ owner, descriptor, orderId, index, securityFence = null }) {
  const context = assertFence(securityFence, owner);
  const db = await openAllocator();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(context ? ['reservations', CONTEXTS] : 'reservations', 'readwrite');
      const store = tx.objectStore('reservations');
      if (context) assertActiveContext(tx, tx.objectStore(CONTEXTS), context, securityFence);
      const key = composite(owner, orderId, 'btc');
      const request = store.get(key);
      request.onsuccess = () => {
        const row = request.result;
        if (!row || row.descriptorId !== descriptor || row.index !== index) { tx.abort(); return; }
        row.state = 'ready';
        store.put(row);
      };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.__securityContextError || tx.error || new Error('Bitcoin reservation could not be finalized.'));
      tx.onerror = () => reject(tx.error || new Error('Bitcoin reservation could not be finalized.'));
    });
  } finally { db.close(); }
}
