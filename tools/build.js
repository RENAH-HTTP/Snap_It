/**
 * build.js
 * Bundles the web assets into dist/ for Cloudflare Pages deployment.
 * Run: node tools/build.js   (from the project root)
 */
const fs = require('fs');
const path = require('path');

// This script lives in tools/; run everything relative to the project root so
// the copy()/copyDir() calls below keep using simple relative paths.
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const OUT = path.join(ROOT, 'dist');

// Clean and recreate dist/
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// Copy a file, creating parent dirs as needed
function copy(src, dest) {
  if (!fs.existsSync(src)) return;
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
}

// Recursively copy a directory
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else copy(srcPath, destPath);
  }
}

// Copy PWA files (index.html = landing page, app.html = the instrument)
copy('index.html', path.join(OUT, 'index.html'));
copy('app.html', path.join(OUT, 'app.html'));
copy('manifest.json', path.join(OUT, 'manifest.json'));
copy('sw.js', path.join(OUT, 'sw.js'));

// Copy directories
copyDir('src', path.join(OUT, 'src'));
copyDir('styles', path.join(OUT, 'styles'));
copyDir('vendor', path.join(OUT, 'vendor'));
copyDir('data', path.join(OUT, 'data'));
copyDir('samples', path.join(OUT, 'samples'));
copyDir('img', path.join(OUT, 'img'));

// Copy Node module bundles needed at runtime
const nodeFiles = [
  'node_modules/tone/build/Tone.js',
  'node_modules/@tensorflow/tfjs/dist/tf.min.js',
  'node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.min.js',
];

for (const f of nodeFiles) {
  if (fs.existsSync(f)) {
    copy(f, path.join(OUT, f));
    console.log('  ✓', f);
  } else {
    console.warn('  ✗ MISSING:', f);
  }
}

// Write Cloudflare Headers for proper caching
const headers = `
/*
  Cache-Control: public, max-age=0, must-revalidate

/samples/*
  Cache-Control: public, max-age=31536000, immutable

/node_modules/*
  Cache-Control: public, max-age=31536000, immutable

/src/*
  Cache-Control: public, max-age=3600
`;
fs.writeFileSync(path.join(OUT, '_headers'), headers.trim());
console.log('  ✓ _headers written for Cloudflare');

console.log('\n✅ dist/ built successfully for Cloudflare Pages!');
