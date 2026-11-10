import { bech32 } from '@scure/base';
import { deriveMoneroAddress } from './moneroAddress';
import { checkPaymentAddress } from './paymentAddress';
import { getActivePubkey, migrateLegacyScope, scopedGet, scopedRaw, scopedSet } from './storage';
import { assertSecurityContextOwner } from './securityContextFence';
import { activateBitcoinAllocationContext, descriptorId, initializeBitcoinDescriptor,
  markBitcoinReservationReady, reserveBitcoinIndex } from './commerceWalletStore';
import { getPublicKey } from 'nostr-tools/pure';

const LEGACY_ADDRESS_KEYS = {
  btc: ['cipher_btc_address', 'cipher_btc'],
  xmr: ['cipher_xmr_address', 'cipher_xmr'],
};

// Older builds also wrote main addresses to device-wide keys, which handed
// one account's address to the buyers of another. A device with one account
// adopts them once. With more than one, nobody can say whose they were.
function adoptLegacyAddresses(storage) {
  if (!storage) return;
  let accounts = 0;
  try {
    accounts = Object.keys(JSON.parse(storage.getItem('cipher_vaults') || '{}') || {}).length;
  } catch {
    accounts = 0;
  }
  for (const [coin, keys] of Object.entries(LEGACY_ADDRESS_KEYS)) {
    const legacy = keys.map((key) => storage.getItem(key)).find(Boolean) || '';
    if (legacy && accounts <= 1 && !scopedGet(`${coin}_address`, '')) scopedSet(`${coin}_address`, legacy.trim());
    keys.forEach((key) => storage.removeItem(key));
  }
}

// A main receiving address belongs to one account and is read only from its scope.
export function readPaymentAddresses(storage = globalThis.localStorage) {
  adoptLegacyAddresses(storage);
  return { btc: scopedGet('btc_address', '') || '', xmr: scopedGet('xmr_address', '') || '' };
}

export function savePaymentAddresses({ btc = '', xmr = '' } = {}, securityFence) {
  const owner = securityFence?.context?.owner;
  assertSecurityContextOwner(securityFence, owner);
  if (getActivePubkey() !== owner) {
    const error = new Error('The active account changed before payment addresses could be saved.');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  }
  scopedSet('btc_address', String(btc).trim());
  scopedSet('xmr_address', String(xmr).trim());
  securityFence.assertCurrent();
}

const BITCOIN_HRP = { bc: 'bc', bcrt: 'bcrt' };

export function bitcoinHrp(network = 'bc') {
  const hrp = BITCOIN_HRP[String(network || 'bc').toLowerCase()];
  if (!hrp) throw new Error('Choose a Bitcoin network.');
  return hrp;
}
const CONFIG_KEY = 'advanced_vendor_payment_keys';
const MAX_DERIVATION_INDEX = 10000;
const settingsLocks = new Map();

function ownerSettingsKey(owner) { return `cipher_${owner}_${CONFIG_KEY}`; }

