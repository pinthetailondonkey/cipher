import { getActivePubkey, scopedGet, scopedRaw, scopedSetVerified } from './storage.js';

const STORAGE_KEY = 'payment_watcher_signing_key';
const DOMAIN = 'cipher-payment-watcher-key-rotation-v2\n';
const blockedAccounts = new Set();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const un64url = (text) => {
  const encoded = String(text || '');
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid base64url encoding.');
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  if (b64url(bytes) !== encoded) throw new Error('Non-canonical base64url encoding.');
  return bytes;
};

export function readPaymentWatcherPin() {
  if (blockedAccounts.has(getActivePubkey())) return '';
  return String(scopedGet(STORAGE_KEY, '') || '');
}

function persistPin(next) {
  if (!scopedSetVerified(STORAGE_KEY, next) || scopedRaw(STORAGE_KEY) !== JSON.stringify(next)) {
    blockedAccounts.add(getActivePubkey());
    throw new Error('The watcher key change could not be saved. Payment reports are held on this account until the pin is saved again.');
  }
  blockedAccounts.delete(getActivePubkey());
}

export async function keyIdOf(publicKey) {
  const raw = un64url(publicKey);
  if (raw.length !== 32) throw new Error('A watcher signing key must be a 32-byte Ed25519 public key.');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function pinPaymentWatcherKey(publicKey) {
  const next = String(publicKey || '').trim();
  await keyIdOf(next);
  if (readPaymentWatcherPin()) throw Object.assign(new Error('A watcher key is already pinned. Use the signed rotation action.'), { code: 'WATCHER_KEY_ALREADY_PINNED' });
  persistPin(next);
}

export function clearPaymentWatcherPin({ confirmRemoval } = {}) {
  if (!confirmRemoval) throw new Error('Confirm removal of the watcher pin before clearing it.');
  blockedAccounts.add(getActivePubkey());
  if (!scopedSetVerified(STORAGE_KEY, '') || scopedRaw(STORAGE_KEY) !== JSON.stringify('')) {
    throw new Error('The watcher key pin could not be removed from storage. Payment reports remain on hold in this session.');
  }
}

export async function rotatePaymentWatcherKey({ publicKey, signature, confirmRotation } = {}) {
  const previous = readPaymentWatcherPin();
  const next = String(publicKey || '').trim();
  if (!previous || !confirmRotation) throw new Error('Confirm the watcher key rotation before saving it.');
  const oldRaw = un64url(previous);
  const signatureBytes = un64url(signature);
  if (signatureBytes.length !== 64) throw new Error('A rotation signature must be 64 bytes.');
  await keyIdOf(next);
  const oldKey = await crypto.subtle.importKey('raw', oldRaw, { name: 'Ed25519' }, false, ['verify']);
  const valid = await crypto.subtle.verify('Ed25519', oldKey, signatureBytes, new TextEncoder().encode(`${DOMAIN}${next}`));
  if (!valid) throw new Error('The new watcher key is not signed by the currently pinned key.');
  persistPin(next);
}

export async function verifyPaymentWatcherReport({ rawBody, signature, publicKey, expectedAddress, expectedCurrency, expectedNonce } = {}) {
  let report;
  try { report = JSON.parse(rawBody); } catch { return false; }
  if (report?.version !== 2 || !/^[0-9a-f]{64}$/.test(String(report.keyId || ''))
    || report.nonce !== expectedNonce || !/^[A-Za-z0-9_-]{22,64}$/.test(String(report.nonce || ''))
    || (expectedAddress !== undefined && report.address !== expectedAddress)
    || (expectedCurrency !== undefined && String(report.currency || '').toLowerCase() !== String(expectedCurrency || '').toLowerCase())) return false;
  try {
    const keyId = await keyIdOf(publicKey);
    if (keyId !== report.keyId) return false;
    const key = await crypto.subtle.importKey('raw', un64url(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, un64url(signature), new TextEncoder().encode(`cipher-payment-watcher-v2\n${rawBody}`));
  } catch { return false; }
}
