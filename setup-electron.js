const { downloadArtifact } = require('@electron/get');
const extract = require('extract-zip');
const fs = require('fs');
const path = require('path');
const { version } = require('./node_modules/electron/package');

const electronDir = path.join(__dirname, 'node_modules/electron');

downloadArtifact({
  version,
  artifactName: 'electron',
  force: false,
  cacheRoot: process.env.electron_config_cache,
  checksums: require('./node_modules/electron/checksums.json'),
  platform: 'win32',
  arch: 'x64'
}).then(zipPath => {
  console.log('Downloaded/cached zip at:', zipPath);
  return extract(zipPath, { dir: path.join(electronDir, 'dist') });
}).then(() => {
  console.log('Extracted successfully');
  return fs.promises.writeFile(path.join(electronDir, 'path.txt'), 'electron.exe');
}).then(() => {
  console.log('path.txt written');
}).catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
});
