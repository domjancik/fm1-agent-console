# Traycer live smoke report (T0, T2, T3, T6)

Date: 2026-11-17. This report covers priority-update items 1–3 (`new-spec-2`).

## Environment

| Field | Value |
|---|---|
| Traycer CLI | `1.5.4` (`~/.traycer/cli/bin/traycer`) |
| Traycer Host | `1.5.4`, pid 69261, hostId `64b73845…` |
| Protocol | vendored `@traycer/protocol` at tag `host-v1.5.4` (`b7a5f5ca`); see `vendor/traycer/VENDORED.md` |
| Client | `@fm1/agent-adapter-traycer` 0.1.0 through `tools/traycer-probe` |
| Client identity | `{kind:"fm1-console", compatibilityEpoch:2, appVersion:"0.1.0"}`, accepted by the host (see below) |
| Disposable repo | `/Users/dominikj/dev/personal/fm1-agent-console-smoke`: README, `src/sum.ts`, `test/sum.test.ts`, `SMOKE_MARKER`, no credentials |
| Disposable task | epic `243c50b9…`. Full ids are in `reports/disposable-allowlist.json` |

No host restart, no Desktop change, and no config change. No existing task or agent was prompted, stopped or modified. The only epic outside the disposable task that was touched is `ab47a5cf…`, and it was only read.

## Answers to the priority-update questions

**Prompt submission through public APIs: possible, live-verified.** A user turn in an existing **Chat-interface (GUI) agent** is submitted with the `chat.subscribe` stream client frame `kind:"send"`. This is the same action the Desktop composer sends (`ChatStreamClient.sendAction`). The frame carries:
- `sender:{type:"user",userId}`;
- `settings` copied verbatim from `epic.getChatRunSettings`;
- `accountContext:{type:"PERSONAL"}`;
- `sentFromHostId` set to the local hostId;
- `deliveryPolicy:"auto"`, `worktreeIntent:null`, `browserAnnotations:[]`.

The host answers with:
1. `actionAck{status:"accepted"}`, matched by clientActionId;
2. `messageAccepted`, matched by messageId;
3. `turnStateChanged`, through `starting → running → completed`.

The negotiated line was `chat.subscribe@1.41`.

This needs **new integration code**, namely the vendored protocol and the adapter, because the CLI has no command that submits a user prompt. `traycer agent send` is inter-agent messaging. The `/rpc` and `/stream` endpoint is local and authenticated with the user's own bearer, so this path uses the public protocol and leaves the installed app unchanged.

**Terminal (TUI) agents** have no structured submit path. Their status is `unsupported` in `traycer-capabilities.json`.

**Session focus (items 4–6)** is not covered by this run. See `docs/discovery/traycer-focus.md`, written by another workstream.

## Discovery open questions resolved

| # | Question | Result |
|---|---|---|
| 1 | Does the host accept a non-first-party `clientIdentity.kind`? | **Yes.** The `open` frame with `kind:"fm1-console"` and epoch 2 received an `openAck`. Unary calls, `agent.activity.subscribe`, `chat.subscribe` send/ack, `epic.createChat` and `agent.stop` all succeeded under that kind. The fallback to `"cli"` was never needed, though `resolveClientIdentity` keeps it. Upstream doc: kind "never gates admission". |
| 2 | What do `epic.listTasks` `extensionPhaseVersion` and `extensionEpicVersion` expect? | `"1.0.0"` and `"2.0.0"`, which are `String(CURRENT_PHASE_VERSION)` and `String(CURRENT_EPIC_VERSION)` as gui-app sends them (`clients/gui-app/src/lib/cloud-epic-tasks-query/query.ts`). The call returned 154 tasks live. |
| 3 | Does `send` from a non-Desktop client create exactly one user turn, and which settings does it need? | **Yes, exactly one.** Settings copied from `epic.getChatRunSettings` kept the model at `haiku`, effort `low` and mode `supervised`, as the transcript shows. |
| 4 | Is `agent.stop` allowed from a socket with no agent context? | **Yes.** It returned `{stoppedAgentIds:[chatId]}` and the turn went `stopping → stopped`. |
| 6 | Where does context usage appear? | In `chat.subscribe` `blockDelta` events `usage.updated` and `turn.completed`, as `{inputTokens, outputTokens, contextTokens, contextWindow, costUsd?}`. |

