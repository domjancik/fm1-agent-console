# Implementation log

## 2026-11-17: session 1 (stopped at usage limit)

### Done

- **Phase 0 discovery:** four reports in `docs/discovery/`, each with a "Reviewer verification" section: `traycer.md`, `agent-deck.md`, `firmware.md`, `voice-midi.md`. Also `connected-device.md` (CoralFlower FM-1, VID 0x1209/PID 0x0001, and the operator's flash authorization).
- **Baseline firmware build works on this Mac** (OrbStack Docker, `~/.jieli/toolchain`, `~/fw-AC79_AIoT_SDK`). Agent Deck 0.7 `firmware-build` was built in the scratch copy `../.fm1-upstream/build-probe`, giving `build/agtdeck.fwsc`: 612222 B, identity `FM-1_24350`, SHA-256 `d88ce61e…eea`. It is not byte-identical to the upstream `dist/agtdeck-0.7.fwsc` (`c0d0b43e…`); the cause has not been investigated.

### Interrupted

The `traycer-focus-submit` workflow (run `wf_f7dc5fbe-034`) was stopped partway. Before resuming:

- Check `reports/disposable-allowlist.json` and Traycer for any disposable "FM1 smoke (disposable)" task it created.
- Check `git status` here for partial probe/vendor files.
- Resume with Workflow `resumeFromRunId: wf_f7dc5fbe-034`.

### Draft decisions (pending `docs/architecture-decision.md`)

- **Firmware:** option A. Fork Agent Deck's `firmware-build` (Dinghy 0.5, supports both flash chips) and `agtdeck.c`. Protocol v7 extends the CC 118/119 framing with request ids and acks, plus a "host owns navigation" flag. New `FM-1_9NN` identity.
- **Companion:** TS/Bun, because the Traycer protocol client is TypeScript.
  - Traycer access is direct WebSocket RPC through the vendored `@traycer/protocol` at `host-v1.5.4`. The CLI is kept for `task create`, `whoami` and `host status`.
  - Speech recognition is Parakeet int8 via `sherpa-onnx-node`.
  - Microphone capture is a Swift AVAudioEngine CLI.
  - MIDI uses `@julusian/midi` 3.8.1.
- **Emulator:** fm1-emu v0.5.1 `fm1-live --usb --midi none`.

### Open: wireless (operator request)

Verify whether FM-1 firmware can fit and support a wireless link to the PC: Bluetooth preferred (works on enterprise networks), Wi-Fi as an option. Leads, all unverified:

- Agent Deck's README lists "Bluetooth MIDI" among the FM-1's stock features.
- The SoC SDK is JieLi AC79 (`wl82`), an "AIoT" Wi-Fi/BT family.

Check:

1. Radio hardware fitted on the FM-1 board (mvave-fm1 docs, teardown).
2. Whether Felucca/Dinghy include any BT stack, and the flash/RAM budget. The app is currently 65 KB of 581 KB; RAM .data+.bss is 18 KB of 96 KB.
3. Whether the AC79 SDK BLE-MIDI stack can link into the bare-metal Dinghy platform.
4. macOS BLE-MIDI pairing (Audio MIDI Setup, Bluetooth panel) and the throughput of the CC-frame protocol over BLE.

## 2026-11-17: session 2 (integration)

- TraycerAgentAdapter, companion (`fm1-console`), companion-ui, smoke runner, firmware-inspect, recovery docs, BLE variant.
- Live T0–T9 pass on the disposable epic; simulated acceptance passes for the claude and codex chats (`reports/e2e.md`).
- Focus reaches window activation only on stock Traycer; tile and composer focus need `docs/upstream/traycer-deep-link.diff`.
- BLE variant `fm1-console-0.1-ble.fwsc` (FM-1_956): flash 89,956 B, RAM 25,832 B. Open: ~90–210 ms interrupt-off window at radio start, random address per boot.
- Flash preflight: NO-GO until the operator steps in `reports/preflight.md` are done (accessory Allow, splash version, mask-ROM chip ID, double-read backup).
