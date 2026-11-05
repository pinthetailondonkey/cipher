// Where the push gateway's wrap pubkey is kept on a device.
//
// When a phone registers with the box, the registration answer carries the
// ephemeral Nostr key the box watches. From then on every buzzable DM this
// device sends wraps a copy of its seal to that key, so the box can still
// learn that something arrived after the t-tag left the wire. Nothing here
// is a secret: the stored value is a public key, and it is only read back by
// the send path in this same app.

import { scopedGet, scopedSet } from './storage.js';

const KEY = 'push_gateway_pubkey';
const URL_KEY = 'push_gateway_url';

export function rememberGatewayPubkey(gatewayUrl, pubkey) {
  if (!/^[0-9a-f]{64}$/.test(String(pubkey || ''))) return;
  try {
    scopedSet(KEY, String(pubkey).trim());
    scopedSet(URL_KEY, String(gatewayUrl || '').trim());
  } catch {
    // A full or unavailable store never blocks sending; the wrap copy just
    // does not ride along until the next successful registration.
  }
}

export function storedGatewayPubkey() {
  try {
    const value = scopedGet(KEY);
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

// The send path wraps to the gateway key only while it is still pointed at
// the gateway the key was learned from, so a stale entry pasted out of
// Connections cannot steer wraps at a box that no longer expects them.
export function gatewayEntryUrl() {
  try {
    return scopedGet(URL_KEY) || null;
  } catch {
    return null;
  }
}
