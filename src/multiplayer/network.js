// src/multiplayer/network.js
// -----------------------------------------------------------------------------
// Transport layer for jam sessions (LAN, browser-friendly).
//
// A browser tab can't listen for TCP connections, so hosting is done through a
// shared relay: the machine running `jam-server.js` serves the app AND relays
// jam messages on the same port. Both host and clients are socket.io CLIENTS of
// that relay — the "host" is simply the peer the relay marks as the authority.
//
// This module stays DUMB: it moves messages and reports connection events. All
// musical/state logic lives in jam.js, which subscribes via Network.on(...).
//
// Public API (attached to window) — unchanged from the old embedded-server
// version so jam.js/ui.js keep working:
//   Network.host()                  -> claim the room on the relay we loaded from
//   Network.join(address)           -> connect to a host's relay (blank = same one)
//   Network.leave()                 -> disconnect
//   Network.send(type, payload)     -> host: broadcast to all clients
//                                      client: send to the host
//   Network.on(event, cb)           -> 'message' (msg, fromId) | 'role' (role)
//                                      'status' | 'peers' | 'peerJoined'/'peerLeft'
//   Network.setSnapshotProvider(fn) -> host sends fn() to each client as it joins
//   Network.role()                  -> 'offline' | 'host' | 'client'
//   Network.peerCount()             -> connected clients (host side)
//   Network.getLanIps()             -> LAN IPv4s the relay reported (host side)
//   Network.clientId()              -> this client's id in the room
// -----------------------------------------------------------------------------

window.Network = (() => {

  let role = 'offline';       // 'offline' | 'host' | 'client'
  let socket = null;          // socket.io-client connection to the relay
  let peers = 0;              // connected clients (host side)
  let assignedId = null;      // our id in the room (client side)
  let lanIps = [];            // reported by the relay (host side)
  let snapshotProvider = null;

  const handlers = {};

  function on(event, cb) {
    (handlers[event] = handlers[event] || []).push(cb);
  }
  function emitLocal(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[event] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { console.error('[Network] handler error', e); }
    });
  }
  function setRole(r) { role = r; emitLocal('role', role); }

  // The socket.io browser client is served by jam-server.js at /socket.io/…;
  // if the app is opened without that server, `io` is missing and jam is off.
  function available() { return typeof io !== 'undefined'; }

  function nameHint() {
    try {
      if (window.Profile && Profile.current && Profile.current()) return Profile.displayName();
    } catch (e) {}
    return 'Player';
  }

  function connect(url) {
    const opts = { reconnectionAttempts: 3, timeout: 5000 };
    return url ? io(url, opts) : io(opts);   // no url == same origin (the relay we loaded from)
  }

  // Messages + disconnect behave the same for host and client.
  function wireCommon() {
    socket.on('jam-msg', function (env) {
      emitLocal('message', { type: env.type, payload: env.payload }, env.from);
    });
    socket.on('jam-status', function (s) { emitLocal('status', s); });
  }

  // ── host ────────────────────────────────────────────────────────────────────

  function host() {
    if (role !== 'offline') return;
    if (!available()) {
      emitLocal('status', 'Jam server not running — start it with “npm start”, then reload.');
      return;
    }
    socket = connect(null);
    wireCommon();

    socket.on('connect', function () {
      socket.emit('join-jam', { role: 'host', name: nameHint() });
    });
    socket.on('jam-role', function (d) {
      if (!d || d.role !== 'host') return;
      lanIps = d.lanIps || [];
      peers = 0;
      setRole('host');
      emitLocal('peers', 0);
      emitLocal('status', 'Hosting — friends join via ' + (lanIps[0] || 'your Wi‑Fi IP'));
      console.log('[Network] hosting via relay; LAN:', lanIps.join(', '));
    });
    socket.on('jam-denied', function (d) {
      emitLocal('status', 'Host failed — ' + ((d && d.reason) || 'unknown') + '.');
      leave();
    });
    socket.on('jam-peer-joined', function (p) {
      peers++;
      emitLocal('peers', peers);
      // Bring the newcomer fully up to date with one targeted snapshot.
      if (snapshotProvider && socket) {
        socket.emit('jam-msg', { target: p.id, type: 'state', payload: snapshotProvider() });
      }
      emitLocal('peerJoined', p.id);
    });
    socket.on('jam-peer-left', function (p) {
      peers = Math.max(0, peers - 1);
      emitLocal('peers', peers);
      emitLocal('peerLeft', p.id);
    });
    socket.on('connect_error', function () {
      emitLocal('status', 'Jam server unreachable — is it running on this machine?');
    });
    socket.on('disconnect', function () {
      if (role === 'host') { setRole('offline'); emitLocal('peers', 0); emitLocal('status', 'Stopped hosting.'); }
    });
  }

  // ── client ────────────────────────────────────────────────────────────────────

  function join(address) {
    if (role !== 'offline') return;
    if (!available()) {
      emitLocal('status', 'Open the host’s address (http://their-ip:' + (location.port || 3001) + '/app.html) to jam.');
      return;
    }
    address = (address || '').trim();
    let url = null;                                  // blank -> same relay we loaded from
    if (address) {
      if (/^https?:\/\//i.test(address)) url = address;
      else if (address.indexOf(':') !== -1) url = 'http://' + address;
      else url = 'http://' + address + ':' + (location.port || 3001);
    }

    socket = connect(url);
    wireCommon();
    emitLocal('status', 'Connecting' + (address ? ' to ' + address : '') + '…');

    socket.on('connect', function () {
      socket.emit('join-jam', { role: 'client', name: nameHint() });
    });
    socket.on('jam-role', function (d) {
      if (!d || d.role !== 'client') return;
      assignedId = d.id;
      setRole('client');
      emitLocal('status', 'Connected' + (address ? ' to ' + address : '') + '.');
      console.log('[Network] joined room as', assignedId);
    });
    socket.on('jam-host-gone', function () {
      if (role === 'client') {
        setRole('offline');
        emitLocal('status', 'Host left — back to solo (pattern kept).');
      }
    });
    socket.on('connect_error', function () {
      emitLocal('status', 'Can’t reach ' + (address || 'the host') + ' — same WiFi? Host running?');
    });
    socket.io.on('reconnect_failed', function () {
      emitLocal('status', 'Could not connect' + (address ? ' to ' + address : '') + '.');
      leave();
    });
    socket.on('disconnect', function () {
      if (role === 'client') {
        setRole('offline');
        emitLocal('status', 'Disconnected — back to solo (pattern kept).');
      }
    });
  }

  // ── shared ────────────────────────────────────────────────────────────────────

  function leave() {
    if (socket) { try { socket.close(); } catch (e) {} socket = null; }
    peers = 0; assignedId = null;
    emitLocal('peers', 0);
    if (role !== 'offline') {
      setRole('offline');
      emitLocal('status', 'Left the session.');
    }
  }

  // Host: relay broadcasts to every client. Client: relay forwards to the host.
  // Offline: no-op.
  function send(type, payload) {
    if (!socket) return;
    socket.emit('jam-msg', { type: type, payload: payload });
  }

  return {
    host: host,
    join: join,
    leave: leave,
    send: send,
    on: on,
    setSnapshotProvider: function (fn) { snapshotProvider = fn; },
    getLanIps: function () { return lanIps.slice(); },
    role: function () { return role; },
    peerCount: function () { return peers; },
    clientId: function () { return assignedId; },
  };
})();
