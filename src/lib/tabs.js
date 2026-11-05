import { MessageSquare, User } from 'lucide-react';

// The two primary destinations (founder ruling 2026-11-05): the thread is the
// home and everything a conversation holds — chats, groups, menus, orders —
// lives inside it. This array is the one source — the bottom bar below md,
// the md+ rail and the command palette's Screen rows all map it; no surface
// keeps its own copy. `badge` is the badge key, not a count: the bar and rail
// resolve 'unread' and 'needsAction' from the store. Unread rides Threads;
// needsAction rides You, which is where the ledger's waiting orders live now
// that the Orders tab folded into that screen. `fills` marks the glyphs that
// read as solids when filled; a fill collapses the strokes of a line grid, so
// a tab without the flag never fills.
export const TABS = Object.freeze([
  { id: 'chat', label: 'Threads', icon: MessageSquare, badge: 'unread', fills: true },
  { id: 'profile', label: 'You', icon: User, badge: 'needsAction', fills: true },
]);

export const TAB_IDS = Object.freeze(TABS.map((tab) => tab.id));

// The Threads tab's own segment row: the kind it filters the list to and the
// browse it swaps in for Menus. The value `explore` is older than this row —
// it was the Menus tab's engineering key and the palette, boot and tests name
// it — so the key stays while the label the user reads is Menus. One source:
// ChatList renders this row and no screen hand-rolls a second copy.
export const THREAD_SEGMENTS = Object.freeze([
  { value: 'chats', label: 'Chats' },
  { value: 'groups', label: 'Groups' },
  { value: 'explore', label: 'Menus' },
]);
