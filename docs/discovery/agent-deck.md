# Discovery: FM-1 Agent Deck (kevinelliott/fm-1-agent-deck)

Scope: spec sections 2 (repository assessment), 7 (firmware UX) and 9 (device protocol).
Date: 2026-11-17. Method: read-only code reading of a shallow clone, `gh` queries, and a read-only comparison with the local Dinghy checkout.

- Clone: `/Users/dominikj/dev/personal/.fm1-upstream/fm-1-agent-deck` at `c107d203a8da47a10618397bc6d461bf805b3982` (2026-11-13).
- Emulator clone: `/Users/dominikj/dev/personal/.fm1-upstream/fm1-emu` at `2ed986561c6f26596d37fd306fac0e7558a41356` (2026-11-16).
- All `file:line` references below are relative to the agent-deck clone unless they name another path.

> **Not executed.** I tried to run `python3 host/test_daemon.py` and `sh tools/host_test.sh`, but the session permission classifier denied it. I did not download or run the fm1-emu binary. Every statement about test results comes from logs that are committed in the repo, from the README, or from CI config. Nothing here was re-verified by running it.

---

## 1. Summary

| Question | Answer |
|---|---|
| License | GPL-3.0 (root `LICENSE`; `pyproject.toml:18` `GPL-3.0-only`; `firmware/agtdeck.c:1` SPDX `GPL-3.0-only`). The vendored Dinghy tree is GPL-3.0-only, with a per-file authorship table in `firmware-build/LICENSING.md`. The Dinghy logo is **not** GPL (all rights reserved). The vendored fm1-emu web player (`docs/play/`) is MIT. |
| Firmware base | **Dinghy-derived, Dinghy 0.5** (Felucca → SLOOP → OberVave → Dinghy lineage). `firmware-build/` is a full vendored copy of the Dinghy tree. The app is one file, `firmware/agtdeck.c` (1015 lines). CI copies it over `firmware-build/firmware/src/dinghy.c` and checks that the two files match (`.github/workflows/test.yml`, step "The two copies…"). |
| Host language | **Python 3.8+**, a single 3500-line module `host/agtdeck.py`. It uses only the standard library, plus `mido` + `python-rtmidi` for real MIDI (`pyproject.toml:21`). There is **no Node/TS host code**. The only JS in the repo is browser code: the vendored fm1-emu player and a config editor (`docs/editor/`). |
| Transport | USB-MIDI class-compliant, **channel 16**, **no SysEx**. Device→host uses Note/CC messages. Host→device uses a framed byte stream packed into CC 118 (control) and CC 119 (data). |
| Protocol version | v6 (`firmware/agtdeck.c:119`, `host/agtdeck.py:104`). Daemon 0.7; firmware 0.7 (`dist/agtdeck-0.7.fwsc`). |
| Emulator | **fm1-emu** by Joakim Eriksson (MIT), <https://github.com/joakimeriksson/fm1-emu>. It emulates the JieLi AC791N chip and runs the shipped `.fwsc` unchanged. The batch runner `fm1-emu` takes `--fwsc --ms --keys --snap` and writes LCD snapshots. `fm1-live --usb` shows the emulated device to macOS as a real CoreMIDI device. |
| Hardware evidence | The author says firmware 0.6.2 runs on his FM-1 (UC25HQ80 flash) against live Herdr (README:75-90). 0.7 has run only in the emulator (README:80-84). No footage. No Firmware Hub listing. |
| Issues/PRs | 0 issues. 1 open PR (ImgBot). 5 stars, 0 forks. Created 2026-11-08, last push 2026-11-14. Bus factor: one author, one week of history. |
| Option A feasibility | **Feasible for the host side. Firmware changes are needed for full spec UX.** Details in section 9. |

---

## 2. Repository structure

