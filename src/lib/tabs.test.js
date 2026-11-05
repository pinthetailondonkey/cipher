import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TABS, TAB_IDS, THREAD_SEGMENTS } from './tabs.js';

// The two-tab shell (founder ruling 2026-11-05): the order and the set are the
// product decision, so they are asserted exactly, and every surface that
// navigates is pinned to this file rather than its own copy.
const bar = readFileSync(new URL('../components/ui/BottomBar.jsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../AuthenticatedApp.jsx', import.meta.url), 'utf8');
const list = readFileSync(new URL('../components/chat/ChatList.jsx', import.meta.url), 'utf8');
const home = readFileSync(new URL('../features/chat/ChatHome.jsx', import.meta.url), 'utf8');

test('tabs are exactly Threads and You, with the badges the two destinations own', () => {
  assert.deepEqual(TAB_IDS, ['chat', 'profile']);
  assert.deepEqual(TABS.map((tab) => tab.label), ['Threads', 'You']);
  // Unread rides the conversation list; the orders the ledger wants a hand on
  // ride You, which is where that door lives now that Orders is not a tab.
  assert.deepEqual(TABS.map((tab) => tab.badge || null), ['unread', 'needsAction']);
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

test('the bottom bar is absent inside a conversation, and a browse is not a conversation', () => {
  // The bar hides on the Threads tab when the store's view is a thread — not
  // when the Menus segment or the directory is up, because both are lists to
  // the thumb and the bar is how the other destination stays reachable. The
  // gate lives in one expression so the shell owns it once.
  assert.match(shell, /activeTab === 'chat' && chatView !== 'list' && threadSegment !== 'explore' && !discoverOpen/);
  assert.match(shell, /\{!barHidden && <BottomBar/);
});

test('the Threads segments are three, and the old Menus tab key survives as the browse value', () => {
  assert.deepEqual(THREAD_SEGMENTS.map((segment) => segment.value), ['chats', 'groups', 'explore']);
  assert.deepEqual(THREAD_SEGMENTS.map((segment) => segment.label), ['Chats', 'Groups', 'Menus']);
  // `explore` was the Menus tab's engineering key: palette, boot and older
  // tests name it, so the word stays while the label the user reads is Menus.
  assert.ok(Object.isFrozen(THREAD_SEGMENTS), 'the segment set is one frozen source');
});

test('the segment row is the shared Segmented, and no screen hand-rolls a tablist for it', () => {
  assert.match(list, /from '\.\.\/\.\.\/lib\/tabs\.js'/);
  assert.match(list, /THREAD_SEGMENTS/);
  assert.match(list, /<Segmented/);
  assert.match(list, /ariaLabel="Filter chats"/);
  // The row this replaced was a hand-rolled role="group" of buttons with its
  // own SEGMENTS const; both are gone.
  assert.doesNotMatch(list, /role="group" aria-label="Filter chats"/);
  assert.doesNotMatch(list, /const SEGMENTS =/);
});

test('the list pane never has to know what a menu pane is: the browse arrives as a node', () => {
  assert.match(home, /browse=\{<Menus/);
  assert.match(list, /segment === 'explore'/);
  assert.match(list, /browse\}/);
  // The directory is one door, and it stands on the Groups segment alone.
  assert.match(list, /onOpenDiscover/);
  assert.match(home, /<Discover identity=\{identity\} onJoined=\{onGoToChat\}/);
});
