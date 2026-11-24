// Independent view from the documented CLI: `traycer agent list --json --all`, scoped to one disposable task by
// naming one of its allowlisted chats as the (read-only) caller.
import { cleanEnv } from "../context";

export interface CliAgent {
  id: string;
  surface: string;
  harnessId: string;
  active: boolean;
  folderPaths: string[];
  permissionMode: string;
  model: string | null;
}

export async function cliAgents(epicId: string, callerChatId: string): Promise<CliAgent[]> {
  const env = { ...cleanEnv(), TRAYCER_EPIC_ID: epicId, TRAYCER_AGENT_ID: callerChatId };
  const p = Bun.spawn(["traycer", "agent", "list", "--json", "--all", "--no-progress"], { env, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o.type === "result");
  const data = line?.data as { agents?: Record<string, unknown>[] } | undefined;
  if (line?.status !== "ok" || !data?.agents) throw new Error(`traycer agent list failed: ${JSON.stringify(line?.error ?? out.slice(0, 200))}`);
  return data.agents.map((a) => ({
    id: String(a.id),
    surface: String(a.surface),
    harnessId: String(a.harnessId),
    active: a.active === true,
    folderPaths: Array.isArray(a.folderPaths) ? a.folderPaths.map(String) : [],
    permissionMode: String(a.permissionMode ?? ""),
    model: ((a.runConfig as { model?: { slug?: string } } | undefined)?.model?.slug) ?? null,
  }));
}
