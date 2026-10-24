// src/db.js
import Dexie from 'dexie';

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
      const merged = { ...existing, ...msg, chatId };
      if (msg.deliveryStatus === undefined && existing?.deliveryStatus) {
        merged.deliveryStatus = existing.deliveryStatus;
      }
      await db.messages.put(merged);
    });
  } catch (error) {
    console.error('[db] Could not save message:', error);
  }
};

export const getMessages = async (chatId) => {
  return await db.messages.where('chatId').equals(chatId).sortBy('timestamp');
};

export const saveProfile = async (profile) => {
  try { await db.profiles.put(profile); } catch (e) { console.error(e); }
};

export const getProfile = async (pubkey) => {
  return await db.profiles.get(pubkey);
};

export const searchProfilesLocal = async (query) => {
  const lowerQuery = query.toLowerCase();
  return await db.profiles.filter(p =>
    (p.name && p.name.toLowerCase().includes(lowerQuery)) ||
    (p.displayName && p.displayName.toLowerCase().includes(lowerQuery))
  ).toArray();
};