```
firmware/agtdeck.c            the whole device app (Dinghy app slot), 1015 lines
firmware/host-test.log        committed output of the Dinghy host harness run
firmware-build/               vendored Dinghy 0.5 tree (platform, HAL, loader, OTA, tools, tests)
  firmware/src/platform.c     platform: boot, USB, MIDI ring, OTA, audio ISR, storage
  firmware/src/usb.c          USB stack; only change vs Dinghy: USB product string "FM-1 AGTDECK"
  tools/build.py              package identity FM-1_2435N, loader screen "AGTDECK"
  tools/fm1_install.py        OTA installer (SysEx M-UPGRADE protocol)
  tests/host.c                host harness: runs the app on a PC, scripted input -> PPM screens + WAV
  tests/agtdeck.txt           generated scripted session (tools/gen_host_test.py)
host/agtdeck.py               daemon: links, backends (tmux, Herdr), Daemon, CLI, doctor, service
host/test_daemon.py           unittest suite with FakeBackend + RecLink (541 lines)
host/test_simulate.sh         tmux self-test; logs committed (simulate-test.log, herdr-test.log)
tools/emu_test.py             test of the packaged .fwsc in fm1-emu
tools/emu_shots.py            README screenshots + intro.gif from fm1-emu
tools/get_emu.sh              downloads the fm1-emu release binary (default v0.4.0)
tools/host_test.sh            builds the firmware for the host and runs the scripted session
dist/*.fwsc                   every release package, 0.1 … 0.7
docs/play/                    vendored fm1-emu web player (wasm) with Agent Deck as its only firmware
docs/editor/                  browser config editor
PROTOCOL.md                   wire protocol v6
Dockerfile, pyproject.toml, fmhub.json
.github/workflows/test.yml    daemon unit tests, pyflakes, copy check, host harness
.github/workflows/release.yml tag v* -> zvenson/fm1-build shared workflow: build, sign, attest, release
```

Comparison with the user's Dinghy checkout `/Users/dominikj/dev/personal/fm1` (read-only; HEAD `22acb91`, 2026-10-23, Dinghy "Status: 0.4"):
- `platform.c` and `ota.c` are identical.
- `fm1_flash_map.h` differs only in the 0.5 change that accepts flash JEDEC `0xB36014` (UC25HQ80).
- `usb.c` differs only in the USB product string (agent-deck `firmware-build/firmware/src/usb.c:276-277`).
- Conclusion: the platform layer is effectively upstream Dinghy 0.5. Agent Deck did not fork the low-level code.

---

## 3. Device ↔ host protocol (exact)

Source of truth: `PROTOCOL.md`, `firmware/agtdeck.c:118-317`, `host/agtdeck.py:104-160, 323-391, 2983-3014`.

### 3.1 Transport and why SysEx is not used
- The platform owns SysEx for the OTA updater. `usb.c:737-742` routes every SysEx packet (CIN 4–7) to `sysex_byte()`, never to the app ring. `midi_get()` (`platform.c:294-305`) returns only channel messages and clock/transport. SysEx host→device would therefore need changes to the platform USB stack, which puts the updater at risk (`PROTOCOL.md:18-29`).
- Only channel-16 CCs are read: `firmware/agtdeck.c:309` drops anything that is not `0xBF`.
- USB input ring: `MQ = 64` USB-MIDI events (`usb.c:161`). Back-pressure: `ep1_take` NAKs the EP1 OUT packet while fewer than 24 slots are free (`usb.c:770-786`). Over USB a burst waits in the host until the ring has room. Over the TRS path (used by the emulator tests) data can be lost when the ring is full (`usb.c:750-761`).
- The device polls USB at 2 kHz (timer comment, `platform.c` timer ISR). The ring is drained in the main loop and during LCD DMA (`LCD_IDLE app_idle`, `firmware/agtdeck.c:44-46, 319-323`).

### 3.2 Device → host (all channel 16)
| Message | Meaning | Evidence |
|---|---|---|
| Note On `9F`, note 48+k (k 0–26), vel 127 | key press; also moves the device's selection unless a button is held (chord) | `agtdeck.c:910-918` |
| Note Off `8F` | key release | same |
| CC 102+id, 127/0 | button down/up, id = `BTN_*` (0 OCT− … 13 REC) | `agtdeck.c:921-925`; enum `platform.c:41-42` |
| CC 85–91, relative (64±n) | encoders SELECT, ALGORITHM, K1–K4, PRESETS. SELECT is sent only on MENU; elsewhere it moves the cursor locally | `agtdeck.c:946-963` |
| CC 7 | MASTER pot 0–127, on change ≥2 | `agtdeck.c:965-981` |
| CC 116 = proto | heartbeat every 1000 ms | `agtdeck.c:891-894` |
| CC 117 = proto | hello, once at boot | `agtdeck.c:886-889` |
| CC 120 = slot | selection changed (also in answer to HELLO_ACK) | `agtdeck.c:845-853, 895-898` |
| CC 121 = page | page changed (also in answer to HELLO_ACK) | `agtdeck.c:835-843, 899-902` |

