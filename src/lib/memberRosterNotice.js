// What the member area says while it has no list to show, as one rule.
//
// The old line was `{memberList.length === 0 && 'Looking up members…'}`: it
// appeared whenever the list was empty, whether a read was running, had
// failed, or had returned nothing — a claim of progress that never expired.
// A read that fails leaves the list empty forever, so the screen said
// "still looking" for as long as the panel stayed open. Unknown has to look
// like absent, not like busy.
//
// The three states this rule keeps apart:
//   roster known                 -> the number, and no line, ever
//   not known, a read in flight  -> the line
//   not known, read settled      -> nothing at all: no line, no number
export const LOOKING_UP_MEMBERS = 'Looking up members…';

export function rosterNotice({ rosterKnown, loading } = {}) {
  // A live roster can land while this panel's own read is still in flight.
  // Progress must never be drawn over a number that is already on screen.
  if (rosterKnown) return '';
  return loading ? LOOKING_UP_MEMBERS : '';
}

// Whether a read is in flight, from what the last settle reported and which
// group is on screen. Keyed by group id so switching chats is in flight again
// the instant the id changes, without a setState at the start of the effect —
// and so a read for the previous group that settles late cannot report the
// new group as done. It has nothing to be in flight about with no group open.
export function rosterInFlight({ settledGroupId = null, openGroupId = null, done = false } = {}) {
  if (!openGroupId) return false;
  return settledGroupId !== openGroupId || !done;
}

// A read that outlives the panel that started it must not move that panel.
// The sidebar re-runs its effect when the group changes, so a slow read for
// the previous group settles after the effect for the new one has started;
// without this gate it would clear the new group's in-flight state and the
// panel would go quiet — or flash — because of a call about another group.
// Still pending when the panel unmounts is the same case with nothing left
// to move: the gate is closed and the settle is dropped.
export function createSettleGate() {
  let open = true;
  return {
    close() { open = false; },
    isOpen() { return open; },
    settle(run) {
      if (!open) return false;
      run();
      return true;
    },
  };
}
