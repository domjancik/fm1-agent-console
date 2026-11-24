import { describe, expect, test } from "bun:test";
import { changedRegions, hintBar, keyBox, keyCell, layoutScreen, REGION_RECT, SCREEN, type DrawOp, type Rect } from "../src/layout";
import { applyHostMessage, initialState, type DeviceState } from "../src/state";
import { STATE_COLOR, toRgb565 } from "../src/colors";
import { demoFrames } from "../src/demo-host";

function demoState(proto = 1): DeviceState {
  let s: DeviceState = { ...initialState(), link: { ...initialState().link, phase: "connected", proto } };
  for (const m of demoFrames()) s = applyHostMessage(s, m, 0);
  return s;
}

const within = (r: Rect, outer: Rect): boolean =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

describe("layout model", () => {
  test("snapshot of the demo screen", () => {
    expect(layoutScreen(demoState(), 0)).toMatchSnapshot();
  });

  test("snapshot of the v2 screen", () => {
    expect(layoutScreen(demoState(2), 0)).toMatchSnapshot();
  });

  test("snapshot of the NO HOST screen", () => {
    const s = demoState();
    expect(layoutScreen({ ...s, link: { ...s.link, phase: "no_host" } }, 0)).toMatchSnapshot();
  });

  test("27 key cells, left to right, non-overlapping, inside the key strip", () => {
    const cells = Array.from({ length: 27 }, (_, k) => keyCell(k));
    cells.forEach((c, k) => {
      expect(within(c, REGION_RECT.keys)).toBe(true);
      expect(c.w).toBeGreaterThanOrEqual(6);
      if (k > 0) expect(c.x).toBeGreaterThan(cells[k - 1]!.x + cells[k - 1]!.w);
    });
    expect(cells[26]!.x + cells[26]!.w).toBeLessThanOrEqual(SCREEN);
  });

  test("every op stays inside its region", () => {
    for (const region of layoutScreen(demoState(), 0).regions) {
      for (const op of region.ops) {
        if (op.t === "fill" || op.t === "outline") expect(within(op, region.rect)).toBe(true);
        if (op.t === "text") {
          expect(op.y).toBeGreaterThanOrEqual(region.rect.y);
          expect(op.y).toBeLessThan(region.rect.y + region.rect.h);
        }
      }
    }
  });

  test("key strip: state colour fill, white 2px outline on selected, cross on stale, outline on empty", () => {
    const keys = layoutScreen(demoState(), 0).regions.find((r) => r.id === "keys")!.ops;
    const at = (k: number): DrawOp[] => {
      const c = keyCell(k);
      return keys.filter((o) => ("x" in o && o.x === c.x) || ("x1" in o && (o.x1 === c.x || o.x2 === c.x)));
    };
    expect(at(3)).toContainEqual({ t: "fill", ...keyCell(3), color: STATE_COLOR.working });
    expect(at(5)).toContainEqual({ t: "outline", ...keyCell(5), color: "#FFFFFF", width: 2 });
    expect(at(9).filter((o) => o.t === "line").length).toBe(2);
    expect(at(0)).toContainEqual({ t: "outline", ...keyCell(0), color: "#303030", width: 1 });
    expect(at(20)).toContainEqual({ t: "outline", ...keyCell(20), color: "#303030", width: 1 });
  });

  test("legend v1: four 60px cells, labels only", () => {
    const ops = layoutScreen(demoState(), 0).regions.find((r) => r.id === "legend")!.ops;
    const texts = ops.filter((o) => o.t === "text").map((o) => (o.t === "text" ? [o.x, o.text] : []));
    expect(texts).toEqual([
      [30, "SHOW"],
      [90, "REPO"],
      [150, "TASK"],
      [210, "TALK"],
    ]);
  });

  test("legend v2: each non-empty cell is tagged with its knob; an empty cell has no tag", () => {
    const s = applyHostMessage(demoState(2), { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "", "TALK"] }, 0);
    const ops = layoutScreen(s, 0).regions.find((r) => r.id === "legend")!.ops;
    const texts = ops.filter((o) => o.t === "text").map((o) => (o.t === "text" ? [o.x, o.y, o.text, o.color] : []));
    expect(texts).toEqual([
      [30, 204, "KNOB1", "#808080"],
      [30, 220, "SHOW", "#FFFFFF"],
      [90, 204, "KNOB2", "#808080"],
      [90, 220, "REPO", "#FFFFFF"],
      [210, 204, "KNOB4", "#808080"],
      [210, 220, "TALK", "#FFFFFF"],
    ]);
  });

  test("v2 keyboard strip: 16 white + 11 black boxes, disjoint, inside the strip; pinned bar on top", () => {
    const boxes = Array.from({ length: 27 }, (_, k) => keyBox(k));
    expect(boxes.filter((b) => !b.black)).toHaveLength(16);
    expect(boxes[0]?.box).toEqual({ x: 8, y: 166, w: 14, h: 34 });
    expect(boxes[1]?.box).toEqual({ x: 16, y: 136, w: 12, h: 30 });
    expect(boxes[26]?.box).toEqual({ x: 218, y: 166, w: 14, h: 34 });
    for (let a = 0; a < 27; a++) {
      expect(within(boxes[a]!.box, REGION_RECT.keys)).toBe(true);
      for (let b = a + 1; b < 27; b++) {
        const p = boxes[a]!.box;
        const q = boxes[b]!.box;
        const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        expect(overlap).toBe(false);
      }
    }
    const keys = layoutScreen(demoState(2), 0).regions.find((r) => r.id === "keys")!.ops;
    const f = keyBox(0).fill;
    expect(keys).toContainEqual({ t: "fill", x: f.x, y: f.y, w: f.w, h: 4, color: "#FFFFFF" });
  });

  test("v2 hint bar and ok-dot; v2 confirm uses the hint bar", () => {
    const s = demoState(2);
    const detail = layoutScreen(s, 0).regions.find((r) => r.id === "detail")!.ops;
    expect(detail).toContainEqual({ t: "fill", x: 0, y: 120, w: 240, h: 16, color: "#202020" });
    expect(hintBar("SAVE approve FX deny").filter((o) => o.t === "text").map((o) => (o.t === "text" ? [o.text, o.color, o.x] : []))).toEqual([
      ["SAVE", "#FFFFFF", 4],
      ["approve", "#A0A0A0", 34],
      ["FX", "#FFFFFF", 82],
      ["deny", "#A0A0A0", 100],
    ]);
    const status = layoutScreen(s, 0).regions.find((r) => r.id === "status")!.ops;
    expect(status).toContainEqual({ t: "fill", x: 204, y: 9, w: 6, h: 6, color: "#20C060" });
    const confirm = applyHostMessage(s, { kind: "SET_VIEW", view: "confirm", page: 0, pages: 1, title: "CHECK BEFORE DOING" }, 0);
    expect(JSON.stringify(layoutScreen(confirm, 0).regions.find((r) => r.id === "detail")!.ops)).toContain('"text":"yes"');
  });

  test("text is clipped to its width", () => {
    let s = demoState();
    s = applyHostMessage(s, { kind: "SET_STATUS", link: "ok", attentionCount: 0, text: "x".repeat(20) }, 0);
    s = applyHostMessage(s, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "T".repeat(20) }, 0);
    const status = layoutScreen(s, 0).regions.find((r) => r.id === "status")!.ops;
    const title = status.find((o) => o.t === "text");
    expect(title?.t === "text" && title.text.length).toBe(18);
  });
});

