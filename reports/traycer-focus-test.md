# Traycer session-focus live test (priority update item 5)

Date: 2026-11-17, 21:01-21:03 local. Traycer Desktop 1.5.4 (pid 53373) and host 1.5.4 were not restarted, patched or reconfigured. No new task was created. The only chat that received input is the disposable chat.

- Disposable epic: `243c50b9-ac47-47d8-8254-c1292092c1bb`
- Disposable chat: `51b0ff2e-946b-40f7-98e5-3d0adaeec793` (claude/haiku), already in `reports/disposable-allowlist.json`. No new ids were added.
- Method: before each pathway, `open -a Finder` and confirm Finder is frontmost. Then run the pathway, wait 2-2.5 s, and measure:
  - (a) the frontmost process, via System Events.
  - (b) a screenshot, read by eye.
  - (c) the AX focused element.
- Desktop log: `~/Library/Application Support/Traycer/traycer-desktop.log`, filtered with `deep-link|jumplist|notificationClick`.

## Accessibility status

`osascript` has no Accessibility (assistive access) permission:

- `get name of every window` of process "Traycer" returns `System Events got an error: osascript is not allowed assistive access. (-1728)`.
- `AXFocusedUIElement` of process "Traycer" returns `Can't get attribute "AXFocusedUIElement" of process "Traycer". (-1728)`.

Window titles and the focused UI element therefore cannot be read. I did not try to grant the permission. Level (c) is BLOCKED for every pathway.

## Baseline

`reports/evidence/focus-baseline-0.png` shows Traycer frontmost. The window tab is "Project Implementation". The active tile is the user's real TUI agent "Implement Project Spec..." (epic ab47a5cf). No window or tab shows the disposable epic "FM1 smoke (disposable)". This is the condition the tests need: a different tile is active.

## Results: pathway × level

| Pathway | Command | (a) window activation | (b) disposable tile selected | (c) composer focus |
|---|---|---|---|---|
| T1 `open -a` | `open -a Traycer` | PASS: Finder, then Traycer | FAIL: the active tile is still the user's tile ([focus-T1-open-a-1.png](evidence/focus-T1-open-a-1.png)) | BLOCKED: AX denied. Visually, the caret is in the previously active (non-disposable) tile. |
| T2 AppleScript activate | `osascript -e 'tell application "Traycer" to activate'` | PASS: Finder, then Traycer | FAIL: unchanged ([focus-T2-osascript-activate-1.png](evidence/focus-T2-osascript-activate-1.png)) | BLOCKED: AX denied |
| T3 deep link | `open 'traycer://open/epic/243c50b9-.../chat/51b0ff2e-...?focus=composer'` | PASS: Finder, then Traycer. Log at `21:02:07.926`: `[deep-link] open-url { url: 'traycer://open/epic/243c50b9-ac47-47d8-8254-c1292092c1bb/chat/51b0ff2e-946b-40f7-98e5-3d0adaeec793' }`, with the query stripped. No further handling. | FAIL: unchanged, which confirms that 1.5.4 ignores non-auth links ([focus-T3-deeplink-1.png](evidence/focus-T3-deeplink-1.png)) | BLOCKED: AX denied |
| T4 `--open-settings` | `open -n -a Traycer --args --open-settings` | NOT RUN: optional, and it opens Settings in the user's live window | NOT RUN: by design it reaches level a only | NOT RUN |
| T5 notification click | agent finishes while unfocused, then a person clicks the toast | NOT RUN: needs a human click, and Traycer was in active use (never every window unfocused) | NOT RUN: expected b by code reading | NOT RUN |
| T6 keystroke probe | `System Events keystroke` | NOT RUN: AX denied. It would also type into whichever composer has focus, which is the user's real agent. | n/a | BLOCKED |
| P9 proposed deep link (patch) | `docs/upstream/traycer-deep-link.diff` | NOT RUN: the patch is not applied, and patching the app is not authorized | NOT RUN | NOT RUN |

Summary: every external pathway available today reaches level (a) only. No pathway selected the disposable tile.

## Acceptance chain (without the FM-1 simulator)

| Step | Result | Evidence |
|---|---|---|
| 1. Select the disposable chat | FAIL: no external pathway selects a tile (see the table above) | T1-T3 screenshots |
| 2. Focus pathway | PARTIAL: level (a) only | as above |
| 3. Submit the dictation-equivalent text through the probe | PASS: `bun src/cli.ts send <E> <C> "FM1_FOCUS_ACCEPT_1794942158132. Respond with exactly this marker. Do not modify files." --live`. Ack `accepted`, `messageAccepted: true`, turn `starting → running → completed`, reply = marker, 1.8 s, $0.025 (haiku). | [focus-accept-send.json](evidence/focus-accept-send.json) |
| 4. The focused tile shows the message | FAIL: the frontmost tile is still the user's own agent. The marker went to the correct chat (51b0ff2e) but is not visible, because that tile is not selected. | [focus-accept-after-send-1.png](evidence/focus-accept-after-send-1.png) |