### 3.3 Host → device: CC frame stream
- CC 118 control: `0x10|type` starts a frame (and aborts a partial one); `0x20` ends and commits; `0x7F` resets (clears all slots, names, detail, menu, LEDs) (`agtdeck.c:310-313`, `slots_clear` `:202-223`).
- CC 119 data: one 7-bit payload byte (`agtdeck.c:314-316`).
- Max frame: the host truncates to `MAX_FRAME = 48` (`host/agtdeck.py:382-387`). The device buffer is 64 bytes (`agtdeck.c:200`) and **silently truncates** at 64 (`agtdeck.c:315`). `PROTOCOL.md:101` says "the receiver drops longer frames", which does not match the code.
- No checksum, length field, sequence number, request id or acknowledgement. The host sends frames back-to-back with no pacing (`host/agtdeck.py:382-387`) and relies on USB NAK back-pressure.
- Frame types (`agtdeck.c:132-143`, `rx_commit` `:236-301`):

| Type | Name | Payload |
|---|---|---|
| 0x01 | SLOT | `[slot 0-53, state 0-6, kind(low 3 bits) + flags AUTO 0x40, LOOP 0x20, MARK 0x10, QUEUE 0x08, name…]`; 12 chars shown |
| 0x02 | DETAIL | `[line 0-7, text ≤29]` |
| 0x03 | META | `[agents, blocked, view?]` |
| 0x04 | FOOTER | `[style 0-4, text ≤29]` |
| 0x05 | BEEP | `[sound 1-9, gain?]` |
| 0x06 | SELECT | `[slot]` (no echo) |
| 0x07 | TEXT | `[line 0-9, style, text]`: MENU lines 0-7, ABOUT lines 8-9 |
| 0x08 | PAGE | `[page 0-4]` (no echo) |
| 0x09 | KEYLEDS | `[mode×27]`, used only while a button is held |
| 0x0A | BTNLEDS | `[mode×14]`: 0 device, 1 off, 2 on, 3 blink, 4 glow |
| 0x0B | GAUGE | `[slot, pct or 127]` |
| 0x0F | HELLO_ACK | `[proto]` |

- **Free type values: only 0x00, 0x0C, 0x0D, 0x0E.** The type field is 4 bits (`(d2 & 0xF0) == 0x10`, `agtdeck.c:313`). Control values 0x30–0x7E are unused and could start a second frame family. This is a hard limit on extending the protocol.
- State enum: EMPTY, IDLE, WORKING, BLOCKED, DONE, ERROR, UNKNOWN. The device clamps an unknown state to UNKNOWN (`agtdeck.c:243`). Kind codes 0–6; code 7 is free (`agtdeck.c:249`).
- Unknown frame types are ignored, but they still count as host activity (`host_seen=1`, `ui_dirty=1` at the top of `rx_commit`).

### 3.4 Versioning, liveness and resync
- One version byte in hello, heartbeat and HELLO_ACK. Each version is a superset of the one before. The host clamps `dev_proto` and withholds flags and frames an older device would misread (`host/agtdeck.py:2983-3005`, `poll_once` `:1700-1712`). There is no capability bitmap.
- Device liveness: the device shows NO HOST 25 s after the last frame (`agtdeck.c:157, 903`). The host does a full re-send every 10 s (`host/agtdeck.py:1663`).
- **On host loss, the slot LEDs keep showing the last states.** `leds()` (`agtdeck.c:810-833`) never reads `host_seen`; only the header and screen change (`:471, 490`). The spec's "Disconnected: global connection indicator" needs a firmware change.
- Host liveness: the host never watches heartbeats for timeouts. It detects unplug only by checking every 2 s whether the port is still present (`watch_link`, `host/agtdeck.py:3340-3362`). Hello or replug triggers `full_resync` (`:2968-2981`): HELLO_ACK, then RESET and a full re-send on the next poll.
- Command semantics: device events are fire-and-forget edges. The host acts on a button release, or on press for old firmware (`on_button` `:2857`). The result is reported only as a FOOTER toast plus a BEEP. There is no command id and no ack. The device does not queue events while the host is away, so a reconnect cannot cause duplicate execution, but events sent during a disconnect are lost.
- Throughput: a frame of N bytes costs N+2 CC events (4 bytes each on USB). LCD redraw is the real bottleneck (`PROTOCOL.md:31-33`). The host refreshes about every 1 s plus on events.

