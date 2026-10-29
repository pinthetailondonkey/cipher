# The one-read note host — how to run it

This is the small server that makes a Cipher burn note readable by anyone in a
normal browser, with no account and no app, and **really** gone after the first
read. You run it once, by hand. Nobody else has access to the machine.

What it does, in one sentence: it keeps a sealed note under a random name and
hands it over one time, then deletes it.

What it never sees: the key. The key lives only in the link, after the `#`
symbol, and a browser never sends that part to a server. A full copy of this
server's folder opens nothing.

---

## Before you begin

- A machine that is on all the time (a small VPS is fine), with **Node.js 20 or
  newer**. Check with `node -v`.
- A web address for it, with HTTPS. The page has to be `https://…` for a modern
  browser to allow the cryptography it does. Caddy is the easiest way to get
  that (steps below).
- Nothing else is needed: no database, no packages, no build step.

---

## 1. Put the two files on the machine

Copy these two files into a folder, for example `/srv/note-carrier/`:

- `note-carrier.mjs` — the server
- (nothing else: the reading page is built into that file)

The server writes its notes into `note-data/` next to wherever you start it,
or into the folder you name in step 3.

## 2. Try it before you commit

```
cd /srv/note-carrier
NOTE_DATA_DIR=/srv/note-carrier/note-data NOTE_PORT=8789 node note-carrier.mjs
```

Open `http://127.0.0.1:8789/` in a browser on the same machine. You should see
the page that says **"A note that reads once"**. That is the page people will
land on. Close it for now — there is nothing to read yet.

Stop the server with `Ctrl-C`.

## 3. Run it as a service, so it stays up

Save this as `/etc/systemd/system/note-carrier.service` (change the two
folders if yours are different):

```
[Unit]
Description=Cipher one-read note carrier
After=network.target

[Service]
WorkingDirectory=/srv/note-carrier
Environment=NOTE_DATA_DIR=/srv/note-carrier/note-data
Environment=NOTE_PORT=8789
Environment=NOTE_HOST=127.0.0.1
ExecStart=/usr/bin/node /srv/note-carrier/note-carrier.mjs
Restart=always
User=note
Group=note

[Install]
WantedBy=multi-user.target
```

Then:

```
sudo useradd --system --home /srv/note-carrier note
sudo chown -R note:note /srv/note-carrier
sudo systemctl daemon-reload
sudo systemctl enable --now note-carrier
sudo systemctl status note-carrier
```

`NOTE_HOST=127.0.0.1` means only the web server on the same machine can reach
it. That is what you want.

## 4. Put HTTPS in front of it

With Caddy, add to `/etc/caddy/Caddyfile` (replace `notes.example.org` with your
real address):

```
notes.example.org {
    reverse_proxy 127.0.0.1:8789
}
```

Then `sudo systemctl reload caddy`. Open `https://notes.example.org/` — the page
should appear, and the lock in the address bar should be a real certificate.

## 5. Check it works, end to end

On the server:

```
curl -s https://notes.example.org/healthz
```

should print `{"ok":true}`.

That is the only check the app itself makes: it asks this address whether it is
a one-read host, and uses it if the answer is yes. Until the address is set in
the app (next step), nothing points here.

## 6. Tell the app where it is

This is a code change made once before a release, not something you do on the
server. In `src/lib/egress.js`, the line

```
'dead-drop': '',
```

becomes your address:

```
'dead-drop': 'https://notes.example.org',
```

Then build and deploy the app as usual. From that build on, every burn note the
app makes is sealed and given to this host, and the link it copies is
`https://notes.example.org/note#…`.

If the line stays empty, the app keeps making notes the old way (stored on
relays, one-open held by the reader's own device) and a link cannot be read by
anyone who does not use the app. Nothing breaks; the promise is just not true.

---

## What to expect in daily use

- **A note can be read once.** First open wins. If the reader's browser fails
  after the server handed the note over, it is still gone: that is what "once"
  means. Tell people to keep the text if they need it.
- **A note nobody opens is deleted after 7 days** if you add the cleanup below;
  otherwise it waits until it is read. A note is never larger than 16 KB (the
  app caps the text at 8000 characters).
- **The server cannot read anything it holds.**
- **Logs never contain a note.** The server prints counts only.

## Optional: delete notes nobody opened

This timer job runs daily and removes notes nobody opened after a week:

```
sudo tee /etc/cron.daily/note-carrier-sweep >/dev/null <<'EOF'
#!/bin/sh
find /srv/note-carrier/note-data -name '*.note' -mmin +10080 -delete
find /srv/note-carrier/note-data -name '*.tmp' -mmin +60 -delete
EOF
sudo chmod +x /etc/cron.daily/note-carrier-sweep
```

## If something is wrong

- **Page does not load**: `sudo systemctl status note-carrier` and
  `sudo journalctl -u note-carrier -n 50`.
- **Page loads but says the note "has already been read"**: it has. There is no
  second copy anywhere, by design.
- **App still makes old-style notes**: the `dead-drop` line in `egress.js` is
  still empty, or the build predates it, or `https://…/healthz` does not answer
  `{"ok":true}` from the reader's network.
- **Do not** "fix" a stuck note by restoring a backup of `note-data/`: a note
  that comes back can be read twice, which is the one thing this host exists to
  prevent. Delete the file instead.
