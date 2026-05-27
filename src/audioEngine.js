// audioEngine.js
// -----------------------------------------------------------------------------
// Everything that makes sound. Built on Tone.js (loaded as the global `Tone`
// in index.html). It does three things:
//   1. Loads every sample in the map into a Tone.Player (one player per sample).
//   2. Owns the step sequencer: a list of tracks, each with 16 on/off steps.
//   3. Drives playback with Tone.Transport + a single Tone.Sequence loop.
//
// A "track" is one row in the sequencer:
//   { id, objectType, steps: [16 booleans], muted }
//
// Public API (attached to window):
//   audioEngine.init()                       -> async; load all samples + build loop
//   audioEngine.previewSample(objectType)    -> play a sample once
//   audioEngine.addTrackToSequencer(type)    -> add a row, returns trackId
//   audioEngine.removeTrack(trackId)
//   audioEngine.toggleStep(trackId, stepIdx) -> flip a step, returns new state
//   audioEngine.setTrackMute(trackId, muted)
//   audioEngine.setMasterBpm(bpm)            -> clamps to 60-180, returns clamped
//   audioEngine.play() / audioEngine.stop()
//   audioEngine.onStep(callback)             -> called each step (for UI playhead)
// -----------------------------------------------------------------------------

const audioEngine = (function () {
  const STEP_COUNT = 16; // one bar of 16th notes

  const players = {};       // objectType -> Tone.Player
  const tracks = [];        // array of track objects (see header)
  let nextTrackId = 1;      // simple incrementing id
  let sequence = null;      // the Tone.Sequence driving the loop
  let stepCallback = null;  // optional UI callback fired on every step
  let audioStarted = false; // has the AudioContext been unlocked by a gesture?
  let recorder = null;      // Tone.Recorder used by the Export button
  let exporting = false;    // are we currently capturing audio?

  // ---- setup -----------------------------------------------------------------

  // Load every sample referenced in the map into its own Tone.Player.
  // Missing WAVs don't crash anything — that player just stays "not loaded"
  // and is skipped at playback time (the user is told to drop WAVs in /samples).
  async function init() {
    const map = library.getAllSampleInfo();

    Object.keys(map).forEach(function (objectType) {
      const url = 'samples/' + map[objectType].sampleFile;
      players[objectType] = new Tone.Player({
        url: url,
        onload: function () { console.log('[audioEngine] loaded', url); },
        onerror: function () {
          console.warn('[audioEngine] missing sample:', url,
            '- drop the WAV into /samples to hear it');
        },
      }).toDestination();
    });

    buildSequence();
    Tone.getTransport().bpm.value = 120;

    console.log('[audioEngine] init done. players:', Object.keys(players).length);
  }

  // Build the 16-step loop. The Sequence fires its callback once per 16th note,
  // handing us the current step index (0-15). For each step we trigger every
  // un-muted track that has that step switched on.
  function buildSequence() {
    const stepIndices = [];
    for (let i = 0; i < STEP_COUNT; i++) stepIndices.push(i);

    sequence = new Tone.Sequence(
      function (time, step) {
        tracks.forEach(function (track) {
          if (track.muted) return;
          if (!track.steps[step]) return;
          const player = players[track.objectType];
          if (player && player.loaded) {
            player.start(time); // schedule precisely on the audio clock
          }
        });

        // Tell the UI which step is playing, synced to the visual frame.
        if (stepCallback && typeof Tone.getDraw === 'function') {
          Tone.getDraw().schedule(function () { stepCallback(step); }, time);
        }
      },
      stepIndices,
      '16n'
    );

    // The Sequence is tied to the Transport: it only advances while the
    // Transport is running, so start()/stop() below control playback.
    sequence.start(0);
  }

  // The browser blocks audio until the user interacts with the page. Call this
  // from anything triggered by a click (preview / play) to unlock the context.
  async function ensureAudioStarted() {
    if (!audioStarted) {
      await Tone.start();
      audioStarted = true;
      console.log('[audioEngine] AudioContext started');
    }
  }

  // ---- helpers ---------------------------------------------------------------

  function findTrack(trackId) {
    return tracks.find(function (t) { return t.id === trackId; });
  }

  // ---- public actions --------------------------------------------------------

  // Play a single sample once (used by the library preview button).
  async function previewSample(objectType) {
    await ensureAudioStarted();
    const key = library.resolveKey(objectType);
    const player = players[key];
    if (player && player.loaded) {
      player.start();
      console.log('[audioEngine] preview', key);
    } else {
      console.warn('[audioEngine] cannot preview', key, '- sample not loaded');
    }
  }

  // Add a new sequencer row for the given sample. Returns its track id.
  function addTrackToSequencer(objectType) {
    const key = library.resolveKey(objectType);
    const track = {
      id: nextTrackId++,
      objectType: key,
      steps: new Array(STEP_COUNT).fill(false),
      muted: false,
    };
    tracks.push(track);
    console.log('[audioEngine] added track', track.id, 'for', key);
    return track.id;
  }

  function removeTrack(trackId) {
    const index = tracks.findIndex(function (t) { return t.id === trackId; });
    if (index !== -1) {
      tracks.splice(index, 1);
      console.log('[audioEngine] removed track', trackId);
    }
  }

  // Flip one step on/off. Returns the new boolean so the UI can update the cell.
  function toggleStep(trackId, stepIndex) {
    const track = findTrack(trackId);
    if (!track) return false;
    track.steps[stepIndex] = !track.steps[stepIndex];
    console.log('[audioEngine] track', trackId, 'step', stepIndex, '=', track.steps[stepIndex]);
    return track.steps[stepIndex];
  }

  function setTrackMute(trackId, muted) {
    const track = findTrack(trackId);
    if (!track) return;
    track.muted = muted;
    console.log('[audioEngine] track', trackId, 'muted =', muted);
  }

  // Set the master tempo, clamped to the 60-180 range. Returns the value used.
  function setMasterBpm(bpm) {
    const clamped = Math.max(60, Math.min(180, Math.round(bpm)));
    Tone.getTransport().bpm.value = clamped;
    console.log('[audioEngine] BPM =', clamped);
    return clamped;
  }

  async function play() {
    await ensureAudioStarted();
    Tone.getTransport().start();
    console.log('[audioEngine] play');
  }

  function stop() {
    const transport = Tone.getTransport();
    transport.stop();
    transport.position = 0; // rewind to the top of the bar
    console.log('[audioEngine] stop');
  }

  // Register a callback(stepIndex) fired on every step (drives the UI playhead).
  function onStep(callback) {
    stepCallback = callback;
  }

  // Turn every step of every track off (the "Clear" button).
  function clearAllSteps() {
    tracks.forEach(function (track) {
      track.steps.fill(false);
    });
    console.log('[audioEngine] cleared all steps');
  }

  // EXPORT (the old record button): capture one bar of the beat to a file.
  // We hook a Tone.Recorder onto every player, run the transport for exactly
  // one bar at the current tempo, then write the recording to the user's
  // Downloads folder. Returns the saved file path (or null on failure).
  async function exportLoop() {
    if (exporting) return null;
    if (typeof Tone.Recorder !== 'function') {
      console.warn('[audioEngine] Tone.Recorder unavailable — cannot export audio');
      return null;
    }

    await ensureAudioStarted();
    exporting = true;

    recorder = new Tone.Recorder();
    Object.keys(players).forEach(function (key) { players[key].connect(recorder); });
    recorder.start();

    // Make sure the loop is actually running while we capture it.
    const transport = Tone.getTransport();
    const wasPlaying = transport.state === 'started';
    if (!wasPlaying) transport.start();

    // One bar (4 beats) at the current BPM, plus a short tail for decays.
    const barMs = (60 / transport.bpm.value) * 4 * 1000;
    await new Promise(function (r) { setTimeout(r, barMs + 150); });

    const blob = await recorder.stop();
    Object.keys(players).forEach(function (key) {
      try { players[key].disconnect(recorder); } catch (e) {}
    });
    recorder.dispose();
    recorder = null;
    if (!wasPlaying) transport.stop();
    exporting = false;

    // Write the blob to disk (nodeIntegration gives us fs directly).
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const buffer = Buffer.from(await blob.arrayBuffer());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(os.homedir(), 'Downloads', 'snap-it-beat-' + stamp + '.webm');
      fs.writeFileSync(dest, buffer);
      console.log('[audioEngine] exported beat to', dest);
      return dest;
    } catch (err) {
      console.error('[audioEngine] export failed to write file', err);
      return null;
    }
  }

  return {
    init: init,
    previewSample: previewSample,
    addTrackToSequencer: addTrackToSequencer,
    removeTrack: removeTrack,
    toggleStep: toggleStep,
    setTrackMute: setTrackMute,
    setMasterBpm: setMasterBpm,
    play: play,
    stop: stop,
    onStep: onStep,
    clearAllSteps: clearAllSteps,
    exportLoop: exportLoop,
    STEP_COUNT: STEP_COUNT,
  };
})();

window.audioEngine = audioEngine;
