// audioEngine.js
// -----------------------------------------------------------------------------
// Everything that makes sound. Built on Tone.js (loaded as the global `Tone`
// in index.html). It does three things:
//   1. Loads every sample in the map into a Tone.Player (one player per sample).
//   2. Owns the step sequencer: a list of tracks, each with 16 on/off steps.
//   3. Drives playback with Tone.Transport + a single Tone.Sequence loop.
//
// A "track" is one row in the sequencer:
//   { id, objectType, steps: [16 booleans], muted, volume }
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
  const envs = {};          // objectType -> Tone.AmplitudeEnvelope (real ADSR)
  const settings = {};      // objectType -> { attack, decay, sustain, release, cents }
  const tracks = [];        // array of track objects (see header)
  let nextTrackId = 1;      // simple incrementing id
  let sequence = null;      // the Tone.Sequence driving the loop
  let stepCallback = null;  // optional UI callback fired on every step
  let audioStarted = false; // has the AudioContext been unlocked by a gesture?
  let recorder = null;      // Tone.Recorder used by the Export button
  let exporting = false;    // are we currently capturing audio?
  let analyser = null;      // Tone.Analyser tapping the master (oscilloscope)
  let sampleLoadedCb = null;// optional UI callback fired when a sample finishes loading
  let keyTranspose = 0;     // global KEY transpose, semitones (-12..+12)

  // ---- setup -----------------------------------------------------------------

  // Load every sample referenced in the map into its own Tone.Player.
  // Missing WAVs don't crash anything — that player just stays "not loaded"
  // and is skipped at playback time (the user is told to drop WAVs in /samples).
  async function init() {
    const map = library.getAllSampleInfo();

    Object.keys(map).forEach(function (objectType) {
      // encodeURIComponent so filenames with '#' (e.g. "..._D#.wav") aren't cut
      // at the fragment marker when fetched as a URL.
      const url = 'samples/' + encodeURIComponent(map[objectType].sampleFile);

      // Per-sample defaults. The envelope basically passes the sample through
      // (instant attack, full sustain) until the user shapes it on the card.
      settings[objectType] = { attack: 0.005, decay: 0.20, sustain: 1.0, release: 0.30, cents: 0 };

      // player -> amplitude envelope -> destination, so ADSR actually shapes it.
      const env = new Tone.AmplitudeEnvelope({
        attack: settings[objectType].attack,
        decay: settings[objectType].decay,
        sustain: settings[objectType].sustain,
        release: settings[objectType].release,
      }).toDestination();
      envs[objectType] = env;

      players[objectType] = new Tone.Player({
        url: url,
        onload: function () {
          console.log('[audioEngine] loaded', url);
          // Let the UI know it can now draw this sample's waveform.
          if (sampleLoadedCb) sampleLoadedCb(objectType);
        },
        onerror: function () {
          console.warn('[audioEngine] missing sample:', url,
            '- drop the WAV into /samples to hear it');
        },
      }).connect(env);
    });

    // Tap the master output for the sequencer oscilloscope. The analyser only
    // reads the signal (it isn't routed onward), so it never affects playback.
    analyser = new Tone.Analyser('waveform', 1024);
    Tone.getDestination().connect(analyser);

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
          // Each step can carry its own pitch offset (semitones -> cents).
          const extraCents = (track.stepPitch[step] || 0) * 100;
          triggerSample(track.objectType, time, extraCents, track.volume);
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

  function centsToRate(cents) {
    return Math.pow(2, cents / 1200);
  }

  // Fire a sample once with its current ADSR + tune, plus any extra pitch
  // (cents) for this hit. `time` is optional (omit for "now", e.g. preview).
  // `gain` (0..1) is the track's mixer level; omitted = full volume.
  function triggerSample(objectType, time, extraCents, gain) {
    const key = library.resolveKey(objectType);
    const player = players[key];
    const env = envs[key];
    const s = settings[key];
    if (!player || !player.loaded) return;

    // Use an explicit time so rapid retriggers always advance on the clock.
    const t = (time === undefined) ? Tone.now() : time;

    // KEY transpose shifts every hit globally, on top of tune + step pitch.
    const cents = (s ? s.cents : 0) + (extraCents || 0) + keyTranspose * 100;
    player.playbackRate = centsToRate(cents);
    player.volume.value = Tone.gainToDb(gain == null ? 1 : Math.max(0.0001, gain));

    // Hold the envelope open for the (rate-adjusted) length of the sample.
    const dur = Math.max(0.02, (player.buffer.duration || 0.2) / player.playbackRate);
    // triggerAttackRelease retriggers cleanly on its own (it cancels and holds
    // internally), so the ADSR re-shapes every hit — no manual cancel needed.
    if (env) env.triggerAttackRelease(dur, t);

    // Stop any current playback then start fresh. stop() throws if not playing,
    // start() throws if already started — both are fine to ignore.
    try { player.stop(t); } catch (e) {}
    try { player.start(t); } catch (e) {}
  }

  // ---- public actions --------------------------------------------------------

  // Play a single sample once (used by the library preview button).
  async function previewSample(objectType) {
    await ensureAudioStarted();
    const key = library.resolveKey(objectType);
    if (players[key] && players[key].loaded) {
      triggerSample(key);
      console.log('[audioEngine] preview', key);
    } else {
      console.warn('[audioEngine] cannot preview', key, '- sample not loaded');
    }
  }

  // Add a new sequencer row for the given sample. Returns its track id.
  // displayName is stored on the track so a pattern snapshot is self-contained —
  // a jam peer can render/label the row without any local lookup.
  function addTrackToSequencer(objectType, displayName) {
    const key = library.resolveKey(objectType);
    const info = library.getSampleInfo(key);
    const track = {
      id: nextTrackId++,
      objectType: key,
      displayName: displayName || (info && info.displayName) || key,
      steps: new Array(STEP_COUNT).fill(false),
      stepPitch: new Array(STEP_COUNT).fill(0), // per-step pitch offset, semitones
      muted: false,
      volume: 0.8, // mixer level 0..1 (0.8 ≈ -2 dB leaves headroom by default)
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

  // Set one step explicitly on/off. Networked edits use this (not toggle) so an
  // action is idempotent no matter what each peer's local state was.
  function setStep(trackId, stepIndex, on) {
    const track = findTrack(trackId);
    if (!track) return false;
    track.steps[stepIndex] = !!on;
    return track.steps[stepIndex];
  }

  function setTrackMute(trackId, muted) {
    const track = findTrack(trackId);
    if (!track) return;
    track.muted = muted;
    console.log('[audioEngine] track', trackId, 'muted =', muted);
  }

  // Mixer level for one track (the crayon bars). Clamped 0..1, returns the
  // value used so networked edits converge on the same number.
  function setTrackVolume(trackId, volume) {
    const track = findTrack(trackId);
    if (!track) return 0;
    track.volume = Math.max(0, Math.min(1, +volume || 0));
    return track.volume;
  }

  function getTrackVolume(trackId) {
    const track = findTrack(trackId);
    return track ? (track.volume == null ? 0.8 : track.volume) : 0.8;
  }

  // Swing: delays every off-beat 16th. 0 = straight, 1 = full triplet feel.
  function setSwing(amount) {
    const v = Math.max(0, Math.min(0.8, +amount || 0));
    const transport = Tone.getTransport();
    transport.swing = v;
    transport.swingSubdivision = '16n';
    return v;
  }

  function getSwing() {
    return Tone.getTransport().swing || 0;
  }

  // KEY: transpose the whole kit by semitones (applied at trigger time).
  function setKeyTranspose(semitones) {
    keyTranspose = Math.max(-12, Math.min(12, Math.round(semitones) || 0));
    return keyTranspose;
  }

  function getKeyTranspose() {
    return keyTranspose;
  }

  // Set the master tempo, clamped to the 60-180 range. Returns the value used.
  function setMasterBpm(bpm) {
    const clamped = Math.max(60, Math.min(180, Math.round(bpm)));
    Tone.getTransport().bpm.value = clamped;
    console.log('[audioEngine] BPM =', clamped);
    return clamped;
  }

  function getBpm() {
    return Math.round(Tone.getTransport().bpm.value);
  }

  function isPlaying() {
    return Tone.getTransport().state === 'started';
  }

  // Unlock the AudioContext from a user gesture (Host/Join buttons call this so a
  // client can start making sound the moment the host presses play).
  async function unlock() {
    await ensureAudioStarted();
  }

  // Master output mute. In a jam session only ONE machine is the "output" — all
  // others run the same transport (so playheads stay in step) but stay silent.
  function setMasterMute(muted) {
    Tone.getDestination().mute = !!muted;
    console.log('[audioEngine] master mute =', !!muted);
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

  // Register a callback(objectType) fired whenever a sample finishes loading,
  // so the UI can (re)draw that sample's waveform once its buffer is ready.
  function onSampleLoaded(callback) {
    sampleLoadedCb = callback;
  }

  // ---- per-sample sound shaping (driven by the library card controls) --------

  // Current { attack, decay, sustain, release, cents } for a sample (a copy).
  function getSampleSettings(objectType) {
    const s = settings[library.resolveKey(objectType)];
    return s ? Object.assign({}, s) : null;
  }

  // Set one ADSR field (attack/decay/sustain/release) and apply it live.
  function setSampleEnv(objectType, field, value) {
    const key = library.resolveKey(objectType);
    const s = settings[key], env = envs[key];
    if (!s || !env) return;
    s[field] = value;
    env[field] = value;
  }

  // Tune the sample, clamped to ±4800 cents (±48 semitones).
  function setSampleCents(objectType, cents) {
    const key = library.resolveKey(objectType);
    if (!settings[key]) return;
    settings[key].cents = Math.max(-4800, Math.min(4800, Math.round(cents)));
    return settings[key].cents;
  }

  // ---- per-step pitch (sequencer) --------------------------------------------

  function setStepPitch(trackId, stepIndex, semitones) {
    const track = findTrack(trackId);
    if (!track) return 0;
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)));
    track.stepPitch[stepIndex] = clamped;
    return clamped;
  }

  function getStepPitch(trackId, stepIndex) {
    const track = findTrack(trackId);
    return track ? (track.stepPitch[stepIndex] || 0) : 0;
  }

  function getStepOn(trackId, stepIndex) {
    const track = findTrack(trackId);
    return track ? !!track.steps[stepIndex] : false;
  }

  // Return the raw mono sample data (Float32Array) for a sample, or null if it
  // isn't loaded yet. Used to draw the static waveform on library cards/pads.
  function getWaveform(objectType) {
    const key = library.resolveKey(objectType);
    const player = players[key];
    if (player && player.loaded && player.buffer) {
      const buf = player.buffer.get(); // underlying Web Audio AudioBuffer
      if (buf && buf.length) return buf.getChannelData(0);
    }
    return null;
  }

  // The master-output analyser. Call analyser.getValue() each frame to read the
  // current waveform (Float32Array in [-1, 1]) for the live oscilloscope.
  function getAnalyser() {
    return analyser;
  }

  // Turn every step of every track off (the "Clear" button).
  function clearAllSteps() {
    tracks.forEach(function (track) {
      track.steps.fill(false);
    });
    console.log('[audioEngine] cleared all steps');
  }

  // ---- shared-pattern snapshot (jam sessions) --------------------------------
  // A snapshot is the ENTIRE sequencer state, serialisable and self-contained, so
  // a jam host can hand the whole "project" to any peer in a single message.

  function getTracks() {
    return tracks.map(function (t) {
      return {
        id: t.id,
        objectType: t.objectType,
        displayName: t.displayName,
        steps: t.steps.slice(),
        stepPitch: t.stepPitch.slice(),
        muted: t.muted,
        volume: t.volume == null ? 0.8 : t.volume,
      };
    });
  }

  function getPatternSnapshot() {
    return {
      tracks: getTracks(),
      bpm: getBpm(),
      swing: getSwing(),
      key: keyTranspose,
      nextTrackId: nextTrackId,
    };
  }

  // Replace the whole sequencer state with an incoming snapshot. The Tone.Sequence
  // reads the module-level `tracks` array live, so we mutate it IN PLACE (never
  // reassign) to keep the running loop pointed at the new data.
  function applyPatternSnapshot(snap) {
    if (!snap || !Array.isArray(snap.tracks)) return;

    tracks.length = 0;
    snap.tracks.forEach(function (t) {
      const steps = new Array(STEP_COUNT).fill(false);
      const pitch = new Array(STEP_COUNT).fill(0);
      (t.steps || []).forEach(function (v, i) { if (i < STEP_COUNT) steps[i] = !!v; });
      (t.stepPitch || []).forEach(function (v, i) { if (i < STEP_COUNT) pitch[i] = v || 0; });
      tracks.push({
        id: t.id,
        objectType: t.objectType,
        displayName: t.displayName || t.objectType,
        steps: steps,
        stepPitch: pitch,
        muted: !!t.muted,
        volume: t.volume == null ? 0.8 : Math.max(0, Math.min(1, +t.volume || 0)),
      });
    });

    // Keep id generation ahead of anything we've seen so a future host-side add
    // never collides with an existing id.
    let maxId = 0;
    tracks.forEach(function (t) { if (t.id > maxId) maxId = t.id; });
    nextTrackId = Math.max(nextTrackId, snap.nextTrackId || 0, maxId + 1);

    if (typeof snap.bpm === 'number') setMasterBpm(snap.bpm);
    if (typeof snap.swing === 'number') setSwing(snap.swing);
    if (typeof snap.key === 'number') setKeyTranspose(snap.key);
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
    Object.keys(envs).forEach(function (key) { envs[key].connect(recorder); });
    recorder.start();

    // Make sure the loop is actually running while we capture it.
    const transport = Tone.getTransport();
    const wasPlaying = transport.state === 'started';
    if (!wasPlaying) transport.start();

    // One bar (4 beats) at the current BPM, plus a short tail for decays.
    const barMs = (60 / transport.bpm.value) * 4 * 1000;
    await new Promise(function (r) { setTimeout(r, barMs + 150); });

    const blob = await recorder.stop();
    Object.keys(envs).forEach(function (key) {
      try { envs[key].disconnect(recorder); } catch (e) {}
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
    setStep: setStep,
    setTrackMute: setTrackMute,
    setTrackVolume: setTrackVolume,
    getTrackVolume: getTrackVolume,
    setSwing: setSwing,
    getSwing: getSwing,
    setKeyTranspose: setKeyTranspose,
    getKeyTranspose: getKeyTranspose,
    setMasterBpm: setMasterBpm,
    getBpm: getBpm,
    isPlaying: isPlaying,
    unlock: unlock,
    setMasterMute: setMasterMute,
    play: play,
    stop: stop,
    getTracks: getTracks,
    getPatternSnapshot: getPatternSnapshot,
    applyPatternSnapshot: applyPatternSnapshot,
    onStep: onStep,
    onSampleLoaded: onSampleLoaded,
    getWaveform: getWaveform,
    getAnalyser: getAnalyser,
    getSampleSettings: getSampleSettings,
    setSampleEnv: setSampleEnv,
    setSampleCents: setSampleCents,
    setStepPitch: setStepPitch,
    getStepPitch: getStepPitch,
    getStepOn: getStepOn,
    clearAllSteps: clearAllSteps,
    exportLoop: exportLoop,
    STEP_COUNT: STEP_COUNT,
  };
})();

window.audioEngine = audioEngine;
