// src/vision/vision.js
// Real-time object detection via webcam + COCO-SSD.
// Works like face recognition but for physical objects — each detected item is
// mapped to a sample key and fired through cameraStub so the rest of the app
// treats it exactly like a manual scan.

window.Vision = (() => {

  const SCORE_THRESHOLD = 0.60;  // min confidence to accept a detection
  const DEBOUNCE_MS     = 2500;  // min gap between two scans of the same object

  // Maps COCO-SSD class names → objectSampleMap.json keys.
  const COCO_TO_SAMPLE = {
    'cup':          'cup',
    'wine glass':   'mug',
    'book':         'book',
    'suitcase':     'box',
    'bottle':       'bottle',
    'potted plant': 'plant',
    'cell phone':   'phone',
    'laptop':       'laptop',
    'mouse':        'mouse',
    'keyboard':     'keyboard',
    'scissors':     'pen',
    'remote':       'can',
  };

  let videoEl  = null;
  let canvasEl = null;
  let statusEl = null;
  let stream   = null;
  let model    = null;
  let running  = false;
  const lastScan = {};   // sampleKey -> timestamp, for per-object debounce

  // ── public ──────────────────────────────────────────────────────────────────

  async function start(videoElement, canvasElement, statusElement) {
    videoEl  = videoElement;
    canvasEl = canvasElement;
    statusEl = statusElement;

    setStatus('Starting camera…');

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      videoEl.srcObject = stream;
      await new Promise(resolve => videoEl.addEventListener('loadedmetadata', resolve, { once: true }));
      await videoEl.play();
      console.log('[Vision] camera started');
    } catch (err) {
      console.error('[Vision] camera error:', err);
      setStatus('Camera unavailable — ' + err.message);
      return;
    }

    setStatus('Loading detection model…');
    try {
      // cocoSsd is the global exposed by the coco-ssd UMD bundle loaded in index.html.
      model = await cocoSsd.load();
      console.log('[Vision] model ready');
    } catch (err) {
      console.error('[Vision] model load failed:', err);
      setStatus('Model failed to load (check network). Use manual scan below.');
      return;
    }

    running = true;
    setStatus('Ready — point camera at an object');
    detectLoop();
  }

  function stop() {
    running = false;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  // ── detection loop ───────────────────────────────────────────────────────────

  async function detectLoop() {
    if (!running || !model) return;

    let predictions = [];
    try {
      predictions = await model.detect(videoEl);
    } catch (err) {
      console.warn('[Vision] detect error', err);
    }

    drawOverlay(predictions);
    handleBestPrediction(predictions);

    requestAnimationFrame(detectLoop);
  }

  function handleBestPrediction(predictions) {
    // Find the highest-confidence prediction that maps to one of our samples.
    const mapped = predictions
      .filter(p => p.score >= SCORE_THRESHOLD && COCO_TO_SAMPLE[p.class])
      .sort((a, b) => b.score - a.score);

    if (mapped.length > 0) {
      const best      = mapped[0];
      const sampleKey = COCO_TO_SAMPLE[best.class];
      const now       = Date.now();

      if (!lastScan[sampleKey] || now - lastScan[sampleKey] > DEBOUNCE_MS) {
        lastScan[sampleKey] = now;
        setStatus('Scanned: ' + best.class + ' (' + Math.round(best.score * 100) + '%)');
        cameraStub.simulateScan(sampleKey);
      } else {
        setStatus('Detected: ' + best.class + ' — already scanned, hold on…');
      }
      return;
    }

    // Visible objects that don't map to a sample.
    const visible = predictions.filter(p => p.score >= SCORE_THRESHOLD);
    if (visible.length > 0) {
      setStatus('Detected: ' + visible[0].class + ' — no sample mapped');
    } else {
      setStatus('Ready — point camera at an object');
    }
  }

  // ── canvas overlay ───────────────────────────────────────────────────────────

  function drawOverlay(predictions) {
    if (!canvasEl || !videoEl.videoWidth) return;

    canvasEl.width  = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;

    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    predictions.forEach(pred => {
      if (pred.score < 0.40) return;

      const [x, y, w, h] = pred.bbox;
      const hit = !!COCO_TO_SAMPLE[pred.class];

      // Box
      ctx.strokeStyle = hit ? '#d8392b' : '#6f6e68';
      ctx.lineWidth   = hit ? 2.5 : 1.5;
      ctx.strokeRect(x, y, w, h);

      // Label chip
      const label = pred.class + '  ' + Math.round(pred.score * 100) + '%';
      ctx.font = 'bold 12px Bahnschrift, "Segoe UI", system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = hit ? '#d8392b' : '#6f6e68';
      ctx.fillRect(x, y > 20 ? y - 22 : y, tw + 10, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 5, (y > 20 ? y - 6 : y + 14));
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  return { start, stop };
})();
