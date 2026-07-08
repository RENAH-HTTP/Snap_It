// worker/auth.js
// -----------------------------------------------------------------------------
// Cross-device player accounts for Snap It, served from the same Cloudflare
// Worker as the app + jam relay. Handles everything under /auth/*.
//
// Storage: ONE Workers KV namespace (binding `USERS`), holding three key kinds:
//   user:<email>       -> { email, name, salt, hash, verified, createdAt, collection[] }
//   session:<token>    -> email        (TTL ~30d; the logged-in cookie/bearer)
//   verify:<token>     -> email        (TTL ~24h; the email-confirmation link)
//
// Passwords are PBKDF2-SHA256 (150k iterations) with a random per-user salt, so
// only a salted hash is ever stored. Tokens are 32 random bytes, hex-encoded.
//
// Email confirmation goes out via Resend. It is OPTIONAL at runtime: if
// RESEND_API_KEY / MAIL_FROM aren't configured the account is still created and
// usable — it just stays "unverified" and no mail is sent (handy for local dev).
//
// Required bindings/vars (see wrangler.toml + DEPLOY.md):
//   [[kv_namespaces]] binding = "USERS"
//   vars: APP_URL (e.g. https://snap-it.example.com), MAIL_FROM (verified sender)
//   secret: RESEND_API_KEY  (wrangler secret put RESEND_API_KEY)
// -----------------------------------------------------------------------------

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const VERIFY_TTL  = 60 * 60 * 24;      // 24 hours
const PBKDF2_ITERS = 150000;

// ── small helpers ────────────────────────────────────────────────────────────

function cors(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

function json(data, request, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors(request)),
  });
}

function hex(buf) {
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(function (h) { return parseInt(h, 16); }));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    key, 256
  );
  return hex(bits);
}

// Constant-time-ish compare (both are fixed-length hex of a hash).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function userKey(email) { return 'user:' + email; }

async function loadUser(env, email) {
  const raw = await env.USERS.get(userKey(email));
  return raw ? JSON.parse(raw) : null;
}

function saveUser(env, user) {
  return env.USERS.put(userKey(user.email), JSON.stringify(user));
}

// A user record minus the secrets, safe to hand to the browser.
function publicUser(user) {
  return { email: user.email, name: user.name, verified: !!user.verified, collection: user.collection || [] };
}

async function sessionEmail(env, token) {
  if (!token) return null;
  return env.USERS.get('session:' + token);
}

// ── email (Resend) ───────────────────────────────────────────────────────────

async function sendVerifyEmail(env, email, token) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log('[auth] Resend not configured — skipping confirmation email for', email);
    return false;
  }
  const base = (env.APP_URL || '').replace(/\/$/, '');
  const link = base + '/auth/verify?token=' + token;
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:460px;margin:0 auto">' +
    '<h2 style="margin:0 0 8px">Confirm your Snap It account</h2>' +
    '<p style="color:#555;line-height:1.5">Tap the button to confirm this email and finish creating your account.</p>' +
    '<p style="margin:20px 0"><a href="' + link + '" style="background:#E67E22;color:#fff;' +
    'text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">' +
    'Confirm my account</a></p>' +
    '<p style="color:#999;font-size:12px">If you didn\'t create a Snap It account, you can ignore this email.</p>' +
    '</div>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Confirm your Snap It account', html: html }),
    });
    if (!res.ok) { console.warn('[auth] Resend failed', res.status, await res.text()); return false; }
    return true;
  } catch (e) {
    console.warn('[auth] Resend error', e);
    return false;
  }
}

// ── route handler (exported; wired from jam-worker.js) ───────────────────────

