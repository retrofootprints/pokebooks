// Shared helpers: identifier validation/normalisation, text folding, misc.
// Mirrors scripts/build_index.py's normalisation exactly so client-side
// lookups agree with how the catalogue was indexed.
window.App = window.App || {};

App.util = (function () {
  const LEADING_ARTICLES = new Set(["o", "a", "os", "as", "um", "uma"]);

  // Strip combining diacritical marks (U+0300-U+036F) after NFKD
  // decomposition. Written as an explicit \uXXXX escape range rather than
  // literal combining characters, which are fragile to embed directly in
  // source (editors/tools can silently mangle them).
  function stripDiacritics(s) {
    if (!s) return "";
    return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  }

  function normText(s) {
    if (!s) return "";
    let t = stripDiacritics(s).toLowerCase();
    t = t.replace(/[^\w\s]/gu, " ");
    let words = t.split(/\s+/).filter(Boolean);
    if (words.length && LEADING_ARTICLES.has(words[0])) words = words.slice(1);
    return words.join(" ");
  }

  // Strips whitespace, hyphens, and common OCR-noise punctuation that
  // sometimes shows up where a hyphen or digit should be (quotes,
  // apostrophes, periods, commas, backticks) — none of these are ever
  // legitimately part of an ISBN, so stripping them is safe. This does NOT
  // recover a digit OCR mis-read as punctuation (that's real data loss,
  // not noise around correct data) — only helps when the digits themselves
  // are intact and punctuation is just clutter between/around them.
  function onlyDigitsX(s) {
    return (s || "").replace(/[\s\-'"´`.,]/g, "");
  }

  function validIsbn13(digits) {
    if (!/^\d{13}$/.test(digits)) return false;
    let total = 0;
    for (let i = 0; i < 12; i++) total += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (total % 10)) % 10;
    return check === Number(digits[12]);
  }

  function validIsbn10(s) {
    s = s.toUpperCase();
    if (!/^\d{9}[\dX]$/.test(s)) return false;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const c = s[i];
      const val = c === "X" ? 10 : Number(c);
      total += val * (10 - i);
    }
    return total % 11 === 0;
  }

  function isbn10ToIsbn13(isbn10) {
    const core = "978" + isbn10.slice(0, 9);
    let total = 0;
    for (let i = 0; i < 12; i++) total += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (total % 10)) % 10;
    return core + String(check);
  }

  function isbn13ToIsbn10(isbn13) {
    if (!isbn13.startsWith("978")) return null;
    const core = isbn13.slice(3, 12);
    let total = 0;
    for (let i = 0; i < 9; i++) total += (10 - i) * Number(core[i]);
    const check = (11 - (total % 11)) % 11;
    const checkChar = check === 10 ? "X" : String(check);
    return core + checkChar;
  }

  // Extract the first checksum-valid ISBN-10/13 from free text (OCR output).
  function extractIsbnFromText(text) {
    if (!text) return null;
    const compact = onlyDigitsX(text);
    const re13 = /(97[89]\d{10})/g;
    let m;
    while ((m = re13.exec(compact))) {
      if (validIsbn13(m[1])) return { isbn13: m[1], isbn10: isbn13ToIsbn10(m[1]) };
    }
    const re10 = /(\d{9}[\dXx])/g;
    while ((m = re10.exec(compact))) {
      const cand = m[1].toUpperCase();
      if (validIsbn10(cand)) return { isbn13: isbn10ToIsbn13(cand), isbn10: cand };
    }
    return null;
  }

  // Permissive Deposito Legal extraction. Real-world label variants:
  // "Deposito Legal", "Deposito legal", "Dep. Legal", "D.L.", "DL", with or
  // without "n.o" / "no" / "N.o", number may carry internal spaces.
  const DL_LABEL_RE = /dep[oó]sito\s*legal|dep\.?\s*legal|d\.?\s*l\.?/i;
  // Primary: requires the "/" between number and year — reliable, low
  // false-positive risk.
  const DL_NUM_STRICT_RE = /(\d[\d\s]{2,7}\d)\s*\/\s*(\d{2,4})\b/;
  // Fallback, tried only when the strict pattern misses on a line that
  // already matched DL_LABEL_RE: OCR sometimes drops the "/" entirely
  // while reading every digit correctly (confirmed on a real photo —
  // "166 353/01" printed on the page came back as "166 353 01"). Requires
  // a plain 2-digit year specifically (not 2-4) to keep this fallback from
  // matching arbitrary nearby numbers now that there's no slash to anchor on.
  const DL_NUM_LOOSE_RE = /(\d[\d\s]{2,7}\d)\s+(\d{2})\b(?!\d)/;

  function extractDLNumber(line) {
    const m = DL_NUM_STRICT_RE.exec(line) || DL_NUM_LOOSE_RE.exec(line);
    if (!m) return null;
    const num = m[1].replace(/\s+/g, "");
    return num ? num + "/" + m[2] : null;
  }

  function extractDLFromText(text) {
    if (!text) return null;
    // Look for the number near a DL label first (more reliable).
    const lines = text.split(/\n/);
    for (const line of lines) {
      if (DL_LABEL_RE.test(line)) {
        const dl = extractDLNumber(line);
        if (dl) return dl;
      }
    }
    // Fall back: label and number might be adjacent across the whole text.
    const idx = text.search(DL_LABEL_RE);
    if (idx >= 0) {
      const dl = extractDLNumber(text.slice(idx, idx + 60));
      if (dl) return dl;
    }
    return null;
  }

  // Best-effort field extraction from ficha-técnica OCR text — title,
  // author, publisher, year — for when no identifier matched a catalogue
  // or network record. Deliberately regex/pattern-based, not a model: the
  // ficha técnica has a small set of recurring labeled patterns
  // ("Título:", "Autor:", a publisher name near "Editora"/"Editores"/
  // "Edições"/"Publicações", a year attached to the Depósito Legal
  // number) that show up across different publishers' layouts. This is a
  // pre-fill suggestion for the manual form, never authoritative — the
  // user reviews and corrects every field before saving, same as every
  // other OCR/network-derived value in this app.
  //
  // Patterns were built and verified against four real photographed ficha
  // técnica pages (see docs/catalogue-gaps.md), not guessed. Two specific
  // failure modes drove the design:
  //   - OCR often prepends a stray garbage character before a label on its
  //     own line ("É | Título:" instead of "Título:") — matching requires
  //     tolerating a few leading characters, not anchoring strictly to
  //     line-start.
  //   - But tolerating too much leads to real false positives: "Fotografia
  //     do autor: Marina Waters" (a PHOTO CREDIT line) matches a loose
  //     "autor" search if the label isn't required near the start of the
  //     line. The `.{0,6}` bound is deliberately tight — enough to skip a
  //     one-character OCR artifact, not enough to skip a real preceding
  //     word.
  const TITLE_LABEL_RE = /^.{0,6}\bt[íi]tulo\s*[:;]\s*(.+)/i;
  const ORIGINAL_TITLE_LABEL_RE = /t[íi]tulo\s+original\s*[:;]\s*(.+)/i;
  const AUTHOR_LABEL_RE = /^.{0,6}\bautor(?:es)?\s*[:;]\s*(.+)/i;
  const PUBLISHER_KEYWORD_RE = /\b(editora|editores|edi[cç][õo]es|publica[cç][õo]es)\b/i;
  const PUBLISHER_EXCLUDE_RE = /dep[oó]sito|isbn|www\.|http|@|copyright/i;

  function cleanExtractedLine(s) {
    return s.replace(/[|"“”«»]/g, "").replace(/\s{2,}/g, " ").trim();
  }

  function extractTitleField(text) {
    for (const line of text.split(/\n/)) {
      if (/t[íi]tulo\s+original/i.test(line)) continue; // handled separately, as a fallback only
      const m = TITLE_LABEL_RE.exec(line);
      if (m) return cleanExtractedLine(m[1]);
    }
    const om = ORIGINAL_TITLE_LABEL_RE.exec(text);
    return om ? cleanExtractedLine(om[1]) : null;
  }

  function extractAuthorField(text) {
    for (const line of text.split(/\n/)) {
      const m = AUTHOR_LABEL_RE.exec(line);
      if (m) return cleanExtractedLine(m[1]);
    }
    return null;
  }

  function extractPublisherField(text) {
    for (const line of text.split(/\n/)) {
      if (PUBLISHER_KEYWORD_RE.test(line) && !PUBLISHER_EXCLUDE_RE.test(line)) {
        const cleaned = cleanExtractedLine(line).replace(/^[O0©]\s*\d{4}\s*,\s*/i, "");
        if (cleaned.length > 3 && cleaned.length < 80) return cleaned;
      }
    }
    return null;
  }

  // The Depósito Legal's own "/YY" or "/YYYY" suffix is a more reliable
  // year source than scanning body text for a 4-digit number — it's
  // structured data, not prose, and verified correct against all four
  // reference photos (each one's DL year matched the printed edition year
  // exactly). Two-digit years are expanded with a simple century pivot;
  // wrong past ~2030 but this whole pilot is about contemporary Portuguese
  // publishing, so that's an acceptable edge.
  function yearFromDL(dl) {
    if (!dl) return null;
    const m = /\/(\d{2,4})$/.exec(dl);
    if (!m) return null;
    let y = m[1];
    if (y.length === 2) {
      const n = Number(y);
      y = String(n <= 30 ? 2000 + n : 1900 + n);
    }
    return y;
  }

  // The Depósito Legal's numeric prefix (e.g. "166353/01" -> 166353) — its
  // position in the registry's running sequence, used by the discovery-grid
  // filmstrip (js/ui.js's renderDiscoveryGrid) to place an encounter into a
  // bucket. See docs/dl-pokedex-analysis.md for why this number is a
  // reliable global ordinal (not reset per year) from ~1983 on. Returns
  // null, not NaN, for anything that isn't the normalized "NNNNNN/YY[YY]"
  // shape build_index.py and OCR extraction both produce.
  function dlNumber(dl) {
    if (!dl) return null;
    const m = /^(\d+)\//.exec(dl);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  function extractYearFallback(text) {
    const years = [];
    const re = /\b(19[0-9]{2}|20[0-2][0-9])\b/g;
    let m;
    while ((m = re.exec(text))) years.push(Number(m[1]));
    return years.length ? String(Math.max(...years)) : null;
  }

  // Returns a partial {title, authors, publisher, year} object — only the
  // fields it found something for. detectedDl, if given (already-extracted
  // via extractDLFromText), is used for a more reliable year than the
  // free-text fallback.
  function extractFichaTecnicaFields(text, detectedDl) {
    if (!text) return {};
    const out = {};
    const title = extractTitleField(text);
    const authors = extractAuthorField(text);
    const publisher = extractPublisherField(text);
    const year = yearFromDL(detectedDl) || extractYearFallback(text);
    if (title) out.title = title;
    if (authors) out.authors = authors;
    if (publisher) out.publisher = publisher;
    if (year) out.year = year;
    return out;
  }

  // EAN-13 checksum (used for barcode validation; ISBN-13 uses the same
  // weighting so validIsbn13 covers it, but barcodes may not start 978/979
  // and this is used before we know that).
  function validEan13(digits) {
    if (!/^\d{13}$/.test(digits)) return false;
    let total = 0;
    for (let i = 0; i < 12; i++) total += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (total % 10)) % 10;
    return check === Number(digits[12]);
  }

  // Latitude rounding: 0.1 degree (~11.1km at any latitude — a degree of
  // latitude is nearly constant). Used for lat_rounded everywhere.
  function roundCoord(n) {
    return Math.round(n * 10) / 10;
  }

  // Longitude rounding: 0.13 degree, not 0.1. A degree of longitude
  // shrinks by cos(latitude), so at Portuguese latitudes 0.1 degree of
  // longitude is only ~8.5km against 0.1 degree of latitude's ~11.1km —
  // cells were visibly tall rectangles on the map (measured w/h 0.771
  // mainland). 0.13 was chosen specifically to close that gap: it renders
  // ~11x11km cells and ~0.2% off-square on the mainland (see js/map.js).
  // Madeira/Azores are further from the reference latitude and still land
  // a few percent off-square even at this step — js/map.js additionally
  // draws an inscribed square as a backstop, so this value doesn't need to
  // be exact everywhere, just close on the mainland where most encounters
  // will fall.
  //
  // LON_STEP itself isn't exactly representable in binary floating point
  // (0.13 * 7 === 0.9099999999999999), so the result is rounded to 2
  // decimals after snapping to the grid — LON_STEP's own precision — to
  // keep stored/exported values clean rather than carrying that noise.
  const LON_STEP = 0.13;
  function roundLon(n) {
    return Math.round((Math.round(n / LON_STEP) * LON_STEP) * 100) / 100;
  }

  function toast(msg, ms) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms || 2500);
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const lang = App.i18n ? App.i18n.getLang() : undefined;
    return d.toLocaleString(lang);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(dataUrl) {
    return fetch(dataUrl).then((r) => r.blob());
  }

  return {
    stripDiacritics, normText, onlyDigitsX,
    validIsbn13, validIsbn10, isbn10ToIsbn13, isbn13ToIsbn10,
    extractIsbnFromText, extractDLFromText, extractFichaTecnicaFields, validEan13,
    roundCoord, roundLon, toast, fmtDate, blobToBase64, base64ToBlob, dlNumber,
  };
})();
