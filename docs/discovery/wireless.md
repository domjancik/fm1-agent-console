# Discovery: wireless link between the FM-1 and the PC

Date: 2026-11-17. Scope: the operator's question, "verify whether fm1 fw could fit and support wireless connection to pc -
wifi or bluetooth or both, preferably bluetooth to be not limited by enterprise networks". Research only: no device was
opened, flashed or sent MIDI, and no microphone was used.

Evidence tags:

- **[V]**: verified here by reading the cited file at the cited commit, or by a measurement in this session.
- **[V-ext]**: a hardware result that a third-party project reports in its own docs. We did not reproduce it.
- **[I]**: inferred. It is not verified.

Third-party clones used (shallow, read-only, session scratchpad; the commit is given once):
`deadactive/hortator` @ `44c9ad4`, `keremimo/melodee` @ `165d177`, `pbarilla/chipbox` @ `aaf6816`,
`ignis32/midimonitor_fm1` @ `acde38e`, `juan-ms2lab/playa` @ `98a356e`, `charlesvestal/fm1-base` @ `c8e0599`,
`hugelton/felucca-bsp` @ `fbc254d`. Local: `.fm1-upstream/dinghy` @ `ea1b6bf`, AC79 SDK `~/fw-AC79_AIoT_SDK` @ `d179b448`
(`AC79NN_SDK_V1.2.1_2023-12-13`).

## Summary

**The answer is yes: Bluetooth LE MIDI fits, it works on FM-1 hardware, and it can be licensed with our GPL-3.0 firmware.**
Use the clean-room BLE stack from Optimist (Henri David). fm1-base and Melodee also carry it. It costs about +41 to 46 KB
of flash, +10 KB of RAM and +1 KB of pool. It needs no RTOS and no JieLi binaries. Its source files are dual-licensed
`GPL-3.0-only OR MPL-2.0`. A Mac connecting to an FM-1 over this stack is reported as working [V-ext].

Wi-Fi is not viable. It needs JieLi's binary libraries, which our GPL-3.0 firmware cannot link. It needs about 276 KB of
pool, which is more than Dinghy's layout has. It also has the enterprise-network problems the operator wants to avoid.

## 1. Hardware: radio, antenna, chip

