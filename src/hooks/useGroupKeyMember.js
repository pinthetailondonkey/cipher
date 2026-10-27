import { installReceivedGroupKey, parseGroupKeyBundle } from '../lib/crypto/groupKeyDistribution';
import { getCurrentGroupKey } from '../lib/crypto/groupKeyStore';
import { markSafetyChange } from '../lib/safetyNumber';

// Member side of a group key. The owner sends a kind-4 bundle with `t: 'gkey'`.
// This module installs it into groupKeys. It is not a chat message.
// useNIP44DM is the only caller: a non-owner never runs the reconciler.

export function isGroupKeyPayload(data) {
  return !!data && (data.t === 'gkey' || data.type === 'gkey');
}

// Returns a control name, or null when the payload is an ordinary chat message.
// A key bundle must take this path. Saving it renders a phantom bubble and
// never installs the key.
export function dmControlAction(data) {
  if (!data || typeof data !== 'object') return null;
  if (isGroupKeyPayload(data)) return 'gkey';
  if (data.type === 'pin' || data.type === 'typing' || data.type === 'read' || data.type === 'call') return data.type;
  return null;
}

export async function installMemberGroupKey(payload, sender = null) {
  if (!isGroupKeyPayload(payload)) return false;
  // Safety numbers: a bundle from a sender that turns over key material is
  // the change the engine's flag waits for. Both the live and history DM
  // ingest paths run through here, so the hook holds without them being
  // rewritten. A first key for a group is not a change — only an epoch
  // advance past what this device already held marks it.
  const bundle = parseGroupKeyBundle(payload);
  const groupId = bundle[0]?.groupId;
  const heldEpoch = groupId ? (await getCurrentGroupKey(groupId))?.epoch : undefined;
  const installed = await installReceivedGroupKey(payload, sender);
  if (installed && sender && Number.isInteger(heldEpoch)) {
    for (const row of bundle) {
      if (row.groupId === groupId && row.epoch > heldEpoch) {
        markSafetyChange(sender);
        break;
      }
    }
  }
  return installed;
}
