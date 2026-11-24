#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The built package in fm1-emu 0.5.1 (fm1-live headless, its emulated USB host): the same scenarios as the host
# tests, against the real .fwsc. Screenshots to reports/evidence/emu/. Never touches a real FM-1: --midi none.
#   sh tests/console/run_emu.sh [PACKAGE.fwsc]     (default build/dinghy-0.1.fwsc; ./build.sh --release 0.1 first)
#   FM1_LIVE=/path/to/fm1-live                     (default: the v0.5.1 macOS binary in ../../.fm1-upstream)
#   HOST_EVIDENCE=DIR                              host-mode shots to compare with (default reports/evidence/firmware-host)
#   LIVE_HANDSHAKE=1                               also fm1-live in window mode with --usb: the TS host link does
#                                                  HELLO / HELLO_ACK over the CoreMIDI device "FM1 CONSOLE (emu)"
set -e
cd "$(dirname "$0")/../.."
ROOT=$(cd .. && pwd)
PKG="${1:-build/dinghy-0.1.fwsc}"
FM1_LIVE="${FM1_LIVE:-$ROOT/../.fm1-upstream/fm1-emu-bin/fm1-emu-0.5.1-macos-arm64/fm1-live}"
EVIDENCE="${EVIDENCE:-$ROOT/reports/evidence/emu}"
HOST_EVIDENCE="${HOST_EVIDENCE:-$ROOT/reports/evidence/firmware-host}"
[ -f "$PKG" ] || { echo "no package $PKG: ./build.sh --release 0.1"; exit 1; }
[ -x "$FM1_LIVE" ] || { echo "no fm1-live at $FM1_LIVE"; exit 1; }
fail=0
rm -rf build/emu/runs
bun tests/console/scenario/emu-run.ts "$PKG" "$FM1_LIVE" build/emu/runs "$EVIDENCE" || fail=1
if [ -d "$HOST_EVIDENCE" ]; then
    echo "== the same screens in host mode and in the emulator"
    python3 tests/console/compare_shots.py "$HOST_EVIDENCE" "$EVIDENCE" || fail=1
fi
if [ "${LIVE_HANDSHAKE:-0}" = 1 ]; then
    echo "== live: CoreMIDI handshake"
    bun tests/console/scenario/live-handshake.ts "$PKG" "$FM1_LIVE" | tee "$EVIDENCE/live-handshake.txt" || fail=1
fi
[ "$fail" = 0 ] && echo "CONSOLE EMULATOR TESTS PASSED" || echo "CONSOLE EMULATOR TESTS FAILED"
exit "$fail"
