// src/lib/groupMetaAnnouncement.js
// A kind-9002 group-metadata edit deserves a timeline announcement only when
// it actually changes what this device has already applied. The group
// timeline sub replays the group's metadata on every resync (around sends),
// and the in-memory sys-<event-id> dedup dies whenever the bootstrap refresh
// rebuilds the timeline from the database — so the announcement cannot rely
// on event ids. It must compare against the metadata the group record
// already carries: its stored name/about and the created_at of the newest
// 9002 applied to it.

// Returns { text, name?, about?, appliedAt } for a genuine change, or null
// when the event is older than what is already applied or changes nothing.
// `text` keeps the exact wording the timeline has always used; the caller
// applies the returned name/about so the next replay stays silent.
export function groupMetaAnnouncement({ current = {}, name = '', about = '', createdAt = 0, appliedAt = 0 } = {}) {
  const at = createdAt || 0;
  if (at < (appliedAt || 0)) return null;
  const changes = {};
  const incomingName = typeof name === 'string' ? name : '';
  if (incomingName && incomingName !== current.name) changes.name = incomingName;
  const incomingAbout = typeof about === 'string' ? about : '';
  if (incomingAbout && incomingAbout !== current.about) changes.about = incomingAbout;
  if (!changes.name && !changes.about) return null;
  const text = changes.name
    ? `Group name was changed to "${changes.name}"`
    : 'Group description was updated';
  return { text, ...changes, appliedAt: at };
}
