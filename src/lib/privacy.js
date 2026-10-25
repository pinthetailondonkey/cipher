import { scopeKey, scopedSet } from './storage';

export const DEFAULT_PRIVACY = {
  calls: 'everyone',
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  groups: 'everyone',
  readReceipts: true,
  typing: true,
  forwarding: true,
  // A preview sends the link to a third-party host, so it is opt-in.
  linkPreviews: false,
};

let privacyKey = '';
let privacyRaw;
let privacySnapshot = DEFAULT_PRIVACY;

export function getPrivacy() {
  const storageKey = scopeKey('privacy');
  let raw = null;
  try {
    raw = globalThis.localStorage?.getItem(storageKey) ?? null;
  } catch {
    raw = null;
  }
  if (storageKey === privacyKey && raw === privacyRaw) return privacySnapshot;
  privacyKey = storageKey;
  privacyRaw = raw;
  let stored = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
    } catch {
      stored = {};
    }
  }
  privacySnapshot = { ...DEFAULT_PRIVACY, ...stored };
  return privacySnapshot;
}

export function setPrivacy(patch) {
  const next = { ...getPrivacy(), ...patch };
  scopedSet('privacy', next);
  privacyRaw = undefined;
  return getPrivacy();
}

export function allowsTyping() {
  const privacy = getPrivacy();
  return privacy.typing !== false && privacy.lastSeen !== 'nobody';
}

export function allowsLinkPreviews() {
  return getPrivacy().linkPreviews === true;
}
