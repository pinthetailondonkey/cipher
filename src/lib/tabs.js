import { LayoutGrid, MessageSquare, Package, User } from 'lucide-react';

// The four primary destinations, in the founder's fixed order (UI-SPEC:
// Chats | Menus | Orders | Profile). This array is the one source — the
// bottom bar below md, the md+ rail and the command palette's Screen rows
// all map it; no surface keeps its own copy. The id `explore` predates the
// Menus rename (CommandPalette, boot deep links and tests name it), so the
// engineering key stays and the label the user reads is Menus. `badge` is
// the badge key, not a count: the bar and rail resolve 'unread' and
// 'needsAction' from the store, and a tab with no key never shows one.
// `fills` marks the two glyphs that still read as solids when filled; a fill
// collapses the strokes of a line grid (LayoutGrid) or a line box (Package),
// so those two never fill and stay outline-only.
export const TABS = Object.freeze([
  { id: 'chat', label: 'Chats', icon: MessageSquare, badge: 'unread', fills: true },
  { id: 'explore', label: 'Menus', icon: LayoutGrid },
  { id: 'orders', label: 'Orders', icon: Package, badge: 'needsAction' },
  { id: 'profile', label: 'Profile', icon: User, fills: true },
]);

export const TAB_IDS = Object.freeze(TABS.map((tab) => tab.id));
