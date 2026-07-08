// src/vision/cameraStub.js
// -----------------------------------------------------------------------------
// A placeholder for the real camera / computer-vision module that a teammate is
// building separately. Its only job right now is to expose a clean entry point
// so the rest of the app can pretend an object was "scanned".
//
// HOW THE REAL CAMERA MODULE PLUGS IN LATER:
//   The vision code will detect an object type (a string like "cup" or "book")
//   and simply call `cameraStub.simulateScan(objectType)` — exactly what the
//   "Simulate scan" button does today. Nothing else in the app needs to change.
//
// Public API (attached to window so plain <script> tags can share it):
//   cameraStub.onObjectScanned(handler)  -> register a callback(objectType)
//   cameraStub.simulateScan(objectType)  -> fire that callback with an object
// -----------------------------------------------------------------------------

const cameraStub = (function () {
  // The single handler the app registers (the UI sets this on startup).
  let scanHandler = null;

  // Register who should be told when an object is scanned.
  function onObjectScanned(handler) {
    scanHandler = handler;
    console.log('[cameraStub] scan handler registered');
  }

  // Pretend the camera just recognised `objectType`. The real vision module
  // will call this same function once it has a detection.
  function simulateScan(objectType) {
    console.log('[cameraStub] simulateScan ->', objectType);
    if (typeof scanHandler === 'function') {
      scanHandler(objectType);
    } else {
      console.warn('[cameraStub] no scan handler registered yet');
    }
  }

  return { onObjectScanned, simulateScan };
})();

// Expose globally so library.js / ui.js can reach it without a bundler.
window.cameraStub = cameraStub;
