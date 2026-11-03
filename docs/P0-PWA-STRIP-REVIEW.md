# P0 REVIEW — iOS installed-PWA bottom gap

Status: **committed and pushed to `main`; NOT deployed; NOT physically verified on
an iPhone.**

| | |
|---|---|
| committed | `99d73f1` implementation, `2f7c5a2` spec repair |
| pushed | yes, `origin/main` |
| deployed | **no** |
| on a real iPhone | **no** |
| gates | build pass, lint 0 errors, 953 unit, 168 UI, 13 strip |

A follow-up commit fixes one defect this document's own lifecycle probe found
(keyboard dropped the band, §3b).

Repo `/home/aegis/cipher`, HEAD `aaac94a` when the review began. Nothing outside
the three files in §4 was touched.

---

## 1. Root cause — what is confirmed, what is hypothesis

### Confirmed: there is a mobile-only viewport band outside every layout viewport

WebKit bug **313800**, filed 2026-04-30, re-confirmed 2026-07-10:
<https://bugs.webkit.org/show_bug.cgi?id=313800>

> "iOS standalone PWA: visualViewport shorter than screen by full status-bar
> delta, orphan strip below page cannot be laid out in CSS"

Its reporter measures an iPhone 16 Pro on iOS 26.3.1:

```
screen.height                 874
visualViewport.height         812
visualViewport.offsetTop        0
env(safe-area-inset-top)       62
env(safe-area-inset-bottom)    34
874 − 812 = 62
```

And a second reporter reproduces it on iOS 27 beta 2, iPhone 16 Pro Max:
`innerHeight 894` vs `screen.height 956`, delta 62 = that device's status-bar
inset. Severity Major, radar **176524228**, still `NEW`.

Three things in that measurement describe the founder's symptom and nothing else
does:

- it is **standalone-only** by definition;
- the missing band is **~the status-bar height**, which is the "large" gap;
- `offsetTop` is 0, so the viewport is anchored at the **top** and the band is at
  the **bottom** — the page is laid out correctly and the black strip is *below*
  the app, exactly as photographed;
- `env(safe-area-inset-bottom)` still reports its full 34px from inside the
  already-short viewport.

