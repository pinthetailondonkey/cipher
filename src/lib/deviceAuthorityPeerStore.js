// Public signed authority checkpoints held by an enrolled peer. This store
// contains no private keys and has no relay/application call site.
import {
  verifyDeviceAuthorityPolicy, verifyDeviceAuthorityRegistry, verifyDeviceAuthorityReplacement,
} from './deviceAuthority.js';
import { verifyRecoveryRootReplacement } from './deviceAuthorityContactVerification.js';
import { assertDeviceAuthorityContext, withDeviceAuthorityContext } from './deviceAuthorityContext.js';

const STORE = 'peer-checkpoints';
const MAX_HISTORY = 512;

function dbName(accountPubkey) {
  if (!/^[0-9a-f]{64}$/.test(accountPubkey || '')) throw new Error('A valid account identity is required.');
  return `CipherAuthorityPeerV2_${accountPubkey.slice(0, 24)}`;
}

function openDb(accountPubkey, indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.reject(new Error('Local browser storage is unavailable for authority checkpoints.'));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName(accountPubkey), 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'accountPubkey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open peer authority checkpoint storage.'));
    request.onblocked = () => reject(new Error('Peer authority checkpoint storage is blocked by another tab.'));
  });
}

function verifyState(row, accountPubkey, recoveryPubkey, now) {
  if (!row || row.accountPubkey !== accountPubkey || row.recoveryPubkey !== recoveryPubkey
    || row.policyId !== row.policyEvent?.id || row.registryId !== row.registryEvent?.id
    || !Array.isArray(row.registryHistory) || row.registryHistory.length < 1 || row.registryHistory.length > MAX_HISTORY) {
    throw new Error('The stored peer authority checkpoint is missing or inconsistent.');
  }
  const policy = verifyDeviceAuthorityPolicy(row.policyEvent, {
    expectedAccount: accountPubkey, expectedRecovery: recoveryPubkey, now,
  });
  if (!policy) throw new Error('The stored recovery policy does not match the independently pinned identity.');
  let previousEvent = null;
  for (const event of row.registryHistory) {
    if (!verifyDeviceAuthorityRegistry(event, row.policyEvent, { previousEvent, now })) {
      throw new Error('The stored authority registry chain is invalid.');
    }
    previousEvent = event;
  }
  if (previousEvent?.id !== row.registryId || previousEvent?.id !== row.registryEvent.id) {
    throw new Error('The stored authority registry head does not match its signed history.');
  }
  return row;
}

function getRow(db, accountPubkey) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(accountPubkey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read peer authority checkpoint.'));
    transaction.onabort = () => reject(transaction.error || new Error('Peer authority checkpoint read was interrupted.'));
  });
}

function compareAndSwap(db, { nextRow, expectedPolicyId, expectedRegistryId, securityFence }) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get(nextRow.accountPubkey);
    let idempotent = false;
    request.onsuccess = () => {
      try { assertDeviceAuthorityContext(securityFence); }
      catch { transaction.abort(); return; }
      const current = request.result || null;
      if (current?.policyId === nextRow.policyId && current?.registryId === nextRow.registryId) {
        idempotent = true;
        return;
      }
      if ((current?.policyId ?? null) !== expectedPolicyId
        || (current?.registryId ?? null) !== expectedRegistryId) {
        transaction.abort();
        return;
      }
      store.put(nextRow);
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve({ policyId: nextRow.policyId, registryId: nextRow.registryId, idempotent });
    transaction.onerror = () => reject(transaction.error || new Error('Peer authority checkpoint could not be committed.'));
    transaction.onabort = () => reject(new Error('A competing policy or registry update won the local checkpoint.'));
  });
}

function checkpointRow({ policyEvent, registryHistory, accountPubkey, recoveryPubkey }) {
  const registryEvent = registryHistory.at(-1);
  return { accountPubkey, recoveryPubkey, policyEvent, policyId: policyEvent.id,
    registryHistory, registryEvent, registryId: registryEvent.id };
}

