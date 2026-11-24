# Upstream and local changes

This tree is Dinghy 0.5 with a new app, FM1 CONSOLE, on top. Every upstream file is byte-identical to the source
commit except the five listed below (plus `tools/build.py`'s `--ble` option, in the Bluetooth section). Check with:

```sh
diff -rq . ../../.fm1-upstream/dinghy -x .git -x build -x dist
```

## Source

| | |
| --- | --- |
| Upstream | `zvenson/dinghy` (GPL-3.0-only) |
| Commit | `ea1b6bf` (Dinghy 0.5, 2026-11-07), copied from `/Users/dominikj/dev/personal/.fm1-upstream/dinghy` without `.git` and `build/` |
| Copied | 2026-11-17 |

## Modified upstream files

| File | Change | Why |
| --- | --- | --- |
| `tools/build.py` | `BOARD_PREFIX["fm1"]` `FM-1_99` → `FM-1_95`; `PRODUCT` `FM-1_990` → `FM-1_950`; `SCREEN_NAME` `DINGHY` → `FM1 CONSOLE`; `SCREEN_COLOUR` `0xB47F` → `0x2BFE` (#2F7DF6); the app source `src/dinghy.c` → `src/console.c` (4 lines) | Our own package identity and update-loader screen. `95N` rather than the architecture decision's `97N`: Dinghy's `docs/MAKE-IT-YOURS.md` lists `97N` as zp12's, `96N` is the operator's Wordscape WIP, and `9NN` keeps the installer's interrupted-update resume (`OWN_LOADER_RE`). Compiling `console.c` directly is a smaller diff than rewriting `dinghy.c`, which stays byte-identical (and unused by the build). The object and package names (`dinghy.o`, `build/dinghy*.fwsc`) stay as upstream so `tests/run_tests.sh` runs unchanged. |
| `firmware/src/usb.c` | The USB product string `STR2` `"Felucca"` → `"FM1 CONSOLE"` (1 line) | The companion finds the console by name. The update loader's own string (`"Felucca Update"`, `FELUCCA_LOADER`) is unchanged. |
| `firmware/src/gfx.c` | `cv_px` without `section(".pool")` when `DINGHY_HOST && __APPLE__` (+4 lines) | Host mode does not compile on macOS otherwise (Mach-O section syntax). This is the same patch as in the operator's WIP tree and in `.fm1-upstream/dinghy-copy`. The device build is unchanged. |
| `tests/host.c` | `fm1_input_note_edges()` reports the keys the script pressed (it returned 0); `fm1_adc_read()` and `T pot V` for the MASTER pot; `T leds` and every `T shot` print the lit and glow LED layers and the count of pixels sent to the screen | Gesture timing, MASTER and the LED and redraw checks need them. Dinghy's own app and its host tests behave as before (`tests/run_tests.sh` passes). |
| `LICENSING.md` | One authorship row for FM1 CONSOLE | GPL attribution. |

## Added files

| Path | What |
| --- | --- |
| `firmware/src/console.c` | The app: panel → frames, frames → screen and LEDs, the link's timers |
| `firmware/src/fm1c_proto.h` | Protocol v1 constants, message struct, checksum, encode and decode (`docs/protocol.md`) |
| `firmware/src/fm1c_frame.h` | CC 116–119 frame assembler and sender |
| `firmware/src/fm1c_link.h` | SEQ, ACK, retransmit, duplicate guard, heartbeat, host lost, HELLO and version negotiation |
| `firmware/src/fm1c_input.h` | Key gestures (single, double, long), button edges, encoder and MASTER filters |
| `firmware/src/fm1c_led.h` | LED patterns and priorities |
| `firmware/src/fm1c_model.h` | What the screen shows, and which regions changed |
| `firmware/src/fm1c_draw.h` | Region-by-region drawing (`docs/firmware-ui.md`) |
| `firmware/src/fm1c_help.h` | The help overlay's three texts (version 2, `docs/ux-v2.md` section 2.5) |
| `firmware/src/fm1c_draw4.h` | Version 4's screen: the characters, the speech bubble, the critter keyboard, the hint bar (`docs/ui-v3.md` section 3.A) |
| `firmware/src/fm1c_draw5.h` | Version 5's LIST layout: the 24 x 24 hero, the header bubble, the 10 rows and the scroll thumb and the GROUPED list's header and indented rows (`docs/ui-v3.md` sections 8 and 9.3) |
| `firmware/src/fm1c_trans.h` | Version 5's transitions and the panel's hardware vertical scroll (VSCRDEF / VSCRSADD through `lcd.c`'s helpers; `FM1C_VSCROLL_HW 0` fallback) (`docs/ui-v3.md` section 9.10) |
| `firmware/src/fm1c_draw6.h` | Version 6's screens: the SPLIT black row (chips at the physical key positions, task page dots), the 4-row Buddy bubble, the compact black boxes over voice / confirm, and the SETTINGS view (`docs/ui-v3.md` sections 10.2 and 10.7) |
| `firmware/src/fm1c_anim.h` | The character animation scheduler: which sprite boxes are due, within a pixel budget a pass |
| `firmware/src/fm1c_sprite.h` | Sprite drawing (4 bpp, 1x or 2x) into the canvas |
| `firmware/src/fm1c_sprites.h` | Generated sprite tables (`tools/gen_sprites.py` from `assets/sprites/`) |
| `assets/sprites/` | The sprite PNGs (Claude cat, Codex bot: 24 x 24 heroes, 12 x 12 minis) |
| `tools/gen_sprites.py`, `tools/sprites_seed.py` | The sprite header generator and the procedural first-pass PNG seed |
| `tests/console/` | Unit tests, the vector-header generator, the scenario runner for host mode and fm1-emu |
| `UPSTREAM.md` | This file |

The `fm1c_*.h` headers other than `fm1c_draw.h` use only `<stdint.h>`, so the unit tests compile them alone.

## The Bluetooth LE MIDI variant (`--ble`, sizing build: never flashed)

`./build.sh --release 0.1 --ble` (or `FM1C_BLE=1 ./build.sh --release 0.1`) builds `build/dinghy-0.1-ble.fwsc`,
copied to `dist/fm1-console-0.1-ble.fwsc`. Identity `FM-1_95(N+5)`: 0.1 is `FM-1_956` (a dev build `FM-1_955`), so it
never shares one with a USB release `FM-1_95N`. Without `--ble` nothing changes: `console.c`'s BLE parts are all inside
`#if FM1C_BLE`, `fm1c_ble.c` is not compiled, and the default package is byte-identical (checked: SHA-256 `00b00e64…`
before and after).

Vendored, byte-identical (provenance and licences in each directory's `README.md`):

| Path | Source | Licence |
| --- | --- | --- |
| `firmware/ble/` (22 files) | fm1-base `bt/ble/` @ `c8e0599`: Optimist's stack by Henri David | `GPL-3.0-only OR MPL-2.0`, used under GPL-3.0-only |
| `firmware/hal/ble/` (8 headers + `NOTICE`, `LICENSES/`) | felucca-bsp `chip/` @ `fbc254d` | per file: GPL-3.0-only OR MPL-2.0, MPL-2.0, Apache-2.0 |

Added (ours): `firmware/src/fm1c_ble.c` (the glue: a unit of its own, include path `firmware/ble`, `firmware/hal/ble`,
`build/gen`, never `firmware/hal`), `firmware/src/fm1c_ble.h` (its interface, the CC <-> USB-MIDI packet helpers and
the stable address derivation), `firmware/hal/ble/fm1c_flash_uid.h` (GPL-3.0-only, the read-only read of the SPI
flash's factory unique ID; ours, not felucca-bsp's, though it sits beside their headers), `tests/ble/` (FM1C frames
through the vendored BLE-MIDI codec; `fm1c_ble_addr_test.c`, the address derivation; `fm1c_uid_test.c`, the ID read
against a model of the flash part). Changed: `console.c` (behind `FM1C_BLE`: frames also to
BLE when a central listens, BLE's frames through an assembler of their own, the radio started 3 s after power-on unless
the boot guard counted a failed boot, HELLO when a central subscribes), `tools/build.py` (`--ble`; the register check
also reads `hal/` subdirectories' macros and scans `firmware/ble/`; BLE builds also check that `fm1_rf_burst_run` is in
`.ram_text` and that `fm1c_ble.o` needs nothing of the app's but `memcpy`/`memset`).

Register access: the stack and the glue have none; felucca-bsp's `fm1_ble.h`, `fm1_ble_rf.h`, `fm1_rf_cal.h` hold it all
in `hal/ble/`. The radio calibrates itself at each start (`fm1_rf_cal_on = 1`): no flash location is read or written, the
stock VM at `0x0E8000` included. For the stable address the BLE unit sends two read commands to the flash part once
per boot, before the radio starts: `0x9F` (JEDEC ID) and, for the two known parts only, `0x4B` (unique ID). Measurements and the emulator run: `docs/discovery/wireless.md`, "Build results".

## Build-time settings in `console.c` (no platform change)

- `FELUCCA_UAC 0`: MIDI only. The platform supports this option. Without USB audio, macOS has no "FM1 CONSOLE"
  microphone that it could pick as the default input and take away from the voice pipeline.
- `CV_MAX 240 x 80`: the largest canvas, which is the NO HOST banner (208 x 80). It uses 38,400 B of the pool.
- `APP_NAME "FM1 CONSOLE"` is shown on the rescue and crash screens.
- The app never writes flash, so there is no `STORE_MAGIC` change. The updater (`FELUCCA_OTA`), the OCT− rescue and
  the boot guard are untouched.

## Build and test

```sh
JIELI_TOOLCHAIN=~/.jieli/toolchain AC79_SDK=~/fw-AC79_AIoT_SDK ./build.sh --release 0.1   # build/dinghy-0.1.fwsc, FM-1_951
sh tests/console/run.sh            # unit tests + the app in host mode (reports/evidence/firmware-host/)
sh tests/console/run_emu.sh        # the package in fm1-emu 0.5.1 (reports/evidence/emu/); LIVE_HANDSHAKE=1 adds CoreMIDI
./build.sh --release 0.1 --ble    # build/dinghy-0.1-ble.fwsc, FM-1_956 (the Bluetooth variant; never flashed so far)
sh tests/ble/run.sh                # FM1C frames through the BLE-MIDI codec (host)
AC79_SDK=~/fw-AC79_AIoT_SDK sh tests/run_tests.sh   # Dinghy's own tests (update path, loader, installer); needs ./build.sh first
```

`.github/workflows/release.yml` is Dinghy's. It does not run in this monorepo.

## Updating from upstream

1. Copy the new Dinghy over this tree, excluding `.git` and `build/`.
2. Apply the five changes in the table again.
3. Run all three test commands and rebuild the package.
