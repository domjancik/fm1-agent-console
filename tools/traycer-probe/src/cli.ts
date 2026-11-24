#!/usr/bin/env bun
/**
 * traycer-probe: thin CLI over @fm1/agent-adapter-traycer.
 *
 * Read-only: discover, list-tasks, list-agents, activity, transcript.
 * Mutating (send, stop, create-chat): refused unless --live is passed AND the
 * epic (and chat) is listed in reports/disposable-allowlist.json. Never prints the bearer.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TraycerAdapter, type ChatFrame, type ChatRunSettingsValue } from "@fm1/agent-adapter-traycer";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ALLOWLIST_PATH = join(REPO_ROOT, "reports", "disposable-allowlist.json");

// Vendored transport code logs diagnostics through console.*; keep stdout
// for this tool's JSON result only.
const writeStdout = (text: string): void => {
  process.stdout.write(text);
};
for (const level of ["log", "info", "debug", "warn"] as const) {
  console[level] = (...parts: unknown[]) => console.error(...parts);
}

function print(value: unknown): void {
  writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

let liveFlag = false;

async function assertDisposable(epicId: string, chatId: string | null): Promise<void> {
  if (!liveFlag) throw new Error("refusing: state-changing command needs --live");
  let allowlist: { tasks?: Array<{ epicId: string; chatIds?: string[] }> };
  try {
    allowlist = JSON.parse(await readFile(ALLOWLIST_PATH, "utf8"));
  } catch {
    throw new Error(`refusing: cannot read ${ALLOWLIST_PATH}`);
  }
  const task = allowlist.tasks?.find((entry) => entry.epicId === epicId);
  if (!task) throw new Error(`refusing: epic ${epicId} is not in the disposable allowlist`);
  if (chatId !== null && !(task.chatIds ?? []).includes(chatId)) {
    throw new Error(`refusing: chat ${chatId} is not in the disposable allowlist for ${epicId}`);
  }
}

function usage(): never {
  console.error(`usage: traycer-probe <command>
  discover
  list-tasks [limit]
  list-agents <epicId>
  activity [seconds=10]
  transcript <epicId> <agentId>
  send <epicId> <chatId> <text> --live [--timeout <sec>] [--frames]
  stop <epicId> <agentId> --live
  create-chat <epicId> <harnessId> <model> [reasoningEffort] --live [--message <text>]`);
  process.exit(2);
}

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1] ?? null;
  args.splice(index, value === null ? 1 : 2);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  liveFlag = hasFlag(args, "--live");
  const command = args.shift();
  if (command === undefined) usage();
  const adapter = await TraycerAdapter.connect();
  try {
    switch (command) {
      case "discover": {
        const handshake = await adapter.handshake();
        print({
          endpoint: {
            pid: adapter.endpoint.pid,
            hostId: adapter.endpoint.hostId,
            version: adapter.endpoint.version,
            websocketUrl: adapter.endpoint.websocketUrl,
            streamUrl: adapter.endpoint.streamUrl,
            startedAt: adapter.endpoint.startedAt,
          },
          clientIdentity: adapter.identityResolution,
          openAck: handshake,
          runtimeCapabilities: await adapter.runtimeCapabilities(),
        });
        return;
      }
      case "list-tasks": {
        const tasks = await adapter.listTasks({ limit: Number(args[0] ?? 50) });
        print({ count: tasks.length, tasks });
        return;
      }
      case "list-agents": {
        const epicId = args[0] ?? usage();
        const agents = await adapter.listAgents(epicId);
        print({ epicId, count: agents.length, agents });
        return;
      }
      case "activity": {
        const seconds = Number(args[0] ?? 10);
        const frames: unknown[] = [];
        const connection: string[] = [];
        const watcher = await adapter.watchActivity(
          (byEpic, servedBy) => frames.push({ at: new Date().toISOString(), servedBy, byEpic }),
          (event) => connection.push(event.status),
        );
        await Bun.sleep(seconds * 1000);
        watcher.close();
        print({ seconds, connection, frameCount: frames.length, frames });
        return;
      }
      case "transcript": {
        const [epicId, agentId] = [args[0] ?? usage(), args[1] ?? usage()];
        print(await adapter.getTranscript(epicId, agentId));
        return;
      }
      case "send": {
        const timeout = Number(flag(args, "--timeout") ?? 180);
        const dumpFrames = hasFlag(args, "--frames");
        const [epicId, chatId, text] = [args[0] ?? usage(), args[1] ?? usage(), args[2] ?? usage()];
        await assertDisposable(epicId, chatId);
        const frameKinds: string[] = [];
        const started = Date.now();
        const result = await adapter.sendPrompt(epicId, chatId, text, {
          timeoutMs: timeout * 1000,
          onFrame: (frame: ChatFrame) => {
            frameKinds.push(frame.kind);
            if (dumpFrames) console.error(JSON.stringify(summarizeFrame(frame)));
          },
        });
        print({ ...result, elapsedMs: Date.now() - started, frameKinds: countKinds(frameKinds) });
        return;
      }
      case "stop": {
        const [epicId, agentId] = [args[0] ?? usage(), args[1] ?? usage()];
        await assertDisposable(epicId, agentId);
        print({ epicId, agentId, response: await adapter.stop(epicId, agentId) });
        return;
      }
      case "create-chat": {
        const message = flag(args, "--message");
        const [epicId, harnessId, model] = [args[0] ?? usage(), args[1] ?? usage(), args[2] ?? usage()];
        await assertDisposable(epicId, null);
        const settings = {
          harnessId,
          model,
          permissionMode: "supervised",
          reasoningEffort: args[3] ?? null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
          ultracode: false,
        } as ChatRunSettingsValue;
        print(
          await adapter.createChat(epicId, {
            settings,
            title: "FM1 smoke codex (disposable)",
            ...(message === null ? {} : { initialMessage: message }),
          }),
        );
        return;
      }
      default:
        usage();
    }
  } finally {
    adapter.close();
  }
}

function countKinds(kinds: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

function summarizeFrame(frame: ChatFrame): unknown {
  switch (frame.kind) {
    case "turnStateChanged":
      return { kind: frame.kind, runStatus: frame.runStatus, activeTurn: frame.activeTurn };
    case "actionAck":
      return { kind: frame.kind, clientActionId: frame.clientActionId, action: frame.action, status: frame.status, reason: frame.reason, code: frame.code };
    case "blockDelta":
      return { kind: frame.kind, event: frame.event };
    case "messageAccepted":
      return { kind: frame.kind, message: frame.message };
    default:
      return { kind: frame.kind, keys: Object.keys(frame) };
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
