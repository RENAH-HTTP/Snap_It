// src/vision/vision.js
// Real-time object detection via webcam + COCO-SSD.
// Works like face recognition but for physical objects — each detected item is
// mapped to a sample key and fired through cameraStub so the rest of the app
// treats it exactly like a manual scan.

window.Vision = (() => {

  const SCORE_THRESHOLD = 0.60;  // min confidence to accept a detection
  const DEBOUNCE_MS     = 2500;  // min gap between two scans of the same object
  const DETECT_EVERY_MS = 90;    // cap detection to ~11 Hz — running model.detect()
                                 // flat-out on every animation frame pegs a phone
                                 // GPU and makes the whole UI crawl. ~11 Hz is
                                 // still instant-feeling for scanning objects.

  // Classes we never react to or draw (people walk in front of the camera a lot).
  const IGNORED_CLASSES = { 'person': true };

  // Every COCO-SSD class maps to its own collectible object. The object key is
  // just the class name slugged ("wine glass" -> "wine_glass"), matching the
  // keys generated in data/objectSampleMap.json by build-objects.js.
  const COCO_CLASSES = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
    'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
    'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
    'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
    'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
    'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
    'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
    'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
    'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
    'hair drier', 'toothbrush',
  ];
  const COCO_TO_SAMPLE = {};
  COCO_CLASSES.forEach(function (c) { COCO_TO_SAMPLE[c] = c.replace(/\s+/g, '_'); });

  let videoEl  = null;
  let canvasEl = null;
  let statusEl = null;
  let stream   = null;
  let model    = null;
  let running  = false;
  let currentDeviceId = null;
  const lastScan = {};   // sampleKey -> timestamp, for per-object debounce

  // ── lazy dependency loading ─────────────────────────────────────────────────
  // TensorFlow.js and COCO-SSD are large; injecting them only when the scanner
  // first runs keeps the app's initial load fast on phones / very old laptops.
  let depsPromise = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadDeps() {
    if (depsPromise) return depsPromise;
    depsPromise = (async function () {
      if (typeof tf === 'undefined') await loadScript('vendor/tf.min.js');
      if (typeof cocoSsd === 'undefined') await loadScript('vendor/coco-ssd.min.js');
    })();
    return depsPromise;
  }

  // ── camera plumbing ─────────────────────────────────────────────────────────

  async function openStream(deviceId) {
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : { video: true, audio: false };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = stream;
    await new Promise(resolve => videoEl.addEventListener('loadedmetadata', resolve, { once: true }));
    await videoEl.play();
    const track = stream.getVideoTracks()[0];
    currentDeviceId =
      (track && track.getSettings && track.getSettings().deviceId) || deviceId || null;
  }

  // Cameras available to the page (labels appear once permission is granted).
  async function listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || ('Camera ' + (i + 1)) }));
    } catch (e) {
      return [];
    }
  }

  // Swap to another camera; the detection loop keeps running on the new feed.
  async function setCamera(deviceId) {
    if (!videoEl || !deviceId || deviceId === currentDeviceId) return;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    try {
      await openStream(deviceId);
      setStatus('Ready — point camera at an object');
      console.log('[Vision] switched camera to', deviceId);
    } catch (err) {
      console.error('[Vision] camera switch failed:', err);
      setStatus('Camera switch failed — ' + err.message);
    }
  }

  // ── public ──────────────────────────────────────────────────────────────────

  async function start(videoElement, canvasElement, statusElement) {
    if (running) return;              // already scanning — ignore double-starts
    videoEl  = videoElement;
    canvasEl = canvasElement;
    statusEl = statusElement;

    setStatus('Starting camera…');

    try {
      await openStream(null);
      console.log('[Vision] camera started');
    } catch (err) {
      console.error('[Vision] camera error:', err);
      setStatus('Camera unavailable — ' + err.message);
      return;
    }

    // Reuse the model across camera on/off toggles — reloading the weights every
    // time is slow and pointless.
    if (!model) {
      setStatus('Loading detection model…');
      try {
        // Load TensorFlow + COCO-SSD on demand (kept out of the boot path for speed).
        await loadDeps();
        // cocoSsd is the global exposed by the coco-ssd UMD bundle.
        model = await cocoSsd.load();
        console.log('[Vision] model ready');
      } catch (err) {
        console.error('[Vision] model load failed:', err);
        setStatus('Model failed to load (check network). Use manual scan below.');
        return;
      }
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

    const t0 = performance.now();

    // Skip the expensive detect entirely while the tab/screen is backgrounded or
    // the video frame isn't ready — just reschedule.
    if (!document.hidden && videoEl && videoEl.readyState >= 2) {
      let predictions = [];
      try {
        predictions = await model.detect(videoEl);
      } catch (err) {
        console.warn('[Vision] detect error', err);
      }
      drawOverlay(predictions);
      handleBestPrediction(predictions);
    }

    if (!running) return;
    // Pace the loop: wait out the remainder of the interval after detection
    // (which itself can take tens of ms) instead of firing back-to-back.
    const wait = Math.max(0, DETECT_EVERY_MS - (performance.now() - t0));
    setTimeout(detectLoop, wait);
  }

  function handleBestPrediction(predictions) {
    // Drop ignored classes (e.g. people) before doing anything with them.
    predictions = predictions.filter(p => !IGNORED_CLASSES[p.class]);

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
      if (IGNORED_CLASSES[pred.class]) return;   // never draw people

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

  return {
    start, stop, listCameras, setCamera,
    isRunning: () => running,
    currentCamera: () => currentDeviceId,
  };
})();