describe("partial redraw", () => {
  test("a heartbeat changes nothing on screen", () => {
    const s = demoState();
    const a = layoutScreen(s, 1000);
    const b = layoutScreen(applyHostMessage(s, { kind: "HEARTBEAT", from: "host", hostUptimeS: 9 }, 2000), 2000);
    expect(changedRegions(a, b)).toEqual([]);
  });

  test("one SET_SLOT redraws only the key strip; SET_LEGEND only the legend", () => {
    const s = demoState();
    const base = layoutScreen(s, 0);
    const slot = applyHostMessage(
      s,
      { kind: "SET_SLOT", key: 20, state: "idle", flags: { selected: false, codex: false, stale: false, pinned: false }, label: "n" },
      0,
    );
    expect(changedRegions(base, layoutScreen(slot, 0))).toEqual(["keys"]);
    const legend = applyHostMessage(s, { kind: "SET_LEGEND", labels: ["1", "2", "3", "4"] }, 0);
    expect(changedRegions(base, layoutScreen(legend, 0))).toEqual(["legend"]);
  });

  test("first frame paints every base region; losing the host adds only the overlay", () => {
    const s = demoState();
    expect(changedRegions(null, layoutScreen(s, 0))).toEqual(["status", "detail", "keys", "legend"]);
    const lost = { ...s, link: { ...s.link, phase: "no_host" as const } };
    expect(changedRegions(layoutScreen(s, 0), layoutScreen(lost, 0))).toEqual(["status", "overlay"]);
  });
});

test("RGB565 conversion of state colours", () => {
  expect(toRgb565("#000000")).toBe(0);
  expect(toRgb565("#FFFFFF")).toBe(0xffff);
  expect(toRgb565(STATE_COLOR.failed)).toBe(((0xf0 >> 3) << 11) | ((0x30 >> 2) << 5) | (0x30 >> 3));
});
