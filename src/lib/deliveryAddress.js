// The buyer's physical shipping address, gathered at checkout. Required on
// every Cipher shop order (founder pin, 2026-10-27) — incomplete until the
// fields are filled, nothing gates with a modal.
//
// DATA SHAPE (Deal's lane, carrier evaluation): the address object is
//   { name, lines[1..4], city, region, postal, country }
// but it NEVER rides in the order body — the order carries a pointer only:
//   delivery: { note: <dead-drop url> }
// and the address itself is sealed into a burn-once dead-drop note at send.
// This module maps the form's fields onto that shape and does the LOCAL
// SHAPE CHECKS (founder law: no autocomplete, no third-party address
// lookup ever — egress law). Deal's validation module replaces the checks
// when it lands; keep these exports, drop the bodies.
//
// The words under the fields are Money Moves' spec, verbatim.

// A US written recognizably still earns the US shape checks.
const US_REASON = /^\s*(?:u\.?\s?s\.?\s?|usa|united states(?: of america)?)\s*$/i;
// Deal's pin: US → two-letter state, postal five digits or five-plus-four.
const US_REGION = /^[A-Za-z]{2}$/;
const US_POSTAL = /^\d{5}(?:-\d{4})?$/;

// The form's state: six fields, labels per Money Moves. Country arrives
// prefilled US; a cleared country is its own miss.
export function emptyDelivery() {
  return { name: '', street: '', city: '', state: '', postalCode: '', country: 'US' };
}

// Map the form onto Deal's field shape. Called only after the checks pass.
export function addressFromForm(form) {
  const value = form || {};
  return {
    name: String(value.name || '').trim(),
    lines: [String(value.street || '').trim()].filter(Boolean),
    city: String(value.city || '').trim(),
    region: String(value.state || '').trim(),
    postal: String(value.postalCode || '').trim(),
    country: String(value.country || '').trim(),
  };
}

// The exact string sealed into the dead-drop note — Deal's open path
// parses this back. One object, their field names.
export function sealedNoteText(form) {
  return JSON.stringify(addressFromForm(form));
}

// One miss object per broken field, in form order; an empty list means the
// address is sealable. Messages are Money Moves' spec words verbatim.
// `field` is the form field's key, so the form paints the miss under it.
export function deliveryMisses(form) {
  const value = form || {};
  const isUs = US_REASON.test(String(value.country || ''));
  const misses = [];
  if (!String(value.name || '').trim()) {
    misses.push({ field: 'name', message: 'Who is this going to?' });
  }
  if (!String(value.street || '').trim()) {
    misses.push({ field: 'street', message: 'We need a street.' });
  }
  if (!String(value.city || '').trim()) {
    misses.push({ field: 'city', message: 'Which city?' });
  }
  if (!String(value.state || '').trim()) {
    misses.push({ field: 'state', message: 'Add the state.' });
  } else if (isUs && !US_REGION.test(String(value.state || '').trim())) {
    misses.push({ field: 'state', message: 'Check the state — two letters.' });
  }
  const postal = String(value.postalCode || '').trim();
  if (!postal || (isUs && !US_POSTAL.test(postal))) {
    misses.push({ field: 'postalCode', message: 'Check the postal code.' });
  }
  if (!String(value.country || '').trim()) {
    misses.push({ field: 'country', message: 'Which country?' });
  }
  return misses;
}

// The form's misses as a field-keyed map, for the moment Send is tapped: every
// required field speaks at once.
export function deliveryMissMap(form) {
  const map = {};
  for (const miss of deliveryMisses(form)) map[miss.field] = miss.message;
  return map;
}

// One field's turn. A field speaks only after it has been left (blur) or Send
// was tapped — typing in one field must not paint the others. This refreshes
// that one field's line and leaves every other field exactly as it was.
export function withFieldMiss(current, form, field) {
  const next = { ...(current || {}) };
  const miss = deliveryMisses(form).find((item) => item.field === field);
  if (miss) next[field] = miss.message;
  else delete next[field];
  return next;
}

// ————— vendor side: the sealed text read back out —————

// The note text sealedNoteText wrote ({name, lines, city, region, postal,
// country}) mapped back onto the form, then run through the SAME local
// shape checks — the vendor validates the address locally exactly like the
// buyer did, no third-party lookup ever. A note that holds no readable
// address is one miss on the note itself and is never guessed into a
// delivery. The caller decides the order of save and burn; this only reads.
export function deliveryFromNoteText(noteText) {
  const NOTE_MISS = 'The note did not hold a readable address.';
  let parsed;
  try { parsed = JSON.parse(String(noteText || '')); } catch {
    return { form: emptyDelivery(), misses: [{ field: 'note', message: NOTE_MISS }] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { form: emptyDelivery(), misses: [{ field: 'note', message: NOTE_MISS }] };
  }
  const read = (value) => (typeof value === 'string' ? value : '');
  const lines = Array.isArray(parsed.lines) ? parsed.lines : (parsed.lines ? [parsed.lines] : []);
  const form = {
    name: read(parsed.name),
    street: read(lines[0]),
    city: read(parsed.city),
    state: read(parsed.region),
    postalCode: read(parsed.postal),
    country: read(parsed.country),
  };
  return { form, misses: deliveryMisses(form) };
}
