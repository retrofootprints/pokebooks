#!/usr/bin/env python3
"""
Phase 1 index build for the PT Book Encounter pilot.

Reads data/catalogo.csv (BNP open data dump), trims it to book records,
normalises identifiers and text, and writes a SQLite catalogue with
identifier indexes and an FTS5 full-text index for title/author/publisher.

See docs/bnp-findings.md for the Phase 0 investigation this build depends
on, in particular the header-column-shift data quality bug that this script
corrects for (BNP_HEADER below).

Usage:
    python scripts/build_index.py
Produces:
    data/build/catalogue.sqlite3
"""
import csv
import datetime
import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

csv.field_size_limit(10_000_000)

ROOT = Path(__file__).resolve().parent.parent
CATALOGO = ROOT / "data" / "catalogo.csv"
OUT_DIR = ROOT / "data" / "build"
OUT_DB = OUT_DIR / "catalogue.sqlite3"
OUT_STATS = ROOT / "assets" / "catalogue-stats.json"

# With FTS5, the pilot's first full build came out to ~508 MB, well past the
# spec's "uncomfortably large" line (250-300 MB expected, >100MB chunk count
# gets unwieldy to commit). Per docs/bnp-findings.md and the spec's own
# fallback ("ship identifier lookup only for the pilot"), FTS5 is off by
# default. Rungs 1-3 (barcode/OCR-ISBN/Depósito Legal) don't need it; rung 4
# falls back to network search instead of local fuzzy match. Flip this on
# if a future pass wants to trade repo size for offline fuzzy title search.
BUILD_FTS = False

# Corrected header — see docs/bnp-findings.md "Data quality issue: the
# header row is wrong". The published header is missing EODOPEN at its
# true position (right after BNP record ID); every data row has 23 fields
# but the published header only names 22.
BNP_HEADER = [
    "BNP record ID", "EODOPEN", "Material type", "ISBN", "Legal deposit number",
    "Language of Text", "Language of Original Work", "Title", "Subtitle",
    "Original title", "Edition", "Place of publicattion", "Name of Publisher",
    "Date of Publication", "Extent of Item", "Dimensions", "Series", "Volume",
    "Universal Decimal Classification", "Authors", "Image", "Persistent URL",
    "_trailing_unused",
]

# Material types kept in the pilot index. Blank type is kept too (flagged
# in docs/bnp-findings.md as "unknown, include by default") since spot
# checks suggest most blank-type rows are books; everything else explicitly
# labeled non-book is dropped.
KEEP_MATERIAL_TYPES = {"Book", ""}

LEADING_ARTICLES = {"o", "a", "os", "as", "um", "uma"}

ISBN13_RE = re.compile(r"\b(97[89]\d{10})\b")
ISBN10_RE = re.compile(r"\b(\d{9}[\dXx])\b")
DL_RE = re.compile(
    r"(?:dep[oó]sito\s*legal|dep\.?\s*legal|d\.?\s*l\.?)\s*n?[.ºo°]{0,2}\s*[:\-]?\s*"
    r"([\d\s]{3,9}\s*/\s*\d{2,4})",
    re.IGNORECASE,
)
DL_BARE_RE = re.compile(r"\b([\d\s]{3,9}\s*/\s*\d{2,4})\b")


def strip_diacritics(s):
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def norm_text(s):
    """lowercase, diacritic-strip, punctuation-strip, drop leading article."""
    if not s:
        return ""
    s = strip_diacritics(s).lower()
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    words = s.split()
    if words and words[0] in LEADING_ARTICLES:
        words = words[1:]
    return " ".join(words)


def valid_isbn13(digits):
    if len(digits) != 13 or not digits.isdigit():
        return False
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(digits[:12]))
    return (10 - (total % 10)) % 10 == int(digits[12])


def valid_isbn10(s):
    s = s.upper()
    if len(s) != 10:
        return False
    total = 0
    for i, c in enumerate(s):
        if c == "X" and i == 9:
            val = 10
        elif c.isdigit():
            val = int(c)
        else:
            return False
        total += val * (10 - i)
    return total % 11 == 0


def isbn10_to_isbn13(isbn10):
    core = "978" + isbn10[:9]
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(core))
    check = (10 - (total % 10)) % 10
    return core + str(check)


def isbn13_to_isbn10(isbn13):
    if not isbn13.startswith("978"):
        return None
    core = isbn13[3:12]
    total = sum((10 - i) * int(c) for i, c in enumerate(core))
    check = (11 - (total % 11)) % 11
    check_char = "X" if check == 10 else str(check)
    return core + check_char


