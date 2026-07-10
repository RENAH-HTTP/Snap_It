// v4: sample remap renamed most WAVs — the bump drops caches still holding the
// old names (samples are cache-first, so they'd never be evicted otherwise).
const CACHE_NAME = 'snap-it-cache-v4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  './styles/app.css',
  './styles/landing.css',
  './src/vision/cameraStub.js',
  './src/ui/visualizer.js',
  './src/vision/vision.js',
  './src/data/profile.js',
  './src/data/library.js',
  './src/audio/audioEngine.js',
  './src/multiplayer/network.js',
  './src/multiplayer/jam.js',
  './src/ui/ui.js',
  './vendor/Tone.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

function cacheIfOk(request, response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return response;
  const copy = response.clone();
  caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
  return response;
}

// The app's own code (page, scripts, stylesheets) is network-first: cache-first
// here means an edit to ui.js or app.css never reaches the browser, which boots
// the previous build instead — a whole afternoon of "my change isn't showing".
// Falling back to the cache keeps the PWA usable offline. Everything else
// (samples, fonts, images) stays cache-first: it's big and its names are stable.
function isAppCode(request) {
  if (request.mode === 'navigate') return true;
  const dest = request.destination;
  return dest === 'document' || dest === 'script' || dest === 'style';
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (isAppCode(request)) {
    event.respondWith(
      fetch(request)
        .then(response => cacheIfOk(request, response))
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => cacheIfOk(request, response));
    })
  );
});
