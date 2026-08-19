// View switching and rendering. No app/business logic here — main.js calls
// into these to reflect state, and wires up event listeners that call back
// into ladder.js / idb.js.
window.App = window.App || {};

App.ui = (function () {
  const CONTEXT_LABELS = {
    shop: "shop", library: "library", friend: "friend's house", fair: "fair",
    secondhand: "secondhand", owned: "already owned", other: "other",
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

  function rungBadge(rung) {
    const span = document.createElement("span");
    span.className = "rung-badge rung-" + rung;
    span.textContent = "rung " + rung;
    return span;
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
    html += `<span class="rung-badge rung-${draft.resolution_rung}">rung ${draft.resolution_rung}</span>`;
    html += `</div>`;

    if (draft.edition) {
      const e = draft.edition;
      html += `<h3>${escapeHtml(e.title || "(untitled)")}</h3>`;
      html += fieldRow("Author", e.authors);
      html += fieldRow("Publisher", e.publisher);
      html += fieldRow("Place", e.place);
      html += fieldRow("Year", e.year);
      html += fieldRow("Edition", e.edition);
      html += fieldRow("Pages", e.pages);
      html += fieldRow("ISBN-13", e.isbn13);
      html += fieldRow("ISBN-10", e.isbn10);
      html += fieldRow("Depósito Legal", e.deposito_legal);
      html += `<div class="source-note">Source: ${escapeHtml(e.source || "unknown")}. OCR/network data is not authoritative — check before confirming.</div>`;
    } else if (draft.resolution_rung === 4 && draft.candidates && draft.candidates.length) {
      html += `<p>No exact identifier found. Ranked candidates from title-page text (pick one, or reject to log by hand):</p>`;
      html += `<div id="candidate-list">`;
      draft.candidates.forEach((c, i) => {
        html += `<div class="candidate" data-idx="${i}">
          <div class="title">${escapeHtml(c.title || "(no title)")}</div>
          <div class="meta">${escapeHtml([c.authors, c.publisher, c.year].filter(Boolean).join(" · "))}</div>
        </div>`;
      });
      html += `</div>`;
    } else if (draft.detected_isbn || draft.detected_dl) {
      html += `<p>Identifier detected but no catalogue or network match:</p>`;
      html += fieldRow("Detected ISBN", draft.detected_isbn);
      html += fieldRow("Detected Depósito Legal", draft.detected_dl);
      html += `<p class="source-note">You can still log this — fill in what you know by hand.</p>`;
    } else {
      html += `<p>No identifier found in this photo.</p>`;
      if (draft.raw_ocr_text) {
        html += `<p class="source-note">OCR text (first 200 chars): ${escapeHtml(draft.raw_ocr_text.slice(0, 200))}</p>`;
      }
    }

    html += `<div class="action-row">
      <button class="btn danger" id="btn-result-reject">Reject</button>
      <button class="btn" id="btn-result-edit">Edit</button>
      ${draft.edition ? '<button class="btn primary" id="btn-result-confirm">Confirm</button>' : ""}
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
      list.innerHTML = `<div class="empty-state">No encounters logged yet.</div>`;
      return;
    }

    releaseObjectUrls();
    list.innerHTML = filtered
      .map((e) => {
        const title = (e.edition && e.edition.title) || (e.note ? e.note.slice(0, 60) : "Unidentified encounter");
        const thumb = e.photo_blob ? `<img class="thumb" src="${blobUrl(e.photo_blob)}">` : `<div class="thumb"></div>`;
        const ctx = e.context ? CONTEXT_LABELS[e.context] || e.context : "";
        return `<div class="log-entry">
          ${thumb}
          <div class="body">
            <div class="title">${escapeHtml(title)}</div>
            <div class="meta">
              <span class="rung-badge rung-${e.resolution_rung}">r${e.resolution_rung}</span>
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
      <div class="stat-tile"><div class="num">${total}</div><div class="label">total encounters</div></div>
      <div class="stat-tile"><div class="num">${editionKeys.size}</div><div class="label">distinct editions</div></div>
      <div class="stat-tile"><div class="num">${unidentifiedPct}%</div><div class="label">unidentified</div></div>
      <div class="stat-tile"><div class="num">${total - unidentified}</div><div class="label">identified</div></div>
    `;

    const maxRung = Math.max(1, ...Object.values(rungCounts));
    document.getElementById("rung-bars").innerHTML = [1, 2, 3, 4, 5]
      .map((r) => {
        const count = rungCounts[r] || 0;
        const pct = Math.round((count / maxRung) * 100);
        return `<div class="bar-row">
          <span class="label">rung ${r}</span>
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
              <span class="label">${escapeHtml(CONTEXT_LABELS[ctx] || ctx)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
              <span class="count">${count}</span>
            </div>`;
          })
          .join("")
      : `<div class="empty-state">No context data yet.</div>`;
  }

  return {
    showView, renderResult, fillManualForm, setManualPhoto, selectedContext,
    renderLog, renderStats, blobUrl, releaseObjectUrls,
  };
})();