async function initializePeerDeviceAuthorityCore({ policyEvent, registryEvent, expectedAccountPubkey,
  expectedRecoveryPubkey, now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB,
  securityFence } = {}) {
  assertDeviceAuthorityContext(securityFence);
  if (!verifyDeviceAuthorityPolicy(policyEvent, { expectedAccount: expectedAccountPubkey,
    expectedRecovery: expectedRecoveryPubkey, now })
    || !verifyDeviceAuthorityRegistry(registryEvent, policyEvent, { now })
    || JSON.parse(registryEvent.content).generation !== 1) {
    throw new Error('Peer checkpoint initialization requires a pinned recovery policy and its genesis registry.');
  }
  const row = checkpointRow({ policyEvent, registryHistory: [registryEvent],
    accountPubkey: expectedAccountPubkey, recoveryPubkey: expectedRecoveryPubkey });
  const db = await openDb(expectedAccountPubkey, indexedDBImpl);
  try {
    assertDeviceAuthorityContext(securityFence);
    const existing = await getRow(db, expectedAccountPubkey);
    assertDeviceAuthorityContext(securityFence);
    if (existing) {
      verifyState(existing, expectedAccountPubkey, expectedRecoveryPubkey, now);
      if (existing.policyId === row.policyId && existing.registryId === row.registryId) {
        return { policyId: row.policyId, registryId: row.registryId, idempotent: true };
      }
      throw new Error('An existing peer checkpoint cannot be replaced by initialization.');
    }
    const result = await compareAndSwap(db, { nextRow: row, expectedPolicyId: null,
      expectedRegistryId: null, securityFence });
    assertDeviceAuthorityContext(securityFence);
    return result;
  } finally { db.close(); }
}

async function applyPeerDeviceRegistryUpdateCore({ update, expectedAccountPubkey, expectedRecoveryPubkey,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB, securityFence } = {}) {
  assertDeviceAuthorityContext(securityFence);
  if (update?.type !== 'registry-update' || !update.policyEvent?.id || !update.previousRegistryEvent?.id
    || !update.nextRegistryEvent?.id) throw new Error('A verified registry update is required.');
  const db = await openDb(expectedAccountPubkey, indexedDBImpl);
  try {
    const current = verifyState(await getRow(db, expectedAccountPubkey), expectedAccountPubkey, expectedRecoveryPubkey, now);
    assertDeviceAuthorityContext(securityFence);
    if (current.registryId === update.nextRegistryEvent?.id) {
      return { policyId: current.policyId, registryId: current.registryId, idempotent: true };
    }
    if (current.policyId !== update.policyEvent?.id || current.registryId !== update.previousRegistryEvent?.id) {
      throw new Error('The registry update does not extend the locally stored exact head.');
    }
    if (!verifyDeviceAuthorityRegistry(update.nextRegistryEvent, current.policyEvent,
      { previousEvent: current.registryEvent, now }) || current.registryHistory.length >= MAX_HISTORY) {
      throw new Error('The registry update is invalid or the local authenticated history is full.');
    }
    const nextRow = checkpointRow({ ...current, registryHistory: [...current.registryHistory, update.nextRegistryEvent] });
    const result = await compareAndSwap(db, { nextRow, expectedPolicyId: current.policyId,
      expectedRegistryId: current.registryId, securityFence });
    assertDeviceAuthorityContext(securityFence);
    return result;
  } finally { db.close(); }
}

async function applyPeerAuthorityReplacementCore({ update, expectedAccountPubkey, expectedRecoveryPubkey,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB, securityFence } = {}) {
  assertDeviceAuthorityContext(securityFence);
  if (update?.type !== 'authority-replacement') throw new Error('A verified authority replacement is required.');
  const db = await openDb(expectedAccountPubkey, indexedDBImpl);
  try {
    const current = verifyState(await getRow(db, expectedAccountPubkey), expectedAccountPubkey, expectedRecoveryPubkey, now);
    assertDeviceAuthorityContext(securityFence);
    if (current.policyId === update.nextPolicyEvent?.id && current.registryId === update.nextRegistryEvent?.id) {
      return { policyId: current.policyId, registryId: current.registryId, idempotent: true };
    }
    if (current.policyId !== update.previousPolicyEvent?.id
      || !verifyDeviceAuthorityReplacement(update.nextPolicyEvent, current.policyEvent,
        { recoveryPubkey: expectedRecoveryPubkey, now })
      || !verifyDeviceAuthorityRegistry(update.nextRegistryEvent, update.nextPolicyEvent, { now })
      || JSON.parse(update.nextRegistryEvent.content).generation !== 1) {
      throw new Error('The recovery update does not extend the locally stored policy head.');
    }
    const nextPolicy = JSON.parse(update.nextPolicyEvent.content);
    if (nextPolicy.accountPubkey !== expectedAccountPubkey || nextPolicy.recoveryPubkey !== expectedRecoveryPubkey) {
      throw new Error('The replacement policy changes the pinned account or recovery identity.');
    }
    const nextRow = checkpointRow({ policyEvent: update.nextPolicyEvent,
      registryHistory: [update.nextRegistryEvent], accountPubkey: expectedAccountPubkey,
      recoveryPubkey: expectedRecoveryPubkey });
    const result = await compareAndSwap(db, { nextRow, expectedPolicyId: current.policyId,
      expectedRegistryId: current.registryId, securityFence });
    assertDeviceAuthorityContext(securityFence);
    return result;
  } finally { db.close(); }
}

