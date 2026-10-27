// The public numbers of a vendor shop: "N deals proven", as a txid bulletin.
//
// Founder ruling ("people check people themselves"): the shop's trust is the
// txids themselves, published so anyone can check one. This device never
// calls a public block explorer — the reader checks on their own terms.
// Amounts are NEVER public on any rail: a txid proves a payment happened
// (on XMR, exactly that — the chain itself hides the amount), never how
// much. The phrasing is law, and the screen lane renders it verbatim:
//   BTC-settled — "N deals proven. One tap shows the txids." (self-attesting)
//   XMR-settled — "N deals recorded on chain." (existence, not value)
//
// The bulletin event (kind 10007) is published by the vendor's data layer.
// THE COUNT IS THE TXIDS: proven count = txids.length, derived in exactly
// one place (dealsProvenFor here), never counted per-screen and never
// re-derived. A vendor-reported figure (kind 10008) is a different KIND, so
// a number without published txids is structurally incapable of entering
// the proven count — excluded by shape, not by convention.

import { ASSETS, CHAIN_WORD } from './paymentState.js';

export const BULLETIN_KIND = 10007;
export const VENDOR_REPORT_KIND = 10008;

const HEX64 = /^[0-9a-f]{64}$/;
// The rails the stats law speaks for come from the asset table itself, so a
// new coin row is pulled in by the same config that declares it — rails are
// never counted here in hand.
const RAILS = new Set(Object.keys(ASSETS));

// The phrasing law, generalized the way the law generalizes: a transparent
// chain self-attests, so its word is "proven" with the txids one tap away;
// a chain that hides its own amounts proves existence, not value, so its
// word is "recorded" — view keys are never published on either. A rail the
// asset table does not know has no banner at all.
const CHAIN_PHRASING = {
  transparent: 'N deals proven. One tap shows the txids.',
  'hidden-amount': 'N deals recorded on chain.',
};

// One vendor's bulletin, newest valid event per rail wins (single source of
// truth per p+rail). Returns null when the event is not a bulletin for the
// rail named in it — bad JSON, a foreign rail word, a non-hex txid, or a
// rail that does not exist all fail closed.
export function parseBulletin(event) {
  if (!event || event.kind !== BULLETIN_KIND) return null;
  const tag = (name) => String(event.tags?.find((row) => row[0] === name)?.[1] || '').toLowerCase();
  const rail = tag('rail');
  if (!RAILS.has(rail)) return null;
  if (tag('bulletin') !== 'proven') return null;
  const vendor = String(event.pubkey || '').toLowerCase();
  if (!HEX64.test(vendor)) return null;
  let body = null;
  try { body = JSON.parse(event.content || ''); } catch { return null; }
  const rows = Array.isArray(body?.txids) ? body.txids : [];
  const txids = [];
  for (const row of rows) {
    const txid = String(row || '').toLowerCase().trim();
    if (!HEX64.test(txid) || txids.includes(txid)) continue;
    txids.push(txid);
  }
  if (!txids.length) return null;
  return { vendor, rail, txids };
}

// The screen lane's whole seam. events = whatever the vendor's published
// records fetched (10007 and anything else — non-bulletins are ignored).
// Vendor-reported entries never reach here, so they cannot mix with the
// proven number however they are labeled.
export function dealsProvenFor(vendorPubkey, events) {
  const vendor = String(vendorPubkey || '').toLowerCase();
  const newest = new Map(); // rail → parsed bulletin
  for (const event of events || []) {
    const parsed = parseBulletin(event);
    if (!parsed || parsed.vendor !== vendor) continue;
    const held = newest.get(parsed.rail);
    if (!held || event.created_at >= held.created_at) newest.set(parsed.rail, { ...parsed, created_at: event.created_at });
  }
  const out = {};
  for (const rail of RAILS) {
    const bulletin = newest.get(rail);
    if (!bulletin) continue;
    out[rail] = { count: bulletin.txids.length, txids: bulletin.txids, phrasing: wordFor(rail) };
  }
  return out;
}

// The short tag inside a proved entry: proven on a chain that shows its
// amounts, recorded on a chain that hides them — read off the asset table
// so a new coin row carries its own word. A rail the table does not know
// has no word.
export function wordFor(rail) {
  return CHAIN_WORD[ASSETS[String(rail || '').toLowerCase()]?.chain] || null;
}

// The verbatim banner strings. phrasingFor tells the screen which one speaks
// for the rail — read off the asset table's chain class, so adding a coin
// configures its banner instead of editing this law. The exact words live
// here so data and screens never drift.
export function phrasingFor(rail) {
  return CHAIN_PHRASING[ASSETS[String(rail || '').toLowerCase()]?.chain] || null;
}
