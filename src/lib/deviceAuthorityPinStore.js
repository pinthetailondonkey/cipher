// Public, monotonic recovery-policy pins for an isolated device authority
// prototype. This stores no private credentials and has no relay call site.
import { verifyDeviceAuthorityPolicy, verifyDeviceAuthorityReplacement } from './deviceAuthority.js';

const STORE = 'pins';

function dbName(accountPubkey) {
  if (!/^[0-9a-f]{64}$/.test(accountPubkey || '')) throw new Error('A valid account identity is required.');
  return `CipherAuthorityPinsV2_${accountPubkey.slice(0, 24)}`;
}

function openDb(accountPubkey, indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.reject(new Error('Local browser storage is unavailable for authority pins.'));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName(accountPubkey), 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'accountPubkey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open authority pin storage.'));
    request.onblocked = () => reject(new Error('Authority pin storage is blocked by another tab.'));
  });
}

function checkedPolicy(policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now) {
  const policy = verifyDeviceAuthorityPolicy(policyEvent, {
    expectedAccount: expectedAccountPubkey,
    expectedRecovery: expectedRecoveryPubkey,
    now,
  });
  if (!policy) throw new Error('The authority policy does not match the independently authenticated account and recovery pins.');
  return policy;
}

function readPin(db, accountPubkey) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(accountPubkey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read the pinned authority policy.'));
    transaction.onabort = () => reject(transaction.error || new Error('Authority pin read was interrupted.'));
  });
}

function savePin(db, row, expectedPolicyId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get(row.accountPubkey);
    let idempotent = false;
    request.onsuccess = () => {
      const existing = request.result || null;
      if (existing?.policyId === row.policyId) {
        if (existing.recoveryPubkey !== row.recoveryPubkey || existing.authorityEpoch !== row.authorityEpoch) {
          transaction.abort();
          return;
        }
        idempotent = true;
        return;
      }
      if ((existing?.policyId ?? null) !== expectedPolicyId
        || (existing && (existing.recoveryPubkey !== row.recoveryPubkey
          || row.authorityEpoch !== existing.authorityEpoch + 1))
        || (!existing && expectedPolicyId !== null)) {
        transaction.abort();
        return;
      }
      store.put(row);
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve({ policyId: row.policyId, authorityEpoch: row.authorityEpoch, idempotent });
    transaction.onerror = () => reject(transaction.error || new Error('The pinned authority policy could not be committed.'));
    transaction.onabort = () => reject(new Error('The authority policy pin changed or the write was interrupted.'));
  });
}

function pinRow(policyEvent, policy) {
  return {
    accountPubkey: policy.accountPubkey,
    recoveryPubkey: policy.recoveryPubkey,
    authorityEpoch: policy.authorityEpoch,
    policyId: policyEvent.id,
    policyEvent,
  };
}

// Initial pinning must receive the recovery fingerprint through a separately
// authenticated ceremony; this function deliberately provides no TOFU path.
export async function pinInitialDeviceAuthorityPolicy({
  policyEvent, expectedAccountPubkey, expectedRecoveryPubkey,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB,
}) {
  const policy = checkedPolicy(policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now);
  if (policy.authorityEpoch !== 1) throw new Error('Initial policy pinning requires the recovery-root genesis policy.');
  const db = await openDb(policy.accountPubkey, indexedDBImpl);
  try {
    return await savePin(db, pinRow(policyEvent, policy), null);
  } finally {
    db.close();
  }
}

// A replacement is accepted only from the exact locally pinned predecessor.
// IndexedDB's read/write transaction is the cross-tab compare-and-swap gate.
export async function advanceDeviceAuthorityPolicyPin({
  currentPolicyEvent, nextPolicyEvent, expectedAccountPubkey, expectedRecoveryPubkey,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB,
}) {
  const current = checkedPolicy(currentPolicyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now);
  const next = verifyDeviceAuthorityReplacement(nextPolicyEvent, currentPolicyEvent, {
    recoveryPubkey: expectedRecoveryPubkey, now,
  });
  if (!next || next.accountPubkey !== expectedAccountPubkey) throw new Error('The authority policy update is not a valid recovery-signed successor.');
  const db = await openDb(current.accountPubkey, indexedDBImpl);
  try {
    const stored = await readPin(db, current.accountPubkey);
    if (stored?.policyId === nextPolicyEvent.id && stored.policyEvent?.id === nextPolicyEvent.id
      && stored.recoveryPubkey === expectedRecoveryPubkey && stored.authorityEpoch === next.authorityEpoch) {
      const storedPolicy = checkedPolicy(stored.policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now);
      if (storedPolicy.authorityEpoch === next.authorityEpoch) {
        return { policyId: stored.policyId, authorityEpoch: stored.authorityEpoch, idempotent: true };
      }
    }
    if (!stored || stored.policyId !== currentPolicyEvent.id || stored.recoveryPubkey !== expectedRecoveryPubkey
      || stored.authorityEpoch !== current.authorityEpoch || stored.policyEvent?.id !== currentPolicyEvent.id) {
      throw new Error('The authority update does not extend the locally pinned policy head.');
    }
    return await savePin(db, pinRow(nextPolicyEvent, next), currentPolicyEvent.id);
  } finally {
    db.close();
  }
}

export async function loadPinnedDeviceAuthorityPolicy({
  expectedAccountPubkey, expectedRecoveryPubkey,
  now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB,
}) {
  const db = await openDb(expectedAccountPubkey, indexedDBImpl);
  try {
    const row = await readPin(db, expectedAccountPubkey);
    if (!row || row.accountPubkey !== expectedAccountPubkey || row.recoveryPubkey !== expectedRecoveryPubkey
      || row.policyId !== row.policyEvent?.id) throw new Error('The locally pinned recovery policy is missing or inconsistent.');
    const policy = checkedPolicy(row.policyEvent, expectedAccountPubkey, expectedRecoveryPubkey, now);
    if (policy.authorityEpoch !== row.authorityEpoch) throw new Error('The local recovery policy checkpoint is inconsistent.');
    return { policyEvent: row.policyEvent, policyId: row.policyId, authorityEpoch: row.authorityEpoch, recoveryPubkey: row.recoveryPubkey };
  } finally {
    db.close();
  }
}
