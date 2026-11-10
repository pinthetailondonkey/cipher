// Primary-installation-only authority secret storage. The independent
// authority key is wrapped by a non-extractable WebCrypto key held in a
// separate local IndexedDB database, never by Cipher's shared account secret.
// Recovery-root material is deliberately not accepted by this API.
import { getPublicKey } from 'nostr-tools/pure';
import { verifyDeviceAuthorityPolicy, verifyDeviceAuthorityRegistry } from './deviceAuthority.js';
import { assertDeviceAuthorityContext, withDeviceAuthorityContext } from './deviceAuthorityContext.js';

const STORE = 'authority';
const encoder = new TextEncoder();

function dbName(accountPubkey) {
  if (!/^[0-9a-f]{64}$/.test(accountPubkey || '')) throw new Error('A valid account identity is required.');
  return `CipherPrimaryAuthorityV2_${accountPubkey.slice(0, 24)}`;
}

function openAuthorityDb(accountPubkey, indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.reject(new Error('Local browser storage is unavailable for the primary authority.'));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(dbName(accountPubkey), 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'accountPubkey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open primary authority storage.'));
    request.onblocked = () => reject(new Error('Primary authority storage is blocked by another tab.'));
  });
}

function aad({ accountPubkey, policyId, authorityEpoch, primaryDeviceId }) {
  return encoder.encode(`cipher-primary-authority-v2|${accountPubkey}|${policyId}|${authorityEpoch}|${primaryDeviceId}`);
}

function deviceAad({ accountPubkey, policyId, authorityEpoch, primaryDeviceId }) {
  return encoder.encode(`cipher-primary-device-v2|${accountPubkey}|${policyId}|${authorityEpoch}|${primaryDeviceId}`);
}

function readRow(db, accountPubkey) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(accountPubkey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read primary authority storage.'));
    transaction.onabort = () => reject(transaction.error || new Error('Primary authority read was interrupted.'));
  });
}

function putIfExpected(db, row, expectedPreviousPolicyId, securityFence) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get(row.accountPubkey);
    request.onsuccess = () => {
      try { assertDeviceAuthorityContext(securityFence); }
      catch { transaction.abort(); return; }
      const existing = request.result || null;
      if (existing) {
        if (!expectedPreviousPolicyId || existing.policyId !== expectedPreviousPolicyId
          || row.authorityEpoch !== existing.authorityEpoch + 1
          || row.accountPubkey !== existing.accountPubkey || row.recoveryPubkey !== existing.recoveryPubkey) {
          transaction.abort();
          return;
        }
      } else if (expectedPreviousPolicyId) {
        transaction.abort();
        return;
      }
      store.put(row);
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Primary authority storage could not be updated.'));
    transaction.onabort = () => reject(new Error('Primary authority state changed or the storage transaction was interrupted.'));
  });
}

function checkedPolicy(policyEvent, expectedRecoveryPubkey, now) {
  const body = JSON.parse(policyEvent?.content || 'null');
  const policy = verifyDeviceAuthorityPolicy(policyEvent, {
    expectedAccount: body?.accountPubkey,
    expectedRecovery: expectedRecoveryPubkey,
    now,
  });
  if (!policy) throw new Error('The pinned recovery policy is invalid.');
  return policy;
}

async function openAuthoritySecret({ policy, policyEvent, primaryDeviceSecret, row, expectedRegistryId, cryptoImpl }) {
  if (!(primaryDeviceSecret instanceof Uint8Array) || getPublicKey(primaryDeviceSecret) !== policy.primaryDevicePubkey) {
    throw new Error('This installation is not the primary device authorized to load the authority key.');
  }
  if (!row || row.policyId !== policyEvent.id || row.authorityEpoch !== policy.authorityEpoch
    || row.authorityPubkey !== policy.authorityPubkey || row.primaryDeviceId !== policy.primaryDeviceId
    || row.primaryDevicePubkey !== policy.primaryDevicePubkey || !row.wrappingKey
    || (expectedRegistryId && row.registryId !== expectedRegistryId)
    || row.registryEvent?.id !== row.registryId
    || !Array.isArray(row.iv) || row.iv.length !== 12 || !Array.isArray(row.ciphertext)) {
    throw new Error('The primary authority key is missing, stale, or belongs to another policy epoch.');
  }
  try {
    const secret = new Uint8Array(await cryptoImpl.subtle.decrypt({
      name: 'AES-GCM', iv: Uint8Array.from(row.iv), additionalData: aad(policy),
    }, row.wrappingKey, Uint8Array.from(row.ciphertext)));
    if (getPublicKey(secret) !== policy.authorityPubkey) {
      secret.fill(0);
      throw new Error('The stored primary authority key does not match the pinned policy.');
    }
    return secret;
  } catch {
    throw new Error('The primary authority key could not be opened by this installation.');
  }
}

