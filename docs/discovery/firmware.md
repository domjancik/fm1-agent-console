# Discovery: firmware build, HAL and emulator

Scope: spec section 1 (Hardware), section 11 layers 5 and 6, and section 12 (build and flash).
Date: 2026-11-17. Machine: macOS 27.2 (Darwin), Apple Silicon (arm64, T6050).

## Sources examined (all read-only)

| Tree | Revision | Notes |
| --- | --- | --- |
| `/Users/dominikj/dev/personal/fm1` | `22acb91` (Dinghy 0.4, 2026-10-23), origin `zvenson/dinghy` | **Uncommitted WIP ("Wordscape")**: `firmware/src/dinghy.c`, `firmware/src/gfx.c`, `tools/build.py` modified; `WORDSCAPE.md`, `firmware/src/ambient.c`, `firmware/src/speech/`, `tests/wordscape/` untracked. Not modified by this discovery. |
| `../.fm1-upstream/dinghy` | `ea1b6bf` (Dinghy 0.5, 2026-11-07), shallow clone | Clean upstream. The local checkout is one release behind. |
| `../.fm1-upstream/dinghy-copy` | copy of the clone above, plus a one-line patch to `gfx.c` for macOS host mode | Used to run host mode. |
| `../.fm1-upstream/fm-1-agent-deck` | `c107d20` (2026-11-13) | Cloned by another agent. Read only for its emulator use and firmware transport. |
| `../.fm1-upstream/fm1-emu` | `2ed9865` (2026-11-16), `joakimeriksson/fm1-emu` | Cloned by another agent. |
| `../.fm1-upstream/fm1-emu-bin/` | release v0.5.1 `fm1-emu-0.5.1-macos-arm64.tar.gz` | Downloaded and extracted. **Not executed** (permission denied, see "Blocked actions"). |
| `../.fm1-upstream/mvave-fm1` | shallow, `maxfridbe/mvave-fm1` (MIT) | |
| `../.fm1-upstream/MvaveFM1Unbricker` | `331f848` (2026-11-12), `Quixotic7/MvaveFM1Unbricker` (MIT) | |

In this document, line references without a prefix are to the **upstream Dinghy 0.5** clone. They also hold for the local
0.4 checkout unless the text says otherwise (`fm1_input.h` and the `BTN_`/`ENC_` enums are byte-identical; `usb.c` is the same).

---

## 1. Panel HAL: buttons, encoders, keys

### 1.1 Identifiers

The FM-1 has one 11-column by 6-row diode matrix behind 74HC595 shift registers. It is scanned at 10 kHz from TIMER5 and debounced:
press after 2 frames (~1.1-2.2 ms), release after 8 frames (~9 ms).
Evidence: `firmware/hal/fm1_input.h:3-43`, `:57-58`, `:64-66`, matrix `:70-77`.

- IDs 0..13 are the 14 buttons. IDs 14..40 are the 27 note keys (`FM1_NKEY 41`, `fm1_input.h:64`).
- Button enum (FM-1 build): `firmware/src/platform.c:41-42`.
- Encoder enum: `firmware/src/platform.c:43`.
- Key LED id: `KEY_LED(k) = 14 + k` (`platform.c:44`).
- The emulator uses the same numbering: `fm1-emu/crates/fm1-soc/src/periph.rs:1451-1470` (`OCTDN 0 ... REC 13`, `n0..n26 = 14+k`).
  fm1-emu names button 3 "SCL".

| Spec section 7 control | Dinghy HAL identifier | ID / type | Read with | LED? |
| --- | --- | --- | --- | --- |
| 27 keys | `fm1_in.notes` bit 0 (F3) .. 26 (G5) | key ids 14..40 | `fm1_in.notes`, `fm1_input_note_edges()` | yes, `fm1_led_key(KEY_LED(k), on)` |
| HOME | `BTN_HOME` | button 8 | `fm1_in.buttons`, `fm1_input_edges(&rel)` | yes |
| EDIT | `BTN_EDIT` | button 6 | same | yes |
| GLO | `BTN_GLO` | button 7 | same | yes |
| REC | `BTN_REC` | button 13 | same (has press and release edges: usable for push-to-talk) | yes |
| SAVE | `BTN_SAVE` | button 9 | same | yes |
| PLAY | `BTN_PLAY` | button 12 | same | yes |
| FX | `BTN_FX` | button 2 | same | yes |
| ENV | `BTN_ENV` | button 4 | same | yes |
| OCT- | `BTN_OCT_DOWN` | button 0 | same. **Held at power-on, it starts the USB rescue** (`platform.c` recovery path; README "USB rescue") | yes |
| OCT+ | `BTN_OCT_UP` | button 1 | same | yes |
| SELECT (encoder) | `ENC_SELECT` | encoder 0 | `fm1_enc_take(ENC_SELECT)`: detents since the last call, + = clockwise | n/a |
| ALGORITHM (encoder) | `ENC_ALGORITHM` | encoder 1 | `fm1_enc_take(ENC_ALGORITHM)` | n/a |
| K1-K4 | `ENC_KNOB1..ENC_KNOB4` | encoders 2..5 | `fm1_enc_take(...)`: **relative detent encoders (K1-K4 are encoders)** | n/a |
| MASTER | `FM1_ADC_MASTER` (pot) | ADC channel 4 (`hal/fm1_adc.h:16`) | `fm1_adc_read(FM1_ADC_MASTER)` returns 0..1023, or -1 when not ready | n/a |
| (unassigned) | `BTN_SEL` 3, `BTN_LFO` 5, `BTN_ARP` 10, `BTN_SEQ` 11 | buttons | | yes |
| (unassigned) | `ENC_PRESETS` | encoder 6 | | n/a |

