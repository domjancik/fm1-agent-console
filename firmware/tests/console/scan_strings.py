#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""docs/ux-v2.md section 5.3, criterion 1: no device-visible string literal in fm1c_draw.h / fm1c_help.h contains
"_", "--", "=", "->" or a one-letter button code ("S:", "F:", "R:", "P:"), and the help lines fit 29 characters.

  python3 tests/console/scan_strings.py firmware/src/fm1c_draw.h firmware/src/fm1c_help.h"""
import re
import sys

BAD = re.compile(r"_|--|=|->|\b[SFRP]:")


def literals(path):
    src = re.sub(r"/\*.*?\*/", "", open(path).read(), flags=re.S)
    src = re.sub(r"(?m)^\s*#.*$", "", src)                 # (#include "...", #pragma)
    return re.findall(r'"((?:[^"\\]|\\.)*)"', src)


def main():
    fail = n = 0
    for path in sys.argv[1:]:
        for s in literals(path):
            n += 1
            if BAD.search(s) or any(ord(c) < 0x20 or ord(c) > 0x7E for c in s):
                print(f"  FAIL  {path}: {s!r}")
                fail += 1
            if path.endswith("fm1c_help.h") and len(s) > 29:
                print(f"  FAIL  {path}: {s!r} is {len(s)} > 29 characters")
                fail += 1
    print(f"device strings: {n} literals scanned, {fail} failed")
    return 1 if fail or not n else 0


if __name__ == "__main__":
    sys.exit(main())
