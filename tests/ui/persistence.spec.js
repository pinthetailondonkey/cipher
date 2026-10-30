import { test, expect } from '@playwright/test';

// Opens the app's per-account database by name without a version, so this never
// creates or upgrades anything. The app must have made the database and its
// stores itself. A missing messages store is a finding, not something to work
// around, so it is reported as { store: false } and asserted on.
async function readStoredMessage(page, { dbName, msgId }) {
  return page.evaluate(({ dbName: name, msgId: id }) => {
    const request = indexedDB.open(name);
    return new Promise((resolve, reject) => {
      request.onsuccess = async () => {
        const db = request.result;
        try {
          if (!db.objectStoreNames.contains('messages')) {
            resolve({ store: false });
            return;
          }
          const tx = db.transaction(['messages'], 'readonly');
          const get = tx.objectStore('messages').get(id);
          const msg = await new Promise((res, rej) => {
            get.onsuccess = () => res(get.result);
            get.onerror = () => rej(get.error);
          });
          resolve({ store: true, msg });
        } finally {
          db.close();
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('database blocked by another connection'));
    });
  }, { dbName, msgId });
}

// A direct IndexedDB put, bypassing the app entirely: this is how a row written
// before the at-rest change looks on disk, plaintext and without a `sealed`
// field. The app must still read and show it next to sealed rows.
async function writeRawMessage(page, { dbName, row }) {
  const result = await page.evaluate(({ dbName: name, row: r }) => {
    const request = indexedDB.open(name);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction(['messages'], 'readwrite');
          const put = tx.objectStore('messages').put(r);
          put.onsuccess = () => resolve({ store: true, written: true });
          put.onerror = () => reject(put.error);
        } finally {
          db.close();
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('database blocked by another connection'));
    });
  }, { dbName, row });
  expect(result, 'legacy plaintext row was written straight to IndexedDB').toMatchObject({ store: true, written: true });
}

// The app's own view of the rows (window.__cipher.readStoredRows, src/db.js):
// sealed rows come back unsealed, legacy rows as they are stored.
async function readOpenedRows(page) {
  return page.evaluate(async () => {
    if (typeof window.__cipher?.readStoredRows !== 'function') {
      throw new Error('window.__cipher.readStoredRows missing — app hook did not load');
    }
    return window.__cipher.readStoredRows();
  });
}

// Waits for the app's per-account database and returns its name: openDBFor
// names it CipherDB_v7_<pk[:16]> (src/db.js) and Dexie creates the file
// lazily, so at any fixed timeout nothing may exist yet. If it never appears,
// fail with the list of databases that was actually there.
async function waitForAppDatabase(page, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    const dbName = seen.find((n) => n && n.startsWith('CipherDB_v7_')) || null;
    if (dbName) return dbName;
    await page.waitForTimeout(100);
  }
  throw new Error(`no CipherDB_v7_ database within ${timeout}ms; databases seen: ${JSON.stringify(seen)}`);
}

