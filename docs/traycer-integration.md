# Traycer integration: answer to the priority update (new-spec-2)

Date: 2026-11-17. Traycer CLI, host and Desktop are all 1.5.4. Protocol is vendored from tag `host-v1.5.4` (`b7a5f5ca`).

This document gives the final verdicts on the priority update. It is based on:
- `docs/discovery/traycer.md` (code discovery and reviewer pass);
- `docs/discovery/traycer-focus.md` (how focus works, and the deep-link proposal);
- `reports/traycer-smoke.md` and `reports/traycer-capabilities.json` (live send, create and stop);
- `reports/traycer-focus-test.md` (live focus tests);
- an adversarial verification pass, recorded in the last section.

Definitions:
- **Public:** the documented CLI (<https://docs.traycer.ai/cli/commands>), or the public MIT protocol (`@traycer/protocol` plus `clients/shared`) as first-party clients (Desktop, gui-app, CLI) use it.
- **Undocumented but present:** behaviour that the shipped 1.5.4 build has but no doc describes.
- **Requires upstream change:** needs new code in Traycer itself.

---

## Verdict 1: prompt submission to an existing chat

**The public MIT protocol supports it, for Chat-interface (GUI) agents. The documented CLI does not support it. We had to write new integration code on our side (done: `packages/agent-adapter-traycer`). Traycer needs no change. Since 2026-11-19, console prompts to Claude and Codex terminal (TUI) agents are typed into the agent's Traycer terminal and arrive as a normal user message (see "Terminal (TUI) agents: prompts typed into the terminal" below); Claude terminals fall back to Traycer a2a when nothing could be typed. Other terminal agents take no prompts.**

| Route | Public? | Works? | Evidence |
|---|---|---|---|
| Documented CLI | Docs and `traycer --help` 1.5.4: no command submits a **user** turn to an existing chat. `task create` sends only the first message of a **new** Task. `agent send` is agent-to-agent: it needs `TRAYCER_AGENT_ID`/`TRAYCER_EPIC_ID` and is recorded with an agent sender. | No | WebFetch of the docs page, and live `traycer --help` / `agent --help` |
| Host WS protocol, `chat.subscribe` client frame `kind:"send"` with `sender:{type:"user"}` | Public MIT protocol. It is the exact frame the Desktop composer sends (`ChatStreamClient.sendAction`). The wire protocol has no prose docs: the docs say only that the CLI reads connection details from `host/`. | **Yes, verified live** | T2 (claude/haiku), T3 (codex/gpt-5.6-luna) and the focus acceptance send. Each got one `actionAck{send, accepted}` and one `messageAccepted`, and the turn went `starting → running → completed`. Every marker appears **exactly once**, in exactly one chat (re-checked in this pass, see below). |
| TUI agent (Claude, Codex), primary since 2026-11-19 | `terminal.subscribe` (`viewer:"cache"`) `write`: bracketed paste, then Enter, only at the idle input prompt | **Yes, verified live on Claude** (2026-11-19); Codex by pattern only | `reports/evidence/tui-typing/smoke-2026-11-19.json` |
| TUI agent (Claude), fallback | `agent.sendMessage` (Traycer a2a) as a sender agent in the receiver's task | **Yes, verified live** (2026-11-18, and as the fallback 2026-11-19) | `reports/evidence/tui-a2a/`, smoke TUI-A2A PASS |

What the integration code has to do (all done in the adapter):
1. Read `~/.traycer/host/pid.json` and check that the pid is the same process.
2. Read the bearer from `~/.traycer/cli/credentials` and keep it in memory only. On `UNAUTHORIZED`, run `traycer whoami --json` and re-read the file.
3. Negotiate per-method manifests on `open`/`openAck` using the vendored `WsRpcClient`/`WsStreamClient`.
4. Copy the chat's run settings from `epic.getChatRunSettings`.
5. Send with `sentFromHostId`, `accountContext:{type:"PERSONAL"}`, `deliveryPolicy:"auto"` and `browserAnnotations:[]`.
6. Correlate the turn by `activeTurn.userMessageId`. Do not use `turnId`, because it is re-minted mid-turn.

Caveats:
- The host source is closed. Authorization rules come from observed behaviour only.
- Future host updates may raise method minors. The vendored manifest must then be re-checked, because a major bump returns `INCOMPATIBLE`.

## Verdict 2: session focus from an external process

**Level (a) works today through OS-level public means. Levels (b) and (c) require an upstream Traycer Desktop change. No public or undocumented external entry point selects a chat. The proposed change is [`docs/upstream/traycer-deep-link.diff`](upstream/traycer-deep-link.diff).**

| Level | Verdict | Pathway | Evidence |
|---|---|---|---|
| (a) Traycer window to front | **Supported, public (OS)** | `open -a Traycer` or AppleScript `activate`. Any `traycer://…` URL also does it (undocumented but present: LaunchServices activates the app, then Electron ignores the URL). | Live T1, T2, T3: Finder, then Traycer frontmost |
| (b) Correct epic and chat tile selected | **Requires upstream change** | None today. In 1.5.4 the `traycer://` handler acts only on `auth/callback`. I confirmed this in the installed `app.asar` `dist/main/index.js`: `deliver()` returns unless `isAuthCallbackUri`. No CLI command and no host RPC tells Desktop to navigate: presence frames go from Desktop to host only. The only built-in route to an exact tile is the native notification click, which needs a real host event, all Traycer windows unfocused, and a **human click**. | Live T3: the log line `[deep-link] open-url … 21:02:07.926` is followed by nothing, and the screenshot shows the tile unchanged (I re-checked it). Source and asar read. |
| (c) Keyboard focus in that chat's composer | **Requires upstream change (b first); not yet verified** | Expected as a side effect of (b): `composer-prompt-editor.tsx` autofocuses when the composer becomes active. Read from code only. | Live check BLOCKED: `osascript` has no Accessibility permission (`-1728`). T5/T6 not run. |

Proposed upstream change (not applied anywhere):
- Handle `traycer://open/epic/<epicId>/chat/<chatId>[?focus=composer]` in the Desktop main process.
- Replay the link as a legacy `{kind:"chat", epicId, chatId}` notification click. This reuses `deliverNotificationClick`, then `findWindowIdForOpenChat` or owner/MRU, then the renderer's `NotificationFocusBridge`, then `routeEpicChatNotification`.
- The patch touches 4 files, including tests, and makes no renderer, preload or IPC-contract changes. Ids must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. The link can only navigate: it cannot send, approve or stop anything.
- Verified in this pass: `git apply --check` passes on `desktop-v1.5.4` (`b7a5f5ca`) and on `main` (`2937e711`). The payload shape matches gui-app's `ChatNotificationPayload` (`epicId`, `chatId`). The bridge routes legacy payloads with `feedId:null`, and `chat` is not origin-host-gated.
- Verified 2026-11-18: the patch applies cleanly in a fresh worktree at `desktop-v1.5.4`. Its vitest suites pass: `deep-link.test.ts` 12/12, which includes 1 side-by-side test; `notification-target.test.ts` + `desktop-startup.test.ts` 40/40. Two neighbouring suites (`host-quit-bridge`, `desktop-startup-none-mode`) fail to load on the unpatched tag too, with vite error `node:sqlite`. That failure is not caused by the patch.
- **Not verified:** no patched build has been launched yet. The live tile and composer test is for the orchestrator (see below).

### Patched side-by-side build ("Traycer FM1.app")

| Item | Value |
|---|---|
| App | `/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched/out/Traycer FM1.app` (unsigned, ad-hoc, arm64, 615 MB) |
| Source | `git worktree` of `desktop-v1.5.4` (`b7a5f5ca`) at `/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched`. Full diff: `out/fm1-build.diff`. Rebuild: `./fm1-build.sh`. |
| Identity | `CFBundleIdentifier` `ai.traycer.desktop.fm1`, bundle and executable name `Traycer FM1`, version 1.5.4, Electron 42.11.12, the same version as the installed app. |
| Data | Baked `environment:"production"`, `appName:"Traycer"` and `protocolScheme:"traycer"`. The asar `package.json` keeps `productName:"Traycer"`, so Electron's userData is `~/Library/Application Support/Traycer` and the single-instance lock is the same as the installed app's. The app uses the same `~/.traycer` host, CLI and credentials. The bundled CLI is a byte-identical copy of the installed 1.5.4 CLI (sha256 `eef1755a…`). |
| Scheme | `Info.plist` declares `traycer`, but the main process skips `setAsDefaultProtocolClient`: build define `TRAYCER_FM1_SIDE_BY_SIDE=1`, an FM-1 addition to `deep-link.ts`. The default handler stays `ai.traycer.desktop`; checked with `LSCopyDefaultHandlerForURLScheme` before and after the build. Links reach the patched app only through `open -a "<app>" <url>`. |
| Storage key | Packaged renderers refuse to start without `VITE_DESKTOP_LOCAL_STORAGE_KEY` (empty windows, 2026-11-23). The build uses the installed app's own key (it encrypts the login tokens in the shared userData; a different key would log one app out on every switch). `fm1-build.sh` reads it from `.fm1-ls-key` (0600, git-excluded, extracted from `/Applications/Traycer.app/Contents/Resources/renderer`), never echoes it; rebuilt 2026-11-23, key absent from the build log. |
| Updates | The `--dir` build has no `app-update.yml`, so `canCheckForUpdates` is false. There is no auto-update and no "move to Applications" prompt. `publish` is null. |
| Host lifecycle | The host-lifecycle code is the same as in the installed app. The in-bundle LaunchAgent plist uses the same label, `ai.traycer.host.agent`. The helper has its own id, `ai.traycer.desktop.fm1.host`. With a healthy host at 1.5.4, launch is a no-op: `host ensure --keep-installed --no-service-register` returns `noop`, and `substrate.json` already exists. If the host is down or needs repair while the patched app runs, its SMAppService register cycle would point the login item at the patched bundle. In that case, reopen Traycer.app afterwards so it re-registers. |

The adapter sends the link to this app when the config sets `focusApp` and `focusDeepLink` is on. It reports `level:"tile+composer"` only while the patched app runs. Otherwise it falls back to activating the window of whichever Traycer is running. Live probe: `packages/agent-adapter-traycer/scripts/focus-test.ts`. It acts on allowlisted chats only.

---

## CLI vs WS transport decision

**Use direct WS RPC through the vendored protocol. Keep the CLI for `task create`, `whoami` and diagnostics.**

| Need | CLI `--json` | WS (vendored @ host-v1.5.4) |
|---|---|---|
| User prompt to an existing chat | **No** | Yes (live) |
| List tasks across epics | No | `epic.listTasks` (live, 154 tasks) |
| List agents in any epic without a sender agent | No (`agent.list` needs a sender in the epic) | `epic.listChatRecords` + `epic.listTuiAgents` + `getChatRunSettingsBatch` (live) |
| Events (activity, chat stream) | No (`monitor` is one agent's inbox) | `agent.activity.subscribe`, `chat.subscribe` (live) |
| Stop | Only in the environment's epic | `agent.stop` with no agent context (live) |
| Create task | Yes, with idempotency (live) | `epic.create` (not used) |
| Token refresh | The CLI owns it | Delegated to `traycer whoami --json` |
| Cost | One process spawn per call | One socket per stream |

Client identity `{kind:"fm1-console", compatibilityEpoch:2}` is accepted by the host. I re-checked this live in this pass.

## Final capability matrix

"Live" means exercised against the running 1.5.4 host. "Live (re-run)" means I repeated it in this verification pass.

| Operation | Pathway | Status |
|---|---|---|
| Discover endpoint | `pid.json` + pid identity check | Live (re-run): pid 69261, `ws://127.0.0.1:52330/rpc` |
| Authenticate | Bearer from the credentials file, in memory | Live (re-run). The UNAUTHORIZED→whoami path is unit-tested only. |
| Version negotiation | `open`/`openAck` manifests | Live (re-run): host 113 floor + 257 optional methods, client 476 |
| Host capabilities | `openAck.capabilities`, `host.getRuntimeCapabilities` | Live (re-run): `unary.idempotencyKey`, `chatMessageList: available` |
| List tasks | `epic.listTasks` (`"1.0.0"`/`"2.0.0"`) | Live (not re-run) |
| List agents | `listChatRecords` + `listTuiAgents` | Live (re-run): disposable epic 2 gui rows; `ab47a5cf` 1 tui row |
| Activity across epics | `agent.activity.subscribe` | Live. TUI agents may not appear in it (observed). |
| Chat events and context usage | `chat.subscribe` (`blockDelta` `usage.updated` / `turn.completed`) | Live |
| Transcript | `agent.getTranscript {epicId, agentId}` | Live (re-run) |
| **Send user prompt, GUI chat** | `chat.subscribe` `send` | **Live**, Claude and Codex, exactly once |
| **Send prompt, Claude/Codex TUI agent** | Typed into the terminal (`terminal.subscribe` `write`, cache viewer, idle-prompt guard); confirmed by a new `<user_message>` in `agent.getTranscript` | **Live** on Claude (2026-11-19); Codex pattern-only |
| Send prompt, Claude TUI fallback | `agent.sendMessage` as the configured `a2aSender` or the receiver itself; delivery and reply read from `agent.getTranscript` | **Live** (TUI-A2A, and the busy fallback 2026-11-19); Codex cannot receive a2a (`TARGET_TUI_UNSUPPORTED`) |
| Stop | `agent.stop` | Live (T6: running → stopping → stopped) |
| Create task | `traycer task create --json --idempotency-key` | Live |
| Create GUI chat in task | `epic.createChat` | Live |
| Approvals, discover and respond | notifications + `approvalDecision` | Verified live (T7: deny, approve, stale) |
| TUI approvals | none | Unsupported |
| Focus (a) | `open -a Traycer` | Live |
| **Focus (b)** | none; deep-link patch proposed | **Requires upstream change** |
| **Focus (c)** | autofocus after (b) | **Unverified; depends on (b)** |

## What remains for acceptance

Acceptance chain: "FM-1 simulator → select chat → desktop focuses session → dictated text submitted to that session".

| Step | State | Remaining work |
|---|---|---|
| FM-1 simulator → select Traycer chat | Not demonstrated | Wire the simulator/companion selection to the adapter's `listAgents` ids. |
| Desktop focuses the correct session | **Blocked at level (a)** | 1. Get the deep-link patch accepted upstream, or authorize a **separate dev build** of Traycer Desktop for testing (patching `/Applications/Traycer.app` is not allowed). 2. Run T5 (a human clicks a notification) to prove the reused click-to-tile path on stock 1.5.4. 3. Grant Accessibility to the terminal so that (c) can be checked with the AX focused element or a T6 keystroke in a **disposable** composer. |
| Dictated text submitted to the same session | **Works** | `sendPrompt(epicId, chatId, text)` is live-verified. Also confirm that the submitted turn is visible in the focused tile after (b). |
| Interim fallback, if upstream is slow | n/a | Submit through WS (exact session, no focus needed), activate the window (a), and show the target chat's title on the FM-1 confirm screen. Be clear that the visible tile may differ. |

Also open, though not part of acceptance:
- T1, T4, T7, T8 and T9 from the smoke plan.
- Root `tsc -p tsconfig.json` fails with 41 errors, all in `packages/agent-adapter-traycer`: 32 `TS2307` "Cannot find module" plus 9 follow-on implicit-any errors. The root needs `paths` aliases. The per-package `tsc` runs pass.

---

## Terminal (TUI) agents: prompts through Traycer a2a

> **Since 2026-11-19 this is the fallback route.** The primary route types the prompt into the terminal (next section).
> The adapter uses a2a only when nothing was typed, or always with `tuiRoute: "a2a"`.

Date: 2026-11-18, host 1.5.4. Approved by the operator after "Report status." to a real TUI agent failed with `terminal sessions accept only PTY keystrokes`. Tested only on throwaway agents in the disposable task `243c50b9…`. Evidence: `reports/evidence/tui-a2a/` (summary: `findings.json`).

**Verdict: Claude TUI agents take console prompts through `agent.sendMessage@1.1`. The prompt goes out as a sender agent in the receiver's own task. Delivery, completion and the answer are read from `agent.getTranscript`. Keystrokes are never injected.**

### What the host does (observed)

| Question | Answer | Evidence |
|---|---|---|
| Version | `agent.sendMessage` 1.1 in the host's required manifest | `*-manifest.json` |
| Which `senderAgentId` is accepted | Any agent of this user **in the receiver's task**: a GUI chat, a dedicated "FM1 Console" GUI agent, a TUI agent (running, stopped, or blocked), an archived chat, even the receiver itself | `*-send-sender-*.json`, `*-send-console-*.json` |
| Which is refused | An unknown id, or a sender from another task: `FORBIDDEN`, message = the sender id | `*-send-sender-unknown.json`, `*-send-sender-crossepic-receiverepic.json` |
| Delivery path | Broker → durable inbox → `traycer monitor` (Claude Code plugin monitor) → Claude takes a turn. The transcript shows a `<task-notification>` "[traycer:agent-message] from <sender title> (agent <id>) … No reply is required. <prompt>", then `<assistant_response>`. | `*-transcript-8a7fec60.json` |
| Latency (running receiver) | RPC 15–51 ms; prompt in the transcript at ~1.0 s; answer at ~3.0–4.1 s (haiku, one line) | `*-send-console-latency-*.json`, smoke |
| Sleeping receiver | An `agent.create`d TUI had no PTY until the first message, which launched it | `*-peek-r2-after-send.json` |
| Blocked receiver | A Claude TUI at the folder-trust dialog never starts its monitor. The RPC still succeeds, but nothing arrives. So RPC success means `sent`, not `backend_acknowledged`. | `*-peek-first.json`, empty `*-transcript-696edaf0.json` |
| `expectReply` | Returns a broker `responseId`, reused per sender→receiver pair. The receiver has to call `traycer_send_message` to reply. Haiku did not, and once asked explicitly, its Claude auto-mode classifier denied the tool ("Unsanctioned Communication"). **Not reliable.** | `*-send-r2-expectreply*.json`, `*-peek-r2-after-reply2.json` |
| Can the companion watch the sender's inbox | GUI sender: `agent.inbox.subscribe` closes `UNAUTHORIZED AGENT_NOT_FOUND`. TUI agent: the fm1-console client may open it, but it would race that agent's own monitor. Not used. | `*-inbox-*.json` |
| Codex TUI | `agent.create` refused: `TARGET_TUI_UNSUPPORTED - harness 'codex' cannot receive agent-to-agent messages` | `2026-11-18T11-03-02-199Z-create-error.json` |
| GUI chat as receiver | Lands as a user_message "Agent message from FM1 Console …" (521 ms). The adapter keeps `chat.subscribe` `send` for GUI chats: a real user turn with exact correlation. | `*-send-gui-receiver.json` |

### What the adapter does

- `sendPrompt` on a TUI session: `agent.sendMessage {senderAgentId, epicId, receiverAgentId, prompt, responseId:null, expectReply:false, workspace:null}` with idempotency key `fm1-a2a-<requestId>`.
- The sender comes from adapter option `a2aSender` (`{agentId, epicId}` or a list, one per task). The adapter never creates agents. `a2aSelfSend` (off by default in the adapter) sends as the receiver itself.
- **Operator decision 2026-11-18, option B (self-send):** the companion passes `a2aSelfSend: true` by default (config key `a2aSelfSend`, default true, saved only when false) and its optional `a2aSender` (one `{agentId, epicId}` or a list) wins for the tasks it names. Live, end to end through the guarded adapter on the throwaway TUI 8a7fec60 (`bun tools/smoke-traycer/src/cli.ts --live --only TUI-A2A --a2a-self`): PASS, `accepted_locally` 0 ms, `sent` 21 ms, `backend_acknowledged` 1,032 ms, `completed` 4,078 ms, the marker in exactly one receiver turn and in `details.reply`, one send.
- Stages: `accepted_locally`, then `sent` on RPC success, then `backend_acknowledged` when the prompt appears in the receiver's transcript (the call resolves here), then `completed` when an assistant answer follows (a later `command_progress`). If delivery is not seen within `ackTimeoutMs`, the call resolves `sent` with a reason and is never resent.
- The answer is stored as `session.details.reply {requestId, text, at}` and `details.lastMessage`.
- Per session: `session.prompt` / `adapter.promptCapability(ref)` gives `{acceptsPrompt, via: "chat.subscribe" | "agent.sendMessage" | null, reason?, senderAgentId?, line?, toast?}`. `acceptsPrompt` is false for non-Claude terminals and for a Claude terminal in a task with no configured sender (and no self-send). agent-core keeps `acceptsPrompt`, `reason` and the device copy (`line` ≤ 28 for the bubble, `toast` ≤ 20 for REC): a Codex terminal says `Codex terminal: open on Mac` / `Terminal: use Mac`; no sender `Terminal: no FM-1 sender` / `No sender for task`. The console reads it before dictation: no REC in the hint, REC refused with the toast, nothing recorded.
- Error mapping: `FORBIDDEN` → `failed` (nothing delivered, retryable); `NOT_FOUND` → `target_unavailable`; `TARGET_TUI_UNSUPPORTED` / `INCOMPATIBLE` → `unsupported`; a transport failure after the request → `sent` (uncertain, not resent).

### Caveats

- **The sender must live in the receiver's task.** One configured sender cannot reach agents in other tasks. To reach a real task the operator must name a sender there: an existing agent of theirs, or a dedicated "FM1 Console" agent they create. The other option is `a2aSelfSend`.
- **The prompt arrives as an agent message, not a user turn.** It is framed "from <sender title>", "No reply is required." The receiving Claude may treat agent instructions with less authority than user ones (its auto-mode classifier denied an a2a-requested tool call live).
- **A blocked TUI** (trust dialog, permission prompt, no monitor) shows `sent` with the reason "delivery not observed yet". The adapter cannot see why.
- Completion is inferred from the transcript (the first answer after the prompt). Two messages that arrive in one turn share one answer.

---

## Terminal (TUI) agents: prompts typed into the terminal (2026-11-19)

Operator decision 2026-11-19: console prompts to terminal agents are **typed into the agent's Traycer terminal**, so they
arrive as a normal user message (not an a2a agent message). This is the primary route for Claude and Codex terminals.
A Claude terminal falls back to a2a self-send (previous section) when nothing could be typed. Tested live only on the
allowlisted throwaway TUIs in task `243c50b9…`. Evidence: `reports/evidence/tui-typing/smoke-2026-11-19.json` (its
`summary` block lists the findings).

### What the host and the TUI do (observed, host 1.5.4, Claude Code 2.1.311)

| Question | Answer |
|---|---|
| Agent to terminal | `terminal.list {scope:{kind:"epic",epicId}}`: the terminal `sessionId` is the TUI agent id, `sessionKind:"terminal-agent"`. Read-only over 15 real tasks (counts only): 144 TUI agents, 17 with a running terminal, 0 terminal-agent sessions without an agent. A TUI agent without a running terminal (reaped or never started) cannot be typed into. |
| Attach | `terminal.subscribe` negotiates 1.7. With `viewer:"cache"` (1.6+) the attachment holds no grid size and no reap claim. The adapter also opens at the size `terminal.list` reports, so even a host that ignored `viewer` would not shrink the operator's view. |
| Snapshot | `binarySnapshot`: an xterm-serialized screen (`ESC[?1049h ESC[H`, rows, `ESC[nC` gaps, SGR, final cursor move, `ESC[?2004h` bracketed paste on), about 1.0–1.6 KB. Live `data` chunks are the TUI's own redraws. |
| Idle Claude screen | A `❯` line between two `─` rules, status lines below. A finished turn leaves `✻ Cogitated for 1s · done …`. Claude Code can show a **gray suggested prompt inside the empty box** (seen live). |
| Busy Claude screen | A spinner line right above the box, for example `· Accomplishing… (2s · ↓ 142 tokens)` (no "esc to interrupt" in this version). |
| Dialog | The folder-trust dialog (`❯ No, exit` / `Yes, I trust this folder` / `Enter to confirm · Esc to cancel`) replaces the box. No permission prompt could be produced safely (the throwaway runs in auto mode), so permission prompts are detected by pattern only. |
| Write | `write` frames are acked (`actionAck accepted`) in about 11 ms. The cache viewer may write. |
| Paste | Bracketed paste shows in the box at once (multi-line: `[Pasted text #1 +N lines]`). Single line arrives as `<user_message>text</user_message>`; multi-line as `<user_message><pasted_content id="…">text</pasted_content id="…"></user_message>`. Quotes, `&`, `<>` and unicode arrive intact (no ASCII fold needed). |
| Mid-turn write | Claude Code accepts it and injects it at the next tool boundary. The running turn is superseded and its one answer is for the new message. **Not safe queueing**, so the route refuses busy screens. |
| Latency (idle, haiku) | Paste ack +11 ms, paste visible +154 ms, Enter ack +11 ms → `sent` +0.5 s; user message in the transcript +1.0 s after Enter; answer +2.5 s. Through the full adapter: `sent` +0.5 s, `backend_acknowledged` +1.5 s, `completed` +4.6 s after `accepted_locally`. |

### What the adapter does (`terminal-typing.ts`, `terminal-screen.ts`, `tui-screen-state.ts`)

1. `terminal.list` of the task: the agent's terminal must exist and be `running`.
2. Baseline: the number of typed `<user_message>` blocks that already hold the prompt's first line.
3. Attach as a `cache` viewer at the listed size. A negotiated version below 1.6 is closed before any write, and the
   adapter then uses a2a for terminals until the next handshake.
4. Rebuild the screen in a headless VT emulator (snapshot plus redraws). Wait until the output is quiet for 300 ms
   (at most 2 s); a spinner seen at any moment means busy. Classify: `idle` | `busy` | `draft` (the box already holds
   non-gray text, for example the operator's own draft) | `dialog` (permission prompt, trust dialog, menu, numbered
   selection, `Enter to confirm`, `Esc to cancel`, …) | `unknown`. Only `idle` is typed into.
5. Text: CR LF → LF, TAB → two spaces, every other control character (ESC included) removed, so the text can never
   close the paste or inject keys. A prompt that starts with `/`, `!`, `#` or `?` (slash command, bash mode, memory,
   help) is not typed.
6. One `write` with `ESC[200~text ESC[201~`, its ack awaited; Enter (`\r`) only after the box shows the pasted text
   (`draft`). This guards the gray suggested prompt: Enter on a box that still reads empty could submit that suggestion.
7. `sent` after the Enter ack; `backend_acknowledged` when a new typed `<user_message>` with the first line appears (an
   a2a `<task-notification>` never counts); `completed` when an answer follows (`details.reply` / `lastMessage`, as for
   a2a). The terminal stream is closed right after the Enter ack.

Fallback and double-send rules:

| Outcome | Result |
|---|---|
| Nothing written (no terminal, terminal exited, `terminal.list` failed, attach refused or timed out, host < 1.6, not idle, bad text, write rejected by the host) | Claude terminal with a sender or self-send: **Traycer a2a** (a `command_progress accepted_locally` says why it was not typed). Codex terminal: `failed`, `Codex terminal: <reason>; nothing typed` (retryable). |
| Paste written, but its ack is missing or the box does not show it | `sent`, "Enter not pressed, not resent". No fallback. |
| Typed and Enter acked, but no user message within `typeConfirmTimeoutMs` (default `ackTimeoutMs`, 15 s) | `sent`, "typed into the terminal; not confirmed in the transcript yet (not resent)". **No fallback** (a second route could deliver it twice). |

Config: adapter `tuiRoute: "type" | "a2a"` (default `type`), `typeConfirmTimeoutMs`, `typeQuietMs`. Companion
config key `tuiRoute` (default `type`, saved only when `a2a`). `promptCapability` / `session.prompt` for a Claude or
Codex terminal is now `{acceptsPrompt:true, via:"terminal.write"}`, plus `fallbackVia:"agent.sendMessage"` and
`senderAgentId` for a Claude terminal with a sender or self-send. The Codex copy `Codex terminal: open on Mac` is used
only with `tuiRoute: "a2a"`; other harnesses keep the harness copy.

Smoke tool (allowlist-enforced; state-changing commands need `--live`): `bun tools/smoke-traycer/src/tui-typing.ts`
`peek | watch | type | raw | adapter <agentId> [--text T] [--live]`. `adapter` goes through `GuardedAdapter`, which now
also checks the a2a fallback sender of a `terminal.write` route.

### Caveats

- **Codex is pattern-only.** No Codex TUI was available: `agent.create` refuses codex TUIs (`TARGET_TUI_UNSUPPORTED`),
  and spawning one through `epic.createTuiAgent` needs the Desktop's PTY launch. The Codex rules (`›` composer, `⏎ send`
  footer, `Working (… esc to interrupt)`, `Would you like to run …` approvals) come from the Codex CLI layout and may
  need adjusting on the first live Codex prompt. An unrecognized screen is refused (`unknown`), never typed into.
- **Permission prompts are pattern-only** (see above). Any numbered selection, `Do you want to …`, `Enter to confirm` or
  `Esc to cancel` without an input box counts as a dialog.
- **Race window (narrowed by the adversarial review).** The last screen read happens right before the paste, after the
  output has been quiet for 300 ms. A screen that never goes quiet within 2 s is refused as busy (an unrecognized
  spinner still redraws). After the paste, Enter is pressed only when the box shows the text.
- **Busy terminals queue (2026-11-24).** A recognized running turn (spinner / `esc to interrupt` above an empty input
  box) is typed into too: Claude Code and Codex take a prompt submitted during a turn as a queued (or steering) user
  message. The result is `backend_acknowledged` "queued behind the running turn" (console: "Queued, runs next") once
  the input box empties after Enter, and `completed` when the answer shows up in the transcript. Text still in the box
  after Enter resolves "sent" with a reason, never resent. A draft or dialog is still refused (Claude: a2a fallback).
- **Review hardening (2026-11-19).** The headless screen bounds scroll / insert / delete counts (`ESC[999999999S` no
  longer hangs the adapter) and clamps restored cursor positions; a frame it cannot take marks the attach broken
  instead of throwing into the stream client. An unknown negotiated `terminal.subscribe` version is refused (cache
  viewer not proven). An error before the first write frame is `written:false` (`internal_error`, Claude falls back to
  a2a); after it, the result stays "sent". An adapter stopping mid-route does not fall back to a2a. The smoke tool's
  `raw` command cleans text exactly like the library route.
- **Only running terminals.** A TUI agent whose PTY is not running cannot be typed into; Claude then falls back to a2a
  (which also starts a sleeping agent), Codex fails with the reason.
- Completion is inferred from the transcript, as for a2a: two messages in one turn share one answer.

---

## Terminal details, pins outside the scan, parent links (adapter step, 2026-11-18)

| Feature | Pathway | Status |
|---|---|---|
| Terminal (TUI) session details | `agent.getTranscript {epicId, agentId}` for the **selected** terminal session only: on selection (`watchSession`), every 15 s while selected (`terminalRefreshMs`), and when its state changes (at most one extra read per 2 s). The last 64,000 characters are parsed: last `<assistant_response>` → `details.lastMessage` (≤ 600) and `summary`, last `<user_message>` (an a2a `<task-notification>` reduced to its prompt) → `details.lastPrompt` (≤ 200); markdown stripped, `redactSecrets`, ASCII fold. A first-seen answer is dated by the agent record's `updatedAt`, a changed one by the time it was seen (transcripts carry no timestamps). | **Live (read-only)** on the operator's terminal session 848e2ae1: 125,449 characters in 1.2 s; lastMessage 526, lastPrompt 196, summary 118 characters (sizes only; no content printed). `bun tools/smoke-traycer/src/transcript-size.ts --agent <id>` |
| Pinned sessions and tasks outside the 25-task scan | `AgentAdapter.fetchPinned`: `epic.listChatRecords` + `epic.listTuiAgents` (+ `epic.getChatRunSettingsBatch`) once per task holding a requested pin, whatever the number of pins in it. `gone` only when the agent is missing from its task's listing (deleted) or archived, or the task is missing from a complete `epic.listTasks` listing. Batched and slow since 2026-11-19 (below). | Fake host (unit tests: 120 pins in 30 tasks = 30 chat + 30 terminal listings; the console reads at most 25 tasks per refresh); uses only calls the scan makes live |
| Parent/child agent links | Chat records `parentChatId`, TUI agents `parentId` → `Session.parentKey` (same task) | **Live (read-only):** 25 tasks, 278 sessions; 242 with a parent (241 listed), 24 distinct parents (one orchestrator per task, fan-out up to 51); depth 1: 214, 2: 26, 3: 1 |
| Backend name in device copy | `AgentAdapter.displayName = "Traycer"` | `Traycer offline`, `Gone from Traycer` |
| `lastActivityAt` | Filled by the adapter itself (record update, last outcome, stream or transcript activity, activity feed while busy); the companion no longer reads `status.raw.outcome.at`. | Unit tests |

### Pins outside the scan: batch and cadence (operator decision 2026-11-19, "no limit")

Pins are unlimited (a safety cap of 200 session pins and 200 task pins), so the console no longer asks for every pin on
every refresh. The rules (`packages/agent-core/src/console.ts`):

- **Which pins.** Only pins outside the last full snapshot (the adapter's 25-task scan): a session pin the snapshot did not
  list, and a task pin whose task had no session in it. Pins inside the scan cost nothing extra.
- **One batch per call.** One `fetchPinned` call carries the pins of at most **25 tasks** (`PIN_FETCH_TASKS`, the size of
  the scan); the adapter reads each of those tasks once. So one refresh costs at most 25 x (chat listing + terminal
  listing + run settings) RPCs, independent of the number of pins.
- **Cadence.** At every resync (start, reconnect) one batch. While some out-of-scan pin has not been asked for since that
  snapshot: one batch every **5 s** (`PIN_CATCHUP_MS`, the companion's tick), in pin order, so 200 pins in 200 tasks are all
  shown within 8 batches (about 40 s). Afterwards one batch every **120 s** (`PIN_REFRESH_MS`), rotating round robin over
  the out-of-scan tasks (every pin is re-read within ceil(T / 25) x 120 s). Never while the backend is disconnected, and
  never two calls at once. Between batches the live record feed keeps the sessions it reports up to date. A task read
  only for pins does not join the adapter's fallback poll (`scannedEpics`, used while the live feeds are down), so that
  poll's cost does not grow with pins either.
- **Never dropped** unless Traycer reports the session or task deleted or archived (`gone`). A failed call keeps every pin;
  its tasks count as asked, so a failure waits for the 120 s cadence instead of retrying every 5 s.

## Session scan: ranking by agent activity and background full scan (operator decision 2026-11-22)

Live measurement: a task's `updatedAt` barely moves while its agents work (3 of 165 tasks updated in 24 h; ranks 26-30
were 7-24 days old), and the `epic.listTasks` order is not recency either. Ranking the quick scan by task `updatedAt`
therefore left recently active tasks outside it. Now (`traycer-agent-adapter.ts` `scanSelection` / `fullScan`):

- **Quick scan** (`listSessions()` without a task, at most `sessionScanLimit` = 25 tasks with chats on this host): ranks
  each task by the newer of its `updatedAt` and its newest known agent activity (agent record created/updated time, last
  turn outcome, chat/transcript details time; `SessionBook.activityByEpic`). Every task with an agent working or in a turn
  in the live `agent.activity.subscribe` frame is always included, on top of the limit (`SessionBook.busyEpics`).
- **Background full scan**: at connect (and every reconnect), then every **120 s** (`FULL_SCAN_INTERVAL_MS`; config
  `fullScanIntervalMs`, 0 disables it), re-lists the tasks and reads the agents of **every** task with chats on this host
  (archived agents excluded as in the scan; `epic.listChatRecords` + `epic.listTuiAgents` + run settings; 4 at a time).
  It never blocks `listSessions`, never overlaps itself (a second trigger joins the run in flight), does nothing while
  the link is down, stops on `disconnect`, and skips a task that cannot be read. It requires full snapshot answers, so an
  `unchanged` answer never removes agents. Its tasks do not join the fallback poll (`scannedEpics`).
- **Announcing**: the full scan's agents land in the session book silently (they feed the ranking). For a task the scan
  moves into the quick-scan selection it emits `task_upserted` and a `session_upserted` per session; for a task already
  selected, only its new agents. So the console shows them before its next snapshot. The book never drops agents of a
  task missing from a later quick scan (agents are removed only by their own task's listing, a record feed removal, or a
  task missing from a complete task listing), and the ranking keeps an active task selected in later quick scans.
- **Live check 2026-11-22** (read-only, counts only): before, the 25-task scan listed 147 sessions and 11 tasks with
  session activity in the last 24 h. After: the full scan sees 450 sessions in 107 tasks, 15 of them active in 24 h;
  the quick scan lists 244 sessions in 25 tasks and includes all 15 active tasks (29 sessions active in 24 h).

## Suggested next prompts (2026-11-19)

Operator-approved: show the agent's suggested next prompt on the console and offer it as a fast option on REC
(docs/ui-v3.md section 11). The adapter reports it as `Session.details.suggestions` (string[], 0..3, adapter-neutral).

| Source | How | Rules | Evidence |
| --- | --- | --- | --- |
| GUI chat | `suggestedPrompt` on the `chat.subscribe` snapshot and on `turnStateChanged` (vendored `chatSuggestedPromptSchema`, the 1.20 "Claude-parity line"), read from the stream the adapter already holds for the selected chat (`ChatDetails`) | One string. An **absent key clears it** (the host drops it on any send, run open and teardown); the stream closing clears it too (live-only state). Markdown reduced, `redactSecrets`, ASCII fold, cut at 600. Ignored when the negotiated `chat.subscribe` minor is below 20 (the host strips the key there anyway): a clean fallback, nothing else changes. | `test/suggestions.test.ts` (unit, and through the fake host with the real vendored client at 1.41 and at a forced 1.19) |
| Negotiated version | `WsStreamClient.getMethodSchemaVersion("chat.subscribe")`, shown as `diagnostics().chatSubscribe` | The vendored client offers its newest minor; the host picks the highest both know. | **Live, read-only** on the allowlisted throwaway chats `51b0ff2e`, `067bd5f8`, `00de2d3e`: **1.41** (>= 1.20), no suggestion present (idle chats). `bun tools/smoke-traycer/src/suggestion-check.ts --chat <id>` (refuses ids outside the allowlist; sizes only). `reports/evidence/ui-v3/suggestions/live-check.json` |
| Terminal agent (Claude/Codex TUI) | The transcript the adapter already reads for the selected terminal session (`terminal-transcript.ts parseNextSteps`) | The list under the **last** heading of the last `<assistant_response>` that matches (case-insensitive, markdown markers stripped) `Next steps`, `Suggested next steps`, `Suggested next`, `Recommended/Possible/Proposed next steps/actions`, optional `(...)` and `:`; a bare `Next:` does not count. Items `- `, `* `, `+ `, `1. `, `1) ` (checkboxes dropped), indented continuation lines joined, nested (more indented) sub-items dropped as detail of their parent, blank lines allowed, the list ends at the first other line. Fenced code (```` ``` ```` / `~~~`) is never a heading or an item: code indented under an item is dropped, a fence at the margin ends the list. Up to 3 items, each reduced, redacted, ASCII-folded, cut at 120. None when there is no heading or list, or when a newer `<user_message>` follows the answer. A newer answer replaces or clears it, and the list is dropped when the session stops being watched (nothing keeps it current; `SessionBook.dropSuggestions`). | `test/suggestions.test.ts` |

The mock adapter supports it (`MockAdapter.setSuggestions`; a send clears them like the host, `clearSuggestionsOnSend`).
No new Traycer call: both sources are reads the adapter already makes. Nothing is sent without SAVE on the device.

## Verification pass (adversarial), 2026-11-17

Read-only, apart from the probe calls listed below. I created no tasks, sent no prompts, stopped nothing and committed nothing. The allowlist is unchanged.

| Claim | Check run | Verdict |
|---|---|---|
| Host reachable as `fm1-console`; manifest counts | `bun src/cli.ts discover` | **Confirmed** (identical numbers) |
| Disposable epic has claude/haiku and codex/gpt-5.6-luna GUI chats | `list-agents 243c50b9…` | **Confirmed** |
| `ab47a5cf` has 1 TUI row matching the CLI | `list-agents ab47a5cf…` (read-only) | **Confirmed** (`ba7ab4d3…`, tui, claude, running) |
| Exactly-once delivery, T2, T3 and focus acceptance | `transcript` for both chats; `traycer_search_chats` across all accessible tasks, which now reports index `complete` (the smoke report saw `partial`) | **Confirmed.** Each marker appears as one `<user_message>` plus one reply, in one chat only. `FM1_SMOKE*` / `FM1_FOCUS*` appear in no other chat. The codex transcript has no claude markers, and the reverse holds. |
| One ack and one `messageAccepted` per send | Frame counts in `t2/t3/t6-frames.ndjson` | **Confirmed** (one `send/accepted` each) |
| T2 PASS | `t2-send-claude.json` | **Qualified.** The probe's own verdict was `outcome: timeout` after 120 s, caused by the turnId correlation bug. PASS rests on the frames and the transcript. The fixed tracker is proven on T3 and on the focus acceptance send (`finished/completed`, 1.8 s). |
| T6 stop with no agent context | Adapter code: env vars are deleted before `whoami`; `agent.stop{epicId,agentId,cascade}` has no sender; `t6-agent-stop.json`; the transcript ends at "129." | **Confirmed** |
| Probe guards | `stop ab47a5cf…` and `send` without `--live` were both refused. The allowlist check runs before any mutation (code read). | **Confirmed.** The refusal with `--live` on a non-allowlisted epic was not re-run on purpose: it would have targeted the live parent agent. |
| No token leakage | `git grep -nE 'eyJ\|refreshToken\|Bearer '` (tracked and untracked) finds only identifiers and docs. An exact-value scan, run in code over 16,158 files in the repo, the smoke repo and the scratchpad, for the bearer, the refresh token and their 32-char slices: **0 hits**. `roomInfo` and license-key values appear in no report. | **Confirmed** |
| Vendoring provenance | Tracked files and `vendor/traycer/{LICENSE,VENDORED.md}` checked against the tag. `cmp` on all 33 `clients-shared` files: 0 differences. `diff -rq` on `protocol/` shows only omitted files. LICENSE is identical to upstream. | **Confirmed**, with a minor correction: VENDORED.md's omission list is missing `protocol/tsconfig.build.json` and `protocol/vitest.config.ts`. The smoke summary says "31 + 2 files"; VENDORED.md says 33. Both are the same 33-file closure. |
| Unit tests | `bun test packages/agent-adapter-traycer` | **Confirmed** (15 pass, 0 fail, 38 expects) |
| Root tsc "41 Cannot find module" | Root `tsc` | **Corrected:** 41 errors = 32 `TS2307` + 9 follow-on errors, all in the adapter |
| Installed 1.5.4 ignores non-auth deep links | Read the installed `app.asar` main bundle; desktop log at 21:02:07.926 | **Confirmed** |
| Patch applies | `git apply --check` in fresh worktrees of `desktop-v1.5.4` and `main` | **Confirmed**. Patch tests: **not run**. |
| "Prompt submission is undocumented-but-present" (focus test report) vs "public API" (smoke report) | Docs page and protocol licence | **Reconciled:** the frame is part of the public MIT protocol used by first-party Desktop, so it is public by this document's definition. It is **not** in the documented CLI, and the wire protocol has no prose docs. |
| Focus (c) "expected via autofocus" | n/a | **Downgraded** to unverified (AX blocked; T5/T6 not run) |
