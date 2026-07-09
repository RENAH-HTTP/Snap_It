# Snap It

Turn the world around you into music. Walk through your space with your laptop, scan objects with your webcam, and every object you find becomes a sound you own.

## The Idea

You explore the real world with your laptop and scan objects using your webcam. The app identifies what it sees and converts physical properties into musical building blocks. Each scanned object becomes a unique sound in your personal collection.

## How It Works

### Scanning
Open your laptop's webcam and point it at any object. The app detects:
- **Type** — what the object is
- **Color** → maps to **pitch**
- **Material** → maps to **instrument type**
- **Size** → maps to **volume**

Every scan adds a unique sound to your collection.

### Collection
Your scanned objects live in a personal library, like a card collection. Each item has a rarity tier:
- **Common** objects are easy to find
- **Rare** objects require hunting

The more interesting your objects, the more interesting your music.

### Hot Zones
Certain real-world locations are marked on the in-app map. Each zone has a mission, for example:
- Scan a wooden object
- Find something reflective
- Capture something blue

All scans must happen within that physical location. Complete the mission and **everyone there unlocks the same rare sound drop** — a drop that can't be found any other way.

### Trading
Players swap items like trading cards. Got a rare brass texture from a museum hot zone? Trade it for an industrial percussion sample someone else pulled from a factory zone. This creates a real economy around sounds and gives players a reason to hunt specific items.

### Jam Sessions
Open a live room and invite other players. Each player triggers items from their collection in real time, building a loop together — like a band where every instrument is something someone found in the world.

## The Core Loop

> **Explore** to collect → **collect** to build → **build** to trade → **trade** to jam → **jam** to want rarer sounds → **explore** more.

## Requirements

- A laptop with a working webcam
- An internet connection (for hot zones, trading, and jam sessions)
- Location access (for the map and zone missions)
- Microphone/speakers or headphones (for jamming)

## Getting Started

1. Launch the app on your laptop
2. Grant camera and location permissions
3. Point your webcam at an object and hit **Scan**
4. Open your **Collection** to hear what you just captured
5. Check the **Map** for nearby hot zones
6. Head out, scan more, and start a **Jam Session** with friends

---

## For Developers

### Running locally

```bash
npm install
npm start          # node server/jam-server.js — serves the app + jam relay on :3001
```

Open http://localhost:3001/app.html. See [DEPLOY.md](DEPLOY.md) for LAN jam and
Cloudflare publishing.

### Project structure

```
Snap_It/
├── app.html              # The instrument (studio UI) — loads /styles + /src
├── index.html            # Landing page
├── manifest.json, sw.js  # PWA manifest + service worker
│
├── styles/               # Page CSS (extracted from the HTML)
│   ├── app.css           #   styles for app.html
│   └── landing.css       #   styles for index.html
│
├── src/                  # App code — plain scripts, each attaches one global to window
│   ├── audio/
│   │   └── audioEngine.js    # Tone.js playback, sequencer, per-track FX  (window.audioEngine)
│   ├── ui/
│   │   ├── ui.js             # all DOM rendering + event wiring           (window.ui)
│   │   └── visualizer.js     # live signal visualizer                     (window.Visualizer)
│   ├── vision/
│   │   ├── vision.js         # webcam + COCO-SSD object detection         (window.Vision)
│   │   └── cameraStub.js     # manual-scan fallback                       (window.cameraStub)
│   ├── data/
│   │   ├── library.js        # loads objectSampleMap, tracks unlocks      (window.library)
│   │   └── profile.js        # accounts (backend + device-local fallback) (window.Profile)
│   └── multiplayer/
│       ├── network.js        # native-WebSocket transport to /jam         (window.Network)
│       └── jam.js            # jam session state/sync                      (window.Jam)
│
├── data/                 # objectSampleMap.json (object → sample mapping)
├── samples/              # the drum/instrument .wav one-shots
├── vendor/               # Tone.js, tf.min.js, coco-ssd.min.js (browser-ready copies)
│
├── server/
│   └── jam-server.js     # local dev + LAN server (static files + jam relay)
├── worker/               # Cloudflare Worker: static assets + /jam relay + /auth
│   ├── jam-worker.js
│   └── auth.js
├── tools/                # build + one-off asset generators (node scripts)
│   ├── build.js          #   bundles dist/ for static hosting
│   ├── build-objects.js, build-sample-map.js, gen-samples.js
└── docs/                 # README, DEPLOY, notes
```

Load order matters (scripts attach globals in sequence); the order lives in the
`<script>` block near the bottom of [../app.html](../app.html).