---

## 4. Device UI, LEDs, buttons

- Pages (`agtdeck.c:152-157`, `draw_content` `:726-785`): GRID (8-row list, or "boxes" tiles when HOME is pressed again), DETAIL (6 lines + status + gauge), APPROVALS (shown as "WAITING"; the GRID filtered to BLOCKED), MENU (8 host TEXT lines, fully host-defined), ABOUT. There is also a splash screen and a NO HOST state.
- Device-local behaviour (`agtdeck.c:926-963`): HOME→GRID (again: boxes toggle), GLO→APPROVALS, EDIT→DETAIL, ALGORITHM cycles pages, SELECT moves the cursor over occupied slots, OCT± moves between 2 key-pages (54 slots). Selection, page and box mode are saved to flash, with the write delayed by 2 s (`:1005-1009`).
- Key LEDs (`led_mode` `:797-808`): EMPTY off; IDLE glow; WORKING on; BLOCKED 2 Hz blink; DONE on for 2 s, then glow; ERROR about 6 Hz; UNKNOWN 1 Hz glow pulse. The selected key is forced on in the alternate 500 ms phase. Hardware has per-key on and glow only, no RGB (`fm1_led_key`, `fm1_led_key_glow`).
- Button LEDs (`:826-832`): PLAY on while WORKING, REC blinks while BLOCKED, ARP auto, HOME/EDIT/GLO show the page. The host can override any button LED with BTNLEDS.
- Buttons (FM-1, `platform.c:41-43`): OCT−0, OCT+1, FX2, SEL3, ENV4, LFO5, EDIT6, GLO7, HOME8, SAVE9, ARP10, SEQ11, PLAY12, REC13. Encoders: SELECT, ALGORITHM, K1–K4, PRESETS. MASTER is an ADC pot. **K1–K4 are encoders.** The spec's "K1–K4 contextual controls" must be turn gestures.
- Current daemon mapping (`_press` `host/agtdeck.py:2894-2932`, `on_encoder` `:2934-2966`): PLAY start/continue, REC approve, SAVE approve-always, FX deny (Esc), ENV interrupt (Ctrl-C), SEL Enter, LFO Shift+Tab, SEQ send preset, ARP auto-approve, GLO-held fleet actions, plus many chords (`PROTOCOL.md:49-90`).
- Sound: BEEP triangle chimes through the DAC (`agtdeck.c:48-116`). There is **no audio input**. Voice must be captured on the Mac.

---

## 5. Host daemon architecture

- Links: `MidiLink` (mido; port matched on "AGTDECK", "FM-1", … `:346-358`), `NullLink` (unplugged), `SimulateLink` (prints frames).
- Backend contract (duck-typed, comment at `host/agtdeck.py:466-479`): `list_agents() -> [{id,name,kind,state,cwd}]`, `read_lines(id,n)`, `act(id, action∈{start,approve,deny,interrupt,prompt}, arg, kind)`, `send_keys(id, keys)`, `spawn(cmd,cwd,label)`, `focus(id)`, `close(id)`, optional `dirty()`.
  - `TmuxBackend` (`:483-666`): scrapes the screen with regexes, and approves by sending keystrokes.
  - `HerdrBackend` (`:668-924`): a newline-JSON socket with `pane.list`, `workspace.list`, `pane.read`, `pane.send_keys`, `agent.prompt`, `agent.start`, `workspace.create`, `pane.focus`, `pane.close`, plus a subscribe thread. Approve, deny and interrupt are **keystrokes** (`APPROVE_KEYS` `:677-680`, `act` `:856-902`).
