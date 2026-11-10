import Dexie from 'dexie';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const TEST_DB_PREFIX = 'CipherProtocolTest_v1_';

function randomId(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) throw new Error('Secure randomness is required for a protocol test identity.');
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseProtocolTestRelayAllowlist(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const values = raw.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const normalized = [];
  for (const value of values) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Protocol test relays must be complete local WebSocket URLs.'); }
    const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'ws:' || !localHost || !url.port || Number(url.port) < 1 || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Protocol test relays must use ws:// on loopback with an explicit port and no credentials or path.');
    }
    const canonical = `ws://${url.hostname}:${url.port}`;
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return normalized;
}

export function assertProtocolTestRelayAllowed(relayUrl, allowlist) {
  const allowed = Array.isArray(allowlist) ? allowlist : [];
  if (!allowed.length) throw new Error('Protocol test relay allowlist is missing. Test mode is disabled.');
  let requested;
  try { requested = new URL(String(relayUrl || '')); } catch { throw new Error('Protocol test relay is invalid.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(requested.hostname) || !requested.port || Number(requested.port) < 1
    || requested.username || requested.password || requested.search || requested.hash || requested.pathname !== '/') {
    throw new Error('Protocol test relay must be an allowlisted loopback endpoint without credentials or a path.');
  }
  const canonical = `${requested.protocol}//${requested.hostname}:${requested.port}`;
  if (requested.protocol !== 'ws:' || !allowed.includes(canonical)) {
    throw new Error('Protocol test relay is outside the configured local allowlist.');
  }
  return canonical;
}

function makeTestDatabase(runId, databaseFactory) {
  const name = `${TEST_DB_PREFIX}${runId}`;
  const database = databaseFactory(name);
  database.version(1).stores({
    run: '&id, createdAt, status',
    devices: '&deviceId, pubkey, createdAt',
    events: '&eventId, kind, createdAt, status',
  });
  return database;
}

function dexieFactory(name) {
  return new Dexie(name);
}

const isProtocolTestDatabaseName = (name) => /^CipherProtocolTest_v1_[a-f0-9]{32}$/.test(String(name || ''));

export async function listProtocolTestDatabases(indexedDb = globalThis.indexedDB) {
  if (typeof indexedDb?.databases !== 'function') {
    throw new Error('This browser cannot list isolated test runs for cleanup.');
  }
  const databases = await indexedDb.databases();
  return databases.map((database) => database.name).filter(isProtocolTestDatabaseName).sort();
}

export async function deleteProtocolTestDatabase(name, indexedDb = globalThis.indexedDB) {
  if (!isProtocolTestDatabaseName(name)) throw new Error('Refusing to delete a database outside the protocol test namespace.');
  if (!indexedDb?.deleteDatabase) throw new Error('IndexedDB is unavailable; test data was not deleted.');
  await new Promise((resolve, reject) => {
    const request = indexedDb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Test data deletion failed.'));
    request.onblocked = () => reject(new Error('Test data is still open in another tab. Close that tab and retry.'));
  });
  return { forgotten: true };
}

export async function startProtocolTestMode({
  buildEnabled,
  relayAllowlist,
  cryptoImpl = globalThis.crypto,
  databaseFactory = dexieFactory,
  keyFactory = generateSecretKey,
  publicKeyFor = getPublicKey,
  now = Date.now,
} = {}) {
  if (buildEnabled !== true) throw new Error('This build does not include protocol test mode.');
  const relays = parseProtocolTestRelayAllowlist(Array.isArray(relayAllowlist) ? relayAllowlist.join(' ') : relayAllowlist);
  if (!relays.length) throw new Error('Protocol test relay allowlist is missing. Test mode is disabled.');

  const runId = randomId(cryptoImpl);
  let identitySecret;
  let deviceSecret;
  let identity;
  let device;
  let database;
  try {
    identitySecret = keyFactory();
    identity = { pubkey: publicKeyFor(identitySecret), kind: 'disposable-test-identity' };
    deviceSecret = keyFactory();
    device = { deviceId: randomId(cryptoImpl), pubkey: publicKeyFor(deviceSecret) };
    database = makeTestDatabase(runId, databaseFactory);
    await database.open();
    await database.transaction('rw', database.run, database.devices, async () => {
      await database.run.put({ id: runId, createdAt: now(), status: 'active', relayAllowlist: relays });
      await database.devices.put({ deviceId: device.deviceId, pubkey: device.pubkey, createdAt: now() });
    });
  } catch (error) {
    database?.close();
    identitySecret?.fill(0);
    deviceSecret?.fill(0);
    throw error;
  }

  let active = true;
  let forgotten = false;
  const assertActive = () => {
    if (!active || forgotten) throw new Error('Protocol test mode is disabled.');
  };
  const stop = async () => {
    if (!active) return { disabled: true, held: true };
    active = false;
    identitySecret.fill(0);
    deviceSecret.fill(0);
    try {
      await database.run.update(runId, { status: 'held', stoppedAt: now() });
    } finally {
      database.close();
    }
    return { disabled: true, held: true };
  };
  const forget = async () => {
    if (active) await stop();
    forgotten = true;
    try {
      return await deleteProtocolTestDatabase(database.name);
    } catch (error) {
      forgotten = false;
      throw error;
    }
  };

  return {
    runId,
    databaseName: database.name,
    identity: { ...identity },
    device: { ...device },
    relayAllowlist: relays,
    assertActive,
    assertRelayAllowed: (url) => { assertActive(); return assertProtocolTestRelayAllowed(url, relays); },
    stop,
    forget,
    get active() { return active; },
  };
}

export const PROTOCOL_TEST_BUILD = import.meta.env?.VITE_PROTOCOL_TEST_MODE === '1';
export const PROTOCOL_TEST_RELAY_ALLOWLIST = import.meta.env?.VITE_PROTOCOL_TEST_RELAYS || '';
export const PROTOCOL_TEST_DM_ENABLED = import.meta.env?.VITE_PROTOCOL_TEST_DM === '1';
export const PROTOCOL_TEST_MLS_ENABLED = import.meta.env?.VITE_PROTOCOL_TEST_MLS === '1';
