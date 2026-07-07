// src/visualizer.js
// -----------------------------------------------------------------------------
// Live-signal visualizer. A small, self-contained module that paints the sound
// you're hearing — the master output — as a filled waveform, redrawn every
// animation frame. It taps audioEngine's master analyser (read-only, so it never
// colours the audio) and does nothing but draw.
//
//   Visualizer.start(canvasEl, { color })   -> begin animating into a <canvas>
//
// Silence collapses to a calm centre line; the moment a hit lands, the body
// fills and the crest trace brightens, so the panel breathes with the beat.
// -----------------------------------------------------------------------------

window.Visualizer = (function () {
  let raf = null;
  let current = { key: null, color: '#7C5CFF' }; // the selected drum to show underneath

  // "#E67E22" / "E67E22" -> "rgba(r,g,b,a)". Falls back to the accent orange.
  function hexA(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(230,126,34,' + a + ')';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' +
           parseInt(m[3], 16) + ',' + a + ')';
  }

  function start(canvas, opts) {
    if (!canvas || !canvas.getContext) return;
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const color = opts.color || '#E67E22';
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    // Match the canvas backing store to its laid-out size (crisp on HiDPI, and
    // it re-fits for free when the panel is resized or the phone rotates).
    function fit() {
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 90;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    }

    function frame() {
      fit();
      const W = canvas.width, H = canvas.height, mid = H / 2;
      ctx.clearRect(0, 0, W, H);

      const analyser = (window.audioEngine && audioEngine.getAnalyser)
        ? audioEngine.getAnalyser() : null;
      const values = analyser ? analyser.getValue() : null;

      let peak = 0;
      if (values) for (let i = 0; i < values.length; i++) {
        const v = Math.abs(values[i]);
        if (v > peak) peak = v;
      }
      const active = peak > 0.004; // below this the output is effectively silent

      // The SELECTED drum's full sample waveform, drawn as dense mirrored ink
      // bars — the bold "printed waveform" look, in our black-on-cream style.
      const gap = Math.max(1, Math.round(dpr));       // 1px bars…
      const stride = Math.max(1, Math.round(2 * dpr)); // …every ~2px, so it reads dense
      if (current.key && window.audioEngine && audioEngine.getWaveform) {
        const wave = audioEngine.getWaveform(current.key);
        if (wave && wave.length) {
          const per = Math.max(1, Math.floor(wave.length / (W / stride)));
          ctx.fillStyle = 'rgba(23,23,26,.86)';
          let bin = 0;
          for (let x = 0; x < W; x += stride) {
            let peak = 0;
            const start = bin * per;
            for (let j = 0; j < per; j++) {
              const a = Math.abs(wave[start + j] || 0);
              if (a > peak) peak = a;
            }
            bin++;
            const barH = Math.max(dpr, peak * H * 0.94);
            ctx.fillRect(x, mid - barH / 2, gap, barH);
          }
        }
      }

      // Faint centre guide, always present so the panel never reads as "off".
      ctx.strokeStyle = 'rgba(23,23,27,.14)';
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

      if (values && active) {
        const n = values.length;
        const amp = H * 0.46;

        // Filled body: trace the crest left-to-right, then the trough back.
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * W;
          const y = mid + values[i] * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let i = n - 1; i >= 0; i--) {
          const x = (i / (n - 1)) * W;
          ctx.lineTo(x, mid - values[i] * amp);
        }
        ctx.closePath();
        ctx.fillStyle = hexA(color, 0.18);
        ctx.fill();

        // Bright crest trace on top.
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * W;
          const y = mid + values[i] * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      raf = requestAnimationFrame(frame);
    }

    if (raf) cancelAnimationFrame(raf);
    frame();
  }

  // Tell the visualizer which drum's waveform to show underneath the live scope.
  function setSample(objectType, color) {
    current = { key: objectType || null, color: color || current.color };
  }

  return { start: start, setSample: setSample };
})();
