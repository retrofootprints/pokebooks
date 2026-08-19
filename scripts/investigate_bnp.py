#!/usr/bin/env python3
"""
Phase 0 investigation script for the PT Book Encounter pilot.

Answers one question: how much pre-ISBN Portuguese material is in the BNP
open data dump, and is the Deposito Legal number usable as a lookup key?

Throwaway script. Reads data/catalogo.csv (and bibliografianacional.csv for
comparison) and prints a findings report to stdout. Run with output
redirected into docs/bnp-findings.md, or see build_findings_doc() below.

Usage:
    python scripts/investigate_bnp.py > docs/bnp-findings-raw.txt
"""
import csv
import random
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

csv.field_size_limit(10_000_000)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CATALOGO = DATA_DIR / "catalogo.csv"
BIBNAC = DATA_DIR / "bibliografianacional.csv"

ISBN10_RE = re.compile(r"\b(\d{9}[\dXx])\b")
ISBN13_RE = re.compile(r"\b(97[89]\d{10})\b")
DL_HAS_DIGITS_RE = re.compile(r"\d")

PERIODICAL_HINTS = ("periodic", "jornal", "revista", "boletim", "serie")
MAP_HINTS = ("mapa", "carta topografica", "atlas")
SCORE_HINTS = ("partitura", "musica impressa", "score")


def sniff(path, sample_bytes=65536):
    """Detect encoding only. The BNP exports are standard RFC 4180 CSV
    (comma-delimited, double-quoted), confirmed by manual inspection —
    csv.Sniffer() was tried here and mis-detected the dialect badly
    (e.g. delimiter 'b' on catalogo.csv), so it is deliberately not used."""
    with open(path, "rb") as f:
        raw = f.read(sample_bytes)
    encoding = "utf-8"
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        encoding = "latin-1"
    return encoding, ","


def strip_diacritics(s):
    if not s:
        return s
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def parse_year(raw):
    if not raw:
        return None
    m = re.search(r"(1[4-9]\d{2}|20[0-2]\d)", raw)
    if m:
        return int(m.group(1))
    return None


def valid_isbn13(digits):
    if len(digits) != 13 or not digits.isdigit():
        return False
    total = 0
    for i, c in enumerate(digits[:12]):
        total += int(c) * (1 if i % 2 == 0 else 3)
    check = (10 - (total % 10)) % 10
    return check == int(digits[12])


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


def extract_isbn(raw):
    """Return first plausible, checksum-valid ISBN found in a raw field, or None."""
    if not raw:
        return None
    compact = re.sub(r"[\s-]", "", raw)
    for m in ISBN13_RE.finditer(compact):
        if valid_isbn13(m.group(1)):
            return m.group(1)
    for m in ISBN10_RE.finditer(compact):
        cand = m.group(1).upper()
        if valid_isbn10(cand):
            return cand
    return None


def classify_material(material_type, title):
    t = (material_type or "").lower()
    ttl = (title or "").lower()
    combined = t + " " + ttl
    if any(h in combined for h in PERIODICAL_HINTS):
        return "periodical"
    if any(h in combined for h in MAP_HINTS):
        return "map"
    if any(h in combined for h in SCORE_HINTS):
        return "score"
    return "book/other"