// Recovery-root changes are deliberately not inferred from an account-key or
// old-root signature. The caller must first complete the independent contact
// fingerprint ceremony and supply the exact displayed value here.
async function applyPeerRecoveryRootReplacementCore({ currentPolicyEvent, nextPolicyEvent,
  nextRegistryEvent, expectedAccountPubkey, expectedOldRecoveryPubkey, confirmedFingerprint,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB, securityFence } = {}) {
  assertDeviceAuthorityContext(securityFence);
  const db = await openDb(expectedAccountPubkey, indexedDBImpl);
  try {
    const row = await getRow(db, expectedAccountPubkey);
    assertDeviceAuthorityContext(securityFence);
    const nextRecoveryPubkey = (() => { try { return JSON.parse(nextPolicyEvent?.content || '').recoveryPubkey; } catch { return null; } })();
    if (row?.policyId === nextPolicyEvent?.id && row.registryId === nextRegistryEvent?.id
      && row.recoveryPubkey === nextRecoveryPubkey) {
      const accepted = verifyState(row, expectedAccountPubkey, nextRecoveryPubkey, now);
      return { policyId: accepted.policyId, registryId: accepted.registryId, idempotent: true };
    }
    const current = verifyState(row, expectedAccountPubkey, expectedOldRecoveryPubkey, now);
    if (current.policyId !== currentPolicyEvent?.id || current.policyEvent?.id !== currentPolicyEvent?.id) {
      throw new Error('Recovery replacement must extend the exact locally pinned policy.');
    }
    const verified = verifyRecoveryRootReplacement({ currentPolicyEvent, nextPolicyEvent, nextRegistryEvent,
      expectedAccountPubkey, expectedOldRecoveryPubkey, confirmedFingerprint, now });
    if (!verified) throw new Error('The new recovery fingerprint was not independently confirmed or the replacement is invalid.');
    const nextRow = checkpointRow({ policyEvent: nextPolicyEvent, registryHistory: [nextRegistryEvent],
      accountPubkey: expectedAccountPubkey, recoveryPubkey: verified.recoveryPubkey });
    const result = await compareAndSwap(db, { nextRow, expectedPolicyId: current.policyId,
      expectedRegistryId: current.registryId, securityFence });
    assertDeviceAuthorityContext(securityFence);
    return result;
  } finally { db.close(); }
}

async function loadPeerDeviceAuthorityCore({ expectedAccountPubkey, expectedRecoveryPubkey,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB, securityFence } = {}) {
  assertDeviceAuthorityContext(securityFence);
  const db = await openDb(expectedAccountPubkey, indexedDBImpl);
  try {
    const row = await getRow(db, expectedAccountPubkey);
    assertDeviceAuthorityContext(securityFence);
    return structuredClone(verifyState(row, expectedAccountPubkey, expectedRecoveryPubkey, now));
  } finally { db.close(); }
}

export function initializePeerDeviceAuthority(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => initializePeerDeviceAuthorityCore(args));
}

export function applyPeerDeviceRegistryUpdate(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => applyPeerDeviceRegistryUpdateCore(args));
}

export function applyPeerAuthorityReplacement(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => applyPeerAuthorityReplacementCore(args));
}

export function applyPeerRecoveryRootReplacement(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => applyPeerRecoveryRootReplacementCore(args));
}

export function loadPeerDeviceAuthority(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => loadPeerDeviceAuthorityCore(args));
}
