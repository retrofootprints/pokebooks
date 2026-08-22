#!/usr/bin/env python3
"""
Build the searchable Portuguese location list used by the manual location
picker (js/geo.js's searchLocations) — concelhos (municipalities) AND
freguesias (civil parishes) combined into one searchable set, disambiguated
by parent concelho where freguesia names collide.

Source: GeoNames.org's per-country export (CC-BY 4.0 — see the attribution
this script prints and that belongs in the README). Downloaded once into
data/ (gitignored) and cached there on re-runs.

WHY BOTH LEVELS, NOT JUST FREGUESIAS (freguesia-only was the first attempt
and shipped with a real bug found by testing, not reasoning): Portugal's
2013 parish mergers renamed many freguesias into "União das freguesias de
X (Y, Z)" compounds, or gave them names that don't contain their city's name
at all — Lisbon's own parishes are "Alvalade", "Arroios", "Santa Maria
Maior", etc., none containing the word "Lisboa". Searching "Lisboa" against
freguesias alone returns ZERO results — confirmed empirically, not assumed.
Concelho names are exactly the fix: always present, always unique (0
collisions among the 308), and exactly what most searches will actually be
for ("Porto", "Sintra", "Cascais"). Freguesias still matter for real
neighborhood/small-town recall beyond the municipal seat. So: both, one
combined, de-duplicated list.

Every coordinate in the output is pre-rounded to 1 decimal (round_coord
below), same precision as App.util.roundCoord — a manual pick and a real
GPS fix end up in the same ballpark of precision, so there's no advantage
to shipping more digits here; it just keeps the committed file's numbers
small. NOTE: since js/geo.js started rounding longitude to 0.13 degrees
(App.util.roundLon, not the same step as latitude — see that function's
comment for why) rather than 0.1, this file's 0.1-rounded longitudes get
rounded a second time at save. Harmless (every picked location still lands
in the correct 0.13 bucket) but not exact — if this script's own
precision ever needs to match app precision exactly, round_coord's 1
decimal here is coarser than necessary for longitude specifically.

Usage:
    python scripts/build_locations.py
Produces:
    assets/pt-locations.json
"""
import csv
import json
import sys
import zipfile
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parent.parent
CACHE_ZIP = ROOT / "data" / "geonames_PT.zip"
CACHE_TXT = ROOT / "data" / "geonames_PT.txt"
CACHE_ADMIN1 = ROOT / "data" / "geonames_admin1_PT.txt"
OUT = ROOT / "assets" / "pt-locations.json"

SOURCE_URL = "https://download.geonames.org/export/dump/PT.zip"
ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"

# geoname table columns (see readme.txt in the zip):
GEONAMEID, NAME, ASCIINAME, ALTNAMES, LAT, LON, FCLASS, FCODE = range(8)
ADMIN1, ADMIN2 = 10, 11

# GeoNames' primary `name` field is occasionally the English form rather
# than Portuguese — found by inspection (checked all 308 concelho names and
# the 19 admin1/district names against a manual watchlist), not assumed.
# Add more here if a future rebuild turns up others.
PT_NAME_OVERRIDES = {
    "Lisbon": "Lisboa",
    "Azores": "Açores",
}


def round_coord(n):
    return round(n * 10) / 10


def pt_name(name):
    name = PT_NAME_OVERRIDES.get(name, name)
    # GeoNames' primary name field is inconsistent about this — every other
    # concelho's primary name is the plain city name with "X Municipality"
    # only in the alternate-names list, except Bragança, whose primary name
    # field is literally "Bragança Municipality". Strip the suffix
    # generically (checked: only one row currently has it, but this is
    # cheap insurance against a future GeoNames update adding more).
    if name.endswith(" Municipality"):
        name = name[: -len(" Municipality")]
    return name


def download_if_needed():
    if not CACHE_TXT.exists():
        CACHE_ZIP.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {SOURCE_URL} (~1.1 MB)...")
        urlretrieve(SOURCE_URL, CACHE_ZIP)
        with zipfile.ZipFile(CACHE_ZIP) as z:
            z.extract("PT.txt", CACHE_TXT.parent)
        (CACHE_TXT.parent / "PT.txt").rename(CACHE_TXT)
        print(f"Extracted to {CACHE_TXT}")
    else:
        print(f"Using cached {CACHE_TXT.name}")

    if not CACHE_ADMIN1.exists():
        print(f"Downloading {ADMIN1_URL}...")
        all_admin1, _ = urlretrieve(ADMIN1_URL)
        with open(all_admin1, encoding="utf-8") as src, open(CACHE_ADMIN1, "w", encoding="utf-8") as dst:
            for line in src:
                if line.startswith("PT."):
                    dst.write(line)
    else:
        print(f"Using cached {CACHE_ADMIN1.name}")