export async function handleAuth(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request) });

  if (!env.USERS) {
    return json({ error: 'Accounts are not configured on this server yet.' }, request, 503);
  }

  const path = url.pathname;

  // GET /auth/verify?token=... — the link in the confirmation email.
  if (path === '/auth/verify' && request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const email = token ? await env.USERS.get('verify:' + token) : null;
    const page = function (msg) {
      return new Response(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<div style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px">' +
        '<h1 style="font-size:22px">' + msg + '</h1>' +
        '<p><a href="' + ((env.APP_URL || '/').replace(/\/$/, '') + '/app.html') + '" ' +
        'style="color:#E67E22;font-weight:700">Open Snap It</a></p></div>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    };
    if (!email) return page('This confirmation link is invalid or has expired.');
    const user = await loadUser(env, email);
    if (!user) return page('Account not found.');
    user.verified = true;
    await saveUser(env, user);
    await env.USERS.delete('verify:' + token);
    return page('✓ Email confirmed — your account is ready.');
  }

  // Everything else is a JSON POST.
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, request, 405);

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }

  // POST /auth/signup { email, password, name? }
  if (path === '/auth/signup') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!validEmail(email)) return json({ error: 'Enter a valid email.' }, request, 400);
    if (password.length < 6) return json({ error: 'Password needs at least 6 characters.' }, request, 400);
    if (await loadUser(env, email)) return json({ error: 'That email already has an account — log in.' }, request, 409);

    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const guestCollection = Array.isArray(body.collection) ? body.collection.slice(0, 500) : [];
    const user = {
      email: email,
      name: (String(body.name || '').trim() || email.split('@')[0]).slice(0, 24),
      salt: salt,
      hash: await hashPassword(password, salt),
      verified: false,
      createdAt: Date.now(),
      collection: guestCollection,
    };
    await saveUser(env, user);

    // Fire off the confirmation email (best-effort).
    const verifyToken = randomToken();
    await env.USERS.put('verify:' + verifyToken, email, { expirationTtl: VERIFY_TTL });
    const sent = await sendVerifyEmail(env, email, verifyToken);

    // Log them in immediately (a bad email shouldn't lock them out); the UI
    // shows an "unconfirmed" note until they click the link.
    const token = randomToken();
    await env.USERS.put('session:' + token, email, { expirationTtl: SESSION_TTL });
    return json({ ok: true, token: token, user: publicUser(user), emailSent: sent }, request);
  }

  // POST /auth/login { email, password }
  if (path === '/auth/login') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = await loadUser(env, email);
    if (!user) return json({ error: 'No account with that email — create one.' }, request, 404);
    const attempt = await hashPassword(password, user.salt);
    if (!safeEqual(attempt, user.hash)) return json({ error: 'Wrong password.' }, request, 401);

    // Fold in any guest collection the client scanned before logging in.
    if (Array.isArray(body.collection) && body.collection.length) {
      const merged = Array.from(new Set((user.collection || []).concat(body.collection)));
      user.collection = merged.slice(0, 500);
      await saveUser(env, user);
    }

    const token = randomToken();
    await env.USERS.put('session:' + token, email, { expirationTtl: SESSION_TTL });
    return json({ ok: true, token: token, user: publicUser(user) }, request);
  }

  // POST /auth/me { token } — resume a session.
  if (path === '/auth/me') {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: 'not logged in' }, request, 401);
    const user = await loadUser(env, email);
    if (!user) return json({ error: 'account gone' }, request, 404);
    return json({ ok: true, user: publicUser(user) }, request);
  }

  // POST /auth/logout { token }
  if (path === '/auth/logout') {
    if (body.token) await env.USERS.delete('session:' + body.token);
    return json({ ok: true }, request);
  }

  // POST /auth/name { token, name }
  if (path === '/auth/name') {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: 'not logged in' }, request, 401);
    const user = await loadUser(env, email);
    if (!user) return json({ error: 'account gone' }, request, 404);
    const name = String(body.name || '').trim().slice(0, 24);
    if (!name) return json({ error: "Name can't be empty." }, request, 400);
    user.name = name;
    await saveUser(env, user);
    return json({ ok: true, user: publicUser(user) }, request);
  }

  // POST /auth/collection { token, collection? } — push a new collection (merge),
  // always returns the authoritative merged list so devices converge.
  if (path === '/auth/collection') {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: 'not logged in' }, request, 401);
    const user = await loadUser(env, email);
    if (!user) return json({ error: 'account gone' }, request, 404);
    if (Array.isArray(body.collection)) {
      const merged = Array.from(new Set((user.collection || []).concat(body.collection)));
      user.collection = merged.slice(0, 500);
      await saveUser(env, user);
    }
    return json({ ok: true, collection: user.collection || [] }, request);
  }

  // POST /auth/resend { email } — re-send the confirmation email.
  if (path === '/auth/resend') {
    const email = String(body.email || '').trim().toLowerCase();
    const user = await loadUser(env, email);
    if (user && !user.verified) {
      const verifyToken = randomToken();
      await env.USERS.put('verify:' + verifyToken, email, { expirationTtl: VERIFY_TTL });
      await sendVerifyEmail(env, email, verifyToken);
    }
    // Always report ok, so this can't be used to probe which emails exist.
    return json({ ok: true }, request);
  }

  // POST /auth/delete { token } — remove the account and its session.
  if (path === '/auth/delete') {
    const email = await sessionEmail(env, body.token);
    if (!email) return json({ error: 'not logged in' }, request, 401);
    await env.USERS.delete(userKey(email));
    await env.USERS.delete('session:' + body.token);
    return json({ ok: true }, request);
  }

  return json({ error: 'unknown endpoint' }, request, 404);
}
