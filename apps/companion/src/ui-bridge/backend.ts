// Implements the companion-ui UiBackend on top of a Companion. SAVE/CANCEL are mirrored device presses.
import type { CommandReply, UiBackend, UiCommand, UiState } from "@fm1/companion-ui";
import type { Companion } from "../companion";
import { mergeConfig, saveConfig } from "../config";
import { buildUiState } from "./ui-state";

export interface UiBackendOptions {
  simulatorUrl?: string | null;
  /** Where config edits are written; null keeps them in memory only (tests). */
  configPath: string | null;
}

export function companionBackend(c: Companion, opts: UiBackendOptions): UiBackend {
  return {
    snapshot: (): UiState => buildUiState(c, opts.simulatorUrl ?? null),
    onChange: (fn) => c.onChange(fn),
    async command(cmd: UiCommand): Promise<CommandReply> {
      try {
        switch (cmd.t) {
          case "edit": {
            const r = c.editTranscript(cmd.text);
            return r.ok ? { ok: true } : { ok: false, error: r.error ?? "edit rejected" };
          }
          case "save":
            await c.pressButton("SAVE");
            return { ok: true };
          case "cancel":
            await c.pressButton("FX");
            return { ok: true };
          case "config": {
            const next = mergeConfig(c.config, cmd.patch);
            if (opts.configPath) await saveConfig(next, opts.configPath);
            c.setConfig(next);
            c.log.info("ui", `config updated (${Object.keys(cmd.patch).join(", ")}); engine/mic changes apply to the next start`);
            return { ok: true };
          }
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
