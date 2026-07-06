// src/data/profile.js
// -----------------------------------------------------------------------------
// Player accounts — device-local email + password login.
//
// Accounts live in localStorage (passwords stored as salted SHA-256 hashes, so
// nothing readable sits on disk). This gives each player on a shared machine
// their own collection and a display name that shows up in jam sessions.
//
// NOTE: this is deliberately local-first. When a real Firebase project exists,
// swap the storage calls here for Firebase Auth/Firestore (see data/firebase.js)
// without touching any caller — the API is designed to survive that move.
//
// Public API (attached to window):
//   Profile.current()        -> { email, name } | null
//   Profile.displayName()    -> name of the logged-in player, or 'Player'
//   Profile.storageSuffix()  -> ':email' when logged in, '' as guest (library
//                               uses this to keep one collection per account)
//   Profile.signup(email, password)  -> async; create account + log in
//   Profile.login(email, password)   -> async; verify + log in
//   Profile.logout()
//   Profile.setName(name)    -> rename the logged-in player
//   Profile.on('change', cb) -> cb(current) after login/logout/rename
// -----------------------------------------------------------------------------

window.Profile = (function () {
  const ACCOUNTS_KEY = 'snapit.accounts.v1';
  const SESSION_KEY  = 'snapit.session.v1';
  const LIBRARY_KEY  = 'snapit.library.v1'; // must match library.js

  let sessionEmail = localStorage.getItem(SESSION_KEY) || null;

  const handlers = {};
  function on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); }
  function fire(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[event] || []).forEach(function (cb) {
      try { cb.apply(null, args); } catch (e) { console.error('[Profile] handler error', e); }
    });
  }

  // ---- storage ----------------------------------------------------------------

  function loadAccounts() {
    try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function saveAccounts(accounts) {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  }

  // ---- hashing ------------------------------------------------------------------

  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  async function hash(salt, password) {
    const data = new TextEncoder().encode(salt + ':' + password);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // ---- session ------------------------------------------------------------------

  function current() {
    if (!sessionEmail) return null;
    const acc = loadAccounts()[sessionEmail];
    return acc ? { email: sessionEmail, name: acc.name } : null;
  }

  // Passwordless per-device player name (used when nobody is logged in).
  const GUEST_KEY = 'snapit.guestname.v1';

  function guestName() {
    return localStorage.getItem(GUEST_KEY) || '';
  }

  function setGuestName(name) {
    name = (name || '').trim().slice(0, 24);
    if (name) localStorage.setItem(GUEST_KEY, name);
    else localStorage.removeItem(GUEST_KEY);
    fire('change', current());
    return name;
  }

  function displayName() {
    const c = current();
    return c ? c.name : (guestName() || 'Player');
  }

  function storageSuffix() {
    return current() ? ':' + sessionEmail : '';
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // Logging in shouldn't lose sounds scanned as a guest: fold the guest
  // collection into the account's collection (a union — nothing is dropped).
  function mergeGuestCollection(email) {
    try {
      const guest = (JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}').unlocked) || [];
      if (!guest.length) return;
      const userKey = LIBRARY_KEY + ':' + email;
      const mine = (JSON.parse(localStorage.getItem(userKey) || '{}').unlocked) || [];
      const merged = Array.from(new Set(mine.concat(guest)));
      localStorage.setItem(userKey, JSON.stringify({ unlocked: merged }));
    } catch (e) {
      console.warn('[Profile] guest merge failed', e);
    }
  }

  // ---- actions --------------------------------------------------------------------

  async function signup(email, password) {
    email = (email || '').trim().toLowerCase();
    if (!validEmail(email)) throw new Error('Enter a valid email.');
    if ((password || '').length < 6) throw new Error('Password needs at least 6 characters.');

    const accounts = loadAccounts();
    if (accounts[email]) throw new Error('That email already has an account — log in.');

    const salt = randomSalt();
    accounts[email] = {
      name: email.split('@')[0].slice(0, 24),
      salt: salt,
      hash: await hash(salt, password),
      createdAt: Date.now(),
    };
    saveAccounts(accounts);

    sessionEmail = email;
    localStorage.setItem(SESSION_KEY, email);
    mergeGuestCollection(email);
    console.log('[Profile] account created:', email);
    fire('change', current());
    return current();
  }

  async function login(email, password) {
    email = (email || '').trim().toLowerCase();
    const acc = loadAccounts()[email];
    if (!acc) throw new Error('No account with that email — create one.');
    if (await hash(acc.salt, password) !== acc.hash) throw new Error('Wrong password.');

    sessionEmail = email;
    localStorage.setItem(SESSION_KEY, email);
    mergeGuestCollection(email);
    console.log('[Profile] logged in:', email);
    fire('change', current());
    return current();
  }

  function logout() {
    sessionEmail = null;
    localStorage.removeItem(SESSION_KEY);
    console.log('[Profile] logged out');
    fire('change', null);
  }

  // Permanently remove the logged-in account AND its collection.
  function deleteAccount() {
    if (!sessionEmail) throw new Error('Log in first.');
    const email = sessionEmail;
    const accounts = loadAccounts();
    delete accounts[email];
    saveAccounts(accounts);
    try { localStorage.removeItem(LIBRARY_KEY + ':' + email); } catch (e) {}
    sessionEmail = null;
    localStorage.removeItem(SESSION_KEY);
    console.log('[Profile] account deleted:', email);
    fire('change', null);
  }

  function setName(name) {
    name = (name || '').trim().slice(0, 24);
    if (!name) throw new Error("Name can't be empty.");
    if (!sessionEmail) throw new Error('Log in first.');
    const accounts = loadAccounts();
    if (accounts[sessionEmail]) {
      accounts[sessionEmail].name = name;
      saveAccounts(accounts);
    }
    fire('change', current());
    return current();
  }

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
  };
})();
