// Encounter density map. Renders Portugal with the 0.1-degree cells that
// contain encounters shaded by how many.
//
// Two things here are deliberate and easy to get wrong if edited:
//
// 1. CELLS ARE CENTRED, NOT CORNER-ANCHORED. App.util.roundCoord is
//    Math.round(n * 10) / 10, so a stored 39.5 means a cell *centred* on
//    39.5, spanning 39.45-39.55. Each rect spans value +/- 0.05. Drawing
//    value -> value + 0.1 would shift every cell half a cell north-east.
//
// 2. CELLS, NEVER POINTS. The stored precision IS 0.1 degrees (~11km N-S at
//    Portuguese latitudes) because the spec requires the true coordinate is
//    never stored. Drawing a dot would imply a precision that was
//    deliberately discarded — the mark must stay cell-sized.
//
// 3. THE MARK IS A SQUARE INSCRIBED IN THE CELL, NOT THE CELL ITSELF. A
//    0.1x0.1 degree bin is not square on the ground: a degree of longitude
//    shrinks by cos(latitude), so at Portuguese latitudes the cell is
//    ~11.1km tall but only ~8.5km wide, and drawing its true footprint
//    (which this used to do) renders visibly tall rectangles — measured
//    w/h 0.771 on the mainland, 0.784 Azores, 0.841 Madeira. Squares were
//    an explicit request. svgFor therefore draws the largest square that
//    FITS INSIDE the true cell (side = min(w, h) = the cell's width),
//    vertically centred on it.
//    Two consequences, both deliberate:
//      - Vertically adjacent cells show a gap of ~23% of the cell height.
//        Unavoidable when drawing squares on a non-square lattice; the
//        alternative (side = max) would overlap horizontal neighbours and
//        visually merge distinct cells, which is worse.
//      - The mark is narrower in latitude than the bin, so it slightly
//        OVERSTATES N-S precision (implies +/-4.25km where the stored truth
//        is +/-5.55km). It never extends beyond the real cell, and stored
//        and exported coordinates are unchanged and still truthful — but
//        this is a legibility choice, so don't read the drawn extent as the
//        privacy boundary. The stored 0.1 degree bin is.
window.App = window.App || {};

