// src/audio/audio.js
// Audio engine for SoundHunter. Uses Tone.js so that every object's sample
// plays in sync with a shared master BPM (similar to Ableton Link).
//
// In a finished build, each detected object would have its own Tone.Player
// triggered on a beat by the Transport. Here we just set up the transport
// and expose simple play / stop / setBpm functions for the UI to call.

window.Audio = (() => {

  // Lazy-require Tone so the app still loads even if dependencies are missing.
  let Tone = null;
  try {
    Tone = require('tone');
  } catch (err) {
    console.warn('[Audio] Tone.js not installed yet. Run `npm install`.');
  }

  /**
   * Set the master BPM. All scheduled samples follow Tone.Transport.bpm.
   */
  function setBpm(bpm) {
    if (!Tone) return;
    Tone.Transport.bpm.value = bpm;
    console.log('[Audio] Master BPM set to', bpm);
  }

  /**
   * Start the transport. Browsers need a user gesture before any audio can
   * play, which is why this is wired to a button click in the UI.
   */
  async function play() {
    if (!Tone) return;
    await Tone.start();
    Tone.Transport.start();
    console.log('[Audio] Transport started');
  }

  /**
   * Stop the transport. All scheduled events pause until play() is called again.
   */
  function stop() {
    if (!Tone) return;
    Tone.Transport.stop();
    console.log('[Audio] Transport stopped');
  }

  /**
   * Register a card's sample so it plays on every beat at its own subdivision.
   * (Stub — real implementation will load the audio file and schedule it.)
   */
  function registerCardSample(card) {
    if (!Tone) return;
    // TODO: const player = new Tone.Player(card.sampleUrl).toDestination();
    // Tone.Transport.scheduleRepeat(time => player.start(time), card.interval);
    console.log('[Audio] (stub) Would register sample for card:', card);
  }

  return { setBpm, play, stop, registerCardSample };
})();