Remarks:

- The spec says "SELECT encoder". `BTN_SEL` (button 3) is a **separate button**. The encoder has no push switch. The SMK-37
  map calls it SCALE and fm1-emu calls it SCL (`docs/API.md` SMK table; `periph.rs:1455`). The HAL has no encoder push switches.
  Check the physical label of button 3 on the unit.
- The four unassigned buttons (SEL, LFO, ARP, SEQ) and PRESETS can take functions the spec does not map yet, for example a
  confirm or "approve" button that is physically apart from FX (deny).
- `platform_poll()` already reads MASTER and uses it as the audio volume (`platform.c:394-423`, `master_q12`). If MASTER also
  controls the screen, the audio scaling has no effect when the app makes no sound, so this is harmless.
- Encoder steps: one detent is one step at any speed (`fm1_input.h:24-33`). `enc_steps` is `int16_t` per encoder.
- Button edges: `fm1_input_edges()` returns the press bits and the release bits since the last call (`fm1_input.h:349-358`).
  A press shorter than one main-loop pass still counts. Double press and long press must be timed in the app with `fm1_ms`.

### 1.2 LEDs

Evidence: `fm1_input.h:7-8` and `:35-43` (the design comment), `:85-86` (LED port/bit), `:102-109` (layers), `:288-322` (tick),
`:366-378` (`fm1_led_key`); `platform.c:61-70` (`fm1_led_key_glow`).

- **Single colour, one drive line per LED.** Four LED lines (PH6, PH9, PA9, PA10) share the matrix columns. Each LED is one bit
  in `fm1_led[col]`, with no colour component. **The FM-1 key and button LEDs are not RGB.** Only the SMK-37 pads are RGB
  (`padled_set`, `hal/fm1_lcd_hw.h:8-10`). This matches the spec rule "do not depend on RGB key lighting".
- **All 41 ids have an LED slot.** LED rows 1..4 of `FM1_KEYMAP` hold all 14 buttons and all 27 keys (`fm1_input.h:70-77`:
  row PA5 = buttons 5,11,4,10,3,9,2,8; row PA6 = keys 20..26 and buttons 13,7,6,12; row PA7 = keys 9..19; row PA8 = buttons 0,1 and
  keys 0..8). The HAL can address all of them. Whether every one has a physical LED fitted must be checked on the hardware
  (post-flash smoke test). The spec says the 27 keys are backlit.
- **Brightness: three fixed layers, no free PWM API.** The brightest layer wins.
  1. lit: `fm1_led_key(id, 1)`, ~95 us per frame;
  2. glow: `fm1_led_key_glow(id, 1)` / `fm1_led_dim[col]`, `FM1_GLOW_NS 4000` ns, ~1/24 of lit;
  3. backlight: `fm1_led_bg[col]` with `fm1_led_bg_ns` (global, adjustable in ns, 0 = off). Dinghy wraps no helper for this layer,
     and **`tests/host.c` does not model it** (only `host_leds` and `host_glow`, `tests/host.c:76-81`).
- **Blink and pulse are app-side.** Toggle the layers from the main loop with `fm1_ms`. The spec's states (working steady, approval
  slow blink, failed fast blink, done pulse, selected bright) map onto off / glow / backlight / lit and blink timing.
  Example: selected = lit, working = glow, approval = slow blink lit/off.
- **The host harness logs only the lit layer.** `host.c:365` writes `notes`, `host_leds>>14` and `host_leds&0x3FFF` to the film log.

### 1.3 LCD

Evidence: `firmware/src/lcd.c:1-7`, `:72`, `:94`, `:142`; `firmware/src/gfx.c:18-24`, `:62-175`; `hal/fm1_lcd_hw.h:1-20`; `docs/API.md:102-144`.