test.describe('Persistence', () => {
  test.beforeEach(async ({ page }) => {
    // Session key in place: the app loads past the lock screen with the vault
    // open. sessionStorage survives reloads within the tab, so the app is
    // still unlocked after page.reload().
    await page.addInitScript(() => {
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array(32).fill(170)));
    });
  });

  test('new rows are sealed at rest and reload beside a legacy plaintext row', async ({ page }) => {
    await page.goto('/');
    const dbName = await waitForAppDatabase(page);

    // The app created this database, so the messages store must already exist.
    // Open without a version: this test never creates or upgrades anything.
    const pre = await readStoredMessage(page, { dbName, msgId: 'test_message_123' });
    expect(pre.store, 'the app database has a messages store').toBe(true);

    // A chat with a peer other than the account itself, so no history fetch for
    // an open chat can touch this row. Both rows below share the thread, so the
    // reload shows a pre-change plaintext row and a sealed row together.
    const peerPk = 'f'.repeat(64);
    const chatId = `dm:${peerPk}`;
    const now = Math.floor(Date.now() / 1000);
    const legacyRow = {
      id: 'legacy_message_1',
      chatId,
      pubkey: peerPk,
      timestamp: now - 60,
      data: { message: 'legacy plaintext note', type: 'text' },
      isSender: false,
    };
    const testMessage = {
      id: 'test_message_123',
      pubkey: peerPk,
      timestamp: now,
      data: { message: 'test persistence', type: 'text' },
      isSender: false,
    };

    // The row written before the at-rest change: put directly into IndexedDB,
    // bypassing the app's save path entirely.
    await writeRawMessage(page, { dbName, row: legacyRow });

    // Write through the app's own saveMessage — window.__cipher (src/db.js) —
    // so the row takes the same merge + tombstone transaction path as a real
    // incoming message. saveMessage swallows its own errors, so the write is
    // verified below.
    await page.evaluate(async ({ chatId: chat, msg }) => {
      if (typeof window.__cipher.saveMessage !== 'function') {
        throw new Error('window.__cipher.saveMessage missing — app hook did not load');
      }
      await window.__cipher.saveMessage(chat, msg);
    }, { chatId, msg: testMessage });

    // Done-when (c): the stored bytes for a new row do not contain the
    // plaintext. Read the raw on-disk row, not the app's opened view.
    const seeded = await readStoredMessage(page, { dbName, msgId: testMessage.id });
    expect(seeded.msg, 'write through saveMessage landed in IndexedDB').toBeDefined();
    expect(seeded.msg.sealed?.ct, 'the stored row carries a sealed envelope').toBeTruthy();
    const storedBytes = JSON.stringify(seeded.msg);
    expect(storedBytes.includes('test persistence'), 'stored bytes do not contain the plaintext').toBe(false);

    // The vendor's changes to an order are stored as localPatch on the row
    // (src/lib/messageMerge.js, via updateLocalOrder -> patchMessage). A
    // history fetch brings the plain relay copy back and re-saves it, so the
    // merge must lay the patch over the copy again instead of losing it. All
    // three writes happen before anything asserts on the patch: the first
    // failure after a merge-but-overwrite revert must be the AFTER-RELOAD
    // assertion below, not here.
    const orderPeer = 'e'.repeat(64);
    const orderChat = `dm:${orderPeer}`;
    const orderMessage = {
      id: 'test_order_1',
      pubkey: orderPeer,
      timestamp: now,
      data: { message: 'order placed', type: 'text' },
      isSender: true,
    };
    await page.evaluate(async ({ chat, order }) => {
      if (typeof window.__cipher.saveMessage !== 'function'
        || typeof window.__cipher.patchMessage !== 'function') {
        throw new Error('app hooks missing — window.__cipher.saveMessage/patchMessage did not load');
      }
      await window.__cipher.saveMessage(chat, order);
      await window.__cipher.patchMessage(order.id, { state: 'confirmed' });
      // A history fetch re-saves the plain relay copy (src/hooks/useNIP44DM.js).
      await window.__cipher.saveMessage(chat, order);
    }, { chat: orderChat, order: orderMessage });

    const seededOrder = await readStoredMessage(page, { dbName, msgId: orderMessage.id });
    expect(seededOrder.msg, 'order write through saveMessage landed in IndexedDB').toBeDefined();

    // Reload page and wait for the app shell, then require the rows both in
    // IndexedDB and in the app's read path.
    await page.reload();
    // The rail rides md+ now; at phone width the chat list's kebab is the
    // mounted landmark the reload reached past the lock.
    await page.getByRole('button', { name: 'Chat list menu' }).waitFor();

    const reloaded = await readStoredMessage(page, { dbName, msgId: testMessage.id });
    expect(reloaded.msg, 'row survived the reload in IndexedDB').toBeDefined();
    expect(reloaded.msg.sealed?.ct, 'the reloaded row is still sealed at rest').toBeTruthy();
    expect(JSON.stringify(reloaded.msg).includes('test persistence'), 'reloaded stored bytes stay sealed').toBe(false);

    // Done-when (b): through the app's own read path, the old plaintext row
    // and the new encrypted row of the same thread come back together, both
    // readable.
    const opened = await readOpenedRows(page);
    const threadRows = opened.filter((r) => r.id === legacyRow.id || r.id === testMessage.id);
    expect(threadRows.map((r) => r.id).sort(), 'both rows of the thread are readable after reload')
      .toEqual([legacyRow.id, testMessage.id].sort());
    const legacyOpened = threadRows.find((r) => r.id === legacyRow.id);
    const sealedOpened = threadRows.find((r) => r.id === testMessage.id);
    expect(legacyOpened.data?.message, 'the pre-change plaintext row reads as stored').toBe('legacy plaintext note');
    expect(sealedOpened.data?.message, 'the sealed row opens to its plaintext').toBe('test persistence');

    // The vendor's patch survived the re-save and the reload: the merge laid
    // localPatch back over the plain relay copy, and the opened view shows it.
    const reloadedOrder = opened.find((r) => r.id === orderMessage.id);
    expect(reloadedOrder?.data?.state, 'vendor patch survives a history re-save and reload').toBe('confirmed');

    // The chat list shows the last message body as the row preview. Bootstrap
    // fills dms from db.messages.toArray() only after its relay fetches settle,
    // so wait on the DOM itself rather than a fixed sleep.
    await expect(page.getByText('test persistence')).toBeVisible({ timeout: 30_000 });
  });

  test('a message written before openDBFor is stored sealed, not plaintext', async ({ page }) => {
    await page.goto('/');
    const dbName = await waitForAppDatabase(page);

    // Close the account's database, then write through the app seam: with no
    // database open, the save waits in the write queue (src/db.js) and is
    // applied when openDBFor runs again. Close, enqueue and reopen in one
    // evaluate, so a background fetch cannot reopen it in between.
    const peer = 'b'.repeat(64);
    const chatId = `dm:${peer}`;
    const message = {
      id: 'queued_before_open_1',
      chatId,
      pubkey: peer,
      timestamp: Math.floor(Date.now() / 1000),
      data: { message: 'written before open', type: 'text' },
      isSender: false,
    };
    await page.evaluate(async ({ chat, msg }) => {
      if (typeof window.__cipher.closeDB !== 'function'
        || typeof window.__cipher.openDBFor !== 'function') {
        throw new Error('window.__cipher.closeDB/openDBFor missing — app hook did not load');
      }
      window.__cipher.closeDB();
      await window.__cipher.saveMessage(chat, msg);
      window.__cipher.openDBFor(localStorage.getItem('cipher_db_owner'));
    }, { chat: chatId, msg: message });

    // The queue is drained asynchronously when the database opens.
    await expect.poll(
      async () => (await readStoredMessage(page, { dbName, msgId: message.id })).msg,
      { timeout: 10_000 },
    ).toBeDefined();

    // Done-when: the stored bytes do not contain the plaintext — the queued
    // write took the at-rest view, not the raw store.
    const stored = (await readStoredMessage(page, { dbName, msgId: message.id })).msg;
    expect(stored.sealed?.ct, 'the queued write reached disk through the seal').toBeTruthy();
    expect(JSON.stringify(stored).includes('written before open'), 'a queued write is never stored in plaintext').toBe(false);

    // And the queued write opens to its own content through the app's read path.
    const opened = await readOpenedRows(page);
    expect(opened.find((r) => r.id === message.id)?.data?.message, 'the queued write opens to its own content')
      .toBe('written before open');
  });

  test('a queued write flushed against an existing sealed row keeps its own content', async ({ page }) => {
    await page.goto('/');
    const dbName = await waitForAppDatabase(page);

    // First version of the row, written through the app: sealed at rest.
    const peer = 'c'.repeat(64);
    const chatId = `dm:${peer}`;
    const now = Math.floor(Date.now() / 1000);
    const firstVersion = {
      id: 'flush_keep_1',
      chatId,
      pubkey: peer,
      timestamp: now,
      data: { message: 'first note', type: 'text' },
      isSender: false,
    };
    await page.evaluate(async ({ chat, msg }) => {
      if (typeof window.__cipher.saveMessage !== 'function') {
        throw new Error('window.__cipher.saveMessage missing — app hook did not load');
      }
      await window.__cipher.saveMessage(chat, msg);
    }, { chat: chatId, msg: firstVersion });

    const stored = await readStoredMessage(page, { dbName, msgId: firstVersion.id });
    expect(stored.msg.sealed?.ct, 'the first version is sealed at rest').toBeTruthy();
    expect(JSON.stringify(stored.msg).includes('first note'), 'nothing plaintext beside the envelope').toBe(false);

    // Lock the vault in place — the session copy of the key is gone while the
    // database stays open — then save a later version of the same row: the
    // write cannot be sealed, so it is held in the at-rest queue
    // (src/lib/messageAtRest.js) and nothing reaches disk.
    await page.evaluate(() => sessionStorage.removeItem('cipher_session_sk'));
    const secondVersion = { ...firstVersion, timestamp: now + 1, data: { message: 'second note', type: 'text' } };
    await page.evaluate(async ({ chat, msg }) => {
      await window.__cipher.saveMessage(chat, msg);
    }, { chat: chatId, msg: secondVersion });

    const held = await readStoredMessage(page, { dbName, msgId: firstVersion.id });
    expect(JSON.stringify(held.msg).includes('second note'), 'the held write never touched disk').toBe(false);

    // Unlock in place and reopen the database: flushAtRestWrites opens the
    // existing sealed row, merges the held write over it, and re-seals. The
    // envelope still on disk must NOT be carried into that merge — its payload
    // is the row as of the first write, not this one.
    await page.evaluate(() => {
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array(32).fill(170)));
      window.__cipher.closeDB();
      window.__cipher.openDBFor(localStorage.getItem('cipher_db_owner'));
    });

    await expect.poll(async () => {
      const opened = await readOpenedRows(page);
      return opened.find((r) => r.id === firstVersion.id)?.data?.message;
    }, { timeout: 10_000 }).toBe('second note');

    const flushed = await readStoredMessage(page, { dbName, msgId: firstVersion.id });
    expect(flushed.msg.sealed?.ct, 'the flushed row is sealed again').toBeTruthy();
    const flushedBytes = JSON.stringify(flushed.msg);
    expect(flushedBytes.includes('second note'), 'no orphan plaintext fields beside the new envelope').toBe(false);
    expect(flushedBytes.includes('first note'), 'no stale payload was written back').toBe(false);
  });

});

