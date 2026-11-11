# Phone test, after every deploy
Close every tab and reopen first - the service worker caches.

1. Tab bar: tap the centre, then 4px from its bottom edge. Both switch tabs.
2. Floating +: opens.
3. Chats list: scroll to the last row. The bar must not cover it.
4. Send a photo, send a voice note. Both arrive and play.
5. Shake to wipe: turn it on, then shake.

## Test-profile DM lane, local relay hand test
Needs Node 18 or newer and `npm install` already run.

1. Start the local relay: `npm run relay:local`. It prints the loopback URL on the line starting `on`; keep the terminal open.
2. Start the app dev server: `npm run dev` (opens on http://localhost:8080).
3. In each browser profile/account: Wallet main screen > Privacy > find "Test-profile DM lane", turn it ON. The change applies when the chat session restarts: switch account away and back, or reload the tab.
4. Paste the relay URL from step 1 into BOTH accounts' Connections screen in the row labeled "Test DM relay" if present, otherwise paste into the advanced panel per the current Connections layout; save.
5. From one account open the other's chat and send a text message. Expected: bubble appears in both chats exactly like ordinary messages.
6. To see fail-closed behavior: stop the relay process and send again while it is down. Expected: a held/unconfirmed state or a visible error toast naming the reason - never a silent fallback to the old path.

These claims are LOCAL-TEST tier only, on a disposable loopback relay. No interop, anonymity, or parity claim. The test-profile wire is under independent review.
