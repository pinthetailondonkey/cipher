// SEC-5: which group's pin proves the group socket.
//
// One WebSocket carries every group this device follows (see
// openGroupRelaySession in hooks/useNIP29Group.js: one socket, one subscription
// per group id, all of them on the same connection). The relay therefore
// already learns the whole set of group ids from the REQ frames, all correlated
// to one connection and one address.
//
// The only identity fact on that socket is the NIP-42 proof, and it is signed
// by ONE group's actor pin. The relay-level proof opens the box for any owned
// group's derivation, so the choice buys nothing operationally and everything
// in what it discloses:
//
//   1. The relay must not learn which group the person happens to have open on
//      screen. Preferring the store's active group made the proof follow the
//      UI, so the relay could tell when the reader switched groups (a fresh
//      socket on a group switch signed with that group's pin).
//   2. The proof should stay ONE pseudonym for as long as it is held, which is
//      the whole point of deriving a per-group actor key.
//
// So the choice is: a socket that already proved keeps its pin for its life
// (held), and a fresh socket takes the LOWEST group id it is about to read,
// falling back to the lowest group the account holds when no subscription has
// been placed yet. Both are stable across reconnects and independent of the
// screen. A group leaving later does not re-sign the socket: the relay already
// accepted the proof, and re-proving would only add a frame.

/**
 * Picks the group id whose actor pin should sign this socket's NIP-42 proof.
 *
 * @param {object} [input]
 * @param {string} [input.held]    the group this socket already proved under
 * @param {string[]} [input.readable] group ids this socket subscribes to
 * @param {string[]} [input.known]    group ids the account holds
 * @returns {string} a group id, or '' when the account holds none
 */
export function socketProofGroupId({ held = '', readable = [], known = [] } = {}) {
  const heldId = clean(held);
  if (heldId) return heldId;
  return lowest(readable) || lowest(known);
}

function lowest(ids) {
  const unique = [];
  for (const id of ids || []) {
    const value = clean(id);
    if (value && !unique.includes(value)) unique.push(value);
  }
  unique.sort();
  return unique[0] || '';
}

function clean(id) {
  return typeof id === 'string' ? id.trim() : '';
}
