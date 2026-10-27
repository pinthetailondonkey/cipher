import assert from 'node:assert/strict';
import test from 'node:test';
import { BULLETIN_KIND, VENDOR_REPORT_KIND, dealsProvenFor, parseBulletin, phrasingFor } from './vendorStats.js';

const VENDOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const bulletinEvent = ({ vendor = VENDOR, rail = 'btc', txids, created_at = 1000, kind = BULLETIN_KIND }) => ({
  kind,
  pubkey: vendor,
  created_at,
  tags: [['rail', rail], ['bulletin', 'proven']],
  content: JSON.stringify({ txids }),
});

test('a bulletin parses only what is honest: right kind, a real rail, the proven word, hex txids', () => {
  const good = bulletinEvent({ txids: ['ab'.repeat(32), 'cd'.repeat(32)] });
  assert.deepEqual(parseBulletin(good), { vendor: VENDOR, rail: 'btc', txids: ['ab'.repeat(32), 'cd'.repeat(32)] });
  assert.equal(parseBulletin({ ...good, kind: VENDOR_REPORT_KIND }), null, 'a vendor-reported number is never a bulletin');
  assert.equal(parseBulletin({ ...good, tags: [['rail', 'usd'], ['bulletin', 'proven']] }), null, 'no rails beyond the coin ones');
  assert.equal(parseBulletin({ ...good, tags: [['rail', 'btc'], ['bulletin', 'vendor-said']] }), null, 'the label must be proven');
  assert.equal(parseBulletin({ ...good, content: '{not json' }), null);
  assert.equal(parseBulletin({ ...good, content: JSON.stringify({ txids: ['zz'] }) }), null, 'a txid is 64 hex or it is nothing');
  assert.equal(parseBulletin({ ...good, content: JSON.stringify({ txids: [] }) }), null, 'an empty bulletin answers nothing');
  assert.equal(parseBulletin({ ...good, content: JSON.stringify({ txids: ['ab'.repeat(32)], amount: '1.5' }) }).txids.length, 1, 'amounts ride along but nothing reads them');
});

test('dealsProvenFor counts the txids — one derivation, newest event per rail wins', () => {
  const events = [
    bulletinEvent({ rail: 'btc', txids: ['11'.repeat(32)], created_at: 1000 }),
    bulletinEvent({ rail: 'xmr', txids: ['22'.repeat(32), '33'.repeat(32)], created_at: 1000 }),
    // A replacement bulletin for the same rail: the newest one is the count.
    bulletinEvent({ rail: 'btc', txids: ['11'.repeat(32), '44'.repeat(32)], created_at: 2000 }),
    // A second device of the same vendor published older data first; it loses.
    bulletinEvent({ rail: 'btc', txids: ['55'.repeat(32)], created_at: 1500 }),
    // Another vendor's bulletin never answers for this one.
    bulletinEvent({ vendor: OTHER, rail: 'btc', txids: ['66'.repeat(32)] }),
    // A vendor-reported event with a whole txid list still never counts:
    // it is the wrong kind, whatever it carries.
    bulletinEvent({ rail: 'btc', txids: ['77'.repeat(32)], kind: VENDOR_REPORT_KIND }),
  ];
  const out = dealsProvenFor(VENDOR, events);
  assert.deepEqual(out.btc, { count: 2, txids: ['11'.repeat(32), '44'.repeat(32)], phrasing: 'proven' });
  assert.deepEqual(out.xmr, { count: 2, txids: ['22'.repeat(32), '33'.repeat(32)], phrasing: 'recorded' });
  assert.deepEqual(dealsProvenFor(OTHER, events), {});
  assert.deepEqual(dealsProvenFor(VENDOR, []), {});
  assert.equal(dealsProvenFor(null, events), {});
});

test('the phrasing law is the data layer\'s, verbatim', () => {
  assert.equal(phrasingFor('btc'), 'N deals proven. One tap shows the txids.');
  assert.equal(phrasingFor('xmr'), 'N deals recorded on chain.');
  assert.equal(phrasingFor('usd'), null);
});

test('bulletin txids deduplicate', () => {
  const parsed = parseBulletin(bulletinEvent({ txids: ['ab'.repeat(32), 'ab'.repeat(32)] }));
  assert.deepEqual(parsed.txids, ['ab'.repeat(32)]);
});
