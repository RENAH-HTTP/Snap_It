// jam-server.js
// -----------------------------------------------------------------------------
// One command that (a) serves the Snap It web app and (b) relays jam-session
// messages over the LAN — so "Host on this WiFi" works from a plain browser.
//
// A browser tab can't open a listening socket, so instead of each host embedding
// its own server (the old Electron-only model), the machine that runs this file
// is the meeting point. Everyone loads the app from it and connects back to it
// on the SAME port. The first browser to press "Host" claims the room and
// becomes the authority; every edit is relayed through here.
//
//   Run:   npm start        (or: node jam-server.js)
//   Host:  open http://localhost:3001/app.html  -> "Host on this WiFi"
//   Join:  friends open  http://<your-lan-ip>:3001/app.html -> "Join"
//
// Wire protocol (browser <-> relay):
//   'join-jam'  {role:'host'|'client', name}   -> ask for a role
//   'jam-role'  {role, id, lanIps?}            -> assigned role (+ host gets IPs)
//   'jam-denied'{reason}                       -> a host already exists
//   'jam-peer-joined' {id, name}   (to host)   -> a client arrived
//   'jam-peer-left'   {id}         (to host)   -> a client left
//   'jam-host-gone'                (to clients)-> the host disconnected
//   'jam-msg'   {target?, type, payload}       -> a session message; relay routes
//               (host w/o target -> all clients; host w/ target -> one client;
//                client -> the host).  Delivered as {from, type, payload}.
// -----------------------------------------------------------------------------

const http = require('http');
const os = require('os');
const handler = require('serve-handler');
const { Server } = require('socket.io');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const ROOT = __dirname;

// This machine's IPv4 LAN addresses — what friends type to join.
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

const httpServer = http.createServer((req, res) =>
  handler(req, res, { public: ROOT, cleanUrls: false })
);

const io = new Server(httpServer, { cors: { origin: '*' } });

let hostSocket = null;            // the room authority (one at a time)
const clients = new Map();        // socket.id -> client socket

io.on('connection', (socket) => {
  socket.on('join-jam', (opts) => {
    const role = opts && opts.role;
    const name = (opts && opts.name) || 'Player';

    if (role === 'host') {
      if (hostSocket && hostSocket.connected && hostSocket.id !== socket.id) {
        socket.emit('jam-denied', { reason: 'someone is already hosting on this network' });
        return;
      }
      hostSocket = socket;
      socket.data.role = 'host';
      socket.emit('jam-role', { role: 'host', id: 'host', lanIps: lanIps() });
      // Introduce anyone who connected before a host existed.
      for (const [id, c] of clients) {
        hostSocket.emit('jam-peer-joined', { id: id, name: c.data.name || 'Player' });
      }
      console.log('[jam] host claimed by', socket.id);
    } else {
      socket.data.role = 'client';
      socket.data.name = name;
      clients.set(socket.id, socket);
      socket.emit('jam-role', { role: 'client', id: socket.id });
      if (hostSocket) hostSocket.emit('jam-peer-joined', { id: socket.id, name: name });
      else socket.emit('jam-status', 'Waiting for a host to start the session…');
      console.log('[jam] client joined', socket.id, '(' + clients.size + ' total)');
    }
  });

  socket.on('jam-msg', (env) => {
    if (!env) return;
    if (socket.data.role === 'host') {
      const wrapped = { from: 'host', type: env.type, payload: env.payload };
      if (env.target) {
        const c = clients.get(env.target);
        if (c) c.emit('jam-msg', wrapped);
      } else {
        for (const c of clients.values()) c.emit('jam-msg', wrapped);
      }
    } else if (socket.data.role === 'client') {
      if (hostSocket) hostSocket.emit('jam-msg', { from: socket.id, type: env.type, payload: env.payload });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'host') {
      hostSocket = null;
      for (const c of clients.values()) c.emit('jam-host-gone');
      console.log('[jam] host left — room closed');
    } else if (socket.data.role === 'client') {
      clients.delete(socket.id);
      if (hostSocket) hostSocket.emit('jam-peer-left', { id: socket.id });
      console.log('[jam] client left', socket.id, '(' + clients.size + ' total)');
    }
  });
});

httpServer.listen(PORT, () => {
  const ips = lanIps();
  console.log('\nSnap It — studio + jam relay running:');
  console.log('  local:    http://localhost:' + PORT + '/app.html');
  ips.forEach((ip) => console.log('  network:  http://' + ip + ':' + PORT + '/app.html   <- friends join here'));
  console.log('');
});
