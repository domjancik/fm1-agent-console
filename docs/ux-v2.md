# FM1 CONSOLE UX v2: plain copy, labelled controls, focus on what needs you

Date: 2026-11-18. Status: design. Nothing is implemented yet. Owner of this file: the UX v2 design step.

Operator feedback (2026-11-18): "many abbreviations on fw screen are cryptic; note that real traycer presents 279
sessions, devise how to prioritize and focus actionable; lower screen 4 actions not clear what to use to trigger them".

This document has three parts and an implementation split:

1. [Copy audit](#1-copy-audit): every string the device can show, and its replacement.
2. [Legend and controls](#2-legend-and-controls): which physical control each screen label belongs to.
3. [279 sessions](#3-279-sessions-actionable-first): ordering, scopes, stable keys, measured view sizes.
4. [Protocol](#4-protocol): the wire format stays FM1C v1. The negotiated version goes to 2 only as a rendering marker.
5. [Implementation split](#5-implementation-split): files, functions, tests and acceptance criteria per implementer.
7. [Session details](#7-session-details): richer chat data, PRESETS text, the DETAILS page (protocol version 3).

Evidence (all under `reports/evidence/ux-v2/`):

| File | What it is |
| --- | --- |
| `before/*.png` (24 screens) | Today's screens. agent-core `buildView` on `fixtures/sessions/mixed.json` and a 279-session synthetic set, serialised by `apps/companion/src/device/render.ts`, drawn by the firmware host build (`console.c` with `-DDINGHY_HOST`). |
| `before/frames.json` | The host frames behind each screen. It is the source for the host-string audit. |
| `session-stats.json` | Real Traycer distribution, read only, anonymised. It holds no titles, ids, paths or tokens. |
| `scripts/session-stats.ts`, `scripts/title-stats.ts` | The read-only probes. They call only connect, `list*` and the passive feeds. Every state-changing method is replaced with a throw. |
| `scripts/render-before.ts` | Re-renders `before/`. Run it as `bun render-before.ts <console-host> <workdir> <outdir>`. |

---

## 1. Copy audit

### 1.1 Pixel budget

From `fm1c_draw.h` and `docs/firmware-ui.md`:

| Region | Font | Width budget | Characters that fit | Protocol limit |
| --- | --- | --- | --- | --- |
| Status bar title (0–23) | `FONT_S` 8×16 | 240 px less the right group: page `1/2` (24 px + 8), link (6–80 px), badge (24–32 px) | 18–20 when healthy | title ≤ 20, status ≤ 20 |
| Head band chips (24–39) | `FONT_S` | Provider chip on the left (≤ 56 px), state chip on the right. Each chip is text + 8 px. | State chip ≤ 20 chars with a provider chip | — (firmware-local) |
| Label band (40–71) | `FONT_L` 16×32 | 232 px | 14 (FONT_L), else falls back to FONT_S (29) | slot label ≤ 12 |
| Lines 1–4 (72–135) | `FONT_S` | 232 px | 29 | line ≤ 20 |
| Legend cell (200–239) | `FONT_S` | 60 px per cell, 40 px tall, so 2 text rows of 16 px | 7 (56 px) per row | legend ≤ 6 |
| Banner (16,80 208×80) | `FONT_L` + `FONT_S` | 204 px inside a 2 px border | 12 (FONT_L), 25 (FONT_S) | — |
| Toast (line 4 band) | `FONT_S` | 232 px | 29 | result text ≤ 20 |

All host text is ASCII 0x20–0x7E. `FONT_L` draws lower case as capitals. `FONT_S` has true lower case, so v2 uses
sentence case for every small text and keeps capitals for chips, titles and button names.

### 1.2 Firmware-local strings (`console.c`, `fm1c_draw.h`)

"v2" is the new text. Firmware wording changes in every protocol version. The layout changes in §2 apply only with
proto 2 (§4).

| Where | Today | Problem | v2 | Fits? |
| --- | --- | --- | --- | --- |
| State chip, `approval_required` | `APPROVAL` | Is it approved, or does it need approval? | `NEEDS APPROVAL` | 120 px chip, ends at 236, starts at 116; the provider chip ends at 60 ✓ |
| State chip, `waiting_input` | `INPUT` | Cryptic: input from whom? | `NEEDS ANSWER` | 104 px ✓ |
| State chip, `completed_unread` | `DONE` | Looks the same as read | `DONE, UNREAD` | 104 px ✓ |
| State chip, `completed_read` | `READ` | Reads as the verb "read" | `DONE` | ✓ |
| State chip, `unknown` | `UNKNOWN` | Says nothing | `NO STATUS` | ✓ |
| State chip, `disconnected` / `idle` / `working` / `failed` | `OFFLINE` `IDLE` `WORKING` `FAILED` | fine | unchanged | ✓ |
| Provider chip, none | `-` | A lone dash in a grey box | no chip at all | ✓ |
| Link indicator, ok | `OK` (green) | Constant noise | a 6×6 green square at the indicator position, no text | ✓ |
| Link, backend_degraded | `DEG` | Cryptic | `LIMITED` (amber) | 56 px ✓ |
| Link, backend_down | `DOWN` | What is down? | `OFFLINE` (red) | 56 px ✓ |
| Link, unacked frames | `LINK ERR` | — | `NO REPLY` (red) | 64 px ✓ |
| Link, no HELLO_ACK yet | `WAIT` | — | `CONNECTING` (grey). No page or badge is shown in this state. | 80 px ✓ |
| Link, version refused | `VER` | Cryptic | `VERSION` (red) | ✓ |
| Link, no host | `NO HOST` | "host" is jargon | `NO LINK` (red) | ✓ |
| Banner big, no host | `NO HOST` | — | `NO COMPANION` | 12×16 = 192 ≤ 204 ✓ |
| Banner small, no host | `waiting for companion` | Says nothing about what to do | `start fm1-console on Mac` | 24×8 = 192 ✓ |
| Banner big, version | `HOST TOO OLD` / `HOST TOO NEW` / `HOST MISMATCH` | — | `UPDATE APP` / `OLD FIRMWARE` / `INCOMPATIBLE` | ≤ 192 ✓ |
| Banner small, version | the reason, or `no common version` | fine | unchanged | ✓ |
| Label band, nothing selected | `no selection` | — | `nothing selected` | ✓ |
| Label band, empty label | `(no label)` | — | `(untitled)` | ✓ |
| Voice label `reviewing` | `REVIEW` | Review what? | `READY TO SEND` | 13×16 = 208 ≤ 232 ✓ |
| Voice label `failed` | `FAILED` | What failed? | `SEND FAILED` | ✓ |
| Voice label `target_unavailable` | `NO TARGET` | — | `TARGET GONE` | ✓ |
| Voice labels `ready` `recording` `transcribing` `submitting` `delivered` `cancelled` | `READY` `RECORDING` `TRANSCRIBING` `SENDING` `DELIVERED` `CANCELLED` | fine | unchanged | ✓ |
| Voice target prefix | `-> ` | Arrow glyph from two characters | `to ` | ✓ |
| Voice no target | `(none)` | — | `(no target)` | ✓ |
| Voice elapsed | `12.3 s` | fine | unchanged | ✓ |
| Voice head chip | `VOICE` | fine | unchanged | ✓ |
| Confirm head chip | `CONFIRM` | fine | unchanged | ✓ |
| Confirm bottom chip | `SAVE=yes  FX=no` | `=` is code-speak | `SAVE yes   FX no` (hint style, §2.4) | ✓ |
| Toast fallback names (result with empty text) | `ACCEPTED` `SENT` `ACKNOWLEDGED` `DONE` `FAILED` `UNSUPPORTED` `UNAVAILABLE` | Protocol words | `OK` `Sent` `Received` `Done` `Failed` `Not supported` `Target gone` | ✓ |
| Title fallback | `FM1 CONSOLE` | fine | unchanged | ✓ |
| Legend tags (new, proto 2) | — | — | `KNOB1` `KNOB2` `KNOB3` `KNOB4` (§2.4) | 40 px ✓ |
| Help overlay (new, proto 2) | — | — | §2.5 | ✓ |

### 1.3 Host-sent strings (agent-core and companion)

Each row's source is a function in `packages/agent-core/src` or `apps/companion/src`. The "Seen" column names a
screen in `before/`.

| Source | Today | Seen | Problem | v2 |
| --- | --- | --- | --- | --- |
| `view.ts titleFor` sessions | `SESSIONS` | 01 | No count, no scope | `ACTIVE 20`, `RECENT 42`, `ALL 279`. Then ` +N new` when items wait for a re-sort (§3.4), then the repo or task filter name. Clip to 20. |
| `titleFor` task filter | `T:<task title>` | 12 | `T:` is cryptic | `ACTIVE 3 <task title>` (the filter name follows the scope) |
| `titleFor` tasks | `TASKS ALL` / `TASKS <project>` | 10 | "ALL" of what? | `TASKS 8` or `TASKS 8 <repo>` |
| `titleFor` inbox | `INBOX 3` | 13 | Inbox is not what GLO becomes | `TO DO 16` (§3.6) |
| `titleFor` voice | `VOICE <state.toUpperCase()>` | 15–17 | The raw enum gives `VOICE TARGET_UNAVAIL` | `TALK` (the panel already shows the state) |
| `titleFor` confirm | `CONFIRM` | 07 | Repeats the chip | `CHECK BEFORE DOING` |
| `slotFor` label | `clip(title, 12)` | 01 | All 279 real titles are longer than 12 (median 28, p90 40). 68 of 279 sessions share a 12-character prefix with another one (`session-stats.json` `titles`). | `titleSplit(title).head`: words up to 12 chars, cut at a word boundary, no ellipsis. Lines 1–2 continue the title from there (below). |
| `detailFor` line1 | full title, clipped to 20 | 01 | Repeats the label, then cuts mid-word | `titleSplit(title).rest[0]`: the title text after the head, wrapped at 20 |
| `detailFor` line2 | `${STALE }${state}${?}`, e.g. `approval_required?` | 02, 05 | Raw enum with underscores; `?` is cryptic | `titleSplit(title).rest[1]` (second wrap line). Empty when the title has ended; then the task name is used. |
| `detailFor` line3 | summary or approval summary | 02 | No age | `<age> <what>`: `12m rm -rf build/`, `3h Tests failed: 3`, `2d in Firmware app`. "What" and age come from §1.4. |
| `detailFor` line4 | workspace path | 01 | Low value | The hint line (§2.3), e.g. `SAVE approve FX deny` |
| `optionLines` (key long press) | `ENV:STOP DBL:FOCUS`, `SAVE:OK FX:NO`, `ENV:--`, `SAVE:-- FX:--`, `DBL:--` | 03 | Code-speak, and needs a long press to find | Removed. The hint line always shows the actions, and the help overlay shows the rest. Key long press now pins (§3.5). |
| Stale state text | `STALE ` prefix | — | Jargon | line3 `gone from Traycer` |
| Inferred state | `?` suffix | 05 | Cryptic | line3 ends with ` (guess)` when the state is inferred, e.g. `2h idle (guess)` |
| `detailFor` tasks | title / `N sessions` / two session titles | 11 | — | label = task head, lines 1–2 = the rest of the title, line3 `5 chats, 1 needs you` / `5 chats, 2 working` / `5 chats, all quiet`, line4 = hint |
| No selection | `No selection`, `No task selected`, `Inbox` | 10, 23 | — | label band `nothing selected` (firmware); line1 `Turn SELECT or tap a`, line2 `key.`, line4 hint `Hold SCL for help` |
| Confirm detail | label sliced at 20 / 40: `APPROVE rm -rf build` + `/` | 08 | Breaks mid-word; the `SAVE=YES  FX=NO` host line duplicates the firmware chip | line1 (FONT_L or FONT_S in the label band) = the verb: `Approve?`, `Deny?`, `Stop this agent?`, `Start new chat?`, `Create new task?`. Lines 2–3 = the target title wrapped at 20 on word boundaries. Line 4 = the target's age and what (§1.4). The host sends no `SAVE=YES` line. |
| Voice target (`destinationFor` label) | session title, `+S <task>`, `+T <project>` | 15 | `+S` and `+T` are cryptic | `<session head>`, `new chat: <task>`, `new task: <repo>` (clip 20) |
| Voice detail line1 | error or target label | 17 | Never drawn: the firmware ignores `SET_DETAIL` in the voice view, so the transcript never appears on the device | v2 voice bands (§2.4): line1/line2 = the transcript wrapped at 20 (or the error), line4 = the hint |
| `legendFor` sessions | `CONT`/`NEWSES`/`NEWTSK`, `CLAUDE`/`CODEX`/`--`, `FOCUS`, `INTR` | 01, 18, 20 | Cryptic. Labels knobs whose position is not obvious. A knob turn triggers focus and interrupt. | `SHOW` `REPO` `TASK` `TALK` (§2.3) |
| `legendFor` tasks | `<mode>`, `<provider>`, `NEWSES`, `--` | 10 | — | `SHOW` `REPO` `` `TALK` |
| `legendFor` inbox | `S:APPR`, `F:DENY`, `SCROLL`, `--` | 13 | Button actions in knob cells | `` `` `` `TALK` (buttons move to the hint line) |
| `legendFor` confirm / voice | `S:YES` `F:NO` / `R:STOP` `F:CANC` `S:SEND` `P:RTRY` `--` | 07, 15, 17 | One-letter button codes | all four empty. Buttons appear in the hint line. |
| `--` filler | `--` | everywhere | Noise | empty string. The firmware draws an empty cell with no tag. |
| `status.text` | `BACKEND DOWN`, controller messages | 22 | Shown only when link ≠ ok (`fm1c_draw_status`), so controller messages never appear here | `Traycer offline` (down) / `Traycer limited` (degraded). Controller messages go to toasts only. |
| `noteResult` labels | `QUEUED`/`SENT`/`ACKED`/`DONE`/`FAILED`/`UNSUPPORTED`/`TARGET GONE` + raw message | — | Feeds `status.text`, which is never visible while ok | Removed from `status.text`. The toast table (§1.5) replaces them. |
| `feedback.ts ACTION_TEXT` | `SELECTED`, `READ`, `RECORDING`, `TRANSCRIBING`, `CANCELLED` | 01, 13 | A toast on every key tap, and it covers line 4 | No toast for select, markRead, view switch, voiceStart or voiceStop: the screen already changes. `Cancelled` stays. |
| `feedback.ts` view switch | `SESSIONS` / `TASKS` / `INBOX` | 10 | Noise | none |
| `feedback.ts` confirm opened | `CONFIRM?` | 08 | Covers the confirm view's own chip | none |
| `feedback.ts MESSAGE_STAGE` | `NO TARGET`, `NO TASK`, `NOT RUNNING`, `IN FLIGHT` | — | Shouting codes | §1.5 |
| `stage-relay.ts LABEL` | `QUEUED` `SENT` `DELIVERED` `DONE` `FAILED` `UNSUPPORTED` `TARGET GONE` or the raw error | 21 | The raw error is clipped mid-word (`timed out waiting fo`) | §1.5 |
| Adapter/console result messages | `session is stale`, the approval-gone message, `task unavailable`, `focus unsupported`, `target stale`, `stale`/`unknown`/`disconnected` (`ResolveError`), exception text | — | Internal wording, clipped to 20 | §1.5 reason table |

### 1.4 Shortening scheme (the only abbreviations allowed)

1. **Button and knob names** are written as printed on the panel (§2.1): `OCT-`, `OCT+`, `FX`, `SCL`, `ENV`, `LFO`,
   `EDIT`, `GLO`, `HOME`, `SAVE`, `ARP`, `SEQ`, `PLAY`, `REC`, `SELECT`, `ALGORITHM`, `PRESETS`, `KNOB1`–`KNOB4`.
   These are the only all-caps abbreviations.
2. **Ages**: `now` (< 60 s), `<n>m` (< 60 min), `<n>h` (< 48 h), `<n>d` (< 14 d), `<n>w`. No space, no "ago".
   `ageText(ms)` in `copy.ts`.
3. **Cutting text**: cut at the last space at or before the limit. A single word longer than the limit is cut at
   the limit. No ellipsis, because it costs 3 of 20 characters.
4. **Title split** (`titleSplit(title)`): replace non-ASCII characters with a space and collapse runs of spaces.
   `head` = the words that fit in 12 characters. If the first word is longer than 12, `head` = its first 12
   characters and the remainder starts with the rest of that word. `rest` = the remainder wrapped at 20 into at most
   2 lines; the second line is cut by rule 3. Head plus 2 lines hold 52 characters. That covers every measured title
   (max 55) except the last 3 characters of the longest.
5. **"What" text** for line3, by state: approval → approval summary; waiting_input → session summary (the question);
   failed → outcome detail or `failed`; completed_* → summary or `finished`; working → summary or `working`;
   idle/unknown → `in <task title>`; stale → `gone from Traycer`; inferred → append ` (guess)` if it fits in 20.
6. **Provider names**: `Claude`, `Codex` in sentence-case text, `CLAUDE` / `CODEX` on chips. Never `C` / `X`.
7. **Scopes**: `ACTIVE`, `RECENT`, `ALL`, `TO DO`. **Talk targets**: `reply`, `Claude chat`, `Codex chat`,
   `Claude task`, `Codex task`. **Repo** means a Traycer workspace project (`ws:` id).

### 1.5 Toast text (`COMMAND_RESULT.text`)

The table lives in `copy.ts` as `toastFor(stage, message)`. Toasts use sentence case and are ≤ 20 characters.

| Event | Result code | Text |
| --- | --- | --- |
| KNOB1 turned | accepted_locally | `Show: active (20)`, `Show: recent (42)`, `Show: all (279)` (count clipped to fit) |
| KNOB2 turned | accepted_locally | `Repo: <name>` / `Repo: all` |
| KNOB3 turned | accepted_locally | `Task: <title>` / `Task: all` |
| KNOB4 turned | accepted_locally | `Talk: reply` / `Talk: Claude chat` / `Talk: Codex chat` / `Talk: Claude task` / `Talk: Codex task` |
| Key long press (pin / unpin) | accepted_locally | `Pinned` / `Unpinned`; only at the safety cap (§3.5, 2026-11-19): `Pins full (200)`, `Task pins full (200)` |
| HOME in sessions (re-sort) | accepted_locally | `Sorted` |
| FX dismiss in TO DO | accepted_locally | `Dismissed, FX undo`; FX again within 3 s: `Restored` (§3.6) |
| REC short tap, no suggestion and no canned response (docs/ui-v3.md §12) | accepted_locally | `No suggestion/canned` |
| ARP tap on REVIEW (docs/ui-v3.md §12.3) | accepted_locally / failed | `Saved as canned N`, `Already canned`; full: `Canned list full` (failed) |
| FX hold on a canned REVIEW (docs/ui-v3.md §12.4) | accepted_locally | `Canned deleted`; FX again within 3 s: `Canned restored` |
| REC on a session that takes no console prompts (`session.prompt.acceptsPrompt` false) | unsupported | the adapter's `prompt.toast` (Traycer: `Terminal: use Mac`, `No sender for task`, `Not supported`), else `Can't take prompts` |
| Confirm cancelled | accepted_locally | `Cancelled` |
| Voice cancelled | accepted_locally | `Cancelled` |
| Controller `NOT RUNNING` | failed | `Nothing to stop` |
| Controller `NO TARGET` | target_unavailable | `Select a chat first` |
| Controller `NO TASK` | target_unavailable | `Select a task first` |
| Controller `IN FLIGHT` | accepted_locally | `Still sending` |
| Capability unsupported | unsupported | `Not supported` |
| focus ok | completed | `Opened on Mac` |
| interrupt ok (sent / ack / done) | sent / acknowledged / completed | `Stop sent` / `Stopping` / `Stopped` |
| approve / deny ok | acknowledged or completed | `Approved` / `Denied` |
| createSession ok | completed | `Chat created` |
| Voice stages | accepted_locally / sent / acknowledged / completed | `Queued` / `Sent` / `Delivered` / `Done` |
| Voice prompt that ends `sent` with a reason (delivery not observed, e.g. Traycer a2a to a blocked terminal agent) | sent | `Queued, undelivered` (the operator's "Queued, not delivered" is 21 characters) |
| Link down (`disconnected`, `<Backend> host disconnected`) | failed | `<backend> offline`, the backend named by the adapter (`AgentAdapter.displayName`, else its id; Traycer: `Traycer offline`). The status line (`<name> offline` / `<name> limited`) and the stale wording (`Gone from <name>`, `gone from <name>`, `GONE FROM <NAME>`) use the same name. |
| Any failure | failed / target_unavailable | `resultReason(message)`, below |

`resultReason(message)` matches whole strings, then prefixes, and falls back:

| Message (adapter, console, dispatcher, composer) | Text |
| --- | --- |
| `session is stale`, `stale`, `unknown`, `target stale`, `target unknown` | `Chat is gone` |
| `disconnected`, `target disconnected`, `Traycer host disconnected` | `Traycer offline` |
| the approval-gone message of `controller.ts executeConfirm`, `approval already answered` | `Already answered` |
| `task gone`, `task unavailable` | `Task is gone` |
| `project unavailable` | `Repo is gone` |
| `target not accepting prompts` | `Chat can't take it` |
| `timed out waiting for backend acknowledgement` | `No reply - retry?` |
| `transcript is empty` | `Nothing heard` |
| ends with ` unsupported` | `Not supported` |
| anything else | `Failed - see Mac` (the full message goes to the companion log and UI) |

---

## 2. Legend and controls

### 2.1 Physical layout

Sources:

- `fm1-emu/crates/fm1-live/src/panel.rs:117-140`, the emulator front panel "drawn after Felucca's controls
  diagram", canvas 1280×820.
- The Agent Deck hero photo `fm-1-agent-deck/docs/fm1-agent-deck-hero.jpg`. It shows the same positions, but its
  button silkscreen differs (`FF`, `MUTE`, `BAND`, `PLAY/STOP`), so it may be a render.
- `dinghy/docs/API.md` for the HAL ids.

```
 +-------------------------------------------------------------------------------------------+
 |  MASTER   SELECT   +--------------------------+   KNOB1   KNOB2   KNOB3   KNOB4             |
 |   (110)   (250)    |                          |   (935)   (1027)  (1119)  (1211)  y=120     |
 |                    |    LCD 240x240           |                                           |
 |  PRESETS ALGORITHM |   shown 2x at x 370..850 |   [FX ] [SCL ] [ENV ] [LFO ] [EDIT] [GLO ]  y=232
 |   (110)   (250)    |                          |   [HOME] [SAVE] [ARP ] [SEQ ] [PLAY] [REC ]  y=308
 |                    |   legend row at the      |    x = 906 + 58*i                         |
 |  [OCT-] [OCT+]     |   bottom of the LCD      |                                           |
 |   y=398            +--------------------------+                                           |
 |      F#3 G#3 A#3     C#4 D#4     F#4 G#4 A#4     C#5 D#5     F#5   (black keys, y=574)      |
 |    F3  G3  A3  B3  C4  D4  E4  F4  G4  A4  B4  C5  D5  E5  F5  G5  (white keys, y=680)      |
 +-------------------------------------------------------------------------------------------+
```

Findings:

- **KNOB1–KNOB4 are not under the LCD.** They form a row at the top right, to the right of the screen and above
  the 2×6 button block. The four legend cells share only their left-to-right order with them. The operator cannot
  tell that cell 1 is KNOB1, which explains the feedback.
- The 14 buttons sit in a 2×6 block right of the LCD, plus OCT−/OCT+ bottom left. Button `BTN_SEL` (id 3) is
  printed **SCL** (fm1-emu label; Dinghy maps it to "SCALE" on the SMK-37).
- The 27 keys are two rows: 16 white keys (F3…G5) and 11 black keys above the gaps. Today's on-screen key strip is
  one chromatic row of 27 thin cells in groups of 9. Those groups match nothing on the keyboard, so slot k is hard
  to find unless you count chromatic keys. The key LEDs on the keys themselves are the reliable mapping.
- The encoders have no push switches. Knobs can only be turned, so a knob must never trigger a one-shot action
  (today KNOB3 turned = focus and KNOB4 turned = interrupt).

### 2.2 What the code binds today (`controller.ts`)

| Control | Sessions | Tasks | Inbox | Legend cell shown |
| --- | --- | --- | --- | --- |
| KNOB1 turn | voice mode cycle | voice mode | voice mode | `CONT`/`NEWSES`/`NEWTSK` |
| KNOB2 turn | provider toggle | provider | provider | `CLAUDE`/`CODEX`/`--` |
| KNOB3 turn | **focus** (one-shot) | **new session** (one-shot, opens confirm) | detail scroll +1 only | `FOCUS` / `NEWSES` / `SCROLL` |
| KNOB4 turn | **interrupt** (opens confirm) | — | — | `INTR` |
| SAVE / FX | approve / deny (confirm) | — | approve / deny | inbox: `S:APPR` `F:DENY` |
| ENV | interrupt (confirm) | interrupt | interrupt | — |
| PLAY | — (voice retry) | new session | — | `P:RTRY` (voice) |
| REC | push to talk | | | `R:STOP` (voice) |
| SELECT | move selection | move task cursor | move inbox cursor | — |
| ALGORITHM | project cycle (tasks list) | | | — |
| PRESETS, SCL, LFO, ARP, SEQ, MASTER | unused | | | — |

Problems: the legend mixes knob labels (cells 1–4) with button codes (`S:`, `F:`, `R:`, `P:`). KNOB3/KNOB4 fire
actions when turned. One cell means three things across views.

### 2.3 v2 control map

Rules:

- **Knobs (KNOB1–4) only change a setting or scroll, never act.** The bottom legend shows only knobs, each cell
  tagged with its knob name.
- **Buttons act.** The hint line (line 4) names the buttons that do something for the selected item now.
- **Left encoders navigate, the same in every list view.**
- **Hold SCL for help.**

| Control | Sessions | Tasks | TO DO (GLO) | Voice | Confirm |
| --- | --- | --- | --- | --- | --- |
| key tap | select | open the task (Sessions filtered to it) | select | — | — |
| key double tap | open on Mac (focus) | — | open on Mac | — | — |
| key long press | pin / unpin (§3.5) | — | pin / unpin | — | — |
| black key tap (SPLIT keys, protocol 6, docs/ui-v3.md §10.3) | F#3/G#3/A#3 choose ALL / PINNED / NEEDS YOU; a task key chooses the task (white keys show its sessions); the chosen task (or PINNED, NEEDS YOU) again → ALL | (flat keys) | (flat keys) | — | — |
| black key double tap (SPLIT) | task key: open the task's first session on Mac (focus); filters: nothing | — | — | — | — |
| black key long press (SPLIT) | task key: pin / unpin the task (task pins: own safety cap of 200, §3.5); filters: nothing | — | — | — | — |
| SELECT turn | move selection (SPLIT: white keys only) | move | move | — | — |
| ALGORITHM turn | jump to next/previous item that needs you (tiers T0–T3, layout order, crosses pages) | next/previous task that needs you | next/previous item | — | — |
| PRESETS turn | scroll line1–3 text | scroll | scroll | scroll transcript | — |
| OCT− / OCT+ | page (SPLIT: pages the white keys; the single press acts 300 ms after release, docs/ui-v3.md §10.5) | page | page | — | — |
| OCT− / OCT+ double press (SPLIT, second down ≤ 300 ms after the first up) | previous / next task page of the black row (wraps; the choice stays) | — | — | — | — |
| KNOB1 turn | **SHOW**: scope ACTIVE → RECENT → ALL (→ PINNED, protocol 5; not in SPLIT, where the PINNED black key replaces it) | SHOW | — | — | — |
| KNOB2 turn | **REPO**: all → repo 1 → repo 2 … (repos with ≥ 1 session in scope, by best tier); wraps both ways, all always reachable. A task choice (Tasks tap, folded row) sets the task's repo implicitly; clearing the task choice (KNOB3 to all, SPLIT ALL, the chosen task again) restores the KNOB2 repo (docs/ui-v3.md §10.9) | REPO | — | — | — |
| KNOB3 turn | **TASK**: all → tasks in the repo (best tier first), wraps. SPLIT: steps the chosen task through the task row, one task per detent, wrapping, only tasks (first turn from ALL/PINNED/NEEDS YOU: first task clockwise, last counter-clockwise); the task page follows; the white keys follow once the knob rests 300 ms (docs/ui-v3.md §10.9) | — | — | — | — |
| KNOB4 turn | **TALK**: reply → Claude chat → Codex chat → Claude task → Codex task (only the supported ones) | TALK | TALK | — | — |
| SAVE | approve (→ confirm) when an approval is pending | — | approve (→ confirm) | send | yes |
| FX | deny (→ confirm) when an approval is pending | — | deny (→ confirm) on approvals, **dismiss** on other items | cancel | no |
| ENV | stop the agent (→ confirm), if working/waiting/approval | — | stop | — | — |
| PLAY | open on Mac (focus); on a selected session it acts on **release** (docs/ui-v3.md §14) | new chat in task (→ confirm) | open on Mac (on release) | retry after a failed send | — |
| PLAY hold ≥ 1 s (docs/ui-v3.md §14) | **read aloud** the selected session's latest message (also on its DETAILS page); never also opens on Mac | — (PLAY new chat on down) | read aloud | — | — |
| PLAY or FX while read aloud plays (docs/ui-v3.md §14) | stop (`Stopped`); FX keeps its meaning when nothing is speaking | stop | stop | stop | stop |
| REC hold | talk to the TALK target | talk (new chat in this task) | talk (reply) | release = stop | — |
| REC short tap (< 350 ms, docs/ui-v3.md §11-12) | review: the chat's suggestions, then the canned responses (new chat / new task: canned only); none: `No suggestion/canned` | same | same | — | — |
| ARP tap on REVIEW (docs/ui-v3.md §12.3) | — | — | — | save the shown text as a canned response (`Saved as canned N`, `Already canned`, `Canned list full`); never opens SETTINGS; nothing sent | no |
| FX hold ≥ 1 s on a canned REVIEW (docs/ui-v3.md §12.4) | — | — | — | delete the entry at release (`Canned deleted`); FX again within 3 s restores (`Canned restored`); a shorter press cancels | no |
| HOME | Sessions. Pressed in Sessions: **re-sort** now (§3.4) | Sessions | Sessions | — | — |
| EDIT | Tasks | Tasks (re-sort) | Tasks | — | — |
| GLO | TO DO | TO DO | TO DO (re-sort) | — | — |
| SCL hold ≥ 400 ms | help overlay (firmware-local, §2.5) | same | same | same | same |
| ARP hold ≥ 1 s (protocol 6, docs/ui-v3.md §10.2) | SETTINGS (a tap toasts `Hold ARP: settings`) | SETTINGS | SETTINGS | — | — |
| SETTINGS (view 6) | SELECT moves, SAVE changes the row (`Keys: Ranked / Split`), HOME closes to Sessions, LFO/ARP close back | | | | |
| LFO, SEQ | LFO details (protocol 3), SEQ layout (protocol 5) | | | | |
| MASTER | unused (reserved) | | | | |

Legend per context (`SET_LEGEND`, KNOB1..KNOB4, ≤ 6 characters, `""` = empty cell):

| Context | KNOB1 | KNOB2 | KNOB3 | KNOB4 |
| --- | --- | --- | --- | --- |
| Sessions | `SHOW` | `REPO` | `TASK` | `TALK` |
| Sessions, SPLIT keys (PINNED chosen: KNOB2 ``) | `SHOW` | `REPO` | `TASK` | `TALK` |
| Tasks | `SHOW` | `REPO` | `` | `TALK` |
| TO DO | `` | `` | `` | `TALK` |
| Voice, confirm | `` | `` | `` | `` |
| SETTINGS | `` | `` | `` | `` |

A knob whose cell is empty does nothing. The current values (scope, repo, task) appear in the title bar (§1.3).
KNOB4's value is the REC verb in the hint line. Each turn also gives a toast (§1.5).

Hint line (`SET_DETAIL.line4`), built by `hintLine(pairs)`: `<BUTTON> <verb>` pairs in priority order, joined
by two spaces. While it is over 20 characters, use one space. If it is still over 20, drop the last pair. A pair
is shown only when the capability is supported and the action is possible now.

| Selected item | Pairs, in priority order | Typical result |
| --- | --- | --- |
| approval_required | SAVE approve, FX deny | `SAVE approve  FX deny` (21 chars, so joined with one space: `SAVE approve FX deny`) |
| waiting_input | REC `<talk verb>`, PLAY open | `REC reply  PLAY open` |
| working | ENV stop, PLAY open | `ENV stop  PLAY open` |
| failed, completed_*, idle | REC `<talk verb>`, PLAY open | `REC reply  PLAY open`; with KNOB4 on Claude chat: `REC new chat` + `PLAY open` = 22, so `REC new chat PLAY open` (still 22) drops PLAY: `REC new chat` |
| unknown (`acceptsPrompt` false) | PLAY open | `PLAY open` |
| stale or disconnected | — | `HOME re-sorts` |
| TO DO, non-approval item | FX dismiss, PLAY open | `FX dismiss  PLAY open` (21, so one space: `FX dismiss PLAY open`) |
| Tasks, a task selected | PLAY new chat, REC talk | `PLAY new chat` |
| nothing selected | — | `Hold SCL for help` |
| Voice recording / transcribing / reviewing / submitting / failed (retryable) / failed / target_unavailable | — | `release REC to stop` / `FX cancel` / `SAVE send  FX cancel` / `sending...` / `PLAY retry  FX close` / `FX close` / `FX close` |
| Confirm | firmware-drawn | `SAVE yes   FX no` |

Talk verb: `reply` (reply mode), `new chat` (Claude/Codex chat), `new task` (Claude/Codex task).

### 2.4 Rendering changes (firmware, proto 2 only)

**Legend cell** (`fm1c_draw_legend`), for each cell i, x0 = 60·i:

- Empty label: draw only the separator, no tag.
- Otherwise draw the tag `KNOB<i+1>` in `FONT_S` #808080, centred, at y = 202. Draw the label in `FONT_S` white,
  centred, at y = 220. The separators and the rule on row 200 stay as they are.
- A cell is 60×40, two rows of 16 px plus margins. Nothing else changes in the legend region.

**Hint bar** (band 5, rows 120–135, in sessions/tasks/inbox and voice views; the confirm view keeps its own chip):

- Fill x 0–239 with #202020 and draw `SET_DETAIL.line4` in `FONT_S` at x = 4.
- Tokens are separated by spaces. A token matching `^[A-Z0-9][A-Z0-9+/-]+$` (a control name) is drawn white;
  every other token is drawn #A0A0A0. Spaces keep their width.
- The toast still replaces band 5 for its 2.5 / 4 s.
- The confirm chip becomes the hint bar with the fixed text `SAVE yes   FX no`.

**Voice view bands** (proto 2):

| Band | recording | transcribing | other voice states |
| --- | --- | --- | --- |
| 2 (line 1) | level bar (unchanged) | level bar (empty) | `SET_DETAIL.line1`, white |
| 3 (line 2) | elapsed `12.3 s` | elapsed | `SET_DETAIL.line2`, #C0C0C0 |
| 4 (line 3) | `to <target>` | `to <target>` | `to <target>` |
| 5 (line 4) | hint bar from `SET_DETAIL.line4` | same | same |

Host side: in the voice view `SET_DETAIL` line1–2 carry the transcript wrapped at 20 (or the error, in failed or
target_unavailable), line3 is `""`, and line4 is the hint.

**Status link "ok"**: a 6×6 square #20C060 at y 9–14, right-aligned where the text was. The badge and page
positions are computed with a width of 6.

**Provider none**: no chip.

**Keyboard-style key strip** (rows 136–199). It replaces the 27 thin cells:

- White key index w (0–15) for keys k ∈ {0,2,4,6,7,9,11,12,14,16,18,19,21,23,24,26}.
  - Box: x = 8 + 14·w, width 14, rows 166–199.
  - Fill: x+1…x+12, rows 170–195 (12×26).
  - Selected: a white frame of 2 px over x…x+13, rows 168–197, with the fill at x+2…x+11.
- Black key k ∈ {1,3,5,8,10,13,15,17,20,22,25}, centred over the boundary after white key a ∈
  {0,1,2,4,5,7,8,9,11,12,14} (same order).
  - Box: c = 8 + 14·(a+1), x = c − 6, width 12, rows 136–165.
  - Fill: c−5…c+4, rows 140–163 (10×24).
  - Selected: a white frame of 2 px over the box rows 138–165.
- Empty: black fill with a 1 px #303030 outline (as today). Stale: the corner-to-corner cross (as today).
- **Pinned (flag bit 3)**: the top 4 rows of the fill drawn white, or black on light colours (`fm1c_dark`).
- Redraw unit for one slot: its box. A white box is 14×34 = 476 px and a black box is 12×30 = 360 px. Today one slot
  is 8×64 = 512 px.

### 2.5 Help overlay (firmware-local, proto 2)

- **Trigger**: `BTN_SEL` (printed SCL) held ≥ 400 ms while version 2 is agreed. The firmware still sends SCL's
  down/up `BUTTON` frames, and the host ignores SCL.
- **While shown**: the firmware sends **no** other KEY/BUTTON/ENCODER/POT frames. Inputs are dropped and never queued.
  Heartbeats, ACKs and host frames continue. Host frames update the model, and the firmware draws nothing under the
  overlay.
- **Release**: the overlay closes and every region under it is marked dirty, so the current state is redrawn.
- **Area**: rows 24–199, black background, 11 lines of `FONT_S` at x = 4, y = 26 + 16·n. Line 0 is amber, the
  rest white. The status bar and the legend stay visible.

The text comes from `fm1c_help.h` and is picked by the current view. Each line is ≤ 29 characters.

Base (sessions, tasks, TO DO):

```
HELP - let go of SCL
key tap   select / open task
key 2x    open on Mac
key hold  pin or unpin
SELECT move  PRESETS scroll
ALGORITHM next needing you
OCT-/OCT+ page  ENV stop
SAVE approve  FX deny/dismiss
PLAY open on Mac / new chat
REC hold to talk  HOME sort
EDIT tasks  GLO to do
```

Voice:

```
HELP - let go of SCL
REC hold    record
REC let go  stop, transcribe
SAVE        send
FX          cancel
PLAY        retry after fail
PRESETS     scroll text
```

Confirm:

```
HELP - let go of SCL
SAVE  yes, do it
FX    no, go back
Nothing else acts here.
```

The same strings are exported from agent-core as `HELP_TEXT` (`control-map.ts`). A test (§5.1) parses
`fm1c_help.h` and requires equality, so the firmware and the host cannot drift.

---

## 3. 279 sessions: actionable first

### 3.1 Measured distribution (`session-stats.json`, 2026-11-18, read only)

The operator's 279 is exactly what the companion lists. The adapter's default `sessionScanLimit` is 25, and the 25
most recently updated Tasks hold **279** sessions. The full host holds 433 listed sessions in 98 Tasks, plus 244
archived ones (not listed), across 157 Tasks and 14 repos.

| | approval_required | waiting_input | failed | completed_unread | working | idle | completed_read | unknown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Companion scan (279) | 0 | 0 | 20 | 13 | 4 | 194 | 12 | 36 |
| All listed (433) | 0 | 0 | 22 | 19 | 4 | 255 | 18 | 115 |

- Runtime: 253 GUI chats and 180 terminals. The terminals are all `unknown` (115) or inferred `idle` (65).
- Provider: 296 Claude, 137 Codex.
- Age since last activity (all 433): < 1 h 24, 1–24 h 44, 1–3 d 48, 3–7 d 1, 7–30 d 102, > 30 d 214. Of the 115
  `unknown` sessions, 103 are older than 30 days.
- Old results: 8 failed and 8 completed_unread are older than 30 days, and they still sit in today's inbox. Today's
  attention badge shows 33 for the 279 (`before/23-scale-279-page1.png`).
- Tasks: 63 of 98 hold one session; 5 hold 20 or more (the largest holds 69). One repo holds 333 of the 433.
- Titles: all longer than 12 characters, median 28, p90 40, max 55.
- No approval or question was pending at the time of the probe. The design still ranks them first: they block an
  agent.

Today 279 sessions fill 11 pages in creation order. Page 1 is 27 mostly grey keys (`before/23`). The 33 attention
items are spread over all 11 pages.

### 3.2 Tiers and ordering

`tierOf(entry, now)` uses the display state (inbox read state applied), the time of the last activity
`lastActivityAt` (§5.1), and the local dismiss set:

| Tier | Rule | Within-tier order |
| --- | --- | --- |
| T0 | approval_required | oldest request first (approval `createdAt`, else inbox occurrence `since`) |
| T1 | waiting_input | oldest first (occurrence `since`) |
| T2 | failed and age ≤ 72 h and not dismissed | newest first (`lastActivityAt` desc) |
| T3 | completed_unread and age ≤ 72 h and not dismissed | newest first |
| T4 | working | newest activity first |
| T5 | idle / completed_read / unknown / disconnected / dismissed, with age ≤ 8 h | newest first |
| T6 | failed or completed_unread with age > 72 h (and not dismissed) | newest first |
| T7 | everything else | newest first |

The final tie-break is `sessionKey` ascending, so the order is deterministic. Stale entries (identity fails to
resolve) keep their tier from their last state while they keep a key (§3.4), and they drop out at the next
re-sort.

Why this order: T0/T1 block an agent, so the longest wait goes first. T2/T3 are results: the newest is the most
relevant, and after 3 days a result is history. Working agents need nothing but are worth watching. T5 is "what I
touched today". The windows are constants `RESULT_WINDOW_MS = 72 h` and `RECENT_WINDOW_MS = 8 h` in `focus.ts`.

### 3.3 Scopes and filters

| Scope (KNOB1) | Shows | Companion scan (279) | All listed (433) | Pages |
| --- | --- | --- | --- | --- |
| **ACTIVE** (default) | T0–T4 | **20** (11 failed, 5 done-unread, 4 working) | 21 | 1 |
| RECENT | T0–T5 | 42 | 43 | 2 |
| ALL | T0–T7 | 279 | 433 | 11 / 17 |
| TO DO (the GLO view, §3.6) | T0–T3, then T6 | 16 + 17 older = 33 | 17 + 24 = 41 | 2 |
| **PINNED** (KNOB1 after ALL; docs/ui-v3.md §9.4, protocol 5 round) | every pinned session, all tiers, all repos (since 2026-11-19 a task pin takes no session key; Grouped lists each pinned task as a row) | - | - | - |

A 24 h window would make RECENT 73 (279) or 75 (433). The 8 h window keeps RECENT to two pages.

- Hidden by default: T5–T7 (259 of 279), archived sessions (already excluded by the adapter, 244), stale sessions
  after their retention.
- Pins are always shown, in every scope (§3.5): first, before the other sessions that need you and the rest.
- **PINNED** (2026-11-18, docs/ui-v3.md §9.4) ignores REPO and TASK: their legend cells are empty and the knobs do nothing
  there. Title `PINNED <n>`; with no pins the bubble/header says `No pins yet` / `hold a key to pin`.
- **REPO (KNOB2)** and **TASK (KNOB3)** filter the scope. The task list holds the tasks of the current repo that
  have ≥ 1 session in the scope, ordered by best tier, then newest activity, then title. Changing the repo resets
  the task filter to all.
- **Tasks view (EDIT)** lists tasks under the same SHOW and REPO. A task's state is the most urgent of its sessions
  (existing `URGENCY`). Order: best tier, newest activity, title. Measured: ACTIVE 8 tasks, RECENT 12, ALL 25 (scan)
  or 98 (all).
- The scope, repo, task and talk mode live in `ControllerState`. They survive view switches and are not persisted.

### 3.4 Filling the 27 keys without slots jumping under the finger

A **frozen layout** is an ordered list of session keys, cut into pages of 27. It is computed by `relayout()` and
then held still.

**Re-sort happens only on:**

1. entering the view from another view (HOME / EDIT / GLO from elsewhere);
2. pressing the current view's button again (HOME in Sessions, EDIT in Tasks, GLO in TO DO), which gives the toast
   `Sorted`;
3. turning KNOB1 / KNOB2 / KNOB3 (a scope or filter change);
4. auto: 60 s with no device input, only in a base view, never in voice/confirm/help, and only if the order would
   change. The current page index is kept, but clamped.

After re-sorts 1–3, the page is 1 and the selection is kept by identity. If the selected session is off
page 1, it stays selected (detail visible) but off-page. SELECT moves from it.

**Layout of page 1:**

- Keys 0…23: the sorted list: since 2026-11-22 (§3.5) the pinned sessions first, then the other sessions that need you
  (T0–T3), then the rest of the scope. (2026-11-19 to 2026-11-22: need you first, then the pins; before: keys 0…p−1
  held the pins in pin order.)
- Keys 24–26 (F5, F#5, G5): reserved for new arrivals and left empty at layout time.
- Later pages: the rest of the list, 27 keys per page. Fewer items than 24 means the reserved keys are simply the
  next empty keys after the list.

**Between re-sorts:**

- A state change updates the key in place (colour, LED, chip). Keys never move.
- A session that becomes T0–T3 and is not in the layout (it was hidden or on another page) goes into the first free
  reserved key (24 → 26). A session the console itself created (new chat/task) also goes there.
- If the reserved keys are full, nothing moves. The title shows ` +N new`, the GLO LED blinks, and the next re-sort
  places them.
- A session that leaves the scope (an approval answered, a result read) keeps its key with its new state until the
  next re-sort.
- A session that disappears is crossed (stale, as today) and keeps its key until the next re-sort, or until the
  existing stale retention prunes it.
- Paging (OCT±) only shows another slice of the frozen list. It never re-sorts.

With the measured data, ACTIVE (20) fits page 1 with 4 free keys plus the 3 reserved keys. Every failed and
unread result of the last 3 days is on keys F3…D5, blinking on the physical key LEDs.

### 3.5 Pins

> **Updated 2026-11-19 (operator decision "no limit"; supersedes the 6- and 9-pin limits below in history).**

- **No limit.** Session pins and task pins are counted and stored apart. Each kind has only a safety cap of **200**
  (`MAX_PINS_PER_KIND` in `focus.ts`). At the cap the toast is `Pins full (200)` (session) or `Task pins full (200)` (task,
  20 characters); no other copy names a number. Help and hint lines do not mention a limit and are unchanged.
- **Pin a session:** key long press in Sessions (any layout, RANKED or SPLIT white key) or TO DO: `Pinned` / `Unpinned`.
  **Pin a task:** key long press on a folded task row (Grouped), on a task in the Tasks view, or on a SPLIT task key:
  `Task pinned` / `Task unpinned`.
- **Order (every Sessions layout path; operator decision 2026-11-22, pins first):** the **pinned sessions** (whatever
  their tier) first, then the other sessions that **need you** (T0–T3, §3.2: approval, question, failed and unread
  results within 72 h, not dismissed), then the rest of the scope. Priority order (§3.2) inside each part; pins no longer
  keep pin order and take no fixed keys. (2026-11-19 to 2026-11-22 the sessions that need you came before the pins.)
  - Buddy and List (RANKED, and the SPLIT white keys for ALL, PINNED and a chosen task): exactly that, session by
    session. A pinned session shows whatever SHOW says, but respects REPO and TASK.
  - Grouped (docs/ui-v3.md §9.2): the same order by group: the Pinned group (every pinned session; a pinned session that
    needs you also leaves its task group for Pinned), then task groups with a session that needs you, then the other
    task groups.
  - NEEDS YOU (SPLIT) and TO DO are unaffected: pins are not lifted there.
- **Task pins take no session key.** They only order the SPLIT task row (pinned tasks first, docs/ui-v3.md §10.4) and
  mark the task (flag bit 3 on the task chip / folded row, the pinned flag on its group header). A session of a pinned task
  is not lifted and carries no pin flag; flag bit 3 on a session slot means a session pin. A chosen pinned task in SPLIT
  still shows every live session of the task.
- **PINNED scope / PIN filter** list every session pin (all repos, all tiers), need-you first, across as many pages as
  needed (27 keys a page in RANKED, 16 white keys in SPLIT). Grouped PINNED adds one folded row per pinned task after the
  session pins, so every pin can be seen and unpinned; Buddy and List PINNED show session pins only.
- **Frozen layout unchanged (§3.4):** pins only change the order a re-sort computes. Between re-sorts keys never move; a
  pinned session that starts to need you keeps its key until the next re-sort (which keeps it in the pinned part). Pinning or unpinning re-sorts (an explicit
  act on the layout).
- **Persistence:** the companion config holds `sessionPins: string[]` (5-part session keys) and `taskPins: string[]`
  (4-part task keys), each ≤ 200, each written only when not empty. A legacy `pins: string[]` (one mixed list) is still
  read and split by key shape with every pin kept; it is never written again. An older companion refuses the new keys, so
  a config with pins saved by this companion needs this companion or later.
- **Pins outside the adapter's scan** are fetched in batches of at most 25 tasks at a slow cadence (one batch at each
  resync, then every 5 s until each has been asked for once, then every 120 s round robin;
  docs/traycer-integration.md). A pin is dropped only when Traycer reports its session or task deleted or archived;
  without `fetchPinned` (the mock) a pin missing after a full snapshot is dropped.

History (superseded): 2026-11-18 (docs/ui-v3.md §9.6) at most 9 pins, session and task pins together (`Pins full (9)`),
pinned tasks expanded after the Pinned group; the first version (below) at most 6 session pins in pin order on keys 0…p−1.

- Key long press in Sessions or TO DO toggles a pin on that session. The toast is `Pinned` / `Unpinned`; when full,
  `Pins full (6)`.
- Pins are session keys, persisted in the companion config (`pins: string[]`, ≤ 6, validated). A pin whose session
  has left Traycer is dropped at the next snapshot.
- Pinned sessions are shown first on page 1 in every Sessions scope (ignoring SHOW, respecting REPO and TASK) and
  carry slot flag bit 3. The firmware draws the bar from §2.4.
- Pinning re-sorts (it is an explicit act on the layout).

### 3.6 What GLO becomes: TO DO

- GLO opens **TO DO**: one item per attention condition across **all** repos and tasks (it ignores REPO, TASK and
  SHOW). It shows T0, T1, T2, T3 in tier order, then T6 ("older").
- The badge (`SET_STATUS.attention_count`) and the GLO LED blink count only T0–T3 items that are unread and not
  dismissed: 16 for the measured 279, against 33 today.
- **Dismiss** (FX on a non-approval item) hides that occurrence locally. It is like `markRead`: per occurrence id,
  it never touches Traycer, and a new failure or result of the same session comes back. Selecting a completed item
  still marks it read (existing behaviour).
- **Dismiss takes effect at once** (operator report 2026-11-18: the item kept its key until the next re-sort, so
  nothing on screen changed). The dismissed item's key empties immediately; every other key stays where it is (the
  frozen layout of §3.4 is not re-sorted). The title count and the badge are recomputed in the same view update. The
  cursor moves to the next item still in TO DO in key order (wrapping; none left: no selection), which is then shown
  and so marked read like a SELECT move. Toast `Dismissed, FX undo`.
- **Undo:** FX again within 3 s (`DISMISS_UNDO_MS`) restores the item to the key it held (the first free key of
  page 1 if that key was taken meanwhile), selects it, and toasts `Restored`. Any input other than FX ends the undo
  window; FX after 3 s acts on the item under the cursor (dismisses the next one). So repeated FX clears a list when
  the presses are more than 3 s apart; two quick presses undo. If the dismissed item changed (a new occurrence has a
  new id) or left within the window, FX there toasts `Nothing to undo` and dismisses nothing; the window then ends.
  Approvals are unchanged (FX = deny with a confirm).
  The device has no fade for the emptied key (it is drawn empty at once).
- Slot labels are the session's `titleSplit().head`. The approval summary (today's label, `before/14`) moves to
  line3 with its age.
- The layout freezes as in §3.4. The re-sort trigger is GLO pressed in TO DO.
- Title: `TO DO 16`, or `TO DO 16 +2 new`.

### 3.7 Selection, focus and voice targets

- Selection is by identity (`registry.select`), as today. TALK `reply` sends to the selected session. `Claude chat`
  / `Codex chat` create a chat in the TASK filter, else the selected task cursor, else the selected session's task.
  `Claude task` / `Codex task` create a task in the REPO filter, else the selected session's repo (existing
  `destinationFor` rules, with `voiceMode` + `provider` merged into one `talk` value).
- The v1 KNOB1 voice mode and KNOB2 provider are replaced by KNOB4 TALK.

---

## 4. Protocol

The wire format stays FM1C v1: framing, message types, bodies, limits, ACKs, vectors. There are no new messages, and
no field grows. What changes is how the device draws existing fields. Old and new screens must not be mixed silently, so
the negotiated version number becomes 2 as a **rendering marker**:

| | Device (firmware) | Host (companion) |
| --- | --- | --- |
| Constants | `FM1C_PROTO_MIN 1`, `FM1C_PROTO_MAX 2` | `PROTOCOL_VERSION 2`, `HOST_VERSIONS = { min: 1, max: 2 }` |
| Negotiation | unchanged (`negotiate()` picks the highest common version) | unchanged |
| Version 1 agreed | The legend, line 4 and the strip are drawn as today. The v2 wording of §1.2 is used (firmware-owned copy). | Sends the v2 content anyway: knob labels and the hint line. An old firmware shows them as plain text (tolerable). |
| Version 2 agreed | §2.4 rendering, §2.5 help overlay, pinned marks | v2 content |

Meaning of version 2: "`SET_LEGEND` labels are KNOB1–KNOB4 only; `SET_DETAIL.line4` in base and voice views is a
hint line; in the voice view `SET_DETAIL.line1–2` are drawn outside recording/transcribing; slot flag bit 3 is
drawn; the device has a local help overlay on SCL hold". `docs/protocol.md` §3 "Version negotiation" and §4
`SET_LEGEND` / `SET_DETAIL` get these sentences. `fixtures/device/vectors.json` gains negotiation cases only:
device 1–2 / host 1–2 → 2; device 1–1 / host 1–2 → 1; device 1–2 / host 1–1 → 1.

---

## 5. Implementation split

Two implementers work in parallel. The only shared contracts are this document's strings and the version rule in §4.

### 5.1 Implementer A: `packages/agent-core`, `packages/device-protocol`, `packages/agent-adapter-traycer`, `apps/companion`

| File | Change |
| --- | --- |
| `packages/agent-core/src/types.ts` | `Session.lastActivityAt?: number` (ms since epoch) |
| `packages/agent-core/src/validate.ts` | `parseSession` accepts an optional finite `lastActivityAt` ≥ 0 and rejects anything else |
| **new** `packages/agent-core/src/copy.ts` | `STATE_WORDS` (line text per state), `ageText(ms)`, `cutWords(s, n)`, `titleSplit(title) → { head, rest: [string, string] }`, `whatText(entry, item?, now)`, `hintLine(pairs: [button, verb][]) → string`, `toastFor(stage, message?)`, `resultReason(message)`, `TALK_LABEL`, `SCOPE_LABEL`. Every string in §1.3–§1.5 lives here. |
| **new** `packages/agent-core/src/focus.ts` | `Tier`, `tierOf(entry, inbox, now, dismissed)`, `compareFocus(a, b)`, `scopeMembers(state, world, now)`, class `FocusLayout { relayout(keys, pins); place(arrivals); page(n); pageCount(); pendingNew; keys() }` with the §3.4 rules (reserved keys 24–26 on page 1), `RESULT_WINDOW_MS`, `RECENT_WINDOW_MS`, `AUTO_RESORT_MS = 60_000`, `MAX_PINS = 6` |
| **new** `packages/agent-core/src/control-map.ts` | `HELP_TEXT: { base: string[]; voice: string[]; confirm: string[] }`, exactly §2.5 |
| `packages/agent-core/src/context.ts` | `ControllerState`: add `scope: "active" \| "recent" \| "all"`, `repoFilter` (renames `projectId`), `talk: "reply" \| "claude-chat" \| "codex-chat" \| "claude-task" \| "codex-task"` (replaces `voiceMode` + `provider`), `pins: string[]`, `dismissed: string[]`, `lastInputAt: number`. `sessionLayout`, `sessionPage`, `inboxPage`, `taskPage` and `pageCount` read the frozen `FocusLayout`s. `destinationFor` maps `talk` to the existing `Destination`. |
| `packages/agent-core/src/controller.ts` | Rebind as in §2.3. `onEncoder`: SELECT move, ALGORITHM `jumpAttention(dir)`, PRESETS `detailScroll`, K1 scope, K2 repo, K3 task, K4 talk. `onButtonDown`: PLAY focus in sessions/inbox, new chat in tasks, retry in voice; HOME/EDIT/GLO re-sort when already in that view; FX dismiss in inbox on non-approval items. `onKey`: long press pin toggle; remove `showOptions`. New action types `pin`, `unpin`, `dismiss`, `resort`. Remove `onK3`, `cycleMode` and the K4 interrupt. |
| `packages/agent-core/src/inbox.ts` | `dismiss(id)` with the same lifetime as `readIds`. `attentionCount(now)` = T0–T3 unread and not dismissed. Items carry their tier. The sort follows §3.2. |
| `packages/agent-core/src/view.ts` | `titleFor`, `detailFor`, `legendFor`, `slotFor` per §1.3 and §2.3. Remove `optionLines` and `MODE_LABEL`. `SlotView.pinned`. Voice detail per §2.4. No `"--"` anywhere. `status.text` = `Traycer offline` / `Traycer limited` / `""`. |
| `packages/agent-core/src/console.ts` | `tick(now)` (auto re-sort and arrivals placement), `lastInputAt` stamping in `handleInput`, an `onPinsChanged` callback, and `pins` passed into the constructor |
| `packages/agent-core/src/controls.ts` | none (ids unchanged) |
| `packages/device-protocol/src/constants.ts`, `negotiate.ts` | `PROTOCOL_VERSION = 2`, `HOST_VERSIONS = { min: 1, max: 2 }` |
| `fixtures/device/vectors.json` + `packages/device-protocol/src/vectors.ts` | The 3 negotiation cases from §4 |
| `packages/agent-adapter-traycer/src/agent/mapping.ts` (`toSession`) and `session-book.ts` | `lastActivityAt = max(agent.updatedAt, outcome?.at ?? 0, agent.createdAt)` |
| `apps/companion/src/device/render.ts` | `slotFrame` sets `flags.pinned` from `SlotView.pinned` |
| `apps/companion/src/feedback.ts` | Uses `toastFor` and the §1.5 table. No toast for select / markRead / view switch / confirm opened / voiceStart / voiceStop. |
| `apps/companion/src/stage-relay.ts` | Its labels come from `toastFor` |
| `apps/companion/src/config.ts` | `pins: string[]` (≤ 6 strings, default `[]`), validated in `mergeConfig` |
| `apps/companion/src/companion.ts` | Passes the pins from the config, saves on `onPinsChanged`, and calls `console.tick(Date.now())` every 5 s |
| `docs/protocol.md` | The §4 text |

Tests A must add (bun test):

1. `copy.test.ts`
   - `ageText` boundaries (59 s, 60 s, 59 m, 47 h, 13 d, 14 d).
   - `titleSplit` on: a 13-character title, a 55-character title, a first word longer than 12, non-ASCII input.
   - `hintLine`: two spaces → one space → drop the last pair, every output ≤ 20.
   - Every `toastFor` / `resultReason` row of §1.5.
   - Property: every string the copy produces is ≤ its limit and ASCII 0x20–0x7E.
2. `focus.test.ts`
   - Every tier rule and window edge (72 h ± 1 ms, 8 h ± 1 ms). Tie-break by `sessionKey`.
   - A 279-session fixture with the measured mix gives ACTIVE 20 / RECENT 42 / ALL 279 (build it from
     `session-stats.json` counts with synthetic ids).
   - Pins first, at most 6. Keys 24–26 empty after `relayout`.
   - An arrival fills 24 → 26, then `pendingNew` grows. A state change never moves a key.
   - Paging never re-sorts.
3. `controller.test.ts` additions
   - A knob turn never produces a `focus`, `interrupt`, `approve`, `deny` or `createSession` action (all four
     knobs, all views).
   - PLAY focuses in sessions/inbox. Key long press pins.
   - HOME in sessions re-sorts and goes to page 1. EDIT/GLO likewise.
   - ALGORITHM jumps across pages to the next T0–T3.
   - FX on a non-approval TO DO item dismisses it, and a new occurrence reappears.
4. `view.test.ts`
   - The legend table of §2.3 exactly per context.
   - No `"--"` and no `_` in any title, line or legend.
   - The voice view's line1–2 carry the transcript and line4 the hint.
   - The title formats `ACTIVE 20`, `ACTIVE 20 +2 new`, `TO DO 16`.
5. `control-map.test.ts`: reads `firmware/firmware/src/fm1c_help.h`, extracts the string literals of
   `FM1C_HELP_BASE` / `_VOICE` / `_CONFIRM`, and requires deep equality with `HELP_TEXT`. Every line is ≤ 29.
6. `apps/companion` units: `feedback.ts` produces no toast for select/view switch. `config.ts` rejects 7 pins and
   non-strings. The pins round-trip.
7. `device-protocol`: the 3 negotiation vectors.

### 5.2 Implementer B: `firmware/firmware/src/console.c`, `fm1c_*.h`, `packages/device-simulator`

Upstream Dinghy files stay byte-identical: no change to `platform.c`, `usb.c`, `ota.c`, `recovery.c`, `hal/` or
`gfx.c` beyond the documented patch.

| File | Change |
| --- | --- |
| `fm1c_proto.h` / `fm1c_link.h` | `FM1C_PROTO_MAX 2`. Store the agreed version in the model (`m->proto`) on HELLO_ACK; clear it on host loss. |
| `fm1c_model.h` | Fields `proto` and `help` (0/1). Mark dirty on `proto` change. The per-key dirty bit keeps its meaning, but the redraw rectangle comes from the key's box (§2.4). Mark the pinned flag changes. |
| `fm1c_draw.h` | §1.2 string tables (`FM1C_STATE_NAME`, `FM1C_PROVIDER_NAME` with none = no chip, `FM1C_VOICE_NAME`, `FM1C_RESULT_NAME`, link labels, banner texts, `nothing selected`, `(untitled)`, `to `, `(no target)`). The ok-dot. With `proto == 2`: `fm1c_draw_legend` tags, the hint bar in band 5, the voice band rules, the keyboard strip (`fm1c_key_box(k, &x, &y, &w, &h)`, `fm1c_cell` / `fm1c_draw_key` / `fm1c_draw_strip` rewritten on it), the pinned bar, and the confirm chip as hint text. |
| **new** `fm1c_help.h` | `static const char *const FM1C_HELP_BASE[11]`, `FM1C_HELP_VOICE[7]`, `FM1C_HELP_CONFIRM[4]` (exact §2.5 text, one literal per line), `fm1c_draw_help(const fm1c_model *m)` |
| `console.c` | SCL hold timer: on SCL down note `fm1_ms`; at +400 ms with SCL still down and `proto == 2`, set `help = 1` and draw. On SCL up, `help = 0` and mark all regions dirty. While `help`, suppress KEY/BUTTON(≠SCL)/ENCODER/POT frames and skip normal drawing (the model still updates). |
| `fm1c_led.h` | No pattern change. Pinned has no LED meaning. |
| `packages/device-simulator/src/layout.ts` (+ `state.ts` if needed) | Mirror the §1.2 strings, the §2.4 legend tags, the hint bar and the keyboard strip, so the simulator matches the firmware (`docs/firmware-ui.md` promises this) |
| `docs/firmware-ui.md`, `docs/firmware-controls.md` | Update to §1.2, §2.3–§2.5 |

Tests B must add:

1. `tests/console/model_test.c`
   - A slot change with `proto 2` dirties only that key. `fm1c_key_box` returns the §2.4 boxes for keys 0, 1, 26
     and all 27 boxes are disjoint.
   - The pinned flag change dirties the key.
   - Help on/off marks every region dirty on close.
2. `tests/console/input_test.c`: SCL held 399 ms gives no help; 400 ms gives help. While help is shown, keys,
   encoders and other buttons emit no frames. SCL still emits down/up.
3. `tests/console/scenario/scenarios.ts`, new scenarios (host and emulator), each with screenshots in
   `reports/evidence/firmware-host/` and `reports/evidence/emu/`:
   - `v2-sessions` (HELLO_ACK proto 2: legend with KNOB tags, hint bar, keyboard strip, a pinned key, the ok-dot)
   - `v2-help-base`, `v2-help-voice`, `v2-help-confirm`
   - `v2-voice-reviewing` (transcript lines and the hint)
   - `v2-confirm`
   - `v1-compat` (HELLO_ACK proto 1: legend/strip/line4 drawn as today)
   - `nohost-v2-words` (`NO COMPANION`, `start fm1-console on Mac`)
4. Update the existing "one slot change redraws one 8 × 64 cell" check: with proto 1 it stays 512 px; with proto 2
   it is 476 px for a white key and 360 px for a black key. Add both.
5. `compare_shots.py`: host and emulator stay byte-identical (RGB565) for every new shared screen.
6. `firmware/tests/run_tests.sh` and `tests/ble/run.sh` stay green (the BLE build compiles the same draw code).

### 5.3 Acceptance criteria

1. No device-visible string contains `_`, `--`, `=`, `->` or a one-letter button code (`S:`, `F:`, `R:`, `P:`).
   Checked by the A view tests and a B scan of `fm1c_draw.h` / `fm1c_help.h` literals.
2. With proto 2, every non-empty legend cell shows `KNOBn` above its label. No knob turn starts an action
   (A controller test).
3. Every base-view selection shows a hint line naming the buttons for the possible actions. Holding SCL shows the
   §2.5 text, byte-equal to agent-core `HELP_TEXT`.
4. On the measured mix (279), Sessions opens in ACTIVE with 20 sessions on one page. RECENT gives 42 on 2 pages.
   The TO DO badge reads 16 (today: 33).
5. A state change or a new attention item never moves an existing key between re-sorts. New attention items land on
   keys 24–26 or raise ` +N new`.
6. With proto 1 (old companion), the firmware still draws a usable screen: the legend, line 4 and the strip as
   today. With an old firmware (max 1), the new companion still connects (negotiates 1).
7. Test counts at least: agent-core 90 → ≥ 90 + the new tests, all passing. Firmware console host and emulator
   suites passing with the new scenarios. `tests/run_tests.sh` and the BLE suite unchanged and passing.
8. Read-only Traycer use is unchanged. Pins, dismiss and read state are local and never call Traycer.

## 6. Open points

- **Silkscreen check.** The button names come from fm1-emu and Felucca (`FX SCL ENV LFO EDIT GLO / HOME SAVE ARP
  SEQ PLAY REC`, `KNOB1–4`). The Agent Deck photo shows other labels. Before the strings ship, the operator should
  confirm the printed names on the unit. They appear only in `copy.ts`, `control-map.ts`/`fm1c_help.h` and the
  legend tag, so a correction is a one-table edit.
- **Help needs proto 2.** With an old companion the help overlay is off, because its text would describe controls
  the old companion does not implement.
- **Terminal agents.** 115 `unknown` and 65 inferred `idle` terminals have no turn signal. They fall into T5/T7 by
  age, and the design cannot make them actionable without upstream signals.
- **`sessionScanLimit` 25** is why the operator sees 279 of the 433 listed sessions. The design keeps the limit (ALL = 279). Raising it
  adds 154 sessions, almost all in T7.
- **Sizes are from one probe** (2026-11-18, no pending approvals or questions). Re-run
  `reports/evidence/ux-v2/scripts/session-stats.ts` to refresh them.

---

## 7. Session details

Date: 2026-11-18. Status: spec (final; firmware and host implement it in parallel). Operator feedback: "can I get any
details on task besides main overview?". Before this section the selected chat showed only its title, its task title
and `<age> <state word>`: the Traycer adapter never set `session.summary`.

Three parts: richer data from the adapter (§7.1), better use of the existing detail lines (§7.2), and a new
full-screen **DETAILS page** (§7.3–§7.6) that needs protocol version 3 (`docs/protocol.md`).

### 7.1 Data (host only: adapter and agent-core)

The adapter already subscribes to the chat stream (`chat.subscribe`) of the selected and watched chats. From that
stream it derives, per chat, `Session.details` (all optional, all ASCII after folding, read only):

| Field | Source in the chat stream | Limit |
| --- | --- | --- |
| `lastMessage`, `lastMessageAt` | text of the last assistant message (markdown stripped to plain text, whitespace collapsed) | 600 chars |
| `lastBlocks` | the same message's Markdown structure (docs/ui-v3.md section 13): headings, lists, code, tables, quotes with inline bold/code; the bubble and this page lay it out instead of wrapping `lastMessage` | 2000 source chars, 96 rows |
| `activity` | the tool call in progress in the running turn, as a verb + target: `editing view.ts`, `reading copy.ts`, `running bun test`, `searching "titleSplit"`, `thinking` | 60 |
| `failure` | the error text of a failed turn | 200 |
| `approval` | the pending approval: `target` (the command, or the file path) and `summary` | 200 / 200 |
| `contextPct` | context window usage of the last `usage.updated` block delta, 0–100 | — |
| `model` | the model of the last turn, short form (`opus-4.5`, `gpt-5-codex`) | 24 |
| `turns` | number of turns in the chat | — |
| `files` | files changed in the last turn: `count` and the first 3 base names | 3 × 40 |

It also sets `Session.lastActivityAt` from the newest turn or activity time it has seen (it was the agent record's
`updatedAt` only, which is why RECENT showed 23 instead of 43 in one probe), and `Session.summary` to the best
one-liner: `activity` while working, `failure` when failed, the approval summary when an approval is pending, else
the head of `lastMessage`. Details exist only for chats whose stream is open; others keep the list data.

### 7.2 Detail lines in the base views (every protocol version)

- Line 3 stays `<age> <what>` (§1.4 rule 5). `what` now gets the adapter's summary, so it reads e.g.
  `2m editing view.ts`, `1h Tests failed: 3`, `5m Done. All 412 pass` instead of `2m working`.
- **PRESETS** (turn) scrolls a longer text in lines 1–3, 20 characters wide: the rest of the title, the task, line 3,
  then the last message wrapped, then `Now: <activity>`, `Context 42%`, `Model opus-4.5`, `Files 3: view.ts ...`.
  Turning back to 0 shows the normal lines again. Nothing changes on the wire.

### 7.3 DETAILS page: controls (protocol version 3 only)

| Control | Base views (Sessions, TO DO) | DETAILS page |
| --- | --- | --- |
| **LFO** (button 5) press | open DETAILS for the selected chat, page 1. Nothing selected: toast `Select a chat first`. In Tasks: nothing (no chat). | close DETAILS, back to the view it was opened from |
| HOME | Sessions (as §2.3) | close DETAILS, back to the view it was opened from |
| EDIT / GLO | as §2.3 | close DETAILS and go to Tasks / TO DO |
| PRESETS turn | scroll lines 1–3 (§7.2) | next / previous page (clamped, no wrap) |
| OCT− / OCT+ | page | previous / next page |
| SELECT turn | move | move the selection in the list below; DETAILS shows the new chat from page 1 |
| ALGORITHM turn | next needing you | same, DETAILS follows the selection |
| key tap / 2x / hold | select / open on Mac / pin | same (the selected chat's DETAILS is shown) |
| SAVE / FX / ENV / PLAY / REC | as §2.3 | as §2.3 for the shown chat; the confirm and voice views return to DETAILS when they close |
| KNOB1–4 | as §2.3 | nothing (legend empty) |
| SCL hold | help (base text) | help (DETAILS text, §7.6) |

With version 1 or 2 agreed, LFO stays unused and the host never sends view 5 or `SET_TEXT`.

The firmware sends LFO's `BUTTON` edges in every view, as today. The host decides; the device only draws what
`SET_VIEW` / `SET_TEXT` say. Button LED: **LFO full while the view is DETAILS** (like HOME/EDIT/GLO for their views),
else off.

### 7.4 DETAILS page: screen (firmware, version 3)

`SET_VIEW.view = 5` (`detail`). The screen:

| Rows | Contents |
| --- | --- |
| 0–23 | Status bar as in every view: `SET_VIEW.title` (e.g. `DETAILS fm1 console`), page `page+1/pages` when `pages` > 1, link, badge. |
| 24–215 | 12 text rows from `SET_TEXT`, row n at y = 24 + 16n, `FONT_S` at x = 4, black background. Colour by the row's style: 0 `body` white #FFFFFF, 1 `heading` amber #FFB000, 2 `muted` #A0A0A0. Text is ≤ 29 characters (232 px). |
| 216–239 | Hint band: fill #202020, the fixed firmware text `PRESETS page  LFO close` in `FONT_S` at x = 4, y = 220, with the hint-bar token colours of §2.4 (control names white, other words #A0A0A0). A `COMMAND_RESULT` toast replaces this band (same colours and durations as the line-4 toast, text at y = 220). |

- The key strip and the legend are **not drawn** in this view. The panel bands (head chip, label, lines 1–4) are not
  drawn either; `SET_DETAIL`, `SET_SLOT` and `SET_LEGEND` still update the model and draw when the view changes back.
- `SET_TEXT` is stored in every view (a 12-row buffer of style + text) and drawn only in DETAILS. A changed row
  redraws only that row (240 × 16). A repeat marks nothing.
- Entering or leaving view 5 redraws everything below the status bar.
- Help overlay (SCL hold) in DETAILS covers rows 24–215 and shows `FM1C_HELP_DETAIL` (§7.6).
- A HELLO_ACK with a new `host_session` clears the 12 rows to empty `body`.
- Every check written `proto == 2` for the v2 layout becomes `proto >= 2`: version 3 includes all of version 2.

### 7.5 DETAILS page: content (host)

agent-core `detailPages(entry, world)` builds rows of `{style, text ≤ 29}`, wrapped on word boundaries (§1.4 rule 3)
at 29, in this order, and cuts them into pages of 12 rows (at most 8 pages; page 1 always starts at the top):

1. heading: `<STATE CHIP WORDS>, <age>`, e.g. `NEEDS APPROVAL, 12m`, `WORKING, now`, `FAILED, 3h (guess)` when inferred,
   `GONE FROM TRAYCER` when stale.
2. body: the full title (≤ 2 rows).
3. muted: `Task: <task title>` (≤ 2 rows).
4. by state, body: approval → `Approve: <target>` (≤ 4 rows) and the approval summary (≤ 3 rows); failed →
   `Error: <failure>` (≤ 4 rows); working → `Now: <activity>` (≤ 2 rows); waiting_input → nothing here (the
   question is the last message, item 6).
5. muted facts, one row each, only when known: `<Provider> <model>` (e.g. `Claude opus-4.5`), `Context 42%  turns 12`,
   `Files 3: view.ts, copy.ts` (cut at 29).
6. heading `Last message <age>`, then the last message wrapped (body), to its end.

With no details known (stream not open, terminal chats) the page holds 1–3 and a muted row `No chat details yet`.
`SET_VIEW.title` = `DETAILS ` + the title head (§1.4 rule 4), clipped to 20.

Frames when DETAILS opens or the page changes: `SET_VIEW` (view 5, page, pages, title), then `SET_TEXT` for rows 0–2,
3–5, 6–8, 9–11 (four frames; unchanged groups are skipped by the host's per-element diff), `SET_LEGEND` all empty.
The resync after HELLO_ACK in view 5 sends all four `SET_TEXT` frames.

### 7.6 Help text (version 3)

`FM1C_HELP_BASE` changes in two lines (it still has 11 lines; lines 7 and 9). agent-core `HELP_TEXT.base` is the same:

```
HELP - let go of SCL
key tap   select / open task
key 2x    open on Mac
key hold  pin or unpin
SELECT move  PRESETS scroll
ALGORITHM next needing you
OCT-/OCT+ page  LFO details
SAVE approve  FX deny/dismiss
PLAY open/new chat  ENV stop
REC hold to talk  HOME sort
EDIT tasks  GLO to do
```

New `static const char *const FM1C_HELP_DETAIL[10]` (agent-core `HELP_TEXT.detail`), shown in view 5:

```
HELP - let go of SCL
PRESETS   next/prev page
OCT-/OCT+ next/prev page
SELECT    next/prev chat
ALGORITHM next needing you
key tap   show that chat
LFO/HOME  close details
SAVE approve  FX deny
ENV stop  PLAY open on Mac
REC hold to talk
```

`FM1C_HELP_VOICE` and `FM1C_HELP_CONFIRM` are unchanged. `test/control-map.test.ts` compares all four tables with
`fm1c_help.h` (one literal per line, as today).

### 7.7 Implementation split

| Owner | Files |
| --- | --- |
| Host | `packages/agent-adapter-traycer` (details from the chat stream, `summary`, `lastActivityAt`), `packages/agent-core` (`SessionDetails`, `detailPages`, PRESETS text, DETAILS view state and controls, `HELP_TEXT`), `packages/device-protocol` (`SET_TEXT`, view `detail`, `PROTOCOL_VERSION 3`, vectors), `apps/companion` (render `SET_TEXT`, proto gate), `packages/device-simulator` (draws view 5) |
| Firmware | `fm1c_proto.h` (`FM1C_T_SET_TEXT 0x4C`, `FM1C_VIEW_DETAIL 5`, `FM1C_PROTO_MAX 3`), `fm1c_model.h` (12-row text buffer, dirty bits, `proto >= 2`), `fm1c_draw.h` (view 5, hint band, toast position), `fm1c_help.h` (§7.6), `fm1c_led.h` (LFO LED), `gen_vectors.py` (`SET_TEXT`, view `detail`) and the console tests |
