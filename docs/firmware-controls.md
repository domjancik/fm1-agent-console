# FM1 CONSOLE controls

Every physical control, its Dinghy HAL id, the protocol frame the firmware sends (`docs/protocol.md`), and what the
companion makes of it (spec section 7). The firmware only reports facts. Every meaning in the last column is the
companion's decision for the current view, and the device changes nothing until a `SET_*` or `COMMAND_RESULT`
says so.

The companion column follows the UX v2 control map (`docs/ux-v2.md` §2.3): **knobs (KNOB1–4) only change a setting,
never act; buttons act**, and the hint bar on line 4 names the buttons that do something for the selected item now.
Physically, KNOB1–KNOB4 are the encoder row at the top right of the panel (not under the screen); with version 2 the
legend cell above each label names its knob.

HAL ids are from `firmware/firmware/src/platform.c:41-44` (FM-1 build). The protocol's button and encoder ids are
the same numbers, which `console.c` checks with `_Static_assert`. The fm1-emu names are the ones its
`--keys` / `FM1_BENCH_KEYS` scripts use.

## Keys

| Control | HAL | Frame | Device side | Companion (sessions / tasks / inbox) |
| --- | --- | --- | --- | --- |
| 27 note keys F3..G5 | `fm1_in.notes` bit k, LED `KEY_LED(k)` = 14 + k; fm1-emu `nK` | `KEY key=k` with gesture `down` / `up` at once, then `single`, `double` or `long` | Gestures are timed in the app (`fm1c_input.h`). **long**: held ≥ 600 ms, sent while held, and its release sends `up` only. **double**: second down within 300 ms of the first up, sent after the second up, with no `single`. **single**: sent when the 300 ms window closes. A tap shorter than one main-loop pass still counts (`fm1_input_note_edges`). | single: select (Sessions, TO DO) or open the task (Tasks). double: open it on the Mac. long: pin / unpin (Sessions, TO DO). The raw `down`/`up` are there for anything else. |

## Buttons

Each button sends `BUTTON button=<id> edge=down`, then `edge=up`. If both edges fall in one pass, they are sent in
the order they happened.

| Control | HAL id | fm1-emu | Companion (spec section 7) | Button LED (device side, section 6) |
| --- | --- | --- | --- | --- |
| OCT− | `BTN_OCT_DOWN` 0 | `OCTDN` | Previous page. **Held at power-on, the platform starts the USB rescue before the app runs.** | off |
| OCT+ | `BTN_OCT_UP` 1 | `OCTUP` | Next page | Slow blink (500 / 500 ms) when there is no host, otherwise off |
| FX | `BTN_FX` 2 | `FX` | Deny (→ confirm) when an approval is pending; dismiss in TO DO; cancel in voice; "no" in confirm | off. v2: glows in confirm, in voice recording / transcribing / reviewing / failed / target unavailable, with an approval (Sessions, DETAILS) and with an item selected (TO DO) |
| SCL | `BTN_SEL` 3 | `SCL` | Ignored by the companion. **Device side (version 2): held ≥ 400 ms shows the help overlay** (below). Its own down/up are always sent. | off |
| ENV | `BTN_ENV` 4 | `ENV` | Stop the agent (→ confirm), if working / waiting / approval | off. v2: glows when the shown chat is working / waiting / approval (Sessions, TO DO, DETAILS) |
| LFO | `BTN_LFO` 5 | `LFO` | Version 3 only (`docs/ux-v2.md` §7.3): open the DETAILS page for the selected chat (Sessions, TO DO); in DETAILS: close it, back to the view it was opened from. Unused with version 1 or 2. | Full while the view is DETAILS (view 5), else off. v2: glows in SETTINGS (view 6) |
| EDIT | `BTN_EDIT` 6 | `EDIT` | Tasks view; pressed in Tasks: re-sort | Full in the tasks view |
| GLO | `BTN_GLO` 7 | `GLO` | TO DO view; pressed in TO DO: re-sort | Full in the TO DO (inbox) view. Elsewhere it blinks (500 / 500 ms) while `attention_count` > 0. |
| HOME | `BTN_HOME` 8 | `HOME` | Sessions view; pressed in Sessions: re-sort | Full in the sessions view. v2: glows in DETAILS and SETTINGS (close) |
| SAVE | `BTN_SAVE` 9 | `SAVE` | Approve (→ confirm) when an approval is pending; send the reviewed prompt; "yes" in confirm | Full while the voice state is reviewing. v2: double blink while a send or approval awaits SAVE; glows in SETTINGS |
| ARP | `BTN_ARP` 10 | `ARP` | Hold 1 s: SETTINGS (version 6); tap on a voice review: save as canned | off. v2: full in SETTINGS; glows on a voice review |
| SEQ | `BTN_SEQ` 11 | `SEQ` | version 5: Buddy ↔ List in Sessions and TO DO (the companion toggles); before: unused | full while the list shows (version 5), else off |
| PLAY | `BTN_PLAY` 12 | `PLAY` | Open on Mac (Sessions, TO DO); new chat in the task (Tasks, → confirm); retry after a failed send (voice) | off. v2: glows with a chat (Sessions, TO DO, DETAILS) or task (Tasks) selected, and on a failed send |
| REC | `BTN_REC` 13 | `REC` | Push to talk to the KNOB4 TALK target: `down` starts recording, `up` stops it | Full while recording, blinks (250 / 250 ms) while transcribing |

