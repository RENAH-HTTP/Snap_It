// src/vision/vision.js
// Real-time object detection via webcam + COCO-SSD.
// Works like face recognition but for physical objects — each detected item is
// mapped to a sample key and fired through cameraStub so the rest of the app
// treats it exactly like a manual scan.

window.Vision = (() => {

  const SCORE_THRESHOLD = 0.60;  // min confidence to accept a detection
  const DEBOUNCE_MS     = 2500;  // min gap between two scans of the same object
  const DETECT_EVERY_MS = 90;    // fastest allowed detection cadence (~11 Hz).
                                 // The loop paces itself off the measured cost of
                                 // a model pass (see detectLoop), so a slow
                                 // machine automatically detects less often
                                 // instead of pegging the GPU and freezing the UI.
  const DETECT_MAX_MS   = 480;   // never back off past ~2 Hz — scanning should
                                 // still feel live on the slowest laptop
  const DETECT_WIDTH    = 320;   // frames are downscaled to this width before
                                 // detection; COCO-SSD shrinks its input anyway,
                                 // so uploading full camera frames to the GPU
                                 // each pass was pure waste
  const SUSPEND_AFTER_MS = 3000; // how long the scanner can be out of sight
                                 // before the camera is quietly parked

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

  // Auto-suspend: the camera is parked (tracks stopped, LED off) while the tab
  // is backgrounded or the scanner panel is scrolled out of view, and revived
  // when it comes back. `running` stays true — suspension is invisible to the
  // rest of the app.
  let suspended    = false;
  let resuming     = false;  // an openStream() is in flight
  let panelVisible = true;   // is the scanner panel on screen (IntersectionObserver)
  let suspendTimer = null;
  let watching     = false;  // visibility listeners attached (once)

  let detCanvas = null;      // downscaled copy of the frame handed to the model
  let detCtx    = null;
  let avgDetectMs = 50;      // rolling cost of one model pass, drives the pacing

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
    // Ask for a modest feed. Bare `video: true` hands back 1080p30 on most
    // laptops, and just compositing that video element burned more of the frame
    // budget than detection itself. 640×480@15 is plenty for object scanning
    // (`ideal` never rejects — a camera that can't comply gives its closest).
    const video = {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 15, max: 24 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: false });
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
    if (suspended) {
      // Parked — just remember the choice; resume will open this device.
      currentDeviceId = deviceId;
      return;
    }
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
    suspended = false;
    watchVisibility();
    setStatus('Ready — point camera at an object');
    detectLoop();
  }

  function stop() {
    running = false;
    suspended = false;
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  // ── auto-suspend while out of sight ─────────────────────────────────────────

  function suspend(reason) {
    if (!running || suspended) return;
    suspended = true;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    setStatus('Camera paused — ' + reason);
    console.log('[Vision] camera suspended (' + reason + ')');
  }

  async function resumeIfNeeded() {
    if (!running || !suspended || resuming) return;
    if (document.hidden || !panelVisible) return;
    resuming = true;
    try {
      await openStream(currentDeviceId);
      suspended = false;
      setStatus('Ready — point camera at an object');
      console.log('[Vision] camera resumed');
    } catch (err) {
      console.error('[Vision] camera resume failed:', err);
      setStatus('Camera unavailable — ' + err.message);
    }
    resuming = false;
  }

  // Wait a moment before cutting the stream so flicking between modules doesn't
  // bounce the camera (a cold reopen can take up to a second).
  function scheduleSuspend(reason) {
    if (suspendTimer || suspended || !running) return;
    suspendTimer = setTimeout(function () {
      suspendTimer = null;
      if (document.hidden || !panelVisible) suspend(reason);
    }, SUSPEND_AFTER_MS);
  }

  function cancelSuspend() {
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
  }

  function watchVisibility() {
    if (watching) return;
    watching = true;

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) scheduleSuspend('tab in background');
      else { cancelSuspend(); resumeIfNeeded(); }
    });

    // On the phone deck the scanner is one page of a horizontal strip — when the
    // user slides to the mixer/sequencer, the camera has no business running.
    if (typeof IntersectionObserver !== 'undefined' && videoEl) {
      new IntersectionObserver(function (entries) {
        const e = entries[entries.length - 1];
        panelVisible = !!(e && e.isIntersecting);
        if (!panelVisible) scheduleSuspend('scanner off-screen');
        else { cancelSuspend(); resumeIfNeeded(); }
      }, { threshold: 0.05 }).observe(videoEl);
    }
  }

  // ── detection loop ───────────────────────────────────────────────────────────

  // Copy the current frame into a small scratch canvas for the model. Detection
  // accuracy is unchanged (COCO-SSD downscales internally anyway) but the GPU
  // upload per pass shrinks by an order of magnitude.
  function grabFrame() {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return null;
    const w = Math.min(DETECT_WIDTH, vw);
    const h = Math.round(vh * (w / vw));
    if (!detCanvas) {
      detCanvas = document.createElement('canvas');
      detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (detCanvas.width !== w || detCanvas.height !== h) {
      detCanvas.width = w;
      detCanvas.height = h;
    }
    detCtx.drawImage(videoEl, 0, 0, w, h);
    return detCanvas;
  }

  async function detectLoop() {
    if (!running || !model) return;

    const t0 = performance.now();
    let ran = false;

    // Skip the expensive detect entirely while suspended/backgrounded or the
    // video frame isn't ready — just reschedule a cheap poll.
    if (!suspended && !document.hidden && videoEl && videoEl.readyState >= 2) {
      const frame = grabFrame();
      if (frame) {
        let predictions = [];
        try {
          predictions = await model.detect(frame);
        } catch (err) {
          console.warn('[Vision] detect error', err);
        }
        drawOverlay(predictions, videoEl.videoWidth / frame.width);
        handleBestPrediction(predictions);
        ran = true;
      }
    }

    if (!running) return;

    let wait;
    if (ran) {
      // Pace to the machine: track what a pass really costs and never spend
      // more than ~1/3 of wall time detecting. While the sequencer is playing,
      // back off further — glitch-free audio beats scan latency.
      avgDetectMs = avgDetectMs * 0.7 + (performance.now() - t0) * 0.3;
      wait = Math.max(DETECT_EVERY_MS, avgDetectMs * 2.5);
      if (window.audioEngine && audioEngine.isPlaying && audioEngine.isPlaying()) {
        wait = Math.max(wait, 240);
      }
      wait = Math.min(wait, DETECT_MAX_MS);
      wait = Math.max(0, wait - (performance.now() - t0));
    } else {
      wait = 300; // idle poll while parked
    }
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

  // `scale` maps bbox coords from the downscaled detection frame back to the
  // full-size video the overlay sits on.
  function drawOverlay(predictions, scale) {
    if (!canvasEl || !videoEl.videoWidth) return;

    // Resize the backing store only when the feed size actually changes —
    // reassigning width/height every pass reallocates the canvas and forces a
    // fresh paint even for identical frames.
    if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
      canvasEl.width  = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
    }

    const s = scale || 1;
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    predictions.forEach(pred => {
      if (pred.score < 0.40) return;
      if (IGNORED_CLASSES[pred.class]) return;   // never draw people

      const x = pred.bbox[0] * s, y = pred.bbox[1] * s,
            w = pred.bbox[2] * s, h = pred.bbox[3] * s;
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
