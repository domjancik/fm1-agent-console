# @fm1/agent-adapter-traycer

`TraycerAgentAdapter` implements agent-core's `AgentAdapter` for the local Traycer host 1.5.4. It talks to the host over the vendored `@traycer/protocol`, using WS RPC on `/rpc` and streams on `/stream`. It uses the CLI only for `task create` and `whoami`. The older `TraycerAdapter` class is still used by `tools/traycer-probe`, and the new adapter reuses its RPC helpers.

```ts
const adapter = new TraycerAgentAdapter({ focusDeepLink: false });
const console = new AgentConsole({ adapter });
await console.start();
adapter.watchSession(selectedRef); // chat: opens chat.subscribe; terminal: reads agent.getTranscript (now, every 15 s, on state change)
```

`displayName` is `"Traycer"` (device copy: `Traycer offline`, `Gone from Traycer`).

## Identity

Each session has the composite id `{backendId:"traycer", hostId, projectId, taskId: epicId, sessionId: chatId | tuiAgentId}`.

- `hostId` is the `hostId` in `~/.traycer/host/pid.json`. It survives a host restart, so session refs survive a reconnect.
- Chats whose `originHostId` belongs to another machine are not listed.
- Archived chats are not listed unless `includeArchived` is set.

### Projects

Traycer has no project entity, so the adapter derives one from each Task's associations (`mapping.ts`):

1. `ws:<path>` is the first workspace, sorted by path, that this host owns. If this host owns none, the first workspace of any host is used.
2. `repo:<owner>/<repo>` is the first repository association, used when the Task has no workspace.
3. `none` is used when the Task has neither.

Each Task belongs to exactly one project. A Task's project changes only if its workspace associations change. `createTask` maps `ws:` back to `--workspace` and `repo:` back to `--repo`.

### Sessions

| Source | Session field |
| --- | --- |
| `epic.listChatRecords` rows | GUI chats, `runtime: "chat"` |
| `epic.listTuiAgents` rows | terminal agents, `runtime: "terminal"` |
| `epic.getChatRunSettingsBatch` | `provider` from `harnessId` (`claude`, `codex`, anything else is `other`) |

`listSessions()` waits up to `firstActivityWaitMs` (default 2 s) for the first activity frame, so a fresh connect lists chats as observed `idle`/`working` instead of `unknown`. With no task id it scans the `sessionScanLimit` most recent Tasks (default 25) that have chats on this host. Up to 4 Tasks are read at a time.

| Field | From |
| --- | --- |
| `parentKey` | the parent agent's session key, same task: `parentChatId` (chat records) or `parentId` (TUI agents); a self-reference is dropped |
| `lastActivityAt` | max of creation, the record's `updatedAt`, the last outcome, the stream's or transcript's newest activity, and the activity feed while busy |
| `details` | GUI chats: the chat stream while it is open (kept after). Terminal agents: the selected session's `agent.getTranscript`, read on selection, every `terminalRefreshMs` (15 s) while selected and on a state change; only the last 64,000 characters are parsed (`terminal-transcript.ts`: last answer → `lastMessage` ≤ 600, last user message or a2a prompt → `lastPrompt` ≤ 200; redacted, ASCII). Never read in bulk. |
| `prompt` | `promptCapability` (below), with device copy `line` / `toast` when `acceptsPrompt` is false |

`fetchPinned({sessions, tasks})` (agent-core §9.7) reads the agents of every task holding a pin, also outside the scan, and returns the pinned sessions and every session of each pinned task. A pin is reported `gone` only when Traycer says so: the agent is missing from its task's listing (deleted) or archived, or the task is missing from a complete task listing. Anything uncertain keeps the pin; while disconnected it rejects.

## State model

The adapter keeps two kinds of state apart:

- **Observed:** a fact the host reported.
- **Inferred:** a heuristic.

The raw facts are kept in `status.raw`.

| Normalized state | Source | Kind |
| --- | --- | --- |
| `approval_required` | `approval.requested` notification, or the chat's `pendingApprovals` / `approvalRequested` | observed |
| `waiting_input` | `interview.requested` notification, or the chat's `pendingInterviews` | observed |
| `working` (GUI chat) | agent listed in the `agent.activity.subscribe` `turn` or `working` bucket, or the chat's active turn is not finished | observed |
| `working` / `idle` (terminal) | activity, which for terminals is based on output only | **inferred only** |
| `failed` | the last turn `errored` or `interrupted`, or an `agent.stalled` notification | observed |
| `completed_unread` | the last turn `completed`, the console has not called `focus` or `markViewed` since, and the notification row is unread in Traycer | observed |
| `completed_read` | as above, after the session was viewed, or when the row was already read in Traycer | observed |
| `idle` | the activity or chat stream is live and the agent is in no bucket | observed |
| `unknown` | no feed has reported yet | none |

