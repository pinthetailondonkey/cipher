// src/db.js
import Dexie from 'dexie';
import { mergeStoredMessage, patchStoredMessage, markReadThrough, replacedTempId, planTempSweep } from './lib/messageMerge';
import { createWriteQueue } from './lib/writeQueue';
import { clearSessionKey, setSessionKey } from './lib/sessionKey';
import { accountDatabaseNames } from './lib/accountDatabaseInventory.js';
import { assertSecurityContextOwner } from './lib/securityContextFence.js';
import {
  activateIndexedDbContext, assertIndexedDbContextActive, retireIndexedDbContext,
  runAuthorizedIndexedDbWrite, SECURITY_CONTEXT_STORE,
} from './lib/indexedDbContextGate.js';
import {
  trySealMessageRow, openMessageRow, isSealedRow,
  queueAtRestWrite, takeAtRestWrites, requeueAtRestWrites, dropAtRestWrites,
} from './lib/messageAtRest';

// Before openDBFor, writes queue here; opening the database applies them.
const writeQueue = createWriteQueue();

let _current = null;
let _currentOwner = null;
let _currentFence = null;
let _queuedOwner = null;
let _queuedFence = null;
let _contextActivation = Promise.resolve();
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
  // v12 adds groupMemberDocs: the owner-signed member-set document at rest
  // (MEMBERSHIP-DESIGN.md Step 1). Keyed by groupId+gen so a generation is
  // written once and never demoted; conflict pairs at one gen keep one row
  // per doc id.
  d.version(12).stores({
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
    groupMemberDocs: '&[groupId+gen+docId], groupId, gen, docId',
  });
  // v13 adds groupDocKeys: the per-group governance-doc content key (SEC-1),
  // one random secret per group created at genesis and rotated wherever chat
  // epochs rotate. Sealed at rest by the same law as groupKeys; a device
  // without it refuses to decrypt kind-30079 content instead of falling back
  // to a publicly derivable key.
  d.version(13).stores({
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
    groupMemberDocs: '&[groupId+gen+docId], groupId, gen, docId',
    groupDocKeys: '&groupId, epoch',
  });
  // v14 stores device-scoped DM ratchet accounts/sessions and a sealed inbox
  // journal. The ratchet protocol state and journal payloads are separately
  // encrypted under the unlocked vault secret by ratchetStateAtRest.js.
  d.version(14).stores({
    ratchetDevices: '&deviceId, updatedAt',
    ratchetSessions: '&sessionId, peerPubkey, peerDeviceId, updatedAt',
    ratchetInbox: '&eventId, chatId, status, receivedAt',
  });
  // v15 stores the latest locally authenticated device-authority checkpoint.
  d.version(15).stores({
    deviceAuth: '&accountPubkey, generation, updatedAt',
  });
  // v16 adds isolated OpenMLS prototype snapshots and inbox journals. State
  // rows are encrypted by mlsStateTransactions.js before reaching IndexedDB.
  d.version(16).stores({
    mlsGroups: '&groupId, version, updatedAt',
    mlsInbox: '&eventId, groupId, status, receivedAt',
  });
  // v17 stores each contact's latest authenticated device registry. Registry
  // payloads are sealed at rest and arrive through a private DM envelope.
  d.version(17).stores({
    peerDeviceAuth: '&peerPubkey, generation, updatedAt',
  });
  // v18 briefly introduced the DM-only journal during local development.
  d.version(18).stores({
    dmEffects: '&effectKey, eventId, status, updatedAt',
  });
  // v19 generalizes the journal to cover DM and group message effects.
  d.version(19).stores({
    messageEffects: '&effectKey, eventId, status, updatedAt',
  });
  // v20 adds per-tab context markers. Every account data write in this build
  // must serialize through the same marker store as context retirement.
  d.version(20).stores({
    securityContexts: '&id, owner, incarnation',
  });
  // v21 adds the test-profile DM lane's sealed key/value rows (TEST-ONLY
  // lane behind the per-account opt-in): the SealedSessionStore adapter
  // treats this table as a bag of {key,value} records under one primary
  // index. Sealing is applied before put; no plaintext ever lands here.
  d.version(21).stores({
    laneState: 'key',
  });
  return d;
}

