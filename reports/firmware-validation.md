# Firmware validation: readiness gate (spec section 12)

Date: 2026-11-17. Candidate: **FM1 CONSOLE 0.1**, package identity **FM-1_951**.

**Verdict: not ready to flash.** Build, protocol, host harness and emulator pass. The live Traycer and audio checks
wait for the companion, and the backup and recovery checks have not been done. The operator's flash authorization
(`docs/discovery/connected-device.md`) requires a rollback image, a double-read flash backup and a fresh identity
read before any write. None of these has been done. Do not flash this package until the pending rows below pass and
the operator approves this exact package and device.

| Gate | Result | Evidence |
| --- | --- | --- |
| Build | **PASS** | Reproducible `.fwsc` built in Docker; all Dinghy build checks pass |
| Protocol | **PASS** | C codec matches the TS reference on all 83 shared vectors; link-layer tests pass |
| Host harness | **PASS** | 1,811 unit checks (codec, link, input, LED, model), 99 scenario checks, 19 screenshots; Dinghy's own suite passes on this tree |
| Emulator | **PASS** | The package in fm1-emu 0.5.1: 77 scenario checks, 19 screenshots identical to host mode, CoreMIDI handshake with the TS link |
| Live Traycer integration | pending (companion integration) | |
| Audio workflow | pending (companion integration) | |
| Hardware identity and compatibility | findings below; flash chip and update-path checks pending | `docs/discovery/connected-device.md` |
| Backup / recovery readiness | pending | |

## Candidate package

