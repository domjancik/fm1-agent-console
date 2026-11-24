// Operator report 2026-11-19: "after selecting repo filter, not sure how to revert"; "it does not have all, cannot roll
// back". KNOB2 REPO must always reach "all", and a repo set implicitly by choosing a task goes when that choice is cleared.
import { describe, expect, test } from "bun:test";
import { AgentConsole } from "../src/console";
import { fixtureToSnapshot, type FixtureFile } from "../src/fixtures";
import { isTaskKey, taskKey } from "../src/identity";
import { MockAdapter } from "../src/mock-adapter";
import type { KeyMode } from "../src/split";
import { FakeTimers, RIG_EPOCH } from "./helpers";

const B = { backendId: "b", hostId: "h" };
const tk = (projectId: string, taskId: string): string => taskKey({ ...B, projectId, taskId });
type S = FixtureFile["sessions"][number];
const sess = (projectId: string, taskId: string, sessionId: string, state: string, ago: number): S => ({
  projectId,
  taskId,
  sessionId,
  title: `${sessionId} title`,
  provider: "claude",
  runtime: "chat",
  workspace: "/w",
  createdAt: RIG_EPOCH - ago,
  observed: { state, at: RIG_EPOCH - ago },
});

/** Three repos with one active task each (webapp's needs you, so it ranks first), and a quiet idle task in console. */
const fixture = (): FixtureFile => ({
  name: "repos",
  ...B,
  projects: [
    { projectId: "P", name: "console" },
    { projectId: "Q", name: "webapp" },
    { projectId: "R", name: "infra" },
  ],
  tasks: [
    { projectId: "P", taskId: "a", title: "Alpha task", updatedAt: RIG_EPOCH - 1000 },
    { projectId: "P", taskId: "d", title: "Delta quiet", updatedAt: RIG_EPOCH - 9000 },
    { projectId: "Q", taskId: "b", title: "Beta task", updatedAt: RIG_EPOCH - 2000 },
    { projectId: "R", taskId: "c", title: "Gamma task", updatedAt: RIG_EPOCH - 3000 },
  ],
  sessions: [
    sess("P", "a", "a1", "working", 1000),
    sess("P", "d", "d1", "idle", 9000),
    sess("Q", "b", "b1", "waiting_input", 2000),
    sess("R", "c", "c1", "working", 3000),
  ],
  approvals: [],
});

interface R {
  c: AgentConsole;
  t: FakeTimers;
  toasts: string[];
}

async function rig(keys: KeyMode, layout: "buddy" | "grouped" = "buddy", pins?: string[]): Promise<R> {
  const t = new FakeTimers();
  const c = new AgentConsole({ adapter: new MockAdapter(fixtureToSnapshot(fixture())), timers: t, now: () => RIG_EPOCH + t.now, settings: { keys }, layouts: { sessions: layout }, pins });
  await c.start();
  c.setProtocol(6);
  return { c, t, toasts: [] };
}
async function input(r: R, i: Parameters<AgentConsole["handleInput"]>[0]) {
  const acts = await r.c.handleInput(i);
  if (r.c.state.notice) r.toasts.push(r.c.state.notice.text);
  return acts;
}
const press = async (r: R, button: string) => {
  await input(r, { kind: "button", button: button as never, edge: "down" });
  await input(r, { kind: "button", button: button as never, edge: "up" });
};
const turn = (r: R, encoder: string, delta: number) => input(r, { kind: "encoder", encoder: encoder as never, delta });
const key = (r: R, k: number) => input(r, { kind: "key", key: k, gesture: "single" });
const toast = (r: R) => r.toasts.at(-1);

/** Tasks view (EDIT), tap the task: the operator's path in both key modes. */
async function chooseInTasks(r: R, task: string) {
  await press(r, "EDIT");
  await key(r, r.c.state.layouts.tasks.slots.indexOf(task));
  expect(r.c.view().view).toBe("sessions");
}

/** Turn KNOB2 n detents one way; each detent's repo, toast, title and KNOB2 legend cell. */
async function sweep(r: R, dir: number, n: number) {
  const out: { repo: string | null; toast: string | undefined; title: string; cell: string }[] = [];
  for (let i = 0; i < n; i++) {
    await turn(r, "K2", dir);
    const v = r.c.view();
    out.push({ repo: r.c.state.repoFilter, toast: toast(r), title: v.title, cell: v.legend[1] });
  }
  return out;
}

/** KNOB2 order: all, then repos by best tier: webapp (T1), console, infra (working, newest first). */
const ORDER = [null, "Q", "P", "R"];

function expectAllReachable(seen: Awaited<ReturnType<typeof sweep>>, from: string | null, dir: number) {
  const at = ORDER.indexOf(from);
  const want = seen.map((_, i) => ORDER[(((at + dir * (i + 1)) % 4) + 4) % 4] ?? null);
  expect(seen.map((x) => x.repo)).toEqual(want);
  const all = seen.find((x) => x.repo === null);
  expect(all).toBeDefined();
  expect(all?.toast).toBe("Repo: all");
  expect(all?.title).toBe("ACTIVE 3"); // no repo part
  for (const x of seen) expect(x.cell).toBe("REPO"); // the legend names the knob; the value is in the title/toast
}

