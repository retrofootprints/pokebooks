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

## Repo layout

```
/                index.html, styles.css       (GitHub Pages root)
/js              app code (capture, barcode, ocr, catalogue, network,
                 ladder, idb, ui, main)
/lib             vendored third-party libs (sql.js-httpvfs, zxing-wasm,
                 tesseract.js + core + Portuguese tessdata_fast model) —
                 no bundler, no CDN, plain <script> tags
/db              chunked SQLite catalogue + config.json (committed build
                 artifact — see "Rebuilding the catalogue index" above)
/scripts         investigate_bnp.py, build_index.py, chunk_db.py,
                 dev_server.js (local testing only)
/docs            bnp-findings.md (Phase 0 investigation writeup)
```

`data/` (raw dumps, intermediate builds, local test scripts) is gitignored
and never committed — see `.gitignore`.

## Testing notes

Camera-dependent flows (barcode scan, real-world OCR against an actual
book) could not be tested with a physical device/camera in the environment
this was built in. What *was* verified, against a real headless Chrome
instance over a local Range-supporting server:

- The chunked SQLite catalogue: exact-match ISBN-13/ISBN-10/Depósito Legal
  lookups return correct rows via real HTTP range requests (not mocked).
- The full OCR pipeline runs end-to-end (Tesseract WASM loads, recognizes,
  and the ladder correctly falls through to rung 4 → network search → the
  honest "no identifier found" state) — tested against Chrome's synthetic
  fake-camera feed, so decode *accuracy* against a real printed page is
  untested, but the pipeline itself doesn't crash or hang.
- Barcode classification logic (Bookland-prefix acceptance, non-Bookland
  rejection, EAN-5 add-on ignoring, checksum validation) — unit-tested
  directly, not through an actual barcode decode.
- The complete manual ("log it anyway") save loop: form → IndexedDB →
  log view → stats view, including the rung-distribution and
  identified/unidentified math.
- Live network search (rung 4 escape hatch) against the real OpenLibrary
  API, including a full export → import round-trip.
- Export/import survive real Blob ↔ base64 photo round-tripping.

Take a phone to a bookshop before trusting rungs 1-3 fully (per the
spec's own build order) — that's the first honest signal this pilot is
designed to produce.
