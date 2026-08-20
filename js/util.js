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

  function onlyDigitsX(s) {
    return (s || "").replace(/[\s-]/g, "");
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
  const DL_NUM_RE = /([\d\s]{3,9}\s*\/\s*\d{2,4})/;

  function extractDLFromText(text) {
    if (!text) return null;
    // Look for the number near a DL label first (more reliable).
    const lines = text.split(/\n/);
    for (const line of lines) {
      if (DL_LABEL_RE.test(line)) {
        const m = DL_NUM_RE.exec(line);
        if (m) return normalizeDL(m[1]);
      }
    }
    // Fall back: label and number might be adjacent across the whole text.
    const idx = text.search(DL_LABEL_RE);
    if (idx >= 0) {
      const m = DL_NUM_RE.exec(text.slice(idx, idx + 60));
      if (m) return normalizeDL(m[1]);
    }
    return null;
  }

  function normalizeDL(raw) {
    const val = raw.replace(/\s+/g, "");
    return val || null;
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

  function roundCoord(n) {
    return Math.round(n * 10) / 10;
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
    extractIsbnFromText, extractDLFromText, normalizeDL, validEan13,
    roundCoord, toast, fmtDate, blobToBase64, base64ToBlob,
  };
})();