describe("KNOB2 REPO always reaches all (operator report 2026-11-19)", () => {
  for (const keys of ["ranked", "split"] as const) {
    test(`${keys}: a task chosen in the Tasks view, then KNOB2 both ways several detents`, async () => {
      const cw = await rig(keys);
      await chooseInTasks(cw, tk("R", "c"));
      const from = cw.c.state.repoFilter;
      expect(from).toBe(keys === "ranked" ? "R" : null); // RANKED sets the task's repo implicitly; SPLIT does not
      expectAllReachable(await sweep(cw, 1, 6), from, 1);
      const ccw = await rig(keys);
      await chooseInTasks(ccw, tk("R", "c"));
      const start = ccw.c.state.repoFilter;
      expectAllReachable(await sweep(ccw, -1, 6), start, -1);
    });
  }

  test("split: a task chosen with its black key, then KNOB2 both ways several detents", async () => {
    const r = await rig("split");
    const slot = r.c.view().slots.findIndex((s) => s.title === "Gamma task");
    await key(r, slot);
    expect(r.c.state.split.task).toBe(tk("R", "c"));
    expectAllReachable(await sweep(r, 1, 6), null, 1);
    expectAllReachable(await sweep(r, -1, 6), ORDER[6 % 4]!, -1);
  });

  test("ranked: KNOB3 TASK also reaches all again (same cycle)", async () => {
    const r = await rig("ranked");
    await turn(r, "K3", 1);
    expect(r.c.state.taskFilter).not.toBeNull();
    const seen: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      await turn(r, "K3", -1);
      seen.push(r.c.state.taskFilter);
    }
    expect(seen).toContain(null);
  });
});

describe("a repo set implicitly by a task choice goes with it; a KNOB2 repo stays", () => {
  test("ranked: Tasks-view task, KNOB3 back to all clears the implicit repo (title without repo)", async () => {
    const r = await rig("ranked");
    await chooseInTasks(r, tk("R", "c"));
    expect(r.c.state).toMatchObject({ repoFilter: "R", repoKnob: null, taskFilter: tk("R", "c") });
    expect(r.c.view().title).toBe("ACTIVE 1 Gamma task");
    await turn(r, "K3", 1); // [all, Gamma]: past Gamma is all
    expect(r.c.state.taskFilter).toBeNull();
    expect(r.c.state.repoFilter).toBeNull();
    expect(toast(r)).toBe("Task: all");
    expect(r.c.view().title).toBe("ACTIVE 3");
  });

  test("ranked: a KNOB2 repo stays when the task chosen inside it is cleared", async () => {
    const r = await rig("ranked");
    await turn(r, "K2", -1); // infra
    expect(r.c.state).toMatchObject({ repoFilter: "R", repoKnob: "R" });
    await chooseInTasks(r, tk("R", "c"));
    await turn(r, "K3", 1);
    expect(r.c.state.taskFilter).toBeNull();
    expect(r.c.state.repoFilter).toBe("R");
    expect(r.c.view().title).toBe("ACTIVE 1 infra");
  });

  test("ranked Grouped: a folded task row sets the repo implicitly; KNOB3 back to all clears it", async () => {
    const r = await rig("ranked", "grouped");
    await turn(r, "K1", 1); // RECENT: the idle Delta task folds
    const at = r.c.state.layouts.sessions.slots.indexOf(tk("P", "d"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(isTaskKey(r.c.state.layouts.sessions.slots[at]!)).toBe(true);
    await key(r, at % 27);
    expect(r.c.state).toMatchObject({ taskFilter: tk("P", "d"), repoFilter: "P", repoKnob: null });
    while (r.c.state.taskFilter !== null) await turn(r, "K3", 1);
    expect(r.c.state.repoFilter).toBeNull();
  });

  test("ranked: another task in another repo replaces the implicit repo; clearing goes back to the KNOB2 repo", async () => {
    const r = await rig("ranked", "buddy", [tk("P", "a")]);
    await turn(r, "K2", 1); // webapp, by KNOB2
    for (let i = 0; i < 3; i++) await turn(r, "K1", 1); // PINNED: the Tasks view lists pinned tasks of every repo
    expect(r.c.state.scope).toBe("pinned");
    await chooseInTasks(r, tk("P", "a")); // the tap leaves PINNED for ALL
    expect(r.c.state).toMatchObject({ scope: "all", taskFilter: tk("P", "a"), repoFilter: "P", repoKnob: "Q" });
    while (r.c.state.taskFilter !== null) await turn(r, "K3", 1);
    expect(r.c.state.repoFilter).toBe("Q");
    expect(r.c.view().title).toBe("ALL 1 webapp");
  });

  test("split: ALL drops an implicit repo carried over from RANKED; a KNOB2 repo stays", async () => {
    const r = await rig("ranked");
    await chooseInTasks(r, tk("R", "c"));
    expect(r.c.state.repoFilter).toBe("R");
    r.c.setSettings({ keys: "split" });
    expect(r.c.state.split.chosen).toBe("all");
    await key(r, 1); // ALL (already chosen): clears the implicit repo
    expect(r.c.state).toMatchObject({ repoFilter: null, taskFilter: null });
    expect(r.c.view().title).toBe("ACTIVE 3");
    expect(r.c.state.taskRow.keys).toHaveLength(3);
    // A KNOB2 repo: ALL leaves it.
    await turn(r, "K2", 1);
    expect(r.c.state.repoFilter).toBe("Q");
    await key(r, r.c.view().slots.findIndex((s) => s.title === "Beta task"));
    await key(r, 1);
    expect(r.c.state.repoFilter).toBe("Q");
    expect(await key(r, 1)).toEqual([]); // ALL again with nothing implicit: nothing
  });

  test("split: tapping the chosen task again (back to ALL) clears an implicit repo", async () => {
    const r = await rig("ranked");
    await chooseInTasks(r, tk("R", "c"));
    r.c.setSettings({ keys: "split" });
    const slot = r.c.view().slots.findIndex((s) => s.title === "Gamma task");
    await key(r, slot); // choose Gamma
    expect(r.c.state.repoFilter).toBe("R");
    await key(r, slot); // again: ALL
    expect(r.c.state.split.chosen).toBe("all");
    expect(r.c.state.repoFilter).toBeNull();
  });
});
