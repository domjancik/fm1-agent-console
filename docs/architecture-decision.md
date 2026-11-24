# Architecture decision

Date: 2026-11-17. Status: accepted by the operator ("prefer from scratch, we have new ux and different pc host").

Evidence: `docs/discovery/*.md`, each with a reviewer-verification section.

## Decision

Spec section 2 offered three options. We take **option C**: new firmware on the Dinghy 0.5 platform, with a new device app, a new device protocol and a new TypeScript companion.

| Component | Choice | Reason |
| --- | --- | --- |
| Firmware platform | Dinghy 0.5 (`zvenson/dinghy` @ `ea1b6bf`), platform files unmodified | Proven update path, OCT− rescue, both flash chips (`0x856014`, `0xB36014`), host mode, build checks. Keeping `platform.c`, `usb.c`, `ota.c`, `recovery.c` and `hal/` untouched keeps the updater and rescue risk at the level Dinghy already carries. |
| Device app | New `firmware/src/console.c` replacing `dinghy.c` | The spec's UX (Sessions/Tasks/Inbox views, voice states, acks, host-owned navigation) differs from Agent Deck's pages. Agent Deck's `agtdeck.c` is a reference only. |
| Device protocol | New "FM1C" protocol v1, CC-framed on USB-MIDI channel 16 (`docs/protocol.md`) | SysEx is consumed by the updater and never reaches the app (`usb.c`, `docs/API.md`). CC framing needs no platform change. The spec's sequence ids, acks, bounded frames and version negotiation are built in. |
| Companion | TypeScript on Bun, `apps/companion` | Traycer's protocol client is TypeScript (vendored, MIT, pinned to `host-v1.5.4`). Agent Deck's host is Python with tmux keystrokes, so nothing there is reusable. |
| Traycer transport | Direct WebSocket RPC with the vendored `@traycer/protocol`; the CLI for `task create`, `whoami`, `host status` | The CLI is scoped to the caller's Task and has no prompt submission, subscriptions or approvals (`docs/discovery/traycer.md` sections 2 and 3). |
| Speech | Parakeet TDT v3 int8 via `sherpa-onnx-node` in a Bun child process (NDJSON); Apple `DictationTranscriber` optional | Same transcripts as parakeet-mlx on fixtures, 0.15–0.65 s warm, about 1 GB, no Python, model already cached. Hotwords fail with the cached model, so technical vocabulary is fixed by a correction dictionary. |
| Mic capture | Swift CLI (`packages/speech/native/fm1-mic`) on AVAudioEngine, 16 kHz mono s16le on stdout | swiftc 6.4 is installed; mic permission is already authorized for the terminal. |
| MIDI | `@julusian/midi` pinned 3.8.1 | Prebuilt arm64; SysEx loopback passed on Node and Bun. |
| Desktop UI | Local web UI served by the companion (`apps/companion-ui`), plain TS + DOM | One small window; no Tauri, because Tauri would need its own mic and MIDI permissions. |
| Emulator | `fm1-emu` v0.5.1 macOS arm64, `fm1-live --usb --midi none` | Runs the real `.fwsc`, saves LCD and panel images, exposes a virtual MIDI port for end-to-end tests. |
| Package identity | `FM-1_95N`, USB product string `FM1 CONSOLE` | 96 (Wordscape), 97 (zp12, per Dinghy docs) and 99 (Dinghy) are taken; the installer's interrupted-update resume only recognises `_9\d\d` identities (`fm1_install.py:43`). |

## Licensing

- `firmware/` is GPL-3.0-only. It carries Dinghy's and Felucca's notices and its `LICENSING.md` authorship table, and upstream files stay byte-identical so local changes are distinguishable.
- `vendor/traycer/` is MIT with `VENDORED.md` provenance.
- Everything else is MIT. The companion talks to the firmware over MIDI only and links no GPL code.

## Guard rails

- The companion never sends SysEx. Its MIDI writer rejects any status byte `0xF0`, which covers the ROM-boot (`F0 22 24 35 7D F7`) and OTA (`F0 22 24 35 7F F7`) triggers.
- The firmware app never calls the update or rescue entry points.
- The Traycer bearer stays in memory and is never logged. Token refresh is delegated to `traycer whoami`.

## Consequences

- Firmware work: the new app file, protocol codec in C, host-mode tests for codec and UI states.
- Host mode needs Dinghy's 4-line macOS `gfx.c` fix (`section(".pool")`). It goes in as a separate, documented patch.
- Key gestures (double, long press) are timed in the device app.
- MASTER drives LCD brightness only if a HAL helper is added; the backlight is on/off (PA2). MVP leaves MASTER unused.