Host 1.5.4 sends `runStatus:"running"` beside an active turn whose status is `completed`. The turn's own status wins.

A new turn clears the previous outcome. If the activity stream shows a turn ending but no outcome arrives, the session stays observed `idle` and gets an inferred `completed_unread`.

## Events

| Feed | Events |
| --- | --- |
| `agent.activity.subscribe` | session status upserts |
| `host.chatRecords.subscribe` | chat or TUI added, archived or removed. When the last chat of a Task is deleted, the Task list is re-read, which emits `task_removed`. |
| `host.notifications.subscribe@1.0` (`filter:"all"`, 200 rows) | approval, interview, stopped and stalled notifications |
| `chat.subscribe` | opened on demand: for the selected session (`watchSession`, `focus`), an in-flight prompt, or an approval decision |

- Malformed frames are dropped and counted in `diagnostics().malformed`. A non-JSON frame makes the vendored client redial that stream.
- Polling with backoff runs only while `host.chatRecords.subscribe` or `agent.activity.subscribe` is dead.

## Commands

| Operation | Pathway | Result stages |
| --- | --- | --- |
| `sendPrompt` | `chat.subscribe` `send`, with run settings copied from `epic.getChatRunSettings` | `accepted_locally`; then `sent` on `actionAck`; then `backend_acknowledged` on `messageAccepted`, which is when the call resolves; then `completed` as a later `command_progress`, when the turn whose `userMessageId` matches finishes. A turn that ends `errored` or `stopped` reports `failed`. With no ack, the result is `sent` and the prompt is never resent. Claude terminal sessions: see the next row. Other terminal sessions return `unsupported`. |
| `sendPrompt` (Claude TUI) | `agent.sendMessage` (Traycer a2a) as the `a2aSender` configured for the receiver's task, idempotency key `fm1-a2a-<requestId>`; never PTY keystrokes | `accepted_locally`; `sent` on RPC success; `backend_acknowledged` when the prompt shows up in the receiver's `agent.getTranscript`, which is when the call resolves; `completed` when an assistant answer follows it, and the answer is stored as `session.details.reply` (and `lastMessage`). If delivery is not seen within `ackTimeoutMs`, the result is `sent` with a reason, and the prompt is never resent. `FORBIDDEN` sender → `failed`; gone → `target_unavailable`; `TARGET_TUI_UNSUPPORTED` → `unsupported`. |
| `respondToApproval` | `chat.subscribe` `approvalDecision` with the exact `approvalId`; for file writes, host 1.5.4 uses `fileEditApprovalRequested` / `fileEditApprovalDecision` / `fileEditApprovalResolved` (`snapshot.pendingFileEditApprovals`), and the matching decision frame is sent (live-verified in T7) | `completed` on `approvalResolved`. An id that is not pending in the chat snapshot, already resolved, belongs to another session, or is rejected as stale returns `target_unavailable`. |
| `interrupt` | `agent.stop {epicId, agentId, cascade:false}` | `completed` |
| `createTask` | `traycer task create --json --no-progress --idempotency-key fm1-<requestId> --harness --model …`, run with `TRAYCER_AGENT_ID`, `TRAYCER_EPIC_ID` and `TRAYCER_TERMINAL_SPAWN_TOKEN` removed from the environment | `backend_acknowledged`. If the outcome is unknown, the result is `sent` and the command is not retried. |
| `createSession` | `epic.createChat` with a client-minted `chatId`, which is also the idempotency key | `backend_acknowledged` |
| `focus` | `open -a Traycer`. With `focusDeepLink`, `traycer://open/epic/<E>/chat/<C>?focus=composer` instead. With `focusDeepLink` and a `focusApp` (`configureFocusApp(path)`, companion config `focusApp`), `ps -axo command=` first: if that patched app is running, `open -a <focusApp> <link>`; if not, `open -a <running Traycer bundle>` (or `open -a Traycer`). | `completed`, plus `level`: `tile+composer` only when the link went to the running patched app, else `window`. The chat tile is selected only on a Desktop build that has the deep-link patch. |

Repeating a request with the same `requestId` returns the first result and never sends again. The one exception is a `failed` result with no backend effect, which may be retried.

The `harness/model` used for each provider defaults to the cheapest models: claude → `haiku`, and codex → `gpt-5.6-luna` with `low` reasoning effort. Set `models` to change them.

## Terminal prompts (Traycer a2a)

