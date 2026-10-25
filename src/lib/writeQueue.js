// Writes that arrive before the account's database is open wait here and are
// applied, in order, when it opens. A write that then fails is reported,
// not silently dropped.
export function createWriteQueue() {
  const pending = [];
  return {
    enqueue(table, method, args) {
      pending.push({ table, method, args });
      return Promise.resolve();
    },
    size() {
      return pending.length;
    },
    async flush(target) {
      const items = pending.splice(0);
      let failed = 0;
      for (const item of items) {
        try {
          await target[item.table][item.method](...item.args);
        } catch (error) {
          failed += 1;
          console.error('[db] A write made before the database opened could not be applied:', item.table, item.method, error);
        }
      }
      return { applied: items.length - failed, failed };
    },
  };
}
