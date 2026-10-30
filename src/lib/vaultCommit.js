// One commit for landing a restored account on this device.
//
// The vault has been sealed and proven before this runs; what is left is
// writing the account table, the active pointer, the single-vault mirror and
// whatever slots go with them. Storage can refuse mid-way (full, locked,
// broken). A half-landed restore is the worst outcome — the account looks
// present while the pointer or the mirror names the wrong thing, and the
// person is told it failed — so everything the commit touched is put back
// exactly as it was before the failure travels.
//
// The device key the seal made is not destroyed on failure. This may be the
// same account restored again: the key on the device may be the one the
// still-standing prior vault opens with, and destroying it would lock the
// account away for good. An unused key is inert; a destroyed one is not.

// What a failed commit says, the same words wherever an account lands.
export const COMMIT_FAILED_MESSAGE = 'This device could not save the account. Nothing was changed — try again.';

export function commitWithRollback(storage, writes) {
  const keys = writes.map((write) => write.key);
  const before = keys.map((key) => [key, storage.getItem(key)]);
  try {
    for (const write of writes) storage.setItem(write.key, write.value);
  } catch (error) {
    // Put every slot back. A storage that refuses even the undo keeps what
    // it has — the failure still travels, and nothing here can do more.
    for (const [key, value] of before) {
      try {
        if (value === null || value === undefined) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch { /* nothing more can be done here */ }
    }
    throw error;
  }
}
