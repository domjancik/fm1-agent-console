# Licensing

Dinghy is free software under the GNU General Public License, version 3 only (`GPL-3.0-only`, full text in
`LICENSE`). You may use, study, change and share it. If you give someone a firmware built from it, give them its
complete source under the same licence too.

## Who made what

| | |
| --- | --- |
| The platform: `firmware/hal/`, `firmware/loader/`, `crt0.S`, `app.ld`, `firmware/src/` (`usb.c`, `ota.c`, `recovery.c`, `lcd.c`, `gfx.c`, `libc.c`, `bootguard.h`, `uac_fir.h`), `tools/` | Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments ([Felucca](https://github.com/hugelton/Felucca)), with the changes of [SLOOP](https://github.com/isod89/sloop-fm1) (isod89) |
| The SMK-37 board layer: `firmware/hal/smk_input.h`, `fm1_flash_map.h`, the SMK-37 parts of `fm1_cc.h`, `fm1_flash.h`, `fm1_lcd_hw.h`, `lcd.c`, `ota.c`, `bootguard.h`, `firmware/loader/`, `tools/fm1pkg_make.py`, `tools/fm1_install.py`, `tools/build.py`; `firmware/src/smk_wheel.h`; `tests/ota_test.c`, `ldr_test.c`, `install_test.py`, `smk_wheel_test.c`, `smk_pkg_test.py` | Copyright (C) 2026 M. Geisler (genkigenki/makkuro), from [genkigenki/sloop-fm1](https://github.com/genkigenki/sloop-fm1) branch `smk37` (the reference port of the [fm1-to-smk37](https://github.com/genkigenki/fm1-to-smk37) kit) |
| The TRS MIDI IN `firmware/src/midi_uart.c` | Felucca's, as sloopDX carries it, with the ring read by content from Felucca [Salt] 0.9-salt14 by ChanceTheMaker (found by keremimo) |
| The update loader's screen: `firmware/loader/ldr_screen.c`, `tests/ldr_screen_test.c` | Copyright (C) 2026 zvenson (from OberVave, the Firmware Hub's look); the idea, a loader that draws, its 5 x 7 letters and the order of things from [Skiff](https://github.com/illuminus5/skiff) by illuminus5, GPL-3.0 |
| From OberVave: the storage (blobs, slots), `LCD_IDLE`, the SMK-37 wiring of `platform.c`, `store.h`, the pad event queue in `smk_input.h`, `tests/smk_flash_test.c`, `tests/run_tests.sh`, the CI workflow | Copyright (C) 2026 zvenson |
| The app `firmware/src/dinghy.c`, the wiring `platform.c`, the host mode `tests/`, the docs | zvenson |
| FM1 CONSOLE: the app `firmware/src/console.c` and `fm1c_*.h`, `tests/console/`, the host-harness additions in `tests/host.c`, the identity in `tools/build.py` and `usb.c` (see `UPSTREAM.md`) | Copyright (C) 2026 Dominik Jancik (fm1-agent-console) |
| FM1 CONSOLE's Bluetooth variant (`--ble`): `firmware/src/fm1c_ble.c`, `fm1c_ble.h`, `tests/ble/`, the BLE parts of `console.c` and `tools/build.py` | Copyright (C) 2026 Dominik Jancik (fm1-agent-console) |
| The BLE stack `firmware/ble/` (Optimist's, through fm1-base; built only with `--ble`) | Copyright (C) 2026 Henri David (hdavid), [Optimist](https://github.com/w0ts/optimist); `GPL-3.0-only OR MPL-2.0`, used under GPL-3.0-only (`firmware/ble/README.md`) |

## Third-party material

| What | Licence | Where |
| --- | --- | --- |
| Terminus font 8x16 (ter-u16n), rendered into `firmware/gen/felucca_font.h` | SIL OFL 1.1 | `assets/fonts/Terminus-LICENSE.txt` |
| The radio's register layer `firmware/hal/ble/` (felucca-bsp `chip/`; built only with `--ble`): the BLE drivers `fm1_ble.h`, `fm1_ble_rf.h` by Henri David (`GPL-3.0-only OR MPL-2.0`, used under GPL-3.0-only) and the platform headers `fm1_cc.h`, `fm1_irq.h`, `fm1_guard.h`, `fm1_time.h` by Leo Kuroshita and contributors (MPL-2.0) | GPL-3.0-only OR MPL-2.0; MPL-2.0 | `firmware/hal/ble/README.md`, `LICENSES/MPL-2.0.txt`, `NOTICE` |
| The radio's start-up tables (`firmware/hal/ble/ble_rf_tables_v15.h`, M-VAVE's stock V15 / JieLi's `rf_init`) and its calibration (`fm1_rf_cal.h`, after JieLi's SDK, by Charles Vestal) | Apache-2.0 | `firmware/hal/ble/LICENSES/Apache-2.0.txt`, each file's header |
| JieLi AC79 SDK: `uboot.boot`, `cfg_tool.bin`, `eq_cfg_hw.bin` are read from your SDK checkout at build time and placed in the package; no SDK files are in this tree | Apache-2.0 | <https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK> |

## The logo

`assets/logo.svg` / `logo.png` carry the designburg signet: Copyright (C) designburg, all rights reserved, not under
the GPL. It marks Dinghy itself; a fork uses its own logo.

## Trademarks

"Felucca" and "Hügelton Instruments" are names of Hügelton Instruments; "M-VAVE", "FM-1", "SMK-37" and "MKE-P37"
belong to their owners. Dinghy is not made or endorsed by them.
