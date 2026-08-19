# Portuguese Book Encounter Log — Pilot Spec

## 0. What this is

A static web app, hosted on GitHub Pages, for logging encounters with physical books in
Portugal. You find a book somewhere — a shop, a library, a friend's house, a fair — scan or
photograph it, and it gets logged on your phone.

**Model: iNaturalist, not Goodreads.** The unit is the *encounter with a specific physical
copy*, not a work you've read and not a library you own. There is no reading tracking, no
shelves, no ratings.

**Scope of this pilot: one user (the author). No accounts, no server, no sharing, no
backend.** Everything is stored in the browser. The point is to find out whether the loop is
worth repeating and whether the resolution ladder actually works on real Portuguese books.

**Explicitly out of scope:** shelf/bulk scanning (one book at a time, by design), user
accounts, any server component, social features, gamification, sync.

---

## PHASE 0 — BNP data investigation (do this first, before any app code)

The whole architecture depends on one unknown: **how much pre-ISBN Portuguese material is
in the BNP open data dump, and is the Depósito Legal number usable as a lookup key?**

Write `investigate_bnp.py` as a throwaway script. Its only job is to answer that. Do not
start the app until it has run and been read.

### Source
- `https://opendata.bnportugal.gov.pt/docs/catalogo.csv.zip` (~138 MB zipped, full BNP
  catalogue, CC0, no auth, no registration, no rate limit)
- Secondary if useful: `https://opendata.bnportugal.gov.pt/docs/bibliografianacional.csv.zip`
  (~26 MB — documented as covering from 2002, so probably *not* the useful one here, but
  confirm rather than assume)

### What the script must report
1. Unzipped size, total row count, **exact column names**, detected encoding, CSV dialect.
2. **Publication year distribution by decade**, from earliest to latest.
3. Count and percentage of rows with a parseable ISBN (10 or 13).
4. **Does a Depósito Legal number appear as its own column, or is it embedded in a notes /
   free-text / UNIMARC-ish field?** This is the single most important finding. Report which
   column(s) contain it and show raw examples.
5. Count of rows with a DL number **and no ISBN**.
6. Count of rows published before 1988 (the pre-ISBN era in Portugal).
7. Print 20 random pre-1988 rows in full, unmodified, so the actual field structure can be
   eyeballed.
8. Field completeness: for title, author, publisher, place, year, pages — what percentage of
   rows have each populated?
9. Any rows that look like periodicals, maps, scores, or non-book material, and how they can
   be filtered out.

### Decision gate
- **Strong result** (roughly >50k rows with a usable DL and no ISBN): build all three tiers.
  The Depósito Legal path is the interesting part of the project.
- **Weak result** (<5k, or DL is unparseable free text): the pilot is ISBN-only. Keep rung 3
  in the code as a stub. Email `OpendataBNP@bnportugal.gov.pt` — small team with an open-data
  mandate, likely to respond — and ask whether pre-1988 records with structured DL numbers
  are available in another export or format.
- **In between**: build it, expect partial coverage, and report the honest hit rate in the
  app's stats view.

Note: Portugal uses **UNIMARC**, not MARC21, so most off-the-shelf MARC libraries target the
wrong standard. Stay with the CSV. Only reach for the MarcXchange/RDF/JSON/Turtle variants if
the CSV turns out to have lost the DL field.

**Output of Phase 0 is a short written findings note in the repo (`docs/bnp-findings.md`),
not just console output.**

---

## PHASE 1 — Build the local catalogue index

### Trim
From the BNP dump, keep only books. For each: internal id, title, subtitle, author(s),
publisher, place, year, edition statement, pages, language, ISBN-13, ISBN-10, Depósito Legal,
BNP record id.

Drop everything else. The goal is the smallest file that can answer "what book is this?".

### Normalise
- Convert ISBN-10 → ISBN-13 (prefix `978`, recompute check digit). **Store both** — older
  catalogue records index the 10-digit form.
- Strip hyphens and spaces from all identifiers before indexing.
- Add a `title_norm` and `author_norm` column: lowercased, diacritics stripped, punctuation
  removed, leading articles (`o`, `a`, `os`, `as`, `um`, `uma`) dropped.

### Build
SQLite. Indexes on `isbn13`, `isbn10`, `deposito_legal`. FTS5 over
`title_norm + author_norm + publisher`, using the `unicode61` tokenizer with
`remove_diacritics=2`. **Portuguese matching fails badly without diacritic folding — this is
not optional.**

