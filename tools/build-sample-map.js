// build-sample-map.js  (one-off helper — safe to delete after running)
// Copies every WAV from the user's library into ./samples (with URL-safe
// names) and rewrites data/objectSampleMap.json so each object key is
// assigned a RANDOM one-shot sample.

const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/charl/Documents/SNAP IT SAMPLES';
const PROJECT = path.join(__dirname, '..'); // this script lives in tools/
const DEST = path.join(PROJECT, 'samples');
const MAP_PATH = path.join(PROJECT, 'data', 'objectSampleMap.json');

// Object keys we assign sounds to. Order/keys preserved from the existing map
// so the camera (COCO_TO_SAMPLE) and manual-scan dropdown keep working.
const OBJECT_KEYS = [
  'cup', 'mug', 'book', 'box', 'bottle', 'plant', 'phone', 'laptop',
  'mouse', 'keyboard', 'pen', 'headphones', 'can', 'shoe', '_default',
];

// --- helpers ---------------------------------------------------------------

// Make a filename safe for use in a file:// URL (no spaces, commas, #, etc.).
function sanitizeFileName(name) {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, path.extname(name));
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean + ext;
}

// Turn a filename into a short, human-readable display name.
function prettyName(fileName) {
  let s = path.basename(fileName, path.extname(fileName));
  // drop common vendor/library prefixes
  s = s.replace(/^(OLIVER|JUSTESSE|OBJCont|PDV1)[_-]*/gi, '');
  s = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // title-case
  s = s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (s.length > 28) s = s.slice(0, 28).trim();
  return s || 'Mystery Hit';
}

// Recursively collect wav files, tagging each with its top-level category.
function collectWavs(dir, category, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectWavs(full, category || entry.name, out);
    } else if (/\.wav$/i.test(entry.name)) {
      out.push({ srcPath: full, category: category || '(root)', original: entry.name });
    }
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- run -------------------------------------------------------------------

fs.mkdirSync(DEST, { recursive: true });

const wavs = collectWavs(SRC, null, []);
console.log(`Found ${wavs.length} WAV files in library.`);

// Copy all of them into ./samples with sanitized, collision-free names.
const usedNames = new Set();
for (const w of wavs) {
  let dest = sanitizeFileName(w.original);
  if (usedNames.has(dest.toLowerCase())) {
    const ext = path.extname(dest);
    const base = path.basename(dest, ext);
    let n = 2;
    while (usedNames.has(`${base}_${n}${ext}`.toLowerCase())) n++;
    dest = `${base}_${n}${ext}`;
  }
  usedNames.add(dest.toLowerCase());
  w.destName = dest;
  fs.copyFileSync(w.srcPath, path.join(DEST, dest));
}
console.log(`Copied ${wavs.length} files into samples/.`);

// Pool for assignment = one-shots only (category folder named "One shot").
const oneShots = wavs.filter(w => /one\s*shot/i.test(w.category));
console.log(`One-shot pool: ${oneShots.length} files.`);
if (oneShots.length < OBJECT_KEYS.length) {
  console.warn('WARNING: fewer one-shots than object keys — some will repeat.');
}

// Random, unique assignment (cycles only if pool is too small).
const pool = shuffle(oneShots);
const map = {};
OBJECT_KEYS.forEach((key, i) => {
  const pick = pool[i % pool.length];
  map[key] = { sampleFile: pick.destName, displayName: prettyName(pick.destName) };
});

fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
console.log(`\nWrote ${MAP_PATH}:`);
for (const key of OBJECT_KEYS) {
  console.log(`  ${key.padEnd(12)} -> ${map[key].displayName.padEnd(28)} (${map[key].sampleFile})`);
}
