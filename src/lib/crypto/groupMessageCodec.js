import * as groupKeyStore from './groupKeyStore';
import { encryptGroupMessage, decryptGroupMessage } from './groupCipher';
const KEY_WAIT_MS = 5000; const KEY_POLL_MS = 200;
async function waitForKey(groupId) {
  const start = Date.now();
  while (Date.now() - start < KEY_WAIT_MS) { const k = await groupKeyStore.getCurrentGroupKey(groupId); if (k) return k; await new Promise(r => setTimeout(r, KEY_POLL_MS)); }
  return null;
}
export async function encodeGroupPayload({ groupId, payload, senderPubkey, waitForKey: wfk = false }) {
  let current = await groupKeyStore.getCurrentGroupKey(groupId);
  if (!current && wfk) current = await waitForKey(groupId);
  if (!current) return { pending: true };
  const envelope = await encryptGroupMessage({ rawKey: current.bytes, plaintext: JSON.stringify(payload), groupId, epoch: current.epoch, senderPubkey });
  return { content: JSON.stringify(envelope), epoch: current.epoch, tags: [['ep', String(current.epoch)]] };
}

// A decoded body is an object the callers can read fields from. JSON that is
// null, a number, a boolean or an array is not a message body, and a string
// is a text message: each becomes a plain text body instead of reaching a
// caller as something it would have to guess the shape of.
function normalizeParsed(value, plaintext) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') return { type: 'text', message: value };
  return { type: 'text', message: plaintext };
}

function parseBody(plaintext) {
  let value;
  try { value = JSON.parse(plaintext); } catch { return { type: 'text', message: plaintext }; }
  return normalizeParsed(value, plaintext);
}

// Kind-9 events that carry a protocol signal, not a chat message: a key
// request and a typing ping. They ride the same kind as messages, so every
// place that turns kind-9 events into saved rows has to ask first.
const GROUP_CONTROL_TYPES = new Set(['gkey_req', 'typing']);

export function isGroupControlBody(parsed) {
  return !!parsed && typeof parsed === 'object' && GROUP_CONTROL_TYPES.has(parsed.type);
}

// A row an earlier version already saved from one of those events.
export function isGroupControlRow(row) {
  if (!row?.isGroup || typeof row.rawContent !== 'string') return false;
  let body;
  try { body = JSON.parse(row.rawContent); } catch { return false; }
  return isGroupControlBody(body);
}

// Audit finding: a kind-9 with no 'ep' tag used to decode as plaintext in
// every group, so anyone who could write to the group relay could post a
// message that read as the sender's, with no key, no AAD and no epoch.
//
// The rule, narrowest that keeps working data working:
//   - the one unencrypted body the protocol still sends is { type:
//     'gkey_req' } (a keyless member cannot encrypt its own key request),
//     and it is read as a control body, never as a message;
//   - any other tagless body is a pre-encryption legacy message and is
//     read only in a group this device holds NO key for. The repo carries
//     no date or marker for the legacy era, and created_at is the
//     sender's own claim, so there is no cutoff to trust. A group that
//     already holds a key is an encrypted group: its tagless content is
//     refused, not shown.
export async function decodeGroupEvent({ event, groupId, store = groupKeyStore }) {
  const epTag = event.tags.find(t => t[0] === 'ep');
  if (!epTag) {
    const parsed = parseBody(event.content);
    if (parsed.type === 'gkey_req') return { plaintext: event.content, parsed, legacy: true };
    const held = await store.getCurrentGroupKey(groupId);
    if (held) {
      return { error: 'unencrypted-refused', refused: true, reason: 'This group is encrypted; a message with no epoch is not one of its messages.' };
    }
    return { plaintext: event.content, parsed, legacy: true };
  }
  const epoch = parseInt(epTag[1], 10);
  if (!Number.isInteger(epoch) || epoch < 0) return { error: 'decrypt-failed', epoch, reason: 'bad epoch tag' };
  const key = await store.getGroupKey(groupId, epoch);
  if (!key) return { pending: true, epoch };
  try {
    const env = JSON.parse(event.content);
    const plaintext = await decryptGroupMessage({ rawKey: key, envelope: env, groupId, epoch, senderPubkey: event.pubkey });
    return { plaintext, parsed: parseBody(plaintext), epoch };
  } catch (e) { return { error: 'decrypt-failed', epoch, reason: e.message }; }
}
