# No IP leaks

An IP address is what the internet sees as you — a return address on every letter you send. The rule for this app: **nobody's IP ever leaks.** Not yours, not the person on the other side of a message or a deal, not a bystander reading your menu.

This page is the law. The tests hold it up where words alone would bend. Deliverable of the 2026-10-27 audit (both apps, Code @ b425b99, Deal @ 8b3bfeb).

## The rules

1. **Every host the app can reach sits on the egress wall** (`src/lib/egress.js`). Nowhere else. A test walks every source file and fails on an address set anywhere else.
2. **A clearnet row on the wall needs `gate: 'founder'`.** Clearnet means an ordinary website address — not onion, not Tor. The old rows are frozen by name and address (`GRANDFATHERED_CLEARNET` in `src/lib/egress.test.js`); any other clearnet row fails the build unless the row itself says `gate: 'founder'`, and the founder named that host first. Changing the address behind a frozen row name counts as a new row.
3. **No public block explorer is ever called.** Pasting one is refused. This stays true in every new path.
4. **No telemetry, no counters, no web fonts, no version checks.** The app loads its own files and asks nothing about itself.
5. **The plain-browser web build cannot promise Tor** — a browser tab cannot choose its own route. The installed desktop app promises it. Every claim about "the app" says which build it covers.
6. **The Deal app phones home to nobody.** A test walks its source and fails on any network call at all.
7. **If something must see an IP, say so in plain words** on the Connections screen before it happens — never after, never in jargon.

## What the audit proved already safe

- The egress wall and its test held: no address outside the list, in either app.
- Desktop: everything rides the bundled Tor. WebRTC (voice) is switched off in the engine; the microphone is refused unless `CIPHER_CALLS=1`. No update calls.
- Deal: zero network calls in shipped code.
- Link previews are off, and stay off unless the person turns them on.
- Media upload is ciphertext under a throwaway key.
- No public block explorer, ever.
- The dead-drop host is only visited by people CLICKING a note link. The app itself talks only to the relays.

## Leaks left open, worst first — founder decides, nothing ships without the card

1. **Voice calls in the plain-browser build.** A direct call shows each side the other side's real IP, and three outside call-peg companies (Google, Twilio, metered) see both. The installed app has this closed.
2. **Name lookups (name@site.com).** The browser visits site.com directly: your IP and the exact name you looked for, to whatever that site is.
3. **Pictures.** A picture can point at any website. Everyone who SEES the picture hands their IP to whichever site the picture came from. The viewer has no say; the poster does.
4. **The plain-browser build reaches the default relays over the open internet** with your IP attached. The installed app does not.
5. **Acceptable with disclosure (each shows a plain warning before use):**
   - Link previews (off unless turned on). Honest note: the preview company fetches the page ITSELF — the page never sees you. Only the preview company sees you.
   - Burn-note links: the host sees the IP of whoever opens the link. The note and its key never reach it.
   - The website itself, hosted on clearnet: the host sees visitor IPs. Anyone opening a site hands theirs over; that is their choice to see labeled, not a bug.

## The honesty correction (2026-10-27)

Earlier drafts said link previews tell the visited site that you clicked. **They do not** — the preview company fetches the page from its own machines. Name lookups DO visit the target directly. Two different shapes, opposite fixes. Recorded so the fix plan is not built on the wrong shape.

## Fix plan, ready on the founder's word (nothing above is shipped until then)

- Voice: calls off by default in the web build, warning in plain words naming exactly who sees the IP.
- Name lookups: a consent card showing the exact site before the first visit to it.
- Pictures: either a named proxy host (crosses the wall — founder gate) or refusing non-onion picture hosts in strict mode.
- Onion twins for the clearnet front ends so the same service has a Tor door.
- Done already: this page, the founder-gate test, the Deal zero-network test, a stale comment in `desktop/src/main.js` that pointed at a lock living elsewhere.
