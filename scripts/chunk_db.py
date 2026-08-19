#!/usr/bin/env python3
"""
Split data/build/catalogue.sqlite3 into <100MB chunks for GitHub + write the
config.json sql.js-httpvfs needs to reassemble it via HTTP range requests.

Mirrors sql.js-httpvfs's own create_db.sh (see
https://github.com/phiresky/sql.js-httpvfs/blob/master/create_db.sh) — same
chunk naming scheme and config shape, reimplemented in Python since we don't
have a Unix `split` guaranteed on the target machine.

Usage:
    python scripts/chunk_db.py
Produces:
    db/db.sqlite3.000, db/db.sqlite3.001, ... (chunk files, committed)
    db/config.json (committed)
"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IN_DB = ROOT / "data" / "build" / "catalogue.sqlite3"
OUT_DIR = ROOT / "db"

# Must be a multiple of the database's page size (build_index.py sets 4096).
CHUNK_SIZE = 20 * 1024 * 1024  # 20 MiB — comfortably under GitHub's 100MB cap
SUFFIX_LENGTH = 3


def main():
    if not IN_DB.exists():
        print(f"ERROR: {IN_DB} not found. Run scripts/build_index.py first.", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(IN_DB)
    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
    conn.close()

    if CHUNK_SIZE % page_size != 0:
        print(f"ERROR: CHUNK_SIZE ({CHUNK_SIZE}) must be a multiple of "
              f"page_size ({page_size})", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(exist_ok=True)
    for old in OUT_DIR.glob("db.sqlite3.*"):
        old.unlink()

    total_bytes = IN_DB.stat().st_size
    n_chunks = 0
    with open(IN_DB, "rb") as f:
        while True:
            data = f.read(CHUNK_SIZE)
            if not data:
                break
            suffix = str(n_chunks).zfill(SUFFIX_LENGTH)
            chunk_path = OUT_DIR / f"db.sqlite3.{suffix}"
            chunk_path.write_bytes(data)
            n_chunks += 1

    config = {
        "serverMode": "chunked",
        "requestChunkSize": page_size,
        "databaseLengthBytes": total_bytes,
        "serverChunkSize": CHUNK_SIZE,
        # Resolved relative to config.json's own location (confirmed by
        # testing against a local server — NOT relative to the page or the
        # worker script), and config.json lives in this same db/ directory
        # as the chunks, so this must be a bare filename prefix.
        "urlPrefix": "db.sqlite3.",
        "suffixLength": SUFFIX_LENGTH,
    }
    (OUT_DIR / "config.json").write_text(json.dumps(config, indent=2))

    print(f"Wrote {n_chunks} chunks ({total_bytes / 1_048_576:.1f} MB total) to {OUT_DIR}")
    print(f"Largest chunk: {CHUNK_SIZE / 1_048_576:.0f} MB, page_size: {page_size}")


if __name__ == "__main__":
    main()
