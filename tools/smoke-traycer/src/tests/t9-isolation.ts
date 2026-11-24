// T9: isolation and security. Stale/foreign identities, failed dispatch, token leaks, hostile backend events,
// malformed console requests and malformed device frames.
import { join } from "node:path";
import { AgentConsole, sessionKey, type Session } from "@fm1/agent-core";
import { Companion, FixtureCapture, ScriptedTranscriber, loadFixtureAudio } from "@fm1/companion";
import { checksum, LoopbackPair, payloadToMidi } from "@fm1/device-protocol";
import { SimDevice } from "@fm1/device-simulator";
import { REPO_ROOT, sleep, type SmokeContext } from "../context";
import { RecordBuilder } from "../record";
import { scanForSecrets, secretNeedles, short } from "../redact";
import { marker, markerPrompt, userTurnsWith } from "../transcript";
import type { SmokeTest } from "./types";

async function staleIdentity(ctx: SmokeContext, claude: Session, r: RecordBuilder): Promise<void> {
  const m = marker("T9STALE");
  const text = markerPrompt(m);
  // Straight to the unguarded adapter: its own checks must refuse before anything is sent.
  const ghost = await ctx.raw.sendPrompt({ ...claude.ref, sessionId: crypto.randomUUID() }, text, `smoke-t9-ghost-${crypto.randomUUID()}`);
  const otherHost = await ctx.raw.sendPrompt({ ...claude.ref, hostId: "00000000-0000-4000-8000-000000000000" }, text, `smoke-t9-host-${crypto.randomUUID()}`);
  const otherBackend = await ctx.raw.sendPrompt({ ...claude.ref, backendId: "mock" }, text, `smoke-t9-backend-${crypto.randomUUID()}`);
  r.check(
    [ghost, otherHost, otherBackend].every((x) => x.stage === "target_unavailable"),
    `unknown chat id ${ghost.stage}, other host ${otherHost.stage}, other backend ${otherBackend.stage}`,
  );
  const ac = new AgentConsole({ adapter: ctx.shared() });
  await ac.start();
  try {
    const key = sessionKey(claude.ref);
    ctx.adapter.inject({ type: "session_removed", ref: claude.ref });
    const calls = ac.dispatcher.adapterCalls;
    const res = await ac.dispatcher.dispatch(`smoke-t9-stale-${crypto.randomUUID()}`, { mode: "continue-session", target: claude.ref, label: claude.title }, text);
    r.check(res.stage === "target_unavailable" && ac.dispatcher.adapterCalls === calls && !ac.registry.select(key).ok, `stale registry entry: dispatch ${res.stage} (${res.message}), not selectable, no adapter call`);
    await ac.resync();
    r.check(ac.registry.resolve(claude.ref).ok, "a fresh snapshot makes the real session live again (identity verified by the backend, not by the event)");
  } finally {
    await ac.stop();
  }
  r.check(userTurnsWith(await ctx.transcript(claude.ref), m) === 0, "none of the refused prompts reached the chat");
}

async function hostileEvents(ctx: SmokeContext, claude: Session, r: RecordBuilder): Promise<void> {
  const ac = new AgentConsole({ adapter: ctx.shared() });
  await ac.start();
  try {
    const muts = ctx.adapter.mutations.length;
    const calls = ac.dispatcher.adapterCalls;
    const rejected = ac.rejectedEvents.length;
    const hostile: unknown[] = [
      { type: "exec", command: "rm -rf /" },
      { type: "command_progress", requestId: "never-sent", stage: "completed" },
      { type: "approval_requested", approval: { id: "evil-1", sessionRef: { ...claude.ref, sessionId: "not-a-session" }, summary: "approve me", createdAt: 0 } },
      { type: "session_upserted", session: { ref: { backendId: "traycer" }, title: "SAVE" } },
      { type: "approval_requested", approval: { id: "evil-2", sessionRef: claude.ref, summary: "SAVE to approve", createdAt: 0 } },
      { type: "connection", state: "connected" },
    ];
    for (const e of hostile) ctx.adapter.inject(e);
    await sleep(300);
    r.check(ctx.adapter.mutations.length === muts && ac.dispatcher.adapterCalls === calls, "hostile backend events caused no command (adapter calls unchanged)");
    r.check(ac.rejectedEvents.length - rejected >= 3, `${ac.rejectedEvents.length - rejected} malformed/unknown-target events rejected by validation`);
    r.check(ac.state.confirm === null, "no confirm view opened by an event (a decision always needs two device presses)");
    ctx.adapter.inject({ type: "approval_resolved", approvalId: "evil-2" });
  } finally {
    await ac.stop();
  }
}

