var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/auth.js
var SESSION_TTL = 60 * 60 * 24 * 30;
var VERIFY_TTL = 60 * 60 * 24;
var PBKDF2_ITERS = 15e4;
function cors(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  };
}
__name(cors, "cors");
function json(data, request, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors(request))
  });
}
__name(json, "json");
function hex(buf) {
  return Array.from(new Uint8Array(buf)).map(function(b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}
__name(hex, "hex");
function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
__name(randomToken, "randomToken");
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
__name(validEmail, "validEmail");
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(function(h) {
    return parseInt(h, 16);
  }));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    key,
    256
  );
  return hex(bits);
}
__name(hashPassword, "hashPassword");
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
function userKey(email) {
  return "user:" + email;
}
__name(userKey, "userKey");
async function loadUser(env, email) {
  const raw = await env.USERS.get(userKey(email));
  return raw ? JSON.parse(raw) : null;
}
__name(loadUser, "loadUser");
function saveUser(env, user) {
  return env.USERS.put(userKey(user.email), JSON.stringify(user));
}
__name(saveUser, "saveUser");
function publicUser(user) {
  return { email: user.email, name: user.name, verified: !!user.verified, collection: user.collection || [] };
}
__name(publicUser, "publicUser");
async function sessionEmail(env, token) {
  if (!token) return null;
  return env.USERS.get("session:" + token);
}
__name(sessionEmail, "sessionEmail");
async function sendVerifyEmail(env, email, token) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log("[auth] Resend not configured \u2014 skipping confirmation email for", email);
    return false;
  }
  const base = (env.APP_URL || "").replace(/\/$/, "");
  const link = base + "/auth/verify?token=" + token;
  const html = '<div style="font-family:system-ui,sans-serif;max-width:460px;margin:0 auto"><h2 style="margin:0 0 8px">Confirm your Snap It account</h2><p style="color:#555;line-height:1.5">Tap the button to confirm this email and finish creating your account.</p><p style="margin:20px 0"><a href="' + link + `" style="background:#E67E22;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">Confirm my account</a></p><p style="color:#999;font-size:12px">If you didn't create a Snap It account, you can ignore this email.</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: "Confirm your Snap It account", html })
    });
    if (!res.ok) {
      console.warn("[auth] Resend failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[auth] Resend error", e);
    return false;
  }
}
__name(sendVerifyEmail, "sendVerifyEmail");
async function handleAuth(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors(request) });
  if (!env.USERS) {
    return json({ error: "Accounts are not configured on this server yet." }, request, 503);
  }
  const path = url.pathname;
  if (path === "/auth/verify" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    const email = token ? await env.USERS.get("verify:" + token) : null;
    const page = /* @__PURE__ */ __name(function(msg) {
      return new Response(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px"><h1 style="font-size:22px">' + msg + '</h1><p><a href="' + ((env.APP_URL || "/").replace(/\/$/, "") + "/app.html") + '" style="color:#E67E22;font-weight:700">Open Snap It</a></p></div>',
        { headers: { "Content-Type": "text/html" } }
      );
    }, "page");
    if (!email) return page("This confirmation link is invalid or has expired.");
    const user = await loadUser(env, email);
    if (!user) return page("Account not found.");
    user.verified = true;
    await saveUser(env, user);
    await env.USERS.delete("verify:" + token);
    return page("\u2713 Email confirmed \u2014 your account is ready.");
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, request, 405);
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  if (path === "/auth/signup") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!validEmail(email)) return json({ error: "Enter a valid email." }, request, 400);
    if (password.length < 6) return json({ error: "Password needs at least 6 characters." }, request, 400);
    if (await loadUser(env, email)) return json({ error: "That email already has an account \u2014 log in." }, request, 409);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const guestCollection = Array.isArray(body.collection) ? body.collection.slice(0, 500) : [];
    const user = {
      email,
      name: (String(body.name || "").trim() || email.split("@")[0]).slice(0, 24),
      salt,
      hash: await hashPassword(password, salt),
      verified: false,
      createdAt: Date.now(),
      collection: guestCollection
    };
    await saveUser(env, user);
    const verifyToken = randomToken();
    await env.USERS.put("verify:" + verifyToken, email, { expirationTtl: VERIFY_TTL });
    const sent = await sendVerifyEmail(env, email, verifyToken);
    const token = randomToken();
    await env.USERS.put("session:" + token, email, { expirationTtl: SESSION_TTL });
    return json({ ok: true, token, user: publicUser(user), emailSent: sent }, request);
  }
  if (path === "/auth/login") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = await loadUser(env, email);
    if (!user) return json({ error: "No account with that email \u2014 create one." }, request, 404);
    const attempt = await hashPassword(password, user.salt);
    if (!safeEqual(attempt, user.hash)) return json({ error: "Wrong password." }, request, 401);
    if (Array.isArray(body.collection) && body.collection.length) {
      const merged = Array.from(new Set((user.collection || []).concat(body.collection)));
      user.collection = merged.slice(0, 500);
      await saveUser(env, user);
    }
    const token = randomToken();
    await env.USERS.put("session:" + token, email, { expirationTtl: SESSION_TTL });
    return json({ ok: true, token, user: publicUser(user) }, request);
  }
  if (path === "/auth/me") {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: "not logged in" }, request, 401);
    const user = await loadUser(env, email);
    if (!user) return json({ error: "account gone" }, request, 404);
    return json({ ok: true, user: publicUser(user) }, request);
  }
  if (path === "/auth/logout") {
    if (body.token) await env.USERS.delete("session:" + body.token);
    return json({ ok: true }, request);
  }
  if (path === "/auth/name") {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: "not logged in" }, request, 401);
    const user = await loadUser(env, email);
    if (!user) return json({ error: "account gone" }, request, 404);
    const name = String(body.name || "").trim().slice(0, 24);
    if (!name) return json({ error: "Name can't be empty." }, request, 400);
    user.name = name;
    await saveUser(env, user);
    return json({ ok: true, user: publicUser(user) }, request);
  }
  if (path === "/auth/collection") {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: "not logged in" }, request, 401);
    const user = await loadUser(env, email);
    if (!user) return json({ error: "account gone" }, request, 404);
    if (Array.isArray(body.collection)) {
      const merged = Array.from(new Set((user.collection || []).concat(body.collection)));
      user.collection = merged.slice(0, 500);
      await saveUser(env, user);
    }
    return json({ ok: true, collection: user.collection || [] }, request);
  }
  if (path === "/auth/resend") {
    const email = String(body.email || "").trim().toLowerCase();
    const user = await loadUser(env, email);
    if (user && !user.verified) {
      const verifyToken = randomToken();
      await env.USERS.put("verify:" + verifyToken, email, { expirationTtl: VERIFY_TTL });
      await sendVerifyEmail(env, email, verifyToken);
    }
    return json({ ok: true }, request);
  }
  if (path === "/auth/delete") {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: "not logged in" }, request, 401);
    await env.USERS.delete(userKey(email));
    await env.USERS.delete("session:" + body.token);
    return json({ ok: true }, request);
  }
  return json({ error: "unknown endpoint" }, request, 404);
}
__name(handleAuth, "handleAuth");

// worker/jam-worker.js
var jam_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/jam") {
      const room = (url.searchParams.get("room") || "MAIN").toUpperCase();
      const id = env.JAM_ROOMS.idFromName(room);
      return env.JAM_ROOMS.get(id).fetch(request);
    }
    if (url.pathname.startsWith("/auth/")) {
      return handleAuth(request, env, url);
    }
    return env.ASSETS.fetch(request);
  }
};
var JamRoom = class {
  static {
    __name(this, "JamRoom");
  }
  constructor(state, env) {
    this.host = null;
    this.clients = /* @__PURE__ */ new Map();
    this.nextId = 1;
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const room = (new URL(request.url).searchParams.get("room") || "MAIN").toUpperCase();
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.wire(server, room);
    return new Response(null, { status: 101, webSocket: client });
  }
  wire(ws, room) {
    const data = { role: null, id: "c" + this.nextId++, name: "Player" };
    const send = /* @__PURE__ */ __name((obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
      }
    }, "send");
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.t === "join") {
        if (m.role === "host") {
          if (this.host && this.host !== ws) {
            send({ t: "denied", reason: "someone is already hosting room " + room });
            return;
          }
          this.host = ws;
          data.role = "host";
          send({ t: "role", role: "host", id: "host", room });
          for (const [id, c] of this.clients) send({ t: "peer-joined", id, name: c._name || "Player" });
        } else {
          data.role = "client";
          data.name = m.name || "Player";
          ws._name = data.name;
          ws._id = data.id;
          this.clients.set(data.id, ws);
          send({ t: "role", role: "client", id: data.id, room });
          if (this.host) this.host.send(JSON.stringify({ t: "peer-joined", id: data.id, name: data.name }));
          else send({ t: "status", text: "Waiting for a host to start room " + room + "\u2026" });
        }
        return;
      }
      if (m.t === "msg") {
        if (data.role === "host") {
          const wrapped = JSON.stringify({ t: "msg", from: "host", mtype: m.mtype, payload: m.payload });
          if (m.target) {
            const c = this.clients.get(m.target);
            if (c) c.send(wrapped);
          } else for (const c of this.clients.values()) c.send(wrapped);
        } else if (data.role === "client") {
          if (this.host) this.host.send(JSON.stringify({ t: "msg", from: data.id, mtype: m.mtype, payload: m.payload }));
        }
      }
    });
    const cleanup = /* @__PURE__ */ __name(() => {
      if (data.role === "host") {
        if (this.host === ws) this.host = null;
        for (const c of this.clients.values()) {
          try {
            c.send(JSON.stringify({ t: "host-gone" }));
          } catch (e) {
          }
        }
      } else if (data.role === "client") {
        this.clients.delete(data.id);
        if (this.host) {
          try {
            this.host.send(JSON.stringify({ t: "peer-left", id: data.id }));
          } catch (e) {
          }
        }
      }
    }, "cleanup");
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }
};
export {
  JamRoom,
  jam_worker_default as default
};
//# sourceMappingURL=jam-worker.js.map
