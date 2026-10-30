# Deploying Cipher

The site answers on **https://www.ciphermessenger.org**. The bare name
`https://ciphermessenger.org` answers `308` and forwards to it. That is the
inverse of the common arrangement, and it is deliberate (founder,
2026-10-28): `www` is primary, and every other name follows it.

This page is the whole procedure, in the order it has to happen, and the
reason for each step.

## What went wrong once, so this page exists

On 2026-10-28 the live site was serving a build from 24 October. `main` was
909 commits past it. Nobody noticed, because everything looked fine:

- The host answered `200`.
- The page carried `<title>Cipher</title>`.
- The Vercel project the repo is linked to was building `main` on every
  push, green, the whole time.

The break was one line of `vercel.json`. This repo has two Vercel projects
built from it. The newer one, `cipher`, is the one `.vercel/repo.json` links
to and the one that deploys `main`. The older one,
`sonic-cobalt-4m6q5vj`, stopped deploying on 24 October and kept serving its
last build. The redirect rule in `vercel.json` sent `cipher`'s production
name to the older project. So every visitor was handed the older build, and
the newest build never reached a person.

Two lessons, both now enforced:

1. **A status code proves nothing.** The live page sent `200` for four days
   while serving the wrong build. The page's own bundle name is the only
   thing that ties a page to a commit, because Vite names its entry after
   the content. `npm run verify:live` runs that check and exits non-zero
   when it fails.
2. **A redirect is a deploy decision.** Pointing one host name at another
   project is as consequential as deploying, and it leaves no build log to
   catch it.

## The order

Diagnose, prove, then bind. Binding the brand address last is deliberate:
the site sends `Strict-Transport-Security` with `includeSubDomains` and
`preload`, so a name that resolves to a broken host is not cheap to
take back.

### 0. Before any of it, the domain must be in your own account

Confirm `ciphermessenger.org` is in your own registrar account, and that the
Cloudflare zone (nameservers `cesar.ns.cloudflare.com` and
`vera.ns.cloudflare.com`) is in your own Cloudflare login. WHOIS redacts the
owner, so nobody outside can establish this for you. If the domain is not in
your hands, stop: none of the rest applies.

Registered 2026-10-27 at Tucows, expires 2027-10-27.

The zone is moving from Cloudflare to the registrar's own DNS by decision
of 2026-10-28. Until the move is finished, the Cloudflare login still
matters; the move's order is at the bottom of this page.

### 1. Diagnose why the live site is stale

In the Vercel dashboard, open the project named `cipher`:

- **Deployments** — is the newest Production deployment green, and does it
  name the commit you expect on `main`? If it is green, the pipeline works
  and the fault is somewhere in what happens to visitors afterwards.
- **Settings → Git** — is the production branch `main`?
- **Settings → Domains** — which names point at this project?
- **Settings → Build & Development Settings** — does the build command match
  `npm run build`?

Then look at the other projects under the same account. A green project is
not proof that people are reaching it.

### 2. One green production deploy of `main`, and prove it

```
npx vercel link --project cipher        # once per checkout; writes .vercel/
npx vercel deploy --prod                # or let the Git integration do it
```

Then prove it by the page:

```
npm run verify:live
```

It builds the tree, reads the bundle name it produced, fetches the page,
and compares. The output names both. It exits `0` only when they match. A
`200` and the right title are not enough, and the script says so.

### 3. Land the code that names the address

Three files move together, as one change. Any one alone leaves something
lying:

- `src/lib/egress.js` — the App host row names
  `https://www.ciphermessenger.org` and carries `gate: 'founder'`.
- `src/lib/egress.test.js` — the old address comes out of
  `GRANDFATHERED_CLEARNET`. That map freezes an id **and** its address, so
  leaving the entry in makes the next honest change fail the gate.
- `vercel.json` — both old Vercel names redirect to
  `https://ciphermessenger.org`, which then forwards to `www`. Neither
  canonical name carries a rule in this file: the apex redirect belongs to
  the domain entry in the dashboard, and a rule there would loop.

