---
name: verify
description: How to run and drive Snap It (browser app + Cloudflare Worker) for verification
---

# Verifying Snap It

Browser PWA (no build step) + Cloudflare Worker (jam relay `/jam` + accounts `/auth/*`).

## Frontend (app.html)

```bash
node server/jam-server.js &   # serves repo root + local jam relay on :3001
```

Drive with headless Edge over raw CDP (no Playwright in this repo; `ws` is in node_modules):

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=<scratch>/edgeprofile --no-first-run \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream about:blank
```

- `PUT /json/new?url=...` (GET is rejected on new Chrome), then talk CDP over its `webSocketDebuggerUrl` with the `ws` package.
- **Disable cache** (`Network.setCacheDisabled`) or a fresh tab may run stale JS after an edit — this produced a false re-test once.
- Fake camera makes `Vision.start` succeed; the test pattern gets detected as "kite" and triggers the real scan→unlock→reveal pipeline (reveal modal opens at boot — expected).
- Mobile: `Emulation.setDeviceMetricsOverride {mobile:true, 390x844}` + `Emulation.setTouchEmulationEnabled` flips `(pointer: coarse)` → swipe-deck layout engages.
- Boot success marker: `[ui] ready` in console; check zero `Runtime.exceptionThrown`.

## Worker (/auth + /jam Durable Object)

**Do NOT run `wrangler dev` against the repo root** — the assets dir is the repo root, and wrangler's own `.wrangler/tmp` writes re-trigger the asset watcher: infinite "Reloading local server..." loop, requests hang (accepted, never answered). Instead copy `worker/*.js` + a stub assets dir + a minimal wrangler.toml (KV id can be any string in local mode) into the scratchpad and run there:

```bash
npx wrangler dev --config <scratch>/cf/wrangler.toml --port 8788   # up in ~6s
```

- Auth flow: curl POST `/auth/signup|login|me|collection|name` (JSON bodies), GET `/auth/verify?token=`.
- Jam relay: WebSocket `ws://127.0.0.1:8788/jam?room=TEST`, protocol `{t:'join',role:'host'|'client'}` then `{t:'msg',mtype,payload}`; assert `role`, `peer-joined`, relayed `msg`, `host-gone`.
- Never `wrangler deploy` — the user deploys themselves.

## Gotchas

- `taskkill //F //IM workerd.exe` if a previous wrangler dev leaks; two workerd instances cause reload churn.
- jam-server serves no-cache-ish but Edge still cached `src/ui/ui.js` once — always bust cache when re-testing an edit.
