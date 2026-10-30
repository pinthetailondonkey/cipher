const STORAGE_KEY = 'cipher_network';

// Every host the app can contact. A new outbound host belongs here, not inline.
// `called: false` is a host the old page policy allowed and the app does not use.
// The no-IP-leak law: a new CLEARNET row (an ordinary address, not .onion)
// must carry gate: 'founder' on the row, or the build fails. The founder names
// the host before it ships.
export const EGRESS = [
  { id: 'group-relay', role: 'Group relay', url: 'wss://groups.ciphertele.com', sees: 'Your IP, and every group you open. If you turn on selling, it also gets your public card: your name, picture and profile line, which anyone reading your menu can see. It can delete its data at any time, so a card there is a sign, not a record.', required: true },
  { id: 'dm-relay', role: 'Message relay', url: 'wss://relay.primal.net', sees: 'Your IP, who you message, and whether each one is a message, an order, or a call. That label is on every message in plain text, so anyone who reads this relay sees it too. The push gateway needs it, because it cannot read the message. The text itself stays encrypted.', required: true },
  { id: 'profile-nos', role: 'Profile relay', url: 'wss://nos.lol', sees: 'Your IP when a name or profile is published' },
  { id: 'profile-damus', role: 'Profile relay', url: 'wss://relay.damus.io', sees: 'Your IP when a profile is saved' },
  { id: 'profile-purple', role: 'Profile relay', url: 'wss://purplepag.es', sees: 'Your IP when profiles are loaded' },
  { id: 'search-vertex', role: 'Search relay', url: 'wss://relay.vertexlab.io', sees: 'Your IP and the text you search' },
  { id: 'search-noswhere', role: 'Search relay', url: 'wss://relay.noswhere.com', sees: 'Your IP and the text you search' },
  { id: 'policy-nostr-band', role: 'Unused relay', url: 'wss://relay.nostr.band', sees: 'Nothing. The old page policy allowed it. The app does not call it.', called: false },
  { id: 'blossom-primal', role: 'Media host', url: 'https://blossom.primal.net', sees: 'Chat photos and voice notes: your IP and the encrypted file when you send, under a throwaway key; each reader\u2019s IP and when they opened it. Not the content. Profile and product pictures are public and stored as they are.' },
  { id: 'blossom-nostr-build', role: 'Media host', url: 'https://nostr.build', sees: 'Chat photos and voice notes: your IP and the encrypted file when you send, under a throwaway key; each reader\u2019s IP and when they opened it. Not the content. Profile and product pictures are public and stored as they are.' },
  { id: 'blossom-band', role: 'Media host', url: 'https://blossom.band', sees: 'Chat photos and voice notes: your IP and the encrypted file when you send, under a throwaway key; each reader\u2019s IP and when they opened it. Not the content. Profile and product pictures are public and stored as they are.' },
  { id: 'link-preview', role: 'Link previews', url: 'https://api.microlink.io', sees: 'Nothing until you turn on Link previews in Privacy. Then your IP and every link a preview is fetched for.' },
  { id: 'dead-drop', role: 'Burn notes', url: 'https://www.ciphermessenger.org', sees: 'Your IP when a burn note link is opened there. The note itself lives on the message relay as ciphertext; this host only serves the page that opens it. The key to open it rides in the link fragment, which never reaches any server.', gate: 'founder' },
  // Call-routing rows (stun, turn) are gone: calls are off in every build
  // under the no-IP-leak law, so no call-routing host is contacted at all.
  { id: 'dns', role: 'Name lookup', url: '', hint: 'This device’s resolver', sees: 'Every hostname, at the resolver on this device. Cipher cannot choose it or turn it off.', dynamic: true },
  { id: 'images', role: 'Pictures', url: '', hint: 'Each picture’s own host', sees: 'Your IP and the address of every chat or product picture. The browser fetches each host. The app does not choose that path.', dynamic: true },
  { id: 'profile-photo', role: 'Profile photos', url: '', hint: 'Each photo’s own host', sees: 'Your IP and whatever host a profile photo points at. A photo can be any site. The app does not proxy it.', dynamic: true },
  { id: 'app-host', role: 'App host', url: 'https://www.ciphermessenger.org', hint: '', sees: 'Your IP if you open the website here. The installed app loads its own files and does not contact this host when it opens.', app: true, gate: 'founder' },
  { id: 'nip05', role: 'Name lookup', url: '', hint: 'The host after the @', sees: 'Your IP and the name you look up. The host is whatever sits after the @.', dynamic: true },
  { id: 'explorer', role: 'Payment watcher', url: '', hint: 'Not set', sees: 'Nothing until you paste a watcher you run. This device does not ask a block explorer. Until then a payment cannot be marked seen or confirmed from the chain.' },
  { id: 'push', role: 'Push gateway', url: '', hint: 'Not set', sees: 'Nothing until you paste a gateway you run. A locked phone does not buzz before that. The notice says New message and does not include the text. The gateway still sorts messages by a plain-text label on each, which the message relay and anyone reading it can also see.' },
  { id: 'fcm', role: 'Android push', url: 'https://fcm.googleapis.com', sees: 'Nothing from the phone. The push box you run delivers a message or a call here when a Firebase key is set. The text is not included.', called: false },
  { id: 'fcm-auth', role: 'Android push', url: 'https://oauth2.googleapis.com', sees: 'Nothing from the phone. The push box trades its service-account key for a short-lived token here.', called: false },
  { id: 'fcm-scope', role: 'Android push', url: 'https://www.googleapis.com', sees: 'Nothing. The token request names this host as its permission scope. The box does not open a connection to it.', called: false },
  { id: 'apns', role: 'iOS push', url: 'https://api.push.apple.com', sees: 'Nothing from the phone. The push box you run delivers a message or a call here when an APNs key is set. The text is not included.', called: false },
];