- ST7789-class 240x240 panel, RGB565 (`RGB(r,g,b)` macro, `gfx.c:24`), on SPI1 at 12 MHz with polled DMA.
- API:
  - `lcd_fill(x,y,w,h,c)` and `lcd_blit(x,y,w,h,px)`;
  - `draw_text_box(x,y,w,font,s,colour,align)`;
  - canvas: `cv_begin`, `cv_rect`, `cv_line`, `cv_pset`, `cv_text`, `text_w`, `cv_blit`, `cv_blit_from`;
  - palette: `palette_set`, with `C_LINE`, `C_DIM`, `C_GRAY`, `C_AMB`, `C_HI`.
- Fonts: `FONT_S` (16 px, full ASCII) and `FONT_L` (32 px, capitals, digits and signs only).
- Canvas size: `CV_MAX` (default 240x124 in 0.4/0.5 gfx.c, held in the 336 KB `.pool`). A full 240x240 canvas is 113 KB.
- One 240x64 strip goes out in ~3 ms. A full frame is ~77 ms at 12 MHz (fm1-emu README, `FM1_LCD_TIMED`). This supports the spec's
  rule "no continuous full-screen redraws".
- `LCD_IDLE` hook: the app can service MIDI while a DMA strip goes out (`lcd.c:22-33`).
- **Backlight: GPIO PA2, active low, on or off only.** No PWM in the HAL. The spec's "MASTER = screen brightness" therefore needs
  one of these:
  - (a) a new `hal/` helper that bit-bangs or uses a timer PWM on PA2. The build forbids register access outside `hal/`
    (`tools/build.py:254-295`).
  - (b) "brightness" emulated by scaling the palette.
  - (c) dropping the mapping.

### 1.4 MIDI and SysEx

Evidence: `platform.c:293-307`; `usb.c:1-21`, `:130-170`, `:676-813`, `:820-913`; `ota.c:1-60`, `:161-185`; `docs/API.md:162-186`.

- App API (3-byte messages only):
  - `midi_get(&st,&d1,&d2)` returns 1 for USB, 2 for TRS, 0 when the queue is empty. It delivers channel voice messages and
    F8/FA/FB/FC.
  - `midi_send(st,d1,d2)` sends one message over USB, from the main loop only.
- Buffers:
  - `MQ 64`: 64 USB-MIDI 4-byte packets each way (`midi_in_q`, `midi_out_q`, `usb.c:161-163`).
  - EP1 packets are 64 B (16 events). EP1 OUT is held back (NAK) while fewer than 24 slots are free (`EP1_ROOM`, `usb.c:774-787`),
    so the host is back-pressured and nothing is dropped.
  - `midi_out_event` **silently drops** a packet when the out ring is full (`usb.c:164-171`).
  - USB is polled at 2 kHz from TIMER5 (`platform.c` timer, `usb_due = sub % 5 == 0`).
- **SysEx never reaches the app.**
  - `midi_in_event` sends CIN 4..7 packets to `sysex_byte()` (`usb.c:733-741`).
  - `sysex_byte()` recognises only `F0 22 24 35 7D F7` (enter UBOOT, i.e. ROM boot mode) and `F0 22 24 35 7F F7` (M-UPGRADE
    update request). Any other frame of up to 640 bytes goes to `sx_frame` (`usb.c:151`, `:677-727`).
  - `platform_poll()` then calls `ota_service()` (`platform.c:400`). Its `ota_take()` drops any frame that is not
    `00 59 cmd len24 ... chk` (`ota.c:161-185`).
  - Only one frame is buffered. Frames that arrive while one is pending are dropped (`usb.c:148-150`).
  - The SysEx TX helper `ota_wire_send()` blocks up to 500 ms on a 64-packet ring (`SXQ`, `usb.c:155`, `:820-857`). TX SysEx has
    priority over notes and is never split by them (`usb.c:891-901`).
- Consequences for the device protocol (spec section 9):
  1. Without platform changes, the transport must use CC/Note messages. Agent Deck does this: channel 16, CC 118 = frame control,
     CC 119 = one payload byte (`fm-1-agent-deck/firmware/agtdeck.c:8-20`). This costs ~3 bytes on the wire per payload byte.
  2. SysEx is possible if the app peeks `sx_frame`/`sx_ready` (through `ota_frame_get`/`ota_frame_done`) before `ota_service()`
     takes the frame, using its own manufacturer ID (for example `F0 7D ...`, non-commercial). This changes `platform.c` or
     `usb.c`, which the Dinghy README says not to fight. Limits: one frame of 640 B in flight, 7-bit payload.
  3. **Danger:** any host-side frame equal to `F0 22 24 35 7D F7` drops the FM-1 into ROM/UBOOT mode, and `F0 22 24 35 7F F7`
     starts an update session. The companion must never send these. Add a guard in the companion's MIDI writer.
- The USB device name is `"Felucca"` in Dinghy (`usb.c` STR2). Agent Deck changed it to `"FM-1 AGTDECK"`. Choose a distinct name
  so that the companion and `tools/fm1_install.py` (`PORT_RE` matches `felucca|fm-1|...`) find the right port.