async function storePrimaryAuthoritySecretCore({
  policyEvent, expectedRecoveryPubkey, primaryDeviceSecret, authoritySecret,
  registryEvent, expectedPreviousPolicyId = null, now = Math.floor(Date.now() / 1000),
  indexedDBImpl = globalThis.indexedDB, cryptoImpl = globalThis.crypto, securityFence,
}) {
  assertDeviceAuthorityContext(securityFence);
  const policy = checkedPolicy(policyEvent, expectedRecoveryPubkey, now);
  if (!(primaryDeviceSecret instanceof Uint8Array) || getPublicKey(primaryDeviceSecret) !== policy.primaryDevicePubkey
    || !(authoritySecret instanceof Uint8Array) || getPublicKey(authoritySecret) !== policy.authorityPubkey) {
    throw new Error('Only the policy-authorized primary installation can store its independent authority key.');
  }
  const registry = verifyDeviceAuthorityRegistry(registryEvent, policyEvent, { now });
  if (!registry || registry.generation !== 1) throw new Error('Primary authority setup requires its signed genesis registry.');
  if (!cryptoImpl?.subtle || !cryptoImpl?.getRandomValues) throw new Error('Secure primary-local cryptography is unavailable.');
  const wrappingKey = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const deviceIv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const metadata = {
    accountPubkey: policy.accountPubkey,
    recoveryPubkey: policy.recoveryPubkey,
    policyId: policyEvent.id,
    authorityEpoch: policy.authorityEpoch,
    authorityPubkey: policy.authorityPubkey,
    primaryDeviceId: policy.primaryDeviceId,
    primaryDevicePubkey: policy.primaryDevicePubkey,
    registryId: registryEvent.id,
    registryGeneration: registry.generation,
    registryEvent,
    wrappingKey,
    iv: Array.from(iv),
    deviceIv: Array.from(deviceIv),
    deviceCiphertext: Array.from(new Uint8Array(await cryptoImpl.subtle.encrypt(
      { name: 'AES-GCM', iv: deviceIv, additionalData: deviceAad(policy) }, wrappingKey, primaryDeviceSecret,
    ))),
    ciphertext: Array.from(new Uint8Array(await cryptoImpl.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(policy) }, wrappingKey, authoritySecret,
    ))),
  };
  const db = await openAuthorityDb(policy.accountPubkey, indexedDBImpl);
  try {
    assertDeviceAuthorityContext(securityFence);
    await putIfExpected(db, metadata, expectedPreviousPolicyId, securityFence);
    assertDeviceAuthorityContext(securityFence);
  } finally {
    db.close();
  }
  return { accountPubkey: policy.accountPubkey, policyId: policyEvent.id, authorityEpoch: policy.authorityEpoch };
}

async function loadPrimaryDeviceSecretCore({
  policyEvent, expectedRecoveryPubkey, now = Math.floor(Date.now() / 1000),
  indexedDBImpl = globalThis.indexedDB, cryptoImpl = globalThis.crypto, securityFence,
}) {
  assertDeviceAuthorityContext(securityFence);
  const policy = checkedPolicy(policyEvent, expectedRecoveryPubkey, now);
  const db = await openAuthorityDb(policy.accountPubkey, indexedDBImpl);
  let row;
  try { row = await readRow(db, policy.accountPubkey); }
  finally { db.close(); }
  assertDeviceAuthorityContext(securityFence);
  if (!row || row.policyId !== policyEvent.id || row.authorityEpoch !== policy.authorityEpoch
    || row.primaryDeviceId !== policy.primaryDeviceId || row.primaryDevicePubkey !== policy.primaryDevicePubkey
    || !row.wrappingKey || !Array.isArray(row.iv) || row.iv.length !== 12
    || !Array.isArray(row.deviceIv) || row.deviceIv.length !== 12
    || !Array.isArray(row.deviceCiphertext)) throw new Error('The primary device credential is unavailable for this policy.');
  try {
    const secret = new Uint8Array(await cryptoImpl.subtle.decrypt({
      name: 'AES-GCM', iv: Uint8Array.from(row.deviceIv), additionalData: deviceAad(policy),
    }, row.wrappingKey, Uint8Array.from(row.deviceCiphertext)));
    assertDeviceAuthorityContext(securityFence);
    if (getPublicKey(secret) !== policy.primaryDevicePubkey) {
      secret.fill(0);
      throw new Error('The stored primary device credential does not match the pinned policy.');
    }
    return secret;
  } catch {
    throw new Error('The primary device credential could not be opened by this installation.');
  }
}

