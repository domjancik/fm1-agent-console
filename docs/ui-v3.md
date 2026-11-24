# FM1 CONSOLE UI v3: characters, animation, the latest message on the main screen

Date: 2026-11-18. Status: design. Nothing is implemented yet. Owner of this file: the UI v3 design step.

Operator request (2026-11-18): "focus on making the fm1 ui cuter, add animations; characters to represent state; clear
access to latest messages, see if screen space use can be improved".

Parts:

1. [Audit of today's screen](#1-audit-of-todays-240x240-screen): each band, its pixels, what is redundant, what is wasted.
2. [The cast](#2-the-cast-state-characters): one character per state, Claude and Codex, sprite sizes, animations.
3. [Three directions](#3-three-directions): A Buddy and bubble, B Chat list, C Keyboard creatures. Each has mocks.
4. [Recommendation](#4-recommendation): direction A, with two parts taken from B and C.
5. [Protocol](#5-protocol-version-4-is-a-rendering-marker): version 4 is a rendering marker. There are no new messages.
6. [Implementation spec](#6-implementation-spec): firmware, sprite format, budgets, scheduling, host, simulator, tests.
7. [Open gaps](#7-open-gaps).
8. [LIST layout](#8-list-layout-protocol-version-5): SEQ toggles Buddy and a chat list (protocol version 5, additive).
9. [GROUPED list, PINNED, LEDs v2, reader, transitions](#9-grouped-list-pinned-scope-leds-v2-reader-and-transitions-protocol-version-5-additions): the round before the reflash (still version 5, additive).
10. [SPLIT keys and settings](#10-split-keys-and-settings-protocol-version-6): black keys as filters and tasks, the SETTINGS view (protocol version 6, additive).
11. [Suggested next prompt](#11-suggested-next-prompt-host-only-every-protocol) and 12. [Canned responses](#12-canned-responses-host-only-every-protocol) (host only).
13. [Markdown and highlights](#13-markdown-and-highlights-host-every-protocol-highlights-protocol-version-7): the message keeps its structure on every version; inline highlights with protocol version 7.

Evidence (all under `reports/evidence/ui-v3/`):

| Path | What it is |
| --- | --- |
| `contact-sheet.png` | Today's six screens (top row) above the six screens of each direction, all at 1x |
| `a-buddy-bubble/`, `b-chat-list/`, `c-keyboard-creatures/` | `sessions`, `todo-approval`, `detail`, `voice-recording`, `no-companion`, `help` as 2x PNGs, with 1x copies in `1x/`. Animated GIFs (8 frames, 125 ms each) for sessions, TO DO and voice. A also has `knob-touched.png`. |
| `sprites/sprite-sheet-1x.png`, `sprite-sheet-4x.png` | Every state × provider: 4 hero frames (24×24) and 2 mini frames (12×12) |
| `audit/today-v3-sessions-bands.png` | Today's Sessions screen with the band boundaries marked |
| `stats.json` | The band audit numbers, the sprite flash budget, and a simulated animation redraw cost per direction |
| `scripts/` | Throwaway renderer (Python + Pillow): `fm1canvas.py`, `sprites.py`, `mocks.py`, `sheet.py`. Run `python3 -I reports/evidence/ui-v3/scripts/mocks.py`. |

**Text in the mocks matches the device exactly.** `fm1canvas.py` reads `FONT_S` and `FONT_L` from
`firmware/firmware/gen/felucca_font.h`. It draws them the way `gfx.c cv_text` does: each pixel is set to
colour × alpha / 15 on black. Colours are quantised to RGB565. I drew `ACTIVE 15`, `VOICE TESTS` (FONT_L) and
`tests for the voice` with it and compared them with `reports/evidence/firmware-host/v3-sessions.png`. All three regions
differ by 0 pixels. The firmware has no smaller font, so every mock uses only `FONT_S` (8×16) and `FONT_L` (16×32,
capitals only).

---

## 1. Audit of today's 240×240 screen

Source: `reports/evidence/firmware-host/v3-sessions.png` (version 3, Sessions, a working chat selected), measured by
`mocks.py audit()`. "Ink" means non-black pixels. Bands are from `docs/firmware-ui.md`.

| Rows | Band | Height | Rows with ink | Ink px / area | What it shows | Assessment |
| --- | --- | --- | --- | --- | --- | --- |
| 0–23 | Status bar | 24 | 17 | 736 / 5,760 | `ACTIVE 15`, page `1/2`, link dot, badge | Needed. A 16 px font in a 24 px bar leaves 7 blank rows. 18 rows are enough. |
| 24–39 | Head chips | 16 | 16 | 1,920 / 3,840 | `CLAUDE` chip, `WORKING` chip | **Redundant.** The state colour is already on the selected key, and the key LED blinks the state. A character carries both the state and the provider. |
| 40–71 | Label (`FONT_L`) | 32 | 20 | 800 / 7,680 | The title head, at most 12 capitals | 32 rows for 12 characters. It is the only large text. Keep it, but only beside something else. |
| 72–87 | Line 1 | 16 | 10 | 269 / 3,840 | The rest of the title (≤ 20) | Useful |
| 88–103 | Line 2 | 16 | 13 | 80 / 3,840 | The second wrap line of the title, or the task | Often a 1–2 word stub (`path`) |
| 104–119 | Line 3 | 16 | 13 | 316 / 3,840 | `<age> <what>`, ≤ 20 characters | **The only trace of the latest message**, and only 20 characters of it |
| 120–135 | Hint bar | 16 | 16 | 3,840 / 3,840 | `ENV stop  PLAY open` | Needed (buttons act). |
| 136–139 | Gap | 4 | 0 | 0 / 960 | — | Wasted |
| 136–165 | Black keys | 30 | 24 | 1,760 / 7,200 | 11 colour boxes 10×24 | One colour per key. Physical key LEDs repeat the blink pattern, but not the colour. |
| 166–199 | White keys | 34 | 30 | 3,420 / 8,160 | 16 colour boxes 12×26 | Same. 64 rows carry 27 colours, the selection, and pin and stale marks. |
| 200–239 | Legend | 40 | 40 | 1,175 / 9,600 | `KNOB1..4` above `SHOW REPO TASK TALK` | **Static.** The labels change only with the view, and knobs are turned rarely. The legend is 16.7 % of the screen. It is empty in voice and confirm, and three cells are empty in TO DO. |

What the audit shows:

- **The latest message is not on the main screen.** You see 20 characters of a summary on line 3. DETAILS page 1
  (`reports/evidence/ux-v2/after/detail-page1.png`) shows `Last message 2m` at row 11 and one line of the message. The
  message itself starts on page 2. Reading what an agent said takes LFO, then PRESETS.
- **Redundant:** the head chip band (16 rows) repeats the key colour and LED. The legend (40 rows) repeats static names;
  the values are in the title (`ACTIVE 15`) and in toasts. The status bar has 6 spare rows.
- **Too small:** line 3 (20 characters for the message). In version 1 the key cells were 6 px wide. Version 2 keys
  are 12×26 px, but they are colour only. On a grey page nothing tells `idle`, `unknown` and `disconnected` apart
  except shades of #202020–#606060.
- **Wasted rows on Sessions: about 94 of 240 (39 %).** Legend 40, strip height above need 32 (64 → 32 holds the same
  27 keys as characters), head chips 16, status padding 6. In the voice view the strip and the legend take 108 rows
  (45 %) and say nothing about the recording (`firmware-host/v2-voice-recording.png`).

---

## 2. The cast: state characters

![sprite sheet](../reports/evidence/ui-v3/sprites/sprite-sheet-4x.png)

There are two species, so the provider shows by shape and the state shows by colour and pose:

- **Claude: a round cat-blob.** It has two pointed ears with pink insides, ink eyes with a white shine, and a `w` mouth.
- **Codex: a boxy bot.** It has an antenna with a ball, and a dark navy visor with white eyes. It reads as a screen face.

At 12×12 the species still differ: ears against an antenna and a visor. The body colour is the state colour of
`docs/firmware-ui.md`. Four colours that are too dark to carry a face on black are lightened for sprites only:
completed_read #3C7A50, idle #707070, unknown #545454, disconnected #383838. Each state gets 3 body shades (base,
+45 % to white, ×0.62). They are computed offline and stored as palette entries 13–15.

| State | Pose (shared id) | Hero animation (24×24) | fps | Mini (12×12) | Hero props |
| --- | --- | --- | --- | --- | --- |
| working | `work`: looks down at a laptop and types | 4 frames: hands go up and down in turn, a 3-dot "thinking" row steps | 8 | 2 frames at 4 fps: hands on the lid | laptop lid, dots |
| waiting_input | `wave`: waves one arm | 4 frames: the hand moves along an arc, the `?` bobs 1 px | 6 | 2 frames at 4 fps: the arm moves | `?` |
| approval_required | `hand`: hand up, wide eyes, mouth open | 4 frames: bounces 1 px, the `!` blinks white, yellow, white, off | 6 | 2 frames at 4 fps: the hand goes up | `!` |
| failed | `dizzy`: X eyes, wavy mouth | 4 frames: 3 stars circle the head, a sweat drop drips | 6 | 2 frames at 4 fps: a star flickers | stars, drop |
| completed_unread | `happy`: ^ ^ eyes, open smile, pink cheeks | 4 frames: squash, jump 2 px, jump 3 px, fall 1 px, arms up at the top; sparkles swap sides | 8 | 2 frames at 4 fps: hops 1 px, a sparkle | sparkles |
| completed_read, idle | `sleep`: closed eyes | 4 frames: breathes (1 px squash), `z` and `Z` rise | 4 | 1 frame (static) | z Z |
| unknown | `huh`: looks left and right | 4 frames: eyes go left, centre, right, centre; the `?` pulses | 4 | 1 frame (static), `?` | `?` |
| disconnected (and stale keys) | `ghost`: dim, hollow eyes, wavy hem | 2 frames: floats 1 px, the hem waves | 4 | 1 frame (static) | — |

Minis animate only in the five states that want attention (working, waiting, approval, failed, done unread). Calm states
stay still, so a page of 27 sleeping sessions costs nothing. The physical key LEDs keep their section 6 patterns. The
animation is synchronised from `fm1_ms`, so all keys in the same state move together, as the LEDs do.

Selection, pin and stale on minis: the selected key gets a 1 px white frame on its 14×14 box and a 4×1 tick under it.
A pinned key gets a 2×2 white dot at its top-right corner. A stale key (flag bit 2) draws the `ghost` pose in its
provider's shape.

---

## 3. Three directions

All three directions follow the UX v2 rules: knobs only change a setting, buttons act, and the hint bar names the
buttons. They draw the same host data. The differences are where the space goes and how the latest message reads.

### 3.A Buddy and bubble (hero + speech bubble + critter keyboard)

![A sessions](../reports/evidence/ui-v3/a-buddy-bubble/sessions.png) ![A to do](../reports/evidence/ui-v3/a-buddy-bubble/todo-approval.png)

| Rows | Band | Contents |
| --- | --- | --- |
| 0–17 | Top bar (18) | Title (`ACTIVE 15`, `TO DO 5`, `DETAILS <head>`), page, link dot, badge 16 px tall at y 1; rule on row 17 |
| 18–71 | Hero zone (54) | Hero 48×48 (the 24×24 sprite drawn 2×) at (4, 20). At x 60: the label in `FONT_L` (≤ 11 capitals = 176 px, else `FONT_S`) at y 18, and line 1 (the rest of the title, ≤ 20, #C0C0C0) at y 50 |
| 69–181 | Speech bubble (113, tail 69–74) | A 1 px frame with cut corners, 236×108 at (2, 74), in the state colour at 80 %. The tail points up at the hero. **Caption** at y 78: `Done, unread, 2m` in the state colour, with the physical key name (`G#3`) right-aligned in grey. **Body:** 5 rows of ≤ 28 characters at y 96 + 16n (140 characters). A white wedge on the bottom edge means there is more. |
| 182–221 | Critter keyboard (40) | 11 black-key minis in boxes 14×14 at y 184, and 16 white-key minis at y 202. The x positions are v2's (white key w at x = 8 + 14w; black key over the boundary after white key a at x = 8 + 14(a+1) − 7). An empty key is a 4×2 dash. |
| 224–239 | Hint bar (16) | `REC reply  PLAY open`. For 2 s after a knob turn it shows the four knobs, with the turned one lit (`knob-touched.png`). The toast replaces it, as today. |

- **Latest message:** always on the main screen, newest first: the caption plus up to 140 characters of the newest
  content. PRESETS (turn) scrolls the bubble 5 rows at a time. LFO opens DETAILS, where the message comes first
  (`detail.png`: the 48 px hero header, then `Last message 2m` and the full text).
- **Voice** (`voice-recording.png`): the bubble becomes **your** bubble, with its tail on the right, framed red. It
  holds a blinking REC dot, `RECORDING`, the elapsed time and a 28-bar level meter. The hero stays the target chat's
  character, and the label shows `to: reply`. In reviewing, the transcript fills the 5 body rows (140 characters;
  today it is 40).
- **No companion** (`no-companion.png`): the dimmed screen, and a 208×128 banner with the ghost character (2×, floating),
  `NO COMPANION` in `FONT_L` and `start fm1-console on Mac`.
- **Help** (`help.png`): the controls in 8 lines, both knob lines included because the legend now shows only after a knob
  turn, and a "who is who" grid of the 8 characters with their state words.
- **Animation cost:** the hero box (2,304 px) at its fps, and a mini box (144 px) at 4 fps for attention states only. On
  the sample page: 18,432 + 9 × 576 = **23,616 px/s**, which is 31 ms/s of SPI at 12 MHz (3.1 %). Simulated over 1 s at
  40 Hz on 6×6 dirty cells: 16,632 px/s, worst tick 2,412 px (`stats.json`).

### 3.B Chat list (selected card + list of rows with key names)

![B sessions](../reports/evidence/ui-v3/b-chat-list/sessions.png) ![B detail](../reports/evidence/ui-v3/b-chat-list/detail.png)

| Rows | Band | Contents |
| --- | --- | --- |
| 0–17 | Top bar (18) | as A |
| 18–71 | Card head (54) | Hero 48×48 at (4, 20). At x 58: the title in `FONT_S` on 2 lines (≤ 22 each), and the state words in the state colour + age + the key name (`G#3`) right-aligned |
| 69–127 | Bubble (54) | 3 rows × 28 characters (84) of the newest content, with no caption |
| 128–223 | List (96) | 6 rows of 16 px: mini sprite, key name (`F#3`, grey), the title cut at 19, and the age right-aligned. A scroll bar on x 237–238. |
| 224–239 | Hint bar (16) | as A |

- There is **no key strip**. The key names on the rows and the key LEDs carry the mapping. SELECT scrolls the list.
- **DETAILS** (`detail.png`) is a transcript, newest first: the agent's bubble with its 24 px hero (`Claude, 2m`), then
  the operator's previous prompt in a grey bubble on the right (`You, 9m`). This needs the adapter to keep the last
  user prompt (§6.4).
- **No companion:** both species asleep side by side in the banner. **Voice:** the card stays, and the list area holds
  the meter and the elapsed time.
- **Animation cost:** hero 18,432 + 6 list minis × 576 = **21,888 px/s**. Simulated: 15,480 px/s, worst tick 2,124 px.
- Weak points: 6 of 27 keys are visible at once, so you lose the whole-page overview the keyboard gives. TO DO with 16
  items needs 3 screens of list. Rows are dense text and less cute.

### 3.C Keyboard creatures (faces on today's keys)

![C sessions](../reports/evidence/ui-v3/c-keyboard-creatures/sessions.png) ![C to do](../reports/evidence/ui-v3/c-keyboard-creatures/todo-approval.png)

| Rows | Band | Contents |
| --- | --- | --- |
| 0–17 | Top bar (18) | as A |
| 18–51 | Hero row (34) | Hero 24×24 at 1x at (4, 21). Title (≤ 25) at (32, 19). State words + age + provider at (32, 35). |
| 51–123 | Bubble (73) | 4 rows × 28 characters (112) |
| 126–207 | Creature keyboard (82) | v2 keyboard geometry, taller: black keys 126–165, white keys 166–207. Each key fill is the state colour with a face (eyes 1×3, Codex gets a visor band). Happy keys hop 2–3 px, approval keys show a white `!` and bob, working keys' eyes scan, failed keys get X eyes. |
| 208–223 | Hint bar (16) | as A |
| 224–239 | Thin legend (16) | 4 cells: a knob glyph (8×8 ring), the knob number in grey, the label (`1 SHOW`) |

- **No companion:** the whole keyboard falls asleep (closed eyes, grey) at full brightness under a smaller banner.
  **Help:** today's text with the thin legend below it.
- **Animation cost:** hero 576 × 8 = 4,608. Each animated key redraws its fill (a hop moves it): about 456 px × 6 fps ×
  9 keys = 24,624, for **about 29,000 px/s**. Simulated: 12,888 px/s, worst tick 1,728 px.
- Weak points: faces on 10–12 px fills are barely readable. The message gets only 4 rows. It keeps the most of today's
  layout (82 rows of keyboard), so it gains the least space. The provider shows only as a visor band.

### 3.D Side by side

| | A Buddy and bubble | B Chat list | C Keyboard creatures | Today (v3) |
| --- | --- | --- | --- | --- |
| Message characters on the main screen | **140** + caption | 84 | 112 | 20 (`<age> <what>`) |
| Hero | 48×48 | 48×48 | 24×24 | none |
| Key overview | 27 minis, keyboard layout, 40 rows | 6 rows, key names | 27 keys with faces, 82 rows | 27 colour boxes, 64 rows |
| Knob legend | on demand (2 s in the hint bar), and in Help | in Help | always, 16 rows | always, 40 rows |
| Rows for the selected chat | 164 (18–181) | 110 (18–127), plus 96 of list | 106 (18–123) | 96 (24–119) |
| Animation px/s (sample page) | 23,616 | 21,888 | ≈ 29,000 | 0 |
| Flash for sprites (raw 4 bpp) | 19.2 KB | 19.2 KB | 9.6 KB hero + key-face code | — |

---

## 4. Recommendation

**Build A (Buddy and bubble), with two parts taken from the others.** Both are already in the A mocks:

1. From B: the physical key name of the selected chat (`G#3`) in the bubble caption. It ties the bubble to a key without
   a strip label.
2. From C: the compact knob row (knob glyph + number + label). A shows it only for 2 s in the hint bar after a knob turn,
   The permanent 40-row legend goes away. Help (SCL hold) lists the knobs too.

Why A:

- **It answers the request directly.** A cute 48×48 character per chat; the newest message readable without a press
  (5 × 28 characters, 7× today's 20); one press (LFO) to the full message, which comes first in DETAILS.
- **It reclaims the space** the audit found. Rows 18–181 (164 rows) go to the selected chat. Today it gets 96 (head
  chips, label, lines 1–3). The 27 keys keep their keyboard positions in 40 rows (today: 64). The 40-row static legend is
  gone.
- **It is cheap.** Animation is one 48×48 box at ≤ 8 fps plus 12×12 boxes at 4 fps, about 3 % of SPI time. The
  keyboard keeps v2's x geometry, so `fm1c_key_box` changes only its y and size. The hint bar sits at the bottom in
  every view, DETAILS included.
- **It needs no new message** (§5). The bubble reuses `SET_TEXT`, which version 3 already stores in every view.

B is better for long text lists but loses the page overview and the cuteness. C is the smallest change but gains the
least space, and its faces are too small to read.

---

## 5. Protocol: version 4 is a rendering marker

The wire format stays as in version 3: the same message types, bodies, limits and vectors. As with version 2 (a
rendering marker over version 1), **version 4** only changes how the device draws existing fields and what the host puts
in them. Nothing grows.

| | Device | Host |
| --- | --- | --- |
| Constants | `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 4` | `PROTOCOL_VERSION 4`, `HOST_VERSIONS = { min: 1, max: 4 }` |
| Version 3 or lower agreed | Draws the v3 or v2 or v1 layout, unchanged | Sends version 3 content |
| Version 4 agreed | Draws the §3.A layout and the characters | Sends the version 4 content below |

Meaning of version 4 (this text goes into `docs/protocol.md` §3 and §4):

- **Base views (0 sessions, 1 tasks, 2 TO DO):**
  - `SET_TEXT` rows 0–6 are **the bubble**. Row 0 is the caption (`<State words>, <age>`, ≤ 20). The device draws it in
    the selected slot's state colour, whatever the style. Rows 1–5 are the body (≤ 28 characters, so 224 px; style 0
    white, style 2 muted). Row 6 is the first line after the visible body, or `""`: when it is non-empty the device
    draws the "more" wedge. Rows 7–11 are `""`.
  - The slot label (≤ 12) is drawn beside the hero in `FONT_L` when it fits in 176 px (11 characters), else in
    `FONT_S`. The host cuts the head at 11 for version 4.
  - `SET_DETAIL.line1` is the rest of the title. `line2` and `line3` are `""`. `line4` is the hint line.
- **Voice (3):** in reviewing, failed and target_unavailable, `SET_TEXT` rows 1–5 carry the transcript or the error,
  wrapped at 28. `SET_DETAIL.line1–3` are `""`. The device draws the recording bubble from `SET_VOICE`.
- **Confirm (4):** unchanged fields. The device draws `SET_DETAIL.line1` (the verb) as the label beside the target's
  hero, and lines 2–4 in the bubble. The hint bar is fixed: `SAVE yes   FX no`.
- **DETAILS (5):** rows 0–2 are the header, drawn right of the 48 px hero at x 60 (≤ 22 characters; row 0 in the state
  colour). Rows 3–11 are the body (9 rows at y 72 + 16n, ≤ 29). The hint bar moves to 224–239.
- **Order rule:** in version 4 the `SET_TEXT` rows mean different things in base views and in DETAILS. On every switch
  between them, the host sends all four `SET_TEXT` groups (rows 0–2, 3–5, 6–8, 9–11) **before** `SET_VIEW`. This
  extends the existing v3 rule ("changed groups before `SET_VIEW` 5"). It costs 4 frames, about 8 ms on the wire.
- **Characters** are firmware-local. They are drawn from `SET_DETAIL.state` + `provider` (hero) and `SET_SLOT.state` +
  flag bit 1 (minis). No field is added.
- **Knob row on demand:** the device shows it for 2,000 ms after it sends an `ENCODER` frame for K1–K4 (encoder
  2–5), from the `SET_LEGEND` labels it already holds. The host is not involved; its toast still follows.

New negotiation vectors (`fixtures/device/vectors.json`, `negotiation`): `v4_device_v4_host` 1–4 / 1–4 → 4;
`v3_device_v4_host` 1–3 / 1–4 → 3; `v4_device_v3_host` 1–4 / 1–3 → 3; `v1_device_v4_host` 1–1 / 1–4 → 1. No frame vector
changes, because the wire format is v3's.

I looked at and rejected **a new `SET_BUBBLE` message** (an additive version 4 with its own body). A body of
5 × 28 characters needs two frames anyway because of `LEN` ≤ 100, and the 12-row `SET_TEXT` buffer already exists,
is stored in every view, is diffed per row and is in the resync. A new type would add a codec, vectors and a
second buffer (+180 B RAM) for no gain.

---

## 6. Implementation spec

### 6.1 Firmware (`firmware/firmware/src/`)

Dinghy platform files stay byte-identical (`platform.c`, `usb.c`, `gfx.c`, `lcd.c`, `ota.c`, `recovery.c`, `hal/`,
`gen/felucca_font.h`). Everything below is in our own `fm1c_*` files and `console.c`.

| File | Change |
| --- | --- |
| `fm1c_proto.h` | `FM1C_PROTO_MAX 4`. Add `FM1C_PROTO_V4 4u`. |
| `fm1c_model.h` | `fm1c_v4(m)` (`proto >= 4`). New region bits: `FM1C_D_HERO` (the hero box), `FM1C_D_LABEL4` (label + line 1 beside the hero), `FM1C_D_HINT4` (224–239), `FM1C_D_KNOBS` (the 2 s knob row). Bubble rows reuse `dirty_rows` (rows 0–6 in base views; rows 0–11 in DETAILS). Key dirt reuses `dirty_keys`. With v4, `fm1c_key_box` returns the 14×14 mini boxes (white: x = 8 + 14w, y 202; black: x = 8 + 14(a+1) − 7, y 184). With v3 or lower it returns today's boxes. New fields: `uint8_t knob_lit; uint32_t knob_until;`. `SET_TEXT` in base views (v4) marks the changed rows; outside v4 it stays "stored only". A `SET_DETAIL.state` or `provider` change marks `FM1C_D_HERO` and row 0 (caption colour). |
| **new** `fm1c_sprites.h` | Generated by `tools/gen_sprites.py` (ours, a new file, so no upstream change) from `firmware/assets/sprites/*.png`, and committed. `static const uint8_t FM1C_SPR_HERO[pose][provider][4][288]` (24×24, 4 bpp, 2 pixels per byte, high nibble first), `FM1C_SPR_MINI[pose][provider][2][72]`, `FM1C_SPR_POSE_OF_STATE[10]`, `FM1C_SPR_ANIM[pose] = {hero_frames, hero_fps, mini_frames, mini_fps}`, `FM1C_SPR_PAL_BASE[13]` (RGB565) and `FM1C_SPR_PAL_STATE[10][3]` (body, light, shade). The key-name table `FM1C_NOTE[27]` (`"F3"`…`"G5"`) lives here too. |
| **new** `fm1c_sprite.h` | `fm1c_sprite(int32_t x, int32_t y, const uint8_t *px4, uint32_t w, uint32_t h, const uint16_t pal[16], uint32_t scale)`: draws into the open canvas (`cv_pset`), index 0 transparent, 1 or 2 times scale. `fm1c_spr_pal(uint32_t state, uint16_t out[16])`. Uses only `cv_*`, no new platform call. |
| **new** `fm1c_anim.h` | Pure (`<stdint.h>` only), so it can be unit-tested alone. `fm1c_anim_frame(pose, which, now)` = `(now * fps / 1000) % frames`. `typedef struct { uint8_t hero_drawn; uint8_t key_drawn[27]; } fm1c_anim;`. `fm1c_anim_due(a, m, now, budget_px, *hero, *keys)` picks the boxes whose frame changed, hero first, then keys in order. It stops before the next box would pass `budget_px`. A box not drawn this pass is drawn on a later pass at its frame of that time; frames are skipped, never queued. |
| `fm1c_draw.h` | Version 4 drawers: `fm1c_draw4_status` (18 rows), `fm1c_draw4_hero` (the 48×48 box: sprite 2×, black background), `fm1c_draw4_label`, `fm1c_draw4_bubble_frame` (frame, tail, wedge), `fm1c_draw4_bubble_row(r)` (one row, 224×16 = 3,584 px), `fm1c_draw4_key(k)` (one 14×14 box), `fm1c_draw4_keyboard`, `fm1c_draw4_hint` (or the knob row while `now < knob_until`, or the toast), `fm1c_draw4_voice` (the meter, 28 bars × 5 px, in the bubble), `fm1c_draw4_detail` (header and 9 rows), `fm1c_draw4_banner` (208×128, drawn as **two** 208×64 strips because `CV_MAX` is 240×80), `fm1c_draw4_help` (`FM1C_HELP_BASE4` + the who-is-who grid). `fm1c_draw()` dispatches to them when `fm1c_v4(m)`. New: `fm1c_draw_anim(m, a, now, budget)` draws only the boxes `fm1c_anim_due` returns. |
| `fm1c_help.h` | `FM1C_HELP_BASE4[8]` (the eight lines of `a-buddy-bubble/help.png`), `FM1C_HELP_DETAIL4` (as v3 with `PRESETS older`), `FM1C_HELP_WORDS4[8]` (`Working`, `Needs answer`, `Approve?`, `Failed`, `Done, unread`, `Asleep`, `No status`, `Offline`) |
| `console.c` | In the main loop, after `fm1c_draw(&model, &kd)`: `if (anim_ok(now)) fm1c_draw_anim(&model, &anim, now, FM1C_ANIM_PX_PASS);` (below). In `read_panel`: when an `ENCODER` frame for K1–K4 is queued with v4, set `model.knob_lit = enc − 2; model.knob_until = now + 2000;` and mark `FM1C_D_HINT4`. `fm1c_model_tick` clears it at `knob_until`. |
| `fm1c_led.h`, `fm1c_input.h`, `fm1c_link.h`, `fm1c_frame.h` | No change |

**Scheduling (USB and BLE come first).** Animation is the lowest-priority drawing:

```
static int anim_ok(uint32_t now)
{
    return fm1c_v4(&model) && !model.help && !fm1c_dimmed(&model)     /* no animation under help or the dimmed screen */
        && model.dirty == 0 && model.dirty_keys == 0 && model.dirty_rows == 0   /* content first */
        && rxq_r == rxq_w                                                /* no host frame waiting to be parsed */
        && !fm1c_link_busy(&lnk, now)                                    /* no device frame awaiting its ACK */
        && now - last_host_rx >= 20u;                                    /* a burst (resync) is not running */
}
```

- `FM1C_ANIM_PX_PASS = 2400`: one hero frame (2,304 px, 3.1 ms of DMA at 12 MHz), or up to 16 minis (144 px each) per
  pass. The DMA runs with `LCD_IDLE` (`app_idle`) moving MIDI, as it does for every blit today.
- `fm1c_link_busy` is a new read-only helper in `fm1c_link.h`: true while a sent frame is unacknowledged. Adding a
  function to our own header does not touch the platform.
- **Rate ceiling:** hero ≤ 8 fps (2,304 × 8 = 18,432 px/s). Minis 4 fps, attention states only (≤ 27 × 576 =
  15,552 px/s). Worst case 33,984 px/s, which is 45 ms/s of SPI (4.5 %). The sample page needs 23,616 px/s.
- **Heartbeats and ACKs:** a pass with animation adds at most 3.1 ms of DMA, and `LCD_IDLE` keeps reading MIDI during
  it. The 250 ms retransmit window and the 1 s heartbeat are not at risk. `fm1c_link_busy` keeps animation off while
  an ACK is pending, so a retransmission never waits behind a sprite.
- **Transitions (cheap ones only):** on a selection change, the hero's first frame is frame 0 of its pose (squash) and
  the rows redraw one per pass. Each bubble row is its own blit, so the link is served between rows. Page change:
  only the changed keys. Toast: no slide (a 4-step slide would cost 15,360 px for little benefit; it could come later).
- **Help, banner and DETAILS:** no mini animation (the keys are hidden or dimmed). The banner ghost animates at 4 fps
  (2 frames, 2,304 px). The DETAILS hero animates like the base hero.

**Budgets.**

| Item | Size | Notes |
| --- | --- | --- |
| Hero frames | 60 × 288 B = **17,280 B** raw 4 bpp | 8 poses × 2 providers × 4 frames (ghost 2). RLE (`(run−1) << 4 \| index`) gives 7,169 B plus a 2 B index per frame. Recommendation: **raw**. Frames are random-access with no decoder, and flash has room (BLE image 94 KB of 581 KB). |
| Mini frames | 26 × 72 B = **1,872 B** raw | 5 animated poses × 2 providers × 2 frames, plus 3 static poses × 2 |
| Palettes | 13 × 2 + 10 × 3 × 2 = **86 B** | RGB565 |
| Code | ≈ 4–6 KB (estimate) | v4 drawers, sprite blitter, anim scheduler, help |
| **Flash total** | **≈ 25 KB** | BLE app image ≈ 94 → ≈ 119 KB of 581 KB |
| RAM | **+≈ 40 B** | `fm1c_anim` 28 B, `knob_lit`/`knob_until` 5 B, `last_host_rx` 4 B. The bubble uses the existing 12-row `SET_TEXT` buffer, and the hero canvas (48×48 × 2 B = 4,608 B) fits in the existing `cv_px` pool (38,400 B). RAM .data+.bss stays ≈ 26 KB of 96 KB. |
| SPI per frame | hero 2,304 px (3.1 ms), mini 144 px (0.19 ms), bubble row 3,584 px (4.8 ms) | at 12 MHz, 16 bit/px |

### 6.2 Sprite pipeline

- Source of truth: `firmware/assets/sprites/hero-<pose>-<provider>.png` (96×24, 4 frames of 24×24) and
  `mini-<pose>-<provider>.png` (24×12). They use exactly the 16-entry index palette of `sprites.py`; entries 13–15 are
  "body", "light" and "shade" placeholders.
- `tools/gen_sprites.py` checks the sizes and that every pixel is in the palette, then writes `fm1c_sprites.h`. A test
  re-runs it and requires the committed header to be byte-equal.
- The throwaway `reports/evidence/ui-v3/scripts/sprites.py` generates the first PNGs procedurally, so the mocks and
  the firmware start from the same pixels. After that the PNGs are edited by hand.

### 6.3 Host (`packages/agent-core`, `packages/device-protocol`, `apps/companion`)

| File | Change |
| --- | --- |
| `device-protocol/src/constants.ts`, `negotiate.ts` | `PROTOCOL_VERSION 4`, `HOST_VERSIONS { min: 1, max: 4 }`. The 4 vectors of §5. |
| `agent-core/src/copy.ts` | `BUBBLE_COLS = 28`. `bubbleRows(entry, details, now, scroll) → TextRow[7]`. Row 0 is the caption: `STATE_WORDS[state]` in sentence case + `, ` + `ageText`, ≤ 20. Rows 1–5 are the newest content, by state: approval → `Approve: <target>` then the approval summary; waiting_input → the last message (the question); failed → `Error: <failure>`, then the last message; working → `Now: <activity>`, then the last message; completed, idle → the last message; nothing known → muted `No message yet`. `scroll` skips 5 rows per step. Row 6 is the next line or `""`. |
| `agent-core/src/details.ts` | `detailRows4(input)`: rows 0–2 are the header (state heading, the title wrapped at 22, 2 rows). Then **newest first**: `Last message <age>` and the message; then approval, error or now; then the facts (`<Provider> <model>`, context, files); then `Task: …`. 9 body rows per page, at most 8 pages. |
| `agent-core/src/view.ts` | With `proto >= 4`: label = `titleSplit(title, 11).head`, line1 = the title continuation (≤ 20), line2 = line3 = `""`, `text` = `bubbleRows` in base views, `detailRows4` pages in DETAILS, the transcript rows in voice. Version 3 output is unchanged. |
| `agent-core/src/controller.ts` | PRESETS in base views with `proto >= 4`: `bubbleScroll ± 1` (clamped), reset on a selection change. In DETAILS: pages, as in v3. |
| `agent-core/src/control-map.ts` | `HELP_TEXT.base4`, `HELP_TEXT.detail4`, `HELP_WORDS4` (equal to `fm1c_help.h`) |
| `apps/companion/src/device/render.ts` | With proto 4, send `SET_TEXT` in base views and voice too. On any base ↔ DETAILS switch, send all four groups before `SET_VIEW` (§5 order rule). The per-element diff still skips groups that did not change in the same view. |
| `packages/agent-adapter-traycer` | No change for A: `lastMessage` (600 characters), `activity`, `failure` and `approval` exist (ux-v2 §7.1). Optional, only for B's transcript: `lastPrompt` (the operator's last message, 200). |

Host status (2026-11-18, host side implemented): `PROTOCOL_VERSION 4`, the 4 vectors, `bubbleLines`/`bubbleRows`
(`copy.ts`), `bubble.ts` (session, task and voice bubbles), `detailPages4`, `AgentConsole.setProtocol`, PRESETS bubble
scroll, and the render order rule. Help: the firmware keeps `FM1C_HELP_BASE4` at **6** static lines and builds the two
knob lines from `SET_LEGEND` (`KNOB1 SHOW  KNOB2 REPO`); the host mirrors this as `HELP_TEXT.base4` (6 lines) plus
`helpKnobLines4(legend)`, and the simulator draws the same 8 lines.

### 6.4 Simulator (`packages/device-simulator`)

Today it still draws the version 1 layout with its own font metrics (6×8 / 8×16 / 16×24). The firmware uses
`FONT_S` 8×16 and `FONT_L` 16×32. For v4:

- `tools/export_assets.py` (or a bun script) turns `felucca_font.h` and `fm1c_sprites.h` into a JSON asset
  (`packages/device-simulator/src/assets/fm1-v4.json`: glyph nibbles, advances, sprite frames, palettes).
- `layout.ts` gets `layoutV4(state, now)` with the §3.A geometry, and a `sprite` draw op. The canvas renderer draws
  glyphs and sprites pixel by pixel with the same alpha-on-black rule.
- A parity test renders 6 scenario states in node into an RGB565 buffer and compares it with the firmware host
  screenshots of the same frames (as `compare_shots.py` does for host and emulator). Byte equality is the target.

Review status (2026-11-18): `test/v4-firmware-parity.test.ts` replays the firmware's own v4 scenarios
(`firmware/tests/console/scenario/scenarios.ts`) through the codec into the simulator and compares 17 screenshots of
`reports/evidence/ui-v3/after/host/` in RGB565: all are byte-identical. To get there, the simulator now follows the
firmware where it differed from the A mocks: the confirm screen (white verb, the chat's label under it, "Please confirm"
and the key name, lines 2-4 as body rows), the voice screen (state colours of `FM1C_VOICE_RGB`, `to <target>`, the
elapsed time in every voice state, the 28-bar meter kept per elapsed step, tail at x 206), one tail diagonal, no tick
under the selected key, white text on the amber badge (`fm1c_dark`), the 80 % frame per RGB565 channel, the 60 ms
animation phase, a top bar that dims with the screen and uses the firmware's title rule, sprites frozen under the
no-host banner, and the knob row in every view. The mock comparison (`v4-screen.test.ts`) is now a loose check.

### 6.5 Tests

Firmware (`firmware/tests/console/`):

1. `anim_test.c` (new, pure):
   - frame index for each pose at fps boundaries, for example `work` at 124/125/249/250 ms;
   - keys in the same state share a frame;
   - `fm1c_anim_due` never returns more than `FM1C_ANIM_PX_PASS` px;
   - skipped frames are not queued;
   - calm poses (sleep, huh, ghost) never mark a mini.
2. `model_test.c`:
   - v4 `SET_TEXT` in a base view marks only its changed rows, and a repeat marks nothing;
   - row 6 becoming non-empty marks the wedge;
   - `SET_DETAIL.state` marks the hero and row 0;
   - the v4 `fm1c_key_box` gives the §3.A boxes for keys 0, 1 and 26, and all 27 boxes are disjoint;
   - knob-touch marks and clears `FM1C_D_HINT4` at 2,000 ms;
   - with v3 agreed, every v3 check is unchanged.
3. Scenarios (host and emulator), with screenshots in `reports/evidence/firmware-host/` and `reports/evidence/emu/`:
   - `v4-sessions`, `v4-todo-approval`, `v4-detail`, `v4-voice-recording`, `v4-voice-reviewing` (5 transcript rows),
     `v4-confirm`, `v4-knob-touch` (and gone after 2 s), `v4-help`, `v4-nohost` (two-strip banner);
   - `v4-anim` (shots at t, t + 125 and t + 250 ms; the hero box changes and nothing else does);
   - `v3-compat` (proto 3 draws exactly as today's v3 shots).
4. Redraw counters:
   - 3 s with no host change and every session calm: 0 px outside the hero box, and the hero box at most
     3 × 4 fps × 2,304 = 27,648 px;
   - all 27 keys attention-animated: ≤ 2,400 px per pass and ≤ 34,000 px/s;
   - one `SET_SLOT`: 196 px (one 14×14 box);
   - one changed bubble row: 3,584 px.
5. Link under animation (emulator, `--midi none`): a 60 s run with all states animating while the TS link sends
   20 frames/s and heartbeats:
   - 0 retransmissions;
   - every ACK within 15 ms;
   - heartbeat jitter < 50 ms.
6. `compare_shots.py`: host and emulator byte-identical for every new screen. `tests/run_tests.sh` and
   `tests/ble/run.sh` stay green. The release build check reports the BLE image ≤ 125 KB.

Host (bun test):

1. `copy.test.ts`: `bubbleRows` for every state; caption ≤ 20; rows ≤ 28; ASCII only; row 6 = the next line; scroll clamps.
2. `details.test.ts`: `detailRows4` puts the last message right after the header; 9 body rows per page; ≤ 8 pages.
3. `view.test.ts`: v4 label ≤ 11; line2/line3 empty; v3 output byte-equal to before.
4. `controller.test.ts`: PRESETS scrolls the bubble in v4; it resets on selection; knobs still never act.
5. `render.test.ts`: SET_TEXT groups go before `SET_VIEW` on every base ↔ DETAILS switch with proto 4.
6. `control-map.test.ts`: `base4`, `detail4`, `HELP_WORDS4` equal `fm1c_help.h`.
7. `device-protocol`: the 4 negotiation vectors.

### 6.6 Acceptance criteria

1. On Sessions and TO DO (v4), the selected chat's newest content shows without a press: caption + ≥ 100 characters
   (up to 140). LFO opens DETAILS with the last message first.
2. Each of the 9 states has its own character pose, and Claude and Codex are told apart by shape at 12×12 and at 48×48.
   This is checked by an operator review of `sprite-sheet-4x.png` and of the device photo.
3. Animation: hero ≤ 8 fps, minis 4 fps for attention states only; ≤ 2,400 px per pass; ≤ 34,000 px/s worst case; no
   animation while a host frame is queued, an ACK is pending, or 20 ms after host traffic.
4. Link: the §6.5 run shows 0 retransmissions and ACKs ≤ 15 ms with animation on.
5. Space: the static legend is gone. The knob row appears for 2 s after a knob turn. Knob names are in Help. Knobs
   never act; buttons act; the hint bar names them.
6. Compatibility: proto 3 (today's companion) draws exactly today's v3 screens. A v3 firmware with a v4 companion
   negotiates 3.
7. Flash ≤ 125 KB for the BLE image. RAM grows ≤ 256 B. Dinghy platform files are byte-identical.

---

## 7. Open gaps

- **No physical check yet.** The mocks are drawn with the firmware fonts and the RGB565 palette, but nobody has seen the
  characters on the real panel (gamma, viewing angle). Mid-greys (idle #707070, unknown #545454) may need tuning there.
- **Sprites are a first pass,** generated procedurally. A hand pass on the PNGs (§6.2) should come before
  implementation, mainly for the Claude working pose (the lid hides the mouth) and the 12×12 Claude ears.
- **Loop timing is not measured** on the AC79. The 2,400 px pass budget comes from the SPI rate (12 MHz) and the existing
  DMA + `LCD_IDLE` design. The §6.5 emulator run is the gate, and a host-mode pass timer would help.
- **No smaller font.** A 6×12 font (for example Terminus `ter-u12n`, about 3.4 KB) would give 38 characters per line
  and a 7-row bubble. It is not in the tree, so no mock uses it.
- **Simulator parity** (§6.4) is real work. Today the simulator is two layout versions behind.
- **"Latest messages" (plural)** is only the newest assistant message. A short history (the last 3) needs the adapter
  to keep more of the chat stream. Only B's transcript DETAILS would use it.
- **Banner size:** v4's 208×128 banner is larger than `CV_MAX` (240×80), so it is drawn as two strips. The other option is to raise
  `CV_MAX` in `console.c`. It is a build setting of our app, so the platform stays byte-identical.

---

## 8. LIST layout (protocol version 5)

Date: 2026-11-18. Status: spec; host side (agent-core, device-protocol, companion, companion-ui, simulator)
implemented and tested; the firmware host-mode shots `reports/evidence/ui-v3/after/host/v5-*.png` exist and the
simulator replays them pixel-identically (§8.9). Operator brief (approved
2026-11-18): direction B's chat list as a second layout of Sessions and TO DO, toggled with SEQ. Mocks:
`reports/evidence/ui-v3/b-chat-list/sessions.png` and `todo-approval.png`. This section is normative for the firmware,
the simulator and the companion.

### 8.1 What changes

- **SEQ** (button 11, unused until now) toggles the base view between **Buddy** (the §3.A screen, version 4) and
  **List** (below). Only Sessions (view 0) and TO DO (view 2) have a List layout. Tasks (view 1) stays Buddy.
- **The choice is per view and remembered** by the companion (`config.json` key `layouts`). Defaults: Sessions =
  Buddy, TO DO = List.
- **Same data, same order, same keys.** The list shows the keys of the page that is shown, in key order (F3 first),
  which is the frozen layout order of docs/ux-v2.md §3.4. A toggle never re-sorts, never changes the page and never
  changes the selection.
- **No new message type.** Version 5 adds one optional trailing byte to `SET_VIEW` (the layout) and two optional
  trailing strings to `SET_SLOT` (a row title and an age), because a 12-character slot label is too short for a row
  (§8.6). Everything else is the version 4 meaning.

### 8.2 Screen bands (240 × 240, List layout)

| Rows | Columns | Band | Contents |
| --- | --- | --- | --- |
| 0–17 | 0–239 | Top bar (18) | As version 4 (`fm1c_draw_status_in(m, 18, 1)`): title, page, link dot, badge |
| 18–59 | 0–28 | Hero (42) | Black. The selected chat's character, **24 × 24 at 1x** at (4, 26) (`SET_DETAIL.state` + `provider`, as the v4 hero, scale 1). No sprite for state `empty`. |
| 18–59 | 29–239 | Header bubble (42) | Black. A 1 px frame with cut corners, 204 × 40 at (34, 19) (x 34–237, y 19–58), drawn exactly like the v4 frame (`fm1c_v4_bubble_into` with x 34, y 19, w 204, h 40) in `fm1c_v4_bubble_col(m)`. **Tail** to the left, at the hero: for i = 0…4 the pixels (29 + i, 31) and (29 + i, 32 + i) in the frame colour, then x 34, y 32–36 black (the frame opens into the tail). **Caption** (row 0) in `FONT_S` at (40, 22) in `fm1c_v4_col(state)`; when a slot is selected, its key name (`FM1C_NOTE[k]`) right-aligned to end at x 231 (x = 232 − text_w) in `FM1C_C_GREY`. **Message line** (row 1) in `FONT_S` at (40, 38), ≤ 24 characters (192 px), colour `FM1C_STYLE_RGB[style]`. **More wedge**: when row 2 is non-empty, for i = 0…3 a white run at (224 + i, 55 + i), width 7 − 2i (it ends on the frame's bottom edge, as the v4 wedge does). Rows 19–58 hold nothing else. |
| 60–223 | 0–235 | List (164) | Black. 10 rows of 16 px at y<sub>n</sub> = 62 + 16n (n = 0…9; rows 62–221). Rows 60–61 and 222–223 stay black. Row format in §8.3. |
| 60–223 | 236–239 | Scroll column (4 × 164) | Black. When the page has more than 10 entries (L > 10): a thumb 2 px wide at x 237–238 in `FM1C_C_GREY`, y = 62 + 160·top / L, height 160·min(10, L − top) / L (integer division). |
| 224–239 | 0–239 | Hint bar (16) | As version 4 (`fm1c_draw4_hint`): the toast, else the knob row for 2 s after a K1–K4 turn, else `SET_DETAIL.line4`. |

There is **no key strip** and **no label beside the hero**: the key names on the rows and the key LEDs carry the
mapping, and the selected row carries the title.

### 8.3 Rows

**Which keys, in which window.** The entries are the keys k = 0…26 whose `SET_SLOT.state` is not `empty`, in
ascending k. L = their number. s = the index in that list of the key with flag bit 0 (selected), or none. The first
entry shown is top = 10 · floor(s / 10) when s exists, else 0. Row n shows entry top + n while top + n < L; the other
rows are black. (Windows of 10, so SELECT walks a whole window before the list moves, and the device needs no state
beyond the slots. The host's paging is unchanged: OCT± changes the 27-key page, the list then shows that page.)

**One row** (row-relative coordinates, origin (0, y<sub>n</sub>), a canvas of 236 × 16):

| x | What | Source | Colour |
| --- | --- | --- | --- |
| 0–235 | Background | flag bit 0 | selected: `FM1C_C_OUTLINE` RGB(48, 48, 48) over the whole row; else black |
| 4–15, y 2–13 | Mini 12 × 12 at (4, 2) | `SET_SLOT.state`, flag bit 1 (Codex), bit 2 (stale: the ghost pose with the disconnected palette) | as the keyboard mini (`fm1c_v4_mini`), frame `fm1c_anim_frame(pose, FM1C_ANIM_MINI, now)` |
| 15–16, y 1–2 | Pin dot 2 × 2 | flag bit 3 | white (the keyboard's `bx + 12, by` with the box at (3, 1)) |
| 20– | Key name (`F3` … `G5`, ≤ 3 characters) at (20, 0) | `FM1C_NOTE[k]` (firmware-local) | selected: white; else `FM1C_C_GREY` |
| 48–207 | Title (≤ 20 characters) at (48, 0) | `SET_SLOT.title` (version 5, §8.6) | stale: `FM1C_C_GREY`; selected: white; else `FM1C_C_TEXT2` |
| ≤ 232 | Age (≤ 3 characters), right-aligned: x = 233 − text_w(age) | `SET_SLOT.age` (version 5) | selected: white; else `FM1C_C_GREY` |

Text is `FONT_S` (8 × 16, alpha onto the canvas as everywhere). An empty title draws nothing (the host never sends
one for a non-empty slot). The state colour is carried by the mini and the key LED, not by the text.

### 8.4 Header content (host)

`SET_TEXT` rows in the List layout (version 5, views 0 and 2 with layout 1):

| Row | Meaning |
| --- | --- |
| 0 | The caption, exactly as version 4 (`bubbleCaption`: `<State words>, <age>`, ≤ 20) |
| 1 | The message line: the bubble body (`bubbleLines`, newest content first) **wrapped at 24** (`LIST_HEAD_COLS`), the line at the PRESETS scroll position |
| 2 | The next body line, or `""` (non-empty draws the more wedge) |
| 3–11 | `""` |

Nothing selected: row 0 `""`, row 1 muted `Turn SELECT or tap a key` (24), row 2 `""`. `SET_DETAIL` is as version 4:
provider and state name the hero, `line1` is the rest of the title (the device does not draw it in the List layout),
`line2`/`line3` `""`, `line4` the hint line (§8.8).

### 8.5 Controls and interactions

| Input | List layout |
| --- | --- |
| SEQ (down) | Toggle Buddy ↔ List for the shown base view (Sessions or TO DO) and save the choice. Tasks: toast `No list in Tasks`, nothing else. DETAILS, voice, confirm: nothing. Selection, page, frozen layout unchanged; the PRESETS scroll resets to the newest line. Version ≤ 4 agreed: SEQ stays unused. |
| SELECT | Moves the selection as in Buddy (host, across pages in layout order). The device moves the highlight and the window. |
| OCT− / OCT+ | Page, as in Buddy (27 keys per page). The list shows the new page's entries. |
| PRESETS | Scrolls the header's message line **one line per step** (Buddy: 5 rows per step), clamped to the last line; reset on a selection change, as in Buddy. |
| LFO | Opens DETAILS (view 5, drawn exactly as version 4); LFO or HOME closes it, back to the List. |
| Keys, ALGORITHM, SAVE, FX, ENV, PLAY, REC, HOME/EDIT/GLO, K1–K4 | As in Buddy. |
| SCL hold | The help overlay as version 4 with `FM1C_HELP_BASE5` (§8.8). |

- **Frozen layout** (docs/ux-v2.md §3.4): rows follow the keys, so a state change updates its row in place; a re-sort
  (HOME/GLO again, KNOB1–3, auto after 60 s) re-lays the keys and the rows follow. The list never sorts on its own.
- **Voice and confirm** are drawn as version 4 (hero + bubble), whatever the layout; when they end, the List comes
  back. **DETAILS** is the version 4 page. **No companion**: the version 4 banner over the dimmed List.
- **Key LEDs** are unchanged. **SEQ LED**: full while a List layout is shown (proto ≥ 5, view 0 or 2, layout 1), else
  off.
- **Animation**: the hero box is 24 × 24 at (4, 26) at the pose's fps (≤ 8 fps: 4,608 px/s). The minis of the visible
  rows animate at 4 fps in the attention states (≤ 10 × 144 × 4 = 5,760 px/s); a mini in the selected row is redrawn
  on the row colour (`cv_begin(12, 12, FM1C_C_OUTLINE)`), and a pinned one sets its pixel (11, 0) white, as on the
  keyboard. Keys outside the window are not animated. Worst case ≈ 10,400 px/s, under the version 4 budget; the
  scheduler (`anim_ok`, `FM1C_ANIM_PX_PASS` 2,400) is unchanged, so the heartbeat (1,000 ms) and ACK (≤ 15 ms) gates
  of §6.5 apply as they are.
- **Redraw regions** (each its own blit, with the link's turn between regions as `fm1c_draw4` does): hero 29 × 42,
  header bubble 211 × 42 (or the caption, message and wedge strips alone), each list row 236 × 16 (3,776 px), the
  gap strips, the scroll column 4 × 164, the hint bar. A slot change marks its row; a change of occupancy (empty ↔
  not) or a selection change that moves the window marks every row and the scroll column; a selection change inside
  the window marks the old and the new row. A `SET_VIEW` whose layout changes marks every band from row 18. In the
  Buddy layout a `SET_SLOT` that changes only `title` or `age` marks nothing.

### 8.6 Protocol: version 5 (additive)

Version 5 includes every version 4 rule and adds two optional trailing fields. The host sends them **only when
version 5 was agreed**; with 4 or lower it sends exactly the version 4 content (and SEQ does nothing), so firmware on
versions 1–4 never sees them. A version 5 decoder accepts both body forms in every negotiated version (decoding does
not depend on the version), as version 3 did for `SET_TEXT`.

| Message | Version 5 body | Rules |
| --- | --- | --- |
| `SET_VIEW` (0x42) | `enum view`, `u7 page`, `u7 pages`, `str title` (≤ 20), **`enum layout`** (0 buddy, 1 list) | The layout byte is optional (absent = buddy). Bad body: a value > 1, or any byte after it. With version 5 the host always sends it: the base view's layout in views 0 and 2, 0 in every other view. The device draws the List only in views 0 and 2. |
| `SET_SLOT` (0x43) | `u7 key`, `enum state`, `u7 flags`, `str label` (≤ 12), **`str title` (≤ 20)**, **`str age` (≤ 3)** | Title and age come together or not at all. Bad body: a title longer than 20 or an age longer than 3, a byte outside 0x20–0x7E, a title without an age, a string running past the body, or bytes left over. With version 5 the host always sends both, in every view and layout (so a toggle needs no slot traffic). Largest body: 3 + 13 + 21 + 4 = 41 bytes. |

Host field content (agent-core `view.ts`): **title** = the session title (TO DO: the item's session title, else its
summary; Tasks: the task title), ASCII, cut at a word boundary to 20 (`cutWords`), `(untitled)` when empty. **age** =
`ageText` of the same instant as the bubble caption (the pending approval's `createdAt`, else the session's last
activity; Tasks: the task's `updatedAt`), `""` for a stale chat, at most 3 characters (`now`, `59m`, `47h`, `13d`,
`99w` as the cap). The host recomputes ages on its 5 s tick; a changed age is one coalesced `SET_SLOT`.

Order rule (extends §5): every switch between a base view and view 5 **and every layout change** sends all four
`SET_TEXT` groups before `SET_VIEW`, because rows 1–2 mean different things in the two layouts (24 against 28
columns).

Selection rule (host, every version): the `SET_SLOT`s of one view change leave in one coalescer flush, and a slot
that becomes selected goes before the one that is deselected, so the device never draws a moment with no selection
(the List window would jump to the first 10 and back). A confirm over the List is the version 4 bubble (rows wrapped at
28), and a PRESETS step never carries between the List header (lines) and the bubble (5-row steps).

Constants: device `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 5`; host `PROTOCOL_VERSION 5`, `LIST_VERSION 5`,
`HOST_VERSIONS = { min: 1, max: 5 }`. Negotiation vectors (`fixtures/device/vectors.json`): `v5_device_v5_host` 1–5 /
1–5 → 5; `v4_device_v5_host` 1–4 / 1–5 → 4; `v5_device_v4_host` 1–5 / 1–4 → 4; `v1_device_v5_host` 1–1 / 1–5 → 1.
Frame vectors, valid: `set_view_list` (sessions, layout list), `set_view_todo_buddy` (inbox, layout byte 0),
`set_slot_list_row`, `set_slot_list_max` (label 12, title 20, age 3, all flags), `set_slot_list_empty_strings`,
`set_slot_list_truncated` (title 25 → 20, age 5 → 3; `decoded` differs). Invalid (all `bad_body`):
`set_view_layout_2`, `set_view_layout_extra_byte`, `set_slot_title_21`, `set_slot_age_4`, `set_slot_title_no_age`,
`set_slot_list_extra_byte`. Vector JSON: `"layout": "buddy" | "list"` on `SET_VIEW`, `"title"` and `"age"` on
`SET_SLOT`, each present only in the version 5 form.

Rejected alternatives: **`SET_TEXT` rows as list rows** (rows 2–11 = 10 titles) needs both sides to agree on which
key each row is, so every SELECT that moves the window would resend rows, and the rows could show the previous
window during a burst. **New view values** (6 = sessions list, 7 = TO DO list) would split every view check in the
firmware (LEDs, help, input) for a drawing choice. **A firmware-local toggle** could not be remembered per view
across reconnects or shown in the companion.

### 8.7 Persistence (companion)

`config.json` gets `"layouts": { "sessions": "buddy" | "list", "inbox": "buddy" | "list" }`, validated (unknown keys
and other values are refused), default `{ "sessions": "buddy", "inbox": "list" }`. The companion writes it only when
it differs from the default, so a config saved by this companion stays readable by an older one unless the operator
changed a layout (an older companion refuses unknown keys). `AgentConsole` takes `layouts` and `onLayoutsChanged`,
like `pins`.

### 8.8 Hint line and help

- **Hint line** (`SET_DETAIL.line4`, ≤ 20) with version 5 in Sessions and TO DO: the pair `SEQ list` (Buddy) or
  `SEQ buddy` (List) is appended **last**, so `hintLine` drops it first when the line would pass 20 characters
  (`REC reply  SEQ list` fits, `REC reply  PLAY open` stays as it is). Nothing selected: `SEQ list  SCL help` /
  `SEQ buddy  SCL help` instead of `Hold SCL for help`.
- **Help** (`fm1c_help.h`, new table, used in every base view when proto ≥ 5; `FM1C_HELP_BASE4` is unchanged for
  version 4). The first line becomes the SEQ line; the hint bar already says `let go of SCL to close`. The two knob
  lines and the who-is-who grid follow as in version 4.

```c
static const char *const FM1C_HELP_BASE5[6] = {
    "HELP - SEQ list/buddy",
    "SELECT move  PRESETS scroll",
    "key tap select  2x open",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
};
```

The host mirrors it as `HELP_TEXT.base5`; `test/control-map.test.ts` requires byte equality with `fm1c_help.h`
once the table is there.

### 8.9 Tests and evidence

Host (bun): codec round trip and the vectors of §8.6; the four negotiation vectors; `view.ts`: version 5 slots carry
title ≤ 20 and age ≤ 3, version 4 slots carry neither and are byte-equal to before; the controller: SEQ toggles in
Sessions and TO DO, keeps selection, page and frozen order, does nothing with proto ≤ 4, toasts in Tasks; TO DO
defaults to List and Sessions to Buddy; PRESETS steps one line in List; `render.ts`: all four `SET_TEXT` groups go
before `SET_VIEW` on a layout change, `SET_VIEW` carries the layout only with version 5, `framesFor` strips the
version 5 fields for a device below 5; config: `layouts` validated, saved only when not default; help equality.
Simulator: `renderV4` draws §8.2–8.3 from the same state; a replay test feeds the firmware's version 5 scenarios
through the codec and compares with `reports/evidence/ui-v3/after/host/v5-*.png` once they exist.

Firmware scenarios and shots (names the simulator replay test looks for): `v5-list-sessions` (shot
`v5-list-sessions` at 1,500 ms), `v5-list-todo` (`v5-list-todo` at 1,700 ms, an approval selected), `v5-list-toggle`
(`v5-list-toggle-buddy` at 1,000 ms, then `SET_TEXT` ×4 + `SET_VIEW` layout list, `v5-list-toggle-list` at 1,500 ms),
`v5-list-window` (`v5-list-window` at 1,500 ms: 14 entries, the 12th selected, so top = 10 and the thumb shows),
`v5-help` (`v5-help` at 1,600 ms, SCL held). Each scenario starts with `HELLO_ACK` proto 5, as the v4 ones do with 4.

Host status (2026-11-18): `PROTOCOL_VERSION 5`, the 4 negotiation and 12 frame vectors; `SetView.layout`,
`SetSlot.title`/`age` (optional, both-or-neither on the wire); `ControllerState.listLayout`/`screen`, SEQ in
`controller.ts`, `screenOf`, `listHeadRows`, `rowTitle`/`rowAge`, the SEQ hint pair and `HELP_TEXT.base5`;
`render.ts` sends the layout byte and row fields only with 5 (`framesFor` strips them below 5, coalesced slots
included) and treats a layout change as a switch for the order rule; config `layouts` (saved only when not the
default) and a Buddy/List choice per view in the desktop UI's config form. Simulator: `listScreen` in
`v4/screen.ts`, SEQ LED, `SIM_VERSIONS` 1–5; `test/v5-firmware-parity.test.ts` replays the firmware's v5 scenarios
(sessions, TO DO, toggle, window, page, DETAILS, voice, animation, help: 22 shots) with 0 differing pixels. The
who-is-who minis of the help now stand still in the simulator too (the firmware draws frame 0).

### 8.10 Open points

- Ages tick every 5 s on the host side, so an age can be up to 5 s late; the caption has the same lag today.
- The window of 10 jumps by whole windows. A scrolling window (keep the selection on row 4) is a firmware-only change
  if the operator prefers it; the host does not depend on it.
- Tasks has no List layout (brief). Adding it later needs only the host to send layout 1 in view 1 and the firmware
  to accept it there.

## 9. GROUPED list, PINNED scope, LEDs v2, reader and transitions (protocol version 5 additions)

Date: 2026-11-18. Status: spec (normative for the firmware, the simulator and the companion); host side implemented with
this section (§9.14 says what is tested where). Operator brief (approved 2026-11-18): "GROUPED list" with its pins,
LED, scroll-to-fullscreen, transition and PINNED parts. Version 5 has not been flashed to the operator's unit (it runs
version 4 Buddy), so this round **extends version 5 additively** instead of adding version 6: two optional SET_SLOT
fields and one more SET_VIEW layout value. Everything of §8 stays valid unless this section says otherwise.

The adapter step (2026-11-18, after this round) filled the hooks of §9.7: the Traycer adapter fetches pinned sessions
outside its 25-task scan (`fetchPinned`), reads Traycer's parent/child agent links (`Session.parentKey`), reads terminal
sessions' transcripts for their details, and the console side of terminal-agent a2a (`Session.prompt`,
`details.reply`) is in place. Host notes in §9.7 and §9.15.

### 9.1 Layouts and SEQ

| View | SEQ cycle (button 11, down) | Default | Remembered |
| --- | --- | --- | --- |
| Sessions (0) | Buddy → List → Grouped → Buddy | **Grouped** | companion `config.json` `layouts.sessions` |
| TO DO (2) | Buddy ↔ List (no Grouped) | List | `layouts.inbox` |
| Tasks (1) | toast `No list in Tasks` | Buddy | - |

- **Buddy ↔ List** never re-sorts (§8.1, unchanged). **Into or out of Grouped** the key order changes (headers and
  task order, §9.2), so it is a re-sort of Sessions: the selection is kept by identity and the page becomes the page
  that holds the selected key (page 1 when nothing is selected or the selection is off the layout). No toast.
- SEQ resets the bubble scroll to the newest line (as §8.5). SEQ does nothing in DETAILS, voice and confirm, and
  nothing with protocol ≤ 4.
- With protocol ≤ 4 a remembered `grouped` (or `list`) draws Buddy and lays keys out flat, exactly as before.

### 9.2 The Grouped frozen layout (host, `agent-core`)

Grouped changes **only the order** of the frozen layout (docs/ux-v2.md §3.4) and adds folded task rows; the re-sort
triggers, the reserved keys 24–26, arrivals, `+N new` and paging stay as they are. It is built by
`groupedLayout()` in `focus.ts` whenever Sessions is shown Grouped with protocol 5.

**Groups, in this order** (operator decision 2026-11-22, docs/ux-v2.md §3.5: pins > need you > rest, by group):

1. **Pinned** (when ≥ 1 pinned session is shown): every pinned session, whatever its tier and whatever SHOW says
   (respecting REPO and TASK), in priority order (tier, then the §3.2 within-tier rule), so the pins that need you lead
   it. Always expanded. A pinned session is always taken out of its task group, also when it needs you.
2. **Tasks that need you:** the task groups of the scope (SHOW, REPO, TASK) with at least one T0–T3 session that is not
   pinned, ordered by best tier (§3.2), newest activity, title, task key. Each holds its sessions in the scope that are
   not pinned, by tier (`compareFocus`).
3. **The other tasks** of the scope, same order and rules as part 2.
4. **New** (between re-sorts only): sessions placed later into a free key (arrivals, §3.4) form their own group
   `New`, whatever task they belong to. The next re-sort moves them into their task.

Task pins take no session key: a pinned task is ordered like any other task (its header carries the pinned flag). The
PINNED scope (§9.4) is the exception that lists each pinned task as a folded row. (2026-11-19 to 2026-11-22 the task
groups that need you came first, then the Pinned group without the pins that need you, which stayed in their task group;
until 2026-11-19 the Pinned group came first and each pinned task followed as its own expanded group with every live
session.)

**Sub-agents.** A session whose optional `parentKey` (a session key, same task) names a session of the same group is
placed right after its parent (after the parent's earlier children), at indent 2, siblings by tier. A child whose
parent is not in the group (out of scope, gone) is an ordinary member at indent 1. Only one level is drawn: a
grandchild is indented 2 like its parent. The Traycer adapter fills `parentKey` from the agent records (§9.7).

**Collapse.** A task group with no T0–T4 session **folds**: none of its sessions takes a key; the task takes **one key
of its own**, the folded task row (§9.3). Never folded: the tasks that need you (they have a T0–T3 session), the
Pinned group, the task of the TASK filter, and every group in the PINNED scope. In ACTIVE no group folds (every task shown has a T0–T4 session).

**Keys.** The group order is flattened into keys: sessions and folded task rows, in order; headers of expanded groups
take **no key** (they are drawn by the device before the first key of their group). Page 1 still takes 24 keys
(keys 24–26 stay free for arrivals), later pages 27. The layout records each key's group (`LayoutData.groups`), so
between re-sorts a key keeps its group and an arrival is `New`.

**Header text** (host): title = the task title, `Pinned` or `New`, ASCII, cut at a word boundary to
`min(20, 25 − count length)` characters. Count (≤ 11): `<n> need you` (n = T0–T3 sessions of the group), else
`<n> working` (state working), else `all quiet`; a folded task says `<n> quiet` (its sessions in the scope); n is
capped at 99. Header state = the most urgent display state of the group's sessions (`URGENCY`), `idle` when it has
none. Header pinned flag = a pinned task, or the Pinned group.

**Selection.** SELECT and ALGORITHM move over session keys only: folded task rows (and header rows) are skipped. A
key tap on a folded task row sets the TASK filter to that task (and REPO to its repo), re-sorts, and toasts
`Task: <title>` (the KNOB3 toast); the task is then expanded (the TASK filter task never folds). A tap on the same
folded row when its task already is the filter clears it (`Task: all`). Double tap: nothing. Long press: pin or
unpin the task (§9.7).

### 9.3 The Grouped screen (device, view 0 with layout 2)

Bands, hero, header bubble, scroll column, hint bar and the 10 rows of 16 px at y<sub>n</sub> = 62 + 16n are exactly
§8.2. Only the entries and the row formats change.

**Entries.** For each key k = 0…26 whose slot is not `empty`, in ascending k: when `row.start` (§9.5) is set, a
**header entry** (k, H); then, unless `row.task` is set, a **session entry** (k, S). L = the number of entries. s =
the index of the session entry of the selected key (flag bit 0), or none. top = 10 · floor(s / 10) when s exists,
else 0; the rows show entries top … top + 9 (windows of 10, as §8.3). Thumb as §8.2, with this L.

**Header row** (row-relative, 236 × 16, entry (k, H)):

| x, y | What | Colour |
| --- | --- | --- |
| 0–235, all | Background | black |
| 0–235, y 0 | Rule (1 px) | `FM1C_C_OUTLINE` RGB(48, 48, 48) |
| (4, 2) | Mini 12 × 12 of `head.state`, **frame 0** (headers never animate), Claude species | sprite palette of the state |
| (15, 1) | Pin dot 2 × 2 when `head.pinned` | white |
| expanded: (20, 0); folded: key name `FM1C_NOTE[k]` at (20, 0) and the title at (48, 0) | Title `head.title`, at most `(xc − 8 − x0) / 8` characters (x0 its x, xc below) | expanded: white; folded: key name `FM1C_C_GREY`, title `FM1C_C_TEXT2` |
| xc = 233 − text_w(count) | Count `head.count`, right-aligned to end at x 232 | `fm1c_v4_col(head.state)` (the caption colour: calm states grey) |

A folded row is never selected (the host never sets bit 0 on it); its key LED follows its slot state (§9.9).

**Session row** (entry (k, S)): exactly §8.3, with every x of the mini, the pin dot and the key name and the title
shifted right by d = 8 · `row.indent` (indent 1: mini at 12, key name at 28, title at 56). The background (full row)
and the age (right-aligned at 233) do not move. The host cuts the title to 20 − indent characters, so it never
reaches the age.

**Redraw marks.** A `SET_SLOT` that changes occupancy, `row` or `head` marks every row and the scroll column (the entry
list changes); one that changes only state, flags, title or age marks its own entries (one or two rows); a selection
change marks as §8.5. A `SET_VIEW` whose layout changes marks every band from row 18 (it starts the layout wipe,
§9.10). Animation of the minis in session rows as §8.5; header minis never animate.

**Layout byte 2 elsewhere.** The device draws Grouped only in view 0. Layout 2 in view 2 draws the List; in other
views it draws as layout 0.

### 9.4 PINNED scope

- **KNOB1 SHOW** cycles ACTIVE → RECENT → ALL → **PINNED** (stops at the ends, as today). Toast `Show: pinned (<n>)`.
- **Contents** (since 2026-11-19): every live pinned session, across all repos and tasks, all tiers, on as many pages
  as needed (no pin limit, safety cap 200 per kind). A task pin takes no session key: Grouped PINNED lists each pinned
  task as one folded row after the session pins (count `<n> quiet` / `no chats`), so every pin can be seen and unpinned;
  Buddy and List show only the session pins. It **ignores REPO and TASK**: the legend cells of KNOB2 and KNOB3 are `""` while PINNED is shown, and turning
  them does nothing.
- **Order:** the pins that need you (T0–T3) first, then the other pins. Grouped: as §9.2 (one Pinned group with every
  session pin, need you first, then the pinned tasks' folded rows); nothing else folds. Buddy and List: flat, priority
  order (need you first). (2026-11-19 to 2026-11-22 Grouped put task groups that need you before the Pinned group; until
  2026-11-19: Pinned group, then pinned tasks expanded; Buddy/List the Grouped order flattened.)
- **Title** `PINNED <n>` (n = the sessions shown), plus ` +N new` as other scopes.
- **Empty state** (no pins, or none live): no keys. Bubble/header row 0 (caption) `No pins yet`, row 1 (muted)
  `hold a key to pin` (the operator's sentence `No pins yet - hold a key to pin` split at the dash: 31 characters fit
  neither the 24 columns of the header line nor the 28 of the bubble). Hint line: `SEQ <next>  SCL help` as with no
  selection.
- Remembered like the other scope values: in `ControllerState`, across view switches, not across restarts.
- **Between re-sorts** only a pinned session arrives (§3.4 arrivals; since 2026-11-19 not a session of a pinned task), whatever REPO and
  TASK hold; the title carries no REPO/TASK name.
- **Tasks view** under PINNED: the pinned tasks and the tasks of pinned sessions, across repos (KNOB2 empty there too;
  ALGORITHM sees them all). A task tap there leaves PINNED for **ALL** with that task as the filter (PINNED would
  ignore it). A tap on a folded `no chats` row in Grouped PINNED does nothing (it would only set a hidden TASK
  filter); its long press unpins.

### 9.5 Protocol: version 5 additions

Still `PROTOCOL_VERSION 5`, `HOST_VERSIONS 1–5`, device `FM1C_PROTO_MAX 5`. Additive over §8.6; the host sends the new
forms only when 5 was agreed and only where this table says; a decoder accepts every form in every negotiated version.

| Message | Addition | Rules |
| --- | --- | --- |
| `SET_VIEW` (0x42) | `enum layout` gets value **2 grouped** | Bad body: a value > 2, or any byte after it. The host sends 2 only in view 0 while Sessions is Grouped. |
| `SET_SLOT` (0x43) | After `str title`, `str age`: optional **`u7 row`**, then, only when row bit 2 is set, **`enum head_state`**, **`u7 head_flags`**, **`str head_title` (≤ 20)**, **`str head_count` (≤ 11)** | row: bits 0–1 indent (0–2; 3 is bad), bit 2 `start` (a header row is drawn before this key's row; the head fields follow), bit 3 `task` (folded task row: the key draws only its header row; needs bit 2), bits 4–6 must be 0. head_flags: bit 0 pinned; other bits must be 0. Bad body: any rule above broken, a head field missing, a longer string, bytes left over. The row byte needs title and age before it. Largest body: 3 + 13 + 21 + 4 + 1 + 1 + 1 + 21 + 12 = **77** bytes. |

- **When the host sends `row`:** on every `SET_SLOT` of view 0 while the Sessions layout is Grouped (an empty slot:
  row 0, no head), also while DETAILS, voice or confirm is drawn over Sessions (the keys stay; the device keeps the
  fields and draws them when view 0 returns, without a resend of all 27 slots). Never in other base views or layouts (absent = indent 0, no header), so the §8.6 vectors and every version 5
  List/Buddy body stay byte-equal.
- **`start`** is set on the first key of each group **on each page** (a group continued from the previous page
  repeats its header), on every folded task row, and on the first `New` key. head_state/head_flags/head_title/
  head_count are the group's (§9.2). For a folded row the slot itself carries the task: state = head_state, flags 0,
  label = the title head (12), title = the task title (`rowTitle`), age = the age of the task's newest activity.
- **Order rule** (§8.6) holds: a layout change sends all four `SET_TEXT` groups before `SET_VIEW`; the slot frames of
  the re-sort follow in one coalescer flush.
- Vector JSON: `"layout": "grouped"`; on `SET_SLOT` `"row": {"indent": 0|1|2, "start": bool, "task": bool}` and, with
  start, `"head": {"state": "<slot state>", "pinned": bool, "title": "...", "count": "..."}`.
- Vectors (`fixtures/device/vectors.json`): valid `set_view_grouped`, `set_slot_group_header` (start, indent 1, head),
  `set_slot_group_member` (indent 1, no head), `set_slot_group_child` (indent 2), `set_slot_group_folded` (start +
  task, indent 0), `set_slot_group_max` (label 12, title 20, age 3, head title 20, count 11, all flags),
  `set_slot_group_truncated` (head title 26 → 20, count 14 → 11; `decoded` differs). Invalid (all `bad_body`):
  `set_view_layout_3` (**replaces** `set_view_layout_2`, which is now valid as `set_view_grouped`),
  `set_slot_row_indent_3`, `set_slot_row_bit4`, `set_slot_row_task_no_start`, `set_slot_head_missing`,
  `set_slot_head_flags_2`, `set_slot_head_title_21`, `set_slot_head_count_12`, `set_slot_group_extra_byte`,
  `set_slot_row_no_start_extra`.

Rejected alternatives: **header rows in `SET_TEXT` rows 3–11** carry no state colour and only 9 rows per page, and a
re-sort would have to keep both message kinds in step; **a new message type** (`SET_GROUP`) changes the
`type_0x4d` vector and needs its own coalescing; **a header key per group** costs keys on page 1 (ACTIVE today: 20
sessions in 8 tasks would need 28 keys, two pages) and the brief says headers have no key. Folded tasks do take a key:
without one a collapsed task could not be reached or pinned.

### 9.6 Pins v2

> **Updated 2026-11-19 (operator decision "no limit"; docs/ux-v2.md §3.5 is the full rule).** The 9-pin limit is gone.

- **No limit; a safety cap of 200 per kind** (`MAX_PINS_PER_KIND`), session pins and task pins counted apart. Toasts only
  at the cap: `Pins full (200)` (a session pin) and `Task pins full (200)` (a task pin, 20 characters). Help and hint lines
  name no limit and stay byte-equal with `fm1c_help.h` (no firmware change).
- **Session pin:** key long press on a session in Sessions (any layout) or TO DO. Toasts `Pinned` / `Unpinned`.
- **Task pin:** key long press on a folded task row (Grouped), on a task in the Tasks view, or on a SPLIT task key.
  Toasts `Task pinned` / `Task unpinned`. The header of an expanded group has no key, so an expanded task is pinned from
  the Tasks view or from its folded row (§9.15 records this against the brief).
- **Where pins show:** every Sessions layout orders the pinned sessions first (whatever their tier; operator decision
  2026-11-22), then the other sessions that need you (T0–T3), then the rest. Buddy and List: session by session (pins whatever SHOW says, respecting REPO and TASK). Grouped: by group
  (§9.2). PINNED: §9.4. **Task pins never take a session key**: they order only the SPLIT task row (pinned tasks first,
  §10.4) and mark the task (flag bit 3 on its folded row or task chip, pinned flag on its header). Slot flag bit 3 on a
  session means a session pin (a session of a pinned task no longer carries it). Pinning re-sorts (as today).
- **Persistence:** `config.json` `sessionPins: string[]` (5-part keys) and `taskPins: string[]` (4-part keys), each ≤ 200,
  validated, each written only when not empty. A legacy `pins: string[]` (one mixed list) is read and split by key shape,
  every pin kept, and never written again. An older companion refuses `sessionPins` / `taskPins` (only once a pin is
  saved).
- **Dropping pins:** with an adapter that implements `fetchPinned` (§9.7; the Traycer adapter does), a pin is dropped
  only when the adapter reports it gone (deleted or archived in Traycer). Without it (the mock) the old rule holds: a
  pin whose session (or task) is missing after a full snapshot is dropped.
- **Pins outside the scan** are fetched in bounded, slow batches: the pins of at most 25 tasks per `fetchPinned` call;
  one call per resync, then one every 5 s until every out-of-scan pin was asked for once, then one every 120 s round robin
  (docs/traycer-integration.md, "Pins outside the scan").

History: 2026-11-18 `MAX_PINS 9` (keys 0–8 of page 1), session and task pins together, `Pins full (9)`; pinned sessions
first in pin order, then every session of each pinned task.

### 9.7 Host plug-ins for the adapter step

- `Session.parentKey?: string`: the session key of the parent agent (same task). Validated as a non-empty string ≤ 1024;
  a self-reference or a key of another task is ignored by the grouping.
- `AgentAdapter.fetchPinned?(req: { sessions: SessionRef[]; tasks: TaskRef[] }): Promise<{ sessions: Session[];
  tasks: Task[]; gone: string[] }>`: optional. The console asks for the pinned sessions that the last full snapshot did
  not list and for the pinned tasks with no session in it, in batches of at most 25 tasks (one at each resync, then on
  the slow cadence of §9.6); the returned sessions and tasks are upserted (validated like snapshot entries), `gone` keys
  are unpinned. A rejected call keeps every pin.

**Host notes, adapter step (2026-11-18).**

- **Traycer `fetchPinned`:** reads the agents of every task that holds a pin (`epic.listChatRecords` +
  `epic.listTuiAgents`, the scan's own calls) and returns the pinned sessions and every session of each pinned task. A
  pin is `gone` only when Traycer says so: the agent is missing from its task's listing (deleted) or archived, or the
  task is missing from a complete `epic.listTasks` listing. Another host's session, an unreadable task or a partial
  task listing keeps the pin. It rejects while the host is disconnected (the console keeps every pin).
- **Traycer `parentKey`:** chat records carry `parentChatId`, TUI agents `parentId` (the spawning agent, e.g. the a2a
  sender of `agent.create`); both become the parent's session key in the same task (any agent kind may be the parent;
  a self-reference is dropped). Measured read-only on the live host (25 scanned tasks, 278 sessions): 242 have a
  parent, 241 of them listed in the scan; 24 distinct parents (one orchestrator per task, fan-out up to 51); depth
  1 for 214, 2 for 26, 3 for 1. The Grouped list draws one level (§9.2), so deeper agents sit at indent 2.
- **`Session.prompt`** (`PromptCapability`: `acceptsPrompt`, `reason`, device `line` ≤ 28, `toast` ≤ 20; validated,
  extra adapter fields dropped): with `acceptsPrompt: false` the hint shows no REC for a reply, REC is refused with
  `toast` (else `Can't take prompts`) before any recording, the dispatcher refuses such a target (`unsupported`, the
  reason), and the bubble and DETAILS lead with the muted `line` (else `No prompts from the console`). Traycer: a Codex
  or other non-Claude terminal says `Codex terminal: open on Mac` / `Terminal: use Mac`; a Claude terminal with no
  sender for its task `Terminal: no FM-1 sender` / `No sender for task`; a lost route `Prompts unavailable here` /
  `Not supported`.
- **`details.reply`** (the answer to a console prompt) is shown as the newest message in the bubble and DETAILS when
  it is at least as new as `lastMessage`; **`details.lastPrompt`** (terminal transcripts) is a muted `Prompt: ...` in
  DETAILS. A voice prompt that resolves `sent` with a reason toasts `Queued, undelivered` (docs/ux-v2.md §1.5).
- **Terminal transcripts:** the selected terminal session's `agent.getTranscript` is read on selection, every 15 s
  while selected and on a state change (at most one extra read per 2 s); only its last 64,000 characters are parsed
  (last `<assistant_response>` → `lastMessage` ≤ 600, last `<user_message>` or a2a prompt → `lastPrompt` ≤ 200;
  markdown stripped, secrets redacted, ASCII). Live read-only check on the operator's terminal session 848e2ae1:
  125,449 characters read in 1.2 s, `lastMessage` 526, `lastPrompt` 196, summary 118 characters.
- **Backend name:** `AgentAdapter.displayName` (Traycer: `Traycer`; agent-core `backendName` falls back to the id,
  ASCII ≤ 12) names the backend in `<name> offline`, `<name> limited`, `Gone from <name>`. The mock says `Traycer`
  (its fixtures are Traycer-shaped).

### 9.8 Scroll opens the reader

- **PRESETS** in Sessions or TO DO (Buddy, List or Grouped) with a chat selected and protocol 5 opens the fullscreen
  DETAILS reader (view 5, drawn as version 4) on **page 0**: the newest message first. The turn that opens it counts
  as its first step: page 0's body (9 rows of 29) already continues past what the bubble (5 rows) or the header line
  showed; a turn back (−1) opens page 0 too (there is nothing newer). The reader opens with the outline transition
  (§9.10). Nothing selected: PRESETS does nothing. Tasks: PRESETS scrolls the task bubble as before; voice: scrolls
  the transcript as before.
- **In the reader** PRESETS and OCT± turn pages (as DETAILS today, with the page scroll transition).
- **Return:** LFO or HOME closes the reader to the layout the operator came from (the view and its layout never changed
  underneath); the selection stays, the bubble/header scroll is reset to the newest line.
- **Auto-return:** after 20 s without device input while the reader is shown (protocol 5), the host closes it as LFO
  would. The companion's 5 s housekeeping tick checks it, so the return comes 20–25 s after the last input. Never while
  voice or confirm is up (they are drawn over it), never while SCL is held.
- With protocol ≤ 4 PRESETS scrolls the bubble as before and there is no auto-return.

### 9.9 LED language v2 (protocol 5)

The FM-1 LEDs are on/off in a ~910 Hz scanned matrix with three layers: **lit** (`fm1_led`, full), **glow**
(`fm1_led_dim`, `FM1_GLOW_NS` 8,000 ns a frame, set in console.c; the HAL default is 4,000) and **backlight** (`fm1_led_bg`, `fm1_led_bg_ns`, one value for every
LED in the layer). `hal/fm1_input.h` is not changed; the firmware uses only those public variables. All patterns run
off one clock (`fm1_ms`), phase = ms mod period, so keys in the same state blink together. Below, L = lit, G = glow,
O = off, B = backlight (breathing).

**Unselected keys** (first matching row wins):

| Condition | Period (ms) | Timeline |
| --- | --- | --- |
| empty, disconnected | - | O |
| stale (flag bit 2) | 4000 | G 0–149, O 150–3999 (a glow wink) |
| approval_required | 500 | L 0–249, O 250–499 (sharp 2 Hz) |
| waiting_input | 1260 | L 0–119, G 120–239, L 240–359, G 360–1259 (double blink) |
| failed | 3000 | G 0–1499, O 1500–2999 (slow glow/off blink; the triple flash was harsh with many failed keys, operator 2026-11-19) |
| completed_unread | 2500 | L 0–149, G 150–2499 (tick) |
| working | - | L |
| idle, completed_read | - | G |
| unknown | 3000 | O 0–149, G 150–2999 (off-wink) |

**Selected key** (flag bit 0): the **only** LED in the backlight layer (B) and **breathing**; in the L windows of
approval_required and waiting_input (the table above) it is lit instead: their blink breaks through. Selected failed
dips to O for 300 ms at the bottom of each breath (2850–149 of 3000 ms). Stale or not, every other selected state is B all the time. No host: every key G, the kept selection B.

**Breathing** (revised 2026-11-19, operator: "don't go to 0, make it apple smooth"). The main loop sets
`fm1_led_bg_ns = FM1C_BREATH_NS[i]` whenever `ms / 20` changes: p = (ms / 20) mod 150, i = p ≤ 75 ? p : 150 − p
(period 3,000 ms, about a calm breath). The table is a raised cosine in perceived brightness: with a = 12000^(1/2.2),
b = 48000^(1/2.2), `round((a + (b − a) · (1 − cos(π · i / 75)) / 2)^2.2)`. It eases in and out at both ends and never
drops below 12,000 ns (three times the glow), so the selected key never looks dark:

```c
static const uint16_t FM1C_BREATH_NS[76] = {
    12000, 12010, 12041, 12092, 12163, 12255, 12367, 12500, 12654, 12829, 13025, 13242, 13480, 13740, 14022, 14325,
    14650, 14997, 15367, 15758, 16171, 16607, 17064, 17544, 18045, 18568, 19111, 19676, 20262, 20867, 21492, 22136,
    22797, 23477, 24172, 24883, 25609, 26348, 27099, 27861, 28632, 29412, 30198, 30989, 31783, 32579, 33374, 34168,
    34957, 35741, 36517, 37283, 38038, 38778, 39503, 40210, 40898, 41563, 42206, 42822, 43412, 43972, 44502, 45000,
    45463, 45892, 46284, 46638, 46953, 47228, 47462, 47655, 47806, 47913, 47978, 48000,
};
```

`fm1_led_bg[]` holds only the selected key's bit (every other bit cleared); its `fm1_led`/`fm1_led_dim` bits are
clear except in a break-through L window. Cost: the input ISR waits out a backlight pulse longer than the shift, at
most 48 µs on one column per ~1.1 ms frame (≤ 4.4 % CPU). **On-device check:** the breathing range (does 48,000 ns read
"nearly full", does 12,000 ns read as a soft floor) and the ISR cost, before the operator signs off.

**Buttons** (never breathing):

| Button | Timeline |
| --- | --- |
| REC | recording: L; transcribing: L 0–249, O 250–499; else O |
| SAVE | double blink L 0–119, O 120–239, L 240–359, O 360–1259 while a send or approval awaits SAVE: voice `reviewing`, view 4 (confirm), or views 0/2/5 with `SET_DETAIL.state` approval_required; else O |
| LFO | L in view 5 |
| SEQ | G in view 0 with layout 1 or 2, and in view 2 with layout 1; else O |
| HOME / EDIT | L in view 0 / view 1 |
| GLO | L in view 2; else, with `attention_count` > 0, a single tick L 0–149, O 150–2499; else O |
| ARP | L in view 6 (§10.8); else O unless it glows below |
| others | O unless they glow below |
| no host | OCT+ L 0–499, O 500–999; every other button O |

**Active controls** (operator 2026-11-22): a button the companion acts on in the shown view glows **G steady** (the dim
layer, never the backlight), when the rule above leaves it O. None of the glowing buttons has a blink in that view, so a
blink's dark phase never turns into a glow. "Chat shown": `SET_DETAIL.state` not `empty` / `disconnected`; "busy":
working, waiting_input or approval_required (what ENV can stop).

| Shown (first match) | Glows G |
| --- | --- |
| view 4 confirm (wins over the voice overlay, as the companion's `currentView`) | FX (cancel) |
| view 3, voice `recording` / `transcribing` / `target_unavailable` | FX (cancel) |
| view 3, voice `reviewing` | FX (cancel), ARP (save as canned, §12.3) |
| view 3, voice `failed` | FX (dismiss), PLAY (retry) |
| view 3, voice `submitting` (and any other) | none (FX only says "still sending") |
| view 5 DETAILS | HOME (close); FX with approval (deny); ENV when busy; PLAY (open on Mac) when a chat is shown |
| view 6 SETTINGS | SAVE, HOME, LFO |
| view 0 Sessions | FX with approval (deny); ENV when busy; PLAY when a chat is selected |
| view 2 TO DO | FX when an item is selected (dismiss / deny); ENV when busy; PLAY when selected |
| view 1 Tasks | PLAY (new chat) when a task is selected (`SET_DETAIL.state` not `empty`) |

REC never glows in a base view (always available: it would be noise), nor on a review (the composer cannot start a new
take from `reviewing`). Limits of what the device can see: PLAY on a failed send retries only when the failure is
retryable; ENV and PLAY need the backend's interrupt / focus capability and a non-stale chat; in DETAILS over TO DO, FX
also dismisses a non-approval item, but view 5 does not say which list is below, so FX glows there for an approval only.

With protocol ≤ 4 the firmware keeps the version 1 table (docs/protocol.md §6); no glow is added. The timelines are also
data: `fixtures/device/led-v2.json` (`breathNs` and sampled timelines per key condition and button; `buttonMatrix`: all
14 button levels for every view × voice state × `SET_DETAIL.state` at 0, 130, 250 and 400 ms, buddy layout, no
attention) is read by the simulator tests and by the firmware's host-mode LED checks, so both use the same numbers.

### 9.10 Transitions and scroll

Budget: SPI1 to the ST7789V at 12 MHz, a full frame (115,200 B) ~77 ms. So transitions touch small regions only.

**Common rules (every transition):**

- **Interpolation** (lerp of rectangles and positions): a + (b − a) · i / n in integer arithmetic, the quotient
  truncated toward zero (C division), as the firmware computes it.
- **Steps** advance equal spatial slices (equal pixels per step); the motion eases out by timing: step i starts at t0 +
  T<sub>i</sub>, T = (0, 30, 70) ms for 3 steps, (0, 20, 50, 90) ms for 4 steps; the transition ends at t0 + 120 ms.
  t0 is the device time the triggering frame or input is applied.
- **Budget:** ≤ 18,000 px per step (24 ms of SPI) and ≤ 60,000 px per transition (the normal content draw that follows
  reader open and close is not part of it). Exception, accepted by the spec owner: the voice text scroll (table below)
  is 4 steps of 17,920 px = 71,680 px; each step stays ≤ 18,000 px and is drawn in passes like every other. Every step is drawn in passes of ≤ `FM1C_ANIM_PX_PASS` (2,400) px with the
  link served between passes (the version 4 scheduler rule), so heartbeats (1,000 ms) and ACKs (≤ 15 ms) keep their
  gates.
- **Start:** a transition starts only when `anim_ok()` (no ACK pending, no host frame waiting); otherwise the change is
  drawn directly. A step that cannot start within 40 ms of its time completes the transition at once.
- **Interruption:** any device input (key, button or encoder edge) during a transition completes it at once: its final
  content is drawn and nothing is queued. Host frames never interrupt: a region the transition has not yet drawn gets
  the current model when its step comes; any other change (including a region already drawn) is marked and drawn
  after the end. A trigger that arrives during a transition is drawn after the end without a transition.
- **During** a transition sprites are paused (`anim_ok` false); new content is drawn with the sprite frame of its step's
  time.
- **New content** of a step is the model at that step's time, clipped to the step's region; old content is what the
  panel shows.

| Transition | Trigger (device side) | Region | Steps |
| --- | --- | --- | --- |
| Selection slide, List/Grouped | `SET_SLOT` sets bit 0 on a key whose session row is in the shown window while another key holds it (view, page, layout unchanged); the deselect frame of the same flush is absorbed | rows of the window between the old and the new row | 3: for i = 1, 2 a 1 px frame 236 × 16 in `FM1C_C_GREY` at y = y<sub>old</sub> + (y<sub>new</sub> − y<sub>old</sub>) · i / 3 (integer), the rows under the previous frame (and the old row) redrawn unselected first; step 3 the final rows. ≤ 2 rows + frame ≈ 8,100 px |
| Selection slide, Buddy strip | as above in a Buddy layout | key boxes | 3: a 1 px white 14 × 14 frame at the box position interpolated between `fm1c_key_box(old)` and `(new)` (i / 3), the keyboard under the previous frame redrawn unselected; step 3 final. ≤ 1,200 px |
| Hero pop | `SET_DETAIL` changes state or provider while the selected key is unchanged, views 0/1/2 | hero box plus 1·scale px above (Buddy 48 × 50 at (4, 18), List/Grouped 24 × 25 at (4, 25)) | 3: squash (the new sprite, 18 rows: destination row d = 0…17 shows source row floor(d · 4 / 3), bottom-aligned in the box, × scale; the 6 · scale rows above it black), pop (the new sprite drawn 1 · scale px higher, the row below it black), normal. ≤ 2,400 px |
| Page wipe | `SET_VIEW` same view and layout, page changes (views 0/1/2) | List/Grouped: the list band x 0–235, y 60–223; Buddy: the keyboard band y 182–221 | 3: columns revealed left → right when the page grows, right → left when it shrinks; step i reveals ⌊W(i − 1)/3⌋ … ⌊W i/3⌋ − 1. The scroll column and the top bar's page are drawn after. ≤ 12,956 px |
| Layout wipe (SEQ) | `SET_VIEW` same view, layout changes | body band y 18–223 | 4: rows revealed top → bottom, step i rows 18 + ⌊206(i − 1)/4⌋ … 18 + ⌊206 i/4⌋ − 1. ≤ 12,480 px |
| Reader open | `SET_VIEW` from view 0 or 2 to view 5 | outlines | 3: 1 px outlines in the caption colour (`fm1c_v4_bubble_col`) at rect lerp(B, F, i/3), drawn over the old screen, earlier outlines left in place; B = the bubble (Buddy (2, 74, 236, 108)) or the header frame (List/Grouped (34, 19, 204, 40)), F = (0, 18, 240, 206). Then at t0 + 110 the DETAILS screen draws as usual. ≤ 892 px a step |
| Reader close | `SET_VIEW` from view 5 to view 0 or 2 | outlines | 3: outlines at lerp(B, F, (3 − i)/3) (open's rectangles in reverse) over the reader, then at t0 + 110 the base screen draws as usual |
| Reader page scroll | `SET_VIEW` view 5 to 5, page ± 1 | **hardware scroll** of y 72–223 | 4 steps of 38 px over the whole scroll area (§ below); step i sets the scroll start and draws the 38 newly exposed rows. 9,120 px a step |
| List window scroll | a selection change that moves the window (top changes), List/Grouped | **hardware scroll** of y 62–221 | 4 steps of 40 px over the whole area; the scroll column is redrawn at step 4. 9,600 px a step |
| Toast in / out | `COMMAND_RESULT` applied / 2,000 ms later | hint bar y 224–239 | 3: the bar redrawn with its new content (in) or the toast (out) drawn at y offset +11, +5, 0 (in) or +5, +11 then the hint line (out). 3,840 px a step |
| Knob row in / out | `ENCODER` K1–K4 sent with no knob row shown / 2,000 ms after the last | hint bar | as the toast, with the knob row. 3,840 px a step |
| Voice text scroll | `SET_TEXT` in view 3 whose rows 1–5 equal the old rows moved by 5 (new row 1 = old row 6: forward; old row 1 = new row 6: back) | bubble body x 8–231, y 96–175 | 4: the text moved 20 px a step (software, the region redrawn each step). 17,920 px a step |

**Hardware vertical scroll** (ST7789V `VSCRDEF` 0x33, `VSCRSADD` 0x37, sent with `fm1_lcd_send_cmd` and the data
helpers `lcd.c` already uses; `src/lcd.c` itself is not changed). `lcd.c` sets MADCTL 0x00 (top-left origin, no
offset), so panel lines 0–239 are frame-memory rows 0–239 and rows 240–319 are never shown; TFA + VSA + BFA = 320:

| Use | TFA | VSA | BFA | Scroll start s<sub>i</sub> (step i = 1…4) |
| --- | --- | --- | --- | --- |
| Reader page, forward / back | 72 | 152 | 96 | 72 + (38 i mod 152) / 72 + ((152 − 38 i) mod 152) |
| List window, forward / back | 62 | 160 | 98 | 62 + (40 i mod 160) / 62 + ((160 − 40 i) mod 160) |

Each scroll moves the **whole** area (VSA), so step 4 lands on the identity mapping (start = TFA) and no offset
survives the transition: drawing outside transitions never needs mapping. Step i draws, in memory rows, the new
content of the 38 (40) rows that step i exposes: forward, rows TFA + 38(i − 1) … TFA + 38 i − 1 get new rows
38(i − 1) … 38 i − 1 of the area; back, rows TFA + 152 − 38 i … get new rows 152 − 38 i … (VSA 160: 40). Before a
scroll the firmware sends `VSCRDEF` for the use; any full redraw (`SET_VIEW` view change, resync, banner) first sends
`VSCRSADD` = TFA. The fixed regions (top bar, hero, header, hint bar) never move.

**Decision: the firmware ships the hardware path** (`FM1C_VSCROLL_HW 1`) and keeps a software fallback
(`FM1C_VSCROLL_HW 0`: the page or window is drawn at once, as today; no animation, since a software scroll of the band
is 37,000–49,000 px a step, over budget). The firmware's host mode models the two commands in its LCD model (scanout
row = TFA + ((y − TFA + start − TFA) mod VSA) inside the area), so the host-mode shots and the simulator check the
hardware path; the fallback build is checked in host mode by its own scenario run. **Flagged for an on-device check**
before sign-off (wrong scroll registers would show a shifted body until the next full redraw).

#### 9.10.1 Fast input and interrupted transitions (2026-11-19)

Operator report from the device: "when scrolling through sessions fast, bugs appear due to animation, some slots get
blank, border stays". Reproduced in host mode (`v5x-window-overtaken`, and a randomized burst run while debugging):
a transition draws each step from the model *of that moment* and leaves the rest to the usual drawing. When a host
frame changed the model while it ran (the companion's answer to the next SELECT step), its plain end still recorded
the list as drawn: after a window scroll that the next answer moved back, rows of the other window and a second
highlight stayed until the next full redraw. Two rules:

1. **Fast scroll, no animation.** A press (a key down or an encoder step; not a release, not a button) within
   **`FM1C_TR_FAST_MS` = 150 ms** of the previous press starts no transition until 150 ms after it: the host's answers
   are drawn at once (rows, key boxes, the whole list when the window moves). The first press of a burst may start a
   slide; the second press completes it at once. A single move after 150 ms of no press still slides. Buttons do not
   count: OCT's double press is one gesture and its task wipe (§10.7) is its answer. Simulator: `FAST_MS` and
   `TransitionScreen.input(at, press)`.
2. **No partial state at an end.** An end that is not the plain one (any panel edge, a step later than 40 ms, or a
   host frame other than heartbeat/ACK applied while the transition ran) marks every region the transition touched, in
   full, from the model as it is then: the whole list (window scroll, page and layout wipes), the rows under the
   frames plus the old and new row (List/Grouped slide), the keyboard or white row (Buddy slide), the band (task wipe),
   the hero, the hint bar, the reader rows. No transition starts before those are drawn, so a transition always starts
   from a screen equal to the model.

Host-mode checks (`firmware/tests/console/scenario/scenarios.ts`): `v5x-fast-list`, `v5x-fast-grouped`,
`v5x-fast-buddy`, `v6-split-fast-list`, `v6-split-fast-buddy` (one slow move that still slides, then 10 inputs 20–60 ms
apart with a key tap among them, each answered 6 ms later; after the burst the screen equals a full redraw of the
model outside the hero box, exactly one row highlighted, no slide frame left, no slide after the first press) and
`v5x-window-overtaken` (the window scroll's target moved back mid-scroll by the host: the end shows the model's
window with one highlight). Every earlier host-mode shot is byte-identical to the build before this change.

### 9.11 Hint line and help

- **SEQ pair** (§8.8) names the next layout: Sessions `SEQ list` (Buddy), `SEQ group` (List), `SEQ buddy` (Grouped);
  TO DO `SEQ list` / `SEQ buddy`. Nothing selected: `SEQ <next>  SCL help`.
- **`PRESETS read`** (protocol 5, base layouts, a chat selected): when the bubble has more than it shows (Buddy row 6
  or List/Grouped header row 2 non-empty) and no approval or question is pending, the hint is `PRESETS read` first,
  then the usual pairs as far as they fit (`hintLine` drops from the end); otherwise the usual pairs, then
  `PRESETS read`, then the SEQ pair, each added (double-spaced) only when the action pairs show intact and it still
  fits 20; one that does not fit is skipped and the next is tried. Examples: an idle chat with a long last message
  `PRESETS read`; an approval `SAVE approve FX deny`; a short idle chat `REC reply  PLAY open`; a working chat without
  PLAY `ENV stop  SEQ group`.
- **Toasts:** `Pins full (200)` / `Task pins full (200)` (only at the safety cap; was `Pins full (9)` until 2026-11-19), `Task pinned`, `Task unpinned`, `Show: pinned (<n>)`; a folded-row tap `Task: <title>`
  / `Task: all` (the KNOB3 toasts).
- **Help** (`fm1c_help.h` `FM1C_HELP_BASE5`, every base view with proto ≥ 5; replaces the §8.8 table, which was never
  flashed). The host mirrors it as `HELP_TEXT.base5`; `test/control-map.test.ts` checks it against this block and,
  once the firmware carries it, against `fm1c_help.h` byte for byte. The knob lines and the who-is-who grid follow as
  in version 4; the DETAILS help (`FM1C_HELP_DETAIL4`) is unchanged.

```c
static const char *const FM1C_HELP_BASE5[6] = {
    "HELP - SEQ buddy/list/group",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
};
```

### 9.12 Persistence (companion)

`config.json` `layouts.sessions` accepts `"buddy" | "list" | "grouped"`, `layouts.inbox` `"buddy" | "list"`; default
`{ "sessions": "grouped", "inbox": "list" }`, written only when it differs (§8.7). `pins` holds ≤ 9 session or task
keys. The desktop UI's config form offers Grouped for Sessions.

### 9.13 Firmware budget and files

- Files: `fm1c_draw5.h` (Grouped entries and rows), a new `fm1c_trans.h` (transition engine and the hardware scroll),
  `fm1c_led.h` (version 2 timelines, `FM1C_BREATH_NS`, the 20 ms ramp in the main loop), `fm1c_help.h`
  (`FM1C_HELP_BASE5`), `fm1c_proto.h`/`console.c` (the new fields and their bad-body rules). Platform files
  (`hal/fm1_input.h`, `src/lcd.c`, ...) stay byte-identical; only their public APIs are used.
- **Flash cap (BLE image): raised from 125 KB to 140 KB (143,360 B).** Today 124,008 B; this round is estimated at
  +8–12 KB. `firmware/tools/build.py`'s only hard limit is the app slot (`APP_SLOT` 0x8DFBC = 581,564 B), so the cap is
  a spec limit, checked in the validation report. RAM `.data + .bss` ≤ +1,536 B over 27,080 B (≤ 28,616 B; raised from
  +512 B: the 27 slots carry the row byte and the head fields, 972 B, plus the transition state and the voice snapshot).
- Emulator gates unchanged: heartbeats every 1,000 ms, worst ACK ≤ 15 ms, with transitions running.

### 9.14 Tests and evidence

**Host (bun):** codec round trip and every §9.5 vector; `focus.ts` `groupedLayout` (group order, pinned block, pinned
tasks with out-of-scope sessions, folding rules, sub-agent indent, `New` arrivals, page-boundary headers); controller
SEQ cycle and re-sort on Grouped, folded-row tap and long press, SELECT/ALGORITHM skipping folded rows, PINNED scope
(contents, legend, knobs, empty state), pin limit 9 and task pins, PRESETS → reader → LFO/HOME return, auto-return at
20 s; view row/head fields and title cuts; `render.ts` sends `row` only in Grouped and strips it below 5; config
(layouts `grouped`, pins 9); help equality with this section (and `fm1c_help.h` once it has the new table).

**Simulator:** `renderV4` draws §9.3; `leds.ts` implements §9.9 and matches `fixtures/device/led-v2.json`;
`transitions.ts` implements §9.10 (every step region inside 240 × 240, pixels per step and per transition within the
budget, T schedules, interruption completes at once, hardware scroll frames equal the logical scroll). A replay test
feeds the firmware's scenarios below through the codec and the transition engine and compares with
`reports/evidence/ui-v3/after/host/<shot>.png` once the shots exist (skipped until then).

**Firmware scenarios and shots** (names the replay test looks for; each starts with `HELLO_ACK` proto 5; the trigger of
a transition scenario is applied at 1,000 ms; `-<n>` shots are at 1,000 + n ms, `-done` at 1,300 ms):

| Scenario | Shots |
| --- | --- |
| `v5g-grouped` (Pinned group, two tasks, one sub-agent, one folded task) | `v5g-grouped` at 1,500 |
| `v5g-grouped-window` (24 entries, selection in the second window) | `v5g-grouped-window` at 1,500 |
| `v5g-pinned` / `v5g-pinned-empty` | `v5g-pinned`, `v5g-pinned-empty` at 1,500 |
| `v5g-trans-select` | `-0`, `-30`, `-70`, `-done` |
| `v5g-trans-hero` | `-0`, `-30`, `-70`, `-done` |
| `v5g-trans-page` | `-0`, `-30`, `-70`, `-done` |
| `v5g-trans-seq` (List → Grouped) | `-0`, `-20`, `-50`, `-90`, `-done` |
| `v5g-trans-reader` (open; close triggered at 2,000) | `-0`, `-30`, `-70`, `-done`; `-close-0` (2,000), `-close-done` (2,300) |
| `v5g-trans-reader-page` | `-0`, `-20`, `-50`, `-90`, `-done` |
| `v5g-trans-window` | `-0`, `-20`, `-50`, `-90`, `-done` |
| `v5g-trans-toast` (out at 3,000) | `-0`, `-30`, `-70`, `-done`; `-out-0` (3,000), `-out-done` (3,300) |
| `v5g-trans-interrupt` (page wipe, a key press at 1,040) | `-30`, `-40` (final at once) |
| `v5g-help` | `v5g-help` at 1,600 (SCL held) |

Evidence: simulator strips of every transition step and the LED timelines under `reports/evidence/ui-v3/grouped/`
(`bun packages/device-simulator/scripts/grouped-evidence.ts`; `fixtures/device/led-v2.json` from
`packages/device-simulator/scripts/gen-led-v2.ts`).

Host status (2026-11-18): device-protocol `Layouts` + `grouped`, `SetSlot.row`/`head` with the bad-body rules, 17 new
vectors (71 valid, 53 invalid in all), ACKs ahead of queued frames (`PacedQueue.run(job, urgent)`: a 27-slot re-sort
had delayed an ACK past the device's retransmit and the retransmitted SEQ press ran twice once the 32-entry duplicate
window had filled with the burst's ACKs); agent-core `groupedLayout`/`nestChildren`/`flatPinBlock` (`focus.ts`),
`LayoutData.groups`, folded task keys, `sessionsGrouped`/`relayoutKeepingSelection`/`SCREEN_CYCLE` (`context.ts`), SEQ
cycle, folded-row tap/long press, task pins and `MAX_PINS` 9, PINNED scope, PRESETS reader and `closeReader`, auto-return
(`READER_AUTO_RETURN_MS`), row/head fields and `PRESETS read` (`view.ts`), `Session.parentKey`,
`AgentAdapter.fetchPinned`; companion `render.ts` row/head (stripped below 5), config `layouts.sessions` grouped
(default) and 9 pins, desktop form option; simulator Grouped screen, LED v2 (`leds.ts`), `v4/transitions.ts`
(`TransitionScreen`, also driving the browser UI), replay test `test/v5g-firmware-parity.test.ts` (skipped until the
v5g shots exist).

### 9.15 Open points and deviations

- **Expanded task headers have no key** (brief: "Headers have no key"), so "long press on a task header row" pins only
  folded tasks in Grouped; expanded tasks are pinned from the Tasks view. If the operator wants header long press
  everywhere, the cheapest option is a header key per group (costs page-1 keys, §9.5) or a button (ARP is unused).
- **PINNED empty state** is split over two lines (`No pins yet` / `hold a key to pin`), §9.4.
- **The reader opens on page 0** for either direction of the first turn (§9.8): opening on page 1 would skip the lines
  between the bubble's 5 rows and the reader's 9.
- **`PRESETS read`** shows only where it fits 20 characters (§9.11), mostly for calm chats with a long message.
- **Auto-return** resolution is the 5 s housekeeping tick (20–25 s).
- **Pinned sessions outside the scan, Traycer parent links, a2a:** done in the adapter step (§9.7 host notes). Task
  pins are still made only from folded rows or the Tasks view (first bullet).
- **Hardware scroll and breathing:** on-device checks (§9.9, §9.10).
- **Duplicate window** (host link): device ACKs fill the 32-entry window too, so a burst longer than 32 frames can still
  evict an input's entry; with ACKs now sent first the device no longer retransmits in that window, but the window
  itself is unchanged (firmware and host keep the same rule).
- **Firmware squash (review 2026-11-18):** `fm1c_tr_hero` clears rows 0–5 inside its bottom-up copy loop, so
  destination rows 3 and 4 of the squash read source rows 4 and 5 after they were cleared (6 px in
  `v5g-trans-hero-0`). The simulator draws the spec; the replay test records the 6 px until the firmware clears those
  rows after the loop.
- **Simulator replay (review 2026-11-18):** the transition engine models what the firmware draws from: a burst of
  frames is drawn as one (the trigger compares the panel before the burst with the model; a later trigger of the burst
  replaces an earlier one), the toast is the filled version 4 bar, slide-outs start from the panel still showing the
  toast or knob row, and the help opens after 400 ms of SCL. 69 of the 70 v5g shots are pixel-identical (all step shots
  included); the one left is the squash above.
- **Grouped key cost:** headers take no key, but a folded task takes one; ALL with the measured 98 tasks folds most of
  them into single keys (fewer keys than flat ALL).

## 10. SPLIT keys and settings (protocol version 6)

Date: 2026-11-19. Status: spec, normative for the companion (`agent-core`, `apps/companion`, `apps/companion-ui`), the
simulator and the firmware. The codec, the shared vectors and the LED data are implemented with this section
(`packages/device-protocol`, `fixtures/device/vectors.json`, `fixtures/device/led-v2.json`); everything else is for the
build agents. Operator brief (approved 2026-11-19, proposal page `https://claude.ai/artifact/EWvzYHqULtB5dFmHLg64zd`):
"agree with general proposal; add as toggle in settings menu; first black keys common filters, rest tasks, also allow
task pinning; octave double click to go to next task page on the keys; [chosen task persists] yes; align screen view
with physical layout in chosen mode". Version 5 is on the device, so this round is **protocol 6** (additive).

### 10.1 What changes

- A **SETTINGS view** (view 6) opened by **holding ARP for 1 s**. Its first (and today only) row is
  `Keys  Ranked / Split`. Default **Ranked**: nothing changes until the operator picks Split.
- **SPLIT keys** (Sessions only): the black keys F#3, G#3, A#3 are the filters **ALL / PINNED / NEEDS YOU**; the other
  8 black keys are **tasks** (8 per task page); the **16 white keys** are the sessions of the chosen filter or task.
  Single OCT pages the white keys, **double OCT** pages the task row.
- The screen draws the black row in its physical positions above the white keys (Buddy strip, List/Grouped band).
- **RANKED** (and TO DO, Tasks, DETAILS, voice, confirm) render exactly as with version 5. The only firmware-local
  difference under protocol 6 is line 1 of the help overlay, which names the settings entry (§10.11).
- Protocol 6 adds: a SET_VIEW **keys** byte (+ task page and task page count for SPLIT), the SET_VIEW view value
  **6 settings**, and SET_SLOT flag **bit 4 chosen**. No new message type, no new SET_SLOT field (§10.6).

### 10.2 The SETTINGS view

**Entry gesture: hold ARP ≥ 1,000 ms** (`ARP_HOLD_MS = 1000`, host-resolved from the `BUTTON` edges the device already
sends). Chosen against the control map (docs/ux-v2.md §2.3, `controller.ts onButtonDown`):

| Candidate | Free today? | Verdict |
| --- | --- | --- |
| **ARP hold** | ARP (button 10) is the only button with no meaning in any view (`default: // SCL, ARP: unused`) | **Chosen.** No conflict in any view; a stray tap does nothing harmful (it only toasts `Hold ARP: settings`); a 1 s hold is deliberate. No firmware input change, no protocol change: ARP down/up edges already reach the host. |
| HOME hold 1 s | HOME acts on **down** (go to Sessions / re-sort) | Rejected: every hold would re-sort first, and the key order would jump under the finger before the menu opens. |
| SCL + SEQ chord | SCL hold is the firmware-local help; while help is shown the firmware drops all other input | Rejected: needs a change in the firmware's help input path, and SCL down already starts the 400 ms help timer. |
| MASTER pot | unused | Rejected: continuous control without a detent, easy to brush. |
| ARP tap | free | Rejected: too easy to hit next to SAVE/SEQ for a mode-changing menu. |

**Host rule.** ARP down at t0 in a base view (Sessions, Tasks, TO DO; not DETAILS, voice, confirm, help): if ARP up
arrives before t0 + 1000, it was a tap → toast `Hold ARP: settings`; otherwise, at t0 + 1000 (a timer, not the next
input), SETTINGS opens over that view (`settingsFrom` = the view). Protocol ≤ 5 agreed: ARP does nothing (no toast).

**Controls in SETTINGS (view 6):**

| Input | Effect |
| --- | --- |
| SELECT turn | moves the cursor one row, clamped (no wrap) |
| SAVE (down) | changes the cursor row's value (cycles to the next value), applies it at once, saves it, toasts it (`Keys: split` / `Keys: ranked`) |
| HOME | closes SETTINGS to Sessions (HOME's usual meaning; a re-sort) |
| LFO, ARP (down) | close SETTINGS back to `settingsFrom` |
| keys, OCT, FX, ENV, PLAY, REC, SEQ, EDIT, GLO, ALGORITHM, PRESETS, K1–K4 | nothing (no toast). REC never starts a recording here. |
| SCL hold | help overlay `FM1C_HELP_SETTINGS6` (§10.11) |

There is no auto-close. A Keys change applies immediately: when `settingsFrom` is Sessions the host re-lays Sessions in
the new mode (both rows re-sorted, §10.4) and sends the 27 slots while SETTINGS is still shown, so the key LEDs show the
new assignment as feedback; the screen shows it on close.

**Rows (host content, `SET_TEXT`, view 6):**

| SET_TEXT row | Content |
| --- | --- |
| 0–8 | item n: label left, value right, padded with spaces to exactly **26** characters (`label.padEnd(26 − value.length) + value`), style 0. Rows past the last item `""`. |
| 9 | the cursor item's description, style 2 (muted), ≤ 29 |
| 10–11 | `""` |

Item 0 (`keys`): label `Keys`, value `Ranked` / `Split`; description `Every key is a session` (Ranked) / `Black keys: filters, tasks`
(Split). Later items append rows 1–8 (at most 9 items); the menu is a list, so nothing else changes.

`SET_VIEW` in view 6: `page` = the cursor row (0-based), `pages` = the number of items (1 today), `title` `SETTINGS`,
`layout` 0, `keys` = the mode of the slots currently on the device (§10.6). `SET_LEGEND` `["", "", "", ""]`.
`SET_DETAIL`: provider none, state empty, line1–3 `""`, line4 the hint `SAVE set  HOME back` (19).

**Order rule:** entering and leaving view 6 sends all four `SET_TEXT` groups before `SET_VIEW` (as view 5).

**Screen (device, view 6, 240 × 240):**

| Rows | Contents |
| --- | --- |
| 0–17 | top bar as version 4 (`fm1c_draw_status_in(m, 18, 1)`): title, link dot, badge; **no page number** (page/pages are the cursor and the count here) |
| 18–21 | black |
| 22–201 | 9 item rows of 20 px at y<sub>n</sub> = 22 + 20n (n = 0…8), each 240 × 20. n < pages: background `FM1C_C_OUTLINE` when n = page (the cursor), else black; on the cursor row a `>` in `FONT_S` white at (4, y<sub>n</sub> + 2); the text (SET_TEXT row n, ≤ 26 characters = 208 px) in `FONT_S` at (16, y<sub>n</sub> + 2), white on the cursor row, else `FM1C_C_TEXT2` (style 2: `FM1C_C_GREY`). n ≥ pages: black. |
| 202–223 | the description: SET_TEXT row 9 in `FONT_S` `FM1C_C_MUTED` at (4, 204); rows 202–203 and 220–223 black |
| 224–239 | hint bar as version 4 (`fm1c_draw4_hint`: toast, else `SET_DETAIL.line4`) |

No hero, no keys, no animation. Redraw: entering draws everything (a view switch); a cursor move (page changes) marks
the old and new item rows (4,800 px each) and the description (5,280 px); a `SET_TEXT` change marks its row. No
transition. LEDs: keys keep their slots' timelines; **ARP L** while view 6 is shown; every other button O.

**Persistence:** `config.json` `"settings": { "keys": "ranked" | "split" }`, default `{ "keys": "ranked" }`, validated
(unknown keys and values refused), written only when it differs from the default (an older companion refuses unknown
keys, as with `layouts`, §8.7). `AgentConsole` takes `settings` and `onSettingsChanged`, like `layouts`. The desktop UI's
config form offers Keys Ranked/Split.

### 10.3 Key assignment in SPLIT

Applies to **Sessions (view 0)** while `settings.keys` is `split` and protocol 6 is agreed (protocol ≤ 5: a saved
`split` lays Sessions out RANKED, exactly as before). TO DO, Tasks and every other view keep the flat 27 keys.

| Keys | k | Role |
| --- | --- | --- |
| F#3, G#3, A#3 | 1, 3, 5 | filters **ALL**, **PINNED**, **NEEDS YOU** (labels `ALL`, `PIN`, `YOU`) |
| C#4 D#4 F#4 G#4 A#4 C#5 D#5 F#5 | 8, 10, 13, 15, 17, 20, 22, 25 | task slots 1–8 of the shown task page |
| 16 white keys | 0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26 | sessions of the chosen filter or task, in white-key order (F3 first) |

Exactly one black key is **chosen** at a time (a filter, or a task while it is on the shown task page; a chosen task on
another task page leaves no chosen key on the row). Default ALL.

**Gestures** (the device's existing `KEY` gestures: single, double, long):

| Gesture | White key | Filter key | Task key | Empty task key |
| --- | --- | --- | --- | --- |
| tap (`single`) | select (as RANKED) | choose it; tapping the chosen PINNED or NEEDS YOU again → ALL; tapping ALL when chosen: nothing | choose it (white keys show its sessions); tapping the chosen task again → ALL | nothing |
| `double` | open on Mac (as RANKED) | nothing | open the task's first session (white-key order) on the Mac with the adapter's `focus` (capability `focus`; the PLAY toasts); no live session or no capability: nothing | nothing |
| `long` | pin / unpin the session (as RANKED) | nothing | pin / unpin the task (`Task pinned` / `Task unpinned`; at the task pins' own safety cap `Task pins full (200)`, §9.6) | nothing |

A double tap never chooses (the device sends `double` without `single`). Choosing toasts `Show: all`,
`Show: pinned (<n>)`, `Needs you (<n>)` or `Task: <title>` (the KNOB3 toast; ≤ 20).

**SELECT** and **ALGORITHM** move over white keys only (the white list in layout order, across white pages). The host
never sets flag bit 0 on a black key in SPLIT. SAVE, FX, ENV, PLAY, REC, LFO, PRESETS (reader), SEQ, dismiss, voice and
approvals keep their meaning and act on the selected session.

**DETAILS over SPLIT Sessions:** a black key tap chooses as above and the reader stays on its chat; white keys as
RANKED (key tap shows that chat). The **Tasks view** (EDIT): a task tap goes to Sessions with that task chosen (the task
page becomes the page that holds it) instead of setting the TASK filter.

### 10.4 Filters, the task row, order, freeze and paging (host, `agent-core`)

**The white list per choice** (the frozen layout of docs/ux-v2.md §3.4 with these contents):

| Choice | Sessions | Order |
| --- | --- | --- |
| ALL | the RANKED Sessions list of SHOW (KNOB1) and REPO (KNOB2) with no TASK filter: the scope plus the pinned sessions (§9.6) | as RANKED (2026-11-22): pinned sessions first, then the other sessions that need you (T0–T3), then the rest; tier §3.2 inside each part |
| PINNED | every pinned session (§9.4: all repos, all tiers; ignores SHOW and REPO), on as many white pages as needed; task pins take no white key | need you first, then the other pins; flat (Buddy, List) or grouped (Grouped: one Pinned group, need you first) |
| NEEDS YOU | every T0–T3 session (§3.2 tiers: approval, question, failed and unread ≤ 72 h, not dismissed) of every task in REPO | tier order (§3.2); pins are not lifted (they keep flag bit 3) |
| a task | the task's sessions in SHOW scope plus its pinned sessions; a pinned task: every live session | the task's pinned sessions first, then its other sessions that need you, then the rest (tier inside each part) |

Page 1 takes **15** white keys (F3…F5); **G5 (k 26) stays free** for arrivals; later pages take 16. `SET_VIEW.pages` is
the white page count. Arrivals (a session that becomes T0–T3, or one the console created) that belong to the current
choice take the first empty white key of page 1 at or after the end of the list; when none is free nothing moves and
the title gets ` +N new` (§3.4). A session of another choice never arrives on the white keys (its task chip and the NEEDS
YOU chip show it).

**Grouped in SPLIT** (§9.2 with two changes): groups never fold (the black row is the task navigation, so no folded
task rows and no `task` bit); a chosen task shows one group, its header. ALL, PINNED and NEEDS YOU group by task as §9.2
(ALL and PINNED: the Pinned group with every pinned session, then task groups that need you, then the other tasks;
NEEDS YOU without a Pinned group, pins not lifted). Headers take no key, as before.

**The task row.** Contents: every pinned task (whatever SHOW and REPO say; pins are bookmarks; since 2026-11-19 task pins
are unlimited and this row is the only place they order), then the tasks of REPO with ≥ 1 session in SHOW scope. Order: pinned tasks first, then the others; inside each part best tier (§3.2), newest
activity, title, task key (`taskChoices` order). Cut into **task pages of 8** (task slot j of page p = task 8p + j);
`taskPages` = max(1, ⌈T / 8⌉). Empty task slots of the last page: state `empty`.

**Freeze.** Both rows are frozen layouts. Keys never move between re-sorts; a state change updates the key in place.

| Trigger | White row | Task row | Pages afterwards |
| --- | --- | --- | --- |
| Entering Sessions from another view, HOME in Sessions (`Sorted`), KNOB1, KNOB2 | re-sort | re-sort | white page 1; task page = the page holding the chosen task (filter chosen: page 1) |
| Choosing a filter or task | re-sort | - (ALL dropping an implicit repo, §10.9: re-sort) | white page 1; task page unchanged |
| KNOB3 turn (§10.9) | re-sort once the knob rests 300 ms | - | white page 1; task page = the page holding the chosen task |
| Pin / unpin a session or a task | re-sort | re-sort | white page 1; task page = the page holding the task just (un)pinned (a session pin: as the first row) |
| SEQ into or out of Grouped | re-sort (§9.1) | - | the page holding the selection (§9.1) |
| Switching Keys to Split (SETTINGS) | re-sort | re-sort | white page 1; task page = the saved one, clamped |
| Auto, 60 s without device input in a base view, only if the order would change | re-sort | re-sort | both page indices kept, clamped |
| OCT single / double | - | - | white page ± 1 (clamped) / task page ± 1 (wraps) |

The selection is kept by identity on every re-sort (as a KNOB3 change today). Between re-sorts a task whose last session
disappears keeps its key with state `disconnected` (chip in the calm colour, LED O); the next re-sort drops it, and if it
was chosen the choice becomes ALL. A task that gains a session needing you while it is not on the row appears at the
next re-sort (NEEDS YOU shows it at once). A chosen task that is not in the task row at a re-sort (left the scope,
unpinned and quiet) falls back to ALL with the toast `Show: all`.

**KNOB1 in SPLIT** cycles ACTIVE → RECENT → ALL (no PINNED step: the PINNED black key replaces it). Switching to SPLIT
while the scope is PINNED sets the scope to ACTIVE and the choice to PINNED.

### 10.5 OCT: single versus double press (host, `agent-core`)

In Sessions with SPLIT keys (view 0; not DETAILS, where OCT turns reader pages at once as today) the host resolves OCT
presses like the device resolves key gestures (docs/protocol.md §4: double = second down within 300 ms of the first up;
the single only after the window closes). The device sends plain `BUTTON` edges as today; nothing changes on the wire.

```
OCT_DOUBLE_MS = 300                      // equal to the device's key double window
octPending: { button: OCT_DOWN | OCT_UP, downAt: number, upAt: number | null } | null

BUTTON OCT_x down at t:
  if octPending?.button === x && octPending.upAt !== null && t - octPending.upAt <= OCT_DOUBLE_MS:
      DOUBLE(x); octPending = null                      // task page -1 / +1, wrapping
  else:
      if octPending: SINGLE(octPending.button)          // the other OCT, or too late: the first press resolves now
      octPending = { button: x, downAt: t, upAt: null }
BUTTON OCT_x up at t:   if octPending?.button === x && upAt === null: upAt = t; arm a timer at t + OCT_DOUBLE_MS
timer fires (no second down): SINGLE(x); octPending = null                  // white page -1 / +1, clamped
any other input (key, encoder, any other button edge) while pending: SINGLE first, then that input
```

- Every press produces exactly one action: one SINGLE, or one DOUBLE together with its partner press. **A single press
  never pages twice and never pages both rows.**
- Times are the host's receive times of the frames (`World.now`). Transport jitter (USB ~1 ms, BLE up to one
  connection interval) shifts the window by that much; a retransmitted edge is dropped by the SEQ duplicate guard, and
  an edge delayed past the window can only turn a double into two singles.
- The timer is a real one-shot timer in the console (not the 5 s housekeeping tick); the controller exposes the
  pending state and a `resolveOct(now)` entry; tests drive it with `FakeClock`.
- SINGLE latency is 300 ms after release in SPLIT only. RANKED, TO DO and Tasks keep the immediate page turn.
- DOUBLE with `taskPages` = 1: toast `No more tasks`, nothing else. Otherwise toast `Tasks <p>/<n>` (e.g. `Tasks 2/3`).
  Filters stay; the choice stays (a chosen task on another page keeps its white keys; the row shows no chosen task).

### 10.6 Protocol: version 6 (additive)

Version 6 includes every version 5 rule. The host sends the version 6 forms **only when version 6 was agreed**; with 5 or
lower it sends exactly the version 5 bodies (Keys behaves as Ranked and ARP does nothing), so firmware on versions 1–5
never sees them. A version 6 decoder accepts every earlier body form in every negotiated version.

| Message | Version 6 addition | Rules |
| --- | --- | --- |
| `SET_VIEW` (0x42) | `enum view` value **6 settings**; after `enum layout` an optional **`u7 keys`** (0 ranked, 1 split); with keys 1 then **`u7 task_page`**, **`u7 task_pages`** | keys needs the layout byte before it. Bad body: view > 6, keys > 1, keys 1 without both task bytes, task_pages 0, task_page ≥ task_pages, keys 0 followed by any byte, any byte after task_pages. Largest body 3 + 21 + 1 + 3 = 28. |
| `SET_SLOT` (0x43) | flags **bit 4 chosen** | flags ≤ 31; bit 4 together with bit 0 (selected) is a bad body. The body forms of versions 1–5 are unchanged. |

- **When the host sends `keys`:** in every `SET_VIEW` once version 6 is agreed (as version 5 always sends the layout):
  `keys` = 1 exactly while the 27 slots on the device hold the SPLIT assignment (view 0 in SPLIT, and views 3, 4, 5, 6
  opened over it), else 0. With keys 1 the host sends the task page (0-based) and the task page count.
- **Black-key slots in SPLIT** (keys 1, k ∈ {1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25}): the device knows the role from the
  key number (§10.3). `label` = the tag (≤ 3 characters: `ALL`, `PIN`, `YOU`, or the task tag of §10.7); `state` = the LED
  state of §10.8; flags bit 3 = a pinned task, bit 4 = chosen, bits 0–2 = 0; `title` = the task title (`rowTitle`, ≤ 20) or
  the filter name (`All`, `Pinned`, `Needs you`); `age` = the age of the task's newest activity, `""` for filters; `row` =
  indent 0, no header, while Grouped (as every view 0 slot). No new field.
- **Order rules:** a `SET_VIEW` whose keys value changes is a layout change (§8.6): all four `SET_TEXT` groups go
  before it. A keys change re-sends all 27 `SET_SLOT`s in one coalescer flush. In SPLIT every switch between view 0 and
  views 3/4 sends all four `SET_TEXT` groups before `SET_VIEW` (the bubble has 4 body rows in view 0, 5 in voice and
  confirm, §10.7). Entering and leaving view 6 does the same.
- **Host strip below 6** (`apps/companion` `render.ts framesFor`): drop `keys`/`taskPage`/`taskPages`, clear `chosen`,
  never send view 6.
- Constants: device `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 6`; host `PROTOCOL_VERSION 6`, `SPLIT_VERSION 6`,
  `HOST_VERSIONS = { min: 1, max: 6 }`. A host at 6 talking to a version 6 device before the host features land sends the
  version 5 forms, which a version 6 device draws as RANKED (keys absent = ranked).
- Vectors: docs/protocol.md §4 "Version 6 vectors".

Rejected alternatives: **a SET_SLOT kind byte** (session/filter/task) costs a byte per slot and a decoder rule for a
role the key number already fixes; **flag bit 0 as "chosen" on black keys** would put the chosen key into every bit-0 code
path of the firmware (backlight breathing, the selection slide, the List window), so a missed check breathes two LEDs;
**a new message for the task row** needs its own coalescing and resync; **device-side OCT double detection** needs a new
BUTTON gesture on the wire for something the host can resolve from the edges it already gets.

### 10.7 Screens in SPLIT (device, keys 1)

Shared geometry: black key index i = 0…10 in the order k = 1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25; the white key it sits
after a<sub>i</sub> = 0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 14; its centre **c<sub>i</sub> = 8 + 14 (a<sub>i</sub> + 1)** = 22, 36, 50,
78, 92, 120, 134, 148, 176, 190, 218 (the version 4 key strip's positions, docs/ux-v2.md §2.4). White key w at x = 8 + 14w
(as version 4). Black keys sit on **two staggered lines**: i even on line A (F#3, A#3, D#4, G#4, C#5, F#5), i odd on line B
(G#3, C#4, F#4, A#4, D#5). Neighbours on one line are ≥ 28 px apart, so a 3-character tag (24 px) fits; physically adjacent
keys (14 px apart) are on different lines.

**Chip** (one black key; a box 26 × 16 at x0 = c − 13, y0 = the line's y):

| Kind / state | Box | Tag | Extras |
| --- | --- | --- | --- |
| task slot, state empty | black | none; a 4 × 2 dash at (x0 + 11, y0 + 7) in `FM1C_C_OUTLINE` | no stem |
| filter, not chosen | black, 1 px frame in C | in C (state empty: frame `FM1C_C_OUTLINE`, tag `FM1C_C_GREY`) | stem in C |
| task, not chosen | filled with C | `fm1c_dark(C)` ? white : black | pinned (flag bit 3): a 2 × 2 dot at (x0 + 23, y0 + 1) in the tag colour; stem in C |
| chosen (flag bit 4), filter or task | filled white | black | pinned dot black; stem white |

C = `fm1c_v4_col(state)` (the caption colour: calm states grey). Tag = the first min(3, length) characters of
`SET_SLOT.label`, `FONT_S`, at x = x0 + (26 − 8n) / 2 (n characters), y0. **Stem**: line A chips only, a 1 px vertical line
at x = c from y0 + 16 to y0 + 31 (it passes between the line B chips: every line A centre lies outside every line B
box). A key's redraw unit is its box (416 px) plus its stem (16 px), each its own blit.

**Task page dots** (only when task_pages > 1): n = min(task_pages, 8) dots of 2 × 2 at x 234–235, y = y<sub>A</sub> + 1 + 4j
(j = 0…n − 1); the current one (j = task_page, or ⌊task_page · 8 / task_pages⌋ when task_pages > 8) white, the others
`FM1C_C_GREY`.

**Task tags (host, `agent-core`):** ASCII-fold the task title, split it into words (runs of letters and digits); tag =
the upper-cased first character of each of the first 3 words; when that gives fewer than 3 characters, append the next
characters of the last word used, upper-cased, until 3 (`Firmware v5` → `FV5`, `Docs pass` → `DPA`, `Firmware` → `FIR`);
no word: `?`. When two tasks of one task page get the same tag, the later one (row order) replaces its third character with
its slot number 1–8 (`DPA`, `DP6`).

**Buddy in SPLIT** (view 0, layout 0):

| Rows | Band | Contents |
| --- | --- | --- |
| 0–17 | top bar | as version 4 |
| 18–67 | hero, label | as version 4 (the selected white key's chat) |
| 68–167 | bubble | the version 4 bubble with **4 body rows**: frame 236 × **92** at (2, 74) (y 74–165), tail as version 4; caption (row 0) at y 78; body rows 1–4 at y 96 + 16 (r − 1) (96–159); **row 5** non-empty draws the "more" wedge on the bottom edge (the version 4 wedge moved up 16 px: its strip is y 160–167) |
| 168–199 | black row (240 × 32) | line A chips at y0 168, line B chips at y0 184, the stems (y 184–199), the task page dots (y 169…197) |
| 200–223 | white row (240 × 24) | the 16 white minis exactly as version 4 (14 × 14 boxes at x = 8 + 14w, y 202, selected frame, pinned dot, empty dash); rows 200–201 and 216–223 black |
| 224–239 | hint bar | as version 4 |

Host `SET_TEXT` for SPLIT Buddy: row 0 the caption, rows 1–4 the body (≤ 28), row 5 the next line or `""`, rows 6–11
`""`. PRESETS opens the reader as in version 5 (§9.8).

**Voice and confirm over SPLIT Sessions** (views 3, 4 with keys 1): the version 4 screen with its 5-row bubble and its key
strip (y 184–223) unchanged, except each **black key box** (14 × 14 at y 184) is drawn compact: task: a 12 × 12 fill in C at
(bx + 1, by + 1); filter: a 1 px frame 12 × 12 in C; chosen: a white 12 × 12 fill; empty task slot: the version 4 dash. No
tags (the strip stays 40 px). DETAILS (view 5) draws no keys, unchanged.

**List in SPLIT** (view 0, layout 1):

| Rows | Columns | Contents |
| --- | --- | --- |
| 0–17 | 0–239 | top bar as §8.2 |
| 18–59 | 0–239 | hero and header bubble as §8.2 (the caption's key name is the selected white key's) |
| 60–91 | 0–239 | black row band: line A chips at y0 60, line B at y0 76, stems y 76–91, task page dots y 61…89 |
| 92–93 | 0–239 | black |
| 94–221 | 0–235 | **8 rows** of 16 px at y<sub>n</sub> = 94 + 16n (n = 0…7), row format §8.3 unchanged |
| 222–223 | 0–235 | black |
| 92–223 | 236–239 | scroll column: when L > 8, a thumb at x 237–238, y = 94 + 128 · top / L, height 128 · min(8, L − top) / L |
| 224–239 | 0–239 | hint bar |

Entries: the **white** keys whose state is not `empty`, ascending k (black keys are never rows). top = 8 · ⌊s / 8⌋ (windows
of 8). **Grouped in SPLIT** (layout 2): the same bands; entries per §9.3 built from the white keys only; with a task chosen
the first entry is its header row. The header bubble's `SET_TEXT` rows are §8.4 unchanged.

**Redraw regions and transitions** (SPI budget of §9.10 unchanged: ≤ 18,000 px a step, ≤ 60,000 px a transition, passes of
≤ 2,400 px with the link served between them):

| Change | Marks | Transition |
| --- | --- | --- |
| black-key `SET_SLOT` (state, label, flags) | its box + stem | none |
| chosen moves | the two boxes + stems (≤ 864 px) | none |
| white-key `SET_SLOT` | as version 5 (Buddy: its 14 × 14 box; List/Grouped: its rows, or all rows on an occupancy change) | as version 5 (selection slide) |
| `SET_VIEW` page (white) | white row / list rows | page wipe on Buddy y 200–223 (5,760 px) or List/Grouped x 0–235, y 92–223 (31,152 px, ≤ 10,384 a step) |
| `SET_VIEW` task_page or task_pages only | the black row band | **task wipe**: 3 steps (T3), columns of the band revealed left → right when task_page = (old + 1) mod task_pages, else right → left; Buddy y 168–199, List/Grouped y 60–91 (7,680 px, ≤ 2,560 a step) |
| `SET_VIEW` keys (same view) | every band from row 18 | the layout wipe (§9.10, 4 steps) |
| List window moves | rows + scroll column | hardware scroll of y 94–221: TFA 94, VSA 128, BFA 98; 4 steps of 32 px, s<sub>i</sub> = 94 + (32 i mod 128) forward, 94 + ((128 − 32 i) mod 128) back (7,680 px a step) |

Animation: the white minis (≤ 16) and the List rows' minis as version 5; chips never animate. Worst case below the version 5
figure (≤ 16 animated minis instead of 27).

**Firmware budget and files:** `fm1c_proto.h` (`FM1C_PROTO_MAX 6`, view 6, the keys/task bytes, flags ≤ 31, bad-body
rules), a new `fm1c_draw6.h` (chips, band, compact boxes, settings screen), `fm1c_trans.h` (task wipe, SPLIT regions and
the 8-row scroll), `fm1c_led.h` (chosen timeline, ARP in view 6), `fm1c_help.h` (the three new tables). Platform files stay
byte-identical. RAM: + 3 B (keys, task_page, task_pages); slots unchanged (the tag is the label). Flash: estimated +3–5 KB,
inside the 140 KB cap of §9.13. Emulator gates unchanged (heartbeat every 1,000 ms, worst ACK ≤ 15 ms).

### 10.8 LEDs in SPLIT (protocol 6)

The host sends black-key states; the device applies LED language v2 (§9.9) per slot, plus one new timeline:

| Black key | `SET_SLOT.state` sent | LED |
| --- | --- | --- |
| **chosen** (flag bit 4), filter or task, any state | - | **CHOSEN: B**, in the backlight layer, breathing in step with the selected session (revised 2026-11-19, operator: the lit/glow blink read as flashing). First match: it overrides the state timeline. |
| ALL, not chosen | `idle` | G |
| PINNED, not chosen | `idle` when ≥ 1 pin exists, else `empty` | G / O |
| NEEDS YOU, not chosen | the most urgent display state (`URGENCY`) among the NEEDS YOU sessions, `empty` when there is none | that state's v2 timeline (approval sharp, question double blink, failed slow glow, unread tick) / O |
| task, not chosen | the most urgent display state of the sessions the task would show on the white keys; `idle` when it has none (a pinned task with no live session) | that state's v2 timeline |
| empty task slot | `empty` | O |
| no host | - | G (as every key) |

- CHOSEN breathes in the backlight layer with the selected session (one shared pulse width, so they move in step). Only
  the selection and the chosen key breathe, so it differs from every state timeline. The host never sets bit 0 on a black
  key, and bits 0 and 4 together are a bad body.
- The chosen task's own state is on its white keys, so the chosen key does not repeat it.
- Data: `fixtures/device/led-v2.json` `chosen` (the CHOSEN timeline sampled at 0, 350, 699, 700, 999, 1000, 1699, 1700,
  2000 ms over eight states), generated by `packages/device-simulator/scripts/gen-led-v2.ts` from `src/leds.ts`
  (`KEY_TIMELINES.chosen`); the `keys` and `buttons` arrays are unchanged.
- Buttons: as §9.9, plus **ARP L in view 6**. OCT LEDs unchanged. In view 6 SAVE, HOME and LFO glow (active controls,
  §9.9) and every other button is O, GLO's attention tick included.

### 10.9 Knobs, legend and title in SPLIT

| Choice | KNOB1 | KNOB2 | KNOB3 | KNOB4 |
| --- | --- | --- | --- | --- |
| ALL, NEEDS YOU, a task | `SHOW` (ACTIVE/RECENT/ALL: white list of ALL, the task row, a task's sessions) | `REPO` (all → repos, wraps; all is always reachable) | `TASK` (steps the chosen task through the task row) | `TALK` |
| PINNED | `SHOW` (the task row only) | `""` | `TASK` | `TALK` |

The legend cells name the knobs; the values (repo, task) are in the title and the turn's toast (docs/ux-v2.md §2.3).

**KNOB3 steps through the tasks** (operator brief 2026-11-19: "even on split task keys, expect knob 3 to scroll through
tasks and paginate"; "just tasks"). In Sessions with SPLIT keys (not DETAILS, voice or confirm):

- One task per detent through the frozen task row (§10.4 order: pinned tasks first, best tier, newest activity),
  **wrapping at both ends**. Only tasks: ALL, PINNED and NEEDS YOU are not in the cycle. Tasks the registry no longer
  knows are skipped; an empty row: nothing happens (no toast).
- From ALL, PINNED or NEEDS YOU the first turn picks the **first** task (clockwise) or the **last** (counter-clockwise).
- The task page follows the chosen task (crossing a page edge flips the task row page); the chosen key's LED and the
  black row update at once. Toast `Task: <title>` (the RANKED KNOB3 toast).
- The white keys are laid out again once the knob **rests 300 ms** (`KNOB3_REST_MS`, a console one-shot timer re-armed by
  each turn): one relayout per pause, white page 1. Any other input before that (a key, another knob, a button) lays them
  out first, so a white key never acts on the previous task's sessions.
- Unchanged: double OCT pages the task row and keeps the choice; black-key taps choose directly; tapping the chosen task
  again returns to ALL. The chosen task and task page persist as §10.10.

**KNOB2 REPO** cycles all → repos (§2.3 order) and wraps, both directions. Since 2026-11-19 (operator report "it does not
have all, cannot roll back") "all" is always reachable: the shared knob cycle used `items[next] ?? current`, which turned
the `null` "all" entry back into the current repo, so KNOB2 (and RANKED KNOB3) stuck at the last / first repo. **Implicit
repo:** a task chosen in RANKED (Tasks view tap, GROUPED folded row) sets REPO to the task's repo implicitly; the console
keeps the KNOB2 repo apart (`repoKnob`). Clearing that task choice (KNOB3 back to all in RANKED, the folded row tapped again,
ALL chosen in SPLIT, including a tap on ALL when it is already chosen, or the chosen task tapped again) puts REPO back to the
KNOB2 repo (all when KNOB2 chose none); a KNOB2 repo stays. When ALL drops an implicit repo, the task row re-sorts for the
new REPO (task page kept, clamped). Choosing a task in SPLIT (black key, KNOB3, Tasks view) never sets REPO. KNOB2 stays
inert under PINNED (scope or SPLIT choice).

TALK destinations: `Claude chat` / `Codex chat` create the chat in the chosen task, else as today (§3.7).

**Title** (≤ 20): ALL → as RANKED (`ACTIVE 20`, with REPO; no TASK part); PINNED → `PINNED <n>`; NEEDS YOU →
`NEEDS YOU <n>`; a task → `<task title, cut at a word boundary> <n>`; each plus ` +N new` as today. n = the sessions of the
white list. **Empty white list** (bubble row 0 / header caption, row 1 muted): PINNED as §9.4 (`No pins yet` /
`hold a key to pin`); NEEDS YOU `Nothing needs you` / `tap ALL or a task`; ALL or a task `No chats here` /
`KNOB1 shows more`.

### 10.10 Persistence (companion)

`config.json` `"split": { "chosen": "all" | "pinned" | "needs" | "task", "task": "<task key>" | null, "taskPage": 0…126 }`,
default `{ "chosen": "all", "task": null, "taskPage": 0 }`, validated (`task` is a 4-part task key exactly when `chosen` is
`task`, else null; `taskPage` an integer), written only when it differs from the default, saved on every change at most once
a second (trailing). `AgentConsole` takes `split` and `onSplitChanged`. On start the saved choice and task page are
restored; after the **first full snapshot** a chosen task that is not on the task row falls back to ALL (and is saved),
and the task page is clamped. The white page and the selection are not persisted. Pins: `sessionPins` and `taskPins`
(≤ 200 each, since 2026-11-19; §9.6).

### 10.11 Hint line, help and toasts

- **Hint line:** unchanged in RANKED (pixel-identical). In SPLIT the pairs are RANKED's; nothing selected:
  `SCL help  ARP setup` (19) instead of `SEQ <next>  SCL help`. SETTINGS: `SAVE set  HOME back` (19).
- **Toasts** (≤ 20): `Hold ARP: settings`, `Keys: split`, `Keys: ranked`, `Show: all`, `Show: pinned (<n>)`,
  `Needs you (<n>)`, `Task: <title>` (also each KNOB3 turn), `Repo: <name>` / `Repo: all` (KNOB2), `Task pinned`, `Task unpinned`, `Pins full (200)` / `Task pins full (200)` (only at
  the safety cap, §9.6), `Tasks <p>/<n>`, `No more tasks`.
- **Help** (`fm1c_help.h`; host `HELP_TEXT.base6`, `.split6`, `.settings6` in `agent-core/src/control-map.ts`, byte-equal;
  `test/control-map.test.ts` must compare them with `fm1c_help.h` once the firmware carries the tables). Selection in the
  firmware: view 6 → `FM1C_HELP_SETTINGS6` (4 lines, no knob lines, no grid); view 0 with keys 1 → `FM1C_HELP_SPLIT6`;
  other base views with proto ≥ 6 → `FM1C_HELP_BASE6`; proto 5 → `FM1C_HELP_BASE5`. BASE6 and SPLIT6 are followed by the
  two knob lines and the who-is-who grid as in version 4; voice, confirm and DETAILS help are unchanged.

```c
static const char *const FM1C_HELP_BASE6[6] = {
    "HELP - SEQ view  ARP settings",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
};
static const char *const FM1C_HELP_SPLIT6[6] = {
    "HELP - SEQ view  ARP settings",
    "white sel 2x open hold pin",
    "black filter/task hold pin",
    "OCT page/2x task  REC talk",
    "SELECT move  PRESETS read",
    "LFO details  ALGORITHM next",
};
static const char *const FM1C_HELP_SETTINGS6[4] = {
    "HELP - let go of SCL",
    "SELECT    move",
    "SAVE      change",
    "HOME/LFO/ARP  close",
};
```

SPLIT6 leaves SAVE, FX and ENV to the hint line, which names them whenever they act.

### 10.12 Unchanged in this round

- **TO DO** stays the flat 27 keys (keys 0 in `SET_VIEW`), in every Keys mode. **Tasks** (EDIT) stays flat. DETAILS,
  voice and confirm keep their screens (voice/confirm draw the compact black boxes of §10.7 over SPLIT Sessions).
- **RANKED** with protocol 6: the host sends keys 0 and otherwise the version 5 content; the device draws exactly the
  version 5 pixels. Only the help overlay's line 1 differs (`FM1C_HELP_BASE6`).
- Selection by identity, ALGORITHM, pins (no limit since 2026-11-19, §9.6), dismiss and undo, voice, approvals, reader and
  auto-return: unchanged in meaning.

### 10.13 Tests and evidence

**Host (bun):** codec and vectors (done, `packages/device-protocol`); controller: ARP tap toast vs 1 s hold (FakeClock), the
SETTINGS controls, Keys toggle re-lays Sessions under SETTINGS and persists; SPLIT white lists per choice, task row order and
paging, tags and collisions, the freeze table, arrivals into G5, task pin/unpin pages, chosen-task fallback, KNOB1 cycle and
legend; KNOB3 task stepping (order, wrap, page follow, first turn from ALL/PIN/YOU both ways, one relayout per 300 ms pause,
persistence, RANKED unchanged; `test/split.test.ts`); KNOB2 reaches all from every path and implicit repos clear with their
task choice (`test/knob-repo.test.ts`); OCT resolution (single after 300 ms, double within 300 ms of the first up, other OCT or other input
resolves the pending single first, a single never pages twice, RANKED stays immediate); `view.ts` black-key slots (label tag,
state, flags 3/4, title, age), titles and empty states, 4-row bubble; `render.ts` keys/task bytes only with 6 (stripped below),
order rules on keys change and view 0 ↔ 3/4 in SPLIT; config `settings` and `split` validation and default-omission; help
equality.
**Simulator:** `renderV4` draws §10.7 (Buddy strip, compact boxes, List/Grouped band, settings screen); `leds.ts` CHOSEN (done)
and a test against `led-v2.json` `chosen`; the task wipe and the 8-row hardware scroll in `transitions.ts`.
**Firmware host-mode scenarios** (each starts with `HELLO_ACK` proto 6; shots under `reports/evidence/ui-v3/split/`):
`v6-split-buddy` (ALL chosen, 3 task pages, one pinned task, attention states on the task chips), `v6-split-task` (a task
chosen), `v6-split-needs-empty`, `v6-split-list`, `v6-split-grouped`, `v6-split-voice` (compact boxes), `v6-split-task-wipe`
(`-0`, `-30`, `-70`, `-done`), `v6-split-window` (List window scroll, `-0`, `-20`, `-50`, `-90`, `-done`), `v6-settings`
(Ranked), `v6-settings-split` (after SAVE), `v6-help-split`, `v6-help-settings`, and `v6-ranked-*`: the version 5 and v5g
scenarios replayed with proto 6 and keys 0, pixel-identical to their v5 shots (help line 1 excepted). LED checks read
`led-v2.json` `chosen`.

### 10.14 Open points

- **Hint line in RANKED** does not name ARP, to keep RANKED pixel-identical; the settings entry is taught by help line 1 and
  the ARP tap toast. Say if `ARP setup` should appear in the RANKED nothing-selected hint as well.
- **The task row has no arrivals** between re-sorts (8 keys, no reserved slot); NEEDS YOU and the task chips carry new
  attention at once. A ninth task needing you on another task page is visible only through NEEDS YOU.
- **OCT single latency** in SPLIT is 300 ms after release (the cost of the double gesture).
- **CHOSEN timeline** (L 700 / G 300 ms at 1 Hz) and the 26 × 16 chips: on-device check of legibility before sign-off.
- **Task double tap** focuses the task's first session (Traycer's focus is per session; there is no task focus call).

### 10.15 Host implementation notes (build step, 2026-11-19)

The host side of this section is implemented in `packages/agent-core` (`src/split.ts`, `context.ts`, `controller.ts`,
`view.ts`, `console.ts`), `apps/companion` (`config.ts`, `companion.ts`, `device/render.ts`), `apps/companion-ui` (Keys
in the config form) and `packages/device-simulator` (`v4/screen.ts`, `v4/transitions.ts`, `leds.ts`, `state.ts`).
Decisions taken where §10.1-10.14 left room:

- **White-key layout.** The SPLIT white keys reuse the frozen `FocusLayout` with a geometry of 16 keys a page and key 15
  (G5) reserved on page 1 (`LayoutData.pageSize` / `reserve`, written only when not the flat 27, so RANKED layout data is
  byte-identical). `sessionPage` maps the white page onto the 16 white key numbers and leaves the 11 black keys null; the
  view overlays the black row.
- **Task row** is its own frozen list (`ControllerState.taskRow`), re-sorted only by the §10.4 freeze table
  (`resortSplit`: task row first, so its chosen-task fallback can change the choice, then the white keys).
- **Gesture timers.** The console arms real one-shot timers: ARP hold (1,000 ms after the down edge, cancelled by the up
  edge) and the OCT single (300 ms after the up edge). The reducer also resolves a late hold at ARP up and a waiting OCT
  single at the next input, so a lost timer never loses a press. `resolveOct` and `arpHoldElapsed` are exported for tests.
- **Counts.** `Show: pinned (<n>)`, `Needs you (<n>)` and the title count the white list including the flat pin block;
  `Show: all` carries no count (§10.11); KNOB1's toast counts the ALL list.
- **Desktop UI.** The config form offers Keys Ranked/Split; with a device below protocol 6 it notes "needs firmware v6
  (device shows Ranked)". The saved value applies at once (`AgentConsole.setSettings`).
- **Simulator.** `SIM_VERSIONS` stays 1-5 (the flashed firmware); `SIM_VERSIONS_V6` (1-6) is passed as
  `identity.versions` to draw protocol 6. List/Grouped SPLIT selection moves use the 8-row geometry; the window scroll uses
  TFA 94 / VSA 128.
- **Review fixes (2026-11-19).** The task row is not rebuilt while the registry is not ready (before the first full
  snapshot or with the backend link down), so early input cannot drop and save a restored task; reaching protocol 6
  under PINNED moves to ACTIVE + PINNED even before the first snapshot; `AgentConsole.stop()` cancels the gesture timers
  and saves a pending SPLIT choice at once; a chosen task's T0-T3 sessions are marked seen at layout (compared by key).
- **Not built here:** firmware (`firmware/**`), the codec (`packages/device-protocol`), the firmware host-mode scenarios
  and their screenshots under `reports/evidence/ui-v3/split/`.
- **Pins, no limit (2026-11-19, host only).** `focus.ts`: `MAX_PINS` replaced by `MAX_PINS_PER_KIND` (200),
  `flatOrder` (need you > pins > rest; pins first since 2026-11-22) for every flat path, `groupedLayout` rebuilt (task
  groups that need you, Pinned group, other tasks; the Pinned group first since 2026-11-22; PINNED adds folded rows for
  task pins), `pinnedSessions`; `split.ts` `whiteList` uses the same
  order (NEEDS YOU unchanged) and `inChoice` PIN admits session pins only; `controller.ts` caps per kind; `console.ts`
  takes `pins` as a legacy list or `{sessions, tasks}`, reports `PinLists`, and fetches out-of-scan pins in batches
  (`PIN_FETCH_TASKS` 25, `PIN_CATCHUP_MS` 5 s, `PIN_REFRESH_MS` 120 s); `view.ts` sets slot flag bit 3 for session pins
  only. Companion config `sessionPins` / `taskPins` with legacy `pins` migration. No firmware, codec or help change.

## 11. Suggested next prompt (host only, every protocol)

Date: 2026-11-19. Status: implemented (host, simulator, tests). Operator brief (approved): "traycer provides suggestions
for next steps in gui chats, and codex/claude also sometimes suggest; ... show it on the console and offer as fast option
on top of record". **No protocol bump and no firmware change**: everything below is host text the device already draws.

### 11.1 Source

`Session.details.suggestions` (agent-core, adapter-neutral): `string[]`, 0..3, best first, each ASCII and redacted, at
most 600 characters (validated in `parseDetails`; empty strings dropped). Traycer fills it from a GUI chat's
`suggestedPrompt` (chat.subscribe >= 1.20) or a terminal agent's trailing "next steps" list (docs/traycer-integration.md,
"Suggested next prompts"). The console offers none for a stale session or one with `prompt.acceptsPrompt === false`.

### 11.2 Bubble

When the shown chat has a suggestion, its bubble gets **one** row `Next: <first suggestion>` (`copy.ts nextLine`, cut at a
word boundary to the body width: 28 Buddy / SPLIT Buddy, 24 List and Grouped header) in the **heading** style (the
accent amber), after the state rows (`Approve:` / `Error:` / `Now:`) and before the last message. It is one row so the
message stays on the first page. A dedicated muted-accent style would need firmware (`FM1C_N_STYLE` is 3): see 11.6.

### 11.3 REC: short tap versus hold (host-timed)

`REC_TAP_MS = 350` (`context.ts`). Recording still starts on the REC **down** edge exactly as before (`voiceStart`, the
mic opens, no audio is lost on a hold). At the **up** edge the host compares the receive times (`World.now`) of the two
edges (`ControllerState.recDownAt`):

| Up edge | Effect |
| --- | --- |
| at or after down + 350 ms (a hold) | `voiceStop` exactly as before: transcribe, review |
| before down + 350 ms, reply destination with a suggestion | the take is dropped untranscribed; the first suggestion goes to the voice REVIEW state as the transcript, `source: "suggested"`, `suggestion: {index 0, count n}` (actions `voiceStart`, `voiceSuggest`) |
| before down + 350 ms, no suggestion (or a new chat / new task TALK destination) | the canned responses go to review instead (section 12); with no canned response either, the take is dropped (`voiceDiscard`: composer back to ready); toast `No suggestion/canned` (was `No suggestion`); nothing else changes |

REC down keeps every fail-early refusal (no prompt capability, `acceptsPrompt: false` with the adapter's toast, nothing
selected): then nothing records and the up edge does nothing. The device needs no change: it already sends both edges.
A tap shows the RECORDING screen for its < 350 ms (the mic is open that long; the audio is discarded). Works in every
view REC works in: Sessions RANKED and SPLIT (Buddy, List, Grouped), TO DO, and over the reader (DETAILS).

### 11.4 Review of a suggestion

The voice screen in `reviewing` as for dictated text (firmware caption `READY TO SEND`, hint `SAVE send  FX cancel`),
with a label in body row 1 (heading style, host text): `Suggested` for one suggestion, `Suggested <i>/<n>  PRESETS next`
(<= 28) for more; the text from row 2. Dictated text has no label (unchanged). Protocol 3 (no bubble): line 1 is
`Suggested` / `Suggested <i>/<n>`, line 2 the text.

| Input | Effect |
| --- | --- |
| SAVE | sends the shown text through the unchanged dispatch path (`voiceSubmit`: target re-check, precheck, a2a self-send for a Claude TUI, the Codex TUI refusal, delivery stages, retry with the same requestId) |
| FX | cancels (`Cancelled`); nothing sent; the suggestion stays offered |
| PRESETS | with more than one suggestion: the next / previous one, wrapping (`voiceSuggest` with the new index), after first scrolling a suggestion longer than the bubble to its end (or back to its start), so SAVE never sends text that was not shown; else the usual scroll |

Nothing is ever sent without SAVE.

### 11.5 Cleared on send, hint line, help

- **On send** (SAVE of any prompt, suggested or dictated, to a chat) the chat's shown list is recorded as spent
  (`ControllerState.spentSuggestions`, by session key and list JSON) and hidden until the adapter reports a different
  list; a spent list the adapter drops is forgotten (`pruneSpent`). Traycer's host also drops `suggestedPrompt` on a
  send; a terminal transcript keeps its list until the next answer, which is why the console hides it itself.
- **Hint line:** a reply with a suggestion shows `REC next` instead of `REC reply` (`REC next  PLAY open`, 19); without
  one, unchanged. The hold is taught by the help line `REC hold to talk`.
- **Help:** unchanged (`FM1C_HELP_BASE5/BASE6/SPLIT6` stay byte-equal with `fm1c_help.h`). The voice help's
  `PRESETS     scroll text` does not mention cycling: see 11.6.
- **Desktop UI:** the session row shows `Next: <first>`; the voice state reads `REVIEWING (suggested)`.

### 11.6 Firmware follow-ups (not needed for this round)

1. A muted-accent text style (style 3) for the `Next:` row instead of the heading amber (needs `FM1C_N_STYLE` 4, a
   protocol bump for the style value, and the host strip below it).
2. The voice help line `PRESETS     scroll text` could read `PRESETS     scroll / next` (help table change, byte-equal
   with the host).
3. A device-drawn `SUGGESTED` caption instead of the host label row (a SET_VOICE flag; protocol 7).

### 11.7 Evidence

Host tests: `packages/agent-core/test/suggestions.test.ts`, `packages/agent-adapter-traycer/test/suggestions.test.ts`,
`apps/companion/test/e2e-suggestions.test.ts` (over the device link), `packages/device-simulator/test/suggestions.test.ts`.
Shots: `bun apps/companion/scripts/suggestions-evidence.ts [console-host]` renders the real host frames (agent-core view
-> companion render, protocol 6 RANKED) in the simulator (`reports/evidence/ui-v3/suggestions/sim/`) and, given a
firmware host-mode binary built from `firmware/firmware/src` (the reviewed sources; built outside `firmware/`), in the
firmware (`.../host/`): `suggest-buddy-next`, `suggest-list-next`, `suggest-review-1of3`, `suggest-review-2of3`. Firmware
and simulator agree pixel for pixel in RGB565 outside the animated hero (`results.json`). Never sent to the FM-1.

## 12. Canned responses (host only, every protocol)

Operator-approved 2026-11-22. Prompts the operator keeps for reuse, offered on the voice REVIEW screen after the
selected chat's suggestions (section 11). Companion and agent-core only: no firmware or protocol change; the
firmware-equal help text (`control-map.ts HELP_TEXT`, `fm1c_help.h`) is unchanged.

### 12.1 Storage

Companion config `canned: [{id, text, uses, createdAt, lastUsedAt}]` (`apps/companion/src/config.ts`): at most 50
entries, text at most 2000 characters, trimmed and ASCII-folded like a transcript (accents dropped, other non-ASCII a
space, whitespace runs one space; `agent-core canned.ts cannedText`). Order everywhere: `uses` desc, then `createdAt`
desc. Written on every change and always written (even empty). A config without the key (or no config file) loads the
three seeds `Status update? What's done, what's left, and any blockers.`, `Rebase on main, fix CI, push, and tell me when
it's green.`, `Continue where you stopped.`; once the key exists it is never seeded again, even when empty. The list
lives in `ControllerState.canned`; the reducer changes it and `AgentConsole` reports each change (`onCannedChanged`).

### 12.2 Use: REC short tap

The tap of 11.3 opens REVIEW on a combined list: the chat's suggestions first (reply destinations only), then every
canned response. With no suggestion the first canned response is shown; new chat / new task TALK destinations (no
suggestions there) get the canned list only. Only when both are empty: toast `No suggestion/canned` (20).

- **Label row** (host text, body row 1, <= 28): suggestions keep `Suggested <i>/<n>  PRESETS next` (`Suggested` for one);
  canned entries show `Canned <i>/<n>  PRESETS next` (`Canned` for one). Decision: `i/n` counts **within the entry's own
  group** (suggestions, or canned responses), not the combined list, so the suggestion labels stay as in section 11.
  Protocol 3: line 1 `Canned <i>/<n>` / `Canned`.
- **PRESETS** steps through the combined list and wraps both ways (after scrolling a long text to its end, as 11.4).
  A canned entry is found again by id, so a re-sort after a send never makes PRESETS skip.
- **SAVE** sends through the normal dispatch path, identical to dictated text (new task: the usual confirm first). A sent
  canned entry gets `uses + 1` and `lastUsedAt = now` (counted at the SAVE that sends, or the confirming SAVE), and the
  list re-sorts. A retry after a failed send does not count again.
- **FX** (a tap) cancels. Nothing is sent without SAVE.
- The composer records `source: "canned"` and `cannedId`; the desktop UI shows `REVIEWING (canned)`.

### 12.3 Record: ARP tap on a review

On REVIEW (dictated text, a suggestion, or a canned entry) ARP is host-timed like the SETTINGS gesture (down/up edges,
`ARP_HOLD_MS` 1 s): a tap (up before 1 s) saves the shown text as a canned response, toast `Saved as canned <N>` (N the
list size after the add). An exact duplicate (trimmed, case-insensitive, after folding): `Already canned`. A full list
(50): `Canned list full`. Nothing is sent; the review stays and SAVE / FX still decide the message. ARP held 1 s or
more on a review does nothing. On REVIEW, ARP never opens SETTINGS (any protocol); the base views keep 10.2 (tap
toasts `Hold ARP: settings`, hold opens SETTINGS).

### 12.4 Delete: FX hold on a canned entry

On REVIEW showing a canned entry, FX acts on its **up** edge (host-timed from the BUTTON edges the device already sends):

| FX | Effect |
| --- | --- |
| released before 1 s (`CANNED_DELETE_HOLD_MS`) | cancel (`Cancelled`), as always |
| released at or after 1 s | the entry is deleted (`Canned deleted`); the review shows the entry now in its place in the combined list (or the last one); when the list is empty the review closes |
| pressed again within 3 s of the delete (`DISMISS_UNDO_MS`) | the entry comes back (`Canned restored`, same id, uses and dates); a review still open shows it again; works from a base view too (the review closed) |

Any other input ends the undo window (as the TO DO dismiss, docs/ux-v2.md section 3.6). The delete happens at release,
not at the 1 s mark: the toast is a COMMAND_RESULT, which the companion sends only in answer to an input, so the up edge
carries it (no timer path to the device). On a suggested or dictated review FX still cancels at the down edge.

### 12.5 Hint

The 20-column hint line is full (`SAVE send  FX cancel`, 20) and stays. Version 4: when the review text leaves body row
5 free (at most 3 rows including the label), row 5 shows a muted hint: `ARP save canned` (dictated / suggested) or
`Hold FX: delete canned` (canned). Longer texts show none.

### 12.6 CLI and the running companion

`fm1-console canned list | add <text...> | add --file <path> | rm <n|id> | edit <n|id> <text...>` edits the config
file directly (`apps/companion/src/cli/canned.ts`; `n` is the listed number). The running companion re-reads `canned`
from the file before every device input when the file's mtime changed (`config.ts cannedReloader`, wired in
`runtime.ts`), so its next save, which writes the whole config, carries the CLI's edit instead of undoing it. Chosen
over a file watcher: no watcher lifecycle, and the list is fresh exactly when a press can use or change it. Residual
race: a CLI write landing between that re-read and a save in the same input is lost (milliseconds).

### 12.7 Evidence

Host tests: `packages/agent-core/test/canned.test.ts`, `apps/companion/test/canned.test.ts` (config, CLI, reload, and
the gestures over the device link). The simulator renders host text only: no change.

---

## 13. Markdown and highlights (host, every protocol; highlights protocol version 7)

Operator approval 2026-11-23 (A + B). Before this round the adapters stripped Markdown and collapsed a message into one
line (`chat-details.ts plainText` + `asciiFold`, `terminal-transcript.ts clean`, 600 characters), so a heading, a list
or a code block read as one run of words. Now:

- **A (host only, every protocol version):** the message keeps its structure. Headings, paragraphs, lists, code, tables
  and quotes become SET_TEXT rows of one style each (`body` / `heading` / `muted`), wrapped at the row width.
- **B (protocol version 7, host + firmware):** inline highlights inside a row (bold, code) and a drawn column rule for
  tables, as control bytes in the SET_TEXT text. Versions 1-6 get exactly the A rows (same text, same columns).

### 13.1 Data model (agent-core)

- `packages/agent-core/src/markdown.ts` is the one Markdown reader, shared by the Traycer adapter (GUI chats and TUI
  transcripts), the mock adapter and the views.
  - `markdownBlocks(source): MdBlock[]`: width-independent structure. Blocks: `heading`, `para` (one source line),
    `item` (`depth`, `marker` `-` or the ordered `1.` / `1)`), `quote` (one line), `code` (lines), `table`
    (`header`, `rows`, cells as plain text), `gap` (a blank line between blocks; runs collapsed, never first or last).
    `para` / `heading` / `item` / `quote` carry `inline: {text, mark?: "bold" | "code"}[]`.
  - `layoutMarkdown(blocks, width, maxRows = 96): {style, text, spans?}[]`: rows of at most `width` visible
    characters; `spans: {start, end, mark: "bold" | "code" | "rule"}[]`, non-overlapping, at most 4 bold/code spans per
    row (later ones are drawn plain), rules unlimited.
  - `clipRow`, `blocksPlain`, `parseBlocks` (validation of adapter input).
- `SessionDetails.lastMessage` stays the plain one-line string (<= 600, unchanged for every existing consumer: summary,
  companion UI, tests). New optional `SessionDetails.lastBlocks?: MdBlock[]` and `PromptReply.blocks?` carry the
  structure. `validate.ts parseDetails` checks them (`parseBlocks`: known kinds, string fields, marker `-` or
  `\d{1,9}[.)]`, depth an integer capped at 3, non-ASCII folded to spaces); a malformed `lastBlocks` rejects the details
  like any other malformed field.
- Rows (`TextRow`, `BubbleRow`) gain `spans?`. Every cut (`bubbleRows`, `listHeadRows`, `padPage`) uses `clipRow`, so
  text and spans are cut together. Without `lastBlocks` everything is exactly as before (plain wrap).

### 13.2 Markdown to rows (A)

Source handling (adapter, `chat-details.ts messageBlocks`): `redactSecrets` over the whole raw message first (so a
multi-line PEM block or a token inside a code block is masked), then `asciiFoldLines` (the `asciiFold` character table,
but line breaks and tabs kept and nothing collapsed: `•` becomes `-`, `—` `-`, accents dropped, anything else a space),
then at most **2000 characters** (cut at the last line break past the middle), then `markdownBlocks`. agent-core
normalises again (CRLF/CR to LF, tab to 4 spaces, non-ASCII to space, trailing spaces dropped).

Rules, in order per line:

1. **Fenced code** (```` ``` ```` or `~~~`, 3+, up to 3 spaces of indent; an info string is ignored; unclosed runs to
   the end) and **indented code** (4 spaces, after a blank line or at the start, not continuing a paragraph or list
   item, not a nested item of the list above): `muted` rows, one per source line, no joining or wrapping. A line wider
   than the row is cut to `width - 1` characters plus `~`. Blank-line runs inside collapse to one empty row. With
   version 7 each code row carries one `code` span over its text (leading spaces excluded).
2. **Headings** `#`..`######` (a space after the hashes; closing hashes dropped) and setext (`===` / `---` under a
   paragraph line): `heading` rows without the markers and without inline marks. A line whose every non-space
   character is bold (`**Summary:**`) is a heading too.
3. **Thematic break** (`---`, `***`, `___` alone, not under a paragraph): a paragraph gap.
4. **Tables** (GFM: a line with `|` followed by a separator row): see 13.3.
5. **Blockquote** (`>`, nested `>` flattened): `muted` rows, `| ` before every row (the first and the wrapped ones). An
   empty quote line is a paragraph gap.
6. **Lists**: `-`, `*`, `+` become `- ` (FONT_S has ASCII 32-126 only, `firmware/firmware/gen/felucca_font.h`, so no
   `•`); ordered markers (`1.`, `10)`) are kept. Nesting: 2 columns per 2 spaces of source indent, at most 3 levels,
   and never more than leaves half the row for the words. Wrapped rows hang under the first word (indent = prefix
   length). A following line that is not a new block joins the item with a space (a wrapped item). A blank line between
   two items adds no gap row. Task boxes stay as text (`[ ]`, `[x]`).
7. **Paragraphs**: every source line is its own block (line breaks are kept: chat output is line-oriented), wrapped
   greedily at word boundaries; a word longer than the row is split at the row width. A blank line (or a run of them)
   is one empty `body` row between blocks.

Inline (every text block): code spans (any run of backticks to the same run) keep their text with the `code` mark;
`**x**` / `__x__` / `***x***` keep the text with the `bold` mark (bold pairs are found over the whole line, so
`**see `x` now**` stays bold around the code; code wins inside); `*x*` / `_x_` lose the markers (intraword `_` is
kept: `snake_case`); `~~x~~` -> `x`; `[t](u)` and `[t][r]` -> `t`; `<https://...>` -> the address; images are dropped
(a line of only an image is no row); common HTML tags (`b`, `br` as a space, `details`, `code`, ...) are dropped, any
other `<...>` stays literal (`<redacted>`, `Array<string>`); backslash escapes give the character. Unmatched markers
stay literal (`2 * 3`). Spaces collapse to one; a space between two words with the same mark joins one span.

The List and Grouped header (one message line at a time, section 8.4) drops the empty gap rows; the Buddy bubble and
DETAILS keep them. The bubble's "more" row (row 6, or row 5 in SPLIT Buddy) is `" "` when the next row is a gap, so the
wedge still says there is more.

### 13.3 Tables

Separator rows are dropped; cells are plain text (inline markers removed, `\|` is a pipe); missing cells are empty.

- **Aligned** when every column fits: sum of the widest cell per column + one column per gap <= row width. The header
  row is `heading`, data rows `body`; cells are padded to the column width (the last column is not padded); each gap is
  one space carrying a `rule` span. Version 7 draws the rule (13.5); below 7 it is the space.
- **Records** otherwise (chosen over cut `a | b | c` lines, which lose most of a wide table at 24-29 columns): per data
  row, the first cell as a `heading` row (`-` when empty), then for every other non-empty cell a `body` row
  `<header>: <cell>` wrapped with a 2-column hanging indent. A header-only table is one `heading` row `a | b | c`.

### 13.4 Where it applies, and the length budget

| Surface | Width | Rows of the message |
| --- | --- | --- |
| Buddy bubble (versions 4-7), rows 1-5, PRESETS by 5 | 28 | up to 96 |
| SPLIT Buddy bubble, rows 1-4 | 28 | up to 96 |
| List / Grouped header row 1 (gap rows dropped) | 28 (as before: `focusBubble` passes 24 only for List) | up to 96 |
| DETAILS version 3 (12 rows x 8 pages) | 29 | 96 |
| DETAILS version 4+ body (9 rows x 8 pages) | 29 | 72 |
| PRESETS scroll tail, versions 1-3 | 20 | all, gap rows dropped |

Sources: GUI chats (`chat-details.ts ChatDetails.setMessage`), TUI terminal answers (`terminal-transcript.ts
parseTranscript`), a2a replies (`session-book.ts setReply`: the reply's own blocks replace the chat's older ones), and the
mock adapter (`withMarkdown`: `lastMessage` read as Markdown when a fixture gives no `lastBlocks`). `parseNextSteps`
still reads the raw answer (unchanged). The voice transcript, approvals, errors, activity and facts stay plain.

The cap was 600 characters of flattened text. Now: 2000 characters of source (enough for the bubble and 8 DETAILS pages
of typical answers) and 96 rows (8 pages x 12); `lastMessage` keeps its 600.

### 13.5 Protocol version 7: inline highlights (B)

**Choice: control bytes inside the SET_TEXT text** (evaluated against a per-row span list field `u7 n` + n x
`(start, len, kind)`): 2 bytes per span instead of 3 + 1, no new arrays in the firmware model, and the drawing loop is
the glyph loop it already runs (one byte test per character). The span list would need a second buffer per row,
bounds checks against the text, and a merge at draw time.

Bytes (only these are new; `TextStyles` and every other field are unchanged):

| Byte | Meaning | Columns |
| --- | --- | --- |
| `0x01` | bold on: following characters in the bold colour | 0 |
| `0x02` | code on: following characters in the code colour | 0 |
| `0x03` | off: back to the row colour | 0 |
| `0x04` | column rule: one 8 px cell with a vertical line | 1 |

- A mark switches the current colour (no nesting: `0x02` inside bold switches to code). The colour resets to the row
  colour at the start of every row; an unterminated span runs to the row end (the host omits the final `0x03` when a span
  ends with the row).
- Limits per row: at most **29 visible** characters (printable ASCII and `0x04`), at most **8 style bytes**
  (`0x01`-`0x03`), so at most **37 bytes**. Any other byte below `0x20` (or above `0x7E`) is a bad body. Width and
  wrapping count visible characters only: a row's columns are the same with and without its marks, so the version 6
  rows (marks dropped, rule as a space) have exactly the same layout.
- Body size: three 37-byte rows would be 119 bytes > `MAX_BODY` 100. The host sends a group whose body would pass 100
  as consecutive frames of fewer rows, in row order (greedy: 2 + 1); a group that fits stays one frame. The device
  already accepts `count` 1-3 at any row.
- The host sends marks **only when version 7 was agreed** (`framesFor`); below 7 it strips them. A version 7 decoder
  accepts them in every negotiated version (decoding does not depend on the version).
- Rows that carry marks: the message rows only (bubble body rows 1-5, the List/Grouped header row 1, DETAILS rows of the
  message, voice rows never). Captions (row 0), SETTINGS rows, hints and facts never carry them, but the device must
  draw any row with marks correctly wherever it draws a SET_TEXT row.

Colours (RGB888, quantised to RGB565 like every firmware colour; the text is alpha-blended onto black as today):

| Mark | Body / muted row | Heading row | RGB565 |
| --- | --- | --- | --- |
| bold | accent amber RGB(255, 176, 0) (`FM1C_STYLE_RGB[heading]`) | white RGB(255, 255, 255) | `0xFD80` / `0xFFFF` |
| code | RGB(128, 208, 255), new `FM1C_C_CODE` | same | `0x869F` |
| rule | RGB(128, 128, 128) `FM1C_C_GREY`, 1 px wide at cell x + 3, from the text's top y for 16 px | same | `0x8410` |

A row whose colour the device overrides (row 0 in the state colour, the SETTINGS cursor row in white) uses that colour as
the "row colour"; bold is white when the row's style byte is heading, else amber. No background fill for code (a
filled box would show the black alpha fringes of `cv_text`, and costs a rect per span).

### 13.6 Firmware (for the firmware step; `firmware/firmware/src/`, not changed in this round)

1. `fm1c_proto.h`: `FM1C_PROTO_MAX 7u`; `FM1C_L_TEXT_WIRE 37u` (29 visible + 8); the SET_TEXT decoder reads each row
   with a new `fm1c_text_str(&r, dst)`: `len <= 37`, every byte `0x01-0x04` or `0x20-0x7E`, visible (`0x04` and
   printable) `<= 29`, else `r->err`. The test encoder (`fm1c_puts` for SET_TEXT) mirrors it. The decoded struct and
   `m->text` rows become `char [FM1C_L_TEXT_WIRE + 1]` (+96 B model RAM, +24 B frame struct).
2. `fm1c_model.h`: `fm1c_str_set(m->text[r], ..., FM1C_L_TEXT_WIRE)`; dirty logic unchanged (byte compare).
3. `fm1c_draw.h`: `#define FM1C_C_CODE RGB(128, 208, 255)` and one drawing function used for every SET_TEXT row
   (DETAILS `fm1c_draw_row`, `fm1c_draw4_body`, `fm1c_draw4_detail_row` incl. header rows 1-2, row 0 caption,
   `fm1c_v5_head_into` rows 0-1 via `fm1c_v5_text`, the SETTINGS rows and description in `fm1c_draw6.h`, and the
   transition strips in `fm1c_trans.h`):
   `static int32_t fm1c_rich(int32_t x, int32_t y, const char *s, uint32_t max_cols, uint16_t c, uint32_t style)`:
   current colour = `c`; for each byte: `0x01` -> bold colour (white if `style == FM1C_TS_HEADING`, else
   `FM1C_STYLE_RGB[FM1C_TS_HEADING]`), `0x02` -> `FM1C_C_CODE`, `0x03` -> `c`; otherwise stop when `max_cols` visible
   cells are drawn, `0x04` -> `fm1c_rect(x + 3, y, 1, 16, FM1C_C_GREY); x += 8`, else draw the glyph at x in the current
   colour (`fm1c_text` on a 1-character string, or on runs of one colour; pixels are identical) and advance. Returns x.
   `fm1c_v5_text(x, y, t, max, c)` becomes a call to it (cut by visible cells, not bytes).
4. Budget: same canvases and blits, so the SPI cost per row is unchanged; per glyph one extra byte test, per rule one
   16 px rect. Flash: one function (~150 B) and a colour.
5. Vectors: `firmware/tests/console/gen_vectors.py` picks up the new shared vectors (13.8); the version 7 valid vectors
   carry bytes `0x01`-`0x04` in JSON strings as `\u0001`..`\u0004`.

### 13.7 Simulator

`packages/device-simulator`: `Framebuffer.richText` (raster.ts) is an independent implementation of 13.5 (the simulator
imports only types from the protocol package); `screen.ts textRow` draws every SET_TEXT row through it (bubble body,
captions, List header with the 20/24 cuts, DETAILS rows, SETTINGS rows with the 26 cut, the SPLIT bubble).
`RICH_RGB` holds the colours. `SIM_VERSIONS_V7 = {1, 7}`; the default stays 5. Parity: the firmware step should add
host screenshots of a version 7 bubble and DETAILS page with bold, code and a table, and compare them against
`renderV4` like `v4-firmware-parity.test.ts`.

### 13.8 Tests and evidence

- `packages/agent-core/test/markdown.test.ts`: inline, headings (incl. bold line, setext), paragraphs and gaps, CRLF,
  lists (nesting, hanging indent, wrapped items), fenced / unclosed / indented code, narrow and wide tables, quotes,
  links / images / HTML, long words, empty input, the 2000 / 96 caps, the mixed message, width and span invariants at
  20-29 columns, the span limit, `clipRow`, validation, bubble / List / DETAILS rows, and the console views with the
  mock adapter (v3, v5 List, v7; hint and legend unchanged).
- `packages/agent-adapter-traycer/test/markdown-details.test.ts`: folding with lines kept, redaction inside code and of
  PEM blocks, TUI transcripts (`lastBlocks` + suggestions), GUI chats (`ChatDetails`), and a2a replies (`SessionBook`).
- `packages/device-protocol/test/rich-text.test.ts` and the shared vectors: valid `set_text_v7_bold_code`,
  `set_text_v7_table`, `set_text_v7_row_max` (two 37-byte rows, 80-byte body), `set_text_v7_open_span`,
  `set_text_v7_sanitised` (decoded differs: `0x07` -> `?`, the 9th and later style bytes dropped); invalid (bad_body)
  `set_text_v7_byte_0x05`, `set_text_v7_byte_0x00`, `set_text_v7_len_38`, `set_text_v7_visible_30`; negotiation
  `v7_device_v7_host` 7, `v6_device_v7_host` 6, `v7_device_v6_host` 6, `v1_device_v7_host` 1.
- `apps/companion/test/e2e-v7.test.ts`: render gating (v7 marks, v3-6 stripped, v1-2 no SET_TEXT), group splitting,
  and end to end with a version 7 and a version 6 simulator.
- `packages/device-simulator/test/v7-rich-text.test.ts`: colours per mark and style, the rule geometry, identical glyph
  positions with and without marks, DETAILS rows.

### 13.9 Open points

- The Grouped header still wraps the message at 28 although the firmware cuts its message line at 24 (`focusBubble`
  passes 24 only for List; pre-existing, unchanged here).
- Tables lose inline marks in cells (plain cells keep the column math simple); headings lose inline code marks.
- Nested blockquotes are flattened; lists inside quotes read as quote text.
- Firmware parity screenshots for version 7 do not exist yet (13.7).

## 14. Read aloud (host only, every protocol)

Operator-approved 2026-11-23. Hold PLAY on a selected session to hear its latest message. No firmware or protocol
change: the host resolves the gesture from the PLAY down / up edges, and every toast is an ordinary `COMMAND_RESULT`.
The firmware help text (`control-map.ts` HELP_TEXT) is unchanged.

### 14.1 Gesture (agent-core `controller.ts`, `console.ts`)

- Where: Sessions, TO DO, and the DETAILS page over them, when a chat is shown (`focusEntry`). Without one PLAY
  toasts `Select a chat first` on the down edge, as before.
- `READ_ALOUD_HOLD_MS` = 1000 (agent-core `speech.ts`). PLAY down stores `playDownAt`; the console arms a one-shot
  timer (like the ARP hold, §10.2). Still down after 1 s: read aloud. Released sooner: open on Mac (focus), exactly the
  old PLAY action. A late up edge (timer missed) past 1 s reads aloud.
- **The short action moves from the down edge to the release** on a session. A press cannot be told from a hold at its
  down edge, and firing focus on down plus read aloud on hold would do two things for one press. Cost: open on Mac
  happens at release (a tap is ~100 ms). Tasks (PLAY new chat), confirm and voice (PLAY retry) still act on the down
  edge and have no hold.
- An input that moves to another view while PLAY is down (voice, confirm, Tasks) drops the pending press.
- While read aloud is busy (preparing or playing): PLAY down or FX down, in any view, only stops it (toast `Stopped`);
  the matching up edge does nothing. When nothing is speaking FX keeps its meaning. REC (voice start) also stops
  playback, so the microphone never hears it.
- Nothing to read (no message): toast `Nothing to read`.

### 14.2 Speech text (agent-core `speech.ts`)

From `newestMessage` (the reply or `lastMessage`), using its Markdown blocks (§13) when the adapter gave them, else
the plain text. Secrets are already redacted by the adapter; the result is ASCII.

| Block | Spoken as |
|---|---|
| heading | a sentence (`Summary.`) |
| paragraph lines | one sentence run, a period added when missing |
| list item | one sentence each; ordered items keep their number (`1, review.`) |
| quote | `Quote: ...` |
| code block | `Code omitted.` (consecutive blocks once) |
| table | row by row as `header value` phrases: `File view.ts, Status done.` (empty cells skipped) |
| link / image | label only (markdown.ts); bare URLs become `link` |

### 14.3 Summary of long text (`apps/companion/native/fm1-summarize`)

- Speech text longer than `readAloud.summarizeOverChars` (default `READ_ALOUD_SUMMARY_CHARS` = 600) goes to
  `bin/fm1-summarize` on stdin. It uses Apple's on-device model (FoundationModels, macOS 26,
  `SystemLanguageModel.default`), prints a 2-3 sentence plain summary on stdout, and exits 2 with a reason when the
  model is unavailable (Apple Intelligence off, device not eligible, model not ready), 3 on empty input, 4 when the
  model fails. Prompt: a concise neutral summary of an AI coding agent's reply for listening; no markdown.
- Built by `scripts/build-native.sh` (`bun run build:native`), no Info.plist or Disclaim.swift (no TCC permission).
- Time limit `SUMMARY_TIMEOUT_MS` = 20 s. Unavailable, failed, timed out or not built: the first ~600 characters are
  read (`clipSpeech`, cut at a sentence end) with toast `Summary unavailable`.
- The summary runs in parallel with the Kokoro start-up.

### 14.4 Speech (Kokoro-FastAPI) and playback (`apps/companion/src/speech/read-aloud.ts`)

- TTS: Kokoro-FastAPI at `readAloud.kokoroUrl` (default `http://127.0.0.1:8880`), `POST /v1/audio/speech`
  `{model: "kokoro", input, voice, response_format: "mp3"}`, voice `readAloud.voice` (default `af_heart`; list:
  `GET /v1/audio/voices`). Limit 60 s.
- Health: `GET /health` must answer `healthy` (2 s limit). When it does not: `docker ps -a` finds containers of
  `readAloud.dockerImage`'s repository (any tag). A running one is only polled; else an existing one is
  `docker start`ed; else `docker run -d --name fm1-kokoro -p 127.0.0.1:<url port>:8880 <image>` (loopback only). **The
  first `docker run` downloads the image** (~GBs; limit 10 min); nothing else is ever pulled. Toast
  `Starting voice...`, then `/health` every 1 s for up to 90 s. Docker missing or not running, a failed start, or no
  health within 90 s: toast `Voice offline`.
- Playback: the audio goes to a fresh private temp directory (`fm1-read-*`, file mode 0600), `afplay` plays it, and the
  directory is removed when playback ends or is stopped. One playback at a time: a new request kills the current
  `afplay` first; stop kills it.
- Toasts (copy.ts NOTICE, <= 20): `Starting voice...`, `Reading`, `Reading summary`, `Stopped`, `Voice offline`,
  `Summary unavailable`, `Nothing to read`. Later toasts are reported against the last device frame's SEQ.
- Logs carry lengths and outcomes only, never the text.

### 14.5 Config (`readAloud`, saved only when not the default)

| Key | Default | Rule |
|---|---|---|
| `voice` | `af_heart` | 1-128 of `A-Za-z0-9_.+()-` (Kokoro mixes like `af_heart+af_bella`) |
| `kokoroUrl` | `http://127.0.0.1:8880` | http(s), no query / fragment / credentials; trailing `/` dropped |
| `summarizeOverChars` | 600 | integer 100-2000 |
| `dockerImage` | `ghcr.io/remsky/kokoro-fastapi-cpu:latest` | a Docker image reference (starts with a letter or digit) |

### 14.6 Tests and open points

- agent-core `test/read-aloud.test.ts`: tap vs hold (no double action, late edge, DETAILS, Tasks unchanged), stop via
  PLAY / FX / REC, speech text. Companion `test/read-aloud.test.ts`: health, `docker start` / `docker run` / Docker
  missing, polling limit, summary success / unavailable / timeout / not built, afplay and kill, temp clean-up, config
  round trip, companion toast wiring. Fake runner, fetch and clock only.
- Open: no hint-line mention (the 20-character hint lines are full: `REC reply  PLAY open`); no progress toast while a
  long summary is computed; the desktop UI has no `readAloud` form fields.
