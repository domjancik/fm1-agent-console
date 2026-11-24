# Discovery: Traycer integration (spec section 5)

Date: 2026-11-17. Scope: read-only investigation. No host restart, no prompts sent, no tasks created, no config changed.

## Sources

- Installed CLI: `~/.traycer/cli/bin/traycer` version `1.5.4`.
- Installed desktop app: `/Applications/Traycer.app`, `CFBundleShortVersionString` = `1.5.4`.
- Running host: pid 69261, version `1.5.4`, hostId `64b73845-3a79-42c5-b7d6-40d4d340b269`.
- Upstream source (MIT): shallow clone at `/Users/dominikj/dev/personal/.fm1-upstream/traycer`, `main` @ `2937e711` (2026-11-17). The tag `host-v1.5.4` (= `cli-v1.5.4` = `desktop-v1.5.4`, commit `b7a5f5ca`) was also fetched. Every method named in this report exists in `protocol/src/host/registry.ts` at `host-v1.5.4` (checked by grep). Line numbers below are for `main`. Between the tag and `main`, `agent/shared.ts` and `agent/gui/subscribe.ts` changed in minor versions only.
- **The host source is not in the public repo.** Only `protocol/` (the wire contract) and `clients/{traycer-cli,shared,desktop,gui-app,mobile}` are public. Any statement about what the host does on the server side is inferred from contract docs and client code, and is labelled as inferred.

All paths below are relative to the upstream clone unless they start with `~` or `/`.

---

## 1. How an external process connects and authenticates

### 1.1 Finding the endpoint

- The host writes `~/.traycer/host/pid.json`. Real content, which holds no secrets:
  ```json
  {"pid":69261,"hostId":"64b73845-...","version":"1.5.4",
   "websocketUrl":"ws://127.0.0.1:52330/rpc","startedAt":"2026-11-15T08:56:03.646Z",
   "processStartTimeMs":1794732959057,"processStartIdentity":"darwin:Sun Nov 15 08:55:57 2026",
   "layer0":{"status":"acquired","attemptId":"..."}}
  ```
- The CLI reads this file in `resolveEndpoint()` (`clients/traycer-cli/src/internal/host-rpc.ts:478-520`). It checks three things:
  - the file is present;
  - the pid is still the same process (`publishedHostProcessGone`). It compares `processStartIdentity` because pids get reused;
  - `isValidLocalHostWebsocketUrl` (`clients/traycer-cli/src/host/pid-metadata.ts:341-356`): scheme `ws`/`wss`, host `127.0.0.1`, path `/rpc`, no query string.
- The port changes on each start. Re-read `pid.json` on every reconnect.
- The stream endpoint comes from the same URL: replace `/rpc` with `/stream` (`toStreamDialUrl`, `clients/shared/host-transport/ws-stream-client.ts:~4140`).
- `traycer host status --json` returns the same record under `data.pidMetadata`, plus lifecycle and supervisor state. It is safe and read-only, but slow and large because it includes a log tail.
- Other host-state files: `holder.json`, `host-instance.json` (instanceId), `supervisor.json`, `desktop-presence.json` (the Desktop pid). These are useful for diagnostics only.

### 1.2 Authentication

- **The host bearer is the user's Traycer cloud access token. It is not a host-local secret.** See `clients/traycer-cli/src/internal/host-auth.ts:6-24`: "The CLI talks to the host ... with a bearer it reads from `~/.traycer/cli/credentials` ... seeded by `traycer login` (the Desktop runs `traycer login --token` after sign-in)."
- `~/.traycer/cli/credentials` is plain JSON with mode `0600`. Its keys are `token`, `refreshToken`, `savedAt`, `user.{id,email,name}`. Only the key names were inspected; no values were read or printed.
- When a token is refreshed, the CLI rotates it under a file lock (`credentials.lock.*`, `store.rotate`; comment in `host-rpc.ts:72-87`). **The companion must not refresh tokens itself.** If it does, it races the CLI and Desktop on refresh-token rotation. Safe pattern:
  1. Read `token`.
  2. On `UNAUTHORIZED`, run `traycer whoami --json`. It validates the stored credential and can rotate it; its output includes `credentialUpdate`.
  3. Re-read the file.
- Team hosts have an extra "local open auth" step (`clients/traycer-cli/src/internal/local-open-auth.ts:15-42`) that can mint a member credential. For a personal host this does not apply. `TEAM_MEMBERSHIP_REQUIRED` is a possible typed refusal.

### 1.3 Handshake and version negotiation

Wire frames are in `protocol/src/framework/ws-protocol.ts`:

