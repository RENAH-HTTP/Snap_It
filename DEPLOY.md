# Deploying Snap It

The app is a static site plus a tiny **jam relay**. Jamming works both locally
(over your WiFi) and on the published Cloudflare site — same browser code, because
`src/multiplayer/network.js` uses the native WebSocket and connects to `/jam` on
whatever origin served the app.

## Run locally (dev + LAN jam)

```bash
npm install
npm start            # = node jam-server.js  (serves the app + jam relay on :3001)
```

- Host: open http://localhost:3001/app.html → **Jam Session → Host** → you get a **room code**.
- Friends on the same WiFi: open `http://<your-lan-ip>:3001/app.html` (the server prints your IP) → **Join** → enter the room code.
- One machine is the audio **output** (default: the host); everyone else stays muted. Change it in the Jam panel’s “Audio output” list.

## Publish to Cloudflare (jam works from the public URL)

One Worker serves the static files **and** the jam relay (a Durable Object per room), so an HTTPS page reaches the relay over `wss://` with no mixed-content problems.

```bash
npx wrangler deploy      # uses wrangler.toml + worker/jam-worker.js
```

Then anyone opens `https://<your-worker-subdomain>.workers.dev/app.html`, hits **Host**, shares the room code, and friends **Join** — same-WiFi or remote. Output-machine selection works identically.

Notes:
- Static assets are served from the repo root; `.assetsignore` trims `node_modules`, `.git`, build scripts, etc. The libraries the app needs are **vendored** in `vendor/` (`Tone.js`, `tf.min.js`, `coco-ssd.min.js`).
- To refresh vendored libs after `npm update`:
  ```bash
  cp node_modules/tone/build/Tone.js vendor/Tone.js
  cp node_modules/@tensorflow/tfjs/dist/tf.min.js vendor/tf.min.js
  cp node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.min.js vendor/coco-ssd.min.js
  ```
- Durable Objects are on Cloudflare’s free tier (SQLite-backed, see `wrangler.toml`).
- Camera scanning needs HTTPS (Cloudflare gives you that) or localhost.
