# Discovery: Voice, Audio and MIDI on macOS

Spec scope: section 1 (environment) and section 8 (voice capture and transcription). The section 9 MIDI transport constraints are included where they affect the choice of MIDI library.
Date: 2026-11-17. Machine: macOS 27.2 (Darwin 27.2.0) arm64, node v22.22.3, bun 1.3.13, Swift 6.4 (CommandLineTools), uv present.
Method: read-only inspection, plus throwaway probes in `/Users/dominikj/dev/personal/.fm1-upstream/probe/`. Nothing was installed system-wide. Nothing was written to `/Users/dominikj/dev/personal/fm1` or `/Users/dominikj/dev/personal/transcription`. No message was sent to the FM-1. The microphone was not opened (see "Not done").

---

## TL;DR recommendation

| Concern | Recommendation | Why |
| --- | --- | --- |
| ASR engine (primary) | **NVIDIA Parakeet TDT 0.6B v3, int8 ONNX, through `sherpa-onnx-node@2.0.1`**. It runs in-process in Bun/Node, or better in a Bun worker or child process. | The model is already cached locally (no download). Prebuilt darwin-arm64 binary, no Python. Transcripts are identical to parakeet-mlx on our fixtures. First inference is about 0.35–0.56 s and needs no warm-up (MLX needs 5.5 s). Load takes 1.6–2.4 s. Supports hotwords for technical vocabulary. |
| ASR engine (alternative) | parakeet-mlx 0.5.2 in a persistent Python `uv` sidecar speaking JSON lines over stdio | About 2× faster per utterance when warm (0.10–0.17 s). Needs Python, a 5.5 s Metal warm-up, about 2.2 GB of Metal memory, and an ffmpeg workaround. |
| Multilingual fallback | Whisper through the same sherpa-onnx API (tiny is cached; a larger model needs a download), or Apple `DictationTranscriber` | Parakeet v3 is European-only. The system languages are `en-IL, he-IL`, and **Parakeet has no Hebrew** (0 Hebrew tokens). |
| Apple on-device | Keep as an optional engine through a small Swift helper (`DictationTranscriber`, macOS 26+) | Works today with no download and no permission prompt for file input. Accuracy on technical prompts was worse (see table). It converts spoken punctuation, which is a plus. `SpeechTranscriber` en_US assets are **not installed**. |
| Mic capture | **Tiny Swift CLI (`AVAudioEngine` → 16 kHz mono s16le on stdout)** spawned by the companion | swiftc is available, it builds in about 4 s with no dependencies, and the binary is 90 KB. sox and ffmpeg are **not installed**. The node audio addons are old or unmaintained. |
| MIDI | **`@julusian/midi@3.8.1`** (RtMidi, N-API v7, prebuilt `darwin-arm64`) | Installs from prebuilt binaries in under 2 s with npm and bun. Loopback with a 203-byte SysEx passed under both Node and Bun. The FM-1 shows up as port `AMB-1 FM-1`. |

---

## 1. Existing local assets

### 1.1 `/Users/dominikj/dev/personal/transcription` (read-only)

- `pyproject.toml` declares `parakeet-mlx` (unpinned), and also pyannote, torch, lancedb and others. `requires-python = ">=3.12,<3.13"`. `.python-version` = 3.12.
- `.venv` site-packages contain: `parakeet_mlx-0.5.2`, `mlx-0.31.2`, `mlx_metal-0.31.2`, `numpy-2.4.6`, `soundfile-0.14.0`, `librosa-0.11.0`, `torch-2.12.0`, `torchaudio-2.11.0`. There is **no** mlx-whisper, whisper, or faster-whisper.
- README: transcription is done with `uv run parakeet-mlx <file> --cache-dir .hf-cache` (README.md:13-22).
- Cached model: `.hf-cache/models--mlx-community--parakeet-tdt-0.6b-v3/snapshots/ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15/` holds `config.json` and `model.safetensors` (**2,508,288,736 bytes, fp32**). `from_pretrained` accepts a local directory path (`parakeet_mlx/utils.py:59-87`, fallback branch at lines 76-78), so we could reuse it by path.
- **Fragility:** `.venv/bin/python` is a symlink to `/Users/dominikjancik/dev/personal/transcription/.uv-python/...`. It works only because `/Users/dominikjancik -> /Users/dominikj/` is a root-owned symlink. `pyvenv.cfg` has the same issue. **Do not depend on this venv.** If we choose MLX, make a fresh `uv` project and point it at the model directory.
- `.hf-cache/hub` also holds pyannote and BAAI embedding models. They are not relevant here.

