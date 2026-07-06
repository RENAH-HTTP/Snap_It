// build-objects.js
// -----------------------------------------------------------------------------
// Regenerates data/objectSampleMap.json so EVERY object the on-device camera
// model (COCO-SSD) can recognise maps to a drum sound. COCO-SSD knows 80 real
// world classes — that's the full universe of things the webcam can unlock —
// so this assigns each of those 80 a sample from ./samples, cycling the pool so
// the sounds (and drum categories) stay varied across the collection.
//
// Run:  node build-objects.js
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DEST = path.join(__dirname, 'samples');
const MAP_PATH = path.join(__dirname, 'data', 'objectSampleMap.json');

// The 80 classes COCO-SSD can detect. Each becomes one collectible object.
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
  'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
  'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush',
];

// Turn a sample filename into a short, human-readable display name. The app's
// UI keys the drum category (kick/snare/hat/…) off this text, so keeping the
// sound's real name here means the collection auto-colours correctly.
function prettyName(fileName) {
  let s = path.basename(fileName, path.extname(fileName));
  s = s.replace(/^(OLIVER|JUSTESSE|OBJCont|PDV1)[_-]*/gi, '');
  s = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (s.length > 28) s = s.slice(0, 28).trim();
  return s || 'Mystery Hit';
}

// A stable object-key slug for a COCO class ("wine glass" -> "wine_glass").
function slug(name) { return name.replace(/\s+/g, '_'); }

// Every WAV currently in samples/, sorted so the assignment is deterministic.
const wavs = fs.readdirSync(DEST)
  .filter(f => /\.wav$/i.test(f))
  .sort();

if (!wavs.length) {
  console.error('No WAVs found in samples/. Aborting.');
  process.exit(1);
}

// Prefer one-shots (kick/snare/hat/clap/tom/perc/cowbell/bass/fx) over loops so
// sequenced hits stay tight; fall back to the full pool if that's too small.
const ONE_SHOT = /(kick|snare|hihat|hat|clap|tom|perc|cowbell|bass|rim|block|popper|oof|horn|glass)/i;
let pool = wavs.filter(f => ONE_SHOT.test(f) && !/loop/i.test(f));
if (pool.length < 12) pool = wavs.slice();

const map = {};
COCO_CLASSES.forEach((cls, i) => {
  const file = pool[i % pool.length];
  map[slug(cls)] = { sampleFile: file, displayName: prettyName(file) };
});

// Keep the fallback for anything unrecognised ("Mystery Hit").
map['_default'] = { sampleFile: pool[0], displayName: 'Mystery Hit' };

fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
console.log(`Wrote ${Object.keys(map).length} objects to ${MAP_PATH}`);
console.log(`(${COCO_CLASSES.length} detectable classes, pool of ${pool.length} samples)`);