```ts
new TraycerAgentAdapter({ a2aSender: [{ epicId: "<task>", agentId: "<an agent of yours in that task>" }] });
adapter.promptCapability(ref); // {acceptsPrompt, via: "chat.subscribe" | "agent.sendMessage" | null, reason?, senderAgentId?}
```

- The host accepts only a sender in the receiver's own task. Unknown or cross-task senders get `FORBIDDEN`. Configure one sender per task. The adapter never creates agents.
- `a2aSelfSend: true` sends as the receiver itself when no sender is set for its task. This works live, but the agent then sees "from <its own title>". Off in the adapter; the companion turns it on by default (config `a2aSelfSend`, operator decision 2026-11-18).
- `a2aExpectReply` defaults to off. The receiver's a2a reply is unreliable (live: not sent, or denied by its Claude auto-mode classifier), so the answer is read from its transcript.
- `a2aPollMs` sets how often the transcript is polled (default 1 s; after delivery it backs off to 5 s).
- Every emitted session carries `prompt` (the same value as `promptCapability`), so the console can tell before sending whether a session will take a prompt.

Live discovery and evidence: `docs/traycer-integration.md` ("Terminal (TUI) agents"), `reports/evidence/tui-a2a/`. Probe: `bun tools/traycer-probe/src/tui-a2a.ts` (state changes need `--live` plus the allowlist).

## Capabilities

`getCapabilities()` reports each operation with a `verified` value of `live`, `code` or `none`, taken from `reports/traycer-capabilities.json`:

- If the report is missing, every operation is `none`.
- `focus` is `{supported:true, level:"window", verified:"live", reason:"tile selection needs upstream deep link (docs/upstream/traycer-deep-link.diff)"}`.

An INCOMPATIBLE answer removes capabilities until the next successful handshake:

| Where the INCOMPATIBLE comes from | What is lost |
| --- | --- |
| The `open` handshake | every host capability (focus stays) |
| One RPC method | the capabilities that depend on that method |
| A feed | the feed. `subscribe` is lost once both the activity feed and the chat-records feed are dead. |

## Connection

- Every connect or reconnect attempt re-reads `pid.json` and proves the endpoint with an `open`/`openAck` probe. On UNAUTHORIZED the adapter runs `traycer whoami` once.
- Failed attempts retry with exponential backoff (`backoff`, default 0.5 s to 30 s). If the host was down at `connect()`, the event feeds start on the first successful retry.
- A stream that drops triggers a re-check: has `pid.json` changed, is the process alive, and does the host still accept `open`? Only a real outage emits `connection: disconnected`.
- On a port change the shared stream client is pointed at the new URL and redials at once.
- Requests that might have reached the host are never replayed.

## Tests

```sh
bun test packages/agent-adapter-traycer
```

The tests run against `test/fake-host.ts`, a real WebSocket server for `/rpc` and `/stream`. Its frames are validated against the vendored host-v1.5.4 schemas. The tests cover:

- handshake
- listing and identity
- all three feeds
- prompt stages
- unsupported operations
- approvals, including stale ones
- task and session deletion
- malformed frames
- port-change reconnect
- host down at start
- INCOMPATIBLE: at the handshake, on a feed, and on an RPC
- `AgentConsole` resync

### Focus with the patched Desktop

The side-by-side build `Traycer FM1.app` (bundle id `ai.traycer.desktop.fm1`, see `docs/traycer-integration.md`) handles `traycer://open/epic/<E>/chat/<C>`. It does not claim `traycer://` as the default handler, so the adapter sends the link to it by path (`open -a <focusApp> <link>`), and only while it runs. It never launches the patched app.

Live focus probe for the orchestrator. It acts only on a chat in `reports/disposable-allowlist.json` (exit 2 otherwise). Host access is read-only. The only commands its runner allows are `ps -axo command=` and `open -a <Traycer app> [<this chat's link>]`. It prints the focus result, the frontmost app, the front window title, the AX focused element and the Desktop log's `[deep-link]` lines:

```sh
env -u TRAYCER_AGENT_ID -u TRAYCER_EPIC_ID -u TRAYCER_TERMINAL_SPAWN_TOKEN \
  bun packages/agent-adapter-traycer/scripts/focus-test.ts --epic <E> --chat <C> \
    [--focus-app "/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched/out/Traycer FM1.app"]
```

Read-only live check (no sends, approvals, stops, creates or focus):

```sh
env -u TRAYCER_AGENT_ID -u TRAYCER_EPIC_ID -u TRAYCER_TERMINAL_SPAWN_TOKEN \
  bun packages/agent-adapter-traycer/scripts/live-readonly.ts 15
```
