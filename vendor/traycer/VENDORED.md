# Vendored: Traycer protocol and client transport

| Field | Value |
|---|---|
| Source repo | https://github.com/traycerai/traycer |
| Tag | `host-v1.5.4` (same commit as `cli-v1.5.4` and `desktop-v1.5.4`) |
| Commit | `b7a5f5ca` ("Pick #3745 into release-v1.5.2: HTML comment bridge review notes (#3747)") |
| Why this tag | It matches the installed host, CLI and Desktop (all `1.5.4`, checked 2026-11-17) |
| License | MIT, see `LICENSE` (copied unchanged from the repo root) |
| Verified | 2026-11-17, by byte comparison against a worktree of the tag at `/Users/dominikj/dev/personal/.fm1-upstream/traycer-1.5.4` |

## What is here

- `protocol/` is upstream `protocol/` (`@traycer/protocol` 0.3.0), complete. Only test and lint files were left out: `__tests__/` directories, `.oxlintrc.json`, `eslint.config.mjs`, `oxlint.config.ts`, `scripts/` and `provider-auth.md`. Every remaining file is byte-identical to the tag (`diff -rq` shows only the omissions).
- `clients-shared/` is a subset of upstream `clients/shared/` (`@traycer-clients/shared`, private, MIT). It holds the transitive import closure of these files:
  - `host-transport/ws-rpc-client.ts` (WsRpcClient)
  - `host-transport/ws-stream-client.ts` (WsStreamClient)
  - `host-transport/chat-stream-client.ts`
  - `host-transport/agent-activity-stream-client.ts`
  - `host-transport/whatwg-ws-factory.ts` and `whatwg-stream-ws-factory.ts`
  - `host-transport/transport-config.ts`
  - `epic/epic-version.ts` and `epic/plain-text-content.ts`

  The closure is 33 files. Each one is byte-identical to the tag. `package.json.upstream` is upstream's `clients/shared/package.json`, renamed so that Bun does not treat it as a package; it uses `catalog:` versions.
- The only third-party runtime dependency the closure needs is `zod@4.6.7`, the version upstream pins.

## Files added by FM-1 (not from upstream)

- `package.json` declares `zod@4.6.7`, so `bun install` in this directory provides `node_modules/zod` to the vendored sources. It is not a root workspace member.
- `tsconfig.json` maps the upstream path aliases (`@traycer/protocol/*`, `@traycer/protocol/utils/*`, `@traycer-clients/shared/*`) onto this directory. These are the same aliases as upstream's `clients/shared/tsconfig.json`. Bun applies them at runtime, and tsc applies them when type-checking.
- `bun.lock` is the lockfile for the zod install.
- `VENDORED.md` is this file.

## Modifications

None. All upstream files are unmodified.

## How to re-vendor for a new host version

1. `git -C ../.fm1-upstream/traycer fetch --tags`, then add a worktree at the new `host-vX.Y.Z` tag.
2. Copy `protocol/` without the omissions listed above.
3. Recompute the closure from the entry points above. Follow every relative import and every `@traycer-clients/shared/*` and `@traycer/protocol/*` alias import, using the paths in `tsconfig.json`. Copy each file that this reaches.
4. Run `bun test packages/agent-adapter-traycer` and `bun run discover` in `tools/traycer-probe`.
