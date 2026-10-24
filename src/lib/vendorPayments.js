import { bech32 } from '@scure/base';
import { scopeKey } from './storage';

const CONFIG_KEY = 'advanced_vendor_payment_keys';
const MAX_DERIVATION_INDEX = 10000;
const settingsLocks = new Map();

function defaultSettings() {
  return { btcXpub: '', xmrPrivateViewKey: '', btcIndex: 0, xmrIndex: 0, orders: {} };
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

async function readSettings(identity) {
  if (!identity?.sk) throw new Error('Unlock your account to access vendor payment settings.');
  const raw = localStorage.getItem(scopeKey(CONFIG_KEY));
  if (!raw) return defaultSettings();
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
  return { ...defaultSettings(), ...parsed, orders: parsed.orders || {} };
}

async function writeSettings(identity, settings) {
  const key = await deriveEncryptionKey(identity.sk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(settings));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  localStorage.setItem(scopeKey(CONFIG_KEY), JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted)),
  }));
}

export async function loadVendorPaymentConfig(identity) {
  const { btcXpub, xmrPrivateViewKey } = await readSettings(identity);
  return { btcXpub, xmrPrivateViewKey };
}

export async function saveVendorPaymentConfig(identity, { btcXpub, xmrPrivateViewKey }) {
  const normalizedXpub = (btcXpub || '').trim();
  const normalizedViewKey = (xmrPrivateViewKey || '').trim().toLowerCase();
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
    const settings = await readSettings(identity);
    await writeSettings(identity, {
      ...settings,
      btcXpub: normalizedXpub,
      xmrPrivateViewKey: normalizedViewKey,
    });
  });
}

async function deriveBitcoinAddress(xpub, index) {
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
  return bech32.encode('bc', [0, ...bech32.toWords(publicKeyHash)]);
}

async function deriveMoneroSubaddress(primaryAddress, privateViewKey, index, orderId) {
  if (!primaryAddress) throw new Error('Add the vendor Monero main address before enabling subaddress rotation.');
  const [{ default: walletModule }, { default: configModule }] = await Promise.all([
    import('monero-ts/dist/src/main/ts/wallet/MoneroWalletFull.js'),
    import('monero-ts/dist/src/main/ts/wallet/model/MoneroWalletConfig.js'),
  ]);
  const MoneroWalletFull = walletModule.default || walletModule;
  const MoneroWalletConfig = configModule.default || configModule;
  let wallet;
  try {
    wallet = await MoneroWalletFull.createWallet(new MoneroWalletConfig({
      networkType: 'mainnet',
      path: '',
      password: '',
      primaryAddress,
      privateViewKey,
      proxyToWorker: false,
      restoreHeight: 0,
    }));
    let subaddress;
    for (let currentIndex = 1; currentIndex <= index; currentIndex += 1) {
      subaddress = await wallet.createSubaddress(0, `Cipher order ${orderId.slice(0, 8)} #${currentIndex}`);
    }
    const address = subaddress?.getAddress();
    if (!address) throw new Error('Monero wallet did not return a subaddress.');
    return address;
  } finally {
    if (wallet) {
      try {
        await wallet.close(false);
      } catch (error) {
        console.warn('[vendor-payments] Could not close the temporary Monero wallet:', error);
      }
    }
  }
}

async function withSettingsLock(pubkey, callback) {
  const previous = settingsLocks.get(pubkey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  settingsLocks.set(pubkey, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (settingsLocks.get(pubkey) === queued) settingsLocks.delete(pubkey);
  }
}

export async function getOrderPaymentMethods(identity, orderId, mainAddresses, paymentPreference = 'btc') {
  if (!identity?.pk || !identity?.sk || !orderId) {
    throw new Error('An unlocked vendor account and order ID are required.');
  }
  if (!['btc', 'xmr', 'both'].includes(paymentPreference)) {
    throw new Error('Choose a supported order payment method.');
  }
  return withSettingsLock(identity.pk, async () => {
    const settings = await readSettings(identity);
    const existing = settings.orders[orderId];
    if (existing) return existing;

    const wantsBtc = paymentPreference === 'btc' || paymentPreference === 'both';
    const wantsXmr = paymentPreference === 'xmr' || paymentPreference === 'both';
    const paymentMethods = {
      btc: wantsBtc ? (mainAddresses.btc || null) : null,
      xmr: wantsXmr ? (mainAddresses.xmr || null) : null,
    };
    let nextBtcIndex = settings.btcIndex;
    let nextXmrIndex = settings.xmrIndex;

    if (wantsBtc && settings.btcXpub) {
      nextBtcIndex += 1;
      if (nextBtcIndex > MAX_DERIVATION_INDEX) throw new Error('Bitcoin address derivation limit reached.');
      paymentMethods.btc = await deriveBitcoinAddress(settings.btcXpub, nextBtcIndex);
    }
    if (wantsXmr && settings.xmrPrivateViewKey) {
      nextXmrIndex += 1;
      if (nextXmrIndex > MAX_DERIVATION_INDEX) throw new Error('Monero subaddress derivation limit reached.');
      paymentMethods.xmr = await deriveMoneroSubaddress(
        mainAddresses.xmr,
        settings.xmrPrivateViewKey,
        nextXmrIndex,
        orderId,
      );
    }

    settings.btcIndex = nextBtcIndex;
    settings.xmrIndex = nextXmrIndex;
    settings.orders = { ...settings.orders, [orderId]: paymentMethods };
    await writeSettings(identity, settings);
    return paymentMethods;
  });
}
