// library.js
// -----------------------------------------------------------------------------
// The player's collection of unlocked samples.
//
// Two pieces of state live here:
//   1. sampleMap  -> the full object->sample mapping shipped with the app,
//                    loaded from /data/objectSampleMap.json. This is the single
//                    source of truth for BOTH locked and unlocked samples.
//   2. unlocked   -> the list of object types the player has scanned, persisted
//                    in localStorage so the collection survives app restarts.
//
// Public API (attached to window):
//   library.load()                 -> async; load the map + saved unlocks
//   library.getUnlocked()          -> array of unlocked object types
//   library.unlock(objectType)     -> add to collection, save, return result
//   library.isUnlocked(objectType) -> true/false
//   library.getAllSampleInfo()     -> the full map (UI renders locked+unlocked)
//   library.getSampleInfo(type)    -> the {sampleFile, displayName} for a type
//   library.resolveKey(type)       -> map key for a scan ("_default" if unknown)
// -----------------------------------------------------------------------------

const library = (function () {
  // Where the unlocked list is stored in the browser's localStorage. Each
  // logged-in account gets its own list (Profile appends ':email'); guests
  // share the plain key.
  const STORAGE_KEY = 'snapit.library.v1';

  let sampleMap = {};   // filled in by load()
  let unlocked = [];    // e.g. ["cup", "book"]

  function storageKey() {
    const suffix = (window.Profile && Profile.storageSuffix && Profile.storageSuffix()) || '';
    return STORAGE_KEY + suffix;
  }

  // (Re)read the unlocked list for the current profile. Called on startup and
  // again whenever the player logs in/out, so the keypad swaps collections.
  function reloadUnlocks() {
    unlocked = [];
    const saved = localStorage.getItem(storageKey());
    if (saved) {
      try {
        unlocked = JSON.parse(saved).unlocked || [];
      } catch (err) {
        console.warn('[library] could not parse saved library, starting fresh', err);
        unlocked = [];
      }
    }
  }

  // Load the shipped sample map and any previously-saved unlocks.
  // Uses fetch() because Electron serves the local files over file:// fine.
  async function load() {
    const response = await fetch('data/objectSampleMap.json');
    sampleMap = await response.json();

    reloadUnlocks();

    console.log(
      '[library] loaded map (' + Object.keys(sampleMap).length + ' entries), ' +
      'unlocked:', unlocked
    );
  }

  // Save the unlocked list to localStorage.
  function save() {
    localStorage.setItem(storageKey(), JSON.stringify({ unlocked: unlocked }));
    console.log('[library] saved. unlocked is now:', unlocked);
  }

  // Turn a scanned object type into a real map key. Anything we don't recognise
  // falls back to the "_default" entry ("Mystery Hit").
  function resolveKey(objectType) {
    return Object.prototype.hasOwnProperty.call(sampleMap, objectType)
      ? objectType
      : '_default';
  }

  function getUnlocked() {
    return unlocked.slice(); // a copy, so callers can't mutate our state
  }

  function isUnlocked(objectType) {
    const key = resolveKey(objectType);
    if (key === '_default') return true; // Mystery Hit is always available
    return unlocked.indexOf(key) !== -1;
  }

  function getSampleInfo(objectType) {
    return sampleMap[resolveKey(objectType)];
  }

  function getAllSampleInfo() {
    return sampleMap;
  }

  // Add a scanned object to the collection.
  // Returns { isNewUnlock, objectType, sampleInfo } so the UI can show a reveal.
  function unlock(objectType) {
    const key = resolveKey(objectType);
    const sampleInfo = sampleMap[key];
    const isNewUnlock = unlocked.indexOf(key) === -1;

    if (isNewUnlock) {
      unlocked.push(key);
      save();
      console.log('[library] NEW unlock:', key, '->', sampleInfo.displayName);
    } else {
      console.log('[library] already owned:', key, '->', sampleInfo.displayName);
    }

    return { isNewUnlock: isNewUnlock, objectType: key, sampleInfo: sampleInfo };
  }

  return {
    load: load,
    reloadUnlocks: reloadUnlocks,
    getUnlocked: getUnlocked,
    unlock: unlock,
    isUnlocked: isUnlocked,
    getAllSampleInfo: getAllSampleInfo,
    getSampleInfo: getSampleInfo,
    resolveKey: resolveKey,
  };
})();

window.library = library;