### 1.2 `~/.cache/huggingface/hub`

| Model | Size | Usable for |
| --- | --- | --- |
| `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` (encoder 652 MB, decoder 12 MB, joiner 6 MB, tokens.txt) | 640 MB | **sherpa-onnx (recommended)** |
| `csukuangfj/sherpa-onnx-whisper-tiny` (int8 and fp32 encoder/decoder) | 245 MB | sherpa-onnx multilingual fallback (weak) |
| `deepdml/faster-whisper-large-v3-turbo-ct2` (model.bin 1.6 GB) | 1.5 GB | Needs Python faster-whisper/CTranslate2, which is not installed. CPU only on Mac. |
| others (TTS, Qwen3-TTS, OmniVoice, LLMs) | — | not relevant |

### 1.3 `/Users/dominikj/dev/personal/voice-processor`

- Old experiment with whisper and vosk plus pyaudio (`process_voice.py`).
- `recorded_audio.wav`: 1 ch, 16 kHz, Int16, 4.99 s, **RMS 143 / peak 1924 (about −47 dBFS), so it is practically silent.** Every engine returned nothing for it, or a hallucination. Use it as the "silent recording" fixture.

### 1.4 Tools on PATH

| Tool | Present |
| --- | --- |
| sox / rec | **missing** |
| ffmpeg | **missing** (parakeet-mlx's `transcribe()` hard-requires it, see 3.2) |
| whisper.cpp (`whisper-cli`) | missing |
| mlx_whisper, parakeet-mlx CLIs on PATH | missing (they exist only inside the transcription venv) |
| swiftc | `/Library/Developer/CommandLineTools/usr/bin/swiftc`, Swift 6.4, target arm64-apple-macosx27.2.0. SDKs: MacOSX26, 26.5, 27. No full Xcode (`xcode-select -p` = CommandLineTools). |
| uv | `/opt/homebrew/bin/uv` |

### 1.5 Audio devices (CoreAudio, read-only)

From `system_profiler SPAudioDataType` and the `mic devices` probe:

- `MacBook Pro Microphone`: 1 ch, 48 kHz, built-in.
- `soundcore Space One`: **default input**, Bluetooth, **16 kHz** (HFP).
- Gotcha: if the BT headset is the default input, opening it switches the headset to the HFP profile, and playback quality drops while recording. The companion should let the user pin the built-in mic. The capture helper takes a device argument (see 4).
- `AVCaptureDevice.authorizationStatus(for: .audio)` = **authorized** for the responsible process (the terminal or host that launched the probe). A launchd-started companion needs its own TCC grant (see Open Questions).

---

## 2. Measurements

Fixtures were made with `say -o pN.wav --data-format=LEI16@16000` (clean TTS, so accuracy here is **optimistic** compared with a real mic). The phrases contain a repo name, an identifier, and spoken punctuation, as section 8 asks:

- p1 (8.17 s): "Open the fm1 agent console repository and rename the function parse Device Frame to decode frame, then run the tests. Period."
- p2 (6.90 s): "In the traycer adapter, add a retry with exponential backoff to send message, comma, and log the session ID."
- p3 (3.84 s): "Fix the null pointer in use Voice Composer hook and update the README."

Fixture and bench scripts: `/private/tmp/claude-501/-Users-dominikj-dev/313be90a-f676-4bad-a7e0-7d10bfdd6de8/scratchpad/{wav/,bench_parakeet.py}`, `/Users/dominikj/dev/personal/.fm1-upstream/probe/sherpa/{bench.js,whisper.js}`, `/Users/dominikj/dev/personal/.fm1-upstream/probe/swift/{stt.swift,dict.swift,mic.swift,loc.swift}`.

### 2.1 Latency and memory

| Engine | Load | First inference | Warm inference (p1 / p2 / p3) | Memory |
| --- | --- | --- | --- | --- |
| parakeet-mlx 0.5.2, fp32 weights cast to bf16, Python 3.12 venv | import 0.6 s + load **3.7 s** (15.0 s on a cold page cache) | **5.56 s** (Metal kernel compile, any input) | 0.15–0.16 / 0.17–0.22 / 0.10 s (RTF ≈ 0.02–0.03) | RSS 0.93 GB, **Metal peak 2.2 GB**, footprint 2.9 GB |
| sherpa-onnx-node 2.0.1, Parakeet v3 int8, CPU, 4 threads, **Node 22** | **2.4 s** | 0.56 s | 0.34 / 0.31–0.64 / 0.19–0.21 s | RSS 0.96 GB |
| same, **Bun 1.3.13** | **1.6 s** | 0.34 s | 0.34–0.41 / – / 0.12–0.17 s | RSS 1.2 GB |
| sherpa-onnx whisper-tiny int8 (Bun) | 0.56 s | — | 0.43 / 0.30 / 0.18 s | not measured |
| Apple `DictationTranscriber` en_US, `.shortDictation` (Swift CLI, new analyzer per file) | ~0 (system daemon) | **1.43 s** | 0.35 (p1 repeat) / 0.90 / 0.57 s | CLI RSS 18 MB (the work runs in a system daemon) |

All engines meet the spec target "short utterance < 2 s after release" (section 13) once warm. MLX misses it on the first utterance unless the sidecar warms up at start with a dummy inference.

Silent fixture (`recorded_audio.wav`): parakeet-mlx gave `""`. sherpa Parakeet gave `""` but took **1.7–2.1 s** (slower than on speech). whisper-tiny hallucinated `(clicking) (clicking) ...`. **Put an RMS/VAD gate in front of the ASR.** sherpa-onnx ships a VAD (`vad.js` in the same package).

### 2.2 Accuracy on the fixtures

| | p1 | p2 | p3 |
| --- | --- | --- | --- |
| parakeet-mlx | "Open the FM1 agent console repository and rename the function parse device frame to decode frame, then run the tests, period." | "In the **tracer** adapter, add a retry with exponential **back off** to send message, **comma**, and log the session ID." | "Fix the null pointer **and** use voice composer hook and update the readme." |
| sherpa Parakeet int8 | identical to MLX | identical to MLX | identical to MLX |
| whisper-tiny (sherpa) | same as Parakeet | "Tracer", "back-off", otherwise the same | same as Parakeet |
| Apple Dictation | "Open the **FM one** agent console**,** repository and rename the function **parts** device frame to decode frame, then run the **test**." | "...exponential back off to send message**,** and **logged** the session ID" | "Fix the **nail** pointer and use voice composer, hook, and update. The read me." |

Notes:
- "Traycer" comes out as "tracer" in every engine. This is the use case for **hotword/contextual biasing**. sherpa supports it: `createStream(hotwords)` with `decodingMethod: 'modified_beam_search'` (`sherpa-onnx-node/non-streaming-asr.js:95-112`, `types.js:386,392`). Apple supports it through `AnalysisContext.contextualStrings` (Speech swiftinterface line 484). parakeet-mlx has no hotword API, so it needs a post-correction dictionary.
- Parakeet transcribes spoken punctuation literally ("comma", "period"). Apple Dictation converts it to punctuation. For Parakeet, add a small deterministic post-processor (a map of spoken punctuation to symbols plus a vocabulary map). This also covers the spec's "technical vocabulary correction" without an LLM.

---

## 3. Engine evaluation details

### 3.1 sherpa-onnx (recommended)

- `npm view sherpa-onnx-node`: 2.0.1 (published 2026-10-26). `optionalDependencies` include `sherpa-onnx-darwin-arm64@2.0.1` (unpacked about 34 MB). `npm install` took 1.2 s with no compile.
- API (verified in the installed source): `new OfflineRecognizer({featConfig, modelConfig:{transducer:{encoder,decoder,joiner}, tokens, numThreads, provider, modelType:'nemo_transducer'}, decodingMethod})`, `rec.createStream(hotwords?)`, `stream.acceptWaveform({samples: Float32Array, sampleRate})`, `rec.decode(stream)` or `await rec.decodeAsync(stream)`, `rec.getResult(stream).text`. Also `OfflineRecognizer.createAsync(config)` (`non-streaming-asr.js:52-150`) and `sherpa.readWave` (`sherpa-onnx.js:29`).
- The same package also covers Whisper, SenseVoice, Canary and others (`types.js:296-318`). Switching to a multilingual model therefore changes only the config.
- Risk: a native crash in the addon kills its host process. Run it in a **child Bun process (`asr-worker`) over stdio NDJSON**, or in a Bun `Worker`, so the main companion survives. The use of `decodeAsync` and `createAsync` keeps the event loop free.
- Bun note: `bun add` reported "Blocked 1 postinstall" for `@julusian/midi`. sherpa uses optionalDependencies and has no postinstall. Prebuilds load anyway, so the projects should not need `trustedDependencies`.

### 3.2 parakeet-mlx (alternative)

- `BaseParakeet.transcribe(path)` calls `load_audio()`, which **raises if ffmpeg is not on PATH** (`parakeet_mlx/audio.py:51-55`, called from `parakeet.py:164-165`). Workaround that I verified: read the PCM yourself and call `get_logmel(audio_f32, model.preprocessor_config)` then `model.generate(mel)[0].text` (`parakeet.py:167-169`).
- Pitfall that I hit: passing a **bf16** audio array to `get_logmel` fails with a matmul shape error (`audio.py:166`). Pass float32. `load_audio` itself returns float32 whatever `dtype` you pass.
- Streaming API exists: `model.transcribe_stream(context_size=(256,256))` with `StreamingParakeet.add_audio(mx.array)` (`parakeet.py:223-267, 999-1030`). This could give live partials while REC is held.
- `from_pretrained` is `functools.lru_cache`d and casts to bf16 at load (`utils.py:58-87`). A one-time conversion to a bf16 safetensors file (about 1.25 GB) would roughly halve load I/O.
- Sidecar design if chosen: a `uv` project at `sidecar/asr-mlx/` (Python 3.12, `parakeet-mlx==0.5.2`, `soundfile`, `numpy`). Long-lived. NDJSON over stdio: `{"op":"hello"}` → `{"ready":true,"load_ms":..}`, `{"op":"transcribe","id":..,"pcm_path"|"pcm_b64":..,"sample_rate":16000}` → `{"id":..,"text":..,"ms":..}`, `{"op":"cancel","id":..}`. Do a warm-up inference at start. Logs go to stderr only.

### 3.3 Apple on-device speech (Swift helper)

- SDK (`MacOSX.sdk/.../Speech.swiftmodule/arm64e-apple-macos.swiftinterface`): `final public actor SpeechAnalyzer` (line 228, `@available(anyAppleOS 26)`), `SpeechTranscriber` (line 346, presets `.transcription`, `.progressiveTranscription`, ...), `DictationTranscriber` (line 70, presets `.phrase`, `.shortDictation`, `.progressiveShortDictation`, ...), `AssetInventory.assetInstallationRequest(supporting:)` (line 57), `SpeechAnalyzer(inputAudioFile:modules:...)` / `analyzeSequence(from: AVAudioFile)` (lines 340-342), and `AnalysisContext.contextualStrings` (line 484).
- Runtime on this Mac (probe output):
  - `SpeechTranscriber.isAvailable=true`, `installedLocales=[]`. `assetInstallationRequest` is non-nil for en_US, so **assets need a download**, which I did not trigger. There are 45 supported locales: no `he`, no `cs`.
  - `DictationTranscriber.installedLocales=["en_US"]`. There are 54 supported locales, and they **include `he_IL`**.
  - Legacy `SFSpeechRecognizer`: en_US `supportsOnDeviceRecognition=true`, he_IL `false`. `authorizationStatus=0` (notDetermined).
- File-based transcription with `DictationTranscriber` ran from an unsigned CLI **without any authorization prompt**. Live mic input still needs microphone TCC.
- Build: `swiftc -parse-as-library -O stt.swift` took about 20 s the first time (module cache). The binary is 90 KB.
- Verdict: worse accuracy on identifiers. Good spoken-punctuation handling. Zero memory cost in our process. Hebrew is possible through Dictation. Keep it as an optional `apple` engine behind the same `AsrEngine` interface. It should not be the default.

### 3.4 Not evaluated or not available

- mlx-whisper / whisper.cpp: not installed. A large-v3-turbo download is about 1.6 GB, which exceeds the 1 GB cap for this discovery.
- faster-whisper (the CT2 model is cached): needs a Python CTranslate2 install. On Apple Silicon it runs on CPU only.

---

## 4. Mic capture options

| Option | Status | Verdict |
| --- | --- | --- |
| sox `rec` | not installed (`brew install sox` needed) | Avoid. It is an extra system dependency. |
| ffmpeg `-f avfoundation` | not installed (large brew dependency tree) | Avoid. |
| Node addons: `naudiodon` 2.3.6 (last modified 2022, node-gyp + PortAudio), `mic` / `node-record-lpcm16` (2022, they shell out to sox/rec), `@picovoice/pvrecorder-node` 1.2.9 (prebuilt, proprietary vendor) | — | Not recommended. |
| **Swift CLI with AVAudioEngine** | **Built and partly run here**: `/Users/dominikj/dev/personal/.fm1-upstream/probe/swift/mic.swift`, `swiftc -O` in **3.8 s**, no dependencies | **Recommended.** |

The probe `mic` CLI implements:
- `mic status` → `authorized` (wraps `AVCaptureDevice.authorizationStatus`, never prompts).
- `mic devices` → NDJSON list of input devices via CoreAudio `kAudioHardwarePropertyDevices` and `kAudioHardwarePropertyDefaultInputDevice`. Output on this Mac: `{"id":79,"name":"MacBook Pro Microphone",...,"default":false}` and `{"id":90,"name":"soundcore Space One",...,"default":true}`.
- `mic record` → `AVAudioEngine.inputNode.installTap` plus `AVAudioConverter` to Int16 16 kHz mono interleaved, streamed to stdout. It stops on stdin EOF or SIGTERM. **This was compiled but not run** (see "Not done").

Proposed production helper `fm1-audio` (Swift, built by `swiftc` in a `bun run build:native` script, no Xcode project):
- NDJSON control on stdin and events on stderr or fd 3. Raw PCM goes on stdout, or into a temp file in memory only.
- Commands: `devices`, `status`, `request` (triggers the permission prompt), `start {deviceUID?}`, `stop`, `cancel`.
- Events: `started {ts, sampleRate, deviceName}` (for the < 200 ms "recording start feedback" target), `level {rms}` (LCD VU, silent detection), `device_changed` (observe `AVAudioEngineConfigurationChange`), `error {code: no_device|denied|...}`, `stopped {frames}`.
- Selecting a non-default device needs `kAudioOutputUnitProperty_CurrentDevice` on the input node's AudioUnit. This is not implemented in the probe.
- Keep the engine **pre-warmed** (prepared but not started) so that pressing REC starts quickly. Do not keep the mic open between presses. Push-to-talk only, as the spec requires.
- The Swift helper could also host Apple ASR (section 3.3) in the same binary, so there is only one native helper.

---

## 5. MIDI from Node/Bun

| Package | Latest | Native? | Notes |
| --- | --- | --- | --- |
| `midi` | 2.0.0 (2022) | node-gyp + nan, compiled at install | stale |
| **`@julusian/midi`** | 3.9.0 (2026-11-14, too new, so **pin 3.8.1**, 2026-08-10) | N-API v7, `pkg-prebuilds` with `prebuilds/midi-darwin-arm64/node-napi-v7.node` | **recommended** |
| `easymidi` | 3.2.0 | wraps `@julusian/midi ^3.6.1` | sugar only. It adds little for SysEx framing. |
| `jzz` | 1.9.6 | via `jazz-midi` 1.7.9 (2023) | heavier, browser-style API |
| `webmidi` | 3.3.1 | browser Web MIDI | needs a Web MIDI shim in Node |

Verified with `@julusian/midi@3.8.1` (`/Users/dominikj/dev/personal/.fm1-upstream/probe/midi-{npm,bun}/midi-loop.mjs`):
- `npm install`: 2.0 s, no compile. `bun add`: 0.86 s, "Blocked 1 postinstall", yet the prebuilt binary still loads under Bun (the postinstall is only `pkg-prebuilds-verify || node-gyp rebuild`).
- API (`dist/input.d.ts`, `dist/output.d.ts`): `Input.getPortNames()`, `openPortByName(name)`, `openVirtualPort(name)`, `ignoreTypes(sysex, timing, activeSensing)` (**SysEx is ignored by default, so call `ignoreTypes(false, true, true)`**), `on('message', (deltaTime, bytes) => ...)`, `Output.send(number[] | Buffer)`.
- Ports on this Mac: inputs and outputs are `['IAC Driver Bus 1', 'AMB-1 FM-1']`.
- Virtual-port loopback: a note-on `[144,60,100]` and a **203-byte SysEx** both arrived intact under **Node 22 and Bun 1.3.13**.
- Passive 3 s listen on `AMB-1 FM-1` (input only, nothing sent): 0 messages. The device sends no heartbeat at idle with the current firmware.
- USB (`system_profiler SPUSBHostDataType`): "CoralFlower FM-1", VID **0x1209**, PID **0x0001**, version 0x0301, full speed. This matches `fm1/firmware/src/usb.c:8` ("VID 0x1209 / PID 0x0001 is the pid.codes test id"), so the attached unit runs Dinghy/Felucca-family firmware.

### 5.1 Firmware constraints that matter for the transport (from the read-only `fm1` checkout)

- **Danger:** SysEx `F0 22 24 35 7D F7` makes the firmware enter **UBOOT** (`firmware/src/usb.c:7`, `usb.c:679` `UBOOT_KEY`). `F0 22 24 35 7F F7` is the OTA/M-UPGRADE request (`usb.c:142`, `usb.c:716-717`). The companion's MIDI layer must **block any outgoing frame that starts with `F0 22 24 35`**, unless an explicit flashing tool sends it.
- Platform SysEx assembly keeps only **16 bytes** (`usb.c:139` `uint8_t sysex[16]`, "only short commands matter here" `usb.c:676`). Per `docs/API.md:172-174`, "SysEx is the platform's (the updater) and does not reach the app". Today a device app sees only channel voice messages plus clock/transport through `midi_get`. So host↔device protocol frames (section 9) carried as SysEx **need a firmware change** in `usb.c`: a manufacturer-ID-gated path to the app with a larger buffer. The other option is CC/NoteOn encoding, or the optional CDC-ACM serial function (`FELUCCA_CDC=1`, `usb.c:9-10`). This belongs to the protocol/firmware discovery. It is flagged here because it decides whether the MIDI library has to carry SysEx at all.

---

## 6. Proposed voice architecture

```
FM-1 REC down ──MIDI──▶ companion (Bun)
                          │  VoiceComposer FSM: READY→RECORDING (destination captured here)
                          ├─▶ fm1-audio (Swift)  start ─▶ PCM s16le 16k on stdout, level events
REC up ─────────────────▶ │  stop ─▶ RMS/VAD gate (silent → FAILED{silent}, no ASR)
                          ├─▶ asr-worker (Bun child, sherpa-onnx Parakeet int8, model preloaded)
                          │      NDJSON {id, pcm(Float32 b64 or shm path)} → {id, text, ms}
                          │  post-process: spoken punctuation map + vocab/hotword list
                          └─▶ REVIEWING (editable draft) → explicit SAVE → SUBMITTING → DELIVERED
```

- `AsrEngine` interface: `load()`, `transcribe(pcm: Int16Array|Float32Array, sr, {lang, hotwords})`, `dispose()`. Implementations: `sherpa-parakeet` (default), `sherpa-whisper` (multilingual), `apple-dictation` (Swift), and optionally `mlx-parakeet` (Python sidecar).
- Model path is configurable. Default to the HF cache snapshot path, resolved via `refs/main` so that no snapshot hash is hardcoded. Fail with a clear message if it is missing, together with a documented download command.
- Persistence: keep PCM in memory only. Write no WAV unless `--keep-audio` is set (section 14). CI uses the `say`-generated fixtures and the silent fixture, with no mic (section 8 "Audio smoke test").

---

## Not done (deliberately)

- **I did not open the live microphone.** Mic permission is already `authorized` for the launching process, so a capture would not prompt. But the default input is a Bluetooth headset, and opening it would switch the user's headset to HFP mid-session. Recording-start latency and real-mic accuracy still need measuring. The command `mic record > /tmp/x.raw` with the built-in mic selected is ready for that.
- I did not trigger Apple asset downloads for `SpeechTranscriber` en_US or Dictation he_IL.
- I sent nothing to the FM-1.

## Open questions

1. **Language:** the system languages are en-IL and he-IL. Is Hebrew dictation needed? If yes, Parakeet cannot do it. Options: a Whisper model larger than tiny (download needed), or Apple `DictationTranscriber` he_IL (asset status unknown).
2. **TCC for the shipped companion:** if it runs as a launchd agent or a `.app`, it needs a bundle with `NSMicrophoneUsageDescription`, and the grant is tied to that bundle. If it runs from a terminal, the terminal's grant is inherited. Which launch mode is the MVP?
3. **SysEx vs firmware:** the current firmware drops app-level SysEx (16-byte platform buffer, UBOOT key). Should the protocol run over a firmware-patched SysEx path, CDC-ACM serial, or CC/Note encoding? This decides the transport for section 9.
4. **Accept int8 Parakeet** (on clean TTS it matched fp32 MLX exactly) or require MLX for peak accuracy on real speech? A real-mic A/B with 10–20 engineering prompts is needed.
5. **Hotwords:** sherpa hotwords need `modified_beam_search`, and phrases must be tokens unless `modelingUnit`/`bpeVocab` is set. The latency cost on this model has not been measured yet.
6. **Bluetooth input:** should we default to the built-in mic to avoid HFP switching, or follow the system default?

---

## Reviewer verification

Reviewer: a skeptical second pass, 2026-11-17. Method: I opened the cited files and re-ran read-only commands and probes. I did not open the microphone, did not send anything to the FM-1, and did not write to `/Users/dominikj/dev/personal/fm1`. Reviewer scripts are in `/private/tmp/claude-501/-Users-dominikj-dev/313be90a-f676-4bad-a7e0-7d10bfdd6de8/scratchpad/review/`.

### Checked claims

| # | Claim | Verdict | Evidence / correction |
| --- | --- | --- | --- |
| 1 | sox, rec, ffmpeg, whisper-cli and mlx_whisper are missing. swiftc and uv are present. The Parakeet int8 sherpa model is cached (640 MB). The transcription venv depends on the `/Users/dominikjancik` symlink. | **CONFIRMED** | `command -v` shows each tool missing. Minor detail: `swiftc` resolves to `/usr/bin/swiftc` (the shim), not the CommandLineTools path. `du -sh` gives 640M, snapshot `2bda32ec…` from `refs/main`. `.venv/bin/python` points to `/Users/dominikjancik/...`, and `/Users/dominikjancik -> /Users/dominikj/` is owned by root. |
| 2 | sherpa-onnx-node 2.0.1 with Parakeet int8 under Bun gives the same text as MLX, with about 1.6 s load and sub-second inference. | **CONFIRMED (timing a little worse)** | I re-ran `probe/sherpa/bench.js` under Bun 1.3.13. The transcripts match section 2.2 exactly. Load took **2.1 s** (the report says 1.6 s). Warm runs took 0.15–0.65 s. RSS was 919 MB. All of this is still well inside the 2 s target. |
| 3 | sherpa supports hotwords for technical vocabulary, such as "Traycer". | **WRONG as a working feature with the cached model** | The API exists (`non-streaming-asr.js:95-112`). But the cached snapshot has **no `bpe.vocab`**. With `modelingUnit:'bpe'`, the config fails validation: `bpe_vocab: '' does not exist`. Without it, the token-form hotwords `▁Tra y cer` fail: `Cannot find ID for token Tra … Encode hotwords failed, skipping`. The pieces exist in `tokens.txt` at lines 7346, 7894 and 1578, but the NeMo hotword encoder splits off `▁`. Decoding then silently continues with no biasing, and p2 still gives "tracer". **Correction:** plan the rule-based post-correction dictionary as the primary vocabulary fix for every engine. Treat sherpa hotwords as unproven until a `bpe.vocab` for Parakeet v3 is generated or downloaded and tested. `modified_beam_search` without hotwords ran at about 0.36–0.6 s on p2, so beam search itself is affordable. |
| 4 | `@julusian/midi` 3.8.1 is installed, 3.9.0 is 3 days old, and SysEx must be un-ignored with `ignoreTypes(false, …)`. | **CONFIRMED** | The installed package.json says 3.8.1. `npm view … time` gives 3.8.1 = 2026-08-10 and 3.9.0 = 2026-11-14. `dist/input.d.ts:17,23,25,26` has `getPortNames`, `ignoreTypes(sysex,timing,activeSensing)`, `openPortByName` and `openVirtualPort`. |
| 5 | The UBOOT key `F0 22 24 35 7D F7` is at `usb.c:7,679`, and the OTA trigger `…7F F7` is at `usb.c:142`. | **CONFIRMED** | `usb.c:7` (comment), `usb.c:679` (`UBOOT_KEY[6]`), `usb.c:142` (`ota_req` field) and `usb.c:715-718` (the match). |
| 6 | "The firmware keeps only 16 bytes of SysEx, so SysEx protocol frames need a new path with a larger buffer." | **PARTLY WRONG / misleading** | `usb.sysex[16]` (`usb.c:139`) is used only to match the 6-byte UBOOT/OTA keys. **`FELUCCA_OTA` is 1 in default builds** (`platform.c:108`, and `docs/API.md:242` says "Leave it on"). With it on, the firmware also has a **640-byte SysEx receive frame** (`usb.c:147-154`, `sx_frame[640]`, `sx_collect`/`sx_ready` at `usb.c:692-723`) and a **64-packet SysEx TX ring that is sent before notes** (`usb.c:155-156`, `ep1_tx` at `usb.c:883-895`). Every received SysEx frame that is not the UBOOT/OTA key gets collected there. The main loop drains it with `ota_service()` (`platform.c:400`, `ota.c:179-184`), which **silently drops** any frame that does not pack7-decode to the M-UPGRADE header `00 59 cmd len24 … chk` (`ota.c:161-175`). So the conclusion stands: SysEx does not reach the app today. But the firmware change is small: dispatch non-`00 59` frames from `ota_service` to the app, and reuse the existing 640-byte buffer, pack7 codec and TX ring. A new large buffer is not needed. Also note that the existing framing has length plus checksum, which suits the spec's "bounded frames" rule (section 9). |
| 7 | Alternative transport "CDC-ACM serial (`FELUCCA_CDC=1`)". | **CONFIRMED, with a caveat** | `platform.c:109` sets `#define FELUCCA_CDC 0`, so CDC is **off in default builds**. Using serial needs a rebuild and reflash. The firmware also gives the CDC to `console.c`, so it would have to be shared or replaced. |

### Gaps relevant to building the spec

1. **No firmware app emits REC down/up today.** `midi_send` is defined at `platform.c:306`, but a grep finds no caller in `firmware/src/*.c`. `BTN_REC` exists (`platform.c:36` for FM-1, `:42` for SMK). The press-and-hold push-to-talk flow (spec section 2 golden path, section 7 control mapping) needs a firmware app that sends BUTTON_DOWN/UP for REC. Until then, the Phase 2 voice work needs a host-side trigger (a keyboard shortcut or the simulator). The report does not say this.
2. **Outgoing safety filter is too narrow.** Blocking only `F0 22 24 35` is not enough. The companion should also refuse to send frames that pack7-decode to the M-UPGRADE header `00 59` (cmd 0x11 handshake, 0x30 read). If the console protocol reuses the pack7 framing, it must use a distinct header byte that can never collide with `00 59`.
3. **Real-mic numbers are still missing**, and spec section 8 "Audio smoke test" requires them. That covers recording-start latency against the <200 ms target, the sample rate from the BT HFP device (16 kHz) and from the built-in mic (48 kHz, resampled), and accuracy on real speech. `mic record` was never run. Its AVAudioConverter path from 48 kHz to 16 kHz Int16 is untested.
4. **Device switching and non-default device selection are not implemented** in the probe (`kAudioOutputUnitProperty_CurrentDevice`, section 4). Spec section 8 requires "device switching", and section 6 requires "microphone selection".
5. **"Configurable language" (spec section 8)** has no worked path. Parakeet v3 has no language parameter and auto-detects among European languages. The report gives no measurement of what Parakeet outputs for Hebrew input: garbage or an empty string. The silence/VAD gate does not catch a wrong language.
6. **Silent-input latency:** sherpa took 1.7–2.1 s on the silent fixture. This makes the VAD gate a latency need as well as an accuracy need. The sherpa VAD (`vad.js`) needs a Silero model, and I did not see one in the HF cache, so that would be a download. A plain RMS threshold needs no download.
7. **Packaging of native artifacts:** the Swift helper is built by `swiftc` with Command Line Tools only. A `.app` or launchd mode needs codesigning and an entitlement or `Info.plist` for microphone TCC (Open Question 2), plus a reproducible build step in `fm1-console doctor` (spec section 10). The report does not plan this.
8. **The FM-1 does not appear as a CoreAudio input** on this machine, although `FELUCCA_UAC` defaults to 1 (`platform.c:110-111`). The attached unit may run a build without UAC. If a future build exposes it, the capture helper must never auto-select the FM-1's UAC input, because it carries the synth's output and not a microphone.