Then chunk it for `sql.js-httpvfs` (its `create_db.sh` / split tooling). Chunks must be under
GitHub's 100 MB per-file hard limit; aim for 10–50 MB chunks.

Expected size: roughly 100–150 MB with identifier indexes only, 250–300 MB with FTS5.
**If FTS pushes it uncomfortably large, ship identifier lookup only for the pilot** — rungs
1–3 don't need full-text search, and rung 4 can fall back to the network.

Commit the build script. **Do not commit the raw dump or the built database** — `.gitignore`
both, and publish the chunks to the `gh-pages` branch or a `docs/db/` directory as a build
artifact.

---

## PHASE 2 — The app

### Stack
- Vanilla JS or minimal React. No build step if avoidable. It must be trivially deployable to
  GitHub Pages.
- **Catalogue query**: `sql.js-httpvfs` — queries the chunked SQLite over HTTP range requests,
  fetching only the pages a query touches (tens of KB per lookup, not the whole file).
- **Barcode**: native `BarcodeDetector` where available (Chrome/Android), `zxing-wasm`
  fallback (Safari has no native support).
- **OCR**: `tesseract.js` with the `tessdata_fast` Portuguese model (~1.5 MB, cached after
  first load). Expect a couple of seconds per page on a modern phone — acceptable for one book.
- **Storage**: **IndexedDB**, not localStorage. Photos will blow past the ~5 MB localStorage
  cap immediately.

### The resolution ladder

Single entry point. Record which rung succeeded on every encounter — the rung distribution is
the main thing this pilot is meant to measure.

**Rung 1 — Barcode → ISBN.** Book barcodes are EAN-13; a `978`/`979` prefix (Bookland) means
the digits *are* the ISBN-13. Validate the check digit. **Reject anything not starting
978/979** — library and shop sticker barcodes are accession numbers and will poison the log;
say so clearly rather than failing silently. **Ignore EAN-5 price add-on barcodes** printed
alongside the main one.

**Rung 2 — OCR'd printed ISBN.** For books from roughly 1988 to the mid-90s: ISBN printed on
the ficha técnica, no barcode. Tesseract, then regex for ISBN-10/13 with optional hyphens and
spaces. Validate the check digit before accepting.

**Rung 3 — Depósito Legal.** Portuguese books print `Depósito Legal n.º NNNNNN/YY` on the
ficha técnica. Legal deposit long predates ISBN, so this is an exact key for material with no
ISBN and no barcode. **Make the regex permissive** — real-world variants include
`Depósito Legal`, `Depósito legal`, `Dep. Legal`, `D.L.`, `DL`, with or without `n.º` / `nº` /
`N.º`, and the number itself may carry internal spaces (`123 456/98`).

Subject to the Phase 0 outcome. If Phase 0 was weak, stub this and log the OCR'd DL string on
the encounter anyway — it costs nothing and it's data for later.

**Rung 4 — Title page.** No identifier. OCR the title page, fuzzy-match against FTS on a
weighted combination of title, author and publisher — **not title alone**, since Portuguese
title pages are verbose and inconsistent. Return a **ranked candidate list, never a single
answer**. User picks.

**Rung 5 — Unidentified.** Nothing matched. **This is a primary path, not a failure.** Log the
encounter with photos and whatever the user can supply by hand. For pre-1931 material this is
the expected outcome and it's where the interesting finds are. Give it a proper form and a
confident tone — no apology copy.