---

## 2. Build system

### 2.1 How a `.fwsc` is built

- `build.sh` (`build.sh:1-20`) checks four things: Pillow, `$JIELI_TOOLCHAIN/pi32v2/bin/clang`, the
  `$AC79_SDK/cpu/wl82/tools/uboot.boot` file, and (on any host other than Linux x86-64) `docker info`. It then runs
  `python3 tools/build.py`.
- `tools/build.py`:
  - Runs every toolchain binary (clang 4.0.1 for `pi32v2`, `ld`, `objcopy`, `objdump`) as
    `docker run --rm --platform linux/amd64 -v SRC:/work -v TOOLCHAIN:/opt/jieli:ro -w /work debian:bookworm-slim /opt/jieli/<tool>`
    (`build.py:45`, `:76-97`). The JieLi toolchain is Linux x86-64 only, so on Apple Silicon it runs under Rosetta/QEMU emulation.
  - Builds the update loader (`build.py:136-163`) and the app (a unity build of `dinghy.c`, `-Os`, `:168-217`).
  - Checks the result: entry stub, no calls in `.ram_text`, no chip-ROM references, image size within the app slot, RAM at most
    96 KiB, no MMIO access outside `hal/` (`:220-295`).
  - Packs the `.fwsc` with `tools/fm1pkg_make.py`, using three SDK files whose SHA-256 is pinned (`SDK_SHA256`, `:51-55`).
  - Package identity is `BOARD_PREFIX + minor`: `FM-1_990` for a dev build, `FM-1_99Y` for `--release X.Y` (`:58-64`, `:321-329`).
    The loader screen name is `SCREEN_NAME`.

### 2.2 What is installed on this Mac (verified)

| Item | State | Evidence |
| --- | --- | --- |
| JieLi toolchain | `~/.jieli/toolchain -> jieli-linux-toolchains-20260730.1` (installed 2026-10-29). `pi32v2/bin/clang` is an ELF x86-64 binary. | `ls -la ~/.jieli`, `file` |
| AC79 SDK | `~/fw-AC79_AIoT_SDK` at `d179b44`, tag text `AC79NN_SDK_V1.2.1_2023-12-13` (gitee). All three pinned files match `SDK_SHA256`. | `git log`, `shasum -a 256` |
| Docker | `/usr/local/bin/docker` runs against **OrbStack**, server 29.8.2, aarch64. `debian:bookworm-slim` is present locally (multi-arch index). No JieLi/Dinghy-specific image: the build uses plain `debian:bookworm-slim`. | `docker info`, `docker images` |
| Python | 3.14.5 with Pillow 12.2.0 | `python3 -c 'import PIL'` |
| Host C compiler | Apple clang (system `cc`) | host mode ran |

How the existing `fm1/build/dinghy.fwsc` was produced:

- `build/*` timestamps are Oct 29 16:52-16:53, minutes after the toolchain install (16:11) and the WIP edits (`build.py`, 16:52).
- It is the **Wordscape WIP build**. The string `WORDSCAPE` is in the package, `build.py` has
  `BOARD_PREFIX "FM-1_96"` and `SCREEN_NAME "WORDSCAPE"`. Size 612,199 B, SHA-256
  `38c332e182093a14e28cf1c3b6605ce71a01c5bee93dfdcda35d4f435f332a76`.
- `build.sh` on macOS cannot run without Docker, so it was built through `./build.sh`, which runs each tool in a
  `--platform linux/amd64 debian:bookworm-slim` container on OrbStack. No other cached build image exists, and nothing related is
  in `~/.cache` or `~/Library/Caches`.
- I did not verify the identity string: only `ota-FM-1_900`/`FM-1_900` appears as plain text, which is the update-loader parm.
  The app identity is inside the packed image.

### 2.3 Exact commands to build a `.fwsc` on this machine

The recommended build uses the clean upstream 0.5 tree, or our own fork of it. **Never build inside `/Users/dominikj/dev/personal/fm1`.**

```sh
# prerequisites are already present: ~/.jieli/toolchain, ~/fw-AC79_AIoT_SDK, OrbStack running, Pillow
cd /Users/dominikj/dev/personal/.fm1-upstream/dinghy        # or our fork under fm1-agent-console/firmware/
JIELI_TOOLCHAIN=$HOME/.jieli/toolchain AC79_SDK=$HOME/fw-AC79_AIoT_SDK ./build.sh
#   -> build/dinghy.fwsc (identity FM-1_990), build/dinghy.bin, build/loader/ota.bin
./build.sh --release 0.1                                     # -> build/dinghy-0.1.fwsc, identity <PREFIX>1
shasum -a 256 build/*.fwsc
sh tests/run_tests.sh                                        # host tests: ota_test, ldr_test, installer tests (needs build/dinghy.fwsc)
```

For our fork, set our own identity in `tools/build.py`:

