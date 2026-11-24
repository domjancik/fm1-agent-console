#!/usr/bin/env bash
# Builds the companion's Swift helpers into apps/companion/bin/. Needs Command Line Tools (swiftc) only.
#   fm1-ble-notify  keeps notifications on for the macOS Bluetooth MIDI driver's port (CoreMIDI Bluetooth path)
#   fm1-ble-midi    GATT pipe for BT direct (`start --ble NAME`), no CoreMIDI port involved
#   fm1-summarize   read aloud summaries with Apple's on-device model (FoundationModels, macOS 26; docs/ui-v3.md section 14)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$here/bin"
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found: install Xcode Command Line Tools (xcode-select --install)" >&2; exit 1; }
for tool in fm1-ble-notify fm1-ble-midi; do
  # The embedded Info.plist carries NSBluetoothAlwaysUsageDescription: without it macOS's privacy check (TCC) aborts
  # the helper (exit 134) the moment it touches CoreBluetooth when the companion spawns it (crash reports 2026-11-22/23).
  swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos26.0" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/native/Info.plist" \
    -o "$here/bin/$tool" "$here/native/$tool/main.swift" "$here/native/Disclaim.swift"
  echo "built: $here/bin/$tool" >&2
done
# No Info.plist or Disclaim.swift: FoundationModels needs no privacy (TCC) permission; the helper reads stdin only.
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos26.0" -o "$here/bin/fm1-summarize" "$here/native/fm1-summarize/main.swift"
echo "built: $here/bin/fm1-summarize" >&2