Adapter detail found live: `activeTurn.turnId` is re-minted mid-turn. During `starting` it is a placeholder `turn:<uuid>`; once the harness starts it becomes the harness turn id. The stable correlation key is `activeTurn.userMessageId`, which equals the messageId we sent. The tracker matches on that key.

## Results

Session ids are cut to their first 8 characters. Full ids are in `reports/disposable-allowlist.json`, and raw outputs and frames are in `reports/evidence/traycer/`.

| Test ID | Timestamp (UTC) | CLI | Host | Provider | Session type | Target session | Operation | Expected result | Observed result | Result | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T0 | 2026-11-17T18:45–18:52 | 1.5.4 | 1.5.4 | n/a | n/a | epic `ab47a5cf…` (read only) | `discover`, `list-tasks`, `list-agents ab47a5cf…`, `activity 10` | Connects while Desktop keeps running unchanged; inventory agrees with Traycer; nothing modified | `openAck`: host manifest 113 floor + 257 optional methods (client offers 476), capabilities `["unary.idempotencyKey"]`, `host.getRuntimeCapabilities` → `chatMessageList: available`. `listTasks` returned 154 tasks. `list-agents ab47a5cf…` returned 1 row (`ba7ab4d3…`, tui, claude, model `default`, effort `medium`, `sessionState: running`), which matches `traycer agent list --json --all` field for field. Activity: 2 `state` frames (local and cloud) over 3 epics; this epic's TUI agent never appeared in `working`/`turn` (TUI caveat). | PASS | probe stdout (this report); `traycer agent list --json --all` |
| T2 | 2026-11-17T18:53:13 | 1.5.4 | 1.5.4 | claude (`haiku`, low, supervised) | GUI chat (surface gui) | `51b0ff2e…` in epic `243c50b9…` | `send` with marker `FM1_SMOKE_CLAUDE_20531314959` | Exactly one new user turn in the target; reply contains the marker; no other session gets it; authoritative ack; no duplicate | `actionAck accepted` ×1 and `messageAccepted` ×1 for the same messageId `6097956e…`; turn `ca513ab5…` reached `completed` about 1.3 s after send; streamed text was `FM1_SMOKE_CLAUDE_20531314959`. `agent.getTranscript` shows exactly one new `<user_message>` and an assistant reply equal to the marker. Chat search across all accessible tasks found the marker only in `51b0ff2e…` (search index `partial`). The probe printed `outcome: timeout` because the first tracker matched on turnId (see the adapter detail above). That was fixed and re-verified in T3 and T6. | PASS | `evidence/traycer/t2-send-claude.json`, `t2-frames.ndjson` |
| T3 | 2026-11-17T18:56:06 | 1.5.4 | 1.5.4 | codex (`gpt-5.6-luna`, low, supervised) | GUI chat, created by `epic.createChat` in the disposable task | `067bd5f8…` in epic `243c50b9…` | `create-chat`, then `send` with marker `FM1_SMOKE_CODEX_20560525442` | Same as T2 | `epic.createChat` → `{chatId}`; `list-agents` shows it as gui/codex/gpt-5.6-luna. Send: ack accepted, messageAccepted, `starting → running → completed`, outcome `finished/completed` in 7.2 s, text equal to the marker. Its transcript holds one user turn plus the marker reply. The claude chat transcript does not contain the codex marker. | PASS | `evidence/traycer/t3-send-codex.json`, `t3-frames.ndjson` |
| T6 | 2026-11-17T18:56:27 | 1.5.4 | 1.5.4 | claude (`haiku`) | GUI chat | `51b0ff2e…` | `send` "count slowly to 200", then `stop` (`agent.stop{cascade:false}`) about 9 s later | Correct session stops; state matches the backend; no replay | `agent.stop` → `{stoppedAgentIds:["51b0ff2e…"]}`. The send tracker saw `running → stopping → stopped` on turn `07c72b90…` and settled `finished/stopped`. Output ended at "129.", so the stop came mid-stream. The codex chat was not touched. | PASS | `evidence/traycer/t6-send-long.json`, `t6-agent-stop.json`, `t6-frames.ndjson` |

Not run in this pass: T1 (live state transition timing), T4, T5 beyond task creation, T7, T8, T9. T5's first half did happen: `traycer task create --json --idempotency-key …` created the disposable task, and its first agent showed up at once as a GUI chat. No result is claimed for those tests.

## Security checks done

