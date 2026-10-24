# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Commerce and native notifications

- Vendors can broadcast a product card to joined groups and group admins can feature one group product as the pinned listing.
- Optional account-level Bitcoin xpub and Monero private view key settings are encrypted locally using a key derived from the unlocked Cipher identity. Bitcoin receiving addresses use the BIP-84 external chain. Monero subaddresses are derived locally with `monero-ts`; the spend key and seed phrase are not requested. The Monero WASM remains a large (~2.7 MB minified) lazy chunk required by `monero-ts`, but does not load for Bitcoin-only orders.
- Buyers can select Bitcoin, Monero, or both in Advanced Settings. Accepted orders derive only the selected currencies; the Monero runtime is dynamically loaded only for XMR orders. Existing primary addresses remain the fallback when address derivation is not configured.
- Capacitor Local Notifications are scheduled for incoming messages and orders received while the app is connected and running. This project does not include an APNs/FCM push provider or server-side relay watcher, so notifications cannot be delivered after the operating system suspends or terminates the app.
- The Nostr outbox persists rejected events, displays delivery state, retries with capped exponential backoff, and flushes on network/relay reconnection. A service worker caches the app shell and same-origin build assets for offline reopening; relay delivery still requires a connection.
- Content-Security-Policy allows HTTPS images (`img-src` includes `https:`), so remote profile pictures and Blossom images can render. Remote audio and video stay blocked: `media-src` is `'self' blob:` only. `connect-src` still allows `https:` plus the listed Nostr relays.
- `Strict-Transport-Security` is `max-age=63072000; includeSubDomains; preload`. The production host already sends that policy; `vercel.json` now declares it as well.
- The native app and these docs use one host: `https://sonic-cobalt-4m6q5vj.vercel.app` (`capacitor.config.json` `server.url`). That is this Vercel project's hostname. It returned HTTP 200 and its CSP matches `vercel.json`. `cipher-beta-eight.vercel.app` is a different deploy (no CSP) and is not used. There is no custom domain.
- Five wrong PINs delete that account's on-device vault, including the encrypted recovery phrase stored on the device. Other accounts are not counted or deleted. The counter is stored per account and resets after a successful PIN unlock, biometric unlock, restore-by-handle, or restore-by-mnemonic. The lock screen says this before it happens, and the PIN error repeats it when two or fewer attempts remain. Only the 12 words that were written down can restore a wiped account. The minimum PIN is 6 digits.
- `android/` is gitignored, so the native Android project is not in version control. `capacitor.config.json` is what records the packaged web host.
- `.idea/` is tracked. Those are IDE files and are not required to build or run the app.
- `.env.local` is intentionally tracked and contains a `VERCEL_OIDC_TOKEN`. That token is short-lived and stale on clone. Do not treat it as a usable credential.
