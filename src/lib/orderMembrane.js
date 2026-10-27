// Order state membrane (experiment, feat/stm-order-membrane).
//
// The lab result (/home/aegis/stm-repair, REPORT-v2.md) says trusted state
// survives hostile input only when every change walks one admission door.
// This file wraps that door around Cipher's OWN order rules -- the payment
// path in paymentState.js and the status table in orderActions.js are the
// policy; the membrane is only the wall around them.
//
//   decode -> dedup(operationId + digest) -> causality(revision) ->
//   authority(principal table) -> ONE durable journal record
//
// Recovery replays through the same decode and checks as live admission.
// A record is trusted iff it is a complete line that passes every check;
// the replay stops at the first record that fails and drops the untrusted
// suffix (trusted-prefix semantics, same as the lab's repair).
//
// All of Cipher's rules stay in paymentState.js. Nothing here re-decides
// what an order may do; it decides WHO may say it, WHEN, and HOW OFTEN.

import {
  ORDER_STATUS,
  PAYMENT_STATES,
  nextPaymentState,
  applyWatcherReport,
  acceptAmount,
} from './paymentState.js';

const SCHEMA_VERSION = 1;

// The one authority table: which principal may say which thing. A watcher
// report is the only thing that moves a payment past address_issued, and a
// buyer or vendor claiming a chain fact is exactly the peer word the F7 fix
// refuses. (paymentState.js already refuses it too -- two walls, one rule.)
const AUTHORITY = {
  vendor: new Set([
    'accept_order', 'decline_order', 'confirm_payment', 'watcher_report',
    'mark_shipped', 'cancel_order', 'mark_refunded', 'resume_order', 'confirm_delivery',
  ]),
  buyer: new Set([
    'cancel_order', 'confirm_delivery', 'report_issue', 'watcher_report',
  ]),
  watcher: new Set(['watcher_report']),
};

// Operation ids accepted from the wire. Length-bounded like the lab.
function validOperationId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Key-order-independent canonical form over the durable JSON projection:
// JSON.stringify drops undefined-valued keys, so the digest must too, at
// admit and at replay alike (the lab's digest-projection bug).
function canonicalize(x) {
  if (Array.isArray(x)) return JSON.stringify(x.map(canonicalize));
  if (isPlainObject(x)) {
    const keys = Object.keys(x).filter((k) => x[k] !== undefined).sort();
    return JSON.stringify(keys.map((k) => [k, canonicalize(x[k])]));
  }
  return JSON.stringify(x);
}

function digestPayload(payload) {
  // A dependency-free stand-in for the lab's sha256 slice: a 64-bit-ish
  // printable digest of the canonical projection. Cipher already has
  // WebCrypto, but admission must stay synchronous, and SubtleCrypto is not.
  const text = canonicalize(payload);
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 + code, 1597334677);
  }
  return (
    ((h1 >>> 0).toString(16).padStart(8, '0')) +
    ((h2 >>> 0).toString(16).padStart(8, '0')) +
    (text.length.toString(16).padStart(8, '0'))
  );
}

// What an order looks like inside the membrane. revision is the CAS counter;
// processed is the dedup table; pendingPay holds a durable intent between
// "we asked the watcher" and "the watcher answered".
function emptyOrder(orderId, currency) {
  return {
    schemaVersion: SCHEMA_VERSION,
    orderId,
    currency,
    revision: 0,
    status: ORDER_STATUS.PENDING,
    paymentState: 'created',
    paymentSeenBy: '',
    coinAmount: null,
    issuedAt: null,
    accepted: false,
    paid: false,
    processed: {},
    pendingPay: null,
  };
}