| Frame | Lines | Fields |
|---|---|---|
| client `open` | 506-525 | `token`, `manifest`, `optionalManifest?`, `capabilities?`, `clientIdentity?`, `cloudAuthorized?` |
| host `openAck` | 563-568 | `manifest`, `optionalManifest?`, `capabilities?` |
| client `request` | 526-538 | `requestId`, `method`, `schemaVersion{major,minor}`, `params`, `idempotencyKey?` |
| host `response` | 594-601 | `requestId`, `method`, `schemaVersion`, `result`, `error{code,message,...}` |
| `fatalError` | 546, 605 | `details{code, reason, incompatibleMethods, upgradeGuidance, retryable?}` |

- The manifest is a per-method map `{major, minor, supportedMajors?}` (`ws-protocol.ts:416-439`). Negotiation is per method. The npm semver plays no part (`protocol/README.md`, "Three version systems").
- The CLI does one unary call per socket: dial, `open`, `openAck`, compatibility check, `request`, `response`, close 1000 (`clients/shared/host-transport/ws-rpc-client.ts:248-262`).
- `clientIdentity` is `{kind?: string, compatibilityEpoch, appVersion}` (`protocol/src/framework/client-identity.ts:76-127`). `kind` is an open string. First-party values are `"desktop" | "cli" | "mobile"`. The current epoch is `2` (`client-identity.ts:64`). An older epoch, or a missing identity, gets the host's "legacy epoch rule" and may be refused with `clientCompatibilityRequirement`.
- Streams use the same shape on `/stream`: `open{token, manifest, clientIdentity?}`, then `openAck{manifest, capabilities, hostCredentialState}`, then `subscribe{method, schemaVersion, params}`. After that, method frames carry `{kind, hasBinaryPayload, ...}` (`protocol/src/framework/stream-ws-protocol.ts:310-394`). The client can send `credentialUpdate{token}` to rotate the bearer on a live stream.
- **Practical consequence:** speaking the protocol by hand means rebuilding the manifest from `hostRpcRegistry` and the stream registry, including floor methods. The safe route is to **vendor `@traycer/protocol` and `clients/shared/host-transport` pinned to tag `host-v1.5.4`** and reuse `WsRpcClient` and the stream clients. `@traycer/protocol` is **not published to npm**: `npm view @traycer/protocol` returns E404, although `protocol/README.md` describes a publish workflow. Both packages are MIT, and `clients/shared` is `private`. Vendoring is TypeScript/Bun-native. The companion should be TS/Node if it is to reuse this code.

---

## 2. RPC methods relevant to each adapter operation

The registry is `protocol/src/host/registry.ts`. Unary methods are at lines 6441-15162, stream methods at 15492-16645.

### 2.1 Listing tasks (epics) for the user

- **`epic.listTasks`** (registry line 8742, latest 1.10). Request: `{limit, cursor?, filters|null, sort?, extensionPhaseVersion, extensionEpicVersion, localFirstPhase?}` (`protocol/src/host/epic/unary-schemas.ts:1188-1235`). Response: `{tasks: ListTaskLight[], nextCursor?, hasMore, facets?}` (`:1479`). Each row carries `epic{...}` or `phase{...}` plus `pinned`, `chatHostIds`, `home`, `ownerEnvironmentId` (`:1068-1185`).
- This is the Desktop "History" list, scoped to the user, and is **not limited to the current task**. The `extensionPhaseVersion` and `extensionEpicVersion` strings are required. What values the host expects is an open question; Desktop code must be checked before calling.
- Push updates: **`host.chatRecords.subscribe`** (registry line 16316) is host-scoped. It covers "every epic that host has open, plus its own rows regardless of which epic", and frames name their epic (`protocol/src/host/epic/chat-records.ts:937-950`).

### 2.2 Listing agents and chats in an epic, with their attributes

Three pathways:

| Method | Needs a sender agent? | What it returns |
|---|---|---|
| `agent.list` (line 14138), used by CLI `agent list` | **Yes**: `{epicId, senderAgentId, scope:"user"|"all"}` (`agent/shared.ts:1255-1262`) | Full normalized row (below) |
| `epic.listChatRecords` (line 10845) | No: `{epicId}` (`chat-records.ts:93-97`) | GUI chats: `chatId, ownerUserId, originHostId, title, parentChatId, createdAt, updatedAt, archived, runSettingsSummary, revision, visibility, origin` (`chat-records.ts:153-202`) |
| `epic.listTuiAgents` (line 11300) | No: `{epicId, hasDocReplica}` | Terminal agents: `tuiAgentId, ownerUserId, hostId, harnessId, harnessSessionId, parentId, title, archived, workspaceFolders, workspaceMode, model, reasoningEffort, profileId, ...` (`epic/tui-agent-records.ts:109-145`) |

