// src/db.js
import Dexie from 'dexie';
import { mergeStoredMessage, patchStoredMessage } from './lib/messageMerge';
import { createWriteQueue } from './lib/writeQueue';
import {
  trySealMessageRow, openMessageRow, isSealedRow,
  queueAtRestWrite, takeAtRestWrites, requeueAtRestWrites, dropAtRestWrites,
} from './lib/messageAtRest';

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
  // v11 adds vendorReviews: the buyer's own reviews of completed deals,
  // keyed by the bound receipt hash (one review per deal). Reviews are
  // local-first like receipts — nothing here reaches a relay.
  d.version(11).stores({
    messages: 'id, chatId, pubkey, timestamp, clientId, type',
    profiles: 'pubkey, name, displayName',
    groups: 'id, name',
    chatReads: 'chatId',
    groupKeys: '++id, &[groupId+epoch], groupId, epoch, isCurrent, obtainedAt',
    groupKeyGrants: '++id, &[groupId+pubkey+epoch], groupId, pubkey, epoch, sentAt',
    groupMemberSigs: '&groupId, members, updatedAt',
    outbox: '&id, kind, created_at, queuedAt',
    tombstones: 'id, chatId',
    vendorReviews: '&receiptHash, vendorPubkey, createdAt',
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
  writeQueue.flush(flushTargetFor(_current));
  // Writes that waited in memory for this account's vault key can be stored
  // now (src/lib/messageAtRest.js).
  setTimeout(() => flushAtRestWrites(pubkey), 0);
  return _current;
}

// Rows that arrived while the vault was locked are sealed and stored now that
// the key is back. Each row is written behind its own get + merge so a
// pending relay copy cannot drop a local patch. Rows the flush cannot write —
// the database changed hands mid-batch, or the vault key went away again —
// are put back in the queue, never dropped (takeAtRestWrites already emptied
// it, so anything left here exists nowhere else).
async function flushAtRestWrites(owner) {
  if (!owner || _currentOwner !== owner || !_current) return;
  const rows = takeAtRestWrites(owner);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (_currentOwner !== owner || !_current) {
        requeueAtRestWrites(owner, rows.slice(i));
        return;
      }
      const [rawExisting, tombstone] = await Promise.all([
        _current.messages.get(row.id),
        _current.tombstones.get(row.id),
      ]);
      if (tombstone) continue;
      // The raw store returns the sealed envelope: open it before merging. A
      // merge over the envelope would carry `sealed` forward — the row's
      // payload AS OF AN EARLIER write — so `trySealMessageRow` would no-op
      // on the stale envelope while leaving the queued row's plaintext
      // fields next to it (src/lib/messageMerge.js spreads the row as stored).
      const existing = rawExisting ? await openMessageRow(rawExisting) : rawExisting;
      const merged = mergeStoredMessage(existing, row, row.chatId || existing?.chatId);
      if (merged) delete merged.sealed;
      const sealed = await trySealMessageRow(merged || row);
      if (sealed === null) {
        // The vault key went away again mid-flush: hold this row, do not
        // drop it and do not write it in plaintext.
        requeueAtRestWrites(owner, [row]);
        continue;
      }
      await _current.messages.put(sealed);
    } catch (error) {
      console.error('[db] A queued message could not be stored:', error);
    }
  }
}

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
  // Pending at-rest rows belong to the gone database.
  dropAtRestWrites(pubkey);
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

// A Dexie query on the messages table. `where(index)` returns a WhereClause,
// and `.equals()` / `.between()` / `.anyOf()` on it return the Collection that
// finally reads rows: every step is wrapped, so rows leave opened. Wrapping
// only the first step (as it once was) handed the raw sealed rows to every
// `where(...).equals(...).toArray()` caller, which then saw a shell with no
// data, no deliveryStatus and no order fields.
const isQuery = (value) => !!value && typeof value === 'object' && (typeof value.toArray === 'function' || typeof value.equals === 'function');
export function openQuery(query) {
  return new Proxy(query, {
    get(_t, member) {
      switch (member) {
        case 'first': return (...a) => query.first(...a).then((row) => (row ? openMessageRow(row) : row));
        case 'toArray': return () => query.toArray().then((rows) => Promise.all(rows.map(openMessageRow)));
        case 'sortBy': return (...a) => query.sortBy(...a).then((rows) => Promise.all(rows.map(openMessageRow)));
        case 'each': return (cb) => query.each(async (row, cursor) => cb(await openMessageRow(row), cursor));
        case 'modify': return () => Promise.reject(new Error('Messages are sealed at rest; modify() cannot be used on the messages table.'));
        default: {
          const v = query[member];
          if (typeof v !== 'function') return v;
          return (...a) => {
            const result = v.apply(query, a);
            return isQuery(result) ? openQuery(result) : result;
          };
        }
      }
    },
  });
}

