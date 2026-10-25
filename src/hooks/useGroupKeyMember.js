import { installReceivedGroupKey } from '../lib/crypto/groupKeyDistribution';

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

export async function installMemberGroupKey(payload) {
  if (!isGroupKeyPayload(payload)) return false;
  return installReceivedGroupKey(payload);
}