### Network fallback (rungs 1–3 miss locally)
Plain fetch, no auth on any of these:
- `https://urn.bnportugal.gov.pt` — by ISBN, DL number, record id, cota
- `https://urn.porbase.org` — union catalogue, 200+ Portuguese libraries, broader than BNP alone
- `https://openlibrary.org/api/books?bibkeys=ISBN:...&format=json&jscmd=data` — foreign books.
  Send a `User-Agent` naming the app with a contact email (raises the limit from 1 to 3 req/sec;
  irrelevant at one-book pace but it's good manners).
- `https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg` — cover art
- Google Books — **last resort only.** Opaque quota, closed system, never a primary path.

CORS may block some of these from the browser. **Test early.** If BNP/PORBASE don't send
permissive CORS headers, note it in the findings doc — that's the one thing that would later
force a tiny proxy, and it's better to know in week one.

Cache every network hit into IndexedDB permanently, so the same edition is never fetched twice.

### Capture

**Photo.** Resize on-device before storing: canvas, 1600px long edge, JPEG quality 0.8, target
under 300 KB. Store the resized version only; discard the original.

**The photo is the record, not just OCR input.** Always keep it, always show it back. The
user's own photograph of this copy — its wear, its binding, the shop shelf behind it — is the
artifact, exactly as in iNaturalist.

**Location.** Ask once, via the standard permission prompt, and work fine if refused.
**Round latitude and longitude to 1 decimal place at the moment of capture and never store the
true coordinate.** At Portuguese latitudes that's ~11 km north–south and ~8.5 km east–west,
giving ~1,600 cells over the mainland — enough for a nice density map, no precision to leak.
One line of code; no geohash library.

**Context.** A single-tap selector: `shop` / `library` / `friend` / `fair` / `secondhand` /
`owned` / `other`. Plus an optional free-text location note ("Alfarrabista da Rua Anchieta")
and an optional personal note.

### Local data model (IndexedDB)

`encounters`: `id`, `timestamp`, `edition` (embedded object or null), `resolution_rung`,
`raw_ocr_text`, `detected_isbn`, `detected_dl`, `lat_rounded`, `lon_rounded`, `context`,
`location_note`, `note`, `photo_blob`, `confirmed`.

**An encounter with a null edition is valid.** Never block logging on identification — that is
the single most important behaviour in the app.

`editions_cache`: network results, keyed by identifier, kept forever.

### UI

One page. Two capture buttons — **Scan barcode** and **Photograph page** — plus a text search
escape hatch and a **"log it anyway"** action that is *always visible*, never buried behind a
failure state.

Camera via `getUserMedia` with `facingMode: "environment"`. HTTPS is mandatory for camera
access; GitHub Pages provides it.

Result view: the user's own photo, title, author, publisher, year, edition statement, **which
rung resolved it**, and **which source supplied the data**. Confirm / Edit / Reject.

A log view: reverse chronological, with a filter by rung and by context.

A stats view: total encounters, **rung distribution**, share unidentified, count of distinct
editions. This is the pilot's actual output — build it, don't defer it.

### Data safety (do not defer)

Local-only means Safari can evict everything.
1. Call `navigator.storage.persist()` on first use.
2. **Ship a JSON export button in the first working version**, including photos as base64.
3. Add a matching import.

Losing two hundred encounters to a silent iOS storage reclaim would destroy the only thing
this pilot is meant to produce.

---

## Build order

1. Phase 0 investigation. Write `docs/bnp-findings.md`. **Stop and read it.**
2. Phase 1 index build + chunking, deployed to Pages, queryable from a browser console.
3. Barcode scan → local ISBN lookup → display result. No storage yet.
4. IndexedDB write + log view + export. **Complete loop, end to end.**
5. Take it to a bookshop. This is the first honest signal and it comes cheap.
6. Rung 5 (log anyway, with photo, manual fields). Early, not last — it makes every later
   failure survivable.
7. Photo capture, resize, location rounding, context selector.
8. Network fallback + cache.
9. Tesseract: rungs 2 and 3.
10. Rung 4 (title page + FTS fuzzy match).
11. Stats view.

---

## Things to get right

- **ISBN is not the universe.** It covers Portuguese commercial publishing from 1988 only. The
  BNP catalogue is the universe; ISBN is one key into it.
- **An encounter with no identification is a valid encounter.**
- Never silently accept a non-978/979 barcode.
- Never present OCR- or model-derived data as authoritative — mark the source on every record.
- Diacritic folding on all text matching, or Portuguese search quietly fails.
- Fuzzy matching returns candidates, not answers.
- Store both ISBN-10 and ISBN-13.
- Round coordinates at capture time; never store the precise ones.
- Keep every photo, including from failed resolutions — that corpus shows where the pipeline
  is weak.

---

## Repo layout

```
/                      index.html, app.js, styles.css   (GitHub Pages root)
/lib                   zxing-wasm, sql.js-httpvfs, tesseract.js
/db                    chunked SQLite (build artifact, generated not committed)
/scripts               investigate_bnp.py, build_index.py
/docs                  bnp-findings.md
README.md              setup + how to rebuild the index
.gitignore             raw dumps, built db, *.zip
```

No environment variables, no keys, no backend. If a proxy later proves necessary for CORS,
that's a separate decision — don't pre-build for it.
