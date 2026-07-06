# Samples

This folder holds the WAV one-shots the app plays. The object→sample mapping
lives in [`/data/objectSampleMap.json`](../data/objectSampleMap.json), which is
the single source of truth — the app loads each `sampleFile` from this folder by
**exact filename**.

The current library was imported from a personal sample pack and each scannable
object was assigned a **random one-shot**. The full pack (including drum and
melodic loops) is copied here, but only the one-shots are mapped to objects —
the sequencer retriggers a sample on every 16th note, so full loops would sound
chaotic.

## Re-rolling the assignment

To shuffle which object gets which sound, re-run the helper at the repo root:

```powershell
node build-sample-map.js
```

It re-copies the library from `C:\Users\charl\Documents\SNAP IT SAMPLES`, then
rewrites `objectSampleMap.json` with a fresh random one-shot per object.

## Adding your own

- Drop a `.wav` into this folder (keep names URL-safe: no spaces, `#`, or commas).
- Point an object at it in `objectSampleMap.json` (`sampleFile` + `displayName`).
- Keep one-shots short — these are hits, not loops. No time-stretching is done.
- Mono or stereo, 44.1 kHz `.wav` is the safe choice.
