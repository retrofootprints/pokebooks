// The resolution ladder. One entry point conceptually (an encounter always
// ends up as a draft with a resolution_rung and a possibly-null edition),
// reached via three different capture paths (barcode / photograph page /
// log anyway).
//
// Per spec: "An encounter with a null edition is valid. Never block
// logging on identification." A rung records which IDENTIFICATION METHOD
// was used (barcode read, OCR'd ISBN, OCR'd Depósito Legal, OCR'd title
// text, or none) — it's set as soon as we have a validated identifier,
// independent of whether that identifier then matched anything in the
// local catalogue or network. If lookup comes up empty, the draft's
// `edition` stays null and the user fills in details by hand from the same
// form (see ui.js).
window.App = window.App || {};

App.ladder = (function () {
  function blankDraft() {
    return {
      resolution_rung: null,
      raw_ocr_text: null,
      detected_isbn: null,
      detected_dl: null,
      edition: null,
      source: null,
      // The encounter's own keepsake photo — the book as found, always the
      // same shot regardless of how (or whether) it gets identified. Set by
      // main.js, not here: capture.js's flow takes this photo BEFORE
      // identification starts, so it's already decided by the time any
      // resolveFrom* function below runs.
      photo_blob: null,
      // The barcode/copyright-page photo actually used for identification
      // — kept separately per the spec's "keep every photo, including from
      // failed resolutions — that corpus shows where the pipeline is weak."
      // null for barcode-only resolutions where no still frame existed to
      // keep (unless main.js captured one at detection time) and for
      // "log it anyway" (no identification attempt at all).
      id_photo_blob: null,
      candidates: null, // rung 4 only: ranked list, never a single answer
      // Regex-extracted {title, authors, publisher, year} guesses from the
      // OCR'd ficha técnica text (App.util.extractFichaTecnicaFields) —
      // only ever used as a manual-form pre-fill when no catalogue/network
      // edition was found; never treated as a match. null when there was
      // no OCR text to extract from (barcode-only or "log it anyway").
      suggestedFields: null,
    };
  }

  async function resolveIsbn(isbn13, isbn10) {
    let edition = await App.catalogue.lookupByIsbn(isbn13, isbn10).catch(() => null);
    if (edition) return edition;
    edition = await App.network.lookupByIsbn(isbn13).catch(() => null);
    return edition;
  }

  async function resolveDL(dl) {
    let edition = await App.catalogue.lookupByDL(dl).catch(() => null);
    if (edition) return edition;
    edition = await App.network.lookupByDL(dl).catch(() => null);
    return edition;
  }

  // Rung 1: barcode already validated as Bookland EAN-13 by barcode.js.
  // idPhotoBlob is a still frame main.js grabs from the live video at the
  // moment of detection (barcode resolution itself needs no captured
  // frame — it reads the live stream — so this exists purely to keep a
  // record of what was scanned; null if that capture failed).
  async function resolveFromBarcode(isbn13, idPhotoBlob) {
    const draft = blankDraft();
    draft.resolution_rung = 1;
    draft.detected_isbn = isbn13;
    draft.id_photo_blob = idPhotoBlob || null;
    const edition = await resolveIsbn(isbn13, App.util.isbn13ToIsbn10(isbn13));
    if (edition) {
      draft.edition = edition;
      draft.source = edition.source;
    }
    return draft;
  }

  // Rungs 2-4: OCR the captured barcode/copyright-page photo, try ISBN,
  // then Depósito Legal, then (network-only) a title/author search. Returns
  // whichever rung matched first, always including the raw OCR text for
  // the record either way.
  //
  // idPhotoBlob is the resized/compressed identification-page frame — kept
  // on the draft (not the encounter's own keepsake photo_blob, which
  // main.js sets separately) per the spec's "keep every photo" rule.
  // ocrBlob, when given, is a separate full-resolution capture
  // (capture.captureHighResBlob) that OCR actually reads — the stored
  // photo's size/quality target is tuned for browsing the log quickly, not
  // for resolving small printed text, so feeding OCR the same lossy copy
  // was starving it of the resolution it needs. Falls back to idPhotoBlob
  // if no separate capture was provided (e.g. resuming an older draft
  // shape).
  //
  // OCR runs via recognizeBestRotation, not a single fixed-orientation pass
  // — see the comment on that function in ocr.js for why a single
  // assumed orientation isn't safe to rely on. onAttempt, if given, is
  // forwarded so the caller can show progress across the (up to 4) passes.
  async function resolveFromPhoto(idPhotoBlob, ocrBlob, onAttempt) {
    const draft = blankDraft();
    draft.id_photo_blob = idPhotoBlob;

    const result = await App.ocr.recognizeBestRotation(ocrBlob || idPhotoBlob, onAttempt);
    draft.raw_ocr_text = result.text;
    // Computed unconditionally (cheap regex work) so it's available as a
    // manual-form pre-fill regardless of which rung this ends up on — most
    // useful when an identifier is found but nothing matches a catalogue
    // or network record, but there's no harm in having it ready either way.
    draft.suggestedFields = App.util.extractFichaTecnicaFields(result.text, result.dl);

    if (result.isbn) {
      draft.resolution_rung = 2;
      draft.detected_isbn = result.isbn.isbn13;
      const edition = await resolveIsbn(result.isbn.isbn13, result.isbn.isbn10);
      if (edition) {
        draft.edition = edition;
        draft.source = edition.source;
      }
      return draft;
    }

    if (result.dl) {
      draft.resolution_rung = 3;
      draft.detected_dl = result.dl;
      const edition = await resolveDL(result.dl);
      if (edition) {
        draft.edition = edition;
        draft.source = edition.source;
      }
      return draft;
    }

    // Rung 4: no identifier found. Try a network title/author search
    // (local fuzzy match was dropped — see catalogue.js). Ranked
    // candidates only, never a single accepted answer.
    draft.resolution_rung = 4;
    const candidates = await App.network.searchByText(result.text).catch(() => []);
    draft.candidates = candidates;
    return draft;
  }

  // Rung 5: explicit, always-available "log it anyway". No OCR required.
  // idPhotoBlob is only ever non-null here when this is called as the
  // fallback from a crashed OCR attempt (main.js) — the identification
  // photo that was captured still gets kept, per "keep every photo,
  // including from failed resolutions."
  function resolveManual(photoBlob, idPhotoBlob) {
    const draft = blankDraft();
    draft.resolution_rung = 5;
    draft.photo_blob = photoBlob || null;
    draft.id_photo_blob = idPhotoBlob || null;
    return draft;
  }

  return { resolveFromBarcode, resolveFromPhoto, resolveManual, blankDraft };
})();
