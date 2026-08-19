# BNP Open Data — Phase 0 Findings

Investigation into whether the BNP (Biblioteca Nacional de Portugal) open data
dump can support a Depósito Legal (DL) lookup for pre-ISBN Portuguese books.
Produced by `scripts/investigate_bnp.py` against the catalogue dump
downloaded 2026-08-19.

## Decision gate: STRONG

**87,319 rows (6.0%) have a Depósito Legal number and no ISBN.** This clears
the spec's "strong result" bar (>50k) by a wide margin. Build all three
resolution tiers — rung 3 (Depósito Legal) is a first-class lookup path, not
a stub.

## Source used

`data/catalogo.csv`, extracted from `catalogo.csv.zip` (151 MB zipped). The
zip actually contains **four** CSVs, not one:

| file | rows | notes |
|---|---:|---|
| `catalogo.csv` | 1,458,937 | the full catalogue — this is the one to use |
| `bibliografianacional.csv` | 321,213 | confirmed below to be 2002+ only, as the docs implied |
| `bnd.csv` | not analyzed | Biblioteca Nacional Digital — out of scope for this pilot |
| `bndlivre.csv` | not analyzed | subset of BND — out of scope for this pilot |

## Data quality issue: the header row is wrong (important — read before writing Phase 1 ingestion code)

`catalogo.csv`'s header line lists 22 column names, but every data row has
**23** fields. The header is missing `EODOPEN` at its true position —
immediately after `BNP record ID` — and instead lists it a second time at
the end, where the corresponding field is always empty.

Confirmed by hand: with the header used as-published, values land in
nonsensical columns (a year like `1979` shows up under "Extent of Item", `21
cm` under "Series", author names under "Image"). Shifting the header by
inserting `EODOPEN` after column 1 makes every field semantically correct —
years land in `Date of Publication`, `NN cm` lands in `Dimensions`,
`Lastname, Firstname` lands in `Authors`, and the field right after `BNP
record ID` turns out to hold exactly what `EODOPEN` implies: "digital copy
available at `<url>`" notes for ~6,200 rows, empty otherwise.

**Corrected 23-column order** (what `scripts/investigate_bnp.py` and any
Phase 1 ingestion code must use):

```
1. BNP record ID          9. Original title        17. Series
2. EODOPEN                10. Edition               18. Volume
3. Material type          11. Place of publication  19. Universal Decimal Classification
4. ISBN                   12. Name of Publisher      20. Authors
5. Legal deposit number   13. Date of Publication    21. Image
6. Language of Text       14. Extent of Item         22. Persistent URL
7. Language of Original Work  15. Dimensions          23. (unused, always empty)
8. Title                  16. Series
```

`bibliografianacional.csv` has the identical bug — same fix applies.

## Other data quality notes

- **Encoding**: UTF-8, but not cleanly — the file contains scattered invalid
  UTF-8 byte sequences (mid-file, not just in one place). Read with
  `errors="replace"` or expect occasional mangled characters. Not `latin-1`:
  the vast majority of the file decodes correctly as UTF-8.
- **Dialect**: standard RFC 4180 comma-delimited CSV, `"` quoting. Python's
  `csv.Sniffer()` badly misdetects this file (returned delimiter `'b'` on
  one run) — don't rely on it; hardcode the dialect.

## 1. Size, rows, columns, encoding, dialect

- Unzipped `catalogo.csv`: 381.5 MB, 1,458,937 rows.
- 23 columns (see corrected order above).
- UTF-8 with scattered invalid bytes; comma-delimited, double-quoted.

## 2. Publication year distribution by decade

Parsed from `Date of Publication` (free text, year extracted by regex).
46,210 rows (3.2%) had no parseable year.

| decade | rows | | decade | rows | | decade | rows |
|---|---:|---|---|---:|---|---|---:|
| 1400s | 88 | | 1700s | 8,725 | | 1930s | 46,996 |
| 1410s | 31 | | 1710s | 3,001 | | 1940s | 55,884 |
| 1420s | 30 | | 1720s | 3,356 | | 1950s | 71,058 |
| 1430s | 43 | | 1730s | 4,308 | | 1960s | 89,259 |
| 1440s | 53 | | 1740s | 4,183 | | 1970s | 99,068 |
| 1450s | 72 | | 1750s | 7,653 | | 1980s | 109,648 |
| 1460s | 36 | | 1760s | 5,547 | | 1990s | 139,284 |
| 1470s | 198 | | 1770s | 7,021 | | 2000s | 196,797 |
| 1480s | 343 | | 1780s | 6,915 | | 2010s | 180,219 |
| 1490s | 661 | | 1790s | 6,899 | | 2020s | 97,560 (partial) |
| 1500s | 978 | | 1800s | 12,351 | | | |
| 1510s–1690s | ~28,700 combined | | 1810s–1890s | ~99,200 combined | | | |

Coverage runs continuously from the 1400s to present, with the expected
long tail growing steadily and a clear inflection around 1900–1950 as legal
deposit / catalogue coverage becomes more complete.

## 3. ISBN parseability

- Non-empty `ISBN` field: 401,556 rows (27.5%).
- **Checksum-valid ISBN-10/13** (regex-extracted, check digit verified):
  394,924 rows (27.1%).
