import assert from 'node:assert/strict';
import test from 'node:test';
import { HALF_LIFE_SECONDS, arbitrationStatement, creditBetween, decayWeight, reputation, rugRegistry } from './trust.js';

const now = 1_700_000_000;

test('reputation decays, a rug is listed, arbitration moves no money, and credit is between two keys', () => {
  assert.equal(decayWeight(now, now), 1);
  assert.equal(decayWeight(now - HALF_LIFE_SECONDS, now), 0.5);
  const fresh = { hash: 'aa', body: { buyer: 'bb', vendor: 'vv', amount: '4', at: now, outcome: 'confirmed' } };
  const old = { hash: 'bb', body: { buyer: 'bb', vendor: 'vv', amount: '4', at: now - HALF_LIFE_SECONDS, outcome: 'confirmed' } };
  const rug = { hash: 'cc', body: { buyer: 'bb', vendor: 'rr', amount: '9', at: now, outcome: 'rugged', address: '8secret', txid: 'dead' } };
  const disputed = { hash: 'dd', body: { buyer: 'bb', vendor: 'vv', amount: '100', at: now, outcome: 'disputed' } };
  assert.deepEqual(reputation([fresh, old, rug, disputed], now), [
    { vendor: 'vv', score: 6 },
    { vendor: 'rr', score: -9 },
  ]);
  assert.deepEqual(rugRegistry([fresh, rug]), [{ vendor: 'rr', at: now, hash: 'cc' }]);
  const statement = arbitrationStatement({ hash: 'dd', finding: 'upheld', arbitrator: 'AA', at: now });
  assert.equal(statement.finding, 'upheld');
  assert.equal(JSON.stringify(statement).includes('8secret'), false);
  assert.equal(JSON.stringify(statement).includes('txid'), false);
  assert.throws(() => arbitrationStatement({ hash: 'dd', finding: 'paid', arbitrator: 'aa' }), /upheld or denied/);
  assert.equal(creditBetween('bb', 'vv', [fresh, old, rug, disputed], now), 6);
  assert.equal(creditBetween('bb', 'rr', [fresh, rug], now), 0);
});
