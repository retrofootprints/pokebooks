// OCR via tesseract.js, Portuguese tessdata_fast model. Used for rung 2
// (printed ISBN, no barcode), rung 3 (Depósito Legal), and rung 4 (title
// page text for fuzzy matching).
window.App = window.App || {};

App.ocr = (function () {
  let workerPromise = null;

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker("por", 1, {
        workerPath: "lib/tesseract/worker.min.js",
        corePath: "lib/tesseract-core",
        langPath: "lib/tessdata",
        cacheMethod: "none", // pilot: don't fight IndexedDB quota with a second cache layer
      });
      return worker;
    })();
    return workerPromise;
  }

  // Runs OCR on an image blob (the same resized capture used for the
  // encounter photo). Returns the raw recognized text; callers apply their
  // own regexes for ISBN / Depósito Legal / title extraction.
  async function recognize(blob) {
    const worker = await getWorker();
    const { data } = await worker.recognize(blob);
    return data.text || "";
  }

  return { recognize };
})();
