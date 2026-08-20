// View switching and rendering. No app/business logic here — main.js calls
// into these to reflect state, and wires up event listeners that call back
// into ladder.js / idb.js.
window.App = window.App || {};

App.ui = (function () {
  const t = App.i18n.t;

  const CONTEXT_KEYS = {
    shop: "ctxShop", library: "ctxLibrary", friend: "ctxFriend", fair: "ctxFair",
    secondhand: "ctxSecondhand", owned: "ctxOwned", other: "ctxOther",
  };

  // Translation keys for what each rung actually detected, shown instead of
  // (or alongside) the bare rung number wherever a rung appears in the UI.
  const RUNG_KEYS = {
    1: "rungBarcode",
    2: "rungIsbn",
    3: "rungDl",
    4: "rungTitleMatch",
    5: "rungManual",
  };

  const objectUrls = []; // revoke on next render to avoid leaking memory

  function releaseObjectUrls() {
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
  }

  function blobUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const el = document.getElementById("view-" + name);
    if (el) el.classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
  }

  function rungLabel(rung) {
    const key = RUNG_KEYS[rung];
    return key ? t(key) : "rung " + rung;
  }

  function contextLabel(ctx) {
    const key = CONTEXT_KEYS[ctx];
    return key ? t(key) : ctx;
  }

  // True when a real identifier was OCR'd (rung 2 or 3 — ISBN or Depósito
  // Legal) but nothing in the local catalogue or network matched it, so
  // whatever edition data exists came from the user typing it in by hand
  // rather than a lookup. This is exactly the "book has a real DL/ISBN but
  // isn't in this BNP dump" case — see docs/catalogue-gaps.md — worth
  // flagging distinctly from a genuinely unidentified encounter (rung 5)
  // since it usually means "known coverage gap," not "identification
  // failed." Derived from stored fields rather than a separate flag, so it
  // works on encounters saved before this existed too.
  function isCatalogueGap(e) {
    const hasIdentifier = !!(e.detected_isbn || e.detected_dl);
    const identifierRung = e.resolution_rung === 2 || e.resolution_rung === 3;
    const noMatch = !e.edition || e.edition.source === "user-entered";
    return hasIdentifier && identifierRung && noMatch;
  }

  function fieldRow(k, v) {
    if (!v) return "";
    return `<div class="field-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // Combines place/publisher/year into one bibliographic-style line instead
  // of three separate rows, e.g. "Lisboa: Relógio d'Água, 2005". Degrades
  // gracefully as fields go missing — never leaves a stray ": " or ", ".
  function formatPublished(e) {
    const parts = [];
    if (e.place && e.publisher) parts.push(`${e.place}: ${e.publisher}`);
    else if (e.publisher) parts.push(e.publisher);
    else if (e.place) parts.push(e.place);
    if (e.year) parts.push(String(e.year));
    return parts.join(", ");
  }

  // Combines both identifiers into one row, e.g.
  // "9789727088539 / 9727088538". Omits the slash/isbn10 entirely when
  // there's nothing to combine (no isbn10, or it's the same string).
  function formatIsbn(e) {
    if (e.isbn13 && e.isbn10 && e.isbn13 !== e.isbn10) return `${e.isbn13} / ${e.isbn10}`;
    return e.isbn13 || e.isbn10 || "";
  }

  // Shows regex-extracted {title, authors, publisher, year} guesses from
  // the ficha técnica text (App.util.extractFichaTecnicaFields, computed in
  // ladder.js) when there's no catalogue/network match — explicitly labeled
  // unverified, same field labels as the matched-edition case for
  // consistency. Returns "" when there's nothing to show, so callers can
  // splice it in unconditionally.
  function renderSuggestedFields(fields) {
    if (!fields || !(fields.title || fields.authors || fields.publisher || fields.year)) return "";
    let html = `<p class="source-note">${escapeHtml(t("suggestedFieldsIntro"))}</p>`;
    html += fieldRow(t("fieldTitle"), fields.title);
    html += fieldRow(t("fieldAuthor"), fields.authors);
    html += fieldRow(t("fieldPublisher"), fields.publisher);
    html += fieldRow(t("fieldYear"), fields.year);
    return html;
  }

  // Renders the read-only result card after a rung 1-4 attempt. Returns
  // nothing; wires nothing — main.js attaches the Confirm/Edit/Reject
  // handlers after calling this (elements have stable ids/classes below).
  function renderResult(draft) {
    const card = document.getElementById("result-card");
    releaseObjectUrls();
    let html = "";

    if (draft.photo_blob) {
      html += `<img class="result-photo" src="${blobUrl(draft.photo_blob)}">`;
    }

    html += `<div style="margin-bottom:0.5rem">`;
    html += `<span class="rung-badge rung-${draft.resolution_rung}">${escapeHtml(rungLabel(draft.resolution_rung))}</span>`;
    html += `</div>`;

    if (draft.edition) {
      const e = draft.edition;
      // Compact, uniform field list: title (edition statement folded in,
      // not a separate row), author, one combined publication line
      // (place/publisher/year), pages, one combined ISBN line, DL. Title is
      // just another row here, same level as the rest — not a heading —
      // per explicit request to make this occupy less space.
      const titleValue = (e.title || t("untitled")) + (e.edition ? " " + e.edition : "");
      html += fieldRow(t("fieldTitle"), titleValue);
      html += fieldRow(t("fieldAuthor"), e.authors);
      html += fieldRow(t("fieldPublished"), formatPublished(e));
      html += fieldRow(t("fieldPages"), e.pages);
      html += fieldRow(t("fieldIsbn"), formatIsbn(e));
      html += fieldRow(t("fieldDepositoLegal"), e.deposito_legal);
      html += `<div class="source-note">${escapeHtml(t("sourceNote", { source: e.source || "unknown" }))}</div>`;
    } else if (draft.resolution_rung === 4 && draft.candidates && draft.candidates.length) {
      html += `<p>${escapeHtml(t("candidatesIntro"))}</p>`;
      html += `<div id="candidate-list">`;
      draft.candidates.forEach((c, i) => {
        html += `<div class="candidate" data-idx="${i}">
          <div class="title">${escapeHtml(c.title || t("noTitle"))}</div>
          <div class="meta">${escapeHtml([c.authors, c.publisher, c.year].filter(Boolean).join(" · "))}</div>
        </div>`;
      });
      html += `</div>`;
    } else if (draft.detected_isbn || draft.detected_dl) {
      html += `<p>${escapeHtml(t("identifierNoMatch"))}</p>`;
      html += fieldRow(t("fieldDetectedIsbn"), draft.detected_isbn);
      html += fieldRow(t("fieldDetectedDl"), draft.detected_dl);
      html += renderSuggestedFields(draft.suggestedFields);
      html += `<p class="source-note">${escapeHtml(t("stillLogByHand"))}</p>`;
    } else {
      html += `<p>${escapeHtml(t("noIdentifierFound"))}</p>`;
      html += renderSuggestedFields(draft.suggestedFields);
      if (draft.raw_ocr_text) {
        html += `<p class="source-note">${escapeHtml(t("ocrTextSample", { text: draft.raw_ocr_text.slice(0, 200) }))}</p>`;
      }
    }

    html += `<div class="action-row">
      <button class="btn danger" id="btn-result-reject">${escapeHtml(t("btnReject"))}</button>
      <button class="btn" id="btn-result-edit">${escapeHtml(t("btnEdit"))}</button>
      ${draft.edition ? `<button class="btn primary" id="btn-result-confirm">${escapeHtml(t("btnConfirm"))}</button>` : ""}
    </div>`;

    card.innerHTML = html;
  }

  function fillManualForm(edition, prefillNote) {
    document.getElementById("m-title").value = (edition && edition.title) || "";
    document.getElementById("m-author").value = (edition && edition.authors) || "";
    document.getElementById("m-publisher").value = (edition && edition.publisher) || "";
    document.getElementById("m-year").value = (edition && edition.year) || "";
    document.getElementById("m-note").value = prefillNote || "";
    document.querySelectorAll("#context-chips .chip").forEach((c) => c.classList.remove("selected"));
  }

  function setManualPhoto(blob) {
    const img = document.getElementById("manual-photo-preview");
    releaseObjectUrls();
    if (blob) {
      img.src = blobUrl(blob);
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }

  function selectedContext() {
    const el = document.querySelector("#context-chips .chip.selected");
    return el ? el.dataset.value : null;
  }

  // --- Log view ---
  function renderLog(encounters, filterRung) {
    const list = document.getElementById("log-list");
    const filtered =
      filterRung === "all" ? encounters : encounters.filter((e) => String(e.resolution_rung) === filterRung);

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t("noEncountersYet"))}</div>`;
      return;
    }

    releaseObjectUrls();
    list.innerHTML = filtered
      .map((e) => {
        const title = (e.edition && e.edition.title) || (e.note ? e.note.slice(0, 60) : t("unidentifiedEncounter"));
        const thumb = e.photo_blob ? `<img class="thumb" src="${blobUrl(e.photo_blob)}">` : `<div class="thumb"></div>`;
        const ctx = e.context ? contextLabel(e.context) : "";
        const gapBadge = isCatalogueGap(e)
          ? `<span class="rung-badge gap-badge">${escapeHtml(t("catalogueGapBadge"))}</span>`
          : "";
        return `<div class="log-entry">
          ${thumb}
          <div class="body">
            <div class="title">${escapeHtml(title)}</div>
            <div class="meta">
              <span class="rung-badge rung-${e.resolution_rung}">${escapeHtml(rungLabel(e.resolution_rung))}</span>
              ${gapBadge}
              ${escapeHtml(ctx)} · ${escapeHtml(App.util.fmtDate(e.timestamp))}
            </div>
          </div>
        </div>`;
      })
      .join("");
  }

  // --- Stats view ---
  function renderStats(encounters) {
    const total = encounters.length;
    const rungCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const contextCounts = {};
    const editionKeys = new Set();

    encounters.forEach((e) => {
      rungCounts[e.resolution_rung] = (rungCounts[e.resolution_rung] || 0) + 1;
      if (e.context) contextCounts[e.context] = (contextCounts[e.context] || 0) + 1;
      if (e.edition) {
        const key = e.edition.isbn13 || e.edition.deposito_legal || e.edition.bnp_record_id || e.edition.title;
        if (key) editionKeys.add(key);
      }
    });

    // "Unidentified" means no edition data at all — not simply rung 5.
    // A rung-5 ("log it anyway") encounter can still carry a hand-typed
    // title/author, in which case it has identification, just not one any
    // automatic rung produced. What this stat is meant to measure is
    // "how often did this encounter end up with zero bibliographic info."
    const unidentified = encounters.filter((e) => !e.edition).length;
    const unidentifiedPct = total ? Math.round((unidentified / total) * 100) : 0;

    document.getElementById("stat-tiles").innerHTML = `
      <div class="stat-tile"><div class="num">${total}</div><div class="label">${escapeHtml(t("statTotalEncounters"))}</div></div>
      <div class="stat-tile"><div class="num">${editionKeys.size}</div><div class="label">${escapeHtml(t("statDistinctEditions"))}</div></div>
      <div class="stat-tile"><div class="num">${unidentifiedPct}%</div><div class="label">${escapeHtml(t("statUnidentified"))}</div></div>
      <div class="stat-tile"><div class="num">${total - unidentified}</div><div class="label">${escapeHtml(t("statIdentified"))}</div></div>
    `;

    const maxRung = Math.max(1, ...Object.values(rungCounts));
    document.getElementById("rung-bars").innerHTML = [1, 2, 3, 4, 5]
      .map((r) => {
        const count = rungCounts[r] || 0;
        const pct = Math.round((count / maxRung) * 100);
        return `<div class="bar-row">
          <span class="label">${escapeHtml(rungLabel(r))}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
          <span class="count">${count}</span>
        </div>`;
      })
      .join("");

    const maxCtx = Math.max(1, ...Object.values(contextCounts).concat([0]));
    const ctxEntries = Object.entries(contextCounts).sort((a, b) => b[1] - a[1]);
    document.getElementById("context-bars").innerHTML = ctxEntries.length
      ? ctxEntries
          .map(([ctx, count]) => {
            const pct = Math.round((count / maxCtx) * 100);
            return `<div class="bar-row">
              <span class="label">${escapeHtml(contextLabel(ctx))}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
              <span class="count">${count}</span>
            </div>`;
          })
          .join("")
      : `<div class="empty-state">${escapeHtml(t("noContextYet"))}</div>`;
  }

  // --- Location banner ---
  //
  // Four states, all rendered into #location-banner. main.js owns the
  // behaviour (which state to ask for, what the buttons do); this just
  // draws. Buttons carry stable ids so main.js can wire them after each
  // render — the banner is re-rendered wholesale on every state change,
  // so handlers must be re-attached, not attached once.
  //   "prompt"  — undecided: explain, offer GPS or manual
  //   "picking" — district chip list
  //   "active"  — GPS granted, or a district chosen
  //   "failed"  — a real GPS attempt failed; offer manual as the way out
  function renderLocationBanner(state, data) {
    const el = document.getElementById("location-banner");
    if (!el) return;
    let html = "";

    if (state === "prompt") {
      html =
        `<div class="loc-text">${escapeHtml(t("locBannerPrompt"))}</div>` +
        `<div class="loc-actions">` +
        `<button type="button" class="btn small" id="btn-loc-gps">${escapeHtml(t("locBannerEnable"))}</button>` +
        `<button type="button" class="btn small" id="btn-loc-manual">${escapeHtml(t("locBannerSetManual"))}</button>` +
        `</div>`;
    } else if (state === "picking") {
      html =
        `<div class="loc-text">${escapeHtml(t("locBannerPickTitle"))}</div>` +
        `<div class="chip-row" id="district-chips">` +
        App.geo
          .districts()
          .map(
            (d) =>
              `<span class="chip" data-district="${escapeHtml(d.key)}">${escapeHtml(d.name)}</span>`
          )
          .join("") +
        `</div>` +
        `<div class="loc-actions">` +
        `<button type="button" class="btn small" id="btn-loc-cancel">${escapeHtml(t("locBannerPickCancel"))}</button>` +
        `</div>`;
    } else if (state === "active") {
      const label =
        data && data.district
          ? t("locBannerActiveManual", { district: data.district.name })
          : t("locBannerActiveGps");
      html =
        `<div class="loc-active">` +
        `<span class="loc-text">${escapeHtml(label)}</span>` +
        `<span class="loc-actions">` +
        `<button type="button" class="btn small" id="btn-loc-manual">${escapeHtml(t("locBannerChange"))}</button>` +
        `<button type="button" class="btn small" id="btn-loc-clear">${escapeHtml(t("locBannerClear"))}</button>` +
        `</span></div>`;
    } else if (state === "failed") {
      html =
        `<div class="loc-text">${escapeHtml(t("locBannerFailed"))}</div>` +
        `<div class="loc-actions">` +
        `<button type="button" class="btn small" id="btn-loc-manual">${escapeHtml(t("locBannerSetManual"))}</button>` +
        `<button type="button" class="btn small" id="btn-loc-gps">${escapeHtml(t("locBannerEnable"))}</button>` +
        `</div>`;
    }

    el.innerHTML = html;
    el.classList.toggle("hidden", !html);
    el.classList.toggle("loc-failed", state === "failed");
  }

  return {
    showView, renderResult, fillManualForm, setManualPhoto, selectedContext,
    renderLog, renderStats, renderLocationBanner, blobUrl, releaseObjectUrls,
  };
})();
