// Deterministic account-owned IndexedDB names. Keep this list shared by
// ordinary account removal and panic wipe so security stores are not omitted.
export function accountDatabaseNames(pubkey) {
  if (!/^[0-9a-f]{64}$/.test(pubkey || '')) throw new Error('A valid account identity is required.');
  return [
    `CipherDB_v7_${pubkey.slice(0, 16)}`,
    `CipherPrimaryAuthorityV2_${pubkey.slice(0, 24)}`,
    `CipherAuthorityPinsV2_${pubkey.slice(0, 24)}`,
  ];
}
