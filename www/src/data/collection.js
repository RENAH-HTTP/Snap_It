// src/data/collection.js
// Manages the user's card collection. Every scanned object becomes a card
// holding the object's identity, the assigned sample, and tempo settings.
//
// Storage is layered:
//   1. In-memory array (the source of truth while the app runs).
//   2. localStorage for quick offline persistence between sessions.
//   3. Firebase Firestore (later) for syncing the collection across devices
//      and powering player-to-player trading.

window.Collection = (() => {

  const STORAGE_KEY = 'soundhunter.collection';
  let cards = loadFromLocalStorage();

  /**
   * Card shape (kept simple for now):
   * {
   *   id: string,            // unique id
   *   objectType: string,    // e.g. "cup", "book"
   *   sampleUrl: string,     // path or URL to the assigned audio sample
   *   tempoMultiplier: number, // e.g. 1, 0.5, 2 — relative to master BPM
   *   createdAt: number      // unix timestamp
   * }
   */
  function addCard(card) {
    cards.push(card);
    saveToLocalStorage();
    renderGrid();
    // TODO: also write to Firestore so the collection syncs across devices.
  }

  function getAll() {
    return cards.slice();
  }

  function removeCard(id) {
    cards = cards.filter(c => c.id !== id);
    saveToLocalStorage();
    renderGrid();
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveToLocalStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  }

  /**
   * Paint the current cards into the #card-grid element.
   * Re-rendered any time the collection changes.
   */
  function renderGrid() {
    const grid = document.getElementById('card-grid');
    if (!grid) return;
    if (cards.length === 0) {
      grid.innerHTML = '<p class="empty">No cards yet — scan something!</p>';
      return;
    }
    grid.innerHTML = cards.map(c => `
      <div class="card">
        <strong>${c.objectType}</strong>
        <small>x${c.tempoMultiplier}</small>
      </div>
    `).join('');
  }

  // Paint once on first load so the placeholder reflects saved state.
  document.addEventListener('DOMContentLoaded', renderGrid);

  return { addCard, removeCard, getAll };
})();
