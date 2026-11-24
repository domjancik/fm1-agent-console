# Discovery: Traycer Desktop session focus (priority update items 4, 5-research, 6)

Date: 2026-11-17. Scope: read-only. No Traycer task was created, no prompt sent, no host/Desktop restarted, no app patched. The draft patch is only a file; it was checked with `git apply --check` and never applied.

Builds on `docs/discovery/traycer.md` §2.9 (focus unsupported, `traycer://` handles only `auth/callback`). This doc adds the full click path, checks the installed build and the patch proposal.

## Sources

- Public source at tag `desktop-v1.5.4` = `host-v1.5.4` (`b7a5f5ca`): `/Users/dominikj/dev/personal/.fm1-upstream/traycer-1.5.4`. All line numbers below are for this tag.
- Installed build: `/Applications/Traycer.app`, `CFBundleShortVersionString` 1.5.4. The `app.asar` was extracted to `/Users/dominikj/dev/personal/.fm1-upstream/traycer-asar` (`package.json`: `@traycer-clients/desktop` 1.5.4). It contains only `dist/main/index.js` and `dist/preload/index.js`. The renderer (gui-app) is not in the asar, so gui-app claims come from public source only.
- Running processes: Desktop pid 53373 (no extra argv, so no `--remote-debugging-port`). Host 1.5.4, pid 69261.
- Desktop log: `~/Library/Application Support/Traycer/traycer-desktop.log`. It has no `[deep-link]` or `[jumplist]` entries yet.

## 1. How the GUI opens a chat tile (renderer)

| Piece | Location | What it does |
|---|---|---|
| `useEpicTileNavigation().openTile(intent)` | `clients/gui-app/src/hooks/epic/use-epic-tile-navigation.ts:21-31` | A React hook. Calls `openTileWithNavigation(intent, navigateNested, MANUAL_TILE_OPEN)`. It exists only inside the renderer React tree. No IPC or protocol entry point calls it. |
| `TileOpenIntent` | `clients/gui-app/src/lib/canvas/tile-open/intent.ts:78-88` | `{node: EpicCanvasTileRef, target: {tabId}\|{epicId}, gesture: "single"\|"double"\|"explicit"\|"host", modifiers, placement, dedupe, source}` |
| `openTile(state,node,preview,pane)` | `clients/gui-app/src/stores/epics/canvas/actions.ts:561` | A pure canvas-store reducer: focus an existing pane tab, or add a new one. |
| `chatLinkOpenIntent(tabId,node)` | `clients/gui-app/src/components/chat/build-chat-link-policy.ts:41-54` | A same-epic chat-link click: `gesture:"single"`, `source:"direct_ui"`. A cross-epic link instead calls `navigateToTabIntent(navigate, openOrFocusEpicIntent({epicId, focus:{focusArtifactId, focusedAt}}))` (`:287-299`), and the route-sync auto-open then opens the tile. |
| `useTraycerReferenceOpenHandler` | `clients/gui-app/src/markdown/components/use-traycer-reference-open.ts` | Parses no URLs. It handles the in-markdown tags `<traycer-spec>`, `<traycer-ticket>`, `<traycer-epic>` and `<traycer-chat>` (`markdown/plugins/const.ts:6-9`), which carry `epicId` and node id attributes. Same epic: `openTile({target:{epicId}, gesture:"single"})`. Cross epic: `openOrFocusEpicIntent` with `focusArtifactId = nodeId`. Nothing in gui-app parses `traycer://` links (grep finds only an auth comment in `lib/auth/auth-service.ts:4920`). |
| Composer focus | `clients/gui-app/src/components/chat/composer/composer-prompt-editor.tsx:528-556` | When a chat composer becomes `isActive` (`chatComposerFocused(isActive, paneFocused, tabSelected)`, `chat-composer.tsx:568`), the editor calls `focusActiveComposer()` on desktop. It skips this on the mobile app and when `paneActivationFocusIntent.shouldYieldAutoFocus()`. **So selecting the tile (level b) is expected to give composer focus (level c) as a side effect.** This must be verified live. |

