// Browser side of the companion UI. Plain DOM; all data is written with textContent (no HTML injection).
import type { CommandReply, ServerPush, UiCommand, UiConfig, UiState } from "../contract";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let ws: WebSocket | null = null;
let state: UiState | null = null;
let nextId = 1;
const waiting = new Map<number, (r: CommandReply) => void>();
let editTimer: ReturnType<typeof setTimeout> | null = null;

function send(cmd: UiCommand): Promise<CommandReply> {
  const sock = ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "not connected" });
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    sock.send(JSON.stringify({ ...cmd, id }));
  });
}

function text(el: HTMLElement, value: string, cls?: string): void {
  el.textContent = value;
  if (cls !== undefined) el.className = cls;
}

function li(content: string, cls = ""): HTMLLIElement {
  const e = document.createElement("li");
  e.textContent = content;
  if (cls) e.className = cls;
  return e;
}

const STATE_CLASS: Record<string, string> = {
  working: "ok", completed_unread: "ok", idle: "muted", completed_read: "muted",
  approval_required: "warn", waiting_input: "warn", failed: "bad", disconnected: "bad", unknown: "muted",
};

function renderStatus(s: UiState): void {
  const b = s.backend;
  text($("backend"), `${b.name ?? b.adapterId}: ${b.connection}${b.ready ? "" : " (not synced)"}`, b.connection === "connected" ? "ok" : b.connection === "degraded" ? "warn" : "bad");
  const d = s.device;
  const extra = [d.transport, d.proto ? `proto ${d.proto}` : null, d.firmware ? `fw ${d.firmware}` : null, d.rxErrors ? `${d.rxErrors} rx errors` : null, d.reason]
    .filter(Boolean)
    .join(" · ");
  text($("device"), `${d.phase}${extra ? ` (${extra})` : ""}`, d.phase === "connected" ? "ok" : d.phase === "waiting" ? "warn" : "bad");
  const details = (s.view.details ?? []).filter((l) => l !== "");
  text($("dview"), `${s.view.name}: ${s.view.title}${s.view.status ? ` · ${s.view.status}` : ""}${s.view.attention ? ` · ${s.view.attention} need attention` : ""}${details.length ? ` · ${details.join(" / ")}` : ""}`);
  text($("legend"), s.view.legend.map((l, i) => `K${i + 1}:${l || "--"}`).join("  "));
  const caps = $("caps");
  caps.replaceChildren(
    ...s.backend.capabilities.map((c) =>
      li(`${c.supported ? "yes" : "no "}  ${c.name}${c.supported ? ` (${c.verified})` : ` - ${c.reason ?? "unsupported"}`}`, c.supported ? "" : "muted"),
    ),
  );
  const sim = $<HTMLAnchorElement>("sim-link");
  sim.hidden = !s.simulatorUrl;
  if (s.simulatorUrl) sim.href = s.simulatorUrl;
}

function renderVoice(s: UiState): void {
  const v = s.voice;
  text($("vstate"), `${v.state.toUpperCase()}${v.source === "suggested" || v.source === "canned" ? ` (${v.source})` : ""}`, v.state === "failed" || v.state === "target_unavailable" ? "bad" : v.state === "delivered" ? "ok" : "");
  text($("vtarget"), v.target ?? "(none)");
  $("vlevel").style.width = `${v.level}%`;
  text($("velapsed"), `${(v.elapsedDs / 10).toFixed(1)} s`);
  const ta = $<HTMLTextAreaElement>("transcript");
  ta.disabled = !v.editable;
  // Never clobber what the user is typing; the server echoes our edit anyway.
  if (document.activeElement !== ta || !v.editable) ta.value = v.transcript;
  $<HTMLButtonElement>("save").disabled = !v.canSave;
  $<HTMLButtonElement>("cancel").disabled = !v.canCancel;
  const err = $("verror");
  err.hidden = !v.error;
  err.textContent = v.error ?? "";
  $("stages").replaceChildren(
    ...s.dispatch.stages.map((st) => li(`${new Date(st.at).toLocaleTimeString()}  ${st.stage}${st.message ? ` - ${st.message}` : ""}`, st.stage === "failed" || st.stage === "target_unavailable" || st.stage === "unsupported" ? "bad" : "")),
  );
}

function renderTasks(s: UiState): void {
  const box = $("tasks");
  if (s.tasks.length === 0) {
    box.replaceChildren(li("No tasks (backend down or empty)", "muted"));
    return;
  }
  box.replaceChildren(
    ...s.tasks.map((t) => {
      const div = document.createElement("div");
      div.className = "task";
      const title = document.createElement("div");
      title.className = "task-title";
      title.textContent = `${t.title} (${t.sessions.length})`;
      const ul = document.createElement("ul");
      ul.className = "sessions";
      for (const ses of t.sessions) {
        const row = document.createElement("li");
        row.className = [ses.selected ? "selected" : "", ses.stale ? "stale" : ""].join(" ").trim();
        const name = document.createElement("span");
        name.textContent = `${ses.title} · ${ses.provider}/${ses.runtime}${ses.summary ? ` · ${ses.summary}` : ""}${ses.next?.[0] ? ` · Next: ${ses.next[0]}` : ""}`;
        const st = document.createElement("span");
        st.textContent = `${ses.state}${ses.inferred ? "?" : ""}`;
        st.className = STATE_CLASS[ses.state] ?? "";
        row.append(name, st);
        ul.append(row);
      }
      div.append(title, ul);
      return div;
    }),
  );
}

