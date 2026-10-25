// Group key requests only. This is not the Nostr outbox and does not change
// outbox retry semantics. Delays start at 2s and double until a 5 minute cap.
// ±30% jitter keeps members from retrying in lockstep after a rotation.
// After GKEY_RETRY_MAX_ATTEMPTS publishes the ladder stops. It does not sit
// on the 5 minute cap forever (~288 requests/day). A reload resumes the saved
// attempt; it does not start over. Only a manual retry clears an exhausted
// "Securing…" stays quiet until 3 minutes. The ladder is still backing off
// then. The button says the send is still in progress, not that it failed.
export const GKEY_RETRY_BASE_MS = 2000;
export const GKEY_RETRY_CAP_MS = 5 * 60 * 1000;
export const GKEY_RETRY_JITTER = 0.3;
export const GKEY_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];
export const GKEY_RETRY_MAX_ATTEMPTS = 12;
export const SECURING_STUCK_MS = 3 * 60 * 1000;

const PENDING_PREFIX = 'cipher_gkey_pending_';
const SECURING_PREFIX = 'cipher_gkey_securing_';

const pending = new Map();

function accountScope(pubkey) {
  return String(pubkey || '').slice(0, 16);
}

function resolveStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* private mode or a non-browser test */ }
  return null;
}

function readJson(storage, key) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  if (!storage) return;
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch { /* quota or a locked store; the in-memory ladder still runs */ }
}

export function applyRetryJitter(baseMs, random = Math.random, jitter = GKEY_RETRY_JITTER) {
  const roll = Number(random());
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0.5;
  const factor = 1 + ((unit * 2 - 1) * jitter);
  return Math.max(0, Math.round(Number(baseMs) * factor));
}

export function retryBaseDelay(attempt, options = {}) {
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const cap = options.cap ?? GKEY_RETRY_CAP_MS;
  const delays = options.delays;
  let grown;
  if (Array.isArray(delays) && delays.length > 0) {
    if (step < delays.length) return delays[step];
    const last = delays[delays.length - 1];
    grown = last * (2 ** (step - (delays.length - 1)));
  } else {
    const base = options.base ?? GKEY_RETRY_BASE_MS;
    grown = base * (2 ** step);
  }
  if (!Number.isFinite(grown)) return cap;
  return Math.min(cap, grown);
}

// Unkeyed requests publish until the attempt cap. `exhausted` is that cap,
// not a missing key. `delay` stays set on every publish, including past the
// old 2/4/8/16/32 ladder.
export function keyRequestPlan(attempt, hasKey, delaysOrOptions, random) {
  const options = Array.isArray(delaysOrOptions)
    ? { delays: delaysOrOptions, random }
    : { ...(delaysOrOptions || {}) };
  if (options.random == null && random) options.random = random;
  if (hasKey) return { publish: false, delay: null, base: null, exhausted: false };
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  if (step >= (options.maxAttempts ?? GKEY_RETRY_MAX_ATTEMPTS)) {
    return { publish: false, delay: null, base: null, exhausted: true };
  }
  const base = retryBaseDelay(step, options);
  const delay = applyRetryJitter(base, options.random || Math.random, options.jitter ?? GKEY_RETRY_JITTER);
  return { publish: true, delay, base, exhausted: false };
}

function blankKeyRequest(id, since = 0) {
  return { id, attempts: 0, exhausted: false, since };
}

export function loadKeyRequestRecords(pubkey, storage) {
  const store = resolveStorage(storage);
  const parsed = readJson(store, PENDING_PREFIX + accountScope(pubkey));
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (typeof item === 'string' && item) out.push(blankKeyRequest(item));
    else if (item && typeof item.id === 'string' && item.id) {
      out.push({
        id: item.id,
        attempts: Number.isFinite(item.attempts) && item.attempts > 0 ? Math.floor(item.attempts) : 0,
        exhausted: item.exhausted === true,
        since: Number.isFinite(item.since) ? item.since : 0,
      });
    }
  }
  return out;
}

function saveKeyRequestRecords(pubkey, records, storage) {
  const store = resolveStorage(storage);
  if (!pubkey || !store) return;
  const unique = [];
  const seen = new Set();
  for (const record of records || []) {
    if (!record?.id || seen.has(record.id)) continue;
    seen.add(record.id);
    unique.push(record);
  }
  writeJson(store, PENDING_PREFIX + accountScope(pubkey), unique.length ? unique : null);
}

