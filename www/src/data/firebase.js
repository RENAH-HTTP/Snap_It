// src/data/firebase.js
// Placeholder Firebase setup. Fill in the config object below with the values
// from your Firebase project console once it exists, then `require('./firebase')`
// from collection.js to sync the user's cards to Firestore.
//
// Docs: https://firebase.google.com/docs/web/setup

let app = null;
let db = null;

function init() {
  try {
    const { initializeApp } = require('firebase/app');
    const { getFirestore } = require('firebase/firestore');

    const firebaseConfig = {
      apiKey: 'REPLACE_ME',
      authDomain: 'REPLACE_ME',
      projectId: 'REPLACE_ME',
      storageBucket: 'REPLACE_ME',
      messagingSenderId: 'REPLACE_ME',
      appId: 'REPLACE_ME'
    };

    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    console.log('[Firebase] Initialized');
  } catch (err) {
    console.warn('[Firebase] Not initialized:', err.message);
  }
}

module.exports = { init, getDb: () => db };