v2 (version 5+, `docs/ui-v3.md` §9.9 "active controls"): a button the companion acts on in the shown view glows dim
steady unless its own pattern is in force; FX, ENV, PLAY, SCL and OCT− may have no physical LED, the firmware drives them
anyway.

The firmware sends the same fact in every view (LFO included: its edges go out as any button's, and the host decides
whether DETAILS opens), and the screen shows what it will do: the hint bar (`SAVE approve
FX deny`, `REC reply  PLAY open`, ...) and `SAVE yes   FX no` in the confirm view.

## DETAILS page (version 3)

The firmware adds no control logic for DETAILS: it draws view 5 and the `SET_TEXT` rows when the host says so. In
DETAILS the companion reads the same frames as follows (`docs/ux-v2.md` §7.3): PRESETS turn and OCT−/OCT+ page
through the details (clamped); SELECT and ALGORITHM move the selection and DETAILS follows it from page 1; a key tap
shows that chat; LFO or HOME closes DETAILS; EDIT / GLO close it and go to Tasks / TO DO; SAVE, FX, ENV, PLAY and REC
act on the shown chat as in the base views; KNOB1–4 do nothing (the legend is empty). SCL held shows the DETAILS help
text (`FM1C_HELP_DETAIL`).

## Version 4 (characters, `docs/ui-v3.md`)

No control changes meaning on the device, and every frame above is sent as before. What the device adds:

- **Knob row**: after it sends an `ENCODER` frame for K1–K4 (encoders 2–5) with version 4 agreed, the hint bar shows
  the four knobs for 2,000 ms (`FM1C_KNOB_MS`), the turned one lit, labelled from the `SET_LEGEND` it holds. The
  permanent 40-row legend of versions 1–3 is gone; the knobs are also listed in the help. SELECT, ALGORITHM and
  PRESETS turns do not show it. The host is not involved, and its toast still follows.
- **Help** (SCL held 400 ms): `FM1C_HELP_BASE4`, the two knob lines and who is who (the eight characters and their
  state words); DETAILS `FM1C_HELP_DETAIL4`. The rules of the overlay below are unchanged.
- The companion's version 4 map (host side, `docs/ui-v3.md` §6.3): PRESETS scrolls the bubble 5 rows at a time in the
  base views and pages DETAILS; LFO opens DETAILS with the last message first.