- 6,632 rows have a non-empty but unparseable/invalid ISBN string — mostly
  ISSNs miscategorized in the ISBN field (e.g. `3051-780X`), a handful of
  bad check digits, and one recurring bad value (`978-972-8285-27-6`)
  appearing on multiple unrelated records, suggesting an upstream data-entry
  error rather than a parsing bug on our side.

## 4. Is Depósito Legal a structured column or buried free text?

**Structured column** — `Legal deposit number` (position 5 in the corrected
order) holds clean values in the expected `NNNNNN/YY` format, not embedded
in a notes/UNIMARC field. Examples pulled at random:

```
321/81       242/82       18086/87     11669/86     55972/92
154716/00    251930/06    3640/83      378724/1979  5683/84
63134/93     135757/99    564812/26    57213/92     19283/87
```

A few outliers use a 4-digit year (`378724/1979` instead of `.../79`) —
worth a permissive regex/normalization step in Phase 1, but the field is
fundamentally clean and directly indexable.

## 5. Rows with DL and no ISBN

**87,319 rows (6.0% of the full catalogue).** This is the number that
clears the decision gate. These are exactly the pre-ISBN-era and
non-commercial-publishing records the DL lookup (rung 3) exists to serve.

## 6. Rows published before 1988 (pre-ISBN era in Portugal)

**775,378 rows — 53.1% of the entire catalogue.** Over half the BNP
catalogue predates ISBN. This confirms the core premise of the project: an
ISBN-only pilot would silently ignore the majority of Portuguese print
history.

## 7. Sample pre-1988 rows

20 random pre-1988 rows were printed in full by the script (see git history
of `scripts/investigate_bnp.py` output, or rerun the script). They read as
expected: real titles, Portuguese and foreign-language works, UDC codes,
`Lastname, Firstname` authors, place/publisher/year/extent/dimensions all
populated, no ISBN, DL present on most where legal deposit predates the row.
Two representative examples:

```
Title: A pedagogia e o ideal republicano em João de Barros
Place: Lisboa · Publisher: Terra Livre · Year: 1979
Extent: 63, [1] p. · Dimensions: 21 cm
Authors: Reis, Maria Alice ; Magalhães, Joaquim Romero

Title: Cicatriz na alma (orig. Cicatriz en el alma)
Place: Lisboa · Publisher: Ag. Port. de Revistas · Year: 1960
Series: Madrepérola, vol. 72 · Authors: Taber, Henry M. ; Aragão, Helena de
```

## 8. Field completeness (corrected column mapping)

| field | populated | pct |
|---|---:|---:|
| title | 1,458,497 / 1,458,937 | 100.0% |
| author | 1,346,138 / 1,458,937 | 92.3% |
| publisher | 1,366,826 / 1,458,937 | 93.7% |
| place | 1,393,832 / 1,458,937 | 95.5% |
| year | 1,448,989 / 1,458,937 | 99.3% |
| pages (extent) | 1,374,290 / 1,458,937 | 94.2% |

Uniformly high across the board once the header shift is corrected.

## 9. Non-book material

`Material type` is a clean, populated column (not free text to infer):

| material type | rows |
|---|---:|
| Book | 1,140,499 |
| Iconographic material | 91,081 |
| Periodical | 68,493 |
| Notated music | 55,195 |
| Manuscript | 47,536 |
| (blank) | 36,430 |
| Cartographic material | 12,387 |
| Electronic resource | 6,688 |
| Multimedia | 391 |
| Sound Recording | 127 |
| Projected and video material | 110 |

Filtering is trivial: `WHERE "Material type" = 'Book'` removes periodicals,
maps, scores, manuscripts, and iconographic/AV material in one step — no
heuristic title-text classification needed. (36,430 blank-type rows will
need a secondary check — spot checks suggest most are books, but this
wasn't fully characterized; Phase 1 should treat them as "unknown, include
by default, flag for review" rather than silently dropping them.)

## Secondary source: bibliografianacional.csv

Confirmed **not useful for the pre-ISBN goal**, as the docs' framing
suggested:

- 321,213 rows total, but only 306 (0.1%) predate 1988.
- 101,060 + 140,411 + 77,091 = 318,562 rows (99.2%) fall in the 2000s–2020s.
- Same header bug as `catalogo.csv`; same fix applies if this file is ever
  used.
- Not needed for Phase 1. `catalogo.csv` alone covers everything this file
  covers, plus 1.1M+ additional records outside its 2002+ window.

## Recommendation for Phase 1

- Use `catalogo.csv` only.
- Apply the corrected 23-column header before parsing anything downstream.
- Filter to `Material type = 'Book'` (optionally also keep blank-type rows,
  flagged) — drops periodicals/maps/scores/manuscripts/AV cleanly.
- Build all three identifier tiers: ISBN-13, ISBN-10 (kept separately, both
  indexed), and Depósito Legal. DL regex should tolerate both `NNNNNN/YY`
  and the rarer `NNNNNN/YYYY` form seen in the sample.
- Read the file with `errors="replace"` given the scattered invalid UTF-8
  bytes; don't assume a single clean encoding.