- `Daemon` (`:1320-3014`) is a monolith. It holds the roster, stable slot assignment saved in `~/.config/agtdeck/slots.json` (`_assign_slots` `:1588-1628`, `SLOTS_FILE` `:1304`), diff-and-send (`poll_once` `:1642-1737`), the prompt queue and pipelines, auto-approve with never/only regexes, notifications, context gauges, host-drawn menus, and the chord engine. It also reads Claude Code session logs (`claude_insight` `:980`) to fix up states. Dependency: Claude transcript JSONL under `~/.claude/projects`.
- Operations: `--doctor`, `--install-service` (launchd on macOS), auto-reconnect, `--simulate` with a stdin command language that replays exact panel events (`handle_command` `:3016-3135`).
- macOS MIDI: **mido + python-rtmidi (RtMidi → CoreMIDI)**. A Node/TS port would need its own CoreMIDI binding; nothing in this repo provides one, so the choice is open (see section 10).

---

## 6. Emulator (fm1-emu)

- Repo: <https://github.com/joakimeriksson/fm1-emu>, MIT. Rust workspace with crates `fm1-core, fm1-soc, fm1-isa, fm1-emu, fm1-live, fm1-web, fm1-plugin, fm1-gdbstub`. Latest release v0.5.1 (2026-11-14), with a `macos-arm64` asset (this Mac is arm64). `tools/get_emu.sh` defaults to **v0.4.0** (`FM1_EMU_VERSION` overrides it). Building from source needs `cargo`, which is not installed here.
- `fm1-emu` batch runner flags (from `crates/fm1-emu/src/main.rs`): `--fwsc --ms --keys --snap --wav --flash --flash-chip --trace --break-pc --dump --quiet …`. The `--keys` script format used by agent-deck is `ms:midi:bfCCVV` (MIDI into the TRS jack) and `ms:ALGO:+1`, `ms:HOME` (panel) (`tools/emu_test.py:113-126`).
- **It runs the real `.fwsc` and captures screenshots.** `emu_test.py` boots the newest `dist/agtdeck-*.fwsc`, injects a full-resync frame stream at 3 ms per CC, walks all pages, and snapshots the LCD to PNG (`tools/emu_test.py:1-40, 123-128`). `emu_shots.py` produces `docs/shot-*.png` and `docs/intro.gif`. The README says it takes "a couple of minutes of CPU" per scene on Apple Silicon (README:801-805).
- **`fm1-live --usb`** (fm1-emu README; `crates/fm1-live/src/main.rs:216`) enumerates the emulated USB controller, so the firmware appears on macOS as the MIDI device "<product> (emu)". The unmodified daemon (or our companion) could then talk to the emulated FM-1 over real CoreMIDI. Headless: `--shot` with `FM1_USB_SEND='MS:HEX;…'`. This is the best path to a full-loop "Layer 6" test. Not verified here; it is unclear whether v0.4.0 already has `--usb`.
- Upstream also offers `FM1_STRICT=1` (cycle-accurate LCD timing) and `--flash-chip uc25hq80`.
- Firmware host harness (Dinghy): `tools/host_test.sh` compiles `dinghy.c` natively with `-DDINGHY_HOST` and runs `tests/agtdeck.txt` (lines like `1020 midi 191 118 127`). It fails unless at least 8 screens (PPM) are rendered and the session ends with a WAV. On macOS it needs `-Dsection(x)=`. The committed log `firmware/host-test.log` ends with `sound -> build/host/agtdeck.wav`.

## 7. Test harness and evidence
- `host/test_daemon.py`: classes Roster, Panel, Prompts, AutoApprove, LogStates, Menu, Link (resync, link swap), Insight, Helpers, Editor, Doctor. Uses `FakeBackend` (`:23`) and `RecLink` (`:56`). This is a good template for our adapter contract tests.
- CI (`test.yml`): unit tests, pyflakes, the source copy check, and the host harness on ubuntu-24.04. The release workflow runs the same tests before the signed build (`release.yml`).
- Committed logs: `host/simulate-test.log` (tmux self-test: discovery, BLOCKED detection), `host/herdr-test.log`, `firmware/host-test.log`.
- Hardware: 0.6.2 is on the author's unit, driven against live Herdr (README:75-80). README:86-90 says the prompt queue, pipelines and auto-approve were tested only against a stub backend. The Linux container with a real FM-1 has never been run (README:694-697). Build budget at 0.7: image 65,296 B of 581,564 B; RAM 18,432 B of 98,304 B (README:797-800). There is plenty of headroom for new views.