- The `agent.list` row is defined in `protocol/src/host/agent/shared.ts:978-1020` and `:1196-1251`. Fields:
  - identity and location: `id, parentId, hostId, isLocal`;
  - runtime: **`surface: "gui"|"tui"`**;
  - provider: **`harnessId`** (claude, codex, ...);
  - `isSelf, title, capabilities{readTranscript, sendMessage}`;
  - activity: **`active`** ("GUI turn running or TUI CLI producing output");
  - workspace: `folderPaths, isWorktree`;
  - run settings: `runConfig{model, reasoningEffort, fastMode, serviceTier}`;
  - session: **`sessionState: running|sleeping|stopped|null`** (`agent-session-state.ts:60`), `lastExit` (`:96`);
  - `archived, profile, permissionMode, reach, hostConnectivity`.
- Harness for GUI chats: `epic.getChatRunSettings` or **`epic.getChatRunSettingsBatch`** `{epicId, chatIds[]}` (`chat-records.ts:708-716`).
- **Live finding:** with `TRAYCER_EPIC_ID` set to a different epic of the same user, `agent list` returned:
  `{"code":"E_FORBIDDEN","message":"traycer: access denied for this epic - check TRAYCER_EPIC_ID and that you're signed in to the account that owns it."}`
  So `agent.list` is effectively gated on the sender belonging to the epic. This is inferred: the host code is not public, and the epic used was `169627d6-...`, which is active on this host. **Cross-epic `agent.list` requires a sender agent id from the target epic, which means impersonating that agent.**

### 2.3 Events and subscriptions

| Stream | Scope | Use |
|---|---|---|
| `agent.activity.subscribe` (line 16196) | **Per user, all epics**. Open params `{plane?: "local-only"}` | `state` frames: `{servedBy, byEpic: {epicId: {working: agentId[], turn: agentId[]}}, cloudSyncStatus?}` (`agent/activity.ts:96-131`). Each frame is a full replacement, so no cursor is needed. From GUI usage (`clients/gui-app/src/stores/agent-activity-store.ts:805-831`): `working` means producing output now; `turn` means a turn is in flight. |
| `host.notifications.subscribe` / `.feed.subscribe` / `host.notifications.list` (lines 15531, 15546, 12879) | Per host | Entries `{id, kind, epicId, chatId, severity, readAt, resolvedAt, payload}`. Kinds include **`approval.requested`**, `interview.requested`, `agent.stopped`, `agent.stalled` (`notifications/host-notifications.ts:113-180`). |
| `host.chatRecords.subscribe` (line 16316) | Per host | Upsert and remove of chat rows across epics |
| `chat.subscribe` (line 16645) | One chat `{epicId, chatId, resume}` | `snapshot`, `turnStateChanged{runStatus: idle|running|stopping, activeTurn{status: starting|running|stopping|completed|stopped|interrupted|errored, harnessId, model, ...}}` (`agent/gui/subscribe.ts:1720, 1735-1790, 3007-3030`), `messageAccepted`, `approvalRequested{approval}`, `approvalResolved`, `blockDelta`, `eventAppended`, `queueChanged` |
| `epic.status.subscribe` (line 15804) | One epic | Permission and cloud sync, `epicDeleted` (`epic/status-subscribe.ts:1-60, 544+`) |
| `terminal.subscribe` (line 15846) | One PTY `{sessionId, cols, rows, viewer?}` | Terminal output |

### 2.4 Sending a user prompt to a chat agent

- **GUI chat, user turn:** send a `chat.subscribe` client frame `kind:"send"` with:
  - `epicId, chatId, clientActionId, messageId`;
  - `content` (JSON doc);
  - **`sender: {type:"user", userId}`**;
  - `settings` (ChatRunSettings);
  - `accountContext`;
  - `deliveryPolicy` (default `"auto"`);
  - `worktreeIntent`.

  Source: `protocol/src/host/agent/gui/subscribe.ts:4394-4417`. The host answers with an `actionAck` and a `messageAccepted`. This is the same path the Desktop composer uses (`ChatStreamClient.sendAction`, `clients/shared/host-transport/chat-stream-client.ts:347-358`). **There is no unary "submit prompt" RPC.**
- **`traycer agent send` / `agent.sendMessage` is inter-agent messaging. It does not create a user turn.**
  - The request is `{senderAgentId, epicId, receiverAgentId, prompt, responseId, expectReply, workspace?, attachments?}`.
  - The docstring says: "fire-and-forget enqueue from one agent to another. **Distinct from `chat.subscribe`'s `send` action**: that surface streams a turn back to a UI client; this surface hands a prompt off to another agent's runtime" (`agent/shared.ts:1505-1535`).
  - The message is recorded with `sender: {type:"agent", agentId, harnessId, displayName, reply, inReplyTo}` (`persistence/epic/senders.ts:60-75`).
  - For a **TUI** receiver it goes into the broker's RAM-only inbox and is delivered to `traycer monitor` running inside the Claude Code session (`agent/inbox.ts:1-30`).
  - It requires a `senderAgentId` in the same epic.
  - **Do not use it for human prompts.**