export function openDBFor(pubkey, securityFence = null) {
  if (!pubkey) return null;
  // A same-account reopen after `closeDB()` belongs to the captured
  // incarnation unless the caller supplies a newer fence. Keep that fence
  // when older non-UI call sites omit the optional argument; its live check
  // below still rejects it if lock, switch, removal, or wipe retired it.
  const activeFence = securityFence
    || (_queuedOwner === pubkey ? _queuedFence : null);
  if (activeFence && (activeFence.context?.owner !== pubkey
    || typeof activeFence.assertCurrent !== 'function')) {
    throw new Error('The database requires a security context for the same account.');
  }
  activeFence?.assertCurrent();
  localStorage.setItem('cipher_db_owner', pubkey);
  if (_currentOwner === pubkey && _current) {
    _currentFence = activeFence;
    _queuedOwner = pubkey;
    _queuedFence = activeFence;
    _contextActivation = activateContextForCurrentDatabase(pubkey, activeFence);
    queueWriteFlush(pubkey, activeFence);
    return _current;
  }
  if (_current) { try { _current.close(); } catch (_) {} }
  const name = 'CipherDB_v7_' + pubkey.slice(0, 16);
  _current = makeDB(name);
  _currentOwner = pubkey;
  _currentFence = activeFence;
  _queuedOwner = pubkey;
  _queuedFence = activeFence;
  _contextActivation = activateContextForCurrentDatabase(pubkey, activeFence);
  queueWriteFlush(pubkey, activeFence);
  // Writes that waited in memory for this account's vault key can be stored
  // now (src/lib/messageAtRest.js).
  setTimeout(() => flushAtRestWrites(pubkey, activeFence), 0);
  return _current;
}

function activateContextForCurrentDatabase(owner, securityFence) {
  if (!securityFence) return Promise.resolve();
  if (securityFence.context?.owner !== owner) {
    return Promise.reject(new Error('The account database context belongs to another account.'));
  }
  const database = _current;
  return activateIndexedDbContext(database, securityFence.context).then(() => {
    securityFence.assertCurrent();
  });
}

function queueWriteFlush(owner, securityFence) {
  const database = _current;
  const ready = _contextActivation;
  void ready.then(() => {
    if (_currentOwner !== owner || _current !== database || _currentFence !== securityFence) return;
    return writeQueue.flush(flushTargetFor(database, owner, securityFence), {
      owner, securityFence, requireContext: Boolean(securityFence),
    });
  }).catch((error) => {
    if (error?.code !== 'SECURITY_CONTEXT_EXPIRED') {
      console.error('[db] Account context could not be activated; queued writes remain held:', error);
    }
  });
}

async function runAccountDbWrite(database, owner, securityFence, stores, callback) {
  await _contextActivation;
  if (_current !== database || _currentOwner !== owner) {
    throw new Error('The account database changed before the write could start.');
  }
  if (!securityFence) return database.transaction('rw', ...stores, callback);
  if (securityFence.context?.owner !== owner) {
    const error = new Error('The account database context belongs to another account.');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  }
  securityFence.assertCurrent();
  const currentTransaction = Dexie.currentTransaction;
  if (currentTransaction?.db === database
    && currentTransaction.storeNames?.includes(SECURITY_CONTEXT_STORE)) {
    await assertIndexedDbContextActive(database, securityFence.context);
    const result = await callback();
    securityFence.assertCurrent();
    return result;
  }
  return runAuthorizedIndexedDbWrite(database, {
    context: securityFence.context, stores,
  }, async () => {
    securityFence.assertCurrent();
    const result = await callback();
    securityFence.assertCurrent();
    return result;
  });
}

// Cross-module stores must pass the fence captured by their originating async
// operation. Using the current global DB fence here would let an old callback
// from a locked account join a later incarnation of the same account.
export async function runAccountDbWriteForFence(securityFence, stores, callback) {
  const owner = securityFence?.context?.owner;
  if (!owner || typeof securityFence?.assertCurrent !== 'function') {
    const error = new Error('A live account security context is required for this database write.');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  }
  securityFence.assertCurrent();
  await _contextActivation;
  const database = _current;
  if (!database || _currentOwner !== owner || _currentFence !== securityFence) {
    const error = new Error('The captured account security context no longer owns the open database.');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  }
  return runAccountDbWrite(database, owner, securityFence, stores,
    () => callback(database));
}

export async function waitForSecurityContextActivation() {
  await _contextActivation;
}