Corroborating WebKit bugs, read directly, not inferred:
[325807](https://bugs.webkit.org/show_bug.cgi?id=325807) ("Home Screen web apps
can no longer draw under the status bar", iOS 27, 2026-09-30),
[301994](https://bugs.webkit.org/show_bug.cgi?id=301994) ("status bar remains
visible in fullscreen mode in Home Screen Web apps", regression in iOS 26.1,
Safari 26). Both confirm the current platform reserves status-bar area from Home
Screen web apps. **They say the status bar blocks the top; 313800's numbers say
the layout is also shortened, leaving a reachable-at-the-canvas-only band at the
bottom.** That is the part Cipher sees.

Relevant iOS: iOS 26 and 27, i.e. current. Not version-specific to an old build.

### Why a browser tab does not show it

A Safari tab has browser chrome (address bar, tab bar) inside the same short
viewport. The chrome is drawn over the top of that area, and the document's
bottom edge lands on real pixels that the chrome does not occupy. There is no
unpainted band to see. Only the installed app draws edge-to-edge with nothing
covering the strip.

### Why the two earlier attempts could not catch it — measured, in Chromium AND WebKit

Two prior commits went at this and both measured the bar against
`window.innerHeight`. On a letterboxed device `innerHeight` is itself short, so
the bar can sit exactly on `innerHeight` and a large strip still be under it.

Confirmed by running the same geometry in **Playwright's real WebKit engine**,
not only Chromium: with `screen.height` = `innerHeight` + a statusbar delta, the
app reached the viewport bottom exactly (`shellBottom 852`, `barBottom 852`,
`innerHeight 852`) in both engines, because **Playwright's WebKit emulation does
not model the letterbox**. It cannot reproduce the bug; it can only be made to
exercise the code path.

### Hypothesis (say so plainly)

- That the entire band is the status-bar inset on every affected device. Bug
  313800 gives one delta on two devices; it is the only delta the report names.
- That painting the band is acceptable. It is a workaround for a WebKit defect,
  not a fix of it.

---

## 2. The algorithm

Per the review's "do not introduce a global screen-height correction", the
correction is computed **only when the app is already standalone** and only from
one specific delta, then written to one custom property:

```
--strip = clamp to 0 unless  screen.height > tallestInnerHeight
                            and  delta <= MAX_INSET (120px)
                            and  portrait
```

- `tallest` is a **running maximum**, so a keyboard shrinking `innerHeight` is
  not read as a strip and the value is stable across typing.
- Re-seeded on `orientationchange`.
- `MAX_INSET` refuses window-sized deltas (desktop PWA window, iPad Split View)
  so those platforms keep the floor they had before this change.
- Landscape falls back to the floor, because the band is vertical.
- If `screen.height` is 0, or ≤ `innerHeight`, or the platform has no bug, the
  delta is ≤ 0 and `--strip` is 0: the fix no-ops.

Two consumers, both standalone-scoped: the canvas is painted the bar's own ground
(`background: var(--panel-strong)` on `:root`) so the band continues the bar, and
`--sab` subtracts the strip so the 34px home-indicator floor is not applied
twice. The three-row grid, the bar as a grid row, and every existing `pb-safe` /
`pb-bar` / `fab-pos` consumer are untouched.

---

## 3. The five distinctions the review asked for

| situation | distinguishable? | by what |
|---|---|---|
| genuine status-bar band | yes | delta ≤ 120, portrait |
| software keyboard | yes | running max of `innerHeight` |
| browser toolbar resize | yes | not standalone at all → `--strip` never written |
| rotation | yes | portrait guard + reseed |
| genuine change in screen space | yes | `tallest` only ever grows |

Event ordering: one initial measure at script parse (before React mounts, so no
shift after first paint), then `resize` and `orientationchange`. Two passive
listeners, no interval, no cleanup needed because they are page-lifetime and
registered exactly once.

---

## 3b. Lifecycle — measured, and one real defect found and fixed

The review asked whether background/bfcache restore can leave `--strip` stale.
Measured with a throwaway probe driving the full sequence (launch, background,
return at a new size, rotate out, rotate back, keyboard open, keyboard close):

| step | strip | nav padding | bar bottom vs viewport |
|---|---|---|---|
| return from background, 640 tall | 59px | 0 | 640 = bottom |
| rotate to landscape | 0px | 34px | 341 = 375 − 34 |
| rotate back to portrait | 59px | 0 | 667 = bottom |
| **keyboard open, 320 tall** | **0px**, then **59px** after the fix | **34px**, then **0px** | 320 = bottom |
| keyboard closed | 59px | 0 | 667 = bottom |

**The defect:** portrait was judged as `innerWidth <= innerHeight`. With the
keyboard up on a 393-wide phone the viewport is 393x320, so that test reads
*landscape* and the correction drops mid-sentence — 34px of extra padding and the
bar visibly stepping up while typing. Judging portrait against `tallest` instead
fixes it, because `tallest` is the phone's real height, not the keyboard's.

Both directions were proven: the strengthened keyboard arm (which now shrinks
below the viewport's width, the case that exposes it) fails with
`Expected "59px" Received "0px"` against the pre-fix line and passes after.

Staleness on restore: no `pageshow` or `visibilitychange` handler was added. The
browser fires `resize` when the viewport actually changes on return, which the
existing listener already handles, and the probe confirms the correct value after
a return, a rotation each way and a keyboard cycle. Adding handlers would be
redundant — so, deliberately, none were.

---

## 3c. The CSS-only alternative — built, not yet decided

`apple-mobile-web-app-status-bar-style: default` instead of `black-translucent`
may make the layout viewport full-screen and remove the band with no JavaScript.
Two isolated builds are prepared from the same committed SHA (main untouched):

- **Variant A** — as committed (JS correction on, `black-translucent`).
- **Variant B** — status bar `default`, and the `--strip` write disabled, so the
  CSS correction is inert.

**This cannot be decided by the test suite.** The new spec fakes the band with
`matchMedia`, which variant B does not change, so variant B would fail that spec
by construction. Only a device can say. Instructions in §8b.

---

## 4. Complete diff

`src/index.css` — `--strip: 0px` default; both standalone rules now also paint
the canvas and subtract the strip from `--sab`; the explanatory comment.

`src/main.jsx` — the guarded `measureStrip` and its two listeners, inside the
existing standalone branch only.

`tests/ui/pwa-standalone-strip.spec.js` — new witness, 13 tests, at four iPhone
sizes plus keyboard, landscape, window-delta and no-strip arms. Harness overrides
only `matchMedia` and `screen.height` (both install-time constants, as on a
device) and drives the viewport with `setViewportSize`, because `innerHeight` is a
non-configurable own property in Chromium and shadowing it broke the app.

`tests/ui/pwa-standalone-select.spec.js` — pre-existing spec whose
`waitForTimeout(1200)` raced the lazy chat list and failed once on the 16 Pro Max
arm; now waits for the shell. **Not caused by this change** — the same spec is in
the 1-failure full-suite run taken before any of my edits.

---

## 5. Tests

- `npm run build` — pass.
- `npm run lint` — 0 errors, 91 pre-existing warnings.
- `npm test` — 953 pass, 0 fail.
- New spec alone — **13/13 pass**; against the unfixed code (both source files
  stashed) **12 fail, 1 pass**, with `Expected "59px" Received "0px"` etc.
- `npm run test:ui` full — **168 passed, 0 failed** (14.5m, no
  infrastructure refusals). The run taken before these edits was 164 pass / 1
  fail, that failure being the selector race fixed in §4.

---

## 6. Smallest correct fix — the honest answer

**Possibly not.** Two simpler alternatives were considered and are **untested**;
saying otherwise would be a guess:

1. **`apple-mobile-web-app-status-bar-style: default`.** If making the status bar
   opaque makes the layout viewport full-screen, the strip disappears for free
   with no JS. Cost: the status-bar ground stops being ours, and 325807 says the
   *colour* is not reliably ours either on iOS 27.
2. **Drop `black-translucent`, or add `constant()` fallbacks.** Falls in the same
   place.

Both are two-line changes and should be tried first on a device. What the current
patch has over them is that it does not depend on which of these Apple leaves
working — and it costs nothing on any platform that has no bug.

Should a future iOS fix the letterbox: `--strip` measures 0 and the whole thing
no-ops. Should the status bar stay permanently out of the web area: `--strip`
becomes 0 and the 34px floor is what already shipped.

---

## 7. Remaining limitations

1. **No physical iPhone.** Everything is simulation. Real WebKit/Chromium here
   does not model the letterbox at all.
2. **Desktop / Android installed PWA.** Guarded by `MAX_INSET`, so the floor is
   kept, but a genuine small band on those platforms would also be ignored.
3. **Non-zero `env()` is untested.** Chromium reports 0; only the arithmetic is
   checked, not a device reporting a real inset.
4. `MAX_INSET` is a constant, not a derivation. 62px is the largest inset known;
   120 is headroom.
5. **Only `--sab` consumers are corrected.** The composer's centre stays parked
   at `innerHeight − 34` during typing. With `interactive-widget=resizes-content`
   the viewport shrinks to the keyboard's top, which is at or below the normal
   bottom, so it is not newly hidden — but it is not a victory.
6. Returning from background / bfcache is handled only by the `resize`/`pageshow`
   path; no explicit re-measure.

---

## 8. Physical iPhone verification

Do this before and after the build:

1. Install from Safari (Share → Add to Home Screen), launch from the icon.
2. Confirm the strip is gone: the tab bar's ground reaches the physical bottom,
   labels sit ~34px above it.
3. Measured evidence: `screen.height − visualViewport.height` and
   `getComputedStyle(document.documentElement).getPropertyValue('--strip')`
   should be equal; `nav.bottom` should equal `innerHeight − 0`.
4. Open the composer and type: the bar must not jump up (proves the max-tracking).
5. Rotate both ways and return: labels stay out of the home indicator.
6. Foreground after backgrounding: no shift.
7. Repeat in Safari as a tab: byte-identical to before, html background back to
   black.

---

## 8b. On-device A/B — the one thing still open

Both variants are already built and served from this machine, from the same
commit, main untouched:

```
Variant A (as committed)  http://192.168.1.154:8091/
Variant B (CSS-only)      http://192.168.1.154:8092/
```

On the iPhone, for each URL: Safari → open → Share → Add to Home Screen →
launch from the icon. Look only at the bottom of the screen.

| what you should see | A | B |
|---|---|---|
| no black band, bar reaches the bottom | expect yes | the question |
| status bar / time area | translucent, our black behind it | system band, not ours |
| tab bar labels clear of the indicator | yes | yes |

Then report just: does B still show the black band, yes or no.

**If B removes the band**: B wins — one line, no JavaScript, and we can delete
`measureStrip`. **If B still shows it**: A is the answer and this is settled.

Caveats about these URLs, stated rather than discovered:

- They are plain `http://` on a LAN address, which is **not a secure context**, so
  the service worker does not register on either. Irrelevant for a layout test.
- The phone must be on the same network as this machine (`192.168.1.154`). If it
  is not, say so and they can be tunnelled or the two patches applied to the live
  host instead.
- Variant B is a patched build, not a branch: `index.html` one word
  (`black-translucent` → `default`) and `main.jsx` one line (the `--strip` write
  disabled). Nothing else differs; both were built from `9752b60`.