Since the address is now a clearnet row the founder named, the gate is
satisfied by `gate: 'founder'` rather than by the grandfather list.

### 4. Bind the name (dashboard, by hand)

Vercel → project `cipher` → **Settings → Domains**:

1. Add `www.ciphermessenger.org` and make it the primary name.
2. Add `ciphermessenger.org` and set it to **redirect to**
   `www.ciphermessenger.org`. Do not flip this the other way for
   tidiness: the founder ruled `www` primary, and the README, the egress row
   and the default address of `verify:live` all follow it.
3. Vercel prints the exact record it wants. Copy that string; do not use a
   remembered IP.

Cloudflare → DNS:

4. Add the record Vercel printed for the apex.
5. Add `www` as the CNAME Vercel printed.
6. **Proxy status: DNS only — the grey cloud.** The orange cloud answers
   the certificate challenge itself, so Vercel never proves it controls the
   name and the domain stays invalid. It also terminates sockets at
   Cloudflare instead of at the app, which is the wrong place for this site.
7. Wait for Vercel to say **Valid Configuration** and show a certificate.
   That usually takes minutes.

### 5. Redeploy after step 3

The name alone changes nothing: it resolves to whichever deployment is
current, and if step 3 has not been deployed, the app-host row still names
the old host. Deploy `main` once more, then prove it twice: once on the canonical name,
and once on the bare name, which must print its `308` before the bundle
matches.

```
npm run verify:live
npm run verify:live -- https://ciphermessenger.org
```

## What to check when a deploy looks fine but is not

| Symptom | What it usually is |
|---|---|
| Page loads, wrong build | another project is answering, or a redirect sends you to one |
| Domain invalid in Vercel | Cloudflare proxy is orange, or the record is not the one Vercel printed |
| Certificate fine, site stale | the domain is bound to an old deployment; redeploy |
| `verify:live` exits 2 | the page could not be read, or does not carry the Cipher title |
| `verify:live` exits 1 | the page is a different build than this checkout |

## Not in this page

- The relays. Group traffic stays on `groups.ciphertele.com`; the full list
  of hosts the app contacts is `src/lib/egress.js`, and it is the only list
  that is authoritative.
- `/download`. It is a separate page on the same host, served by the same
  deploy.

## Moving the zone to the registrar's DNS (decided 2026-10-28)

What this changes: one fewer party holds the zone file — the registrar sees
it instead of Cloudflare. What it does not change: visitors are unaffected
either way, and whoever serves the page still sees their IPs.

The site sends `Strict-Transport-Security` with `preload`, so a name that
resolves to nothing is not cheap to take back. The order exists because of
that: recreate first, switch second, delete last.

1. **Turn on DNS hosting at the registrar** for `ciphermessenger.org`.
   It prints its own nameservers; note them.
2. **Recreate every record there first**, copied from the Cloudflare zone
   exactly: the apex record Vercel printed and the `www` CNAME from step 4
   above. Plain records only — no proxying exists to turn on.
3. **Prove the new servers answer before switching anything.**
   `dig @<registrar-nameserver-1> ciphermessenger.org` and the same for
   `www`, and check the answers match what Cloudflare returns. A wrong
   record caught here costs nothing; caught after the switch it takes the
   site down.
4. **Switch the nameservers** at the registrar from Cloudflare's
   (`cesar`, `vera`) to the registrar's own. Nothing changes at Cloudflare
   yet — it keeps answering for anyone who has not caught up.
5. **Wait, then prove.** After a few hours, `dig +short ciphermessenger.org`
   against the system resolver, then `npm run verify:live` — the site must
   still answer and still be this build. Also check Vercel still says
   **Valid Configuration** for both names.
6. **Remove the Cloudflare zone last**, only after step 5 passes, so the
   Cloudflare login stops mattering from that day.
