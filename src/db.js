// src/db.js
import Dexie from 'dexie';
import { mergeStoredMessage, patchStoredMessage } from './lib/messageMerge';

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
  return _current;
}

// Restore DB connection if HMR reloads this module
try {
  const saved = localStorage.getItem('cipher_db_owner');
  if (saved) {
    const name = 'CipherDB_v7_' + saved.slice(0, 16);
    _current = makeDB(name);
    _currentOwner = saved;
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

// Queue for messages that arrive before DB is open
const pendingQueue = [];
export function flushQueue() {
  if (!_current) return;
  const q = pendingQueue.splice(0);
  q.forEach(item => {
    try { _current[item.table][item.method](...item.args); } catch(e) {}
  });
}

// Safe stub returned when accessed before openDBFor().
// Reads return empty, writes no-op. Prevents pre-login crashes.
const stubTable = (tableName) => ({
  toArray: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  put: (...args) => { pendingQueue.push({ table: tableName, method: 'put', args }); return Promise.resolve(); },
  add: (...args) => { pendingQueue.push({ table: tableName, method: 'add', args }); return Promise.resolve(); },
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
      if (['messages', 'chatReads', 'profiles', 'groups', 'groupKeys', 'groupKeyGrants', 'groupMemberSigs', 'outbox'].includes(prop)) {
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
    await db.transaction('rw', db.messages, async () => {
      const existing = await db.messages.get(msg.id);
      await db.messages.put(mergeStoredMessage(existing, msg, chatId));
    });
  } catch (error) {
    console.error('[db] Could not save message:', error);
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

export const saveProfile = async (profile) => {
  try { await db.profiles.put(profile); } catch (e) { console.error(e); }
};

