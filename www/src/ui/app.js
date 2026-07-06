// src/ui/app.js
// This file wires the HTML controls to the other modules.
// It is the "glue" between user input and the audio/vision/network code.
//
// Each other module exposes a small global object (e.g. window.Vision,
// window.Audio, window.Collection, window.Network). Here we just hook up
// the buttons and sliders to call into them.

document.addEventListener('DOMContentLoaded', () => {
  // -------- Camera button: ask Vision module to start the webcam ----------
  const startCameraBtn = document.getElementById('start-camera-btn');
  startCameraBtn.addEventListener('click', async () => {
    await window.Vision.start(document.getElementById('camera-feed'));
  });

  // -------- Master BPM slider ----------
  const bpmSlider = document.getElementById('master-bpm');
  const bpmValue = document.getElementById('master-bpm-value');
  bpmSlider.addEventListener('input', () => {
    const bpm = Number(bpmSlider.value);
    bpmValue.textContent = bpm;
    window.Audio.setBpm(bpm);
    // If we are the host in a jam session, broadcast the new tempo.
    window.Network.broadcastBpm(bpm);
  });

  // -------- Transport buttons ----------
  document.getElementById('play-btn').addEventListener('click', () => {
    window.Audio.play();
  });
  document.getElementById('stop-btn').addEventListener('click', () => {
    window.Audio.stop();
  });

  // -------- Network buttons: host or join a session ----------
  document.getElementById('host-btn').addEventListener('click', () => {
    window.Network.host();
  });
  document.getElementById('join-btn').addEventListener('click', () => {
    const address = document.getElementById('host-address').value.trim();
    window.Network.join(address);
  });
});
