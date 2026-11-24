// One acceptance pass, device controls only: pick the task, pick the chat, double-press to focus, hold REC,
// review, SAVE. Every step is checked against the simulator's screen state and the companion's /api/state;
// delivery is checked against the backend transcript.
import { join } from "node:path";
import { sessionKey, type Session } from "@fm1/agent-core";
import { selectedKey as deviceSelected, type DeviceState, type ScriptedDriver, type SimDevice } from "@fm1/device-simulator";
import { sleep, type SmokeContext } from "../context";
import { userMessages } from "../transcript";
import { selectedKey, type CompanionProcess } from "./companion-proc";
import { activate, dumpLayout, frontmostApp, screenshot } from "./shots";

export interface FlowResult {
  provider: string;
  chatId: string;
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  timings: Record<string, number | null>;
  focusLevel: string;
  transcript: string;
  evidence: string[];
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

class Steps {
  readonly list: FlowResult["steps"] = [];
  ok = true;
  add(step: string, ok: boolean, detail: string): boolean {
    this.list.push({ step, ok, detail });
    if (!ok) this.ok = false;
    return ok;
  }
}

/** Time from `act()` until the device state satisfies `pred`. */
async function timed(driver: ScriptedDriver, act: () => void | Promise<void>, pred: (s: DeviceState) => boolean, timeoutMs: number): Promise<number | null> {
  const t0 = performance.now();
  const wait = driver.waitFor(pred, timeoutMs).then(
    () => Math.round(performance.now() - t0),
    () => null,
  );
  await act();
  return wait;
}

/** EDIT -> page through tasks with OCT+ -> press the key whose label matches the task. */
async function openTask(device: SimDevice, driver: ScriptedDriver, ui: CompanionProcess, taskTitle: string, s: Steps): Promise<boolean> {
  await driver.tap("HOME");
  await driver.tap("EDIT");
  await driver.waitFor((d) => d.view.view === "tasks", 3000);
  // The tasks view remembers its page: go back to the first one.
  for (let i = 0; i < 20 && device.state.view.page > 0; i++) {
    const p = device.state.view.page;
    await driver.tap("OCT_DOWN");
    await driver.waitFor((d) => d.view.page === p - 1, 2000).catch(() => null);
  }
  const label = clip(taskTitle, 12);
  for (let page = 0; page < 20; page++) {
    await sleep(150);
    const keys = device.state.slots.flatMap((x, i) => (x.label === label ? [i] : []));
    for (const k of keys) {
      await driver.press(k);
      const st = await driver.waitFor((d) => d.view.view === "sessions", 2000).catch(() => null);
      if (st && st.view.title === clip(`T:${taskTitle}`, 20)) return s.add("open task", true, `tasks page ${page + 1}, key ${k}: view "${st.view.title}"`);
      await driver.tap("EDIT");
    }
    if (device.state.view.page + 1 >= device.state.view.pages) break;
    await driver.tap("OCT_UP");
    await driver.waitFor((d) => d.view.page === page + 1, 2000).catch(() => null);
  }
  void ui;
  return s.add("open task", false, `no task key labelled "${label}"`);
}

export async function acceptanceFlow(
  ctx: SmokeContext,
  device: SimDevice,
  driver: ScriptedDriver,
  ui: CompanionProcess,
  target: Session,
  taskTitle: string,
  outDir: string,
  rel: (p: string) => string,
  simUrl: string,
): Promise<FlowResult> {
  const s = new Steps();
  const timings: Record<string, number | null> = {};
  const evidence: string[] = [];
  const want = sessionKey(target.ref);
  const tag = target.provider;
  const res = (focusLevel: string, transcript = ""): FlowResult => ({ provider: tag, chatId: target.ref.sessionId, ok: s.ok, steps: s.list, timings, focusLevel, transcript, evidence });

  if (!(await openTask(device, driver, ui, taskTitle, s))) return res("none");

  // Select the chat: single press on the key whose label matches; verified on the device and in the companion.
  const label = clip(target.title, 12);
  let key = -1;
  await driver.waitFor((d) => d.slots.some((x) => x.label === label), 3000).catch(() => null);
  for (const k of device.state.slots.flatMap((x, i) => (x.label === label ? [i] : []))) {
    const ms = await timed(driver, () => driver.press(k), (d) => d.slots[k]?.flags.selected === true, 3000);
    if (selectedKey(await ui.state()) === want) {
      key = k;
      timings.key_press_to_selected_ms = ms;
      break;
    }
  }
  const detail0 = device.state.detail.lines[0];
  if (!s.add("select chat", key >= 0 && deviceSelected(device.state) === key, `key ${key}, device detail "${detail0}", companion selection ${key >= 0 ? "matches" : "does not match"} ${want.split("/").pop()}`)) return res("none");
  timings.gesture_window_ms = 300;

  // Focus: double press. Finder first, so window activation is observable.
  await activate("Finder");
  await sleep(800);
  const before = await frontmostApp();
  const resultsBefore = device.state.lastResult?.atMs ?? -1;
  const focusMs = await timed(driver, () => driver.press(key, "double"), (d) => (d.lastResult?.atMs ?? -1) !== resultsBefore, 5000);
  await sleep(1200);
  const after = await frontmostApp();
  const fr = device.state.lastResult;
  timings.double_press_to_focus_result_ms = focusMs;
  const level = after === "Traycer" && before !== "Traycer" ? "a (window activated)" : "none";
  s.add("focus", fr !== null && fr.result !== "failed" && after === "Traycer", `device result ${fr?.result} "${fr?.text}"; frontmost ${before} -> ${after}; level ${level}; tile selection needs the upstream deep link (not enabled)`);

  // REC push-to-talk with the fixture capture.
  const recMs = await timed(driver, () => device.button("REC", true), (d) => d.voice.voice === "recording", 3000);
  timings.rec_down_to_recording_ms = recMs;
  await sleep(1500);
  const reviewMs = await timed(driver, () => device.button("REC", false), (d) => d.voice.voice === "reviewing", 30_000);
  timings.rec_release_to_transcript_ms = reviewMs;
  const st = await ui.state();
  const transcript = st.voice.transcript;
  // The UI shows the full title; the device protocol clips the target to 20 characters.
  const targetOk = st.voice.target === target.title && device.state.voice.target === clip(target.title, 20) && selectedKey(st) === want;
  if (!s.add("review", reviewMs !== null && transcript.length > 0 && targetOk, `voice ${st.voice.state}, target "${st.voice.target}", transcript "${transcript}"`)) {
    await driver.tap("FX");
    return res(level, transcript);
  }
  const uiShot = join(outDir, `${tag}-companion-ui-review.png`);
  const simShot = join(outDir, `${tag}-simulator-review.png`);
  const okUi = await screenshot(ui.url, uiShot);
  const okSim = await screenshot(simUrl, simShot, "1200,900");
  const dump = join(outDir, `${tag}-simulator-layout-review.json`);
  dumpLayout(device.state, dump, 0);
  evidence.push(...[okUi ? uiShot : null, okSim ? simShot : null, dump].filter((x): x is string => x !== null).map(rel));
  s.add("screenshots", okUi && okSim, `companion UI ${okUi}, simulator ${okSim}, layout dump written`);

  // SAVE -> backend ack, then the transcript must hold exactly one new user turn with that text.
  const beforeTurns = userMessages(await ctx.transcript(target.ref));
  const saveMs = await timed(driver, () => driver.tap("SAVE"), (d) => d.voice.voice === "delivered" && d.lastResult?.result === "acknowledged", 20_000);
  timings.save_to_backend_ack_ms = saveMs;
  let afterTurns = beforeTurns;
  for (let i = 0; i < 20 && afterTurns.length === beforeTurns.length; i++) {
    await sleep(500);
    afterTurns = userMessages(await ctx.transcript(target.ref));
  }
  const added = afterTurns.slice(beforeTurns.length);
  s.add("delivered", saveMs !== null && device.state.voice.voice === "delivered", `device voice ${device.state.voice.voice}, last result ${device.state.lastResult?.result} "${device.state.lastResult?.text}"`);
  s.add("exactly one turn", added.length === 1 && added[0]?.trim() === transcript.trim(), `${added.length} new user turn(s); text ${added[0]?.trim() === transcript.trim() ? "matches" : "differs"}`);
  const doneShot = join(outDir, `${tag}-simulator-delivered.png`);
  if (await screenshot(simUrl, doneShot, "1200,900")) evidence.push(rel(doneShot));
  dumpLayout(device.state, join(outDir, `${tag}-simulator-layout-delivered.json`), 0);
  evidence.push(rel(join(outDir, `${tag}-simulator-layout-delivered.json`)));

  // The dictated text asks for real work; stop the disposable agent so it does not keep running.
  const stop = await ctx.adapter.interrupt(target.ref, `smoke-e2e-stop-${crypto.randomUUID()}`);
  s.add("cleanup", stop.stage === "completed", `interrupt ${stop.stage}${stop.message ? ` (${stop.message})` : ""}`);
  return res(level, transcript);
}
