// src/multiplayer/network.js
// -----------------------------------------------------------------------------
// Transport layer for jam sessions (LAN, Ableton-Link-style).
//
// One computer hosts: it embeds a socket.io server on PORT and becomes the
// authority for the shared project (pattern + BPM + transport). Others join
// with the host's LAN IP. This module is DUMB on purpose — it only moves
// messages and reports connection events. All musical/state logic lives in
// jam.js, which subscribes via Network.on(...).
//
// Message envelope on the wire: { type: string, payload: any }
//
// Public API (attached to window):
//   Network.host()                  -> start hosting on this machine
//   Network.join(address)           -> connect to a host's LAN IP
//   Network.leave()                 -> tear down host/client connection
//   Network.send(type, payload)     -> host: broadcast to all clients
//                                      client: send to the host
//   Network.on(event, cb)           -> 'message' (msg, fromId)
//                                      'role'    (role)
//                                      'status'  (human-readable string)
//                                      'peers'   (count)
//   Network.setSnapshotProvider(fn) -> fn() returns the full session state;
//                                      sent to every client the moment it joins
//   Network.role()                  -> 'offline' | 'host' | 'client'
//   Network.peerCount()             -> connected clients (host side)
//   Network.getLanIps()             -> this machine's IPv4 LAN addresses
// -----------------------------------------------------------------------------

window.Network = (() => {

  const PORT = 3030;

  let role = 'offline';       // 'offline' | 'host' | 'client'
  let ioServer = null;        // socket.io server (host only)
  let httpServer = null;      // underlying http server (host only)
  let socket = null;          // socket.io-client connection (client only)
  let peers = 0;              // connected clients (host only)
  let snapshotProvider = null;

  const handlers = {};        // event -> [callbacks]

  // ── tiny local event bus ────────────────────────────────────────────────────

  function on(event, cb) {
    (handlers[event] = handlers[event] || []).push(cb);
  }

  function emitLocal(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[event] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { console.error('[Network] handler error', e); }
    });
  }

  function setRole(r) {
    role = r;
    emitLocal('role', role);
  }

  // ── LAN discovery helper ────────────────────────────────────────────────────

  // The IPv4 addresses friends can type to join (skips loopback/virtual-ish).
  function getLanIps() {
    try {
      const nets = require('os').networkInterfaces();
      const ips = [];
      Object.keys(nets).forEach(function (name) {
        (nets[name] || []).forEach(function (n) {
          if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
        });
      });
      return ips;
    } catch (e) {
      return [];
    }
  }

  // ── host ────────────────────────────────────────────────────────────────────

  function host() {
    if (role !== 'offline') return;
    try {
      const { Server } = require('socket.io');
      httpServer = require('http').createServer();
      ioServer = new Server(httpServer, { cors: { origin: '*' } });

      ioServer.on('connection', function (client) {
        peers++;
        emitLocal('peers', peers);
        console.log('[Network] client joined:', client.id, '(' + peers + ' total)');

        // Bring the newcomer fully up to date with one state snapshot.
        if (snapshotProvider) {
          client.emit('msg', { type: 'state', payload: snapshotProvider() });
        }
        emitLocal('peerJoined', client.id);

        client.on('msg', function (m) { emitLocal('message', m, client.id); });
        client.on('disconnect', function () {
          peers = Math.max(0, peers - 1);
          emitLocal('peers', peers);
          emitLocal('peerLeft', client.id);
          console.log('[Network] client left:', client.id, '(' + peers + ' total)');
        });
      });

      httpServer.on('error', function (err) {
        console.error('[Network] server error:', err);
        emitLocal('status', 'Host failed: ' + err.message);
        leave();
      });

      httpServer.listen(PORT, function () {
        setRole('host');
        const ip = getLanIps()[0] || 'this machine\'s IP';
        emitLocal('status', 'Hosting — friends join via ' + ip);
        console.log('[Network] hosting on port', PORT, 'at', getLanIps().join(', '));
      });
    } catch (err) {
      console.error('[Network] failed to host:', err);
      emitLocal('status', 'Host failed — see console');
    }
  }

  // ── client ──────────────────────────────────────────────────────────────────

  function join(address) {
    if (role !== 'offline') return;
    address = (address || '').trim();
    if (!address) {
      emitLocal('status', 'Enter the host\'s IP first.');
      return;
    }
    try {
      const { io } = require('socket.io-client');
      emitLocal('status', 'Connecting to ' + address + '…');
      socket = io('http://' + address + ':' + PORT, {
        reconnectionAttempts: 3,
        timeout: 5000,
      });

      socket.on('connect', function () {
        setRole('client');
        emitLocal('status', 'Connected to ' + address);
        console.log('[Network] connected to host', address);
      });

      socket.on('msg', function (m) { emitLocal('message', m, 'host'); });

      socket.on('connect_error', function (err) {
        console.warn('[Network] connect error:', err.message);
        emitLocal('status', 'Can\'t reach ' + address + ' — same WiFi? Host running?');
      });

      socket.io.on('reconnect_failed', function () {
        emitLocal('status', 'Could not connect to ' + address + '.');
        leave();
      });

      socket.on('disconnect', function () {
        // Host quit or network dropped. Fall back to solo mode but keep the
        // last-synced pattern locally so the music doesn't vanish.
        if (role === 'client') {
          setRole('offline');
          emitLocal('status', 'Disconnected — back to solo (pattern kept).');
        }
      });
    } catch (err) {
      console.error('[Network] failed to join:', err);
      emitLocal('status', 'Join failed — see console');
    }
  }

  // ── shared ──────────────────────────────────────────────────────────────────

  function leave() {
    if (socket) {
      try { socket.close(); } catch (e) {}
      socket = null;
    }
    if (ioServer) {
      try { ioServer.close(); } catch (e) {}
      ioServer = null;
    }
    if (httpServer) {
      try { httpServer.close(); } catch (e) {}
      httpServer = null;
    }
    peers = 0;
    emitLocal('peers', 0);
    if (role !== 'offline') {
      setRole('offline');
      emitLocal('status', 'Left the session.');
    }
  }

  // Host broadcasts to every client; a client sends to the host. Offline: no-op.
  function send(type, payload) {
    const m = { type: type, payload: payload };
    if (role === 'host' && ioServer) ioServer.emit('msg', m);
    else if (role === 'client' && socket) socket.emit('msg', m);
  }

  return {
    host: host,
    join: join,
    leave: leave,
    send: send,
    on: on,
    setSnapshotProvider: function (fn) { snapshotProvider = fn; },
    getLanIps: getLanIps,
    role: function () { return role; },
    peerCount: function () { return peers; },
    // This machine's socket id when joined as a client (used to answer
    // "is ME the selected output machine?").
    clientId: function () { return (socket && socket.id) ? socket.id : null; },
  };
})();
