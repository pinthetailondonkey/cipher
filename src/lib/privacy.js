import { scopeKey, scopedSet } from './storage';

export const DEFAULT_PRIVACY = {
  calls: 'everyone',
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  groups: 'everyone',
  readReceipts: true,
  typing: true,
  // A preview sends the link to a third-party host, so it is opt-in.
  linkPreviews: false,
  // A buzz asks the OS for permission, and the prompt is the person's to
  // give: it is not fired on mount. Opt-in here; the OS grant is separate.
  notifications: false,
  // The experimental review lane for direct messages. Opt-in per account;
  // off means the default transport does the sending, exactly as shipped.
  protocolTestDm: false,
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

// Whether the person asked for a buzz. Separate from the OS grant: this is the
// intent, the OS permission is the ability, and a buzz needs both.
export function allowsNotifications() {
  return getPrivacy().notifications === true;
}

// The Groups setting owns the door: 'nobody' refuses every new join request.
// The 9021 handler reads this before it queues a sender, so the hint on the
// setting describes an engine that really runs.
export function allowsGroupJoins() {
  return getPrivacy().groups !== 'nobody';
}

// The experimental DM review lane is opt-in per account. Read fresh by the
// send and receive paths on every attempt, so a flip takes hold on the next
// connection cycle without deeper restart requirements than the setting
// advertises.
export function allowsProtocolTestDm() {
  return getPrivacy().protocolTestDm === true;
}