## 8. Release artifacts
- GitHub releases v0.3 … v0.7. v0.7 assets: `agtdeck-0.7.fwsc`, `SHA256SUMS`. Packages are built and signed through `zvenson/fm1-build/.github/workflows/build.yml@v1`, with an attestation (`release.yml`).
- Package identity `FM-1_2435N` (`firmware-build/tools/build.py:58`). USB name `FM-1 AGTDECK`. `STORE_MAGIC 0x4147444B` (`firmware-build/firmware/src/store.h:21`). A fork must pick its own identity, USB name, store magic and logo.
- Installation: `firmware-build/tools/fm1_install.py` (OTA SysEx), the web installers, or the Firmware Hub. Recovery: hold OCT− at power-on (Dinghy rescue). The firmware falls back to the updater after two boot crashes.

---

## 9. Option A (fork and extend) feasibility

**Verdict: viable, with clear limits.** The firmware is a deliberately dumb panel that forwards every control, so most spec behaviour can live in the host. Firmware work is moderate and stays inside one app file. It never touches the updater, USB or loader.

### Host-only (no firmware change)
- **Traycer backend.** Implement the backend contract: `list_agents` maps Traycer sessions to `{id,name,kind,state}`; `act` covers prompt, interrupt, approve and deny through Traycer APIs. The current Herdr/tmux `act` sends **keystrokes**; Traycer needs structured calls. The contract also needs new verbs: focus session, tasks/workstreams, inbox items, and message-vs-prompt delivery (spec 5.2).
- **Kind codes.** claude=1 and codex=2 already exist.
- **Remap buttons to the spec table** in `_press` / `on_encoder`: REC=PTT, SAVE=submit, PLAY=start/resume, FX=cancel/deny, ENV=interrupt. Override conflicting device LED defaults with BTNLEDS (REC currently blinks on BLOCKED).
- **Double press and long press** detection on keys: note on/off edges already reach the host.
- **Tasks view and Inbox view (MVP).** Two routes: (a) render them on the host-drawn MENU page (title + 7 rows, TEXT frames), or (b) repurpose GRID slots, which only mean "whatever the host says".
- **More than 54 sessions.** Host-side windowing.
- **Voice composer status.** FOOTER and TEXT can show it in an MVP.

### Firmware changes (inside `firmware/agtdeck.c` only)
- **ALGORITHM** cycles pages locally (`agtdeck.c:961`). The spec wants project selection, so that local action must go or become host-owned.
- **HOME/EDIT/GLO** jump to GRID/DETAIL/APPROVALS locally (`:926-935`). The spec wants Sessions/Tasks/Inbox. Rename or extend the pages (`NPAGES`, `PAGE_NAME` `:456`).
- **New frames for SET_VOICE_STATE, SET_ATTENTION/inbox items, COMMAND_RESULT with request ids, SET_WORKSPACE/project.** Only 3–4 type values are free. Use one as an "extended frame" (type 0x0E + subtype byte), or use control values 0x30+. Bump `PROTO_VER` to 7. Keep supersets so the old daemon still works.
- **LEDs:** "completed unread" pulse (DONE currently goes to glow after 2 s); a global disconnected indication (LEDs ignore `host_seen`); priority rules when states overlap.
- **Acks and sequence ids** (spec 9). Today nothing carries an id. Proposal: give device→host actions a request id and add a host→device COMMAND_RESULT frame. Or keep the device dumb and do idempotency in the host (no replay exists, so there is no duplicate risk).
- Fix the doc/code mismatch on oversize frames: make the device drop an oversize frame, or correct the doc.

### Risk
- Updater and recovery risk is low if we change only the app file. SysEx stays with the platform, and Dinghy's build checks fail on code that could brick the unit.
- Main risks:
  1. A young single-author upstream, so expect churn and possible future protocol changes.
  2. The Python monolith is coupled to terminal multiplexers.
  3. No CRC or ack on the wire.

### Reuse recommendation
- Keep `firmware/agtdeck.c` + `firmware-build/` + `PROTOCOL.md` + the fm1-emu tooling as the base. Keep upstream files distinguishable, as GPL requires.
- If the companion is Node/TS (spec section 3B), port `MidiLink.frame`, the diff-and-send `poll_once` logic and the slot assignment. They are small and well specified. Treat `test_daemon.py` and `emu_test.py` frame streams as golden fixtures.
- Or keep the Python daemon as the device driver and put a Traycer adapter behind its backend interface. Either way, the CC-frame codec should be one shared, tested module.

