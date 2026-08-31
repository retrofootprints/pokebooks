#!/usr/bin/env python3
"""
Probe the BNP / PORBASE URN resolver from the server side.

Run this when something about the resolver might have changed -- in
particular when BNP answers either of the two questions in docs/bnp-findings.md
(addendum, section 7):

    1. Do the hosts now send Access-Control-Allow-Origin? If so, the browser
       can call them directly and js/network.js's BNP/PORBASE path becomes
       live with no proxy and no code change.
    2. Whether the identifier schemes still resolve, in particular `ndl`
       (numero de deposito legal), which is undocumented and was found by
       guessing -- so it could change without notice.

This runs server-side deliberately: CORS is enforced by browsers, not
servers, so this script sees the responses the app cannot.

Usage:
    python scripts/probe_urn.py

Findings as of 2026-08-31 (see docs/bnp-findings.md addendum):
  - Request shape is /{scheme}/{schema}/{serialization}?id={value}. Omitting
    the schema/serialization segments gives "nao contem forma".
  - Hyphenated and unhyphenated ISBNs both resolve.
  - PORBASE uses the identical interface.
  - Deposito Legal resolves under scheme `ndl` on both hosts. /dl/,
    /depositolegal/, /deposito-legal/ and /stock/ all 404. /cota/ is valid.
  - Neither host sends Access-Control-Allow-Origin. This is now the ONLY
    thing keeping js/network.js's BNP/PORBASE path from working.
"""
import re
import urllib.error
import urllib.request

HOSTS = ["urn.bnportugal.gov.pt", "urn.porbase.org"]

# A book known to be in both catalogues (four printings share this ISBN --
# see scripts/analyze_isbn_reuse.py).
ISBN_HYPHENATED = "978-972-41-2174-1"
ISBN_PLAIN = "9789724121741"

# The DL carried by BNP record 1731654, as <identifier type="stock">.
KNOWN_DL = "272507/08"

# `ndl` (numero de deposito legal) is the one that works, as of 2026-08-31.
# The rest are kept so a regression shows up as the working one going quiet
# rather than as a silent behaviour change.
DL_SCHEME_GUESSES = ["ndl", "dl", "depositolegal", "deposito-legal", "stock", "cota"]

UA = "pt-book-encounter-pilot/0.1 (single-user pilot; contact via GitHub repo)"
TIMEOUT = 20


def fetch(url, limit=400):
    """Returns (status, cors_header_or_None, body_prefix). Never raises.

    Only the first `limit` bytes are read -- enough to classify the response.
    Pass a larger limit when a field deeper in the record is needed.
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(limit).decode("utf-8", errors="replace")
            return r.status, r.headers.get("Access-Control-Allow-Origin"), body
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Access-Control-Allow-Origin"), ""
    except Exception as e:  # DNS, TLS, timeout
        return None, None, f"({type(e).__name__}: {e})"


def verdict(body):
    if "Registo inexistente" in body:
        return "valid request, no matching record"
    if "nao contem forma" in body or "não contém forma" in body:
        return "MALFORMED -- missing schema/serialization segments"
    if "<error>" in body:
        return "error response"
    if "<mods" in body:
        return "RECORD"
    return "unrecognised"


def main():
    print("=== 1. Does the documented request shape still work? ===\n")
    for host in HOSTS:
        for label, isbn in (("hyphenated", ISBN_HYPHENATED), ("plain", ISBN_PLAIN)):
            url = f"https://{host}/isbn/mods/xml?id={isbn}"
            status, cors, body = fetch(url)
            print(f"  {host:26} {label:11} -> {status}  {verdict(body)}")

    print("\n=== 2. The old (wrong) shape, for contrast ===\n")
    for host in HOSTS:
        status, cors, body = fetch(f"https://{host}/isbn/{ISBN_PLAIN}")
        print(f"  {host:26} /isbn/{{isbn}}   -> {status}  {verdict(body)}")

    print("\n=== 3. CORS -- the blocker for browser use ===\n")
    for host in HOSTS:
        status, cors, _ = fetch(f"https://{host}/isbn/mods/xml?id={ISBN_PLAIN}")
        if cors:
            print(f"  {host:26} Access-Control-Allow-Origin: {cors}")
            print(f"  {'':26} ^^ CHANGED. The browser path may now work directly;")
            print(f"  {'':26}    see js/network.js's header comment.")
        else:
            print(f"  {host:26} no Access-Control-Allow-Origin (browser-blocked)")

    print("\n=== 4. Hunting the Deposito Legal scheme name ===\n")
    found = []
    for host in HOSTS:
        for scheme in DL_SCHEME_GUESSES:
            url = f"https://{host}/{scheme}/mods/xml?id={KNOWN_DL}"
            status, _, body = fetch(url)
            hit = status == 200 and "<mods" in body
            if hit:
                found.append((host, scheme))
            print(f"  {host:26} /{scheme:16} -> {status}  {verdict(body) if body else ''}")

    if found:
        print("\n  Working DL schemes:")
        for host, scheme in found:
            print(f"    {host} -> /{scheme}/mods/xml?id=")
        if not any(scheme == "ndl" for _, scheme in found):
            print("\n  WARNING: `ndl` no longer resolves. js/network.js's")
            print("  lookupByDL hardcodes it -- update it to a scheme above.")
    else:
        print("\n  NO DL scheme resolves any more. js/network.js's lookupByDL")
        print("  hardcodes `ndl` and is now broken -- see docs/bnp-findings.md")
        print("  addendum sections 4 and 7.")

    print("\n=== 5. Does DL actually disambiguate printings? ===\n")
    # The claim the whole resolution ladder rests on: these two DLs are
    # different printings of one ISBN (9789724121741). See
    # scripts/analyze_isbn_reuse.py.
    for dl in ("272507/08", "308831/10"):
        _, _, body = fetch(f"https://{HOSTS[0]}/ndl/mods/xml?id={dl}", limit=20000)
        rec = re.search(r"<recordIdentifier[^>]*>(\d+)<", body)
        ed = re.search(r"<edition>([^<]*)</edition>", body)
        print(
            f"  DL {dl} -> record {rec.group(1) if rec else '?'}, "
            f"edition {ed.group(1) if ed else '?'}"
        )
    print("\n  Both share ISBN 9789724121741. An ISBN query returns one of")
    print("  them arbitrarily; the DL query returns the printing asked for.")


if __name__ == "__main__":
    main()
