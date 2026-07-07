// src/multiplayer/jam.js
// -----------------------------------------------------------------------------
// Jam session controller — ONE shared project, one output everywhere.
//
// The UI never talks to audioEngine directly for sequencer edits any more; it
// calls Jam.* instead. Jam decides what an edit means based on the role:
//
//   offline -> apply straight to the local engine (exactly the old behaviour)
//   host    -> apply locally (host is the authority), then broadcast to clients
//   client  -> send the edit to the host; the host applies it and echoes it to
//              EVERYONE (including the sender). Each peer applies edits only
//              when they arrive back from the host, so every machine plays the
//              same project — the host serialises all edits into one order.
//
// Two kinds of edits travel differently:
//   - granular  (step on/off, per-step pitch, mute, bpm): tiny 'action' messages
//   - structural (add/remove track, clear): the host applies them and then sends
//     the full pattern snapshot, which sidesteps track-id collisions entirely.
//
// Every machine already has every sample loaded (audioEngine.init loads the full
// map, unlocked or not), so any peer can play back any track it receives.
//
// UI events (subscribe with Jam.on):
//   'pattern'                     -> structure changed; do a full re-render
//   'step'    (trackId, i, on)    -> one cell changed
//   'pitch'   (trackId, i, val)   -> one pitch cell changed
//   'mute'    (trackId, muted)
//   'volume'  (trackId, v)        -> one mixer bar moved
//   'bpm'     (bpm) / 'swing' (v) / 'key' (semitones)
//   'transport' (playing)
//   'session' (role) / 'status' (text) / 'peers' (count)
// -----------------------------------------------------------------------------

