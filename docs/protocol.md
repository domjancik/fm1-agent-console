# FM1C device protocol, versions 1–7 (version 5 with the GROUPED additions of docs/ui-v3.md section 9; version 6 SPLIT keys and settings, docs/ui-v3.md section 10; version 7 Markdown highlights in SET_TEXT, docs/ui-v3.md section 13)

The contract between the console firmware (`firmware/src/console.c`) and the companion (`packages/device-protocol`). Both sides implement this document; the TypeScript codec is the reference and the C codec must pass the shared vectors in `fixtures/device/vectors.json`.

## 1. Transport

- USB-MIDI, channel 16 (status nibble `0xF`, so control change is `0xBF`).
- No SysEx in either direction. The updater owns SysEx.
- Frames travel as control changes. The direction is fixed by controller number:

| CC | Direction | Meaning of the 7-bit value |
| --- | --- | --- |
| 118 | host → device | control: `1` START, `2` END, `3` ABORT |
| 119 | host → device | one payload byte |
| 116 | device → host | control: `1` START, `2` END, `3` ABORT |
| 117 | device → host | one payload byte |

Any other MIDI message is ignored by both sides. A START while a frame is open discards the open frame. A data byte outside a frame is dropped.

## 2. Frame

All payload bytes are 7-bit (0–127).

```
TYPE  SEQ  LEN  BODY[LEN]  CK
```

- `TYPE`: message type (section 4).
- `SEQ`: 0–127, per direction, incremented for each new frame, wrapping to 0. Retransmissions reuse the original `SEQ`.
- `LEN`: body length, 0–100. A frame with `LEN` > 100 is rejected.
- `CK`: `(TYPE + SEQ + LEN + sum(BODY)) & 0x7F` XOR `0x2A`.

A frame is valid when its byte count equals `LEN + 4` and the checksum matches. Invalid frames are dropped and counted; the receiver sends no ACK for them.

### Field encodings

- `u7`: one byte.
- `u14`: two bytes, high 7 bits first.
- `s7`: one byte, value + 64 (range −64…63).
- `str`: `u7` length, then that many ASCII bytes 0x20–0x7E. Senders replace other characters with `?` and truncate to the stated maximum.
- `enum`: `u7`.

## 3. Reliability

- Every frame except `ACK` and `HEARTBEAT` must be acknowledged with an `ACK` carrying its `SEQ`.
- A sender retransmits an unacknowledged frame after 250 ms, at most 3 times, then reports a link fault (device: shows LINK ERR; host: marks the device degraded and resyncs).
- Receivers keep the last 32 received `SEQ` values per direction. A repeated `SEQ` with the same checksum is acknowledged again and not processed again. This is the duplicate-execution guard.
- Host state frames (`SET_*`) are idempotent full replacements of the named element, so a resync replays them safely.
- Device input frames are facts ("key 4 single press"). The host decides what they mean in the current context; the device never assumes a command succeeded until `COMMAND_RESULT` arrives.

### Liveness

- Both sides send `HEARTBEAT` every 1000 ms.
- The device treats the host as lost after 3500 ms without any valid host frame: it shows NO HOST, turns key LEDs to glow, keeps the local selection, and keeps sending `HELLO` every 1000 ms.
- The host treats the device as lost after 3500 ms without a valid device frame.
- After `HELLO_ACK` the host sends a full resync: `SET_VIEW`, every visible `SET_SLOT`, `SET_DETAIL`, `SET_LEGEND`, `SET_VOICE`, `SET_STATUS`, and with version 3 in view 5 (`detail`) the four `SET_TEXT` frames (rows 0–2, 3–5, 6–8, 9–11); with version 4 the four `SET_TEXT` frames in every view. With version 5 `SET_VIEW` and every `SET_SLOT` use the version 5 forms; with version 6 `SET_VIEW` carries the keys byte (and, in SPLIT, the task page) and the black-key slots their SPLIT content.

### Version negotiation

`HELLO` carries the device's protocol version range. The host replies `HELLO_ACK` with the chosen version (the highest common one), or `HELLO_ACK` with version 0 and a reason string when it supports none, in which case the device shows a version banner (v2 wording: UPDATE APP / OLD FIRMWARE / INCOMPATIBLE).

