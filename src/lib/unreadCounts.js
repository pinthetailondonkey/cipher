// Unread counts, from the database. A chat's count is the messages from the
// other side newer than its lastRead marker, not deleted on this device, each
// counted once by id.
export function unreadCountsFor(messages, reads, deletedIds = []) {
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds);
  const seen = new Set();
  const counts = {};
  for (const msg of messages || []) {
    if (!msg || msg.isSender || !msg.chatId) continue;
    if (msg.id !== undefined) {
      if (deleted.has(msg.id) || seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    const lastRead = Number(reads?.[msg.chatId]) || 0;
    if (msg.timestamp > lastRead) counts[msg.chatId] = (counts[msg.chatId] || 0) + 1;
  }
  return counts;
}

// A message that just arrived live. History already counted every stored
// message, so a copy the database already holds adds nothing; a message
// deleted here adds nothing; a chat that is open is being read.
export function countsAsNewUnread({ alreadyStored, tombstoned, isSender, chatOpen, timestamp, lastRead }) {
  if (alreadyStored || tombstoned || isSender || chatOpen) return false;
  return Number(timestamp) > (Number(lastRead) || 0);
}
