// Location capture. Coordinates are rounded to 1 decimal place (~11km
// cells) at capture time and the exact coordinate is never stored — see
// App.util.roundCoord and the spec's privacy requirement.
//
// Location can come from two places, both producing identical
// {lat_rounded, lon_rounded} shapes:
//   - GPS, via an explicitly user-initiated request (the Capture screen's
//     location banner), never a blind automatic prompt. See requestLocation.
//   - A manually searched-and-picked Portuguese freguesia (civil parish —
//     real neighborhood/small-town names, not just a district capital), for
//     users who keep GPS off at the OS level — where no amount of prompting
//     helps, because the block is above the page (see PERMISSION LAYERS
//     below). Data is assets/pt-locations.json, built by
//     scripts/build_locations.py from GeoNames (CC-BY 4.0 — see README).
//
// PERMISSION LAYERS. Location permission is three layers deep and a web
// page only occupies the bottom one:
//   1. Device master switch  (iOS: Settings > Privacy > Location Services)
//   2. Browser app permission (Location Services > Safari > Never/Ask/...)
//   3. Per-site permission    (the prompt this page can trigger, once)
// If 1 or 2 block, getCurrentPosition just fails and the user has to fix it
// in OS settings — the page cannot prompt for, detect, or repair that. It
// also cannot reliably tell "user denied this site" from "OS location is
// off": iOS reports these inconsistently. That's why the manual district
// fallback exists, and why recovery copy names both causes rather than
// asserting one.
window.App = window.App || {};