// The group door is chosen by the build, and the address lives outside the
// repo. A browser cannot open a connection to an onion at all: a page served
// over https may not dial ws:// on port 80 (mixed content), and the hidden
// service answers nothing on 443. So the web build — the browser, iPhone
// Safari, the installed PWA — ships the clear address its own row already
// names, and the desktop build, which runs its own Tor, carries the onion.
//
// The address is not written here. It comes from an untracked build file
// (VITE_GROUP_ONION, read by scripts/with-app-env.mjs), and the desktop build
// refuses to start without it: a desktop bundle that silently fell back to
// clearnet would take groups off Tor without a word. That refusal is the
// difference between an env var and a silent fallback.
//
// The switch is decided at build time, never by looking at the user agent and
// never by a runtime guess: a page cannot tell reliably whether Tor is
// underneath it. prepare-pack.mjs refuses a build without the marker
// build-desktop.mjs writes, for the same reason.
//
// A device's own paste still outranks the build's door, and `off` still drops
// the host entirely.
const DESKTOP_BUILD = typeof __CIPHER_DESKTOP_BUILD__ !== 'undefined' && __CIPHER_DESKTOP_BUILD__ === true;

const buildGroupDoor = String(import.meta?.env?.VITE_GROUP_ONION || '').trim();
const buildMediaDoor = String(import.meta?.env?.VITE_MEDIA_ONION || '').trim();

// One door shape for every onion row, the group door's: the build supplies the
// address from an untracked file, and only a desktop build may carry it. A web
// bundle holds no onion by construction — the address is not in the repo and
// not in the page.
const doorOrEmpty = (value) => (DESKTOP_BUILD && value ? value : '');

export const FOUNDER_GROUP_ONION = doorOrEmpty(buildGroupDoor);
export const FOUNDER_MEDIA_ONION = doorOrEmpty(buildMediaDoor);

// The doors still to come: one message relay, one search relay, one media
// host, one note host. Each ships dark ('') until a build carries its
// address, so every row keeps its shipped address today.
//
// An earlier version of this comment said a name must land here as a literal,
// and never as an env var, because an env var once bought a silent clearnet
// fallback. The lesson was right and the rule was wrong: what failed was a
// build that could ship without the address and say nothing. The refusal is
// what makes the env var safe, so every onion door now reads its address the
// way the group door does — from the build, behind DESKTOP_BUILD, with the
// build refusing to run without it.
//
// A lit door outranks the shipped address under the same rank order as the
// group door: a device's own paste wins, then the door, and `off` still drops
// the host. One door serves every row of its kind: the search pair and the
// media trio each resolve to the one address when their door is lit.
export const FOUNDER_ONION_DOORS = {
  'dm-relay': '',
  'search-vertex': '',
  'search-noswhere': '',
  'blossom-primal': FOUNDER_MEDIA_ONION,
  'blossom-nostr-build': FOUNDER_MEDIA_ONION,
  'blossom-band': FOUNDER_MEDIA_ONION,
  'dead-drop': '',
};

export const RELAY_SETS = {
  general: ['dm-relay'],
  group: ['group-relay'],
  'group-only': ['group-relay'],
  vendorCard: ['group-relay'],
  search: ['dm-relay', 'search-vertex', 'search-noswhere'],
  profile: ['dm-relay', 'profile-nos'],
  profileEditor: ['dm-relay', 'profile-nos', 'profile-damus'],
  profileRead: ['profile-purple', 'profile-nos', 'dm-relay'],
  username: ['dm-relay', 'profile-nos'],
  product: ['dm-relay'],
  blossom: ['blossom-primal', 'blossom-nostr-build', 'blossom-band'],
  preview: ['link-preview'],
};

let refreshBoundRelays = () => {};
export function bindRelayRefresh(refresh) {
  refreshBoundRelays = typeof refresh === 'function' ? refresh : () => {};
}

export function isOnionUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `ws://${raw}`;
    return new URL(withScheme).hostname.endsWith('.onion');
  } catch {
    return raw.includes('.onion');
  }
}

function asList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

