const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const CIPHER_VERSION = 1;
export function generateGroupKey() { const k = new Uint8Array(32); crypto.getRandomValues(k); return k; }
export function toHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function fromHex(hex) { if (hex.length % 2) throw new Error('invalid hex'); const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
export function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
export function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function aad({ groupId, epoch, senderPubkey }) { return enc.encode(`cipher-group-v${CIPHER_VERSION}|${groupId}|${epoch}|${senderPubkey}`); }
async function importKey(raw) { return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
export async function encryptGroupMessage({ rawKey, plaintext, groupId, epoch, senderPubkey }) {
  const key = await importKey(rawKey);
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad({ groupId, epoch, senderPubkey }) }, key, enc.encode(plaintext));
  return { v: CIPHER_VERSION, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
export async function decryptGroupMessage({ rawKey, envelope, groupId, epoch, senderPubkey }) {
  if (!envelope || envelope.v !== CIPHER_VERSION) throw new Error('unsupported envelope');
  const key = await importKey(rawKey);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: aad({ groupId, epoch, senderPubkey }) }, key, unb64(envelope.ct));
  return dec.decode(pt);
}
