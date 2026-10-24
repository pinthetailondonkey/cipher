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
  const messages = db.messages;
  await db.transaction('rw', messages, async () => {
    if (currentOwner() !== owner) return;
    const message = await messages.get(id);
    if (message && currentOwner() === owner) {
      await messages.put({ ...message, deliveryStatus: status });
    }
  });
  if (currentOwner() === owner) notifyStatus(id, status);
}

export async function enqueueNostrEvent(event) {
  const owner = currentOwner();
  if (!owner) throw new Error('Local account database is not open.');
  const outbox = db.outbox;
  await outbox.put(outboxRow(event));
  await updateMessageStatus(event.id, 'queued', owner);
}

function retryDelay(attempts, random = Math.random) {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 16)));
  return Math.round(exponential * (0.8 + random() * 0.4));
}

export function shouldFlushOutboxRow(row, now, force = false) {
  if (force) return true;
  return (row?.nextRetryAt || 0) <= now;
}

export function outboxRow(event, now = Date.now()) {
  return {
    id: event.id,
    kind: event.kind,
    event,
    attempts: 0,
    nextRetryAt: 0,
    status: 'queued',
    queuedAt: now,
    created_at: event.created_at,
  };
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
        const relays = queued.kind === 9 ? groupRelays : generalRelays;
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
