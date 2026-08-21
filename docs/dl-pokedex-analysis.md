# Depósito Legal as a "dex" ordinal — findings

Investigated 2026-08-21, prompted by a question about whether Depósito
Legal (DL) numbers are sequential enough to use as a Pokédex-style ordinal
ID/completion mechanic, the way ISBN can't be (ISBN is allocated to
publishers in negotiated blocks — no relationship to chronological or
catalogue order). Checked directly against the local BNP catalogue build
(`data/build/catalogue.sqlite3`, 419,270 catalogued editions carry a DL
number), not assumed.

## It's one continuous global counter, not reset per year

Grouping DL numbers by their `/YY` year suffix and looking at
`(p95 − p5) ÷ count` per year (a ratio near 1.0 means virtually every
integer in that year's span is actually used — almost no gaps) shows tight,
contiguous ranges from the early 1980s on, and — critically — each year's
range picks up right where the previous year's left off. E.g. 2015's
numbers run 387,023–402,468; 2016's start immediately after, at 404,038.
Confirmed by direct inspection, not assumed: the counter runs across the
whole history of the registry, not per calendar year.

Pre-1983 data is too sparse (single digits to low hundreds/year, wildly
inconsistent ranges) to draw the same conclusion from — either an early
different numbering scheme or, more likely, poor digitization of the oldest
records. Treat the "reliable sequential ordinal" property as holding from
~1983 onward, not from the registry's 1931 founding.

## Volume and growth

Roughly 13,000–16,000 new DL numbers/year since ~2013 (up from a few
hundred/year in the early 1980s), i.e. ~1,100–1,300/month, ~35–45/day. As of
the newest 2026 data in the current snapshot, the counter sits around
560,000–565,000 (all material types, not book-only — see below).

## Three real caveats found while checking this, not assumed going in

1. **Small amount of garbage in BNP's own export.** ~0.02% of DL fields
   don't parse to a sane year; a handful (<0.2%) have absurd numeric values
   (8-9 digits) — clearly typos/OCR artifacts in BNP's own data, not
   something this app's own OCR introduced. Trivial to filter.
2. **DL is sometimes 1-per-series, not 1-per-book.** 6.3% of distinct DL
   values are reused across more than one catalogue row; 15.3% of all
   DL-bearing rows share a number with something else. Checked the worst
   offender directly: `3664/83`, shared by 275 rows, all issues of a Banco
   de Portugal working-paper series registered once and reused 1983-1992.
   So DL is a reliable "when in the sequence was this registered" signal,
   but not always a unique-item key — worth a dedup rule wherever it's used
   as one (the Stats view's completion card, `js/ui.js`'s
   `renderDexCompletion`, dedupes by DL value for exactly this reason).
3. **The raw counter isn't book-exclusive** — legal deposit also covers
   periodicals, sheet music, maps, etc. Checked directly: among all
   DL-bearing rows in the raw BNP export, 96.2% are explicitly labeled
   `Material type = Book` (426,725 of 443,731), with Periodicals a distant
   second at 12,994. `scripts/build_index.py` already filters to
   `Book`/blank type before anything reaches the local catalogue (see
   `KEEP_MATERIAL_TYPES`), so the app's own local DB is already
   book-scoped — confirmed by re-deriving the count directly from the raw
   CSV restricted to `Material type == "Book"` only: 378,525 distinct DL
   values, versus 378,899 from the shipped Book+blank-type table. The
   difference is negligible (blank-type rows are ~0.1% of DL-bearing rows).

## How fast does a book actually get a DL number?

**Legal deadline: 30 days after publication.** Deposit is compulsory for
printers/publishers under Decreto-Lei nº 74/82 (3 March) and 362/86 (28
October) — normally 11 copies, fewer for small/luxury editions, theses, and
reprints under a year old. Sources:
[APEL](https://www.apel.pt/documentacao/deposito-legal/),
[BNP](https://www.bnportugal.gov.pt/index.php?option=com_content&view=article&id=153&Itemid=63&lang=pt).

That's the legal registration deadline, not how fast the record becomes
visible in open data — see `docs/catalogue-gaps.md` for why a book can have
a completely genuine DL number and still not appear in BNP's public
catalogue for some time (or ever, if it falls into a cataloguing-backlog
gap).

## How fresh is BNP's open data?

Not on a documented schedule. Both `dados.gov.pt` dataset pages for this
data (Catálogo BNP, Bibliografia Nacional Portuguesa) list "frequency of
updates: not set," and their own "last updated 6 May 2025" metadata is
demonstrably stale/unreliable — the locally downloaded `catalogo.csv`
already contains DL numbers dated into 2026, so the portal's own
last-updated field lags behind the actual file content. Sources:
[Catálogo BNP](https://dados.gov.pt/en/datasets/catalogo-bnp/),
[Bibliografia Nacional Portuguesa](https://dados.gov.pt/en/datasets/bibliografia-nacional-portuguesa/).
Practical takeaway: treat any BNP-derived total as running some months
behind reality, with no way to know exactly how far, and re-pull the source
periodically rather than trusting one fixed number long-term.

## What this means for the "dex" mechanic (shipped)

The Stats view's "Catalogue completion" card
(`js/ui.js`'s `renderDexCompletion`, backed by `assets/catalogue-stats.json`,
regenerated by `scripts/build_index.py` on every rebuild) shows:

> {count} of {total} BNP-catalogued books logged ({pct}%)

`{total}` is `book_dl_count` from the snapshot — an exact count of distinct
book DL numbers in the shipped catalogue (378,899 as of the 2026-08-21
build), **not** an estimate of all Portuguese books ever published. There is
no way to derive that larger, true number from data this app has access
to — no independent source exists to calibrate the cataloguing-backlog and
snapshot-staleness gap against. The UI is deliberately worded to say
"BNP-catalogued books" with the snapshot date shown, rather than implying a
global total, and `{count}` is deduped by DL value per the series-sharing
caveat above.

## The discovery-grid filmstrip (shipped 2026-08-22)

A second visualization, added after discussing what a Pokédex-style
completion *grid* (not just a single number) could look like: a
GitHub-contribution-graph-style filmstrip, one square per fixed-size range
of consecutive DL numbers, oldest at top-left to newest at bottom-right.

**Bucket size: 200 DL numbers/square**, chosen from a menu of options
presented to the user (10/25/200/1000-per-square, trading grid fineness
against phone-scroll length) — 200 was picked because it lands closest to
the user's own "4-5 phone screens" intuition. With `dl_max` (see below) at
596,560, that's **2,983 squares**, about 2-2.5 phone-screens of scrolling
at typical mobile width.

**Color: raw count, not percentage-of-bucket.** The user's own initial
framing ("if you have one or two, first shade; eight or nine of ten,
almost full") describes a *percentage* scale — but with realistic personal
collection sizes (dozens to a few hundred books) spread across a
378,899-book registry, a percentage-of-bucket scale would leave nearly
every touched square at the very faintest shade forever, since even 1 book
in a 200-book bucket is 0.5%. Resolved by switching to GitHub's own
approach instead: color reflects **raw count logged**, thresholded into 5
levels (0 / 1 / 2 / 3-4 / 5+), independent of bucket size. A single find is
always clearly visible. Reuses the density map's already-validated
sequential ramp (`--map-cell-1..4` in `styles.css`) rather than a new
palette — same "shows how much of something," same white-panel background
the ramp was validated against.

**Personal data only — explicitly not multi-user.** The user's first
instinct was that the shading should reflect what *everyone* has logged,
not just them, for the eventual real multi-user app. Flagged directly:
this pilot has no backend at all (static GitHub Pages, IndexedDB per
browser) — there is currently no way for one device to know what another
has found. Resolved by building against this device's own data now,
labeled honestly ("this device," not "community"), with the rendering
function taking an already-fetched encounters array as a parameter
specifically so a future backend can swap in an aggregated feed without
touching `renderDiscoveryGrid`/`renderDexCompletion` themselves.

**`dl_max` (the grid's upper bound) needed its own outlier filter, found by
testing, not assumed.** A plausible-year filter alone wasn't enough to
exclude garbage: some rows pair a wildly wrong DL number with an otherwise
plausible year (e.g. `691001/93`, when 1993's real range tops out around
73,000 per the per-year table above) — confirmed directly by checking the
top values under a first-attempt ceiling of 2,000,000, which came back
essentially unfiltered (`1,998,831`, clearly still garbage). Replaced with
a deliberately round, hand-picked ceiling (`DL_NUM_CEILING = 600_000` in
`scripts/build_index.py`) rather than chasing a percentile-derived exact
cutoff against data this noisy — yields `dl_max = 596,560`, a sane value
consistent with the per-year table's ~560-570k range for recent years.
