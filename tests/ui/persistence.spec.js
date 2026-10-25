import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

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

test.describe('Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('message written through saveMessage survives reload in per-account database', async ({ page }) => {
    await page.goto('/');

    // Dexie creates the database file lazily, so at any fixed timeout nothing
    // may exist yet. Wait for the app instead: openDBFor names the per-account
    // database CipherDB_v7_<pk[:16]> (src/db.js). Poll databases() and, if it
    // never appears, fail with the list that was actually there.
    const deadline = Date.now() + 10_000;
    let dbName = null;
    let seen = [];
    while (Date.now() < deadline) {
      seen = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
      dbName = seen.find((n) => n && n.startsWith('CipherDB_v7_')) || null;
      if (dbName) break;
      await page.waitForTimeout(100);
    }
    if (!dbName) {
      throw new Error(`no CipherDB_v7_ database within 10s; databases seen: ${JSON.stringify(seen)}`);
    }

    // The app created this database, so the messages store must already exist.
    // Open without a version: this test never creates or upgrades anything.
    const pre = await readStoredMessage(page, { dbName, msgId: 'test_message_123' });
    expect(pre.store, 'the app database has a messages store').toBe(true);

    // A chat with a peer other than the account itself, so no history fetch for
    // an open chat can touch this row.
    const peerPk = 'f'.repeat(64);
    const chatId = `dm:${peerPk}`;
    const testMessage = {
      id: 'test_message_123',
      pubkey: peerPk,
      timestamp: Math.floor(Date.now() / 1000),
      data: { message: 'test persistence', type: 'text' },
      isSender: false,
    };

    // Write through the app's own saveMessage — exposed at window
    // .__cipherSaveMessage (src/db.js) — so the row takes the same merge +
    // tombstone transaction path as a real incoming message. saveMessage
    // swallows its own errors, so the write is verified below.
    await page.evaluate(async ({ chatId: chat, msg }) => {
      if (typeof window.__cipherSaveMessage !== 'function') {
        throw new Error('window.__cipherSaveMessage missing — app hook did not load');
      }
      await window.__cipherSaveMessage(chat, msg);
    }, { chatId, msg: testMessage });

    const seeded = await readStoredMessage(page, { dbName, msgId: testMessage.id });
    expect(seeded.store, 'the app database has a messages store').toBe(true);
    expect(seeded.msg, 'write through saveMessage landed in IndexedDB').toBeDefined();

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
      timestamp: Math.floor(Date.now() / 1000),
      data: { message: 'order placed', type: 'text' },
      isSender: true,
    };
    await page.evaluate(async ({ chat, order }) => {
      if (typeof window.__cipherSaveMessage !== 'function'
        || typeof window.__cipherPatchMessage !== 'function') {
        throw new Error('app hooks missing — window.__cipherSaveMessage/__cipherPatchMessage did not load');
      }
      await window.__cipherSaveMessage(chat, order);
      await window.__cipherPatchMessage(order.id, { state: 'confirmed' });
      // A history fetch re-saves the plain relay copy (src/hooks/useNIP44DM.js).
      await window.__cipherSaveMessage(chat, order);
    }, { chat: orderChat, order: orderMessage });

    const seededOrder = await readStoredMessage(page, { dbName, msgId: orderMessage.id });
    expect(seededOrder.store, 'the app database has a messages store').toBe(true);
    expect(seededOrder.msg, 'order write through saveMessage landed in IndexedDB').toBeDefined();

    // Reload page and wait for the app shell, then require the row both in
    // IndexedDB and in the DOM.
    await page.reload();
    await page.locator('nav').last().waitFor();

    const reloaded = await readStoredMessage(page, { dbName, msgId: testMessage.id });
    expect(reloaded.store, 'the app database has a messages store after reload').toBe(true);
    expect(reloaded.msg, 'row survived the reload in IndexedDB').toBeDefined();

    // The vendor's patch survived the re-save and the reload: the merge laid
    // localPatch back over the plain relay copy.
    const reloadedOrder = await readStoredMessage(page, { dbName, msgId: orderMessage.id });
    expect(reloadedOrder.msg?.data?.state, 'vendor patch survives a history re-save and reload').toBe('confirmed');

    // The chat list shows the last message body as the row preview. Bootstrap
    // fills dms from db.messages.toArray() only after its relay fetches settle,
    // so wait on the DOM itself rather than a fixed sleep.
    await expect(page.getByText('test persistence')).toBeVisible({ timeout: 30_000 });
  });
});
