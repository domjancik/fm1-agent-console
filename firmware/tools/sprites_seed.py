#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""One-off seed of firmware/assets/sprites/*.png from the UI v3 design's procedural sprites (docs/ui-v3.md section 6.2:
reports/evidence/ui-v3/scripts/sprites.py), so the mocks and the firmware start from the same pixels. After the seed
the PNGs are the source of truth and are edited by hand; tools/gen_sprites.py turns them into fm1c_sprites.h.

  python3 -I tools/sprites_seed.py [--force]      (from firmware/; refuses to overwrite existing PNGs without --force)

Each PNG is palette mode with the 16-entry sprite palette: 0 transparent, 1-12 the fixed colours, 13-15 the body,
light and shade placeholders (magenta shades) that the firmware swaps per state."""
import importlib.util
import sys
from pathlib import Path

from PIL import Image

FW = Path(__file__).resolve().parent.parent
REPO = FW.parent
OUT = FW / "assets" / "sprites"
POSES = ["work", "wave", "hand", "dizzy", "happy", "sleep", "huh", "ghost"]
PROVIDERS = ["claude", "codex"]
PLACEHOLDER = {13: (255, 0, 255), 14: (255, 160, 255), 15: (128, 0, 128)}


def load_design():
    p = REPO / "reports" / "evidence" / "ui-v3" / "scripts" / "sprites.py"
    spec = importlib.util.spec_from_file_location("ui_v3_sprites", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def palette(base):
    pal = [(0, 0, 0)] * 16
    for i, c in base.items():
        pal[i] = c
    for i, c in PLACEHOLDER.items():
        pal[i] = c
    return [v for c in pal for v in c]


def hand_pass(kind, pose, prov, f, g):
    """The first hand pass the design asked for (docs/ui-v3.md section 7): the 12 x 12 Claude ears join the head, and
    the Claude working pose gets a mouth above the laptop lid (the lid hid it)."""
    BODY, LIGHT, INK = 13, 14, 1
    if kind == "mini" and prov == "claude":
        dy = -1 if pose == "happy" and f == 1 else 0
        for x in (2, 3, 8, 9):
            y = 3 + dy
            if 0 <= y < 12 and g[y][x] == 0:
                g[y][x] = LIGHT
    if kind == "hero" and prov == "claude" and pose == "work":
        for x in (11, 12):
            g[15][x] = INK
        g[15][10] = g[15][10] if g[15][10] else BODY
    return g


def save(frames, n, path, pal):
    w = n * len(frames)
    im = Image.new("P", (w, n), 0)
    im.putpalette(pal)
    for f, g in enumerate(frames):
        for y in range(n):
            for x in range(n):
                im.putpixel((f * n + x, y), g[y][x])
    im.save(path, transparency=0)


def main():
    force = "--force" in sys.argv
    s = load_design()
    OUT.mkdir(parents=True, exist_ok=True)
    pal = palette(s.BASE_PAL)
    for pose in POSES:
        for prov in PROVIDERS:
            hn = s.HERO_ANIM[pose][0]
            mn = max(1, s.MINI_ANIM[pose][0])
            for kind, n, frames in (("hero", 24, [hand_pass("hero", pose, prov, f, s.hero(pose, prov, f)) for f in range(hn)]),
                                    ("mini", 12, [hand_pass("mini", pose, prov, f, s.mini(pose, prov, f)) for f in range(mn)])):
                path = OUT / f"{kind}-{pose}-{prov}.png"
                if path.exists() and not force:
                    print(f"kept {path.relative_to(FW)} (use --force to overwrite)")
                    continue
                save(frames, n, path, pal)
                print(f"wrote {path.relative_to(FW)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