- **Terminal (TUI) agents, raw input:** `terminal.subscribe` client frame `{kind:"write", data}` (`host/terminal/subscribe.ts:267-273`). This is keystroke injection, which spec 5.2 calls brittle. Note that the subscribe open carries `cols` and `rows`, which may resize the user's PTY. Use `viewer:"cache"` (`:125-140`) and verify. There is **no structured "submit prompt" for TUI agents**.

### 2.5 Stop and interrupt

- `chat.subscribe` frame `{kind:"stop", turnId|null}` (`subscribe.ts:4450-4455`) for a GUI chat. The owner sends it.
- `agent.stop` `{epicId, agentId, cascade}`: GUI aborts the turn; TUI receives SIGINT and keeps its PTY (`agent/shared.ts:1610-1655`). It needs no sender id. The CLI wraps it as `traycer agent stop --agent-id` (`clients/traycer-cli/src/index.ts:3568-3588`), but takes the epic only from the environment.

### 2.6 Approvals

- **Discovery, across epics:** `host.notifications.*` entries of `kind:"approval.requested"`, carrying `epicId` and `chatId`, with `resolvedAt` once resolved (`host-notifications.ts:167-174`). **Detail and response, per chat:** `chat.subscribe` `approvalRequested{approval}` and `approvalResolved{approvalId, decision}` (`subscribe.ts:3441-3460`).
- To respond, send the client frame `{kind:"approvalDecision", approvalId, decision:{approved, reason?}}` (`subscribe.ts:4555-4561`, `agent/gui/agent-runtime.ts:198-203`). `fileEditApprovalDecision` follows the same pattern.
- **TUI (terminal) agents:** no approval surface was found. TUI activity hooks report only `start|stop|resync|started|idle-confirmed` (`agent/tui/unary-schemas.ts:336, 382, 418`). Claude Code's own permission prompt happens inside the PTY.

### 2.7 Creating a task

- `epic.create` (line 8885, 1.2), used by `traycer task create`. The CLI builds:
  - `chat.initialMessage{messageId, clientActionId, content, sender{type:"user", userId}, settings, accountContext{type:"PERSONAL"}, sentFromHostId}`;
  - `owner:null`;
  - the transport idempotency key set to the new taskId.

  Source: `clients/traycer-cli/src/commands/task-create.ts:380-420`. `--idempotency-key` is a CLI-side key record valid for 24 h.
- **`task create` refuses to run if `TRAYCER_AGENT_ID` or `TRAYCER_EPIC_ID` is set** (`task-create.ts:260-269`). A companion started outside an agent session is fine. It also requires `--harness` **and** `--model` (`:275-279`).

### 2.8 Creating an agent in an existing task

- GUI chat: `epic.createChat` `{epicId, parentId|null, hostId, title, chatId (client-minted, idempotent), workspaceMode?, settings?, worktreeIntent?, initialMessage?}` (`epic/unary-schemas.ts:2259-2289`). `initialMessage` starts the first turn immediately.
- Terminal agent: `epic.createTuiAgent` (line 10238).
- `agent.create` (line 8400), used by CLI `agent create`, is the agent-to-agent child creation path. It needs a sender.

### 2.9 Focusing a desktop session

- `/Applications/Traycer.app` registers URL scheme `traycer` (Info.plist `CFBundleURLTypes`).
- In the public desktop source, the only `open-url` handler accepts **only `traycer://auth/callback`**. "Non-auth traycer URIs are ignored" (`clients/desktop/src/electron-main/auth/deep-link.ts:26-50, 57-118`).
- No host RPC to focus a chat in Desktop was found. The only `focus` concept is notification-entity "focus consumption" (`host-notifications.ts:118-124`).
- **Focus is unsupported. Report the capability as unavailable.** Maybe-supported fallbacks:
  - `open -a Traycer` brings the window forward but does not select a chat;
  - `editor.openPaths` (line 7393) opens files in an external editor. It does not touch Desktop.

---

## 3. CLI scoping and transport choice

### 3.1 Can CLI commands target another epic?

