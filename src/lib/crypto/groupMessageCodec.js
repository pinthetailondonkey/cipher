import * as groupKeyStore from './groupKeyStore';
import { verifyEvent } from 'nostr-tools';
import { encryptGroupMessage, decryptGroupMessage } from './groupCipher';
import { resolveControlSender } from './groupMembership';
const KEY_WAIT_MS = 5000; const KEY_POLL_MS = 200;
async function waitForKey(groupId) {
  const start = Date.now();
  while (Date.now() - start < KEY_WAIT_MS) { const k = await groupKeyStore.getCurrentGroupKey(groupId); if (k) return k; await new Promise(r => setTimeout(r, KEY_POLL_MS)); }
  return null;
}
export async function encodeGroupPayload({ groupId, payload, senderPubkey, by, waitForKey: wfk = false }) {
  let current = await groupKeyStore.getCurrentGroupKey(groupId);
  if (!current && wfk) current = await waitForKey(groupId);
  if (!current) return { pending: true };
  // Step 2 (gmIdentityWire.js): senderPubkey may be the per-group ACTOR pin
  // rather than the account pubkey. The AAD binds whatever key sits on the
  // wire event, so the caller decides; the default keeps the old behaviour
  // for callers not yet cut over.
  //
  // `by` folds the sender's account pubkey INTO the sealed body: the relay
  // sees only the actor pin on the wire, while members open the ciphertext
  // and read who the act belongs to (roster standing, blocking, the grant
  // path). Omitted means the body leaves exactly the shape it arrived with.
  const body = (by && payload && typeof payload === 'object' && !Array.isArray(payload))
    ? { ...payload, by }
    : payload;
  const envelope = await encryptGroupMessage({ rawKey: current.bytes, plaintext: JSON.stringify(body), groupId, epoch: current.epoch, senderPubkey });
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
export async function decodeGroupEvent({ event, groupId, store = groupKeyStore, members = null, requireMember = true }) {
  let sender = '';
  if (requireMember) {
    // Historical epoch keys remain useful for authorized members' history,
    // but possessing one does not grant the right to author new relay events.
    // The caller supplies only active rows from a verified governance doc.
    if (!event || event.kind !== 9 || !verifyEvent(event)) {
      return { error: 'invalid-sender-event', refused: true };
    }
    const groupTags = event.tags.filter((tag) => tag[0] === 'h');
    if (groupTags.length !== 1 || groupTags[0][1] !== groupId) {
      return { error: 'invalid-group-binding', refused: true };
    }
    sender = resolveControlSender({ wirePubkey: event.pubkey, members });
    if (!sender) return { error: 'sender-not-in-current-membership', refused: true };
  }
  const epTags = event.tags.filter((tag) => tag[0] === 'ep');
  if (epTags.length > 1) return { error: 'decrypt-failed', reason: 'ambiguous epoch tags' };
  const epTag = epTags[0];
  if (!epTag) {
    const parsed = parseBody(event.content);
    if (parsed.type === 'gkey_req') return { plaintext: event.content, parsed, legacy: true, ...(sender ? { sender } : {}) };
    const held = await store.getCurrentGroupKey(groupId);
    if (held) {
      return { error: 'unencrypted-refused', refused: true, reason: 'This group is encrypted; a message with no epoch is not one of its messages.' };
    }
    return { plaintext: event.content, parsed, legacy: true, ...(sender ? { sender } : {}) };
  }
  const epoch = parseInt(epTag[1], 10);
  if (!Number.isInteger(epoch) || epoch < 0) return { error: 'decrypt-failed', epoch, reason: 'bad epoch tag' };
  const key = await store.getGroupKey(groupId, epoch);
  if (!key) return { pending: true, epoch, ...(sender ? { sender } : {}) };
  try {
    const env = JSON.parse(event.content);
    const plaintext = await decryptGroupMessage({ rawKey: key, envelope: env, groupId, epoch, senderPubkey: event.pubkey });
    return { plaintext, parsed: parseBody(plaintext), epoch, ...(sender ? { sender } : {}) };
  } catch (e) { return { error: 'decrypt-failed', epoch, reason: e.message }; }
}
