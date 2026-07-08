# Deploying Snap It

The app is a static site plus a tiny **jam relay**. Jamming works both locally
(over your WiFi) and on the published Cloudflare site — same browser code, because
`src/multiplayer/network.js` uses the native WebSocket and connects to `/jam` on
whatever origin served the app.

## Run locally (dev + LAN jam)

```bash
npm install
npm start            # = node server/jam-server.js  (serves the app + jam relay on :3001)
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

## Cross-device accounts + email confirmation (optional)

Signup / login / rename and **collection sync** run on the same Worker under
`/auth/*` (`worker/auth.js`), backed by one **Workers KV** namespace. Confirmation
emails go out through **Resend**. Until this is set up the app still works — it
falls back to device-local accounts in the browser (`src/data/profile.js`).

1. **Create the KV namespace** and paste its id into `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create USERS
   # copy the printed id into [[kv_namespaces]] id = "…"  (in wrangler.toml)
   ```
2. **Set the site URL + sender** in `wrangler.toml` `[vars]`:
   - `APP_URL` = your public origin, e.g. `https://snap-it.<you>.workers.dev`
     (used to build the email confirm link `/auth/verify?token=…`).
   - `MAIL_FROM` = a **verified** Resend sender, e.g. `Snap It <noreply@yourdomain.com>`.
3. **Add the Resend API key as a secret** (never commit it):
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   Get the key + verify your sending domain at https://resend.com.
4. `npx wrangler deploy` again.

How it behaves: signup creates the account, logs you straight in, and emails a
confirm link; the account works immediately but shows a "confirm your email"
note until the link is clicked. Passwords are PBKDF2-SHA256 (salted) — only the
hash is stored. Your collection is merged (never dropped) across devices on login.

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
