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

// A peer with no published inbox stays on our first relay, so the message is
// not partitioned onto a relay they do not read. A peer with an inbox is
// written to that inbox and to one of our relays, chosen from the peer, so
// no single relay holds every conversation.
export function dmTargets({ peer, ourWrite, theirRead } = {}) {
  const ours = unique(ourWrite);
  const theirs = unique(theirRead);
  if (!ours.length && !theirs.length) return [];
  if (!theirs.length) return ours.length ? [ours[0]] : [];
  return unique([...partitionWriteRelay(peer, ours), ...theirs]);
}
