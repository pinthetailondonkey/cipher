import assert from 'node:assert/strict';
import test from 'node:test';
import { openQuery } from '../db.js';
import { setAtRestKeyProvider, trySealMessageRow } from './messageAtRest.js';

setAtRestKeyProvider(() => Uint8Array.from({ length: 32 }, (_, i) => i + 1));

// A stand-in for Dexie: where() gives a clause, equals() gives the collection
// that finally reads the stored (sealed) rows.
const fakeTable = (rows) => ({
  where: () => ({
    equals: () => ({
      toArray: async () => rows,
      first: async () => rows[0],
      sortBy: async () => rows,
      filter: () => ({ toArray: async () => rows }),
    }),
  }),
});

test('rows read through where().equals() come back opened, not as sealed shells', async () => {
  const sealed = await trySealMessageRow({
    id: 'm1', chatId: 'peer', isSender: true, timestamp: 10, deliveryStatus: 'sent', data: { type: 'order_request', status: 'accepted' },
  });
  assert.equal(sealed.data, undefined);
  const query = () => openQuery(fakeTable([sealed]).where('chatId')).equals('peer');
  assert.equal((await query().toArray())[0].data.status, 'accepted');
  assert.equal((await query().first()).deliveryStatus, 'sent');
  assert.equal((await query().sortBy('timestamp'))[0].data.type, 'order_request');
  assert.equal((await query().filter(() => true).toArray())[0].data.status, 'accepted');
});

test('the window.__cipher test seam is compiled in only for a build that asks for it', async () => {
  const fs = await import('node:fs');
  const dbSource = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.match(dbSource, /typeof window !== "undefined" && import\.meta\.env\?\.VITE_TEST_HOOKS === '1'\) \{\n  window\.__cipher = \{/);
  assert.equal(/if \(typeof window !== "undefined"\) \{\n  window\.__cipher/.test(dbSource), false);
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['test:ui'], /build-ui-test/);
});
