import assert from 'node:assert/strict';
import test from 'node:test';
import { BULLETIN_KIND, VENDOR_REPORT_KIND, bulletinContent, bulletinRefusal, bulletinTags, dealsProvenFor, parseBulletin, phrasingFor } from './vendorStats.js';

const VENDOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const bulletinEvent = ({ vendor = VENDOR, rail = 'btc', hashes, txids = null, created_at = 1000, kind = BULLETIN_KIND }) => ({
  kind,
  pubkey: vendor,
  created_at,
  tags: [['rail', rail], ['bulletin', 'proven']],
  content: JSON.stringify(txids ? { txids } : { hashes }),
});

test('a bulletin parses only what is honest: right kind, a real rail, the proven word, hex hashes', () => {
  const good = bulletinEvent({ hashes: ['ab'.repeat(32), 'cd'.repeat(32)] });
  assert.deepEqual(parseBulletin(good), { vendor: VENDOR, rail: 'btc', hashes: ['ab'.repeat(32), 'cd'.repeat(32)] });
  assert.equal(parseBulletin({ ...good, kind: VENDOR_REPORT_KIND }), null, 'a vendor-reported number is never a bulletin');
  assert.equal(parseBulletin({ ...good, tags: [['rail', 'usd'], ['bulletin', 'proven']] }), null, 'no rails beyond the coin ones');
  assert.equal(parseBulletin({ ...good, tags: [['rail', 'btc'], ['bulletin', 'vendor-said']] }), null, 'the label must be proven');
  assert.equal(parseBulletin({ ...good, content: '{not json' }), null);
  assert.equal(parseBulletin({ ...good, content: JSON.stringify({ hashes: ['zz'] }) }), null, 'a hash is 64 hex or it is nothing');
  assert.equal(parseBulletin({ ...good, content: JSON.stringify({ hashes: [] }) }), null, 'an empty bulletin answers nothing');
  assert.equal(parseBulletin({ ...good, content: JSON.stringify({ hashes: ['ab'.repeat(32)], amount: '1.5' }) }).hashes.length, 1, 'amounts ride along but nothing reads them');
});

test('dealsProvenFor counts the hashes — one derivation, newest event per rail wins', () => {
  const events = [
    bulletinEvent({ rail: 'btc', hashes: ['11'.repeat(32)], created_at: 1000 }),
    bulletinEvent({ rail: 'xmr', hashes: ['22'.repeat(32), '33'.repeat(32)], created_at: 1000 }),
    // A replacement bulletin for the same rail: the newest one is the count.
    bulletinEvent({ rail: 'btc', hashes: ['11'.repeat(32), '44'.repeat(32)], created_at: 2000 }),
    // A second device of the same vendor published older data first; it loses.
    bulletinEvent({ rail: 'btc', hashes: ['55'.repeat(32)], created_at: 1500 }),
    // Another vendor's bulletin never answers for this one.
    bulletinEvent({ vendor: OTHER, rail: 'btc', hashes: ['66'.repeat(32)] }),
    // A vendor-reported event with a whole hash list still never counts:
    // it is the wrong kind, whatever it carries.
    bulletinEvent({ rail: 'btc', hashes: ['77'.repeat(32)], kind: VENDOR_REPORT_KIND }),
  ];
  const out = dealsProvenFor(VENDOR, events);
  assert.deepEqual(out.btc, { count: 2, hashes: ['11'.repeat(32), '44'.repeat(32)], phrasing: 'proven' });
  assert.deepEqual(out.xmr, { count: 2, hashes: ['22'.repeat(32), '33'.repeat(32)], phrasing: 'recorded' });
  // The same list answers each vendor from their own bulletin alone: OTHER
  // proves exactly their one hash, no more — also the proof that VENDOR's
  // derivation above never absorbed OTHER's hash.
  assert.deepEqual(dealsProvenFor(OTHER, events), { btc: { count: 1, hashes: ['66'.repeat(32)], phrasing: 'proven' } });
  assert.deepEqual(dealsProvenFor(VENDOR, []), {});
  assert.deepEqual(dealsProvenFor(null, events), {}, 'no vendor named, no count comes out');
});

test('the phrasing law is the data layer\'s, verbatim', () => {
  assert.equal(phrasingFor('btc'), 'N deals proven. One tap shows the proofs.');
  assert.equal(phrasingFor('xmr'), 'N deals recorded on chain.');
  assert.equal(phrasingFor('usd'), null);
});

test('bulletin hashes deduplicate', () => {
  const parsed = parseBulletin(bulletinEvent({ hashes: ['ab'.repeat(32), 'ab'.repeat(32)] }));
  assert.deepEqual(parsed.hashes, ['ab'.repeat(32)]);
});

test('bulletinRefusal: the publisher passes the same law the reader enforces', () => {
  const hash = 'aa'.repeat(32);
  assert.equal(bulletinRefusal('btc', [hash]), null, 'an honest bulletin composes');
  assert.equal(bulletinRefusal('xmr', [hash, 'bb'.repeat(32)]), null, 'any table rail composes');
  assert.match(bulletinRefusal('btc', ['zz']), /64 hex/, 'a hash is hex or nothing');
  assert.match(bulletinRefusal('btc', [hash, hash.toUpperCase()]), /duplicate/, 'case-folded duplicates refuse');
  assert.match(bulletinRefusal('btc', []), /at least one/, 'an empty bulletin answers nothing');
  assert.match(bulletinRefusal('usd', [hash]), /does not know that chain/, 'a rail the table does not declare is refused');
  assert.deepEqual(bulletinTags('BTC'), [['rail', 'btc'], ['bulletin', 'proven']], 'the tags are written the way the reader demands');
  assert.equal(bulletinContent([hash]), JSON.stringify({ hashes: [hash] }), 'the content is the receipt-hash list and nothing else');
});

// F8 witness: the wire shape carries no raw transaction id anywhere. The
// composer only ever emits { hashes }, and an old-build txid bulletin is
// read through the alias but never re-emitted. Red if either half regrows
// a txid key on the publishing side — the exact defect F8 was.
test('F8: the composer emits hashes and nothing else; an old txid bulletin still reads', () => {
  const hash = 'aa'.repeat(32);
  const composed = JSON.parse(bulletinContent([hash]));
  assert.ok(!('txids' in composed), 'the composer must not publish a txids key');
  assert.deepEqual(composed.hashes, [hash]);
  // Read alias: a bulletin published before this change keeps counting.
  const legacy = bulletinEvent({ txids: ['ef'.repeat(32)] });
  assert.deepEqual(parseBulletin(legacy).hashes, ['ef'.repeat(32)], 'an old txid bulletin counts until superseded');
});
