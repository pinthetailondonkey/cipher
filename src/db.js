// src/db.js
import Dexie from 'dexie';
import { mergeStoredMessage, patchStoredMessage } from './lib/messageMerge';
import { createWriteQueue } from './lib/writeQueue';

// Before openDBFor, writes queue here; opening the database applies them.
const writeQueue = createWriteQueue();

let _current = null;
let _currentOwner = null;
let _warnedOnce = false;

function makeDB(name) {
  const d = new Dexie(name);
  d.version(8).stores({
    messages: 'id, chatId, pubkey, timestamp, clientId, type',
    profiles: 'pubkey, name, displayName',
    groups: 'id, name',
    chatReads: 'chatId',
    groupKeys: '++id, &[groupId+epoch], groupId, epoch, isCurrent, obtainedAt',
    groupKeyGrants: '++id, &[groupId+pubkey+epoch], groupId, pubkey, epoch, sentAt',
    groupMemberSigs: '&groupId, members, updatedAt',
  });
  d.version(9).stores({
    messages: 'id, chatId, pubkey, timestamp, clientId, type',
    profiles: 'pubkey, name, displayName',
    groups: 'id, name',
    chatReads: 'chatId',
    groupKeys: '++id, &[groupId+epoch], groupId, epoch, isCurrent, obtainedAt',
    groupKeyGrants: '++id, &[groupId+pubkey+epoch], groupId, pubkey, epoch, sentAt',
    groupMemberSigs: '&groupId, members, updatedAt',
    outbox: '&id, kind, created_at, queuedAt',
  });
  // v10 adds tombstones: ids this device deleted, so a history fetch that
  // re-saves the relay copy cannot bring them back. Every v9 store is unchanged.
  d.version(10).stores({
    messages: 'id, chatId, pubkey, timestamp, clientId, type',
    profiles: 'pubkey, name, displayName',
    groups: 'id, name',
    chatReads: 'chatId',
    groupKeys: '++id, &[groupId+epoch], groupId, epoch, isCurrent, obtainedAt',
    groupKeyGrants: '++id, &[groupId+pubkey+epoch], groupId, pubkey, epoch, sentAt',
    groupMemberSigs: '&groupId, members, updatedAt',
    outbox: '&id, kind, created_at, queuedAt',
    tombstones: 'id, chatId',
  });
  return d;
}

export function openDBFor(pubkey) {
  if (!pubkey) return null;
  localStorage.setItem('cipher_db_owner', pubkey);
  if (_currentOwner === pubkey && _current) return _current;
  if (_current) { try { _current.close(); } catch (_) {} }
  const name = 'CipherDB_v7_' + pubkey.slice(0, 16);
  _current = makeDB(name);
  _currentOwner = pubkey;
  writeQueue.flush(_current);
  return _current;
}

// Restore DB connection if HMR reloads this module
try {
  const saved = localStorage.getItem('cipher_db_owner');
  if (saved) {
    const name = 'CipherDB_v7_' + saved.slice(0, 16);
    _current = makeDB(name);
    _currentOwner = saved;
    writeQueue.flush(_current);
  }
} catch (e) {}

export function closeDB() {
  if (_current) { try { _current.close(); } catch (_) {} }
  _current = null;
  _currentOwner = null;
}

export function currentOwner() { return _currentOwner; }

// Deletes one account's whole database: messages, group keys, grants, and its
// outbox. Used when that account is locked out. False when it did not go.
export function deleteAccountDatabase(pubkey) {
  if (!pubkey || typeof indexedDB === 'undefined') return Promise.resolve(false);
  if (_currentOwner === pubkey) closeDB();
  const name = 'CipherDB_v7_' + pubkey.slice(0, 16);
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => {
      console.error(`[db] Could not delete ${name}:`, request.error);
      resolve(false);
    };
    request.onblocked = () => {
      console.error(`[db] Deleting ${name} was blocked by another open tab.`);
      resolve(false);
    };
  });
}

