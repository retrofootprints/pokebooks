// Location capture: ask once via the standard permission prompt, round to
// 1 decimal place at capture time, never store the precise coordinate.
window.App = window.App || {};

App.geo = (function () {
  // Resolves { ok: true, lat_rounded, lon_rounded } on success, or
  // { ok: false, reason } on failure — never rejects, so a caller can just
  // await it without a try/catch. reason is one of "unsupported",
  // "denied", "timeout", "unavailable", so callers can tell the user
  // something more useful than silent nulls (this used to just resolve
  // `null` on any failure, which is how a user could scan a dozen books,
  // see no map data, and have no way to tell why).
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

  // Fire-and-forget: triggers the browser's native permission prompt (if
  // the user hasn't already decided) at the moment the camera opens,
  // alongside the camera permission prompt — a moment the user already
  // expects to be asked for something, rather than silently and invisibly
  // deep inside the save flow, where a prompt is easy to miss or dismiss
  // without noticing what it was for. Once decided, later
  // getRoundedLocation() calls at save time just reuse that decision
  // instantly, no new prompt.
  function primePermission() {
    getRoundedLocation(4000);
  }

  return { getRoundedLocation, primePermission };
})();