## Version 5 (the LIST and GROUPED layouts, `docs/ui-v3.md` §8 and §9)

- **SEQ** (button 11) goes out as a `BUTTON` frame like every button (it always did; until version 5 the companion
  ignored it). The companion decides: Sessions cycles Buddy → List → Grouped (default Grouped), TO DO toggles Buddy ↔
  List (default List), and it sends the four `SET_TEXT` groups and `SET_VIEW` with the layout byte (0, 1, 2). The device
  keeps no toggle of its own; with version 4 or lower agreed SEQ still goes out and does nothing.
- **In the lists** SELECT, ALGORITHM, OCT−/OCT+, LFO and every other control mean what the companion says, as in Buddy;
  the device only draws the highlight, the headers, the indents and the window from the slots. Folded task rows are
  never selected (the host skips them); a key tap on one, its long press (task pin) and the PINNED scope (KNOB1's fourth
  value) are host decisions too.
- **PRESETS** (version 5, a chat selected, base views): the companion opens the DETAILS reader on page 0 and turns its
  pages; LFO or HOME closes it, and the companion closes it by itself after 20 s without input (`docs/ui-v3.md` §9.8).
  The device sends the ENCODER frame as always and draws the reader open / close outlines and the page scroll.
- **Transitions** (`fm1c_trans.h`, §9.10): any key, button or encoder edge during a transition completes it at once
  (its final content drawn, nothing queued); the input itself is handled as usual.
- **LEDs**: version 5 uses LED language v2 (below). SEQ glows while a list (layout 1 or 2) is shown.
- **Help**: `FM1C_HELP_BASE5` (§9.11): `HELP - SEQ buddy/list/group`, `SELECT move  PRESETS read`, `key tap sel 2x open
  hold pin`, `LFO details  ALGORITHM next`, `SAVE approve  FX deny`, `REC hold to talk  ENV stop`, then the knob lines
  and who is who as version 4.

## Version 6 (SPLIT keys and settings, `docs/ui-v3.md` §10)

Nothing changes in what the device sends. The host resolves every new gesture from the frames it already gets:

- **Settings entry, hold ARP 1 s:** the device sends ARP down and ARP up as plain `BUTTON` edges (button 10); the host
  times the hold and opens view 6. In view 6 ARP is lit (L); HOME, EDIT, SEQ and SAVE are off.
- **Double OCT (task page):** the device sends both presses as four `BUTTON` edges (OCT- 0 / OCT+ 1, down then up), with
  no device-side gesture and no delay; the host's 300 ms window decides single (white page) or double (task page).
- **Black keys in SPLIT:** the usual `KEY` gestures (single, double, long; double = second down within 300 ms of the
  first up). The key number tells the host the role (filter or task slot).
- Help: view 6 → `FM1C_HELP_SETTINGS6` (4 lines, no knob lines, no grid); Sessions with keys 1 → `FM1C_HELP_SPLIT6`;
  other base views with version 6 → `FM1C_HELP_BASE6`; version 5 → `FM1C_HELP_BASE5`. The tables are byte-equal to
  agent-core's `HELP_TEXT.base6 / .split6 / .settings6` (`tests/console/help_equal.py`, run by `run.sh`).

## Help overlay (device side, version 2 to 5)

- **Open**: SCL held for 400 ms while version 2, 3 or 4 is agreed and the link is up (`fm1c_help_tick`, `fm1c_input.h`).
  With an old companion (version 1) SCL is an ordinary button.
- **While open**: the firmware sends no KEY, ENCODER or POT frame and no BUTTON frame other than SCL's. Those inputs
  are dropped, never queued: encoder detents are discarded, MASTER moves are absorbed (the next move after the help
  is sent), and a key pressed under the help stays silent until its next press, so its `single` or `double`, timed
  after the help closed, is dropped too. One exception keeps the host's view of the panel whole: the `up` of a key or
  button whose `down` was sent before the help opened is still sent (REC let go under the help ends the recording).
  Heartbeats, ACKs and host frames go on; host frames update the model, and nothing is drawn under the overlay
  except the status bar and the legend (in DETAILS: the hint band).