- Every `agent *` command passes `epicId: null` and `senderAgentId: null`. Values come **only** from `TRAYCER_EPIC_ID` and `TRAYCER_AGENT_ID` (`clients/traycer-cli/src/internal/agent-context.ts:13-62`, `index.ts:3283-3303, 3568-3660`). There is no `--epic` flag. `workspace list` also takes `epicId: null` (`index.ts:~2846`).
- Overriding the environment works mechanically, but `agent.list` returns `E_FORBIDDEN` unless the sender agent belongs to that epic (live test above). Setting both variables to another epic's agent means impersonating that agent. This is not a documented or legitimate external use: the code comment reads "Every Traycer-launched session carries ... in its environment, so an agent typically runs these" (`index.ts:2829-2832`).
- `TRAYCER_AGENT_CLI_SURFACE` (`full` in this session) hides or refuses mutations in `readonly` sessions (`index.ts:3248-3256`).

### 3.2 CLI `--json` versus direct WebSocket

| | CLI `--json` subprocess | Direct WS RPC (vendored protocol @ host-v1.5.4) |
|---|---|---|
| Cross-epic listing | **No.** `agent.list` is per epic and needs a sender; `epic.listTasks` is not exposed | Yes: `epic.listTasks`, `epic.listChatRecords`, `epic.listTuiAgents` |
| Events | No subscriptions. `monitor` is the inbox for one agent only | `agent.activity.subscribe`, `host.notifications.*`, `chat.subscribe` |
| User prompt to a chat | **Not possible.** `agent send` is inter-agent | `chat.subscribe` `send` |
| Approvals | Not possible | Yes, via notifications and `approvalDecision` |
| Create task | Yes (`task create --json --idempotency-key`) | Yes (`epic.create`) |
| Stop | Yes, but only within the environment's epic | `agent.stop` for any epic |
| Version handling | The CLI does it | We must pin and vendor, and re-check on each host update |
| Auth | The CLI handles refresh | Read the token; delegate refresh to `traycer whoami` |
| Cost | Process spawn per call (~0.5-1 s; `host status` is slower because of the log tail) | One persistent socket per stream |

**Recommendation: speak WS RPC directly through vendored `@traycer/protocol` and `clients/shared/host-transport`, pinned to tag `host-v1.5.4`, in a TS/Node companion.** Keep the CLI for:
- `task create`, which already has idempotency;
- `whoami`, for token refresh;
- `host status`, for diagnostics.

The CLI alone cannot do the core MVP features: a cross-task inbox, prompt delivery, and approvals. Identify the companion as its own `clientIdentity.kind` (for example `"fm1-console"`) with `compatibilityEpoch: 2`. Whether the host accepts a non-first-party `kind` is unverified and is open question 1.

---

## 4. Read-only command output shapes (redacted)

- `traycer --version` returns `1.5.4`.
- `traycer host status --json` returns NDJSON `{"type":"result","status":"ok","data":{running, pidMetadata{pid, hostId, version, websocketUrl, startedAt, processStartIdentity, layer0}, bootstrapLogPath, bootstrapLogTail (≈10 KB of host log), lifecycle{policy, presence, supervisor, run, owner}, lastUpdateAttempt{...outcome:"parked", message:"The update was installed, but the host has work in progress; restart it to finish."}}, "timestamp"}`.
- `traycer agent list --json --all` returns `data: {caller:{agentId, canSendMessages:true}, scope:"all", agents:[1 row]}`. The row is `surface:"tui", harnessId:"claude", title:"Implement Project Spec Artifact", active:false, sessionState:"running", archived:false, folderPaths:["/Users/dominikj/dev"], runConfig{model:{kind:"concrete",slug:"default"}, reasoningEffort:"medium"}, reach:"same_principal", hostConnectivity:{kind:"known",connectivity:"connectable"}`. **Note:** this agent was working, through a sub-workflow, yet `active` was `false`. `active` tracks PTY output only and is not a reliable "working" signal for TUI agents.
- `traycer workspace list --json` returns `data.rows[{hostId, runningDir, workspacePath, worktreePath, mode:"local", isGitRepo, branch, isPrimary, setupState, sources[{ownerKind:"terminal-agent", ownerId, ...}]}], folderlessCwd`.
- `traycer host capabilities --json` returns `{"v":1,"capabilities":["service-label","host-start-adoption-v2","maintenance-lease-v1","maintenance-lease-v2","lifecycle-policy-v1"]}`. **These are capabilities of the CLI binary. They say nothing about host RPC support.** For host capabilities, use `host.getRuntimeCapabilities` (line 7687) or the `openAck` manifest.
- `traycer whoami --json` returns `data: {status:"valid", user{id, email:<redacted>, name}, authnBaseUrl:"https://authn.traycer.ai", validated:true, credentialUpdate:"none"}`.
- With `TRAYCER_EPIC_ID` set to another epic, `agent list` returns `E_FORBIDDEN` (see 2.2).

---

## 5. Observability (spec 5.3)

