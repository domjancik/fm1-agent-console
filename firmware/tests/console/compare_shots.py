#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""The host-mode screenshots against the emulator's of the same state, at the panel's RGB565 precision (the two
PPM-to-RGB888 conversions round the low bits differently, by at most 1 per channel).

  python3 tests/console/compare_shots.py reports/evidence/firmware-host reports/evidence/emu"""
import re
import sys
from pathlib import Path
from PIL import Image


def rgb565(img):
    img = img.convert("RGB").resize((240, 240), Image.NEAREST)
    return [(r >> 3, g >> 2, b >> 3) for r, g, b in img.get_flattened_data()] if hasattr(img, "get_flattened_data") \
        else [(r >> 3, g >> 2, b >> 3) for r, g, b in img.getdata()]


# Shots whose list hero box (x 0-28, y 18-59) shows another animation frame in the emulator, whose clock runs ahead of
# host mode (the frame is a function of the time); the rest of the screen must still be identical.
HERO_MASKED = {"v5x-help-trans-closed.png", "v5x-window-interrupt-after.png",
               "v6-ranked-v5x-help-trans-closed.png", "v6-ranked-v5x-window-interrupt-after.png",
               "v6-split-grouped.png"}          # (the question character's blinking "!" accent, x 24-25 y 27-32)
# Shots taken during a transition, SETTLE ms after a step (their content depends on the SPI and pass timing; fm1-emu
# 0.5.1 also ignores VSCRSADD): host mode only. Version 6 adds the task wipe and the SPLIT list window, and the RANKED
# replays (v6-ranked-*) of the version 5 ones.
STEP = re.compile(r"^(v6-ranked-)?(v5g-trans-.*-\d+|v5x-window-interrupt-mid|v6-split-(task-wipe|window)-\d+)\.png$")


def masked(i):
    x, y = i % 240, i // 240
    return x < 29 and 18 <= y < 60


def main():
    host, emu = Path(sys.argv[1]), Path(sys.argv[2])
    fail = n = 0
    for h in sorted(host.glob("*.png")):
        e = emu / ("emu-" + h.name)
        if not e.exists():
            continue
        if STEP.match(h.name):                  # (every -<n> shot is taken during a transition, SETTLE ms after its step)
            print(f"  SKIP  {h.name}: a transition step (its time depends on the SPI and pass timing; host mode only)")
            continue
        n += 1
        mask = h.name in HERO_MASKED
        diff = sum(1 for i, (a, b) in enumerate(zip(rgb565(Image.open(h)), rgb565(Image.open(e))))
                   if a != b and not (mask and masked(i)))
        note = " (hero box excluded: animation frame)" if mask else ""
        print(f"  {'PASS' if diff == 0 else 'FAIL'}  {h.name}: host mode and the package {'identical' if diff == 0 else f'differ in {diff} px'}{note}")
        fail += diff != 0
    print(f"screens compared: {n}, {fail} differ")
    return 1 if fail or not n else 0


if __name__ == "__main__":
    sys.exit(main())
