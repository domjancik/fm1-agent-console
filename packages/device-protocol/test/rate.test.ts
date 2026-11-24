import { describe, expect, test } from "bun:test";
import { DedupWindow, FakeClock, negotiate, PacedQueue, SlotCoalescer, type SetSlot } from "../src";

const slot = (key: number, label: string): SetSlot => ({
  kind: "SET_SLOT",
  key,
  state: "idle",
  flags: { selected: false, codex: false, stale: false, pinned: false },
  label,
});

describe("SlotCoalescer", () => {
  test("first update is immediate, later ones collapse per key within 50 ms", () => {
    const clock = new FakeClock();
    const flushed: SetSlot[][] = [];
    const c = new SlotCoalescer(clock, (s) => flushed.push(s));
    c.push(slot(1, "a"));
    expect(flushed).toEqual([[slot(1, "a")]]);
    clock.advance(10);
    c.push(slot(2, "x"));
    c.push(slot(1, "b"));
    c.push(slot(1, "c"));
    expect(flushed).toHaveLength(1);
    clock.advance(39);
    expect(flushed).toHaveLength(1);
    clock.advance(1);
    expect(flushed[1]).toEqual([slot(1, "c"), slot(2, "x")]);
    clock.advance(200);
    c.push(slot(3, "z"));
    expect(flushed[2]).toEqual([slot(3, "z")]);
  });

  test("pushAll: one diff's updates leave in one flush (a selection move is never split)", () => {
    const clock = new FakeClock();
    const flushed: SetSlot[][] = [];
    const c = new SlotCoalescer(clock, (s) => flushed.push(s));
    c.pushAll([slot(5, "old"), slot(6, "new")]);
    expect(flushed).toEqual([[slot(5, "old"), slot(6, "new")]]);
    c.pushAll([]);
    expect(flushed).toHaveLength(1);
    clock.advance(10);
    c.pushAll([slot(6, "x"), slot(7, "y")]);
    expect(flushed).toHaveLength(1);
    clock.advance(40);
    expect(flushed[1]).toEqual([slot(6, "x"), slot(7, "y")]);
  });

  test("cancel drops pending updates", () => {
    const clock = new FakeClock();
    const flushed: SetSlot[][] = [];
    const c = new SlotCoalescer(clock, (s) => flushed.push(s));
    c.push(slot(1, "a"));
    c.push(slot(1, "b"));
    c.cancel();
    clock.advance(100);
    expect(flushed).toHaveLength(1);
  });
});

describe("PacedQueue", () => {
  test("keeps order and respects the rate after the burst", () => {
    const clock = new FakeClock();
    const q = new PacedQueue(clock, 100, 2);
    const ran: number[] = [];
    for (let i = 0; i < 5; i++) q.run(() => ran.push(i));
    expect(ran).toEqual([0, 1]);
    clock.advance(10);
    expect(ran).toEqual([0, 1, 2]);
    clock.advance(20);
    expect(ran).toEqual([0, 1, 2, 3, 4]);
  });
});

test("PacedQueue default spacing never exceeds the rate in any 1 s window", () => {
  const clock = new FakeClock();
  const q = new PacedQueue(clock, 200);
  const at: number[] = [];
  for (let i = 0; i < 500; i++) q.run(() => at.push(clock.now()));
  clock.advance(3000);
  expect(at).toHaveLength(500);
  for (let i = 0; i + 200 < at.length; i++) expect((at[i + 200] ?? 0) - (at[i] ?? 0)).toBeGreaterThanOrEqual(1000);
});

describe("DedupWindow", () => {
  test("remembers the last 32 frames and distinguishes checksums", () => {
    const w = new DedupWindow();
    w.record(5, 10, "ok");
    expect(w.lookup(5, 10)).toBe("ok");
    expect(w.lookup(5, 11)).toBeUndefined();
    for (let i = 6; i < 6 + 32; i++) w.record(i % 128, 0, "ok");
    expect(w.lookup(5, 10)).toBeUndefined();
  });
});

describe("negotiate", () => {
  test("picks the highest common version", () => {
    expect(negotiate({ min: 1, max: 4 }, { min: 1, max: 2 })).toEqual({ proto: 2, reason: "" });
    expect(negotiate({ min: 1, max: 1 })).toEqual({ proto: 1, reason: "" });
    expect(negotiate({ min: 3, max: 2 }).proto).toBe(0);
  });
});

test("an urgent job (ACK) runs ahead of queued jobs, still paced", () => {
  const clock = new FakeClock(0);
  const q = new PacedQueue(clock, 200);
  const ran: string[] = [];
  for (let i = 0; i < 5; i++) q.run(() => ran.push(`s${i}`));
  q.run(() => ran.push("ack"), true);
  clock.advance(5);
  expect(ran).toEqual(["s0", "ack"]);
  clock.advance(100);
  expect(ran).toEqual(["s0", "ack", "s1", "s2", "s3", "s4"]);
});

test("urgent jobs keep their order among themselves (two ACKs in a row are not reversed)", () => {
  const clock = new FakeClock(0);
  const q = new PacedQueue(clock, 200);
  const ran: string[] = [];
  for (let i = 0; i < 3; i++) q.run(() => ran.push(`s${i}`));
  q.run(() => ran.push("ack1"), true);
  q.run(() => ran.push("ack2"), true);
  clock.advance(100);
  expect(ran).toEqual(["s0", "ack1", "ack2", "s1", "s2"]);
  // The urgent counter is spent: a later normal job is not overtaken by an old urgent slot.
  q.run(() => ran.push("s3")); // idle queue with a token: runs at once
  q.run(() => ran.push("s4"));
  q.run(() => ran.push("ack3"), true);
  clock.advance(100);
  expect(ran).toEqual(["s0", "ack1", "ack2", "s1", "s2", "s3", "ack3", "s4"]);
});
