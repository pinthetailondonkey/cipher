# UI inventory

Read at **`975506107eb4aeda200aecbeb254b4c42ac39c05`** (`main` after PR #33). This is an inventory only; nothing in `src/` changed.

**Method.** `/tmp/cipher-audit/ui-inventory.mjs` parses all 49 `.jsx` files with the repo's own `rolldown/parseAst` and reads every `className`: string literals and the static parts of template literals. Lists marked *heuristic* come from class names alone.

**Limits.** The scan does not resolve a class passed through a variable or prop, such as `row` in `ChatList.jsx:44`, `field` in `ProfileEditor.jsx:71`, or the `className` prop of `PrivateMedia`. Those were checked by hand and are noted where they matter. Nothing was rendered: no browser here.


## 1. States per screen

Every screen has its default state. The other three, from reading each screen (the pattern scan below backs it). *n/a* means the screen reads only local data and has no failure path of its own.

| Screen | File | Loading | Empty | Error |
|---|---|---|---|---|
| Lock screen (create, unlock, restore, save key, verify, profile) | `src/LockScreen.jsx` | yes: spinner on submit | n/a | yes: inline error |
| Chats list | `src/features/chat/ChatHome.jsx + ChatList.jsx` | yes: ChatLoading while store.loading (Chat.jsx:85) | yes: "No chats yet" (ChatList.jsx:36) | no: a failed fetch logs only (useChatBootstrap.js fetchChats catch) |
| DM thread | `src/components/chat/DmView.jsx` | no | yes: "Your messages stay private…" (DmView.jsx:29) | no: a failed send shows a toast, a failed history load nothing |
| Group thread | `src/components/chat/GroupView.jsx` | partial: "Securing…" per message | yes (GroupView.jsx:50) | yes: toast and inline (GroupView.jsx:83) |
| Search | `src/components/chat/SearchView.jsx` | yes (SearchView.jsx:41) | yes (SearchView.jsx:43) | no: failures end as "no results" |
| Shop | `src/Shop.jsx` | yes | yes (Shop.jsx:145) | yes (Shop.jsx:25) |
| Discover groups | `src/Discover.jsx` | yes | yes (Discover.jsx:107) | yes (Discover.jsx:71) |
| Profile tab (main) | `src/Wallet.jsx` | partial: upload spinner only | n/a | partial: status banner |
| Edit profile | `src/components/chat/ProfileEditor.jsx` | yes: `saving` disables Save | n/a | yes (ProfileEditor.jsx:61) |
| Privacy | `src/components/chat/PrivacySettings.jsx` | n/a | yes: no blocked people (PrivacySettings.jsx:94) | partial: motion note only |
| Connections | `src/components/chat/Connections.jsx` | n/a | yes | yes: onion warning |
| Accounts | `src/components/chat/AccountSwitcher.jsx` | yes (AccountSwitcher.jsx:52) | yes (AccountSwitcher.jsx:58) | yes (AccountSwitcher.jsx:17) |
| Backup | `src/components/chat/IdentityBackup.jsx` | yes (IdentityBackup.jsx:162) | n/a | yes (IdentityBackup.jsx:55) |
| My orders | `src/components/chat/MyOrders.jsx` | no: reads the store only | yes (MyOrders.jsx:21) | no |
| Message requests | `src/components/chat/MessageRequests.jsx` | no | yes (MessageRequests.jsx:17) | no |
| Vendor dashboard | `src/components/chat/VendorDashboard.jsx` | yes: dash while loading | yes (VendorDashboard.jsx:12) | no: a failed stats read logs only |
| Vendor storefront | `src/components/chat/VendorStorefront.jsx` | yes | yes (VendorStorefront.jsx:82) | yes (VendorStorefront.jsx:38) |
| Notifications | `src/components/chat/NotificationCenter.jsx` | n/a: store | yes (NotificationCenter.jsx:58) | n/a |
| Bookmarks | `src/components/chat/BookmarksViewer.jsx` | n/a: store | yes (BookmarksViewer.jsx:31) | no: a missing message just does not show |
| Group info | `src/components/chat/GroupInfoSidebar.jsx` | yes | yes | yes (GroupInfoSidebar.jsx:48) |
| Checkout sheet | `src/components/OneTapCheckout.jsx` | yes | yes: no addresses (OneTapCheckout.jsx:69) | yes (OneTapCheckout.jsx:34) |
| QR scanner | `src/components/chat/QRScanner.jsx` | no: blank video until the camera starts | n/a | yes (QRScanner.jsx:65) |
| Call overlay | `src/components/chat/CallOverlay.jsx` | yes: Calling…/Connecting… | n/a | yes: status text |
| Profile sheet | `src/components/ProfileModal.jsx` | yes: vouches | n/a | yes (ProfileModal.jsx:30) |
| Create group | `src/components/chat/CreateGroupModal.jsx` | yes: `creating` disables Create | n/a | no: failure is a toast from the hook |
| Broadcast product | `src/components/chat/BroadcastModal.jsx` | yes: `sending` disables Post | yes (BroadcastModal.jsx:21) | no: result is a toast |
| Edit listing | `src/components/chat/ProductEditModal.jsx` | no | n/a | yes (ProductEditModal.jsx:17) |
| Tutorial | `src/components/TutorialModal.jsx` | n/a | n/a | n/a |
| Global dialog | `src/components/GlobalDialog.jsx` | yes: `busy` disables Confirm | n/a | yes (GlobalDialog.jsx:16) |

Screens that can show only data, with no loading and no error state:
- DM thread;
- My orders;
- Message requests.

The Chats list and Search have no error state: a failed fetch looks like an empty list.

<details><summary>Pattern scan per file (raw)</summary>

```
src/App.jsx                                    loading yes:39  empty —  error yes:22
src/AuthenticatedApp.jsx                       loading yes:27  empty —  error —
src/Chat.jsx                                   loading yes:8  empty —  error —
src/Discover.jsx                               loading yes:2  empty yes:107  error yes:71
src/LockScreen.jsx                             loading yes:31  empty yes:69  error yes:43
src/Shop.jsx                                   loading yes:3  empty yes:145  error yes:25
src/Wallet.jsx                                 loading yes:64  empty —  error yes:86
src/components/GlobalDialog.jsx                loading —  empty —  error yes:16
src/components/Logo.jsx                        loading —  empty —  error —
src/components/MessageBubble.jsx               loading yes:115  empty —  error yes:41
src/components/MessageInput.jsx                loading yes:53  empty —  error yes:22
src/components/OneTapCheckout.jsx              loading yes:3  empty yes:69  error yes:34
src/components/ProfileModal.jsx                loading yes:14  empty —  error yes:30
src/components/TutorialModal.jsx               loading —  empty —  error —
src/components/chat/AccountSwitcher.jsx        loading yes:52  empty yes:58  error yes:17
src/components/chat/BookmarksViewer.jsx        loading —  empty yes:31  error —
src/components/chat/BroadcastModal.jsx         loading —  empty yes:21  error —
src/components/chat/CallOverlay.jsx            loading yes:64  empty —  error —
src/components/chat/ChatHeader.jsx             loading —  empty —  error —
src/components/chat/ChatList.jsx               loading —  empty yes:36  error —
src/components/chat/Connections.jsx            loading —  empty yes:61  error yes:44
src/components/chat/CreateGroupModal.jsx       loading —  empty —  error —
src/components/chat/DmView.jsx                 loading —  empty yes:29  error —
src/components/chat/FloatingMenu.jsx           loading —  empty —  error —
src/components/chat/GroupInfoSidebar.jsx       loading yes:217  empty yes:184  error yes:48
src/components/chat/GroupView.jsx              loading yes:63  empty yes:50  error yes:83
src/components/chat/IdentityBackup.jsx         loading yes:162  empty —  error yes:55
src/components/chat/LinkPreview.jsx            loading yes:16  empty —  error —
src/components/chat/MessageRequests.jsx        loading —  empty yes:17  error —
src/components/chat/MyOrders.jsx               loading yes:35  empty yes:21  error —
src/components/chat/MyProfileModal.jsx         loading —  empty yes:23  error yes:19
src/components/chat/NotificationCenter.jsx     loading —  empty yes:58  error —
src/components/chat/PrivacySettings.jsx        loading —  empty yes:94  error —
src/components/chat/ProductEditModal.jsx       loading —  empty —  error yes:17
src/components/chat/ProfileEditor.jsx          loading —  empty —  error yes:61
src/components/chat/QRScanner.jsx              loading —  empty —  error yes:65
src/components/chat/SearchView.jsx             loading yes:41  empty yes:43  error —
src/components/chat/VendorDashboard.jsx        loading yes:22  empty yes:12  error —
src/components/chat/VendorStorefront.jsx       loading yes:27  empty yes:82  error yes:38
src/components/ui/Avatar.jsx                   loading —  empty —  error —
src/components/ui/Button.jsx                   loading —  empty —  error —
src/components/ui/Input.jsx                    loading —  empty —  error —
src/components/ui/Picture.jsx                  loading —  empty —  error —
src/components/ui/PrivateMedia.jsx             loading yes:28  empty —  error yes:14
src/components/ui/ScreenHeader.jsx             loading —  empty —  error —
src/features/chat/ChatHome.jsx                 loading —  empty —  error —
src/features/chat/ChatLoading.jsx              loading yes:1  empty —  error —
src/features/chat/ChatOverlays.jsx             loading —  empty —  error —
src/features/chat/ToastBanner.jsx              loading —  empty —  error —
```
</details>


## 2. Repeated utility class strings, more than twice

repeated className strings, more than twice (58). Count, string, and every place:

```
31x  "min-w-0 flex-1"
     src/Wallet.jsx:360, src/Wallet.jsx:365, src/Wallet.jsx:370, src/Wallet.jsx:375, src/Wallet.jsx:384, src/Wallet.jsx:391, src/Wallet.jsx:396, src/Wallet.jsx:406, src/Wallet.jsx:411, src/Wallet.jsx:416, src/components/GlobalDialog.jsx:51, src/components/chat/AccountSwitcher.jsx:40, src/components/chat/BroadcastModal.jsx:35, src/components/chat/GroupInfoSidebar.jsx:169, src/components/chat/GroupInfoSidebar.jsx:192, src/components/chat/GroupInfoSidebar.jsx:218, src/components/chat/GroupView.jsx:38, src/components/chat/IdentityBackup.jsx:136, src/components/chat/IdentityBackup.jsx:144, src/components/chat/MessageRequests.jsx:32, src/components/chat/MyOrders.jsx:36, src/components/chat/NotificationCenter.jsx:72, src/components/chat/PrivacySettings.jsx:15, src/components/chat/PrivacySettings.jsx:41, src/components/chat/ProfileEditor.jsx:81, src/components/chat/ProfileEditor.jsx:88, src/components/chat/ProfileEditor.jsx:95, src/components/chat/ProfileEditor.jsx:102, src/components/chat/VendorDashboard.jsx:59, src/components/chat/VendorStorefront.jsx:72, src/components/chat/VendorStorefront.jsx:87
30x  "overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl"
     src/Wallet.jsx:256, src/Wallet.jsx:282, src/Wallet.jsx:357, src/Wallet.jsx:380, src/Wallet.jsx:403, src/Wallet.jsx:425, src/components/chat/BookmarksViewer.jsx:38, src/components/chat/ChatList.jsx:42, src/components/chat/Connections.jsx:36, src/components/chat/Connections.jsx:88, src/components/chat/GroupInfoSidebar.jsx:177, src/components/chat/GroupInfoSidebar.jsx:182, src/components/chat/GroupInfoSidebar.jsx:203, src/components/chat/GroupView.jsx:47, src/components/chat/GroupView.jsx:70, src/components/chat/IdentityBackup.jsx:123, src/components/chat/IdentityBackup.jsx:133, src/components/chat/MessageRequests.jsx:25, src/components/chat/MyOrders.jsx:29, src/components/chat/NotificationCenter.jsx:66, src/components/chat/PrivacySettings.jsx:80, src/components/chat/PrivacySettings.jsx:86, src/components/chat/PrivacySettings.jsx:93, src/components/chat/ProductEditModal.jsx:43, src/components/chat/ProfileEditor.jsx:78, src/components/chat/SearchView.jsx:49, src/components/chat/VendorDashboard.jsx:10, src/components/chat/VendorDashboard.jsx:45, src/components/chat/VendorDashboard.jsx:53, src/components/chat/VendorStorefront.jsx:83
22x  "text-white/40"
     src/Discover.jsx:89, src/Shop.jsx:123, src/Wallet.jsx:359, src/Wallet.jsx:364, src/Wallet.jsx:369, src/Wallet.jsx:374, src/Wallet.jsx:383, src/Wallet.jsx:390, src/Wallet.jsx:395, src/Wallet.jsx:405, src/Wallet.jsx:410, src/Wallet.jsx:415, src/Wallet.jsx:420, src/components/chat/GroupInfoSidebar.jsx:178, src/components/chat/GroupInfoSidebar.jsx:179, src/components/chat/IdentityBackup.jsx:128, src/components/chat/ProductEditModal.jsx:45, src/components/chat/ProductEditModal.jsx:49, src/components/chat/ProductEditModal.jsx:53, src/components/chat/ProductEditModal.jsx:57, src/components/chat/SearchView.jsx:24, src/components/chat/VendorDashboard.jsx:58
14x  "text-[15px] font-semibold text-white"
     src/Discover.jsx:110, src/Discover.jsx:129, src/Shop.jsx:142, src/Shop.jsx:148, src/components/MessageBubble.jsx:59, src/components/chat/BookmarksViewer.jsx:34, src/components/chat/Connections.jsx:32, src/components/chat/Connections.jsx:41, src/components/chat/GroupView.jsx:57, src/components/chat/GroupView.jsx:323, src/components/chat/NotificationCenter.jsx:61, src/components/chat/PrivacySettings.jsx:16, src/components/chat/QRScanner.jsx:125, src/components/chat/SearchView.jsx:45
14x  "block text-[15px] font-semibold text-white"
     src/Wallet.jsx:360, src/Wallet.jsx:365, src/Wallet.jsx:370, src/Wallet.jsx:375, src/Wallet.jsx:384, src/Wallet.jsx:391, src/Wallet.jsx:396, src/Wallet.jsx:406, src/Wallet.jsx:411, src/Wallet.jsx:416, src/components/chat/Connections.jsx:63, src/components/chat/Connections.jsx:76, src/components/chat/Connections.jsx:92, src/components/chat/PrivacySettings.jsx:42
12x  "block text-[13px] text-white/40"
     src/Wallet.jsx:360, src/Wallet.jsx:365, src/Wallet.jsx:370, src/Wallet.jsx:375, src/Wallet.jsx:384, src/Wallet.jsx:391, src/Wallet.jsx:396, src/Wallet.jsx:406, src/Wallet.jsx:411, src/Wallet.jsx:416, src/components/chat/CreateGroupModal.jsx:49, src/components/chat/SearchView.jsx:76
10x  "mt-1 text-[13px] text-white/40"
     src/Shop.jsx:143, src/components/MessageBubble.jsx:66, src/components/OneTapCheckout.jsx:61, src/components/chat/BookmarksViewer.jsx:35, src/components/chat/CreateGroupModal.jsx:37, src/components/chat/GroupView.jsx:63, src/components/chat/MessageRequests.jsx:21, src/components/chat/MyOrders.jsx:25, src/components/chat/NotificationCenter.jsx:62, src/components/chat/SearchView.jsx:46
10x  "text-white/30"
     src/Wallet.jsx:361, src/Wallet.jsx:366, src/Wallet.jsx:371, src/Wallet.jsx:376, src/Wallet.jsx:385, src/Wallet.jsx:392, src/Wallet.jsx:397, src/Wallet.jsx:407, src/Wallet.jsx:412, src/Wallet.jsx:417
9x  "block truncate text-[15px] font-semibold text-white"
     src/components/chat/AccountSwitcher.jsx:41, src/components/chat/BookmarksViewer.jsx:51, src/components/chat/ChatList.jsx:58, src/components/chat/ChatList.jsx:96, src/components/chat/GroupView.jsx:40, src/components/chat/MessageRequests.jsx:33, src/components/chat/MyOrders.jsx:37, src/components/chat/NotificationCenter.jsx:73, src/components/chat/SearchView.jsx:75
8x  "space-y-4 p-4"
     src/Wallet.jsx:254, src/Wallet.jsx:280, src/Wallet.jsx:305, src/Wallet.jsx:356, src/components/chat/Connections.jsx:30, src/components/chat/IdentityBackup.jsx:118, src/components/chat/PrivacySettings.jsx:79, src/components/chat/VendorDashboard.jsx:33
8x  "flex w-full items-center gap-3 border-b border-white/5 p-4 text-left"
     src/Wallet.jsx:358, src/Wallet.jsx:363, src/Wallet.jsx:368, src/Wallet.jsx:389, src/Wallet.jsx:404, src/Wallet.jsx:409, src/Wallet.jsx:414, src/Wallet.jsx:427
7x  "absolute left-[-10%] top-[-10%] h-[50%] w-[50%] rounded-full bg-blue-600/20 blur-[120px]"
     src/App.jsx:56, src/AuthenticatedApp.jsx:36, src/LockScreen.jsx:205, src/components/chat/BookmarksViewer.jsx:25, src/components/chat/NotificationCenter.jsx:53, src/components/chat/QRScanner.jsx:116, src/components/chat/SearchView.jsx:17
7x  "absolute bottom-[-10%] right-[-10%] h-[50%] w-[50%] rounded-full bg-purple-600/10 blur-[120px]"
     src/App.jsx:57, src/AuthenticatedApp.jsx:37, src/LockScreen.jsx:206, src/components/chat/BookmarksViewer.jsx:26, src/components/chat/NotificationCenter.jsx:54, src/components/chat/QRScanner.jsx:117, src/components/chat/SearchView.jsx:18
7x  "p-2 text-white/50 hover:text-white"
     src/components/OneTapCheckout.jsx:63, src/components/chat/ChatHeader.jsx:59, src/features/chat/ChatHome.jsx:44, src/features/chat/ChatHome.jsx:45, src/features/chat/ChatHome.jsx:46, src/features/chat/ChatHome.jsx:47, src/features/chat/ChatHome.jsx:48
7x  "min-w-0"
     src/components/ProfileModal.jsx:72, src/components/chat/BookmarksViewer.jsx:50, src/components/chat/ChatList.jsx:57, src/components/chat/ChatList.jsx:95, src/components/chat/Connections.jsx:40, src/components/chat/MyProfileModal.jsx:42, src/components/chat/SearchView.jsx:74
7x  "shrink-0 text-white/40"
     src/components/chat/AccountSwitcher.jsx:49, src/components/chat/IdentityBackup.jsx:135, src/components/chat/IdentityBackup.jsx:143, src/components/chat/PrivacySettings.jsx:40, src/components/chat/ProfileEditor.jsx:80, src/components/chat/ProfileEditor.jsx:87, src/components/chat/ProfileEditor.jsx:101
6x  "pointer-events-none absolute inset-0"
     src/AuthenticatedApp.jsx:54, src/components/chat/BookmarksViewer.jsx:24, src/components/chat/CallOverlay.jsx:59, src/components/chat/NotificationCenter.jsx:52, src/components/chat/QRScanner.jsx:115, src/components/chat/SearchView.jsx:16
6x  "truncate text-[15px] font-semibold text-white"
     src/Shop.jsx:164, src/components/chat/GroupInfoSidebar.jsx:193, src/components/chat/GroupInfoSidebar.jsx:219, src/components/chat/VendorDashboard.jsx:59, src/components/chat/VendorStorefront.jsx:73, src/components/chat/VendorStorefront.jsx:88
6x  "text-2xl font-bold tracking-tight text-white"
     src/Wallet.jsx:347, src/components/OneTapCheckout.jsx:60, src/components/chat/BroadcastModal.jsx:36, src/components/chat/CreateGroupModal.jsx:36, src/components/chat/ProductEditModal.jsx:40, src/features/chat/ChatHome.jsx:41
6x  "flex items-center gap-3 border-b border-white/5 p-4"
     src/components/chat/IdentityBackup.jsx:134, src/components/chat/ProductEditModal.jsx:44, src/components/chat/ProductEditModal.jsx:48, src/components/chat/ProductEditModal.jsx:52, src/components/chat/ProfileEditor.jsx:79, src/components/chat/ProfileEditor.jsx:86
5x  "text-[13px] text-white/40"
     src/Wallet.jsx:255, src/Wallet.jsx:281, src/components/OneTapCheckout.jsx:59, src/components/chat/VendorDashboard.jsx:36, src/components/chat/VendorDashboard.jsx:40
5x  "h-full overflow-y-auto bg-transparent pb-8"
     src/Wallet.jsx:278, src/Wallet.jsx:303, src/components/chat/IdentityBackup.jsx:116, src/components/chat/PrivacySettings.jsx:77, src/components/chat/ProfileEditor.jsx:74
5x  "flex w-full items-center gap-3 p-4 text-left"
     src/Wallet.jsx:373, src/Wallet.jsx:382, src/Wallet.jsx:394, src/Wallet.jsx:419, src/Wallet.jsx:431
5x  "truncate text-2xl font-bold tracking-tight text-white"
     src/components/ProfileModal.jsx:73, src/components/chat/ChatHeader.jsx:43, src/components/chat/GroupInfoSidebar.jsx:170, src/components/chat/MyProfileModal.jsx:43, src/components/ui/ScreenHeader.jsx:13
5x  "truncate text-[13px] text-white/40"
     src/components/ProfileModal.jsx:74, src/components/chat/GroupInfoSidebar.jsx:171, src/components/chat/MyProfileModal.jsx:44, src/components/chat/VendorStorefront.jsx:90, src/components/ui/ScreenHeader.jsx:14
5x  "block truncate text-[13px] text-white/40"
     src/components/chat/AccountSwitcher.jsx:42, src/components/chat/ChatList.jsx:59, src/components/chat/ChatList.jsx:99, src/components/chat/MessageRequests.jsx:34, src/components/chat/MyOrders.jsx:38
5x  "p-2 text-white/45 hover:text-white"
     src/components/chat/BroadcastModal.jsx:39, src/components/chat/DmView.jsx:47, src/components/chat/GroupInfoSidebar.jsx:173, src/components/chat/GroupView.jsx:350, src/components/chat/VendorStorefront.jsx:76
4x  "flex h-full items-center justify-center bg-black"
     src/AuthenticatedApp.jsx:27, src/Chat.jsx:23, src/Wallet.jsx:243, src/Wallet.jsx:247
4x  "h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500"
     src/AuthenticatedApp.jsx:27, src/Chat.jsx:24, src/Wallet.jsx:243, src/Wallet.jsx:247
4x  "animate-spin"
     src/LockScreen.jsx:306, src/LockScreen.jsx:318, src/Wallet.jsx:327, src/components/OneTapCheckout.jsx:90
4x  "h-full overflow-y-auto bg-transparent pb-safe"
     src/Wallet.jsx:252, src/components/chat/Connections.jsx:28, src/components/chat/MessageRequests.jsx:15, src/components/chat/MyOrders.jsx:19
4x  "hidden"
     src/Wallet.jsx:312, src/Wallet.jsx:342, src/components/MessageInput.jsx:29, src/components/chat/QRScanner.jsx:132
4x  "relative z-10 flex min-h-0 flex-1 flex-col"
     src/components/chat/BookmarksViewer.jsx:28, src/components/chat/NotificationCenter.jsx:56, src/components/chat/QRScanner.jsx:119, src/components/chat/SearchView.jsx:20
4x  "text-[13px] text-white/70"
     src/components/chat/CallOverlay.jsx:73, src/components/chat/CallOverlay.jsx:79, src/components/chat/CallOverlay.jsx:85, src/components/chat/CallOverlay.jsx:91
4x  "flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5"
     src/components/chat/MessageRequests.jsx:30, src/components/chat/MyOrders.jsx:34, src/components/chat/NotificationCenter.jsx:68, src/components/chat/PrivacySettings.jsx:39
4x  "w-full bg-transparent text-[15px] text-white outline-none"
     src/components/chat/ProductEditModal.jsx:46, src/components/chat/ProductEditModal.jsx:50, src/components/chat/ProductEditModal.jsx:54, src/components/chat/ProductEditModal.jsx:58
4x  "block text-[12px] text-white/40"
     src/components/chat/ProfileEditor.jsx:82, src/components/chat/ProfileEditor.jsx:89, src/components/chat/ProfileEditor.jsx:96, src/components/chat/ProfileEditor.jsx:103
3x  "pointer-events-none fixed inset-0"
     src/App.jsx:55, src/AuthenticatedApp.jsx:35, src/LockScreen.jsx:204
3x  "text-[10px] font-medium"
     src/AuthenticatedApp.jsx:85, src/AuthenticatedApp.jsx:89, src/AuthenticatedApp.jsx:94
3x  "mx-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl"
     src/Discover.jsx:108, src/Shop.jsx:141, src/Shop.jsx:146
3x  "mx-auto mb-3 text-white/30"
     src/Discover.jsx:109, src/Shop.jsx:147, src/components/chat/BookmarksViewer.jsx:33
3x  "flex items-center gap-3"
     src/Discover.jsx:124, src/components/chat/AccountSwitcher.jsx:38, src/features/chat/ChatHome.jsx:39
3x  "w-full relative"
     src/LockScreen.jsx:253, src/LockScreen.jsx:266, src/LockScreen.jsx:280
3x  "h-full w-full object-cover"
     src/Shop.jsx:155, src/components/chat/QRScanner.jsx:131, src/components/chat/SearchView.jsx:66
3x  "w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30"
     src/Wallet.jsx:283, src/Wallet.jsx:284, src/Wallet.jsx:285
3x  "text-[13px] text-white/45"
     src/components/MessageBubble.jsx:273, src/components/ui/PrivateMedia.jsx:27, src/components/ui/PrivateMedia.jsx:38
3x  "text-[12px] text-white/40"
     src/components/OneTapCheckout.jsx:66, src/components/chat/IdentityBackup.jsx:137, src/components/chat/IdentityBackup.jsx:145
3x  "flex flex-col items-center gap-2"
     src/components/chat/CallOverlay.jsx:77, src/components/chat/CallOverlay.jsx:83, src/components/chat/CallOverlay.jsx:89
3x  "flex min-w-0 items-center gap-3"
     src/components/chat/ChatList.jsx:55, src/components/chat/ChatList.jsx:91, src/components/chat/SearchView.jsx:64
3x  "mt-0.5 block text-[13px] text-white/40"
     src/components/chat/Connections.jsx:64, src/components/chat/Connections.jsx:77, src/components/chat/PrivacySettings.jsx:43
3x  "mt-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] text-white outline-none placeholder:text-white/30 focus:border-blue-500"
     src/components/chat/Connections.jsx:65, src/components/chat/Connections.jsx:78, src/components/chat/Connections.jsx:94
3x  "flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-5 py-3.5 font-bold text-white shadow-2xl active:bg-white/10"
     src/components/chat/FloatingMenu.jsx:31, src/components/chat/FloatingMenu.jsx:39, src/components/chat/FloatingMenu.jsx:47
3x  "text-sm font-bold tracking-wide"
     src/components/chat/FloatingMenu.jsx:35, src/components/chat/FloatingMenu.jsx:43, src/components/chat/FloatingMenu.jsx:51
3x  "p-2 bg-blue-600 rounded-full text-white shadow-lg"
     src/components/chat/FloatingMenu.jsx:36, src/components/chat/FloatingMenu.jsx:44, src/components/chat/FloatingMenu.jsx:52
3x  "w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30"
     src/components/chat/GroupView.jsx:79, src/components/chat/GroupView.jsx:80, src/components/chat/GroupView.jsx:81
3x  "text-[13px] font-semibold text-blue-500"
     src/components/chat/IdentityBackup.jsx:140, src/components/chat/IdentityBackup.jsx:148, src/components/chat/VendorStorefront.jsx:89
3x  "flex items-center gap-3 p-4"
     src/components/chat/IdentityBackup.jsx:142, src/components/chat/ProductEditModal.jsx:56, src/components/chat/ProfileEditor.jsx:100
3x  "flex items-center gap-3 border-b border-white/5 p-4 last:border-0"
     src/components/chat/PrivacySettings.jsx:99, src/components/chat/VendorDashboard.jsx:57, src/components/chat/VendorStorefront.jsx:85
```


## 3. Hardcoded colour, radius, spacing and font size

Every value written in a `className`, with its count. Values used four times or fewer list their places.

```
# colour: 94 distinct values, 1014 uses
 172  text-white
 131  border-white/10
 119  text-white/40
  49  border-white/5
  37  bg-blue-600
  37  bg-white/5
  32  text-blue-500
  30  bg-transparent
  28  hover:text-white
  23  text-white/50
  20  bg-black
  20  text-white/30
  18  text-red-400
  17  text-white/45
  15  bg-white/10
  15  focus:border-blue-500
  14  hover:bg-blue-500
  13  text-white/70
  12  placeholder:text-white/30
  11  active:bg-white/5
  11  text-blue-400
   9  border-white/20
   8  text-gray-500
   8  bg-black/80
   7  bg-blue-600/20
   7  bg-purple-600/10
   7  active:bg-white/10
   6  border-white/15
   6  text-white/60
   6  placeholder-gray-600
   6  text-amber-300
   6  text-white/55
   5  bg-red-600
   5  border-blue-500
   4  text-red-500   (src/App.jsx:22, src/LockScreen.jsx:271, src/LockScreen.jsx:302, src/Wallet.jsx:442)
   4  bg-white   (src/App.jsx:25, src/components/MessageBubble.jsx:228, src/components/OneTapCheckout.jsx:82, src/components/chat/PrivacySettings.jsx:46)
   4  bg-blue-500   (src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93, src/components/TutorialModal.jsx:66, src/components/chat/NotificationCenter.jsx:76)
   4  text-gray-400   (src/LockScreen.jsx:233, src/LockScreen.jsx:263, src/LockScreen.jsx:291, src/LockScreen.jsx:331)
   4  bg-black/60   (src/LockScreen.jsx:248, src/components/MessageBubble.jsx:297, src/components/chat/FloatingMenu.jsx:19, src/components/chat/ProductEditModal.jsx:37)
   4  text-amber-200   (src/components/MessageBubble.jsx:223, src/components/chat/GroupInfoSidebar.jsx:206, src/components/chat/GroupView.jsx:39, src/components/chat/IdentityBackup.jsx:119)
   4  active:bg-blue-700   (src/components/chat/AccountSwitcher.jsx:52, src/components/chat/CreateGroupModal.jsx:42, src/components/chat/CreateGroupModal.jsx:43, src/components/chat/FloatingMenu.jsx:59)
   3  text-black   (src/App.jsx:25, src/components/MessageBubble.jsx:229, src/components/MessageBubble.jsx:231)
   3  placeholder-white/30   (src/Discover.jsx:90, src/Shop.jsx:124, src/components/chat/CreateGroupModal.jsx:51)
   3  text-white/35   (src/LockScreen.jsx:325, src/components/ProfileModal.jsx:87, src/components/chat/BroadcastModal.jsx:53)
   3  hover:bg-red-500   (src/Wallet.jsx:446, src/components/GlobalDialog.jsx:70, src/components/MessageInput.jsx:58)
   3  bg-blue-400   (src/components/chat/ChatHeader.jsx:49, src/components/chat/ChatHeader.jsx:50, src/components/chat/ChatHeader.jsx:51)
   2  checked:bg-blue-600   (src/LockScreen.jsx:235, src/LockScreen.jsx:293)
   2  checked:border-blue-600   (src/LockScreen.jsx:235, src/LockScreen.jsx:293)
   2  text-emerald-400   (src/Wallet.jsx:294, src/components/ProfileModal.jsx:101)
   2  hover:bg-white/10   (src/Wallet.jsx:445, src/components/chat/CreateGroupModal.jsx:39)
   2  placeholder:text-white/35   (src/components/GlobalDialog.jsx:58, src/components/MessageInput.jsx:43)
   2  text-rose-200   (src/components/MessageBubble.jsx:125, src/components/chat/Connections.jsx:44)
   2  text-blue-300   (src/components/MessageBubble.jsx:246, src/components/chat/GroupView.jsx:59)
   2  bg-black/40   (src/components/MessageBubble.jsx:258, src/components/chat/LinkPreview.jsx:71)
   2  bg-black/70   (src/components/MessageBubble.jsx:278, src/components/chat/MyProfileModal.jsx:35)
   2  text-white/80   (src/components/MessageBubble.jsx:301, src/components/chat/QRScanner.jsx:140)
   2  focus:border-blue-500/50   (src/components/MessageInput.jsx:43, src/components/chat/CreateGroupModal.jsx:51)
   2  active:bg-red-700   (src/components/chat/CallOverlay.jsx:78, src/components/chat/CallOverlay.jsx:90)
   2  placeholder-white/40   (src/components/chat/SearchView.jsx:25, src/components/ui/Input.jsx:3)
   1  bg-red-900/20   (src/App.jsx:24)
   1  border-red-500/50   (src/App.jsx:24)
   1  bg-blue-500/30   (src/AuthenticatedApp.jsx:55)
   1  bg-purple-500/25   (src/AuthenticatedApp.jsx:56)
   1  hover:text-white/60   (src/AuthenticatedApp.jsx:87)
   1  group-hover:border-blue-500   (src/LockScreen.jsx:244)
   1  group-hover:text-blue-500   (src/LockScreen.jsx:245)
   1  hover:text-blue-400   (src/LockScreen.jsx:334)
   1  text-white/20   (src/Wallet.jsx:310)
   1  hover:bg-white/20   (src/Wallet.jsx:313)
   1  text-red-400/70   (src/Wallet.jsx:433)
   1  border-red-500/30   (src/Wallet.jsx:441)
   1  hover:bg-white/5   (src/components/GlobalDialog.jsx:69)
   1  bg-[#161616]   (src/components/MessageBubble.jsx:185)
   1  text-rose-300   (src/components/ProfileModal.jsx:97)
   1  bg-white/[0.03]   (src/components/chat/BroadcastModal.jsx:45)
   1  hover:bg-white/[0.07]   (src/components/chat/BroadcastModal.jsx:45)
   1  accent-blue-500   (src/components/chat/BroadcastModal.jsx:46)
   1  bg-blue-600/25   (src/components/chat/CallOverlay.jsx:60)
   1  bg-purple-600/15   (src/components/chat/CallOverlay.jsx:61)
   1  active:bg-white/20   (src/components/chat/CallOverlay.jsx:72)
   1  bg-emerald-500   (src/components/chat/CallOverlay.jsx:84)
   1  active:bg-emerald-600   (src/components/chat/CallOverlay.jsx:84)
   1  bg-rose-500/20   (src/components/chat/Connections.jsx:44)
   1  bg-black/50   (src/components/chat/GroupInfoSidebar.jsx:147)
   1  bg-amber-300/[0.07]   (src/components/chat/GroupView.jsx:31)
   1  border-blue-600   (src/components/chat/GroupView.jsx:304)
   1  border-amber-400/20   (src/components/chat/IdentityBackup.jsx:119)
   1  text-emerald-300   (src/components/chat/IdentityBackup.jsx:125)
   1  accent-blue-600   (src/components/chat/IdentityBackup.jsx:158)
   1  bg-black/30   (src/components/chat/LinkPreview.jsx:60)
   1  bg-white/15   (src/components/chat/PrivacySettings.jsx:45)
   1  focus:bg-white/10   (src/components/ui/Input.jsx:3)
   1  bg-red-500   (src/features/chat/ToastBanner.jsx:8)
   1  bg-green-500   (src/features/chat/ToastBanner.jsx:8)

# radius: 9 distinct values, 249 uses
 119  rounded-2xl
  69  rounded-full
  36  rounded-xl
  13  rounded-3xl
   4  rounded   (src/components/chat/LinkPreview.jsx:63, src/components/chat/LinkPreview.jsx:64, src/features/chat/ChatLoading.jsx:16, src/features/chat/ChatLoading.jsx:17)
   2  rounded-md   (src/LockScreen.jsx:235, src/LockScreen.jsx:293)
   2  rounded-lg   (src/components/MessageBubble.jsx:216, src/features/chat/ChatLoading.jsx:5)
   2  rounded-t-3xl   (src/components/chat/CreateGroupModal.jsx:33, src/components/chat/VendorStorefront.jsx:69)
   2  sm:rounded-3xl   (src/components/chat/CreateGroupModal.jsx:33, src/components/chat/VendorStorefront.jsx:69)

# spacing: 104 distinct values, 831 uses
  98  p-4
  69  gap-3
  68  px-4
  43  gap-2
  38  py-3
  33  inset-0
  28  p-2
  25  mt-1
  20  py-3.5
  17  mt-3
  16  gap-1
  15  mt-2
  14  py-4
  13  space-y-4
  13  mt-0.5
  11  mb-4
  11  mb-3
  10  mb-2
   9  top-[-10%]
   9  p-3
   9  mb-1
   8  p-6
   8  left-[-10%]
   8  bottom-[-10%]
   8  right-[-10%]
   8  py-16
   8  px-3
   8  py-2
   8  mt-5
   8  px-2
   7  px-6
   7  mx-4
   7  gap-4
   7  mt-4
   6  pb-4
   6  px-5
   6  pb-8
   6  py-8
   5  py-2.5
   5  px-1.5
   5  mb-8
   5  space-y-3
   4  p-1   (src/AuthenticatedApp.jsx:59, src/components/GlobalDialog.jsx:55, src/components/chat/CreateGroupModal.jsx:41, src/features/chat/ChatHome.jsx:43)
   4  left-4   (src/AuthenticatedApp.jsx:77, src/LockScreen.jsx:254, src/LockScreen.jsx:267, src/LockScreen.jsx:281)
   4  right-4   (src/AuthenticatedApp.jsx:77, src/components/ProfileModal.jsx:69, src/components/TutorialModal.jsx:53, src/components/chat/MyProfileModal.jsx:39)
   4  pb-3   (src/Discover.jsx:87, src/Shop.jsx:121, src/components/chat/PrivacySettings.jsx:90, src/components/chat/SearchView.jsx:22)
   4  p-5   (src/LockScreen.jsx:276, src/components/chat/BroadcastModal.jsx:32, src/components/chat/CreateGroupModal.jsx:33, src/components/chat/ProductEditModal.jsx:38)
   4  space-y-2   (src/components/MessageBubble.jsx:226, src/components/chat/BroadcastModal.jsx:42, src/components/chat/LinkPreview.jsx:62, src/features/chat/ChatLoading.jsx:15)
   3  pt-3   (src/AuthenticatedApp.jsx:58, src/Shop.jsx:163, src/features/chat/ChatHome.jsx:38)
   3  pr-5   (src/LockScreen.jsx:255, src/LockScreen.jsx:268, src/LockScreen.jsx:282)
   3  py-1   (src/Shop.jsx:167, src/components/MessageBubble.jsx:177, src/components/ui/ScreenHeader.jsx:12)
   3  mb-5   (src/Wallet.jsx:271, src/components/chat/CreateGroupModal.jsx:34, src/components/chat/CreateGroupModal.jsx:41)
   3  py-0.5   (src/components/MessageBubble.jsx:60, src/components/MessageBubble.jsx:258, src/components/chat/Connections.jsx:44)
   3  ml-2   (src/components/MessageBubble.jsx:123, src/components/chat/ChatList.jsx:67, src/components/chat/ChatList.jsx:105)
   3  mb-0.5   (src/components/MessageBubble.jsx:185, src/components/MessageBubble.jsx:185, src/components/MessageBubble.jsx:198)
   3  p-2.5   (src/components/MessageInput.jsx:58, src/components/MessageInput.jsx:62, src/components/MessageInput.jsx:66)
   3  top-4   (src/components/ProfileModal.jsx:69, src/components/TutorialModal.jsx:53, src/components/chat/MyProfileModal.jsx:39)
   3  py-10   (src/components/chat/AccountSwitcher.jsx:58, src/components/chat/ChatList.jsx:37, src/components/chat/QRScanner.jsx:123)
   3  top-0   (src/components/chat/ChatHeader.jsx:37, src/components/chat/VendorStorefront.jsx:70, src/components/ui/ScreenHeader.jsx:6)
   2  mt-6   (src/App.jsx:25, src/components/chat/ChatList.jsx:37)
   2  pb-1   (src/AuthenticatedApp.jsx:58, src/Shop.jsx:163)
   2  top-1   (src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93)
   2  right-3   (src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93)
   2  pt-2   (src/Discover.jsx:87, src/Shop.jsx:121)
   2  mt-20   (src/Discover.jsx:103, src/Shop.jsx:136)
   2  py-1.5   (src/Discover.jsx:133, src/components/chat/SearchView.jsx:79)
   2  pl-11   (src/LockScreen.jsx:255, src/LockScreen.jsx:282)
   2  mb-6   (src/Wallet.jsx:443, src/features/chat/ChatLoading.jsx:4)
   2  pr-8   (src/components/ProfileModal.jsx:70, src/components/chat/MyProfileModal.jsx:40)
   2  pb-24   (src/components/chat/AccountSwitcher.jsx:31, src/components/chat/VendorDashboard.jsx:31)
   2  p-0   (src/components/chat/CreateGroupModal.jsx:30, src/components/chat/VendorStorefront.jsx:68)
   2  sm:p-4   (src/components/chat/CreateGroupModal.jsx:30, src/components/chat/VendorStorefront.jsx:68)
   2  mx-3   (src/components/chat/DmView.jsx:42, src/components/chat/GroupView.jsx:345)
   2  pl-3   (src/components/chat/DmView.jsx:43, src/components/chat/GroupView.jsx:346)
   2  right-6   (src/components/chat/FloatingMenu.jsx:24, src/components/chat/FloatingMenu.jsx:59)
   1  left-[-20%]   (src/AuthenticatedApp.jsx:55)
   1  bottom-[-15%]   (src/AuthenticatedApp.jsx:56)
   1  right-[-20%]   (src/AuthenticatedApp.jsx:56)
   1  bottom-4   (src/AuthenticatedApp.jsx:77)
   1  py-12   (src/LockScreen.jsx:203)
   1  space-y-6   (src/LockScreen.jsx:225)
   1  pl-24   (src/LockScreen.jsx:268)
   1  mt-8   (src/LockScreen.jsx:313)
   1  -ml-2   (src/Wallet.jsx:271)
   1  top-20   (src/Wallet.jsx:337)
   1  pb-2   (src/Wallet.jsx:340)
   1  pt-8   (src/Wallet.jsx:340)
   1  ml-1   (src/components/GlobalDialog.jsx:71)
   1  mt-[5px]   (src/components/MessageBubble.jsx:123)
   1  p-8   (src/components/TutorialModal.jsx:47)
   1  gap-14   (src/components/chat/CallOverlay.jsx:69)
   1  px-8   (src/components/chat/CallOverlay.jsx:69)
   1  pb-16   (src/components/chat/CallOverlay.jsx:69)
   1  gap-0.5   (src/components/chat/ChatHeader.jsx:48)
   1  sm:p-6   (src/components/chat/CreateGroupModal.jsx:33)
   1  bottom-40   (src/components/chat/FloatingMenu.jsx:24)
   1  bottom-24   (src/components/chat/FloatingMenu.jsx:59)
   1  px-1   (src/components/chat/IdentityBackup.jsx:164)
   1  m-4   (src/components/chat/NotificationCenter.jsx:59)
   1  top-0.5   (src/components/chat/PrivacySettings.jsx:46)
   1  gap-5   (src/components/chat/QRScanner.jsx:121)
   1  mt-10   (src/components/chat/SearchView.jsx:40)
   1  ml-3   (src/components/chat/SearchView.jsx:79)
   1  pr-3   (src/components/ui/ScreenHeader.jsx:12)

# fontSize: 14 distinct values, 346 uses
 141  text-[13px]
  92  text-[15px]
  37  text-sm
  18  text-2xl
  14  text-[12px]
  13  text-[10px]
   9  text-[11px]
   7  text-xs
   5  text-[16px]
   5  text-xl
   2  text-[22px]   (src/components/MessageBubble.jsx:282, src/components/OneTapCheckout.jsx:67)
   1  text-[14.5px]   (src/components/MessageBubble.jsx:237)
   1  text-[14px]   (src/components/TutorialModal.jsx:62)
   1  text-4xl   (src/components/chat/CallOverlay.jsx:64)

# arbitrary: 55 distinct values, 508 uses
 141  text-[13px]
  96  bg-[#0A0A0A]/60
  92  text-[15px]
  17  h-[50%]
  16  w-[50%]
  16  blur-[120px]
  14  text-[12px]
  13  text-[10px]
   9  top-[-10%]
   9  text-[11px]
   8  left-[-10%]
   8  bottom-[-10%]
   8  right-[-10%]
   7  z-[999]
   5  text-[16px]
   3  h-[16px]   (src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93, src/components/chat/NotificationCenter.jsx:76)
   3  min-w-[16px]   (src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93, src/components/chat/NotificationCenter.jsx:76)
   3  z-[1000]   (src/components/GlobalDialog.jsx:47, src/components/ProfileModal.jsx:67, src/components/chat/MyProfileModal.jsx:35)
   2  h-[100dvh]   (src/AuthenticatedApp.jsx:34, src/LockScreen.jsx:203)
   2  w-[70%]   (src/AuthenticatedApp.jsx:55, src/AuthenticatedApp.jsx:56)
   2  text-[22px]   (src/components/MessageBubble.jsx:282, src/components/OneTapCheckout.jsx:67)
   1  min-h-[100dvh]   (src/App.jsx:54)
   1  h-[calc(100dvh-6.5rem-env(safe-area-inset-bottom))]   (src/AuthenticatedApp.jsx:43)
   1  left-[-20%]   (src/AuthenticatedApp.jsx:55)
   1  h-[55%]   (src/AuthenticatedApp.jsx:55)
   1  blur-[100px]   (src/AuthenticatedApp.jsx:55)
   1  bottom-[-15%]   (src/AuthenticatedApp.jsx:56)
   1  right-[-20%]   (src/AuthenticatedApp.jsx:56)
   1  blur-[110px]   (src/AuthenticatedApp.jsx:56)
   1  max-w-[280px]   (src/LockScreen.jsx:218)
   1  mt-[5px]   (src/components/MessageBubble.jsx:123)
   1  bg-[#161616]   (src/components/MessageBubble.jsx:185)
   1  max-w-[78%]   (src/components/MessageBubble.jsx:187)
   1  min-w-[4.5rem]   (src/components/MessageBubble.jsx:187)
   1  text-[14.5px]   (src/components/MessageBubble.jsx:237)
   1  leading-[1.28]   (src/components/MessageBubble.jsx:237)
   1  z-[75]   (src/components/MessageBubble.jsx:278)
   1  z-[70]   (src/components/MessageBubble.jsx:297)
   1  max-h-[90vh]   (src/components/OneTapCheckout.jsx:56)
   1  text-[14px]   (src/components/TutorialModal.jsx:62)
   1  z-[950]   (src/components/chat/BroadcastModal.jsx:31)
   1  bg-white/[0.03]   (src/components/chat/BroadcastModal.jsx:45)
   1  hover:bg-white/[0.07]   (src/components/chat/BroadcastModal.jsx:45)
   1  z-[80]   (src/components/chat/CallOverlay.jsx:58)
   1  [animation-delay:0ms]   (src/components/chat/ChatHeader.jsx:49)
   1  [animation-delay:120ms]   (src/components/chat/ChatHeader.jsx:50)
   1  [animation-delay:240ms]   (src/components/chat/ChatHeader.jsx:51)
   1  max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)]   (src/components/chat/CreateGroupModal.jsx:33)
   1  shadow-[0_0_20px_rgba(37,99,235,0.4)]   (src/components/chat/FloatingMenu.jsx:59)
   1  z-[980]   (src/components/chat/GroupInfoSidebar.jsx:147)
   1  bg-amber-300/[0.07]   (src/components/chat/GroupView.jsx:31)
   1  z-[90]   (src/components/chat/ProductEditModal.jsx:37)
   1  z-[900]   (src/components/chat/VendorStorefront.jsx:68)
   1  max-h-[90dvh]   (src/components/chat/VendorStorefront.jsx:69)
   1  z-[200]   (src/features/chat/ToastBanner.jsx:7)
```

Hardcoded values in CSS and config, raw:

```
index.html:10  #000000
index.html:23  #000000
index.html:31  #000000
src/App.css:4  12px
src/App.css:8  #1a1a1a
src/App.css:9  8px
src/App.css:10  12px
src/App.css:16  120px
src/App.css:18  4px
src/App.css:19  8px
src/App.css:23  14px
src/App.css:24  4px
src/App.css:28  16px
src/App.css:30  #fff
src/App.css:31  4px
src/App.css:35  12px
src/App.css:36  #888
src/App.css:37  8px
src/App.css:41  #fff
src/App.css:42  #000
src/App.css:44  8px 16px
src/App.css:45  4px
src/App.css:46  14px
src/App.css:52  #ccc
src/index.css:7  #000000
src/index.css:8  #0a0a0a
src/index.css:9  #111111
src/index.css:10  #171717
src/index.css:11  #1d1d1d
src/index.css:12  rgba(255, 255, 255, 0.08)
src/index.css:13  rgba(255, 255, 255, 0.12)
src/index.css:14  #f5f5f5
src/index.css:15  #9ca3af
src/index.css:16  #6b7280
src/index.css:17  #3b82f6
src/index.css:18  rgba(59, 130, 246, 0.12)
src/index.css:19  #10b981
src/index.css:20  #ef4444
src/index.css:21  0px
src/index.css:22  0px
src/index.css:23  4rem
src/index.css:24  1.25rem 14rem 1.25rem
src/index.css:65  2px rgba(59, 130, 246, 0.9)
src/index.css:66  2px
src/index.css:76  0.5rem
src/index.css:81  640px
src/index.css:90  0.5rem
src/index.css:91  1.5rem 1.5rem
src/index.css:92  1.5rem
src/index.css:103  0.5rem
src/index.css:106  1.5rem 1.5rem
src/index.css:107  1.5rem
src/index.css:113  rgba(156, 163, 175, 0.8)
src/index.css:124  rgba(59, 130, 246, 0.13)
src/index.css:125  rgba(59, 130, 246, 0.06)
src/index.css:126  #000
src/index.css:137  1.5rem
src/index.css:138  1rem
src/index.css:139  1.25rem
src/index.css:140  6rem
src/index.css:141  44px 44px
src/index.css:149  600px
src/index.css:150  200px
src/index.css:151  rgba(59, 130, 246, 0.15) rgba(0,0,0,0)
src/index.css:157  rgba(17, 17, 17, 0.9)
src/index.css:158  1px
src/index.css:159  1rem
src/index.css:164  0.75rem
src/index.css:168  rgba(255, 255, 255, 0.06)
src/index.css:176  #3b82f6
src/index.css:177  10px rgba(59, 130, 246, 0.5)
src/index.css:181  #10b981
src/index.css:182  10px rgba(16, 185, 129, 0.5)
src/index.css:190  rgba(28, 28, 30, 0.7)
src/index.css:191  20px
src/index.css:192  20px
src/index.css:193  1px rgba(255, 255, 255, 0.08)
src/index.css:194  8px 32px rgba(0, 0, 0, 0.37)
src/index.css:198  rgba(10, 10, 10, 0.75)
src/index.css:199  24px
src/index.css:200  24px
src/index.css:201  1px rgba(255, 255, 255, 0.05)
tailwind.config.cjs:11  #000000
tailwind.config.cjs:12  #0a0a0a
tailwind.config.cjs:13  #171717
tailwind.config.cjs:14  #262626
```

Theme scaffolding that exists and is not used:
- **`index.css` variables:** 18 are defined (`--bg`, `--panel`, `--accent`, `--danger`, …; `index.css:5-24`). None is read by any `.jsx` file. Components hardcode `bg-[#0A0A0A]/60` (96 uses), `text-white/40` (119), `bg-blue-600` (37) and so on.
- **`index.css` utilities:** 12 of the 17 utility classes are never used: `cipher-shell`, `cipher-tab`, `pb-sheet`, `fab-pos`, `fab-menu-pos`, `linear-glow`, `hybrid-panel`, `hybrid-button`, `neon-blue`, `neon-green`, `glass-panel`, `glass-header`.
- **`tailwind.config.cjs`:** the colours `base`, `surface`, `surfaceLight` and `borderDark` are used 0, 1, 2 and 0 times. The font family `Inter` is declared, but no Inter font is loaded, so it falls back to the system stack.
- **`src/App.css`:** imported by nothing. It is dead, and its colours above have no effect.


## 4. Interactive elements: focus, labels, tap targets

**Focus.** `index.css` sets one global `:focus-visible` outline (`index.css:63-66`). It covers every button, link and `role="button"` element. No element sets its own `focus-visible:` style. The same file then removes the outline from inputs, textareas and selects (`index.css:68-72`), so a text field has a focus cue only if it adds a `focus:` class.

```
# text fields: 38; with no focus cue of their own: 19
src/Wallet.jsx:257  <input>  w-full border-b border-white/5 bg-transparent px-4 py-4 text-[15px] text-white outline-none placehol
src/Wallet.jsx:258  <input>  w-full bg-transparent px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30
src/Wallet.jsx:283  <input>  w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder
src/Wallet.jsx:284  <input>  w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder
src/Wallet.jsx:285  <input>  w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder
src/Wallet.jsx:286  <select>  w-full bg-white/5 px-4 py-4 text-[15px] text-white outline-none
src/components/chat/AccountSwitcher.jsx:50  <input>  min-w-0 flex-1 bg-transparent py-3 text-[15px] text-white outline-none placeholder:text-white/30
src/components/chat/GroupView.jsx:79  <input>  w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placehol
src/components/chat/GroupView.jsx:80  <input>  w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placehol
src/components/chat/GroupView.jsx:81  <input>  w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placehol
src/components/chat/ProductEditModal.jsx:46  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProductEditModal.jsx:50  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProductEditModal.jsx:54  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProductEditModal.jsx:58  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProfileEditor.jsx:83  <input>  (no class)
src/components/chat/ProfileEditor.jsx:90  <input>  (no class)
src/components/chat/ProfileEditor.jsx:97  <textarea>  resize-none
src/components/chat/ProfileEditor.jsx:104  <input>  (no class)
src/components/chat/SearchView.jsx:25  <input>  w-full bg-transparent text-[15px] text-white placeholder-white/40 outline-none
```
`ProfileEditor.jsx:83, 90, 97, 104` use `field` (`ProfileEditor.jsx:71`), which has `outline-none` and no `focus:` class, so they are bare too.

**Icon-only buttons without an aria label:**
```
# icon-only and missing an aria label (6)
src/Wallet.jsx:271  <button>  mb-5 -ml-2 touch-target p-2 text-white/50 hover:text-white
src/components/TutorialModal.jsx:53  <button>  absolute top-4 right-4 text-white/30 hover:text-white transition-colors
src/components/chat/FloatingMenu.jsx:59  <motion.button>  fixed bottom-24 right-6 z-50 rounded-full bg-blue-600 p-4 text-white shadow-[0_0_20px_rgba
src/features/chat/ChatHome.jsx:44  <button>  p-2 text-white/50 hover:text-white
src/features/chat/ChatHome.jsx:47  <button>  p-2 text-white/50 hover:text-white
src/features/chat/ChatHome.jsx:48  <button>  p-2 text-white/50 hover:text-white
```

**Below a 44px tap target, heuristic** (80 after removing four known false positives: the `ChatList` rows, which get `p-4` through `row`, and the `Picture` and `PrivateMedia` link wrappers, which are sized by the image). The rule: no `min-h-11`, `h-11` or larger, `touch-target`, or vertical padding of `3` or more.
```
src/AuthenticatedApp.jsx:60  <button>  rounded-xl py-2.5 text-[13px] font-bold shop bg-blue-600 text-white shadow-lg text-white/6
src/AuthenticatedApp.jsx:61  <button>  rounded-xl py-2.5 text-[13px] font-bold groups bg-blue-600 text-white shadow-lg text-white
src/AuthenticatedApp.jsx:82  <button>  relative flex flex-col items-center gap-1 w-16 active:scale-95 transition-transform durati
src/AuthenticatedApp.jsx:87  <button>  flex flex-col items-center gap-1 w-16 transition-all active:scale-90 explore text-blue-500
src/AuthenticatedApp.jsx:91  <button>  relative flex flex-col items-center gap-1 w-16 active:scale-95 transition-transform durati
src/Discover.jsx:90  <input>  flex-1 bg-transparent text-[15px] text-white placeholder-white/30 focus:outline-none
src/LockScreen.jsx:235  <input>  peer appearance-none w-5 h-5 border border-white/20 rounded-md bg-white/5 checked:bg-blue-
src/LockScreen.jsx:276  <textarea>  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-5 text-
src/LockScreen.jsx:293  <input>  peer appearance-none w-5 h-5 border border-white/20 rounded-md bg-white/5 checked:bg-blue-
src/LockScreen.jsx:322  <button>  text-gray-500 hover:text-white text-sm font-medium transition-colors
src/LockScreen.jsx:331  <button>  text-gray-400 hover:text-white text-sm font-medium transition-colors
src/LockScreen.jsx:334  <button>  text-blue-500 hover:text-blue-400 text-sm font-medium transition-colors
src/LockScreen.jsx:342  <button>  text-gray-500 hover:text-white text-sm font-medium transition-colors flex items-center gap
src/LockScreen.jsx:345  <button>  text-gray-500 hover:text-white text-sm font-medium transition-colors
src/LockScreen.jsx:352  <button>  text-gray-500 hover:text-white text-sm font-medium transition-colors flex items-center gap
src/Shop.jsx:124  <input>  flex-1 bg-transparent text-[15px] text-white placeholder-white/30 focus:outline-none
src/Shop.jsx:166  <button>  mt-3 w-full rounded-2xl bg-blue-600 py-2.5 text-[13px] font-bold text-white shadow-lg
src/Shop.jsx:167  <button>  mt-1 w-full py-1 text-[12px] font-semibold text-white/50
src/Wallet.jsx:321  <select>  border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-4 text-sm foc
src/Wallet.jsx:350  <button>  flex items-center gap-2 rounded-full border border-white/10 bg-[#0A0A0A]/60 shadow-2xl bac
src/components/GlobalDialog.jsx:55  <button>  p-1 text-white/45 hover:text-white
src/components/MessageBubble.jsx:187  <div>  max-w-[78%] min-w-[4.5rem] rounded-2xl border px-3 py-2 border-blue-500 bg-blue-600 text-w
src/components/MessageBubble.jsx:258  <motion.button>  rounded-full border border-white/10 bg-black/40 px-1.5 py-0.5 text-[12px] text-white
src/components/MessageBubble.jsx:282  <button>  text-[22px] active:scale-95
src/components/MessageBubble.jsx:305  <button>  mt-3 text-[13px] font-semibold text-blue-500
src/components/MessageInput.jsx:40  <button>  shrink-0 p-2 text-white/55 hover:text-white disabled:opacity-40
src/components/MessageInput.jsx:58  <button>  shrink-0 rounded-full bg-red-600 p-2.5 text-white hover:bg-red-500
src/components/MessageInput.jsx:62  <button>  shrink-0 rounded-full bg-blue-600 p-2.5 text-white hover:bg-blue-500 disabled:opacity-40
src/components/MessageInput.jsx:66  <button>  shrink-0 p-2.5 text-white/55 hover:text-white disabled:opacity-40
src/components/OneTapCheckout.jsx:63  <button>  p-2 text-white/50 hover:text-white
src/components/OneTapCheckout.jsx:78  <button>  flex items-center gap-1 text-[12px] font-semibold text-blue-500
src/components/ProfileModal.jsx:69  <button>  absolute right-4 top-4 p-2 text-white/45 hover:text-white
src/components/TutorialModal.jsx:53  <button>  absolute top-4 right-4 text-white/30 hover:text-white transition-colors
src/components/chat/AccountSwitcher.jsx:52  <button>  rounded-2xl bg-blue-600 px-4 font-bold text-white active:bg-blue-700
src/components/chat/BroadcastModal.jsx:39  <button>  p-2 text-white/45 hover:text-white
src/components/chat/BroadcastModal.jsx:46  <input>  h-4 w-4 accent-blue-500
src/components/chat/CallOverlay.jsx:71  <button>  flex flex-col items-center gap-2 text-white
src/components/chat/CallOverlay.jsx:77  <button>  flex flex-col items-center gap-2
src/components/chat/CallOverlay.jsx:83  <button>  flex flex-col items-center gap-2
src/components/chat/CallOverlay.jsx:89  <button>  flex flex-col items-center gap-2
src/components/chat/ChatHeader.jsx:39  <button>  p-2 text-white
src/components/chat/ChatHeader.jsx:42  <button>  min-w-0 text-left
src/components/chat/ChatHeader.jsx:59  <button>  p-2 text-white/50 hover:text-white
src/components/chat/ChatHeader.jsx:60  <button>  p-2 text-white/70 hover:text-white
src/components/chat/CreateGroupModal.jsx:39  <button>  rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white
src/components/chat/DmView.jsx:47  <button>  p-2 text-white/45 hover:text-white
src/components/chat/FloatingMenu.jsx:19  <motion.div>  fixed inset-0 z-40 bg-black/60 backdrop-blur-sm
src/components/chat/GroupInfoSidebar.jsx:173  <button>  p-2 text-white/45 hover:text-white
src/components/chat/GroupInfoSidebar.jsx:197  <button>  text-[13px] font-semibold text-red-400 disabled:opacity-50
src/components/chat/GroupInfoSidebar.jsx:208  <button>  ml-auto text-blue-500 disabled:opacity-50
src/components/chat/GroupInfoSidebar.jsx:223  <button>  text-[13px] font-semibold text-blue-500 disabled:opacity-40
src/components/chat/GroupView.jsx:304  <button>  py-2.5 text-[13px] font-semibold border-b-2 border-blue-600 text-white text-white/40
src/components/chat/GroupView.jsx:350  <button>  p-2 text-white/45 hover:text-white
src/components/chat/IdentityBackup.jsx:140  <button>  text-[13px] font-semibold text-blue-500
src/components/chat/IdentityBackup.jsx:148  <button>  text-[13px] font-semibold text-blue-500
src/components/chat/IdentityBackup.jsx:158  <input>  mt-0.5 h-5 w-5 accent-blue-600
src/components/chat/LinkPreview.jsx:71  <a>  mb-1 block overflow-hidden rounded-xl border border-white/10 bg-black/40 text-left
src/components/chat/MyProfileModal.jsx:39  <button>  absolute right-4 top-4 p-2 text-white/45 hover:text-white
src/components/chat/PrivacySettings.jsx:20  <button>  rounded-2xl border px-3 py-2 text-[13px] font-bold active:scale-95 border-blue-500 bg-blue
src/components/chat/PrivacySettings.jsx:102  <button>  text-[13px] font-bold text-blue-500
src/components/chat/ProductEditModal.jsx:41  <button>  p-2 text-white/50
src/components/chat/ProductEditModal.jsx:46  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProductEditModal.jsx:50  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProductEditModal.jsx:54  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProductEditModal.jsx:58  <input>  w-full bg-transparent text-[15px] text-white outline-none
src/components/chat/ProfileEditor.jsx:83  <input>  
src/components/chat/ProfileEditor.jsx:90  <input>  
src/components/chat/ProfileEditor.jsx:97  <textarea>  resize-none
src/components/chat/ProfileEditor.jsx:104  <input>  
src/components/chat/SearchView.jsx:25  <input>  w-full bg-transparent text-[15px] text-white placeholder-white/40 outline-none
src/components/chat/VendorStorefront.jsx:76  <button>  p-2 text-white/45 hover:text-white
src/components/chat/VendorStorefront.jsx:92  <button>  rounded-2xl bg-blue-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-blue-500
src/components/ui/PrivateMedia.jsx:40  <audio>  
src/components/ui/PrivateMedia.jsx:52  <audio>  
src/components/ui/ScreenHeader.jsx:8  <button>  p-2 text-white
src/features/chat/ChatHome.jsx:44  <button>  p-2 text-white/50 hover:text-white
src/features/chat/ChatHome.jsx:45  <button>  p-2 text-white/50 hover:text-white
src/features/chat/ChatHome.jsx:46  <button>  p-2 text-white/50 hover:text-white
src/features/chat/ChatHome.jsx:47  <button>  p-2 text-white/50 hover:text-white
src/features/chat/ChatHome.jsx:48  <button>  p-2 text-white/50 hover:text-white
```

**Reduced motion.** `index.css:184-190` cuts CSS animations and transitions under `prefers-reduced-motion`. framer-motion animates in JavaScript, which that rule does not reach. It is used in `AuthenticatedApp.jsx`, `MessageBubble.jsx`, `TutorialModal.jsx`, `FloatingMenu.jsx`, `GroupInfoSidebar.jsx` and `ChatHome.jsx`, and no file uses `useReducedMotion` or `MotionConfig`.

**Safe areas.** The utilities exist (`pt-safe`, `pb-safe`, `top-safe`; `index.css:126-129`). These ignore the insets:
- **bottom inset:** the bottom tab bar (`AuthenticatedApp.jsx:79`, `fixed bottom-4`) and the floating action menu (`FloatingMenu.jsx:29`, `59`);
- **top inset:** the sticky headers `ScreenHeader.jsx:6`, `ChatHeader.jsx:37` and `VendorStorefront.jsx:70`, while `index.html:14` sets `black-translucent`, so content runs under the status bar;
- **both:** the Wallet status banner (`Wallet.jsx:337`).
`pb-safe` appears in 9 files; `pt-safe` and `top-safe` in 1 each.


## 5. The same visual built with different classes

Elements grouped by visual role, using class-name tests in the script. Each line is one distinct class string for that role, with count and places.

Two observations:
- **Overlays** use seven z-index values: `z-40`, `[70]`, `[75]`, `[950]`, `[980]`, `[999]`, `[1000]`.
- **Panels and inputs** use at least two backgrounds for the same surface: `bg-[#0A0A0A]/60` and `bg-white/5`.

```
# panel: 73 different class strings for one visual
 30x  overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl
       src/Wallet.jsx:256, src/Wallet.jsx:282, src/Wallet.jsx:357, src/Wallet.jsx:380, src/Wallet.jsx:403, src/Wallet.jsx:425, +24
  3x  mx-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl
       src/Discover.jsx:108, src/Shop.jsx:141, src/Shop.jsx:146
  3x  mt-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] text-white outline-none placeholder:text-white/30 focus:border-blue-500
       src/components/chat/Connections.jsx:65, src/components/chat/Connections.jsx:78, src/components/chat/Connections.jsx:94
  3x  flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-5 py-3.5 font-bold text-white shadow-2xl active:bg-white/10
       src/components/chat/FloatingMenu.jsx:31, src/components/chat/FloatingMenu.jsx:39, src/components/chat/FloatingMenu.jsx:47
  2x  flex items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 shadow-2xl backdrop-blur-2xl
       src/Discover.jsx:88, src/Shop.jsx:122
  2x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors
       src/LockScreen.jsx:251, src/LockScreen.jsx:287
  2x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl pl-11 pr-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors
       src/LockScreen.jsx:255, src/LockScreen.jsx:282
  2x  relative w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-6
       src/components/ProfileModal.jsx:68, src/components/chat/MyProfileModal.jsx:38
  2x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl
       src/components/chat/BookmarksViewer.jsx:32, src/components/chat/SearchView.jsx:44
  2x  block rounded-2xl border border-white/10 bg-[#0A0A0A]/60 p-4 shadow-2xl backdrop-blur-2xl
       src/components/chat/Connections.jsx:62, src/components/chat/Connections.jsx:75
  2x  mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-3
       src/components/chat/DmView.jsx:42, src/components/chat/GroupView.jsx:345
  2x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4
       src/components/chat/VendorDashboard.jsx:35, src/components/chat/VendorDashboard.jsx:39
  2x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-8 text-center text-[13px] text-white/40
       src/components/chat/VendorStorefront.jsx:80, src/components/chat/VendorStorefront.jsx:82
  1x  grid grid-cols-2 rounded-2xl border border-white/15 bg-white/10 p-1 shadow-2xl backdrop-blur-2xl
       src/AuthenticatedApp.jsx:59
  1x  fixed bottom-4 left-4 right-4 z-20 mx-auto max-w-md rounded-3xl border border-white/10 bg-white/5 shadow-2xl backdrop-blur-xl
       src/AuthenticatedApp.jsx:77
  1x  mx-4 overflow-hidden rounded-3xl border border-white/15 bg-white/10 shadow-2xl backdrop-blur-2xl
       src/Discover.jsx:113
  1x  w-full flex flex-col gap-4 rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-6 shadow-2xl
       src/LockScreen.jsx:222
  1x  border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-xl p-3 text-center text-[13px] text-white font-mono
       src/LockScreen.jsx:228
  1x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl pl-24 pr-5 py-4 text-[16px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors
       src/LockScreen.jsx:268
  1x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-5 text-[15px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors resize-none
       src/LockScreen.jsx:276
  1x  flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 text-[15px] font-semibold text-blue-500 active:bg-white/10 disabled:opacity-50
       src/LockScreen.jsx:317
  1x  rounded-3xl border border-white/15 bg-white/10 p-2 shadow-2xl backdrop-blur-2xl
       src/Shop.jsx:153
  1x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none
       src/Wallet.jsx:306
  1x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none resize-none h-24
       src/Wallet.jsx:307
  1x  flex items-center gap-4 p-4 border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl
       src/Wallet.jsx:309
  1x  flex h-16 w-16 items-center justify-center rounded-xl border border-white/10 bg-white/5
       src/Wallet.jsx:310
  1x  flex-1 border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none
       src/Wallet.jsx:320
  1x  border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-4 text-sm focus:border-blue-500 outline-none
       src/Wallet.jsx:321
  1x  bg-white/5 border border-red-500/30 rounded-2xl w-full max-w-sm p-6 shadow-2xl
       src/Wallet.jsx:441
  1x  w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-6
       src/components/GlobalDialog.jsx:48
  1x  mt-4 w-full resize-y rounded-xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-blue-500
       src/components/GlobalDialog.jsx:58
  1x  mb-1 overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl text-left
       src/components/MessageBubble.jsx:55
  1x  mb-safe w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-3
       src/components/MessageBubble.jsx:279
  1x  w-full max-w-sm rounded-2xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-4
       src/components/MessageBubble.jsx:298
  1x  max-h-32 min-h-10 flex-1 resize-y rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-2.5 text-[15px] text-white outline-none placeholder:text-white/35 focus:border-blue-500/50
       src/components/MessageInput.jsx:43
  1x  max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-6
       src/components/OneTapCheckout.jsx:56
  1x  mb-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4
       src/components/OneTapCheckout.jsx:65
  1x  rounded-xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4 text-[13px] leading-relaxed text-white/55
       src/components/OneTapCheckout.jsx:71
  1x  mb-3 rounded-xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-3
       src/components/OneTapCheckout.jsx:75
  1x  mt-5 flex items-center gap-2 rounded-xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-3
       src/components/ProfileModal.jsx:86
  1x  relative bg-[#0A0A0A]/60 backdrop-blur-2xl border border-white/10 rounded-3xl w-full max-w-sm p-8 overflow-hidden shadow-2xl flex flex-col items-center text-center
       src/components/TutorialModal.jsx:47
  1x  overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4
       src/components/chat/AccountSwitcher.jsx:37
  1x  flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 backdrop-blur-md
       src/components/chat/AccountSwitcher.jsx:48
  1x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-10 text-center text-[13px] text-white/40
       src/components/chat/AccountSwitcher.jsx:58
  1x  w-full max-w-sm rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-5
       src/components/chat/BroadcastModal.jsx:32
  1x  flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 hover:bg-white/[0.07]
       src/components/chat/BroadcastModal.jsx:45
  1x  mx-4 mt-6 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-10 text-center text-[13px] text-white/40
       src/components/chat/ChatList.jsx:37
  1x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 p-4 shadow-2xl backdrop-blur-2xl
       src/components/chat/Connections.jsx:31
  1x  w-full rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-3 text-left text-[15px] font-semibold text-white shadow-2xl backdrop-blur-2xl active:scale-95
       src/components/chat/Connections.jsx:55
  1x  mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-1
       src/components/chat/CreateGroupModal.jsx:41
  1x  mt-2 w-full resize-none rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50
       src/components/chat/CreateGroupModal.jsx:51
  1x  m-auto mx-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-8 text-center text-[13px] text-white/40
       src/components/chat/DmView.jsx:30
  1x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4 text-[13px] text-white/50
       src/components/chat/GroupInfoSidebar.jsx:176
  1x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-3 shadow-2xl backdrop-blur-2xl
       src/components/chat/GroupView.jsx:56
  1x  m-auto mx-4 max-w-sm rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-8 text-center
       src/components/chat/GroupView.jsx:322
  1x  flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-white/5 p-4 text-[13px] text-amber-200
       src/components/chat/IdentityBackup.jsx:119
  1x  flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl py-3.5 font-bold text-white disabled:opacity-40
       src/components/chat/IdentityBackup.jsx:154
  1x  flex items-start gap-3 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-4 text-[13px] text-white/70
       src/components/chat/IdentityBackup.jsx:157
  1x  mb-1 overflow-hidden rounded-xl border border-white/10 bg-black/30
       src/components/chat/LinkPreview.jsx:60
  1x  mb-1 block overflow-hidden rounded-xl border border-white/10 bg-black/40 text-left
       src/components/chat/LinkPreview.jsx:71
  1x  m-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl
       src/components/chat/NotificationCenter.jsx:59
  1x  w-full max-w-sm space-y-4 rounded-3xl border border-white/10 bg-[#0A0A0A]/60 backdrop-blur-2xl p-5
       src/components/chat/ProductEditModal.jsx:38
  1x  w-full max-w-xs rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-10 text-center shadow-2xl backdrop-blur-2xl
       src/components/chat/QRScanner.jsx:123
  1x  relative aspect-square w-full max-w-xs overflow-hidden rounded-3xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl
       src/components/chat/QRScanner.jsx:130
  1x  w-full max-w-sm rounded-2xl border border-white/10 bg-[#0A0A0A]/60 p-4 shadow-2xl backdrop-blur-2xl
       src/components/chat/QRScanner.jsx:138
  1x  break-all rounded-2xl border border-white/10 bg-white/5 p-3 font-mono text-[13px] text-white/80
       src/components/chat/QRScanner.jsx:140
  1x  flex items-center gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-3 shadow-2xl backdrop-blur-2xl
       src/components/chat/SearchView.jsx:23
  1x  rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-8 text-center text-[13px] text-red-400
       src/components/chat/VendorStorefront.jsx:81
  1x  flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-black text-white/40
       src/components/chat/VendorStorefront.jsx:86
  1x  w-full rounded-2xl border border-white/10 bg-white/5 p-4 text-[15px] text-white backdrop-blur-md transition-all placeholder-white/40 focus:border-blue-500 focus:bg-white/10 focus:outline-none
       src/components/ui/Input.jsx:3
  1x  flex gap-1 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 p-1 shadow-2xl backdrop-blur-2xl
       src/features/chat/ChatHome.jsx:43
  1x  bg-surface p-4 rounded-2xl border border-white/5 flex items-center gap-4
       src/features/chat/ChatLoading.jsx:13
  1x  fixed top-safe left-1/2 z-[200] flex -translate-x-1/2 animate-slide-up items-center gap-3 rounded-2xl border border-white/10 bg-surfaceLight px-5 py-3 shadow-2xl
       src/features/chat/ToastBanner.jsx:7

# primaryButton: 28 different class strings for one visual
  2x  absolute top-1 right-3 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white
       src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93
  2x  w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500
       src/Wallet.jsx:261, src/components/chat/ProductEditModal.jsx:62
  2x  flex min-h-11 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold bg-blue-600 text-white active:bg-blue-700 text-white/50 active:bg-white/10
       src/components/chat/CreateGroupModal.jsx:42, src/components/chat/CreateGroupModal.jsx:43
  2x  flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500 disabled:opacity-40
       src/components/chat/IdentityBackup.jsx:151, src/components/chat/IdentityBackup.jsx:161
  2x  flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500
       src/components/chat/VendorDashboard.jsx:52, src/components/chat/VendorStorefront.jsx:79
  1x  rounded-xl py-2.5 text-[13px] font-bold shop bg-blue-600 text-white shadow-lg text-white/60
       src/AuthenticatedApp.jsx:60
  1x  rounded-xl py-2.5 text-[13px] font-bold groups bg-blue-600 text-white shadow-lg text-white/60
       src/AuthenticatedApp.jsx:61
  1x  rounded-2xl bg-blue-600 px-3 py-1.5 text-[13px] font-bold text-white
       src/Discover.jsx:133
  1x  mt-3 w-full rounded-2xl bg-blue-600 py-2.5 text-[13px] font-bold text-white shadow-lg
       src/Shop.jsx:166
  1x  w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white disabled:opacity-40
       src/Wallet.jsx:291
  1x  w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm mt-4 flex justify-center items-center gap-2 hover:bg-blue-500 transition-colors
       src/Wallet.jsx:326
  1x  fixed top-20 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-lg z-50 animate-bounce
       src/Wallet.jsx:337
  1x  flex-1 rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50 danger bg-red-600 hover:bg-red-500 bg-blue-600 hover:bg-blue-500
       src/components/GlobalDialog.jsx:70
  1x  mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500 disabled:opacity-60
       src/components/OneTapCheckout.jsx:89
  1x  w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors
       src/components/TutorialModal.jsx:70
  1x  rounded-2xl bg-blue-600 px-4 font-bold text-white active:bg-blue-700
       src/components/chat/AccountSwitcher.jsx:52
  1x  mt-5 w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50
       src/components/chat/BroadcastModal.jsx:57
  1x  flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white
       src/components/chat/ChatList.jsx:74
  1x  ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white
       src/components/chat/ChatList.jsx:105
  1x  shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tor bg-blue-600 text-white blocked bg-rose-500/20 text-rose-200 bg-white/10 text-white/70
       src/components/chat/Connections.jsx:44
  1x  w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white
       src/components/chat/GroupView.jsx:68
  1x  w-full bg-blue-600 py-3.5 font-bold text-white
       src/components/chat/GroupView.jsx:82
  1x  flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white
       src/components/chat/NotificationCenter.jsx:76
  1x  rounded-2xl border px-3 py-2 text-[13px] font-bold active:scale-95 border-blue-500 bg-blue-600 text-white border-white/10 bg-white/5 text-white/55 backdrop-blur-md
       src/components/chat/PrivacySettings.jsx:20
  1x  w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500 active:scale-95 disabled:opacity-50
       src/components/chat/ProfileEditor.jsx:109
  1x  mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 text-[15px] font-bold text-white
       src/components/chat/QRScanner.jsx:141
  1x  ml-3 shrink-0 rounded-2xl bg-blue-600 px-3 py-1.5 text-[13px] font-bold text-white
       src/components/chat/SearchView.jsx:79
  1x  rounded-2xl bg-blue-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-blue-500
       src/components/chat/VendorStorefront.jsx:92

# dangerButton: 7 different class strings for one visual
  1x  block text-[15px] font-semibold text-red-400
       src/Wallet.jsx:433
  1x  text-xl font-bold text-red-500 mb-2
       src/Wallet.jsx:442
  1x  flex-1 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold transition-colors
       src/Wallet.jsx:446
  1x  flex-1 rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50 danger bg-red-600 hover:bg-red-500 bg-blue-600 hover:bg-blue-500
       src/components/GlobalDialog.jsx:70
  1x  flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-[12px] font-semibold active:bg-white/10 delete text-red-400 text-white
       src/components/MessageBubble.jsx:287
  1x  flex w-full items-center gap-3 p-4 text-left text-[15px] font-semibold text-red-400 disabled:opacity-40 active:bg-white/5
       src/components/chat/GroupInfoSidebar.jsx:180
  1x  text-[13px] font-semibold text-red-400 disabled:opacity-50
       src/components/chat/GroupInfoSidebar.jsx:197

# input: 15 different class strings for one visual
  4x  w-full bg-transparent text-[15px] text-white outline-none
       src/components/chat/ProductEditModal.jsx:46, src/components/chat/ProductEditModal.jsx:50, src/components/chat/ProductEditModal.jsx:54, src/components/chat/ProductEditModal.jsx:58
  3x  w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30
       src/Wallet.jsx:283, src/Wallet.jsx:284, src/Wallet.jsx:285
  3x  mt-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] text-white outline-none placeholder:text-white/30 focus:border-blue-500
       src/components/chat/Connections.jsx:65, src/components/chat/Connections.jsx:78, src/components/chat/Connections.jsx:94
  3x  w-full border-b border-white/5 bg-transparent px-4 py-3 text-[15px] text-white outline-none placeholder:text-white/30
       src/components/chat/GroupView.jsx:79, src/components/chat/GroupView.jsx:80, src/components/chat/GroupView.jsx:81
  1x  w-full border-b border-white/5 bg-transparent px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30
       src/Wallet.jsx:257
  1x  w-full bg-transparent px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30
       src/Wallet.jsx:258
  1x  w-full bg-white/5 px-4 py-4 text-[15px] text-white outline-none
       src/Wallet.jsx:286
  1x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none
       src/Wallet.jsx:306
  1x  w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none resize-none h-24
       src/Wallet.jsx:307
  1x  flex-1 border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none
       src/Wallet.jsx:320
  1x  border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-4 text-sm focus:border-blue-500 outline-none
       src/Wallet.jsx:321
  1x  mt-4 w-full resize-y rounded-xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl p-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-blue-500
       src/components/GlobalDialog.jsx:58
  1x  max-h-32 min-h-10 flex-1 resize-y rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-2.5 text-[15px] text-white outline-none placeholder:text-white/35 focus:border-blue-500/50
       src/components/MessageInput.jsx:43
  1x  min-w-0 flex-1 bg-transparent py-3 text-[15px] text-white outline-none placeholder:text-white/30
       src/components/chat/AccountSwitcher.jsx:50
  1x  w-full bg-transparent text-[15px] text-white placeholder-white/40 outline-none
       src/components/chat/SearchView.jsx:25

# listRow: 10 different class strings for one visual
  8x  flex w-full items-center gap-3 border-b border-white/5 p-4 text-left
       src/Wallet.jsx:358, src/Wallet.jsx:363, src/Wallet.jsx:368, src/Wallet.jsx:389, src/Wallet.jsx:404, src/Wallet.jsx:409, +2
  5x  flex w-full items-center gap-3 p-4 text-left
       src/Wallet.jsx:373, src/Wallet.jsx:382, src/Wallet.jsx:394, src/Wallet.jsx:419, src/Wallet.jsx:431
  4x  flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5
       src/components/chat/MessageRequests.jsx:30, src/components/chat/MyOrders.jsx:34, src/components/chat/NotificationCenter.jsx:68, src/components/chat/PrivacySettings.jsx:39
  2x  flex w-full items-center justify-between border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5 disabled:opacity-50
       src/Discover.jsx:117, src/components/chat/SearchView.jsx:51
  1x  flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 text-[15px] font-semibold text-blue-500 active:bg-white/10 disabled:opacity-50
       src/LockScreen.jsx:317
  1x  flex w-full items-center gap-3 border-b border-white/5 p-4 text-left text-[15px] font-semibold text-white active:bg-white/5
       src/components/chat/GroupInfoSidebar.jsx:178
  1x  flex w-full items-center gap-3 border-b border-white/5 p-4 text-left text-[15px] font-semibold text-white disabled:opacity-40 active:bg-white/5
       src/components/chat/GroupInfoSidebar.jsx:179
  1x  flex w-full items-center gap-3 p-4 text-left text-[15px] font-semibold text-red-400 disabled:opacity-40 active:bg-white/5
       src/components/chat/GroupInfoSidebar.jsx:180
  1x  flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5 bg-amber-300/[0.07]
       src/components/chat/GroupView.jsx:31
  1x  flex w-full items-center gap-3 p-4 text-left text-[15px] font-semibold text-white disabled:opacity-40
       src/components/chat/IdentityBackup.jsx:127

# badge: 7 different class strings for one visual
  2x  absolute top-1 right-3 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white
       src/AuthenticatedApp.jsx:84, src/AuthenticatedApp.jsx:93
  1x  shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold
       src/components/MessageBubble.jsx:60
  1x  mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#161616] text-[11px] font-semibold
       src/components/MessageBubble.jsx:185
  1x  flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white
       src/components/chat/ChatList.jsx:74
  1x  ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white
       src/components/chat/ChatList.jsx:105
  1x  shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tor bg-blue-600 text-white blocked bg-rose-500/20 text-rose-200 bg-white/10 text-white/70
       src/components/chat/Connections.jsx:44
  1x  flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white
       src/components/chat/NotificationCenter.jsx:76

# overlay: 13 different class strings for one visual
  2x  fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm
       src/components/GlobalDialog.jsx:47, src/components/ProfileModal.jsx:67
  1x  fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in
       src/Wallet.jsx:440
  1x  fixed inset-0 z-[75] flex items-end justify-center bg-black/70 p-3
       src/components/MessageBubble.jsx:278
  1x  fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-4
       src/components/MessageBubble.jsx:297
  1x  fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm
       src/components/OneTapCheckout.jsx:55
  1x  fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-md p-6
       src/components/TutorialModal.jsx:43
  1x  fixed inset-0 z-[950] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm
       src/components/chat/BroadcastModal.jsx:31
  1x  fixed inset-0 z-[999] flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4
       src/components/chat/CreateGroupModal.jsx:30
  1x  fixed inset-0 z-40 bg-black/60 backdrop-blur-sm
       src/components/chat/FloatingMenu.jsx:19
  1x  fixed inset-0 z-[980] flex justify-end bg-black/50 backdrop-blur-sm
       src/components/chat/GroupInfoSidebar.jsx:147
  1x  fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md
       src/components/chat/MyProfileModal.jsx:35
  1x  fixed inset-0 z-[90] flex items-end justify-center bg-black/60 p-3 backdrop-blur-md
       src/components/chat/ProductEditModal.jsx:37
  1x  fixed inset-0 z-[900] flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4
       src/components/chat/VendorStorefront.jsx:68
```


## 6. Proposed token set, for approval before the sweep

One of each, and everything else composes them. Values are taken from what the app already uses most, so the sweep changes as little as possible.

**Foundations.** These become CSS variables in `index.css` and Tailwind theme entries, and replace every hardcoded hex and `[#…]`.

| Token | Value | Replaces |
|---|---|---|
| `bg` | `#000000` | `bg-black`, `#000` |
| `surface` | `rgb(10 10 10 / 0.6)` + `backdrop-blur-2xl` | `bg-[#0A0A0A]/60` (96), `bg-white/5` panels (37) |
| `surface-raised` | `rgb(255 255 255 / 0.10)` | `bg-white/10` |
| `line` | `rgb(255 255 255 / 0.10)` | `border-white/10` (131), `/15`, `/20` |
| `line-subtle` | `rgb(255 255 255 / 0.05)` | `border-white/5` (49) |
| `text` | `#ffffff` | `text-white` (172) |
| `text-muted` | `rgb(255 255 255 / 0.55)` | `text-white/40` to `/60` (about 180 uses across six steps) |
| `text-faint` | `rgb(255 255 255 / 0.35)` | `text-white/30`, `/35`, `text-gray-500` |
| `accent` | `#2563eb` (blue-600) | `bg-blue-600`, `bg-blue-500`, `text-blue-500` |
| `danger` | `#f87171` text, `#dc2626` fill | `text-red-400`, `text-rose-300`, `bg-red-600` |
| `warning` | `#fcd34d` | `text-amber-300`, `text-amber-200` |
| `success` | `#34d399` | `text-emerald-400` |

**Type scale, 5 steps:** `caption` 11px (`[10px]`, `[11px]`), `meta` 13px (`[12px]`, `[13px]`, `text-xs`, `text-sm`), `body` 15px (`[15px]`, `[16px]`, `[14.5px]`), `title` 24px (`text-2xl`), `display` 28px (`text-[22px]`, `text-4xl`). That replaces 14 sizes.

**Radius, 3 steps:** `control` `rounded-2xl`, `sheet` `rounded-3xl`, `pill` `rounded-full`. That replaces 9.

**Spacing:** the 4px grid Tailwind already has. No arbitrary spacing. `mt-[5px]` (`MessageBubble.jsx:123`) is the one in use.

**Layers, 6 steps:** `nav` 20, `header` 30, `sheet` 40, `dialog` 50, `toast` 60, `call` 70. That replaces 7 ad hoc values.

**Breakpoint:** one, `lg` (1024px), for the desktop two-pane layout, defined in `tailwind.config.cjs` only.

**Motion:** one `MotionConfig reducedMotion="user"` at the root, so framer-motion follows the system setting.

**Components.** Each is one exported component, or one class constant where a component would be overkill.

| Token | Composition |
|---|---|
| `Panel` | `surface`, `line` border, `control` radius, `overflow-hidden`; padding 16px when it holds content directly |
| `Button.primary` | `accent` fill, white text, `control` radius, 15px semibold, `min-h-11`, focus-visible ring |
| `Button.secondary` | `surface-raised`, `line` border, otherwise as primary |
| `Button.danger` | `danger` fill, otherwise as primary |
| `Button.ghost` | no fill, `text-muted`, hover `text`, `min-h-11 min-w-11`; icon-only requires `aria-label` |
| `Input` | `surface-raised`, `line` border, `control` radius, `body` size, `min-h-11`, `focus-visible` border `accent` plus ring (inputs get their own cue, since the global outline is off for them) |
| `Header` | sticky, `surface`, `line-subtle` bottom border, top inset padding, `title` text, ghost back button |
| `Dialog` | overlay `bg/80`, layer `dialog`; panel `sheet` radius, bottom-sheet under `lg`, bottom inset padding, `role="dialog" aria-modal` |
| `Toast` | layer `toast`, top inset offset, `surface`, one line, `role="status"`, or `alert` for errors |
| `ListRow` | full width, `min-h-11`, 16px padding, `line-subtle` divider, leading icon or avatar, trailing value or chevron |
| `Badge` | `pill`, `caption`, `accent` fill or `surface-raised`, minimum width 16px |
| `Avatar` | `pill`, sizes 28 / 48 / 64, initial fallback on `surface` |

Approval is needed on the foundations table (especially merging the six muted text steps into one `text-muted` and two `text-faint` steps), the five-step type scale, and the single `lg` breakpoint. After approval: Phase D adds these tokens and primitives, and Phase E sweeps.