export async function retireDatabaseSecurityContext(context) {
  if (_current && _currentOwner === context?.owner) {
    try { await _contextActivation; } catch { /* retirement still attempts to remove any marker */ }
    return retireIndexedDbContext(_current, context);
  }
  const name = accountDatabaseNames(context?.owner)[0];
  const database = makeDB(name);
  try {
    await database.open();
    return await retireIndexedDbContext(database, context);
  } catch (error) {
    return { retired: false, error: error?.message || String(error) };
  } finally {
    try { database.close(); } catch { /* close best-effort after marker result */ }
  }
}

export async function retireAccountDatabaseContexts(owner) {
  const name = accountDatabaseNames(owner)[0];
  const database = makeDB(name);
  try {
    await database.open();
    return await database.transaction('rw', SECURITY_CONTEXT_STORE, async () => {
      const table = database.table(SECURITY_CONTEXT_STORE);
      const rows = await table.where('owner').equals(owner).toArray();
      for (const row of rows) await table.delete(row.id);
      const leftovers = await table.where('owner').equals(owner).count();
      return { retired: leftovers === 0, count: rows.length };
    });
  } catch (error) {
    return { retired: false, error: error?.message || String(error) };
  } finally {
    try { database.close(); } catch { /* close best-effort after marker result */ }
  }
}

// Rows that arrived while the vault was locked are sealed and stored now that
// the key is back. Each row is written behind its own get + merge so a
// pending relay copy cannot drop a local patch. Rows the flush cannot write —
// the database changed hands mid-batch, or the vault key went away again —
// are put back in the queue, never dropped (takeAtRestWrites already emptied
// it, so anything left here exists nowhere else).
async function flushAtRestWrites(owner, securityFence = _currentFence) {
  if (!owner || _currentOwner !== owner || !_current || securityFence !== _currentFence) return;
  try { securityFence?.assertCurrent(); } catch { return; }
  const database = _current;
  const rows = takeAtRestWrites(owner, securityFence);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (_currentOwner !== owner || _current !== database || _currentFence !== securityFence) {
        requeueAtRestWrites(owner, rows.slice(i), securityFence);
        return;
      }
      securityFence?.assertCurrent();
      const [rawExisting, tombstone] = await Promise.all([
        database.messages.get(row.id),
        database.tombstones.get(row.id),
      ]);
      securityFence?.assertCurrent();
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
      securityFence?.assertCurrent();
      if (sealed === null) {
        // The vault key went away again mid-flush: hold this row, do not
        // drop it and do not write it in plaintext.
        requeueAtRestWrites(owner, [row], securityFence);
        continue;
      }
      if (_currentOwner !== owner || _current !== database || _currentFence !== securityFence) {
        requeueAtRestWrites(owner, rows.slice(i), securityFence);
        return;
      }
      await runAccountDbWrite(database, owner, securityFence, ['messages'], async () => {
        securityFence?.assertCurrent();
        if (_currentOwner !== owner || _current !== database || _currentFence !== securityFence) {
          throw new Error('The account database changed while an at-rest row was being flushed.');
        }
        await database.messages.put(sealed);
        securityFence?.assertCurrent();
      });
    } catch (error) {
      if (error?.code === 'SECURITY_CONTEXT_EXPIRED') return;
      console.error('[db] A queued message could not be stored:', error);
    }
  }
}

export function closeDB() {
  if (_currentOwner) {
    _queuedOwner = _currentOwner;
    _queuedFence = _currentFence;
  }
  if (_current) { try { _current.close(); } catch (_) {} }
  _current = null;
  _currentOwner = null;
  _currentFence = null;
  _contextActivation = Promise.resolve();
}

export function currentOwner() { return _currentOwner; }

// Deletes one account's whole database: messages, group keys, grants, and its
// outbox. Used when that account is locked out. False when it did not go.
export { accountDatabaseNames };

