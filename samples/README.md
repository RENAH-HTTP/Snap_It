# Samples

Drop your own WAV one-shots into this folder. The app loads them by **exact
filename** — the names below come straight from
[`/data/objectSampleMap.json`](../data/objectSampleMap.json), which is the
single source of truth. If you rename a file here, rename it there too.

Until a file exists, its sample just stays silent — the app still runs, and the
console logs a `missing sample` warning so you know which WAV to add.

## Required files

| Filename        | Sound in app   | Unlocked by scanning |
| --------------- | -------------- | -------------------- |
| `kick_01.wav`   | Deep Kick      | cup                  |
| `kick_02.wav`   | Punchy Kick    | mug                  |
| `snare_01.wav`  | Tight Snare    | book                 |
| `snare_02.wav`  | Fat Snare      | box                  |
| `hat_01.wav`    | Closed Hat     | bottle               |
| `hat_02.wav`    | Open Hat       | plant                |
| `clap_01.wav`   | Studio Clap    | phone                |
| `perc_01.wav`   | Wood Block     | laptop               |
| `perc_02.wav`   | Mystery Hit    | any unknown object   |
| `perc_03.wav`   | Tin Tap        | can                  |
| `perc_04.wav`   | Stomp          | shoe                 |
| `rim_01.wav`    | Rimshot        | mouse                |
| `tom_01.wav`    | Low Tom        | keyboard             |
| `tom_02.wav`    | High Tom       | pen                  |
| `cymbal_01.wav` | Crash Cymbal   | headphones           |

## Tips

- Keep them short — these are one-shots, not loops. No time-stretching is done.
- Mono or stereo, 44.1 kHz `.wav` is the safe choice.
- Want to add a new object? Add an entry to `objectSampleMap.json` and drop a
  matching WAV here. Nothing else needs to change.