## Conclusions

- **Prompt submission** works through the host WS RPC that the GUI uses (`chat.subscribe` client `send`). That RPC is undocumented but present. The CLI does not offer it. It is exact-session and verified live again here.
- **Session focus** with public or undocumented APIs reaches level (a), window activation, only. Level (b) needs new integration code, the deep-link patch in `docs/upstream/traycer-deep-link.diff`. Level (c) is expected from the existing composer autofocus on tile activation, but that is unverified.
- The full acceptance chain (simulator → select → focus → submit to the same visible session) is **not demonstrable** on stock Traycer 1.5.4.

## What a person must do to finish the remaining checks

1. Grant Accessibility to the terminal app that runs the tests, so level (c) can be read through `AXFocusedUIElement`. This is the user's decision.
2. Run T5 by hand: unfocus every Traycer window, send a prompt to the disposable chat, and click the "agent stopped" toast. Then screenshot. If AX is granted, also read the focused element.
3. To get level (b) without a person, build Desktop from `desktop-v1.5.4` with the patch applied. Do this as a separate dev build only, never by patching `/Applications/Traycer.app`. Then repeat T3.

## Patched build (2026-11-18): built and checked statically, not launched

The patched Desktop is built. Nobody has launched it yet: the installed Traycer.app holds the single-instance lock, and the orchestrator runs the live test.

- App: `/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched/out/Traycer FM1.app`
- Source: worktree `/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched` (detached at `desktop-v1.5.4` = `b7a5f5ca`, the version of the installed Desktop 1.5.4 and host 1.5.4) + `docs/upstream/traycer-deep-link.diff` + FM-1 build changes. Diff: `out/fm1-build.diff`. Script: `fm1-build.sh`.

### Build commands

```sh
cd /Users/dominikj/dev/personal/.fm1-upstream/traycer-1.5.4
git worktree add --detach ../traycer-patched desktop-v1.5.4
cd ../traycer-patched
git apply /Users/dominikj/dev/personal/fm1-agent-console/docs/upstream/traycer-deep-link.diff
# FM-1 edits: clients/desktop/package.json build {appId ai.traycer.desktop.fm1, productName "Traycer FM1",
#   extraMetadata {productName "Traycer", version 1.5.4}, publish null};
#   deep-link.ts skips setAsDefaultProtocolClient when TRAYCER_FM1_SIDE_BY_SIDE=1 (+1 test);
#   build-main-bundle.cjs defines TRAYCER_FM1_SIDE_BY_SIDE.
bun install --frozen-lockfile
cd clients/desktop
bun x vitest run src/electron-main/auth/__tests__/deep-link.test.ts \
  src/electron-main/ipc/__tests__/notification-target.test.ts src/electron-main/startup/__tests__/desktop-startup.test.ts
cp -p /Applications/Traycer.app/Contents/Resources/cli/darwin-arm64/{traycer,version.json} resources/cli/darwin-arm64/
bun scripts/set-deploy-target.cjs --target=production --version=1.5.4
TRAYCER_FM1_SIDE_BY_SIDE=1 bun run build:app
bun run prepack:check-cli && bun run prepack:check-icons && bun run prepack:check-tray
CSC_IDENTITY_AUTO_DISCOVERY=false bun x electron-builder --mac dir --arm64 --publish never -c.mac.identity=- -c.mac.notarize=false
ditto "release/mac-arm64/Traycer FM1.app" "../../out/Traycer FM1.app"
```

### Unit tests (vitest 5.0.4)

| Suite | Result |
|---|---|
| `auth/__tests__/deep-link.test.ts` | 12/12 pass: 7 existing, 4 from the patch, 1 FM-1 side-by-side test |
| `ipc/__tests__/notification-target.test.ts` + `startup/__tests__/desktop-startup.test.ts` | 40/40 pass |
| `ipc/__tests__/host-quit-bridge.test.ts`, `startup/__tests__/desktop-startup-none-mode.test.ts` | Fail to load with `Cannot bundle Node.js built-in "node:sqlite"`. They fail the same way on the unpatched tag, so the patch is not the cause. |

### Static checks