## 2. Electron main: every path that can move the GUI

| Path | Code (tag) | Trigger | Result |
|---|---|---|---|
| `open-url` / `second-instance` deep link | `clients/desktop/src/electron-main/auth/deep-link.ts:72-114`. Identical code in the installed `index.js` at offset ~2.359 MB. | Any `traycer://` URL. `Info.plist` `CFBundleURLTypes` = `traycer`, and LaunchServices binds `traycer` to `ai.traycer.desktop`. | `deliver()` acts only on `auth/callback`, which calls `bridge.deliverAuthReturnSignal()` (focus the MRU window and nudge the device poll, `runner-ipc-bridge.ts:793-808`). Every other path is ignored. It logs `[deep-link] open-url` with the query stripped. macOS LaunchServices activates the app on `open <url>` before Electron sees the URL. |
| Jump-list `second-instance` | `app/jumplist-commands.ts:34-45`, wired in `startup/desktop-startup.ts:1069-1077`. Installed build identical. | A second launch of the binary (on macOS only with `open -n`). | Always `focusMainWindow()` (MRU window). With `--new-epic` it dispatches `epic.newWindow`; with `--open-settings` it dispatches `app.openSettings`. No epic or chat selection. |
| Native notification click | `notifications.ts:44-137` creates the `Notification`. `ipc/runner-ipc-bridge.ts:856-872` `deliverNotificationClick(payload)`. `ipc/notification-target.ts` `parseNotificationClickTarget` / `findWindowIdForOpenChat`. | The renderer asks main to show a toast for a host-feed row (`approval.requested`, `interview.requested`, `agent.stopped`, `agent.stalled`, `browser.human.needed`). The toast shows only when **no Traycer window is focused** (`notifications.ts:53-65`). | Main focuses the window that already holds the chat tile, or else the owner of the epic, or else the MRU window. It sends `runnerHost:event:notificationClick` to that window. In the renderer, `NotificationFocusBridge` (`gui-app/.../bridges/notification-focus-bridge.tsx`) calls `activate` and then `routeNotificationForHost`. Chat, approval and interview rows go through `routeEpicChatNotification` (`lib/notifications/payload.ts:956-1000`), which tries in order: focus the open chat tile (`routeOpenChatNotification`, `:1022-1111`, via `prepareSetActiveTileTabFocusTarget` and `existingEpicTabIntentWithNestedFocus`), restore a closed tile, or navigate to the epic with `focusArtifactId=chatId` (auto-open). **So an approval click opens the exact chat tile (level b, expected c).** Approval and interview rows need the origin host to match (`use-notification-activation.ts:44-54`). A legacy raw `{kind:"chat",epicId,chatId}` payload needs no origin host. |
| Tray epic click | `ipc/tray-ipc.ts` (`setEpicSelectedHandler`), `runner-ipc-bridge.ts:909-911` `deliverTrayEpicSelected`, renderer `bridges/runner-host-bridges.tsx:52` | The user clicks an epic in the menu-bar tray. | Focuses the owner or MRU window and opens the **epic**. It does not select a chat. |
| Host tray command | `runner-ipc-bridge.ts:781-783` | Tray host submenu | Settings or Doctor only. |
| Host streams to Desktop | `host.notifications.subscribe` and `feed.subscribe` client frames (`protocol/src/host/notifications/host-notifications.ts:1885-1930`) | n/a | The `presence` frames go **from Desktop to host** (`windowId`, `focused`, `entity`). No host frame tells Desktop to navigate. `desktop-presence.json` holds only a pid record. |