- **Close**: letting go of SCL (or losing version 2 or the host) closes it and redraws every region.

## Encoders and MASTER

| Control | HAL | fm1-emu | Frame | Device side | Companion |
| --- | --- | --- | --- | --- | --- |
| SELECT | `ENC_SELECT` 0 | `e0` | `ENCODER encoder=SELECT delta` | Detents add up. One frame per encoder at most every 20 ms, delta clamped to −64..63 with the rest sent next. Turns made while no version is agreed, or under the help overlay, are dropped. | Move the selection |
| ALGORITHM | `ENC_ALGORITHM` 1 | `e1` | `ENCODER encoder=ALGORITHM` | as above | Jump to the next / previous item that needs you |
| KNOB1 | `ENC_KNOB1` 2 | `e2` | `ENCODER encoder=K1` | as above | **SHOW**: scope ACTIVE → RECENT → ALL (Sessions, Tasks) |
| KNOB2 | `ENC_KNOB2` 3 | `e3` | `ENCODER encoder=K2` | as above | **REPO** filter (Sessions, Tasks) |
| KNOB3 | `ENC_KNOB3` 4 | `e4` | `ENCODER encoder=K3` | as above | **TASK** filter (Sessions) |
| KNOB4 | `ENC_KNOB4` 5 | `e5` | `ENCODER encoder=K4` | as above | **TALK** target: reply / Claude chat / Codex chat / Claude task / Codex task |
| PRESETS | `ENC_PRESETS` 6 | `e6` | `ENCODER encoder=PRESETS` | as above | Scroll the detail text (or the transcript); in DETAILS (version 3): next / previous page |
| MASTER | `fm1_adc_read(FM1_ADC_MASTER)`, ADC channel 4 | `pot:V` | `POT pot=MASTER value=0..1023` | Read every 20 ms and smoothed (the average moves a quarter of the way per reading). Sent when it moves 8 counts or more, at most every 50 ms, and once right after each HELLO_ACK (when a reading exists) so the host knows where it stands. | Free. The spec's "screen brightness" is not possible: the backlight (PA2) is on/off only, and the HAL has no PWM for it. |

The encoders have no push switches, so a knob never triggers a one-shot action. `BTN_SEL` (button 3, printed
"SCL") is a separate button. The legend labels (`SET_LEGEND`) belong to KNOB1..KNOB4 only; an empty label means the
knob does nothing in that view.

## Key LEDs

