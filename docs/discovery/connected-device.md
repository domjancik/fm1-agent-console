# Connected device (observed 2026-11-17)

Source: `system_profiler SPUSBDataType SPUSBHostDataType` (read-only). Operator states the unit runs CoralFlower firmware.

| Field | Value |
| --- | --- |
| USB product string | `CoralFlower FM-1` |
| Manufacturer | `CoralFlower` |
| Vendor ID | `0x1209` (pid.codes shared VID) |
| Product ID | `0x0001` |
| bcdDevice | `0x0301` |
| Link speed | 12 Mb/s (USB full speed) |
| Serial | not provided |
| Location ID | `0x02142000` (behind a Generic USB2.1 hub) |

## Firmware

- Upstream: <https://github.com/FicusFicusov/CoralFlower> (GPL-3.0), latest tagged release seen: v0.7.1.
- Lineage: "after ChoralRoot FM-1 and Felucca" (`firmware/src/coralflower.c` header). It is the same Felucca platform family as
  Dinghy, so the Felucca update path is expected to apply: the USB installer and the OCT− rescue updater. Verify against
  CoralFlower's own `platform`/loader before any write.
- The installed CoralFlower is a chord instrument; it does not speak the Agent Deck protocol. The console needs our firmware
  flashed (gated, Phase 6/7). Until then the companion runs against the simulator/emulator.

## Open items for preflight (Phase 6)

- Map bcdDevice `0x0301` to a CoralFlower version (check `tools/build.py` / USB descriptor in the CoralFlower repo).
- Confirm the installer accepts a Dinghy-derived `.fwsc` from a CoralFlower-installed unit (package identity, loader version).
- Identify the stock M-VAVE firmware image for rollback, and the flash chip ID.
## Flash authorization

2026-11-17: the operator (dominikj) authorized reflashing this unit (CoralFlower FM-1, VID 0x1209 / PID 0x0001) with the
console firmware. The authorization covers the write itself. These checks still run before the write, because they protect the
unit:

1. The candidate `.fwsc` builds and passes the host harness and emulator tests.
2. The candidate's SHA-256 and package identity are recorded in `reports/firmware-validation.md`.
3. A rollback image is in hand: the CoralFlower v0.7.1 release package or the stock M-VAVE image.
4. A flash backup is taken and double-read where the tooling supports it.
5. The device identity is re-read immediately before the write.

If any check fails, the write does not happen and the failure is reported. If the install itself fails, no automatic recovery
write is attempted.