**Can an external client create a host notification?** No. The registry (`protocol/src/host/registry.ts`) has `host.notifications.{getConfig,setConfig,markRead,resolve,clearAll,list,markAllRead,indicatorState,subscribe,feed.subscribe,cloudFeed.*}`, and none of them creates a row. Rows come only from real host events. An external process can cause one indirectly, for example a disposable task's agent requests approval or finishes (`agent.stopped`). The toast then still needs (1) every Traycer window unfocused, (2) notification settings that allow it, and (3) a **user click** on the toast. A process could click the toast only through Accessibility UI scripting of Notification Center. That is fragile and needs TCC permission.

**Other checks on the installed build.** No `createServer`. The only `.listen(` is the Squirrel updater proxy. No `remote-debugging` switch. No `NSAppleScriptEnabled` and no AppleScript dictionary. No routes beyond the public source. The installed `index.js` matches the public tag for `deep-link.ts`, `jumplist-commands.ts`, `deliverNotificationClick` and `deliverTrayEpicSelected`.

**CLI.** `traycer --help` 1.5.4, `traycer task --help` and `traycer agent --help` have no `open`, `focus`, `reveal` or `show` command or flag. `traycer task create` has no `--open` flag either.

## 3. Pathway classification

Levels: (a) window activation only. (b) correct epic and chat tile selected. (c) keyboard focus in that chat's composer.

| # | Pathway | Max level | Status | Notes |
|---|---|---|---|---|
| P1 | `open -a Traycer` / `osascript -e 'tell application "Traycer" to activate'` | a | SUPPORTED-PUBLIC (OS) | Activates the app, so the last focused window and tile come forward. Gives c only if that chat was already the active tile. |
| P2 | `open 'traycer://open/epic/<E>/chat/<C>'` (or any non-auth `traycer://` URL) | a | UNDOCUMENTED-BUT-PRESENT | LaunchServices activates the app. Electron logs `[deep-link] open-url` and ignores the URL. |
| P3 | `open 'traycer://auth/callback'` | a | UNDOCUMENTED-BUT-PRESENT | Focuses the MRU window explicitly and nudges a device poll that is not running (no-op). Do not use in production; it is an auth path. |
| P4 | `open -n -a Traycer --args --open-settings` / `--new-epic` | a (+ Settings / new epic) | UNDOCUMENTED-BUT-PRESENT (Windows jump-list flags) | Spawns a short-lived second process that exits on the single-instance lock. `--new-epic` opens a new epic window, which is a side effect, so do not use it. |
| P5 | Tray epic click via System Events UI scripting | b-epic (no chat) | UNDOCUMENTED-BUT-PRESENT | Needs Accessibility permission. Selects the epic only. The chat stays unselected. |
| P6 | Native notification click (`approval.requested`, `agent.stopped`, ...) | b, expected c | PRESENT, user-gesture only | Exact tile is selected. Cannot be triggered externally without a real host event, every window unfocused, and a click. |
| P7 | In-app `<traycer-chat>` reference or chat link | b, expected c | PRESENT, in-renderer only | Not reachable from outside. |
| P8 | Any host RPC or stream that makes Desktop navigate | none | ABSENT | Presence goes Desktop to host only. |
| P9 | Proposed `traycer://open/epic/<E>/chat/<C>[?focus=composer]` | b, expected c | ABSENT (needs the patch below) | |

**Conclusion.** No public or undocumented external API selects a specific chat. External focus reaches level (a) only. Level (b/c) needs new integration code in Traycer Desktop.

## 4. Proposal: smallest upstream-compatible deep link

Draft patch (not applied): `/Users/dominikj/dev/personal/fm1-agent-console/docs/upstream/traycer-deep-link.diff`. 301 lines, 4 files, main process only. `git apply --check` passes against both `desktop-v1.5.4` and current `main` (`2937e711`).

Design: **replay the link as a legacy `chat` notification click.** The full path from main through the renderer to the exact tile already exists, is tested, and is shipped. The patch therefore needs no gui-app, preload or IPC-contract changes.