App.geo = (function () {
  const MANUAL_KEY = "pt-book-encounters-manual-location";
  const LOCATIONS_URL = "assets/pt-locations.json";

  let locationsPromise = null;

  // Lazy-loaded once (176KB, 3259 freguesias) and cached — only fetched the
  // first time the manual picker is actually opened, not on every page load.
  function loadLocations() {
    if (!locationsPromise) {
      locationsPromise = fetch(LOCATIONS_URL).then((r) => {
        if (!r.ok) throw new Error("could not load " + LOCATIONS_URL);
        return r.json();
      });
    }
    return locationsPromise;
  }

  // Diacritic-insensitive search over location names, reusing the same
  // normalization the BNP title search uses (App.util.normText) — so
  // "sao joao" correctly finds "São João" the same way title search already
  // tolerates Portuguese accents.
  //
  // Ranked in four tiers, cheapest/most-specific first — this exists
  // because a naive "contains the query" search, tried first, put an
  // obscure parish ("Terrugem (Sintra)") above the actual Sintra entry for
  // the query "sintra": the query only matched inside the disambiguation
  // suffix, not the real name. Confirmed by testing several town searches,
  // not assumed:
  //   0. exact match on the base name (before any " (" suffix)
  //   1. base name starts with the query
  //   2. base name contains the query
  //   3. only the parenthetical disambiguation suffix contains the query
  // Ties within a tier go to the shorter overall name (more likely what a
  // short query meant).
  async function searchLocations(query, limit) {
    const locations = await loadLocations();
    const q = App.util.normText(query);
    if (!q) return [];
    const scored = [];
    for (const loc of locations) {
      const parenIdx = loc.name.indexOf(" (");
      const base = parenIdx === -1 ? loc.name : loc.name.slice(0, parenIdx);
      const nBase = App.util.normText(base);
      const nFull = App.util.normText(loc.name);

      let tier;
      if (nBase === q) tier = 0;
      else if (nBase.startsWith(q)) tier = 1;
      else if (nBase.indexOf(q) !== -1) tier = 2;
      else if (nFull.indexOf(q) !== -1) tier = 3;
      else continue;

      scored.push({ loc, tier, len: loc.name.length });
    }
    scored.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.len - b.len));
    return scored.slice(0, limit || 8).map((s) => s.loc);
  }

  // Dev/testing helper only (the Log view's "Add random test locations"
  // button) — n random points drawn from the same real Portuguese
  // concelho/freguesia gazetteer the manual picker searches, already
  // rounded the same way a real GPS or manual pick is. Reusing real
  // places (rather than a random lat/lon within some bounding box) means
  // every point lands somewhere real and inside the density map's actual
  // land outline, not scattered into the sea or a to-scale-irrelevant
  // corner of the bounding box.
  async function randomTestLocations(n) {
    const locations = await loadLocations();
    const picks = [];
    for (let i = 0; i < n; i++) {
      const loc = locations[Math.floor(Math.random() * locations.length)];
      picks.push({ lat_rounded: App.util.roundCoord(loc.lat), lon_rounded: App.util.roundCoord(loc.lon) });
    }
    return picks;
  }

  // Resolves { ok: true, lat_rounded, lon_rounded } on success, or
  // { ok: false, reason } on failure — never rejects, so a caller can just
  // await it without a try/catch. reason is one of "unsupported",
  // "denied", "timeout", "unavailable", so callers can tell the user
  // something more useful than silent nulls.
  function getRoundedLocation(timeoutMs) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ ok: false, reason: "unsupported" });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            ok: true,
            lat_rounded: App.util.roundCoord(pos.coords.latitude),
            lon_rounded: App.util.roundCoord(pos.coords.longitude),
          });
        },
        (err) => {
          // GeolocationPositionError.code: 1=PERMISSION_DENIED,
          // 2=POSITION_UNAVAILABLE, 3=TIMEOUT.
          const reason = err.code === 1 ? "denied" : err.code === 3 ? "timeout" : "unavailable";
          console.warn("Geolocation failed (" + reason + "):", err.message);
          resolve({ ok: false, reason });
        },
        { timeout: timeoutMs || 8000, maximumAge: 300000 }
      );
    });
  }

  // Best-effort only. Returns "granted" | "prompt" | "denied" | "unknown".
  //
  // DO NOT TRUST "denied" (or a missing API) FROM THIS. Safari has a
  // documented inconsistency where permissions.query reports "prompt" even
  // when the site permission is actually set to Deny. Use this to skip
  // asking again when it says "granted" — never to decide something is
  // blocked, and never to skip a real attempt. The GeolocationPositionError
  // from an actual getCurrentPosition call is the only reliable truth.
  async function getPermissionState() {
    if (!navigator.permissions || !navigator.permissions.query) return "unknown";
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      return status.state || "unknown";
    } catch (err) {
      return "unknown"; // some browsers reject unsupported permission names
    }
  }

  // An explicitly user-initiated GPS request — only ever called from the
  // location banner's Enable button. This deliberately replaces the old
  // primePermission(), which fired getCurrentPosition automatically when
  // the camera opened: the native prompt is effectively one-shot (once
  // denied a page can never re-trigger it), so spending it with no
  // explanation is the standard anti-pattern.
  function requestLocation() {
    return getRoundedLocation(10000);
  }

  // --- manual location (a searched-and-picked freguesia) ---
  //
  // The whole {name, lat, lon} object is persisted directly, not a key into
  // a lookup table — unlike the earlier ~20-entry district list, the full
  // 3259-entry dataset isn't something worth keeping loaded just to redisplay
  // the current pick.

  function setManualLocation(location) {
    if (!location || typeof location.lat !== "number" || typeof location.lon !== "number") return false;
    try {
      localStorage.setItem(MANUAL_KEY, JSON.stringify(location));
    } catch (err) {
      return false; // private mode etc. — caller falls back to no location
    }
    return true;
  }

  function getManualLocation() {
    let raw;
    try {
      raw = localStorage.getItem(MANUAL_KEY);
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    let location;
    try {
      location = JSON.parse(raw);
    } catch (err) {
      return null; // corrupt stored value — treat as unset rather than throw
    }
    return {
      ok: true,
      lat_rounded: App.util.roundCoord(location.lat),
      lon_rounded: App.util.roundCoord(location.lon),
      location,
    };
  }

  function clearManualLocation() {
    try {
      localStorage.removeItem(MANUAL_KEY);
    } catch (err) {
      /* nothing to do */
    }
  }

  // --- the single entry point saveEncounter uses ---

  // GPS first (fresh reading, only attempted when permission is already
  // granted — never triggers a prompt from inside a save), else the manual
  // district, else no location. Always resolves; logging must never be
  // blocked on identification OR location.
  //
  // Includes `source: "gps" | "manual"` so the encounter can record where
  // its coordinates came from — the spec's "mark the source on every
  // record" rule applies to a hand-picked coordinate just as much as to
  // OCR- or network-derived bibliographic data.
  async function resolveLocationForSave() {
    const state = await getPermissionState();
    if (state === "granted") {
      const gps = await getRoundedLocation(8000);
      if (gps.ok) return Object.assign({ source: "gps" }, gps);
      // fall through to manual — a granted permission can still fail to get
      // an actual fix (no signal indoors, airplane mode, etc.)
    }
    const manual = getManualLocation();
    if (manual) return Object.assign({ source: "manual" }, manual);
    return { ok: false, reason: state === "granted" ? "unavailable" : "not-enabled" };
  }

  return {
    getRoundedLocation,
    getPermissionState,
    requestLocation,
    resolveLocationForSave,
    searchLocations,
    randomTestLocations,
    setManualLocation,
    getManualLocation,
    clearManualLocation,
  };
})();
