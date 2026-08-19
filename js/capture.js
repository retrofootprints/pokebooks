// Camera lifecycle and photo capture/resize.
window.App = window.App || {};

App.capture = (function () {
  let stream = null;

  async function startCamera(videoEl) {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  // Draws the current video frame to a canvas at native resolution, for
  // barcode decoding (full-res helps small/blurry barcodes).
  function grabFrame(videoEl, canvasEl) {
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
    const ctx = canvasEl.getContext("2d");
    ctx.drawImage(videoEl, 0, 0);
    return canvasEl;
  }

  // Captures a photo, resized to a 1600px long edge, JPEG quality 0.8,
  // targeting under 300KB (per spec: "the photo is the record, not just
  // OCR input" — keep it, always show it back). Only the resized version
  // is kept; the original full-res frame is discarded after this returns.
  async function capturePhotoBlob(videoEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const longEdge = 1600;
    const scale = longEdge / Math.max(vw, vh);
    const w = Math.round(vw * Math.min(scale, 1));
    const h = Math.round(vh * Math.min(scale, 1));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(videoEl, 0, 0, w, h);

    let quality = 0.8;
    let blob = await canvasToBlob(canvas, quality);
    // Step quality down if we're well over target; a handful of tries is
    // enough for a one-book-at-a-time pilot, no need for a binary search.
    let attempts = 0;
    while (blob.size > 300 * 1024 && quality > 0.4 && attempts < 5) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, quality);
      attempts++;
    }
    return blob;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  return { startCamera, stopCamera, grabFrame, capturePhotoBlob };
})();