// Outside the describe above on purpose: that describe seeds the session key
// with addInitScript, which would re-seed this test's "locked" reload too.
test('with the vault locked the app renders without crashing', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // No seeded session key: the app shows the lock screen first. Unlocking
  // here means putting the session key in place by hand, exactly what the
  // unlock paths do (src/useIdentity.js).
  await page.goto('/');
  await page.evaluate(() => {
    sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array(32).fill(170)));
  });
  await page.reload();
  // The rail rides md+ now; at phone width the chat list's kebab is the
  // mounted landmark.
  await page.getByRole('button', { name: 'Chat list menu' }).waitFor();

  // Dexie creates the database file lazily — wait for the app to open it.
  const deadline = Date.now() + 10_000;
  let dbName = null;
  while (Date.now() < deadline) {
    const names = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    dbName = names.find((n) => n && n.startsWith('CipherDB_v7_')) || null;
    if (dbName) break;
    await page.waitForTimeout(100);
  }
  expect(dbName, 'the unlocked app opened its per-account database').toBeTruthy();

  await page.evaluate(async () => {
    if (typeof window.__cipher.saveMessage !== 'function') {
      throw new Error('window.__cipher.saveMessage missing — app hook did not load');
    }
    await window.__cipher.saveMessage('dm:' + 'd'.repeat(64), {
      id: 'locked_test_1',
      pubkey: 'd'.repeat(64),
      timestamp: Math.floor(Date.now() / 1000),
      data: { message: 'locked vault note', type: 'text' },
      isSender: false,
    });
  });

  // Lock the app the way lockApp does: the session copy of the vault key
  // goes away. On reload the vault is locked while the sealed rows sit in
  // IndexedDB.
  await page.evaluate(() => sessionStorage.removeItem('cipher_session_sk'));
  await page.reload();

  // The lock screen renders and nothing threw.
  await expect(page.locator('h1')).toBeVisible({ timeout: 15_000 });
  expect(pageErrors, 'no uncaught error while locked').toEqual([]);
});
