// gen-samples.js
// -----------------------------------------------------------------------------
// Synthesises a full kit of drum/instrument one-shots as real 16-bit WAV files
// in samples/, so every collectible object can have its own distinct sound
// without depending on an external sample library.
//
// Run:  node gen-samples.js
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const SR = 44100; // sample rate
const OUT = path.join(__dirname, "samples");
fs.mkdirSync(OUT, { recursive: true });

// ---- WAV writer (mono, 16-bit PCM) -----------------------------------------
function writeWav(name, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = Math.tanh(s * 1.15); // gentle soft-clip for glue
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, name), buf);
}

// ---- helpers ----------------------------------------------------------------
const TAU = Math.PI * 2;
let seed = 1337;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function env(t, dur, curve) {
  return Math.pow(Math.max(0, 1 - t / dur), curve || 3);
}
function noise() {
  return rnd() * 2 - 1;
}
function buffer(dur) {
  return new Float32Array(Math.ceil(dur * SR));
}

// one-pole high-pass / low-pass for shaping noise
function hp(sig, cutoff) {
  const a = cutoff / (cutoff + SR / TAU);
  let prev = 0,
    pin = 0;
  for (let i = 0; i < sig.length; i++) {
    const o = a * (prev + sig[i] - pin);
    pin = sig[i];
    prev = o;
    sig[i] = o;
  }
  return sig;
}
function lp(sig, cutoff) {
  const a = cutoff / (cutoff + SR / TAU);
  let prev = 0;
  for (let i = 0; i < sig.length; i++) {
    prev = prev + a * (sig[i] - prev);
    sig[i] = prev;
  }
  return sig;
}

// ---- voices -----------------------------------------------------------------
function kick(f0, f1, dur, click) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t * 32); // fast pitch drop
    const phase = TAU * (f1 * t + ((f0 - f1) * (1 - Math.exp(-t * 32))) / 32);
    b[i] = Math.sin(phase) * env(t, dur, 3.2);
    if (t < 0.006) b[i] += click * noise() * (1 - t / 0.006); // beater click
  }
  return b;
}
function snare(tone, dur, noiseMix) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const body =
      (Math.sin(TAU * tone * t) + Math.sin(TAU * tone * 1.6 * t)) *
      0.5 *
      env(t, dur * 0.5, 3);
    b[i] = body * (1 - noiseMix) + noise() * env(t, dur, 2.4) * noiseMix;
  }
  return hp(b, 900);
}
function hat(dur, cutoff) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) b[i] = noise() * env(i / SR, dur, 3.4);
  return hp(b, cutoff);
}
function tom(f0, dur) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.5 * Math.exp(-t * 18));
    b[i] = Math.sin(TAU * f * t) * env(t, dur, 3);
  }
  return b;
}
function clap(dur) {
  const b = buffer(dur);
  const bursts = [0, 0.009, 0.018, 0.028];
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    let a = 0;
    bursts.forEach(function (o) {
      if (t >= o) a += env(t - o, 0.02, 4);
    });
    a += env(Math.max(0, t - 0.03), dur - 0.03, 3) * 0.6; // tail
    b[i] = noise() * Math.min(1, a);
  }
  return hp(b, 1100);
}
function cowbell(f1, f2, dur) {
  const b = buffer(dur);
  const sq = function (f, t) {
    return Math.sign(Math.sin(TAU * f * t));
  };
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    b[i] = (sq(f1, t) + sq(f2, t)) * 0.35 * env(t, dur, 3);
  }
  return lp(b, 5000);
}
function perc(f, dur, wave) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const s =
      wave === "tri"
        ? Math.asin(Math.sin(TAU * f * t)) * (2 / Math.PI)
        : Math.sin(TAU * f * t);
    b[i] = s * env(t, dur, 4);
  }
  return b;
}
function bass(f, dur) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const saw = 2 * ((f * t) % 1) - 1;
    const a = t < dur * 0.7 ? 1 : env(t - dur * 0.7, dur * 0.3, 2);
    b[i] = (Math.sin(TAU * f * t) * 0.7 + saw * 0.3) * a * Math.exp(-t * 1.5);
  }
  return lp(b, 2600);
}
function fx(kind, dur) {
  const b = buffer(dur);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR,
      p = t / dur;
    let f;
    if (kind === "riser") f = 200 + 2600 * p;
    else if (kind === "faller") f = 2800 - 2500 * p;
    else f = 400 + 1400 * Math.sin(p * 24); // arp/warble
    const s = Math.sin(TAU * f * t);
    b[i] =
      s *
      (kind === "faller"
        ? env(t, dur, 2)
        : kind === "riser"
          ? p * (1 - Math.pow(p, 8))
          : env(t, dur, 1.5));
  }
  return kind === "zap" ? hp(b, 600) : b;
}

