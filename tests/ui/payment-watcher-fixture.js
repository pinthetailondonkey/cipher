import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
export const watcherPublicKey = b64url(rawPublicKey);
const keyId = createHash('sha256').update(rawPublicKey).digest('hex');

export const childWatcherToken = (base, currency, address) =>
  createHmac('sha256', base).update(`cipher-watch-v1:${currency}:${address}`).digest('hex');

export async function pinWatcherKey(page) {
  await page.evaluate((value) => {
    const owner = localStorage.getItem('cipher_active_pubkey') || localStorage.getItem('cipher_db_owner');
    if (!owner) throw new Error('No active account for the watcher trust fixture.');
    localStorage.setItem(`cipher_${owner}_payment_watcher_signing_key`, JSON.stringify(value));
  }, watcherPublicKey);
}

export function signedWatcherReport({ address, currency, nonce, confirmations, amount, time, txid = 'ab' }) {
  const rawBody = JSON.stringify({
    version: 2, keyId, nonce, address, currency, txid, confirmations, amount,
    ...(time == null ? {} : { time }),
    signedAt: Math.floor(Date.now() / 1000),
  });
  const signature = sign(null, Buffer.from(`cipher-payment-watcher-v2\n${rawBody}`), privateKey);
  return { rawBody, signature: b64url(signature) };
}
