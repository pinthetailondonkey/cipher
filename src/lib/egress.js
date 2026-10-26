const STORAGE_KEY = 'cipher_network';

// Every host the app can contact. A new outbound host belongs here, not inline.
// `called: false` is a host the old page policy allowed and the app does not use.
export const EGRESS = [
  { id: 'group-relay', role: 'Group relay', url: 'wss://groups.aegispayhq.com', sees: 'Your IP, and every group you open', required: true },
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
  { id: 'dead-drop', role: 'Burn notes', url: 'https://cipherlinkhere.com', sees: 'Your IP when a burn note link is opened there. The note itself lives on the message relay as ciphertext; this host only serves the link page. The key to open it rides in the link fragment, which never reaches any server.' },
  { id: 'stun-google', role: 'Call routing', url: 'stun:stun.l.google.com:19302', sees: 'Your IP while a call connects. It never carries the audio.' },
  { id: 'stun-google-1', role: 'Call routing', url: 'stun:stun1.l.google.com:19302', sees: 'Your IP while a call connects. It never carries the audio.' },
  { id: 'stun-twilio', role: 'Call routing', url: 'stun:global.stun.twilio.com:3478', sees: 'Your IP while a call connects. It never carries the audio.' },
  { id: 'turn', role: 'Call relay', url: 'turn:openrelayproject:openrelayproject@openrelay.metered.ca:80?transport=tcp', hint: 'Built in. Swap it or turn it off in the Advanced panel of this Connections screen.', sees: 'Routes the audio when a direct link will not cross two networks. The relay sees your IP, never the audio: it is encrypted end to end.' },
  { id: 'dns', role: 'Name lookup', url: '', hint: 'This device’s resolver', sees: 'Every hostname, at the resolver on this device. Cipher cannot choose it or turn it off.', dynamic: true },
  { id: 'images', role: 'Pictures', url: '', hint: 'Each picture’s own host', sees: 'Your IP and the address of every chat or product picture. The browser fetches each host. The app does not choose that path.', dynamic: true },
  { id: 'profile-photo', role: 'Profile photos', url: '', hint: 'Each photo’s own host', sees: 'Your IP and whatever host a profile photo points at. A photo can be any site. The app does not proxy it.', dynamic: true },
  { id: 'app-host', role: 'App host', url: 'https://sonic-cobalt-4m6q5vj.vercel.app', hint: '', sees: 'Your IP if you open the website here. The installed app loads its own files and does not contact this host when it opens.', app: true },
  { id: 'nip05', role: 'Name lookup', url: '', hint: 'The host after the @', sees: 'Your IP and the name you look up. The host is whatever sits after the @.', dynamic: true },
  { id: 'explorer', role: 'Payment watcher', url: '', hint: 'Not set', sees: 'Nothing until you paste a watcher you run. This device does not ask a block explorer. Until then a payment cannot be marked seen or confirmed from the chain.' },
  { id: 'push', role: 'Push gateway', url: '', hint: 'Not set', sees: 'Nothing until you paste a gateway you run. A locked phone does not buzz before that. The notice says New message and does not include the text. The gateway still sorts messages by a plain-text label on each, which the message relay and anyone reading it can also see.' },
  { id: 'fcm', role: 'Android push', url: 'https://fcm.googleapis.com', sees: 'Nothing from the phone. The push box you run delivers a message or a call here when a Firebase key is set. The text is not included.', called: false },
  { id: 'fcm-auth', role: 'Android push', url: 'https://oauth2.googleapis.com', sees: 'Nothing from the phone. The push box trades its service-account key for a short-lived token here.', called: false },
  { id: 'fcm-scope', role: 'Android push', url: 'https://www.googleapis.com', sees: 'Nothing. The token request names this host as its permission scope. The box does not open a connection to it.', called: false },
  { id: 'apns', role: 'iOS push', url: 'https://api.push.apple.com', sees: 'Nothing from the phone. The push box you run delivers a message or a call here when an APNs key is set. The text is not included.', called: false },
];

export const RELAY_SETS = {
  general: ['dm-relay'],
  group: ['group-relay'],
  'group-only': ['group-relay'],
  search: ['dm-relay', 'search-vertex', 'search-noswhere'],
  profile: ['dm-relay', 'profile-nos'],
  profileEditor: ['dm-relay', 'profile-nos', 'profile-damus'],
  profileRead: ['profile-purple', 'profile-nos', 'dm-relay'],
  username: ['dm-relay', 'profile-nos'],
  product: ['dm-relay'],
  blossom: ['blossom-primal', 'blossom-nostr-build', 'blossom-band'],
  stun: ['stun-google', 'stun-google-1', 'stun-twilio'],
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
  return override || String(entry.url || '').trim();
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

function iceServerFrom(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const server = { urls: raw };
  try {
    // Accept both turn://user:pass@host and the spec form turn:user:pass@host.
    const withoutScheme = raw.replace(/^turns?:\/?\/?/i, '');
    const parsed = new URL(`https://${withoutScheme}`);
    if (parsed.username) server.username = decodeURIComponent(parsed.username);
    if (parsed.password) server.credential = decodeURIComponent(parsed.password);
    if (parsed.username || parsed.password) {
      // The login never rides in the urls prop; the browser gets it separately.
      server.urls = raw.replace(/^(turns?:)\/?\/?[^@/]*@/i, '$1');
    }
  } catch { /* a bare stun or turn URL is still usable */ }
  return server;
}

export function iceServers(config = readNetworkConfig()) {
  const servers = urlsFor('stun', config).map((urls) => ({ urls }));
  const turn = iceServerFrom(activeUrl(entryById('turn'), config));
  if (turn) servers.push(turn);
  return servers;
}

export function linkPreviewEndpoint(target, config) {
  const base = urlsFor('preview', config)[0];
  if (!base || !target) return '';
  return `${base.replace(/\/$/, '')}/?url=${encodeURIComponent(target)}`;
}
