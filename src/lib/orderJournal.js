// The order membrane's journal, written through to this device's own database.
//
// The membrane (orderMembrane.js) admits every trusted order fact through one
// door: decode, dedup, revision, authority, then ONE journal line. Until now
// that line lived in memory only. A reload forgot it, and a history fetch
// re-saved the relay's copy of the card over the screen, so a release a buyer
// had already taken could come back as an order still waiting to be paid.
//
// This adapter writes each admitted line to the account's database, in its own
// table. A history fetch re-saves `messages`; it never touches `orderJournal`,
// which is why a settled order survives one.
//
// Two rules shape the code:
//
//   - The door is synchronous. admit() must answer before the caller sends
//     anything, and Dexie is not synchronous. So append() records the line in
//     memory and queues the write, and flush() is the receipt. A caller that
//     acts on "accepted" awaits flush first. admitAndFlush() is the only way
//     this file hands out a verdict, so that cannot be forgotten at a call
//     site.
//
//   - Recovery is trusted-prefix. Lines are read back in seq order; a torn or
//     foreign line stops the replay and the membrane drops that tail. rewrite()
//     drops it here too, in memory and in the table.
//
// A journal that cannot be durable refuses to open. Running on a stub table
// (the database not yet open for an account) would read back empty, replay
// nothing and quietly be a memory journal with extra steps.

import { db, currentOwner } from '../db.js';
import { OrderMembrane } from './orderMembrane.js';

// Writes one membrane line at a time; nothing here parses order rules.
export class DatabaseJournal {
  #table;
  #orderId;
  #lines = []; // { seq, raw }, in seq order
  #pending = []; // queued table writes, in call order

  constructor(table, orderId, rows = []) {
    this.#table = table;
    this.#orderId = String(orderId);
    const ordered = [...(rows || [])]
      .filter((row) => row && typeof row.line === 'string' && Number.isInteger(row.seq))
      .sort((a, b) => a.seq - b.seq);
    for (const row of ordered) this.#lines.push({ seq: row.seq, raw: row.line });
  }

  // Called inside the membrane's admission door. It must not await.
  append(entry) {
    const raw = JSON.stringify(entry);
    this.#lines.push({ seq: entry.seq, raw });
    this.#pending.push({ kind: 'put', row: { orderId: this.#orderId, seq: entry.seq, line: raw } });
  }

  readAllDetailed() {
    return this.#lines.map(({ raw }) => {
      try {
        return { raw, ok: true, entry: JSON.parse(raw) };
      } catch {
        return { raw, ok: false };
      }
    });
  }

  // Drop everything past the trusted prefix, on disk as well as in memory.
  // A line that was never flushed still gets its delete queued; put-then-
  // delete settles to nothing, which is the intent.
  rewrite(keptCount) {
    const dropped = this.#lines.slice(keptCount);
    this.#lines = this.#lines.slice(0, keptCount);
    for (const line of dropped) {
      this.#pending.push({ kind: 'delete', key: [this.#orderId, line.seq] });
    }
  }

  raw() {
    return this.#lines.map((line) => `${line.raw}\n`).join('');
  }

  // The receipt. Resolves only when every queued line is on disk.
  async flush() {
    const batch = this.#pending;
    this.#pending = [];
    try {
      for (const write of batch) {
        if (write.kind === 'put') await this.#table.put(write.row);
        else await this.#table.delete(write.key);
      }
    } catch (error) {
      this.#pending = batch.concat(this.#pending);
      throw error;
    }
  }
}

// Open one order's journal from the account database. `table` is a seam for
// tests; the app uses the real one and must have an account open.
export async function loadOrderJournal(orderId, table = null) {
  const target = table || db.orderJournal;
  if (!table && !currentOwner()) {
    throw new Error('The order journal needs this account’s database open; a memory journal would forget the release.');
  }
  const rows = await target.where('orderId').equals(String(orderId)).sortBy('seq');
  return new DatabaseJournal(target, orderId, rows);
}

// Rebuild one order's membrane from its durable lines.
export async function openOrderMembrane(orderId, currency, table = null) {
  const journal = await loadOrderJournal(orderId, table);
  const membrane = new OrderMembrane(orderId, currency, journal);
  // A repair that is only in memory would be redone on every open, and the
  // bad tail would stay on disk for whatever reads the table next. Make the
  // repair durable before anyone trusts the reopened order.
  if (membrane.recoveryAnomalies.length > 0) await journal.flush();
  return { membrane, journal };
}

// Admit, then make it durable, then answer. A write that fails is a crash:
// the caller must not send or show anything the next reload would forget.
export async function admitAndFlush(membrane, journal, envelope) {
  const verdict = membrane.admit(envelope);
  if (verdict.status !== 'accepted') return verdict;
  try {
    await journal.flush();
  } catch (error) {
    return { status: 'crashed', reason: 'journal_write_failed', error };
  }
  return verdict;
}
