// worker/jam-worker.js
// -----------------------------------------------------------------------------
// Cloudflare Worker: serves the static app and runs the jam relay over WSS, so
// "Host / Join" works straight from the published site (no mixed-content issues,
// no server for the host to run). Each room is one Durable Object instance.
//
// Same JSON wire protocol as the local jam-server.js, so src/multiplayer/
// network.js talks to either without changes:
//   client -> {t:'join', role, name}         (room is the ?room= query)
//   server -> {t:'role'|'denied'|'peer-joined'|'peer-left'|'host-gone'|'status'}
//   either -> {t:'msg', target?, mtype, payload}  -> {t:'msg', from, mtype, payload}
//
// Deploy:  npx wrangler deploy   (see wrangler.toml + DEPLOY.md)
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/jam') {
      const room = (url.searchParams.get('room') || 'MAIN').toUpperCase();
      const id = env.JAM_ROOMS.idFromName(room);
      return env.JAM_ROOMS.get(id).fetch(request);
    }
    // Everything else is a static asset (app.html, src/…, samples/…).
    return env.ASSETS.fetch(request);
  },
};

// One instance per room code. Holds the authority (host) + client sockets and
// relays messages between them — the browser tabs never talk directly.
export class JamRoom {
  constructor(state, env) {
    this.host = null;              // host WebSocket (the authority)
    this.clients = new Map();      // id -> client WebSocket
    this.nextId = 1;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const room = (new URL(request.url).searchParams.get('room') || 'MAIN').toUpperCase();
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.wire(server, room);
    return new Response(null, { status: 101, webSocket: client });
  }

  wire(ws, room) {
    const data = { role: null, id: 'c' + (this.nextId++), name: 'Player' };
    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (e) {} };

    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.t === 'join') {
        if (m.role === 'host') {
          if (this.host && this.host !== ws) { send({ t: 'denied', reason: 'someone is already hosting room ' + room }); return; }
          this.host = ws; data.role = 'host';
          send({ t: 'role', role: 'host', id: 'host', room });
          for (const [id, c] of this.clients) send({ t: 'peer-joined', id, name: c._name || 'Player' });
        } else {
          data.role = 'client'; data.name = m.name || 'Player';
          ws._name = data.name; ws._id = data.id;
          this.clients.set(data.id, ws);
          send({ t: 'role', role: 'client', id: data.id, room });
          if (this.host) this.host.send(JSON.stringify({ t: 'peer-joined', id: data.id, name: data.name }));
          else send({ t: 'status', text: 'Waiting for a host to start room ' + room + '…' });
        }
        return;
      }

      if (m.t === 'msg') {
        if (data.role === 'host') {
          const wrapped = JSON.stringify({ t: 'msg', from: 'host', mtype: m.mtype, payload: m.payload });
          if (m.target) { const c = this.clients.get(m.target); if (c) c.send(wrapped); }
          else for (const c of this.clients.values()) c.send(wrapped);
        } else if (data.role === 'client') {
          if (this.host) this.host.send(JSON.stringify({ t: 'msg', from: data.id, mtype: m.mtype, payload: m.payload }));
        }
      }
    });

    const cleanup = () => {
      if (data.role === 'host') {
        if (this.host === ws) this.host = null;
        for (const c of this.clients.values()) { try { c.send(JSON.stringify({ t: 'host-gone' })); } catch (e) {} }
      } else if (data.role === 'client') {
        this.clients.delete(data.id);
        if (this.host) { try { this.host.send(JSON.stringify({ t: 'peer-left', id: data.id })); } catch (e) {} }
      }
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }
}