- `BOARD_PREFIX["fm1"]`, for example `"FM-1_9A"` or another `FM-1_9NN` prefix not used in the Firmware Hub catalogue.
  `fm1_install.py`'s `OWN_LOADER_RE` wants `ota-FM-1_9\d\d` for resume, so keep the `FM-1_9` prefix.
- `SCREEN_NAME` and `SCREEN_COLOUR`.
- `APP_NAME`.
- The USB string in `usb.c`.

**Status: not yet executed.** `./build.sh` in the upstream clone was blocked by the session's permission classifier (see below).
Every input is present and hash-verified, and the WIP build on Oct 29 shows that this exact Docker path works on this Mac.
A first real build should take a few minutes, because each tool invocation is a separate amd64 container.

Alternatives:

- `maxfridbe/mvave-fm1` has a podman Containerfile and `mvave-build.sh` (toolchain 20250324.1, hash-pinned). It needs podman and
  manual vendor files. Our Docker path is simpler because the files are already local.
- Dinghy CI (`.github/workflows/release.yml`) builds on GitHub with build attestation. This is useful for provenance of a
  candidate package.

### 2.4 Host mode (spec Layer 5)

- `tests/run_host.sh` compiles `firmware/src/dinghy.c` with `-DDINGHY_HOST` and the native `cc`. `platform.c:47-48` then includes
  `tests/host.c` (the fake FM-1) in place of the HAL.
- Output: `build/host/<name>.wav` and screen PPMs, which Pillow converts to 480x480 PNGs.
- Script language (`tests/host.c:183-205`), one line per event: `T keys MASK`, `T btn ID` (a tap), `T btndown ID` / `T btnup ID`,
  `T enc N STEPS`, `T midi ST D1 D2` / `T trs ...`, `T clock BPM N`, `T shot`, `T end`.
- `midi_send` on the host prints `MIDI out ...` to stdout (`host.c:142`). This gives a way to assert the device-to-host stream.
- **Upstream host mode does not compile on macOS.** In the clean clone the result is:
  `gfx.c:20: error: argument to 'section' attribute is not valid for this target: mach-o section specifier requires a segment and section separated by a comma`.
  The user's WIP has the fix (`git diff firmware/src/gfx.c`, +4 lines):

  ```c
  #if defined(DINGHY_HOST) && defined(__APPLE__)
  static uint16_t cv_px[CV_MAX];
  #else
  static uint16_t cv_px[CV_MAX] __attribute__((section(".pool")));
  #endif
  ```

  With this patch applied in `../.fm1-upstream/dinghy-copy`, `sh tests/run_host.sh` **passes on this Mac**. It printed MIDI out
  events, `settings 0 saved`, `build/host/dinghy.wav (286464 frames)` and `dinghy-1000.png`/`dinghy-3000.png`. Our fork must carry
  this patch. Other section attributes, such as `platform.c:94` `.noinit`, are skipped on the host build today; any new one needs the same guard.
- Gaps in the host harness:
  - No SysEx path.
  - No `fm1_led_bg` layer.
  - `fm1_input_note_edges()` returns 0, because the script sets `notes` directly (`host.c:72`).
  - No USB connect/disconnect model.

  Our protocol and connection-loss tests need small host.c extensions, for example a `midi`-from-file feeder, a `usb off` / `usb on`
  event, and an LED-state dump per shot.

---

## 3. Emulator (spec Layer 6)

**It exists:** `joakimeriksson/fm1-emu` (MIT), the "fm1-emu" that Agent Deck uses.

- `fm-1-agent-deck/tools/get_emu.sh:1-30` fetches the release binary (it pins v0.4.0; v0.5.1 is the latest, 2026-11-14). Assets
  include `fm1-emu-0.5.1-macos-arm64.tar.gz` with `fm1-emu` (batch runner) and `fm1-live` (window or headless), both Mach-O arm64,
  unsigned. Clear the quarantine flag first: `xattr -d com.apple.quarantine fm1-live fm1-emu`, per README.txt.
- Agent Deck boots every package in it (`tools/emu_test.py`, `tools/emu_shots.py`). It feeds CC frames through the emulated MIDI IN
  jack (`--keys "T:midi:bfCCVV,..."`) and saves LCD screenshots.
- What it executes: the real `.fwsc` on a pi32v2 CPU model with a JIT (AArch64 native). It also models the timers, IRQs, flash
  (Puya, or `--flash-chip uc25hq80`), LCD, key matrix and encoders, ADC pot, audio, MIDI UART and **the USB controller**.
  Source: `fm1-emu/README.md` "How it works" and the `--usb` paragraph.