// The status walk an order may take, mirroring the vendor table in
// orderActions.js. The payment walk is Cipher's own nextPaymentState.
const STATUS_NEXT = {
  [ORDER_STATUS.PENDING]: new Set([ORDER_STATUS.ACCEPTED, ORDER_STATUS.CANCELLED]),
  [ORDER_STATUS.ACCEPTED]: new Set([ORDER_STATUS.PAID, ORDER_STATUS.DISPUTED, ORDER_STATUS.CANCELLED]),
  [ORDER_STATUS.PAID]: new Set([ORDER_STATUS.SHIPPED, ORDER_STATUS.DISPUTED]),
  [ORDER_STATUS.SHIPPED]: new Set([ORDER_STATUS.COMPLETED, ORDER_STATUS.DISPUTED]),
  [ORDER_STATUS.DISPUTED]: new Set([ORDER_STATUS.REFUNDED]),
};

// The op a principal tried to say, decoded strictly. Returns
// { ok: true, op } or { ok: false, reason }.
function decodeOp(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'malformed' };
  switch (payload.type) {
    case 'accept_order': {
      // The acceptance locks the amount with Cipher's own acceptAmount and
      // dates the address. A missing or finer-than-the-coin amount dies at
      // the door (security S7).
      if (typeof payload.expectedRevision !== 'number') return { ok: false, reason: 'malformed' };
      if (payload.currency !== 'btc' && payload.currency !== 'xmr') return { ok: false, reason: 'malformed' };
      try {
        acceptAmount(payload.coinAmount, payload.currency);
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (!Number.isFinite(payload.issuedAt) || payload.issuedAt <= 0) return { ok: false, reason: 'malformed' };
      return { ok: true, op: { type: 'accept_order', expectedRevision: payload.expectedRevision, currency: payload.currency, coinAmount: payload.coinAmount, issuedAt: payload.issuedAt } };
    }
    case 'decline_order':
    case 'mark_shipped':
    case 'cancel_order':
    case 'confirm_delivery':
    case 'mark_refunded':
    case 'resume_order':
    case 'report_issue': {
      if (typeof payload.expectedRevision !== 'number') return { ok: false, reason: 'malformed' };
      return { ok: true, op: { type: payload.type, expectedRevision: payload.expectedRevision } };
    }
    case 'watcher_report': {
      // The watcher's words and nothing else: a report with a txid. The
      // payment walk itself is Cipher's applyWatcherReport -- same
      // confirmations threshold, same seen-before-confirmed rule.
      if (typeof payload.expectedRevision !== 'number') return { ok: false, reason: 'malformed' };
      if (!isPlainObject(payload.report)) return { ok: false, reason: 'malformed' };
      if (payload.report.source !== 'watcher' || !payload.report.txid) return { ok: false, reason: 'malformed' };
      return { ok: true, op: { type: 'watcher_report', expectedRevision: payload.expectedRevision, report: { source: 'watcher', txid: String(payload.report.txid), confirmations: Number(payload.report.confirmations) || 0, amount: payload.report.amount ?? null } } };
    }
    default:
      return { ok: false, reason: 'unknown_op' };
  }
}