// Safe stub returned when accessed before openDBFor().
// Reads return empty, and writes wait in writeQueue until the database opens.
const stubTable = (tableName) => ({
  toArray: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  put: (...args) => writeQueue.enqueue(tableName, 'put', args),
  add: (...args) => writeQueue.enqueue(tableName, 'add', args),
  clear: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  count: () => Promise.resolve(0),
  where: () => ({
    equals: () => ({
      sortBy: () => Promise.resolve([]),
      toArray: () => Promise.resolve([]),
      first: () => Promise.resolve(undefined),
      modify: () => Promise.resolve(0),
    }),
    between: () => ({ toArray: () => Promise.resolve([]) }),
    sortBy: () => Promise.resolve([]),
    toArray: () => Promise.resolve([]),
  }),
  filter: () => ({ toArray: () => Promise.resolve([]) }),
});

export const db = new Proxy({}, {
  get(_t, prop) {
    if (!_current) {
      if (!_warnedOnce) {
        _warnedOnce = true;
        console.warn('[db] accessed before openDBFor — returning empty stubs');
      }
      if (['messages', 'chatReads', 'profiles', 'groups', 'groupKeys', 'groupKeyGrants', 'groupMemberSigs', 'outbox', 'tombstones'].includes(prop)) {
        return stubTable(prop);
      }
      return () => Promise.resolve();
    }
    const v = _current[prop];
    return typeof v === 'function' ? v.bind(_current) : v;
  },
});

export const saveMessage = async (chatId, msg) => {
  try {
    if (!currentOwner()) {
      await db.messages.put({ ...msg, chatId });
      return;
    }
    await db.transaction('rw', db.messages, db.tombstones, async () => {
      const [existing, tombstone] = await Promise.all([db.messages.get(msg.id), db.tombstones.get(msg.id)]);
      const merged = mergeStoredMessage(existing, msg, chatId, { tombstoned: !!tombstone });
      if (merged) await db.messages.put(merged);
    });
  } catch (error) {
    console.error('[db] Could not save message:', error);
  }
};

// Deletes a message on this device and remembers that it did, in one
// transaction. False when nothing was written.
export const deleteMessageForGood = async (id, chatId) => {
  if (!currentOwner() || !id) return false;
  try {
    await db.transaction('rw', db.messages, db.tombstones, async () => {
      await db.messages.delete(id);
      await db.tombstones.put({ id, chatId: chatId || '', at: Date.now() });
    });
    return true;
  } catch (error) {
    console.error('[db] Could not delete the message:', error);
    return false;
  }
};

export const deletedMessageIds = async () => {
  if (!currentOwner()) return [];
  try {
    return (await db.tombstones.toArray()).map((row) => row.id);
  } catch (error) {
    console.error('[db] Could not read deleted messages:', error);
    return [];
  }
};

// Records a change this device made to a stored message, so it survives the
// next history fetch. False when nothing was written.
export const patchMessage = async (id, patch) => {
  if (!currentOwner()) return false;
  try {
    let written = false;
    await db.transaction('rw', db.messages, async () => {
      const existing = await db.messages.get(id);
      if (!existing) return;
      await db.messages.put(patchStoredMessage(existing, patch));
      written = true;
    });
    if (!written) console.error('[db] No stored message to change:', id);
    return written;
  } catch (error) {
    console.error('[db] Could not save the change to a message:', error);
    return false;
  }
};

// Test hook: lets the Playwright suite write through the app's own saveMessage
// and patchMessage, so a seeded row takes the same merge + tombstone
// transaction path as a real incoming message and a real vendor order update,
// instead of raw IndexedDB puts.
if (typeof window !== 'undefined') {
}

export const saveProfile = async (profile) => {
  try { await db.profiles.put(profile); } catch (e) { console.error(e); }
};


// Test seam: lets the UI specs drive the real save and patch paths.
if (typeof window !== "undefined") window.__cipher = { saveMessage, patchMessage };
