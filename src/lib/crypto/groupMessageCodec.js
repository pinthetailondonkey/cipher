import { getCurrentGroupKey, getGroupKey } from './groupKeyStore';
import { encryptGroupMessage, decryptGroupMessage } from './groupCipher';
const KEY_WAIT_MS = 5000; const KEY_POLL_MS = 200;
async function waitForKey(groupId) {
  const start = Date.now();
  while (Date.now() - start < KEY_WAIT_MS) { const k = await getCurrentGroupKey(groupId); if (k) return k; await new Promise(r => setTimeout(r, KEY_POLL_MS)); }
  return null;
}
export async function encodeGroupPayload({ groupId, payload, senderPubkey, waitForKey: wfk = false }) {
  let current = await getCurrentGroupKey(groupId);
  if (!current && wfk) current = await waitForKey(groupId);
  if (!current) return { pending: true };
  const envelope = await encryptGroupMessage({ rawKey: current.bytes, plaintext: JSON.stringify(payload), groupId, epoch: current.epoch, senderPubkey });
  return { content: JSON.stringify(envelope), epoch: current.epoch, tags: [['ep', String(current.epoch)]] };
}
export async function decodeGroupEvent({ event, groupId }) {
  const epTag = event.tags.find(t => t[0] === 'ep');
  if (!epTag) {
    try { return { plaintext: event.content, parsed: JSON.parse(event.content), legacy: true }; }
    catch { return { plaintext: event.content, parsed: { type: 'text', message: event.content }, legacy: true }; }
  }
  const epoch = parseInt(epTag[1], 10);
  const key = await getGroupKey(groupId, epoch);
  if (!key) return { pending: true, epoch };
  try {
    const env = JSON.parse(event.content);
    const plaintext = await decryptGroupMessage({ rawKey: key, envelope: env, groupId, epoch, senderPubkey: event.pubkey });
    return { plaintext, parsed: JSON.parse(plaintext), epoch };
  } catch (e) { return { error: 'decrypt-failed', epoch, reason: e.message }; }
}
