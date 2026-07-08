// src/data/profile.js
// -----------------------------------------------------------------------------
// Player accounts — now CROSS-DEVICE.
//
// When the app is served by the Cloudflare Worker (worker/auth.js), signup /
// login / rename / collection-sync all hit /auth/* and your account + collection
// follow you to any device. Signing up sends a confirmation email (Resend).
//
// When the backend isn't reachable (opened from a bare static server, offline,
// or before you've configured KV + Resend), Profile transparently falls back to
// the old DEVICE-LOCAL accounts (salted-hash in localStorage) so nothing breaks.
//
// Public API (unchanged, so ui.js/library.js don't care which mode we're in):
//   Profile.current()        -> { email, name } | null
//   Profile.displayName()    -> logged-in name, or the guest name, or 'Player'
//   Profile.storageSuffix()  -> ':email' when logged in, '' as guest
//   Profile.signup(email,pw)  / Profile.login(email,pw)   -> async
//   Profile.logout() / Profile.setName(name) / Profile.deleteAccount()
//   Profile.guestName() / Profile.setGuestName(name)
//   Profile.on('change', cb)
//   Profile.pushCollection(unlockedArray)   -> sync a change up (backend only)
//   Profile.isVerified() / Profile.resendVerification()
// -----------------------------------------------------------------------------