def main():
    download_if_needed()

    admin1_name = {}  # admin1 code -> district/region name
    with open(CACHE_ADMIN1, encoding="utf-8") as f:
        for line in f:
            code, name, _ascii, _id = line.rstrip("\n").split("\t")
            admin1_name[code.split(".")[1]] = pt_name(name)

    concelho_by_key = {}  # (admin1, admin2) -> (name, lat, lon)
    freguesias = []  # [(name, admin1, admin2, lat, lon)]

    with open(CACHE_TXT, encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            if row[FCLASS] != "A":
                continue
            if row[FCODE] == "ADM2":
                concelho_by_key[(row[ADMIN1], row[ADMIN2])] = (pt_name(row[NAME]), float(row[LAT]), float(row[LON]))
            elif row[FCODE] == "ADM3":
                freguesias.append((row[NAME], row[ADMIN1], row[ADMIN2], float(row[LAT]), float(row[LON])))

    print(f"Concelhos (municipalities): {len(concelho_by_key)}")
    print(f"Freguesias (civil parishes): {len(freguesias)}")

    name_counts = {}
    for name, *_ in freguesias:
        name_counts[name] = name_counts.get(name, 0) + 1

    # Concelho names are unique among themselves with one known real-world
    # exception: Portugal has two municipalities both named "Lagoa" (one in
    # the Algarve, one in the Açores) — confirmed by running this script,
    # not assumed going in. Disambiguated the same way as freguesia
    # collisions, but by district (admin1) instead of concelho, since that's
    # the level at which they actually differ.
    concelho_name_counts = {}
    for (_a1, _a2), (name, _lat, _lon) in concelho_by_key.items():
        concelho_name_counts[name] = concelho_name_counts.get(name, 0) + 1

    out = []
    seen_names = set()
    for (a1, _a2), (name, lat, lon) in concelho_by_key.items():
        display = name
        if concelho_name_counts[name] > 1:
            district = admin1_name.get(a1)
            if district:
                display = f"{name} ({district})"
        out.append({"name": display, "lat": round_coord(lat), "lon": round_coord(lon)})
        seen_names.add(display)

    skipped_redundant = 0
    for name, a1, a2, lat, lon in freguesias:
        display = name
        if name_counts[name] > 1:
            concelho = concelho_by_key.get((a1, a2))
            concelho_name = concelho[0] if concelho else None
            if concelho_name and concelho_name != name:
                display = f"{name} ({concelho_name})"
        # Drop a freguesia entry that is now an exact duplicate of something
        # already in the list — most commonly the seat parish sharing its
        # concelho's own name (e.g. a "Loures" freguesia inside "Loures"
        # concelho): the concelho entry already covers that point, a second
        # identically-named row would just look like a glitch to the user.
        if display in seen_names:
            skipped_redundant += 1
            continue
        seen_names.add(display)
        out.append({"name": display, "lat": round_coord(lat), "lon": round_coord(lon)})

    out.sort(key=lambda d: d["name"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size_kb = OUT.stat().st_size / 1024
    print(f"\nWrote {OUT} ({len(out)} entries, {size_kb:.1f} KB)")
    print(f"Freguesia name collisions disambiguated: {sum(1 for n, c in name_counts.items() if c > 1)}")
    print(f"Freguesia entries dropped as redundant with their concelho: {skipped_redundant}")

    remaining_names = [d["name"] for d in out]
    remaining_dupes = {n for n in remaining_names if remaining_names.count(n) > 1}
    if remaining_dupes:
        print(f"WARNING: {len(remaining_dupes)} display names are still not unique: "
              f"{sorted(remaining_dupes)}", file=sys.stderr)
    else:
        print("All display names unique.")
    print("\nAttribution required (CC-BY 4.0): GeoNames.org — add to README if not already present.")


if __name__ == "__main__":
    main()