export function loadPendingKeyRequests(pubkey, storage) {
  return loadKeyRequestRecords(pubkey, storage).filter((record) => !record.exhausted).map((record) => record.id);
}

export function keyRequestRecord(pubkey, groupId, storage) {
  if (!groupId) return null;
  return loadKeyRequestRecords(pubkey, storage).find((record) => record.id === groupId) || null;
}

export function savePendingKeyRequests(pubkey, groupIds, storage) {
  const existing = loadKeyRequestRecords(pubkey, storage);
  const want = [...new Set((groupIds || []).filter((id) => typeof id === 'string' && id))];
  const next = [];
  for (const id of want) {
    next.push(existing.find((record) => record.id === id) || blankKeyRequest(id, Date.now()));
  }
  for (const record of existing) {
    if (record.exhausted && !want.includes(record.id)) next.push(record);
  }
  saveKeyRequestRecords(pubkey, next, storage);
}

export function rememberPendingKeyRequest(pubkey, groupId, storage) {
  if (!pubkey || !groupId) return;
  const records = loadKeyRequestRecords(pubkey, storage);
  const row = records.find((record) => record.id === groupId);
  if (!row) records.push(blankKeyRequest(groupId, Date.now()));
  else if (row.exhausted) return;
  saveKeyRequestRecords(pubkey, records, storage);
}

export function noteKeyRequestAttempt(pubkey, groupId, attempts, storage) {
  if (!pubkey || !groupId) return;
  const records = loadKeyRequestRecords(pubkey, storage);
  let row = records.find((record) => record.id === groupId);
  if (!row) {
    row = blankKeyRequest(groupId, Date.now());
    records.push(row);
  }
  row.attempts = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  row.exhausted = false;
  saveKeyRequestRecords(pubkey, records, storage);
}

export function exhaustKeyRequest(pubkey, groupId, storage) {
  if (!pubkey || !groupId) return;
  const records = loadKeyRequestRecords(pubkey, storage);
  let row = records.find((record) => record.id === groupId);
  if (!row) {
    row = blankKeyRequest(groupId, Date.now());
    records.push(row);
  }
  row.exhausted = true;
  row.attempts = Math.max(row.attempts || 0, GKEY_RETRY_MAX_ATTEMPTS);
  saveKeyRequestRecords(pubkey, records, storage);
}

export function resetKeyRequest(pubkey, groupId, storage) {
  if (!pubkey || !groupId) return;
  const records = loadKeyRequestRecords(pubkey, storage).filter((record) => record.id !== groupId);
  records.push(blankKeyRequest(groupId, Date.now()));
  saveKeyRequestRecords(pubkey, records, storage);
}

export function forgetPendingKeyRequest(pubkey, groupId, storage) {
  if (!pubkey || !groupId) return;
  saveKeyRequestRecords(
    pubkey,
    loadKeyRequestRecords(pubkey, storage).filter((record) => record.id !== groupId),
    storage,
  );
}

// Persisted requests that still have no key, plus any joined ids the caller
// already knows about. A reload reads this instead of the dead in-memory ladder.
export function resumeKeyRequestIds({ pubkey, joinedIds = [], hasKey = {}, storage } = {}) {
  const pendingIds = loadPendingKeyRequests(pubkey, storage);
  return [...new Set([...pendingIds, ...joinedIds.filter((id) => typeof id === 'string' && id)])]
    .filter((id) => !hasKey[id]);
}

export function loadSecuringSends(pubkey, storage) {
  const store = resolveStorage(storage);
  const parsed = readJson(store, SECURING_PREFIX + accountScope(pubkey));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.groupId === 'string');
}

function saveSecuringSends(pubkey, items, storage) {
  const store = resolveStorage(storage);
  if (!pubkey || !store) return;
  writeJson(store, SECURING_PREFIX + accountScope(pubkey), items.length ? items : null);
}

export function queueSecuringSend(pubkey, send, storage) {
  if (!pubkey || !send?.groupId || !send?.id) return;
  const next = loadSecuringSends(pubkey, storage).filter((item) => item.id !== send.id);
  next.push({
    id: send.id,
    groupId: send.groupId,
    payload: send.payload ?? null,
    replyId: send.replyId || null,
    since: Number.isFinite(send.since) ? send.since : Date.now(),
  });
  saveSecuringSends(pubkey, next, storage);
}

