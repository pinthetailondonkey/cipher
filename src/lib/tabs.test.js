import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TABS, TAB_IDS } from './tabs.js';

// The four-tab shell (15.1): the order is the product decision, so it is
// asserted as exactly the four ids in UI-SPEC order, and every surface that
// navigates is pinned to this file rather than its own copy.
const bar = readFileSync(new URL('../components/ui/BottomBar.jsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../AuthenticatedApp.jsx', import.meta.url), 'utf8');

test('tabs are exactly the four destinations, in order, with badge keys on chats and orders only', () => {
  assert.deepEqual(TAB_IDS, ['chat', 'explore', 'orders', 'profile']);
  assert.deepEqual(TABS.map((tab) => tab.label), ['Chats', 'Menus', 'Orders', 'You']);
  assert.deepEqual(
    TABS.map((tab) => tab.badge || null),
    ['unread', null, 'needsAction', null],
  );
});

test('the bottom bar and the rail item list both map tabs.js — neither hardcodes the set', () => {
  assert.match(bar, /from '\.\.\/\.\.\/lib\/tabs\.js'/);
  assert.match(bar, /TABS\.map\(/);
  // The rail takes items as props; its one item source is the shell.
  assert.match(shell, /import \{ TABS \} from '\.\/lib\/tabs\.js';/);
  assert.match(shell, /TABS\.map\(/);
});

test('every tab id has a render path in the shell', () => {
  for (const id of TAB_IDS) {
    assert.match(shell, new RegExp(`activeTab === '${id}'`), `no render path for ${id}`);
  }
});

test('the bottom bar is absent inside a conversation: the shell gates it on the chat view', () => {
  // The bar hides on the chat tab when the store's view is a thread, not a
  // list. The gate lives in one expression so the shell owns it once.
  assert.match(shell, /activeTab === 'chat' && chatView !== 'list'/);
  assert.match(shell, /\{!barHidden && <BottomBar/);
});