- Batch CLI (`crates/fm1-emu/src/main.rs:23-48`):

  ```
  fm1-emu --fwsc PKG.fwsc [--ms MS] [--steps N] [--flash-chip p25q80|uc25hq80]
          [--keys 'T[-T2]:PLAY,T:n7,T:k12,T:enc0:+3,T:pot:512,T:midi:903c64']
          [--wav OUT.wav] [--snap MS,MS (-> work/lcd_MS.bmp)] [--flash FILE] [--quiet]
  ```

  Button names are `OCTDN OCTUP FX SCL ENV LFO EDIT GLO HOME SAVE ARP SEQ PLAY REC`, `kN` = raw id, `nN` = note key
  (`fm1-soc/src/periph.rs:1451-1470`).
- `fm1-live --usb` enumerates the emulated device on macOS as a real CoreMIDI device named "<product> (emu)". The companion can then
  talk to the **actual package over USB-MIDI**, including SysEx and `fm1_install.py`. Headless runs use
  `fm1-live --shot MS` with `FM1_USB_SEND='MS:HEX;...'` and print the device's USB replies (README lines ~110-120).
  This is the best fit for spec Layer 6: protocol framing, heartbeats, disconnect (the device "goes away when the firmware drops
  off USB"), and malformed packets.
- LED state: the SoC model counts lit cycles per LED (`periph.rs:263`; env `FM1_WATCH_LEDPUT`). I found no documented CLI dump of
  LED state. **Open question:** is there a scriptable LED readout for asserting blink patterns in the emulator? If not, LED
  assertions stay in host mode.
- `FM1_STRICT=1` / `FM1_LCD_TIMED=1` give realistic LCD timing (a full frame ~77 ms), so redraw budgets are visible.
- **Not run in this discovery.** Running the downloaded binary was denied. Nothing on this Mac builds it from source either:
  `cargo` and `rustc` are absent.

---

## 4. Recovery and flash identity (spec section 12)

- Flash IDs: `0x856014` = Puya P25Q80 (older units), `0xB36014` = UCUN UC25HQ80 (units sold from autumn 2026).
  Sources: `MvaveFM1Unbricker/README.md:14`, `:85`; `fm1_unbrick.py:97-98`; `docs/index.html:509`.
- **Dinghy 0.4 (the local checkout) only accepts `0x856014`.** See `fm1/firmware/hal/fm1_flash_map.h:20`:
  `#define FL_JEDEC_OK(id) ((id) == 0x856014u)`. Dinghy 0.5 adds `0xB36014` (`dinghy/firmware/hal/fm1_flash_map.h:22`; README
  "Status: 0.5").
  On a UC25HQ80 unit, a 0.4-based firmware sets `flash_ok = 0`. Settings then stay in RAM only, and **the OTA updater refuses**
  (`platform.c` `if (flash_ok) ota_session()`), which locks the user into that firmware. The Unbricker README describes exactly
  this "firmware lock". **We must base on Dinghy 0.5 or later.**
- Recovery tiers:
  1. Normal update: `python3 tools/fm1_install.py PKG.fwsc` (it asks before writing; `--info` reads the identity; exit codes in
     `fm1_install.py:12-50`), or the FM-1 Firmware Hub in Chrome or Edge.
  2. Dinghy rescue: hold OCT- at power-on, or let it happen automatically after two crashed boots (bootguard). Only the updater
     runs. This depends on the app image's boot code being intact, so the spec's warning applies.
  3. Mask-ROM UBOOT (`WL82 UBOOT1.00`, USB `4C4A:8057`). Enter it with SysEx `F0 22 24 35 7D F7`, with `fm1_unbrick.py softkey`, or
     by a button combination. Then use `MvaveFM1Unbricker`:
     - `info`: chip key `0x980F`, flash ID;
     - `backup DIR`: a double read of the full 1 MiB, compared;
     - `restore V15-FM-1.fwsc`: writes `0x4000..0x92FFF`, hash-checked against V15;
     - `full-restore`: writes the boot head too.

     Tested on an Apple Silicon Mac on 2026-11-10 (`README.md:186`; `fm1_macusb.py` handles macOS).
  4. Hardware: the FM-1 Transporter (an RP2040 on the USB data lines), `TRANSPORTER-GUIDE.md`.
- `maxfridbe/mvave-fm1` has the backup → flash → restore procedure as Claude skills. It was verified on one FM-1 under Linux only.
- Use V15 for `restore`. V16 runs past `0x92FFF` and needs `full-restore` (Unbricker README).

---

## 5. Blocked actions (permission classifier)

The session's auto-mode classifier denied two actions. I did not work around them:

1. `./build.sh` in `../.fm1-upstream/dinghy`, the Docker-based firmware build. Reason given: "Undermining Oversight".
2. Running the downloaded `fm1-emu --version` / `--help`.

The user must allow one of these (for example a Bash permission rule for `./build.sh` in the upstream tree and for
`.fm1-upstream/fm1-emu-bin/*/fm1-emu`) before an implementation agent can produce or test a `.fwsc`.

## 6. Open questions

1. Physical LEDs: does every one of the 41 HAL LED slots have an LED, and what colour are they? The HAL shows single-colour only.
   Verify on the unit.
2. Physical label of button 3 (`BTN_SEL`; "SCL" in fm1-emu). Does any encoder have a push switch? The HAL shows none.
3. MASTER as screen brightness needs a new `hal/` PWM helper for backlight pin PA2. Is this worth it, or should MASTER stay as volume
   or a navigation control?
4. Transport: CC framing as in Agent Deck (no platform change, slower), or app-level SysEx (requires patching `ota_service` /
   `sx_frame` handling)? This affects the protocol owner's design.
5. Package identity: which `FM-1_9NN` prefix is free in the Firmware Hub catalogue? The user's WIP uses `FM-1_96`, and Dinghy uses
   `FM-1_99`.
6. Which flash chip is in the attached unit? Run `fm1_install.py --info`, or the Unbricker `info` command in UBOOT mode. This is
   read-only but needs user approval and the device.
7. Is there a scriptable LED-state readout in fm1-emu for Layer 6 LED assertions?
8. Should the fork track Dinghy 0.5 (`ea1b6bf`) directly, or Agent Deck's `firmware-build/` (a Dinghy copy with a changed `usb.c`
   name, `store.h` and `dinghy.c`)?

