// The public numbers of a vendor shop: "N deals proven", as a receipt-hash
// bulletin.
//
// Founder ruling ("people check people themselves"): the shop's trust is
// the proofs themselves, published so anyone can check one. This device
// never calls a public block explorer — the reader checks on their own
// terms. Amounts are NEVER public on any rail, and neither is the txid:
// a raw txid on a transparent chain lets any explorer resolve amount and
// time, which undoes the amount privacy the receipt just bought. So the
// bulletin binds each deal to the receipt hash of a countersigned receipt
// (proofOfTrade.receiptHash — the same hash a vouch binds to), never the
// txid itself. A party who wants to show their work shows the receipt;
// the wire carries only the hash.
// The count IS the list: a bulletin carries hashes and nothing else — no
// amounts on any rail, no claimed totals, no vendor-reported counts. The
// tag is written from the same constants the reader demands, so a
// publisher cannot drift out of its own format.
//
// (F8: the bulletin's txids were raw until this ruling. A receipt hash is
// as checkable — the hash is what a public view and a vouch already bind
// to — and resolves to nothing without the receipt in hand.)
//
// The bulletin event (kind 10007) is published by the vendor's data layer.
// THE COUNT IS THE HASHES: proven count = hashes.length, derived in exactly
// one place (dealsProvenFor here), never counted per-screen and never
// re-derived. A vendor-reported figure (kind 10008) is a different KIND, so
// a number without published proofs is structurally incapable of entering
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
// chain self-attests, so its word is "proven" with the proofs one tap away;
// a chain that hides its own amounts proves existence, not value, so its
// word is "recorded" — view keys are never published on either. A rail the
// asset table does not know has no banner at all. The proof shown on tap
// is the receipt hash list: checkable against a receipt a party hands
// over, silent about amount and time to everyone else.
const CHAIN_PHRASING = {
  transparent: 'N deals proven. One tap shows the proofs.',
  'hidden-amount': 'N deals recorded on chain.',
};

// One vendor's bulletin, newest valid event per rail wins (single source of
// truth per p+rail). Returns null when the event is not a bulletin for the
// rail named in it — bad JSON, a foreign rail word, a non-hex hash, or a
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
  // The wire key is hashes. txids stays as a read alias for bulletins an
  // older build already published: a replaceable kind means every old
  // copy sits beside the new one until superseded, and dropping the alias
  // would zero the proven count for vendors who published before this
  // change instead of asking them to republish first.
  const rows = Array.isArray(body?.hashes) ? body.hashes : Array.isArray(body?.txids) ? body.txids : [];
  const hashes = [];
  for (const row of rows) {
    const hash = String(row || '').toLowerCase().trim();
    if (!HEX64.test(hash) || hashes.includes(hash)) continue;
    hashes.push(hash);
  }
  if (!hashes.length) return null;
  return { vendor, rail, hashes };
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
    out[rail] = { count: bulletin.hashes.length, hashes: bulletin.hashes, phrasing: wordFor(rail) };
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

// ————— the publisher's seam —————
//
// A vendor publishes their own bulletin (kind 10007, replaceable per rail
// by the 'rail' tag convention this layer reads back). The count IS the
// list: a bulletin carries receipt hashes and nothing else — no amounts on
// any rail (BTC too: this wire never says how much a deal moved), no
// claimed totals, no vendor-reported counts. The tag is written from the
// same constants the reader demands, so a publisher cannot drift out of
// its own format.
export function bulletinTags(rail) {
  return [['rail', String(rail || '').toLowerCase()], ['bulletin', 'proven']];
}

// The bulletin content, and the pure guard the compose side runs before
// signing. Fails closed with a word: not a rail the table knows, a hash
// that is not 64 hex, duplicates in the hand-entered list, or an empty
// list — a bulletin with no proofs answers nothing. The entries are
// receipt hashes (F8): a raw txid lets any explorer resolve amount and
// time on a transparent chain, and the bulletin never needs it — a proof
// is checkable through the receipt, which stays between the parties.
export function bulletinRefusal(rail, hashes) {
  const rows = Array.isArray(hashes) ? hashes : [];
  const list = [];
  for (const row of rows) {
    const hash = String(row || '').toLowerCase().trim();
    if (!HEX64.test(hash)) return 'A receipt hash is 64 hex characters, or it is nothing.';
    if (list.includes(hash)) return 'The same receipt twice proves one deal, not two — drop the duplicate.';
    list.push(hash);
  }
  if (!list.length) return 'A bulletin proves deals with their receipt hashes — paste at least one.';
  if (!phrasingFor(rail)) return 'This device does not know that chain, so it cannot speak a bulletin on it.';
  return null;
}

export function bulletinContent(hashes) {
  return JSON.stringify({ hashes });
}