export function deleteAccountDatabase(pubkey) {
  const names = accountDatabaseNames(pubkey);
  if (typeof indexedDB === 'undefined') return Promise.resolve({
    success: false, deleted: [], failures: names.map((name) => ({ name, status: 'unavailable' })),
  });
  if (_currentOwner === pubkey) closeDB();
  // Pending at-rest rows belong to the gone database.
  dropAtRestWrites(pubkey);
  return Promise.all(names.map((name) => new Promise((resolve) => {
    let request;
    try { request = indexedDB.deleteDatabase(name); }
    catch (error) {
      console.error(`[db] Could not start deleting ${name}:`, error);
      resolve({ name, status: 'failed', error: error?.message || String(error) });
      return;
    }
    request.onsuccess = () => resolve({ name, status: 'deleted' });
    request.onerror = () => {
      console.error(`[db] Could not delete ${name}:`, request.error);
      resolve({ name, status: 'failed', error: request.error?.message || 'IndexedDB deletion failed' });
    };
    request.onblocked = () => {
      console.error(`[db] Deleting ${name} was blocked by another open tab.`);
      resolve({ name, status: 'blocked' });
    };
  }))).then((resources) => ({
    success: resources.every((resource) => resource.status === 'deleted'),
    deleted: resources.filter((resource) => resource.status === 'deleted').map(({ name }) => name),
    failures: resources.filter((resource) => resource.status !== 'deleted'),
  }));
}