Versions 1 and 2 share the same wire format: framing, message types, bodies, limits, ACKs and the frame vectors are identical. Version 2 is a rendering marker only (docs/ux-v2.md section 4). It means: `SET_LEGEND` labels are KNOB1–KNOB4 only; `SET_DETAIL.line4` in the base and voice views is a hint line; in the voice view `SET_DETAIL.line1–2` are drawn outside recording/transcribing; slot flag bit 3 (pinned) is drawn; the device has a local help overlay on SCL hold. The host (companion) accepts 1–2 and sends the v2 content either way; a version 1 firmware draws it as plain text. `fixtures/device/vectors.json` carries the negotiation cases (`negotiation`: device 1–2 / host 1–2 → 2; device 1–1 / host 1–2 → 1; device 1–2 / host 1–1 → 1); its `protocol` field stays 1 because it names the wire format family.

Version 3 (docs/ux-v2.md section 7, session details) is **additive** on the wire: it adds the host message `SET_TEXT` (0x4C) and the view value 5 `detail` in `SET_VIEW`. Everything of versions 1–2 is unchanged, and version 3 includes every version 2 rendering rule (firmware checks become `proto >= 2`). The host sends `SET_TEXT` and view 5 **only when version 3 was agreed**; with 1 or 2 it never does (LFO stays unused), so an older firmware never sees them. A version 3 decoder accepts 0x4C and view 5 in every negotiated version (decoding does not depend on the version). Constants: device `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 3`; host `PROTOCOL_VERSION 3`, `HOST_VERSIONS = { min: 1, max: 3 }`. New negotiation vectors: `v3_device_v3_host` device 1–3 / host 1–3 → 3; `v2_device_v3_host` device 1–2 / host 1–3 → 2; `v3_device_v2_host` device 1–3 / host 1–2 → 2; `v1_device_v3_host` device 1–1 / host 1–3 → 1 (the three version 2 cases stay).

Version 4 (docs/ui-v3.md section 5, characters and the speech bubble) is a **rendering marker** over version 3, as version 2 is over version 1: the same message types, bodies, limits and frame vectors. Only the meaning of existing fields changes, and only when version 4 was agreed; with 3 or lower the host sends exactly the version 3 content and the device draws the v3 (or v2, v1) layout. Constants: device `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 4`; host `PROTOCOL_VERSION 4`, `HOST_VERSIONS = { min: 1, max: 4 }`. New negotiation vectors: `v4_device_v4_host` 1–4 / 1–4 → 4; `v3_device_v4_host` 1–3 / 1–4 → 3; `v4_device_v3_host` 1–4 / 1–3 → 3; `v1_device_v4_host` 1–1 / 1–4 → 1. Meaning of version 4:

- **Base views (0 sessions, 1 tasks, 2 inbox):** `SET_TEXT` rows 0–6 are the speech bubble. Row 0 is the caption (`<State words>, <age>`, ≤ 20; the device draws it in the selected slot's state colour whatever the style). Rows 1–5 are the body (≤ 28 characters; style 0 white, 2 muted). Row 6 is the first line after the visible body, or `""`; non-empty draws the "more" wedge. Rows 7–11 are `""`. The slot label is cut at 11 characters (drawn in `FONT_L` beside the character when it fits 176 px). `SET_DETAIL.line1` is the rest of the title, `line2` and `line3` are `""`, `line4` is the hint line.
- **Voice (3):** in reviewing, submitting, failed and target_unavailable, `SET_TEXT` rows 1–5 carry the transcript or the error, wrapped at 28 (row 0 `""`); otherwise all rows are `""`. `SET_DETAIL.line1–3` are `""`. The device draws the recording bubble from `SET_VOICE`.
- **Confirm (4):** fields unchanged. `SET_DETAIL.state`/`provider` name the target chat's character when there is one.
- **Detail (5):** rows 0–2 are the header beside the 48 px character (≤ 22; row 0 the state heading), rows 3–11 the body (9 rows, ≤ 29), newest first: `Last message <age>` and the message, then the approval, error or current activity, then facts and the task.
- **Characters** are firmware-local, drawn from `SET_DETAIL.state` + `provider` (the hero) and `SET_SLOT.state` + flag bit 1 (the minis). No field is added.
- **Knob row** is device-local: for 2000 ms after the device sends an `ENCODER` frame for K1–K4 it shows the four `SET_LEGEND` labels in the hint bar. The host is not involved.
- **Order rule:** the rows mean different things in the base views and in view 5, so on every switch between a base view (or voice, confirm) and view 5 the host sends all four `SET_TEXT` groups **before** `SET_VIEW`, even groups whose text looks unchanged. Within the same kind of view only changed groups are sent, still before `SET_VIEW`.

Version 5 (docs/ui-v3.md section 8, the LIST layout) is **additive** over version 4: it adds one optional trailing field to `SET_VIEW` and two to `SET_SLOT` (section 4), and includes every version 4 rule. The host sends the version 5 forms **only when version 5 was agreed**; with 4 or lower it sends exactly the version 4 bodies and content (SEQ stays unused), so firmware on versions 1–4 never sees them. A version 5 decoder accepts both body forms in every negotiated version. Constants: device `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 5`; host `PROTOCOL_VERSION 5`, `LIST_VERSION 5`, `HOST_VERSIONS = { min: 1, max: 5 }`. New negotiation vectors: `v5_device_v5_host` 1–5 / 1–5 → 5; `v4_device_v5_host` 1–4 / 1–5 → 4; `v5_device_v4_host` 1–5 / 1–4 → 4; `v1_device_v5_host` 1–1 / 1–5 → 1. Meaning of version 5:

- **Layout:** `SET_VIEW.layout` 0 buddy (the version 4 screen), 1 list. The host always sends it: the base view's layout in views 0 (sessions) and 2 (TO DO), 0 in every other view. The device draws the list (docs/ui-v3.md §8.2–8.3) only in views 0 and 2 with layout 1; voice, confirm and DETAILS are drawn as version 4. SEQ (button 11) is the toggle; the host decides and remembers the layout per view (defaults: sessions buddy, TO DO list). The device lights the SEQ LED while the list is shown.
- **Rows:** every `SET_SLOT` carries `title` (≤ 20, the row title) and `age` (≤ 3, e.g. `now`, `12m`, `3h`, `""` for a stale chat), in every view and layout. In the buddy layout a change of only `title` or `age` redraws nothing.
- **List header:** in views 0 and 2 with layout 1, `SET_TEXT` row 0 is the caption (as version 4), row 1 the message line wrapped at 24, row 2 the next line or `""` (non-empty draws the "more" wedge), rows 3–11 `""`.
- **Order rule:** every layout change, like every switch between a base view and view 5, sends all four `SET_TEXT` groups **before** `SET_VIEW`.

Version 5, GROUPED additions (docs/ui-v3.md section 9; still version 5 because version 5 was never flashed to the operator's unit; additive, so every earlier version 5 body keeps its meaning):

- **Layout 2 grouped** in `SET_VIEW`: Sessions grouped by task (view 0 only; the device draws layout 2 in view 2 as the list). A layout value above 2 is a bad body.
- **`SET_SLOT` row byte and group header**, after title and age, only while Sessions is shown Grouped: `u7 row` (bits 0–1 indent 0–2, bit 2 `start` = a header row is drawn before this key's row, bit 3 `task` = a folded task row that draws only its header, bits 4–6 zero), then, with `start`, `enum head_state`, `u7 head_flags` (bit 0 pinned), `str head_title` (≤ 20), `str head_count` (≤ 11). Headers of expanded groups take no key; a folded task (no T0–T4 session) takes one key, its header row. Largest `SET_SLOT` body 77.
- **LED language v2** (section 6): the selected key breathes in the backlight layer; new timelines for keys and buttons. Device-local; no field is added.
- **Transitions and hardware scroll** (docs/ui-v3.md section 9.10): device-local; no field is added.

Version 6 (docs/ui-v3.md section 10, SPLIT keys and the SETTINGS view) is **additive** over version 5 and includes every
version 5 rule. The host sends the version 6 forms **only when version 6 was agreed**; with 5 or lower it sends exactly the
version 5 bodies and content (Keys behaves as Ranked, ARP does nothing), so firmware on versions 1–5 never sees them. A
version 6 decoder accepts every earlier body form in every negotiated version. Constants: device `FM1C_PROTO_MIN 1`,
`FM1C_PROTO_MAX 6`; host `PROTOCOL_VERSION 6`, `SPLIT_VERSION 6`, `HOST_VERSIONS = { min: 1, max: 6 }`. New negotiation
vectors: `v6_device_v6_host` 1–6 / 1–6 → 6; `v5_device_v6_host` 1–5 / 1–6 → 5; `v6_device_v5_host` 1–6 / 1–5 → 5;
`v1_device_v6_host` 1–1 / 1–6 → 1. Meaning of version 6:

- **View 6 `settings`** in `SET_VIEW`: the SETTINGS list (docs/ui-v3.md §10.2). `page` = the cursor row, `pages` = the item
  count; `SET_TEXT` rows 0–8 the items (26 characters each, label left, value right), row 9 the cursor item's description,
  rows 10–11 `""`; `SET_DETAIL.line4` the hint. The device draws no page number in view 6. Entering and leaving view 6 sends
  all four `SET_TEXT` groups before `SET_VIEW`.
- **Keys byte** in `SET_VIEW` after the layout: 0 ranked, 1 split; with 1 then the task page and the task page count. The
  host always sends it with version 6: 1 exactly while the 27 slots hold the SPLIT assignment of Sessions (view 0 in SPLIT and
  views 3, 4, 5, 6 opened over it), else 0. A keys change is a layout change for the order rule (all four `SET_TEXT` groups
  before `SET_VIEW`) and re-sends all 27 `SET_SLOT`s in one coalescer flush. In SPLIT every switch between view 0 and views
  3/4 also sends all four groups first (the SPLIT Buddy bubble has 4 body rows: row 5 is the "more" line).
- **Black-key slots in SPLIT** (keys 1; k = 1, 3, 5 filters ALL / PINNED / NEEDS YOU, k = 8, 10, 13, 15, 17, 20, 22, 25 the
  task slots of the shown task page): the role comes from the key number. `label` = the tag (≤ 3 characters), `state` = the
  LED state of docs/ui-v3.md §10.8, flag bit 3 = a pinned task, **flag bit 4 = chosen**, bits 0–2 = 0, `title` = the task
  title or the filter name, `age` = the task's newest activity (`""` for filters), `row` = indent 0 without a header while
  Grouped. White keys carry sessions as before; the host never sets bit 0 on a black key in SPLIT.
- **Rendering** (docs/ui-v3.md §10.7): with keys 1 the device draws the black row in its physical positions (Buddy: y
  168–199 above the white minis, the bubble with 4 body rows; List/Grouped: a band at y 60–91 and 8 list rows of white keys;
  voice/confirm: compact black boxes in the version 4 strip). With keys 0 it draws exactly the version 5 screens.
- **LEDs** (section 6): the CHOSEN timeline for flag bit 4; ARP lit in view 6.

Version 7 (docs/ui-v3.md section 13, Markdown highlights) is **additive** over version 6 and includes every version 6
rule. Its only wire change: a `SET_TEXT` row's text may carry the control bytes `0x01` bold on, `0x02` code on, `0x03`
off (none takes a column) and `0x04` a column rule (one column). The host sends them **only when version 7 was agreed**;
with 6 or lower it strips them (a rule becomes a space, so the columns are the same) and every body is exactly the
version 6 body. A version 7 decoder accepts them in every negotiated version. Constants: device `FM1C_PROTO_MIN 1`,
`FM1C_PROTO_MAX 7`, `FM1C_L_TEXT_WIRE 37`; host `PROTOCOL_VERSION 7`, `RICH_TEXT_VERSION 7`, `HOST_VERSIONS = { min: 1,
max: 7 }`, `TEXT_MARK`, `TEXT_ROW_WIRE_MAX 37`, `TEXT_SPANS_MAX 4` (`packages/device-protocol/src/rich-text.ts`). New
negotiation vectors: `v7_device_v7_host` 1–7 / 1–7 → 7; `v6_device_v7_host` 1–6 / 1–7 → 6; `v7_device_v6_host` 1–7 /
1–6 → 6; `v1_device_v7_host` 1–1 / 1–7 → 1. Meaning of version 7:

- **Row text:** at most 29 visible characters (printable ASCII and `0x04`), at most 8 style bytes (`0x01`–`0x03`), at
  most 37 bytes. A mark switches the drawing colour until the next mark or the row end (no nesting; every row starts in
  its row colour). Colours and geometry: docs/ui-v3.md §13.5 (bold amber, white in a heading row; code RGB(128, 208,
  255); rule 1 px grey at cell x + 3, 16 px high).
- **Frames:** three 37-byte rows exceed `MAX_BODY`, so a group whose body would pass 100 bytes goes as consecutive
  `SET_TEXT` frames of fewer rows (`count` 1–2), in row order, still inside the order rules (all before `SET_VIEW`).

## 4. Messages

### Device → host

| Type | Name | Body |
| --- | --- | --- |
| 0x01 | HELLO | `u7 proto_min`, `u7 proto_max`, `u7 fw_major`, `u7 fw_minor`, `u7 fw_patch`, `u14 boot_id` (random per boot) |
| 0x02 | BUTTON | `enum button`, `enum edge` (0 up, 1 down) |
| 0x03 | KEY | `u7 key` (0–26), `enum gesture` (1 single, 2 double, 3 long, 4 down, 5 up) |
| 0x04 | ENCODER | `enum encoder`, `s7 delta` |
| 0x05 | POT | `enum pot` (0 MASTER), `u14 value` (0–1023) |
| 0x06 | HEARTBEAT | `u14 uptime_s`, `u7 rx_errors` (saturating) |
| 0x07 | ACK | `u7 acked_seq`, `enum status` (0 ok, 1 unknown type, 2 bad body, 3 busy) |

Button ids follow the HAL: OCT− 0, OCT+ 1, FX 2, SEL 3, ENV 4, LFO 5, EDIT 6, GLO 7, HOME 8, SAVE 9, ARP 10, SEQ 11, PLAY 12, REC 13. Encoder ids: SELECT 0, ALGORITHM 1, K1–K4 2–5, PRESETS 6.

Gesture timing (device side): long press = held ≥ 600 ms; double = second down within 300 ms of the first up. `single` is sent after the double window closes, so a double press produces `down, up, down, up, double` and no `single`. `down`/`up` are always sent, so REC push-to-talk uses `BUTTON` edges and keys can be used raw.

### Host → device

| Type | Name | Body |
| --- | --- | --- |
| 0x41 | HELLO_ACK | `u7 proto`, `u14 host_session`, `str reason` (≤ 24) |
| 0x42 | SET_VIEW | `enum view` (0 sessions, 1 tasks, 2 inbox, 3 voice, 4 confirm, 5 detail — version 3 and later, 6 settings — version 6), `u7 page`, `u7 pages`, `str title` (≤ 20). Version 5: then optionally `enum layout` (0 buddy, 1 list, 2 grouped); absent = buddy; a value > 2 is a bad body. Version 6: then optionally `enum keys` (0 ranked, 1 split); absent = ranked; with keys 1 then `u7 task_page`, `u7 task_pages` (1–127, task_page < task_pages). Bad body: a view > 6, keys > 1, keys 1 without both task bytes, task_pages 0, task_page ≥ task_pages, any byte after keys 0 or after task_pages. Largest body 28 |
| 0x43 | SET_SLOT | `u7 key`, `enum state`, `u7 flags` (≤ 15; version 6: ≤ 31, bit 4 chosen, never with bit 0), `str label` (≤ 12). Version 5: then optionally `str title` (≤ 20) and `str age` (≤ 3), both or neither; then optionally `u7 row` and, when row bit 2 is set, `enum head_state`, `u7 head_flags`, `str head_title` (≤ 20), `str head_count` (≤ 11) (docs/ui-v3.md section 9.5). A title without an age, a row value with indent 3 or bits 4–6 set, bit 3 without bit 2, a missing or extra head field, head_flags > 1, a longer string or bytes left over are a bad body. Largest body 77 |
| 0x44 | SET_DETAIL | `enum provider` (0 none, 1 claude, 2 codex, 3 other), `enum state`, `str line1` (≤ 20), `str line2` (≤ 20), `str line3` (≤ 20), `str line4` (≤ 20). Version 2: `line4` is the hint line (`<BUTTON> <verb>` pairs); in the voice view `line1–2` carry the transcript or error and are drawn outside recording/transcribing, `line3` is empty |
| 0x45 | SET_VOICE | `enum voice` (section 5), `u7 level` (0–100 mic level), `u14 elapsed_ds` (tenths of a second), `str target` (≤ 20) |
| 0x46 | SET_LEGEND | four `str` (≤ 6 each): labels for K1–K4 or contextual buttons, shown on the bottom row. Version 2: labels for KNOB1–KNOB4 only (`""` = that knob does nothing here); the device tags each non-empty cell with its knob name |
| 0x47 | SET_STATUS | `enum link` (0 ok, 1 backend degraded, 2 backend down), `u7 attention_count`, `str text` (≤ 20) |
| 0x48 | COMMAND_RESULT | `u7 req_seq` (the device frame that caused it, or 127 for none), `enum result` (0 accepted locally, 1 sent, 2 acknowledged by backend, 3 completed, 4 failed, 5 unsupported, 6 target unavailable), `str text` (≤ 20) |
| 0x49 | HEARTBEAT | `u14 host_uptime_s` |
| 0x4A | ACK | same body as device ACK |
| 0x4B | CLEAR_SLOTS | no body: all 27 slots become empty |
| 0x4C | SET_TEXT | version 3 and later. `u7 row` (0–11), `u7 count` (1–3, and `row + count` ≤ 12), then `count` times: `enum style` (0 body, 1 heading, 2 muted), `str text` (≤ 29). Replaces rows `row … row+count−1` of the 12-row DETAILS text buffer (docs/ux-v2.md §7.4). Largest body: 2 + 3 × (1 + 1 + 29) = 95 bytes. Version 7: `text` ≤ 37 bytes, each printable ASCII or `0x01`–`0x04`, ≤ 29 of them visible (printable or `0x04`); a body still ≤ 100 (the host splits a group) |

#### SET_TEXT rules

- Idempotent full replacement of the named rows; a resync replays them safely. The host sends rows in groups 0–2, 3–5, 6–8, 9–11 and skips a group whose content did not change. Empty rows are sent as style 0 with `""`.
- Body errors (`bad_body`, ACK status 2): `row` > 11, `count` 0 or > 3, `row + count` > 12, `style` > 2, a string longer than 29 or with a byte outside 0x20–0x7E, a string running past the body, or bytes left over. Version 7 decoder: a string longer than 37 bytes, more than 29 visible characters (printable or `0x04`), or a byte outside `0x01`–`0x04` and `0x20`–`0x7E`.
- Version 7: a group whose body would exceed 100 bytes is sent as consecutive frames of 1–2 rows in row order (rows 0–1 then 2, etc.).
- The device stores the rows in every view and draws them only in view 5 (version 4: also rows 0–6 as the bubble of the base views and rows 1–5 in voice, section 3). A HELLO_ACK with a new `host_session` clears them. Because the rows survive leaving view 5, an incremental update that opens the page (or switches it to another chat) sends the changed `SET_TEXT` groups **before** `SET_VIEW` 5, so the device never draws the previous chat's rows under the new page.
- Vector JSON shape (`fixtures/device/vectors.json`, read by `firmware/tests/console/gen_vectors.py`): `{"kind": "SET_TEXT", "row": 3, "lines": [{"style": "heading", "text": "Last message 2m"}, {"style": "body", "text": "..."}]}`; style names `body`, `heading`, `muted`; view name `detail`. Valid vectors: `set_view_detail`, `set_text_one_row`, `set_text_three_rows_max` (row 9, three rows of 29 characters, all styles), `set_text_empty_rows`, `set_text_sanitised` (decoded differs). The invalid vectors `type_0x4c` and `set_view_view_5` became `type_0x4d` (unknown_type) and `set_view_view_6` (bad_body); new invalid: `set_text_row_12`, `set_text_count_0`, `set_text_count_4`, `set_text_past_end` (row 10, count 3), `set_text_style_3`, `set_text_str_30` (all bad_body).

#### Version 5 GROUPED vectors

Valid `set_view_grouped`, `set_slot_group_header`, `set_slot_group_member`, `set_slot_group_child`, `set_slot_group_folded`, `set_slot_group_max` (77-byte body), `set_slot_group_truncated` (decoded differs); invalid (all `bad_body`) `set_view_layout_3` (replaces `set_view_layout_2`, now valid), `set_slot_row_indent_3`, `set_slot_row_bit4`, `set_slot_row_task_no_start`, `set_slot_head_missing`, `set_slot_head_flags_2`, `set_slot_head_title_21`, `set_slot_head_count_12`, `set_slot_group_extra_byte`, `set_slot_row_no_start_extra`. `set_slot_list_extra_byte` now carries two trailing bytes (the first is a valid row byte). JSON: `"layout": "grouped"`; `"row": {"indent", "start", "task"}`; `"head": {"state", "pinned", "title", "count"}`.

#### Version 5 vectors

`fixtures/device/vectors.json`: valid `set_view_list`, `set_view_todo_buddy`, `set_slot_list_row`, `set_slot_list_max`, `set_slot_list_empty_strings`, `set_slot_list_truncated` (decoded differs); invalid (all `bad_body`) `set_view_layout_2`, `set_view_layout_extra_byte`, `set_slot_title_21`, `set_slot_age_4`, `set_slot_title_no_age`, `set_slot_list_extra_byte`. JSON: `"layout": "buddy" | "list"` on `SET_VIEW`, `"title"` and `"age"` on `SET_SLOT`, each present only in the version 5 form. Every earlier vector is unchanged.

#### Version 6 vectors

`fixtures/device/vectors.json`: valid `set_view_split` (buddy, NEEDS YOU, task page 0 of 3), `set_view_split_grouped` (task
page 2 of 3), `set_view_split_max` (28-byte body, task page 126 of 127), `set_view_keys_ranked`, `set_view_settings` (view 6
with the version 6 tail), `set_view_settings_v5_body` (view 6, no layout), `set_slot_task_chosen` (key 8, pinned + chosen,
tag `FV5`), `set_slot_filter_needs` (key 5, `YOU`), `set_slot_chosen_v4_body` (bit 4 on a version 1–4 body),
`set_slot_chosen_flags_max_row` (flags 30, the largest valid value, with a Grouped row byte). Invalid (all `bad_body`):
`set_view_view_7` (**replaces** `set_view_view_6`, now valid), `set_slot_flags_32` (**replaces** `set_slot_flags_16`, now
valid), `set_view_keys_2`, `set_view_split_no_task_page`, `set_view_split_no_task_pages`, `set_view_task_pages_0`,
`set_view_task_page_past_end`, `set_view_ranked_extra_byte`, `set_view_split_extra_byte`, `set_slot_selected_and_chosen`
(flags 17). `set_view_layout_extra_byte` now carries two trailing bytes (the first is a valid keys byte). JSON: `"view":
"settings"`; on `SET_VIEW` `"keys": "ranked" | "split"` and, with split, `"taskPage"`, `"taskPages"`; on `SET_SLOT` flags
`"chosen": true` (present only when set). Every other vector is unchanged; 81 valid, 61 invalid, 19 negotiation cases.

#### Version 7 vectors

`fixtures/device/vectors.json`: valid `set_text_v7_bold_code`, `set_text_v7_table` (rules), `set_text_v7_row_max` (two
37-byte rows, 29 visible + 8 style bytes each; 80-byte body), `set_text_v7_open_span` (a span right at the start and one
running to the row end), `set_text_v7_sanitised` (decoded differs: `0x07` → `?`, style bytes past the 8th dropped);
invalid (all `bad_body`) `set_text_v7_byte_0x05`, `set_text_v7_byte_0x00`, `set_text_v7_len_38`,
`set_text_v7_visible_30`. JSON strings carry the marks as `\u0001`–`\u0004`. Every earlier vector is unchanged
(`set_text_str_30` stays invalid: 30 visible characters); 86 valid, 65 invalid, 23 negotiation cases.

#### Slot state enum (shared with `SET_DETAIL.state`)

`0` empty, `1` disconnected, `2` idle, `3` working, `4` waiting_input, `5` approval_required, `6` completed_unread, `7` completed_read, `8` failed, `9` unknown.

#### Slot flags

bit0 selected, bit1 provider codex (else claude), bit2 stale (identity fails to resolve), bit3 pinned, bit4 chosen (version 6:
the chosen filter or task key of the SPLIT black row; never together with bit0).

## 5. Voice states

`0` ready, `1` recording, `2` transcribing, `3` reviewing, `4` submitting, `5` delivered, `6` cancelled, `7` failed, `8` target_unavailable.

## 6. LED rules (device)

**Protocol 5: LED language v2** (docs/ui-v3.md section 9.9; the timelines are also data in `fixtures/device/led-v2.json`). Levels: L lit (full), G glow (`FM1_GLOW_NS`), O off, B backlight (`fm1_led_bg_ns`, breathing). Phase = `fm1_ms` mod period.

| Key condition (first match) | Period | Timeline |
| --- | --- | --- |
| empty, disconnected | - | O |
| stale (flag bit 2) | 4000 | G 0–149, O 150–3999 |
| approval_required | 500 | L 0–249, O 250–499 |
| waiting_input | 1260 | L 0–119, G 120–239, L 240–359, G 360–1259 |
| failed | 3000 | G 0–1499, O 1500–2999 (slow, never lit, calm when many keys fail) |
| completed_unread | 2500 | L 0–149, G 150–2499 |
| working | - | L |
| idle, completed_read | - | G |
| unknown | 3000 | O 0–149, G 150–2999 |
| **chosen** (flag bit 4, protocol 6; checked first, before every row above, whatever the state) | - | B: in the backlight layer with the selected session, breathing in step with it (revised 2026-11-19; was a lit/glow blink) |
| **selected** (flag bit 0) | 3000 | B, the only LED in the backlight layer, breathing (`FM1C_BREATH_NS`, a 76-entry raised cosine in perceived brightness, gamma 2.2, 12,000–48,000 ns so it never goes dark, one step per 20 ms, mirrored); the L windows of approval_required and waiting_input break through; failed dips it to O at the bottom of each breath, 2850–149 of 3000 |
| no host | - | every key G, the kept selection B |

Buttons (protocol 5, never breathing): REC L recording, L 0–249/O 250–499 transcribing; SAVE double blink (L 0–119, O 120–239, L 240–359, O 360–1259) while voice is reviewing, in confirm, or in views 0/2/5 with `SET_DETAIL.state` approval_required; LFO L in view 5; SEQ G in view 0 with layout 1 or 2 and in view 2 with layout 1; HOME/EDIT L for views 0/1; GLO L in view 2, else a single tick L 0–149/O 150–2499 while `attention_count` > 0; no host: OCT+ L 0–499/O 500–999. Protocol 6: ARP L in view 6 (settings). Active controls (protocol 5+): a button the companion acts on in the shown view (by view, voice state and `SET_DETAIL.state`) glows G steady when the rule above leaves it O; the table is docs/ui-v3.md §9.9.

**Protocol 6 SPLIT black keys** (docs/ui-v3.md §10.8): the host sends each black key's state so that the table above gives
its LED: ALL `idle` (G); PINNED `idle` with pins, else `empty` (O); NEEDS YOU the most urgent T0–T3 state, else `empty`; a
task its most urgent session state (`idle` with none); an empty task slot `empty`. The chosen one carries bit 4 (CHOSEN). The
backlight layer holds the selected session (a white key) and the chosen black key, which breathe in step. No host: every key G, chosen included. Data:
`fixtures/device/led-v2.json` `chosen`.

**Protocol 1–4** (unchanged): key LEDs are single-colour with three levels: off, glow, full. Patterns are timed in the app.

| Priority | Condition | Pattern |
| --- | --- | --- |
| 1 | selected | full, steady (overrides below, except approval blink keeps a 100 ms dip every 1 s so attention stays visible) |
| 2 | approval_required | full/off, 500 ms each (slow blink) |
| 3 | failed | full/off, 150 ms each (fast blink) |
| 4 | waiting_input | full/glow, 500 ms each |
| 5 | completed_unread | full 120 ms every 2 s, glow otherwise |
| 6 | working | full steady |
| 7 | idle, completed_read | glow |
| 8 | empty, disconnected | off |
| 9 | unknown | glow with a 120 ms off every 2 s |

Button LEDs: REC full while recording, blinking while transcribing; SAVE full while reviewing (send available); HOME/EDIT/GLO full for the active view; GLO blinks when `attention_count` > 0. With no host, all button LEDs are off except a slow OCT+ blink as the "disconnected" indicator.

## 7. Limits

- Max frame on the wire: 104 payload bytes plus 2 control CCs, 106 CC messages. At USB full speed one frame takes about 2 ms.
- Host rate limit: at most 200 frames per second; slot updates are coalesced per 50 ms. ACKs go ahead of queued frames (still inside the rate), so a burst of state frames (a re-sort sends up to 27 slots) never holds an ACK past the device's 250 ms retransmit.
- Device input buffer: 128 bytes per open frame (frames above 104 bytes are invalid by `LEN`).
