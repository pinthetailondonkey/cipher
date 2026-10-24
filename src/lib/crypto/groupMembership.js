function pubkeyOf(member) {
  return typeof member === 'string' ? member : member?.pubkey;
}

export function isCurrentMember(members, pubkey) {
  if (!pubkey || !Array.isArray(members)) return false;
  return members.some((member) => pubkeyOf(member) === pubkey);
}

export function isGroupAdmin(members, pubkey, creator) {
  if (!pubkey) return false;
  if (creator && pubkey === creator) return true;
  const row = (Array.isArray(members) ? members : []).find((member) => pubkeyOf(member) === pubkey);
  return !!row && typeof row !== 'string' && row.role === 'admin';
}

export function authorizeGroupControl({ kind, sender, subject, members, creator }) {
  if (!sender) return false;
  if (kind === 9022) return sender === subject;
  if (kind === 9021) return sender === subject;
  if (kind === 9000 || kind === 9001 || kind === 9002 || kind === 39002) {
    return isGroupAdmin(members, sender, creator);
  }
  return false;
}
