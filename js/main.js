// Wiring: camera flows, event listeners, app bootstrap. All business logic
// lives in ladder.js/idb.js/catalogue.js/network.js; this file just calls
// into them from DOM events and keeps the one piece of shared UI state
// (the in-progress encounter draft).
(function () {
  let currentDraft = null;
  let activeScan = null; // { cancel() } from barcode.startScanLoop, while scanning

  // Capture session state. The camera is a two-MODE viewfinder, not a
  // wizard: "identify" (barcode auto-detect + shutter-to-OCR-the-page) and
  // "photo" (the keepsake shot of the book as found). It opens in identify
  // mode and auto-advances to photo once something resolves, so the default
  // path is identify -> photo — but the mode strip is live the whole time,
  // so either can be entered directly. One camera stream throughout;
  // switching modes never re-inits it.
  let captureMode = null; // "identify" | "photo" | null
  let pendingDraft = null; // result of identification, awaiting its keepsake photo
  // Bumped whenever a capture session starts or ends. Identification awaits
  // (OCR takes seconds, a lookup can too), and the session can be torn down
  // mid-flight — cancelling, or navigating away. Anything resuming after an
  // await must check its token still matches, or it would resurrect a
  // half-open camera on top of whatever view the user moved to.
  let sessionId = 0;

  const videoEl = document.getElementById("camera-video");
  const canvasEl = document.getElementById("camera-canvas");
  const cameraWrap = document.getElementById("camera-wrap");
  const cameraControls = document.getElementById("camera-controls");
  const captureGrid = document.getElementById("capture-grid");
  const statusLine = document.getElementById("capture-status");
  const camInstruction = document.getElementById("cam-instruction");
  const camScanStatus = document.getElementById("cam-scan-status");
  const camReticle = document.getElementById("cam-reticle");
  const camModes = document.getElementById("cam-modes");
  const btnCamSkip = document.getElementById("btn-cam-skip");
  const btnShutter = document.getElementById("btn-shutter");

  function setStatus(msg) {
    statusLine.textContent = msg || "";
  }

  // The prompt lives on the viewfinder, not in a band below it — a 0.9rem
  // grey strip between the video and the buttons is the one place nobody
  // looks, which is why the old prompts went unread.
  function setCamInstruction(msg) {
    camInstruction.textContent = msg || "";
  }

  function setCamScanStatus(msg) {
    camScanStatus.textContent = msg || "";
  }

  function setCamBusy(busy) {
    cameraControls.classList.toggle("busy", !!busy);
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

  function stopScanLoop() {
    if (activeScan) {
      activeScan.cancel();
      activeScan = null;
    }
  }

  async function stopEverything() {
    sessionId++; // invalidates any identification still awaiting
    stopScanLoop();
    App.capture.stopCamera();
    hideCameraUI();
    setCamBusy(false);
    captureMode = null;
    pendingDraft = null;
  }

  // --- Capture: a two-mode viewfinder (identify, then photo) ---
  //
  // "Identify" deliberately keeps barcode and page-OCR merged into ONE
  // mode rather than offering them as separate choices: that merge was made
  // after real hands-on use (see the README's "One 'Scan' button" note),
  // because you can't tell whether a book has a barcode until you're
  // already looking at it. So barcode detection runs continuously in the
  // background (cheap — one detect() call per frame) while the shutter
  // stays available to photograph the copyright page; whichever resolves
  // first wins. The mode strip separates the two acts that genuinely
  // differ — identify ends when the APP recognises something, photo ends
  // when the USER decides — without reintroducing that up-front decision.
  async function startScanFlow() {
    try {
      showCameraUI();
      sessionId++;
      pendingDraft = null;
      enterIdentifyMode();
      await App.capture.startCamera(videoEl);
    } catch (err) {
      setStatus(App.i18n.t("statusCameraUnavailable", { msg: err.message }));
      await stopEverything();
    }
  }

  function syncModeUI() {
    camModes.querySelectorAll(".cam-mode").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === captureMode);
    });
    const identifying = captureMode === "identify";
    camReticle.classList.toggle("hidden", !identifying);
    setCamInstruction(App.i18n.t(identifying ? "statusIdentifyPrompt" : "statusEncounterPrompt"));
    setCamScanStatus(identifying ? App.i18n.t("camScanLooking") : "");
    btnCamSkip.textContent = App.i18n.t(identifying ? "btnCamSkip" : "btnCamSkipPhoto");
    btnShutter.setAttribute(
      "aria-label",
      App.i18n.t(identifying ? "btnShutterPage" : "btnShutterPhoto")
    );
  }

  function enterIdentifyMode() {
    captureMode = "identify";
    syncModeUI();
    if (activeScan) return; // already scanning; don't stack loops
    activeScan = App.barcode.startScanLoop(videoEl, canvasEl, {
      onBook: onBarcodeFound,
      onReject: (raw) => {
        App.util.toast(App.i18n.t("toastNotBookBarcode", { raw }));
      },
      onTick: () => {},
    });
  }

  function enterPhotoMode() {
    // Barcode detection is pointless (and wasteful) while composing the
    // keepsake shot, and would hijack the flow if a spine barcode drifted
    // into frame.
    stopScanLoop();
    captureMode = "photo";
    syncModeUI();
  }

  async function onBarcodeFound(isbn13) {
    if (captureMode !== "identify") return; // mode changed mid-detect
    const mySession = sessionId;
    // Barcode resolution reads the live stream, not a captured frame — grab
    // one still now, purely so this rung also keeps an identification photo
    // like the OCR rungs do. Best-effort: a capture failure here must not
    // block resolving the book, so it's swallowed to null.
    const idPhoto = await App.capture.capturePhotoBlob(videoEl).catch(() => null);
    stopScanLoop(); // stop before awaiting, so it can't fire twice
    setCamBusy(true);
    setCamScanStatus(App.i18n.t("toastLookingUp", { isbn: isbn13 }));
    const draft = await App.ladder.resolveFromBarcode(isbn13, idPhoto);
    if (mySession !== sessionId) return; // session ended while looking up
    pendingDraft = draft;
    setCamBusy(false);
    App.util.toast(App.i18n.t("toastIdentified"));
    enterPhotoMode();
  }

  function shutterClicked() {
    return captureMode === "identify" ? identifyShutter() : photoShutter();
  }

  async function identifyShutter() {
    // Two captures from the same frame: idPhotoBlob is what gets saved and
    // shown as the identification photo (small, resized), ocrBlob is a
    // full-resolution capture OCR actually reads — the stored photo's
    // size/quality target is tuned for browsing the log, too lossy for
    // small printed text.
    let idPhotoBlob, ocrBlob;
    try {
      idPhotoBlob = await App.capture.capturePhotoBlob(videoEl);
      ocrBlob = await App.capture.captureHighResBlob(videoEl);
    } catch (err) {
      App.util.toast(App.i18n.t("toastCaptureFailed", { msg: err.message }));
      return;
    }
    const mySession = sessionId;
    stopScanLoop();
    setCamBusy(true);
    setCamInstruction(App.i18n.t("statusReadingText"));
    setCamScanStatus("");
    let draft;
    try {
      draft = await App.ladder.resolveFromPhoto(idPhotoBlob, ocrBlob, (deg, i, total) => {
        setCamScanStatus(i === 0 ? "" : App.i18n.t("statusTryingRotation", { i: i + 1, total }));
      });
    } catch (err) {
      if (mySession !== sessionId) return;
      App.util.toast(App.i18n.t("toastOcrFailed", { msg: err.message }));
      // Keep the identification photo even though reading it failed — the
      // spec's "keep every photo, including from failed resolutions" rule.
      draft = App.ladder.resolveManual(null, idPhotoBlob);
    }
    if (mySession !== sessionId) return; // session ended while reading
    pendingDraft = draft;
    setCamBusy(false);
    enterPhotoMode();
  }

  async function photoShutter() {
    let blob;
    try {
      blob = await App.capture.capturePhotoBlob(videoEl);
    } catch (err) {
      App.util.toast(App.i18n.t("toastCaptureFailed", { msg: err.message }));
      return;
    }
    await finishCapture(blob);
  }

  // Skip means different things per mode, but never loses the encounter:
  // in identify it moves on without identifying (ends as rung 5), in photo
  // it finishes with whatever was identified and no keepsake shot.
  function camSkipClicked() {
    if (captureMode === "identify") enterPhotoMode();
    else finishCapture(null);
  }

  async function finishCapture(keepsakeBlob) {
    const draft = pendingDraft || App.ladder.resolveManual(null, null);
    await stopEverything(); // clears pendingDraft, so read it first
    draft.photo_blob = keepsakeBlob || null;
    currentDraft = draft;
    // A rung-5 draft has nothing to confirm — send it straight to the form
    // to be filled in by hand, same as the old OCR-failure path did.
    if (draft.resolution_rung === 5) {
      openManualForm();
      return;
    }
    App.ui.renderResult(draft);
    wireResultButtons();
    wireCandidateClicks(draft);
    App.ui.showView("result");
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
      id_photo_blob: draft.id_photo_blob || null,
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
  const logState = { rung: "all", context: "all", query: "", selectMode: false, selectedIds: new Set() };
  // The most recent delete, held only for the duration of the undo toast.
  // Full records (photo blobs included) come straight off the list that was
  // rendered, so undo restores the same rows with their original ids — no
  // re-read needed, and nothing is written to disk in the meantime.
  let undoBuffer = null;
  let lastLoadedEncounters = [];

  async function refreshLog() {
    lastLoadedEncounters = await App.idb.getAllEncounters();
    // Drop selections whose rows no longer exist (deleted, or filtered
    // away then deleted elsewhere) so a stale id can't ride along into a
    // later bulk delete.
    const live = new Set(lastLoadedEncounters.map((e) => e.id));
    logState.selectedIds.forEach((id) => {
      if (!live.has(id)) logState.selectedIds.delete(id);
    });
    App.ui.renderLog(lastLoadedEncounters, logState);
    syncLogChrome();
  }

  // Keeps the select bar, its delete-count label and the Select toggle in
  // step with logState. Called after every render and every selection change.
  function syncLogChrome() {
    const bar = document.getElementById("log-selectbar");
    const delBtn = document.getElementById("btn-log-delete-selected");
    const selectBtn = document.getElementById("btn-log-select");
    bar.classList.toggle("hidden", !logState.selectMode);
    selectBtn.textContent = App.i18n.t(logState.selectMode ? "btnLogSelectDone" : "btnLogSelect");
    const n = logState.selectedIds.size;
    delBtn.textContent = App.i18n.t("btnLogDeleteSelected", { n });
    delBtn.disabled = n === 0;
  }

  function setLogSelectMode(on) {
    logState.selectMode = on;
    if (!on) logState.selectedIds.clear();
    App.ui.renderLog(lastLoadedEncounters, logState);
    syncLogChrome();
  }

  function toggleLogSelection(id) {
    if (logState.selectedIds.has(id)) logState.selectedIds.delete(id);
    else logState.selectedIds.add(id);
    App.ui.renderLog(lastLoadedEncounters, logState);
    syncLogChrome();
  }

  // Selects exactly what's on screen — the same filterEncounters predicate
  // the list was rendered from, never the whole store. This is how "delete
  // many by category" works: filter to it, then select all.
  function selectAllFiltered() {
    App.ui.filterEncounters(lastLoadedEncounters, logState).forEach((e) => logState.selectedIds.add(e.id));
    App.ui.renderLog(lastLoadedEncounters, logState);
    syncLogChrome();
  }

  // --- Encounter detail ---
  let detailId = null;
  let logScrollY = 0;

  function openEncounterDetail(id) {
    const encounter = lastLoadedEncounters.find((e) => e.id === id);
    if (!encounter) return;
    detailId = id;
    logScrollY = window.scrollY; // restored on Back, so the list doesn't jump
    App.ui.renderEncounterDetail(encounter);
    const del = document.getElementById("btn-detail-delete");
    if (del) {
      del.addEventListener("click", async () => {
        const id = detailId;
        closeEncounterDetail();
        await deleteEncounterIds([id]);
      });
    }
    App.ui.showView("detail");
    window.scrollTo(0, 0);
  }

  function closeEncounterDetail() {
    detailId = null;
    App.ui.showView("log");
    // Wait a frame: the log section is display:none until showView runs, so
    // it has no scroll height to restore into yet.
    requestAnimationFrame(() => window.scrollTo(0, logScrollY));
  }

  // --- Swipe-to-reveal delete ---
  //
  // Touch only, and deliberately not the only way to delete one record —
  // the detail view's Delete button covers pointer/keyboard, and select
  // mode covers bulk. See the README note.
  //
  // The axis lock is the important part: until the gesture is clearly more
  // horizontal than vertical it must do nothing at all, or the list stops
  // scrolling properly under the thumb.
  const SWIPE_W = 76; // must match .log-row-del width in styles.css
  let swipe = null;

  function closeOpenRows(except) {
    document.querySelectorAll("#log-list .log-row.open").forEach((r) => {
      if (r !== except) r.classList.remove("open");
    });
  }

  function onLogTouchStart(ev) {
    if (logState.selectMode || ev.touches.length !== 1) return;
    const row = ev.target.closest(".log-row");
    if (!row) return;
    swipe = {
      row,
      startX: ev.touches[0].clientX,
      startY: ev.touches[0].clientY,
      base: row.classList.contains("open") ? -SWIPE_W : 0,
      axis: null, // null = undecided, "x" = swiping, "y" = let it scroll
    };
  }

  function onLogTouchMove(ev) {
    if (!swipe) return;
    const dx = ev.touches[0].clientX - swipe.startX;
    const dy = ev.touches[0].clientY - swipe.startY;
    if (swipe.axis === null) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
        swipe = null; // vertical: hand it back to the scroller untouched
        return;
      }
      if (Math.abs(dx) > 8) swipe.axis = "x";
      else return;
    }
    ev.preventDefault(); // now we own the gesture
    const offset = Math.max(-SWIPE_W, Math.min(0, swipe.base + dx));
    swipe.row.querySelector(".log-entry").style.transform = `translateX(${offset}px)`;
    swipe.moved = true;
  }

  function onLogTouchEnd() {
    if (!swipe) return;
    const { row } = swipe;
    const entry = row.querySelector(".log-entry");
    if (swipe.axis === "x") {
      const offset = parseFloat((entry.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
      const open = offset < -SWIPE_W * 0.5;
      entry.style.transform = ""; // hand back to the CSS class
      row.classList.toggle("open", open);
      if (open) closeOpenRows(row);
      // Suppress the click that follows this gesture, so a swipe never
      // also opens the detail view.
      row.dataset.swiped = "1";
      setTimeout(() => delete row.dataset.swiped, 350);
    }
    swipe = null;
  }

  // The single delete path for both one row and a bulk selection. Records
  // are captured before the delete so undo can put them back verbatim.
  async function deleteEncounterIds(ids) {
    if (!ids.length) return;
    const records = lastLoadedEncounters.filter((e) => ids.includes(e.id));
    await App.idb.deleteEncounters(ids);
    undoBuffer = records;
    ids.forEach((id) => logState.selectedIds.delete(id));
    await refreshLog();
    App.util.toastAction(
      App.i18n.tn("toastDeleted", records.length, { n: records.length }),
      App.i18n.t("btnUndo"),
      async () => {
        const restoring = undoBuffer;
        undoBuffer = null;
        if (!restoring) return;
        await App.idb.restoreEncounters(restoring);
        await refreshLog();
        App.util.toast(App.i18n.tn("toastRestored", restoring.length, { n: restoring.length }));
      },
      8000,
      () => {
        undoBuffer = null; // window closed unused — let the records go
      }
    );
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

  // --- Dev/testing: seed random location-only encounters ---
  //
  // No identification, no photo — just a way to see the density map filled
  // in without scanning 50 real books. Points are drawn from the real
  // gazetteer (App.geo.randomTestLocations), not a random lat/lon in some
  // bounding box, so they always land on real ground the map actually
  // renders. Marked in the note field so they're identifiable in the Log
  // list and easy to tell apart from real encounters later.
  async function seedRandomLocationsClicked() {
    const locs = await App.geo.randomTestLocations(50);
    const now = Date.now();
    for (let i = 0; i < locs.length; i++) {
      await App.idb.addEncounter({
        timestamp: now - i,
        edition: null,
        resolution_rung: 5,
        raw_ocr_text: null,
        detected_isbn: null,
        detected_dl: null,
        lat_rounded: locs[i].lat_rounded,
        lon_rounded: locs[i].lon_rounded,
        context: null,
        location_note: null,
        location_source: "manual",
        note: "Random test location (dev tool)",
        photo_blob: null,
        id_photo_blob: null,
        confirmed: true,
      });
    }
    App.util.toast(App.i18n.t("toastSeeded", { n: locs.length }));
    await refreshLog();
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
    btnCamSkip.addEventListener("click", camSkipClicked);
    camModes.addEventListener("click", (e) => {
      const btn = e.target.closest(".cam-mode");
      if (!btn || btn.dataset.mode === captureMode) return;
      if (btn.dataset.mode === "identify") enterIdentifyMode();
      else enterPhotoMode();
    });
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
      logState.rung = chip.dataset.rung;
      refreshLog();
    });

    document.getElementById("log-context-filters").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll("#log-context-filters .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      logState.context = chip.dataset.context;
      refreshLog();
    });

    // Debounced like the location search — re-rendering the whole list on
    // every keystroke is wasteful and the input is re-rendered around, so
    // it must not lose focus.
    let logSearchTimer = null;
    document.getElementById("log-search").addEventListener("input", (e) => {
      const value = e.target.value;
      clearTimeout(logSearchTimer);
      logSearchTimer = setTimeout(() => {
        logState.query = value;
        refreshLog();
      }, 120);
    });

    document.getElementById("btn-log-select").addEventListener("click", () => {
      setLogSelectMode(!logState.selectMode);
    });
    document.getElementById("btn-log-select-cancel").addEventListener("click", () => setLogSelectMode(false));
    document.getElementById("btn-log-select-all").addEventListener("click", selectAllFiltered);
    document.getElementById("btn-log-delete-selected").addEventListener("click", () => {
      deleteEncounterIds(Array.from(logState.selectedIds));
    });

    const logList = document.getElementById("log-list");
    logList.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        deleteEncounterIds([Number(del.dataset.del)]);
        return;
      }
      const row = e.target.closest(".log-row");
      if (!row) return;
      if (logState.selectMode) {
        toggleLogSelection(Number(row.dataset.id));
        return;
      }
      if (row.dataset.swiped) return; // this click is the tail of a swipe
      if (row.classList.contains("open")) {
        row.classList.remove("open"); // tapping an open row closes it
        return;
      }
      if (document.querySelector("#log-list .log-row.open")) {
        closeOpenRows(null); // first tap just dismisses whatever was open
        return;
      }
      openEncounterDetail(Number(row.dataset.id));
    });
    logList.addEventListener("touchstart", onLogTouchStart, { passive: true });
    logList.addEventListener("touchmove", onLogTouchMove, { passive: false });
    logList.addEventListener("touchend", onLogTouchEnd, { passive: true });
    logList.addEventListener("touchcancel", onLogTouchEnd, { passive: true });

    document.getElementById("btn-detail-back").addEventListener("click", closeEncounterDetail);

    document.getElementById("btn-seed-random").addEventListener("click", seedRandomLocationsClicked);

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
