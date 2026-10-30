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

// Audit H9 (drill round three): expiry is a decision the DM arms must make
// BEFORE any engine runs. An expired message is dead on arrival — it installs
// no key and countersigns no receipt on its way to the drop. Same clock and
// boundary the arms have always used: whole seconds, and "now" already counts
// as expired. A missing, zero, or unparseable expires_at is no expiry at all.
export function dmExpired(data, now = Math.floor(Date.now() / 1000)) {
  if (!data || !data.expires_at) return false;
  return now >= Number(data.expires_at);
}

export async function installMemberGroupKey(payload, sender = null) {
  if (!isGroupKeyPayload(payload)) return false;
  return installReceivedGroupKey(payload, sender);
}