// Safe stub returned when accessed before openDBFor().
// Reads return empty, and writes wait in writeQueue until the database opens.
const stubTable = (tableName) => ({
  toArray: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  put: (...args) => writeQueue.enqueue(tableName, 'put', args,
    _queuedOwner && _queuedFence ? { owner: _queuedOwner, securityFence: _queuedFence } : null),
  add: (...args) => writeQueue.enqueue(tableName, 'add', args,
    _queuedOwner && _queuedFence ? { owner: _queuedOwner, securityFence: _queuedFence } : null),
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
  const database = _current;
  const owner = _currentOwner;
  const fence = _currentFence;
  fence?.assertCurrent();
  if (isSealedRow(row) || currentOwner() === null) {
    const sealed = await trySealMessageRow(row) ?? row;
    const result = await runAccountDbWrite(database, owner, fence, ['messages'], () => table.put(sealed));
    fence?.assertCurrent();
    return result;
  }
  const sealed = await trySealMessageRow(row);
  fence?.assertCurrent();
  if (sealed === null) {
    queueAtRestWrite(currentOwner(), row, _currentFence);
    return;
  }
  const result = await runAccountDbWrite(database, owner, fence, ['messages'], () => table.put(sealed));
  fence?.assertCurrent();
  return result;
};
// The app's view of the messages table: sealed on write, opened on read.
const messagesView = (table) => ({
  get: (id) => queryMessages(table).get(id),
  bulkGet: (ids) => queryMessages(table).bulkGet(ids),
  toArray: () => queryMessages(table).toArray(),
  where: (...args) => queryMessages(table).where(...args),
  put: (row) => writeMessage(table, row),
  add: (row) => writeMessage(table, row),
  // Change one stored message in place. The row is woken, the named fields
  // replace their top-level namesakes, and the whole row goes back down the
  // same seal-on-write door as put. IndexedDB's own update() writes straight
  // at the sealed bytes, so this view never offers it.
  update: async (id, changes) => {
    const row = await queryMessages(table).get(id);
    if (!row) return 0;
    await writeMessage(table, { ...row, ...changes });
    return 1;
  },
  bulkPut: async (rows, ...rest) => {
    const sealedRows = [];
    for (const row of rows) {
      const sealed = await writeSealedForRow(table, row);
      if (sealed === undefined) return rows.length;
      if (sealed !== null) sealedRows.push(sealed);
    }
    if (sealedRows.length) {
      return runAccountDbWrite(_current, _currentOwner, _currentFence, ['messages'], () => table.bulkPut(sealedRows, ...rest));
    }
  },
  clear: () => runAccountDbWrite(_current, _currentOwner, _currentFence, ['messages'], () => table.clear()),
  delete: (...args) => runAccountDbWrite(_current, _currentOwner, _currentFence, ['messages'], () => table.delete(...args)),
  bulkDelete: (...args) => runAccountDbWrite(_current, _currentOwner, _currentFence, ['messages'], () => table.bulkDelete(...args)),
  count: (...args) => table.count(...args),
});

async function writeSealedForRow(table, row) {
  if (isSealedRow(row)) return row;
  if (currentOwner() === null) return (await trySealMessageRow(row)) ?? row;
  const sealed = await trySealMessageRow(row);
  if (sealed === null) queueAtRestWrite(currentOwner(), row, _currentFence);
  return sealed;
}

// The flush target for writes queued before openDBFor (src/lib/writeQueue.js):
// the raw Dexie stores, except `messages` — a queued message written straight
// to the store would land in plaintext, bypassing the at-rest seal, so it
// must take the same view as every other message write.
function flushTargetFor(d, owner, securityFence) {
  return new Proxy({}, {
    get(_t, name) {
      if (name === 'messages') return messagesView(d.messages);
      const table = d[name];
      if (!table || typeof table.put !== 'function' || !securityFence) return table;
      return new Proxy(table, {
        get(target, member) {
          const value = target[member];
          if (!['put', 'add', 'bulkPut', 'update', 'delete', 'bulkDelete', 'clear'].includes(member)
            || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
          return (...args) => runAccountDbWrite(d, owner, securityFence, [String(name)], () => value.apply(target, args));
        },
      });
    },
  });
}

// Do not restore a database handle from the persisted owner string after HMR.
// That value names an account, but carries no proof that the same unlocked
// incarnation is still active. The authenticated application path calls
// openDBFor with its live fence and flushes only writes captured by that fence.

export const db = new Proxy({}, {
  get(_t, prop) {
    if (!_current) {
      if (!_warnedOnce) {
        _warnedOnce = true;
        console.warn('[db] accessed before openDBFor — returning empty stubs');
      }
      if (['messages', 'chatReads', 'profiles', 'groups', 'groupKeys', 'groupKeyGrants', 'groupMemberSigs', 'outbox', 'tombstones', 'vendorReviews', 'groupMemberDocs', 'ratchetDevices', 'ratchetSessions', 'ratchetInbox', 'mlsGroups', 'mlsInbox', 'deviceAuth', 'peerDeviceAuth', 'messageEffects'].includes(prop)) {
        return stubTable(prop);
      }
      return () => Promise.resolve();
    }
    if (prop === 'transaction') {
      const database = _current;
      const fence = _currentFence;
      return (...args) => {
        if (!fence) return database.transaction(...args);
        fence.assertCurrent();
        const callback = args.at(-1);
        if (typeof callback !== 'function') return database.transaction(...args);
        const [mode, ...requestedStores] = args.slice(0, -1);
        if (mode !== 'rw' && mode !== 'readwrite') {
          return database.transaction(...args.slice(0, -1), async (...callbackArgs) => {
            await _contextActivation;
            fence.assertCurrent();
            const result = await callback(...callbackArgs);
            fence.assertCurrent();
            return result;
          });
        }
        const stores = requestedStores.flat().filter((name) => typeof name === 'string');
        return runAuthorizedIndexedDbWrite(database, {
          context: fence.context,
          stores,
        }, async () => {
          fence.assertCurrent();
          const result = await callback(Dexie.currentTransaction);
          fence.assertCurrent();
          return result;
        });
      };
    }
    if (prop === 'messages') return messagesView(_current.messages);
    const v = _current[prop];
    if (v && typeof v === 'object' && typeof v.put === 'function') {
      const fence = _currentFence;
      if (!fence) return v;
      return new Proxy(v, {
        get(table, member) {
          const value = table[member];
          if (!['put', 'add', 'bulkPut', 'update', 'delete', 'bulkDelete', 'clear'].includes(member)
            || typeof value !== 'function') return typeof value === 'function' ? value.bind(table) : value;
          const database = _current;
          const owner = _currentOwner;
          return (...args) => runAccountDbWrite(database, owner, fence, [String(prop)], () => value.apply(table, args));
        },
      });
    }
    return typeof v === 'function' ? v.bind(_current) : v;
  },
});

export const saveMessage = async (chatId, msg) => {
  const database = _current;
  const owner = _currentOwner;
  const fence = _currentFence;
  if (!msg?.id) return;
  if (!database || !owner) {
    // A close can race a relay callback that already belongs to the current
    // account. Preserve that row with its captured owner/fence so a later
    // open can merge and seal it; the flush will discard it if the account
    // incarnation was retired in the meantime.
    const queuedOwner = _queuedOwner;
    const queuedFence = _queuedFence;
    if (!queuedOwner) return;
    try {
      queuedFence?.assertCurrent();
      queueAtRestWrite(queuedOwner, { ...msg, chatId }, queuedFence);
    } catch {
      // A retired callback is held out of both IndexedDB and the queue.
    }
    return;
  }
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      fence?.assertCurrent();
      if (_current !== database || _currentOwner !== owner || _currentFence !== fence) return;
      const rawExisting = await database.messages.get(msg.id);
      const existingFingerprint = rawExisting == null ? null : JSON.stringify(rawExisting);
      const [existing, tombstone] = await Promise.all([
        rawExisting ? openMessageRow(rawExisting) : rawExisting,
        database.tombstones.get(msg.id),
      ]);
      const merged = mergeStoredMessage(existing, msg, chatId, { tombstoned: !!tombstone });
      if (!merged) return;
      const sealed = await trySealMessageRow(merged);
      if (!sealed) {
        // `saveMessage` does not go through the table proxy below. Preserve
        // its merged row in the at-rest queue while locked so the next unlock
        // can re-read the existing sealed row, apply this update, and re-seal.
        queueAtRestWrite(owner, merged, fence);
        return;
      }
      fence?.assertCurrent();
      const result = await db.transaction('rw', 'messages', 'tombstones', async () => {
        const current = await database.messages.get(msg.id);
        if ((current == null ? null : JSON.stringify(current)) !== existingFingerprint) return 'retry';
        if (await database.tombstones.get(msg.id)) return 'tombstoned';
        await database.messages.put(sealed);
        // The real row is in: the temporary one it replaces goes in the same
        // transaction.
        const temp = replacedTempId(merged);
        if (temp) await database.messages.delete(temp);
        return 'saved';
      });
      if (result !== 'retry') return;
    }
    throw new Error('The message changed repeatedly while its update was being prepared.');
  } catch (error) {
    console.error('[db] Could not save message:', error);
  }
};

