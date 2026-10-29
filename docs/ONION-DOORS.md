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

- The two names go into the app's Connections rows that this lane adds: the wall rows for the burn-note link and for the site mirror start unset, and the addresses belong on-device, pasted by you — never shipped in a chat line. A paste is the shape that works the same afternoon: a row's own paste outranks everything under it, so an address pasted after the doors come up is in use with no build at all.
- A door baked into a desktop build is the second shape, and it is deliberately harder — see the next section. (An earlier version of this runbook said onion rows carry no gate. That was wrong, and it is the rule that let a build ship without an address and say nothing.)
- A note posting the clearnet burn-note link keeps working until you say otherwise; the doors sit beside the clearnet rows. Retiring the clearnet rows is a later, separate decision.
- If the box ever moves, both blocks move with it; the addresses die with the box, and new ones take their place the same way.

## How a door reaches the app (one mechanism)

Every outbound host is one row in `src/lib/egress.js`, and a row resolves to
an address by one rank order:

    off  >  the person's own paste  >  the founder's door  >  the shipped default

`off` drops the host entirely. A paste wins over everything below it. The
founder's door wins over the shipped default, and only exists in a build that
was given it. Otherwise the row uses the address it ships with.

There are two shapes of door, and which one a row may have is decided by
whether its address is public or hidden:

- **A public address goes in the repo.** It is the row's shipped default, and
  the row must carry `gate: 'founder'` or the build fails before it runs. The
  founder names the host; a build cannot add one, and a row cannot quietly
  point at a new company.
- **A hidden address never goes in the repo.** It comes from the untracked
  build file (`.grok/app-env.json`) and enters the bundle only when the build
  is the desktop app. A web build therefore cannot carry an onion at all — not
  because nobody typed one, but because the code will not read one unless the
  desktop marker is set.

Both shapes are the same law from two sides: a build that would send traffic
somewhere it should not goes red instead of shipping. The desktop build
refuses to finish when its door is missing or is not an onion address; the
same refusal covers the media rows the day they ship the founder's host.

One door serves every row of its kind. The media trio (three rows, three
outside hosts today) resolves to the one media door when it is lit, and the
search pair resolves to one search door, so a host is named once and every
row that uses it moves together.

Doors today:

| Door | Build value | State |
| --- | --- | --- |
| Group relay | `VITE_GROUP_ONION` | required — the desktop build will not finish without it |
| Media (three rows) | `VITE_MEDIA_ONION` | checked, and dark until a media row ships the founder's host |
| Message relay, search pair, burn note | — | a slot that ships dark; no address yet |

A desktop bundle carries the onion in the clear, because anything that dials
an onion must. That is the shape already accepted for the group relay.

**Evidence, once an onion rides in a build:** a commit sha alone no longer
determines a desktop bundle, because the address came from an untracked file.
A build record must name the sha and the env it was built with, so two
bundles from one sha can never be confused for each other.

## Offering the mirror to Tor Browser (Onion-Location)

Once the mirror door is up, the clearnet site can tell Tor Browser the onion
exists. Tor Browser then shows a ".onion available" button, and the person
chooses to use it. It is an offer, never a redirect: a plain browser never
sees an error, and nothing is sent to the box.

The offer is one header line, and the line carries the real onion name, so
it is pasted by hand — the same way the names go into Connections, never
through a chat line or a build machine:

1. Open `vercel.json`. In the `headers` block whose `source` is `/(.*)`,
   add one entry:

        {
          "key": "Onion-Location",
          "value": "http://<the-mirror-name>.onion/"
        }

2. Deploy, then prove the deploy the usual way (`npm run verify:live`).
3. Open the site in Tor Browser and check the ".onion available" button
   appears and reaches the mirror.

The header was deliberately not added early with a blank value: an untested
value in the deploy config is exactly the kind of line that once silently
pointed the whole site at a stale build. The line goes in when there is a
real name to put in it, and it goes in by hand.

## Hardening the box (decided 2026-10-28)

The doors are only as private as the box they run on. Do these the same day
the box is rented, before either door takes a visitor. All of it is by hand
on the box; none of it touches the repo.

1. **Keys only, no passwords.** In `/etc/ssh/sshd_config`:
   `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
   `PermitRootLogin prohibit-password`. Password guessing then has nothing
   to guess at.
2. **No public SSH port where possible.** If the provider offers a private
   network or a web console, close port 22 in the provider's firewall
   entirely and reach the box that way. If SSH must stay open, the
   keys-only rule above is what stands between the box and the internet's
   guessing.
3. **Security updates install themselves.** `apt install unattended-upgrades`
   and confirm `/etc/apt/apt.conf.d/20auto-upgrades` says
   `Unattended-Upgrade "1"`. The box has no person watching it.
4. **Nothing else listens.** After setup, check `ss -tulp`: the only
   public-facing things should be tor itself; the note page and the mirror
   stay bound to 127.0.0.1 as the runbook already arranges.
5. **What a tampered bundle looks like versus a stale one.** A stale build
   is caught by `npm run verify:live` — a different bundle name on the page
   than a build of the checkout produces. A tampered one, served by whoever
   controls the deploy account under a copied name, is not caught by that
   check. What holds that door is the account's own protection: 2FA on the
   deploy login, and no deploy keys on machines you do not control. If a
   stronger check is ever wanted, pinning the expected bundle digest
   somewhere the deploy pipeline cannot write is the shape — no new
   dependency needed, but it is not built yet.