App.map = (function () {
  const t = App.i18n.t;
  const tn = App.i18n.tn;
  const OUTLINE_URL = "assets/portugal-outline.json";
  const CELL = 0.1; // degrees, matches App.util.roundCoord's precision
  const HALF = CELL / 2;

  // Sequential ramp, light->dark. Validated with the dataviz ordinal checks
  // (monotone lightness, adjacent dL >= 0.06, light-end contrast 2.23:1 on
  // white, single hue / 6 degree spread). It passes ONLY on a white surface,
  // which is why the land is filled white — on a tinted land fill the light
  // end drops to ~1.8:1 and fails. Keep these in sync with styles.css.
  const RAMP = ["#7dbaa3", "#559b81", "#367a64", "#1f5f4f"];

  let outlinePromise = null;

  function loadOutline() {
    if (!outlinePromise) {
      outlinePromise = fetch(OUTLINE_URL).then((r) => {
        if (!r.ok) throw new Error("could not load " + OUTLINE_URL);
        return r.json();
      });
    }
    return outlinePromise;
  }

  // --- aggregation ---

  function aggregate(encounters) {
    const cells = new Map();
    let missing = 0;
    encounters.forEach((e) => {
      if (typeof e.lat_rounded !== "number" || typeof e.lon_rounded !== "number") {
        missing++;
        return;
      }
      const key = e.lat_rounded + "," + e.lon_rounded;
      const cell = cells.get(key);
      if (cell) cell.count++;
      else cells.set(key, { lat: e.lat_rounded, lon: e.lon_rounded, count: 1 });
    });
    return { cells: Array.from(cells.values()), missing };
  }

  // Assigns each cell to whichever outline group contains it (padded, so a
  // coastal or slightly-offshore reading still lands with its group). Cells
  // matching nothing are reported honestly rather than silently dropped.
  function groupCells(cells, groups) {
    const out = { mainland: [], madeira: [], azores: [], elsewhere: [] };
    const pad = 0.5;
    cells.forEach((cell) => {
      let placed = false;
      for (const name of ["mainland", "madeira", "azores"]) {
        const g = groups[name];
        if (!g) continue;
        const [lon0, lat0, lon1, lat1] = g.bbox;
        if (
          cell.lon >= lon0 - pad && cell.lon <= lon1 + pad &&
          cell.lat >= lat0 - pad && cell.lat <= lat1 + pad
        ) {
          out[name].push(cell);
          placed = true;
          break;
        }
      }
      if (!placed) out.elsewhere.push(cell);
    });
    return out;
  }

  // --- bins ---

  // With only a handful of encounters a fixed 4-bin legend is misleading, so
  // bins adapt: <=4 distinct counts gets one bin per value, otherwise four
  // quantile-derived ranges. The legend always prints the real ranges.
  function computeBins(counts) {
    const distinct = Array.from(new Set(counts)).sort((a, b) => a - b);
    if (!distinct.length) return [];

    let ranges;
    if (distinct.length <= RAMP.length) {
      ranges = distinct.map((v) => [v, v]);
    } else {
      const sorted = counts.slice().sort((a, b) => a - b);
      const cut = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      const edges = [];
      [0.25, 0.5, 0.75].forEach((q) => {
        const v = cut(q);
        if (!edges.includes(v)) edges.push(v);
      });
      const max = distinct[distinct.length - 1];
      const min = distinct[0];
      const bounds = [min - 1].concat(edges.filter((e) => e < max)).concat([max]);
      ranges = [];
      for (let i = 0; i < bounds.length - 1; i++) {
        const lo = bounds[i] + 1;
        const hi = bounds[i + 1];
        if (lo <= hi) ranges.push([lo, hi]);
      }
    }

    const n = ranges.length;
    return ranges.map(([lo, hi], i) => ({
      lo, hi,
      label: lo === hi ? String(lo) : lo + "–" + hi,
      color: RAMP[n === 1 ? 2 : Math.round((i * (RAMP.length - 1)) / (n - 1))],
    }));
  }

  function colorFor(count, bins) {
    for (const b of bins) if (count >= b.lo && count <= b.hi) return b.color;
    return bins.length ? bins[bins.length - 1].color : RAMP[0];
  }

  // --- projection ---

  // Equirectangular with a cos(lat0) longitude correction — correct aspect
  // ratio for a country this small, and no projection library needed.
  function makeProjection(bounds, targetWidth) {
    const [lon0, lat0, lon1, lat1] = bounds;
    const k = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
    const worldW = (lon1 - lon0) * k;
    const worldH = lat1 - lat0;
    const scale = targetWidth / worldW;
    return {
      width: targetWidth,
      height: worldH * scale,
      x: (lon) => (lon - lon0) * k * scale,
      y: (lat) => (lat1 - lat) * scale,
      len: (deg) => deg * scale,
      lenX: (deg) => deg * k * scale,
    };
  }

  function boundsFor(group, cells, padFrac) {
    let [lon0, lat0, lon1, lat1] = group.bbox;
    cells.forEach((c) => {
      lon0 = Math.min(lon0, c.lon - HALF);
      lon1 = Math.max(lon1, c.lon + HALF);
      lat0 = Math.min(lat0, c.lat - HALF);
      lat1 = Math.max(lat1, c.lat + HALF);
    });
    const padX = (lon1 - lon0) * padFrac;
    const padY = (lat1 - lat0) * padFrac;
    return [lon0 - padX, lat0 - padY, lon1 + padX, lat1 + padY];
  }

  // --- svg ---

  function pathFor(polygons, proj) {
    return polygons
      .map((poly) =>
        poly
          .map((ring) =>
            ring
              .map((pt, i) => (i ? "L" : "M") + proj.x(pt[0]).toFixed(1) + " " + proj.y(pt[1]).toFixed(1))
              .join("") + "Z"
          )
          .join("")
      )
      .join("");
  }

  function svgFor(group, cells, bins, targetWidth, padFrac) {
    const proj = makeProjection(boundsFor(group, cells, padFrac), targetWidth);
    const land = pathFor(group.polygons, proj);

    // The cell's true footprint, then the largest square that fits inside
    // it, vertically centred — see point 3 of the header comment for why
    // the mark is a square rather than the footprint itself.
    const w = proj.lenX(CELL);
    const h = proj.len(CELL);
    const side = Math.min(w, h);
    const yInset = (h - side) / 2;

    const rects = cells
      .map((c) => {
        const x = proj.x(c.lon - HALF) + (w - side) / 2;
        const y = proj.y(c.lat + HALF) + yInset;
        return (
          `<rect class="map-cell" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
          `width="${side.toFixed(1)}" height="${side.toFixed(1)}" ` +
          `fill="${colorFor(c.count, bins)}"><title>${c.count} encounter${c.count === 1 ? "" : "s"}</title></rect>`
        );
      })
      .join("");

    // Land is drawn twice: filled beneath the cells, then its outline again
    // on top so the coastline stays legible where a cell overlaps it.
    return (
      `<svg class="map-svg" viewBox="0 0 ${proj.width.toFixed(1)} ${proj.height.toFixed(1)}" ` +
      `role="img" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${land}" class="map-land"/>` +
      rects +
      `<path d="${land}" class="map-outline"/>` +
      `</svg>`
    );
  }

  // --- text helpers ---

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function fmtCoord(lat, lon) {
    const ns = lat >= 0 ? "N" : "S";
    const ew = lon >= 0 ? "E" : "W";
    return Math.abs(lat).toFixed(1) + "°" + ns + ", " + Math.abs(lon).toFixed(1) + "°" + ew;
  }

  const GROUP_LABELS = { madeira: "Madeira", azores: "Azores" };

  // --- render ---

  async function render(encounters) {
    const root = document.getElementById("map-root");
    if (!root) return;

    const total = encounters.length;
    if (!total) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(t("mapEmptyState"))}</div>`;
      return;
    }

    let outline;
    try {
      outline = await loadOutline();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(t("mapOutlineFailed", { msg: err.message }))}</div>`;
      return;
    }

    const { cells, missing } = aggregate(encounters);

    if (!cells.length) {
      root.innerHTML =
        svgFor(outline.groups.mainland, [], [], 1000, 0.04) +
        `<p class="map-note">${escapeHtml(tn("mapNoLocationYet", total, { total }))}</p>`;
      return;
    }

    const bins = computeBins(cells.map((c) => c.count));
    const grouped = groupCells(cells, outline.groups);

    let html = svgFor(outline.groups.mainland, grouped.mainland, bins, 1000, 0.04);

    // Insets render only when they actually hold encounters.
    const insets = ["madeira", "azores"]
      .filter((name) => grouped[name].length && outline.groups[name])
      .map(
        (name) =>
          `<div class="map-inset">
             <div class="map-inset-label">${GROUP_LABELS[name]}</div>
             ${svgFor(outline.groups[name], grouped[name], bins, 1000, 0.12)}
           </div>`
      )
      .join("");
    if (insets) html += `<div class="map-insets">${insets}</div>`;

    html +=
      `<div class="map-legend">` +
      `<span class="map-legend-title">${escapeHtml(t("mapLegendTitle"))}</span>` +
      `<div class="map-legend-items">` +
      bins
        .map(
          (b) =>
            `<span class="legend-item"><span class="legend-swatch" style="background:${b.color}"></span>${escapeHtml(b.label)}</span>`
        )
        .join("") +
      `</div></div>`;

    // The map is deliberately static (no hover/tap), so colour alone would be
    // the only channel for magnitude. This list is the non-interactive way to
    // recover exact counts.
    const top = cells.slice().sort((a, b) => b.count - a.count).slice(0, 5);
    html +=
      `<div class="cell-list"><h4>${escapeHtml(t("mapBusiestCells"))}</h4>` +
      top
        .map(
          (c) =>
            `<div class="cell-row"><span class="k">${fmtCoord(c.lat, c.lon)}</span>` +
            `<span class="v">${c.count}</span></div>`
        )
        .join("") +
      `</div>`;

    const notes = [];
    if (missing) {
      notes.push(tn("mapMissingLocation", missing, { missing, total }));
    }
    if (grouped.elsewhere.length) {
      const n = grouped.elsewhere.reduce((s, c) => s + c.count, 0);
      notes.push(tn("mapOutsidePortugal", n, { n }));
    }
    notes.push(t("mapCoordNote"));
    html += `<p class="map-note">${escapeHtml(notes.join(" "))}</p>`;

    root.innerHTML = html;
  }

  return { render, computeBins, aggregate, RAMP };
})();