// Cross-tab receive-side insertion gate. Unlike saveMessage (which merges
// history and local patches), this reports which delivery won the unique-id
// race so unread counters and notifications do not repeat for the same event.
// Rows are sealed before entering the transaction; if the vault is locked,
// no in-memory queue is mistaken for a durable application effect.
export const saveMessageOnce = async (chatId, msg) => {
  const owner = currentOwner();
  if (!owner || !msg?.id || !_current) return { status: 'unavailable' };
  const row = { ...msg, chatId };
  try {
    const sealed = await trySealMessageRow(row);
    if (!sealed) return { status: 'locked' };
    return await db.transaction('rw', 'messages', 'tombstones', async () => {
      if (currentOwner() !== owner || !_current) return { status: 'unavailable' };
      const [existing, tombstone] = await Promise.all([
        _current.messages.get(msg.id),
        db.tombstones.get(msg.id),
      ]);
      if (tombstone) return { status: 'tombstoned' };
      if (existing) return { status: 'exists' };
      await _current.messages.add(sealed);
      return { status: 'inserted' };
    });
  } catch (error) {
    console.error('[db] Could not claim an incoming message:', error);
    return { status: 'failed', error };
  }
};

// The read marker of a chat, written to the database. It only moves forward:
// opening a chat and a message arriving into an open chat both call it, and a
// stale caller must not pull the marker back.
export const markChatRead = async (chatId, at = Math.floor(Date.now() / 1000), securityFence = null, owner = securityFence?.context?.owner) => {
  if (!currentOwner() || !chatId) return false;
  try {
    if (securityFence) assertSecurityContextOwner(securityFence, owner);
    await db.transaction('rw', 'chatReads', async () => {
      if (securityFence) assertSecurityContextOwner(securityFence, owner);
      const current = await db.chatReads.get(chatId);
      if (securityFence) assertSecurityContextOwner(securityFence, owner);
      if ((current?.lastRead || 0) >= at) return;
      await db.chatReads.put({ chatId, lastRead: at });
    });
    if (securityFence) assertSecurityContextOwner(securityFence, owner);
    return true;
  } catch (error) {
    console.error('[db] Could not save the read marker:', error);
    return false;
  }
};

