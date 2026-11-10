// Dexie transaction gate for the account DB. Writers and context retirement
// touch the same IndexedDB store in readwrite transactions, so retirement has
// a durable ordering point that localStorage events do not provide. Wire this
// into src/db.js and identity lifecycle paths before claiming app coverage.
export const SECURITY_CONTEXT_STORE = 'securityContexts';

export function securityContextRecord(context) {
  if (typeof context?.owner !== 'string' || !/^[0-9a-f]{64}$/i.test(context.owner)
    || typeof context?.incarnation !== 'string' || context.incarnation.length < 16) {
    throw new Error('A valid account security context is required.');
  }
  return {
    id: `${context.owner}:${context.incarnation}`,
    owner: context.owner,
    incarnation: context.incarnation,
  };
}

function expiredContextError() {
  const error = new Error('The account security context is no longer active.');
  error.code = 'SECURITY_CONTEXT_EXPIRED';
  return error;
}

export async function activateIndexedDbContext(database, context) {
  if (!database) throw new Error('An account database is required.');
  const record = securityContextRecord(context);
  await database.transaction('rw', SECURITY_CONTEXT_STORE, async () => {
    await database.table(SECURITY_CONTEXT_STORE).put(record);
  });
  return { active: true, id: record.id };
}

export async function assertIndexedDbContextActive(database, context) {
  if (!database) throw new Error('An account database is required.');
  const record = securityContextRecord(context);
  const active = await database.table(SECURITY_CONTEXT_STORE).get(record.id);
  if (active?.owner !== record.owner || active?.incarnation !== record.incarnation) {
    throw expiredContextError();
  }
  return true;
}

export async function retireIndexedDbContext(database, context) {
  if (!database) return { retired: false, error: 'An account database is required.' };
  let record;
  try { record = securityContextRecord(context); }
  catch (error) { return { retired: false, error: error.message }; }
  try {
    await database.transaction('rw', SECURITY_CONTEXT_STORE, async () => {
      const active = await database.table(SECURITY_CONTEXT_STORE).get(record.id);
      if (active?.owner === record.owner && active?.incarnation === record.incarnation) {
        await database.table(SECURITY_CONTEXT_STORE).delete(record.id);
      }
    });
    const remaining = await database.table(SECURITY_CONTEXT_STORE).get(record.id);
    return { retired: !remaining };
  } catch (error) {
    return { retired: false, error: error?.message || String(error) };
  }
}

// callback may await only IndexedDB operations issued through this database
// transaction. Network calls, crypto, timers and unrelated promises must stay
// outside; such work cannot be made atomic with an IndexedDB commit.
export async function runAuthorizedIndexedDbWrite(database, { context, stores }, callback) {
  if (!database || !Array.isArray(stores) || !stores.length || typeof callback !== 'function') {
    throw new Error('A database, context, stores, and callback are required.');
  }
  securityContextRecord(context);
  const storeNames = [...new Set([...stores, SECURITY_CONTEXT_STORE])];
  for (const name of storeNames) database.table(name);
  return database.transaction('rw', ...storeNames, async () => {
    await assertIndexedDbContextActive(database, context);
    const result = await callback(database);
    await assertIndexedDbContextActive(database, context);
    return result;
  });
}