Each key LED has three levels: off, glow (the HAL's dim layer, 8,000 ns a frame: about 1/12) and full. The LEDs are single colour.
The level comes from the slot's state and flags (`fm1c_led.h`), and every pattern runs off `fm1_ms`, so keys in the
same state blink together.

| Priority | Condition | Pattern |
| --- | --- | --- |
| 1 | selected (flag bit 0) | full, steady. A selected approval_required slot dips off for 100 ms every second. |
| 2 | approval_required | full / off, 500 ms each |
| 3 | failed | full / off, 150 ms each |
| 4 | waiting_input | full / glow, 500 ms each |
| 5 | completed_unread | full for 120 ms every 2 s, glow otherwise |
| 6 | working | full, steady |
| 7 | idle, completed_read | glow |
| 8 | empty, disconnected | off |
| 9 | unknown | glow, with 120 ms off every 2 s |
| no host | after 3500 ms of silence, and at boot | every key glows, and the kept selection stays full |

The host tests check all 27 key LEDs against these rules at several times, and the button LEDs per view and voice
state. The emulator's own LED readout confirms the no-host glow on the package. The table above is versions 1–4.

### LED language v2 (version 5, `docs/ui-v3.md` §9.9)

Three layers of `hal/fm1_input.h`, used only through their public variables: lit (`fm1_led`), glow (`fm1_led_dim`,
`FM1_GLOW_NS` 8,000 ns, set in console.c) and the backlight (`fm1_led_bg`, one pulse length `fm1_led_bg_ns` for every LED in it). The
selected key is the **only** LED in the backlight layer (`console.c` `led_key_bg`, set like `fm1_led_key_glow` sets the
glow), and its pulse breathes: whenever `fm1_ms / 20` changes the main loop sets `fm1_led_bg_ns = FM1C_BREATH_NS[i]`,
p = (ms / 20) mod 70, i = p ≤ 35 ? p : 70 − p (1,400 ms; a gamma 2.2 ramp 4,000 → 48,000 ns). Timelines (L lit, G glow,
O off, B backlight; first row that matches):

| Unselected key | Period | Timeline |
| --- | --- | --- |
| empty, disconnected | - | O |
| stale (flag bit 2) | 4,000 | G 0–149, O 150–3999 |
| approval_required | 500 | L 0–249, O 250–499 |
| waiting_input | 1,260 | L 0–119, G 120–239, L 240–359, G 360–1259 |
| failed | 2,000 | L 0–59, G 60–119, L 120–179, G 180–239, L 240–299, G 300–1999 |
| completed_unread | 2,500 | L 0–149, G 150–2499 |
| working | - | L |
| idle, completed_read | - | G |
| unknown | 3,000 | O 0–149, G 150–2999 |

- **Selected key**: B, breathing; in the L windows of approval_required, waiting_input and failed it is lit instead
  (their blink breaks through). No host: every key G, the kept selection B.
- **Buttons** (never breathing): REC L while recording, L 0–249 / O 250–499 while transcribing; SAVE the double blink
  (L 0–119, O 120–239, L 240–359, O 360–1259) while a send or approval awaits it (voice reviewing, view 4, or views
  0/2/5 with `SET_DETAIL.state` approval_required); LFO L in view 5; SEQ G with a list shown; HOME / EDIT L in view 0 /
  1; GLO L in view 2, else a tick L 0–149 every 2,500 ms with `attention_count` > 0; no host: OCT+ L 0–499 / O 500–999.
- **Checks**: `led_test.c` compares `fm1c_key_level2` / `fm1c_button_level` with every sample of
  `fixtures/device/led-v2.json` (the simulator's file, through `tests/console/gen_led_v2.py`) and the breathing table;
  host mode prints the backlight mask (`LEDBG`), and the `v5g-leds` / `v5g-leds-nohost` scenarios read every key and
  button over time. **On-device check pending**: whether 48,000 ns reads "nearly full" next to a lit key and 4,000 ns
  matches the glow, and the input ISR's cost of the longer backlight pulse (≤ 48 µs a column frame).

### CHOSEN (protocol 6, `docs/ui-v3.md` §10.8)

A slot with flag bit 4 (the chosen filter or task of the SPLIT black row) shows **L 0–699, G 700–999** of every
1,000 ms, whatever its state; it is checked before every other row, is never off and never uses the backlight layer
(bits 0 and 4 together are a bad body, so the selected white key stays the only breathing LED). The other black keys
show the state the host sends through the v2 table. No host: G, as every key. Checked against
`fixtures/device/led-v2.json` `chosen` (72 samples × 4 flag combinations) in `led_test.c`.

## Safety

- The firmware sends CCs 116/117 on channel 16 only, never SysEx. SysEx belongs to the platform's updater, which
  this app does not touch.
- No control triggers an update, the rescue or a flash write in the app.
- With no host (no version agreed), presses, turns and MASTER moves are not sent or queued, so nothing stale runs
  when a companion connects. The same holds under the help overlay.
- Pinned keys (slot flag bit 3) are drawn only; they have no LED meaning (versions 1–5).