def analyze(path, label, max_sample_rows=None):
    print(f"\n{'=' * 70}")
    print(f"ANALYZING: {label} ({path})")
    print(f"{'=' * 70}")

    size_bytes = path.stat().st_size
    print(f"File size on disk: {size_bytes / 1_048_576:.1f} MB")

    encoding, delimiter = sniff(path)
    print(f"Detected encoding: {encoding}")
    print(f"Detected delimiter: {delimiter!r}")

    with open(path, encoding=encoding, newline="", errors="replace") as f:
        reader = csv.reader(f, delimiter=delimiter)
        raw_header = next(reader)

        # Data quality bug in the BNP export: the header row is missing the
        # "EODOPEN" (digital-copy note/URL) column at its true position, right
        # after "BNP record ID". Every data row has one more field than the
        # header lists. Confirmed by hand: raw_header[-1] ("EODOPEN") is
        # consistently empty in the data, while the field immediately after
        # "BNP record ID" holds exactly the kind of "digital copy available
        # at <url>" text EODOPEN implies, and the remaining columns only
        # line up semantically (year in Date of Publication, cm in
        # Dimensions, "Lastname, Firstname" in Authors, etc.) once shifted
        # this way. See docs/bnp-findings.md for the row-by-row evidence.
        header = [raw_header[0], "EODOPEN"] + raw_header[1:-1] + ["_trailing_unused"]

        print(f"Column count (raw header): {len(raw_header)}")
        print(f"Column count (corrected, matches data row width): {len(header)}")
        print("Column names (corrected order):")
        for i, col in enumerate(header, 1):
            print(f"  {i:2d}. {col}")

        col_idx = {name: i for i, name in enumerate(header)}

        def get(row, name):
            i = col_idx.get(name)
            if i is None or i >= len(row):
                return ""
            return row[i].strip()

        # Field name lookups tolerant of the actual header text seen in catalogo.csv
        def find_col(*candidates):
            for c in candidates:
                for name in header:
                    if name.strip().lower() == c.lower():
                        return name
            # fallback: substring match
            for c in candidates:
                for name in header:
                    if c.lower() in name.strip().lower():
                        return name
            return None

        col_title = find_col("Title")
        col_subtitle = find_col("Subtitle")
        col_author = find_col("Authors")
        col_publisher = find_col("Name of Publisher")
        col_place = find_col("Place of publicattion", "Place of publication")
        col_year = find_col("Date of Publication")
        col_pages = find_col("Extent of Item")
        col_isbn = find_col("ISBN")
        col_dl = find_col("Legal deposit number")
        col_material = find_col("Material type")

        print(f"\nResolved key columns: title={col_title!r} author={col_author!r} "
              f"publisher={col_publisher!r} place={col_place!r} year={col_year!r} "
              f"pages={col_pages!r} isbn={col_isbn!r} dl={col_dl!r} material={col_material!r}")

        row_count = 0
        decade_counter = Counter()
        material_counter = Counter()
        classified_counter = Counter()
        isbn_present = 0
        dl_present = 0
        dl_and_no_isbn = 0
        pre_1988 = 0
        pre_1988_rows_sample = []
        field_populated = Counter()
        field_total = 0
        dl_examples = []

        for row in reader:
            if len(row) < len(header):
                row += [""] * (len(header) - len(row))
            row_count += 1
            field_total += 1

            title = get(row, col_title) if col_title else ""
            subtitle = get(row, col_subtitle) if col_subtitle else ""
            author = get(row, col_author) if col_author else ""
            publisher = get(row, col_publisher) if col_publisher else ""
            place = get(row, col_place) if col_place else ""
            year_raw = get(row, col_year) if col_year else ""
            pages = get(row, col_pages) if col_pages else ""
            isbn_raw = get(row, col_isbn) if col_isbn else ""
            dl_raw = get(row, col_dl) if col_dl else ""
            material = get(row, col_material) if col_material else ""

            for fname, val in [("title", title), ("author", author),
                                ("publisher", publisher), ("place", place),
                                ("year", year_raw), ("pages", pages)]:
                if val:
                    field_populated[fname] += 1

            material_counter[material or "(blank)"] += 1
            classified_counter[classify_material(material, title)] += 1

            year = parse_year(year_raw)
            if year:
                decade = (year // 10) * 10
                decade_counter[decade] += 1

            isbn_found = extract_isbn(isbn_raw)
            has_isbn = bool(isbn_found) or bool(isbn_raw)
            if isbn_raw:
                isbn_present += 1

            has_dl = bool(dl_raw) and DL_HAS_DIGITS_RE.search(dl_raw)
            if has_dl:
                dl_present += 1
                if len(dl_examples) < 30:
                    dl_examples.append(dl_raw)

            if has_dl and not isbn_raw:
                dl_and_no_isbn += 1

            if year and year < 1988:
                pre_1988 += 1
                if len(pre_1988_rows_sample) < 5000:
                    pre_1988_rows_sample.append(dict(zip(header, row)))

            if max_sample_rows and row_count >= max_sample_rows:
                break

        print(f"\nTotal rows read: {row_count}")

        print("\n--- Publication year distribution by decade ---")
        for decade in sorted(decade_counter):
            print(f"  {decade}s: {decade_counter[decade]}")
        undated = row_count - sum(decade_counter.values())
        print(f"  (undated/unparseable): {undated}")

        print("\n--- ISBN presence ---")
        print(f"  Rows with non-empty ISBN field: {isbn_present} "
              f"({100 * isbn_present / row_count:.1f}%)")

        print("\n--- Legal deposit number ---")
        print(f"  Column used: {col_dl!r}")
        print(f"  Rows with a Legal deposit number: {dl_present} "
              f"({100 * dl_present / row_count:.1f}%)")
        print(f"  Rows with DL and NO ISBN: {dl_and_no_isbn} "
              f"({100 * dl_and_no_isbn / row_count:.1f}%)")
        print("  Raw DL examples:")
        for ex in dl_examples[:20]:
            print(f"    {ex!r}")

        print(f"\n--- Rows published before 1988: {pre_1988} "
              f"({100 * pre_1988 / row_count:.1f}%) ---")

        print("\n--- Field completeness ---")
        for fname in ["title", "author", "publisher", "place", "year", "pages"]:
            pct = 100 * field_populated[fname] / field_total
            print(f"  {fname:10s}: {field_populated[fname]:>8d} / {field_total} ({pct:.1f}%)")

        print("\n--- Material type breakdown (raw column values) ---")
        for mtype, count in material_counter.most_common(30):
            print(f"  {mtype!r}: {count}")

        print("\n--- Heuristic classification (periodical/map/score/book) ---")
        for cls, count in classified_counter.most_common():
            print(f"  {cls}: {count} ({100 * count / row_count:.1f}%)")

        print("\n--- 20 random pre-1988 rows, full and unmodified ---")
        sample = random.sample(pre_1988_rows_sample, min(20, len(pre_1988_rows_sample)))
        for i, r in enumerate(sample, 1):
            print(f"\n  [{i}]")
            for k, v in r.items():
                if v:
                    print(f"    {k}: {v}")

        return {
            "row_count": row_count,
            "dl_and_no_isbn": dl_and_no_isbn,
            "pre_1988": pre_1988,
            "dl_present": dl_present,
            "isbn_present": isbn_present,
        }


def main():
    random.seed(42)

    if not CATALOGO.exists():
        print(f"ERROR: {CATALOGO} not found. Download and unzip "
              f"https://opendata.bnportugal.gov.pt/docs/catalogo.csv.zip into data/ first.",
              file=sys.stderr)
        sys.exit(1)

    results = {}
    results["catalogo"] = analyze(CATALOGO, "catalogo.csv (full BNP catalogue)")

    if BIBNAC.exists():
        results["bibnac"] = analyze(BIBNAC, "bibliografianacional.csv (secondary, docs say 2002+)")
    else:
        print(f"\n(skipping bibliografianacional.csv, not found at {BIBNAC})")

    print(f"\n{'=' * 70}")
    print("DECISION GATE")
    print(f"{'=' * 70}")
    dl_no_isbn = results["catalogo"]["dl_and_no_isbn"]
    if dl_no_isbn > 50_000:
        verdict = "STRONG — build all three resolution tiers. DL path is viable."
    elif dl_no_isbn < 5_000:
        verdict = "WEAK — pilot should be ISBN-only. Keep rung 3 as a stub, email BNP."
    else:
        verdict = "IN BETWEEN — build it, expect partial coverage, report honest hit rate."
    print(f"Rows with DL and no ISBN: {dl_no_isbn}")
    print(f"Verdict: {verdict}")


if __name__ == "__main__":
    main()