let configDirty = false;
/** The layouts the form last showed: a save sends only the ones the operator changed, so SEQ on the device meanwhile is kept. */
let shownLayouts: UiConfig["layouts"] = { sessions: "", inbox: "" };
function renderConfig(s: UiState): void {
  if (configDirty) return;
  const c = s.config;
  shownLayouts = { ...c.layouts };
  $<HTMLInputElement>("c-mic").value = c.micDeviceUid ?? "";
  $<HTMLSelectElement>("c-asr").value = c.asrEngine;
  $<HTMLInputElement>("c-lang").value = c.language;
  $<HTMLInputElement>("c-vocab").value = c.vocabularyFile ?? "";
  $<HTMLInputElement>("c-deeplink").checked = c.focusDeepLink;
  $<HTMLInputElement>("c-a2aself").checked = c.a2aSelfSend ?? true;
  $<HTMLSelectElement>("c-provider").value = c.defaults.provider;
  $<HTMLInputElement>("c-model").value = c.defaults.model ?? "";
  $<HTMLSelectElement>("c-layout-sessions").value = c.layouts.sessions;
  $<HTMLSelectElement>("c-layout-inbox").value = c.layouts.inbox;
  shownKeys = c.settings?.keys ?? "ranked";
  $<HTMLSelectElement>("c-keys").value = shownKeys;
  // SPLIT needs protocol 6 on the device; with an older firmware a saved Split shows the keys as Ranked.
  const proto = s.device.proto;
  text($("c-keys-note"), proto !== null && proto < 6 ? "needs firmware v6 (device shows Ranked)" : "", "muted");
}
let shownKeys = "ranked";

function renderLog(s: UiState): void {
  const pre = $("log");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = s.log.map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.source.padEnd(7)} ${e.text}`).join("\n");
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function render(s: UiState): void {
  state = s;
  renderStatus(s);
  renderVoice(s);
  renderTasks(s);
  renderConfig(s);
  renderLog(s);
}

async function flushEdit(): Promise<void> {
  if (!editTimer) return;
  clearTimeout(editTimer);
  editTimer = null;
  await send({ t: "edit", text: $<HTMLTextAreaElement>("transcript").value });
}

async function save(): Promise<void> {
  if (!state?.voice.canSave) return;
  await flushEdit();
  await send({ t: "save" });
}

async function cancel(): Promise<void> {
  if (!state?.voice.canCancel) return;
  if (editTimer) clearTimeout(editTimer);
  editTimer = null;
  await send({ t: "cancel" });
}

function wire(): void {
  const ta = $<HTMLTextAreaElement>("transcript");
  ta.addEventListener("input", () => {
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => void flushEdit(), 250);
  });
  $("save").addEventListener("click", () => void save());
  $("cancel").addEventListener("click", () => void cancel());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      void cancel();
    }
  });
  const changedLayouts = (): Partial<UiConfig["layouts"]> => {
    const out: Partial<UiConfig["layouts"]> = {};
    const sessions = $<HTMLSelectElement>("c-layout-sessions").value;
    const inbox = $<HTMLSelectElement>("c-layout-inbox").value;
    if (sessions !== shownLayouts.sessions) out.sessions = sessions;
    if (inbox !== shownLayouts.inbox) out.inbox = inbox;
    return out;
  };
  const form = $<HTMLFormElement>("config");
  form.addEventListener("input", () => (configDirty = true));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = (id: string): string => $<HTMLInputElement>(id).value.trim();
    const patch = {
      micDeviceUid: val("c-mic") || null,
      asrEngine: $<HTMLSelectElement>("c-asr").value,
      language: val("c-lang"),
      vocabularyFile: val("c-vocab") || null,
      focusDeepLink: $<HTMLInputElement>("c-deeplink").checked,
      a2aSelfSend: $<HTMLInputElement>("c-a2aself").checked,
      defaults: { provider: $<HTMLSelectElement>("c-provider").value, model: val("c-model") || null },
      layouts: changedLayouts(),
      ...($<HTMLSelectElement>("c-keys").value !== shownKeys ? { settings: { keys: $<HTMLSelectElement>("c-keys").value } } : {}),
    };
    void send({ t: "config", patch }).then((r) => {
      text($("c-msg"), r.ok ? "saved" : r.error, r.ok ? "ok" : "bad");
      if (r.ok) configDirty = false;
    });
  });
}

function connect(): void {
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => text($("conn"), "live", "pill ok");
  sock.onclose = () => {
    text($("conn"), "disconnected, retrying", "pill bad");
    for (const [, resolve] of waiting) resolve({ ok: false, error: "connection closed" });
    waiting.clear();
    setTimeout(connect, 1000);
  };
  sock.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerPush;
    if (msg.t === "state") render(msg.state);
    else {
      waiting.get(msg.id)?.(msg.reply);
      waiting.delete(msg.id);
    }
  };
}

wire();
connect();
