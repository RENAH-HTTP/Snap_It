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

  // Which tracks have their advanced (pitch/vel/gate/fx) lanes expanded — kept
  // across sequencer rebuilds so a structural edit doesn't collapse your lanes.
  const advOpenTracks = {};

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

    setupDeck();
    setupModuleControls();
    setupSequencerTransport();
    setupTopBar();
    setupProfilePanel();
    setupCollection();
    setupPicker();

    // Start the live camera + object detection, then wire the camera picker.
    Vision.start(
      document.getElementById('camera-video'),
      document.getElementById('camera-canvas'),
      document.getElementById('vision-status')
    ).then(setupCameraPicker);
    renderLibrary();
    syncTracksToPads(); // the kit IS the sequencer — mirror pads into rows
    renderSequencer();
    startScope();
    if (window.Visualizer) Visualizer.start(document.getElementById('live-scope'));

    // When an object is "scanned" (button today, camera later), unlock it.
    cameraStub.onObjectScanned(handleScan);

    // Highlight the playing column as the sequence advances.
    audioEngine.onStep(highlightStep);

    console.log('[ui] ready');
  }

  // ---- tabs ------------------------------------------------------------------

  // ---- deck & track selection ------------------------------------------------

  let activeTrackIndex = 0; // 0..3 for TR1..TR4, 'fx' for FX
  
  function setupModuleControls() {
    // Fullscreen for Scanner
    const camFsBtn = document.getElementById('cam-fullscreen-btn');
    if (camFsBtn) {
      camFsBtn.addEventListener('click', () => {
        const wrapper = document.getElementById('card-video').closest('.panel-rot-wrapper');
        if (wrapper) {
          wrapper.classList.toggle('module-fullscreen');
          Jam.triggerResize();
        }
      });
    }

    // Fullscreen for Sequencer
    const seqFsBtn = document.getElementById('seq-fullscreen-btn');
    if (seqFsBtn) {
      seqFsBtn.addEventListener('click', () => {
        const wrapper = document.getElementById('card-seq').closest('.panel-rot-wrapper');
        if (wrapper) wrapper.classList.toggle('module-fullscreen');
      });
    }

    // Camera Toggle
    let cameraEnabled = true;
    const camToggleBtn = document.getElementById('cam-toggle-btn');
    const overlay = document.getElementById('cam-disabled-overlay');
    if (camToggleBtn && overlay) {
      camToggleBtn.addEventListener('click', () => {
        cameraEnabled = !cameraEnabled;
        if (!cameraEnabled) {
          if (window.Vision && Vision.stop) Vision.stop();
          overlay.classList.add('show');
          camToggleBtn.style.color = 'var(--red, #FF3366)';
        } else {
          if (window.Vision && Vision.start) {
            Vision.start(
              document.getElementById('camera-video'),
              document.getElementById('camera-canvas'),
              document.getElementById('vision-status')
            );
          }
          overlay.classList.remove('show');
          camToggleBtn.style.color = 'var(--ink)';
        }
      });
    }
  }

  function setupDeck() {
    // XY morph pad: every colour zone is one effect; the cursor position
    // morphs between them (closer to a zone's centre = more of that effect).
    const xy = document.getElementById('xy-pad');
    if (xy) {
      const cur = xy.querySelector('.xy-cursor');
      const bypassBtn = document.getElementById('xy-bypass');

      // Reflect "is the rack dry?" on both the cursor and the DRY button, so the
      // player always knows whether an effect is engaged.
      function setDry(dry) {
        cur.classList.toggle('off', dry);
        if (bypassBtn) bypassBtn.classList.toggle('on', dry);
      }

      function placeXy(ev) {
        const r = xy.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        const y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
        cur.style.left = (x * 100) + '%';
        cur.style.top = (y * 100) + '%';
        audioEngine.setFxMorph(x, y);
      }
      xy.addEventListener('pointerdown', function (e) {
        if (bypassBtn && (e.target === bypassBtn || bypassBtn.contains(e.target))) return;
        e.preventDefault();
        audioEngine.unlock();
        setDry(false); // grabbing the pad engages the rack
        xy.setPointerCapture(e.pointerId);
        placeXy(e);
        function up() {
          xy.removeEventListener('pointermove', placeXy);
          xy.removeEventListener('pointerup', up);
        }
        xy.addEventListener('pointermove', placeXy);
        xy.addEventListener('pointerup', up);
      });

      // Explicit "no effect": the DRY button (and double-click) drop the whole
      // rack to dry so there's a clear, findable neutral.
      function bypass() {
        setDry(true);
        audioEngine.fxBypass();
      }
      if (bypassBtn) {
        bypassBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        bypassBtn.addEventListener('click', function (e) { e.stopPropagation(); bypass(); });
      }
      xy.addEventListener('dblclick', bypass);
    }
  }

  // ---- TR bar: one button per sequencer track ---------------------------------
  // The buttons mirror the track list live (there can be any number of tracks).
  // Tapping one focuses its row in the sequencer; FX flashes the XY panel.

  function renderTrackBar() {
    const wrap = document.getElementById('track-selectors');
    if (!wrap) return;
    wrap.innerHTML = '';
    const tracks = audioEngine.getTracks();
    const slots = Math.max(4, tracks.length); // always show at least 4 slots

    for (let i = 0; i < slots; i++) {
      const b = document.createElement('button');
      const track = tracks[i];
      b.className = 'tr-btn' +
        (String(i) === String(activeTrackIndex) ? ' active' : '') +
        (track ? ' has-color' : ' vacant');
      b.innerHTML = SEG(i + 1, 15);
      if (track) {
        const d = describeSample(track.objectType, track.displayName);
        b.style.setProperty('--tc', d.type.color);
        b.title = track.displayName;
      } else {
        b.title = 'Empty slot — scan an object or tap + on your kit';
      }
      (function (i) {
        b.addEventListener('click', function () {
          activeTrackIndex = String(i);
          renderTrackBar();
          applyTrackFocus();
        });
      })(i);
      wrap.appendChild(b);
    }

    const fx = document.createElement('button');
    fx.className = 'tr-btn fx' + (activeTrackIndex === 'fx' ? ' active' : '');
    fx.textContent = 'FX';
    fx.title = 'XY effects pad';
    fx.addEventListener('click', function () {
      activeTrackIndex = 'fx';
      renderTrackBar();
      applyTrackFocus();
    });
    wrap.appendChild(fx);
  }

  // TR buttons focus a sequencer row (outline + scroll to it); FX flashes the
  // XY panel, which is where the performance effects live.
  function applyTrackFocus() {
    const blocks = document.querySelectorAll('#sequencer-tracks .track-block');
    blocks.forEach(function (b, idx) {
      b.classList.toggle('tr-focus', String(idx) === String(activeTrackIndex));
    });
    if (activeTrackIndex === 'fx') {
      const xyCard = document.getElementById('card-xy');
      xyCard.classList.remove('flash');
      void xyCard.offsetWidth;
      xyCard.classList.add('flash');
      xyCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      const b = blocks[+activeTrackIndex];
      if (b) b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function switchToTab(name) {
    // Tabs no longer exist; user swipes manually. This is a stub for old code.
  }

  // ---- jam session: engine events -> DOM --------------------------------------
  // Whether an edit was made here or on another laptop, it lands in the engine
  // via Jam and surfaces through these events. Granular events touch single
  // cells (so drags keep working); 'pattern' rebuilds the whole grid.

  function setupJamEvents() {
    Jam.on('pattern', function () { renderSequencer(); updateFlipSeqWidth(); });

    Jam.on('step', function (trackId, i, on) {
      const dom = trackDom[trackId];
      if (dom && dom.stepCells[i]) dom.stepCells[i].classList.toggle('on', on);
    });

    Jam.on('pitch', function (trackId, i, val) {
      const dom = trackDom[trackId];
      if (dom) dom.setPitchDisplay(i, val);
    });

    Jam.on('vel', function (trackId, i, val) {
      const dom = trackDom[trackId];
      if (dom) dom.setLane('vel', i, val);
    });

    Jam.on('len', function (trackId, i, val) {
      const dom = trackDom[trackId];
      if (dom) dom.setLane('len', i, val);
    });

    Jam.on('fx', function (trackId, fxName, i, val) {
      const dom = trackDom[trackId];
      if (dom) dom.setLane('fx_' + fxName, i, val);
    });

    Jam.on('patternLen', function (len) {
      renderSequencer();
      updateFlipSeqWidth();   // flipped length tracks the beat count
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
      document.querySelectorAll('.guide-panel.open, .profile-panel.open').forEach(function (p) {
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
        const code = Jam.getRoomCode() || '----';
        const ips = Jam.getLanIps();
        // On a LOCAL server, friends also need the address to open the app;
        // on a published (cloud) site they're already on it — just share the code.
        const where = ips.length
          ? ' · on this WiFi open http://' + ips[0] + ':' + (location.port || 80) + '/app.html'
          : '';
        ipsEl.textContent = 'Room code: ' + code + ' — friends tap Join and enter it' + where;
        peersEl.textContent = '0 connected';
      } else if (role === 'client') {
        ipsEl.textContent = 'In room ' + (Jam.getRoomCode() || '') + '.';
        peersEl.textContent = '';
      } else {
        ipsEl.textContent = '';
        peersEl.textContent = '';
      }
    });
  }

  // ---- camera picker -----------------------------------------------------------
  // Fill the dropdown with the machine's cameras (labels only appear once the
  // user has granted permission, which Vision.start already did).

  async function setupCameraPicker() {
    const sel = document.getElementById('camera-select');
    if (!sel || !window.Vision || !Vision.listCameras) return;

    async function refresh() {
      const cams = await Vision.listCameras();
      const current = Vision.currentCamera();
      if (!cams.length) { sel.innerHTML = '<option>No camera found</option>'; return; }
      sel.innerHTML = '';
      cams.forEach(function (c) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        if (c.id && c.id === current) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    sel.addEventListener('change', function () {
      Vision.setCamera(sel.value).then(refresh);
    });
    // A camera being plugged in/out changes the list.
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', refresh);
    }
    await refresh();
  }

  // ---- player profile: login / signup / display name ---------------------------

  function setupProfilePanel() {
    if (!window.Profile) return;

    const authSec = document.getElementById('profile-auth');
    const userSec = document.getElementById('profile-user');
    const emailIn = document.getElementById('pp-email');
    const passIn  = document.getElementById('pp-pass');
    const err1    = document.getElementById('pp-error');
    const err2    = document.getElementById('pp-error2');
    const nameIn  = document.getElementById('pp-newname');

    const delBtn = document.getElementById('pp-delete');
    let delArmed = false;

    function disarmDelete() {
      delArmed = false;
      delBtn.classList.remove('confirm');
      delBtn.textContent = 'Delete account';
    }

    function renderProfile() {
      const cur = Profile.current();
      authSec.style.display = cur ? 'none' : '';
      userSec.style.display = cur ? '' : 'none';
      err1.textContent = '';
      err2.textContent = '';
      disarmDelete();
      if (cur) {
        document.getElementById('pp-name').textContent = cur.name;
        document.getElementById('pp-mail').textContent = cur.email;
        document.getElementById('pp-ava').textContent = (cur.name || '?').charAt(0);
        nameIn.value = cur.name;
      } else {
        document.getElementById('pp-guestname').value = Profile.guestName();
      }
    }

    // Passwordless player name: enough to be seen by name in a jam.
    document.getElementById('pp-saveguest').addEventListener('click', function () {
      run(function () {
        const n = Profile.setGuestName(document.getElementById('pp-guestname').value);
        showToast(n ? 'Playing as ' + n : 'Name cleared');
      }, err1);
    });
    document.getElementById('pp-guestname').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('pp-saveguest').click();
    });

    // Run an async Profile action; surface its error message in the panel.
    function run(fn, errEl) {
      Promise.resolve().then(fn).catch(function (e) {
        errEl.textContent = (e && e.message) || String(e);
      });
    }

    document.getElementById('pp-login').addEventListener('click', function () {
      run(function () { return Profile.login(emailIn.value, passIn.value); }, err1);
    });
    document.getElementById('pp-signup').addEventListener('click', function () {
      run(function () { return Profile.signup(emailIn.value, passIn.value); }, err1);
    });
    passIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        run(function () { return Profile.login(emailIn.value, passIn.value); }, err1);
      }
    });
    document.getElementById('pp-savename').addEventListener('click', function () {
      run(function () { Profile.setName(nameIn.value); showToast('Name saved'); }, err2);
    });
    nameIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('pp-savename').click();
    });
    document.getElementById('pp-logout').addEventListener('click', function () {
      Profile.logout();
    });

    // Deleting is destructive (the account's collection goes with it), so the
    // button arms first and only a second press within 4s actually deletes.
    delBtn.addEventListener('click', function () {
      if (!delArmed) {
        delArmed = true;
        delBtn.classList.add('confirm');
        delBtn.textContent = 'Really delete? Collection is wiped too';
        setTimeout(disarmDelete, 4000);
        return;
      }
      run(function () {
        Profile.deleteAccount();
        showToast('Account deleted');
      }, err2);
    });

    // Login/logout swaps the whole collection: reload it and re-render.
    Profile.on('change', function (cur) {
      renderProfile();
      library.reloadUnlocks();
      padBank = null;         // pads are per-account too
      selectedPadId = null;
      renderLibrary();
      syncTracksToPads();     // swap the sequencer to the new account's kit
      if (document.getElementById('collection-modal').classList.contains('active')) {
        renderCollection();
      }
      passIn.value = '';
      showToast(cur ? 'Hi ' + cur.name + '!' : 'Logged out');
    });

    renderProfile();
  }

  // ---- collection modal: every sound, found and still hiding -------------------

  let colFilter = 'all';

  function setupCollection() {
    const modal = document.getElementById('collection-modal');
    function open() {
      colFilter = 'all';
      renderCollection();
      modal.classList.add('active');
    }
    function close() { modal.classList.remove('active'); }
    document.getElementById('collection-button').addEventListener('click', open);
    document.getElementById('kp-mode').addEventListener('click', open);
    document.getElementById('col-close').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  }

  function renderCollection() {
    const grid = document.getElementById('collection-grid');
    const chipsWrap = document.getElementById('col-chips');
    const map = library.getAllSampleInfo();
    const unlockedOrder = library.getUnlocked();

    const items = Object.keys(map)
      .filter(function (k) { return k !== '_default'; }) // Mystery isn't a collectible
      .map(function (objectType) {
        return {
          key: objectType,
          info: map[objectType],
          d: describeSample(objectType, map[objectType].displayName),
          unlocked: library.isUnlocked(objectType),
        };
      });

    // Progress readout: found / total.
    const found = items.filter(function (it) { return it.unlocked; }).length;
    document.getElementById('col-count').innerHTML =
      SEG(found, 16) + '<span class="col-of">OF ' + items.length + '</span>';

    // Filter chips. Counts include locked sounds — "more out there to find".
    const counts = {};
    items.forEach(function (it) {
      const c = counts[it.d.cat] || (counts[it.d.cat] = { total: 0, unlocked: 0 });
      c.total++;
      if (it.unlocked) c.unlocked++;
    });
    chipsWrap.innerHTML = '';
    function chip(catKey, labelTxt, iconHtml, color, got, total) {
      const b = document.createElement('button');
      b.className = 'col-chip' + (colFilter === catKey ? ' active' : '');
      b.innerHTML =
        (iconHtml ? '<span class="ico" style="color:' + color + '">' + iconHtml + '</span>' : '') +
        '<span>' + labelTxt + '</span><span class="cnt">' + got + '/' + total + '</span>';
      b.addEventListener('click', function () {
        colFilter = catKey;
        renderCollection();
      });
      chipsWrap.appendChild(b);
    }
    chip('all', 'All', '', null, found, items.length);
    Object.keys(SAMPLE_TYPES).forEach(function (cat) {
      if (!counts[cat]) return;
      const t = SAMPLE_TYPES[cat];
      chip(cat, t.label, t.icon, t.color, counts[cat].unlocked, counts[cat].total);
    });

    // Cards: unlocked first (in type order), locked teasers after.
    const typeOrder = Object.keys(SAMPLE_TYPES);
    let shown = (colFilter === 'all')
      ? items
      : items.filter(function (it) { return it.d.cat === colFilter; });
    shown = shown.slice().sort(function (a, b) {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      return (typeOrder.indexOf(a.d.cat) - typeOrder.indexOf(b.d.cat)) ||
             a.info.displayName.localeCompare(b.info.displayName);
    });
    const newestKey = unlockedOrder.length ? unlockedOrder[unlockedOrder.length - 1] : null;

    grid.innerHTML = '';
    shown.forEach(function (item) {
      const card = document.createElement('button');
      const rar = RARITIES[item.d.rarity];
      const rarHtml = '<span class="ci-rar" style="color:' + rar.color + '">' +
        (rar.stars ? rar.stars + ' ' : '') + rar.label + '</span>';

      if (item.unlocked) {
        card.className = 'col-item';
        card.innerHTML =
          '<span class="ci-ico" style="color:' + item.d.type.color + '">' + item.d.type.icon + '</span>' +
          '<span class="ci-name"></span>' +
          '<span class="ci-kind">' + item.d.type.label + '</span>' + rarHtml +
          (item.key === newestKey ? '<span class="ci-new"></span>' : '');
        card.querySelector('.ci-name').textContent = item.info.displayName;
        card.title = 'Play ' + item.info.displayName;
        card.addEventListener('click', function () {
          card.classList.remove('pop');
          void card.offsetWidth;
          card.classList.add('pop');
          audioEngine.previewSample(item.key);
        });
      } else {
        const clue = objectClue(item.key);
        card.className = 'col-item locked';
        card.innerHTML =
          '<span class="ci-ico"><span class="ci-hatch"></span></span>' +
          '<span class="ci-name">? ? ?</span>' +
          '<span class="ci-kind">' + item.d.type.label + '</span>' + rarHtml +
          '<span class="ci-clue"></span>';
        // Clue: the real-world object you have to scan to unlock this sound.
        card.querySelector('.ci-clue').textContent = '🔍 Scan a ' + clue;
        card.title = 'Scan a ' + clue + ' in the real world to unlock this sound';
      }
      grid.appendChild(card);
    });
  }

  // ---- scan tab --------------------------------------------------------------
  // Scanning is fully automatic now: Vision detects an object via the webcam and
  // calls cameraStub.simulateScan(), which fires handleScan below.

  // Runs whenever an object is scanned. Unlocks it and shows the reveal.
  function handleScan(objectType) {
    if (padBank == null) loadPadBank();
    const key = library.resolveKey(objectType);
    const alreadyOwned = library.isUnlocked(key);
    const result = library.unlock(objectType);

    // Only a genuinely NEW find interrupts you. Re-seeing an object you already
    // own (e.g. the camera keeps spotting the same thing, or misreads a person
    // as a couch) must never re-pop the modal — that's what made the camera feel
    // "stuck". At most it gives a quiet toast, throttled.
    if (result.isNewUnlock) {
      // land the new sound on a fresh pad (padBank holds {id,key,snd} objects)
      // and, since the kit IS the sequencer, drop it straight into a row too.
      if (!padBank.some(function (p) { return p.key === key; })) {
        const np = makePad(key);
        padBank.push(np);
        savePadBank();
        addPadTrack(np);
      }
      renderLibrary();
      // don't stack modals — if one's already up, just toast instead
      if (document.getElementById('reveal-modal').classList.contains('active')) {
        showToast('Unlocked ' + result.sampleInfo.displayName);
      } else {
        showReveal(result);
      }
    } else if (!alreadyOwned) {
      // (defensive) unlocked-but-not-previously-owned edge — refresh quietly
      renderLibrary();
    }

    if (document.getElementById('collection-modal').classList.contains('active')) {
      renderCollection(); // keep the open pokedex in sync too
    }
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

  // ---- readouts --------------------------------------------------------------
  // Our numeric displays use clean, heavy tabular numerals (not a 7-segment LCD)
  // — a distinct look that still reads as an instrument readout. SEG(value, px)
  // returns an inline span sized to `px`, inheriting currentColor so it recolours
  // for free wherever it's dropped in.
  function SEG(str, height) {
    const size = Math.round((height || 16) * 1.15);
    return '<span class="rd" style="font-size:' + size + 'px">' +
           String(str).replace(/</g, '&lt;') + '</span>';
  }

  // Note names for the KEY readout (plain sharps now that we're off the LCD).
  const NOTES_SEG = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

  // A pool of distinct flat glyphs. Every SOUND (not just every type) picks one
  // by hash, so sixteen "Hi-Hat"s no longer share one icon. Paired with a
  // per-sound colour below, each sound gets its own visual identity.
  const GLYPHS = [
    '<circle cx="12" cy="12" r="8.5"/>',
    '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="3"/>',
    '<rect x="4.5" y="4.5" width="15" height="15" rx="2.6"/>',
    '<rect x="6" y="6" width="12" height="12" rx="2" transform="rotate(45 12 12)"/>',
    '<path d="M12 3.4 L20.6 19.6 L3.4 19.6 Z"/>',
    '<path d="M3.4 4.4 L20.6 4.4 L12 20.6 Z"/>',
    '<path d="M12 2 L14 9.6 L21.8 12 L14 14.4 L12 22 L10 14.4 L2.2 12 L10 9.6 Z"/>',
    '<path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z"/>',
    '<path d="M12 3 C12 3 19 11.2 19 15 A7 7 0 0 1 5 15 C5 11.2 12 3 12 3 Z"/>',
    '<path d="M13.4 2 L5 13 H11 L10.2 22 L19 9.6 H13 Z"/>',
    '<path d="M5 5.6 L12 12 L5 18.4" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 5.6 L19 12 L12 18.4" fill="none" stroke="currentColor" stroke-width="2.6"/>',
    '<path d="M4 14 Q12 4 20 14" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M7.5 18 Q12 12 16.5 18" fill="none" stroke="currentColor" stroke-width="2.4"/>',
    '<circle cx="8" cy="8" r="2.9"/><circle cx="16" cy="8" r="2.9"/><circle cx="8" cy="16" r="2.9"/><circle cx="16" cy="16" r="2.9"/>',
    '<rect x="10" y="3.4" width="4" height="17.2" rx="1.6"/><rect x="3.4" y="10" width="17.2" height="4" rx="1.6"/>',
    '<path d="M3 12 Q7 5 11 12 T19 12" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M3 17.5 Q7 10.5 11 17.5 T19 17.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
    '<path d="M12 2.5 L21.5 8 V16 L12 21.5 L2.5 16 V8 Z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="2.6"/>',
  ];

  // Deterministic per-sound colour: golden-angle hue spread keeps neighbouring
  // sounds far apart on the wheel, so a kit of 16 reads as 16 colours.
  function soundColor(h) {
    return 'hsl(' + Math.round((h * 137.508) % 360) + ', 58%, 47%)';
  }
  function soundGlyph(h) {
    return icon(GLYPHS[h % GLYPHS.length]);
  }

  // Turn a detector key ("traffic_light") into a human clue ("Traffic Light").
  function objectClue(key) {
    return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

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

    // Give this exact sound its own colour + glyph, overriding the shared type
    // visuals. Everything that renders through d.type.color / d.type.icon (pads,
    // mixer, sequencer rows, collection, reveal) becomes per-sound for free.
    // d.type.label stays the category name ("Hi-Hat") so the drum's role reads.
    const type = Object.assign({}, SAMPLE_TYPES[cat], {
      color: soundColor(h),
      icon: soundGlyph(h),
    });

    return { cat: cat, type: type, rarity: rarity, note: note, choke: choke };
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

  // Vertical fader: top of the track = 1, bottom = 0. `resetNorm` (optional) is
  // the normalised default a double-click snaps back to.
  function attachVFader(vfader, initial, onChange, resetNorm) {
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
    if (resetNorm != null) vfader.addEventListener('dblclick', function () { set(resetNorm); });
  }

  // Horizontal slider: left = 0, right = 1. `resetNorm` (optional) is the
  // normalised default a double-click snaps back to.
  function attachHSlider(hslider, initial, onChange, resetNorm) {
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
    if (resetNorm != null) hslider.addEventListener('dblclick', function () { set(resetNorm); });
  }

  // ---- library tab -----------------------------------------------------------

  // Collection view state (Pokedex-style): current type filter + sort mode.
  let libFilter = 'all';
  let libSort = 'type';

  function setupLibraryControls() {
    // Removed old library filter/sort.
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

  // ---- pad bank ----------------------------------------------------------------
  // The keypad is the player's own bank of pads. Each pad is its OWN voice —
  // { id, key, snd } — so two pads holding the same sample can be tuned and
  // shaped independently (fixing the "editing pad 1 also changed pad 3" bug).
  // Scanning a new object auto-adds a pad; the ⇄ corner button (or the + tile)
  // opens the picker to swap/add sounds.

  const PADS_KEY = 'snapit.pads.v1';
  let padBank = null;          // array of { id, key, snd }, or null = not loaded
  let selectedPadId = null;    // which pad the SOUND panel is editing
  let nextPadId = 1;

  function padsStorageKey() {
    const suffix = (window.Profile && Profile.storageSuffix && Profile.storageSuffix()) || '';
    return PADS_KEY + suffix;
  }

  function defaultSnd(key) {
    return audioEngine.getSampleSettings(key) ||
           { attack: 0.005, decay: 0.2, sustain: 1, release: 0.3, cents: 0 };
  }

  function makePad(key) {
    return { id: 'p' + (nextPadId++), key: key, snd: defaultSnd(key) };
  }

  function loadPadBank() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(padsStorageKey())); } catch (e) {}
    padBank = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (p) {
        // migrate old format (array of plain keys) -> pad objects
        const key = (typeof p === 'string') ? p : (p && p.key);
        if (!key || !library.isUnlocked(key)) return;
        padBank.push({
          id: 'p' + (nextPadId++),
          key: key,
          snd: (p && p.snd) ? Object.assign(defaultSnd(key), p.snd) : defaultSnd(key),
        });
      });
    } else {
      // first run: one pad per unlocked sound
      library.getUnlocked().forEach(function (key) { padBank.push(makePad(key)); });
    }
  }

  function savePadBank() {
    localStorage.setItem(padsStorageKey(), JSON.stringify(padBank));
  }

  function describeKey(objectType) {
    const info = library.getSampleInfo(objectType);
    return { key: objectType, info: info, d: describeSample(objectType, info.displayName) };
  }

  function findPad(id) {
    return padBank.find(function (p) { return p.id === id; });
  }

  // ---- kit <-> sequencer (they are one) --------------------------------------
  // A pad in the kit IS a row in the sequencer — no separate "add" step. These
  // keep the two in lockstep as pads come and go.

  // Drop a pad into the sequencer as its own row, linked back by the pad id so
  // later SOUND-panel edits keep flowing to it.
  function addPadTrack(pad) {
    const info = describeKey(pad.key).info;
    Jam.addTrack(pad.key, info.displayName, pad.snd, pad.id);
  }

  // Give any pad that lacks a row one, and drop rows whose pad is gone. Solo
  // only: in a jam the shared project is the source of truth, so we never
  // auto-push the local kit into the room.
  function syncTracksToPads() {
    if (window.Jam && Jam.role && Jam.role() !== 'offline') return;
    if (padBank == null) loadPadBank();
    padBank.forEach(function (pad) {
      if (audioEngine.getTrackIdForPad(pad.id) == null) addPadTrack(pad);
    });
    audioEngine.getTracks().forEach(function (t) {
      const sp = audioEngine.getPadForTrack(t.id);
      if (sp && !padBank.some(function (p) { return p.id === sp; })) Jam.removeTrack(t.id);
    });
  }

  function renderLibrary() {
    const grid = document.getElementById('library-grid');
    grid.innerHTML = '';
    if (padBank == null) loadPadBank();

    const unlockedOrder = library.getUnlocked();
    const newestKey = unlockedOrder.length ? unlockedOrder[unlockedOrder.length - 1] : null;

    // Keep the selection valid: fall back to the first pad.
    if (!findPad(selectedPadId)) {
      selectedPadId = padBank.length ? padBank[0].id : null;
    }

    padBank.forEach(function (pad, i) {
      const item = describeKey(pad.key);
      const cell = document.createElement('button');
      cell.style.setProperty('--i', i); // cascade-in stagger
      cell.className = 'pad' + (pad.id === selectedPadId ? ' selected' : '');
      cell.style.setProperty('--type-color', item.d.type.color);
      cell.innerHTML =
        '<div class="pad-ico" style="color: ' + item.d.type.color + '">' + item.d.type.icon + '</div>' +
        '<div class="pad-num">' + SEG(i + 1, 9) + '</div>' +
        (pad.key === newestKey ? '<div class="pad-new-dot"></div>' : '') +
        '<span class="pad-swap" title="Swap this pad\'s sound">&#8644;</span>';
      cell.title = item.info.displayName;

      cell.querySelector('.pad-swap').addEventListener('click', function (e) {
        e.stopPropagation(); // don't fire the pad underneath
        openSamplePicker(pad.id);
      });

      cell.addEventListener('click', function () {
        // Select in place (no grid re-render) so the press animation shows.
        if (selectedPadId !== pad.id) {
          selectedPadId = pad.id;
          grid.querySelectorAll('.pad.selected').forEach(function (p) {
            p.classList.remove('selected');
          });
          cell.classList.add('selected');
          renderEditor(pad);
        }
        cell.classList.remove('pop');
        void cell.offsetWidth; // restart the squash animation
        cell.classList.add('pop');
        // Tapping a pad loads its waveform into the Live Signal panel; until then
        // the panel stays empty (no default drum).
        if (window.Visualizer && Visualizer.setSample) Visualizer.setSample(pad.key, item.d.type.color);
        audioEngine.previewSample(pad.key, pad.snd);
      });

      grid.appendChild(cell);
    });

    // The + tile adds a brand new pad…
    const add = document.createElement('button');
    add.className = 'pad pad-addable';
    add.style.setProperty('--i', padBank.length);
    add.innerHTML = '<span class="pad-add-ico">+</span>';
    add.title = 'Add a pad';
    add.addEventListener('click', function () { openSamplePicker(null); });
    grid.appendChild(add);

    // …and fillers square the grid off to at least 4x4.
    const used = padBank.length + 1;
    const total = Math.max(16, Math.ceil(used / 4) * 4);
    for (let i = used; i < total; i++) {
      const filler = document.createElement('button');
      filler.className = 'pad filler';
      filler.style.setProperty('--i', i);
      filler.innerHTML = '<div class="pad-num">' + SEG(i + 1, 9) + '</div>';
      grid.appendChild(filler);
    }

    // Keep the SOUND panel in sync with the current selection.
    const sel = findPad(selectedPadId);
    if (sel) renderEditor(sel);
    else document.getElementById('lib-editor').innerHTML =
      '<div class="ed-empty">TAP A PAD TO SHAPE ITS SOUND</div>';
  }

  // ---- sample picker: choose a sound for a pad ----------------------------------

  let pickerTargetId = null;  // pad id being swapped, or null = append a new pad

  function setupPicker() {
    const modal = document.getElementById('picker-modal');
    document.getElementById('picker-close').addEventListener('click', function () {
      modal.classList.remove('active');
    });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.remove('active');
    });
    document.getElementById('picker-remove').addEventListener('click', function () {
      const idx = padBank.findIndex(function (p) { return p.id === pickerTargetId; });
      if (idx !== -1) {
        // Pulling a pad from the kit also pulls its row from the sequencer.
        const tid = audioEngine.getTrackIdForPad(padBank[idx].id);
        if (tid != null) Jam.removeTrack(tid);
        padBank.splice(idx, 1);
        savePadBank();
        renderLibrary();
      }
      modal.classList.remove('active');
    });
  }

  function openSamplePicker(padId) {
    pickerTargetId = padId;
    const pad = findPad(padId);
    const modal = document.getElementById('picker-modal');
    const grid = document.getElementById('picker-grid');
    const removeBtn = document.getElementById('picker-remove');
    document.getElementById('picker-title').textContent =
      padId == null ? 'ADD A PAD' : 'SWAP THIS PAD';
    removeBtn.style.display = padId == null ? 'none' : '';

    grid.innerHTML = '';
    // Mystery is always available; then every unlocked sound.
    const choices = ['_default'].concat(library.getUnlocked());
    choices.forEach(function (key) {
      const item = describeKey(key);
      const isMystery = key === '_default';
      const b = document.createElement('button');
      b.className = 'picker-item' + ((pad && pad.key === key) ? ' current' : '');
      b.innerHTML =
        '<span class="pi-ico" style="color:' + (isMystery ? '#8E8977' : item.d.type.color) + '">' +
          (isMystery ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M9 9a3 3 0 116 0c0 2-3 2-3 4"/><circle cx="12" cy="18" r="1.3"/><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' : item.d.type.icon) +
        '</span>' +
        '<span class="pi-name"></span>';
      b.querySelector('.pi-name').textContent = isMystery ? 'Mystery Hit' : item.info.displayName;
      b.title = isMystery ? 'A random sound every time you play it' : item.info.displayName;
      b.addEventListener('click', function () {
        if (pickerTargetId == null) {
          const np = makePad(key);
          padBank.push(np);
          selectedPadId = np.id;
          addPadTrack(np);                       // new pad => new sequencer row
        } else {
          const t = findPad(pickerTargetId);
          if (t) {
            t.key = key; t.snd = defaultSnd(key); selectedPadId = t.id;
            // Swap the pad's existing row to the new sound (keeps its steps).
            const tid = audioEngine.getTrackIdForPad(t.id);
            if (tid != null) Jam.swapTrack(tid, key, describeKey(key).info.displayName, t.snd);
            else addPadTrack(t);
          }
        }
        savePadBank();
        modal.classList.remove('active');
        renderLibrary();
        audioEngine.previewSample(key, findPad(selectedPadId).snd);
      });
      grid.appendChild(b);
    });

    modal.classList.add('active');
  }

  // Fill the editor plate (waveform + ADSR faders + tune) for ONE pad. Edits go
  // to that pad's own `snd`, so shaping one pad never touches another — even if
  // they share the same underlying sample. Split out of renderLibrary so
  // selecting a pad never rebuilds the grid.
  function renderEditor(pad) {
    const editor = document.getElementById('lib-editor');
    editor.className = 'lib-editor';

    const item = describeKey(pad.key);
    const info = item.info;
    const d = item.d;
    const objectType = pad.key;
    const isMystery = pad.key === '_default';
    const rar = RARITIES[d.rarity];
    const rarLabel = isMystery ? 'Random' : (rar.stars ? rar.stars + ' ' : '') + rar.label;
    const name = isMystery ? 'Mystery Hit' : info.displayName;

    const playSvg =
      '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">' +
        '<path d="M5 3.4v9.2l8-4.6z"/>' +
      '</svg>';

    editor.innerHTML =
      '<div class="ed-main">' +
        '<div class="ed-head">' +
          '<span class="ed-ico" style="color: ' + d.type.color + '">' + d.type.icon + '</span>' +
          '<span class="ed-name" title="' + name + '">' + name + '</span>' +
          '<span class="ed-meta" style="color: ' + rar.color + '">' + rarLabel + '</span>' +
          '<div class="ed-spacer"></div>' +
          '<button class="ed-play" title="Preview">' + playSvg + '</button>' +
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

    // Wiring Editor Events — all shaping targets THIS pad's snd.
    editor.querySelector('.ed-play').addEventListener('click', function () {
      audioEngine.previewSample(pad.key, pad.snd);
    });

    const canvas = editor.querySelector('.ed-wave');
    drawWaveform(canvas, objectType, d.type.color);
    canvas.addEventListener('click', function () { audioEngine.previewSample(pad.key, pad.snd); });

    // ADSR faders + tune, initialised from and written back to pad.snd.
    const s = pad.snd;
    const faderEls = editor.querySelectorAll('.vfader');
    // Editing a fader updates pad.snd, persists it, AND flows live to any
    // sequencer track made from this pad so the beat reflects the change.
    const commit = function () {
      savePadBank();
      audioEngine.updateTrackSndForPad(pad.id, pad.snd);
    };
    // The sample's own defaults — what a double-click on a fader initialises to.
    const defSnd = defaultSnd(pad.key);
    ADSR_SPECS.forEach(function (spec, i) {
      const norm = (s[spec.field] - spec.min) / (spec.max - spec.min);
      const defNorm = (defSnd[spec.field] - spec.min) / (spec.max - spec.min);
      attachVFader(faderEls[i], norm, function (n) {
        s[spec.field] = spec.min + n * (spec.max - spec.min);
        commit();
      }, defNorm);
    });

    const tuneSlider = editor.querySelector('.hslider.tune');
    const tuneReadout = editor.querySelector('.ed-tune-val');
    const setTuneText = function (st) {
      tuneReadout.textContent = (st > 0 ? '+' : '') + st + ' st';
      tuneSlider.title = 'Tune ' + (st > 0 ? '+' : '') + st + ' st';
    };
    setTuneText(Math.round((s.cents || 0) / 100));
    attachHSlider(tuneSlider, ((s.cents || 0) / 100 + 48) / 96, function (n) {
      const st = Math.round(n * 96 - 48);
      s.cents = st * 100;
      commit();
      setTuneText(st);
    }, 0.5); // double-click -> 0 st (centre)
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

    const tracks = audioEngine.getTracks();

    // No tracks yet: just show a simple clean hint
    if (tracks.length === 0) {
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
      slot.title = track.displayName + ' — drag to set level, double-click to reset';
      slot.style.setProperty('--bar-color', d.type.color);

      // Channel number (top) so a bar maps back to its sequencer row.
      const num = document.createElement('div');
      num.className = 'mix-num';
      num.textContent = idx + 1;
      slot.appendChild(num);

      const crayon = document.createElement('div');
      crayon.className = 'mix-crayon';
      crayon.style.setProperty('--v', volToHeight(track.volume == null ? 0.8 : track.volume));
      slot.appendChild(crayon);

      // The strip carries the track's TYPE ICON, so you can tell kick from hat
      // at a glance even across 16 skinny channels.
      const strip = document.createElement('div');
      strip.className = 'mix-strip';
      strip.innerHTML = '<span class="ms-ico">' + d.type.icon + '</span>';
      strip.title = track.displayName;
      slot.appendChild(strip);

      // An explicit, unmissable mute toggle (the old "tap the number" was invisible).
      const muteBtn = document.createElement('button');
      muteBtn.className = 'mix-mute';
      muteBtn.textContent = track.muted ? 'MUTED' : 'MUTE';
      muteBtn.title = 'Mute / unmute ' + track.displayName;
      muteBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      muteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        Jam.setMute(track.id, !slot.classList.contains('muted'));
      });
      slot.appendChild(muteBtn);

      // Absolute fader across the bar region (the area above the strip + mute),
      // so the level tracks your finger: top of the region = full, strip = zero.
      function setFromEvent(ev) {
        const r = slot.getBoundingClientRect();
        const stripTop = strip.getBoundingClientRect().top;
        const usable = Math.max(1, stripTop - r.top);
        const v = Math.max(0, Math.min(1, (stripTop - ev.clientY) / usable));
        Jam.setVolume(track.id, Math.round(v * 100) / 100);
      }
      slot.addEventListener('pointerdown', function (e) {
        if (e.target === muteBtn || muteBtn.contains(e.target)) return; // mute handles itself
        e.preventDefault();
        slot.setPointerCapture(e.pointerId);
        setFromEvent(e);
        function move(ev) { setFromEvent(ev); }
        function up() {
          slot.removeEventListener('pointermove', move);
          slot.removeEventListener('pointerup', up);
        }
        slot.addEventListener('pointermove', move);
        slot.addEventListener('pointerup', up);
      });
      // Double-click resets the channel to the default level.
      slot.addEventListener('dblclick', function (e) {
        if (e.target === muteBtn || muteBtn.contains(e.target)) return;
        Jam.setVolume(track.id, 0.8);
      });

      mixerDom[track.id] = {
        setVol: function (v) { crayon.style.setProperty('--v', volToHeight(v)); },
        setMuted: function (m) {
          slot.classList.toggle('muted', m);
          muteBtn.textContent = m ? 'MUTED' : 'MUTE';
        },
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

  // When flipped on a phone/tablet, the sequencer panel is sized to its pattern
  // length so the whole thing scrolls in landscape — longer with more beats. The
  // width is derived from the step count + CSS step size (constants), never from
  // measuring a stretchable element, so it can't feed back into itself.
  function updateFlipSeqWidth() {
    const panel = document.querySelector('.p-seq');
    if (!panel) return;
    const rot = parseInt(document.body.getAttribute('data-rotation') || '0', 10);
    if (rot !== 90 && rot !== 270) {
      if (panel.style.width) panel.style.width = '';
      if (panel.style.minWidth) panel.style.minWidth = '';
      return;
    }
    // A flex item's default min-width:auto (min-content) would otherwise floor the
    // panel wider than we ask; pin it so our explicit width is exact.
    panel.style.minWidth = '0px';
    const steps = (window.audioEngine && audioEngine.getPatternLen) ? audioEngine.getPatternLen() : 16;
    const cs = getComputedStyle(document.documentElement);
    const stepPx = parseFloat(cs.getPropertyValue('--step')) || 52;
    const gapPx  = parseFloat(cs.getPropertyValue('--step-gap')) || 4;
    const labels = 150;                                   // sticky icon(48) + name(102)
    const groupPad = Math.floor(steps / 4) * 9;           // every-4th-step spacer
    // Exactly as long as the beats — 4 steps is short, 16 is long. (No viewport
    // floor: that would feed back through page height into itself.)
    const px = (labels + steps * (stepPx + gapPx) + groupPad + 40) + 'px';
    if (panel.style.width !== px) panel.style.width = px;
  }

  function renderSequencer() {
    renderMixer(); // the crayon bars mirror the track list 1:1

    const container = document.getElementById('sequencer-tracks');
    container.innerHTML = '';
    Object.keys(trackDom).forEach(function (k) { delete trackDom[k]; });
    
    const pLen = (window.audioEngine && audioEngine.getPatternLen) ? audioEngine.getPatternLen() : 16;
    
    // Pattern length selector
    const patLenBar = document.getElementById('pat-len-bar');
    if (patLenBar) {
      patLenBar.innerHTML = '';
      [4, 8, 12, 16].forEach(function (len) {
        const b = document.createElement('button');
        b.className = 'pat-len-btn' + (len === pLen ? ' active' : '');
        b.textContent = len + ' STEPS';
        b.addEventListener('click', function () {
          if (window.Jam && Jam.setPatternLen) Jam.setPatternLen(len);
        });
        patLenBar.appendChild(b);
      });
    }
    
    // Dynamic ruler
    const ruler = document.querySelector('.ruler-steps');
    if (ruler) {
      ruler.innerHTML = '';
      for (let i = 1; i <= pLen; i++) {
        const sp = document.createElement('span');
        sp.textContent = i;
        ruler.appendChild(sp);
      }
    }

    // The engine's track list IS the project (local or synced) — render from it.
    const tracks = audioEngine.getTracks();

    if (tracks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No sounds yet — scan an object or tap + on your kit to fill the sequencer.';
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

      // Split into sticky icon and scrolling text
      const icoWrap = document.createElement('div');
      icoWrap.className = 'tl-ico-wrap';
      icoWrap.style.cursor = 'pointer';
      icoWrap.title = 'Per-step pitch, velocity, gate & FX';
      icoWrap.innerHTML = '<span class="tl-ico" style="background:' + d.type.color + '">' +
        d.type.icon + '<span class="adv-indicator" style="font-size:8px; margin-left:3px; opacity:0.6; display:inline-block; transition:transform 0.2s;">▼</span></span>';
      
      if (advOpenTracks[track.id]) { block.classList.add('adv-open'); }
      icoWrap.addEventListener('click', function () {
        const open = !block.classList.contains('adv-open');
        block.classList.toggle('adv-open', open);
        advOpenTracks[track.id] = open;
      });
      row.appendChild(icoWrap);

      const txtWrap = document.createElement('div');
      txtWrap.className = 'tl-txt-wrap';
      txtWrap.innerHTML = '<span class="tl-txt"><span class="tl-nm"></span>' +
        '<span class="tl-by"></span></span>';
      txtWrap.querySelector('.tl-nm').textContent = track.displayName;
      const tlBy = txtWrap.querySelector('.tl-by');
      if (track.by && window.Jam && Jam.role && Jam.role() !== 'offline') {
        tlBy.textContent = track.by;
      } else {
        tlBy.remove();
      }
      row.appendChild(txtWrap);

      const stepCells = [];

      // 16 step cells (click = on/off).
      const steps = document.createElement('div');
      steps.className = 'track-steps';
      for (let i = 0; i < audioEngine.STEP_COUNT; i++) {
        const cell = document.createElement('button');
        cell.className = 'step';
        if (i % 4 === 0) cell.classList.add('beat-start');
        if (i >= audioEngine.getPatternLen()) cell.classList.add('step-hidden');
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
      remove.title = 'Remove from kit & sequencer';
      remove.addEventListener('click', function () {
        // The row and its kit pad are the same thing — remove both.
        const padId = audioEngine.getPadForTrack(track.id);
        if (padId && padBank) {
          const pi = padBank.findIndex(function (p) { return p.id === padId; });
          if (pi !== -1) { padBank.splice(pi, 1); savePadBank(); }
        }
        Jam.removeTrack(track.id);
        renderLibrary();
      });
      row.appendChild(remove);

      block.appendChild(row);

      // ----- advanced per-step lanes: PITCH · VEL · GATE · FX -----
      const adv = document.createElement('div');
      adv.className = 'track-adv';

      // FX-type picker — which insert effect this track's FX lane drives. Each
      // effect owns a colour (matching the XY pad zones); the FX lane repaints in
      // that colour + names the effect, so a step's FX is unmistakable.
      const FX_META = {
        filter: { label: 'Filter', color: '#2F5DE0' },
        drive:  { label: 'Drive',  color: '#E67E22' },
        crush:  { label: 'Crush',  color: '#E0A32E' },
        delay:  { label: 'Echo',   color: '#3FA34D' },
        reverb: { label: 'Verb',   color: '#7C5CFF' },
      };
      const fxOrder = ['filter', 'drive', 'crush', 'delay', 'reverb'];
      let curFxType = 'filter';
      const fxBtns = {};
      // Same label-column structure as the lanes, so the buttons line up with the
      // step grid instead of floating out of alignment.
      const fxPick = document.createElement('div');
      fxPick.className = 'pitch-lane adv-fxpick';
      const fxPickIco = document.createElement('div');
      fxPickIco.className = 'pitch-lane-ico';
      fxPickIco.textContent = 'FX';
      fxPick.appendChild(fxPickIco);
        
      const fxPickTxt = document.createElement('div');
      fxPickTxt.className = 'pitch-lane-txt';
      fxPickTxt.textContent = ' drives';
      fxPick.appendChild(fxPickTxt);
      const fxBtnWrap = document.createElement('div');
      fxBtnWrap.className = 'adv-fxbtns';
      fxOrder.forEach(function (k) {
        const b = document.createElement('button');
        b.className = 'adv-fxbtn' + (k === curFxType ? ' active' : '');
        b.textContent = FX_META[k].label;
        b.style.setProperty('--fxc', FX_META[k].color);
        b.addEventListener('click', function () { applyFxVisual(k); });
        fxBtns[k] = b;
        fxBtnWrap.appendChild(b);
      });
      fxPick.appendChild(fxBtnWrap);

      // Stamp the little pitch badge onto a step cell (pitch lane only).
      function setPitchStepBadge(i, p) {
        const sp = stepCells[i].querySelector('.step-pitch');
        sp.textContent = p === 0 ? '' : (p > 0 ? '+' + p : '' + p);
        stepCells[i].classList.toggle('tuned', p !== 0);
      }

      // Generic draggable lane. Drag a cell up/down, scroll, or double / right-click
      // to reset. Cells only show a value when they deviate from default, keeping
      // the lane visually quiet.
      const laneSetters = {};
      const laneEls = {};
      function buildLane(spec) {
        const lane = document.createElement('div');
        lane.className = 'pitch-lane';
        const labIco = document.createElement('div');
        labIco.className = 'pitch-lane-ico';
        labIco.textContent = spec.label.substring(0, 3);
        lane.appendChild(labIco);
          
        const labTxt = document.createElement('div');
        labTxt.className = 'pitch-lane-txt';
        labTxt.textContent = spec.label.substring(3);
        lane.appendChild(labTxt);
        const wrap = document.createElement('div');
        wrap.className = 'pitch-cells';
        const cells = [];
        function setDisplay(i, v) {
          const c = cells[i];
          c.textContent = spec.fmt(v);
          c.classList.toggle('nz', spec.nz(v));
          c.title = 'Step ' + (i + 1) + ' ' + spec.label.toLowerCase() + ' ' + spec.fmt(v) + (spec.unitLabel || '');
          if (spec.kind === 'pitch') setPitchStepBadge(i, v);
        }
        function clamp(v) { return Math.max(spec.min, Math.min(spec.max, spec.round ? Math.round(v) : v)); }
        for (let i = 0; i < audioEngine.STEP_COUNT; i++) {
          const pc = document.createElement('div');
          pc.className = 'pitch-cell';
          if (i % 4 === 0) pc.classList.add('beat-start');
          if (i >= audioEngine.getPatternLen()) pc.classList.add('pitch-cell-hidden');
          (function (i) {
            pc.addEventListener('pointerdown', function (e) {
              e.preventDefault();
              pc.setPointerCapture(e.pointerId);
              const startY = e.clientY;
              const startVal = spec.get(track.id, i);
              function move(ev) {
                spec.set(track.id, i, clamp(startVal + ((startY - ev.clientY) / spec.px) * spec.unit));
              }
              function up() { pc.removeEventListener('pointermove', move); pc.removeEventListener('pointerup', up); }
              pc.addEventListener('pointermove', move);
              pc.addEventListener('pointerup', up);
            });
            pc.addEventListener('wheel', function (e) {
              e.preventDefault();
              spec.set(track.id, i, clamp(spec.get(track.id, i) + (e.deltaY < 0 ? spec.wheel : -spec.wheel)));
            }, { passive: false });
            // double-click / right-click INITIALISE this step's parameter
            pc.addEventListener('dblclick', function () { spec.set(track.id, i, spec.reset); });
            pc.addEventListener('contextmenu', function (e) { e.preventDefault(); spec.set(track.id, i, spec.reset); });
          })(i);
          cells.push(pc);
          wrap.appendChild(pc);
        }
        lane.appendChild(wrap);
        adv.appendChild(lane);
        laneSetters[spec.kind] = setDisplay;
        laneEls[spec.kind] = { lane: lane, label: labTxt };
        for (let i = 0; i < audioEngine.STEP_COUNT; i++) setDisplay(i, spec.get(track.id, i));
      }

      adv.appendChild(fxPick);
      buildLane({ kind: 'pitch', label: 'Pitch', get: audioEngine.getStepPitch, set: Jam.setStepPitch,
                  min: -12, max: 12, unit: 1, px: 6, wheel: 1, reset: 0, round: true, unitLabel: ' st',
                  fmt: function (v) { return v === 0 ? '0' : (v > 0 ? '+' + v : '' + v); }, nz: function (v) { return v !== 0; } });
      buildLane({ kind: 'vel', label: 'Vel', get: audioEngine.getStepVel, set: Jam.setStepVel,
                  min: 0, max: 1, unit: 0.01, px: 1.5, wheel: 0.05, reset: 1, round: false, unitLabel: '%',
                  fmt: function (v) { return String(Math.round(v * 100)); }, nz: function (v) { return v < 0.995; } });
      buildLane({ kind: 'len', label: 'Gate', get: audioEngine.getStepLen, set: Jam.setStepLen,
                  min: 1, max: 16, unit: 1, px: 8, wheel: 1, reset: 1, round: true, unitLabel: '',
                  fmt: function (v) { return String(v); }, nz: function (v) { return v > 1; } });
                  
      fxOrder.forEach(function (k) {
        buildLane({ kind: 'fx_' + k, label: 'FX · ' + FX_META[k].label, 
                    get: function(tid, i) { return audioEngine.getStepFx(tid, k, i); }, 
                    set: function(tid, i, v) { Jam.setStepFx(tid, k, i, v); },
                    min: 0, max: 1, unit: 0.01, px: 1.5, wheel: 0.05, reset: 0, round: false, unitLabel: '%',
                    fmt: function (v) { return String(Math.round(v * 100)); }, nz: function (v) { return v > 0.005; } });
        laneEls['fx_' + k].lane.classList.add('fx-lane');
        laneEls['fx_' + k].lane.style.setProperty('--fx-col', FX_META[k].color);
        laneEls['fx_' + k].lane.style.display = 'none'; // hidden by default
      });
      
      block.appendChild(adv);

      // Repaint the FX lane in the chosen effect's colour + name it, and light the
      // matching picker button — so you always know which effect the FX lane rides.
      function applyFxVisual(t) {
        curFxType = t;
        Object.keys(fxBtns).forEach(function (k) { 
          fxBtns[k].classList.toggle('active', k === t); 
          if (laneEls['fx_' + k]) {
            laneEls['fx_' + k].lane.style.display = (k === t) ? 'flex' : 'none';
          }
        });
      }
      applyFxVisual(curFxType);

      // Register this row's DOM so single-cell Jam events can update it in place.
      trackDom[track.id] = {
        stepCells: stepCells, muteBtn: mute,
        setPitchDisplay: function (i, p) { if (laneSetters.pitch) laneSetters.pitch(i, p); },
        setLane: function (kind, i, v) { if (laneSetters[kind]) laneSetters[kind](i, v); }
      };

      container.appendChild(block);
    });

    renderTrackBar();  // the TR buttons mirror the track list
    applyTrackFocus(); // restore the focused-row highlight after a rebuild
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
      if (confirm('Are you sure you want to clear the sequencer?')) {
        Jam.clearAll();
      }
    });

    // Flip layout: rotate individual modules (panels) so they can be viewed in landscape while scrolling physically up/down
    let currentRotation = 0;
    const deck = document.querySelector('.deck');
    
    const rotObserver = new ResizeObserver(entries => {
      const rot = parseInt(document.body.getAttribute('data-rotation') || '0', 10);
      const isLandscape = rot === 90 || rot === 270;
      for (let entry of entries) {
        const panel = entry.target;
        const wrapper = panel.closest('.panel-rot-wrapper');
        if (!wrapper) continue;
        if (isLandscape) {
          // The sequencer runs AS LONG AS its beats so the whole pattern scrolls
          // in landscape; other modules keep their one-screenful CSS width.
          if (panel.classList.contains('p-seq')) updateFlipSeqWidth();
          wrapper.style.width = panel.offsetHeight + 'px';
          wrapper.style.height = panel.offsetWidth + 'px';
        } else {
          panel.style.width = '';
          wrapper.style.width = '';
          wrapper.style.height = '';
        }
      }
    });
    document.querySelectorAll('.panel').forEach(p => rotObserver.observe(p));

    document.getElementById('flip-button').addEventListener('click', function () {
      let currentRotation = parseInt(document.body.getAttribute('data-rotation') || '0', 10);
      currentRotation = (currentRotation + 90) % 360;
      document.body.setAttribute('data-rotation', currentRotation);
      
      const rotLayer = document.getElementById('rot-layer');
      if (rotLayer) {
        rotLayer.setAttribute('data-rotation', currentRotation);
      }
      
      const isLandscape = currentRotation === 90 || currentRotation === 270;
      if (isLandscape) {
        deck.classList.add('deck-flip');
      } else {
        deck.classList.remove('deck-flip');
      }

      updateFlipSeqWidth();   // size the sequencer to its beats (or reset)
      Jam.triggerResize();
    });

    // Side Drawer logic
    const drawer = document.getElementById('side-drawer');
    const hamburgerBtn = document.getElementById('hamburger-button');
    const closeDrawerBtn = document.getElementById('close-drawer');
    if (hamburgerBtn && drawer) {
      hamburgerBtn.addEventListener('click', () => drawer.classList.add('open'));
    }
    if (closeDrawerBtn && drawer) {
      closeDrawerBtn.addEventListener('click', () => drawer.classList.remove('open'));
    }

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

  // State tracking for slot animations
  let lastBpm = 120, lastSwing = 0, lastKey = 0;
  const slotTimers = {};

  function updateSlot(elId, newHtml, isIncreasing) {
    const el = document.getElementById(elId);
    if (!el || el.getAttribute('data-val') === newHtml) return;
    el.setAttribute('data-val', newHtml);
    
    // If an animation is already running, just seamlessly update the incoming value!
    if (el.children.length === 2) {
      el.lastElementChild.innerHTML = newHtml;
      return;
    }
    
    if (slotTimers[elId]) {
      clearTimeout(slotTimers[elId]);
      slotTimers[elId] = null;
    }
    
    // First setup
    if (!el.firstElementChild || !el.firstElementChild.classList.contains('slot-wrap')) {
      el.innerHTML = `<div class="slot-wrap" style="display:inline-flex; width:100%; justify-content:center;">${newHtml}</div>`;
      el.style.position = 'relative';
      el.style.overflow = 'hidden';
      return;
    }
    
    const oldWrap = el.firstElementChild;
    const newWrap = document.createElement('div');
    newWrap.className = 'slot-wrap';
    newWrap.style.display = 'inline-flex';
    newWrap.style.justifyContent = 'center';
    newWrap.innerHTML = newHtml;
    
    newWrap.style.position = 'absolute';
    newWrap.style.left = '0';
    newWrap.style.width = '100%';
    newWrap.style.top = isIncreasing ? '100%' : '-100%';
    
    el.appendChild(newWrap);
    
    void el.offsetWidth; // force reflow
    
    const easing = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // Satisfying bounce
    oldWrap.style.transition = `transform 0.35s ${easing}`;
    newWrap.style.transition = `top 0.35s ${easing}`;
    
    oldWrap.style.transform = isIncreasing ? 'translateY(-100%)' : 'translateY(100%)';
    newWrap.style.top = '0';
    
    slotTimers[elId] = setTimeout(() => {
      slotTimers[elId] = null;
      if (oldWrap.parentNode) oldWrap.parentNode.removeChild(oldWrap);
      newWrap.style.position = 'relative';
      newWrap.style.top = 'auto';
    }, 350);
  }

  // Repaint every tempo readout (top-bar chip + panel chips) from the engine,
  // and retime the metronome. Called on every bpm/swing/key event.
  function refreshTempoDisplays() {
    const bpm = audioEngine.getBpm();
    const swing = Math.round(audioEngine.getSwing() * 100);
    const key = audioEngine.getKeyTranspose();

    // LCD segment faces, exactly like the reference ("125" reads as "|25").
    const bpmHtml = SEG(bpm, 13);
    const bpmBigHtml = SEG(bpm, 22);
    const swingHtml = SEG((swing > 0 ? '+' : '') + swing, 18);
    const keyHtml = SEG(NOTES_SEG[((key % 12) + 12) % 12], 18);

    updateSlot('bpm-value', bpmHtml, bpm >= lastBpm);
    updateSlot('bpm-value-big', bpmBigHtml, bpm >= lastBpm);
    updateSlot('swing-value', swingHtml, swing >= lastSwing);
    updateSlot('key-value', keyHtml, key >= lastKey);

    lastBpm = bpm;
    lastSwing = swing;
    lastKey = key;

    // Drive the beat-pulse timing on the panel.
    const panel = document.getElementById('tempo-panel');
    if (panel) panel.style.setProperty('--tick', (60 / bpm).toFixed(3) + 's');
    const knurl = document.getElementById('knurl-needle');
    if (knurl) knurl.style.setProperty('--tilt', (((120 - bpm) / 60) * 22).toFixed(1) + 'deg');
  }

  // Vertical drag-to-adjust for the tempo chips (with wheel support). A press
  // that never moves counts as a tap and fires onTap instead.
  function attachDragValue(el, pxPerStep, get, apply, onTap, resetVal) {
    if (!el) return; // element may not exist in every layout
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
    // Double-click initialises the value back to its default.
    if (resetVal != null) el.addEventListener('dblclick', function () { apply(resetVal); });
  }

  function setupTopBar() {
    const tempoPanel = document.getElementById('tempo-panel');
    const guidePanel = document.getElementById('guide-panel');
    const jamPanel = document.getElementById('jam-panel');
    const profilePanel = document.getElementById('profile-panel');

    // Only one popover at a time.
    function toggle(panel) {
      if (!panel) return;
      const wasOpen = panel.classList.contains('open');
      [tempoPanel, guidePanel, jamPanel, profilePanel].forEach(function (p) {
        if (p) p.classList.remove('open');
      });
      if (!wasOpen) panel.classList.add('open');
    }

    const tempoBtn = document.getElementById('tempo-button');
    const guideBtn = document.getElementById('guide-button');
    const menuBtn = document.getElementById('menu-button');
    const jamBtn = document.getElementById('jam-button');

    if (tempoBtn) tempoBtn.addEventListener('click', function () { toggle(tempoPanel); });
    if (guideBtn) guideBtn.addEventListener('click', function () { toggle(guidePanel); });
    if (menuBtn) menuBtn.addEventListener('click', function () { toggle(profilePanel); });
    if (jamBtn) jamBtn.addEventListener('click', function () { toggle(jamPanel); });

    document.querySelectorAll('.guide-num[data-seg]').forEach(function (el) {
      el.textContent = el.getAttribute('data-seg');
    });

    // BPM: drag/scroll the top-bar chip (tap opens the panel), drag the big
    // chip, the metronome plate, or the mustard fine-adjust plate.
    function getBpm() { return audioEngine.getBpm(); }
    function setBpm(v) { Jam.setBpm(v); }
    attachDragValue(document.getElementById('bpm-chip'), 4, getBpm, setBpm,
      function () { toggle(tempoPanel); }, 120);
    attachDragValue(document.getElementById('chip-bpm'), 4, getBpm, setBpm, null, 120);
    attachDragValue(document.getElementById('metro-plate'), 3, getBpm, setBpm, null, 120);
    attachDragValue(document.getElementById('knurl-plate'), 7, getBpm, setBpm, null, 120);

    // SWING (0..80, percent) and KEY (−12..+12 semitones). Double-click resets.
    attachDragValue(document.getElementById('chip-swing'), 5,
      function () { return Math.round(audioEngine.getSwing() * 100); },
      function (v) { Jam.setSwing(Math.max(0, Math.min(80, v)) / 100); }, null, 0);
    attachDragValue(document.getElementById('chip-key'), 14,
      function () { return audioEngine.getKeyTranspose(); },
      function (v) { Jam.setKey(v); }, null, 0);

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
