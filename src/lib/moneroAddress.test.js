import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMoneroAddress, deriveMoneroAddress } from './moneroAddress.js';

const PRIMARY = '46etjTvQYbgVNShCP2Ni9W9cfq3JYHDW685X25drxRSAN7nVRDoK4vff1uN2hpDUowiGDEWC4vw8MVco4o3chTvaDhdAVyD';
const VIEW = 'efcdab8967452301000000000000000000000000000000000000000000000000';

test('a view-only wallet derives the same subaddresses as Monero', () => {
  assert.equal(deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: VIEW, index: 0 }), PRIMARY);
  assert.equal(
    deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: VIEW, index: 1 }),
    '8A892SV9D6HEnvGADpxPcUjFvaPdB9xjCbJhoZMmwMo3KgakBgwBiuxX7fxzu8PEcybNDV39Q3VRmTYouQKFfFdt9hgFoER',
  );
  assert.equal(
    deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: VIEW.toUpperCase(), account: 0, index: 2 }),
    '84zpnuEvt2zGYJda91Tau15X7BpcEiUeRBZALraEQQFWTToG5Cn3eXxXougogsivNmfkCYGXRKwx7STWfvr2PZMJ78gUzMi',
  );
});

// These strings were produced by knaccc/subaddress-js 1.0.3, a separate implementation
// of the wallet rule: the index is a 32-bit little-endian integer, not one byte.
// A one-byte index matches through 127 and diverges at 128. Prefix 42 is the mainnet
// subaddress byte. decodeMoneroAddress rejects the string if the checksum skipped it.
test('high indexes match an independent wallet implementation', () => {
  const expected = {
    127: '82u2C7xzfkWgM4KXEqktpaGtNJbTex6W2bMXEmrhF78PAoqdw3iHhgVhyvqgT6KuJHNdeBPgb5Lh7X1kNut6u2VFRJLvnAo',
    128: '898tu2dqEXe7upoP4BmBcrT9hm37ETDmADDvDmCozzz7dpvNPBXa3FYho1u148UEH2XHPJDZ3cN9BBmAiHHb4MZmCMsQNz8',
    129: '8AWJbt3stsUZTy9qvp85gFhUtAAg1zSswZggtTKNEDd9PmfCa3SzJCNbZwUzxaSMZhBLFCP2BKeXWRuK5KU7zuCQKWpD3XV',
    10000: '89q2XcNt9mUgDa4PgY8Cbi4xEdMbaNNqT3d2cmPkVhiCGhU8p3s9vpHEXEPnLhgsoQJ3Kkv2CotMg5dZocQzHq2B2nKHNNV',
  };
  for (const [index, address] of Object.entries(expected)) {
    const derived = deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: VIEW, account: 0, index: Number(index) });
    assert.equal(derived, address);
    const decoded = decodeMoneroAddress(derived);
    assert.equal(decoded.prefix, 42);
    assert.equal(derived.startsWith('8'), true);
  }
  assert.notEqual(
    deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: VIEW, index: 127 }),
    deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: VIEW, index: 128 }),
  );
});

test('a view key that does not match the address is refused', () => {
  assert.throws(
    () => deriveMoneroAddress({
      primaryAddress: PRIMARY,
      privateViewKey: `01${'00'.repeat(31)}`,
      index: 1,
    }),
    /does not belong/,
  );
  assert.throws(
    () => deriveMoneroAddress({ primaryAddress: PRIMARY, privateViewKey: 'abcd', index: 1 }),
    /64 hexadecimal/,
  );
});
