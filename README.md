# Portuguese Book Encounter Log — pilot

A static web app for logging encounters with physical books in Portugal —
model is iNaturalist, not Goodreads: the unit is the encounter with a
specific physical copy, not a work read or a library owned. Single-user
pilot, no accounts, no server, no backend. Everything lives in the
browser's IndexedDB. See [`pt-book-encounter-pilot-spec.md`](pt-book-encounter-pilot-spec.md)
for the full spec this was built from, and [`docs/bnp-findings.md`](docs/bnp-findings.md)
for the Phase 0 data investigation the whole design depends on.

## Running it

Open `index.html` through **any HTTPS or localhost server that supports
HTTP Range requests** — the local catalogue (`db/`) is a chunked SQLite
file queried via `sql.js-httpvfs`, which needs Range support to fetch only
the pages a query touches instead of downloading 300MB+ up front. GitHub
Pages supports Range requests; most trivial local static servers
(`python -m http.server`, VS Code Live Server) do not reliably.

For local testing, use the included dev server:

```
node scripts/dev_server.js 8080
# then open http://localhost:8080
```

Camera access (barcode scan / photograph page) requires HTTPS or
`localhost` — both work; a plain `file://` URL will not.

## Rebuilding the catalogue index

The BNP open data dump changes over time; to rebuild from a fresh copy:

1. Download `https://opendata.bnportugal.gov.pt/docs/catalogo.csv.zip`
   (~150MB) and unzip `catalogo.csv` into `data/` (gitignored — this and
   everything else in `data/` is a local build intermediate, never
   committed).
2. `python scripts/investigate_bnp.py > data/bnp-findings-raw.txt` —
   optional, re-runs the Phase 0 investigation. Only needed if you want to
   re-verify the header-shift bug or size/coverage numbers documented in
   `docs/bnp-findings.md` against a newer dump.
3. `python scripts/build_index.py` — trims to books, normalises
   identifiers and text, builds `data/build/catalogue.sqlite3` with
   indexes on `isbn13`/`isbn10`/`deposito_legal`.