async function loadPrimaryAuthoritySecretCore({
  policyEvent, expectedRecoveryPubkey, primaryDeviceSecret,
  expectedRegistryId, now = Math.floor(Date.now() / 1000), indexedDBImpl = globalThis.indexedDB,
  cryptoImpl = globalThis.crypto, securityFence,
}) {
  assertDeviceAuthorityContext(securityFence);
  const policy = checkedPolicy(policyEvent, expectedRecoveryPubkey, now);
  const db = await openAuthorityDb(policy.accountPubkey, indexedDBImpl);
  let row;
  try {
    row = await readRow(db, policy.accountPubkey);
  } finally {
    db.close();
  }
  assertDeviceAuthorityContext(securityFence);
  const secret = await openAuthoritySecret({ policy, policyEvent, primaryDeviceSecret, row, expectedRegistryId, cryptoImpl });
  assertDeviceAuthorityContext(securityFence);
  return secret;
}

// Durable compare-and-swap for the sole registry writer. The caller must first
// obtain a signed successor from the current primary authority. Only one tab
// can advance a pinned head; after commit the exact event remains available
// for retry if delivery is interrupted.
async function commitPrimaryRegistryHeadCore({
  policyEvent, expectedRecoveryPubkey, primaryDeviceSecret, authoritySecret,
  previousRegistryEvent, nextRegistryEvent, now = Math.floor(Date.now() / 1000),
  indexedDBImpl = globalThis.indexedDB, securityFence,
}) {
  assertDeviceAuthorityContext(securityFence);
  const policy = checkedPolicy(policyEvent, expectedRecoveryPubkey, now);
  if (!(primaryDeviceSecret instanceof Uint8Array) || getPublicKey(primaryDeviceSecret) !== policy.primaryDevicePubkey
    || !(authoritySecret instanceof Uint8Array) || getPublicKey(authoritySecret) !== policy.authorityPubkey
    || !verifyDeviceAuthorityRegistry(nextRegistryEvent, policyEvent, { previousEvent: previousRegistryEvent, now })) {
    throw new Error('The proposed registry head is not authorized by the active primary policy.');
  }
  const db = await openAuthorityDb(policy.accountPubkey, indexedDBImpl);
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.get(policy.accountPubkey);
      request.onsuccess = () => {
        try { assertDeviceAuthorityContext(securityFence); }
        catch { transaction.abort(); return; }
        const row = request.result;
        if (!row || row.policyId !== policyEvent.id || row.registryId !== previousRegistryEvent.id
          || row.registryGeneration + 1 !== JSON.parse(nextRegistryEvent.content).generation) {
          transaction.abort();
          return;
        }
        row.registryId = nextRegistryEvent.id;
        row.registryGeneration += 1;
        row.registryEvent = nextRegistryEvent;
        store.put(row);
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('The registry head could not be committed.'));
      transaction.onabort = () => reject(new Error('The pinned registry head changed or the write was interrupted.'));
    });
  } finally {
    db.close();
  }
  assertDeviceAuthorityContext(securityFence);
  return { registryId: nextRegistryEvent.id, generation: JSON.parse(nextRegistryEvent.content).generation };
}

async function loadPrimaryAuthorityStateCore(options) {
  assertDeviceAuthorityContext(options.securityFence);
  const policy = checkedPolicy(options.policyEvent, options.expectedRecoveryPubkey, options.now ?? Math.floor(Date.now() / 1000));
  const db = await openAuthorityDb(policy.accountPubkey, options.indexedDBImpl ?? globalThis.indexedDB);
  try {
    const row = await readRow(db, policy.accountPubkey);
    assertDeviceAuthorityContext(options.securityFence);
    if (!row?.registryEvent || row.registryEvent.id !== row.registryId) throw new Error('The primary registry checkpoint is unavailable.');
    const authoritySecret = await openAuthoritySecret({
      policy, policyEvent: options.policyEvent, primaryDeviceSecret: options.primaryDeviceSecret,
      row, expectedRegistryId: options.expectedRegistryId, cryptoImpl: options.cryptoImpl ?? globalThis.crypto,
    });
    assertDeviceAuthorityContext(options.securityFence);
    return { authoritySecret, registryEvent: row.registryEvent, registryId: row.registryId, generation: row.registryGeneration };
  } finally {
    db.close();
  }
}

export function storePrimaryAuthoritySecret(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => storePrimaryAuthoritySecretCore(args));
}

export function loadPrimaryDeviceSecret(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => loadPrimaryDeviceSecretCore(args));
}

export function loadPrimaryAuthoritySecret(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => loadPrimaryAuthoritySecretCore(args));
}

export function commitPrimaryRegistryHead(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => commitPrimaryRegistryHeadCore(args));
}

export function loadPrimaryAuthorityState(args = {}) {
  return withDeviceAuthorityContext(args.securityFence, () => loadPrimaryAuthorityStateCore(args));
}
