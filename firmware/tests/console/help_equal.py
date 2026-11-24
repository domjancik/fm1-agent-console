#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""docs/ui-v3.md section 10.11: the help tables in fm1c_help.h byte-equal to agent-core's HELP_TEXT
(packages/agent-core/src/control-map.ts), so the firmware's overlay says what the companion's legend says.

  python3 tests/console/help_equal.py firmware/src/fm1c_help.h ../packages/agent-core/src/control-map.ts"""
import json
import re
import sys

PAIRS = [("FM1C_HELP_BASE", "base"), ("FM1C_HELP_VOICE", "voice"), ("FM1C_HELP_CONFIRM", "confirm"), ("FM1C_HELP_DETAIL", "detail"),
         ("FM1C_HELP_BASE4", "base4"), ("FM1C_HELP_BASE5", "base5"), ("FM1C_HELP_DETAIL4", "detail4"),
         ("FM1C_HELP_BASE6", "base6"), ("FM1C_HELP_SPLIT6", "split6"), ("FM1C_HELP_SETTINGS6", "settings6")]


def c_table(src, name):
    m = re.search(r"\b" + name + r"\[\d+\]\s*=\s*\{(.*?)\};", src, re.S)
    return None if not m else [bytes(x, "ascii").decode("unicode_escape") for x in re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))]


def ts_table(src, key):
    m = re.search(r"\n\s*" + key + r":\s*\[(.*?)\]", src, re.S)
    return None if not m else [json.loads('"' + x + '"') for x in re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))]


def main():
    c_src, ts_src = open(sys.argv[1]).read(), open(sys.argv[2]).read()
    fail = 0
    for cn, tn in PAIRS:
        a, b = c_table(c_src, cn), ts_table(ts_src, tn)
        ok = a is not None and a == b
        print(f"  {'PASS' if ok else 'FAIL'}  {cn} == HELP_TEXT.{tn} ({len(a or [])} lines)")
        fail += not ok
    print(f"help tables: {len(PAIRS) - fail} of {len(PAIRS)} byte-equal")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
