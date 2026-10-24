import { scopedGet, scopedSet } from './storage';

export const DEFAULT_PRIVACY = {
  calls: 'everyone',
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  groups: 'everyone',
  readReceipts: true,
  typing: true,
  forwarding: true,
};

export function getPrivacy() {
  const stored = scopedGet('privacy', {});
  return { ...DEFAULT_PRIVACY, ...(stored && typeof stored === 'object' ? stored : {}) };
}

export function setPrivacy(patch) {
  const next = { ...getPrivacy(), ...patch };
  scopedSet('privacy', next);
  return next;
}

export function allowsTyping() {
  const privacy = getPrivacy();
  return privacy.typing !== false && privacy.lastSeen !== 'nobody';
}
