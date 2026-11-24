// `fm1-console canned list|add|rm|edit` (docs/ui-v3.md section 12): edits `canned` in the companion config file.
// A running companion re-reads the list from the file before its next device input (config.ts cannedReloader).
import { readFile } from "node:fs/promises";
import { addCanned, cannedKey, cannedText, sortCanned, type CannedEntry } from "@fm1/agent-core";
import { configPath, loadConfig, saveConfig } from "../config";

export interface CannedCliOptions {
  path?: string;
  /** `add --file <path>`: the text is the file's content. */
  file?: string;
  out?: (line: string) => void;
  now?: () => number;
}

export const CANNED_USAGE = `  canned list                                list canned responses (number, id, uses, text)
  canned add <text...> | --file <path>       add one (max 50, 2000 chars; duplicates refused)
  canned rm <n|id>                           remove one (n as listed)
  canned edit <n|id> <text...>               replace a text (uses kept)`;

/** Finds an entry by its listed number (1-based, sorted order) or its id. */
function pick(list: readonly CannedEntry[], ref: string | undefined): CannedEntry {
  if (!ref) throw new Error("canned: which one? give its number (canned list) or id");
  const byId = list.find((e) => e.id === ref);
  if (byId) return byId;
  const n = /^\d+$/.test(ref) ? Number(ref) : NaN;
  const e = Number.isInteger(n) ? list[n - 1] : undefined;
  if (!e) throw new Error(`canned: no entry ${ref} (${list.length} listed)`);
  return e;
}

export async function runCanned(sub: string | undefined, args: string[], opts: CannedCliOptions = {}): Promise<number> {
  const path = opts.path ?? configPath();
  const out = opts.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const now = opts.now ?? Date.now;
  const cfg = await loadConfig(path);
  const list = sortCanned(cfg.canned);
  const save = (canned: CannedEntry[]): Promise<void> => saveConfig({ ...cfg, canned }, path);
  switch (sub) {
    case "list":
    case undefined: {
      if (list.length === 0) out("no canned responses");
      list.forEach((e, i) => out(`${String(i + 1).padStart(2)}. [${e.id}] (${e.uses} uses) ${e.text}`));
      return 0;
    }
    case "add": {
      const raw = opts.file !== undefined ? await readFile(opts.file, "utf8") : args.join(" ");
      const r = addCanned(list, raw, now());
      if (!r.ok) {
        const why = r.reason === "empty" ? "text is empty" : r.reason === "duplicate" ? "already canned" : "canned list full (50)";
        throw new Error(`canned add: ${why}`);
      }
      await save(r.list);
      out(`added [${r.entry.id}] as ${r.list.indexOf(r.entry) + 1} of ${r.list.length}`);
      return 0;
    }
    case "rm": {
      const e = pick(list, args[0]);
      await save(list.filter((x) => x.id !== e.id));
      out(`removed [${e.id}] ${e.text}`);
      return 0;
    }
    case "edit": {
      const e = pick(list, args[0]);
      const text = cannedText(args.slice(1).join(" "));
      if (!text) throw new Error("canned edit: text is empty");
      if (list.some((x) => x.id !== e.id && cannedKey(x.text) === cannedKey(text))) throw new Error("canned edit: already canned");
      await save(sortCanned(list.map((x) => (x.id === e.id ? { ...x, text } : x))));
      out(`edited [${e.id}] ${text}`);
      return 0;
    }
    default:
      throw new Error(`unknown canned command "${sub}" (list | add | rm | edit)`);
  }
}