| Fact | Evidence | Tag |
| --- | --- | --- |
| The SoC is the JieLi AC791N family (WL82). The package text in the firmware build is `AC791N`. | `.fm1-upstream/dinghy/tools/fm1pkg_make.py:61` (`UFW_CHIP = b"AC791N"`); `fm1-emu/docs/recon.md:9` | V |
| The exact part is the AC7911B. | `.fm1-upstream/mvave-fm1/skills/mvave-fm1-software-development/SKILL.md:34`. We did not read a package marking. | I (one source) |
| The chip has a shared Wi-Fi/BT 2.4 GHz radio: an RF die, a baseband at `0x20000`, and wireless control at `0x14000`. | `fm1-base/docs/bt/RF-CALIBRATION.md:2-5`; `fm1-base/docs/bt/BLE-HW-FACTS.md:29`; `fm1-emu/crates/fm1-soc/src/lib.rs:1325-1331` | V (docs) |
| The stock firmware (V15) offers BLE-MIDI and advertises as `FM-1_BLE`. | `fm1-base/docs/bt/BLE-HW-FACTS.md:17`; `melodee/docs/BLE-STACK.md:59` ("stock's was `FM-1_BLE`"); `mvave-fm1/.../SKILL.md:40` ("V14 accepts BLE MIDI in and sends BLE out"); retail listings give "USB-C, Bluetooth BLE MIDI, 3.5 mm MIDI IN" ([scrapbox](https://scrapbox.io/zenwerk/FM-1), [Synthtopia](https://www.synthtopia.com/content/2026/07/13/m-vave-introduces-fm-1-fm-pocket-synthesizer/), [synthanatomy review](https://synthanatomy.com/2026/07/m-vave-fm-1-review-low-budget-pocket-fm-ynthesizer-with-iconic-sounds.html)) | V-ext |
| An antenna is fitted and the radio works. A Mac connected through Audio MIDI Setup and MIDI went both ways. A Mac reconnected to the FM-1 acting as central after a power cycle. | `melodee/docs/BLE-STACK.md:15-18` ("Verified on an FM-1 (2026-10)") | V-ext. The antenna type (PCB trace or chip) was not seen; a working link implies one. |
| The radio's analog performance (TX power, sensitivity, drift) has not been measured. | `melodee/docs/BLE-STACK.md:18`, `:313` | V (open item) |
| The RF trims are stored in the SDK "VM" at flash `0x0E8000` on an FM-1. | `fm1-base/docs/bt/BLE-HW-FACTS.md:39`; `melodee/docs/BLE-STACK.md:189-197` | V-ext |
| The TRS jack is MIDI **IN only**, on `PH8`/UART1 RX. There is no MIDI OUT. | `mvave-fm1/.../SKILL.md:39`; `fm1-emu/docs/recon.md:21` | V (docs) |
| The Agent Deck README's "Bluetooth MIDI" describes the stock hardware. The Agent Deck firmware has no BLE code. | `fm-1-agent-deck/README.md:47`; `grep -w -i 'ble\|bluetooth'` in `fm-1-agent-deck/firmware-build/firmware/src/{dinghy,platform}.c` finds nothing | V |

## 2. Community firmware with a radio

| Firmware | Radio | Stack | License | Hardware status |
| --- | --- | --- | --- | --- |
| **Optimist** (`w0ts/optimist`) | BLE-MIDI peripheral and central, pairing | Its own clean-room stack, written from the Core spec and the BLE-MIDI 1.0 spec. "No vendor code, libraries, IR or disassembly". | `GPL-3.0-only OR MPL-2.0` (stack files) | Works with a Mac and an iPhone [V-ext]; `melodee/docs/BLE-STACK.md:15-22` |
| **Melodee** 1.6.x | BLE-MIDI | Optimist's stack. Stores the radio start-up program in a resource region. | GPL-3.0 | `melodee/README.md:1248`; `fm1-emu/PLAN.md:1318` |
| **fm1-base** (Charles Vestal) | BLE-MIDI (two stacks), BT audio (A2DP), Wi-Fi station | `ble_stack = "own"` is Optimist's stack. The default uses JieLi's libraries through a shim. Wi-Fi uses JieLi's libraries plus lwIP. | MPL-2.0 | `fm1-base/README.md:25-62`, `:143-175` |
| **Chipbox / Drumlab / Smileyface** (pbarilla) | BLE-MIDI | Copies of fm1-base `bt/ble` and the felucca-bsp radio drivers, linked into the app only | GPL-3.0 | `chipbox/firmware/ble/README.md` |
| **Hortator (Bluetooth)** | BLE-MIDI host and device, SMC-Mixer, FM-Link | JieLi `btctrler.a`/`btstack.a` through LTO, with a cooperative OS shim (3 tasks) | GPL-3.0 (see section 3.4) | Packaged as "experimental". The manual notes "the audio has less headroom while Bluetooth is on" and a stutter bug while it searches for saved devices. `hortator/docs/manual/12-bluetooth.md`; `hortator/docs/ble/FIT.md` |
| **MIDIMON** (ignis32) | BLE peripheral and central together | fm1-base based | MPL-2.0 | `midimonitor_fm1/README.md:5-8` |
| **PLAYA** | BLE-MIDI keyboards (as central) | Optimist based | GPL-3.0 | `fm1-emu/docs/FIRMWARES.md:163` |
| Felucca, SLOOP, OberVave, Dinghy, Agent Deck | none | none | GPL-3.0 | "Felucca never enables the Bluetooth / Wi-Fi radio" (`hortator/LICENSING.md:89`); `dinghy/README.md` has 0 mentions of Bluetooth |
| fm1-radio (Charles Vestal) | Wi-Fi station: HTTPS internet radio | JieLi Wi-Fi libraries | MPL-2.0 | `fm1-base/README.md:11`, `:171-175` |

We found no ChoralRoot, CoralFlower or Wordscape firmware with radio code. The search was the `gh` repo search for
"fm-1 firmware" with a wireless keyword in the description, plus the local clones. A repo whose description does not
mention wireless would be missed, so this is [I].

## 3. What on-chip BLE needs on Dinghy

### 3.1 Two stack options

| | A: JieLi libraries (Hortator, fm1-base default) | **C: Optimist's own stack (fm1-base `own`, Melodee, Chipbox)** |
| --- | --- | --- |
| Code | `btctrler.a` 5.16 MB, `btstack.a` 3.06 MB, `wl_rf_common.a` 0.32 MB, `crypto_toolbox_Osize.a` 0.42 MB, `lib_ccm_aes.a` 33 KB as archives [V, `ls -la cpu/wl82/liba`]. They are LLVM bitcode (pi32v2 triple), so LTO sets the linked size. | About 35 portable C files in `bt/ble/`, 281 KB of source [V, `wc -c`]. It also needs felucca-bsp `chip/fm1_ble.h`, `fm1_ble_rf.h`, `fm1_rf_cal.h` and `ble_rf_tables_v15.h`. |
| Linked flash | 418 KB before LTO folding, 104 KB after (`hortator/docs/ble/FIT.md:22`, `:52`). fm1-base measures +124 KB (`fm1-base/README.md:153`). | **+41 to 46 KB** for MIDI with a computer; +57 to 62 KB more with pairing, central and audio (`fm1-base/README.md:155-156`) |
| RAM (`.data+.bss`) | +45 KB (fm1-base); +12 KB (Hortator) | **+10 KB** |
| Pool | +24 KB (fm1-base: three 8 KB task stacks); Hortator: 26 KB heap + 4×2.5 KB tasks | **+1 KB**. The driver has one static 1,508-byte block (`melodee/docs/BLE-STACK.md:148`). |
| RTOS | **Needed.** The libraries create tasks and use queues and semaphores. Hortator wrote "A cooperative OS for the JieLi BT libraries" with 3 tasks (`hortator/firmware/src/ble/ble_os.c:4-16`). | **None.** Everything runs in the two BLE interrupts (IRQ 45 event, IRQ 29 RX) at priority 2, below audio. The app talks to it through single-producer rings (`melodee/docs/BLE-STACK.md:44-46`, `:157-161`). This matches Dinghy's bare-metal main loop. |
| RF calibration | Done by the SDK | Optimist/Melodee: replays a start-up program captured from stock V15 and needs stored trims, or it shows NO CAL (`melodee/docs/BLE-STACK.md:132-133`). fm1-base `own`: "The radio calibrates itself at every start, so an FM-1 whose stock calibration was overwritten works the same" (`fm1-base/README.md:68-69`). |
| License with GPL-3.0 firmware | **Blocked** (section 3.4) | **OK.** Take the files under GPL-3.0-only. Chipbox does exactly this (`chipbox/LICENSING.md:23`). |

### 3.2 Budget on our firmware

Our current numbers, from the Agent Deck build per the brief: flash 65 of 581 KB, RAM 18 of 96 KB, pool 92 of 344 KB.

| Build | Flash KB | RAM KB | Pool KB | Fits |
| --- | --- | --- | --- | --- |
| Console today | 65 / 581 | 18 / 96 | 92 / 344 | |
| + own stack, BLE-MIDI peripheral only | ~111 | ~28 | ~93 | **yes, with large margins** |
| + own stack with pairing and central (no audio) | ~120 to 130 [I: fm1-base gives +8 KB flash for central; pairing alone is not split out] | ~30 | ~93 | yes |
| + JieLi libraries (option A) | ~189 | ~63 | ~116 | yes on size; blocked by the license |
| + Wi-Fi (fm1-base figures) | ~365 | ~118 / 128 (needs the Wi-Fi RAM layout) | ~368 / 304 | **no** (pool) |

The sums are [I]: we added fm1-base's measured deltas to our numbers and did not run a build. Dinghy's canvas lives in
`.pool` (`docs/discovery/firmware.md:105`). It is counted in the 92 KB only if the Agent Deck figure includes it, so
confirm with a real link.

### 3.3 Flash map: is the calibration area preserved?

- In Dinghy on the FM-1, the app may write only `FL_OTA` `0xE0000-0xE4FFF`, settings at `0xFC000`, 8 blob sectors from
  `0xF4000`, and the slots from `0x97000` (`dinghy/firmware/src/store.h:7`, `:23`, `:39-43`;
  `firmware/hal/fm1_flash_map.h:83-97`). The RF-trim VM at `0x0E8000` and the whole stock config store `0xE5000-0xFBFFF`
  are **never written by the app** [V]. Hortator's map calls that range "the stock config store (never written; the radio
  calibration)" (`hortator/docs/ble/FIT.md:226`).
- The update loader's window on the FM-1 is wider: `[0x93000, 0xFC000)` (`dinghy/firmware/loader/loader.c:32`). There it
  only erases a sector whose last 256 bytes hold a valid update record (magic `0x5441` plus CRC-16;
  `firmware/loader/ldr_core.c:101-112`). A VM sector starts `55 AA AA 55` and is not an update record, so it is safe
  unless its tail happens to match [I, low risk]. Melodee and Optimist, and Hortator, ship on the same loader.
- Keeping a copy of the trims in our own settings record, as Optimist does in `persist_t.ble_rf`, 100 B
  (`melodee/docs/BLE-STACK.md:193-196`), or using fm1-base's self-calibration, removes the dependence on the VM.
- The BT address: Optimist creates a random static address once and stores it. It does not use VM record 104
  (`melodee/docs/BLE-STACK.md:140-141`). We need about 8 B in our settings blob. **Superseded (2026-11-18):** FM1
  CONSOLE stores nothing; it derives a stable address from the SPI flash's factory unique ID at each boot, as fm1-base
  does ("Build results", "Stable address").
- **Unknown for our unit:** whether this FM-1 still has the stock VM at `0x0E8000`. Earlier community firmware, or a
  full-chip restore, could have changed it. Reading it needs the read-only console or UBOOT `backup`. Do this only when the
  operator allows it.

### 3.4 Licensing of the JieLi blobs

- The AC79 SDK is Apache-2.0 at its root (`~/fw-AC79_AIoT_SDK/LICENSE`) [V]. Apache-2.0 code may be included in GPL-3.0
  works. But the BT and Wi-Fi libraries ship only as bitcode archives, without their preferred source form. GPL-3.0 §1/§6
  requires Corresponding Source for the whole linked work, and the system-library exception does not cover them.
- fm1-base states: "A GPL-3.0 firmware that links them can't be distributed without an extra permission from the GPL
  code's copyright holders" (`fm1-base/skill/felucca-to-fm1-base/RULES.md:59-61`). fm1-base relicensed to MPL-2.0 for this
  reason (`fm1-base/LICENSING.md:6`, `README.md:243`).
- Our firmware is GPL-3.0-only and contains Dinghy and Felucca code by other authors (`docs/architecture-decision.md`
  "Licensing"). **We cannot add a linking exception ourselves.** Option A is therefore out unless every Dinghy and
  Felucca author grants one. This is our engineering reading. It is not legal advice.
- Option C is `GPL-3.0-only OR MPL-2.0` (stack) plus MPL-2.0/Apache-2.0 (felucca-bsp drivers and captured tables).
  Both are compatible with GPL-3.0 [V, `chipbox/firmware/ble/README.md`]. A clean-room provenance statement is in
  `melodee/docs/BLE-STACK.md:19-22`.

### 3.5 Risk to the updater and recovery

- Keep BLE in the app only. The loader never contains it, as in Chipbox (`chipbox/firmware/ble/README.md`). Dinghy's
  `platform.c`, `usb.c`, `ota.c`, `recovery.c` and loader stay untouched.
- Dinghy has a generic `fm1_irq_attach(n, h, prio)` (`dinghy/firmware/hal/fm1_irq.h:10`), so IRQ 29 and 45 can be attached
  from app code. The asm wrappers may need app-local copies of the `fm1_isr.S` pattern [I].
- Main hazard: a radio start-up that hangs. Optimist saw one in the crystal ramp when the table sat at a certain flash
  alignment, and fixed it by running that burst from `.ram_text` (`melodee/docs/BLE-STACK.md:181-183`). It also saw one
  unexplained boot that never came back (`:317-319`).
  Copy their guards:
  - the radio is OFF by default;
  - the radio starts only after the OCT− rescue check and after USB is up;
  - a boot guard skips the radio after a failed start (Dinghy already has `bootguard.h`);
  - the start-up writes breadcrumbs.
- The USB SysEx triggers (`F0 22 24 35 7D/7F`) are parsed only in `usb.c`. BLE-MIDI input goes to the app, so BLE cannot
  reach the updater unless we forward it. The firmware should drop SysEx on BLE completely [I/design].
- Audio: Hortator reports less headroom with BT on, but that is the heavier JieLi stack. The console has no synth load, so
  this matters little to us [I].

## 4. BLE-MIDI on macOS and FM1C throughput

- **Pairing flow:** Audio MIDI Setup → Window → Show MIDI Studio → Bluetooth icon (Bluetooth Configuration) → Connect next
  to the advertised name. The device then appears as an ordinary CoreMIDI source and destination. Optimist's default
  needs no SMP pairing: "A Mac connects and plays MIDI like this" (`melodee/docs/BLE-STACK.md:88-89`).
- **Reverse mode:** the FM-1 acts as central and connects to a Mac that advertises in Bluetooth Configuration. Pairing uses
  a passkey shown on the FM-1. It reconnects after a power cycle [V-ext, `:15-17`]. This avoids the Mac-side "click
  Connect again" step [I: macOS reconnect behaviour as peripheral was not tested].
- **The companion stays transport-agnostic.** `@julusian/midi` sees a BLE port like a USB port. The port-selection code
  must accept a second port name (the BLE advertised name, e.g. `FM1 CONSOLE`), prefer USB when both exist, and keep the
  SysEx-blocking writer [I/design]. Use one active transport at a time, because the protocol has one SEQ space per
  direction.
- **Link parameters:**
  - Optimist asks for a connection interval of 6 to 9 units (7.5 to 11.25 ms). After a reject it asks for 12 (15 ms)
    (`:82-83`).
  - It offers an ATT MTU of 247 and sends up to 2 notifications per connection event (`:76`, `:111`).
  - The minimum ATT MTU is 23, which leaves 20 B of payload. macOS usually negotiates larger [I].

### Arithmetic

A BLE-MIDI packet carries 1 header byte and 1 timestamp byte, then `BF cc vv`. Later CCs use running status: 2 bytes
each, with no new timestamp. A 20 B payload therefore holds 1 + (20 − 5) / 2 = **8 CC messages**. A 182 B payload
(MTU 185) holds 89.

FM1C cost: each payload byte is one CC, plus START and END (`docs/protocol.md` section 1).

| Item | Payload B | CCs | Packets at MTU 23 | Packets at MTU 185 |
| --- | --- | --- | --- | --- |
| SET_SLOT, max (4 + 3 + 13) | 20 | 22 | 3 | 1 |
| SET_SLOT, 40 B (the brief's figure) | 40 | 42 | 6 | 1 |
| Full resync: SET_VIEW 28, 27 × SET_SLOT 20, SET_DETAIL 90, SET_LEGEND 32, SET_VOICE 29, SET_STATUS 27 | 746 | 810 | 102 | 10 |

| Link | Packets/s | CC/s at MTU 23 | Full resync, raw | SET_SLOT/s (22 CC) |
| --- | --- | --- | --- | --- |
| 15 ms, 1 packet/event (worst plausible) | 67 | 533 | 1.5 s | 24 |
| 11.25 ms, 2 packets/event (Optimist) | 178 | 1,422 | 0.57 s | 65 |
| 7.5 ms, 2 packets/event | 267 | 2,133 | 0.38 s | 97 |
| USB today (`docs/protocol.md` section 7) | | | ~32 frames × 2 ms ≈ 0.07 s | ~500 |

The ACK round trip is 1 to 3 connection events, which is 15 to 45 ms at 15 ms intervals. That is well under the 250 ms
retransmit and the 3,500 ms liveness timeout. If ACKs are stop-and-wait per frame, a resync costs about 32 RTTs, roughly
1 s at 15 ms. **FM1C fits BLE-MIDI without protocol changes.** The 200 frames/s host cap and the 50 ms slot coalescing
are already below the worst-case link rate.

Caveat [I]: the operator's Mac also runs a Bluetooth headset as the default input. Its 2.4 GHz scheduling can stretch the
BLE connection interval or cause retransmissions. This must be measured, and it is the main latency risk for
push-to-talk feedback.

## 5. Wi-Fi

- **Hardware:** present, the same shared radio [V-ext, `fm1-base/docs/bt/RF-CALIBRATION.md:2`].
- **Stack:** only JieLi's binary libraries (`wl_wifi_sta.a` 6.2 MB, `hostapd_and_wpasupplicant.a` 9.0 MB) plus lwIP. They
  need RTOS tasks: about 6 tasks of 4 to 8 KB and a 272 KB heap (`fm1-base/README.md:166-171`). No clean-room Wi-Fi stack
  exists.
- **Budget:** about +300 KB flash, +100 KB RAM, +276 KB pool. Our pool would reach about 368 of 304 KB in the Wi-Fi
  layout: **does not fit**. fm1-base allows a firmware only one of Bluetooth and Wi-Fi (`fm1-base/README.md:60`).
- **License:** blocked for GPL-3.0, as for option A.
- **Network:**
  - Station mode needs the enterprise SSID. 802.1X/EAP support in the JieLi supplicant is unverified.
  - Client isolation and blocked mDNS or peer traffic are common, so the FM-1 and the Mac may not reach each other.
  - SoftAP mode, with the FM-1 as its own access point, takes the Mac's Wi-Fi off the corporate network, which also cuts
    the companion's link to the Traycer backend.
- **Verdict:** no.

## 6. External dongle alternatives

- **TRS:** the jack is MIDI IN only, so a WIDI Jack or BT-to-DIN dongle could only carry host → device. Device → host
  (keys, ACKs, HELLO) is impossible. **No.**
- **USB host adapter on the FM-1's USB-C port:** a CME WIDI Uhost acts as USB host for a class-compliant USB-MIDI device and
  bridges it to BLE-MIDI. It powers the device and has its own USB-C power port. Its limits: "no USB hubs, combined device
  class, or multiple MIDI ports" ([CME WIDI Uhost](https://www.cme-pro.com/widi-uhost/),
  [start guide](https://www.cme-pro.com/widi-uhost-start-guide-bluetooth-midi-usb-host/)).
  - Our firmware already exposes one MIDI port. Dinghy's USB audio is off unless `FELUCCA_UAC=1`
    (`dinghy/firmware/src/usb.c:26-27`; `docs/API.md:239`), so the device is plain USB-MIDI (audio control plus MIDI
    streaming). It should be accepted [I: "combined device class" probably means composite audio+MIDI or CDC; this
    needs a test].
  - Drawbacks:
    - extra hardware (~€50-60) and an OTG cable;
    - the USB-C port is busy, so the FM-1 cannot charge or update while bridged;
    - the WIDI adds its own latency;
    - the FM-1 battery may power the dongle [I].
  - Firmware effort: none. **This is a valid fallback and a quick way to test the BLE path on the companion side.**
- A BLE-MIDI adapter on the PC side does not help, because the FM-1 side still needs a radio.

## 7. Verdict

| | Hardware present | Stack available | Fits budget | License OK | Effort | Risk to updater/recovery |
| --- | --- | --- | --- | --- | --- | --- |
| **BLE on-chip, Optimist stack (C)** | yes [V-ext: stock V15 and Optimist on a Mac] | yes, clean-room, no RTOS [V docs] | yes: ~111/581 KB flash, ~28/96 KB RAM, ~93/344 KB pool [I sums] | **yes** (GPL-3.0-only OR MPL-2.0) [V] | medium: port about 35 files plus 4 bsp headers, IRQ glue, settings fields, a transport switch in the companion; about 1 to 2 weeks plus device time [I] | low to medium: app-only, the loader is untouched. A radio start-up hang is possible; mitigate with OFF by default, the boot guard and starting after the rescue check. |
| BLE on-chip, JieLi libraries (A) | yes | yes, plus a cooperative OS shim | yes (~189 KB / ~63 KB / ~116 KB) | **no** for GPL-3.0 without an exception from all authors | medium-high | medium: RTOS shim, larger heap, audio headroom loss reported |
| Wi-Fi on-chip | yes | JieLi binaries only | **no** (pool) | **no** | high | high |
| External WIDI Uhost on USB-C | n/a | vendor dongle | n/a | n/a | none on the firmware; a companion port-name option | none on the firmware; the USB port is occupied |
| TRS dongle | IN only | n/a | n/a | n/a | n/a | n/a. Not viable: one direction only. |

## 8. Recommendation and next steps

Plan for **BLE-MIDI peripheral on Optimist's stack** as an optional firmware feature behind a build flag and a runtime
setting that is OFF by default. Keep USB as the primary transport. Do it after the USB MVP is stable.

1. **No device needed:** vendor `fm1-base/bt/ble` (or Optimist upstream) and the felucca-bsp `chip/` BLE headers into
   `firmware/vendor/ble/` with provenance and license files. Build a `FM1C_BLE=1` variant. Record the real flash, RAM and
   pool from the link map. Run the stack's host tests (`ble_stack_test`, `ble_midi_test`) in our harness, and run the
   fm1-emu BLE engine if its `feat/ble-engine` is available.
2. **Decide the calibration source:** fm1-base's self-calibration (`fm1_rf_cal.h`) is preferred because it does not depend
   on the VM at `0x0E8000`. Optimist's VM-trim path is the fallback.
3. **Companion:** add BLE port-name matching and a "transport" field in the status display. FM1C stays unchanged.
4. **Device test, operator-approved:** flash the BLE variant. Pair it in Audio MIDI Setup. Measure the RTT of ACKs,
   resync time and loss with the Bluetooth headset active. Check the OCT− rescue with the radio set ON.
5. **Optional bridge test before any firmware work:** a WIDI Uhost on the current USB-only firmware checks the
   companion's BLE port handling and the latency with the headset.

## Verification status

- **Verified in this session:**
  - the SDK license and the library sizes;
  - Dinghy's flash map, store windows, loader window and record sweep, IRQ attach API and `FELUCCA_UAC` default;
  - the Agent Deck firmware has no BLE code;
  - the third-party docs and licensing tables quoted above (file:line at the stated commits);
  - the FM1C throughput arithmetic.
- **Reported by third parties (we did not reproduce these):**
  - BLE working on FM-1 hardware with a Mac;
  - the RF trims at `0x0E8000`;
  - the size deltas for each stack.
- **Inferred:**
  - the summed budgets;
  - macOS MTU and interval behaviour, and reconnect behaviour;
  - the effect of the headset on coexistence;
  - WIDI Uhost acceptance of our descriptor;
  - the exact chip marking (AC7911B);
  - the antenna type.

## Build results

Date: 2026-11-17. A sizing build of section 8 step 1, done: the stack compiles into FM1 CONSOLE behind a build flag and
the package boots in the emulator. **Nothing was flashed**, no MIDI or SysEx was sent to the FM-1, and the radio was
never run on hardware. Tags as above; [M] = measured in this session from the link output or a test run.

### What was built

- `firmware/tools/build.py --ble` (or `FM1C_BLE=1`): `./build.sh --release 0.1 --ble` gives
  `firmware/build/dinghy-0.1-ble.fwsc`, copied to **`firmware/dist/fm1-console-0.1-ble.fwsc`** (612,227 B, SHA-256
  `1ef3b67aafe14f07b05ae7864780d4bbe8ac79518d89695bbade0b09c1aa87c5` since the stable address, 2026-11-18; it was
  `35fb158c…e655`), identity **`FM-1_956`**: BLE builds take minor + 5, so a USB release `FM-1_95N` never collides; the
  brief's example `952` would collide with a USB 0.2). The build is reproducible: two runs, the same SHA-256 [M].
- Stack: Optimist's, from fm1-base `bt/ble/` @ `c8e0599`, 22 files, byte-identical (`cmp`), in `firmware/ble/`
  (`GPL-3.0-only OR MPL-2.0`, used under GPL-3.0-only). Radio layer: felucca-bsp `chip/` @ `fbc254d`, 8 headers,
  byte-identical, in `firmware/hal/ble/` (dual / MPL-2.0 / Apache-2.0; licence texts, `NOTICE` and a provenance
  `README.md` beside them; rows in `firmware/LICENSING.md`, `firmware/UPSTREAM.md`). This follows Chipbox's split
  (section 2): the glue `firmware/src/fm1c_ble.c` is a unit of its own whose include path is `firmware/ble`,
  `firmware/hal/ble` and `build/gen`, never Dinghy's `firmware/hal`.
- Configuration: peripheral only, no central, no SMP, no LL encryption, no diagnostics (`BLE_CENTRAL 0`, `BLE_LL_ENC 0`,
  `BLE_SMP_LEGACY 0`, `BLE_DIAG 0`), interrupts at priority 2. Advertised name **`FM1 CONSOLE XXXX`**, XXXX the
  address's two low octets; the address is stable per unit since 2026-11-18 ("Stable address" below; in the emulator
  `FM1 CONSOLE 9F7F` [M], before that a random `FM1 CONSOLE 7201`).
- Transport-agnostic link: `console.c` (all of it behind `#if FM1C_BLE`) sends every frame to USB as before and, while a
  central has the MIDI notifications on, the same CC words as USB-MIDI packets to the stack's ring (whole frames or
  none, like USB). BLE input goes through **its own frame assembler**, so a USB and a BLE frame never interleave; both
  feed the one link (one SEQ space, as section 4 asks: the companion uses one transport at a time). A central
  subscribing triggers HELLO, like the cable coming in. The BLE interrupt drops everything but control changes, so
  SysEx (the updater triggers included), notes and real time never reach the app or `usb.c` [M: `tests/ble`].
- Start policy: the radio starts once, **3 s after power-on** (after the OCT- rescue check and `usb_start`), and **not
  at all in a boot that follows a failed one** (`bootguard.failed`: a warm reset within a boot's first 30 s). There is
  no runtime switch yet: the console has no settings store, so "OFF by default" (section 3.5) is not implemented. The
  update loader contains none of the BLE code.

### Sizes vs budget [M, `build.py` link checks]

| | USB build (default) | BLE build | Delta | Budget | Section 3.2 estimate |
| --- | --- | --- | --- | --- | --- |
| Flash (app image) | 61,056 B | **90,832 B** | **+29,776 B (+29.1 KiB)** | 581,564 B (15.6 % used) | +41 to 46 KB |
| RAM `.data+.bss` | 16,684 B | **25,864 B** | **+9,180 B** | 98,304 B (26.3 % used) | +10 KB |
| Pool | 38,400 B | **38,400 B** | **0** | 344,064 B | +1 KB |
| `.ram_text` | 916 insns | 1,120 insns, no calls | the crystal-ramp burst; the flash-ID read (588 B) | | |

(2026-11-18, with the stable address. The 2026-11-17 build: 89,956 B flash, 25,832 B RAM, 929 insns; the address
costs 876 B of flash and 32 B of RAM.)

- Flash is under the estimate because this build leaves out the diagnostics, the central and SMP, and links with
  `--gc-sections`. The radio's start-up program alone is 5,795 B (`ble_rf_prog`).
- RAM: the baseband block 1,508 B, the link layer 1,316 B (with its 1 KiB L2CAP ring), the PLL table 972 B, our two
  rings 4,096 B (512 out, 256 in; they can shrink), the calibration state about 0.3 KB. Nothing goes in the pool:
  every buffer is static.
- The default package is **byte-identical** after all changes: `dist/fm1-console-0.1.fwsc` SHA-256 `00b00e64…eaf`
  before, and after a default rebuild with the BLE code in the tree [M; also `dinghy.bin` `5fc05856…`].

### Dinghy build checks [M]

All pass for the BLE build: no 64-bit division (the link would fail), no ROM reference, image, RAM and pool limits,
`.ram_text` without calls. The register check now also reads the macros of `hal/` subdirectories and scans
`firmware/ble/`: the stack and the glue pass it. **No register access outside `hal/`**: the stack reaches the radio
only through `hal/ble/fm1_ble.h`; its `volatile` fields are the baseband control block, SRAM the engine reads by DMA
(one `(volatile uint8_t *)&bb.cb` cast of a C object, which the check allows). The glue uses `hal/ble`'s
`fm1_irq_off/on`, `fm1_guard_unlock_top/lock_top`, `fm1_ble_irqs_hold`. Two BLE-only checks were added: the
crystal-ramp burst `fm1_rf_burst_run` sits in `.ram_text` (the hang of section 3.5), and `fm1c_ble.o` needs nothing of
the app's but `memcpy`/`memset` (so it cannot call the flash driver, which lives in `console.o`).

### The RF calibration at 0x0E8000: read-only for us? Yes, and not even read [M]

- The BLE build uses fm1-base's self-calibration (`fm1_rf_cal_on = 1`, records 106-108 from the SDK board's constants,
  as Chipbox does). `ble_vm.c` (the VM reader) is not compiled. The image has no constant in `0x0E5000-0x0FBFFF` or
  its XIP alias that is used as an address (the two values in that range, `0xF0001` and `0xF423F`, are arithmetic).
- Nothing in the BLE unit writes flash, and the app never writes flash (unchanged). The FM-1 package, BLE or not, covers
  flash `[0, 0x93000)` only (`fm1pkg_make.py` `FLASH_SIZE`); Dinghy's loader test installs the BLE package over an
  older app and over the USB build with "no write outside the allowed windows" [M].
- So whether this unit's VM still holds stock trims does not matter to this build. Since 2026-11-18 the BLE unit
  sends two read commands to the flash part once per boot (`0x9F` JEDEC ID, `0x4B` unique ID; "Stable address"):
  neither reads the VM or any other array location, and neither writes.

### Tests [M]

Re-run on 2026-11-18 with the stable address, except the last row (2026-11-17).

| Command | Result |
| --- | --- |
| `sh firmware/tests/ble/run.sh` | **`fm1c_ble` 1,180 checks, 0 failed**: a full resync (32 frames, 810 CCs) and device frames through the vendored BLE-MIDI codec at MTU 23 and 247, byte-identical and decodable after; a 13-bit timestamp wrap; SysEx, notes, clock and a non-CC status dropped. **`fm1c_ble_addr` 19 checks, 0 failed** and **`fm1c_flash_uid` 43 checks, 0 failed** ("Stable address") |
| fm1-base `tests/bt/run.sh` in the clone (the same files, `cmp`-identical) | **35 of 35 ok**, 22 of them BLE: stack against a simulated central, the WL82 driver against a fake engine, BLE-MIDI codec |
| `sh firmware/tests/console/run.sh` (host mode, BLE off there) | **1,811 unit checks + 99 scenario checks, 0 failed** |
| `sh firmware/tests/run_tests.sh` (Dinghy's: update path, loader, installer) | **ALL TESTS PASSED**; plus `ota_test` and `ldr_test` on the BLE package: passed |
| `sh firmware/tests/console/run_emu.sh dist/fm1-console-0.1.fwsc` (USB build) | 77 / 77, 19 screens identical to host mode |
| `run_emu.sh dist/fm1-console-0.1-ble.fwsc` | **63 / 77**; the same 14 failures as before the stable address, all in the radio's start window (below; the heartbeat gap there is 1,093 ms, as before); 19 / 19 screens identical |
| the same with `-DFM1C_BLE_START_MS=600000u` (radio never started in a scenario) | 77 / 77 |

**Correction to section 4's arithmetic.** This encoder writes a timestamp octet before every message, running status
included, so a packet of `cap` octets holds `1 + (cap - 5) / 3` CCs: **6 at MTU 23** (not 8) and 80 at MTU 247. The
full resync is **135 notifications at MTU 23** (not 102) and 11 at MTU 247 [M]. At 15 ms and 1 packet per event that is
about 2.0 s, at Optimist's 11.25 ms and 2 per event about 0.76 s. FM1C still fits; the 200 frames/s host cap needs no
change, and a SET_SLOT (22 CCs) is 4 packets at MTU 23.

### Emulator boot of the BLE package (fm1-emu 0.5.1 release binary) [M]

- `fm1-emu --fwsc fm1-console-0.1-ble.fwsc --ms 8000`: it runs the full 8 s and draws (14 LCD frames; NO HOST at
  4.4 s, the same screen as the USB build). The radio start-up ran from **3,028 to 3,114 ms** emulated (step times in
  `fm1_ble_step_at`): all start-up groups entered (sections `0xEDFC`, last 15 = done), 3,454 ops, 512 LUT words,
  101 trim marks, the group-5 burst from RAM (16 writes), 0 BBP and 0 SPI timeouts. Advertising was programmed.
- **The emulator does not model the radio.** It logs 14,198 accesses to 10 unknown MMIO addresses (the BBP port
  `0x3101C`, the RF-die SPI port `0x14028/2C/30`, `0x1405C`, `0x14000`, `0x31004`) and returns 0, so the VCO scan
  finds no band (`scan_found 0`), and **IRQ 29 and 45 never fire** (interrupts: only IRQ 63 TIMER5 and IRQ 11 audio).
  This proves the boot path does not hang or fault in software, not that the radio works. The BLE engine model is in
  fm1-emu's `feat/ble-engine` branch, not in 0.5.1.
- **A real cost found:** the start-up runs with all interrupts off (Chipbox's choice after hangs with them on). In the
  emulator that stalled the main loop and the USB interrupt for about **90 ms** at 3 s: one HEARTBEAT 93 ms late,
  frames arriving then ACKed late (not lost: the host's 250 ms retransmit covers it), one key gesture misread. On
  hardware Chipbox measured about 210 ms. Options: start the radio before USB enumerates, start it only on a user
  action, or leave interrupts on outside the RAM burst (fm1-base's way, with Chipbox's 1-in-20 hang report against it).

### Stable address (2026-11-18) [M unless tagged]

The operator saw the cost of a random address per boot: macOS lists a new device after each power cycle, and the
CoreMIDI port name `FM1 CONSOLE XXXX` changes. Now the address is the same on every boot of a given FM-1, with
nothing stored and no flash write.

- **Source: the SPI flash's factory unique ID** (command `0x4B`, four dummy bytes, 16 ID bytes). Both FM-1 parts
  have one: the stock Puya P25Q80 (`0x856014`) and the newer units' UC25HQ80 (`0xB36014`) [I: from felucca-bsp and
  fm1-base, which read it on FM-1s at every boot for their Wi-Fi MAC and BLE name, `fm1-base/device/main_fm1.c:1280`,
  `device/bt_own.c:90-113`]. The AC79 SDK does the same (`get_norflash_uuid()`, used for the MAC in
  `apps/common/net/assign_macaddr.c`). No other per-unit value is readable without risk: the stock VM's BT MAC at
  `0xE5000-0xFBFFF` may be gone on a unit (section 3.3), and the chip's efuse key is not exposed by any HAL here.
- **The read** (`firmware/hal/ble/fm1c_flash_uid.h`, ours, beside felucca-bsp's headers because the build allows
  register access only under `hal/`): Dinghy's `fl_jedec_ram` sequence, which this firmware already runs at every
  boot on this FM-1, plus felucca-bsp's `fl_uid_ram` command. It sends `0x9F`, then `0x4B` only when the JEDEC ID is
  one of the two FM-1 parts. No other command exists in the file: no write enable, erase, program or status write.
- **XIP and interrupts:** XIP is off while the commands run, so the function is in `.ram_text`, entered through a
  pointer, with every helper inlined (`build.py`: 1,120 `.ram_text` instructions, no calls). The disassembly has only
  immediates, no literal-pool or XIP load. The function itself masks both ICFG enables (bit 9 `cli`, and bit 8, which
  also holds priority-7 sources, as felucca-bsp's `irq_save` does) and gives the caller's ICFG back. It waits for the
  cache to go idle, refuses a continuous-read SFC mode (6, 7) and any core but CPU0, and restores `SFC_CON`, the pin
  map and `SPI0_CON`. It runs once, in `fm1c_ble_start` (3 s after power-on), **before** the radio start-up, whose
  crystal ramp leaves XIP unusable for a while (`fm1_ble_rf.h`). It takes 25 SPI bytes, tens of microseconds [I];
  the emulator's heartbeat gap at the radio start is unchanged (1,093 ms).
- **Derivation** (`fm1c_ble_addr_make` in `firmware/src/fm1c_ble.h`, pure C): two 32-bit FNV-1a hashes with their
  own seeds over `"FM1C"` and the 16 ID bytes, each through MurmurHash3's finaliser (the second also mixes in the
  first). `a[0..1]` = the first hash's low 16 bits, `a[2..5]` = the second's 32 bits, `a[5] |= 0xC0` (static random:
  the two most significant bits 1). A result whose 46 random bits would be all 1 is moved off it; low 16 bits of 0
  become 1, so `0000` names only the fallback. The `"FM1C"` prefix keeps the address apart from the one fm1-base or
  Melodee derives from the same ID, so a Mac never mixes up names cached for another firmware on the same unit.
- **Fallback, never random:** an unknown part, a SPI timeout, a refused mode or core, or an ID of 16 equal bytes (all
  FF or 00: no answer to `0x4B`) gives the fixed address `C6:46:31:43:00:00`, name **`FM1 CONSOLE 0000`**. Two units
  in fallback would share it; the name tells the operator. The outcome is kept in RAM in `fm1c_ble_id` (tag
  `FM1CADR`, source, read result, JEDEC ID, address; not the ID itself), and `fm1c_ble_addr()` gives it to
  `console.c` if it wants to show it (no `console.c` change so far).
- **What the Mac shows:** `FM1 CONSOLE XXXX`, XXXX = the address's octets 1 and 0 as upper-case hex (the address as
  macOS writes it, `..:XX:XX`, last two octets). In the emulator, whose flash answers `0x4B` with `"FM1-"` four times:
  `CE:5D:B1:E5:9F:7F`, **`FM1 CONSOLE 9F7F`**, for both flash parts (`fm1c_ble_id`: source 1 = ID, read result 0,
  JEDEC `856014` / `b36014`), the same as the host test's pinned vector. The real unit's four digits are unknown
  until it runs the BLE package once; they then stay.
- **macOS and pairing:** this build never pairs (no SMP, no bonding), and BLE-MIDI on macOS needs none. With a stable
  address, Audio MIDI Setup's Bluetooth Configuration keeps one entry for the FM-1 and the CoreMIDI port keeps its
  name, so the companion's `--port "FM1 CONSOLE XXXX"` holds across power cycles. Whether macOS reconnects by itself
  after a power cycle, or the operator clicks Connect again, is untested [I: without a bond, expect a click]. Adding
  bonding (the stack's `BLE_SMP_LEGACY`) is not cheap or safe now: it needs the key stored in flash. Note that the
  address changes once, from the random ones to the stable one: forget the old `FM1 CONSOLE XXXX` entries in
  Bluetooth Configuration after flashing.
- **Tests:** `tests/ble/fm1c_ble_addr_test.c` (19 checks): two pinned vectors, determinism, 200,000 random IDs all
  valid static random addresses with no duplicate and no `0000` name, all 128 single-bit ID changes change the
  address, five fallback IDs, the name format, never fm1-base's address for the same ID.
  `tests/ble/fm1c_uid_test.c` (43 checks): the read against a model of SFC, SPI0, CS# and the part: only `0x9F` and
  `0x4B` on the bus, `0x4B` only for the two FM-1 parts, four zero dummy bytes, 25 bytes in all, ICFG given back with
  both enables cleared in between, XIP and the pins restored, CS# high, nothing sent while the SFC is on; refusals for
  modes 6 and 7, CPU1, an unknown or absent part and a stuck SPI.

### BT direct: the companion's own BLE-MIDI client (2026-11-22/23) [M unless tagged]

**Why.** macOS's Bluetooth MIDI driver creates the CoreMIDI port `FM1 CONSOLE XXXX Bluetooth` only after the device
is connected in Audio MIDI Setup → Bluetooth Configuration. `MIDIBluetoothDriverActivateAllConnections` returned
`noErr` but the device stayed offline (2026-11-22, FM1 CONSOLE 19E2). The driver also never enables the
characteristic's notifications, which is why `fm1-ble-notify` exists (2026-11-18). Our own CoreBluetooth client
already scanned, connected and subscribed with no clicks, so BT direct carries the MIDI over it too and uses no
CoreMIDI port.

**Start it** (build the helpers once: `bash apps/companion/scripts/build-native.sh`):

```sh
bun apps/companion/src/cli.ts start --ble "FM1 CONSOLE 8C2F"    # the advertised name, without " Bluetooth"
```

- `--ble NAME` = BT direct. `--port NAME` stays CoreMIDI: `--port "FM1 CONSOLE"` (USB) and
  `--port "FM1 CONSOLE XXXX"` (macOS driver's Bluetooth port, plus `fm1-ble-notify`) work as before. The two flags
  are exclusive. A separate flag was chosen over "`--port` falls back to BT direct when no port exists": with
  Bluetooth the port can appear later, and a silent switch of transport would hide which path runs.
- With `--ble`, `fm1-ble-notify` does not run (one GATT client is enough) and no CoreMIDI port is opened, also when
  the macOS driver holds its own connection: BLE allows several clients on one link, and the helper takes a
  peripheral that is already connected (`retrieveConnectedPeripherals`).
- First run: macOS asks once for Bluetooth access for the terminal app. A denial makes the helper exit 3; the
  companion then logs it and does not restart it.

**Design.** The helper `apps/companion/native/fm1-ble-midi/main.swift` is a plain GATT pipe. It scans for the exact
name (or takes the connected peripheral), connects, discovers service `03B80E5A-…C700` / characteristic
`7772E5DB-…6BF3`, subscribes, and moves raw values: `rx <hex>` lines out, `tx <hex>` lines in. It also prints
`state scanning|connecting|connected|ready mtu=N write=without|with|disconnected|waiting`, `ack`, `log`, `error`.
Nothing else goes to stdout. It writes `.withoutResponse` (`.withResponse` if the characteristic lacks it), in order.
It queues while `canSendWriteWithoutResponse` is false and resumes on `peripheralIsReady(toSendWriteWithoutResponse:)`.
On disconnect it rescans every 2 s, and gives up a connection that is not ready after 15 s. It exits on stdin EOF
(companion gone), 2 on usage, 3 on denied permission. The BLE-MIDI codec and flow control are in TypeScript, where
Bun tests cover them: `apps/companion/src/device/ble-midi-codec.ts` (decoder after the firmware's
`ble_midi.c` rules: header/timestamp bytes, running status with and without timestamp, SysEx across packets with
timestamps before F7 and real-time bytes inside; encoder: one timestamp + status per message, packets ≤ the reported
MTU, ≥ 5, SysEx split) and `apps/companion/src/device/ble-midi.ts` (line parser, `BleMidiTransport`, `BleMidiLink`).
CCs sent in the same tick share packets (an FM1C frame is a CC burst). At most 4 `tx` lines are in flight before
the helper's `ack`s; the rest waits in order. `BleMidiLink` attaches the transport to the device host on
`state ready` and detaches it on `disconnected` or helper exit. It restarts the helper 2 s after a crash, the way
`keepBleNotify` does. The device host's link and heartbeat logic is unchanged. As with CoreMIDI, the transport sends
only channel-16 CCs and drops incoming SysEx, MTC, clock and active sensing.

**Live check (2026-11-23, read-only, nothing written to the device).** The flashed unit now advertises
**`FM1 CONSOLE 8C2F`** (address `FB:60:88:E2:8C:2F`). The name 19E2 from 2026-11-22 is gone. While the operator's companion ran over
`--port "FM1 CONSOLE 8C2F"` (macOS driver connected), the helper alone took the connected peripheral, became
`ready mtu=244 write=without` within the same second, and got 27 notifications in 25 s: the heartbeat once a second
plus ACKs. The firmware sends timestamp + status before every CC. The TS decoder turned them into FM1C HEARTBEAT and
ACK frames with valid checksums and 0 errors. The host-to-device direction and a companion run with `--ble` were not
tried (operator step).

### Open items (need the operator and the device)

1. Flash the BLE package (operator-approved), pair in Audio MIDI Setup, measure ACK RTT, resync time and loss with the
   Bluetooth headset active; check the OCT- rescue and the boot guard with the radio starting.
2. A runtime ON/OFF (a settings bit and a menu or gesture). (The stable address is done: "Stable address" above. On
   the device, check that the name is the same after two power cycles and is not `FM1 CONSOLE 0000`.)
3. Companion (outside this brief): match the BLE port name `FM1 CONSOLE XXXX`, prefer USB when both exist, keep the
   SysEx-blocking writer.
4. Decide the start-up stall (above) before a release.
5. ISR durations and the analog radio side on hardware remain unmeasured (section 1, `melodee/docs/BLE-STACK.md` §12).
