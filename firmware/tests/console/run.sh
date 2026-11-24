#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# FM1 CONSOLE's host tests (no hardware, no emulator): the C codec against the shared vectors, the link, gestures,
# LEDs and the redraw model as unit tests, then the whole app on Dinghy's host harness (tests/host.c) driven by the
# scenarios in scenario/, checked with the TypeScript codec, screenshots to reports/evidence/firmware-host/.
#   sh tests/console/run.sh            (from firmware/; needs cc, python3 + Pillow, bun)
set -e
cd "$(dirname "$0")/../.."
ROOT=$(cd .. && pwd)
OUT=build/console
EVIDENCE="${EVIDENCE:-$ROOT/reports/evidence/firmware-host}"
mkdir -p "$OUT"
fail=0
UNIT="${CC:-cc} -std=c11 -O1 -Wall -Wextra -Werror -Wno-unused-function -Ifirmware/src -I$OUT"

python3 tests/console/gen_vectors.py "$ROOT/fixtures/device/vectors.json" "$OUT/vectors.h"
python3 tests/console/gen_led_v2.py "$ROOT/fixtures/device/led-v2.json" "$OUT/led_v2.h"
for t in vectors link input led model anim; do
    echo "== $t"
    $UNIT -o "$OUT/${t}_test" "tests/console/${t}_test.c"
    "$OUT/${t}_test" || fail=1
done

echo "== sprites: fm1c_sprites.h is tools/gen_sprites.py's output of assets/sprites/*.png (docs/ui-v3.md section 6.2)"
python3 -I tools/gen_sprites.py "$OUT/fm1c_sprites.h" >/dev/null &&
    cmp -s "$OUT/fm1c_sprites.h" firmware/src/fm1c_sprites.h && echo "sprites: the committed header is byte-equal" ||
    { echo "sprites: firmware/src/fm1c_sprites.h differs from the PNGs (run python3 -I tools/gen_sprites.py)"; fail=1; }

echo "== device strings (docs/ux-v2.md section 5.3)"
python3 tests/console/scan_strings.py firmware/src/fm1c_draw.h firmware/src/fm1c_draw4.h firmware/src/fm1c_help.h || fail=1

echo "== help text: fm1c_help.h byte-equal to agent-core's HELP_TEXT (docs/ui-v3.md section 10.11)"
python3 tests/console/help_equal.py firmware/src/fm1c_help.h "$ROOT/packages/agent-core/src/control-map.ts" || fail=1

echo "== the app on the host harness"
${CC:-cc} -O2 -Wall -Werror -Wno-unused-function -DDINGHY_HOST -DAPP_VER='"0.1"' -Ifirmware/hal -Ifirmware/src -Ifirmware/gen \
    -o "$OUT/console-host" firmware/src/console.c
rm -rf "$OUT/host"
bun tests/console/scenario/host-run.ts "$OUT/console-host" "$OUT/host" "$EVIDENCE" || fail=1
SPLIT_EVIDENCE="${SPLIT_EVIDENCE:-$ROOT/reports/evidence/ui-v3/split}"   # (docs/ui-v3.md section 10.13: the SPLIT shots)
mkdir -p "$SPLIT_EVIDENCE/host" "$SPLIT_EVIDENCE/ranked"
rm -f "$SPLIT_EVIDENCE"/host/*.png "$SPLIT_EVIDENCE"/ranked/*.png
for f in "$EVIDENCE"/v6-*.png "$EVIDENCE"/v6x-*.png; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in v6-ranked-*) cp "$f" "$SPLIT_EVIDENCE/ranked/" ;; *) cp "$f" "$SPLIT_EVIDENCE/host/" ;; esac
done

echo "== protocol 7: the v7 host shots against the simulator's renderV4 (docs/ui-v3.md section 13.7)"
bun tests/console/scenario/v7-parity.ts "$OUT/host" || fail=1
MD_EVIDENCE="${MD_EVIDENCE:-$ROOT/reports/evidence/ui-v3/markdown}"   # (docs/ui-v3.md section 13.7: the v7 shots)
mkdir -p "$MD_EVIDENCE/host"
rm -f "$MD_EVIDENCE"/host/*.png
for f in "$EVIDENCE"/v7-*.png; do [ -f "$f" ] && cp "$f" "$MD_EVIDENCE/host/"; done

echo "== the software-scroll fallback (FM1C_VSCROLL_HW 0, docs/ui-v3.md section 9.10)"
${CC:-cc} -O2 -Wall -Werror -Wno-unused-function -DDINGHY_HOST -DFM1C_VSCROLL_HW=0 -DAPP_VER='"0.1"' -Ifirmware/hal -Ifirmware/src -Ifirmware/gen \
    -o "$OUT/console-host-sw" firmware/src/console.c
rm -rf "$OUT/host-sw"
FM1C_SW_SCROLL=1 FM1C_SCENARIOS=v5g-trans-window,v5g-trans-reader-page,v5x-window-interrupt,v6-split-window \
    bun tests/console/scenario/host-run.ts "$OUT/console-host-sw" "$OUT/host-sw" "$OUT/host-sw-evidence" || fail=1

[ "$fail" = 0 ] && echo "CONSOLE HOST TESTS PASSED" || echo "CONSOLE HOST TESTS FAILED"
exit "$fail"