| Field | Available? | Source |
|---|---|---|
| Provider (Claude/Codex) | Yes | `agent.list.harnessId`; `tuiAgent.harnessId`; GUI `getChatRunSettingsBatch`; `activeTurn.harnessId` |
| Runtime (Chat/Terminal) | Yes | `agent.list.surface` gui/tui; separate list methods |
| Task identity | Yes | epicId everywhere; `epic.listTasks` rows |
| Worktree identity | Partial | `folderPaths`, `isWorktree`; `worktree.getBinding` / `listBindingsForEpic` (lines 12457, 12469) |
| Current operation | Partial, GUI only | `chat.subscribe` `blockDelta`/`eventAppended` (tool calls). Not for TUI |
| Idle/working | Yes | `agent.activity.subscribe` (all epics); GUI `runStatus`/`activeTurn.status`; `sessionState`. TUI `active` is output-based (see caveat) |
| Pending permissions | GUI yes, TUI no | `approval.requested` notifications plus chat `approvalRequested` |
| Context usage | GUI likely | Runtime usage event carries `inputTokens`, `contextTokens`, `contextWindow` (`agent/gui/agent-runtime.ts:100-130`). Exact surfacing on `chat.subscribe` not verified. Not for TUI |
| Recent output summary | Partial | `agent.getTranscript` returns the full XML transcript (`agent/shared.ts:1585-1608`); `chat.subscribe` stream. No ready-made summary field |
| Completion/failure | Yes | `activeTurn.status` completed/stopped/interrupted/errored; `agent.stopped`/`agent.stalled` notifications with `outcome`; `lastExit` |

---

## 6. Capability matrix

| Operation | Pathway | Verified? | Evidence |
|---|---|---|---|
| Discover host endpoint | read `~/.traycer/host/pid.json`, validate pid identity and URL | **Live** (file read, matches `host status`) | `host-rpc.ts:478-520`, `pid-metadata.ts:341-356` |
| Authenticate | bearer = `token` from `~/.traycer/cli/credentials` in `open` frame | Code-verified; CLI live calls succeed with it | `host-auth.ts:6-64`, `ws-protocol.ts:506-525` |
| Version negotiation | per-method manifest on `open`/`openAck` | Code-verified | `ws-protocol.ts:416-568`, `ws-rpc-client.ts:248-300`, `protocol/README.md` |
| List all tasks | `epic.listTasks` (WS) | Code only | registry:8742, `epic/unary-schemas.ts:1188-1235,1479` |
| List agents in an epic (no sender) | `epic.listChatRecords` + `epic.listTuiAgents` (WS) | Code only | `chat-records.ts:93,153`; `tui-agent-records.ts:109-145` |
| List agents, full normalized row | `agent.list` (WS/CLI), needs a sender in the epic | **Live** for own epic; **cross-epic live = E_FORBIDDEN** | `agent/shared.ts:978-1262` |
| Activity across epics | `agent.activity.subscribe` | Code only | `agent/activity.ts:96-131` |
| Chat events | `chat.subscribe` | Code only | `agent/gui/subscribe.ts:253-290, 3007, 3400-3460` |
| Send user prompt (GUI chat) | `chat.subscribe` `send` frame, `sender.type="user"` | Code only; **needs live test T2/T3** | `subscribe.ts:4394-4417`; `chat-stream-client.ts:347-358` |
| Inter-agent message | `agent.sendMessage` / `traycer agent send` | Code-verified semantics (agent sender, inbox) | `agent/shared.ts:1505-1579`; `agent/inbox.ts:1-30`; `persistence/epic/senders.ts:60-75` |
| Send input to terminal | `terminal.subscribe` `write` frame | Code only; brittle | `terminal/subscribe.ts:114-140, 267-273` |
| Stop/interrupt | `agent.stop{epicId,agentId,cascade}` or chat `stop` frame | Code only | `agent/shared.ts:1610-1655`; `subscribe.ts:4450` |
| Discover approvals | `host.notifications.*` `approval.requested` (+ chat `approvalRequested`) | Code only | `host-notifications.ts:113-180` |
| Respond to approval | chat `approvalDecision{approvalId, decision{approved, reason?}}` | Code only; needs live T7 | `subscribe.ts:4555-4561`; `agent-runtime.ts:198` |
| TUI approval | none | Unavailable (no schema) | `agent/tui/unary-schemas.ts:336-418` |
| Create task | `traycer task create --json --idempotency-key` or `epic.create` | CLI help live; code-verified | `task-create.ts:260-279, 380-420` |
| Create agent in task | `epic.createChat` (GUI) / `epic.createTuiAgent` (TUI) | Code only | `epic/unary-schemas.ts:2259-2289`; registry:10238 |
| Focus desktop session | none supported (`traycer://` handles auth/callback only) | Code-verified unavailable | `deep-link.ts:26-118`; Info.plist |
| Host capabilities | `openAck.manifest` / `host.getRuntimeCapabilities` | Code only | registry:7687 |

