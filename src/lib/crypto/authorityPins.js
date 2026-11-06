// Where authority pins live between sessions (Step 1d wiring).
//
// localStorage under the account scope, written by exactly two doors:
//   - group creation (the owner derives and stamps its own pin)
//   - an invite link join carrying `a=` (the member learns it out of band)
// Read by one door only: bindMemberDocPins at bootstrap. Never fetched from a
// relay row — that is H5's whole point.

const PREFIX = 'cipher_group_auth_pin_';

// Legacy local actor-binding cache. A shared-key message's `by` field is not
// proof of account ownership, so this cache is not an authorization source
// and no current publisher or control path reads it. New bindings live only
// in v3 governance docs after an account-signed private admission proof.
const ACTOR_PREFIX = 'cipher_group_actor_pin_';

function actorKeyFor(ownerPk, groupId) {
  const scope = String(ownerPk || '').toLowerCase().slice(0, 16);
  return scope && groupId ? `${ACTOR_PREFIX}${scope}_${groupId}` : '';
}

/** Legacy storage helper; returned values are untrusted migration hints. */
export function rememberActorBinding(ownerPk, groupId, accountPk, pin) {
  const key = actorKeyFor(ownerPk, groupId);
  const account = String(accountPk || '').toLowerCase();
  const value = String(pin || '').toLowerCase().trim();
  if (!key || !/^[0-9a-f]{64}$/.test(account) || !/^[0-9a-f]{66}$/.test(value)) return false;
  try {
    const raw = localStorage.getItem(key);
    const map = raw ? JSON.parse(raw) : {};
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('junk');
    const held = map[account];
    map[account] = value;
    // Two different pins naming one account is either a rotation in flight or
    // corrupt observation; overwrite is the safe answer (the newest decode won).
    if (held && held !== value) {
      console.warn('[group-pins] An account presented two different actor pins; keeping the newest.', { groupId: String(groupId).slice(0, 8) });
    }
    localStorage.setItem(key, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export function readActorBindings(ownerPk, groupId) {
  const key = actorKeyFor(ownerPk, groupId);
  if (!key) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [account, pin] of Object.entries(parsed)) {
      if (/^[0-9a-f]{64}$/.test(account) && /^[0-9a-f]{66}$/.test(String(pin))) out[account] = pin.toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

function scoped(ownerPk) {
  return String(ownerPk || '').toLowerCase().slice(0, 16);
}

function keyFor(ownerPk, groupId) {
  if (!scoped(ownerPk) || !groupId) return '';
  return `${PREFIX}${scoped(ownerPk)}_${groupId}`;
}

export function rememberAuthorityPin(ownerPk, groupId, pin) {
  const key = keyFor(ownerPk, groupId);
  const value = String(pin || '').toLowerCase().trim();
  if (!key || !/^[0-9a-f]{66}$/.test(value)) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Private mode or quota: pins stay session-only via the memory cache.
    memory.set(key, value);
    return true;
  }
}

const memory = new Map();

export function readAuthorityPin(ownerPk, groupId) {
  const key = keyFor(ownerPk, groupId);
  if (!key) return '';
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[0-9a-f]{66}$/.test(stored)) return stored;
  } catch { /* fall through to memory */ }
  return memory.get(key) || '';
}

export function forgetAuthorityPin(ownerPk, groupId) {
  const key = keyFor(ownerPk, groupId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch { /* ignore */ }
  memory.delete(key);
}

// The bootstrap binding: loadDocStanding asks this for each group's pin.
export function authorityPinGetterFor(ownerPk) {
  return async (groupId) => readAuthorityPin(ownerPk, groupId);
}