const EMPTY_NETWORK = {
  overrides: {},
  lists: { profile: [], dm: [] },
};

// useSyncExternalStore requires this to return the same object until storage
// actually changes. A fresh object on every read re-renders until React throws.
let snapshotRaw;
let snapshot = EMPTY_NETWORK;

export function readNetworkConfig() {
  let raw = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === snapshotRaw) return snapshot;
  snapshotRaw = raw;
  if (!raw) {
    snapshot = EMPTY_NETWORK;
    return snapshot;
  }
  try {
    const parsed = JSON.parse(raw);
    const overrides = parsed?.overrides && typeof parsed.overrides === 'object' ? { ...parsed.overrides } : {};
    const lists = parsed?.lists && typeof parsed.lists === 'object' ? parsed.lists : {};
    snapshot = {
      overrides,
      lists: { profile: asList(lists.profile), dm: asList(lists.dm) },
    };
  } catch {
    snapshot = EMPTY_NETWORK;
  }
  return snapshot;
}

export function writeNetworkConfig(patch) {
  const current = readNetworkConfig();
  const next = {
    overrides: patch.overrides ? { ...patch.overrides } : current.overrides,
    lists: patch.lists ? { ...current.lists, ...patch.lists } : current.lists,
  };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* private mode */ }
  refreshBoundRelays();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cipher:network'));
  return next;
}

export function setRelayList(name, text) {
  const urls = String(text || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const config = readNetworkConfig();
  return writeNetworkConfig({ lists: { ...config.lists, [name]: urls } });
}

export function setRelayOverride(id, url) {
  const config = readNetworkConfig();
  const overrides = { ...config.overrides };
  const trimmed = String(url || '').trim();
  if (!trimmed) delete overrides[id];
  else overrides[id] = trimmed.toLowerCase() === 'off' ? 'off' : trimmed;
  return writeNetworkConfig({ overrides });
}

export function entryById(id) {
  return EGRESS.find((entry) => entry.id === id) || null;
}

export function activeUrl(entry, config = readNetworkConfig()) {
  if (!entry || entry.called === false || entry.dynamic) return '';
  const override = String(config.overrides?.[entry.id] || '').trim();
  if (override === 'off') return '';
  // The founder's own door outranks the shipped default, and a device's
  // own paste outranks both. `off` was answered above, so it still drops the
  // host even when the build carries the door.
  if (entry.id === 'group-relay' && FOUNDER_GROUP_ONION) {
    return override || FOUNDER_GROUP_ONION;
  }
  // A door still dark ('') keeps the shipped address; a lit one outranks it
  // under the same rank order as the group door.
  return override || FOUNDER_ONION_DOORS[entry.id] || String(entry.url || '').trim();
}

export function listEgress(config = readNetworkConfig()) {
  return EGRESS.map((entry) => {
    const override = String(config.overrides?.[entry.id] || '').trim();
    if (entry.called === false) {
      return { ...entry, override, active: '', transport: 'unused', blocked: false };
    }
    if (override === 'off') {
      return { ...entry, override, active: '', transport: 'off', blocked: false };
    }
    if (entry.dynamic) {
      return { ...entry, override, active: '', transport: 'depends', blocked: false };
    }
    if (!entry.url && !override) {
      return { ...entry, override, active: '', transport: 'unset', blocked: false };
    }
    const active = activeUrl(entry, config);
    const transport = !active ? 'blocked' : isOnionUrl(active) ? 'tor' : 'clearnet';
    return { ...entry, override, active, transport, blocked: transport === 'blocked' };
  });
}

function extraUrls(setName, config) {
  const lists = config.lists || {};
  if (['profile', 'profileEditor', 'profileRead', 'username'].includes(setName)) return lists.profile || [];
  if (setName === 'general' || setName === 'product') return lists.dm || [];
  return [];
}

export function urlsFor(setName, config = readNetworkConfig()) {
  const ids = RELAY_SETS[setName] || [];
  const urls = [];
  const push = (url) => {
    const trimmed = String(url || '').trim();
    if (!trimmed || urls.includes(trimmed)) return;
    urls.push(trimmed);
  };
  for (const id of ids) push(activeUrl(entryById(id), config));
  for (const url of extraUrls(setName, config)) push(url);
  return urls;
}

export function groupSocketUrl(config) {
  return urlsFor('group-only', config)[0] || '';
}

export function groupRelayHttp(config) {
  const ws = groupSocketUrl(config);
  if (!ws) return '';
  try {
    const url = new URL(ws);
    url.protocol = url.hostname.endsWith('.onion') || url.protocol === 'ws:' ? 'http:' : 'https:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch {
    return '';
  }
}

export function blossomServers(config) {
  return urlsFor('blossom', config);
}

export function linkPreviewEndpoint(target, config) {
  const base = urlsFor('preview', config)[0];
  if (!base || !target) return '';
  return `${base.replace(/\/$/, '')}/?url=${encodeURIComponent(target)}`;
}