window.Profile = (function () {
  const TOKEN_KEY   = 'snapit.session.token.v1';  // backend bearer token
  const USER_KEY    = 'snapit.session.user.v1';   // cached public user (offline)
  const GUEST_KEY   = 'snapit.guestname.v1';
  const LIBRARY_KEY = 'snapit.library.v1';        // must match library.js
  const ACCOUNTS_KEY = 'snapit.accounts.v1';      // legacy device-local accounts
  const LOCAL_SESSION_KEY = 'snapit.session.v1';  // legacy device-local session

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let user  = null;   // cached public user { email, name, verified, collection }
  let mode  = null;   // 'backend' | 'local' | null

  // Restore the cached user synchronously so storageSuffix() is correct BEFORE
  // library.load() runs; the network refresh (init) happens right after.
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { user = null; }
  if (user) mode = token ? 'backend' : 'local';

  // ── events ──────────────────────────────────────────────────────────────────
  const handlers = {};
  function on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); }
  function fire(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[event] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { console.error('[Profile] handler error', e); }
    });
  }

  function cacheUser() {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  }

  // ── backend transport ─────────────────────────────────────────────────────
  // api() distinguishes "server said no" (validation — surface it) from "server
  // isn't there" (offline/unavailable — fall back to device-local accounts).
  async function api(path, payload) {
    let res;
    try {
      res = await fetch('/auth/' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    } catch (e) { const err = new Error('offline'); err.kind = 'offline'; throw err; }

    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (data === null) { const err = new Error('unavailable'); err.kind = 'unavailable'; throw err; }
    if (!res.ok) {
      if (res.status === 503) { const err = new Error('unavailable'); err.kind = 'unavailable'; throw err; }
      const err = new Error(data.error || ('Server error ' + res.status));
      err.kind = 'api'; err.status = res.status; throw err;
    }
    return data;
  }
  function offlineish(e) { return e && (e.kind === 'offline' || e.kind === 'unavailable'); }

  // ── collection helpers ───────────────────────────────────────────────────────
  function guestCollection() {
    try { return (JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}').unlocked) || []; }
    catch (e) { return []; }
  }
  // Write the account's collection into the per-account localStorage slot the
  // library reads (union with whatever's already there — never drop unlocks).
  function writeAccountCollection(email, arr) {
    try {
      const key = LIBRARY_KEY + ':' + email;
      const mine = (JSON.parse(localStorage.getItem(key) || '{}').unlocked) || [];
      const merged = Array.from(new Set(mine.concat(arr || [])));
      localStorage.setItem(key, JSON.stringify({ unlocked: merged }));
    } catch (e) { console.warn('[Profile] writeAccountCollection failed', e); }
  }

  // Adopt a signed-in backend user: cache it, land its collection locally, notify.
  function adoptBackendUser(newToken, u) {
    token = newToken; user = u; mode = 'backend';
    localStorage.setItem(TOKEN_KEY, token);
    cacheUser();
    writeAccountCollection(user.email, user.collection);
    fire('change', current());
  }

  // ── session bootstrap (runs once on load) ────────────────────────────────────
  async function init() {
    if (!token) return;
    try {
      const data = await api('me', { token: token });
      user = data.user; mode = 'backend'; cacheUser();
      writeAccountCollection(user.email, user.collection);
      fire('change', current());
    } catch (e) {
      if (e.kind === 'api') {          // token invalid/expired — sign out cleanly
        token = null; user = null; mode = null;
        localStorage.removeItem(TOKEN_KEY); cacheUser();
        fire('change', null);
      }
      // offlineish: keep the cached user; we're "logged in, offline".
    }
  }

  // ── hashing (device-local fallback only) ─────────────────────────────────────
  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function localHash(salt, password) {
    const data = new TextEncoder().encode(salt + ':' + password);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function loadAccounts() { try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; } catch (e) { return {}; } }
  function saveAccounts(a) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)); }
  function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

  // ── device-local implementations (fallback) ──────────────────────────────────
  async function localSignup(email, password) {
    if (!validEmail(email)) throw new Error('Enter a valid email.');
    if ((password || '').length < 6) throw new Error('Password needs at least 6 characters.');
    const accounts = loadAccounts();
    if (accounts[email]) throw new Error('That email already has an account — log in.');
    const salt = randomSalt();
    accounts[email] = { name: email.split('@')[0].slice(0, 24), salt: salt, hash: await localHash(salt, password), verified: true, createdAt: Date.now() };
    saveAccounts(accounts);
    writeAccountCollection(email, guestCollection());
    localStorage.setItem(LOCAL_SESSION_KEY, email);
    user = { email: email, name: accounts[email].name, verified: true, collection: [] };
    mode = 'local'; token = null; cacheUser();
    fire('change', current());
    return current();
  }
  async function localLogin(email, password) {
    const acc = loadAccounts()[email];
    if (!acc) throw new Error('No account with that email — create one.');
    if (await localHash(acc.salt, password) !== acc.hash) throw new Error('Wrong password.');
    writeAccountCollection(email, guestCollection());
    localStorage.setItem(LOCAL_SESSION_KEY, email);
    user = { email: email, name: acc.name, verified: true, collection: [] };
    mode = 'local'; token = null; cacheUser();
    fire('change', current());
    return current();
  }

  // ── public actions ───────────────────────────────────────────────────────────
  async function signup(email, password) {
    email = (email || '').trim().toLowerCase();
    try {
      const data = await api('signup', { email: email, password: password, collection: guestCollection() });
      adoptBackendUser(data.token, data.user);
      return current();
    } catch (e) {
      if (offlineish(e)) return localSignup(email, password);
      throw e;
    }
  }

  async function login(email, password) {
    email = (email || '').trim().toLowerCase();
    try {
      const data = await api('login', { email: email, password: password, collection: guestCollection() });
      adoptBackendUser(data.token, data.user);
      return current();
    } catch (e) {
      if (offlineish(e)) return localLogin(email, password);
      throw e;
    }
  }

  function logout() {
    if (mode === 'backend' && token) { api('logout', { token: token }).catch(function () {}); }
    localStorage.removeItem(LOCAL_SESSION_KEY);
    token = null; user = null; mode = null;
    localStorage.removeItem(TOKEN_KEY); cacheUser();
    fire('change', null);
  }

  async function setName(name) {
    name = (name || '').trim().slice(0, 24);
    if (!name) throw new Error("Name can't be empty.");
    if (!user) throw new Error('Log in first.');
    if (mode === 'backend' && token) {
      try {
        const data = await api('name', { token: token, name: name });
        user = data.user; cacheUser(); fire('change', current());
        return current();
      } catch (e) { if (!offlineish(e)) throw e; /* offline: fall through to local update */ }
    } else {
      const accounts = loadAccounts();
      if (accounts[user.email]) { accounts[user.email].name = name; saveAccounts(accounts); }
    }
    user.name = name; cacheUser(); fire('change', current());
    return current();
  }

  function deleteAccount() {
    if (!user) throw new Error('Log in first.');
    const email = user.email;
    if (mode === 'backend' && token) { api('delete', { token: token }).catch(function () {}); }
    else {
      const accounts = loadAccounts(); delete accounts[email]; saveAccounts(accounts);
      localStorage.removeItem(LOCAL_SESSION_KEY);
    }
    try { localStorage.removeItem(LIBRARY_KEY + ':' + email); } catch (e) {}
    token = null; user = null; mode = null;
    localStorage.removeItem(TOKEN_KEY); cacheUser();
    fire('change', null);
  }

  // ── collection sync up (backend only, debounced) ─────────────────────────────
  let pushTimer = null, pending = null;
  function pushCollection(unlocked) {
    if (mode !== 'backend' || !token) return;      // local mode already persists
    pending = (unlocked || []).slice();
    if (pushTimer) return;
    pushTimer = setTimeout(function () {
      pushTimer = null; const col = pending; pending = null;
      api('collection', { token: token, collection: col }).then(function (data) {
        if (user) { user.collection = data.collection; cacheUser(); }
      }).catch(function () { /* offline: it's still saved locally, resync on next login */ });
    }, 800);
  }

  // ── guest name (always device-local) ─────────────────────────────────────────
  function guestName() { return localStorage.getItem(GUEST_KEY) || ''; }
  function setGuestName(name) {
    name = (name || '').trim().slice(0, 24);
    if (name) localStorage.setItem(GUEST_KEY, name);
    else localStorage.removeItem(GUEST_KEY);
    fire('change', current());
    return name;
  }

  // ── read helpers ──────────────────────────────────────────────────────────────
  function current() { return user ? { email: user.email, name: user.name } : null; }
  function displayName() { return user ? user.name : (guestName() || 'Player'); }
  function storageSuffix() { return user ? ':' + user.email : ''; }
  function isVerified() { return !user || !!user.verified; }
  function resendVerification() {
    if (user && mode === 'backend') api('resend', { email: user.email }).catch(function () {});
  }

  // Kick off the async session refresh (non-blocking).
  init();

  return {
    on: on,
    current: current,
    displayName: displayName,
    storageSuffix: storageSuffix,
    signup: signup,
    login: login,
    logout: logout,
    setName: setName,
    deleteAccount: deleteAccount,
    guestName: guestName,
    setGuestName: setGuestName,
    pushCollection: pushCollection,
    isVerified: isVerified,
    resendVerification: resendVerification,
  };
})();
