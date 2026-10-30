// Chat order: messages sort by when this device got or made them — the local
// millisecond stamp, then a monotonic arrival counter for ties inside the same
// millisecond, and only then the relay event id. The id alone was a random
// tiebreak: two same-second messages could land in either order, so a fresh
// reply could rise above the message it answers, and a reply to a
// clock-skewed sender sorted by the sender's clock instead of arrival.
// Rows without a stamp (history written before this) keep working: the id
// compare is the last resort.
let arrivalSeq = 0;
export const stampArrival = (message) => {
  if (message) message.arrival = ++arrivalSeq;
  return message;
};

export const sortMessages = (a, b) => {
  const timeA = a.local_timestamp || (a.timestamp * 1000);
  const timeB = b.local_timestamp || (b.timestamp * 1000);
  if (timeA !== timeB) return timeA - timeB;
  if (a.arrival !== b.arrival) return (a.arrival || 0) - (b.arrival || 0);
  return (a.id || '').localeCompare(b.id || '');
};
