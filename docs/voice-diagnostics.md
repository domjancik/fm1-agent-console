# Voice diagnostics: per-take stats and kept recordings

Why: on 2026-11-19 two takes (about 4.7 s and 2.2 s) passed the silence gate, but Parakeet returned "no speech
recognised". The input was a 2-channel, 48 kHz USB wireless mic. The suspect is the stereo-to-mono step: a -6 dB
average, or one transmitter per channel. The operator approved keeping the last few recordings, with a TTL, so the
takes can be checked offline. This change measures and keeps audio only. It does **not** change what the ASR engine
gets. Changing the mono mix or adding gain is not approved yet.

## Where the mono mix happens

`fm1-mic` (Swift) turns the device input into mono 16 kHz with `AVAudioConverter` and writes only that stream to
stdout. Before this change, the companion never saw the separate channels. Now `MicCapture({ keepRaw: true })` sets
`FM1_MIC_RAW_OUT=<private temp file>` for the helper. A rebuilt helper then also writes the unconverted input (all
channels, input rate, s16le) to that file and reports `"rawOut": true` in `started`. The helper's stdout does not
change. The companion reads the file on `stop()` and then deletes it. The temp directory is 0700 and the file is 0600.
A helper built before this change ignores the variable. Takes then log only the mono stats, and recording works as
before.

It is not known whether `AVAudioConverter` (with `downmix` off) averages the channels or keeps only channel 1. Compare
the per-channel stats with the mono stats to find out.

Rebuild the helper to get per-channel data: `bun run --cwd packages/speech build:native`.

## Per-take log line

Every take that reaches the gate logs one `voice` line. A take cancelled before its audio was stopped logs nothing.
For example:

```
take 4.70 s, 48000 Hz x2 (Hollyland ...); L rms -31.0 peak -9.4 dBFS voiced 2610 ms; R rms -120.0 peak -120.0 dBFS voiced 0 ms;
mono 16000 Hz rms -37.0 peak -15.4 dBFS voiced 1890 ms; gate accepted; engine sherpa-parakeet-v3; asr 312 ms;
transcript 0 chars; outcome failed (no speech recognised); kept take-20261119T102201123Z-3.wav
```

- Duration, rate and channel count come from the raw capture when it is known. Otherwise they come from the mono stream.
- Per-channel and mono levels: RMS and peak in dBFS. Voiced ms counts 30 ms frames at or above -40 dBFS, the gate's
  rule.
- `gate` is the verdict on the 16 kHz stream: `accepted`, `too_short`, `silent` or `empty`. The line also gives the
  engine id, ASR time and transcript length.
- `outcome` is `transcript`, `failed (reason)` or `cancelled`. `kept` names the saved file.
- The log line never contains the transcript text.

## Kept recordings

Config (`~/.config/fm1-console/config.json`). Kept recordings are on by default, with these values:

```json
{ "voice": { "keepRecordings": { "count": 5, "ttlHours": 24, "dir": "~/.fm1-console/recordings" } } }
```

`"keepRecordings": false` (or `count: 0`) turns it off. The next prune then removes the kept takes. `saveConfig`
writes the key only when it differs from the default. Use a directory that holds nothing else: pruning deletes the
`take-*` files in it.

Each kept take has 3 files. All are 0600. The companion creates the directory 0700; it never changes the modes of a
directory that already exists, and logs a warning once if other users can read it.

| File | Content |
| --- | --- |
| `take-<UTC>-<n>.wav` | The raw capture: original channels and rate. The mono stream, if the helper gave no raw capture. |
| `take-<UTC>-<n>.mono.wav` | The exact mono stream the companion passed to the pipeline (before the 16 kHz resample). |
| `take-<UTC>-<n>.json` | Stats (per channel, mono, gate), engine, ASR ms, outcome, device name. `transcript` only when the take succeeded. |

The companion does not keep REC taps shorter than 350 ms, or takes cancelled with FX. It prunes by count (newest kept)
and by TTL when it starts, after each save and every hour. Save and prune errors are logged as warnings. They never
fail the take: the diagnostics run after the transcript or the error reaches the composer.

## Re-running a kept take offline

```sh
bun packages/speech/src/cli.ts transcribe ~/.fm1-console/recordings/take-...wav                 # average of all channels
bun packages/speech/src/cli.ts transcribe ~/.fm1-console/recordings/take-...wav --channel L     # channel 1 only
bun packages/speech/src/cli.ts transcribe ~/.fm1-console/recordings/take-...wav --channel R     # channel 2 only
bun packages/speech/src/cli.ts transcribe ~/.fm1-console/recordings/take-...mono.wav            # what the live ASR got
```

With `--channel`, the output also has `input` (file, rate, channels, pick) and per-channel `stats`. `--channel` exists
only in the CLI and the companion never uses it. The default (`mix`, a plain average) can differ from the live
`AVAudioConverter` mono. Use `.mono.wav` to reproduce the live input exactly.

## Open points

- The raw side output has not been run against a real microphone (by instruction). The Swift code builds, and the TS
  side is tested with the fake helper.
- If the companion crashes mid-take, a `fm1-mic-raw-*` directory stays in `$TMPDIR` until the next run's first take,
  which removes such directories once they are over an hour old.