// The pure check: may this op apply to this state? Reads Cipher's rules.
function checkOp(st, principal, op) {
  const allowed = AUTHORITY[principal];
  if (!allowed || !allowed.has(op.type)) return { ok: false, reason: 'authority' };
  if (op.expectedRevision !== st.revision) return { ok: false, reason: 'stale' };
  switch (op.type) {
    case 'accept_order':
      if (st.status !== ORDER_STATUS.PENDING) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: true };
    case 'decline_order':
      if (st.status !== ORDER_STATUS.PENDING) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: true, apply: () => { st.status = ORDER_STATUS.CANCELLED; } };
    case 'cancel_order':
      if (st.status !== ORDER_STATUS.PENDING && st.status !== ORDER_STATUS.ACCEPTED) {
        return { ok: false, reason: 'invalid_transition' };
      }
      return { ok: true, changed: true, apply: () => { st.status = ORDER_STATUS.CANCELLED; } };
    case 'confirm_payment':
      // The vendor's own wallet sight moves accepted -> paid in the UI
      // table, but on the membrane a chain fact is a watcher report's job.
      // Kept as an accepted-state guard only.
      if (st.status !== ORDER_STATUS.ACCEPTED) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: false };
    case 'watcher_report': {
      // applyWatcherReport is pure: it either names the next state or throws.
      try {
        const next = applyWatcherReport({
          state: st.paymentState,
          watcherUrl: 'membrane://watcher',
          report: op.report,
          currency: st.currency,
          amount: st.coinAmount ?? undefined,
        });
        return { ok: true, changed: true, nextPayment: next, apply: (state) => {
          state.paymentState = next;
          state.paymentSeenBy = 'watcher';
          if (next === 'confirmed' && !state.paid) {
            state.paid = true;
            if (state.status === ORDER_STATUS.ACCEPTED) state.status = ORDER_STATUS.PAID;
          }
        } };
      } catch {
        // Short of the order, did not move, or would skip a step: rejected,
        // not fatal. The gate itself stays up.
        return { ok: false, reason: 'watcher_refused' };
      }
    }
    case 'mark_shipped':
      if (st.status !== ORDER_STATUS.PAID) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: true, apply: () => { st.status = ORDER_STATUS.SHIPPED; } };
    case 'confirm_delivery':
      if (st.status !== ORDER_STATUS.SHIPPED) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: true, apply: () => { st.status = ORDER_STATUS.COMPLETED; } };
    case 'report_issue':
      if (!STATUS_NEXT[st.status] || !STATUS_NEXT[st.status].has(ORDER_STATUS.DISPUTED)) {
        return { ok: false, reason: 'invalid_transition' };
      }
      return { ok: true, changed: true, apply: () => { st.status = ORDER_STATUS.DISPUTED; } };
    case 'mark_refunded':
      if (st.status !== ORDER_STATUS.DISPUTED) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: true, apply: () => { st.status = ORDER_STATUS.REFUNDED; } };
    case 'resume_order':
      if (st.status !== ORDER_STATUS.DISPUTED) return { ok: false, reason: 'invalid_transition' };
      return { ok: true, changed: true, apply: () => {
        st.status = st.paymentState === 'seen' || st.paymentState === 'confirmed'
          ? ORDER_STATUS.PAID : ORDER_STATUS.ACCEPTED;
      } };
    default:
      return { ok: false, reason: 'unknown_op' };
  }
}

export class OrderMembrane {
  // journal: an array-like sink with append(entry) and readAllDetailed();
  // the tests pass a crash-injecting one, callers without a journal pass
  // nothing and get an in-memory one.
  constructor(orderId, currency, journal = null) {
    this.orderId = String(orderId);
    this.#journal = journal ?? new MemoryJournal();
    this.#order = emptyOrder(this.orderId, currency);
    this.#recover();
  }

  #journal;
  #order;
  #seq = 0;

