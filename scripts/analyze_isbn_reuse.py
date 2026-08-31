#!/usr/bin/env python3
"""
How often does one ISBN cover more than one printing?

This is the empirical basis for the resolution ladder preferring Deposito
Legal over ISBN (see js/ladder.js and docs/dl-pokedex-analysis.md). The
change was originally made on a field observation -- several test books kept
the outer cover's original ISBN on a later edition while carrying a new DL --
and this quantifies it against the built catalogue.

The mechanism: DL is issued per deposit event, so each edition and reimpressao
gets its own. Portuguese publishers routinely reuse a cover ISBN across
reprints. So an ISBN identifies the title; the DL identifies the printing in
hand. Since catalogue.js's lookups are `LIMIT 1` with no `ORDER BY`, an
ISBN-first ladder returns an arbitrary printing.

Reads the built database, not the raw CSV -- these are the numbers that
describe what the app actually ships and queries.

Usage:
    python scripts/analyze_isbn_reuse.py

Results as of the 2026-08-22 build (recorded in docs/bnp-findings.md):
    rows sharing an ISBN-13        88,725  (22.7% of ISBN-bearing rows)
    ISBN-13 with >1 distinct DL    19,071  (6.7% of DL-bearing ISBNs)
    worst offender                 9789722323970, spanning 53 distinct DLs
"""
import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "build" / "catalogue.sqlite3"

HAS_ISBN = "isbn13 IS NOT NULL AND isbn13 != ''"
HAS_DL = "deposito_legal IS NOT NULL AND deposito_legal != ''"


def main():
    if not DB.exists():
        raise SystemExit(f"No built database at {DB}. Run scripts/build_index.py first.")

    con = sqlite3.connect(DB)
    one = lambda sql: con.execute(sql).fetchone()[0]

    rows_with_isbn = one(f"SELECT COUNT(*) FROM editions WHERE {HAS_ISBN}")
    distinct_isbn = one(
        f"SELECT COUNT(*) FROM (SELECT isbn13 FROM editions WHERE {HAS_ISBN} GROUP BY isbn13)"
    )
    isbn_on_many_rows = one(
        f"SELECT COUNT(*) FROM (SELECT isbn13 FROM editions WHERE {HAS_ISBN} "
        f"GROUP BY isbn13 HAVING COUNT(*) > 1)"
    )
    rows_sharing_isbn = one(
        f"SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) n FROM editions "
        f"WHERE {HAS_ISBN} GROUP BY isbn13 HAVING COUNT(*) > 1)"
    )
    distinct_isbn_with_dl = one(
        f"SELECT COUNT(*) FROM (SELECT isbn13 FROM editions "
        f"WHERE {HAS_ISBN} AND {HAS_DL} GROUP BY isbn13)"
    )
    isbn_many_dls = one(
        f"SELECT COUNT(*) FROM (SELECT isbn13 FROM editions "
        f"WHERE {HAS_ISBN} AND {HAS_DL} GROUP BY isbn13 "
        f"HAVING COUNT(DISTINCT deposito_legal) > 1)"
    )

    pct = lambda a, b: (a / b * 100) if b else 0.0

    print("=== One ISBN, many printings ===\n")
    print(f"Rows with an ISBN-13                : {rows_with_isbn:,}")
    print(f"Distinct ISBN-13                    : {distinct_isbn:,}")
    print(
        f"ISBN-13 appearing on >1 row         : {isbn_on_many_rows:,} "
        f"({pct(isbn_on_many_rows, distinct_isbn):.1f}% of distinct)"
    )
    print(
        f"Rows sharing an ISBN-13             : {rows_sharing_isbn:,} "
        f"({pct(rows_sharing_isbn, rows_with_isbn):.1f}% of ISBN-bearing rows)"
    )
    print()
    print(f"Distinct ISBN-13 that also have a DL: {distinct_isbn_with_dl:,}")
    print(
        f"  ...mapping to >1 DISTINCT DL      : {isbn_many_dls:,} "
        f"({pct(isbn_many_dls, distinct_isbn_with_dl):.1f}% of those)"
    )

    print("\nWorst offenders (ISBN-13, distinct DL count):")
    for isbn, n in con.execute(
        f"SELECT isbn13, COUNT(DISTINCT deposito_legal) n FROM editions "
        f"WHERE {HAS_ISBN} AND {HAS_DL} GROUP BY isbn13 ORDER BY n DESC LIMIT 5"
    ):
        print(f"    {isbn}  ->  {n} distinct DL numbers")

    # The worked example used in the docs: one ISBN, four printings, four DLs.
    print("\nWorked example -- ISBN 9789724121741:")
    for row in con.execute(
        "SELECT bnp_record_id, edition, year, deposito_legal FROM editions "
        "WHERE isbn13 = '9789724121741' ORDER BY year"
    ):
        print("    record {0}  {1:<8} {2}  DL {3}".format(*row))
    print(
        "\n  catalogue.js looks these up with LIMIT 1 and no ORDER BY, so an\n"
        "  ISBN-keyed scan of this book returns an arbitrary one of the four."
    )

    con.close()


if __name__ == "__main__":
    main()
