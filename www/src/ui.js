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
  // DOM handles for each sequencer row, keyed by track id, so remote edits from
  // a jam session can update a single cell without rebuilding the grid:
  //   { stepCells: [...], setPitchDisplay(i, v), muteBtn }
  const trackDom = {};

  // ---- startup ---------------------------------------------------------------

  async function init() {
    console.log('[ui] starting up');

    // Load data first, then the audio engine (it reads the sample map).
    await library.load();
    // Fill in waveforms as each sample's buffer finishes downloading.
    audioEngine.onSampleLoaded(redrawWaveforms);
    await audioEngine.init();

    // Jam session layer: all sequencer edits flow through Jam so they hit the
    // shared project when connected (and just the local engine when solo).
    Jam.init();
    setupJamEvents();
    setupJamPanel();

    setupTabs();
    setupLibraryControls();
    setupSequencerTransport();
    setupTopBar();

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
    const ORDER = ['scan', 'library', 'sequencer'];
    let current = 'scan';
    const buttons = document.querySelectorAll('.tab-button');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = btn.getAttribute('data-tab');

        // Switching tabs only toggles visibility — nothing is re-rendered, so
        // each tab keeps its state (sequencer steps, scroll, etc.). The panel
        // slides in from the side it lives on, like the reference's carousel.
        const dir = ORDER.indexOf(target) >= ORDER.indexOf(current) ? 'slide-r' : 'slide-l';
        document.querySelectorAll('.tab-button').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        document.querySelectorAll('.tab-panel').forEach(function (panel) {
          const isTarget = panel.id === 'tab-' + target;
          panel.classList.remove('slide-l', 'slide-r');
          panel.classList.toggle('active', isTarget);
          if (isTarget && target !== current) {
            void panel.offsetWidth; // restart the slide animation
            panel.classList.add(dir);
          }
        });
        current = target;
        console.log('[ui] switched to tab:', target);
      });
    });
  }

  function switchToTab(name) {
    const btn = document.querySelector('.tab-button[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  // ---- jam session: engine events -> DOM --------------------------------------
  // Whether an edit was made here or on another laptop, it lands in the engine
  // via Jam and surfaces through these events. Granular events touch single
  // cells (so drags keep working); 'pattern' rebuilds the whole grid.

  function setupJamEvents() {
    Jam.on('pattern', function () { renderSequencer(); });

    Jam.on('step', function (trackId, i, on) {
      const dom = trackDom[trackId];
      if (dom && dom.stepCells[i]) dom.stepCells[i].classList.toggle('on', on);
    });

    Jam.on('pitch', function (trackId, i, val) {
      const dom = trackDom[trackId];
      if (dom) dom.setPitchDisplay(i, val);
    });

    Jam.on('mute', function (trackId, muted) {
      const dom = trackDom[trackId];
      if (dom && dom.muteBtn) dom.muteBtn.classList.toggle('active', muted);
      if (mixerDom[trackId]) mixerDom[trackId].setMuted(muted);
    });

    Jam.on('volume', function (trackId, v) {
      if (mixerDom[trackId]) mixerDom[trackId].setVol(v);
    });

    Jam.on('bpm', refreshTempoDisplays);
    Jam.on('swing', refreshTempoDisplays);
    Jam.on('key', refreshTempoDisplays);

    Jam.on('transport', function (playing) {
      document.getElementById('play-button').classList.toggle('playing', playing);
      document.getElementById('tempo-panel').classList.toggle('running', playing);
      if (!playing) clearPlayhead();
    });
  }

  // ---- jam session: panel (Host / Join / Leave) --------------------------------

  function setupJamPanel() {
    const panel   = document.getElementById('jam-panel');
    const toggle  = document.getElementById('jam-button');
    const dot     = document.getElementById('jam-dot');
    const status  = document.getElementById('jam-status');
    const peersEl = document.getElementById('jam-peers');
    const ipsEl   = document.getElementById('jam-ips');
    const hostBtn = document.getElementById('jam-host');
    const joinBtn = document.getElementById('jam-join');
    const addrIn  = document.getElementById('jam-address');
    const leave   = document.getElementById('jam-leave');
    const outSec  = document.getElementById('jam-output-sec');
    const outsEl  = document.getElementById('jam-outputs');
    const silent  = document.getElementById('jam-silent-note');

    // The "who plays the sound" picker. One button per machine; the active one
    // is the session's speaker, every other machine runs silent.
    function renderOutputs(peers, outputId) {
      const inSession = Jam.role() !== 'offline';
      outSec.style.display = (inSession && peers.length > 0) ? '' : 'none';
      outsEl.innerHTML = '';

      peers.forEach(function (p) {
        const isOut = p.id === outputId;
        const isMe  = p.id === Jam.myId();
        const b = document.createElement('button');
        b.className = 'jam-output-btn' + (isOut ? ' active' : '');
        b.innerHTML = '<span class="spk"></span><span class="nm"></span><span class="who"></span>';
        b.querySelector('.spk').textContent = isOut ? '🔊' : '🔇';
        b.querySelector('.nm').textContent = p.name;
        b.querySelector('.who').textContent =
          (p.id === 'host' ? 'HOST' : '') + (isMe ? (p.id === 'host' ? ' · YOU' : 'YOU') : '');
        b.title = isOut ? (p.name + ' is the audio output') : ('Make ' + p.name + ' the audio output');
        b.addEventListener('click', function () { Jam.setOutput(p.id); });
        outsEl.appendChild(b);
      });

      const amSilent = inSession && !Jam.isOutput();
      dot.classList.toggle('silent', amSilent);
      silent.textContent = amSilent
        ? 'This machine is silent — sound plays on the 🔊 machine.'
        : '';
    }

    Jam.on('roster', renderOutputs);

    toggle.addEventListener('click', function () {
      const wasOpen = panel.classList.contains('open');
      // Close the other top-bar popovers so only one is up at a time.
      document.querySelectorAll('.tempo-panel.open, .guide-panel.open').forEach(function (p) {
        p.classList.remove('open');
      });
      panel.classList.toggle('open', !wasOpen);
    });

    hostBtn.addEventListener('click', function () { Jam.hostSession(); });
    joinBtn.addEventListener('click', function () { Jam.joinSession(addrIn.value); });
    addrIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') Jam.joinSession(addrIn.value);
    });
    leave.addEventListener('click', function () { Jam.leaveSession(); });

    Jam.on('status', function (text) { status.textContent = text; });

    Jam.on('peers', function (n) {
      peersEl.textContent = (Jam.role() === 'host') ? (n + ' connected') : '';
    });

    Jam.on('session', function (role) {
      const inSession = role !== 'offline';
      dot.classList.toggle('on', inSession);
      leave.style.display = inSession ? '' : 'none';
      hostBtn.disabled = inSession;
      joinBtn.disabled = inSession;
      addrIn.disabled  = inSession;

      if (role === 'host') {
        const ips = Jam.getLanIps();
        ipsEl.textContent = ips.length
          ? 'Friends enter: ' + ips.join('  or  ')
          : 'No LAN address found — check WiFi.';
        peersEl.textContent = '0 connected';
      } else {
        ipsEl.textContent = '';
        peersEl.textContent = '';
      }
    });
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

  // Colours the confetti pulls from (the flat PO palette).
  const CONFETTI_COLORS = ['#2A2F6E', '#B02058', '#D9551C', '#4C86AB', '#7FB2D4',
                           '#12794A', '#C6A12D', '#BE3B2B'];

  function showReveal(result) {
    const modal = document.getElementById('reveal-modal');
    const d = describeSample(result.objectType, result.sampleInfo.displayName);
    const rar = RARITIES[d.rarity];

    document.getElementById('reveal-title').textContent =
      result.isNewUnlock ? 'New sound' : 'Already collected';
    document.getElementById('reveal-ico').innerHTML =
      '<span style="color:' + d.type.color + '">' + d.type.icon + '</span>';
    document.getElementById('reveal-name').textContent = result.sampleInfo.displayName;
    document.getElementById('reveal-kind').textContent =
      d.type.label + ' · ' + (rar.stars ? rar.stars + ' ' : '') + rar.label;

    // Bauhaus confetti: only a fresh unlock earns the burst.
    const confetti = document.getElementById('reveal-confetti');
    confetti.innerHTML = '';
    if (result.isNewUnlock) {
      const SHAPES = ['round', 'tri', ''];
      for (let i = 0; i < 16; i++) {
        const s = document.createElement('span');
        s.className = 'cf ' + SHAPES[i % 3];
        const ang = (i / 16) * Math.PI * 2 + Math.random() * 0.5;
        const dist = 90 + Math.random() * 90;
        s.style.setProperty('--c', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
        s.style.setProperty('--dx', Math.round(Math.cos(ang) * dist) + 'px');
        s.style.setProperty('--dy', Math.round(Math.sin(ang) * dist * 0.8 - 40) + 'px');
        s.style.setProperty('--r', Math.round(120 + Math.random() * 260) + 'deg');
        s.style.setProperty('--d', (Math.random() * 0.22).toFixed(2) + 's');
        confetti.appendChild(s);
      }
      // Hear the new sound the moment the card lands.
      audioEngine.previewSample(result.objectType);
    }

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

  // Flat Pocket-Operator-style pictograms (fill: currentColor; the parent
  // element sets the type colour). Drawn to echo the reference cell icons.
  function icon(paths, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
           '" fill="currentColor" aria-hidden="true">' + paths + '</svg>';
  }
  const ICON_PATHS = {
    kick:    '<circle cx="12" cy="12" r="9"/>',
    snare:   '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2"/>' +
             '<circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="2"/>' +
             '<circle cx="12" cy="12" r="1.4"/>',
    hat:     '<path d="M3 11.2 Q12 2.6 21 11.2 Z"/><path d="M3 19.6 Q12 11 21 19.6 Z"/>',
    clap:    '<rect x="10.9" y="2.5" width="2.2" height="19" rx="1.1"/>' +
             '<rect x="10.9" y="2.5" width="2.2" height="19" rx="1.1" transform="rotate(60 12 12)"/>' +
             '<rect x="10.9" y="2.5" width="2.2" height="19" rx="1.1" transform="rotate(120 12 12)"/>',
    bass:    '<path d="M12 2.5 C14.6 2.5 15.6 6.2 15.8 9.5 L17.2 21.5 L6.8 21.5 L8.2 9.5 C8.4 6.2 9.4 2.5 12 2.5 Z"/>',
    tom:     '<rect x="4.5" y="6" width="15" height="12" rx="2.5"/>',
    cowbell: '<path d="M8.2 3 h7.6 l2.7 13 H5.5 Z"/><rect x="4.5" y="17.5" width="15" height="3" rx="1.5"/>',
    perc:    '<circle cx="4" cy="12" r="2.6"/><circle cx="9.33" cy="12" r="2.6"/>' +
             '<circle cx="14.66" cy="12" r="2.6"/><circle cx="20" cy="12" r="2.6"/>',
    horn:    '<circle cx="8" cy="17.5" r="4"/><rect x="10.6" y="4" width="2.3" height="13.5"/>' +
             '<path d="M10.6 4 q6.4 .8 7.4 6 l-2.2 .9 q-.9 -4.2 -5.2 -4.6 Z"/>',
    fx:      '<rect x="4" y="9" width="16" height="11" rx="1.5"/><rect x="11" y="3.5" width="2" height="6"/>' +
             '<rect x="7.5" y="2.5" width="9" height="2" rx="1"/>',
  };

  // ---- segment-display numerals ----------------------------------------------
  // Every number in the reference is set in a calculator-style segment face
  // ("125" reads as "|25"). We build the same glyphs as tiny inline SVGs that
  // take currentColor, so they stay crisp at any size and recolour for free.
  const SEG = (function () {
    // seven segments on an 11x20 box: [x, y, w, h]
    const R = {
      A: [1.3, 0, 8.4, 2.4],
      B: [8.7, 0.7, 2.3, 8.5],
      C: [8.7, 10.8, 2.3, 8.5],
      D: [1.3, 17.6, 8.4, 2.4],
      E: [0, 10.8, 2.3, 8.5],
      F: [0, 0.7, 2.3, 8.5],
      G: [1.3, 8.8, 8.4, 2.4],
    };
    const GLYPHS = {
      '0': 'ABCDEF', '2': 'ABGED', '3': 'ABGCD', '4': 'FGBC', '5': 'AFGCD',
      '6': 'AFGEDC', '7': 'ABC', '8': 'ABCDEFG', '9': 'ABCDFG',
      'A': 'ABCEFG', 'b': 'FGECD', 'C': 'AFED', 'd': 'BCDEG', 'E': 'AFGED',
      'F': 'AFGE', 'G': 'AFEDC',
    };
    // drawn directly (the reference's "1" is a lone centred bar, not 7-seg)
    const SPECIAL = {
      '1': [[4.35, 0, 2.3, 20]],
      '-': [[1.3, 8.8, 8.4, 2.4]],
      '+': [[1.9, 8.8, 7.2, 2.4], [4.35, 6.3, 2.3, 7.4]],
      '#': [[2.5, 2.8, 1.9, 14.4], [6.6, 2.8, 1.9, 14.4],
            [0.7, 6.2, 9.6, 1.9], [0.7, 11.9, 9.6, 1.9]],
      ' ': [],
    };
    const CW = 11, GAP = 3.4, CH = 20;

    // SEG('125', 15) -> segment-digit SVG, 15px tall, in currentColor
    return function (str, height) {
      str = String(str);
      const n = str.length;
      const total = n * CW + (n - 1) * GAP;
      let rects = '';
      for (let i = 0; i < n; i++) {
        const ch = str[i], ox = i * (CW + GAP);
        const list = SPECIAL[ch] ||
          (GLYPHS[ch] || '').split('').map(function (s) { return R[s]; });
        list.forEach(function (r) {
          rects += '<rect x="' + (ox + r[0]) + '" y="' + r[1] + '" width="' + r[2] +
                   '" height="' + r[3] + '" rx="0.8"/>';
        });
      }
      const w = +(height * total / CH).toFixed(1);
      return '<svg class="seg" viewBox="0 0 ' + total + ' ' + CH + '" width="' + w +
             '" height="' + height + '" fill="currentColor" aria-hidden="true">' + rects + '</svg>';
    };
  })();

  // Note names spelled with segment-friendly letters (B -> "b", D -> "d").
  const NOTES_SEG = ['C', 'C#', 'd', 'd#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'b'];

  // Each instrument gets its own step polygon in the sequencer (kick = circle,
  // hat = triangle, clap = diamond…) so a row reads as its sound at a glance.
  const STEP_SHAPES = {
    kick:    'circle(50% at 50% 50%)',
    snare:   'inset(6% round 22%)',
    hat:     'polygon(50% 3%, 98% 97%, 2% 97%)',
    clap:    'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
    bass:    'ellipse(48% 94% at 50% 100%)',
    tom:     'inset(20% 3% 20% 3% round 40px)',
    cowbell: 'polygon(24% 3%, 76% 3%, 98% 97%, 2% 97%)',
    perc:    'polygon(25% 3%, 75% 3%, 98% 50%, 75% 97%, 25% 97%, 2% 50%)',
    horn:    'polygon(50% 2%, 98% 40%, 80% 98%, 20% 98%, 2% 40%)',
    fx:      'polygon(30% 2%, 70% 2%, 98% 30%, 98% 70%, 70% 98%, 30% 98%, 2% 70%, 2% 30%)',
  };

  // Flat PO palette (visuals/APP ui): navy / magenta / sky / orange / blue /
  // mustard / green / red / brown / grey on warm paper.
  const SAMPLE_TYPES = {
    kick:    { label: 'Kick',    icon: icon(ICON_PATHS.kick),    color: '#2A2F6E', tint: 'rgba(42,47,110,.14)' },
    snare:   { label: 'Snare',   icon: icon(ICON_PATHS.snare),   color: '#B02058', tint: 'rgba(176,32,88,.13)' },
    hat:     { label: 'Hi-Hat',  icon: icon(ICON_PATHS.hat),     color: '#7FB2D4', tint: 'rgba(127,178,212,.2)' },
    clap:    { label: 'Clap',    icon: icon(ICON_PATHS.clap),    color: '#D9551C', tint: 'rgba(217,85,28,.14)' },
    bass:    { label: 'Bass',    icon: icon(ICON_PATHS.bass),    color: '#4C86AB', tint: 'rgba(76,134,171,.16)' },
    tom:     { label: 'Tom',     icon: icon(ICON_PATHS.tom),     color: '#C6A12D', tint: 'rgba(198,161,45,.18)' },
    cowbell: { label: 'Cowbell', icon: icon(ICON_PATHS.cowbell), color: '#12794A', tint: 'rgba(18,121,74,.14)' },
    perc:    { label: 'Perc',    icon: icon(ICON_PATHS.perc),    color: '#BE3B2B', tint: 'rgba(190,59,43,.13)' },
    horn:    { label: 'Horn',    icon: icon(ICON_PATHS.horn),    color: '#6E5A4B', tint: 'rgba(110,90,75,.14)' },
    fx:      { label: 'FX',      icon: icon(ICON_PATHS.fx),      color: '#6F6F6C', tint: 'rgba(111,111,108,.16)' },
  };

  const RARITIES = {
    common:    { label: 'Common',    stars: '',    color: '#8E8E8A', order: 0 },
    rare:      { label: 'Rare',      stars: '★',   color: '#4C86AB', order: 1 },
    epic:      { label: 'Epic',      stars: '★★',  color: '#B02058', order: 2 },
    legendary: { label: 'Legendary', stars: '★★★', color: '#C6A12D', order: 3 },
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

    return { cat: cat, type: SAMPLE_TYPES[cat], rarity: rarity, note: note, choke: choke };
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
      ctx.strokeStyle = 'rgba(23,23,27,.18)';
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
    ctx.strokeStyle = 'rgba(23,23,27,.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  }

  // Redraw every on-screen waveform canvas for a sample (library + pads).
  function redrawWaveforms(objectType) {
    document.querySelectorAll('canvas[data-otype="' + objectType + '"]').forEach(function (c) {
      drawWaveform(c, objectType, c.getAttribute('data-color') || '#2A2F6E');
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

  // Collection view state (Pokedex-style): current type filter + sort mode.
  let libFilter = 'all';
  let libSort = 'type';
  let libSelectedObject = null;

  function setupLibraryControls() {
    document.getElementById('lib-sort').addEventListener('change', function (e) {
      libSort = e.target.value;
      renderLibrary();
    });
  }

  // The type filter chips above the grid. Counts include locked samples, so a
  // chip reading 1/3 says "two more of these are still out there" — the same
  // pull as empty Pokedex slots.
  function renderLibraryChips(items) {
    const wrap = document.getElementById('lib-chips');
    wrap.innerHTML = '';

    const counts = {};   // cat -> { total, unlocked }
    items.forEach(function (it) {
      const c = counts[it.d.cat] || (counts[it.d.cat] = { total: 0, unlocked: 0 });
      c.total++;
      if (it.unlocked) c.unlocked++;
    });

    function chip(catKey, label, iconHtml, color, unlockedN, totalN) {
      const b = document.createElement('button');
      b.className = 'lib-chip' + (libFilter === catKey ? ' active' : '');
      b.innerHTML = (iconHtml ? '<span class="ico" style="color:' + (color || 'currentColor') + '">' + iconHtml + '</span>' : '') +
        '<span>' + label + '</span><span class="cnt">' + unlockedN + '/' + totalN + '</span>';
      b.addEventListener('click', function () {
        libFilter = catKey;
        renderLibrary();
      });
      wrap.appendChild(b);
    }

    const totalUnlocked = items.filter(function (it) { return it.unlocked; }).length;
    chip('all', 'All', '', null, totalUnlocked, items.length);
    Object.keys(SAMPLE_TYPES).forEach(function (cat) {
      if (!counts[cat]) return; // no samples of this type shipped
      const t = SAMPLE_TYPES[cat];
      chip(cat, t.label, t.icon, t.color, counts[cat].unlocked, counts[cat].total);
    });
  }

  function renderLibrary() {
    const grid = document.getElementById('library-grid');
    const editor = document.getElementById('lib-editor');
    grid.innerHTML = '';
    const map = library.getAllSampleInfo();
    const unlockedOrder = library.getUnlocked(); // in unlock order, oldest first

    // Describe everything once: type, rarity, unlock state, recency.
    const items = Object.keys(map).map(function (objectType) {
      return {
        key: objectType,
        info: map[objectType],
        d: describeSample(objectType, map[objectType].displayName),
        unlocked: library.isUnlocked(objectType),
        recent: unlockedOrder.indexOf(objectType),
      };
    });

    // Header: discovery progress + type filter chips.
    const found = unlockedOrder.length;
    document.getElementById('lib-progress-text').textContent =
      found + ' / ' + items.length + ' discovered';
    document.getElementById('lib-progress-fill').style.width =
      (items.length ? Math.round((found / items.length) * 100) : 0) + '%';
    renderLibraryChips(items);

    // Filter, then sort. Unlocked cards always come before locked ones.
    let shown = (libFilter === 'all')
      ? items
      : items.filter(function (it) { return it.d.cat === libFilter; });

    const typeOrder = Object.keys(SAMPLE_TYPES);
    shown = shown.slice().sort(function (a, b) {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      if (libSort === 'rarity') {
        return (RARITIES[b.d.rarity].order - RARITIES[a.d.rarity].order) ||
               a.info.displayName.localeCompare(b.info.displayName);
      }
      if (libSort === 'recent') return b.recent - a.recent;
      if (libSort === 'name') return a.info.displayName.localeCompare(b.info.displayName);
      return (typeOrder.indexOf(a.d.cat) - typeOrder.indexOf(b.d.cat)) ||
             a.info.displayName.localeCompare(b.info.displayName);
    });

    // The single most recent find gets a NEW badge.
    const newestKey = unlockedOrder.length ? unlockedOrder[unlockedOrder.length - 1] : null;

    // Auto-select first unlocked item if none selected or if selected is not in shown
    if (shown.length > 0) {
      const isSelectedInShown = shown.some(it => it.key === libSelectedObject);
      if (!libSelectedObject || !isSelectedInShown) {
        const firstUnlocked = shown.find(it => it.unlocked);
        libSelectedObject = firstUnlocked ? firstUnlocked.key : null;
      }
    } else {
      libSelectedObject = null;
    }

    // Grid population
    // We want at least 16 slots to fill a 4x4 or 8x2 visual pad grid like the references.
    const minSlots = 16;
    const totalSlots = Math.max(minSlots, Math.ceil(shown.length / 8) * 8);

    for (let i = 0; i < totalSlots; i++) {
      const item = i < shown.length ? shown[i] : null;
      const cell = document.createElement('button');
      cell.style.setProperty('--i', i); // cascade-in stagger
      const num = '<div class="pad-num">' + (i + 1) + '</div>';

      if (!item) {
        cell.className = 'pad filler';
        cell.innerHTML = num;
      } else if (!item.unlocked) {
        cell.className = 'pad locked';
        cell.innerHTML = '<div class="pad-hatch" title="Undiscovered ' + item.d.type.label + '"></div>' + num;
      } else {
        cell.className = 'pad' + (item.key === libSelectedObject ? ' selected' : '');
        cell.style.setProperty('--type-color', item.d.type.color);
        const isNew = item.key === newestKey;

        cell.innerHTML =
          '<div class="pad-ico" style="color: ' + item.d.type.color + '">' + item.d.type.icon + '</div>' +
          num +
          (isNew ? '<div class="pad-new-dot"></div>' : '');

        cell.title = item.info.displayName;
        cell.addEventListener('click', function () {
          // Select in place (no grid re-render) so the press animation shows.
          if (libSelectedObject !== item.key) {
            libSelectedObject = item.key;
            grid.querySelectorAll('.pad.selected').forEach(function (p) {
              p.classList.remove('selected');
            });
            cell.classList.add('selected');
            renderEditor(item);
          }
          cell.classList.remove('pop');
          void cell.offsetWidth; // restart the squash animation
          cell.classList.add('pop');
          audioEngine.previewSample(item.key);
        });
      }
      grid.appendChild(cell);
    }

    // Editor Population
    if (!libSelectedObject) {
      editor.className = 'lib-editor empty';
      editor.innerHTML = 'Scan an object to unlock your first sound';
      return;
    }

    const selectedItem = shown.find(it => it.key === libSelectedObject);
    if (selectedItem) renderEditor(selectedItem);
  }

  // Fill the editor plate (waveform + ADSR faders + tune) for one library item.
  // Split out of renderLibrary so selecting a pad never rebuilds the grid.
  function renderEditor(selectedItem) {
    const editor = document.getElementById('lib-editor');
    editor.className = 'lib-editor';

    const info = selectedItem.info;
    const d = selectedItem.d;
    const objectType = selectedItem.key;
    const rar = RARITIES[d.rarity];
    const rarLabel = (rar.stars ? rar.stars + ' ' : '') + rar.label;

    const playSvg =
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">' +
        '<path d="M5 3.4v9.2l8-4.6z"/>' +
      '</svg>';

    editor.innerHTML =
      '<div class="ed-main">' +
        '<div class="ed-head">' +
          '<span class="ed-ico" style="color: ' + d.type.color + '">' + d.type.icon + '</span>' +
          '<span class="ed-name" title="' + info.displayName + '">' + info.displayName + '</span>' +
          '<span class="ed-meta" style="color: ' + rar.color + '">' + rarLabel + '</span>' +
          '<div class="ed-spacer"></div>' +
          '<button class="ed-play" title="Preview">' + playSvg + '</button>' +
          '<button class="ed-add" title="Add to sequencer">+ Seq</button>' +
        '</div>' +
        '<canvas class="ed-wave" width="800" height="150" data-otype="' + objectType + '" data-color="' + d.type.color + '"></canvas>' +
      '</div>' +
      '<div class="ed-side">' +
        '<div class="ed-faders">' +
          '<div class="vfader" title="Attack"><div class="vtrack"></div><div class="vhandle"></div></div>' +
          '<div class="vfader" title="Decay"><div class="vtrack"></div><div class="vhandle"></div></div>' +
          '<div class="vfader" title="Sustain"><div class="vtrack"></div><div class="vhandle"></div></div>' +
          '<div class="vfader" title="Release"><div class="vtrack"></div><div class="vhandle"></div></div>' +
        '</div>' +
        '<div class="ed-fletters">' +
          '<span>A</span><span>D</span><span>S</span><span>R</span>' +
        '</div>' +
        '<div class="ed-tune">' +
          '<span class="mc-sym" title="Tune down / up">&#9837;</span>' +
          '<div class="hslider tune" title="Tune"><div class="hknob"></div></div>' +
          '<span class="mc-sym">&#9839;</span>' +
          '<div class="ed-tune-val">0 st</div>' +
        '</div>' +
      '</div>';

    // Wiring Editor Events
    editor.querySelector('.ed-play').addEventListener('click', function () {
      audioEngine.previewSample(objectType);
    });
    editor.querySelector('.ed-add').addEventListener('click', function () {
      addTrack(objectType, info.displayName);
    });

    const canvas = editor.querySelector('.ed-wave');
    drawWaveform(canvas, objectType, d.type.color);
    canvas.addEventListener('click', function () { audioEngine.previewSample(objectType); });

    // ADSR faders + tune
    const s = audioEngine.getSampleSettings(objectType) ||
              { attack: 0.005, decay: 0.2, sustain: 1, release: 0.3, cents: 0 };
    const faderEls = editor.querySelectorAll('.vfader');
    ADSR_SPECS.forEach(function (spec, i) {
      const norm = (s[spec.field] - spec.min) / (spec.max - spec.min);
      attachVFader(faderEls[i], norm, function (n) {
        audioEngine.setSampleEnv(objectType, spec.field, spec.min + n * (spec.max - spec.min));
      });
    });

    const tuneSlider = editor.querySelector('.hslider.tune');
    const tuneReadout = editor.querySelector('.ed-tune-val');
    attachHSlider(tuneSlider, (s.cents / 100 + 48) / 96, function (n) {
      const st = Math.round(n * 96 - 48);
      audioEngine.setSampleCents(objectType, st * 100);
      tuneReadout.textContent = (st > 0 ? '+' : '') + st + ' st';
      tuneSlider.title = 'Tune ' + (st > 0 ? '+' : '') + st + ' st';
    });
  }

  // ---- mixer (the crayon bars) -------------------------------------------------
  // One pointed bar per track, in the track's colour, exactly like the
  // reference's MIXER screen. Drag a bar to ride its level; tap the number in
  // the strip to mute (the bar goes pale). Bars pulse when their track fires.
  // DOM handles per track so jam edits can move a single bar:
  //   { setVol(v), setMuted(m), hit() }
  const mixerDom = {};

  function volToHeight(v) { return 18 + v * 78; } // volume 0..1 -> % of plate

  function renderMixer() {
    const area = document.getElementById('mixer-area');
    area.innerHTML = '';
    Object.keys(mixerDom).forEach(function (k) { delete mixerDom[k]; });

    const muteLabel = document.createElement('div');
    muteLabel.className = 'mix-mute-label';
    muteLabel.textContent = 'Mute';
    area.appendChild(muteLabel);

    const tracks = audioEngine.getTracks();

    // No tracks yet: four pale ghost crayons keep the plate composed like the
    // reference until the first sound lands.
    if (tracks.length === 0) {
      [46, 62, 78, 38].forEach(function (h, i) {
        const slot = document.createElement('div');
        slot.className = 'mix-slot ghost';
        slot.innerHTML = '<div class="mix-crayon" style="--v:' + h + '"></div>' +
          '<div class="mix-strip">' + (i + 1) + '</div>';
        area.appendChild(slot);
      });
      const hint = document.createElement('div');
      hint.className = 'mix-empty-hint';
      hint.textContent = 'Add sounds to mix';
      area.appendChild(hint);
      return;
    }

    tracks.forEach(function (track, idx) {
      const d = describeSample(track.objectType, track.displayName);

      const slot = document.createElement('div');
      slot.className = 'mix-slot' + (track.muted ? ' muted' : '');
      slot.title = track.displayName + ' — drag for volume, tap the number to mute';

      const crayon = document.createElement('div');
      crayon.className = 'mix-crayon';
      crayon.style.setProperty('--bar-color', d.type.color);
      crayon.style.setProperty('--v', volToHeight(track.volume == null ? 0.8 : track.volume));
      slot.appendChild(crayon);

      const strip = document.createElement('div');
      strip.className = 'mix-strip';
      strip.textContent = idx + 1;
      slot.appendChild(strip);

      // Drag anywhere on the column to ride the level. Pointer capture
      // retargets the tail of the gesture, so mute-taps are resolved here too:
      // a press that started on the strip and never moved is a mute toggle.
      slot.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        slot.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startV = audioEngine.getTrackVolume(track.id);
        const onStrip = strip.contains(e.target);
        let moved = false;
        function move(ev) {
          if (Math.abs(ev.clientY - startY) > 3) moved = true;
          if (!moved) return;
          const v = Math.max(0, Math.min(1, startV + (startY - ev.clientY) / 150));
          Jam.setVolume(track.id, Math.round(v * 100) / 100);
        }
        function up() {
          slot.removeEventListener('pointermove', move);
          slot.removeEventListener('pointerup', up);
          if (!moved && onStrip) Jam.setMute(track.id, !slot.classList.contains('muted'));
        }
        slot.addEventListener('pointermove', move);
        slot.addEventListener('pointerup', up);
      });

      mixerDom[track.id] = {
        setVol: function (v) { crayon.style.setProperty('--v', volToHeight(v)); },
        setMuted: function (m) { slot.classList.toggle('muted', m); },
        hit: function () {
          crayon.classList.remove('hit');
          void crayon.offsetWidth; // restart the pulse
          crayon.classList.add('hit');
        },
      };

      area.appendChild(slot);
    });
  }

  // ---- oscilloscopes -----------------------------------------------------------
  // Two live views of the master output: a red trace along the mixer plate's
  // zero line (only when there's signal — silence keeps the printed hairline
  // clean), and the little always-on meter card in the sidebar.

  function startScope() {
    const mixCanvas = document.getElementById('scope-canvas');
    const sideCanvas = document.getElementById('side-scope');
    const mixCtx = mixCanvas ? mixCanvas.getContext('2d') : null;
    const sideCtx = sideCanvas ? sideCanvas.getContext('2d') : null;

    function trace(ctx, w, h, values, style, width, amp) {
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      ctx.beginPath();
      const mid = h / 2, n = values ? values.length : 0;
      if (n) {
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * w;
          const y = mid + values[i] * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {
        ctx.moveTo(0, mid); ctx.lineTo(w, mid);
      }
      ctx.stroke();
    }

    function frame() {
      const analyser = audioEngine.getAnalyser();
      const values = analyser ? analyser.getValue() : null;
      let peak = 0;
      if (values) for (let i = 0; i < values.length; i++) {
        const v = Math.abs(values[i]);
        if (v > peak) peak = v;
      }

      if (mixCtx) {
        mixCtx.clearRect(0, 0, mixCanvas.width, mixCanvas.height);
        // draw only when the output is actually moving
        if (peak > 0.006) {
          trace(mixCtx, mixCanvas.width, mixCanvas.height, values,
                'rgba(163,31,52,.75)', 1.6, mixCanvas.height * 0.48);
        }
      }
      if (sideCtx) {
        sideCtx.clearRect(0, 0, sideCanvas.width, sideCanvas.height);
        trace(sideCtx, sideCanvas.width, sideCanvas.height, values,
              '#2A2F6E', 2.2, sideCanvas.height * 0.42);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---- sequencer tab ---------------------------------------------------------

  function addTrack(objectType, displayName) {
    // Goes through Jam: adds locally when solo, or into the shared project when
    // in a session. The 'pattern' event re-renders the grid either way.
    Jam.addTrack(objectType, displayName);
    switchToTab('sequencer'); // jump to the grid so the new row is visible
  }

  function renderSequencer() {
    renderMixer(); // the crayon bars mirror the track list 1:1

    const container = document.getElementById('sequencer-tracks');
    container.innerHTML = '';
    Object.keys(trackDom).forEach(function (k) { delete trackDom[k]; });

    // The engine's track list IS the project (local or synced) — render from it.
    const tracks = audioEngine.getTracks();

    if (tracks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No tracks yet. Go to the Library tab and add a sample.';
      container.appendChild(empty);
      return;
    }

    tracks.forEach(function (track) {
      const d = describeSample(track.objectType, track.displayName);

      const block = document.createElement('div');
      block.className = 'track-block';
      // Steps + pitch cells pick up the track's colour AND polygon from the block.
      block.style.setProperty('--type-color', d.type.color);
      block.style.setProperty('--shape', STEP_SHAPES[d.cat] || STEP_SHAPES.kick);

      const row = document.createElement('div');
      row.className = 'track-row';

      // Label: the type pictogram in its colour, then the name.
      const label = document.createElement('div');
      label.className = 'track-label';
      label.innerHTML = '<span class="tl-ico" style="color:' + d.type.color + '">' +
        d.type.icon + '</span><span class="tl-nm"></span>';
      label.querySelector('.tl-nm').textContent = track.displayName;
      label.title = track.displayName;
      row.appendChild(label);

      const stepCells = [];
      const laneCells = [];

      // Paint a step's pitch onto its step indicator and lane cell (DOM only —
      // the value itself lives in the engine and arrives via Jam's 'pitch' event).
      function setPitchDisplay(i, p) {
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
        // ring = the shape-following playhead outline; shape = the polygon itself
        cell.innerHTML = '<span class="ring"></span><span class="shape"></span>';
        const pitchLabel = document.createElement('span');
        pitchLabel.className = 'step-pitch';
        cell.appendChild(pitchLabel);
        (function (i) {
          // The cell lights up when Jam's 'step' event comes back — instantly
          // when solo/hosting, after the host's echo when joined.
          cell.addEventListener('click', function () {
            Jam.toggleStep(track.id, i);
          });
        })(i);
        stepCells.push(cell);
        steps.appendChild(cell);
      }
      row.appendChild(steps);

      // Mute toggle (state restored from the engine on re-render).
      const mute = document.createElement('button');
      mute.className = 'track-mute';
      mute.textContent = 'Mute';
      mute.classList.toggle('active', !!track.muted);
      mute.addEventListener('click', function () {
        Jam.setMute(track.id, !mute.classList.contains('active'));
      });
      row.appendChild(mute);

      // Remove track.
      const remove = document.createElement('button');
      remove.className = 'track-remove';
      remove.textContent = '✕';
      remove.title = 'Remove track';
      remove.addEventListener('click', function () {
        Jam.removeTrack(track.id);
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
            function move(ev) { Jam.setStepPitch(track.id, i, startVal + Math.round((startY - ev.clientY) / 6)); }
            function up() { pc.removeEventListener('pointermove', move); pc.removeEventListener('pointerup', up); }
            pc.addEventListener('pointermove', move);
            pc.addEventListener('pointerup', up);
          });
          pc.addEventListener('wheel', function (e) {
            e.preventDefault();
            Jam.setStepPitch(track.id, i, audioEngine.getStepPitch(track.id, i) + (e.deltaY < 0 ? 1 : -1));
          }, { passive: false });
          pc.addEventListener('contextmenu', function (e) { e.preventDefault(); Jam.setStepPitch(track.id, i, 0); });
          pc.addEventListener('dblclick', function () { Jam.setStepPitch(track.id, i, 0); });
        })(i);
        laneCells.push(pc);
        laneCellsWrap.appendChild(pc);
      }
      lane.appendChild(laneCellsWrap);
      block.appendChild(lane);

      // Initialise both displays from the engine's current values.
      for (let i = 0; i < audioEngine.STEP_COUNT; i++) setPitchDisplay(i, audioEngine.getStepPitch(track.id, i));

      // Register this row's DOM so Jam events can update single cells later.
      trackDom[track.id] = { stepCells: stepCells, setPitchDisplay: setPitchDisplay, muteBtn: mute };

      container.appendChild(block);
    });
  }

  // Light up the column for the currently-playing step across all rows.
  function highlightStep(step) {
    // Tone.Draw can deliver a queued step after Stop — ignore it so the
    // playhead doesn't reappear on a stopped grid.
    if (!audioEngine.isPlaying()) return;

    document.querySelectorAll('.step.playhead').forEach(function (el) {
      el.classList.remove('playhead');
    });
    document.querySelectorAll('.step[data-step="' + step + '"]').forEach(function (el) {
      el.classList.add('playhead');
    });

    // Pulse the mixer bar of every track that fires on this step.
    audioEngine.getTracks().forEach(function (t) {
      if (t.steps[step] && !t.muted && mixerDom[t.id]) mixerDom[t.id].hit();
    });
  }

  function clearPlayhead() {
    document.querySelectorAll('.step.playhead').forEach(function (el) {
      el.classList.remove('playhead');
    });
  }

  // ---- transport controls ----------------------------------------------------

  function setupSequencerTransport() {
    // Play/stop/clear go through Jam: solo they act locally, in a session the
    // whole room starts/stops together (the host is the authority).
    document.getElementById('play-button').addEventListener('click', function () {
      audioEngine.unlock(); // click = user gesture; make sure audio can start
      Jam.play();
    });
    document.getElementById('stop-button').addEventListener('click', function () {
      Jam.stop();
      clearPlayhead();
    });

    // Clear all steps across every track (re-renders via the 'pattern' event).
    document.getElementById('clear-button').addEventListener('click', function () {
      Jam.clearAll();
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

    // Reveal modal: close button, or click the backdrop.
    document.getElementById('reveal-close').addEventListener('click', hideReveal);
    document.getElementById('reveal-modal').addEventListener('click', function (e) {
      if (e.target === this) hideReveal();
    });
  }

  // ---- top bar: tempo panel, guide, segment digits ----------------------------

  // Repaint every tempo readout (top-bar chip + panel chips) from the engine,
  // and retime the metronome. Called on every bpm/swing/key event.
  function refreshTempoDisplays() {
    const bpm = audioEngine.getBpm();
    const swing = Math.round(audioEngine.getSwing() * 100);
    const key = audioEngine.getKeyTranspose();

    document.getElementById('bpm-value').textContent = bpm;
    document.getElementById('bpm-value-big').textContent = bpm;
    document.getElementById('swing-value').textContent =
      (swing > 0 ? '+' : '') + swing + '%';
    document.getElementById('key-value').textContent =
      NOTES_SEG[((key % 12) + 12) % 12];

    // One needle pass per beat, and the mustard needle tilts with the tempo.
    const panel = document.getElementById('tempo-panel');
    panel.style.setProperty('--tick', (60 / bpm).toFixed(3) + 's');
    document.getElementById('knurl-needle').style.setProperty(
      '--tilt', (((120 - bpm) / 60) * 22).toFixed(1) + 'deg');
  }

  // Vertical drag-to-adjust for the tempo chips (with wheel support). A press
  // that never moves counts as a tap and fires onTap instead.
  function attachDragValue(el, pxPerStep, get, apply, onTap) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startV = get();
      let moved = false;
      function move(ev) {
        const d = Math.round((startY - ev.clientY) / pxPerStep);
        if (d !== 0) moved = true;
        if (moved) apply(startV + d);
      }
      function up() {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (!moved && onTap) onTap();
      }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      apply(get() + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }

  function setupTopBar() {
    const tempoPanel = document.getElementById('tempo-panel');
    const guidePanel = document.getElementById('guide-panel');
    const jamPanel = document.getElementById('jam-panel');

    // Only one popover at a time.
    function toggle(panel) {
      const wasOpen = panel.classList.contains('open');
      [tempoPanel, guidePanel, jamPanel].forEach(function (p) { p.classList.remove('open'); });
      if (!wasOpen) panel.classList.add('open');
    }

    document.getElementById('tempo-button').addEventListener('click', function () { toggle(tempoPanel); });
    document.getElementById('guide-button').addEventListener('click', function () { toggle(guidePanel); });
    document.getElementById('menu-button').addEventListener('click', function () { toggle(guidePanel); });

    // Plain text for tab numbers and guide steps (no segment digits).
    document.querySelectorAll('.tab-button .num').forEach(function (el) {
      // nums are hidden via CSS in the minimal design
    });
    document.querySelectorAll('.guide-num[data-seg]').forEach(function (el) {
      el.textContent = el.getAttribute('data-seg');
    });

    // BPM: drag/scroll the top-bar chip (tap opens the panel), drag the big
    // chip, the metronome plate, or the mustard fine-adjust plate.
    function getBpm() { return audioEngine.getBpm(); }
    function setBpm(v) { Jam.setBpm(v); }
    attachDragValue(document.getElementById('bpm-chip'), 4, getBpm, setBpm,
      function () { toggle(tempoPanel); });
    attachDragValue(document.getElementById('chip-bpm'), 4, getBpm, setBpm);
    attachDragValue(document.getElementById('metro-plate'), 3, getBpm, setBpm);
    attachDragValue(document.getElementById('knurl-plate'), 7, getBpm, setBpm);

    // SWING (0..80, percent) and KEY (−12..+12 semitones).
    attachDragValue(document.getElementById('chip-swing'), 5,
      function () { return Math.round(audioEngine.getSwing() * 100); },
      function (v) { Jam.setSwing(Math.max(0, Math.min(80, v)) / 100); });
    attachDragValue(document.getElementById('chip-key'), 14,
      function () { return audioEngine.getKeyTranspose(); },
      function (v) { Jam.setKey(v); });

    refreshTempoDisplays();
  }

  // Brief, self-dismissing status message (used by Export).
  function showToast(message) {
    let toast = document.getElementById('snapit-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'snapit-toast';
      toast.style.cssText =
        'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
        'background:#F8F5EE;color:#2C2C30;border:1px solid #E0DAC8;border-radius:12px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.1);' +
        'padding:10px 18px;font:600 13px Inter,system-ui,sans-serif;' +
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
