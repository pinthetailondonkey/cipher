import assert from 'node:assert/strict';
import test from 'node:test';
import { withPaymentLedgerLock } from './paymentLedgerLock.js';

test('payment ledger lock is exclusive and scoped per account', async () => {
  const calls = [];
  const locks = {
    request: async (...args) => {
      calls.push(args.slice(0, 2));
      return args[2]();
    },
  };
  assert.equal(await withPaymentLedgerLock(async () => 'confirmed', { scope: 'account-a', locks }), 'confirmed');
  assert.deepEqual(calls, [[
    'cipher-consumed-ledger:account-a', { mode: 'exclusive' },
  ]]);
});

test('payment confirmation refuses safely when cross-tab locking is unavailable', async () => {
  let ran = false;
  await assert.rejects(
    withPaymentLedgerLock(async () => { ran = true; }, { scope: 'account-a', locks: null }),
    /cannot safely coordinate payment checks/,
  );
  assert.equal(ran, false);
});
