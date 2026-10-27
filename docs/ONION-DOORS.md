# Onion doors — the runbook

The card said yes: open two doors for the app through onion itself.

## What this buys you

- **Burn-note links.** Today a person opening a burn-note link in a plain browser tells one clearnet host "I am here, opening a note". With the door on onion, the note's page is reached through Tor and the host never learns their address.
- **The site mirror.** Anyone opening the website through the onion door leaves no address with the clearnet host.

Rough shape per the card: one small box, both doors on it, zero new programs to write, an evening of setup. The tor machinery already ships inside the app's own desktop shell (scripts/self-host.mjs prints its own two torrc lines for the mirror door).

## What stays fully yours, outside this chat

Which box you rent, what it costs, and how you pay for it. None of that belongs here — the chat never hears the provider, the price, or the payment. Same for the onion names once they exist: they go where you keep that kind of thing. This lane needs none of it; it only needs the words "the doors are up".

## The steps

1. Rent a small Linux box and reach it over ssh. Any provider you'd have chosen anyway.
2. Install the tor package the way the system normally gets packages (`apt install tor` on a Debian-family box).
3. Two blocks in `/etc/tor/torrc` — that is the whole arrangement:

        HiddenServiceDir /var/lib/tor/cipher-note/
        HiddenServicePort 80 127.0.0.1:8080

        HiddenServiceDir /var/lib/tor/cipher-mirror/
        HiddenServicePort 80 127.0.0.1:8081

4. Serve the two folders the doors look at:
   - Port 8080: the burn-note page's folder — whatever folder the note host serves today is the same files.
   - Port 8081: the built app site. On the box itself, `node scripts/self-host.mjs` builds the site and serves it on 127.0.0.1:8080 — set `PORT=8081` for that one and run the note page on plain 8080.
5. Reload tor. Each door now has an address waiting in its folder's `hostname` file:
   `/var/lib/tor/cipher-note/hostname` and `/var/lib/tor/cipher-mirror/hostname`.
   Those files are the only place you need to copy the onion names from.
6. Test both with your own Tor client: the note page and the site come up through the onion. Done.

## After the doors are up

- The two names go into the app's Connections rows that this lane adds: the wall rows for the burn-note link and for the site mirror start unset, and the addresses belong on-device, pasted by you — never shipped in a chat line, and no build gate needs them until they are onion rows (onion rows carry no gate; the founder gate only exists to protect clearnet).
- A note posting the clearnet burn-note link keeps working until you say otherwise; the doors sit beside the clearnet rows. Retiring the clearnet rows is a later, separate decision.
- If the box ever moves, both blocks move with it; the addresses die with the box, and new ones take their place the same way.
