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

  // Runs OCR on an image blob exactly as given. Returns the raw recognized
  // text; callers apply their own regexes for ISBN / Depósito Legal / title
  // extraction. Kept as a simple single-pass primitive — recognizeBestRotation
  // below is what the app actually uses for captured photos.
  async function recognize(blob) {
    const worker = await getWorker();
    const { data } = await worker.recognize(blob);
    return data.text || "";
  }

  function rotateBlob(blob, degrees) {
    return createImageBitmap(blob).then((bitmap) => {
      const canvas = document.createElement("canvas");
      const swap = degrees === 90 || degrees === 270;
      canvas.width = swap ? bitmap.height : bitmap.width;
      canvas.height = swap ? bitmap.width : bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      bitmap.close();
      return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    });
  }

  // Try 0 degrees first (the fast path when capture orientation is already
  // correct), then the two 90-degree cases (the realistic real-world
  // failure — see below), then 180 last (rare, upside-down).
  //
  // WHY THIS EXISTS: getUserMedia video frames captured via canvas
  // drawImage() do not carry EXIF orientation the way a phone's own camera
  // app JPEGs do, and on-screen <video> preview orientation is not a
  // reliable guarantee that a canvas-captured frame from that same video
  // matches what the user sees — this is a documented cross-browser
  // getUserMedia+canvas inconsistency, most notably on iOS/WebKit. Verified
  // empirically against real Portuguese book photos (data/ocr_test/, not
  // committed): OCR on a sideways-rotated capture produced pure gibberish
  // and zero identifier matches on every test image; the same images
  // corrected to upright extracted the correct Depósito Legal number on
  // 2 of 3. Rather than trust any single orientation assumption, this
  // brute-forces all four and keeps whichever one actually works.
  const ROTATIONS = [0, 90, 270, 180];

  // Returns { text, isbn, dl, rotation, confidence } for whichever rotation
  // first produced a checksum-valid ISBN or a Depósito Legal match. If none
  // of the four do, returns the rotation with the highest OCR mean
  // confidence (Tesseract's own score, 0-100) as the best-effort fallback —
  // used as the rung 4 search text and the record's raw_ocr_text either way.
  //
  // onAttempt(degrees, index, total), if given, fires before each pass —
  // used to keep the UI's status line honest about what's actually
  // happening instead of one long unexplained wait.
  //
  // Known limitation, accepted rather than fixed: this returns on the first
  // rotation yielding EITHER identifier, so an ISBN read cleanly at 0° stops
  // the search before a Depósito Legal that only resolves at 90°. Since
  // ladder.js now prefers DL over ISBN, that costs a preference it would
  // otherwise have honoured. Left alone because on a ficha técnica both are
  // printed in the same orientation, so they come out of the same pass — and
  // the alternative (keep scanning after an ISBN hit, hunting for a DL)
  // would pay up to 4x the OCR time on every ISBN-only book to catch a case
  // that shouldn't arise. Worth revisiting only if real captures show it.
  async function recognizeBestRotation(blob, onAttempt) {
    const worker = await getWorker();
    let best = null;

    for (let i = 0; i < ROTATIONS.length; i++) {
      const deg = ROTATIONS[i];
      if (onAttempt) onAttempt(deg, i, ROTATIONS.length);

      const candidate = deg === 0 ? blob : await rotateBlob(blob, deg);
      const { data } = await worker.recognize(candidate);
      const text = data.text || "";
      const isbn = App.util.extractIsbnFromText(text);
      const dl = App.util.extractDLFromText(text);

      if (isbn || dl) {
        return { text, isbn, dl, rotation: deg, confidence: data.confidence };
      }
      if (!best || data.confidence > best.confidence) {
        best = { text, isbn: null, dl: null, rotation: deg, confidence: data.confidence };
      }
    }
    return best;
  }

  return { recognize, recognizeBestRotation };
})();