1. `clients/desktop/src/electron-main/auth/deep-link.ts`
   - New `parseOpenChatUri(uri)`. Accepts only `${PROTOCOL_SCHEME}://open/epic/<epicId>/chat/<chatId>`, with an optional trailing `/` and a query that is ignored (`?focus=composer` is an accepted hint, because the composer autofocuses on tile activation). Ids must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, which rejects `%`-escapes, dots, slashes and over-long ids.
   - `registerDeepLinkHandling(handler, openChatHandler = null)`. The existing auth behaviour is unchanged, and callers that pass only the auth handler keep ignoring open-chat links.
2. `clients/desktop/src/electron-main/ipc/runner-ipc-bridge.ts`. New `deliverOpenChatDeepLink({epicId, chatId})` that calls `this.deliverNotificationClick({kind:"chat", epicId, chatId})`. That leads to `findWindowIdForOpenChat`, then owner-or-MRU, then `focusAndDeliver`, then `NotificationFocusBridge`, then `routeEpicChatNotification`.
3. `clients/desktop/src/electron-main/startup/desktop-startup.ts`. Wires the handler. `BootState.pendingOpenChat` holds the latest link (last one wins) when it arrives before the bridge exists. It is drained on the first window's `did-finish-load`, the same way as `pendingAuthReturnSignal`. The renderer's tab navigation already queues activation until hydration.
4. `clients/desktop/src/electron-main/auth/__tests__/deep-link.test.ts`. Tests for parsing, rejection, and routing to the right handler.

Security:
- **Navigation only.** No prompt text, action, model or host parameter exists, so a link can never send, approve, stop or create anything.
- **User-scoped.** The renderer resolves ids against the signed-in user's open epics. An unknown id falls back to opening an epic that fails to load. Nothing leaks back to the caller, because `open-url` has no return channel.
- **Strict validation.** Ids go through a closed alphabet regex before they reach the renderer. The legacy `chat` route carries no feed id, so it never marks or acknowledges a notification row. It has no origin host, so it resolves through the effective host. This matches how plain chat rows already behave.
- **Log hygiene.** The existing `redactDeepLinkUrl` drops the query. The new log line logs no ids.
- **Abuse surface.** A web page can open `traycer://` links, and browsers show a confirmation prompt. The worst outcome is focus stealing to one of the user's own chats. Upstream may optionally add rate limiting or ignore links while a modal is open.
- `?focus=composer` is a hint only. Composer focus comes from the existing autofocus effect. A later change could make the hint explicit, for example by passing `focusComposer` through the payload.

## 5. Live tests to run (item 5)

Prerequisite: create a disposable task in `/Users/dominikj/dev/personal/fm1-agent-console-smoke` (record it in `reports/disposable-allowlist.json`), and get its `<E>` and `<C>`. Before each test, focus another app (for example Terminal) and leave another tile active in Traycer. Watch `tail -f ~/Library/Application\ Support/Traycer/traycer-desktop.log | grep -E 'deep-link|jumplist'`.

| Test | Command | Expected |
|---|---|---|
| T1 | `open -a Traycer` | a |
| T2 | `osascript -e 'tell application "Traycer" to activate'` | a |
| T3 | `open 'traycer://open/epic/<E>/chat/<C>?focus=composer'` | a. Log shows `[deep-link] open-url url=traycer://open/epic/<E>/chat/<C>`. The tile does **not** change. |
| T4 | `open -n -a Traycer --args --open-settings` | a + Settings. Log `[jumplist] dispatching second-instance command`. Optional; it has a side effect. |
| T5 | Disposable agent finishes while Traycer is unfocused, then a human clicks the toast | b, expected c. Proves the target path that the patch reuses. |
| T6 (composer check) | After T5, `osascript -e 'tell application "System Events" to keystroke "fm1-marker"'` with no Enter | Text appears in `<C>`'s composer, which shows level c. Delete it manually. Needs Accessibility permission. |
