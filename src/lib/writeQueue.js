// Writes that arrive before the account's database is open wait here and are
// applied, in order, when it opens. A write that then fails is reported,
// not silently dropped.
export function createWriteQueue() {
  const pending = [];
  return {
    enqueue(table, method, args, context = null) {
      pending.push({ table, method, args, context });
      return Promise.resolve();
    },
    size() {
      return pending.length;
    },
    async flush(target, { owner = null, securityFence = null, requireContext = false } = {}) {
      const items = pending.splice(0);
      let failed = 0;
      for (const item of items) {
        try {
          if (requireContext && (!item.context?.owner || item.context.owner !== owner
            || !item.context.securityFence || item.context.securityFence !== securityFence)) {
            throw new Error('A queued database write belongs to a different or missing account context.');
          }
          item.context?.securityFence?.assertCurrent?.();
          await target[item.table][item.method](...item.args);
          item.context?.securityFence?.assertCurrent?.();
        } catch (error) {
          failed += 1;
          console.error('[db] A write made before the database opened could not be applied:', item.table, item.method, error);
        }
      }
      return { applied: items.length - failed, failed };
    },
  };
}
