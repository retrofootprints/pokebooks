// Wiring: camera flows, event listeners, app bootstrap. All business logic
// lives in ladder.js/idb.js/catalogue.js/network.js; this file just calls
// into them from DOM events and keeps the one piece of shared UI state
// (the in-progress encounter draft).
(function () {
  let currentDraft = null;
  let activeScan = null; // { cancel() } from barcode.startScanLoop, while scanning

  const videoEl = document.getElementById("camera-video");
  const canvasEl = document.getElementById("camera-canvas");
  const cameraWrap = document.getElementById("camera-wrap");
  const cameraControls = document.getElementById("camera-controls");
  const captureGrid = document.getElementById("capture-grid");
  const statusLine = document.getElementById("capture-status");

  function setStatus(msg) {
    statusLine.textContent = msg || "";
  }

  // The "camera-active" body class drives a fullscreen layout in
  // styles.css: header and bottom nav hidden, the capture view becomes a
  // fixed-position flex column where the video flexes to fill whatever
  // space is left after the status line and button row — both of which
  // stay a fixed natural size, so they're always visible without
  // scrolling, on any phone screen. See the "camera-active" rules in
  // styles.css. (Previously the camera preview had a fixed 3:4
  // aspect-ratio with the shutter button below it in normal document
  // flow, which pushed the button off-screen on some phones — reported
  // directly by a user on an iPhone 15 Pro.)
  function showCameraUI() {
    document.body.classList.add("camera-active");
    cameraWrap.classList.remove("hidden");
    cameraControls.classList.remove("hidden");
    captureGrid.classList.add("hidden");
  }

  function hideCameraUI() {
    document.body.classList.remove("camera-active");
    // Forces a synchronous reflow right after dropping the fixed-position
    // fullscreen overlay. Without this, some mobile browsers (seen on
    // iPhone after a barcode auto-resolves: the result view is switched to
    // in the DOM, but the camera view stays visually stuck on screen until
    // the next unrelated touch/scroll forces a repaint) can leave the old
    // layout painted until something else forces a repaint. Reading
    // offsetHeight forces the browser to recompute layout immediately
    // rather than lazily, which is the standard fix for this class of
    // stuck-repaint bug.
    void document.body.offsetHeight;
    cameraWrap.classList.add("hidden");
    cameraControls.classList.add("hidden");
    captureGrid.classList.remove("hidden");
    setStatus("");
  }

  async function stopEverything() {
    if (activeScan) {
      activeScan.cancel();
      activeScan = null;
    }
    App.capture.stopCamera();
    hideCameraUI();
  }

  // --- Scan: one flow covering rungs 1-4 ---
  //
  // A single camera session now does both jobs at once, rather than
  // making the user pre-choose "barcode" vs "photo" before they know
  // whether the book even has a barcode. Barcode detection runs
  // continuously in the background the whole time the camera is open
  // (cheap — one detect() call per frame); the shutter button to capture
  // the page for OCR is available the entire time too, not gated behind a
  // separate mode. Whichever resolves first wins: a valid Bookland barcode
  // jumps straight to rung 1, or the user can tap the shutter at any point
  // to go the OCR route (rungs 2-4) — useful the moment they can see there's
  // no barcode, or the book predates barcodes entirely.
  async function startScanFlow() {
    try {
      showCameraUI();
      setStatus(App.i18n.t("statusScanPrompt"));
      await App.capture.startCamera(videoEl);
    } catch (err) {
      setStatus(App.i18n.t("statusCameraUnavailable", { msg: err.message }));
      hideCameraUI();
      return;
    }

    activeScan = App.barcode.startScanLoop(videoEl, canvasEl, {
      onBook: async (isbn13) => {
        await stopEverything();
        setStatus("");
        App.util.toast(App.i18n.t("toastLookingUp", { isbn: isbn13 }));
        const draft = await App.ladder.resolveFromBarcode(isbn13);
        currentDraft = draft;
        App.ui.renderResult(draft);
        wireResultButtons();
        App.ui.showView("result");
      },
      onReject: (raw) => {
        App.util.toast(App.i18n.t("toastNotBookBarcode", { raw }));
      },
      onTick: () => {},
    });
  }

  async function shutterClicked() {
    // Two captures from the same frame: storedBlob is what gets saved/shown
    // (small, resized — capturePhotoBlob), ocrBlob is a full-resolution
    // capture OCR actually reads (captureHighResBlob). Both are grabbed
    // before stopEverything() stops the stream.
    let storedBlob, ocrBlob;
    try {
      storedBlob = await App.capture.capturePhotoBlob(videoEl);
      ocrBlob = await App.capture.captureHighResBlob(videoEl);
    } catch (err) {
      App.util.toast(App.i18n.t("toastCaptureFailed", { msg: err.message }));
      return;
    }
    await stopEverything();
    setStatus(App.i18n.t("statusReadingText"));
    App.ui.showView("capture"); // stay put but show progress via status line
    try {
      const draft = await App.ladder.resolveFromPhoto(storedBlob, ocrBlob, (deg, i, total) => {
        setStatus(
          i === 0
            ? App.i18n.t("statusReadingText")
            : App.i18n.t("statusTryingRotation", { i: i + 1, total })
        );
      });
      currentDraft = draft;
      setStatus("");
      App.ui.renderResult(draft);
      wireResultButtons();
      wireCandidateClicks(draft);
      App.ui.showView("result");
    } catch (err) {
      setStatus("");
      App.util.toast(App.i18n.t("toastOcrFailed", { msg: err.message }));
      currentDraft = App.ladder.resolveManual(storedBlob);
      openManualForm();
    }
  }

  function wireCandidateClicks(draft) {
    const list = document.getElementById("candidate-list");
    if (!list) return;
    list.querySelectorAll(".candidate").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = Number(el.dataset.idx);
        currentDraft.edition = draft.candidates[idx];
        currentDraft.source = draft.candidates[idx].source;
        App.ui.renderResult(currentDraft);
        wireResultButtons();
      });
    });
  }

  // --- Result view actions ---
  function wireResultButtons() {
    const confirmBtn = document.getElementById("btn-result-confirm");
    const editBtn = document.getElementById("btn-result-edit");
    const rejectBtn = document.getElementById("btn-result-reject");
    if (confirmBtn) confirmBtn.addEventListener("click", onResultConfirm, { once: true });
    if (editBtn) editBtn.addEventListener("click", onResultEdit, { once: true });
    if (rejectBtn) rejectBtn.addEventListener("click", onResultReject, { once: true });
  }

  async function onResultConfirm() {
    const result = await saveEncounter(currentDraft, currentDraft.edition, null, null);
    toastSaved(result);
    currentDraft = null;
    App.ui.showView("capture");
  }

  function onResultEdit() {
    openManualForm();
  }

  function onResultReject() {
    currentDraft = null;
    App.ui.showView("capture");
  }

  function openManualForm() {
    const editingKnown = currentDraft && currentDraft.resolution_rung !== 5;
    document.getElementById("manual-heading").textContent = App.i18n.t(
      editingKnown ? "manualHeadingConfirm" : "manualHeadingLog"
    );
    // Prefer a real matched edition; fall back to the OCR-derived
    // suggestions (title/author/publisher/year regex-extracted from the
    // ficha técnica text) when there's no match — both are the same
    // {title, authors, publisher, year} shape, so fillManualForm doesn't
    // need to know which one it got.
    const prefill = currentDraft && (currentDraft.edition || currentDraft.suggestedFields);
    App.ui.fillManualForm(prefill);
    App.ui.setManualPhoto(currentDraft ? currentDraft.photo_blob : null);
    App.ui.showView("manual");
  }

  // --- Log it anyway (rung 5) ---
  function logAnywayClicked() {
    currentDraft = App.ladder.resolveManual(null);
    openManualForm();
  }

  // --- Manual form submit ---
  async function manualFormSubmit(ev) {
    ev.preventDefault();
    if (!currentDraft) currentDraft = App.ladder.resolveManual(null);

    const title = document.getElementById("m-title").value.trim();
    const author = document.getElementById("m-author").value.trim();
    const publisher = document.getElementById("m-publisher").value.trim();
    const year = document.getElementById("m-year").value.trim();
    const locationNote = document.getElementById("m-location-note").value.trim();
    const note = document.getElementById("m-note").value.trim();
    const context = App.ui.selectedContext();

    let edition = currentDraft.edition;
    if (title || author || publisher || year) {
      edition = Object.assign({}, edition, {
        title: title || (edition && edition.title) || "",
        authors: author || (edition && edition.authors) || "",
        publisher: publisher || (edition && edition.publisher) || "",
        year: year || (edition && edition.year) || "",
        source: (edition && edition.source) || "user-entered",
      });
    }

    const result = await saveEncounter(currentDraft, edition, context, { locationNote, note });
    toastSaved(result);
    currentDraft = null;
    ev.target.reset();
    App.ui.showView("capture");
  }

  // Returns { id, locationOk, locationReason } so callers can tell the
  // user whether location was actually captured — previously this
  // swallowed any geolocation failure into a silent null, which is how a
  // user could scan a dozen books, see an empty map, and have no way to
  // tell why (permission denied vs timeout vs no GPS fix vs unsupported
  // are all very different problems with different fixes).
  async function saveEncounter(draft, edition, context, extra) {
    // resolveLocationForSave never triggers a permission prompt — GPS is
    // only read when permission was already granted via the location
    // banner, otherwise it falls back to the manually picked district.
    const loc = await App.geo.resolveLocationForSave();
    const record = {
      timestamp: Date.now(),
      edition: edition || null,
      resolution_rung: draft.resolution_rung,
      raw_ocr_text: draft.raw_ocr_text || null,
      detected_isbn: draft.detected_isbn || null,
      detected_dl: draft.detected_dl || null,
      lat_rounded: loc.ok ? loc.lat_rounded : null,
      lon_rounded: loc.ok ? loc.lon_rounded : null,
      context: context || (extra && extra.context) || null,
      location_note: (extra && extra.locationNote) || null,
      // Where the coordinates came from ("gps" | "manual"), or null when
      // there are none. The spec's "mark the source on every record" rule
      // applies to a hand-picked coordinate as much as to OCR- or
      // network-derived bibliographic data. Records saved before this
      // existed simply lack the field — absent means unknown, not "gps".
      location_source: loc.ok ? loc.source || null : null,
      note: (extra && extra.note) || null,
      photo_blob: draft.photo_blob || null,
      confirmed: true,
    };
    const id = await App.idb.addEncounter(record);
    return { id, locationOk: loc.ok, locationReason: loc.reason };
  }

  function toastSaved(saveResult) {
    if (saveResult.locationOk) {
      App.util.toast(App.i18n.t("toastEncounterSaved"));
    } else {
      // reason is a kebab-case token ("not-enabled") -> camelCase i18n key
      // suffix ("NotEnabled"), so locationReasonNotEnabled resolves.
      const reason = saveResult.locationReason || "unavailable";
      const suffix = reason
        .split("-")
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join("");
      App.util.toast(
        App.i18n.t("toastEncounterSavedNoLocation", { reason: App.i18n.t("locationReason" + suffix) })
      );
    }
  }

  // --- Location banner ---

  let locSearchResults = []; // latest search results, indexed by the "picking" list's data-idx
  let locSearchDebounce = null;

  async function refreshLocationBanner() {
    const manual = App.geo.getManualLocation();
    if (manual) {
      App.ui.renderLocationBanner("active", { location: manual.location });
    } else {
      const state = await App.geo.getPermissionState();
      // Only "granted" is trusted from the Permissions API — see the
      // comment on getPermissionState. Everything else shows the opt-in,
      // which is harmless: it's an explanation, not a native prompt.
      App.ui.renderLocationBanner(state === "granted" ? "active" : "prompt");
    }
    wireLocationBanner();
  }

  function wireLocationBanner() {
    const gpsBtn = document.getElementById("btn-loc-gps");
    if (gpsBtn) gpsBtn.addEventListener("click", locGpsClicked);

    const manualBtn = document.getElementById("btn-loc-manual");
    if (manualBtn) {
      manualBtn.addEventListener("click", () => {
        locSearchResults = [];
        App.ui.renderLocationBanner("picking");
        wireLocationBanner();
        const input = document.getElementById("loc-search-input");
        if (input) input.focus();
      });
    }

    const cancelBtn = document.getElementById("btn-loc-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", refreshLocationBanner);

    const clearBtn = document.getElementById("btn-loc-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        App.geo.clearManualLocation();
        App.util.toast(App.i18n.t("locToastCleared"));
        await refreshLocationBanner();
      });
    }

    const searchInput = document.getElementById("loc-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const query = searchInput.value;
        clearTimeout(locSearchDebounce);
        locSearchDebounce = setTimeout(async () => {
          const hasQuery = !!query.trim();
          locSearchResults = hasQuery ? await App.geo.searchLocations(query, 8) : [];
          App.ui.renderLocationResults(locSearchResults, hasQuery);
        }, 120);
      });
    }

    const resultsEl = document.getElementById("loc-search-results");
    if (resultsEl) {
      resultsEl.addEventListener("click", async (e) => {
        const item = e.target.closest(".loc-result");
        if (!item) return;
        const location = locSearchResults[Number(item.dataset.idx)];
        if (!location) return;
        if (App.geo.setManualLocation(location)) {
          App.util.toast(App.i18n.t("locToastManualSet", { district: location.name }));
        }
        await refreshLocationBanner();
      });
    }
  }

  async function locGpsClicked() {
    const result = await App.geo.requestLocation();
    if (result.ok) {
      // A successful fix means permission is granted; clear any manual
      // override so live GPS takes precedence from here on.
      App.geo.clearManualLocation();
      App.util.toast(App.i18n.t("locToastEnabled"));
      App.ui.renderLocationBanner("active");
    } else {
      App.ui.renderLocationBanner("failed");
    }
    wireLocationBanner();
  }

  // --- Search escape hatch ---
  async function searchClicked() {
    const q = document.getElementById("search-input").value.trim();
    if (!q) return;
    const resultsEl = document.getElementById("search-results");
    resultsEl.innerHTML = `<p class="status-line">${App.i18n.t("statusSearching")}</p>`;
    const candidates = await App.network.searchByText(q, 8).catch(() => []);
    if (!candidates.length) {
      resultsEl.innerHTML = `<p class="status-line">${App.i18n.t("statusNoResults")}</p>`;
      return;
    }
    resultsEl.innerHTML = candidates
      .map(
        (c, i) => `<div class="candidate" data-idx="${i}">
          <div class="title">${c.title || App.i18n.t("noTitle")}</div>
          <div class="meta">${[c.authors, c.publisher, c.year].filter(Boolean).join(" · ")}</div>
        </div>`
      )
      .join("");
    resultsEl.querySelectorAll(".candidate").forEach((el) => {
      el.addEventListener("click", () => {
        const c = candidates[Number(el.dataset.idx)];
        currentDraft = App.ladder.blankDraft();
        currentDraft.resolution_rung = 4;
        currentDraft.edition = c;
        currentDraft.source = c.source;
        App.ui.renderResult(currentDraft);
        wireResultButtons();
        App.ui.showView("result");
        resultsEl.innerHTML = "";
        document.getElementById("search-input").value = "";
      });
    });
  }

  // --- Log / Stats views ---
  let logFilter = "all";

  async function refreshLog() {
    const encounters = await App.idb.getAllEncounters();
    App.ui.renderLog(encounters, logFilter);
  }

  async function refreshStats() {
    const encounters = await App.idb.getAllEncounters();
    App.ui.renderStats(encounters);
    const stats = await App.catalogue.getStats();
    App.ui.renderDexCompletion(encounters, stats);
    App.ui.renderDiscoveryGrid(encounters, stats);
  }

  async function refreshMap() {
    const encounters = await App.idb.getAllEncounters();
    await App.map.render(encounters);
  }

  // --- Export / Import ---
  async function exportClicked() {
    const data = await App.idb.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pt-book-encounters-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function importClicked() {
    document.getElementById("import-file").click();
  }

  async function importFileChosen(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const count = await App.idb.importAll(data);
      App.util.toast(App.i18n.tn("toastImported", count));
      await refreshStats();
    } catch (err) {
      App.util.toast(App.i18n.t("toastImportFailed", { msg: err.message }));
    } finally {
      ev.target.value = "";
    }
  }

  // --- Bootstrap ---
  function wireStaticEvents() {
    document.getElementById("btn-scan").addEventListener("click", startScanFlow);
    document.getElementById("btn-shutter").addEventListener("click", shutterClicked);
    document.getElementById("btn-cancel-camera").addEventListener("click", stopEverything);
    document.getElementById("btn-log-anyway").addEventListener("click", logAnywayClicked);
    document.getElementById("btn-search").addEventListener("click", searchClicked);
    document.getElementById("search-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchClicked();
    });

    document.getElementById("manual-form").addEventListener("submit", manualFormSubmit);
    document.getElementById("btn-manual-cancel").addEventListener("click", () => {
      currentDraft = null;
      App.ui.showView("capture");
    });

    document.getElementById("context-chips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll("#context-chips .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
    });

    document.getElementById("log-filters").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll("#log-filters .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      logFilter = chip.dataset.rung;
      refreshLog();
    });

    document.getElementById("btn-export").addEventListener("click", exportClicked);
    document.getElementById("btn-import").addEventListener("click", importClicked);
    document.getElementById("import-file").addEventListener("change", importFileChosen);

    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await stopEverything();
        const view = btn.dataset.view;
        App.ui.showView(view);
        if (view === "log") await refreshLog();
        if (view === "map") await refreshMap();
        if (view === "stats") await refreshStats();
      });
    });

    // Switching language reloads the page (see js/i18n.js) rather than
    // live-translating everything in place — simpler and avoids having to
    // re-render whatever view happens to be open at the time.
    document.querySelectorAll(".lang-switch button").forEach((btn) => {
      btn.addEventListener("click", () => App.i18n.setLang(btn.dataset.lang));
    });
  }

  function init() {
    App.i18n.applyStaticTranslations();
    wireStaticEvents();
    App.ui.showView("capture");
    // Renders the opt-in / current-location banner. Note this only reads
    // stored state and (best-effort) the Permissions API — it never calls
    // getCurrentPosition, so no native prompt fires on load.
    refreshLocationBanner();

    // Data safety: Safari can evict IndexedDB silently without this.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
