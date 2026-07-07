// src/multiplayer/network.js
// -----------------------------------------------------------------------------
// Transport layer for jam sessions — native WebSocket, host-anywhere.
//
// The app is a static site. Jam messages travel through a relay reachable at the
// SAME origin the app was loaded from, on the path /jam:
//   - published on Cloudflare -> wss://<site>/jam  (a Worker + Durable Object)
//   - run locally (npm start)  -> ws://<lan-ip>:3001/jam  (jam-server.js)
// Same browser code either way; no socket.io, nothing to bundle.
//
// A session is a ROOM addressed by a short code. The first peer to Host claims
// the room and becomes the authority; everyone else is a client of the relay.
//
// Public API (attached to window) — the shape jam.js/ui.js expect:
//   Network.host()                 -> claim a fresh room (auto room code)
//   Network.join(code)             -> join a room by its code
//   Network.leave()                -> disconnect
//   Network.send(type, payload)    -> host: to all clients / client: to host
//   Network.on(event, cb)          -> 'message'(msg,fromId) 'role' 'status'
//                                     'peers' 'peerJoined' 'peerLeft'
//   Network.setSnapshotProvider(fn)-> host sends fn() to each client as it joins
//   Network.role()  peerCount()  clientId()
//   Network.getLanIps()            -> LAN URLs to reach a LOCAL host (host side)
//   Network.getRoomCode()          -> the current room's code
// -----------------------------------------------------------------------------

window.Network = (() => {

  let role = 'offline';       // 'offline' | 'host' | 'client'
  let ws = null;              // native WebSocket to the relay
  let peers = 0;              // connected clients (host side)
  let assignedId = null;      // our id in the room (client side)
  let roomCode = null;        // current room code
  let lanIps = [];            // LAN IPs of a LOCAL relay (host side; empty on cloud)
  let snapshotProvider = null;

  const handlers = {};

  function on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); }
  function emitLocal(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[event] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { console.error('[Network] handler error', e); }
    });
  }
  function setRole(r) { role = r; emitLocal('role', role); }

  function newRoomCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
    let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  function relayUrl(code) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + location.host + '/jam?room=' + encodeURIComponent(code);
  }

  function nameHint() {
    try { if (window.Profile && Profile.current && Profile.current()) return Profile.displayName(); } catch (e) {}
    return 'Player';
  }

  function send_(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // Relay -> here. Common to host and client.
  function handleFrame(m) {
    switch (m.t) {
      case 'role':
        roomCode = m.room || roomCode;
        if (m.role === 'host') {
          lanIps = m.lanIps || [];
          peers = 0; setRole('host'); emitLocal('peers', 0);
          emitLocal('status', 'Hosting room ' + roomCode + ' — share the code.');
        } else {
          assignedId = m.id; setRole('client');
          emitLocal('status', 'Joined room ' + roomCode + '.');
        }
        break;
      case 'denied':
        emitLocal('status', 'Couldn’t host — ' + (m.reason || 'try another code') + '.');
        leave();
        break;
      case 'peer-joined':
        peers++; emitLocal('peers', peers);
        if (snapshotProvider) send_({ t: 'msg', target: m.id, mtype: 'state', payload: snapshotProvider() });
        emitLocal('peerJoined', m.id);
        break;
      case 'peer-left':
        peers = Math.max(0, peers - 1); emitLocal('peers', peers); emitLocal('peerLeft', m.id);
        break;
      case 'host-gone':
        if (role === 'client') { setRole('offline'); emitLocal('status', 'Host left — back to solo (pattern kept).'); }
        break;
      case 'status':
        emitLocal('status', m.text || '');
        break;
      case 'msg':
        emitLocal('message', { type: m.mtype, payload: m.payload }, m.from);
        break;
    }
  }

  function openSocket(code, joinRole) {
    let sock;
    try { sock = new WebSocket(relayUrl(code)); }
    catch (e) { emitLocal('status', 'Jam unavailable here.'); return null; }
    ws = sock;
    sock.onopen = function () { send_({ t: 'join', role: joinRole, name: nameHint() }); };
    sock.onmessage = function (ev) { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handleFrame(m); };
    sock.onerror = function () {
      emitLocal('status', joinRole === 'host'
        ? 'Jam relay unreachable — is the server running?'
        : 'Can’t reach room ' + code + ' — same site & code?');
    };
    sock.onclose = function () {
      if (role === 'client') { setRole('offline'); emitLocal('status', 'Disconnected — back to solo (pattern kept).'); }
      else if (role === 'host') { setRole('offline'); emitLocal('peers', 0); emitLocal('status', 'Stopped hosting.'); }
    };
    return sock;
  }

  function host() {
    if (role !== 'offline') return;
    roomCode = newRoomCode();
    emitLocal('status', 'Starting room ' + roomCode + '…');
    openSocket(roomCode, 'host');
  }

  function join(code) {
    if (role !== 'offline') return;
    code = (code || '').trim().toUpperCase() || 'MAIN';
    roomCode = code;
    emitLocal('status', 'Joining room ' + code + '…');
    openSocket(code, 'client');
  }

  function leave() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    peers = 0; assignedId = null;
    emitLocal('peers', 0);
    if (role !== 'offline') { setRole('offline'); emitLocal('status', 'Left the session.'); }
    roomCode = null;
  }

  // Host: relay broadcasts to clients. Client: relay forwards to host.
  function send(type, payload) { send_({ t: 'msg', mtype: type, payload: payload }); }

  return {
    host: host,
    join: join,
    leave: leave,
    send: send,
    on: on,
    setSnapshotProvider: function (fn) { snapshotProvider = fn; },
    getLanIps: function () { return lanIps.slice(); },
    getRoomCode: function () { return roomCode; },
    role: function () { return role; },
    peerCount: function () { return peers; },
    clientId: function () { return assignedId; },
  };
})();
