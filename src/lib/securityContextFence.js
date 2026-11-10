// A tab-local capability tied to an account-scoped durable incarnation.
// Local lock retires only this tab's fence; account removal and panic wipe
// remove the durable incarnation and invalidate every cooperating tab.
export const SECURITY_CONTEXT_KEY = 'cipher_security_context_v1';
const ownerPrefix = (owner) => `${SECURITY_CONTEXT_KEY}:${encodeURIComponent(owner)}:`;
const keyFor = (owner, incarnation) => `${ownerPrefix(owner)}${encodeURIComponent(incarnation)}`;
const validOwner = (owner) => typeof owner === 'string' && /^[0-9a-f]{64}$/i.test(owner);

export function assertSecurityContextOwner(fence, owner) {
  if (!validOwner(owner) || fence?.context?.owner !== owner || typeof fence.assertCurrent !== 'function') {
    const error = new Error('The account security context is unavailable.');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  }
  fence.assertCurrent();
}

function readRecord(storage, key) {
  try {
    const record = JSON.parse(storage.getItem(key) || 'null');
    return record && typeof record.owner === 'string'
      && typeof record.incarnation === 'string' && record.incarnation.length >= 16 ? record : null;
  } catch { return null; }
}

export function establishSecurityContext({ owner, storage = globalThis.localStorage,
  randomId = () => crypto.randomUUID() } = {}) {
  if (!validOwner(owner) || !storage) throw new Error('An authenticated owner and durable storage are required.');
  // Each tab gets a separate durable marker. This avoids the non-atomic
  // read/replace race that would otherwise let two simultaneous unlocks
  // invalidate one another. Account-wide invalidation removes every marker.
  const incarnation = randomId();
  if (typeof incarnation !== 'string' || incarnation.length < 16) {
    throw new Error('A valid security context incarnation is required.');
  }
  const key = keyFor(owner, incarnation);
  const record = JSON.stringify({ owner, incarnation });
  try {
    storage.setItem(key, record);
    const persisted = readRecord(storage, key);
    if (persisted?.owner !== owner || persisted.incarnation !== incarnation) {
      throw new Error('The security context changed while it was being established.');
    }
  } catch (error) {
    throw new Error(`Could not persist the security context: ${error?.message || error}`);
  }
  return Object.freeze({ owner, incarnation });
}

export function createSecurityContextFence({ context, storage = globalThis.localStorage,
  channel = null, onInvalidate = () => {} } = {}) {
  if (!validOwner(context?.owner) || typeof context?.incarnation !== 'string' || !storage) {
    throw new Error('A valid security context is required.');
  }
  let closed = false;
  let invalid = false;
  const invalidate = (reason) => {
    if (invalid) return;
    invalid = true;
    onInvalidate(reason);
  };
  const check = () => {
    if (closed || invalid) return false;
    const record = readRecord(storage, keyFor(context.owner, context.incarnation));
    if (record?.owner !== context.owner || record.incarnation !== context.incarnation) {
      invalidate('context-replaced-or-missing');
      return false;
    }
    return true;
  };
  const onStorage = (event) => {
    if (!event || event.key === keyFor(context.owner, context.incarnation) || event.key === null) check();
  };
  const onMessage = (event) => {
    if (event?.data?.type === 'invalidate'
      && event.data.owner === context.owner && event.data.incarnation === context.incarnation) {
      invalidate('peer-invalidation');
    }
  };
  globalThis.addEventListener?.('storage', onStorage);
  channel?.addEventListener?.('message', onMessage);
  return Object.freeze({
    context,
    isCurrent: check,
    assertCurrent() {
      if (!check()) {
        const error = new Error('The account security context has expired.');
        error.code = 'SECURITY_CONTEXT_EXPIRED';
        throw error;
      }
    },
    invalidate(reason = 'local-invalidation') { invalidate(reason); },
    close() {
      closed = true;
      globalThis.removeEventListener?.('storage', onStorage);
      channel?.removeEventListener?.('message', onMessage);
    },
  });
}

export function retireSecurityContext({ context, storage = globalThis.localStorage } = {}) {
  if (!validOwner(context?.owner) || typeof context?.incarnation !== 'string' || !storage) {
    return { retired: false, persisted: false, errors: ['A valid context and storage are required.'] };
  }
  const key = keyFor(context.owner, context.incarnation);
  try {
    storage.removeItem(key);
    const persisted = storage.getItem(key) === null;
    return { retired: persisted, persisted, errors: persisted ? [] : ['The local security context marker remains.'] };
  } catch (error) {
    return { retired: false, persisted: false, errors: [`storage:${error?.message || error}`] };
  }
}

