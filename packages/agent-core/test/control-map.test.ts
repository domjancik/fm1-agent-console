import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP_LINE_MAX, HELP_TEXT, HELP_WORDS4, HELP_WORDS4_STATES, helpKnobLines4, LEGEND } from "../src/control-map";

const HEADER = fileURLToPath(new URL("../../../firmware/firmware/src/fm1c_help.h", import.meta.url));

/** The string literals of `static const char *const NAME[n] = { ... };` in order. */
function literals(src: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*\\[\\s*\\d*\\s*\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(src);
  if (!m) throw new Error(`${name} not found in fm1c_help.h`);
  return [...(m[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
}

test("HELP_TEXT lines fit FONT_S and are printable ASCII", () => {
  for (const lines of Object.values(HELP_TEXT)) {
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(HELP_LINE_MAX);
      expect(l).toMatch(/^[\x20-\x7e]+$/);
    }
  }
  expect([HELP_TEXT.base.length, HELP_TEXT.voice.length, HELP_TEXT.confirm.length, HELP_TEXT.detail.length]).toEqual([11, 7, 4, 10]);
});

test("firmware fm1c_help.h carries exactly the HELP_TEXT strings", () => {
  expect(existsSync(HEADER)).toBe(true);
  const src = readFileSync(HEADER, "utf8");
  expect(literals(src, "FM1C_HELP_BASE")).toEqual([...HELP_TEXT.base]);
  expect(literals(src, "FM1C_HELP_VOICE")).toEqual([...HELP_TEXT.voice]);
  expect(literals(src, "FM1C_HELP_CONFIRM")).toEqual([...HELP_TEXT.confirm]);
  expect(literals(src, "FM1C_HELP_DETAIL")).toEqual([...HELP_TEXT.detail]);
});

test("help text names the DETAILS controls (docs/ux-v2.md section 7.6)", () => {
  expect(HELP_TEXT.base).toContain("OCT-/OCT+ page  LFO details");
  expect(HELP_TEXT.detail).toContain("LFO/HOME  close details");
});

// Protocol version 4 (docs/ui-v3.md section 6.1, fm1c_help.h). The firmware tables are checked once the firmware
// side has them; until then the host tables are checked against the spec mocks.
test("version 4 help: six static lines, then two knob lines built from the legend (8 lines as in the A mock)", () => {
  expect(HELP_TEXT.base4.length).toBe(6);
  expect(HELP_TEXT.base4[0]).toBe("HELP - let go of SCL");
  const knobs = helpKnobLines4(LEGEND.sessions);
  expect(knobs[0]).toMatch(/^KNOB1 \S+  KNOB2 \S+$/);
  expect(knobs[1]).toMatch(/^KNOB3 \S+  KNOB4 \S+$/);
  for (const l of [...HELP_TEXT.base4, ...knobs]) expect(l.length).toBeLessThanOrEqual(HELP_LINE_MAX);
  expect(helpKnobLines4(["", "", "", ""])).toEqual(["KNOB1 -  KNOB2 -", "KNOB3 -  KNOB4 -"]);
  expect(HELP_TEXT.detail4.length).toBe(HELP_TEXT.detail.length);
  expect(HELP_TEXT.detail4[1]).toContain("older");
  expect<readonly string[]>(HELP_TEXT.detail4.slice(2)).toEqual(HELP_TEXT.detail.slice(2));
});

test("version 4 who-is-who words: 8 characters, each fits half the help width (12 FONT_S characters)", () => {
  expect(HELP_WORDS4.length).toBe(8);
  expect(HELP_WORDS4_STATES.length).toBe(8);
  for (const w of HELP_WORDS4) expect(w.length).toBeLessThanOrEqual(12);
});

const src = existsSync(HEADER) ? readFileSync(HEADER, "utf8") : "";
test.if(src.includes("FM1C_HELP_BASE4"))("firmware fm1c_help.h carries exactly the version 4 tables", () => {
  expect(literals(src, "FM1C_HELP_BASE4")).toEqual([...HELP_TEXT.base4]);
  expect(literals(src, "FM1C_HELP_DETAIL4")).toEqual([...HELP_TEXT.detail4]);
  expect(literals(src, "FM1C_HELP_WORDS4")).toEqual([...HELP_WORDS4]);
});

// Protocol version 6 (docs/ui-v3.md section 10.11): byte equality once the firmware carries the tables.
test.if(src.includes("FM1C_HELP_BASE6"))("firmware fm1c_help.h carries exactly the version 6 tables", () => {
  expect(literals(src, "FM1C_HELP_BASE6")).toEqual([...HELP_TEXT.base6]);
  expect(literals(src, "FM1C_HELP_SPLIT6")).toEqual([...HELP_TEXT.split6]);
  expect(literals(src, "FM1C_HELP_SETTINGS6")).toEqual([...HELP_TEXT.settings6]);
});