// One message read or write through the at-rest layer (src/lib/messageAtRest.js).
const queryMessages = (table) => ({
  get: (id) => table.get(id).then((row) => (row ? openMessageRow(row) : row)),
  bulkGet: (ids) => table.bulkGet(ids).then((rows) => Promise.all(rows.map(openMessageRow))),
  toArray: () => table.toArray().then((rows) => Promise.all(rows.map(openMessageRow))),
  where: (...args) => openQuery(table.where(...args)),
});

// One message put through the at-rest layer. Without the vault key the row is
// held in memory for this account (messageAtRest) and never reaches disk.
const writeMessage = async (table, row) => {
  if (isSealedRow(row) || currentOwner() === null) return table.put(await trySealMessageRow(row) ?? row);
  const sealed = await trySealMessageRow(row);
  if (sealed === null) {
    queueAtRestWrite(currentOwner(), row);
    return;
  }
  return table.put(sealed);
};
// The app's view of the messages table: sealed on write, opened on read.
const messagesView = (table) => ({
  get: (id) => queryMessages(table).get(id),
  bulkGet: (ids) => queryMessages(table).bulkGet(ids),
  toArray: () => queryMessages(table).toArray(),
  where: (...args) => queryMessages(table).where(...args),
  put: (row) => writeMessage(table, row),
  add: (row) => writeMessage(table, row),
  bulkPut: async (rows, ...rest) => {
    const sealedRows = [];
    for (const row of rows) {
      const sealed = await writeSealedForRow(table, row);
      if (sealed === undefined) return rows.length;
      if (sealed !== null) sealedRows.push(sealed);
    }
    if (sealedRows.length) return table.bulkPut(sealedRows, ...rest);
  },
  clear: () => table.clear(),
  delete: (...args) => table.delete(...args),
  bulkDelete: (...args) => table.bulkDelete(...args),
  count: (...args) => table.count(...args),
});

async function writeSealedForRow(table, row) {
  if (isSealedRow(row)) return row;
  if (currentOwner() === null) return (await trySealMessageRow(row)) ?? row;
  const sealed = await trySealMessageRow(row);
  if (sealed === null) queueAtRestWrite(currentOwner(), row);
  return sealed;
}

// The flush target for writes queued before openDBFor (src/lib/writeQueue.js):
// the raw Dexie stores, except `messages` — a queued message written straight
// to the store would land in plaintext, bypassing the at-rest seal, so it
// must take the same view as every other message write.
function flushTargetFor(d) {
  return new Proxy({}, {
    get(_t, name) {
      if (name === 'messages') return messagesView(d.messages);
      return d[name];
    },
  });
}

// Restore DB connection if HMR reloads this module. Sits below the at-rest
// views so flushTargetFor resolves `messagesView` when the queue is applied.
try {
  const saved = localStorage.getItem('cipher_db_owner');
  if (saved) {
    const name = 'CipherDB_v7_' + saved.slice(0, 16);
    _current = makeDB(name);
    _currentOwner = saved;
    writeQueue.flush(flushTargetFor(_current));
  }
} catch (e) {}

export const db = new Proxy({}, {
  get(_t, prop) {
    if (!_current) {
      if (!_warnedOnce) {
        _warnedOnce = true;
        console.warn('[db] accessed before openDBFor — returning empty stubs');
      }
      if (['messages', 'chatReads', 'profiles', 'groups', 'groupKeys', 'groupKeyGrants', 'groupMemberSigs', 'outbox', 'tombstones', 'vendorReviews'].includes(prop)) {
        return stubTable(prop);
      }
      return () => Promise.resolve();
    }
    if (prop === 'messages') return messagesView(_current.messages);
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
    await db.transaction('rw', 'messages', 'tombstones', async () => {
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
    await db.transaction('rw', 'messages', 'tombstones', async () => {
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
    await db.transaction('rw', 'messages', async () => {
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

// Test seam: lets the UI specs drive the real save and patch paths.

export const saveProfile = async (profile) => {
  try { await db.profiles.put(profile); } catch (e) { console.error(e); }
};


// Test seam: lets the UI specs drive the real save and patch paths and read
// the opened message view (sealed rows come back unsealed).
export async function readStoredRows() {
  if (!currentOwner()) return [];
  return queryMessages(_current.messages).toArray();
}

if (typeof window !== "undefined") {
  window.__cipher = {
    saveMessage, patchMessage, readStoredRows,
    // Test seam: closeDB + openDBFor re-open the account's database. Writes
    // queued while it was closed — the write queue and the at-rest queue —
    // are applied on the open.
    closeDB, openDBFor,
  };
}
