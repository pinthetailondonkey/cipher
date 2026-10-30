// What a send actually did, in one place.
//
// The composer used to decide this three times by hand, and the callers fired
// their "sent" toast on the return value alone, so a send the relays refused
// reported success one line after reporting the failure. One function answers
// for every path: 'sent', 'queued' (signed and held in the outbox, no relay
// has it yet), 'securing' (a group message waiting on a key) or 'failed'.
// Only 'sent' earns a sent toast, and only 'sent' earns a sent word in the
// bubble: the outbox will keep trying, but nothing has it yet.
export function sendOutcome(result) {
  if (result?.success !== true) {
    // A group message with no key yet is not a failure: the bubble says so
    // and the send goes out once the key arrives.
    return result?.error === 'NO_KEY' ? 'securing' : 'failed';
  }
  // Success with no event id is not a message anyone can read back.
  if (!result.event?.id) return 'failed';
  return result.queued === true ? 'queued' : 'sent';
}
