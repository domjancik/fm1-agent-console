# firmware/ble: the Bluetooth LE MIDI stack (FM1C_BLE builds only)

Not ours. Copies, byte-identical, of `bt/ble/` in [fm1-base](https://github.com/charlesvestal/fm1-base) at commit
`c8e0599` (2026-11-13). The stack is Optimist's ([w0ts/optimist](https://github.com/w0ts/optimist)), Copyright (C) 2026
Henri David (hdavid), written clean-room from the Bluetooth Core Specification and the MIDI Association's BLE-MIDI 1.0
(fm1-base `docs/bt/BLE-STACK.md`). Every file keeps its header `SPDX-License-Identifier: GPL-3.0-only OR MPL-2.0`.
FM1 CONSOLE takes them **under GPL-3.0-only**, like the rest of this firmware. The MPL-2.0 text is in
`LICENSES/MPL-2.0.txt` for the other option.

Only what a BLE-MIDI peripheral without pairing needs is copied: the link layer, L2CAP/ATT/GAP host, the BLE-MIDI codec,
the WL82 baseband driver (`ble_hw_wl82.c`) and their headers. Left out: the central role, SMP/AES, the diagnostics, the
VM-trim reader (`ble_vm.c`; only its header's struct is used). The build compiles them through `ble_stack.c` from
`src/fm1c_ble.c`, with `BLE_CENTRAL 0`, `BLE_LL_ENC 0`, `BLE_SMP_LEGACY 0`, `BLE_DIAG 0`.

The driver reaches the radio's registers only through `firmware/hal/ble/fm1_ble.h`; its own `volatile` fields are the
baseband control block, plain SRAM the engine reads by DMA. `tools/build.py`'s register check scans this directory too.
