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
    await audioEngine.init();

    setupTabs();
    setupScanTab();
    setupSequencerTransport();
    renderLibrary();
    renderSequencer();

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

  function setupScanTab() {
    const select = document.getElementById('scan-select');
    const map = library.getAllSampleInfo();

    // One dropdown option per real object (skip the "_default" fallback entry).
    Object.keys(map).forEach(function (objectType) {
      if (objectType === '_default') return;
      const option = document.createElement('option');
      option.value = objectType;
      option.textContent = objectType + ' (' + map[objectType].displayName + ')';
      select.appendChild(option);
    });

    // An extra option that isn't in the map, to demo the "Mystery Hit" fallback.
    const mystery = document.createElement('option');
    mystery.value = 'doorknob';
    mystery.textContent = 'doorknob (unknown object -> Mystery Hit)';
    select.appendChild(mystery);

    document.getElementById('scan-button').addEventListener('click', function () {
      // This is the seam the real camera module replaces: instead of reading a
      // dropdown, the vision code will call cameraStub.simulateScan(detected).
      cameraStub.simulateScan(select.value);
    });
  }

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

  // ---- library tab -----------------------------------------------------------

  function renderLibrary() {
    const grid = document.getElementById('library-grid');
    grid.innerHTML = '';
    const map = library.getAllSampleInfo();

    Object.keys(map).forEach(function (objectType) {
      const info = map[objectType];
      const unlocked = library.isUnlocked(objectType);
      const card = document.createElement('div');
      card.className = 'card ' + (unlocked ? 'unlocked' : 'locked');

      if (unlocked) {
        // Name + preview + add-to-sequencer.
        const title = document.createElement('div');
        title.className = 'card-name';
        title.textContent = info.displayName;

        const sub = document.createElement('div');
        sub.className = 'card-sub';
        sub.textContent = objectType;

        const preview = document.createElement('button');
        preview.textContent = '▶ Preview';
        preview.addEventListener('click', function () {
          audioEngine.previewSample(objectType);
        });

        const add = document.createElement('button');
        add.textContent = '+ Add to sequencer';
        add.addEventListener('click', function () {
          addTrack(objectType, info.displayName);
        });

        card.appendChild(title);
        card.appendChild(sub);
        card.appendChild(preview);
        card.appendChild(add);
      } else {
        // Silhouette: show the player there's something still out there to find.
        const q = document.createElement('div');
        q.className = 'card-locked-mark';
        q.textContent = '?';
        const lbl = document.createElement('div');
        lbl.className = 'card-sub';
        lbl.textContent = 'Locked';
        card.appendChild(q);
        card.appendChild(lbl);
      }

      grid.appendChild(card);
    });
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
      const row = document.createElement('div');
      row.className = 'track-row';

      // Label.
      const label = document.createElement('div');
      label.className = 'track-label';
      label.textContent = track.displayName;
      row.appendChild(label);

      // 16 step cells.
      const steps = document.createElement('div');
      steps.className = 'track-steps';
      for (let i = 0; i < audioEngine.STEP_COUNT; i++) {
        const cell = document.createElement('button');
        cell.className = 'step';
        // Visually group every 4 steps (the four beats of the bar).
        if (i % 4 === 0) cell.classList.add('beat-start');
        cell.setAttribute('data-step', i);
        cell.addEventListener('click', function () {
          const on = audioEngine.toggleStep(track.id, i);
          cell.classList.toggle('on', on);
        });
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

      container.appendChild(row);
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

    const bpm = document.getElementById('bpm-slider');
    const bpmValue = document.getElementById('bpm-value');
    bpm.addEventListener('input', function () {
      const used = audioEngine.setMasterBpm(parseInt(bpm.value, 10));
      bpmValue.textContent = used;
    });

    // Reveal modal close button.
    document.getElementById('reveal-close').addEventListener('click', hideReveal);
  }

  return { init: init };
})();

window.ui = ui;

// Kick everything off. These scripts live at the end of <body>, so the tab
// markup above already exists by the time this runs.
ui.init();
