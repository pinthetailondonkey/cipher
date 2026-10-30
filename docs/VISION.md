# Cipher — Vision and Agent Brief

## 0. How to use this file
- Part 1 is the pitch. Read it for intent, not requirements.
- Part 2 is what Cipher is, plainly.
- Part 3 is hard invariants. Never break these. If a task seems to require breaking one, stop and say so.
- Part 4 is what exists today vs what does not. Treat "not built" as new work, never as a bug.
- Part 5 is out of scope for now. Do not build it unless the task says so.

## 1. The pitch (intent, not spec)
Cipher is an encrypted messenger and direct-deal shop for people who cannot afford to be shut down. No phone number, no central account, no platform fees. It replaces a centralised chat app plus a marketplace with one app on an open protocol.

## 2. What Cipher is, plainly
- A messenger. Encrypted end to end. Identity is a handle and a PIN; the user never handles a key.
- A shop. Buyers pay vendors directly in BTC or Monero. Cipher never touches the money.
- Groups are storefronts. A group has a chat and a catalogue.
- Trust is social, not escrowed. Group owners vouch for vendors; reputation travels with the vendor.

## 3. Hard invariants (must always hold)
1. No phone number and no email required.
2. DMs are always NIP-44 encrypted.
3. Group messages use rotating AES-GCM keys. Removing a member rotates the key so they cannot read later messages.
4. Every order generates a fresh payment address. No address reuse.
5. Photos have EXIF/GPS stripped before sending.
6. Cipher never holds funds. Zero custody.
7. No central server required: the app works against more than one relay.
8. The UI never shows the words "Nostr", "relay", or "private key".

## 4. Reality check (verify and correct this section against the repo)
- Built:
- Not built:
Do not assume. If unsure, check the code, then update this section in the same commit.

## 5. Out of scope for now
- Pin-slot auctions and paid "verified" badges
- Global web-of-trust scoring
- Native mobile apps (this is a web app)

## 6. Words used
- "custies" = buyers
- "trap house" = a group's storefront
- "WoT" = web of trust, a reputation system
- "relay" = an open server that stores and forwards messages
