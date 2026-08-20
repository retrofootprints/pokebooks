# Catalogue gaps: real books with a real Depósito Legal or ISBN that aren't in the BNP dump

This is expected, not a bug, and it will keep happening. Documented here
because it comes up repeatedly and is worth recognizing on sight rather
than re-investigating every time.

## What it means

A book can have a completely genuine Depósito Legal (DL) number or ISBN
printed on it and still not appear in `catalogo.csv` (the BNP open data
dump this pilot's local index is built from — see
[`bnp-findings.md`](bnp-findings.md)). The DL number and the BNP catalogue
are two different things:

- **Depósito Legal is a legal registration**, submitted by the publisher to
  DGLAB at or before publication. The number gets printed on the book at
  that point — its existence just proves the publisher registered it.
- **BNP's catalogue is BNP cataloguing the physical deposit copies they've
  received**, a separate administrative step that happens on BNP's own
  timeline, not the publisher's.

A DL number with no catalogue match usually means one of:

1. **Cataloguing backlog.** Smaller or less prominent titles — and
   pocket-format reprints especially — sit in the queue longer than a first
   edition or a major release.
2. **The open-data export isn't a live mirror of BNP's internal system.**
   `catalogo.csv` is a point-in-time snapshot; BNP's actual internal
   catalogue may be ahead of it.
3. **Reprints specifically are a common case.** A reprint sometimes gets
   its own fresh DL registration, sometimes doesn't (if nothing
   substantive changed from the original edition) — and BNP may have only
   catalogued the original edition's record, not a later reprint's.

None of this means the book isn't real, the DL is fake, or the app is
broken. Expect this to be **common** across a general, varied home
collection — it disproportionately affects exactly the kind of books a
personal library tends to have a lot of: reprints, pocket/paperback
editions, and older or smaller-press titles.

## What the app does about it

- The result view shows the detected identifier plainly, labeled as having
  no catalogue/network match, rather than pretending nothing was found.
- It also shows **best-effort suggested fields** (title, author, publisher,
  year) extracted from the photographed page's OCR text via
  `App.util.extractFichaTecnicaFields` (`js/util.js`) — pattern/regex-based,
  not a model, matching this project's existing "never present OCR data as
  authoritative" rule. These pre-fill the manual form; every field stays
  fully editable and nothing saves without the user reviewing it. See the
  function's own comment for exactly which patterns it looks for and the
  two real OCR failure modes that shaped them.
- The year is derived from the DL number's own `/YY` suffix when a DL was
  detected (verified more reliable than scanning body text — see the
  comment on `yearFromDL`), falling back to a free-text scan otherwise.
- Once such an encounter is saved, the Log view flags it with a distinct
  "Not catalogued" badge (`js/ui.js`'s `isCatalogueGap`) — separate from
  the rung badge — so it's visually distinguishable from both a genuine
  catalogue match and a fully unidentified (rung 5) encounter. This is
  derived from stored fields (identifier rung + no matched edition), not a
  separate stored flag, so it works retroactively on already-saved
  encounters too.

## Confirmed cases

A running log of specific books found to hit this gap, as they're
identified. Add a row here whenever the app shows "identifier detected,
no catalogue/network match" for a book that's clearly a real, unremarkable
publication — this is the evidence base for how common the gap actually
is across a real collection, not just a hypothetical.

| Title | Publisher | Year | DL | ISBN | Notes |
|---|---|---|---|---|---|
| A Christmas Carol (O Cântico de Natal) | Publicações Dom Quixote | 2001 | 166353/01 | 972-20-2044-7 | 2.ª edição / 1.ª edição de bolso (paperback reprint of a 1989 first edition) — checked directly against the local catalogue, OpenLibrary, and the BNP URN endpoint; genuinely absent from all three as of 2026-08-20. |

<!--
When adding a row: check the local catalogue directly before assuming it's
a gap —
  python3 -c "
  import sqlite3
  conn = sqlite3.connect('data/build/catalogue.sqlite3')
  cur = conn.cursor()
  cur.execute(\"SELECT * FROM editions WHERE deposito_legal = '...' OR isbn13 = '...' OR isbn10 = '...'\")
  print(cur.fetchall())
  "
confirm it's not a normalization mismatch (spacing, 2- vs 4-digit year)
before logging it here as a true gap.
-->