// Settles temporary send rows a closed app left behind (see planTempSweep).
// Returns the plan that was applied.
export const sweepTempMessages = async () => {
  const database = _current;
  const owner = _currentOwner;
  const fence = _currentFence;
  if (!owner || !database) return null;
  try {
    const [rows, outbox] = await Promise.all([db.messages.toArray(), db.outbox.toArray()]);
    const plan = planTempSweep(rows, outbox.map((row) => row.event));
    const sealedUpdates = [];
    for (const [ids, deliveryStatus] of [[plan.queued, 'queued'], [plan.failed, 'failed']]) {
      for (const id of ids) {
        const row = rows.find((item) => item.id === id);
        const sealed = row && await trySealMessageRow({ ...row, deliveryStatus });
        if (!sealed) return null;
        sealedUpdates.push(sealed);
      }
    }
    fence?.assertCurrent();
    if (_current !== database || _currentOwner !== owner || _currentFence !== fence) return null;
    await db.transaction('rw', 'messages', async () => {
      for (const id of plan.remove) await database.messages.delete(id);
      for (const row of sealedUpdates) await database.messages.put(row);
    });
    return plan;
  } catch (error) {
    console.error('[db] Could not settle unsent messages:', error);
    return null;
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
  const database = _current;
  const owner = _currentOwner;
  const fence = _currentFence;
  if (!owner || !database || !id) return false;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      fence?.assertCurrent();
      if (_current !== database || _currentOwner !== owner || _currentFence !== fence) return false;
      const rawExisting = await database.messages.get(id);
      if (!rawExisting) return false;
      const fingerprint = JSON.stringify(rawExisting);
      const existing = await openMessageRow(rawExisting);
      const sealed = await trySealMessageRow(patchStoredMessage(existing, patch));
      if (!sealed) return false;
      fence?.assertCurrent();
      const result = await db.transaction('rw', 'messages', async () => {
        const current = await database.messages.get(id);
        if (!current || JSON.stringify(current) !== fingerprint) return 'retry';
        await database.messages.put(sealed);
        return 'saved';
      });
      if (result === 'saved') return true;
    }
    throw new Error('The message changed repeatedly while its update was being prepared.');
  } catch (error) {
    console.error('[db] Could not save the change to a message:', error);
    return false;
  }
};

// A peer's read receipt, written to the database: our own messages in that
// chat at or before `upTo` become 'read'. Returns the ids changed. The next
// history fetch re-saves the relay copy as 'sent' and the merge keeps 'read'.
export const markSentMessagesRead = async (chatId, upTo) => {
  const database = _current;
  const owner = _currentOwner;
  const fence = _currentFence;
  if (!owner || !database || !chatId) return [];
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      fence?.assertCurrent();
      if (_current !== database || _currentOwner !== owner || _currentFence !== fence) return [];
      const rawRows = await database.messages.where('chatId').equals(chatId).toArray();
      const openedRows = await Promise.all(rawRows.map(openMessageRow));
      const changed = markReadThrough(openedRows, upTo);
      const changedById = new Map(changed.map((row) => [row.id, row]));
      const sealedUpdates = await Promise.all(changed.map(trySealMessageRow));
      if (sealedUpdates.some((row) => !row)) return [];
      const fingerprints = new Map(rawRows.map((row) => [row.id, JSON.stringify(row)]));
      fence?.assertCurrent();
      const result = await db.transaction('rw', 'messages', async () => {
        for (const id of changedById.keys()) {
          const current = await database.messages.get(id);
          if (!current || JSON.stringify(current) !== fingerprints.get(id)) return 'retry';
        }
        for (const row of sealedUpdates) await database.messages.put(row);
        return 'saved';
      });
      if (result === 'saved') return changed.map((row) => row.id);
    }
    throw new Error('The message list changed repeatedly while read marks were being prepared.');
  } catch (error) {
    console.error('[db] Could not save the read mark:', error);
    return [];
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

// The seam is compiled in only when the build asks for it
// (VITE_TEST_HOOKS=1, `npm run build:ui-test`, which `npm run test:ui` runs
// first). An ordinary build, the one that ships, carries no window.__cipher:
// a page script or an extension could otherwise read every opened message row
// and write messages through it.
if (typeof window !== "undefined" && import.meta.env?.VITE_TEST_HOOKS === '1') {
  window.__cipher = {
    saveMessage, patchMessage, readStoredRows,
    readMessageEffects: () => db.messageEffects.toArray(),
    readOutboxRows: () => db.outbox.toArray(),
    // Test seam: the one-row change the payment check mark writes through, so
    // a spec can execute the product's writer instead of writing the field by
    // hand. Compiled out of the shipped build with the rest of this block.
    updateMessage: (id, changes) => db.messages.update(id, changes),
    // Test seam: closeDB + openDBFor re-open the account's database. Writes
    // queued while it was closed — the write queue and the at-rest queue —
    // are applied on the open.
    closeDB, openDBFor,
    // Test seam: the in-memory session key, which no storage holds any more
    // (src/lib/sessionKey.js). Clearing it is what removing the old
    // sessionStorage copy used to mean — the tab is locked with the database
    // still open — and setting it back is an unlock in place, no PIN and no
    // reload. A spec that wants the locked branch can reach it without
    // re-deriving the key it already has.
    clearSessionKey, setSessionKey,
  };
}