| | |
| --- | --- |
| Path | `/Users/dominikj/dev/personal/fm1-agent-console/firmware/dist/fm1-console-0.1.fwsc` (a copy of `firmware/build/dinghy-0.1.fwsc`) |
| SHA-256 | `00b00e64ae33da81869ce824d8d60bdace8a90c1620390d5b617c14e4c8b3eaf` |
| Size | 612,227 B |
| Identity | `FM-1_951`, read back from the file with `tools/fm1_install.py`'s `product_of()` (20 identity blocks) |
| App image | `build/dinghy.bin` 61,056 B, SHA-256 `5fc058562ccc1f9682210b4de5aefda42d5ba38b9b7189adc37cebc7739a7c63` |
| Update loader | `build/loader/ota.bin` 9,071 B, SHA-256 `68bfe16a96615f91ee09c4e9ab9b00f84053abc8db5958dc454ca5e8e5b1112f`; screen name `FM1 CONSOLE` |
| USB product string | `FM1 CONSOLE` (VID 0x1209, PID 0x0001; seen by fm1-emu's USB host) |
| Source | `fm1-agent-console` `firmware/` on Dinghy `ea1b6bf` (0.5) plus the changes in `firmware/UPSTREAM.md`; repo HEAD at build time `65e6365` with the firmware tree not yet committed |
| License | GPL-3.0-only (`firmware/LICENSE`, `firmware/LICENSING.md`) |

## Build — PASS

```sh
cd /Users/dominikj/dev/personal/fm1-agent-console/firmware
JIELI_TOOLCHAIN=~/.jieli/toolchain AC79_SDK=~/fw-AC79_AIoT_SDK ./build.sh --release 0.1
```

| | |
| --- | --- |
| Toolchain | `~/.jieli/toolchain` → `jieli-linux-toolchains-20260730.1`, pi32v2 clang 4.0.1 |
| SDK | `~/fw-AC79_AIoT_SDK` at `d179b448` (AC79NN_SDK_V1.2.1); the three pinned files match `SDK_SHA256` (no warning printed) |
| Container | OrbStack Docker 29.8.2, `debian:bookworm-slim` (`sha256:99c0b25c46d0…`), `--platform linux/amd64` |
| Time | about 8 s |
| Build checks | `.ram_text`: 916 instructions, no calls; image 61,056 B of 581,564; RAM .data+.bss 16,684 B of 98,304; pool 38,400 B of 344,064; register access in `hal/` only; no chip-ROM references; no 64-bit division, no float (the link would fail) |
| Reproducible | Rebuilding from the same tree gave the same package SHA-256 |
| Dev build | `./build.sh` → `build/dinghy.fwsc`, identity `FM-1_950` (used by Dinghy's tests) |

## Protocol — PASS

`sh firmware/tests/console/run.sh` (the unit part):

- **`vectors_test`: 1,277 checks, 0 failed.** `fixtures/device/vectors.json` (TS generator, checksum `7943f152`)
  becomes a C header (`tests/console/gen_vectors.py`). For each of the 51 valid frames the C codec checks:
  - decoding gives the same message;
  - encoding gives the same bytes;
  - framing gives the same CC stream;
  - the assembler recovers it with junk MIDI interleaved;
  - the direction filter rejects it from the wrong side.

  All 32 invalid frames fail with the same error code as the TS codec, including the 4 direction cases. A mutation
  test (accepting slot flags above 15) makes the suite fail, so it does detect divergence.
- **`link_test`: 440 checks, 0 failed.** Covered:
  - HELLO at boot and every 1000 ms until a HELLO_ACK, and immediately when USB comes up;
  - an ACK for every host frame except ACK and HEARTBEAT;
  - retransmission at 250, 500 and 750 ms with the same SEQ, a fault at 1000 ms, and no fifth send;
  - a busy ACK settles the frame;
  - the 32-entry duplicate guard: a repeat is re-ACKed and not re-run, and a frame is processed again only after
    32 newer ones;
  - ACK status 1 for an unknown type or a device-only type, status 2 for a bad body, no ACK for a bad checksum;
  - `rx_errors` saturates at 127;
  - host lost at exactly 3500 ms, pending frames dropped without a fault, input refused, HELLO resumes;
  - HELLO_ACK 0 or an unsupported version marks the link incompatible, with the reason kept;
  - a new vs the same `host_session`;
  - a host restart detected by its heartbeat uptime going back, ignoring the u14 wrap;
  - SEQ wraps after 127;
  - after a host loss the duplicate window is empty, so a new companion run's HELLO_ACK is not swallowed by an
    old-run frame with the same SEQ and 7-bit checksum;
  - a HELLO_ACK repeating the linked session (an answer to a second HELLO) keeps the inputs in flight and the
    duplicate window; one with another session drops them.
- The firmware's frames are also decoded by the TS codec in every host and emulator scenario: 0 undecodable frames.

## Host harness — PASS

`sh firmware/tests/console/run.sh` builds `firmware/src/console.c` with `-DDINGHY_HOST` on Dinghy's harness
(`tests/host.c`, extended as `firmware/UPSTREAM.md` lists). Result: `CONSOLE HOST TESTS PASSED`.

- **Unit tests:**
  - `input_test`, 29 checks: single at up + 300 ms; double without a single; a second down at exactly 300 ms still
    double, at 301 ms two singles; long at 600 ms while held, its release sends `up` only; a long second press;
    taps shorter than one pass; re-press between passes; independent keys; button edge order; encoder pacing and
    clamping; MASTER smoothing, deadband and pacing.
  - `led_test`, 37 checks: every priority row of protocol section 6 sampled over time; the no-host pattern; button
    LEDs per view and voice state.
  - `model_test`, 28 checks: exactly which regions each `SET_*` marks; a repeat marks nothing.
- **Scenarios: 99 checks, 0 failed** (`firmware/tests/console/scenario/`, host frames encoded by the TS codec,
  device output decoded by it, a second pass ACKs input like a live companion):

  | Scenario | What is checked |
  | --- | --- |
  | `sessions` | Resync ACKed frame by frame; gestures on keys 5, 6 and 7 with exact timing; HOME, REC held, encoders; MASTER 300 → ~900 paced; all 27 key LEDs vs section 6 at two times; the selection moved by the host; **0 px redrawn over 3 heartbeat-only seconds; 512 px (one cell) for one `SET_SLOT`** |
  | `views` | Tasks, inbox (backend degraded), page 2 with stale slots; EDIT and GLO LEDs |
  | `voice` | Recording → transcribing → reviewing → delivered; REC full, then blinking; SAVE full in reviewing; push-to-talk edges |
  | `confirm` | Confirm view; SAVE reported as a fact |
  | `nohost` | Boot: HELLO every second, only OCT+ blinking, keys glowing, presses not sent. After 3500 ms of silence: NO HOST, keys glow, the kept selection full, HELLO resumes, no input sent. **After reconnect and resync the screen is byte-identical to before.** |
  | `malformed` | Bad checksum (no ACK), unknown type (ACK 1), bad body (ACK 2), device type from the host (ACK 1), a 110-byte frame, an aborted frame, junk MIDI, an empty frame; `rx_errors` = 5; **the screen is byte-identical before and after**; a frame sent 3 times is ACKed 3 times |
  | `retransmit` | Unacknowledged BUTTON sent at +0, 250, 500 and 750 ms with the same SEQ; LINK ERR |
  | `incompatible` | HELLO_ACK 0 → HOST TOO OLD; HELLO continues |

- **Screenshots** in `reports/evidence/firmware-host/`: `sessions-mixed`, `sessions-selected-failed`,
  `toast-completed`, `tasks`, `inbox-degraded`, `sessions-page2-stale`, `voice-recording`, `voice-transcribing`,
  `voice-reviewing`, `voice-delivered`, `confirm`, `nohost-boot`, `connected`, `nohost-dimmed`, `reconnected`,
  `before-malformed`, `after-malformed`, `link-err`, `host-too-old` (PNG, 2x). `results.json` lists every check.
- **Dinghy's own suite** (`sh tests/run_tests.sh`, log in `reports/evidence/firmware-host/upstream-tests.log`):
  `ALL TESTS PASSED`. This covers the M-UPGRADE entry against our `build/dinghy.fwsc`, the update loader installing
  this build over another app, the loader screen, and the installer tests. The update and rescue path is intact.

## Emulator — PASS

`sh firmware/tests/console/run_emu.sh` (with `LIVE_HANDSHAKE=1` for the last part). It uses fm1-emu v0.5.1 macOS
arm64 (`.fm1-upstream/fm1-emu-bin/fm1-emu-0.5.1-macos-arm64`): `fm1-live --fwsc dist package --usb --midi none
--shot MS --lcd-only`. Host frames go in as USB-MIDI (`FM1_USB_SEND`) and the panel as `FM1_BENCH_KEYS`. The
device's USB replies are decoded with the TS codec. `--midi none` means no MIDI port of this Mac is opened, so the
real FM-1 is never touched.

- **77 checks, 0 failed** over 9 scenarios, the host scenarios plus a no-host boot:
  - USB enumerates as `FM1 CONSOLE`.
  - HELLO goes out at 334 ms, right after enumeration, then every 1000 ms with no host.
  - HEARTBEAT every 1000 ms with uptime counting.
  - Every host `SET_*`, HELLO_ACK and COMMAND_RESULT is ACKed within 15 ms.
  - Gestures on the package: single 300 ms after the up, long 600 ms after the down, double with no single.
  - Buttons and encoders (the emulator turns detent by detent, and the sums match); MASTER followed to 900.
  - No retransmissions while the host ACKs; 4 sends 250 ms apart when it does not.
  - Malformed frames: ACK statuses 1 and 2, `rx_errors` 5, the LCD unchanged.
  - Repeated frames are ACKed each time.
  - Host lost → NO HOST and HELLO resumes; reconnect → **the LCD is byte-identical to before**.
  - The emulator's LED readout shows all 27 key LEDs at glow level and only OCT+ among the buttons with no host.
- **Screenshots** in `reports/evidence/emu/` (`emu-*.png`): the same 19 states as host mode, plus `emu-nohost-boot`.
  `tests/console/compare_shots.py` found **all 19 shared states identical at RGB565 precision**, so the host
  harness renders exactly what the package renders.
- **Live CoreMIDI handshake** (`reports/evidence/emu/live-handshake.txt`, 7 checks, 0 failed; run on the earlier
  candidate `274cfb9b…`, not re-run on the current one after the review fixes below). `fm1-live --usb`
  in window mode exposes the package as the CoreMIDI device `FM1 CONSOLE (emu)`. The TypeScript `Link.host` from
  `packages/device-protocol` opened it by name and got:
  - the device's HELLO, answered with HELLO_ACK and negotiated proto 1;
  - SET_VIEW and SET_SLOT acknowledged by the firmware;
  - two device heartbeats in 2.5 s, with 0 invalid frames;
  - the port gone when the emulator quit.

## Live Traycer integration — pending (companion integration)

The firmware side is ready: the CoreMIDI handshake above runs against the real package. End-to-end tests T0–T9
need the companion (`apps/companion`), which other agents are building.

## Audio workflow — pending (companion integration)

The device side of voice is tested: REC edges, the voice view states, and the REC/SAVE LEDs. Capture and
transcription belong to the companion. The firmware builds with `FELUCCA_UAC 0`, so it presents no USB audio
input that macOS could pick as the default microphone.

## Hardware identity and compatibility

Source: `docs/discovery/connected-device.md` (read-only `system_profiler`). No new reads of the device were made
for this report.

| | Connected unit | Candidate |
| --- | --- | --- |
| Firmware | CoralFlower (Felucca family), USB product `CoralFlower FM-1`, VID 0x1209, PID 0x0001, bcdDevice 0x0301 | Dinghy 0.5 platform, USB product `FM1 CONSOLE`, VID 0x1209, PID 0x0001 |
| Flash chip | **unknown**: P25Q80 (0x856014) or UC25HQ80 (0xB36014) | Dinghy 0.5 accepts both (`hal/fm1_flash_map.h:22`), so the updater and settings work on either |
| Package identity | unknown (read it with `fm1_install.py --info` at preflight) | `FM-1_951` |

Findings:

1. **The identity is `FM-1_95N`.** The architecture decision chose `FM-1_97N`, but Dinghy's
   `docs/MAKE-IT-YOURS.md` lists `97N` as zp12's, so 97N would collide with an existing firmware. `96N` is the operator's Wordscape WIP, and
   `99N` is Dinghy. `FM-1_9NN` keeps `fm1_install.py`'s interrupted-update resume (`OWN_LOADER_RE`). The Firmware
   Hub's catalogue did not load for an online check, so `95N` is free as far as the local sources show. To change
   it, edit one line (`BOARD_PREFIX` in `firmware/tools/build.py`). `docs/architecture-decision.md` should be
   updated to say 95N.
2. **The installer will not find the console by name on its own.** `fm1_install.py`'s `PORT_RE` matches `fm-1`,
   `felucca` and similar names, but not `FM1 CONSOLE`. A later update needs `--port "FM1 CONSOLE"`. The update
   loader ("Felucca Update") and the OCT− rescue still match. The alternative is a USB name such as `FM-1 CONSOLE`,
   which the companion would then have to match instead.
3. Whether CoralFlower's own updater accepts a Dinghy-family package is **unverified**. Both are Felucca lineage,
   and the M-UPGRADE path is expected to apply. Check CoralFlower's `platform`/loader at preflight.
4. The app never writes flash and never calls the update or rescue entry points. The Dinghy updater, the boot guard
   and OCT− rescue are unmodified, and their tests pass on this tree.

## Backup and recovery readiness — pending

Not started:

- no rollback image in hand (the CoralFlower v0.7.1 package or the stock M-VAVE image);
- no flash backup;
- flash chip not identified;
- identity not re-read.

Tools available per `docs/discovery/firmware.md` section 4: the Dinghy updater, OCT− rescue, mask-ROM UBOOT with
`MvaveFM1Unbricker` (`info`, `backup` with a double read, `restore V15`), and the FM-1 Transporter. These are the
operator's preflight steps (Phase 6), with explicit approval of this package and device.

## Review fixes (adversarial review, 2026-11-17)

The review found three defects; each is fixed and, where the host can show it, covered by a test that fails on the
old code. The package above is the rebuild after these fixes (reproducible: two builds, same SHA-256).

- **Stale duplicate window after a host loss** (`fm1c_link.h`). The window survived the 3500 ms loss. A new
  companion run restarts its SEQ at 0, so its HELLO_ACK could match an old-run entry (same SEQ, same 7-bit
  checksum): it was ACKed but not processed, and linking slipped by a HELLO cycle. The window is now cleared when
  the host is lost (as the TS link's `close()` does). Test: `test_lost_then_new_run`.
- **A repeated HELLO_ACK dropped inputs in flight** (`fm1c_link.h`). Every new HELLO_ACK cleared the window and
  cancelled pending input frames, including one from the same companion run answering a second HELLO. A key press
  in flight was then lost without retransmission or LINK ERR. Now only a HELLO_ACK for another session, or one that
  arrives while not linked, resets them. Test: `test_repeated_hello_ack`.
- **Key state and press edges read non-atomically** (`console.c`). `fm1_in.notes` and the latched note edges were
  read at different times with the key-scan interrupt enabled. A press landing between the two reads looked like a
  finished tap followed by a second down, which the gesture timer reports as a double press. Both are now read in
  one `fm1__lock()` section (`port_keys`). The host harness has no interrupt, so this has no automated test.

## Bluetooth LE variant (`--ble`): not a flash candidate yet

Date: 2026-11-18. Built and tested only; never flashed, the radio never run on hardware. Details:
`docs/discovery/wireless.md`, "Build results" and "Stable address".

| | |
| --- | --- |
| Path | `firmware/dist/fm1-console-0.1-ble.fwsc` (a copy of `firmware/build/dinghy-0.1-ble.fwsc`) |
| SHA-256 | `1ef3b67aafe14f07b05ae7864780d4bbe8ac79518d89695bbade0b09c1aa87c5` (two builds, the same SHA-256; it was `35fb158c…e655` before the stable address) |
| Size | 612,227 B |
| Identity | `FM-1_956` (BLE builds: minor + 5) |
| App image | `build/dinghy.bin` 90,832 B, SHA-256 `58d2276145ba659a8aa1aa890fd127f24c93a23615e135daa602a2bba0ba0bd2`; RAM .data+.bss 25,864 B; `.ram_text` 1,120 instructions, no calls |
| Build checks | all pass, plus the BLE ones: `fm1_rf_burst_run` in `.ram_text`; `fm1c_ble.o` needs nothing of the app's but `memcpy`/`memset`; register access in `hal/` only |
| BLE address | **stable per unit**: a static random address hashed from the SPI flash's factory unique ID (`0x4B`, read once per boot from RAM with interrupts off; no flash write). Fallback, never random: `C6:46:31:43:00:00` |
| Name on the Mac | **`FM1 CONSOLE XXXX`**, XXXX = the address's last two octets in hex; `FM1 CONSOLE 0000` means the fallback. In the emulator: `CE:5D:B1:E5:9F:7F`, `FM1 CONSOLE 9F7F` (both flash parts) |
| Default USB package | still byte-identical after a default rebuild: `00b00e64ae33da81869ce824d8d60bdace8a90c1620390d5b617c14e4c8b3eaf`, `dinghy.bin` `5fc05856…` |

| Test (2026-11-18) | Result |
| --- | --- |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0 failed; `fm1c_ble_addr` 19 / 0 failed; `fm1c_flash_uid` 43 / 0 failed |
| `sh firmware/tests/console/run.sh` | 1,811 unit checks (1,277 + 440 + 29 + 37 + 28), 99 scenario checks, 0 failed |
| `run_emu.sh dist/fm1-console-0.1.fwsc` | 77 / 77; 19 screens identical to host mode |
| `run_emu.sh dist/fm1-console-0.1-ble.fwsc` | 63 / 77: the 14 known failures in the radio's start window at 3 s (interrupts off about 90 ms in the emulator, open item); 19 screens identical |
| `sh firmware/tests/run_tests.sh` | ALL TESTS PASSED; `ota_test` and `ldr_test` on the BLE package (from an older app and from the USB build): passed |

Open before this package can be a candidate: the start-up stall, a runtime BLE ON/OFF, and on the device a check that
the name stays the same over two power cycles and is not `FM1 CONSOLE 0000`.

## UX v2 firmware (2026-11-18): built and tested, not flashed

`docs/ux-v2.md` §1.2, §2.4, §2.5 and §4 on the device side: plain words everywhere, version 2 as a rendering marker
(`FM1C_PROTO_MAX 2`, HELLO now says 1..2), and with version 2 agreed the KNOB1–KNOB4 legend tags, the line 4 hint
bar, the voice transcript, the keyboard-shaped key strip with pinned marks, and the SCL-hold help overlay. With an
old companion (version 1) the legend, line 4 and strip are drawn as before. Never sent to the FM-1.

`firmware/dist/` is **unchanged**: it still holds the pre-UX-v2 candidates (`00b00e64…` USB, which the FM-1 runs, and
`1ef3b67a…` BLE). `dist/` is not tracked by git, so overwriting it would lose the copy of the image on the device. The
UX v2 packages are in `firmware/build/`; promoting them to `dist/` is the orchestrator's call.

| Package | Path | Identity | SHA-256 (2 builds each, identical) | Size | App image |
| --- | --- | --- | --- | --- | --- |
| USB (default) | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `3ec1505fe5bc5e505d112b77b16003fab399f160f11b057cc51f451f065b49d0` | 612,227 B | `dinghy.bin` 63,288 B (was 61,056), SHA-256 `2d92af6eb92dcbe43126b536109c906f8149a747c51b86ae7bfd1312670a104c`; RAM .data+.bss 16,716 B; `.ram_text` 916 insns |
| BLE (`--ble`) | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `0ccaef7fdd4e835c4332e515435f8f9f69ae411c619240322b6ca6728d9fc435` | 612,227 B | 93,248 B (was 90,832), SHA-256 `d91553994864ea8009f2999bf1ad172add971b27ec65934af1fd25a5ae7c5286`; RAM .data+.bss 25,880 B; `.ram_text` 1,120 insns |

Identities read back from each file with `tools/fm1_install.py`'s `product_of()`. The USB package was built a third
time (after the BLE builds, for `run_tests.sh`) and again gave `3ec1505f…`. All build checks pass, including the BLE
ones (`fm1_rf_burst_run` in `.ram_text`, `fm1c_ble.o` needs only `memcpy`/`memset`, register access in `hal/` only).
The update loader is unchanged (`ota.bin` `68bfe16a…`). The stable BLE address from the BLE step is in this build.

Review fix (2026-11-18, adversarial review): a button pressed under the help and let go after it closed sent an
orphan BUTTON up (the host never heard the down); keys already stayed silent to the end of such a press. Buttons now
do the same (`fm1c_help_button`, `btn_muted`; 5 new checks in `input_test.c`). This changed both packages: before the
fix they were USB `240b52f9…` and BLE `291740ca…`; the hashes above are after it (each built twice, identical).

| Test (2026-11-18) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 2,308 unit checks, 0 failed (vectors 1,324 incl. the 3 shared negotiation vectors; link 445; input 455; LED 37; model 47); device-string scan 82 literals, 0 failed; 186 scenario checks, 0 failed (16 scenarios, 8 new); 42 screenshots in `reports/evidence/firmware-host/` |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB) | 125 / 125; 42 screens identical to host mode (`compare_shots.py`); evidence in `reports/evidence/emu/` |
| `run_emu.sh firmware/build/dinghy-0.1-ble.fwsc` (BLE) | 102 / 125; 42 screens identical. The 23 failures are all the known radio start at 3 s: a 1,093 ms heartbeat gap in 15 of the 17 emulator runs, plus 5 late-ACK checks, 2 gesture checks and 1 retransmit-gap check whose events land inside the stall (8). Same cause as the 14 / 77 before; the 8 new scenarios add 9. Evidence kept in the scratchpad, not in `reports/evidence/` |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0 failed; `fm1c_ble_addr` 19 / 0 failed; `fm1c_flash_uid` 43 / 0 failed |
| `sh firmware/tests/run_tests.sh` | ALL TESTS PASSED |

New scenarios (host and emulator): `v2-sessions` (KNOB tags, hint bar, keyboard strip, pinned key, ok dot; one white
key = 476 px, one black key = 360 px, unpin = 360 px), `v2-help-base` / `-voice` / `-confirm` (no help at 350 ms,
help at 400 ms, only SCL's edges sent while held, a host frame under the help draws nothing, redraw on release),
`v2-voice-reviewing`, `v2-confirm`, `v1-compat` (version 1: old legend, line 4, 8 x 64 cells, 512 px per slot, SCL is
an ordinary button), `nohost-v2-words`. After-screens of the 24 `before/` scenes: `reports/evidence/ux-v2/after/`
(`scripts/render-after.ts`, version 2 agreed, the same host frames as `before/`).

## Session DETAILS firmware, protocol version 3 (2026-11-18): built and tested, not flashed

`docs/ux-v2.md` §7.3–§7.6 and `docs/protocol.md` (versions 1–3) on the device side. `FM1C_PROTO_MAX 3` (HELLO now
says 1..3); `SET_TEXT` (0x4C) decoded and encoded (row 0–11, count 1–3 with row + count ≤ 12, style 0–2, ≤ 29
characters); `SET_VIEW` view 5 `detail`. The model keeps a 12-row text buffer in every view (a changed row marks only
that row; a repeat nothing; a new host session clears it to empty body). View 5 draws the status bar, the 12 rows
(body white, heading amber, muted #A0A0A0) and the hint band `PRESETS page  LFO close` at 216–239, where a
`COMMAND_RESULT` toast also goes; no panel, key strip or legend. Entering or leaving view 5 redraws everything. The
help overlay in view 5 covers 24–215 with `FM1C_HELP_DETAIL`; `FM1C_HELP_BASE` lines 7 and 9 changed as §7.6 says
(both tables checked byte for byte against the spec text). LFO LED full in view 5. LFO's BUTTON edges were already
sent in every view; the host decides. Every version 2 rule was already `proto >= 2`, so a version 3 link in the base
views draws as version 2 (scenario `v3-base-as-v2`). Never sent to the FM-1.

Files: `firmware/firmware/src/fm1c_proto.h`, `fm1c_model.h`, `fm1c_draw.h`, `fm1c_help.h`, `fm1c_led.h`,
`console.c` (comment only); `firmware/tests/console/gen_vectors.py`, `vectors_test.c`, `link_test.c`, `model_test.c`,
`led_test.c`, `scenario/scenarios.ts`, `scenario/emu-run.ts`. Dinghy platform files, `fm1c_ble.*` and `hal/` are
unchanged.

`firmware/dist/` is **unchanged**. The new packages are in `firmware/build/`:

| Package | Path | Identity | SHA-256 (2 builds each, identical) | Size | App image |
| --- | --- | --- | --- | --- | --- |
| USB (default) | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `f609d3e3b878d2a049ec4fa81ee5b989de4f998d69c74cfd29119eed1eafec7f` | 612,227 B | `dinghy.bin` 64,456 B, SHA-256 `2407f22aca76750944d9d30067c9a3590639172920bc9ad558c52569d84b1212`; RAM .data+.bss 17,100 B; `.ram_text` 916 insns |
| BLE (`--ble`) | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `ec02057473a0875e13b834965867c053322337159b59fe72e950432c4f9f77aa` | 612,227 B | 94,376 B; RAM .data+.bss 26,264 B; `.ram_text` 1,120 insns |

The USB package was built a third time after the BLE builds (for `run_tests.sh`) and again gave `f609d3e3…`. All
build checks pass. The update loader is unchanged (`ota.bin` `68bfe16a…`).

| Test (2026-11-18) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 2,582 unit checks, 0 failed (vectors 1,582: 58 valid, 38 invalid, 7 negotiation; link 447; input 455; LED 39; model 59); device-string scan 93 literals, 0 failed; 235 scenario checks, 0 failed (19 scenarios, 3 new: `v3-detail`, `v3-detail-help`, `v3-base-as-v2`); 55 screenshots |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB) | 143 / 143. `compare_shots.py` against fresh host-mode shots: 55 / 55 identical. Against the checked-in `reports/evidence/firmware-host/` 40 / 42: the 2 `v2-help-base*` screens show the old help text (that folder was not regenerated) |
| `run_emu.sh firmware/build/dinghy-0.1-ble.fwsc` (BLE) | 117 / 143; 55 / 55 screens identical to fresh host mode. The 26 failures are the known radio start at 3 s (a 1,093 ms heartbeat gap, and ACKs, gestures and a retransmit gap that land inside the stall); in `v3-detail` the 5 late ACKs are the page-2 frames sent at exactly 3,000 ms |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0 failed; `fm1c_ble_addr` 19 / 0 failed; `fm1c_flash_uid` 43 / 0 failed |
| `sh firmware/tests/run_tests.sh` | ALL TESTS PASSED |

New scenarios: `v3-detail` (SET_TEXT outside view 5 stored and not drawn; view 5 styles, hint band, no strip or
legend; LFO LED full / HOME off; one changed row = 3,840 px; a repeat = 0 px; page 2; toast in the hint band and gone
after 2.5 s; LFO edges sent; back to sessions pixel-identical to before), `v3-detail-help` (no help at 350 ms; help
over 24–215 with the hint band kept; only SCL's edges sent; a SET_TEXT under the help drawn on release),
`v3-base-as-v2`. Screens: `reports/evidence/ux-v2/after/detail-*.png` (host mode) and `emu-detail-*.png` (the USB
package in fm1-emu). Host and emulator evidence of the full run is in the scratchpad, not in `reports/evidence/`.

## UI v3 firmware, protocol version 4 "characters" (2026-11-18): built and tested, not flashed

`docs/ui-v3.md` §4–§6 (direction A, Buddy and bubble) on the device side. `FM1C_PROTO_MAX 4` (HELLO says 1..4);
version 4 adds no message: it changes how `SET_DETAIL`, `SET_SLOT`, `SET_TEXT`, `SET_VOICE` and `SET_LEGEND` are
drawn (`docs/firmware-ui.md` "Version 4: characters"). With version 1–3 agreed every screen is drawn as before: all
v1–v3 host-mode screenshots are byte-identical to the checked-in `reports/evidence/firmware-host/` except the three
drawn before any version is agreed (`nohost-boot`, `nohost-v2-words`, `host-too-old`), which now show the version 4
banner with the ghost (the layout before the first host is the newest one). Never sent to the FM-1.

What is new: sprites (8 poses x Claude cat / Codex bot, 24 x 24 heroes drawn 2x and 12 x 12 minis, from
`firmware/assets/sprites/*.png` through `firmware/tools/gen_sprites.py` into `fm1c_sprites.h`, byte-equal check in
`run.sh`); the animation scheduler (`fm1c_anim.h`: frames from the clock, ≤ 2,400 px a pass, hero first, skipped
never queued, only on a pass with no content drawn, no host frame queued, no unACKed device frame
(`fm1c_link_busy`) and 20 ms after host traffic); the version 4 layout (18-row top bar, 48 x 48 hero + label, the
speech bubble with caption, key name, 5 body rows and the more wedge, the critter keyboard in 40 rows, the hint bar at
the bottom of every view, the knob row for 2 s after a K1–K4 turn, the voice bubble with REC dot and 28-bar meter,
DETAILS with the hero header, the two-strip banner, help with who is who). Link protection: content is drawn a
region at a time and stops when a host frame came in (`fm1c_yield`), and nothing is drawn while a burst of host
frames is still arriving (`draw_held`: gap < 3 ms, at most 120 ms).

Files: `firmware/firmware/src/console.c`, `fm1c_proto.h`, `fm1c_model.h`, `fm1c_draw.h`, `fm1c_help.h`, `fm1c_link.h`
(`fm1c_link_busy`, read-only), new `fm1c_draw4.h`, `fm1c_sprite.h`, `fm1c_sprites.h` (generated), `fm1c_anim.h`;
`firmware/assets/sprites/` (32 PNGs), `firmware/tools/gen_sprites.py`, `firmware/tools/sprites_seed.py`;
`firmware/tests/console/anim_test.c` (new), `model_test.c`, `link_test.c`, `vectors_test.c`, `run.sh`, `run_emu.sh`
(`HOST_EVIDENCE`), `scenario/scenarios.ts`, `scenario/builder.ts`, `scenario/host-run.ts`, `scenario/emu-run.ts`.
Dinghy platform files, `fm1c_ble.*`, `hal/`, `gen/`, `tools/build.py` and `firmware/dist/` are unchanged.

| Package | Path | Identity | SHA-256 (2 builds each, identical) | Size | App image |
| --- | --- | --- | --- | --- | --- |
| USB (default) | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `df6eda86323c28aea90d44e652931abfa99931dabe99baf64c32c928cefc7ca5` | 612,227 B | `dinghy.bin` 92,376 B (was 64,456), SHA-256 `5020afcf96ca1426d38dccad9f8c062b940f9d7e039af4e97fa6056689bc3d81`; RAM .data+.bss 17,228 B (+128); `.ram_text` 916 insns |
| BLE (`--ble`) | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `ef5554f5c42a29ea9fa11de2ad19ffb2733732c0000fe564e150f578b84b35f4` | 612,227 B | 122,036 B (was 94,376; limit in the spec 125 KB), SHA-256 `7019240e74e860960f191228313062075a81366f3699a0cb8e555f13f4c05ce4`; RAM .data+.bss 26,392 B (+128); `.ram_text` 1,120 insns |

All build checks pass (one fix on the way: two new dirty-bit literals `0x10000u` / `0x20000u` matched the MMIO
window check and are written as shifts). The update loader is unchanged (`ota.bin` 9,071 B).

| Test (2026-11-18) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 2,856 unit checks, 0 failed (vectors 1,586; link 466, incl. `fm1c_link_busy`; input 455; LED 39; model 91; anim 219: sprite decode and blitter, frame timing, pass budget, skipped frames, calm minis); sprites header byte-equal; device-string scan 141 literals, 0 failed; 384 scenario checks, 0 failed (30 scenarios, 11 new `v4-*`); 79 screenshots |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB, `HOST_EVIDENCE` = the fresh host shots) | 211 / 211 (was 143 / 143 before the 11 v4 scenarios); `compare_shots.py` 79 / 79 screens identical to host mode |
| `v4-soak` on the USB package (60 s, every key and the hero animating, 20 host frames/s, heartbeats, knob turns and PLAY taps) | every host frame ACKed, worst 3 ms (limit 15); 0 retransmissions of 36 input frames; 62 heartbeats, every gap 1,000 ms (jitter 0 ms). Worst ACK over all 31 emulator scenarios: 6 ms |
| Redraw counters (host mode, `v4-counters`) | 3 s calm: 27,648 px (the sleeping hero only); one `SET_SLOT` 196 px; one bubble row 3,584 px; 27 keys animating: worst pass 2,304 px, 24,768 px/s |
| `sh firmware/tests/run_tests.sh` | ALL TESTS PASSED |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0 failed; `fm1c_ble_addr` 19 / 0; `fm1c_flash_uid` 43 / 0 |

Test harness fixes found on the way: (1) `builder.ts` paced host CCs at 24 per ms, more than fm1-live's emulated bus
carries (one 64-byte packet, 16 CCs, per 1 ms frame); the v4 connect burst (~55 ms) then queued on the bus, and the
ACK check, which counts from the schedule, reported 16–21 ms. The checked-in version 3 package
(`dist/fm1-console-0.1.fwsc`) shows the same 21 ms on that burst, so it was the wire, not the firmware; pacing is now
16 CCs per ms and the worst ACK is 3–6 ms. (2) The companion-ACK schedule deduplicated input frames by SEQ over the
whole run; long runs reuse SEQs, so it is now per 1 s and iterated until stable (host and emulator). (3) Two
screenshot times moved (`voice-recording` 2,950 → 2,980 ms: an emulator `--shot` run had not yet drawn a frame
sent 40 ms before; `v4-todo-approval` 1,500 → 1,700 ms: the emulator's clock runs 1 s ahead of host mode, which
shifts 6 fps poses by 2 frames; frames 0 and 2 of `hand` look alike).

Screens: `reports/evidence/ui-v3/after/` — `host/` (host mode), `emu/` (the USB package, plus `results.json`),
`side-by-side/<scene>.png` (design mock | host | emulator for the 7 mock scenes), `contact-sheet.png`,
`anim-host.gif` (t, t + 125, t + 250 ms).

Open: no physical check of the characters on the panel (gamma, the mid-greys); sprites are still the procedural
first pass (`docs/ui-v3.md` §7); the BLE package was not run in the emulator for this change (its radio start at 3 s
was a known emulator failure before); the companion side of version 4 (bubble rows, PRESETS scroll, the order rule)
is the host agent's work and was not exercised end to end against this firmware; the device simulator parity
(§6.4) is not part of this step.

### Version 4: adversarial review (2026-11-18)

Read-only review of `git diff firmware/` and the two `firmware/build/` packages. No firmware defect was found, so
nothing was rebuilt and the hashes above stand. Never sent to the FM-1, nothing flashed.

| Check | Result |
| --- | --- |
| Reproducible | Clean copy of `firmware/` (no `build/`, `dist/`) at another path, `./build.sh --release 0.1 --ble` then `--release 0.1`: BLE `ef5554f5…b84b35f4` (`dinghy.bin` `7019240e…c05ce4`), USB `df6eda86…cefc7ca5`: identical to `firmware/build/` |
| `firmware-inspect verify` | BLE `--expect-identity FM-1_956 --expect-sha256 ef5554f5…`: OK, app.bin 122,036 B of 581,564 B; USB `--expect-identity FM-1_951 --expect-sha256 df6eda86…`: OK; wrong identity: exit 1 |
| Budgets | BLE image 122,036 B (spec ≤ 125 KB); RAM .data+.bss 26,392 B of 98,304 (+128, spec ≤ +256); largest canvas 240 x 80 = `CV_MAX` |
| Upstream | `diff -rq` against `.fm1-upstream/dinghy`: only the five documented files differ; none changed by this work. `UPSTREAM.md` "Added files" now lists `fm1c_draw4.h`, `fm1c_anim.h`, `fm1c_sprite.h`, `fm1c_sprites.h`, `assets/sprites/`, `tools/gen_sprites.py`, `tools/sprites_seed.py` |
| Host tests (re-run) | `run.sh`: 2,856 unit checks / 0 failed, sprites byte-equal, 141 strings, 384 scenario checks / 0 failed, 79 shots; the 24 `v4-*` shots byte-equal to `reports/evidence/ui-v3/after/host/`; 52 of 55 v1–v3 shots byte-equal to `reports/evidence/firmware-host/` (the 3 pre-host screens differ as documented) |
| Emulator, USB package, animations on | 211 / 211, 79 / 79 screens equal to host mode; heartbeat gaps 1,000 ms in all 31 scenarios; worst ACK per scenario 0–6 ms; `v4-soak` 62 heartbeats, jitter 0, worst ACK 3 ms, 0 of 36 input frames resent |
| Emulator, baseline `dist/fm1-console-0.1.fwsc` (v3) | same harness: heartbeat gaps 1,000 ms, worst ACK 0–7 ms (2 expected failures: HELLO 1..3, no knob frames). The v4 package is no worse |
| Emulator, BLE package (subset `sessions`, `v4-sessions`, `v4-detail`, `v4-help`, `v4-soak`) | 30 / 40: one ~93 ms stall at t ≈ 2 s (heartbeat gap 1,093 / 907, ACK 94 ms) and the `sessions` gesture checks. The flashed `dist/fm1-console-0.1-ble.fwsc` (`ec020574…`) fails the same checks at the same time (95 ms): the emulator's BLE radio start, not the animation. Apart from it, `v4-soak` on BLE: gaps 1,000 ms, 0 of 36 resent |
| Code review | Regions tile 240 x 240 (top 0–17, hero 0–51 x 18–67/71, label 52–239, bubble strips 68–77 / 78–175 / 94–95 / 176–183, caption 78–93, rows 96–175, keyboard 184–223, hint 224–239); animation boxes stay inside their region (hero 48 x 48 at (4, 20), mini 12 x 12 inside the 14 x 14 key box, keeping its frame and pin, REC dot 8 x 8 at (10, 84), ghost 48 x 48 at (96, 62) in the banner); sprite indices bounded (hero ≤ 59 of 60, mini ≤ 25 of 26, pose < 8 or none); `cv_pset` clips. The animation runs only with every dirty mask empty, no queued host frame, no unACKed device frame, 20 ms after host traffic and not under help; help, DETAILS, dim and lit transitions reset what it tracks. `v4-help-closed` vs `v4-help-before` differ only inside the hero and mini sprite boxes (frames) |

Notes, not defects: (1) the help overlay is drawn in one pass (206 rows, ~49,000 px, about 66 ms of SPI at 12 MHz)
with no yield; version 3's was ~42,000 px, also unyielded. An ACK can wait that long once when SCL is held, inside the
250 ms retransmit window. (2) fm1-emu's LCD timing is not the AC79's SPI, so loop timing on the panel is still
unmeasured. (3) With the operator's current companion (protocol 3) the device agrees version 3 and draws exactly the
version 3 screens; only the screen before the first host is the version 4 banner. The characters appear once the
version 4 companion runs. (4) Against the A mocks: the recording meter draws taller, coloured bars and no
"speak; let go to stop" row; the dimmed status bar stays dim under NO COMPANION (mock: lit); the confirm bubble shows
`SET_DETAIL` lines 2–4, each ≤ 20 characters (`v4-confirm` sends a 22-character line, cut to "stops the running tu").

## LIST layout firmware, protocol version 5 (2026-11-18): built and tested, not flashed

`docs/ui-v3.md` §8 on the device side. `FM1C_PROTO_MAX 5` (HELLO says 1..5). Version 5 is additive: the C codec
decodes the optional `SET_VIEW.layout` byte and `SET_SLOT.title` (≤ 20) / `age` (≤ 3) in every version (both or
neither; longer strings, layout > 1 or bytes left over are `bad_body`) and passes the host's 10 new shared vectors and
4 negotiation vectors. With Sessions or TO DO and layout 1 the device draws the list (`docs/firmware-ui.md` "Version 5:
the LIST layout"): the 24 x 24 hero and a header bubble (caption, key name, one 24-column line, the more wedge), 10 rows
(mini, key name, title, age; the selected row on #303030) in windows of 10, a scroll thumb above 10 entries; SEQ LED
full while it shows; help `FM1C_HELP_BASE5`. Voice, confirm, DETAILS and Tasks stay the version 4 screens. With
version 1–4 agreed nothing changes: all 24 `v4-*` host shots and all 24 `emu-v4-*` emulator shots are byte-identical
to the checked-in ones, and the v1–v3 host shots too (except the same 3 pre-host screens as before). Never sent to the
FM-1.

Files: `firmware/firmware/src/fm1c_proto.h`, `fm1c_model.h`, `fm1c_draw4.h` (the list dispatch, the small hero and row
minis in `fm1c_draw_anim`, the cut-corner frame as `fm1c_v4_frame`), new `fm1c_draw5.h`, `fm1c_anim.h`
(`hero_small`: 576 px a frame), `fm1c_help.h`, `fm1c_led.h`, `fm1c_draw.h`, `console.c` (SEQ LED context,
`dirty_lrows` in `anim_ok`, `FM1C_ENCODE_DEVICE_ONLY`); `firmware/tests/console/vectors_test.c`, `gen_vectors.py`,
`model_test.c`, `link_test.c`, `led_test.c`, `anim_test.c`, `scenario/scenarios.ts`, `scenario/fixtures.ts`,
`scenario/emu-run.ts`. Dinghy platform files, `fm1c_ble.*`, `hal/`, `gen/`, `tools/` and `firmware/dist/` are
unchanged. Flash: the BLE image first came to exactly 125,000 B; leaving the host-message cases out of the device's
encoder (`FM1C_ENCODE_DEVICE_ONLY` in `console.c`; the tests still build the full codec) brought it to 123,920 B; the review fixes below make it 124,008 B (992 B under the limit).
RAM +688 B, mostly the 27 slots' title (21 B) and age (4 B).

| Package | Path | Identity | SHA-256 (2 builds each, identical) | Size | App image |
| --- | --- | --- | --- | --- | --- |
| USB (default) | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `962d538de0e19ebcb7fc38be0b6340b9830402d32906466e77d1df7ada50f39e` | 612,227 B | `dinghy.bin` 94,268 B (was 92,376), SHA-256 `cd958aecc87121d62105c77e3f5f47c35def0712b4998d114d41b1bc6a97a8c3`; RAM .data+.bss 17,916 B (+688); `.ram_text` 916 insns |
| BLE (`--ble`) | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `ca215dda97ccf0a4f1ecd21ec445ab4198505a0875e4ea490e6dd84ecb8c09c5` | 612,227 B | 124,008 B (was 122,036; spec ≤ 125 KB), SHA-256 `de7c50f5225a9347cc4b74143eb67d99ba5bc04a9ed2bf42e1d6519e1b90713d`; RAM .data+.bss 27,080 B (+688); `.ram_text` 1,120 insns |

The update loader is unchanged (`ota.bin` 9,071 B). All build checks pass.

| Test (2026-11-18) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 3,154 unit checks, 0 failed (vectors 1,856: 64 valid, 44 invalid, 15 negotiation, plus local checks of both version 5 body forms and their bad bodies; link 468; input 455; LED 42; model 112; anim 221); sprites header byte-equal; device strings 147 literals, 0 failed; 527 scenario checks, 0 failed (39 scenarios, 9 new `v5-*`); 101 screenshots |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB, `HOST_EVIDENCE` = the fresh host shots) | 265 / 265 (was 211; 41 runs); `compare_shots.py` 101 / 101 screens identical to host mode |
| Link with animations (emulator, USB package) | every heartbeat gap 1,000 ms in every scenario; worst ACK 6 ms over all scenarios (limit 15), 3–5 ms in the 9 `v5-*`; `v4-soak` (60 s, every sprite moving, 20 host frames/s): 62 heartbeats, jitter 0 ms, worst ACK 3 ms, 0 of 36 input frames resent |
| Redraw counters (host mode, `v5-list-window`, `v5-list-anim`) | one `SET_SLOT` age: 3,776 px (one row); a selection change inside the window: 11,632 px (two rows + the caption strip + 7 minis); a moved window: 42,432 px (all rows, gaps, scroll column, header strips); list animation 1 s: 8,640 px (≤ 10,400) |
| `sh firmware/tests/run_tests.sh` | ALL TESTS PASSED |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0 failed; `fm1c_ble_addr` 19 / 0; `fm1c_flash_uid` 43 / 0 |

Scenarios (host and emulator; shots in `reports/evidence/ui-v3/after/host/v5-*.png` and `after/emu/emu-v5-*.png`):
`v5-list-sessions` (the sample page, 15 entries, thumb; SEQ lit; SEQ goes out as BUTTON), `v5-list-todo` (TO DO, the
approval selected, Codex hero), `v5-list-toggle` (buddy → list → buddy: selection kept, bubble and label back
exactly), `v5-list-window` (14 entries, the 12th selected: window 10–13, thumb at y 176; redraw counters),
`v5-list-page` (OCT+ and page 2), `v5-list-detail` (LFO into the version 4 DETAILS and back), `v5-list-voice` (REC
from the list: the version 4 voice screen, then the list as before), `v5-list-anim` (only the hero box and the row
minis change), `v5-help` (SCL held over the list).

Open: no physical check (as version 4); the companion's version 5 side (SEQ toggle, layouts in config, the 24-column
header, title / age) was not run end to end against this firmware (the scenarios use the TS codec's version 5 frames);
the BLE package was not run in the emulator for this change (known emulator radio-start stall); the window jumps by
whole windows of 10 (`docs/ui-v3.md` §8.10).

Adversarial review (2026-11-18), two defects fixed, packages rebuilt (2 builds each, identical) and verified with
`tools/firmware-inspect verify --expect-identity --expect-sha256` (both `RESULT: OK`):

- **Occupancy swap left stale rows.** `fm1c_list_check` compared the entry count, so a burst that emptied one key in
  the window and filled another (same count, same window) shifted the rows between them without redrawing them. It now
  compares the occupancy mask (`fm1c_list_occ`, `list_occ` replaces `list_n`), as §8.5 says. New check in
  `model_test.c`.
- **Header text past the spec width.** `SET_TEXT` rows decode up to 29 characters; the whole-header redraw drew a longer
  caption or message line over the key name and the frame (to x 239) while the strip redraw clipped at x 231, so a
  later strip left pixels behind. `fm1c_draw5.h` now cuts the caption at 20 and the message line at 24 (`fm1c_v5_text`).

After the fixes: `run.sh` 3,154 unit checks / 527 scenario checks, 0 failed; all 46 `v4-*`/`v5-*` host shots and all 46
`emu-v4-*`/`emu-v5-*` shots byte-identical to the checked-in ones; `run_emu.sh` (USB) 265 / 265, 101 / 101 screens equal
to host mode, every heartbeat gap 1,000 ms, worst ACK 6 ms; `v4-soak` 62 heartbeats, jitter 0 ms, 0 of 36 resent;
`run_tests.sh` ALL TESTS PASSED; `tests/ble/run.sh` 1,180 / 19 / 43, 0 failed.

## GROUPED list, PINNED, LEDs v2 and transitions, protocol version 5 additions (2026-11-18): built and tested, not flashed

`docs/ui-v3.md` §9 on the device side (still `FM1C_PROTO_MAX 5`). The C codec decodes `SET_VIEW.layout` 2 and the
optional `SET_SLOT` row byte with its head fields (indent 3, bits 4–6, task without start, a missing head field, head
flags > 1, head title > 20, count > 11 and bytes left over are `bad_body`) and passes all 71 valid / 53 invalid shared
vectors. Sessions with layout 2 draws the GROUPED list (header rows, folded task rows, indents; `docs/firmware-ui.md`
"Version 5: the GROUPED list"); PINNED and its empty state are drawn from the host's frames. LED language v2 (the
selected key alone in the backlight layer, breathing from the main loop through `fm1_led_bg_ns`; blinks per state;
`docs/firmware-controls.md`) replaces the version 1 table with version 5. New `fm1c_trans.h`: every §9.10 transition
(selection slide List/Grouped and Buddy, hero pop, page wipe, layout wipe, reader open/close, reader page and list
window by hardware vertical scroll with the `FM1C_VSCROLL_HW 0` fallback, toast and knob row in/out, voice text
scroll), within the version 4 scheduler rules (passes of ≤ 2,400 px, link served between them, start only with the link
quiet, input completes at once, end at t0 + 120 ms). Help `FM1C_HELP_BASE5` per §9.11 (byte-equal to the host's
`HELP_TEXT.base5`: `packages/agent-core/test/control-map.test.ts` 6 / 0). Never sent to the FM-1; no flash, no SysEx.

Files: `firmware/firmware/src/fm1c_proto.h`, `fm1c_model.h`, `fm1c_draw4.h`, `fm1c_draw5.h`, `fm1c_led.h`,
`fm1c_help.h`, `console.c`, new `fm1c_trans.h`; `firmware/tests/console/led_test.c`, `model_test.c`, `vectors_test.c`,
`gen_vectors.py`, new `gen_led_v2.py` (reads `fixtures/device/led-v2.json`), `run.sh` (plus the fallback build),
`compare_shots.py`, `scenario/scenarios.ts`, `builder.ts`, `fixtures.ts`, `parse.ts`, `host-run.ts`. Platform files
(`hal/`, `src/lcd.c`, `platform.c`, `gfx.c`, `dinghy.c`), `fm1c_ble.*`, `gen/`, `tools/` unchanged (the scroll uses
`lcd.c`'s `lcd_cmd` / `lcd_data` / `lcd_window`, the LEDs only `fm1_led_bg[]` / `fm1_led_bg_ns`).

| Package | Path | Identity | SHA-256 (2 builds each, identical) | Size | App image |
| --- | --- | --- | --- | --- | --- |
| USB (default) | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `48ff637c03442ce4089a68e416c1e515aa837799ba063adc488d1bc73b137cac` | 612,227 B | `dinghy.bin` 103,272 B (was 94,268), SHA-256 `bbd950a0b53108bb46c7e895987a6f1ee0aa4f35157ee859baeac325fba3f0c3`; RAM .data+.bss 19,212 B (+1,296); `.ram_text` 916 insns |
| BLE (`--ble`) | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `762ef8fe1e7226c103e4d50de6d99aa4c360e8ec9ee9e0fe678a4b7ddbe2119c` | 612,227 B | 133,160 B (was 124,008; cap raised by §9.13 to 140 KB = 143,360 B: 10,200 B under), SHA-256 `171ecb4d425e31aa460650172f64da4698137f6f088e6adfecbdeb0552f8d8e7`; RAM .data+.bss 28,360 B (+1,280; §9.13 now allows ≤ +1,536 B = 28,616 B: 256 B under); `.ram_text` 1,120 insns |

These are the packages after the second review below (it changed both; before it they were USB `6e1cbedb…cc98f7` and
BLE `fd8f4a2e…bbbf9`). `build.py`'s only hard limit is the app slot (581,564 B); both images pass every build check. `tools/firmware-inspect
verify --expect-identity --expect-sha256`: both `RESULT: OK`. The update loader is unchanged (`ota.bin` 9,071 B).

| Test (2026-11-18) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 4,454 unit checks, 0 failed (vectors 2,305; link 468; input 455; LED 883, of which the `led-v2.json` samples and breathing table; model 122; anim 221); sprites header byte-equal; device strings 147 literals, 0 failed; 749 scenario checks, 0 failed (58 scenarios, 19 `v5g-*`); 171 screenshots; fallback build (`FM1C_VSCROLL_HW 0`) 19 / 0 |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB, `HOST_EVIDENCE` = the fresh host shots) | 379 / 379 checks (373 in the full run, 6 in `v5g-trans-select-buddy` run with `ONLY=` after it was added); `compare_shots.py` 128 / 128 screens identical to host mode (the transition step shots `v5g-trans-*-<n>` are skipped: their content depends on SPI and pass timing; fm1-emu 0.5.1 also ignores `VSCRSADD`, so its window/page step shots show the fallback; every `-done` screen is identical) |
| Link with animations and transitions (emulator, USB) | every heartbeat gap 1,000 ms in every scenario; worst ACK 6 ms over all scenarios (limit 15; 2–4 ms in the transition scenarios); `v4-soak` 62 heartbeats, jitter 0 ms, worst ACK 3 ms, 0 of 36 input frames resent (unchanged) |
| Transitions (host mode, px a transition / largest step) | select List 27,432 / 11,328; select Buddy 1,084 / 588; hero 1,800 / 600; page 38,704 / 12,956; layout 49,440 / 12,480; reader open 2,258 / 888, close 1,854 / 752; reader page 36,480 / 9,120; window 38,400 / 9,600; toast and knob in/out 11,520 / 3,840; voice 71,680 / 17,920 (see open points); all end at t0 + 120 ms (reader t0 + 110); a key press mid-wipe completes it at once |
| `sh firmware/tests/run_tests.sh` | ALL TESTS PASSED |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0; `fm1c_ble_addr` 19 / 0; `fm1c_flash_uid` 43 / 0 |
| Unchanged screens | all 24 `v4-*` and 20 of 22 `v5-*` host shots and their `emu-` twins byte-identical to the checked-in ones; `v5-help` / `v5-help-held` changed on purpose (the §9.11 help text) |

Scenarios (shots in `reports/evidence/ui-v3/after/host/v5g-*.png` and `after/emu/emu-v5g-*.png`; transition GIFs in
4× slow motion in `after/transitions/`): `v5g-grouped`, `v5g-grouped-window`, `v5g-pinned`, `v5g-pinned-empty`,
`v5g-trans-select`, `-select-buddy`, `-hero`, `-page`, `-seq`, `-reader` (open and close), `-reader-page`, `-window`,
`-toast` (in and out), `-knob` (in and out), `-voice` (forward and back), `-interrupt`, `v5g-help`, `v5g-leds`,
`v5g-leds-nohost` (every key condition and button over time). The step shots are taken 15 ms after §9.14's
1,000 + n ms (`SETTLE`: host mode shoots before that ms's passes).

Fixes made while finishing the interrupted work: the transitions now hold until t0 + 120 ms (they ended after their
last step, drawing held-back regions early); step 3 of the selection slides and the hero pop draws the final rows /
boxes / sprite (it was left to the end); the shown-screen snapshot is taken at a transition's end, not its start (the
voice scroll drew the new rows over themselves); a reader-outline check looked for the wrong colour.

Open points:

- **Simulator replay** (`packages/device-simulator/test/v5g-firmware-parity.test.ts`, host side, not changed here) now
  runs against these shots and fails: 41 of 70 shots identical, 29 differ. Each difference was traced to the
  simulator or its replay, not to the firmware against §9: the simulator draws the toast as coloured text on the hint
  background where the firmware keeps the version 4 filled bar (`toast-*`); it applies each frame of a burst at once
  where the firmware holds the burst (version 4 rule), so it shows `SET_TEXT` rows on the old screen and misses
  multi-frame triggers (`reader-*`, `reader-close-0`, `voice-back-50`, `page-*`, the deselect of `select-*`); it draws
  held-back regions (hint, hero, scroll column) during a transition (`seq-*`, `page-70`); its reader page fills the
  whole area with the new page instead of the exposed rows (`reader-page-*`); its replay opens the help at the SCL
  press and applies encoder turns made under the help (`help-not-yet`, `help-closed`); small edge differences in
  `select-buddy-*`, `knob-out-0`, `hero-0`. `tests/run_tests.sh`-level bun suites that include this file will fail
  until the simulator follows.
- **RAM (resolved):** +1,280 B (BLE 28,360 B). 972 B are the 27 slots' row byte and head fields (state, flags, title
  21 B, count 12 B), which the protocol carries per key; the rest is the transition state and the shown-screen snapshot
  (voice rows). The spec owner raised §9.13's cap to +1,536 B (≤ 28,616 B); the image is 256 B under it.
- **Voice text scroll budget (resolved):** §9.10's row (4 × 17,920 = 71,680 px) is over the 60,000 px a transition; the
  spec owner accepted the row (4 steps, each ≤ 18,000 px) and §9.10's budget note now says so.
- **On-device checks pending:** hardware vertical scroll registers; breathing range (48,000 ns vs a lit key, 4,000 ns vs
  the glow) and the input ISR cost of the longer backlight pulse.
- The BLE package was not run in the emulator (known radio-start stall). `after/emu/results.json` is now the second
  review's full run (403 checks, 63 runs).

### GROUPED round: second adversarial review (2026-11-18)

Review of `git diff d763751..HEAD -- firmware/` (HEAD `abe22f0`; no uncommitted firmware changes at the start). Never
sent to the FM-1, nothing flashed, no SysEx.

**Why the hashes moved.** The firmware agent reported USB `51c1f9cf…edad62` / BLE `ef368800…41d689c` (`dinghy.bin`
103,036 / 132,892 B). The first review attempt then fixed two defects (below), rebuilt (USB `6e1cbedb…`, BLE
`fd8f4a2e…`, +200 B / +236 B of code), wrote those hashes into the table above and ended before its emulator run
finished; its fixes are in `abe22f0`. A rebuild of the clean `abe22f0` tree gave `6e1cbedb…` and `fd8f4a2e…` again
(two builds each, identical), so the files matched the committed source. The first attempt's two fixes:

- a selection slide onto or off a key whose group header changed in the same burst left that header row undrawn
  (`fm1c_trans.h`; scenario `v5x-select-head`);
- a host change under the help started a transition from the screen before the help when it closed (`console.c`;
  scenario `v5x-help-trans`); plus `v5x-window-interrupt` (a key press mid-scroll restores the scroll at once).

**Defects found and fixed in this pass** (each with a check that fails on `abe22f0` and passes now):

- **Hero pop, squash step: the sprite's top rows were black** (`fm1c_tr_hero`). The loop cleared the 6 · scale rows
  above the squashed sprite while it was still copying rows down, and rows d 0–4 read source rows it had already
  cleared, so the top of the sprite (the pose's dots, the ears) was missing for the 30 ms step. The clear now runs
  after the copy. Check in `v5g-trans-hero` (y 32–36 not all black); `after/host/v5g-trans-hero-0.png` and
  `after/transitions/v5g-trans-hero.gif` regenerated.
- **Grouped session title not cut by the indent** (`fm1c_draw5_row`). §9.3 has the host cut the title to 20 − indent
  characters; the decoder accepts 20 at any indent, and a longer one drew over the age. The device now cuts it too
  (the same hardening as the version 5 header fix). New scenario `v5x-title-cut`.
- Test harness: `compare_shots.py` compared the first attempt's mid-scroll shot `v5x-window-interrupt-mid` (fm1-emu
  0.5.1 ignores `VSCRSADD`, like the skipped `v5g-trans-*-<n>` shots) and two `v5x` shots whose list hero shows another
  animation frame (the emulator clock runs ahead). The mid shot is now skipped and the two compare with the hero box
  (x 0–28, y 18–59) excluded. `UPSTREAM.md` now lists `fm1c_trans.h`.

**Checked, no defect:**

| Area | Result |
| --- | --- |
| `SET_SLOT` row / head decode | message zeroed first; row u7 ≤ 15 with indent 3, bits 4–6 (via the 15 limit) and task without start rejected; head_state < `FM1C_N_STATE`, head_flags ≤ 1, head title ≤ 20, count ≤ 11, printable only; bytes left over `bad_body`; the encoder mirrors it. All strings copied with `fm1c_str_set` to their `FM1C_L_*` size |
| Regions in 240 × 240 | header row: count ≥ x 145, title ≤ `(xc − 8 − x0) / 8` chars and NUL-bounded into a 21 B buffer; session rows 62–221 (`FM1C_V5_ROW_Y + 16n`); entry indices `k << 1` with k < 27, rows < 10 for every `1u << row`; hero squash rows stay inside the 24 × 25 / 48 × 50 canvas; reader outlines inside (0, 18, 240, 206); page / layout / toast / voice slices inside their bands; `fm1c_cvx` clips to the canvas and the step's slice |
| Transitions | start only with no host frame waiting and no unACKed device frame; key, button, encoder edge, help open/close, link loss / return / renegotiation complete one at once; a step later than 40 ms ends it; end held to t0 + 120 ms (reader t0 + 110); sprites wait (`anim_ok`) |
| Hardware scroll state | VSCRSADD returns to TFA at every transition end (the last step lands on it; `fm1c_tr_end` → `fm1c_vs_identity` covers every early end: input, help, host loss, late step); nothing else draws while a transition runs, so no full redraw, banner or help is drawn under an offset; VSCRDEF stays defined but with the identity start it maps nothing; every boot (`lcd_init`: SWRESET, in the app, the update loader and `recovery.c`) resets both registers. Only exception: a CPU fault during a 120 ms scroll would draw Dinghy's crash screen under the offset (upstream `platform.c`, untouched; the reboot after it resets the panel) |
| Fallback | `FM1C_VSCROLL_HW 0`: window and reader page are drawn at once (`fm1c_trans_detect` returns 0); `run.sh`'s fallback build 28 / 0 |
| LEDs v2 | `fm1_led_bg_ns` is a `volatile uint16_t`, written once every 20 ms by the main loop (one aligned store, ≤ 48,000); `fm1_led_bg[]` is read-modify-written only by the main loop and only read by the input ISR (`hal/fm1_input.h:294`), the pattern of `fm1_led_key_glow`. Only `FM1C_LED_BACK` puts a key in the layer and only `fm1c_key_level2` / `_nohost` return it, for a key with the selected flag; buttons never; leaving version 5 clears it through `led_set` |
| Help | `FM1C_HELP_BASE5` byte-equal to §9.11's block; `control-map.test.ts` 6 / 0 |
| Upstream | `diff -rq` against `.fm1-upstream/dinghy`: only the five documented files differ, none touched by this round; `hal/`, `src/lcd.c`, `platform.c` unchanged |

**Packages after the fixes** (two builds each, identical; a third USB build after `run_tests.sh` identical too;
`firmware-inspect verify --expect-identity --expect-sha256`: both `RESULT: OK`, wrong identity exit 1):

| Package | Identity | SHA-256 | App image | RAM .data+.bss |
| --- | --- | --- | --- | --- |
| `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `48ff637c03442ce4089a68e416c1e515aa837799ba063adc488d1bc73b137cac` | 103,272 B | 19,212 B |
| `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `762ef8fe1e7226c103e4d50de6d99aa4c360e8ec9ee9e0fe678a4b7ddbe2119c` | 133,160 B (cap 143,360) | 28,360 B (cap 28,616) |

| Test (this pass) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 4,454 unit checks, 0 failed (vectors 2,305; link 468; input 455; LED 883; model 122; anim 221); sprites byte-equal; 147 device strings, 0 failed; 785 scenario checks, 0 failed (62 scenarios: 19 `v5g-*`, 4 `v5x-*`); 180 screenshots; fallback build 28 / 0 |
| Host shots vs `abe22f0` | all 178 identical except `v5g-trans-hero-0` (the fix); 119 of the 120 checked-in `after/host/` identical (same one) |
| `run_emu.sh` on the USB package `48ff637c…` (full run, foreground, to the end) | 403 / 403 checks, 63 runs; `compare_shots.py` 136 / 136 identical (after the harness fix; 3 differed before it, all explained above) |
| Link vs the `d763751` baseline (`962d538d…`, rebuilt from `git archive d763751`, the same harness, its 40 runs: 265 / 265) | worst ACK 6 ms in both (limit 15); in the 23 `v5g`/`v5x` runs ≤ 3 ms; heartbeat gaps 1,000 ms in 62 of 63 runs, `sessions` (version 1) 1,000 / 1,001 / 999 ms once (baseline: 1,000; the same on `6e1cbedb`); `v4-soak` identical to the baseline: 62 heartbeats, jitter 0 ms, worst ACK 3 ms, 0 of 36 input frames resent |
| `sh firmware/tests/run_tests.sh` (after a dev `./build.sh`, `FM-1_950`) | ALL TESTS PASSED |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0; `fm1c_ble_addr` 19 / 0; `fm1c_flash_uid` 43 / 0 |
| Emulator, BLE package `762ef8fe…` (full, 63 runs, no screen compare) | 385 / 403. All 18 failures are the known radio start: host frames delivered at t 2,000–2,050 ms ACKed 45–95 ms late (14 runs, incl. `v5g-trans-reader` and `v5g-trans-voice`, whose trigger frame is sent at 2,000 ms), the `sessions` gestures and the `retransmit` gap (341 ms) that fall in it, and one heartbeat 4 ms late at 2,004 ms in `v5g-trans-voice` (gate ±2; the USB package: 1,000). No failure outside that window; the UI v3 round had 26 of 143 with the same cause. Heartbeats elsewhere 1,000 ms |

Screens read: the five static `v5g` screens, every step shot of the window, reader page, selection, layout, reader,
voice, toast, knob, page and interrupt transitions, and the regenerated hero GIF.

**Review verdict: GO** for `firmware/build/dinghy-0.1-ble.fwsc` (`FM-1_956`, `762ef8fe1e7226c103e4d50de6d99aa4c360e8ec9ee9e0fe678a4b7ddbe2119c`) as the grouped round's firmware: no open defect, all host and USB-emulator gates pass, the BLE emulator failures are the known radio start only. This is not a flash approval: the BLE open items (start-up stall, runtime BLE on/off, name over two power cycles) and the flash gate at the top of this report still apply.

Open: on-device checks of VSCRDEF/VSCRSADD, the breathing range and the ISR cost of the longer backlight pulse; the
simulator replay (host side) still differs on the 29 shots listed above; the BLE radio-start stall in the emulator; the
flash gate at the top of this report (backup, rollback image, operator approval) still applies to any package.

## SPLIT keys and SETTINGS, protocol version 6 (2026-11-19): built and tested, not flashed

`docs/ui-v3.md` §10 on the device side (`FM1C_PROTO_MAX 6`). The C codec decodes the version 6 forms: `SET_VIEW` view 6
and the optional `keys` byte after the layout (keys 1 with `task_page` < `task_pages`, `task_pages` ≥ 1; view > 6,
keys > 1, a missing task byte, keys 0 followed by a byte and bytes left over are `bad_body`), `SET_SLOT` flags ≤ 31
with bit 4 chosen (bits 0 and 4 together `bad_body`); the message is zeroed first, so keys absent = RANKED. The
encoder mirrors every rule. New `fm1c_draw6.h`: the SPLIT black row (11 chips 26 × 16 on two staggered lines at the
physical key centres 22…218, stems, task page dots), the 4-row Buddy bubble with the white minis unchanged at y 202,
the List/Grouped band (y 60–91) over 8 rows from y 94, compact black boxes over voice/confirm, and the SETTINGS view
(view 6). `fm1c_trans.h`: the task wipe (3 steps, direction by page), the SPLIT page wipe regions and the 8-row
hardware window scroll (TFA 94, VSA 128). `fm1c_led.h`: CHOSEN (L 0–699, G 700–999, checked first, never in the
backlight layer) and ARP lit in view 6. `fm1c_help.h`: `FM1C_HELP_BASE6`, `SPLIT6`, `SETTINGS6`. OCT single/double and
the ARP hold are resolved on the host from the `BUTTON` edges the device already sends (§10.2, §10.5): no input change
in the firmware. Never sent to the FM-1; no flash, no SysEx.

Files: `firmware/firmware/src/fm1c_proto.h`, `fm1c_model.h`, `fm1c_draw.h` (no page number in view 6), `fm1c_draw4.h`,
`fm1c_draw5.h`, `fm1c_led.h`, `fm1c_help.h`, `fm1c_trans.h`, new `fm1c_draw6.h`; `firmware/UPSTREAM.md` (the new
file's row); tests `vectors_test.c`, `link_test.c`, `led_test.c`, `model_test.c`, `gen_vectors.py`, `gen_led_v2.py`,
new `help_equal.py`, `run.sh`, `compare_shots.py`, `scenario/{scenarios,fixtures,host-run,emu-run}.ts`. Platform files
unchanged: `diff -rq` against `.fm1-upstream/dinghy` lists only the five documented files (`gfx.c`, `usb.c`,
`tests/host.c`, `tools/build.py`, `LICENSING.md`), none touched in this round (`git diff` of `hal/`, `lcd.c`,
`platform.c`, `gfx.c`, `dinghy.c`, `ble/`, `gen/`, `tools/` is empty).

| Package | Path | Identity | SHA-256 | Size | App image | RAM .data+.bss |
| --- | --- | --- | --- | --- | --- | --- |
| USB (default) | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `1a6216a34cb00ca7b27d3a2ffd0efef98995e05d3243bddaa144bd6a558a6833` (2 builds, identical) | 612,227 B | `dinghy.bin` 107,324 B (af9905c: 103,252; +4,072), SHA-256 `fa5b24c8ebace72880ecf5f039550045c7d610f9780509e165dd427dcd017a1c`; `.ram_text` 916 insns | 19,212 B (unchanged) |
| BLE (`--ble`) | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `652616961b8cc86aa2959f5a8320a531b1013d45156871d2a44f06bfc7bf77bf` | 612,227 B | 137,300 B (cap 143,360: 6,060 B under), SHA-256 `458d7acb2fae4127a4284646c873f44dfa6575dafca1d6cf429273b28f48358f`; `.ram_text` 1,120 insns | 28,360 B (cap 28,616, unchanged) |

Both images pass every `build.py` check; the update loader is unchanged (`ota.bin` 9,071 B).

| Test (2026-11-19) | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | 5,588 unit checks, 0 failed (vectors 2,678 against 81 valid / 61 invalid / 19 negotiation shared vectors; link 474; input 455; LED 1,620 incl. `led-v2.json` `chosen`; model 140; anim 221); sprites byte-equal; 163 device strings, 0 failed; help tables 10 of 10 byte-equal to agent-core `HELP_TEXT` (`help_equal.py`, incl. `base6`, `split6`, `settings6`); 1,523 scenario checks, 0 failed (108 scenarios: 14 new `v6-*`/`v6x-*`, 32 `v6-ranked-*` replays); 315 screenshots; fallback build (`FM1C_VSCROLL_HW 0`) 40 / 0 |
| RANKED pixel identity | the af9905c firmware rebuilt from `git archive HEAD` and run through its own harness (785 / 785, 180 shots): all 180 shots byte-identical to this build's. The 32 `v6-ranked-*` replays (HELLO_ACK 6, keys 0) are byte-identical to their version 5 shots, help line 1 excepted (`host-run.ts`, 102 checks). The three checked-in `firmware-host` PNGs that changed (`host-too-old`, `nohost-boot`, `nohost-v2-words`) were stale in git: af9905c's own build draws the new ones too |
| Protocol 5 companion | `v6-v5-companion`: HELLO offers 1..6, the companion agrees 5, screen unchanged, ARP edges as before and never lit |
| SPLIT / settings shots | `reports/evidence/ui-v3/split/host/` (34 shots), `ranked/` (101 shots), `emu-all/` (315 PNGs and `results.json`) |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB `1a6216a3…`, full run, foreground until the end) | 679 / 679 checks, 109 runs; `compare_shots.py` 220 / 220 identical (95 transition step shots skipped as before). One screen, `v6-split-grouped`, first differed in 10 px: the question character's blinking `!` accent in the hero box (x 24–25, y 27–32), the emulator's clock running ahead of host mode; it is now in `HERO_MASKED` like the four version 5 shots of the same kind |
| Link vs the af9905c baseline (`b58a2a25…`, rebuilt from `git archive HEAD`, the same harness version, 63 runs: 403 / 403, compare 136 / 136) | worst ACK 6 ms in both (limit 15); in the 63 common runs ≤ 6 ms in both (6 runs 1 ms better, none worse); the 14 new SPLIT/settings runs ≤ 2 ms, the 32 RANKED replays ≤ 3 ms; heartbeat gaps 1,000 ms in every run but `sessions` (version 1: 1,000 / 1,001 / 999, the same in the baseline); `v4-soak` identical to the baseline: 62 heartbeats, jitter 0 ms, worst ACK 3 ms, 0 of 36 input frames resent |
| `sh firmware/tests/run_tests.sh` (after a dev `./build.sh`, `FM-1_950`) | ALL TESTS PASSED |
| `sh firmware/tests/ble/run.sh` | `fm1c_ble` 1,180 / 0; `fm1c_ble_addr` 19 / 0; `fm1c_flash_uid` 43 / 0 |
| Host side, not changed here | `packages/agent-core` `control-map.test.ts` 7 / 0; `packages/device-protocol` 327 pass, 1 skip, 0 fail |

Screens read: `v6-split-buddy`, `v6-split-list`, `v6-settings-split` and the `v6-split-grouped` hero crop in both runs.

**Not done here:** the BLE package was not run in the emulator (the known radio-start stall); the simulator parity test
against these shots is host-side work. **Needs checking on the device:** whether the CHOSEN timeline and the 26 × 16
chips read well, plus the open items of the grouped round. The flash gate at the top of this report (backup, rollback
image, operator approval) still applies to any package.

### Review of the SPLIT round and the fast-scroll fix (2026-11-19): current packages

These packages replace the hashes in the table above (`1a6216a3…` / `65261696…`) and the fast-scroll build
(`2f4988ea…` / `0f2ec966…`). Adversarial review of `git diff HEAD -- firmware/` (protocol 6 decode bounds, version 5
negotiation, SETTINGS input, SPLIT regions inside 240 × 240, SPI budget, LED timelines, help tables, platform files,
RANKED identity, the section 9.10.1 fast-scroll rules). One defect confirmed and fixed:

- **SETTINGS body drawn as one 49,440 px region.** On entry (or any `FM1C_D_LIST` mark in view 6), `fm1c_draw4` drew the
  gap, all 9 item rows and the description in one `FM1C_STEP`, so the link had no turn for about 66 ms of SPI at 12 MHz.
  That is 5 times the largest region this file allows (the keyboard, 9,600 px), and an ACK for a frame that arrived
  then would miss the 15 ms limit. Fix (`fm1c_draw4.h`): the `FM1C_D_LIST` step now draws only the 960 px gap and marks
  `dirty_rows` 0–9, so each item row (4,800 px) and the description (5,280 px) is its own region with a yield between
  them. The pixels are the same: the 10 emulator settings shots are byte-identical to the ones from before the fix.
  (Host mode and the emulator do not model SPI time, so no test failed before the fix.)

| Package | Path | Identity | SHA-256 | App image | RAM .data+.bss |
| --- | --- | --- | --- | --- | --- |
| USB | `firmware/build/dinghy-0.1.fwsc` | `FM-1_951` | `c167c5169f5677f54764931e835f15c7cc22ae9b8b6d42011dace0ad532730e6` (2 builds, identical) | 107,412 B, `dinghy.bin` SHA-256 `51e830cb72882db88abad790ccd9b85adae8a63c8e8358bc06563525fb63cbc9` | 19,228 B |
| BLE | `firmware/build/dinghy-0.1-ble.fwsc` | `FM-1_956` | `1060760c0aa3c8fcbac13b09580b67525ba462e17248f81c42412982302a01d6` (2 builds, identical) | 137,316 B (6,044 B under the 143,360 B cap), `dinghy.bin` SHA-256 `2d1da5992f16f7e9d0863b892371d62f370abe8f4e7496b121a92d08458f4064` | 28,376 B (cap 28,616) |

Every `build.py` check passes; the update loader is unchanged (`ota.bin` 9,071 B). `bun tools/firmware-inspect/src/cli.ts
verify <pkg> --expect-identity … --expect-sha256 …` returns `RESULT: OK` for all four builds.

| Test | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | CONSOLE HOST TESTS PASSED: unit 5,588 / 0 (vectors 2,678, link 474, input 455, LED 1,620, model 140, anim 221); device strings 163 / 0; help tables 10 of 10 byte-equal; scenarios 1,634 / 0 over 118 scenarios, 343 shots; software-scroll build 40 / 0 |
| `sh firmware/tests/ble/run.sh` | 1,180 / 0, 19 / 0, 43 / 0 |
| `sh firmware/tests/run_tests.sh` (after a dev `./build.sh`, `FM-1_950`) | ALL TESTS PASSED |
| `run_emu.sh firmware/build/dinghy-0.1.fwsc` (USB `c167c516…`, run to the end) | CONSOLE EMULATOR TESTS PASSED: 739 / 739 checks over 119 runs; 248 screens compared, 0 differ; 95 transition-step shots skipped as before |
| Link against af9905c (`base-emu`: 403 / 403, 63 runs) | worst ACK 6 ms in both (limit 15); the 63 shared runs are equal (none better, none worse); the v6 runs at most 3 ms, the settings runs 2 ms, the v5x fast-scroll runs at most 2 ms; heartbeat gaps 1,000 ms everywhere except version 1 `sessions` (999 / 1,000 / 1,001, as in the baseline); `v4-soak` 62 heartbeats, jitter 0 ms, 0 of 36 input frames resent |
| `packages/device-simulator` `bun test` | 122 pass, 1 skip, 0 fail; `v6-split.test.ts` 17 / 0 (model and LED data; there is no pixel parity test against the SPLIT firmware shots) |

## Rich text, protocol version 7 (2026-11-23): built and tested, not flashed

`docs/ui-v3.md` §13.5–13.6 and `docs/protocol.md` (version 7) on the device side (`FM1C_PROTO_MAX 7`). The decoder reads
each `SET_TEXT` row with `fm1c_text_str`: at most 37 bytes, each printable ASCII or `0x01`–`0x04`, at most 29 visible
(printable or `0x04`), else `bad_body`. It does not count style bytes (the TypeScript reader `fields.ts textRow` does
not either, so a row of 10 style bytes and 20 visible characters is valid on both sides); the test encoder mirrors
`sanitizeTextRow` (`?` for other bytes, cut after 29 visible, style bytes past the 8th dropped). The model and the
voice snapshot keep rows as `char[38]` (+96 B, +56 B; frame struct +24 B). One drawing function, `fm1c_rich`
(`fm1c_draw.h`), draws every `SET_TEXT` row: bold amber `0xFD80` (white in a heading row), code `0x869F`
(`FM1C_C_CODE`), off back to the row colour, rule 1 px `0x8410` at cell x + 3 for 16 px; no background. Glyphs go out
in runs of one colour through `cv_text` (one ramp per run), so a row without marks is the same single `cv_text` call
as before. `fm1c_v5_text` now cuts by visible cells. Never sent to the FM-1; no flash, no SysEx.

Files: `firmware/firmware/src/fm1c_proto.h`, `fm1c_model.h`, `fm1c_draw.h`, `fm1c_draw4.h`, `fm1c_draw5.h`,
`fm1c_draw6.h`, `fm1c_trans.h`; tests `vectors_test.c` (new `version7_forms`), `link_test.c`, `gen_vectors.py`
(v7 rows encodable), `run.sh` (parity step, `ui-v3/markdown/host/`), `scenario/scenarios.ts` (4 new `v7-*`
scenarios, HELLO 1..7), `scenario/emu-run.ts`, new `scenario/v7-parity.ts`. Platform files unchanged (`diff -rq`
against `.fm1-upstream/dinghy`: only the five documented files); `fm1c_help.h` unchanged (help text byte-equal).

| Package | Path | Identity | SHA-256 | App image | RAM .data+.bss |
| --- | --- | --- | --- | --- | --- |
| USB | `firmware/dist/fm1-console-0.1.fwsc` (= `build/dinghy-0.1.fwsc`) | `FM-1_951` | `69f1755d30d03c92986b99104225d80de579ccc276f1b092c7ddb8fd85f30827` | 108,316 B | 19,388 B |
| BLE | `firmware/dist/fm1-console-0.1-ble.fwsc` (= `build/dinghy-0.1-ble.fwsc`) | `FM-1_956` | `4886f6679ca8793829a97a1c67201233aa4a4fe5e3d72aeed9dce21b47a3652d` | 138,176 B (5,184 B under the 143,360 B cap) | 28,536 B (cap 28,616: 80 B left) |

Every `build.py` check passes; `ota.bin` unchanged (9,071 B). `firmware-inspect verify --expect-identity
--expect-sha256`: `RESULT: OK` for both.

| Test | Result |
| --- | --- |
| `sh firmware/tests/console/run.sh` | CONSOLE HOST TESTS PASSED: vectors 2,957 / 0 (86 valid, 65 invalid, 23 negotiation, incl. every v7 case), link 478 / 0, input 455, LED 66,389, model 140, anim 221; help text byte-equal; scenarios 1,688 / 0, 349 shots; software-scroll build 40 / 0 |
| Older screens | all 343 earlier `firmware-host` shots (RANKED, SPLIT, v1–v6, transitions) byte-identical to the previous run's |
| Simulator parity (`v7-parity.ts`) | 6 of 6 v7 shots (Buddy bubble with bold, code and table rules; DETAILS with heading-bold, code rows, rules and a 37-byte row; List header cut at 24 visible cells; the v6 companion) pixel-identical in RGB565 to `renderV4` |
| v6 companion | `v7-v6-companion`: HELLO 1..7, agreed 6, stripped rows; same glyphs in the same cells as the v7 screen (only recolour and the 64 rule px differ); same pixel cost per row change as v7 |
| Redraw budget | a marked row change costs the same pixels as a plain one (`v7-bubble` vs `v7-v6-companion`; DETAILS row 11: 240 × 24) |
| `sh firmware/tests/ble/run.sh` | 1,180 / 0, 19 / 0, 43 / 0 |
| `run_emu.sh` on the USB package (`69f1755d…`, to the end) | CONSOLE EMULATOR TESTS PASSED: 763 / 763 checks over 123 runs; 254 screens compared with host mode, 0 differ (incl. the 6 v7 shots); worst ACK 6 ms (limit 15). Two transition-step shots (`v5g-trans-voice-50/-90` and their RANKED replays, skipped by design) show another scroll phase than before: timing only, the host-mode shots are byte-identical |
| `bun test` (workspace) | 1,475 pass, 2 skip, 0 fail |

Evidence: `reports/evidence/ui-v3/markdown/host/` (6 shots), `reports/evidence/firmware-host/`, `reports/evidence/emu/`.

## Gaps and notes

- The device ignores `SET_STATUS.text` while the backend link is ok and a title is set. It shows the text in place
  of the title when the backend is degraded or down (`docs/firmware-ui.md`).
- The provider flag is not drawn on the key strip; it shows in the panel for the selected session. The pinned flag
  is drawn with version 2 (UX v2).
- MASTER is reported as `POT`. It cannot dim the screen because the backlight is on/off only.
- The screenshot timing of the emulator runs comes from separate `--shot` runs of the same deterministic input.
- The CoreMIDI handshake runs fm1-live in window mode: a window opens for about 5 s. It is opt-in
  (`LIVE_HANDSHAKE=1`).

## Preflight (spec section 12 checks 1–12, 2026-11-17)

Full checklist, evidence and the proposed flash procedure: `reports/preflight.md`. Recovery: `docs/recovery.md`.
Nothing was sent to the device.

| Check | Result |
| --- | --- |
| 1 Identify the FM-1 | PASS: `CoralFlower FM-1`, `0x1209:0x0001`, bcdDevice `0x0301` (CoralFlower with CDC on, USB audio off), built-in port `0x01100000`. **macOS has not authorized the accessory**, so it has no MIDI port: the operator must click Allow |
| 2 Firmware identity | PENDING-OPERATOR: CoralFlower, package identity `FM-1_930` in every release; the release number shows only on the splash |
| 3 Flash chip | PENDING-OPERATOR: only the mask ROM reports the JEDEC ID; the candidate accepts both chips |
| 4 Compatibility | PASS: `tools/firmware-inspect verify` exit 0; CoralFlower 0.7.1's updater runs the same step-1 checks and accepts the loader |
| 5 Update path | PASS (code trace): CoralFlower 0.7.x keeps the Felucca M-UPGRADE updater; CoralFlower before 0.7 refuses on a `0xB36014` unit |
| 6 Stock firmware | PASS: V15 and V16 in `../.fm1-rollback/stock-mvave/`, hashes equal MvaveFM1Unbricker's pins; the backup's head decides which applies |
| 7 Checksum and provenance | PASS: every embedded CRC re-computed; a corrupted copy fails with exit 1 |
| 8 Recovery plan | PASS: `docs/recovery.md` |
| 9, 10 Backup and double read | PENDING-OPERATOR: mask ROM via OCT−+OCT+ 5 s on CoralFlower, then `fm1_unbrick.py backup` twice and `firmware-inspect dump A --second B` |
| 11 Emulator on the exact candidate | PASS: 77 checks on the package that hashes to `00b00e64…` |
| 12 Recovery tool and stock image | PENDING-OPERATOR: images ready; `mido`/`python-rtmidi` and the unbricker set-up are missing |

Findings that change the plan:

- Install command: `fm1_install.py firmware/dist/fm1-console-0.1.fwsc --port FM`. `FM` matches `CoralFlower FM-1`
  before the write and `FM1 CONSOLE` after it. Without `--port`, the installer cannot find the new firmware after
  the write (exit 5, although the write finished).
- Each of `CoralFlower FM-1`, `Felucca Update` and `FM1 CONSOLE` may raise its own macOS accessory prompt during the
  install. The operator must be at the Mac.
- CoralFlower's authors report that the SPL does not restart the loader from the flash record after a cold boot.
  A power cut during the write probably needs the mask ROM.
