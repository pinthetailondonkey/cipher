// The unlocked account's raw secret, held in memory for the tab's lifetime.
//
// It used to be written to sessionStorage as a JSON array of the 32 bytes, so
// a reload silently restored the session while a second copy of the raw key
// sat readable in storage. sessionStorage is not localStorage, but it is still
// a persisted copy of the same secret; the vault already keeps an encrypted
// one, so the raw copy lives in memory now. A reload carries no key and the
// account unlocks again — the vault's own door is the only way back in.
//
// In memory is not a claim about same-origin script access: a persisted copy
// of this key would be just as readable to a same-origin script. It is about
// not writing the raw secret anywhere the vault already covers.
let sessionKey = null;

export function setSessionKey(bytes) {
  sessionKey = bytes ? Uint8Array.from(bytes) : null;
}

export function getSessionKey() {
  return sessionKey;
}

export function clearSessionKey() {
  sessionKey = null;
}
