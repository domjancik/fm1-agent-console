# @fm1/speech

Push-to-talk capture and local transcription for the FM-1 companion (spec section 8).

```
fm1-mic (Swift, AVAudioEngine) --s16le 16 kHz--> MicCapture --> gate --> AsrEngine --> postprocess
                                                                 |        (worker process)
                                                     rejects silent/short audio before ASR
```

## Build and use

```sh
bun run --cwd packages/speech build:native      # swiftc -> packages/speech/bin/{fm1-mic,fm1-dictate}
bun packages/speech/src/cli.ts status            # mic permission (never prompts, never opens the mic)
bun packages/speech/src/cli.ts devices           # input devices, default marked
bun packages/speech/src/cli.ts transcribe fixtures/audio/smoke-16k.wav [--engine apple] [--language en]
bun packages/speech/src/cli.ts transcribe ~/.fm1-console/recordings/take-...wav --channel L|R|mix  # kept take, one channel
bun packages/speech/src/cli.ts bench [--runs 2] [--apple]   # writes reports/asr-bench.md
bun packages/speech/src/cli.ts record --seconds 5 --device BuiltInMicrophoneDevice  # manual mic smoke test
bash packages/speech/scripts/make-fixtures.sh    # regenerate fixtures/audio with `say` + afconvert
```

## Modules

| Path | Role |
| --- | --- |
| `native/fm1-mic/main.swift` | `status`, `request`, `devices`, `record [--device uid] [--rate hz] [--max-seconds n]` (env `FM1_MIC_RAW_OUT=<path>`: also the raw input, all channels, to that file). PCM on stdout, NDJSON events (`started`, `level`, `device_changed`, `error`, `stopped`) on stderr. Stops on SIGTERM/SIGINT/stdin EOF. Exit 3 = permission denied, 4 = no/unknown device. Never selects an FM-1 audio input implicitly. |
| `native/fm1-dictate/main.swift` | Apple `DictationTranscriber` (macOS 26+) over stdin PCM. Never downloads assets. |
| `src/capture.ts` | `MicCapture` (start/stop/cancel, levels, start latency, `onEnd` when the helper stops by itself), `micPermission`, `listInputDevices`. A 120 s hard stop is passed to the helper unless `maxSeconds: 0`; `stop()` during startup (quick REC tap) waits for the start and then stops. |
| `src/asr/sherpa-engine.ts`, `src/asr/worker.ts` | Parakeet TDT 0.6B v3 int8 via `sherpa-onnx-node` in a child Bun process (NDJSON). A crashed worker fails the pending call with `worker_crashed`; the next call restarts it. |
| `src/asr/model.ts` | Model lookup: `FM1_ASR_MODEL_DIR`, else the HF cache (`HF_HUB_CACHE`/`HF_HOME`) via `refs/main`. |
| `src/asr/apple-engine.ts` | Optional `AppleDictationEngine`. |
| `src/gate.ts` | RMS/duration gate: 30 ms frames at >= -40 dBFS must add up to >= 200 ms; recordings < 300 ms are rejected. |
| `src/text/punctuation.ts` | Spoken punctuation to symbols; absorbs Parakeet's own punctuation around the spoken word; `literal comma` keeps the word. |
| `src/text/vocabulary.ts`, `vocabulary.default.json` | Word-boundary, case-preserving corrections with `requireAny`/`avoidAny` context. `FM1_VOCAB_PATH` replaces the default list. |
| `src/pipeline.ts` | `transcribeFile`, `transcribePcm` -> `{text, raw, timings:{loadMs, asrMs, totalMs}, audio, rejected?}`. Audio is written only with `keepAudioPath`. |

Env overrides: `FM1_MIC_BIN`, `FM1_DICTATE_BIN`, `FM1_ASR_MODEL_DIR`, `FM1_VOCAB_PATH`.

## Voice diagnostics (raw channels, per-take stats, kept recordings)

Details: [docs/voice-diagnostics.md](../../docs/voice-diagnostics.md).

- `MicCapture({ keepRaw: true })` sets `FM1_MIC_RAW_OUT` for the helper. A rebuilt `fm1-mic` then also writes the
  unconverted input (all channels, input rate) to a private temp file. `stop()` returns it as `raw` and deletes the
  file. The mono stdout stream that goes to ASR does not change. An older helper ignores the variable.
- `takeStats(mono, rate, raw?)` (`src/take-stats.ts`) gives RMS, peak and voiced ms per raw channel and for the mono
  stream. `src/audio/channels.ts` has `channelOf`, `pickChannel` (`L`, `R`, `mix`) and `channelLabel`.
- The companion logs one `voice` line per take. It also keeps the last takes, default 5 for 24 h in
  `~/.fm1-console/recordings`, set by config `voice.keepRecordings`.
- `cli.ts transcribe <wav> --channel L|R|mix` re-runs a kept multi-channel WAV for offline experiments.

## Languages

Parakeet v3 covers 25 European languages and detects the language itself; `language` is checked against that set
(`language_unsupported` otherwise). `engineForLanguage(lang, primary, fallback)` picks the Apple engine for other
languages. On this Mac Apple dictation has only `en_US` assets; `he_IL` reports `assetsInstalled: false`.

## Known gaps

- `fm1-mic record` has not been run against a real microphone (by instruction). Real-mic start latency, the
  48 kHz -> 16 kHz `AVAudioConverter` path and real-speech accuracy still need the manual `record` smoke test.
- Cancelling a Parakeet transcription drops the result; the native decode itself runs to completion. A worker that does not answer (60 s load / 30 s transcribe by default) is killed and the call fails with `timeout`.
- `AVAudioEngineConfigurationChange` ends the recording (`device_changed`) instead of switching devices mid-take.
- Spoken "period"/"colon" are always converted, including as nouns; say "literal period" to keep the word.