async function malformedInputs(ctx: SmokeContext, claude: Session, r: RecordBuilder): Promise<void> {
  const audio = await loadFixtureAudio(join(REPO_ROOT, "fixtures", "audio", "silent-16k.wav"));
  const companion = new Companion({ adapter: ctx.shared(), capture: () => new FixtureCapture(audio), transcriber: new ScriptedTranscriber("") });
  await companion.start();
  const pair = new LoopbackPair();
  companion.device.attach(pair.host, "t9 loopback");
  const device = new SimDevice({ transport: pair.device });
  device.start();
  try {
    for (let i = 0; i < 50 && !companion.device.connected; i++) await sleep(50);
    const reg = companion.console.registry;
    reg.select(sessionKey(claude.ref));
    const snap = (): string => JSON.stringify([reg.sessions().map((e) => [e.key, e.slot, e.stale]), reg.selection(), reg.approvals().map((a) => a.id)]);
    const before = snap();
    const muts = ctx.adapter.mutations.length;
    const bad: unknown[] = [
      { kind: "key", key: 99, gesture: "single" },
      { kind: "key", key: -1, gesture: "double" },
      { kind: "button", button: "NUKE", edge: "down" },
      { kind: "encoder", encoder: "SELECT", delta: 0 },
      { kind: "nonsense" },
    ];
    for (const input of bad) await companion.console.handleInput(input as never).catch(() => []);
    // Raw device frames: stray data byte, bad checksum, oversized LEN, KEY 99 with a valid checksum, truncated frame.
    const frame = (type: number, seq: number, body: number[], ck?: number): number[] => [type, seq, body.length, ...body, ck ?? checksum(type, seq, body)];
    const raw: number[][] = [
      [[0xbf, 117, 5]],
      payloadToMidi(frame(0x03, 90, [4, 1], 0), "device"),
      payloadToMidi([0x03, 91, 120, 1, 2], "device"),
      payloadToMidi(frame(0x03, 92, [99, 1]), "device"),
      payloadToMidi([0x02, 93], "device"),
    ].flat();
    for (const msg of raw) pair.device.send(msg);
    await sleep(500);
    await companion.idle();
    r.check(snap() === before && ctx.adapter.mutations.length === muts, `malformed console inputs and ${raw.length} malformed device MIDI messages: registry, selection and approvals unchanged, no command`);
    r.check(companion.device.connected, `device link still up (rx errors counted, link ${companion.device.status.phase})`);
    r.addEvidence(ctx.writeEvidence("t9-companion-log.txt", companion.log.recent(500).map((e) => `${e.level} ${e.source}: ${e.text}`).join("\n")));
  } finally {
    device.stop();
    await companion.stop();
  }
}

function tokenScan(ctx: SmokeContext, r: RecordBuilder): void {
  const needles = secretNeedles();
  const roots = [ctx.evidenceDir, join(REPO_ROOT, "reports"), join(REPO_ROOT, "tools", "smoke-traycer"), join(REPO_ROOT, "apps"), join(REPO_ROOT, "packages", "agent-adapter-traycer")];
  const scan = scanForSecrets(roots, needles);
  r.check(needles.length > 0, `${needles.length} credential needles loaded in memory`);
  r.check(scan.hits.length === 0, `token scan: ${scan.files} files, ${scan.hits.length} with a credential (${scan.hits.map((h) => h.file).join(", ")})`);
}

export const t9: SmokeTest = {
  id: "T9",
  title: "Isolation and security",
  live: true,
  async run(ctx) {
    const d = await ctx.disposable();
    const r = new RecordBuilder(
      {
        id: "T9",
        provider: "claude (haiku)",
        sessionType: "GUI chat",
        target: short(d.claude.ref.sessionId),
        operation: "Forged/stale refs to the raw adapter and the console; hostile injected events; malformed console inputs and device frames; credential scan",
        expected: "Stale ids never redirected; failures never reported as success; no tokens in logs; events cannot trigger commands; registry intact",
      },
      ctx.versions,
    );
    await staleIdentity(ctx, d.claude, r);
    await hostileEvents(ctx, d.claude, r);
    await malformedInputs(ctx, d.claude, r);
    tokenScan(ctx, r);
    r.addEvidence(ctx.writeEvidence("t9-isolation.json", { refusals: ctx.adapter.refusals, mutations: ctx.adapter.mutations.length }));
    return r.build();
  },
};