---

## 7. Risks and notes

1. **Credential sharing.** The companion uses the user's full cloud bearer, which is scoped to the whole account. Keep it in memory only. Never log it. Never refresh it ourselves.
2. **Protocol drift.** The host auto-updates; `lastUpdateAttempt` shows "parked". A host update can raise per-method minors. Same-major minor bumps are bridged; a major bump yields `INCOMPATIBLE` with `upgradeGuidance`. The adapter must surface this as a capability loss and keep running.
3. **`active` is unreliable for TUI agents.** Prefer `agent.activity.subscribe` `turn`/`working`, and confirm with live test T1.
4. **Ownership.** Chat actions use `ownerActionFrameFields` (`subscribe.ts:248-252`), so only the owner can act. Personal tasks are fine.
5. Upstream has a `clients/mobile` client. It is likely the closest model of a "remote controller" and is worth a follow-up read for its chat-send and approval UX.

## 8. Open questions

1. Does the host accept a `clientIdentity.kind` other than desktop/cli/mobile, or must we identify as `"cli"`? Check the host-side epoch rule; the server code is not public. Test it with a read-only call.
2. What values do `epic.listTasks` `extensionPhaseVersion` and `extensionEpicVersion` expect? Check how Desktop/gui-app fills them.
3. Does `chat.subscribe` `send` from a non-Desktop client trigger exactly one user turn, and what `settings` must be supplied? Copy them from `epic.getChatRunSettings` so we do not change model or profile. Live test T2/T3.
4. Is `agent.stop` permitted from a socket with no agent context? It has no sender field, so it probably is. Live test T6.
5. How do TUI (Claude Code terminal) approvals surface, if at all? This is probably impossible without PTY scraping. Decide whether FM-1 supports GUI-chat approvals only.
6. Where is context-usage surfaced on `chat.subscribe` (snapshot versus a `blockDelta` usage event)?
7. Focus: is there an undocumented Desktop IPC or deep link in the closed-source build? Grepping `/Applications/Traycer.app/Contents/Resources/app.asar` for `open-url` handlers may confirm or refute this.

---

## Reviewer verification

Reviewer pass on 2026-11-17. Read-only. Clone at `.fm1-upstream/traycer`, `main` = `2937e711`, tag `host-v1.5.4` = `b7a5f5ca`. No host calls. Only key names of local files were read.

### Checked claims