| Check | Result |
|---|---|
| `CFBundleIdentifier` | `ai.traycer.desktop.fm1`. Name and executable: `Traycer FM1`. |
| Version | `CFBundleShortVersionString` and `CFBundleVersion` 1.5.4. Asar `package.json` version 1.5.4. |
| Production baked | `dist/main/index.js`: `environment: "production"`, `appName: "Traycer"`, `protocolScheme "traycer"`, `releaseChannel "stable"`. Unreleased features off, the same as shipped. |
| userData | Asar `package.json` `productName: "Traycer"`. Electron's `init` sets userData from this, so it is `~/Library/Application Support/Traycer`, the same as the installed app. The runtime identity sets no userData override in production. |
| Patched code | `parseOpenChatUri` and `deliverOpenChatDeepLink` are in `dist/main/index.js`. So is `[deep-link] side-by-side build - not claiming default scheme`, as `else if (true)`. |
| Renderer | `Contents/Resources/renderer/{index.html,assets,pdfjs,sandbox}` |
| Native addon | `app.asar.unpacked/dist/main/native/trackpad_scroll_phase.node`. A universal x86_64+arm64 build, like the installed one. Main executable: arm64. |
| Bundled CLI | `Resources/cli/darwin-arm64/traycer`. sha256 identical to `/Applications/Traycer.app` (cli-v1.5.4). |
| Auto-update | No `app-update.yml`, so updater checks and the relocation prompt are off. |
| Signature | Ad-hoc. `codesign --verify --deep --strict` OK. Entitlements include `disable-library-validation`. |
| Default `traycer` handler | `ai.traycer.desktop` before and after the build (`LSCopyDefaultHandlerForURLScheme`). The explicit LSHandlers entry is intact. Nothing ran `lsregister -f`. |

### How the orchestrator runs the live test

Prerequisite: the host is healthy at 1.5.4. The host lifecycle mode is the default `background` (no `lifecycle-policy.json`), so quitting Desktop leaves the host and its agents running. If a quit dialog appears, choose **"Keep Running and Quit"**, never "Stop Host".

```sh
# 0. Note the current default handler (expect ai.traycer.desktop).
# 1. Quit the stock app (Cmd-Q, or):
osascript -e 'tell application id "ai.traycer.desktop" to quit'
#    Wait until no /Applications/Traycer.app/Contents/MacOS/Traycer process is left: pgrep -f '/Applications/Traycer.app/Contents/MacOS/Traycer$'
# 2. Launch the patched app (not as default handler; no lsregister -f):
open -a "/Users/dominikj/dev/personal/.fm1-upstream/traycer-patched/out/Traycer FM1.app"
#    Wait for its window; check the log: grep 'side-by-side build' ~/Library/Application\ Support/Traycer/traycer-desktop.log
#    Focus another app and leave another tile active, as in T1-T3.
# 3. Run the probe on the disposable chat only:
cd /Users/dominikj/dev/personal/fm1-agent-console
env -u TRAYCER_AGENT_ID -u TRAYCER_EPIC_ID -u TRAYCER_TERMINAL_SPAWN_TOKEN \
  bun packages/agent-adapter-traycer/scripts/focus-test.ts \
    --epic 243c50b9-ac47-47d8-8254-c1292092c1bb --chat 51b0ff2e-946b-40f7-98e5-3d0adaeec793
#    Expect result.level "tile+composer", after.frontApp "Traycer FM1",
#    deepLinkLog containing "[deep-link] open-url" then "[deep-link] open chat". Take a screenshot for (b).
# 4. Quit the patched app ("Keep Running and Quit" if asked):
osascript -e 'tell application id "ai.traycer.desktop.fm1" to quit'
# 5. Reopen the stock app and re-check the default handler:
open -b ai.traycer.desktop
```

Notes:
- The patched app uses the same userData and window-restore state as the stock app, so it opens the same windows and tiles.
- Level (c), the AX focused element and window title, still needs Accessibility permission for `osascript`. Without it the probe prints the `-1728` error, and (c) can only be judged visually or by a person typing.
- The patched app never claims `traycer://`. A bare `open traycer://…` during the test goes to LaunchServices' default (`ai.traycer.desktop`), which would relaunch the stock app. The adapter and the probe always use `open -a <patched app>`.

### Live run, 2026-11-18 10:33 (patched build): INCONCLUSIVE

- Stock Traycer.app quit cleanly with the host kept (`[host-quit] quit { mode: 'background', reason: 'host-kept' }`); host pid 69261 and its agents stayed up.
- `Traycer FM1.app` started (pid 51227), logged `[deep-link] side-by-side build - not claiming default scheme`, then nothing more. No window appeared. macOS `SecurityAgent` was frontmost: most likely the Keychain prompt for the "Traycer Safe Storage" item, since the ad-hoc signature differs from the installed app's.
- `focus-test.ts` reported `level: tile+composer`, but that is the adapter's claim after `open -a`; the app never handled the link (no `[deep-link] open-url` line). Not a pass.
- The frozen app ignored `quit`; it was terminated by pid and Traycer.app reopened (`open -b ai.traycer.desktop`). Default `traycer` handler checked afterwards.
- Next run needs the operator at the screen to answer the Keychain prompt (Allow once), or a build signed so it can read the item. Until then focus stays at window level.