- The bearer and refresh token are read only inside `CredentialSource` and held in memory. A post-run scan of every probe output, evidence file, report and package source found neither token. `host.getRuntimeCapabilities` returns a license key; the adapter reduces it to the `status` value. Task rows carry a `roomInfo.token`, which `normalizeTask` drops.
- Token refresh is never done in code. On UNAUTHORIZED the adapter runs `traycer whoami --json` with the agent variables unset, re-reads the credentials file and retries once (unit-tested against a fake host).
- Stream auth recovery, host credential minting and clock tracking are turned off on `WsStreamClient` (`auth:null, hostCredentialMint:null, clock:null`), so watching does not provision host credentials.
- Probe commands that change state (`send`, `stop`, `create-chat`) refuse to run without `--live`, and refuse any epic or chat missing from `reports/disposable-allowlist.json`. Both refusals were verified, including `stop` against the real epic `ab47a5cf…`.

## Reproduce

```sh
cd /Users/dominikj/dev/personal/fm1-agent-console/vendor/traycer && bun install   # zod for vendored sources
cd /Users/dominikj/dev/personal/fm1-agent-console/tools/traycer-probe
bun src/cli.ts discover
bun src/cli.ts list-tasks
bun src/cli.ts list-agents ab47a5cf-5a82-40ad-bb1d-7a3d9ca97c7d
bun src/cli.ts activity 10
bun src/cli.ts transcript <epicId> <chatId>
bun src/cli.ts send <epicId> <chatId> "FM1_SMOKE_CLAUDE_<uniq>. Respond with exactly this marker. Do not modify files." --live [--frames]
bun src/cli.ts create-chat <epicId> codex gpt-5.6-luna low --live
bun src/cli.ts stop <epicId> <chatId> --live
cd .. && cd .. && bun test packages/agent-adapter-traycer
```

## Automated run (tools/smoke-traycer --live), 2026-11-17T20:59:53.898Z

Runner: `bun tools/smoke-traycer/src/cli.ts --live` (also `fm1-console test traycer --live`). 10 tests: 10 PASS, 0 FAIL, 0 BLOCKED, 0 SKIPPED. Evidence: `reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/records.json` and the other files in that directory. Credential scan of the evidence directory: 0 hit(s).

