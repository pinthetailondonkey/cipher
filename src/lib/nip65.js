function unique(urls) {
  const out = [];
  for (const url of urls || []) {
    const trimmed = String(url || '').trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function parseRelayList(event) {
  const read = [];
  const write = [];
  for (const tag of event?.tags || []) {
    if (tag[0] !== 'r' || !tag[1]) continue;
    const url = String(tag[1]).trim();
    if (tag[2] === 'read') read.push(url);
    else if (tag[2] === 'write') write.push(url);
    else {
      read.push(url);
      write.push(url);
    }
  }
  return { read: unique(read), write: unique(write) };
}

export function relayListTags(read, write) {
  const readSet = new Set(unique(read));
  const writeSet = new Set(unique(write));
  const tags = [];
  for (const url of unique([...readSet, ...writeSet])) {
    const canRead = readSet.has(url);
    const canWrite = writeSet.has(url);
    if (canRead && canWrite) tags.push(['r', url]);
    else if (canRead) tags.push(['r', url, 'read']);
    else tags.push(['r', url, 'write']);
  }
  return tags;
}

export function partitionWriteRelay(peer, writeRelays) {
  const relays = unique(writeRelays);
  if (relays.length <= 1) return relays;
  let hash = 0;
  const text = String(peer || '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  return [relays[hash % relays.length]];
}

export const MAX_PEER_RELAYS = 5;

const ONION_URL = /^wss?:\/\/[^/?#]*\.onion(?::\d+)?(?:[/?#]|$)/i;

function isIpLiteral(host) {
  if (host.includes(':') || host.startsWith('[')) return true;
  // Dotted quads, plus the bare-number and hex forms a URL parser also reads as an address.
  return /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host.split('.').pop());
}

// A relay a stranger names is theirs to name, not ours to trust. Only a wss://
// address (or a .onion, which Tor already wraps) on a real public hostname is
// kept. Never loopback, a private or link-local address, an IP literal, a
// single-label name, or a link with a login in it.
export function safePeerRelay(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (!host || host.endsWith('.') || url.username || url.password) return '';
  const onion = host.endsWith('.onion') && host.length > '.onion'.length;
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && onion)) return '';
  if (!onion) {
    if (isIpLiteral(host) || !host.includes('.')) return '';
    if (!/^[a-z0-9.-]+$/.test(host)) return '';
    if (/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|arpa)$/.test(host)) return '';
  }
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

// Dedupe, keep what passes safePeerRelay, drop anything already ours, cap the
// count. When every relay of ours is an onion, a clearnet peer relay would put
// our address on an open connection the Tor-only setup forbids, so those go too.
export function safePeerRelays(urls, ours = []) {
  const mine = unique(ours);
  const torOnly = mine.length > 0 && mine.every((url) => ONION_URL.test(url));
  const out = [];
  for (const raw of urls || []) {
    const url = safePeerRelay(raw);
    if (!url || out.includes(url) || mine.includes(url)) continue;
    if (torOnly && !ONION_URL.test(url)) continue;
    out.push(url);
    if (out.length >= MAX_PEER_RELAYS) break;
  }
  return out;
}

// A peer with no published inbox stays on our first relay, so the message is
// not partitioned onto a relay they do not read. A peer with an inbox is
// written to that inbox and to one of our relays, chosen from the peer, so
// no single relay holds every conversation.
export function dmTargets({ peer, ourWrite, theirRead } = {}) {
  const ours = unique(ourWrite);
  const theirs = safePeerRelays(theirRead, ours);
  if (!ours.length && !theirs.length) return [];
  if (!theirs.length) return ours.length ? [ours[0]] : [];
  return unique([...partitionWriteRelay(peer, ours), ...theirs]);
}
