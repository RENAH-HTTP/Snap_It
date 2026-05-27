const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
const APP_INDEX = path.join(__dirname, '..', 'index.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Drop one real WAV into /samples so export + playback have actual audio.
function ensureSample() {
  const sr = 8000, dur = 0.12, n = Math.floor(sr * dur);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 120 * i / sr) * 12000 * (1 - i / n)), 44 + i * 2);
  const dir = path.join(__dirname, '..', 'samples');
  fs.writeFileSync(path.join(dir, 'kick_01.wav'), buf);
}

app.whenReady().then(async () => {
  ensureSample();
  const win = new BrowserWindow({
    width: 1180, height: 740, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });

  await win.loadFile(APP_INDEX);
  await wait(900);

  const trackCount = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
    async function waitFor(fn, ms){const s=Date.now();while(Date.now()-s<ms){try{if(fn())return true;}catch(e){}await wait(40);}return false;}
    await waitFor(()=>document.querySelectorAll('#library-grid .card').length>0, 5000);
    ['cup','mug','book','bottle','phone','laptop'].forEach(o=>window.cameraStub.simulateScan(o));
    document.getElementById('reveal-close').click();
    function addByName(name){const cards=[...document.querySelectorAll('#library-grid .card.unlocked')];
      const card=cards.find(c=>(c.querySelector('.card-name')||{}).textContent===name);
      if(card){const b=card.querySelectorAll('button');b[b.length-1].click();}}
    addByName('Deep Kick'); addByName('Tight Snare'); addByName('Closed Hat');
    await wait(60);
    const rows=document.querySelectorAll('#sequencer-tracks .track-row');
    function pat(r,steps){const c=rows[r].querySelectorAll('.step');steps.forEach(i=>c[i].click());}
    if(rows.length>=3){pat(0,[0,4,8,12]);pat(1,[4,12]);pat(2,[0,2,4,6,8,10,12,14]);}
    return rows.length;
  })()`);
  console.log('tracks added:', trackCount);

  async function shot(tab, file) {
    await win.webContents.executeJavaScript(`document.querySelector('.tab-button[data-tab="${tab}"]').click(); true;`);
    await wait(350);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, file), img.toPNG());
    console.log('wrote', file);
  }
  await shot('scan', 'scan.png');
  await shot('library', 'library.png');
  await shot('sequencer', 'sequencer.png');

  // Exercise Export and report the saved path.
  const dest = await win.webContents.executeJavaScript(`window.audioEngine.exportLoop()`);
  console.log('EXPORT_DEST', dest);

  console.log('ERRORS', JSON.stringify(errors));
  app.quit();
});

setTimeout(() => { console.log('TIMEOUT'); app.quit(); }, 30000);