| Test ID | Timestamp (UTC) | CLI | Host | Provider | Session type | Target session | Operation | Expected result | Observed result | Result | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T0 | 2026-11-17T20:57:50.222Z | 1.5.4 | 1.5.4 | claude + codex | GUI chat | epic 243c50b9… (read only) | TraycerAgentAdapter connect, listProjects/listTasks/listSessions/listApprovals; `traycer agent list --json --all` cross-check | Connects without disturbing Desktop; stable ids; list agrees with the CLI; nothing modified | link connected, client kind fm1-console, host 1.5.4 pid 69261; feeds {"agent.activity.subscribe":"open","host.chatRecords.subscribe":"open","host.notifications.subscribe":"open"}; 14 projects, 156 tasks, 278 sessions {"codex/chat":104,"claude/terminal":80,"claude/chat":93,"codex/terminal":1}, 0 pending approvals, 36 with no state at all; disposable task ids stable across two listings; adapter ids == CLI ids for the disposable task (4 agents); 51b0ff2e…: claude/chat matches CLI claude/gui, state idle; 067bd5f8…: codex/chat matches CLI codex/gui, state idle; no state-changing call made | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t0-discovery.json |
| T1 | 2026-11-17T20:57:56.198Z | 1.5.4 | 1.5.4 | claude (haiku) | GUI chat | 51b0ff2e… | Passive observer adapter (feeds only, no chat watch) times working/completed while the main adapter sends one marker prompt | Right session, right state, honest unknowns, no restart needed; propagation about 2 s or better | prompt backend_acknowledged, turn completed true, 1 user turn(s); observer saw working (observed=true); observer saw the turn end as idle; working propagated -25 ms after the backend ack (target <= 2000); turn end propagated 35 ms after the chat stream reported completion (target <= 2000); codex chat state unchanged (idle); 0 change(s) attributed to it; after the turn: CLI active=false, adapter completed_unread; 10 terminal sessions: activity reported as inferred only (7 inferred); Desktop tile switching (spec step 2) was not driven: no UI automation (Accessibility not granted); the observer needs no Desktop action | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t1-state-sync.json |
| T2 | 2026-11-17T20:58:03.969Z | 1.5.4 | 1.5.4 | claude (haiku, low, supervised) | GUI chat | 51b0ff2e… | TraycerAgentAdapter.sendPrompt with FM1_SMOKE_CLAUDE_<id> | Exactly one user turn in the target; reply has the marker; no other session gets it; authoritative ack; no duplicate | sendPrompt resolved backend_acknowledged in 17 ms; stages accepted_locally@0 > sent@17 > backend_acknowledged@17 > completed@1235; 1 user turn(s) with marker FM1_SMOKE_CLAUDE_MWL6C952RYG in the target; assistant reply contains the marker; other disposable chat: 0 turn(s) with the marker; 1 adapter send call(s) for the request | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t2-delivery.json |
| T3 | 2026-11-17T20:58:05.233Z | 1.5.4 | 1.5.4 | codex (gpt-5.6-luna, low, supervised) | GUI chat | 067bd5f8… | TraycerAgentAdapter.sendPrompt with FM1_SMOKE_CODEX_<id> | Exactly one user turn in the target; reply has the marker; no other session gets it; authoritative ack; no duplicate | sendPrompt resolved backend_acknowledged in 422 ms; stages accepted_locally@0 > sent@422 > backend_acknowledged@422 > completed@6349; 1 user turn(s) with marker FM1_SMOKE_CODEX_MWL6CA47U5L in the target; assistant reply contains the marker; other disposable chat: 0 turn(s) with the marker; 1 adapter send call(s) for the request | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t3-delivery.json |
| T4 | 2026-11-17T20:58:11.639Z | 1.5.4 | 1.5.4 | claude A + codex B | GUI chat | A 51b0ff2e…, B 067bd5f8… | AgentConsole: select A, select B, send to B, select A, send to A, select B, send to B (selected session = target) | Each instruction reaches only its own session; workspaces unchanged; no forced focus | select B ok; select A ok; select B ok; dispatch stages B1:backend_acknowledged, A1:backend_acknowledged, B2:backend_acknowledged; B1: 1 turn in its own chat, 0 in the other (1/0); A1: 1 turn in its own chat, 0 in the other (1/0); B2: 1 turn in its own chat, 0 in the other (1/0); workspaces unchanged (/Users/dominikj/dev/personal/fm1-agent-console-smoke, /Users/dominikj/dev/personal/fm1-agent-console-smoke); no focus call was needed | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t4-switching.json |
| T5 | 2026-11-17T20:58:27.402Z | 1.5.4 | 1.5.4 | claude (haiku, supervised) | GUI chat (first agent of a new task) | new task in ws:/Users/dominikj/dev/personal/fm1-agent-console-smoke | TraycerAgentAdapter.createTask (traycer task create --idempotency-key fm1-<requestId>), repeat from a fresh adapter, list, select | Task and session appear in Traycer; prompt delivered once; repeat returns the same task; controller can select it | createTask backend_acknowledged, task 86facc1a…; repeat from a fresh adapter: backend_acknowledged, same task true (task already created for this request); 1 session(s) in the new task: 11d00d84… claude/chat; task listed under the smoke workspace project; first prompt: 1 user turn(s), reply has the marker true; controller selects it (slot 277, state completed_unread) | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t5-new-task.json |
| T6 | 2026-11-17T20:58:45.278Z | 1.5.4 | 1.5.4 | claude (haiku) | GUI chat | 51b0ff2e… | sendPrompt (count slowly to 200), then TraycerAgentAdapter.interrupt (agent.stop cascade:false); disconnect + reconnect | Correct session stops; codex chat unaffected; state matches backend; nothing replayed on reconnect | prompt backend_acknowledged; working after 15 ms; interrupt completed; prompt progress ended failed turn stopped; session left working after the stop (idle); codex chat unchanged (completed_unread -> completed_unread); after reconnect: 0 new user turn(s), marker turns 1; after reconnect the chat is idle (not restarted); one interrupt call, never repeated | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t6-interrupt.json |
| T7 | 2026-11-17T20:58:54.445Z | 1.5.4 | 1.5.4 | claude (haiku, supervised) | GUI chat (new, createSession) | new chat in epic 243c50b9… | createSession; prompt a write of SMOKE_APPROVAL.txt; deny via FX+SAVE; again, approve via SAVE+SAVE; stale decision after each | Approval discovered with exact id and summary; explicit confirmation; deny blocks the write; approve allows it; stale decisions refused | createSession backend_acknowledged, chat 00de2d3e…; new chat selected in the console; deny prompt backend_acknowledged; approval toolu_01… listed for exactly this chat; summary "Approval: FM1 smoke (disposable) / Create SMOKE_APPROVAL.txt file"; deny: first press opens the confirm view "DENY Approval: FM1 smoke (disposable) / Create SMOKE_APPROVAL.txt file" and sends nothing; deny result completed; denied write did not happen (SMOKE_APPROVAL.txt absent); stale toolu_01… via adapter: target_unavailable (approval toolu_013eX69xrk6jcgU3hxi8AoE6:file-edit already resolved); stale via device: SAVE opens no confirm and sends nothing; approve prompt backend_acknowledged; second approval toolu_01… (new id); approve: first press opens the confirm view "APPROVE Approval: FM1 smoke (disposable) / Create SMOKE_APPROVAL.txt file" and sends nothing; approve result completed; approved write happened (SMOKE_APPROVAL.txt contains FM1); stale toolu_01… via adapter: target_unavailable (approval toolu_016v46SJVND88fLdtYzzJpjq:file-edit already resolved); stale via device: SAVE opens no confirm and sends nothing; every decision targeted this chat only | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t7-approvals.json |
| T8 | 2026-11-17T20:59:10.566Z | 1.5.4 | 1.5.4 | claude (haiku) | GUI chat | 51b0ff2e… | Kill the console process after backend ack and restart it; adapter disconnect/connect; console on a pid.json copy with a dead pid, then restored | State resyncs; ids stable; in-flight prompt not duplicated; actions refused while the host is unavailable | companion process killed (SIGKILL) right after backend_acknowledged; stages seen accepted_locally>sent>backend_acknowledged; restarted process lists the same 5 session keys; in-flight prompt delivered exactly once after the crash (1 user turn(s)); transport drop: disconnected>connected, keys stable (5); bogus pid.json: console disconnected, device message "BACKEND DOWN"; while down: console dispatch target_unavailable, adapter sendPrompt failed (Traycer host disconnected); nothing reached the chat while the host was unavailable; host back: console resynced in 5376 ms with the same 5 keys; event feeds open after the late connect {"agent.activity.subscribe":"open","host.chatRecords.subscribe":"open","host.notifications.subscribe":"open"}; 'Restart a disposable agent' not exercised separately (T6 stop + later prompts cover the agent coming back) | PASS |  |
| T9 | 2026-11-17T20:59:32.178Z | 1.5.4 | 1.5.4 | claude (haiku) | GUI chat | 51b0ff2e… | Forged/stale refs to the raw adapter and the console; hostile injected events; malformed console inputs and device frames; credential scan | Stale ids never redirected; failures never reported as success; no tokens in logs; events cannot trigger commands; registry intact | unknown chat id target_unavailable, other host target_unavailable, other backend target_unavailable; stale registry entry: dispatch target_unavailable (target stale), not selectable, no adapter call; a fresh snapshot makes the real session live again (identity verified by the backend, not by the event); none of the refused prompts reached the chat; hostile backend events caused no command (adapter calls unchanged); 3 malformed/unknown-target events rejected by validation; no confirm view opened by an event (a decision always needs two device presses); malformed console inputs and 28 malformed device MIDI messages: registry, selection and approvals unchanged, no command; device link still up (rx errors counted, link connected); 70 credential needles loaded in memory; token scan: 176 files, 0 with a credential () | PASS | reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t9-companion-log.txt, reports/evidence/e2e/smoke/2026-11-17T20-57-45-389Z/t9-isolation.json |