export function dropSecuringSend(pubkey, id, storage) {
  if (!pubkey || !id) return;
  saveSecuringSends(
    pubkey,
    loadSecuringSends(pubkey, storage).filter((item) => item.id !== id),
    storage,
  );
}

export function dropSecuringSendsForGroup(pubkey, groupId, storage) {
  if (!pubkey || !groupId) return;
  saveSecuringSends(
    pubkey,
    loadSecuringSends(pubkey, storage).filter((item) => item.groupId !== groupId),
    storage,
  );
}

export function securingSendsFor(pubkey, groupId, storage) {
  return loadSecuringSends(pubkey, storage).filter((item) => item.groupId === groupId);
}

export function securingPhase(since, now = Date.now(), threshold = SECURING_STUCK_MS) {
  const started = Number(since);
  if (!Number.isFinite(started) || started <= 0) return 'securing';
  return now - started >= threshold ? 'stuck' : 'securing';
}

// A key that shows up after the ladder has stopped still sends. Exhaustion
// only stops more requests. It does not swallow a send whose key arrived.
export function shouldFlushSecuring({ groupId, sends, exhausted = false } = {}) {
  const ids = (sends || []).filter((item) => item?.groupId === groupId).map((item) => item.id);
  return { flush: ids.length > 0, ids, exhausted: !!exhausted };
}

export function markSecuringRetry(pubkey, groupId, storage, now = Date.now()) {
  if (!pubkey || !groupId) return;
  const next = loadSecuringSends(pubkey, storage).map((item) => (
    item.groupId === groupId ? { ...item, since: now } : item
  ));
  saveSecuringSends(pubkey, next, storage);
}

export function stopGroupKeyRequests(groupId) {
  const job = pending.get(groupId);
  if (!job) return;
  job.cancelled = true;
  if (job.timer) job.disarm(job.timer);
  pending.delete(groupId);
}

export function stopAllGroupKeyRequests() {
  for (const groupId of [...pending.keys()]) stopGroupKeyRequests(groupId);
}

export function groupKeyRequestPending(groupId) {
  return pending.has(groupId);
}

// One in-flight series per group. A second call does not stack another publisher.
// Stopping the timer (navigation, reload) does not forget a persisted request.
// `attempt` is the saved rung. A reload continues there instead of restarting
// at 2s, so refreshing cannot dodge the cap.
export function startGroupKeyRequests({
  groupId,
  hasKey,
  publish,
  onKeyed,
  onExhausted,
  pubkey,
  storage,
  delays,
  attempt: startAttempt = 0,
  random = Math.random,
  schedule = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (!groupId) return () => {};
  if (pending.has(groupId)) return () => stopGroupKeyRequests(groupId);
  const job = { cancelled: false, timer: null, disarm: clearTimer };
  pending.set(groupId, job);

  const step = async (attempt) => {
    if (job.cancelled || pending.get(groupId) !== job) return;
    let keyed = false;
    try { keyed = Boolean(await hasKey()); } catch { keyed = false; }
    const plan = keyRequestPlan(attempt, keyed, { delays, random });
    if (plan.exhausted) {
      if (job.cancelled || pending.get(groupId) !== job) return;
      exhaustKeyRequest(pubkey, groupId, storage);
      stopGroupKeyRequests(groupId);
      try { await onExhausted?.(); } catch (error) {
        console.warn('[group-key] Could not surface a stuck key request:', error);
      }
      return;
    }
    if (!plan.publish) {
      if (job.cancelled || pending.get(groupId) !== job) return;
      stopGroupKeyRequests(groupId);
      forgetPendingKeyRequest(pubkey, groupId, storage);
      try { await onKeyed?.(); } catch (error) {
        console.warn('[group-key] Could not flush sends waiting on the key:', error);
      }
      return;
    }
    rememberPendingKeyRequest(pubkey, groupId, storage);
    noteKeyRequestAttempt(pubkey, groupId, attempt + 1, storage);
    try { await publish(); } catch { /* the next attempt is the retry */ }
    if (job.cancelled || pending.get(groupId) !== job) return;
    job.timer = schedule(() => { step(attempt + 1); }, plan.delay);
  };

  step(Math.max(0, Math.floor(Number(startAttempt) || 0)));
  return () => stopGroupKeyRequests(groupId);
}