// ---- kit recipe (varied so the collection sounds diverse) -------------------
const NOTE = {
  C: 65.4,
  D: 73.4,
  E: 82.4,
  F: 87.3,
  G: 98.0,
  A: 110.0,
  B: 123.5,
};
const jobs = [];
function add(name, samples) {
  jobs.push([name, samples]);
}

// kicks
[
  ["analog", 120, 45],
  ["deep", 100, 38],
  ["punch", 150, 55],
  ["sub", 85, 32],
  ["tight", 140, 60],
  ["boom", 110, 40],
  ["click", 170, 58],
  ["warm", 95, 42],
].forEach((k, i) =>
  add(
    `kick_${k[0]}_${String(i + 1).padStart(2, "0")}.wav`,
    kick(k[1], k[2], 0.34 + rnd() * 0.14, 0.5),
  ),
);
// snares
[
  ["crack", 220, 0.8],
  ["fat", 180, 0.6],
  ["rim", 300, 0.4],
  ["clap", 200, 0.75],
  ["tight", 260, 0.7],
  ["noise", 240, 0.9],
  ["brush", 210, 0.85],
  ["deep", 160, 0.65],
].forEach((s, i) =>
  add(
    `snare_${s[0]}_${String(i + 1).padStart(2, "0")}.wav`,
    snare(s[1], 0.18 + rnd() * 0.12, s[2]),
  ),
);
// hats
[
  ["closed", 0.05, 7000],
  ["closed", 0.04, 9000],
  ["tick", 0.03, 11000],
  ["open", 0.28, 6500],
  ["open", 0.35, 8000],
  ["pedal", 0.07, 7500],
].forEach((h, i) =>
  add(`hat_${h[0]}_${String(i + 1).padStart(2, "0")}.wav`, hat(h[1], h[2])),
);
// toms
["C", "E", "G", "A", "D", "F"].forEach((n, i) =>
  add(
    `tom_${n.toLowerCase()}_${String(i + 1).padStart(2, "0")}.wav`,
    tom(NOTE[n] * 2, 0.3 + rnd() * 0.12),
  ),
);
// claps
[1, 2, 3].forEach((i) =>
  add(
    `clap_layer_${String(i).padStart(2, "0")}.wav`,
    clap(0.16 + rnd() * 0.08),
  ),
);
// cowbells / metals
[
  [540, 800],
  [620, 900],
  [480, 720],
].forEach((c, i) =>
  add(
    `cowbell_metal_${String(i + 1).padStart(2, "0")}.wav`,
    cowbell(c[0], c[1], 0.22 + rnd() * 0.1),
  ),
);
// percs / blips
[440, 660, 880, 550, 990, 330, 770, 1100].forEach((f, i) =>
  add(
    `perc_blip_${String(i + 1).padStart(2, "0")}.wav`,
    perc(f, 0.1 + rnd() * 0.08, i % 2 ? "tri" : "sine"),
  ),
);
// bass notes
["C", "E", "G", "A", "D", "F", "B"].forEach((n, i) =>
  add(
    `bass_${n.toLowerCase()}_${String(i + 1).padStart(2, "0")}.wav`,
    bass(NOTE[n], 0.4 + rnd() * 0.2),
  ),
);
// fx
["riser", "faller", "zap", "arp", "faller", "riser", "arp", "zap"].forEach(
  (k, i) =>
    add(
      `fx_${k}_${String(i + 1).padStart(2, "0")}.wav`,
      fx(k, 0.3 + rnd() * 0.3),
    ),
);

jobs.forEach(([name, samples]) => writeWav(name, samples));
console.log(`Synthesised ${jobs.length} samples into samples/`);