| # | Claim | Verdict | Evidence / correction |
|---|---|---|---|
| 1 | Host bearer is the cloud token from `~/.traycer/cli/credentials`, and the CLI owns refresh | **CONFIRMED** | `clients/traycer-cli/src/internal/host-auth.ts:6-19`. The file has keys `refreshToken, savedAt, token, user` and mode `0600` (checked). `pid.json` has keys `hostId, layer0, pid, processStartIdentity, processStartTimeMs, startedAt, version(1.5.4), websocketUrl` (checked). |
| 2 | `agent.sendMessage` is inter-agent messaging, needs `senderAgentId`, and is distinct from chat `send` | **CONFIRMED** | `protocol/src/host/agent/shared.ts:1505-1537` (docstring, `senderAgentId`). `workspace` is added at `:1550` and `attachments` at `:1558-1566`, both in later minors. |
| 3 | User prompt = `chat.subscribe` client frame `kind:"send"` with `sender: userMessageSender`, `settings`, `accountContext`, `deliveryPolicy`, `worktreeIntent` | **PARTLY WRONG** (incomplete) | The cited block `subscribe.ts:4393-4417` is `chatSubscribeClientFrameSchemaOptionsBeforeInterview`, a frozen **old** line. The live line (`:5013-5070`) adds:<br>- **`sentFromHostId`**, required from `chat.subscribe@1.17` (`:5010-5016`);<br>- `browserAnnotations` (default `[]`, from 1.32);<br>- a steer-restart confirmation on `queueSteerNow` (1.40).<br>The open request also needs an explicit nullable **`resume`** from 1.19 (`:262-277`). At the tag, `chat.subscribe` `latestMinor` is **41**; on `main` it is 44. An implementation built from the report's field list fails validation on the live line. Build frames from the vendored schema at the tag, not from this report. |
| 4 | Ownership: "only the owner can act" because of `ownerActionFrameFields` | **WRONG / overstated** | `ownerActionFrameFields` (`subscribe.ts:247-251`) is just `hasBinaryPayload:false + epicId + chatId + clientActionId`. It is a field bundle, not an authorization rule. Permission is decided on the host, which is closed. |
| 5 | `agent.stop{epicId, agentId, cascade}` has no sender field | **CONFIRMED** | `shared.ts:1620-1645`. Whether the host authorizes it without agent context is still open question 4. |
| 6 | `epic.listTasks` needs `extensionPhaseVersion` / `extensionEpicVersion` with unknown values (open question 2) | **RESOLVED** | gui-app sends `String(CURRENT_PHASE_VERSION)` = `"1.0.0"` and `String(CURRENT_EPIC_VERSION)` = `"2.0.0"`, with `sort:"recent"` and `filters:null`. Sources: `clients/gui-app/src/lib/cloud-epic-tasks-query/query.ts:102-108`, `clients/shared/epic/epic-version.ts:1-3`. The values are the same at `host-v1.5.4`. |
| 7 | `agent.activity.subscribe` frames are `byEpic{working[], turn[]}`, with `servedBy` | **CONFIRMED** | `protocol/src/host/agent/activity.ts:96-114`. `servedBy` is `local\|cloud`. |
| 8 | CLI scoping is env-only, and `task create` refuses to run inside agent sessions | **CONFIRMED** (nuance) | `agent-context.ts:14-48`: `readEnvOrFlag(flag, "TRAYCER_EPIC_ID")`. The helper accepts a flag, but `index.ts` has no `--epic` option (grep). `task-create.ts:260-279` refuses to run and requires `--harness`/`--model`. |
| 9 | Focus is unsupported, and `traycer://` handles only `auth/callback` | **CONFIRMED** | `deep-link.ts:26-56`: "Other traycer deep links (e.g. session links) ... return `false`". `jumplist-commands.ts:37-46`: a second launch only calls `focusMainWindow()` and handles `--new-epic` / `--open-settings`. Bringing the window forward works; selecting a chat does not. |
| 10 | Line numbers cite `main`, and the tag-to-`main` changes are minor | **MISLEADING** | `git diff --stat host-v1.5.4 HEAD -- protocol/` reports **286 files, +41,772 / -2,067**. Registry lines differ, for example at the tag `epic.listTasks` is at `:8380`, not `:8742`, and `chat.subscribe` is at `:15943`. The host runs 1.5.4, so all vendoring and schema reading must use the **tag**. Every citation in this report needs to be re-checked against the tag. |
| 11 | Cross-epic `agent.list` returns `E_FORBIDDEN` | **UNVERIFIED** (not re-run) | Plausible from the schema (`senderAgentId` is required). It does not matter much, because the report already routes listing through `epic.listChatRecords` / `epic.listTuiAgents`. |

### Gaps for the spec

1. **Most sessions are probably TUI (terminal) agents.** The live `agent list` showed a TUI Claude agent. For TUI agents the report finds only two prompt paths:
   - PTY `write`;
   - `agent.sendMessage`, which needs an agent sender.

   `agent.tui.promptSubmitted` (`agent/tui/unary-schemas.ts:441-506`) is a `UserPromptSubmit` **hook report**, not a submit path. Do not mistake it for one. The core success path is "prompt reaches the correct Claude/Codex session". Spec T2/T3 must decide early whether TUI prompt delivery is PTY-write, marked unsupported, or limited to GUI chats only.
2. **Codex is not covered separately.** Is Codex usually a GUI chat or a TUI agent here? Which harnessId/model values does it use (`agent.tui.listHarnesses`, `agent list-harness-models`)?
3. **`listProjects` / NEW TASK project picker is unmapped.** `epic.create` needs `repoIdentifiers[]` and `workspaces[]` (`epic/unary-schemas.ts:570-581`; `@1.3` adds `owner`). Candidate sources such as `workspace.*` and `host.resolveRepoPaths` (`registry.ts:11716`) were not examined. The spec "Project" concept has no backing call yet.
4. **TUI recent output is missed.** `terminal.readOutput` (registry `:12055`) returns `{path}` to a file with the output (`terminal/output-format.ts:1-15`). `terminal.list` is also available. This partly covers spec 5.3 for TUI agents.
5. **Reconnection (spec 5.4) is not mapped event by event:**
   - task deletion: `epic.status.subscribe` `epicDeleted`;
   - archive: the `archived` fields;
   - host restart: the port changes, so re-read `pid.json`;
   - `credentialUpdate` on live streams;
   - `chat.subscribe` `resume` claim semantics.
6. **`approval.requested` notification payload shape is not dumped.** Can the console render an approval card from the notification alone, or must it open `chat.subscribe` for each chat?
7. **Normalized states `waiting_input` and `completed_unread`.** Their mapping is unstated. Candidates are `interview.requested` notifications and `readAt`.