4. `python scripts/chunk_db.py` — splits the built database into
   `db/db.sqlite3.NNN` chunks (20MB each, under GitHub's 100MB file limit)
   and writes `db/config.json`. **These chunk files under `db/` are
   committed** — they're the actual build artifact GitHub Pages serves,
   not a raw dump.

Total pipeline time on the full BNP dump: budget a few minutes for step 3
(reads/normalises ~1.2M rows) and under a minute for the rest.

## Rebuilding the map outline

The density map (Map tab) draws Portugal from
`assets/portugal-outline.json`, a small committed artifact built from
Natural Earth 1:10m admin-0 data (public domain):

```
python scripts/build_geodata.py
```

It caches the 13MB source in `data/` (gitignored) and emits ~20KB. The
outline is split into three groups — mainland, Madeira, Azores — because
they cannot share one map extent: the mainland spans ~3.3° of longitude
while the full territory spans ~25°, which would squash the mainland into
an unreadable sliver. The map renders the mainland full-size and the island
groups as insets, shown only when they actually contain encounters. The
script deliberately drops the Selvagens (uninhabited islets ~250km south of
Madeira) — see the comment on `GROUPS` for why.

Map data © [Natural Earth](https://www.naturalearthdata.com/), public domain.

## Language (English / Portuguese)

All UI text lives in two dictionaries in `js/i18n.js` (`DICTS.en` and
`DICTS.pt`). To correct a translation, find its key there and edit the
Portuguese (or English) value — no other file needs to change, since every
other module looks strings up by key via `App.i18n.t(key, params)` (or
`App.i18n.tn(key, count, params)` for the handful of strings that need a
singular/plural form — English and Portuguese both just need a `_one` and
an `_other` variant of the key, no complex plural rules to worry about).

Static markup (buttons, labels, headings in `index.html`) is translated via
`data-i18n="key"` (and `data-i18n-placeholder="key"` for input
placeholders) — `App.i18n.applyStaticTranslations()` walks those once at
startup. Everything built dynamically (result card, log entries, stats,
the map's notes and legend) calls `t()`/`tn()` directly each time it
renders.

Language is decided once per page load — a stored preference, else the
browser's language, else English — and the header's EN/PT toggle just
persists the choice and reloads the page, rather than live-translating
whatever's currently on screen. This was a deliberate simplification: it
avoids having to track and re-render "whatever view happens to be open"
when the language changes. Records already in IndexedDB are unaffected by
language — `context`/`resolution_rung` are stored as raw values (`"shop"`,
`3`, …) and only translated at render time, so switching language
correctly re-labels every existing encounter, not just new ones.

## Known limitations (read before extending)

- **No full-text search / rung 4 is network-only.** The first build with
  an FTS5 index came out to ~508MB (spec's own "uncomfortably large"
  threshold); identifiers-only without any text index came to ~323MB.
  Since indexing `title_norm`/`author_norm` without FTS5 would only support
  slow, weak prefix matching while still costing ~100MB, that index was
  dropped entirely (see the comment in `scripts/build_index.py`). Rung 4
  (title-page fuzzy match) falls back to a live OpenLibrary search
  (`js/network.js`) instead of a local index. This is an explicit,
  documented spec fallback, not an oversight.
- **BNP/PORBASE URN resolvers are CORS-blocked.** Tested directly
  (`urn.bnportugal.gov.pt/isbn/<isbn>` and the PORBASE equivalent both
  return real XML server-side via curl, but send no
  `Access-Control-Allow-Origin` header). Browser fetches to them will fail
  silently and the ladder just moves on to OpenLibrary. The code still
  attempts them first, in case that changes. A same-origin proxy would fix
  this but is explicitly out of scope for this pilot.
- **The `User-Agent` header cannot be set from browser JS** (forbidden
  header per the Fetch spec), so the spec's "send a User-Agent naming the
  app" instruction for the OpenLibrary API is not actionable client-side.
  Requests go out with the browser's default UA.
- **BNP's published CSV header is wrong** (documented in detail in
  `docs/bnp-findings.md`): it's missing a column, and every downstream
  script corrects for it. If BNP ever fixes the header upstream,
  `BNP_HEADER` in `scripts/build_index.py` will need updating to match —
  check a few rows by hand before assuming the old shift still applies.
- **One "Scan" button, not the spec's separate "Scan barcode" /
  "Photograph page" pair.** Deliberate deviation, made after real hands-on
  use: barcode detection is cheap enough to run continuously in the
  background for the whole camera session regardless of intent, and the
  shutter (for the OCR path — rungs 2-4) is available the entire time too,
  rather than gated behind picking a mode up front. Whichever resolves
  first wins. This removes a decision the user usually can't make in
  advance anyway (you don't know if a given book has a barcode until you
  look). See `startScanFlow` in `js/main.js`.

## Repo layout

```
/                index.html, styles.css       (GitHub Pages root)
/js              app code (i18n, capture, barcode, ocr, catalogue, network,
                 ladder, idb, ui, map, main)
/assets          portugal-outline.json (committed build artifact for the
                 density map — see "Rebuilding the map outline")
/lib             vendored third-party libs (sql.js-httpvfs, zxing-wasm,
                 tesseract.js + core + Portuguese tessdata_fast model) —
                 no bundler, no CDN, plain <script> tags
/db              chunked SQLite catalogue + config.json (committed build
                 artifact — see "Rebuilding the catalogue index" above)
/scripts         investigate_bnp.py, build_index.py, chunk_db.py,
                 build_geodata.py, dev_server.js (local testing only)
/docs            bnp-findings.md (Phase 0 investigation writeup)
```

`data/` (raw dumps, intermediate builds, local test scripts) is gitignored
and never committed — see `.gitignore`.

## Why OCR tries four rotations, not one

`js/ocr.js`'s `recognizeBestRotation` runs OCR at 0/90/180/270 degrees and
keeps whichever produced a valid ISBN or Depósito Legal match, short-
circuiting as soon as one does (in practice this is 1-2 attempts, not 4).
This exists because a canvas capture of a live `<video>` element is **not**
guaranteed to match what the on-screen preview looks like — a documented
cross-browser `getUserMedia`+canvas inconsistency, most notably on
iOS/WebKit. The preview can look correctly oriented to the user while the
captured frame is sideways. Verified against three real Portuguese book
photos (an actual user report, not a hypothetical): OCR on the as-captured
sideways frame produced pure gibberish and zero identifier matches on all
three; trying all four rotations correctly extracted the real Depósito
Legal number on all three. See the comment on `recognizeBestRotation` and
the commit that introduced it for the full detail. If you're debugging OCR
misses, check `raw_ocr_text` on the encounter — if it's dense gibberish
rather than near-miss noisy text, orientation is the first thing to
suspect, not the OCR model.

**Known remaining limitation:** this fixes *rotation*, not *perspective*.
A page photographed at a steep glancing angle (rather than roughly face-on)
comes out skewed/foreshortened, and no rotation fixes that. One of the
three real test photos above failed to extract anything for exactly this
reason. Perspective correction (real deskew) would be a much larger feature
and is out of scope for the pilot.

## Testing notes

Barcode-scan decode accuracy could not be tested with a physical
device/camera in the environment this was built in — no phone was
available. OCR, however, **was** validated against three real photos of
Portuguese books' ficha técnica pages (provided by the user after an actual
gibberish-OCR bug report), run through the real production pipeline end to
end, not mocked: capture → OCR rotation retry → identifier extraction →
real SQLite catalogue lookup via HTTP range requests. It correctly
identified a real edition (Moby Dick, Relógio d'Água, 2005) from a
genuinely flawed, uncorrected sideways photo. What else *was* verified,
against a real headless Chrome instance over a local Range-supporting
server:

- The chunked SQLite catalogue: exact-match ISBN-13/ISBN-10/Depósito Legal
  lookups return correct rows via real HTTP range requests (not mocked).
- The full OCR pipeline runs end-to-end (Tesseract WASM loads, recognizes,
  rotation retry works, and the ladder correctly falls through to rung 4 →
  network search → the honest "no identifier found" state) — both against
  Chrome's synthetic fake-camera feed and against the three real book
  photos above.
- Barcode classification logic (Bookland-prefix acceptance, non-Bookland
  rejection, EAN-5 add-on ignoring, checksum validation) — unit-tested
  directly, not through an actual barcode decode.
- The complete manual ("log it anyway") save loop: form → IndexedDB →
  log view → stats view, including the rung-distribution and
  identified/unidentified math.
- Live network search (rung 4 escape hatch) against the real OpenLibrary
  API, including a full export → import round-trip.
- Export/import survive real Blob ↔ base64 photo round-tripping.
- The density map, across five seeded scenarios: mainland-only, with island
  insets, encounters with no location at all, a partial/outside-Portugal
  mix, and empty. Cell placement was asserted geographically (Porto renders
  north of Lisboa, Faro southernmost), island insets confirmed to appear
  only when they hold encounters, adaptive binning checked against five
  count distributions (every count lands in exactly one bin), and the
  rendered map was screenshotted and inspected.
- English/Portuguese switching: default-language detection, the header
  toggle's persist-and-reload, and — the part most likely to silently
  break on a careless edit — that a record saved while the app is in one
  language re-labels correctly after switching to the other, since
  `context`/`resolution_rung` are stored as raw values and only translated
  at render time. Grep the codebase for a stray hardcoded English string
  before assuming this is complete after future UI changes.

### A note on the map's colour scale

The density ramp is **sequential** (one hue, light→dark) and was validated
programmatically, not chosen by eye — monotone lightness, adjacent ΔL ≥
0.06, light-end contrast ≥ 2:1, single hue. It passes **only against a white
surface**, which is why the landmass is filled white; on a tinted land fill
the lightest step drops to ~1.8:1 and fails. The ramp is duplicated in
`styles.css` (`--map-cell-*`) and `js/map.js` (`RAMP`) and the two must stay
in sync — if you change one, change both and re-validate.

Take a phone to a bookshop before trusting rungs 1-3 fully (per the
spec's own build order) — that's the first honest signal this pilot is
designed to produce.
