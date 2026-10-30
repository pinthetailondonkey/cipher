import { db, currentOwner } from '../db';
import { getAuthenticatedPool } from './pool';
import { generalRelays, groupRelays } from './relays';

const flushes = new Map();
const syncWatchers = new Map();
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function notifyStatus(id, status) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('cipher:outbox-status', { detail: { id, status } }));
  if (status === 'sent') {
    window.dispatchEvent(new CustomEvent('cipher:outbox-sent', { detail: { id } }));
  }
}

async function updateMessageStatus(id, status, owner) {
  if (!owner || currentOwner() !== owner) return;
  // db.messages is now the at-rest view (src/db.js), not a Dexie Table, so the
  // transaction takes the table name; get/put go through the view so a sealed
  // row is opened, patched, and re-sealed instead of written back in plaintext.
  await db.transaction('rw', 'messages', async () => {
    if (currentOwner() !== owner) return;
    const message = await db.messages.get(id);
    if (message && currentOwner() === owner) {
      await db.messages.put({ ...message, deliveryStatus: status });
    }
  });
  if (currentOwner() === owner) notifyStatus(id, status);
}

export async function enqueueNostrEvent(event, relays = null) {
  const owner = currentOwner();
  if (!owner) throw new Error('Local account database is not open.');
  const outbox = db.outbox;
  await outbox.put(outboxRow(event, Date.now(), relays));
  await updateMessageStatus(event.id, 'queued', owner);
}

async function dropOutboxRow(id) {
  await db.outbox.delete(id);
}

// Write-ahead publish. The signed event goes into the outbox BEFORE any relay
// is tried, and the row is deleted on the first relay accept. A crash or a
// closed tab between sign and publish used to lose the message for good: the
// row was only written after every relay had refused. The event id is stable
// and a relay ignores an id it already holds, so a retry from the outbox
// cannot double-send. `publish` returns the pool's list of publish promises.
// writeAhead:false is for ephemeral signals (calls, read marks), which keep
// the old order: queued only if every relay refuses.
export async function publishWriteAhead(event, relays, publish, deps = {}) {
  const enqueue = deps.enqueue || enqueueNostrEvent;
  const unqueue = deps.unqueue || dropOutboxRow;
  const writeAhead = deps.writeAhead !== false;
  let written = false;
  if (writeAhead) {
    try {
      await enqueue(event, relays);
      written = true;
    } catch (error) {
      console.warn('[outbox] Could not write the event ahead of publishing:', error);
    }
  }
  let results = [];
  try {
    results = await Promise.allSettled(publish());
  } catch (error) {
    console.warn('[outbox] Publish could not start:', error);
  }
  const okCount = results.filter((result) => result.status === 'fulfilled').length;
  if (okCount > 0) {
    if (written) {
      try { await unqueue(event.id); } catch (error) {
        console.warn('[outbox] Could not clear a delivered row; the next flush will clear it:', error);
      }
    }
    return { queued: false, results, okCount };
  }
  if (!written) await enqueue(event, relays);
  return { queued: true, results, okCount: 0 };
}

function retryDelay(attempts, random = Math.random) {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 16)));
  return Math.round(exponential * (0.8 + random() * 0.4));
}

export function shouldFlushOutboxRow(row, now, force = false) {
  if (force) return true;
  return (row?.nextRetryAt || 0) <= now;
}

export function outboxRow(event, now = Date.now(), relays = null) {
  const row = {
    id: event.id,
    kind: event.kind,
    event,
    attempts: 0,
    nextRetryAt: 0,
    status: 'queued',
    queuedAt: now,
    created_at: event.created_at,
  };
  if (Array.isArray(relays) && relays.length) row.relays = relays;
  return row;
}

export function settleOutboxAttempt(queued, { accepted, now = Date.now(), error = '' }) {
  if (accepted) return { action: 'delete' };
  const attempts = (queued.attempts || 0) + 1;
  return {
    action: 'update',
    patch: {
      attempts,
      nextRetryAt: now + retryDelay(attempts),
      lastError: String(error || '').slice(0, 500),
      status: 'failed',
    },
  };
}

export async function flushNostrOutbox(identity, { force = false } = {}) {
  if (!identity?.sk || !identity?.pk || currentOwner() !== identity.pk) return;
  const activeFlush = flushes.get(identity.pk);
  if (activeFlush) return activeFlush;

  const flushPromise = (async () => {
    const pool = await getAuthenticatedPool(identity);
    if (currentOwner() !== identity.pk) return;
    const outbox = db.outbox;
    const pending = await outbox.toArray();
    for (const queued of pending) {
      if (currentOwner() !== identity.pk) return;
      if (!shouldFlushOutboxRow(queued, Date.now(), force)) continue;

      await outbox.update(queued.id, { status: 'sending' });
      await updateMessageStatus(queued.id, 'sending', identity.pk);
      try {
        const relays = queued.relays?.length
          ? queued.relays
          : (queued.kind === 9 ? groupRelays : generalRelays);
        const results = await Promise.allSettled(pool.publish(relays, queued.event));
        if (currentOwner() !== identity.pk) return;
        const accepted = results.some((result) => result.status === 'fulfilled');
        const settled = settleOutboxAttempt(queued, {
          accepted,
          error: results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason?.message || String(result.reason))
            .join('; '),
        });
        if (settled.action === 'delete') {
          await outbox.delete(queued.id);
          await updateMessageStatus(queued.id, 'sent', identity.pk);
          continue;
        }
        await outbox.update(queued.id, settled.patch);
        await updateMessageStatus(queued.id, 'failed', identity.pk);
      } catch (error) {
        if (currentOwner() !== identity.pk) return;
        console.warn('[outbox] Retry failed:', queued.id, error);
        const settled = settleOutboxAttempt(queued, { accepted: false, error: error?.message || String(error) });
        await outbox.update(queued.id, settled.patch);
        await updateMessageStatus(queued.id, 'failed', identity.pk);
      }
    }
  })().finally(() => {
    flushes.delete(identity.pk);
  });

  flushes.set(identity.pk, flushPromise);
  return flushPromise;
}

export function startOutboxSync(identity) {
  if (!identity?.pk || !identity?.sk || typeof window === 'undefined') return () => {};
  let watcher = syncWatchers.get(identity.pk);
  if (!watcher) {
    const flush = (force = false) => {
      flushNostrOutbox(identity, { force }).catch((error) => {
        console.error('[outbox] Sync failed:', error);
      });
    };
    const onOnline = () => flush(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') flush(true);
    };
    const onRelayConnected = () => flush(true);

    watcher = {
      refs: 0,
      interval: window.setInterval(() => flush(false), 15000),
      flush,
      onOnline,
      onVisible,
      onRelayConnected,
    };
    syncWatchers.set(identity.pk, watcher);
    window.addEventListener('online', onOnline);
    window.addEventListener('cipher:relay-connected', onRelayConnected);
    document.addEventListener('visibilitychange', onVisible);
    flush(false);
  }
  watcher.refs += 1;

  return () => {
    const activeWatcher = syncWatchers.get(identity.pk);
    if (!activeWatcher) return;
    activeWatcher.refs -= 1;
    if (activeWatcher.refs > 0) return;
    window.clearInterval(activeWatcher.interval);
    window.removeEventListener('online', activeWatcher.onOnline);
    window.removeEventListener('cipher:relay-connected', activeWatcher.onRelayConnected);
    document.removeEventListener('visibilitychange', activeWatcher.onVisible);
    syncWatchers.delete(identity.pk);
  };
}
