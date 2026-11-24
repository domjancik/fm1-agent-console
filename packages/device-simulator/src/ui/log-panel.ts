import type { LogEntry } from "../wire";

const KEEP = 400;
const NOISE = new Set(["HEARTBEAT", "ACK"]);

export const formatEntry = (e: LogEntry): string => {
  const t = (e.atMs / 1000).toFixed(3).padStart(9);
  const arrow = e.dir === "rx" ? "<- host" : "-> host";
  const seq = e.seq === null ? "   " : String(e.seq).padStart(3);
  const err = e.error ? ` [${e.error}]` : "";
  return `${t} ${arrow} #${seq} ${e.kind}${err} ${e.summary}`.trimEnd();
};

/** Scrolling list of decoded frames in both directions. */
export class LogPanel {
  private readonly entries: LogEntry[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly hideNoise: HTMLInputElement,
  ) {
    hideNoise.addEventListener("change", () => this.rerender());
  }

  add(entries: readonly LogEntry[]): void {
    this.entries.push(...entries);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    const stick = this.root.scrollTop + this.root.clientHeight >= this.root.scrollHeight - 4;
    for (const e of entries) this.append(e);
    while (this.root.childElementCount > KEEP) this.root.firstElementChild?.remove();
    if (stick) this.root.scrollTop = this.root.scrollHeight;
  }

  private visible(e: LogEntry): boolean {
    return !(this.hideNoise.checked && NOISE.has(e.kind));
  }

  private append(e: LogEntry): void {
    if (!this.visible(e)) return;
    const row = document.createElement("div");
    row.className = e.error ? "err" : e.dir;
    row.textContent = formatEntry(e);
    this.root.append(row);
  }

  private rerender(): void {
    this.root.replaceChildren();
    for (const e of this.entries) this.append(e);
    this.root.scrollTop = this.root.scrollHeight;
  }
}
