// jam-server.js
// -----------------------------------------------------------------------------
// Local dev + LAN server: serves the Snap It app AND relays jam messages over a
// native WebSocket, using the SAME wire protocol as the Cloudflare Worker relay
// (worker/jam-worker.js). So the exact same browser code jams whether the app is
// opened from this server (http on your WiFi) or from the published Cloudflare
// site (wss). Rooms are addressed by a short code so several groups don't collide.
//
//   Run:   npm start           (node server/jam-server.js, PORT env optional)
//   Local: open http://localhost:3001/app.html      -> "Host"  (get a room code)
//   LAN:   friends open http://<your-lan-ip>:3001/app.html -> "Join" + code
//
// Wire protocol (JSON over a WebSocket at /jam?room=CODE):
//   client -> {t:'join', role:'host'|'client', name}
//   server -> {t:'role', role, id, room, lanIps?}     (host also gets LAN IPs)
//          -> {t:'denied', reason}                      (a host already holds room)
//          -> {t:'peer-joined', id, name}   (to host)
//          -> {t:'peer-left', id}           (to host)
//          -> {t:'host-gone'}               (to clients)
//   either -> {t:'msg', target?, mtype, payload}  -> relayed as
//   server -> {t:'msg', from, mtype, payload}
//             (host w/o target -> all clients; host w/ target -> one; client -> host)
// -----------------------------------------------------------------------------

const http = require('http');
const os = require('os');
const url = require('url');
const path = require('path');
const handler = require('serve-handler');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
// This file lives in server/; the app's static files sit one level up.
const ROOT = path.join(__dirname, '..');

function lanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    });
  });
  return ips;
}

// The site's pages. "/" and "/index" resolve to the landing page, "/app" to the
// studio — serve-handler (6.1.7) can't find a directory's index.html on Windows
// and renders a file listing of the repo instead, so the mapping is explicit.
const PAGES = {
  '/': '/index.html',
  '/index': '/index.html',
  '/app': '/app.html',
};

const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const page = PAGES[parsed.pathname];
  if (page) req.url = page + (parsed.search || '');

  return handler(req, res, {
    public: ROOT,
    cleanUrls: false,
    // Never list the repo's own directories: it 404s a stray path instead of
    // publishing the source tree to everyone on the WiFi.
    directoryListing: false,
    // no-store on everything: this is the dev/LAN server, and without an
    // explicit directive browsers fall back to heuristic caching off
    // Last-Modified — they reuse app.css / ui.js on a plain refresh without
    // asking, so an edit silently doesn't show up and you debug a change the
    // page never loaded.
    headers: [{
      source: '**',
      headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
    }],
  });
});

// One room = { host: ws|null, clients: Map<id, ws> }. Matches the Durable Object.
const rooms = new Map();
function room(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, clients: new Map() });
  return rooms.get(code);
}

let nextId = 1;
const wss = new WebSocketServer({ server: httpServer, path: '/jam' });

wss.on('connection', (ws, req) => {
  const q = url.parse(req.url, true).query;
  const code = (q.room || 'MAIN').toString().toUpperCase();
  const r = room(code);
  ws.data = { role: null, id: 'c' + (nextId++), room: code };

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (e) {} };

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }

    if (m.t === 'join') {
      if (m.role === 'host') {
        if (r.host && r.host.readyState === 1 && r.host !== ws) {
          send({ t: 'denied', reason: 'someone is already hosting room ' + code });
          return;
        }
        r.host = ws; ws.data.role = 'host';
        send({ t: 'role', role: 'host', id: 'host', room: code, lanIps: lanIps() });
        for (const [id, c] of r.clients) send({ t: 'peer-joined', id: id, name: c.data.name || 'Player' });
        console.log('[jam] host claimed room', code);
      } else {
        ws.data.role = 'client'; ws.data.name = m.name || 'Player';
        r.clients.set(ws.data.id, ws);
        send({ t: 'role', role: 'client', id: ws.data.id, room: code });
        if (r.host && r.host.readyState === 1) r.host.send(JSON.stringify({ t: 'peer-joined', id: ws.data.id, name: ws.data.name }));
        else send({ t: 'status', text: 'Waiting for a host to start room ' + code + '…' });
        console.log('[jam] client', ws.data.id, 'joined room', code);
      }
      return;
    }

    if (m.t === 'msg') {
      if (ws.data.role === 'host') {
        const wrapped = JSON.stringify({ t: 'msg', from: 'host', mtype: m.mtype, payload: m.payload });
        if (m.target) { const c = r.clients.get(m.target); if (c && c.readyState === 1) c.send(wrapped); }
        else for (const c of r.clients.values()) if (c.readyState === 1) c.send(wrapped);
      } else if (ws.data.role === 'client') {
        if (r.host && r.host.readyState === 1) r.host.send(JSON.stringify({ t: 'msg', from: ws.data.id, mtype: m.mtype, payload: m.payload }));
      }
    }
  });

  ws.on('close', () => {
    if (ws.data.role === 'host') {
      if (r.host === ws) r.host = null;
      for (const c of r.clients.values()) if (c.readyState === 1) c.send(JSON.stringify({ t: 'host-gone' }));
      console.log('[jam] host left room', code);
    } else if (ws.data.role === 'client') {
      r.clients.delete(ws.data.id);
      if (r.host && r.host.readyState === 1) r.host.send(JSON.stringify({ t: 'peer-left', id: ws.data.id }));
      console.log('[jam] client', ws.data.id, 'left room', code);
    }
    if (!r.host && r.clients.size === 0) rooms.delete(code);
  });
});

httpServer.listen(PORT, () => {
  const ips = lanIps();
  console.log('\nSnap It — site + studio + jam relay running:');
  console.log('  landing:  http://localhost:' + PORT + '/');
  console.log('  studio:   http://localhost:' + PORT + '/app.html');
  console.log('  studio (phone layout on a desktop browser):');
  console.log('            http://localhost:' + PORT + '/app.html?mobile=1');
  ips.forEach((ip) => console.log('  network:  http://' + ip + ':' + PORT + '/   <- friends open this, then Join with the room code'));
  console.log('');
});
