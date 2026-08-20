#!/usr/bin/env python3
"""
Build the Portugal outline used by the encounter density map (js/map.js).

Downloads Natural Earth 1:10m admin-0 countries (public domain), extracts the
Portugal feature, and splits its polygons into three geographic groups —
mainland, Madeira, Azores — because they cannot share one map extent: the
mainland spans ~3.3 degrees of longitude while the full territory spans ~25,
which would squash the mainland into an unreadable sliver. The map renders
the mainland at full size and the island groups as insets.

The whole Portugal geometry is only ~1255 coordinates, so no Douglas-Peucker
simplification is needed — rounding to 3 decimals (~100m, far below the map's
11km cell size) is enough to keep the output small.

Usage:
    python scripts/build_geodata.py
Produces:
    assets/portugal-outline.json   (committed — the page needs it)
Caches:
    data/ne_10m_admin_0_countries.geojson   (gitignored, re-used on re-runs)
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "ne_10m_admin_0_countries.geojson"
OUT = ROOT / "assets" / "portugal-outline.json"

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_10m_admin_0_countries.geojson"
)

# Lon/lat windows that separate the three groups. The Portugal feature's
# polygons fall into well-separated clusters (verified against the source
# data): mainland ~-9.5..-6.2, Madeira ~-17.2..-16.3, Azores ~-31.3..-25.0.
#
# The latitude bounds are what exclude the Selvagens (two uninhabited islet
# groups at lat ~30.0-30.2, administratively part of Madeira but ~250km south
# of it). They are a nature reserve with no permanent population, so no book
# will ever be encountered there — and including them stretches the Madeira
# inset's bbox from 0.6 to 3.1 degrees of latitude, rendering the inset as
# mostly empty ocean. Dropping them is a cartographic choice, not a data bug.
GROUPS = {
    "mainland": {"lon": (-10.0, -6.0), "lat": (36.0, 43.0)},
    "madeira": {"lon": (-17.5, -16.0), "lat": (32.0, 33.5)},
    "azores": {"lon": (-32.0, -24.0), "lat": (36.0, 40.0)},
}

COORD_PRECISION = 3


def download_if_needed():
    if CACHE.exists():
        print(f"Using cached {CACHE.name} ({CACHE.stat().st_size / 1_048_576:.1f} MB)")
        return
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {SOURCE_URL} (~13 MB)...")
    urllib.request.urlretrieve(SOURCE_URL, CACHE)
    print(f"Saved to {CACHE}")


def find_portugal(geo):
    for feature in geo["features"]:
        props = feature["properties"]
        name = props.get("NAME") or props.get("ADMIN") or ""
        if "ortugal" in str(name):
            return feature
    raise SystemExit("ERROR: Portugal feature not found in the Natural Earth data.")


def classify(ring):
    """Return the group name for a ring, based on its mean position."""
    lons = [pt[0] for pt in ring]
    lats = [pt[1] for pt in ring]
    mean_lon = sum(lons) / len(lons)
    mean_lat = sum(lats) / len(lats)
    for group, win in GROUPS.items():
        lon_lo, lon_hi = win["lon"]
        lat_lo, lat_hi = win["lat"]
        if lon_lo <= mean_lon <= lon_hi and lat_lo <= mean_lat <= lat_hi:
            return group
    return None


def round_ring(ring):
    return [
        [round(pt[0], COORD_PRECISION), round(pt[1], COORD_PRECISION)]
        for pt in ring
    ]


def bbox_of(polygons):
    lons = [pt[0] for poly in polygons for ring in poly for pt in ring]
    lats = [pt[1] for poly in polygons for ring in poly for pt in ring]
    return [min(lons), min(lats), max(lons), max(lats)]


def main():
    download_if_needed()

    print("Reading Natural Earth data...")
    with open(CACHE, encoding="utf-8") as f:
        geo = json.load(f)

    feature = find_portugal(geo)
    geom = feature["geometry"]
    raw_polys = (
        geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    )

    groups = {name: [] for name in GROUPS}
    skipped = 0
    for poly in raw_polys:
        # poly is a list of rings; ring 0 is the outer boundary. Portugal has
        # no holes, but rings are preserved as-is rather than assuming that.
        group = classify(poly[0])
        if group is None:
            skipped += 1
            continue
        groups[group].append([round_ring(ring) for ring in poly])

    out = {
        "source": "Natural Earth 1:10m admin-0 countries (public domain)",
        "source_url": SOURCE_URL,
        "note": (
            "Portugal outline split into three groups; they cannot share one "
            "map extent. Coordinates are [lon, lat], rounded to "
            f"{COORD_PRECISION} decimals."
        ),
        "groups": {},
    }

    for name, polys in groups.items():
        if not polys:
            print(f"WARNING: group {name!r} came out empty", file=sys.stderr)
            continue
        out["groups"][name] = {"bbox": bbox_of(polys), "polygons": polys}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    size_kb = OUT.stat().st_size / 1024
    print(f"\nWrote {OUT} ({size_kb:.1f} KB)")
    for name, data in out["groups"].items():
        n_pts = sum(len(ring) for poly in data["polygons"] for ring in poly)
        lon0, lat0, lon1, lat1 = data["bbox"]
        print(
            f"  {name:9s} {len(data['polygons']):2d} polys, {n_pts:5d} pts, "
            f"lon {lon0:.2f}..{lon1:.2f}  lat {lat0:.2f}..{lat1:.2f}"
        )
    if skipped:
        print(
            f"  ({skipped} polygon(s) outside all group windows, skipped — "
            f"expected: these are the uninhabited Selvagens islets, see GROUPS)"
        )


if __name__ == "__main__":
    main()
