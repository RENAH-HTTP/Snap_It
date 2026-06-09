// ui.js
// -----------------------------------------------------------------------------
// All DOM rendering and event wiring. This is the only module that touches the
// page. It orchestrates startup, then renders the three tabs:
//   - Scan      : simulate scanning an object to unlock its sample
//   - Library   : grid of every sample (unlocked = playable, locked = silhouette)
//   - Sequencer : the 16-step grid + transport controls
//
// State lives in the other modules (library + audioEngine). The UI keeps only a
// tiny mirror of which tracks exist so it can re-draw the sequencer rows.
// -----------------------------------------------------------------------------

const ui = (function () {
  // Rows currently shown in the sequencer: { id, objectType, displayName }.
  // The on/off step state itself lives in audioEngine; the DOM reflects it.
  let sequencerTracks = [];

  // ---- startup ---------------------------------------------------------------

  async function init() {
    console.log('[ui] starting up');

    // Load data first, then the audio engine (it reads the sample map).
    await library.load();
    // Fill in waveforms as each sample's buffer finishes downloading.
    audioEngine.onSampleLoaded(redrawWaveforms);
    await audioEngine.init();

    setupTabs();
    setupSequencerTransport();

    // Start the live camera + object detection.
    Vision.start(
      document.getElementById('camera-video'),
      document.getElementById('camera-canvas'),
      document.getElementById('vision-status')
    );
    renderLibrary();
    renderSequencer();
    startScope();

    // When an object is "scanned" (button today, camera later), unlock it.
    cameraStub.onObjectScanned(handleScan);

    // Highlight the playing column as the sequence advances.
    audioEngine.onStep(highlightStep);

    console.log('[ui] ready');
  }

  // ---- tabs ------------------------------------------------------------------

  function setupTabs() {
    const buttons = document.querySelectorAll('.tab-button');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = btn.getAttribute('data-tab');

        // Switching tabs only toggles visibility — nothing is re-rendered, so
        // each tab keeps its state (sequencer steps, scroll, etc.).
        document.querySelectorAll('.tab-button').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        document.querySelectorAll('.tab-panel').forEach(function (panel) {
          panel.classList.toggle('active', panel.id === 'tab-' + target);
        });
        console.log('[ui] switched to tab:', target);
      });
    });
  }

  function switchToTab(name) {
    const btn = document.querySelector('.tab-button[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  // ---- scan tab --------------------------------------------------------------
  // Scanning is fully automatic now: Vision detects an object via the webcam and
  // calls cameraStub.simulateScan(), which fires handleScan below.

  // Runs whenever an object is scanned. Unlocks it and shows the reveal.
  function handleScan(objectType) {
    const result = library.unlock(objectType);
    showReveal(result);
    renderLibrary(); // a freshly-unlocked sample is no longer a silhouette
  }

  // ---- reveal modal ----------------------------------------------------------

  function showReveal(result) {
    const modal = document.getElementById('reveal-modal');
    const title = document.getElementById('reveal-title');
    const name = document.getElementById('reveal-name');

    title.textContent = result.isNewUnlock ? 'You unlocked:' : 'Already collected:';
    name.textContent = result.sampleInfo.displayName + ' (' + result.objectType + ')';
    modal.classList.add('active');
  }

  function hideReveal() {
    document.getElementById('reveal-modal').classList.remove('active');
  }

  // ---- sample classification -------------------------------------------------
  // Derive a drum "type" (for colour-coding, à la Emergent Drums) and a stable
  // rarity tier (for the trading-card foil treatment) from a sample. Nothing in
  // the data file declares these — we infer the type from the display name and
  // hash the object key for a deterministic rarity.

  // Muted, desaturated type colours (Emergent-style: subtle on near-black).
  const SAMPLE_TYPES = {
    kick:    { label: 'Kick',    icon: '🥁', color: '#8585c4', tint: 'rgba(133,133,196,.16)', glow: 'rgba(133,133,196,.3)' },
    snare:   { label: 'Snare',   icon: '🎯', color: '#cc8f8a', tint: 'rgba(204,143,138,.16)', glow: 'rgba(204,143,138,.3)' },
    hat:     { label: 'Hi-Hat',  icon: '🎩', color: '#86bd79', tint: 'rgba(134,189,121,.15)', glow: 'rgba(134,189,121,.3)' },
    clap:    { label: 'Clap',    icon: '👏', color: '#c690bf', tint: 'rgba(198,144,191,.15)', glow: 'rgba(198,144,191,.3)' },
    bass:    { label: 'Bass',    icon: '🔊', color: '#7fa0cf', tint: 'rgba(127,160,207,.15)', glow: 'rgba(127,160,207,.3)' },
    tom:     { label: 'Tom',     icon: '🛢️', color: '#c2bd83', tint: 'rgba(194,189,131,.14)', glow: 'rgba(194,189,131,.3)' },
    cowbell: { label: 'Cowbell', icon: '🔔', color: '#cdab6a', tint: 'rgba(205,171,106,.15)', glow: 'rgba(205,171,106,.3)' },
    perc:    { label: 'Perc',    icon: '🪘', color: '#6fb8c4', tint: 'rgba(111,184,196,.15)', glow: 'rgba(111,184,196,.3)' },
    horn:    { label: 'Horn',    icon: '📯', color: '#cf9f78', tint: 'rgba(207,159,120,.15)', glow: 'rgba(207,159,120,.3)' },
    fx:      { label: 'FX',      icon: '💥', color: '#a394c0', tint: 'rgba(163,148,192,.15)', glow: 'rgba(163,148,192,.3)' },
  };

  const RARITIES = {
    common:    'Common',
    rare:      '★ Rare',
    epic:      '★★ Epic',
    legendary: '★★★ Legendary',
  };

  function describeSample(objectType, displayName) {
    const n = (displayName || '').toLowerCase();
    let cat = 'fx';
    if      (n.includes('kick'))                       cat = 'kick';
    else if (n.includes('snare') || n.includes('rim')) cat = 'snare';
    else if (n.includes('hat'))                        cat = 'hat';
    else if (n.includes('clap'))                       cat = 'clap';
    else if (n.includes('bass'))                       cat = 'bass';
    else if (n.includes('tom'))                        cat = 'tom';
    else if (n.includes('cowbell'))                    cat = 'cowbell';
    else if (n.includes('perc') || n.includes('popper')) cat = 'perc';
    else if (n.includes('horn'))                       cat = 'horn';

    // Deterministic flavour: hash the key so a sample always looks the same.
    let h = 0;
    for (let i = 0; i < objectType.length; i++) h = (h * 31 + objectType.charCodeAt(i)) >>> 0;
    const tier = h % 16;
    let rarity = 'common';
    if (tier === 0)      rarity = 'legendary';
    else if (tier <= 2)  rarity = 'epic';
    else if (tier <= 6)  rarity = 'rare';

    // Decorative MIDI-style note + choke group, mirroring Emergent Drums' header.
    const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const note  = NOTES[h % 12] + (1 + (h >> 4) % 4);
    const choke = (h % 6 === 0) ? 'None' : ('Self');

    return { type: SAMPLE_TYPES[cat], rarity: rarity, note: note, choke: choke };
  }

  // ---- waveform drawing ------------------------------------------------------
  // Draws a sample's static waveform onto a <canvas>. Uses the canvas's intrinsic
  // width/height (not its laid-out size) so it works even while the tab is hidden.
  // If the sample isn't loaded yet it draws a faint idle line; onSampleLoaded()
  // later calls redrawWaveforms() to fill it in.

  function drawWaveform(canvas, objectType, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    const data = audioEngine.getWaveform(objectType);
    if (!data) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      return;
    }

    const step = Math.max(1, Math.floor(data.length / w));
    ctx.fillStyle = color;
    for (let x = 0; x < w; x++) {
      let peak = 0;
      const start = x * step;
      for (let i = 0; i < step; i++) {
        const v = Math.abs(data[start + i] || 0);
        if (v > peak) peak = v;
      }
      const barH = Math.max(1, peak * h * 0.92);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, mid - barH / 2, 1, barH);
    }
    ctx.globalAlpha = 1;
    // faint centre line
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  }

  // Redraw every on-screen waveform canvas for a sample (library + pads).
  function redrawWaveforms(objectType) {
    document.querySelectorAll('canvas[data-otype="' + objectType + '"]').forEach(function (c) {
      drawWaveform(c, objectType, c.getAttribute('data-color') || '#7c5cff');
    });
  }

  // ---- draggable fader / slider helpers --------------------------------------
  // The four vertical faders map to a real ADSR envelope; the tune slider maps
  // to ±100 cents. Both report a normalised 0..1 value as you drag.

  const ADSR_SPECS = [
    { label: 'A', field: 'attack',  min: 0, max: 0.40 },
    { label: 'D', field: 'decay',   min: 0, max: 0.60 },
    { label: 'S', field: 'sustain', min: 0, max: 1.00 },
    { label: 'R', field: 'release', min: 0, max: 1.20 },
  ];

  // Vertical fader: top of the track = 1, bottom = 0.
  function attachVFader(vfader, initial, onChange) {
    const handle = vfader.querySelector('.vhandle');
    const track = vfader.querySelector('.vtrack');
    function set(v) {
      v = Math.max(0, Math.min(1, v));
      handle.style.setProperty('--p', ((1 - v) * 100) + '%');
      onChange(v);
    }
    set(initial);
    function fromEvent(e) {
      const r = track.getBoundingClientRect();
      set(1 - (e.clientY - r.top) / r.height);
    }
    vfader.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      vfader.setPointerCapture(e.pointerId);
      fromEvent(e);
      function move(ev) { fromEvent(ev); }
      function up() {
        vfader.removeEventListener('pointermove', move);
        vfader.removeEventListener('pointerup', up);
      }
      vfader.addEventListener('pointermove', move);
      vfader.addEventListener('pointerup', up);
    });
  }

  // Horizontal slider: left = 0, right = 1.
  function attachHSlider(hslider, initial, onChange) {
    const knob = hslider.querySelector('.hknob');
    function set(n) {
      n = Math.max(0, Math.min(1, n));
      knob.style.setProperty('--p', (n * 100) + '%');
      onChange(n);
    }
    set(initial);
    function fromEvent(e) {
      const r = hslider.getBoundingClientRect();
      set((e.clientX - r.left) / r.width);
    }
    hslider.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      hslider.setPointerCapture(e.pointerId);
      fromEvent(e);
      function move(ev) { fromEvent(ev); }
      function up() {
        hslider.removeEventListener('pointermove', move);
        hslider.removeEventListener('pointerup', up);
      }
      hslider.addEventListener('pointermove', move);
      hslider.addEventListener('pointerup', up);
    });
  }

  // ---- library tab -----------------------------------------------------------

  function renderLibrary() {
    const grid = document.getElementById('library-grid');
    grid.innerHTML = '';
    const map = library.getAllSampleInfo();

    Object.keys(map).forEach(function (objectType) {
      const info = map[objectType];
      const unlocked = library.isUnlocked(objectType);
      const cell = document.createElement('div');

      if (!unlocked) {
        // Undiscovered slot.
        cell.className = 'mod locked';
        cell.innerHTML =
          '<div class="mod-locked">' +
            '<div class="mod-locked-mark">?</div>' +
            '<div class="mod-locked-label">Undiscovered</div>' +
          '</div>';
        grid.appendChild(cell);
        return;
      }

      const d = describeSample(objectType, info.displayName);
      cell.className = 'mod';
      cell.style.setProperty('--type-color', d.type.color);

      const playSvg =
        '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">' +
          '<path d="M5 3.4v9.2l8-4.6z"/>' +
        '</svg>';

      cell.innerHTML =
        '<div class="mod-head">' +
          '<span class="mod-name"><span class="nm"></span></span>' +
          '<span class="mod-spacer"></span>' +
          '<button class="mod-add" title="Add to sequencer">+ Seq</button>' +
        '</div>' +
        '<div class="mod-body">' +
          '<div class="mod-wave-col"><canvas class="mod-wave" width="360" height="72"></canvas></div>' +
          '<div class="mod-fader-col"><div class="mod-faders">' +
            '<div class="vfader" title="Attack"><div class="vtrack"></div><div class="vhandle"></div></div>' +
            '<div class="vfader" title="Decay"><div class="vtrack"></div><div class="vhandle"></div></div>' +
            '<div class="vfader" title="Sustain"><div class="vtrack"></div><div class="vhandle"></div></div>' +
            '<div class="vfader" title="Release"><div class="vtrack"></div><div class="vhandle"></div></div>' +
          '</div></div>' +
        '</div>' +
        '<div class="mod-controls">' +
          '<div class="mc-row">' +
            '<div class="mc-left">' +
              '<button class="mc-btn play" title="Preview">' + playSvg + '</button>' +
            '</div>' +
            '<div class="mc-right"><span>A</span><span>D</span><span>S</span><span>R</span></div>' +
          '</div>' +
          '<div class="mc-row">' +
            '<div class="mc-left">' +
              '<span class="mc-sym" title="Tune down / up">&#9837;</span>' +
              '<div class="hslider tune" title="Tune"><div class="hknob"></div></div>' +
              '<span class="mc-sym">&#9839;</span>' +
            '</div>' +
            '<div class="mc-right tune-readout"><span></span></div>' +
          '</div>' +
        '</div>';

      const nameEl = cell.querySelector('.mod-name .nm');
      nameEl.textContent = info.displayName;
      cell.querySelector('.mod-name').title = info.displayName;

      // Waveform (real, drawn from the decoded buffer).
      const canvas = cell.querySelector('.mod-wave');
      canvas.setAttribute('data-otype', objectType);
      canvas.setAttribute('data-color', d.type.color);
      drawWaveform(canvas, objectType, d.type.color);
      canvas.addEventListener('click', function () { audioEngine.previewSample(objectType); });

      // Wiring.
      cell.querySelector('.mc-btn.play').addEventListener('click', function () {
        audioEngine.previewSample(objectType);
      });
      cell.querySelector('.mod-add').addEventListener('click', function () {
        addTrack(objectType, info.displayName);
      });

      // ADSR faders + tune — initialised from the engine's current settings.
      const s = audioEngine.getSampleSettings(objectType) ||
                { attack: 0.005, decay: 0.2, sustain: 1, release: 0.3, cents: 0 };
      const faderEls = cell.querySelectorAll('.vfader');
      ADSR_SPECS.forEach(function (spec, i) {
        const norm = (s[spec.field] - spec.min) / (spec.max - spec.min);
        attachVFader(faderEls[i], norm, function (n) {
          audioEngine.setSampleEnv(objectType, spec.field, spec.min + n * (spec.max - spec.min));
        });
      });

      // Tune in semitones, ±48. Slider 0..1 maps to -48..+48 st (×100 = cents).
      const tuneSlider = cell.querySelector('.hslider.tune');
      const tuneReadout = cell.querySelector('.tune-readout span');
      attachHSlider(tuneSlider, (s.cents / 100 + 48) / 96, function (n) {
        const st = Math.round(n * 96 - 48);
        audioEngine.setSampleCents(objectType, st * 100);
        tuneReadout.textContent = (st > 0 ? '+' : '') + st + ' st';
        tuneSlider.title = 'Tune ' + (st > 0 ? '+' : '') + st + ' st';
      });

      grid.appendChild(cell);
    });
  }

  // ---- oscilloscope ----------------------------------------------------------
  // A continuous animation reading the master-output analyser. When nothing is
  // playing the signal is silent, so it shows a flat centre line.

  function startScope() {
    const canvas = document.getElementById('scope-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function frame() {
      const w = canvas.width, h = canvas.height, mid = h / 2;
      ctx.clearRect(0, 0, w, h);

      const analyser = audioEngine.getAnalyser();
      const values = analyser ? analyser.getValue() : null;

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#8585c4';
      ctx.shadowColor = 'rgba(133,133,196,.6)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      if (values && values.length) {
        const n = values.length;
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * w;
          const y = mid + values[i] * (h * 0.46);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {
        ctx.moveTo(0, mid); ctx.lineTo(w, mid);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---- sequencer tab ---------------------------------------------------------

  function addTrack(objectType, displayName) {
    const trackId = audioEngine.addTrackToSequencer(objectType);
    sequencerTracks.push({ id: trackId, objectType: objectType, displayName: displayName });
    renderSequencer();
    switchToTab('sequencer'); // jump to the grid so the new row is visible
  }

  function renderSequencer() {
    const container = document.getElementById('sequencer-tracks');
    container.innerHTML = '';

    if (sequencerTracks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No tracks yet. Go to the Library tab and add a sample.';
      container.appendChild(empty);
      return;
    }

    sequencerTracks.forEach(function (track) {
      const d = describeSample(track.objectType, track.displayName);

      const block = document.createElement('div');
      block.className = 'track-block';

      const row = document.createElement('div');
      row.className = 'track-row';

      // Label, colour-coded by drum type.
      const label = document.createElement('div');
      label.className = 'track-label';
      label.style.setProperty('--type-color', d.type.color);
      label.style.setProperty('--type-tint', d.type.tint);
      label.textContent = track.displayName;
      row.appendChild(label);

      const stepCells = [];
      const laneCells = [];

      // Apply a step's pitch and update BOTH its step indicator and lane cell.
      function setPitch(i, val) {
        const p = audioEngine.setStepPitch(track.id, i, val);
        const sp = stepCells[i].querySelector('.step-pitch');
        sp.textContent = p === 0 ? '' : (p > 0 ? '+' + p : '' + p);
        stepCells[i].classList.toggle('tuned', p !== 0);
        const lc = laneCells[i];
        lc.textContent = p === 0 ? '0' : (p > 0 ? '+' + p : '' + p);
        lc.classList.toggle('nz', p !== 0);
        lc.title = 'Step ' + (i + 1) + ' pitch ' + (p > 0 ? '+' : '') + p + ' st';
      }

      // 16 step cells (click = on/off).
      const steps = document.createElement('div');
      steps.className = 'track-steps';
      for (let i = 0; i < audioEngine.STEP_COUNT; i++) {
        const cell = document.createElement('button');
        cell.className = 'step';
        if (i % 4 === 0) cell.classList.add('beat-start');
        cell.setAttribute('data-step', i);
        cell.classList.toggle('on', audioEngine.getStepOn(track.id, i));
        const pitchLabel = document.createElement('span');
        pitchLabel.className = 'step-pitch';
        cell.appendChild(pitchLabel);
        (function (i) {
          cell.addEventListener('click', function () {
            cell.classList.toggle('on', audioEngine.toggleStep(track.id, i));
          });
        })(i);
        stepCells.push(cell);
        steps.appendChild(cell);
      }
      row.appendChild(steps);

      // Mute toggle.
      const mute = document.createElement('button');
      mute.className = 'track-mute';
      mute.textContent = 'Mute';
      mute.addEventListener('click', function () {
        const nowMuted = !mute.classList.contains('active');
        mute.classList.toggle('active', nowMuted);
        audioEngine.setTrackMute(track.id, nowMuted);
      });
      row.appendChild(mute);

      // Remove track.
      const remove = document.createElement('button');
      remove.className = 'track-remove';
      remove.textContent = '✕';
      remove.title = 'Remove track';
      remove.addEventListener('click', function () {
        audioEngine.removeTrack(track.id);
        sequencerTracks = sequencerTracks.filter(function (t) { return t.id !== track.id; });
        renderSequencer();
      });
      row.appendChild(remove);

      block.appendChild(row);

      // ----- visible per-step PITCH lane (drag a cell up/down to tune) -----
      const lane = document.createElement('div');
      lane.className = 'pitch-lane';
      const laneLabel = document.createElement('div');
      laneLabel.className = 'pitch-lane-label';
      laneLabel.textContent = 'Pitch';
      lane.appendChild(laneLabel);

      const laneCellsWrap = document.createElement('div');
      laneCellsWrap.className = 'pitch-cells';
      for (let i = 0; i < audioEngine.STEP_COUNT; i++) {
        const pc = document.createElement('div');
        pc.className = 'pitch-cell';
        if (i % 4 === 0) pc.classList.add('beat-start');
        (function (i) {
          // Drag vertically (≈6px per semitone), scroll, or right-click/double-click to reset.
          pc.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            pc.setPointerCapture(e.pointerId);
            const startY = e.clientY;
            const startVal = audioEngine.getStepPitch(track.id, i);
            function move(ev) { setPitch(i, startVal + Math.round((startY - ev.clientY) / 6)); }
            function up() { pc.removeEventListener('pointermove', move); pc.removeEventListener('pointerup', up); }
            pc.addEventListener('pointermove', move);
            pc.addEventListener('pointerup', up);
          });
          pc.addEventListener('wheel', function (e) {
            e.preventDefault();
            setPitch(i, audioEngine.getStepPitch(track.id, i) + (e.deltaY < 0 ? 1 : -1));
          }, { passive: false });
          pc.addEventListener('contextmenu', function (e) { e.preventDefault(); setPitch(i, 0); });
          pc.addEventListener('dblclick', function () { setPitch(i, 0); });
        })(i);
        laneCells.push(pc);
        laneCellsWrap.appendChild(pc);
      }
      lane.appendChild(laneCellsWrap);
      block.appendChild(lane);

      // Initialise both displays from the engine.
      for (let i = 0; i < audioEngine.STEP_COUNT; i++) setPitch(i, audioEngine.getStepPitch(track.id, i));

      container.appendChild(block);
    });
  }

  // Light up the column for the currently-playing step across all rows.
  function highlightStep(step) {
    document.querySelectorAll('.step.playhead').forEach(function (el) {
      el.classList.remove('playhead');
    });
    document.querySelectorAll('.step[data-step="' + step + '"]').forEach(function (el) {
      el.classList.add('playhead');
    });
  }

  function clearPlayhead() {
    document.querySelectorAll('.step.playhead').forEach(function (el) {
      el.classList.remove('playhead');
    });
  }

  // ---- transport controls ----------------------------------------------------

  function setupSequencerTransport() {
    document.getElementById('play-button').addEventListener('click', function () {
      audioEngine.play();
    });
    document.getElementById('stop-button').addEventListener('click', function () {
      audioEngine.stop();
      clearPlayhead();
    });

    // Clear all steps across every track.
    document.getElementById('clear-button').addEventListener('click', function () {
      audioEngine.clearAllSteps();
      document.querySelectorAll('.step.on').forEach(function (cell) {
        cell.classList.remove('on');
      });
    });

    const bpm = document.getElementById('bpm-slider');
    const bpmValue = document.getElementById('bpm-value');
    bpm.addEventListener('input', function () {
      const used = audioEngine.setMasterBpm(parseInt(bpm.value, 10));
      bpmValue.textContent = used;
    });

    // EXPORT (the Roland "record" button): capture one bar to a file.
    const exportBtn = document.getElementById('export-button');
    exportBtn.addEventListener('click', async function () {
      if (exportBtn.classList.contains('recording')) return; // already capturing
      exportBtn.classList.add('recording');
      console.log('[ui] exporting beat…');
      const dest = await audioEngine.exportLoop();
      exportBtn.classList.remove('recording');
      if (dest) {
        showToast('Exported to ' + dest.split(/[\\/]/).pop());
      } else {
        showToast('Export failed — see console');
      }
    });

    // Reveal modal close button.
    document.getElementById('reveal-close').addEventListener('click', hideReveal);
  }

  // Brief, self-dismissing status message (used by Export).
  function showToast(message) {
    let toast = document.getElementById('snapit-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'snapit-toast';
      toast.style.cssText =
        'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);' +
        'background:rgba(20,24,35,.92);color:#e8ecf5;border:1px solid #39425a;border-radius:10px;' +
        'backdrop-filter:blur(10px);box-shadow:0 10px 40px rgba(0,0,0,.5);' +
        'padding:11px 20px;font:600 13px Inter,system-ui,sans-serif;letter-spacing:.03em;' +
        'z-index:80;';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.style.opacity = '0'; toast.style.transition = 'opacity .4s'; }, 3200);
  }

  return { init: init };
})();

window.ui = ui;

// Kick everything off. These scripts live at the end of <body>, so the tab
// markup above already exists by the time this runs.
ui.init();
