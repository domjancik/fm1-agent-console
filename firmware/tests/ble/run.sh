#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The FM1C_BLE variant's host tests:
#   fm1c_ble_test   FM1C frames through the vendored BLE-MIDI codec (firmware/ble/ble_midi.c)
#   fm1c_ble_addr   the stable address made from the flash's unique ID (fm1c_ble.h fm1c_ble_addr_make)
#   fm1c_flash_uid  hal/ble/fm1c_flash_uid.h's read against a model of the SPI NOR (only 9F and 4B ever sent)
#   sh tests/ble/run.sh            (from firmware/ or anywhere; needs cc)
set -e
cd "$(dirname "$0")/../.."
OUT=build/ble-test
mkdir -p "$OUT"
CFL="-std=c11 -O1 -Wall -Wextra -Werror -Wno-unused-function"
${CC:-cc} $CFL -Ifirmware/ble -Ifirmware/src -o "$OUT/fm1c_ble_test" tests/ble/fm1c_ble_test.c
${CC:-cc} $CFL -Ifirmware/src -o "$OUT/fm1c_ble_addr_test" tests/ble/fm1c_ble_addr_test.c
${CC:-cc} $CFL -Ifirmware/hal/ble -o "$OUT/fm1c_uid_test" tests/ble/fm1c_uid_test.c
"$OUT/fm1c_ble_test"
"$OUT/fm1c_ble_addr_test"
"$OUT/fm1c_uid_test"
