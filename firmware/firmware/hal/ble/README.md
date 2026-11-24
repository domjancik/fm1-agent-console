# firmware/hal/ble: the radio's register layer (FM1C_BLE builds only)

Not ours. Copies, byte-identical, of `chip/` files in [felucca-bsp](https://github.com/hugelton/felucca-bsp) at commit
`fbc254d` (2026-11-16):

| File | Origin, licence |
| --- | --- |
| `fm1_ble.h`, `fm1_ble_rf.h` | the BLE baseband and the radio start-up, Optimist's (Henri David). Their headers say `GPL-3.0-only OR MPL-2.0` (felucca-bsp `NOTICE`: taken there under MPL-2.0); FM1 CONSOLE uses them under GPL-3.0-only |
| `fm1_rf_cal.h` | the radio's calibration at every start: JieLi's AC79 SDK calibration rewritten in C by Charles Vestal, Apache-2.0 (`NOTICE`, `LICENSES/Apache-2.0.txt`) |
| `ble_rf_tables_v15.h` | the start-up writes of M-VAVE's stock FM-1 V15 (Copyright (c) 2026 Zhuhai Shengke / M-VAVE; JieLi's `rf_init`, Copyright (c) 2024-2026 Zhuhai Jieli Technology Co., Ltd.), packed by Optimist, Apache-2.0 |
| `fm1_cc.h`, `fm1_irq.h`, `fm1_guard.h`, `fm1_time.h` | felucca-bsp's newer copies of the platform headers in `firmware/hal/`, Copyright (C) 2026 Leo Kuroshita (Hügelton Instruments) and contributors, MPL-2.0. Only the BLE unit includes them (`fm1_irq.h` with `FM1_IRQ_DEFS 0`, so the crash record stays the app's) |

One file here is ours, not felucca-bsp's: `fm1c_flash_uid.h` (FM1 CONSOLE, GPL-3.0-only), the read-only read of the
SPI flash's factory unique ID (commands `0x9F` and `0x4B` only) that `src/fm1c_ble.c` turns into the stable BLE
address. It lives here because every register access of the BLE unit must be under `hal/` (`tools/build.py`), and
it follows Dinghy's `fl_jedec_ram` (`firmware/hal/fm1_flash.h`) and felucca-bsp's `fl_uid_ram` (`chip/fm1_flash.h`).

MPL-2.0 and Apache-2.0 are compatible with GPL-3.0; the combined firmware is distributed under GPL-3.0-only, with these
files' own notices kept. `tools/build.py --ble` copies `ble_rf_tables_v15.h` to `build/gen/ble_rf_tables.h` after
checking its SHA-256. Every register access of the BLE variant is in this directory (`src/fm1c_ble.c` and
`firmware/ble/` have none; the build checks both).