  // Recovery replays through the same decode + checks as live admission.
  #recover() {
    const detailed = this.#journal.readAllDetailed();
    let lastSeq = 0;
    for (let i = 0; i < detailed.length; i += 1) {
      const row = detailed[i];
      if (!row.ok) { this.#dropTail(i, 'corrupt_line'); break; }
      const entry = row.entry;
      if (!entry || entry.seq !== lastSeq + 1) { this.#dropTail(i, 'seq_break'); break; }
      lastSeq = entry.seq;
      if (entry.orderId !== this.orderId || entry.schemaVersion !== SCHEMA_VERSION) {
        this.#dropTail(i, 'foreign_record');
        break;
      }
      if (entry.kind !== 'commit') { this.#dropTail(i, 'unknown_record_kind'); break; }
      if (digestPayload(entry.op) !== entry.digest) { this.#dropTail(i, 'digest_mismatch'); break; }
      const decoded = decodeOp(entry.op);
      if (!decoded.ok) { this.#dropTail(i, 'committed_line_fails_decode'); break; }
      const verdict = checkOp(this.#order, entry.principal, decoded.op);
      if (!verdict.ok) { this.#dropTail(i, 'committed_line_fails_check'); break; }
      if (verdict.changed) {
        if (verdict.apply) verdict.apply(this.#order); else this.#applyAccept(decoded.op);
        this.#order.revision += 1;
      }
      this.#order.processed[entry.opId] = { digest: entry.digest };
    }
    this.#seq = lastSeq;
  }

  #applyAccept(op) {
    this.#order.status = ORDER_STATUS.ACCEPTED;
    this.#order.accepted = true;
    this.#order.currency = op.currency;
    this.#order.coinAmount = op.coinAmount;
    this.#order.issuedAt = op.issuedAt;
    this.#order.paymentState = 'address_issued';
    this.#order.paymentSeenBy = 'vendor';
  }

  #dropTail(index, reason) {
    this.#journal.rewrite(index);
    this.recoveryAnomalies.push(reason);
  }

  recoveryAnomalies = [];

  // The one door. Every change to trusted order state walks it.
  admit(envelope) {
    const st = this.#order;
    if (!isPlainObject(envelope)) return { status: 'rejected', reason: 'malformed_envelope' };
    if (envelope.schemaVersion !== SCHEMA_VERSION) return { status: 'rejected', reason: 'schema_version' };
    if (!validOperationId(envelope.operationId)) return { status: 'rejected', reason: 'operation_id' };
    if (envelope.orderId !== undefined && envelope.orderId !== this.orderId) {
      return { status: 'rejected', reason: 'foreign_order' };
    }
    const principal = envelope.principal;
    if (typeof principal !== 'string') return { status: 'rejected', reason: 'malformed_envelope' };

    const decoded = decodeOp(envelope.payload);
    if (!decoded.ok) return { status: 'rejected', reason: decoded.reason };
    const op = decoded.op;

    // Dedup: one logical operation, one effect. Same id + same payload is a
    // duplicate; same id + different payload is a surfaced conflict -- a
    // replayed id must never silently swallow a different order of business.
    const digest = digestPayload(op);
    if (st.processed[envelope.operationId] !== undefined) {
      return st.processed[envelope.operationId].digest === digest
        ? { status: 'duplicate' }
        : { status: 'conflict', currentRevision: st.revision, reason: 'op_id_reuse' };
    }
    if (st.pendingPay?.opId === envelope.operationId) return { status: 'duplicate' };

    const verdict = checkOp(st, principal, op);
    if (!verdict.ok) return { status: 'rejected', reason: verdict.reason };

    // ONE record: effect + dedup marker + revision basis. The caller sees
    // "crashed" on a crash, never a false "accepted".
    let committed = false;
    try {
      this.#journal.append({
        kind: 'commit',
        schemaVersion: SCHEMA_VERSION,
        orderId: this.orderId,
        seq: this.#seq + 1,
        opId: envelope.operationId,
        digest,
        principal,
        op,
      });
      committed = true;
    } catch {
      return { status: 'crashed' };
    }
    if (!committed) return { status: 'crashed' };
    this.#seq += 1;
    if (verdict.changed) {
      if (verdict.apply) verdict.apply(st); else this.#applyAccept(op);
      st.revision += 1;
    }
    st.processed[envelope.operationId] = { digest };
    return { status: 'accepted', revision: st.revision };
  }

  // The order as others may read it. A copy, never the live object.
  summary() {
    const { processed, ...rest } = this.#order;
    return JSON.parse(JSON.stringify(rest));
  }
}

// The in-memory journal: complete lines only. readAllDetailed marks a torn
// line unparseable, which recovery treats as untrusted.
export class MemoryJournal {
  #lines = [];
  append(entry) {
    // A crash between half-writing and the newline leaves a torn line, the
    // mid_write window. The tests cut lines to simulate it.
    this.#lines.push(JSON.stringify(entry));
  }
  readAllDetailed() {
    return this.#lines.map((raw) => {
      try {
        return { raw, ok: true, entry: JSON.parse(raw) };
      } catch {
        return { raw, ok: false };
      }
    });
  }
  rewrite(keptCount) {
    this.#lines = this.#lines.slice(0, keptCount);
  }
  raw() {
    return this.#lines.map((line) => `${line}\n`).join('');
  }
}