// Durable invalidation is checked by suspended tabs when they resume. A
// broadcast is only a prompt; correctness comes from the persisted marker.
export function invalidateSecurityContext({ owner, storage = globalThis.localStorage,
  channel = null } = {}) {
  if (!validOwner(owner) || !storage) {
    return { invalidated: false, persisted: false, broadcast: false, errors: ['A valid owner and storage are required.'] };
  }
  let length;
  try { length = storage.length; } catch (error) {
    return { invalidated: false, persisted: false, broadcast: false, errors: [`enumerate:${error?.message || error}`] };
  }
  if (!Number.isSafeInteger(length) || typeof storage.key !== 'function') {
    return { invalidated: false, persisted: false, broadcast: false, errors: ['Security context storage cannot be enumerated.'] };
  }
  const prefix = ownerPrefix(owner);
  const contexts = [];
  const errors = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const record = readRecord(storage, key);
      if (record?.owner !== owner || key !== keyFor(owner, record.incarnation)) {
        errors.push('malformed: an account context marker is inconsistent');
        continue;
      }
      contexts.push({ key, incarnation: record.incarnation });
    }
  } catch (error) { errors.push(`enumerate:${error?.message || error}`); }
  let broadcast = false;
  for (const { key, incarnation } of contexts) {
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error('security context marker remains');
    } catch (error) { errors.push(`storage:${error?.message || error}`); }
    try {
      if (channel?.postMessage) {
        channel.postMessage({ type: 'invalidate', owner, incarnation });
        broadcast = true;
      }
    }
    catch (error) { errors.push(`broadcast:${error?.message || error}`); }
  }
  let persisted = false;
  try {
    persisted = true;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith(prefix)) persisted = false;
    }
  } catch (error) { errors.push(`verify:${error?.message || error}`); }
  return { invalidated: persisted, persisted, broadcast, errors };
}

export function invalidateAllSecurityContexts({ storage = globalThis.localStorage, channel = null } = {}) {
  let length;
  try { length = storage?.length; } catch (error) {
    return { invalidated: false, persisted: false, results: [], errors: [`enumerate:${error?.message || error}`] };
  }
  if (!storage || !Number.isSafeInteger(length)) {
    return { invalidated: false, persisted: false, results: [], errors: ['Security context storage cannot be enumerated.'] };
  }
  const owners = new Set();
  const errors = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key !== 'string' || !key.startsWith(`${SECURITY_CONTEXT_KEY}:`)) continue;
      try {
        const owner = decodeURIComponent(key.slice(`${SECURITY_CONTEXT_KEY}:`.length).split(':', 1)[0]);
        if (validOwner(owner)) owners.add(owner);
      } catch { errors.push('key:malformed security context owner key'); }
    }
  } catch (error) { errors.push(`enumerate:${error?.message || error}`); }
  const results = Array.from(owners, (owner) => invalidateSecurityContext({ owner, storage, channel }));
  if (results.some((result) => !result.persisted)) errors.push('one or more account context markers could not be cleared');
  return { invalidated: results.every((result) => result.invalidated), persisted: results.every((result) => result.persisted), results, errors };
}

export function listSecurityContextOwners({ storage = globalThis.localStorage } = {}) {
  if (!storage) return { owners: [], errors: ['Security context storage is unavailable.'] };
  const owners = new Set();
  const errors = [];
  try {
    const length = storage.length;
    if (!Number.isSafeInteger(length) || typeof storage.key !== 'function') {
      return { owners: [], errors: ['Security context storage cannot be enumerated.'] };
    }
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key !== 'string' || !key.startsWith(`${SECURITY_CONTEXT_KEY}:`)) continue;
      try {
        const owner = decodeURIComponent(key.slice(`${SECURITY_CONTEXT_KEY}:`.length).split(':', 1)[0]);
        if (validOwner(owner)) owners.add(owner);
        else errors.push('key:malformed security context owner key');
      } catch { errors.push('key:malformed security context owner key'); }
    }
  } catch (error) { errors.push(`enumerate:${error?.message || error}`); }
  return { owners: Array.from(owners), errors };
}