---

## 10. Open questions
1. Companion language: Python (reuse the daemon) or Node/TS (rewrite about 400 lines of link and diff logic)? For Node on macOS, the candidates are RtMidi bindings such as `@julusian/midi` or `midi` (node-midi). I did not evaluate them here.
2. Do we accept protocol v7 with an extended-frame scheme, given the 4-bit type limit? Should a COMMAND_RESULT/request-id layer go on the device or stay host-only?
3. Should the Inbox and Tasks views be real firmware pages, or MENU/GRID repurposing for the MVP?
4. Does fm1-emu v0.4.0 (the get_emu.sh default) support `fm1-live --usb`, or do we pin v0.5.1? Is a headless `--shot` + `FM1_USB_SEND` round-trip good enough for CI on macOS?
5. Fork identity: new package id, USB name, STORE_MAGIC and logo, needed to coexist with Agent Deck on the Firmware Hub and in installers.
6. Does the user's FM-1 have the UC25HQ80 or the Puya flash? Dinghy 0.5 handles both. The user's local Dinghy checkout is 0.4, which accepts only Puya.
7. Upstream relationship: contribute a backend plugin interface upstream, or hard-fork?
8. The test suite and host harness were not run in this session because permission was denied. They should be run once permission is given.

---

## Reviewer verification

Reviewer: skeptical second pass, 2026-11-17. Method: re-read the cited code in the same clones (agent-deck at `c107d203`, fm1-emu at `2ed98656`), read-only `diff` against `/Users/dominikj/dev/personal/fm1` (HEAD `22acb91`, working tree), `strings` on the local fm1-emu 0.5.1 binary. I did not run any binary or test.

### Checked claims

| # | Claim | Verdict | Evidence / correction |
|---|---|---|---|
| 1 | Frame codec: CC 118 control (`0x10\|type` start, `0x20` end, `0x7F` reset), CC 119 data, only ch-16 CCs read, 4-bit type field, PROTO_VER 6 | **CONFIRMED** | `firmware/agtdeck.c:119-145` (constants), `:303-317` (`midi_in`). Types 0x01-0x0B and 0x0F are defined; 0x00, 0x0C, 0x0D, 0x0E are free. `host/agtdeck.py:125` `MAX_FRAME = 48`; `:382-383` truncates. |
| 2 | Device truncates frames over 64 bytes, while `PROTOCOL.md` says it drops them | **CONFIRMED** | `agtdeck.c:200` `rx_buf[64]`; `:315` `if (rx_len < sizeof rx_buf) rx_buf[rx_len++] = d2;` keeps the first 64 bytes and commits them. `PROTOCOL.md:100-101` says "the receiver drops longer frames". |
| 3 | On host loss, key LEDs keep the last states; only header/screen react | **CONFIRMED, plus more** | `leds()` `agtdeck.c:810-833` never reads `host_seen` (its only uses are `:190, 238, 471, 490, 708, 737, 764, 903, 992, 998`). **Also:** BTNLEDS overrides (`bled[]`) also persist after host loss, because only RESET (`slots_clear`, `:217`) clears them. A host that takes over button LEDs leaves them in a stale state when it dies. |
| 4 | HOME/EDIT/GLO and ALGORITHM change pages on the device; SELECT moves the cursor locally except on MENU | **CONFIRMED** | `agtdeck.c:926-935` (HOME toggles boxes, GLO→APPROVALS, EDIT→DETAIL); `:960-961` ALGORITHM `page_set(...)` after the CC goes out; `:955-958` SELECT. A key press also calls `sel_set` locally unless a button is held (`:913-916`). There is no host frame that disables these local actions. The host could fight back with PAGE frames, but that makes the screen flash. |
| 5 | Platform layer equals Dinghy; only the USB name and the UC25HQ80 JEDEC id differ | **CONFIRMED (path correction)** | `platform.c` and `ota.c` are identical. `usb.c:276-277` differs only in the product string. The user's checkout says `"Felucca"`, so their current Dinghy build enumerates as "Felucca", not "Dinghy". The flash header is at `firmware-build/firmware/hal/fm1_flash_map.h:20-22`, **not** `src/`. The comment there says a unit with the unsupported chip "saves to RAM only". It does not brick, but persistence is lost. |
| 6 | `fm1-live --usb` makes the emulated FM-1 appear as a real CoreMIDI device | **CONFIRMED with a nuance** | `fm1-emu/crates/fm1-live/src/main.rs:1137-1182`: it is a **midir virtual port** (`create_virtual`) named `"<product> (emu)"`, i.e. `"FM-1 AGTDECK (emu)"`, not a USB device in IORegistry. The daemon's substring match on "AGTDECK" (`host/agtdeck.py:346-358`) would still find it. The 0.5.1 macOS-arm64 binary is **already downloaded** at `/Users/dominikj/dev/personal/.fm1-upstream/fm1-emu-bin/fm1-emu-0.5.1-macos-arm64/`. `strings fm1-live` shows `--usb`, `FM1_USB_SEND`, `FM1_USB_TRACE`. The binary is unsigned and needs `xattr -d com.apple.quarantine` (bundled README.txt). |
| 7 | `get_emu.sh` defaults to v0.4.0 | **CONFIRMED** | `tools/get_emu.sh:6` `VER="${FM1_EMU_VERSION:-v0.4.0}"`. It is still **UNVERIFIED** whether v0.4.0 has `--usb` (the shallow clone has no tags or changelog). Pin v0.5.1. |
| 8 | Host full resync every 10 s; unplug detected only by port polling | **CONFIRMED** | `host/agtdeck.py:1670` (`> 10.0`), `:2968` `full_resync`, `:3340` `watch_link`. |
| 9 | Test results (daemon tests, host harness) | **UNVERIFIED** | I did not run them either. The claims rest on committed logs only. |