---

## Reviewer verification

Reviewer: skeptical second pass, 2026-11-17. I re-opened the cited files and re-ran read-only commands. I modified nothing outside this section.
Paths: `D` = `.fm1-upstream/dinghy` (`ea1b6bf`), `AD` = `.fm1-upstream/fm-1-agent-deck`, `EMU` = `.fm1-upstream/fm1-emu` (`2ed9865`).

### Checked claims

| # | Claim | Verdict | Evidence / correction |
| --- | --- | --- | --- |
| 1 | Button/encoder IDs (HOME 8, EDIT 6, GLO 7, REC 13, SAVE 9, PLAY 12, FX 2, ENV 4, OCT-/+ 0/1; ENC 0..6; `KEY_LED(k)=14+k`) | CONFIRMED | `D/firmware/src/platform.c:41-44` (FM-1 branch; the SMK-37 branch at `:34-39` has different IDs and `KEY_LED=32+k`, so code must not be built with `BOARD_SMK37`). Seven encoders match spec section 1. |
| 2 | Dinghy 0.4 accepts only `0x856014`; 0.5 adds `0xB36014`; OTA refused when `flash_ok=0` | CONFIRMED, one citation fix | `fm1/firmware/hal/fm1_flash_map.h:20` vs `D/firmware/hal/fm1_flash_map.h:22`. The OTA gate is at `D/firmware/src/platform.c:403` (normal mode) and `D/firmware/src/recovery.c:37` (rescue mode), not a generic "platform.c recovery path". Line 18 in both files is the SMK-37 branch. |
| 3 | SysEx never reaches the app; only `F0 22 24 35 7D F7` / `...7F F7` are special; one 640 B frame; `ota_take` drops non-`00 59` frames | CONFIRMED | `D/firmware/src/usb.c:151` (`sx_frame[640]`), `:677-727` (`sysex_byte`, `sx_collect = !sx_ready` = drop while pending), `:733-741` (CIN 4..7); `D/firmware/src/ota.c:162-185`; `platform.c:400`. Precision: the `7F` match checks only bytes 1..4 and length 6 (`usb.c:716-717`), so any 6-byte `F0 22 24 35 7F xx` sets `ota_req`. The companion guard should block the whole `F0 22 24 35` prefix, not two exact strings. The usb.c comment "ota_take() / ed_service()" refers to an `ed_service` that does not exist in 0.5 (grep finds no definition). |
| 4 | Upstream host mode fails on macOS at `gfx.c:20`; the 4-line guard fixes it | CONFIRMED | Re-ran `cc -fsyntax-only -DDINGHY_HOST` with the generated `firmware/gen` headers: upstream gives the exact Mach-O `section` error at `gfx.c:20:54`; `dinghy-copy` gives 0 errors. `diff -r` shows the gfx.c guard is the only source change. Note: host builds also need `firmware/gen/felucca_font.h`, generated by the build scripts, which is not in the clean clone. |
| 5 | Existing `fm1/build/dinghy.fwsc` is the Wordscape WIP build | CONFIRMED | SHA-256 `38c332e1...2a76` reproduced; `WORDSCAPE` occurs once in the package; WIP `fm1/tools/build.py:58` has `BOARD_PREFIX "FM-1_96"`. |
| 6 | fm1-emu has no scriptable LED readout | PARTLY WRONG | No numeric LED dump exists, but LED state can be captured as images: `fm1-live --bench` with `FM1_BENCH_FRAMES=DIR[,MS]` writes a PPM of the panel every MS ms, including "the LEDs as they were lit since the last frame" (`EMU/crates/fm1-live/src/main.rs:483-509`), and `FM1_BENCH_PANEL=FILE` writes the final panel (`:595-599`, help at `:1366-1367`). The per-LED fractions come from `led_take()`/`led_shown()` (`EMU/crates/fm1-soc/src/periph.rs:271`, `:1273-1283`; the report's `:263` is stale after the `led-average` merge). LED blink assertions in Layer 6 are therefore possible by sampling pixels at the LED positions, or by a small upstream patch that prints `led_take()` as text. |
| 7 | `fm1_led_bg` backlight layer has no Dinghy helper | CONFIRMED | `grep fm1_led_bg D/firmware/src` finds nothing. The HAL comment mentions a "menu LIGHTS" (`D/firmware/hal/fm1_input.h:41`, `:108-109`) that Dinghy 0.5 does not implement. The app can write `fm1_led_bg[]`/`fm1_led_bg_ns` directly because they are HAL globals visible to the unity build. |
| 8 | Build via `./build.sh` works on this Mac | UNVERIFIED | Still not run (classifier block). Evidence remains indirect (Oct 29 WIP package). Not re-attempted by the reviewer. |
| 9 | Emulator `--usb` gives a real CoreMIDI device | UNVERIFIED | README text confirms it (`EMU/README.md:112-118`); binary never executed. |

### Gaps and corrections the report missed

1. **Agent Deck's `firmware-build/` is already Dinghy-0.5 equivalent.** `diff -rq AD/firmware-build/firmware D/firmware` differs only in `dinghy.c`, `store.h` and `usb.c`; it accepts `0xB36014` (`AD/firmware-build/firmware/hal/fm1_flash_map.h:22`). So open question 8 is not a flash-chip question: either base is safe. Agent Deck's tree also lacks the macOS gfx.c guard (`AD/firmware-build/firmware/src/gfx.c:20`), so its host harness fails on this Mac too.
2. **Agent Deck identity breaks the installer resume regex.** Agent Deck uses `BOARD_PREFIX "FM-1_2435"` (`AD/firmware-build/tools/build.py:58`, README:556, :762), but `fm1_install.py:43` `OWN_LOADER_RE` only matches `_9\d\d`. Whether the loader parm stays `ota-FM-1_900` regardless of app identity (the report saw only that string in the WIP package) is unverified. Pin this down before choosing an identity: it decides whether an interrupted update can resume.
3. **Licensing (spec section 2 "Licensing").** Dinghy and Agent Deck are both GPL-3.0 (`D/LICENSE`, `AD/LICENSE`; `AD/firmware-build/LICENSING.md`). A fork is GPL-3.0. Whether the companion must be GPL depends on whether it ships any of this code. The report does not mention it.
4. **Protocol gap vs spec section 9.** Agent Deck's CC stream (`AD/PROTOCOL.md:26-33`, `:92-98`) has a version CC (116/117) but no sequence/request IDs, no checksum and no explicit command ACK frame. The spec requires all three plus "no duplicate execution after reconnection". The CC framing must be extended (for example a seq byte and a checksum byte per frame, and a device-to-host ACK CC). Throughput: ~3 wire bytes per payload byte, at most 48-byte frames, 2-4 Hz refresh. Budget `SET_SESSION_DETAIL` text with this in mind.
5. **Control-mapping conflicts with Agent Deck.** Agent Deck uses SEL, LFO, ARP, SEQ and PRESETS heavily as chord buttons (`AD/PROTOCOL.md:41`, `:64-85`). The spec's mapping leaves them free. If we reuse Agent Deck's `agtdeck.c`, its mapping must be rewritten. Also, the spec has no "approve" control. Only FX (deny) is defined, so approval needs a new mapping, such as SAVE in context or a free button.
6. **Spec UX timing must be built in the app.** Double press and long press for keys (spec section 7 "Sessions") have no HAL support. `fm1_input_note_edges()` returns 0 in host mode (`host.c:72`), so the host harness cannot test key edges without a patch. That blocks Layer 5 verification of the press semantics.
7. **Readiness-gate fields.** Spec section 12 requires toolchain/SDK versions, commit, identity, size and SHA-256 to be recorded. The report has the inputs (toolchain `20260730.1`, SDK V1.2.1 `d179b44`), but no script yet produces `reports/firmware-validation.md`. This is an implementation task, not a discovery gap.
8. **Disconnect detection.** The documented app API has no USB-connected flag. But the build is a unity build (`dinghy.c:20` includes `platform.c`, which includes `usb.c` at `platform.c:117`), so the app can read `usb.config`, which is set at `usb.c:554` and gates output at `:166`. That flag shows only cable/enumeration state. It cannot tell whether the companion is alive. Host-loss detection must still use heartbeat timeouts (Agent Deck heartbeat is 1000 ms, `AD/PROTOCOL.md:45`). Define the device-side timeout and the "disconnected" LED/LCD state.