### Findings from the automated runs (2026-11-17, 20:38–21:00 UTC)

- **T7 first run: BLOCKED, now fixed.** For file writes, host 1.5.4 uses `fileEditApprovalRequested` / `fileEditApprovalDecision` / `fileEditApprovalResolved` and `snapshot.pendingFileEditApprovals`, not `approvalRequested`. The adapter discovered the approval from the notification feed (approval id `toolu_…:file-edit`) and then resolved it itself 4 ms later, because the chat channel's pending set lacked file-edit cards. Evidence: `reports/evidence/e2e/t7-diagnosis/pre-fix-run-2026-11-17T20-38-15-417Z/t7-approvals.json` (timeline t=30230/30234) and `probe-send-frames.json` (`frameKinds.fileEditApprovalRequested: 1`). After the fix, T7 passes: deny blocks the write, approve allows it, and both stale decisions are refused (`target_unavailable` from the adapter; the device opens no confirm view).
- Approvals (discover, deny, approve, stale) are now **verified live** for claude GUI chats in supervised mode. `reports/traycer-capabilities.json` still says `code-only` (not updated by this workstream).
- Spec 6 T1 propagation through the passive feeds: `working` was seen 25 ms *before* the sender's own `messageAccepted`, and the turn end 35 ms after the chat stream's completion.
- T8: a console process killed by SIGKILL right after `backend_acknowledged` and then restarted: the prompt appears exactly once, and session keys are identical across processes.
- Each run creates one disposable T5 task (createTask, idempotency checked from a fresh adapter) and one T7 chat (createSession). Both go into the allowlist before any prompt.

