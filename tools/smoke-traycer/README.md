# @fm1/smoke-traycer

Live checks against the installed Traycer host 1.5.4. Results go to `reports/traycer-smoke.md`, `reports/e2e.md` and `reports/evidence/e2e/`.

| Command | What it does | State changes |
|---|---|---|
| `bun tools/smoke-traycer/src/cli.ts --read-only` (or `fm1-console test traycer --read-only`) | T0 discovery | none |
| `bun tools/smoke-traycer/src/cli.ts --live [--only T2,T7] [--no-report]` (or `fm1-console test traycer --live [-- --only T2]`) | spec 6 T0–T9 through `TraycerAgentAdapter` | only on `reports/disposable-allowlist.json` targets |
| `bun tools/smoke-traycer/src/cli.ts --live --only TUI-A2A --a2a-self` (the smoke context pins `tuiRoute: "a2a"`) | TUI-A2A with the companion's default route: the receiver sends as itself (`a2aSelfSend`, no `a2aSender`) | one marker prompt to the allowlisted throwaway Claude TUI |
| `bun tools/smoke-traycer/src/tui-typing.ts peek\|watch <agentId>` | read-only: attach to an allowlisted TUI's terminal as a `cache` viewer, rebuild the screen, classify it (idle/busy/draft/dialog/unknown) | none |
| `bun tools/smoke-traycer/src/tui-typing.ts type\|adapter <agentId> --text T --live` | the typing route (docs/traycer-integration.md, "prompts typed into the terminal"): `type` runs `deliverTyped` alone, `adapter` the full `sendPrompt` behind `GuardedAdapter` (a2a self-send fallback); `raw ... --force` is the low-level experiment write | one typed prompt to an allowlisted throwaway TUI; agents outside the allowlist are refused before connecting |
| `bun tools/smoke-traycer/src/transcript-size.ts --agent <id or prefix> [--epic <id>]` | read-only: the adapter's terminal-details path (`watchSession` → `agent.getTranscript`) on one terminal session; prints sizes only (transcript, lastMessage, lastPrompt, summary), never text | none |
| `bun tools/smoke-traycer/src/e2e.ts --live` | simulator on virtual MIDI, companion process (`start --sim --adapter traycer --fixture-audio smoke-16k.wav`), device-only flow for the claude and codex disposable chats; writes `reports/e2e.md` | sends the dictated fixture text to both chats, then stops them |
| `bun tools/smoke-traycer/src/emu-live.ts` | real firmware package in fm1-emu (`--usb --midi none`) linked to `fm1-console start --emu` | none |

Run with `env -u TRAYCER_AGENT_ID -u TRAYCER_EPIC_ID -u TRAYCER_TERMINAL_SPAWN_TOKEN` so the CLI acts as the user and not as an agent.

## Safety

- `GuardedAdapter` (`src/guard.ts`) refuses every state-changing call unless `--live` is set and its target is allowlisted. `createTask` is allowed only in the project `ws:/Users/dominikj/dev/personal/fm1-agent-console-smoke`. The few calls in T9 that go straight to the raw adapter use forged ids, which the adapter must refuse before it sends anything.
- New disposable tasks (T5) and chats (T7) are added to the allowlist before any prompt is sent to them.
- Models are the adapter defaults: claude `haiku`, codex `gpt-5.6-luna` low.
- The bearer token is read only by `CredentialSource`. `src/redact.ts` loads token values in memory just to scan the evidence for leaks, and reports file names and counts only.
- The e2e and emu scripts never open the microphone (`FixtureCapture`) and never open the real FM-1 port. They also refuse to start if a `FM1 CONSOLE (sim|emu)` port already exists.

## Tests

`bun test tools/smoke-traycer` runs offline unit tests for the guard, the allowlist, transcript parsing, records, the secret scan and test selection.