function assertOwner(identity, owner = identity?.pk, generation, fence = identity?.securityFence) {
  if (!identity?.sk || !owner || getPublicKey(identity.sk) !== owner) throw new Error('The unlocked account does not match the wallet settings owner.');
  if (fence) {
    if (fence.context?.owner !== owner) throw Object.assign(new Error('The wallet operation no longer belongs to the current account context.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
    fence.assertCurrent();
  }
  const active = localStorage.getItem('cipher_active_pubkey') || localStorage.getItem('cipher_db_owner') || 'guest';
  if (active !== owner) throw Object.assign(new Error('The active account changed during this payment operation.'), { code: 'WALLET_ACCOUNT_CHANGED' });
  if (generation !== undefined && localStorage.getItem('cipher_identity_session_generation') !== generation) {
    throw Object.assign(new Error('The unlocked account session changed during this payment operation.'), { code: 'WALLET_SESSION_CHANGED' });
  }
}

function defaultSettings() {
  return { btcXpub: '', xmrPrivateViewKey: '', btcNetwork: 'bc', btcIndex: 0, xmrIndex: 0, orders: {} };
}

async function deriveEncryptionKey(secretKey) {
  const material = await crypto.subtle.importKey('raw', secretKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('cipher-vendor-payment-settings-v1'),
    info: new TextEncoder().encode('local-only'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function readSettings(identity, owner = identity?.pk, generation, fence = identity?.securityFence) {
  if (!identity?.sk) throw new Error('Unlock your account to access vendor payment settings.');
  assertOwner(identity, owner, generation, fence);
  migrateLegacyScope();
  const raw = localStorage.getItem(ownerSettingsKey(owner));
  if (!raw) {
    const legacyRaw = owner.length >= 8 ? localStorage.getItem(`cipher_${owner.slice(0, 8)}_${CONFIG_KEY}`) : null;
    if (legacyRaw) throw Object.assign(new Error('Older wallet settings could not be assigned to this account safely. Resolve the shared legacy account prefix before changing payment settings.'), { code: 'WALLET_SETTINGS_RECOVERY_REQUIRED' });
    return defaultSettings();
  }
  const envelope = JSON.parse(raw);
  if (!Array.isArray(envelope.iv) || !Array.isArray(envelope.data)) {
    throw new Error('Stored vendor payment settings are invalid.');
  }
  const key = await deriveEncryptionKey(identity.sk);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(envelope.iv) },
    key,
    new Uint8Array(envelope.data),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  assertOwner(identity, owner, generation, fence);
  return { ...defaultSettings(), ...parsed, orders: parsed.orders || {} };
}

async function writeSettings(identity, settings, owner = identity?.pk, generation, fence = identity?.securityFence) {
  assertOwner(identity, owner, generation, fence);
  const key = await deriveEncryptionKey(identity.sk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(settings));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  assertOwner(identity, owner, generation, fence);
  localStorage.setItem(ownerSettingsKey(owner), JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted)),
  }));
}

export async function loadVendorPaymentConfig(identity) {
  const owner = identity?.pk;
  const generation = localStorage.getItem('cipher_identity_session_generation');
  const fence = identity?.securityFence;
  assertOwner(identity, owner, generation, fence);
  const { btcXpub, xmrPrivateViewKey, btcNetwork } = await readSettings(identity, owner, generation, fence);
  assertOwner(identity, owner, generation, fence);
  return { btcXpub, xmrPrivateViewKey, btcNetwork: bitcoinHrp(btcNetwork || 'bc') };
}

export async function saveVendorPaymentConfig(identity, { btcXpub, xmrPrivateViewKey, btcNetwork } = {}) {
  const owner = identity?.pk;
  const generation = localStorage.getItem('cipher_identity_session_generation');
  const fence = identity?.securityFence;
  assertOwner(identity, owner, generation, fence);
  const normalizedXpub = (btcXpub || '').trim();
  const normalizedViewKey = (xmrPrivateViewKey || '').trim().toLowerCase();
  const network = bitcoinHrp(btcNetwork || 'bc');
  if (normalizedXpub) {
    const { HDKey } = await import('@scure/bip32');
    const root = HDKey.fromExtendedKey(normalizedXpub);
    if (!root.publicKey || root.privateKey) throw new Error('Enter a public Bitcoin account xpub, not a private key.');
    root.deriveChild(0).deriveChild(0);
  }
  if (normalizedViewKey && !/^[0-9a-f]{64}$/.test(normalizedViewKey)) {
    throw new Error('The Monero private view key must be 64 hexadecimal characters.');
  }
  await withSettingsLock(identity.pk, async () => {
    const settings = await readSettings(identity, owner, generation, fence);
    assertOwner(identity, owner, generation, fence);
    if (fence) await activateBitcoinAllocationContext(fence);
    assertOwner(identity, owner, generation, fence);
    if (normalizedXpub && normalizedXpub !== settings.btcXpub) {
      const descriptor = await descriptorId(normalizedXpub, network);
      await initializeBitcoinDescriptor({ owner, descriptor, explicitlyNew: true, securityFence: fence });
    }
    await writeSettings(identity, {
      ...settings,
      btcXpub: normalizedXpub,
      xmrPrivateViewKey: normalizedViewKey,
      btcNetwork: network,
    }, owner, generation, fence);
  });
}

export async function deriveBitcoinAddress(xpub, index, network = 'bc') {
  const [{ HDKey }, { sha256 }, { ripemd160 }] = await Promise.all([
    import('@scure/bip32'),
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/legacy.js'),
  ]);
  const root = HDKey.fromExtendedKey(xpub);
  if (!root.publicKey || root.privateKey) throw new Error('The configured Bitcoin xpub is invalid.');
  const publicKey = root.deriveChild(0).deriveChild(index).publicKey;
  if (!publicKey) throw new Error('Could not derive a Bitcoin receiving key.');
  const publicKeyHash = ripemd160(sha256(publicKey));
  return bech32.encode(bitcoinHrp(network), [0, ...bech32.toWords(publicKeyHash)]);
}

