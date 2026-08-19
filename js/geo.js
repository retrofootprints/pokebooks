// Location capture: ask once via the standard permission prompt, round to
// 1 decimal place at capture time, never store the precise coordinate.
window.App = window.App || {};

App.geo = (function () {
  function getRoundedLocation(timeoutMs) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            lat_rounded: App.util.roundCoord(pos.coords.latitude),
            lon_rounded: App.util.roundCoord(pos.coords.longitude),
          });
        },
        () => resolve(null), // denied or unavailable — work fine without it
        { timeout: timeoutMs || 8000, maximumAge: 300000 }
      );
    });
  }

  return { getRoundedLocation };
})();