def extract_isbns(raw):
    """Return (isbn13, isbn10) from a raw ISBN field, both possibly None."""
    if not raw:
        return None, None
    compact = re.sub(r"[\s-]", "", raw)
    for m in ISBN13_RE.finditer(compact):
        cand = m.group(1)
        if valid_isbn13(cand):
            return cand, isbn13_to_isbn10(cand)
    for m in ISBN10_RE.finditer(compact):
        cand = m.group(1).upper()
        if valid_isbn10(cand):
            return isbn10_to_isbn13(cand), cand
    return None, None


def normalize_dl(raw):
    """Strip internal spaces from a Depósito Legal number, keep NNNNNN/YY[YY]."""
    if not raw:
        return None
    m = DL_RE.search(raw) or DL_BARE_RE.search(raw)
    if not m:
        return None
    val = re.sub(r"\s+", "", m.group(1))
    return val or None


def parse_year(raw):
    if not raw:
        return None
    m = re.search(r"(1[3-9]\d{2}|20[0-2]\d)", raw)
    return int(m.group(1)) if m else None


def main():
    if not CATALOGO.exists():
        print(f"ERROR: {CATALOGO} not found. See docs/bnp-findings.md for the "
              f"source URL and Phase 0 setup.", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if OUT_DB.exists():
        OUT_DB.unlink()

    conn = sqlite3.connect(OUT_DB)
    conn.execute("PRAGMA journal_mode = OFF")  # bulk load, rebuilt from scratch each time
    conn.execute("PRAGMA synchronous = OFF")
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE editions (
            id INTEGER PRIMARY KEY,
            bnp_record_id TEXT,
            title TEXT,
            subtitle TEXT,
            authors TEXT,
            publisher TEXT,
            place TEXT,
            year INTEGER,
            edition TEXT,
            pages TEXT,
            language TEXT,
            isbn13 TEXT,
            isbn10 TEXT,
            deposito_legal TEXT,
            title_norm TEXT,
            author_norm TEXT
        )
    """)

    idx = {name: i for i, name in enumerate(BNP_HEADER)}

    def get(row, name):
        i = idx[name]
        return row[i].strip() if i < len(row) else ""

    total_read = 0
    total_kept = 0
    batch = []
    BATCH_SIZE = 20_000

    with open(CATALOGO, encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        next(reader)  # discard the (wrong) published header; BNP_HEADER is used instead

        for row in reader:
            total_read += 1
            if len(row) < len(BNP_HEADER):
                row = row + [""] * (len(BNP_HEADER) - len(row))

            material = get(row, "Material type")
            if material not in KEEP_MATERIAL_TYPES:
                continue

            title = get(row, "Title")
            subtitle = get(row, "Subtitle")
            authors = get(row, "Authors")
            publisher = get(row, "Name of Publisher")
            place = get(row, "Place of publicattion")
            year = parse_year(get(row, "Date of Publication"))
            edition = get(row, "Edition")
            pages = get(row, "Extent of Item")
            language = get(row, "Language of Text")
            bnp_record_id = get(row, "BNP record ID")

            isbn13, isbn10 = extract_isbns(get(row, "ISBN"))
            dl = normalize_dl(get(row, "Legal deposit number"))

            # A record with no title and no identifiers at all is not
            # useful for "what book is this?" lookups; skip it.
            if not title and not isbn13 and not dl:
                continue

            title_norm = norm_text(title or subtitle)
            author_norm = norm_text(authors)

            batch.append((
                bnp_record_id, title, subtitle, authors, publisher, place,
                year, edition, pages, language, isbn13, isbn10, dl,
                title_norm, author_norm,
            ))
            total_kept += 1

            if len(batch) >= BATCH_SIZE:
                cur.executemany(
                    "INSERT INTO editions (bnp_record_id, title, subtitle, authors, "
                    "publisher, place, year, edition, pages, language, isbn13, isbn10, "
                    "deposito_legal, title_norm, author_norm) VALUES "
                    "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    batch,
                )
                batch.clear()
                print(f"  ...{total_read} read, {total_kept} kept", file=sys.stderr)

        if batch:
            cur.executemany(
                "INSERT INTO editions (bnp_record_id, title, subtitle, authors, "
                "publisher, place, year, edition, pages, language, isbn13, isbn10, "
                "deposito_legal, title_norm, author_norm) VALUES "
                "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                batch,
            )

    conn.commit()
    print(f"Rows read: {total_read}, rows kept: {total_kept}")

    print("Building indexes...")
    cur.execute("CREATE INDEX idx_isbn13 ON editions(isbn13)")
    cur.execute("CREATE INDEX idx_isbn10 ON editions(isbn10)")
    cur.execute("CREATE INDEX idx_dl ON editions(deposito_legal)")

    # Dex-completion denominator (see docs/dl-pokedex-analysis.md): how many
    # distinct Depósito Legal numbers are in THIS catalogue snapshot. The
    # editions table is already filtered to Material type Book/blank (see
    # KEEP_MATERIAL_TYPES above), so this is a book count, not a raw legal-
    # deposit count. Shipped as a tiny separate JSON asset (same pattern as
    # assets/pt-locations.json) rather than queried at runtime — a
    # COUNT(DISTINCT ...) over the whole indexed column would mean the
    # range-request VFS pulling a large fraction of the index just to show
    # one number, on every stats-view visit.
    cur.execute("SELECT COUNT(DISTINCT deposito_legal) FROM editions WHERE deposito_legal IS NOT NULL AND deposito_legal != ''")
    book_dl_count = cur.fetchone()[0]

    # dl_max: the discovery-grid filmstrip (js/ui.js's renderDiscoveryGrid)
    # buckets encounters by the DL number's numeric prefix, and needs a fixed
    # upper bound to size the grid — it can't just take max(deposito_legal)
    # over the raw text column, because a small number of rows in BNP's own
    # export have corrupt/mis-parsed DL fields with absurd numeric values
    # (see docs/dl-pokedex-analysis.md's "small amount of garbage" finding,
    # e.g. 8-9 digit numbers). A plausible-year filter alone doesn't catch
    # all of it — checked directly: some rows pair a wildly wrong number
    # with an otherwise-plausible year (e.g. "691001/93", when 1993's real
    # range tops out around 73,000). DL_NUM_CEILING is therefore a
    # deliberately round, hand-picked ceiling with headroom (current real
    # max is ~565,000-597,000 depending on the year), not a
    # percentile-derived exact bound — chasing a perfectly precise cutoff
    # isn't worth it against data this noisy.
    DL_NUM_CEILING = 600_000
    dl_year_re = re.compile(r"^(\d+)/(\d{2,4})$")
    current_year = datetime.date.today().year
    dl_max = 0
    cur.execute("SELECT deposito_legal FROM editions WHERE deposito_legal IS NOT NULL AND deposito_legal != ''")
    for (dl,) in cur.fetchall():
        m = dl_year_re.match(dl)
        if not m:
            continue
        num, yr = int(m.group(1)), int(m.group(2))
        if yr < 100:
            yr = 1900 + yr if yr >= 30 else 2000 + yr
        if not (1930 <= yr <= current_year) or num >= DL_NUM_CEILING:
            continue
        dl_max = max(dl_max, num)

    OUT_STATS.parent.mkdir(parents=True, exist_ok=True)
    OUT_STATS.write_text(
        json.dumps({
            "book_dl_count": book_dl_count,
            "dl_max": dl_max,
            "built_at": datetime.date.today().isoformat(),
        }),
        encoding="utf-8",
    )
    print(f"Wrote {OUT_STATS}: book_dl_count={book_dl_count}, dl_max={dl_max}")

    # title_norm/author_norm are kept as columns (per spec's Normalise step)
    # but deliberately NOT indexed: without FTS5 (see BUILD_FTS above) a
    # B-tree index on long text buys nothing for rung 4 (no local prefix/
    # substring search is attempted) while costing ~100MB. Measured on the
    # full build: 423MB with these two indexes vs 323MB without.
    conn.commit()

    if BUILD_FTS:
        print("Building FTS5 index (title_norm + author_norm + publisher, diacritic-folded)...")
        cur.execute("""
            CREATE VIRTUAL TABLE editions_fts USING fts5(
                title_norm, author_norm, publisher,
                content='editions', content_rowid='id',
                tokenize="unicode61 remove_diacritics 2"
            )
        """)
        cur.execute("""
            INSERT INTO editions_fts (rowid, title_norm, author_norm, publisher)
            SELECT id, title_norm, author_norm, publisher FROM editions
        """)
        conn.commit()

        print("Optimizing FTS index...")
        cur.execute("INSERT INTO editions_fts(editions_fts) VALUES ('optimize')")
        conn.commit()
    else:
        print("Skipping FTS5 (BUILD_FTS=False) — identifier lookup only, "
              "per spec's size fallback. Rung 4 falls back to network search.")

    print("Setting page size and vacuuming (required before chunking for sql.js-httpvfs)...")
    conn.execute("PRAGMA journal_mode = delete")
    conn.execute("PRAGMA page_size = 4096")
    conn.execute("VACUUM")
    conn.commit()
    conn.close()

    size_mb = OUT_DB.stat().st_size / 1_048_576
    print(f"\nDone. {OUT_DB} is {size_mb:.1f} MB.")


if __name__ == "__main__":
    main()