function deriveMoneroSubaddress(primaryAddress, privateViewKey, index) {
  if (!primaryAddress) throw new Error('Add the vendor Monero main address before enabling subaddress rotation.');
  return deriveMoneroAddress({ primaryAddress, privateViewKey, account: 0, index });
}

async function withSettingsLock(pubkey, callback) {
  const previous = settingsLocks.get(pubkey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  settingsLocks.set(pubkey, queued);
  const run = async () => {
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (settingsLocks.get(pubkey) === queued) settingsLocks.delete(pubkey);
    }
  };
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(`cipher-vendor-payment-settings:${pubkey}`, run);
  }
  if (globalThis.window) {
    release();
    if (settingsLocks.get(pubkey) === queued) settingsLocks.delete(pubkey);
    throw Object.assign(new Error('This browser cannot safely coordinate wallet settings across tabs.'), { code: 'WALLET_ALLOCATION_UNAVAILABLE' });
  }
  return run();
}

export async function getOrderPaymentMethods(identity, orderId, mainAddresses, paymentPreference = 'xmr') {
  if (!identity?.pk || !identity?.sk || !orderId) {
    throw new Error('An unlocked vendor account and order ID are required.');
  }
  if (!['btc', 'xmr', 'both'].includes(paymentPreference)) {
    throw new Error('Choose a supported order payment method.');
  }
  const owner = identity.pk;
  const generation = localStorage.getItem('cipher_identity_session_generation');
  const fence = identity?.securityFence;
  assertOwner(identity, owner, generation, fence);
  return withSettingsLock(identity.pk, async () => {
    const settings = await readSettings(identity, owner, generation, fence);
    assertOwner(identity, owner, generation, fence);
    const existing = settings.orders[orderId];
    // An older build could leave an order parked on the account's shared
    // address. Re-accepting that order issues it a fresh address instead of
    // serving the shared one again. Bech32 is case-insensitive, so the
    // compare is. (security S1)
    const sharedLeak = existing && ((existing.btc && existing.btc.toLowerCase() === String(mainAddresses?.btc || '').trim().toLowerCase())
      || (existing.xmr && existing.xmr.toLowerCase() === String(mainAddresses?.xmr || '').trim().toLowerCase()));
    if (existing && !sharedLeak) return existing;

    const wantsBtc = paymentPreference === 'btc' || paymentPreference === 'both';
    const wantsXmr = paymentPreference === 'xmr' || paymentPreference === 'both';
    // Every order gets an address of its own, freshly derived. The account's
    // main address is never handed out: with one shared address, a single
    // transfer could be read as payment for many orders, and a buyer's
    // lifetime payments would pool in whichever order was checked. (security S1)
    const paymentMethods = { btc: null, xmr: null };
    let nextBtcIndex = settings.btcIndex;
    let btcDescriptor = '';
    let btcReservation = null;
    let nextXmrIndex = settings.xmrIndex;

    if (wantsBtc && settings.btcXpub) {
      btcDescriptor = await descriptorId(settings.btcXpub, settings.btcNetwork || 'bc');
      assertOwner(identity, owner, generation, fence);
      if (fence) await activateBitcoinAllocationContext(fence);
      assertOwner(identity, owner, generation, fence);
      btcReservation = await reserveBitcoinIndex({ owner, descriptor: btcDescriptor, orderId, securityFence: fence });
      if (btcReservation.descriptorId !== btcDescriptor) throw Object.assign(new Error('This order is already reserved against a different wallet descriptor.'), { code: 'WALLET_DESCRIPTOR_MISMATCH' });
      if (btcReservation.index > MAX_DERIVATION_INDEX) throw new Error('Bitcoin address derivation limit reached.');
      nextBtcIndex = Math.max(nextBtcIndex, btcReservation.index);
      paymentMethods.btc = await deriveBitcoinAddress(settings.btcXpub, btcReservation.index, settings.btcNetwork || 'bc');
    }
    if (wantsXmr && settings.xmrPrivateViewKey) {
      nextXmrIndex += 1;
      if (nextXmrIndex > MAX_DERIVATION_INDEX) throw new Error('Monero subaddress derivation limit reached.');
      paymentMethods.xmr = deriveMoneroSubaddress(
        mainAddresses.xmr,
        settings.xmrPrivateViewKey,
        nextXmrIndex,
      );
    }
    if (wantsBtc && !paymentMethods.btc) {
      throw new Error('Turn on Bitcoin address derivation (an account xpub in Profile) so this order gets its own address. The shared account address cannot tell this order\'s payment from any other.');
    }
    if (wantsXmr && !paymentMethods.xmr) {
      throw new Error('Turn on Monero subaddress derivation (a private view key in Profile) so this order gets its own address. The shared account address cannot tell this order\'s payment from any other.');
    }
    // An address is checked by its own checksum before it is recorded or
    // returned, so a badly formed one is never issued and never sent.
    for (const [currency, address] of [['BTC', paymentMethods.btc], ['XMR', paymentMethods.xmr]]) {
      if (!address) continue;
      const check = checkPaymentAddress(currency, address, { network: settings.btcNetwork || 'bc' });
      if (!check.ok) throw new Error(check.message);
    }

    settings.btcIndex = nextBtcIndex;
    settings.xmrIndex = nextXmrIndex;
    settings.orders = { ...settings.orders, [orderId]: paymentMethods };
    if (btcReservation && paymentMethods.btc) {
      await markBitcoinReservationReady({ owner, descriptor: btcDescriptor, orderId,
        index: btcReservation.index, securityFence: fence });
    }
    assertOwner(identity, owner, generation, fence);
    await writeSettings(identity, settings, owner, generation, fence);
    return paymentMethods;
  });
}

