// Location capture. Coordinates are rounded to 1 decimal place (~11km
// cells) at capture time and the exact coordinate is never stored — see
// App.util.roundCoord and the spec's privacy requirement.
//
// Location can come from two places, both producing identical
// {lat_rounded, lon_rounded} shapes:
//   - GPS, via an explicitly user-initiated request (the Capture screen's
//     location banner), never a blind automatic prompt. See requestLocation.
//   - A manually picked Portuguese district, for users who keep GPS off at
//     the OS level — where no amount of prompting helps, because the block
//     is above the page (see PERMISSION LAYERS below).
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

  // Portuguese districts (18 mainland) + the two autonomous regions, each
  // with its capital's coordinates. Passed through App.util.roundCoord like
  // any GPS reading, so a manual pick is indistinguishable in precision
  // from a real fix — at 0.1 degrees (~11km) a district capital lands in
  // the same cell GPS would give anyone in that city, which is exactly why
  // this fallback costs nothing at the precision this app keeps.
  //
  // Names stay in Portuguese in both UI languages: they're proper nouns,
  // and "Lisboa"/"Açores" read correctly in an app about Portuguese books.
  // Not a missing translation.
  const DISTRICTS = [
    { key: "aveiro", name: "Aveiro", lat: 40.64, lon: -8.65 },
    { key: "beja", name: "Beja", lat: 38.02, lon: -7.86 },
    { key: "braga", name: "Braga", lat: 41.55, lon: -8.43 },
    { key: "braganca", name: "Bragança", lat: 41.81, lon: -6.76 },
    { key: "castelo-branco", name: "Castelo Branco", lat: 39.82, lon: -7.49 },
    { key: "coimbra", name: "Coimbra", lat: 40.21, lon: -8.43 },
    { key: "evora", name: "Évora", lat: 38.57, lon: -7.91 },
    { key: "faro", name: "Faro", lat: 37.02, lon: -7.93 },
    { key: "guarda", name: "Guarda", lat: 40.54, lon: -7.27 },
    { key: "leiria", name: "Leiria", lat: 39.74, lon: -8.81 },
    { key: "lisboa", name: "Lisboa", lat: 38.72, lon: -9.14 },
    { key: "portalegre", name: "Portalegre", lat: 39.29, lon: -7.43 },
    { key: "porto", name: "Porto", lat: 41.15, lon: -8.61 },
    { key: "santarem", name: "Santarém", lat: 39.24, lon: -8.69 },
    { key: "setubal", name: "Setúbal", lat: 38.52, lon: -8.89 },
    { key: "viana-do-castelo", name: "Viana do Castelo", lat: 41.69, lon: -8.83 },
    { key: "vila-real", name: "Vila Real", lat: 41.3, lon: -7.74 },
    { key: "viseu", name: "Viseu", lat: 40.66, lon: -7.91 },
    { key: "madeira", name: "Madeira", lat: 32.65, lon: -16.91 },
    { key: "acores", name: "Açores", lat: 37.74, lon: -25.68 },
  ];

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

  // --- manual district ---

  function districts() {
    return DISTRICTS;
  }

  function findDistrict(key) {
    return DISTRICTS.find((d) => d.key === key) || null;
  }

  function setManualLocation(key) {
    if (!findDistrict(key)) return false;
    try {
      localStorage.setItem(MANUAL_KEY, key);
    } catch (err) {
      return false; // private mode etc. — caller falls back to no location
    }
    return true;
  }

  function getManualLocationKey() {
    try {
      return localStorage.getItem(MANUAL_KEY);
    } catch (err) {
      return null;
    }
  }

  function getManualLocation() {
    const d = findDistrict(getManualLocationKey());
    if (!d) return null;
    return {
      ok: true,
      lat_rounded: App.util.roundCoord(d.lat),
      lon_rounded: App.util.roundCoord(d.lon),
      district: d,
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
    districts,
    findDistrict,
    setManualLocation,
    getManualLocation,
    getManualLocationKey,
    clearManualLocation,
  };
})();