### Gaps for building the spec system

1. **MASTER → screen brightness (spec 7) is not possible as specified.** The FM-1 LCD backlight is a GPIO on/off (`firmware-build/firmware/hal/fm1_lcd_hw.h:6, 59`, PA2 active low). I found no PWM path in the HAL. The firmware comment `agtdeck.c:966-967` says the platform owns MASTER as the chime volume. At most, MASTER could control the key-LED glow and backlight layer (`fm1_input.h:108-109`, `fm1_led_bg_ns`), or the backlight could switch on/off. Decide this, or drop it from the spec.
2. **Pre-flash checks (spec 12) are not covered by the repo's tooling.** `firmware-build/tools/` has only `build.py, fm1_install.py, fm1pkg_make.py, get_toolchain.sh, lz4blk.py`. `fm1_install.py` reads the identity and installs. It has no full-flash backup or second-read hash compare, and no JEDEC readout. Steps 3, 9 and 10 of the spec need other tooling (the `MvaveFM1Unbricker` and `probe` clones in `.fm1-upstream/` were not assessed in this report).
3. **No firmware-side way to suppress local page and selection actions.** Option A needs a "host-owned navigation" flag, for example a HELLO_ACK flag byte or a new frame, so HOME/EDIT/GLO/ALGORITHM become pure events. This belongs on the v7 list.
4. **Spec 9 "explicit command acknowledgement / no duplicate execution".** The report notes that no ids exist. CC values are 7-bit, so any request id on device→host must be a separate CC (for example a reserved CC carrying a rolling 0-127 id) sent before the button CC. No design is proposed yet.
5. **Emulator MIDI loop risk.** By default `fm1-live` routes "every MIDI input of the computer" into the emulated TRS jack (bundled README.txt; `--midi all` default, `main.rs:212`). With `--usb`, it is untested whether the companion's output to the virtual port also echoes back into the TRS path. Run Layer 6 with `--midi none`.
6. **Disconnected-state LED priority rules (spec 7 LEDs)** need a defined table. Today, BLOCKED, DONE, ERROR and selected share a single per-key on/glow pair (`led_mode` `:796-807`). With only two intensities, "completed unread pulse" versus "UNKNOWN 1 Hz glow pulse" will be hard to tell apart. This is a UX decision, not only a code change.
7. **Not assessed:** the spec's Display list item "contextual control labels" against the 240x240 layout budget (`DETAIL_SHOWN 6`, `FOOTER_CHARS 29`, `agtdeck.c:147-150`). Also not assessed: whether the spec's SET_WORKSPACE (project name) fits in the existing header.