// The ledger of what a transfer has already paid for. One transaction speaks
// for one order: a receipt consumes its txid for one coin on one address, and
// no second order may confirm against either. The map is kept per vendor
// account with scopedSet, so it survives a reload and a history fetch.
// (security S1)
export function consumedKey(currency, txid) {
  return `${String(currency || '').trim().toLowerCase()}:${String(txid || '').trim().toLowerCase()}`;
}

// The entry that already spoke for this txid on a different order, if any.
// The same order asking about its own txid is not a clash.
export function txidSpokenFor(ledger, { currency, txid, orderId } = {}) {
  const entry = (ledger && typeof ledger === 'object') ? ledger[consumedKey(currency, txid)] : null;
  if (!entry) return null;
  return String(entry.orderId || '') === String(orderId || '') ? null : entry;
}

// The entry that already spoke for this address on a different order, if any.
// A reused address is the seat a shared-address replay sits in, so a second
// order cannot confirm against it either.
export function addressSpokenFor(ledger, { address, orderId } = {}) {
  // Bech32 is case-insensitive, so a mixed-case twin of a paid address is the
  // same address. The compare reads it that way.
  const wanted = String(address || '').trim().toLowerCase();
  if (!ledger || typeof ledger !== 'object' || !wanted) return null;
  for (const entry of Object.values(ledger)) {
    if (entry && String(entry.address || '').trim().toLowerCase() === wanted
      && String(entry.orderId || '') !== String(orderId || '')) return entry;
  }
  return null;
}

// A copy of the ledger with the txid recorded as spoken for by this order.
export function markConsumed(ledger, { currency, txid, orderId, address, at } = {}) {
  const next = { ...(ledger && typeof ledger === 'object' ? ledger : {}) };
  next[consumedKey(currency, txid)] = {
    orderId: String(orderId || ''),
    address: String(address || '').trim().toLowerCase(),
    at: at == null ? null : at,
  };
  return next;
}

// Reading the ledger has to tell three states apart: absent (nothing recorded
// yet — fine), a plain entry map (an older build wrote it — fine), and
// something unreadable (the bytes are not a ledger we can trust). scopedGet
// collapses the last two into a default of {}, and a default of "nothing
// recorded" would let a payment confirm twice. A ledger this device cannot
// read confirms nothing. (security A7)
export function readConsumedLedger() {
  const raw = scopedRaw('consumed_txids');
  if (raw === null) return { ok: true, ledger: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, ledger: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, ledger: null };
  }
  // The envelope the current build writes: { v: 1, entries }.
  if (parsed.v !== undefined || parsed.entries !== undefined) {
    if (parsed.v !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return { ok: false, ledger: null };
    }
    return { ok: true, ledger: parsed.entries };
  }
  // Legacy: a plain map of consumedKey → entry, no envelope.
  return { ok: true, ledger: parsed };
}

