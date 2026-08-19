// Barcode scanning: native BarcodeDetector where available (Chrome/Android),
// zxing-wasm fallback otherwise (Safari has no native BarcodeDetector).
//
// Rung 1 rules (see pt-book-encounter-pilot-spec.md):
//   - Only EAN-13 with a 978/979 (Bookland) prefix IS the ISBN-13. Anything
//     else (library/shop accession-number stickers) must be rejected
//     explicitly, not silently ignored.
//   - EAN-5 price add-on barcodes, printed next to the main barcode on many
//     books, must be ignored rather than reported as a failed scan.
window.App = window.App || {};

App.barcode = (function () {
  const hasNative = "BarcodeDetector" in window;
  let nativeDetector = null;
  let zxingReady = false;

  async function ensureNative() {
    if (nativeDetector) return nativeDetector;
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes("ean_13")) throw new Error("ean_13 not supported by native BarcodeDetector");
    nativeDetector = new window.BarcodeDetector({ formats: ["ean_13"] });
    return nativeDetector;
  }

  function ensureZxing() {
    if (zxingReady) return;
    ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path) => "lib/zxing/" + path },
    });
    zxingReady = true;
  }

  // Classifies a raw scanned value. Returns:
  //   { status: "isbn", isbn13 }          — valid Bookland EAN-13
  //   { status: "not-bookland", raw }     — valid EAN-13 but not 978/979
  //   { status: "addon-ignored" }         — EAN-5 price add-on, ignore silently
  function classify(rawValue, format) {
    const digits = (rawValue || "").replace(/\D/g, "");
    if (format === "ean_5" || digits.length === 5) {
      return { status: "addon-ignored" };
    }
    if (digits.length !== 13 || !App.util.validEan13(digits)) {
      return { status: "invalid" };
    }
    if (digits.startsWith("978") || digits.startsWith("979")) {
      return { status: "isbn", isbn13: digits };
    }
    return { status: "not-bookland", raw: digits };
  }

  // Scans repeatedly from the live video until a book (978/979) barcode is
  // found or the scan is cancelled. Non-Bookland and add-on codes are
  // reported via onReject/ignored so the UI can say so, rather than the
  // loop just silently continuing forever with no feedback.
  function startScanLoop(videoEl, canvasEl, { onBook, onReject, onTick }) {
    let cancelled = false;
    ensureZxing();

    async function tick() {
      if (cancelled) return;
      try {
        let results = [];
        if (hasNative) {
          const detector = await ensureNative();
          const found = await detector.detect(videoEl);
          results = found.map((f) => ({ rawValue: f.rawValue, format: "ean_13" }));
        } else {
          App.capture.grabFrame(videoEl, canvasEl);
          const blob = await new Promise((res) => canvasEl.toBlob(res, "image/jpeg", 0.85));
          if (blob) {
            const zResults = await ZXingWASM.readBarcodes(blob, {
              formats: ["EAN-13", "EAN-5"],
              tryHarder: true,
            });
            results = zResults.map((r) => ({ rawValue: r.text, format: r.format === "EAN-5" ? "ean_5" : "ean_13" }));
          }
        }

        if (onTick) onTick(results.length > 0);

        for (const r of results) {
          const cls = classify(r.rawValue, r.format);
          if (cls.status === "isbn") {
            cancelled = true;
            onBook(cls.isbn13);
            return;
          } else if (cls.status === "not-bookland") {
            onReject(cls.raw);
            // keep scanning — user may re-aim at the actual book barcode
          }
          // addon-ignored / invalid: say nothing, keep scanning
        }
      } catch (err) {
        // transient decode errors are normal (blurry frame, nothing in
        // view) — only surface via onTick(false), never abort the loop
      }
      if (!cancelled) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
    return {
      cancel() {
        cancelled = true;
      },
    };
  }

  return { hasNative, startScanLoop, classify };
})();
