# FM1 CONSOLE screen layout

The 240 x 240 LCD as the firmware draws it (`firmware/firmware/src/fm1c_draw.h`, `fm1c_help.h`). All coordinates are
pixels from the top left; ranges are inclusive.

**UX v2** (`docs/ux-v2.md`). The words below are v2's in every protocol version (§1.2 of that document). The layout
has these forms, picked by the version `HELLO_ACK` agreed (the firmware speaks 1..4):

- **Version 1** (an old companion): the legend, line 4 and the key strip are drawn as before UX v2.
- **Version 2**: the legend names each knob, line 4 is a hint bar, the voice view shows the transcript, the key strip
  is drawn as the keyboard, pinned keys are marked, and holding SCL shows a help overlay.
- **Version 3** (`docs/ux-v2.md` §7): everything of version 2, plus the full-screen **DETAILS page** (view 5) drawn
  from `SET_TEXT`. The host opens it only when version 3 was agreed (LFO); see [DETAILS page](#details-page-view-5-version-3).
- **Version 4** (`docs/ui-v3.md`, direction A "Buddy and bubble"): the same messages drawn as a character per chat,
  its newest message in a speech bubble, the 27 sessions as critters in keyboard order. Version 4 adds no message; see
  [Version 4: characters](#version-4-characters). Everything below that section describes versions 1–3, which draw
  exactly as before.

Before the first host (and while none is agreed) the screen keeps the last agreed layout; at boot it is the newest,
version 4, so the boot banner has the ghost character.

The device simulator (`packages/device-simulator`) still draws the version 1 layout; see the open gaps in
`reports/firmware-validation.md`.

Screenshots of every state: `reports/evidence/firmware-host/` (host mode) and `reports/evidence/emu/` (the real
package in fm1-emu). Both sets show the same pixels at RGB565 precision for every state they share (`tests/console/compare_shots.py`).

![Sessions, version 2](../reports/evidence/emu/emu-v2-sessions.png)

## Version 4: characters

Files: `fm1c_draw4.h` (the drawers), `fm1c_sprite.h` (the 4 bpp blitter, `cv_pset` only), `fm1c_sprites.h` (generated
sprite data), `fm1c_anim.h` (the animation scheduler, pure), `fm1c_model.h` (`fm1c_model_apply4`, the v4 key boxes,
the knob row), `fm1c_help.h` (`FM1C_HELP_BASE4`, `_DETAIL4`, `_WORDS4`). Screens: `reports/evidence/ui-v3/after/`
(host mode and the USB package in fm1-emu, next to the design mocks).

![Sessions, version 4](../reports/evidence/ui-v3/after/host/v4-sessions.png)

| Rows | Region (dirty bit) | Contents |
| --- | --- | --- |
| 0–17 | Top bar (`FM1C_D_STATUS`) | As in version 1–3 but 18 rows: words at y 1, rule on row 17 |
| 18–67, x 0–51 | Hero (`FM1C_D_HERO`) | The selected chat's character, the 24 x 24 frame drawn 2x (48 x 48) at (4, 20). Pose from `SET_DETAIL.state`, species from `SET_DETAIL.provider` (codex: the bot; anything else: the cat) |
| 18–67, x 52–239 | Label (`FM1C_D_LABEL4`) | The selected slot's label in `FONT_L` at x 60 when it fits 176 px (11 capitals), else `FONT_S`; `SET_DETAIL.line1` at y 50 in #C0C0C0. Voice: `to <target>`. Confirm: the verb (`line1`) as the label, the target below |
| 68–183 | Bubble (`FM1C_D_BUBBLE` for the frame; `dirty_rows` 0–6 for the text) | A 1 px frame with cut corners, 236 x 108 at (2, 74), in the state colour at 80 %; its tail up at the hero (x 22). Caption = `SET_TEXT` row 0 at (8, 78) in the state colour (calm states #969696), the selected key's name (`G#3`) right-aligned in grey. Body = rows 1–5 at y 96 + 16(r−1), 224 px each, in the row's style colour. Row 6 non-empty: a white wedge on the bottom edge ("more") |
| 184–223 | Critter keyboard (`FM1C_D_KBD`; `dirty_keys`) | 11 black-key minis in 14 x 14 boxes at y 184 (x = 8 + 14(a+1) − 7), 16 white-key minis at y 202 (x = 8 + 14w). A mini is the 12 x 12 sprite at +1, +1. Empty: a 4 x 2 dash. Selected: a 1 px white frame. Pinned: a 2 x 2 white dot top right. Stale: the ghost in its provider's shape |
| 224–239 | Hint bar (`FM1C_D_HINT4`) | `SET_DETAIL.line4` with the hint-bar token colours; the toast over it; for 2,000 ms after a K1–K4 turn the **knob row** (four 60 px cells: a knob glyph, the number, the `SET_LEGEND` label; the turned one lit #464646) |

Views:

- **Voice** (`FM1C_V4_TAIL_X_VOICE`): the bubble becomes the operator's, framed in the voice state's colour with its
  tail on the right (x 206). Caption: a REC dot (8 x 8, blinking 500/500 ms) and the voice state words; the elapsed
  time right-aligned (`FM1C_D_ELAPSED`). Recording / transcribing: a 28-bar level meter over the body rows, one bar
  (5 px wide, 8 px pitch, centred at y 136) per `SET_VOICE` elapsed step, sweeping left to right with a gap ahead of
  the newest bar (`dirty_bars`). Other voice states: rows 1–5 carry the transcript or the error.
- **Confirm**: amber bubble, caption `Please confirm`, `SET_DETAIL.line2..4` in the body, hint `SAVE yes   FX no`.
- **DETAILS** (view 5): the hero stays; `SET_TEXT` rows 0–2 are the header right of it at x 60 (row 0 in the state
  colour), rows 3–11 the body at y 72 + 16(r−3) (row 11 down to 223); the hint bar `PRESETS older  LFO close` at
  224–239. No keyboard.
- **Help** (SCL held, rows 18–223): `FM1C_HELP_BASE4` (6 lines), the two knob lines built from `SET_LEGEND`
  (`KNOB1 SHOW  KNOB2 REPO`), a rule, and who is who: the eight characters (Claude left, Codex right) with
  `FM1C_HELP_WORDS4`. Voice, confirm and DETAILS show their own tables. Hint `let go of SCL to close`.
- **NO COMPANION / version mismatch**: the dimmed screen and a 208 x 128 banner at (16, 56), drawn as two 208 x 64
  strips (`CV_MAX` is 240 x 80), with the ghost (2x, floating) at (96, 62), the big words at banner row 56 and the
  reason at row 96. A refused version shows the `huh` character and a red border.

### Sprites

- Source of truth: `firmware/assets/sprites/hero-<pose>-<provider>.png` (24 px high, 4 or 2 frames of 24 x 24) and
  `mini-<pose>-<provider>.png` (12 x 12 frames), palette PNGs with the 16-entry sprite palette (0 transparent, 1–12
  fixed colours, 13–15 the state's body / light / shade placeholders). Seeded once from the design's procedural
  sprites by `firmware/tools/sprites_seed.py`; edit the PNGs by hand from now on.
- `python3 -I firmware/tools/gen_sprites.py` checks sizes, frame counts and palette indices and writes
  `firmware/firmware/src/fm1c_sprites.h` (raw 4 bpp, 2 px per byte, high nibble first; 60 hero frames x 288 B =
  17,280 B, 26 mini frames x 72 B = 1,872 B, palettes 86 B, the key names `FM1C_NOTE`). `tests/console/run.sh`
  regenerates it and requires the committed header to be byte-equal.
- Poses: working `work` (8 fps), waiting `wave` (6), approval `hand` (6), failed `dizzy` (6), done unread `happy` (8),
  done read and idle `sleep` (4), unknown `huh` (4), disconnected and stale `ghost` (4, 2 frames). Minis move (2
  frames at 4 fps) only in the first five; calm minis are still. Four slot colours too dark to carry a face are
  lightened for sprites only (`docs/ui-v3.md` §2).

### Animation and the link

Animation is the lowest-priority drawing (`console.c anim_ok`): it runs only on a pass that drew no content, with no
host frame queued, no device frame awaiting its ACK (`fm1c_link_busy`), 20 ms after the last host frame, and not
under the help. `fm1c_anim_due` picks the boxes whose frame changed (frames come from `fm1_ms`, so boxes in the same
pose move together, like the key LEDs), hero first, then the REC dot, then keys in order, and stops before the next
box would pass `FM1C_ANIM_PX_PASS` = 2,400 px (one hero frame, 2,304 px = 3.1 ms of SPI at 12 MHz, or 16 minis of
144 px). A box not drawn on time is drawn later at the frame of that time: frames are skipped, never queued.

Content drawing is bounded too: `fm1c_draw4` draws one region at a time and stops when a host frame came in while a
region went out (`fm1c_yield`), leaving the rest marked for the next pass; and while a burst of host frames is still
arriving (a gap under 3 ms, at most 120 ms) the main loop parses and ACKs them without drawing (`draw_held`), then
draws the final state once. The largest regions: the keyboard 240 x 40 (only on a view change or the first draw),
a bubble row 224 x 16 (3,584 px, 4.8 ms), the bubble frame strips 6,336 px.

Measured (host mode, pixel counter; `v4-counters`, `anim_test`): 3 s with every session calm: 27,648 px (the sleeping
hero only, 12 frames); one `SET_SLOT`: 196 px; one changed bubble row: 3,584 px; all 27 keys animating: worst pass
2,304 px, 24,768 px/s; the sample page 23,616 px/s by the scheduler model. Link under animation (`v4-soak`, 60 s,
20 host frames/s, every sprite moving, on the USB package in fm1-emu): see `reports/firmware-validation.md`.

## Version 5: the LIST layout

`docs/ui-v3.md` §8 (direction B's chat list as a second layout). Files: `fm1c_draw5.h` (the drawers),
`fm1c_model.h` (`fm1c_list`, `fm1c_list_win`, `fm1c_list_row` / `_key`, `fm1c_list_check`), `fm1c_proto.h` (the
optional `SET_VIEW.layout` byte and `SET_SLOT.title` / `age`), `fm1c_help.h` (`FM1C_HELP_BASE5`). Drawn when version 5
is agreed, the view is Sessions (0) or TO DO (2) and `SET_VIEW.layout` is 1. Tasks, voice, confirm and DETAILS are drawn
as version 4 whatever the layout; NO COMPANION puts the version 4 banner over the dimmed list. Screens:
`reports/evidence/ui-v3/after/host/v5-*.png`.

![Sessions as a list, version 5](../reports/evidence/ui-v3/after/host/v5-list-sessions.png)

| Rows | Region (dirty bit) | Contents |
| --- | --- | --- |
| 0–17 | Top bar (`FM1C_D_STATUS`) | As version 4 |
| 18–59, x 0–28 | Hero (`FM1C_D_HERO`) | The selected chat's character, 24 x 24 at 1x at (4, 26), from `SET_DETAIL.state` + `provider` |
| 18–59, x 29–239 | Header bubble (`FM1C_D_BUBBLE`; `dirty_rows` 0–2) | A cut-corner frame 204 x 40 at (34, 19) in the version 4 bubble colour, its tail left at the hero. Caption (`SET_TEXT` row 0) at (40, 22) in the state colour, the selected key's name ending at x 231 in grey; the message line (row 1, ≤ 24 characters) at (40, 38); row 2 non-empty: the white more wedge at (224, 55). Each of the three can be drawn alone (strips 192 x 16, 192 x 16, 7 x 4); the device cuts the caption at 20 and the message line at 24 characters, so the whole header and its strips draw the same pixels |
| 60–223, x 0–235 | List (`FM1C_D_LIST`; `dirty_lrows`, `dirty_keys`) | 10 rows of 16 px at y 62 + 16n; rows 60–61 and 222–223 black. A row: the selected one on #303030; the 12 x 12 mini at (4, 2) (the stale ghost, the pin dot at (15, 1)); the key name (`F3`…`G5`) at x 20 (selected white, else grey); `SET_SLOT.title` at x 48 (stale grey, selected white, else #C0C0C0); `SET_SLOT.age` right-aligned to x 232 |
| 60–223, x 236–239 | Scroll column (with `FM1C_D_LIST`) | More than 10 entries: a grey thumb at x 237–238, y 62 + 160·top/L, 160·min(10, L − top)/L high |
| 224–239 | Hint bar (`FM1C_D_HINT4`) | As version 4 (`SET_DETAIL.line4`, the toast, the knob row) |

- **Rows and the window**: the entries are the non-empty slots in key order (the frozen layout order); the window starts
  at 10 · floor(s / 10) for the selected entry s (else 0), so the device keeps no list state of its own.
- **Redraws**: a `SET_SLOT` marks its key; in the list that is its row (3,776 px), when the key is in the window. The
  window or the occupancy (as a mask of the non-empty keys) is compared with what was drawn last at draw time (`fm1c_list_check`), so a selection
  change inside the window (deselect, select) costs the two rows and the caption strip (measured 10,624 px plus sprite
  frames), and only a moved window or an occupancy change redraws all 10 rows, the gaps and the scroll column (about
  39,400 px). A `SET_VIEW` whose layout changes, or that enters or leaves the list, marks everything. In the buddy layout
  a `SET_SLOT` that changes only `title` or `age` stores them and marks nothing.
- **Animation**: the small hero (576 px a frame, `fm1c_anim.hero_small`) and the minis of the rows shown (a selected
  row's mini redrawn on #303030, a pinned one keeps its pixel). Keys outside the window are not tracked. Measured: 8,640
  px in 1 s with a working hero and the sample page (`v5-list-anim`); the scheduler, its 2,400 px pass budget and its
  gates are those of version 4.
- **SEQ LED**: glows while a list is shown (LED language v2, `docs/firmware-controls.md`).
- **Help**: in every base view with version 5, `FM1C_HELP_BASE5` (first line `HELP - SEQ buddy/list/group`, §9.11),
  then the knob lines and who is who as version 4.

## Version 5: the GROUPED list, PINNED, transitions

`docs/ui-v3.md` §9 (still protocol version 5, additive). Files: `fm1c_proto.h` (`SET_VIEW.layout` 2, the optional
`SET_SLOT` row byte and head fields with their bad-body rules), `fm1c_model.h` (`fm1c_grouped`, `fm1c_shown_layout`, the
entry list `fm1c_list_win` / `_ent` / `_row_of`, header and folded masks in `fm1c_list_moved`), `fm1c_draw5.h`
(`fm1c_v5_header`, indented session rows), new `fm1c_trans.h` (the transitions and the panel's vertical scroll),
`fm1c_draw4.h` (the clip and scroll-aware blit `fm1c_cvx` every v4/v5 drawer now uses; the hint bar with an offset),
`fm1c_led.h` (LED language v2), `fm1c_help.h` (`FM1C_HELP_BASE5`), `console.c` (the backlight layer, the 20 ms
breathing, the transition dispatch, input completes a transition). Screens: `reports/evidence/ui-v3/after/host/v5g-*.png`;
transitions as GIFs (4× slow motion, the step shots) in `reports/evidence/ui-v3/after/transitions/`.

![Sessions grouped, version 5](../reports/evidence/ui-v3/after/host/v5g-grouped.png)
![PINNED](../reports/evidence/ui-v3/after/host/v5g-pinned.png)
![PINNED, empty](../reports/evidence/ui-v3/after/host/v5g-pinned-empty.png)

- **When**: view 0 with `SET_VIEW.layout` 2 (`fm1c_grouped`). Layout 2 in TO DO draws the List; elsewhere Buddy. The
  bands, the hero, the header bubble, the scroll column, the hint bar and the 10 rows of 16 px are the LIST layout's.
- **Entries** (§9.3): for each non-empty key in key order, a header entry when `row.start` is set, then a session
  entry unless `row.task` (a folded task row is its header only). The window is 10 · floor(s / 10) for the selected
  key's session entry s, as in the List; the thumb counts entries.
- **Header row** (`fm1c_v5_header`, 236 × 16): a 1 px #303030 rule on its top line; the still mini (frame 0) of
  `head.state` at (4, 2); the 2 × 2 pin dot at (15, 1) when `head.pinned`; the title in white at x 20 (folded: the key
  name in grey at x 20 and the title in #C0C0C0 at x 48), cut to `(xc − 8 − x0) / 8` characters; the count right-aligned
  to x 232 in the state's caption colour. Header minis never animate; a folded row is never selected.
- **Session row**: the List row with the mini, pin dot, key name and title shifted right by 8 · indent (0–2); the
  background and the age stay put. The title is drawn with at most 20 − indent characters (the host cuts it so; a
  longer one from the host is cut here, so it never reaches the age).
- **Redraws**: a `SET_SLOT` that changes the row byte or a head field marks its key (its header and session rows);
  a changed entry list (occupancy, header or folded masks) redraws every row and the scroll column (`fm1c_list_check`).
  The minis of session rows animate as in the List, shifted by the indent.
- **PINNED** is a host scope: the device draws its title (`PINNED <n>`), its groups and the empty state (no keys; the header
  bubble's caption `No pins yet` and line `hold a key to pin`) from the frames.

### Transitions (`fm1c_trans.h`, §9.10)

The main loop (`console.c`) runs one of three things a pass: a running transition (`fm1c_trans_run`), else a new one
when the model differs from what was last drawn in a way §9.10 lists (`fm1c_trans_detect`, compared with the snapshot
`fm1c_sn`), else the usual draw. A transition starts and steps only with the link quiet (no host frame waiting, no
device frame awaiting its ACK); its steps are due at t0 + (0, 30, 70) or (0, 20, 50, 90) ms, each drawn in passes of
≤ 2,400 px (`FM1C_ANIM_PX_PASS`) with the link served between them; a step that cannot start within 40 ms ends the
transition at once; the transition ends at t0 + 120 ms (the reader at t0 + 110, when its screen draws as usual), and
only then is what it held back drawn (other regions a host frame marked meanwhile, the scroll column after a page or
window move, the caption's key name after a selection slide, and in Grouped the header row of either key of a slide when
the same burst marked that key). Any key, button or encoder edge completes it at once, and so does the help opening
or closing (also when SCL's hold, not an edge, opens it). Sprites stand still while it runs. A resync (new host session,
negotiation, link lost or back) and the screen after the help closes are drawn without one (the snapshot is dropped).

| Transition | Steps | Measured (host mode: px a transition / largest step) |
| --- | --- | --- |
| Selection slide, List/Grouped | 1–2 the grey frame moves (rows under it redrawn unselected), 3 the old row, the new row and the rows under the frame as they are | 27,432 / 11,328 |
| Selection slide, Buddy | 1–2 a white 14 × 14 frame between the key boxes, 3 the boxes as they are | 1,084 / 588 |
| Hero pop | squash (18 rows from 24, bottom-aligned), pop (1 · scale px up), normal | 1,800 / 600 (List box) |
| Page wipe | the list band (or the keyboard) revealed in thirds, left → right or back | 38,704 / 12,956 |
| Layout wipe (SEQ) | the body band y 18–223 in four row bands | 49,440 / 12,480 |
| Reader open / close | three outlines in the caption colour between the bubble / header and the full body; the screen at t0 + 110 | 2,258 / 888, 1,854 / 752 |
| Reader page | hardware vertical scroll, 4 × 38 rows | 36,480 / 9,120 |
| List window | hardware vertical scroll, 4 × 40 rows | 38,400 / 9,600 |
| Toast / knob row in, out | the bar at offset 11, 5, 0 (in) or 5, 11, then the hint line (out) | 11,520 / 3,840 each |
| Voice text scroll | software, the 224 × 80 body moved 20 px a step | 71,680 / 17,920 |

**Vertical scroll.** `FM1C_VSCROLL_HW 1` (default) sends `VSCRDEF` (0x33: TFA, VSA, BFA = 320 − TFA − VSA) and
`VSCRSADD` (0x37) through `lcd.c`'s `lcd_cmd` / `lcd_data` (the RAM window is first moved off the visible 240 lines, so a
panel model that does not know the commands writes their parameters where nothing shows); every scroll moves the whole
area, so the last step lands on the identity and nothing outside a transition sees an offset (`fm1c_vs_identity` runs
at every end). Host mode models the commands on its screen buffer and maps blits like the panel. `FM1C_VSCROLL_HW 0`
(built and run by `run.sh` for `v5g-trans-window` and `v5g-trans-reader-page`) draws the page or window at once.
**On-device check pending** (a wrong register would show a shifted body until the next full redraw).

**Deviations and notes.** (1) The voice text scroll follows §9.10's own row (4 steps of 17,920 px = 71,680 px), which is
over the common 60,000 px a transition; each step stays under 18,000 and is drawn in passes, so the link gates hold
(the simulator does the same); the spec owner should either allow it or move the row to 3 steps. (2) The host-mode
step shots (`-<n>`) are taken 15 ms after 1,000 + n (host mode shoots at the start of its ms, before that ms's passes):
`SETTLE` in `scenario/scenarios.ts`. (3) The firmware's transitions start from the screen as drawn after a burst
(version 4's burst hold), so the `SET_TEXT` groups that come before a `SET_VIEW` never show on the old screen.

## Version 6: SPLIT keys and the SETTINGS view (`docs/ui-v3.md` §10)

`fm1c_draw6.h`, version 6 agreed (`FM1C_PROTO_MAX 6`). With `SET_VIEW.keys` 0 (RANKED) or absent, every screen is the
version 5 one, pixel for pixel; the only difference under protocol 6 is line 1 of the base help (`FM1C_HELP_BASE6`).
With keys 1 (the 27 slots hold the SPLIT assignment) the device knows each key's role from its number: k 1, 3, 5 the
filters ALL / PINNED / NEEDS YOU, k 8, 10, 13, 15, 17, 20, 22, 25 the task slots, the 16 white keys sessions.

**Chips** (one per black key, 26 × 16): centre c = 8 + 14 (a + 1) for the white key a it follows (22 … 218), on two
staggered lines (black index even: line A, odd: line B 16 px lower), so a 3-character tag fits where neighbours are
14 px apart. A line A chip has a 1 px stem from its bottom down past line B (y0 + 16 … y0 + 31). Kinds: chosen (flag
bit 4) white with a black tag and a white stem; a filter a 1 px frame and tag in `fm1c_v4_col(state)` (no state:
`#303030` frame, grey tag); a task filled with that colour, the tag white or black by `fm1c_dark`, a 2 × 2 dot at
(x0 + 23, y0 + 1) when pinned; an empty task slot a 4 × 2 dash, no stem. Task page dots (task_pages > 1): up to 8
2 × 2 dots at x 234, one every 4 px, the current white. Chips never animate.

| Screen | Rows |
| --- | --- |
| SPLIT Buddy (view 0, layout 0) | 0–67 as version 4; bubble frame 236 × 92 at (2, 74), caption y 78, body rows 1–4 at y 96–159, row 5 the more wedge (strip y 160–167); band y 168–199 (line A 168, line B 184); white minis y 200–223 exactly as version 4 (boxes at y 202); hint 224–239 |
| SPLIT List / Grouped (view 0, layout 1 / 2) | 0–59 as version 5; band y 60–91; rows 92–93 black; 8 rows of 16 px at y 94 + 16 n; 222–223 black; scroll column x 236–239, y 92–223 (thumb from y 94 over 128 px); entries are the white keys only, top = 8 ⌊s / 8⌋ |
| voice / confirm over SPLIT (views 3, 4, keys 1) | the version 4 screen; each black 14 × 14 box compact: chosen a white 12 × 12 fill, a filter a 12 × 12 frame, a task a 12 × 12 fill in its colour, an empty slot the dash |
| SETTINGS (view 6) | top bar (no page number: page / pages are the cursor and the item count); 18–21 black; 9 item rows 240 × 20 at y 22 + 20 n (n < pages: the cursor row on `#303030` with a white `>` at x 4 and white text at x 16, others `#C0C0C0`, style 2 grey; text cut at 26); description (SET_TEXT row 9) at y 204 in `#A0A0A0`; hint 224–239. No hero, keys or animation |

Regions: `FM1C_D_BAND` the band (7,680 px); a black key's `dirty_keys` bit its chip (416 px box + 16 px stem, two
blits); Buddy `FM1C_D_KBD` the white row (5,760 px), `FM1C_D_BUBBLE` the 4-row strips (6,080 px); List `FM1C_D_LIST`
rows 92–223. SETTINGS: `FM1C_D_LIST` the body (the 960 px gap, then it marks every row: never one 49,440 px blit),
`dirty_rows` 0–8 an item row (4,800 px), 9 the description (5,280 px), each its own region.
A change of `fm1c_shape` (layout, SPLIT band, settings, compact boxes) redraws everything.

Transitions (§10.7, within §9.10's budget): page wipe on the white row (Buddy y 200–223, 5,760 px) or below the band
(List x 0–235, y 92–223); the **task wipe** on a task page change alone (the band in 3 columns, left to right for the
next page, 7,680 px, ≤ 2,560 a step); the List window by hardware scroll of y 94–221 (TFA 94, VSA 128, 32 px a step);
a keys change in the same view: the layout wipe. Reader open/close from SPLIT Buddy uses the 92 px bubble.

## Regions

| Region | Rows | Contents |
| --- | --- | --- |
| Status bar | 0–23 | View title on the left. On the right, from right to left: attention badge, link indicator, page. A 1 px rule on row 23. |
| Panel | 24–135 | Four bands: head 24–39, label 40–71, lines 72–87, 88–103, 104–119, 120–135. What they hold depends on the view. |
| (gap) | 136–139 | Black. Redrawn with the key strip. |
| Key strip | 136–199 | Version 1: 27 cells, key 0 on the left. Version 2: 11 black keys (136–165) above 16 white keys (166–199). |
| Legend | 200–239 | Four cells of 60 px with the `SET_LEGEND` labels; version 2 adds the knob name above each. |
| Help overlay | 24–199 | Version 2, while SCL is held: covers the panel and the key strip. |

In the DETAILS page (view 5) the regions below the status bar are different: 12 text rows at 24–215 and a hint band
at 216–239; see [DETAILS page](#details-page-view-5-version-3).

The NO COMPANION banner covers (16, 80) to (223, 159), on top of the panel and the key strip.

## Fonts

- `FONT_S`: Terminus 8 x 16, ASCII 32–126, 8 px advance. A 20-character line is 160 px.
- `FONT_L`: 16 x 32, capitals, digits and signs. Lower case is drawn as capitals, and anything else as `?`. Up to
  14 characters fit in the 232 px the panel allows. Longer text drops to `FONT_S`.

## Colours

Slot states (`SET_SLOT.state`, `SET_DETAIL.state`):

| State | RGB | RGB565 | Chip text |
| --- | --- | --- | --- |
| empty | #000000, outline #303030 | 0x0000, 0x3186 | (no chip) |
| disconnected | #202020 | 0x2104 | OFFLINE |
| idle | #606060 | 0x630C | IDLE |
| working | #2F7DF6 | 0x2BFE | WORKING |
| waiting_input | #A050F0 | 0xA29E | NEEDS ANSWER |
| approval_required | #FFB000 | 0xFD80 | NEEDS APPROVAL |
| completed_unread | #20C060 | 0x260C | DONE, UNREAD |
| completed_read | #2A5A3A | 0x2AC7 | DONE |
| failed | #F03030 | 0xF186 | FAILED |
| unknown | #404040 | 0x4208 | NO STATUS |

Other colours: text white; secondary text #C0C0C0; muted text #808080; version 7 inline code #80D0FF (0x869F); badges and the provider chip #303030;
banner background #101010. Text on a chip is white when the chip is dark, otherwise black. The test is
`2R + G + 2B < 140` on the RGB565 channels.

## Status bar

- **Title**: `SET_VIEW.title` in white, drawn with `FONT_S` at (4, 4). When `SET_STATUS.link` is not ok and
  `SET_STATUS.text` is set, the status text replaces the title, in amber #FFB000. With no title, the status text is
  shown instead, or `FM1 CONSOLE` if that is empty too. A long title is cut off by the right-hand group.
- **Attention badge**: an amber chip with the count in black, capped at 99. It is shown only when the count is
  above 0 and a version has been agreed. Its right edge is at x = 235.
- **Link indicator**: 6 px to the left of the badge, in `FONT_S`. When all is well it is a 6 x 6 green square at
  rows 9–14, with no text.

  | Shown | Colour | When |
  | --- | --- | --- |
  | 6 x 6 square | #20C060 | Version agreed, `SET_STATUS.link` = ok |
  | `LIMITED` | #FFB000 | `SET_STATUS.link` = backend_degraded |
  | `OFFLINE` | #F03030 | `SET_STATUS.link` = backend_down |
  | `NO REPLY` | #F03030 | A device frame went unacknowledged after 3 retransmissions. Cleared by the next ACK or HELLO_ACK. |
  | `CONNECTING` | #808080 | Host frames arrive, but no HELLO_ACK yet (or the host restarted). No page or badge. |
  | `VERSION` | #F03030 | HELLO_ACK refused the version (the banner says why) |
  | `NO LINK` | #F03030 | No valid host frame for 3500 ms (also at boot) |

- **Page**: `page+1/pages` in #808080, 8 px to the left of the link indicator. It is shown when `pages` > 1.

## Panel: sessions, tasks and inbox views

| Band | Contents |
| --- | --- |
| Head (24–39) | Provider chip at x = 4: `CLAUDE`, `CODEX`, `OTHER` from `SET_DETAIL.provider`; none for `none`. State chip in the state colour, ending at x = 236, from `SET_DETAIL.state`; none for empty. |
| Label (40–71) | The label of the selected slot (the first slot with flag bit 0) in `FONT_L` at x = 4, in white. With no selection it shows `nothing selected`, and for a selected slot without a label `(untitled)`, both in grey `FONT_S`. |
| Line 1 (72–87) | `SET_DETAIL.line1`, white |
| Lines 2–3 (88–119) | `SET_DETAIL.line2..3`, #C0C0C0 |
| Line 4 (120–135) | Version 1: `SET_DETAIL.line4`, #C0C0C0. Version 2: the **hint bar** (below). |

**Hint bar** (version 2): rows 120–135 filled #202020, `SET_DETAIL.line4` in `FONT_S` at x = 4. Each space-separated
token that matches `^[A-Z0-9][A-Z0-9+/-]+$` (a control name such as `SAVE`, `REC`, `OCT-/OCT+`) is white; every other
token is #A0A0A0. So `SAVE approve FX deny` reads as two buttons and what they do.

**Command result toast:** `COMMAND_RESULT` fills the line 4 band with the result's colour and writes its text, or
a fallback when the text is empty. The toast lasts 2.5 s, or 4 s for failed and target_unavailable. It appears in
every view and covers the hint bar while shown. Colours and fallbacks: accepted_locally grey `OK`; sent blue #2F7DF6
`Sent`; acknowledged blue `Received`; completed green #20C060 `Done`; failed red #F03030 `Failed`; unsupported amber
#FFB000 `Not supported`; target_unavailable red `Target gone`.

## Panel: voice view

The voice view replaces the panel contents.

| Band | Contents |
| --- | --- |
| Head | `VOICE` chip |
| Label | The voice state in `FONT_L`, in its colour: `READY` #C0C0C0, `RECORDING` #F03030, `TRANSCRIBING` #2F7DF6, `READY TO SEND` #FFB000, `SENDING` #2F7DF6, `DELIVERED` #20C060, `CANCELLED` #808080, `SEND FAILED` and `TARGET GONE` #F03030 |
| Line 1 | Recording / transcribing (and every state in version 1): the mic level bar, a 1 px grey frame at (4, 74) 232 x 12, filled from (5, 75) for `level x 230 / 100` px, 10 px high; green below 70, amber below 90, red from 90. Version 2 draws it empty while transcribing. Version 2, other states: `SET_DETAIL.line1` (the transcript, or the error) in white. |
| Line 2 | Recording / transcribing (and version 1): elapsed time `12.3 s` from `SET_VOICE.elapsed_ds`. Version 2, other states: `SET_DETAIL.line2`, #C0C0C0. |
| Line 3 | `to ` in grey, then the target in white, or `(no target)` in grey |
| Line 4 | Version 1: toast, or empty. Version 2: the hint bar from `SET_DETAIL.line4` (e.g. `SAVE send  FX cancel`), or the toast. |

![Reviewing, version 2](../reports/evidence/emu/emu-v2-voice-reviewing.png)

## Panel: confirm view

| Band | Contents |
| --- | --- |
| Head | `CONFIRM` chip in amber |
| Label | `SET_DETAIL.line1` (the action) in `FONT_L`, or `FONT_S` when wider than 232 px |
| Lines 1–3 | `SET_DETAIL.line2..4`, #C0C0C0 |
| Line 4 | `SAVE yes   FX no`: a chip (#303030) in version 1, the hint bar in version 2; or the toast |

The device only reports the SAVE and FX presses. The companion decides what they mean.

## DETAILS page (view 5, version 3)

`SET_VIEW.view = 5`. The whole screen below the status bar shows the selected chat's details (`docs/ux-v2.md` §7.4).

| Rows | Contents |
| --- | --- |
| 0–23 | The status bar as in every view: `SET_VIEW.title` (e.g. `DETAILS fm1 console`), `page+1/pages` when `pages` > 1, link, badge. |
| 24–215 | 12 text rows from `SET_TEXT`: row n at y = 24 + 16n, `FONT_S` at x = 4 (≤ 29 characters, 232 px), black background. Style 0 `body` white #FFFFFF, 1 `heading` amber #FFB000, 2 `muted` #A0A0A0. |
| 216–239 | Hint band: filled #202020, the fixed text `PRESETS page  LFO close` at (4, 220) with the hint-bar token colours (control names white, other words #A0A0A0). A `COMMAND_RESULT` toast fills this band instead (the line 4 toast's colours, fallbacks and durations; text at y = 220). |

- The panel bands, the key strip and the legend are **not drawn** in view 5. `SET_DETAIL`, `SET_SLOT` and
  `SET_LEGEND` still update the model; leaving view 5 redraws everything with what they hold.
- `SET_TEXT` is stored in every view (a 12-row buffer of style + text, `fm1c_model.tstyle` / `text`) and drawn only in
  view 5. A HELLO_ACK with a new `host_session` clears the rows to empty `body`.
- Help (SCL held) in view 5 covers rows 24–215 with `FM1C_HELP_DETAIL`; the status bar and the hint band stay.
- Button LED: LFO full while the view is DETAILS, else off.
- A version 3 link in the other views draws exactly as version 2 (every version 2 rule is `proto >= 2`).

![DETAILS, page 1 of 2](../reports/evidence/ux-v2/after/detail-page1.png)

## Rich text in SET_TEXT rows (version 7)

Protocol version 7 (`docs/ui-v3.md` §13.5, `docs/protocol.md` §3) lets a `SET_TEXT` row carry control bytes. The
decoder accepts them in every negotiated version; a version 1–6 host never sends them. Every place that draws a
`SET_TEXT` row draws it through one function, `fm1c_rich` (`fm1c_draw.h`): the DETAILS rows (versions 3 and 4+,
header rows 0–2 included), the Buddy bubble caption and body (also SPLIT), the List/Grouped header rows 0–1
(`fm1c_v5_text`, cut at 20 / 24 **visible** cells), the SETTINGS items (26 cells) and description, and the voice
transcript's scroll strip (`fm1c_trans.h`).

| Byte | Effect | Columns |
| --- | --- | --- |
| `0x01` | bold on: amber #FFB000 (0xFD80); white #FFFFFF in a `heading` row | 0 |
| `0x02` | code on: #80D0FF (0x869F, `FM1C_C_CODE`) | 0 |
| `0x03` | off: back to the row colour (the style colour, or the colour the device overrides: the state colour for row 0, white for the SETTINGS cursor row) | 0 |
| `0x04` | column rule: one 8 px cell, a 1 px #808080 line at cell x + 3 from the text's top y, 16 px high | 1 |

No nesting (a mark replaces the colour), the colour resets at every row, an open span runs to the row end, and code
has no background. A row holds at most 37 bytes and 29 visible characters (printable ASCII and `0x04`); the model
keeps the bytes as received (`fm1c_model.text`, 12 × 38 B). Glyphs are drawn in runs of one colour with the same
`cv_text` pixels as before, so a row without marks is drawn exactly as in version 6, and a marked row's glyphs sit in
the same cells as its unmarked form. The canvases, blits and dirty rules are unchanged (a changed row is still one
row region).

![Version 7 DETAILS: bold, code and table rules](../reports/evidence/ui-v3/markdown/host/v7-detail.png)

## Key strip, version 2: the keyboard

The keys are drawn where they are on the FM-1: 16 white keys (F3 … G5) in a row, 11 black keys above the gaps.
`fm1c_key_box(m, k, …)` in `fm1c_model.h` gives each key's box, which is also its redraw rectangle.

- **White key** k ∈ {0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26}, white index w = 0…15: box x = 8 + 14w,
  14 x 34, rows 166–199. Fill x+1…x+12, rows 170–195. Selected: a 2 px white frame over x…x+13, rows 168–197, the fill
  x+2…x+11.
- **Black key** k ∈ {1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25}, over the boundary after white key a ∈ {0, 1, 2, 4, 5, 7,
  8, 9, 11, 12, 14}: c = 8 + 14(a+1), box x = c − 6, 12 x 30, rows 136–165. Fill c−5…c+4, rows 140–163. Selected: a
  2 px white frame over rows 138–165, the fill c−4…c+3.
- **Empty**: black with a 1 px #303030 outline over the fill. **Stale** (flag bit 2): the fill crossed corner to corner.
- **Pinned** (flag bit 3): the top 4 rows of the fill white, or black on a light state colour.
- One key's redraw: 476 px (white) or 360 px (black).

## Key strip, version 1

- Cell column for key k: x = 8 + 8k + 4·⌊k/9⌋. Each column is 8 px wide, and the 27 keys form three groups of 9
  with 4 px between groups.
- **Normal cell**: filled in the state colour over x+1..x+6 and rows 144–191 (6 x 48).
- **Empty cell**: black with a 1 px #303030 outline over the same rectangle.
- **Selected cell**: a white column over x..x+7 and rows 140–195, which is a 2 px outline, with the state colour
  inside over x+2..x+5 and rows 142–193. An empty selected cell is black inside.
- **Stale (flag bit 2)**: the colour rectangle is crossed corner to corner, in black on light colours and in white
  on dark ones.
- The provider and pinned flags are not drawn on the strip.

## Legend

Version 1: each `SET_LEGEND` label centred in its 60 px cell at row 212, white.

Version 2: the labels belong to KNOB1–KNOB4 (the encoder row right of the screen). Each non-empty cell shows its
knob's name `KNOB1` … `KNOB4` in #808080 centred at row 202, and the label in white centred at row 220. An empty
label leaves the cell empty (only the separators). Knobs only change a setting; buttons act, and the hint bar names
them.

## Help overlay (version 2 and 3)

Hold **SCL** (button 3) for 400 ms while version 2 or 3 is agreed. Rows 24–199 (DETAILS: 24–215) turn black and show
up to 11 lines of `FONT_S` at x = 4, y = 26 + 16n; line 0 in amber, the rest white. The status bar and the legend
(DETAILS: the hint band) stay visible. The text (`fm1c_help.h`, equal to agent-core's `HELP_TEXT`) depends on the
view: the base list (sessions, tasks, TO DO), voice, confirm, or DETAILS (`FM1C_HELP_DETAIL`, 10 lines). Letting go of SCL closes it and redraws every region it covered, with whatever the host changed
meanwhile. While it is up the panel sends only SCL's own BUTTON edges; see `docs/firmware-controls.md`.

![Help](../reports/evidence/emu/emu-v2-help-base.png)

## NO COMPANION and version mismatch

When no valid host frame has arrived for 3500 ms (and at boot), every region is redrawn at a quarter of its
brightness: each RGB565 channel is shifted right by 2. This dims the last frame. Then a banner is drawn at full
brightness: 208 x 80 at (16, 80), background #101010, a 2 px white border, `NO COMPANION` in `FONT_L` centred at row
92, and `start fm1-console on Mac` in `FONT_S` (#C0C0C0) centred at row 132.

With `HELLO_ACK` version 0 (or one outside 1..4), the banner has a red border and shows `UPDATE APP` (reason contains
"old": the companion is too old), `OLD FIRMWARE` (reason contains "new") or `INCOMPATIBLE`, with the reason below it.

The selection and all other host state are kept. When the host comes back with the same `host_session`, the screen
returns exactly as it was. The host and emulator tests compare the screenshots byte for byte. A HELLO_ACK with a
new `host_session` clears the content first, and the companion's resync fills it again.

![NO COMPANION](../reports/evidence/emu/emu-nohost-dimmed.png)

## Redraw rules

- The model compares every `SET_*` against what it holds. A repeat marks nothing, so a resync or a retransmission
  causes no redraw. Heartbeats and ACKs never touch the screen.
- Each change marks only its regions:
  - one slot (state, flags including pinned, label): its key's box (8 x 64 in version 1; 14 x 34 or 12 x 30 in version 2);
  - the selection moving: the two cells and the label band;
  - `SET_DETAIL`: the head band and the lines that changed;
  - `SET_VOICE` (voice view only): the level bar, elapsed time or target band; in version 2 a voice state change
    also redraws lines 1–2 (bar or transcript);
  - `SET_DETAIL` in the voice view: nothing in version 1; lines 1, 2 and 4 in version 2;
  - the agreed version changing: everything;
  - the help overlay: drawn once when it opens; under it only the status bar and the legend are drawn; closing it
    redraws everything;
  - `SET_STATUS` and `SET_VIEW`'s title or page: the status bar;
  - a view change: the status bar and the panel; into or out of DETAILS (view 5): everything;
  - `SET_TEXT`: in DETAILS each changed row alone (240 x 16 = 3,840 px); a repeat nothing; outside DETAILS nothing
    (stored only);
  - a toast in DETAILS: the hint band (240 x 24);
  - `SET_LEGEND`: the legend.
- The whole screen is redrawn only when the host appears or is lost (dimming).
- Measured in host mode with a pixel counter: 0 px over 3 seconds of heartbeats only; for one `SET_SLOT`, 512 px in
  version 1, 476 px (white key) or 360 px (black key) in version 2; for one changed DETAILS row, 3,840 px; for a
  repeated `SET_TEXT`, 0 px.
- Drawing never blocks input. While a strip goes out by DMA, the platform's `LCD_IDLE` hook reads MIDI into an
  8-frame queue and sends queued CCs. The main loop parses the frames.
- Version 4 (`fm1c_model_apply4`): one slot marks its 14 x 14 box (196 px); the selection moving marks the two boxes,
  the label and the caption; `SET_DETAIL` state or provider marks the hero, the bubble frame and the caption, line 1
  the label, line 4 the hint bar; `SET_TEXT` marks only the changed rows (base views 0–6, DETAILS 0–11); a K1–K4 turn
  and its 2 s timeout mark the hint bar; `SET_LEGEND` marks nothing unless the knob row is up; a view change marks all
  but the keyboard (into or out of DETAILS: everything).