## Automated run (tools/smoke-traycer --live), 2026-11-18T11:10:35.432Z

Runner: `bun tools/smoke-traycer/src/cli.ts --live` (also `fm1-console test traycer --live`). 1 tests: 1 PASS, 0 FAIL, 0 BLOCKED, 0 SKIPPED. Evidence: `reports/evidence/tui-a2a/smoke-2026-11-18T11-10-24Z/records.json` and the other files in that directory. Credential scan of the evidence directory: 0 hit(s).

| Test ID | Timestamp (UTC) | CLI | Host | Provider | Session type | Target session | Operation | Expected result | Observed result | Result | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TUI-A2A | 2026-11-18T11:10:31.296Z | 1.5.4 | 1.5.4 | claude (haiku) terminal agent | TUI (terminal) | 8a7fec60… | TraycerAgentAdapter.sendPrompt to a TUI agent -> agent.sendMessage as the allowlisted a2aSender, marker FM1_SMOKE_A2A_<id> | Guard refuses a non-allowlisted target and sender; route is agent.sendMessage; stages accepted_locally>sent>backend_acknowledged>completed; marker in exactly one receiver turn; reply captured in session details; not in the sender's transcript; one send | guard refused a non-allowlisted TUI target: smoke guard refused: 243c50b9-ac47-47d8-8254-c1292092c1bb/00000000-0000-4000-8000-00000000a2a0 is not in the disposable allowlist; route agent.sendMessage as 08488a00-d6c8-4c8f-bf4e-73c02fec81a3; a2a sender is allowlisted; stages accepted_locally@1 > sent@44 > backend_acknowledged@1059 > completed@4086; 1 receiver turn(s) with marker FM1_SMOKE_A2A_MWM0SIO1VR1; receiver reply contains the marker; sender transcript: 0 turn(s) with the marker; session details.reply: "FM1_SMOKE_A2A_MWM0SIO1VR1"; 1 adapter send call(s) for the request | PASS | reports/evidence/tui-a2a/smoke-2026-11-18T11-10-24Z/tui-a2a-delivery.json |

## TUI prompts through Traycer a2a: live discovery, 2026-11-18

Operator-approved, on throwaway agents in the disposable task `243c50b9…` only (all listed in `reports/disposable-allowlist.json` before any prompt). Probe: `tools/traycer-probe/src/tui-a2a.ts`. Evidence: `reports/evidence/tui-a2a/` (summary: `findings.json`). No real session was messaged. No `traycer agent send` or MCP send was used. No keystrokes were written.

| Check | Result |
|---|---|
| `agent.sendMessage` version | 1.1 (host required manifest) |
| Sender acceptance | Same-task GUI chat, the "FM1 Console" GUI agent, a TUI agent (running, blocked or stopped), an archived chat, and the receiver itself: accepted. Unknown id: `FORBIDDEN`. Sender from another task: `FORBIDDEN`. |
| Claude TUI delivery (running) | RPC 26–31 ms; prompt in `agent.getTranscript` at 1.0 s; answer at 3.0–3.1 s |
| Claude TUI at the folder-trust dialog | RPC ok, never delivered (no monitor). Accepting the dialog by terminal write was refused by this session's permission classifier and was not done. |
| Sleeping TUI (no PTY) | The first message launched it, then it was delivered |
| `expectReply` | `responseId` minted (reused per pair). The receiver did not reply over a2a (once denied by its auto-mode classifier). The reply is read from the transcript instead. |
| `agent.inbox.subscribe` on the sender | GUI sender: `UNAUTHORIZED AGENT_NOT_FOUND` |
| Codex TUI | `TARGET_TUI_UNSUPPORTED` (cannot receive a2a) |
| GUI receiver via a2a | Lands as an agent-framed user_message. The adapter keeps `chat.subscribe` for GUI chats. |
| Smoke `--only TUI-A2A` | **PASS**. The run is recorded in the section above, with evidence in `reports/evidence/tui-a2a/smoke-2026-11-18T11-10-24Z/`. |