window.Jam = (() => {

  const handlers = {};

  function on(event, cb) {
    (handlers[event] = handlers[event] || []).push(cb);
  }

  function fire(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[event] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { console.error('[Jam] handler error', e); }
    });
  }

  // ── roster / audio-output routing ───────────────────────────────────────────
  // Everyone edits, but only ONE machine actually makes sound. peers is the
  // list of machines in the session ({id, name}); 'host' is always the host's
  // id. outputId picks the speaker — every other machine master-mutes.

  let peers = [];
  let outputId = 'host';

  function machineName() {
    // A logged-in player's chosen name beats the machine's hostname.
    if (window.Profile && Profile.current && Profile.current()) return Profile.displayName();
    try { return require('os').hostname(); } catch (e) { return 'Player'; }
  }

  function myId() {
    const role = Network.role();
    if (role === 'host') return 'host';
    if (role === 'client') return Network.clientId();
    return null;
  }

  function isOutput() {
    if (Network.role() === 'offline') return true; // solo: always audible
    return outputId === myId();
  }

  // Mute/unmute this machine to match the current output selection.
  function applyOutputMute() {
    audioEngine.setMasterMute(Network.role() !== 'offline' && !isOutput());
    fire('roster', peers.slice(), outputId);
  }

  // Host only: push the roster + output choice to every client.
  function broadcastRoster() {
    Network.send('roster', { peers: peers, outputId: outputId });
    fire('roster', peers.slice(), outputId);
  }

  // Host only: validate and apply an output change (from anyone's panel).
  function setOutputAuthoritative(id) {
    if (!peers.some(function (p) { return p.id === id; })) return;
    outputId = id;
    applyOutputMute();
    broadcastRoster();
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  function init() {
    // What a newly-joined client receives: the whole project + transport state.
    Network.setSnapshotProvider(function () {
      return {
        pattern: audioEngine.getPatternSnapshot(),
        playing: audioEngine.isPlaying(),
      };
    });

    Network.on('message', handleMessage);

    Network.on('role', function (r) {
      if (r === 'host') {
        // A fresh session: the host is the only peer and the default output.
        peers = [{ id: 'host', name: machineName() }];
        outputId = 'host';
      } else if (r === 'client') {
        // Introduce ourselves so the roster shows a real machine name.
        Network.send('hello', { name: machineName() });
      } else {
        // Back to solo: no roster, and always audible again.
        peers = [];
        outputId = 'host';
      }
      applyOutputMute();
      fire('session', r);
    });

    // Host-side roster upkeep.
    Network.on('peerJoined', function (id) {
      peers.push({ id: id, name: 'Player' }); // placeholder until 'hello' lands
      broadcastRoster();
    });

    Network.on('peerLeft', function (id) {
      peers = peers.filter(function (p) { return p.id !== id; });
      if (outputId === id) outputId = 'host'; // output machine left -> host takes over
      applyOutputMute();
      broadcastRoster();
    });

    Network.on('status', function (s) { fire('status', s); });
    Network.on('peers', function (n) { fire('peers', n); });

    console.log('[Jam] ready');
  }

  // ── applying edits to the local engine (+ telling the UI) ───────────────────

  function applyAction(a) {
    switch (a.kind) {
      case 'step': {
        const on_ = audioEngine.setStep(a.trackId, a.i, a.on);
        fire('step', a.trackId, a.i, on_);
        break;
      }
      case 'pitch': {
        const v = audioEngine.setStepPitch(a.trackId, a.i, a.val);
        fire('pitch', a.trackId, a.i, v);
        break;
      }
      case 'len': {
        const l = audioEngine.setStepLen(a.trackId, a.i, a.val);
        fire('len', a.trackId, a.i, l);
        break;
      }
      case 'vel': {
        const v = audioEngine.setStepVel(a.trackId, a.i, a.val);
        fire('vel', a.trackId, a.i, v);
        break;
      }
      case 'fx': {
        const f = audioEngine.setStepFx(a.trackId, a.fxName, a.i, a.val);
        fire('fx', a.trackId, a.fxName, a.i, f);
        break;
      }
      case 'patternLen': {
        const pl = audioEngine.setPatternLen(a.len);
        fire('patternLen', pl);
        break;
      }
      case 'mute': {
        audioEngine.setTrackMute(a.trackId, a.muted);
        fire('mute', a.trackId, a.muted);
        break;
      }
      case 'volume': {
        const vol = audioEngine.setTrackVolume(a.trackId, a.v);
        fire('volume', a.trackId, vol);
        break;
      }
      case 'bpm': {
        const used = audioEngine.setMasterBpm(a.bpm);
        fire('bpm', used);
        break;
      }
      case 'swing': {
        const sw = audioEngine.setSwing(a.v);
        fire('swing', sw);
        break;
      }
      case 'key': {
        const st = audioEngine.setKeyTranspose(a.st);
        fire('key', st);
        break;
      }
      default:
        console.warn('[Jam] unknown action', a);
    }
  }

  function applyStructural(p) {
    if (p.kind === 'add') {
      audioEngine.addTrackToSequencer(p.objectType, p.displayName, p.by, p.snd, p.srcPad);
    } else if (p.kind === 'remove') {
      audioEngine.removeTrack(p.trackId);
    } else if (p.kind === 'swap') {
      audioEngine.setTrackSample(p.trackId, p.objectType, p.displayName, p.snd);
    } else if (p.kind === 'clear') {
      audioEngine.clearAllSteps();
    }
    fire('pattern');
  }

  function applyTransport(playing) {
    if (playing && !audioEngine.isPlaying()) audioEngine.play();
    if (!playing && audioEngine.isPlaying()) audioEngine.stop();
    fire('transport', playing);
  }

  function broadcastState() {
    Network.send('state', {
      pattern: audioEngine.getPatternSnapshot(),
      playing: audioEngine.isPlaying(),
    });
  }

  // ── message routing ─────────────────────────────────────────────────────────

  function handleMessage(m, fromId) {
    const role = Network.role();

    if (role === 'host') {
      // Everything a client sends is a REQUEST. The host applies it with
      // authority, then re-emits it so all peers (incl. the sender) converge.
      if (m.type === 'action') {
        applyAction(m.payload);
        Network.send('action', m.payload);
      } else if (m.type === 'structural') {
        applyStructural(m.payload);
        broadcastState();
      } else if (m.type === 'transport') {
        applyTransport(!!m.payload.playing);
        Network.send('transport', { playing: !!m.payload.playing });
      } else if (m.type === 'hello') {
        // A client told us its machine name — put it on the roster.
        const p = peers.find(function (x) { return x.id === fromId; });
        if (p) p.name = (m.payload && m.payload.name) || p.name;
        broadcastRoster();
      } else if (m.type === 'setOutput') {
        setOutputAuthoritative(m.payload && m.payload.id);
      }
      return;
    }

    if (role === 'client') {
      if (m.type === 'state') {
        // The whole project in one message (sent on join + after structure edits).
        audioEngine.applyPatternSnapshot(m.payload.pattern);
        fire('pattern');
        fire('bpm', audioEngine.getBpm());
        fire('swing', audioEngine.getSwing());
        fire('key', audioEngine.getKeyTranspose());
        applyTransport(!!m.payload.playing);
      } else if (m.type === 'action') {
        applyAction(m.payload);
      } else if (m.type === 'transport') {
        applyTransport(!!m.payload.playing);
      } else if (m.type === 'roster') {
        peers = m.payload.peers || [];
        outputId = m.payload.outputId || 'host';
        applyOutputMute();
      }
    }
  }

  // ── dispatch: local edit -> right place based on role ───────────────────────

  function dispatchAction(a) {
    const role = Network.role();
    if (role === 'client') {
      Network.send('action', a);     // host applies + echoes; we apply on echo
      return;
    }
    applyAction(a);                  // offline & host apply immediately
    if (role === 'host') Network.send('action', a);
  }

  function dispatchStructural(p) {
    const role = Network.role();
    if (role === 'client') {
      Network.send('structural', p);
      return;
    }
    applyStructural(p);
    if (role === 'host') broadcastState();
  }

  // ── the API the UI calls (mirrors what audioEngine used to expose) ──────────

  function toggleStep(trackId, i) {
    dispatchAction({ kind: 'step', trackId: trackId, i: i, on: !audioEngine.getStepOn(trackId, i) });
  }

  function setStepPitch(trackId, i, val) {
    dispatchAction({ kind: 'pitch', trackId: trackId, i: i, val: val });
  }

  function setStepLen(trackId, i, val) {
    dispatchAction({ kind: 'len', trackId: trackId, i: i, val: val });
  }

  function setStepVel(trackId, i, val) {
    dispatchAction({ kind: 'vel', trackId: trackId, i: i, val: val });
  }

  function setStepFx(trackId, fxName, i, val) {
    dispatchAction({ kind: 'fx', trackId: trackId, fxName: fxName, i: i, val: val });
  }

  function setMute(trackId, muted) {
    dispatchAction({ kind: 'mute', trackId: trackId, muted: muted });
  }

  function setVolume(trackId, v) {
    dispatchAction({ kind: 'volume', trackId: trackId, v: v });
  }

  function setBpm(bpm) {
    dispatchAction({ kind: 'bpm', bpm: bpm });
  }

  function setSwing(v) {
    dispatchAction({ kind: 'swing', v: v });
  }

  function setKey(st) {
    dispatchAction({ kind: 'key', st: st });
  }

  function setPatternLen(len) {
    dispatchAction({ kind: 'patternLen', len: len });
  }

  function addTrack(objectType, displayName, snd, srcPad) {
    // Tag the track with who added it, so jam peers see it in the sequencer.
    // srcPad is a local pad id (only meaningful on this machine).
    dispatchStructural({
      kind: 'add', objectType: objectType, displayName: displayName,
      by: machineName(), snd: snd || null, srcPad: srcPad || null,
    });
  }

  function removeTrack(trackId) {
    dispatchStructural({ kind: 'remove', trackId: trackId });
  }

  // Swap the sample an existing row plays (keeps its steps). Used when a pad's
  // sound is changed in the picker — the pad and its sequencer row are one thing.
  function swapTrack(trackId, objectType, displayName, snd) {
    dispatchStructural({
      kind: 'swap', trackId: trackId, objectType: objectType,
      displayName: displayName, snd: snd || null,
    });
  }

  function clearAll() {
    dispatchStructural({ kind: 'clear' });
  }

  function play() {
    const role = Network.role();
    if (role === 'client') { Network.send('transport', { playing: true }); return; }
    applyTransport(true);
    if (role === 'host') Network.send('transport', { playing: true });
  }

  function stop() {
    const role = Network.role();
    if (role === 'client') { Network.send('transport', { playing: false }); return; }
    applyTransport(false);
    if (role === 'host') Network.send('transport', { playing: false });
  }

  // Choose which machine is the audio output. Host applies directly; a client
  // asks the host, which validates and broadcasts the change to everyone.
  function setOutput(id) {
    const role = Network.role();
    if (role === 'host') setOutputAuthoritative(id);
    else if (role === 'client') Network.send('setOutput', { id: id });
  }

  // ── session controls (Host / Join / Leave buttons) ──────────────────────────

  function hostSession() {
    audioEngine.unlock();   // button click = user gesture; unlock audio now
    Network.host();
  }

  function joinSession(address) {
    audioEngine.unlock();
    Network.join(address);
  }

  function leaveSession() {
    Network.leave();
  }

  return {
    init: init,
    on: on,
    // sequencer edits
    toggleStep: toggleStep,
    setStepPitch: setStepPitch,
    setStepLen: setStepLen,
    setStepVel: setStepVel,
    setStepFx: setStepFx,
    setMute: setMute,
    setVolume: setVolume,
    setBpm: setBpm,
    setSwing: setSwing,
    setKey: setKey,
    setPatternLen: setPatternLen,
    addTrack: addTrack,
    removeTrack: removeTrack,
    swapTrack: swapTrack,
    clearAll: clearAll,
    play: play,
    stop: stop,
    // session
    hostSession: hostSession,
    joinSession: joinSession,
    leaveSession: leaveSession,
    role: function () { return Network.role(); },
    peerCount: function () { return Network.peerCount(); },
    getLanIps: function () { return Network.getLanIps(); },
    // audio-output routing
    setOutput: setOutput,
    isOutput: isOutput,
    myId: myId,
    getPeers: function () { return peers.slice(); },
    getOutputId: function () { return outputId; },
  };
})();
