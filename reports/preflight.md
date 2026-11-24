# Firmware preflight (spec section 12, Phase 6)

Date: 2026-11-17. Candidate: `firmware/dist/fm1-console-0.1.fwsc`, identity `FM-1_951`,
SHA-256 `00b00e64ae33da81869ce824d8d60bdace8a90c1620390d5b617c14e4c8b3eaf`.
Device: CoralFlower FM-1, USB `0x1209:0x0001`, bcdDevice `0x0301`.

**Verdict: not ready to write.** Package-side checks pass. Five checks need the operator at the unit: allow the USB
accessory, read the CoralFlower version, enter the mask ROM for the flash ID and the double-read backup, and set up
the tools. Nothing was sent to the device in this preflight. Its MIDI input was not opened either: macOS has not
authorized the accessory, so there is no MIDI port to open (check 1).

Recovery plan: `docs/recovery.md`. Tool: `tools/firmware-inspect` (read-only).

## Checklist

| # | Spec 12 check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Identify the connected FM-1 | **PASS**, with an operator blocker | IORegistry (read-only, `firmware-inspect device`): `CoralFlower FM-1`, maker `CoralFlower`, VID `0x1209`, PID `0x0001`, bcdDevice `0x0301`, bcdUSB `0x0200`, class `EF/02/01`, full speed, no serial, location `0x01100000` (built-in USB-C port, no hub). The descriptor equals CoralFlower's `DEV_DESC` for `FELUCCA_CDC=1, FELUCCA_UAC=0` (`CoralFlower firmware/src/usb.c:229-230`), set in `coralflower.c:23-26`. **Blocker:** macOS reports `AuthorizationStatusDescription = "Unauthorized"`, policy "Ask for New Accessories". The device has no interfaces matched, so CoreMIDI lists only `IAC Driver Bus 1` and there is no `/dev/cu.usbmodem*`. The operator must click Allow. |
| 2 | Read the current firmware identity | **PENDING-OPERATOR** | Family: CoralFlower (USB product string). Package identity: `FM-1_930`, constant in every CoralFlower release (`tools/build.py:66`). The release number is not visible over USB: bcdDevice `0x0301` and the product string are the same in v0.1 to v0.7.1 (checked per tag). The version shows on the boot splash (`cf_splash.c:28`) and in the CDC console banner (sending DTR is a host request: not done). **Operator:** power-cycle and note the `CoralFlower X.Y` on the splash. At flash time the orchestrator runs `fm1_install.py --info --port "CoralFlower FM-1"` and expects `FM-1_930 [running]`. |
| 3 | Identify the flash chip | **PENDING-OPERATOR** | Only the mask ROM reports the JEDEC ID (`fm1_unbrick.py info` or `backup`, through jl-uboot-tool). No path without the ROM exposes it: the M-UPGRADE handshake returns the identity only; CoralFlower's CDC console `status` prints `flash 0/1` (supported or not), and it is unreachable while the accessory is unauthorized. The candidate accepts both chips: `flash-chip.claims` PASS, `0x856014` and `0xB36014` constants in app and loader (Dinghy 0.4's Wordscape build shows only `0x856014`, so the heuristic tells them apart). The ID matters for the update path: CoralFlower before 0.7 knows only `0x856014` (`git grep` per tag; `59fbdb1` "Support both known FM-1 flash chips" is in v0.7 and v0.7.1). |
| 4 | Verify firmware/package compatibility | **PASS** | `firmware-inspect verify` exit 0, 31 checks pass (with `--expect-identity` and `--expect-sha256`), 0 fail. Model `FM-1` (installer `same_keyboard`). Felucca loader accepted by the running updater's step-2 checks (`ota_stage`; CoralFlower 0.7.1's checks are the same code). Loader body and LZ4 image CRCs match. Update-mode identity `ota-FM-1_900` (installer resume). Chip key `0x980F` (unit-side value confirmed by the backup; the loader refuses a mismatch before erasing). App 61,056 B, inside `0x4000–0x92FFF`. |
| 5 | Check the current firmware's update path | **PASS** (code trace; conditional on checks 2 and 3) | CoralFlower 0.7.x keeps the Felucca M-UPGRADE updater: `main.c:344-349` handshake + `ota_session()` when `flash_ok`; `ota.c` step 1 accepts our loader (mark `FELUCCA-LOADER-1` within 64 B of `0x48`, size ≤ `0x14000`, load `0x01C0A800`, body ≤ `0x4E00`), stages it at `0xE0000`, writes the record `ota-FM-1_015` at `0xE4F00`, resets. Our loader (`ldr_core.c`) checks this unit's chip key and flash chip, writes `0x4000–0x92FFF` with per-sector verify. Refusal paths: `-1…-13` in step 1 (nothing written), `-6` wrong chip key, `-14` unknown flash (loader drops the record, old firmware stays). The installer matches `CoralFlower FM-1` by `PORT_RE` "fm-1" (there is no "AMB-1" name anywhere upstream). Rescue: CoralFlower's boot stub (sector `0x4000`, v3) starts the kept loader when OCT− alone is held at power-on; mask ROM on OCT−+OCT+ 5 s. `fm1_install.py` has no dry-run mode; nothing was sent. |
| 6 | Identify the applicable official stock firmware | **PASS** (which one applies: PENDING-OPERATOR, from the backup's head) | V15 `FM-1_015` and V16 `FM-1_016` downloaded; file hashes equal the values pinned in MvaveFM1Unbricker (`fm1_unbrick.py:118`, `:125`). `firmware-inspect` identifies the stock V15 and V16 heads and the V15 firmware region by hash. V15 fits `restore`; V16 runs to `0xA8FFF` and needs `full-restore`. Over USB-MIDI an official package installs only when its head equals the unit's head: `firmware-inspect dump BACKUP --package V15` decides. |
| 7 | Verify package checksum and provenance | **PASS** | Candidate: SHA-256 above; every UFW, head and app-area CRC re-computed and equal; built reproducibly (`reports/firmware-validation.md`). Rollback images: see "Rollback images". A corrupted copy (one bit in the app area) fails with exit 1 and 4 mismatches. |
| 8 | Create a recovery plan | **PASS** | `docs/recovery.md`: tiers 1–6, flash map, backup locations, macOS accessory prompts, hardware risks. |
| 9 | Back up the entire flash | **PENDING-OPERATOR** | Needs the mask ROM (step P2). No full-flash read exists without it: CoralFlower's console `flr` reads only `0x93000–0xFFFFF`. |
| 10 | Verify the backup with a second read | **PENDING-OPERATOR** | `fm1_unbrick.py backup` reads twice in one session and compares. Step P2 runs it twice and compares the two files with `firmware-inspect dump A --second B`. |
| 11 | Emulator testing of the exact candidate | **PASS** | `reports/evidence/emu/results.json`: 77 checks, 0 failed, on `firmware/build/dinghy-0.1.fwsc`; that path and `firmware/dist/fm1-console-0.1.fwsc` both hash to `00b00e64…` now. The CoreMIDI live handshake ran on an earlier candidate (`firmware-validation.md`). `results.json` records only the path. Re-verify the hash at flash time (step P0). |
| 12 | Prepare a recovery tool and compatible stock image | **PENDING-OPERATOR** (images PASS) | Images in `../.fm1-rollback` (verified). Tools not set up: `mido`/`python-rtmidi` missing (`ModuleNotFoundError`); MvaveFM1Unbricker `setup` not run (no `jl-uboot-tool/`, no `pyusb`). Both download third-party code, so this preflight did not run them. The unbricker accepts the candidate: `restore --dry-run` on its mock device wrote and verified region SHA-256 `115f8fd5…bb95`, the same value `firmware-inspect` reports. |

## Package verification

```sh
cd /Users/dominikj/dev/personal/fm1-agent-console
bun tools/firmware-inspect/src/cli.ts verify firmware/dist/fm1-console-0.1.fwsc \
  --expect-identity FM-1_951 --expect-sha256 00b00e64ae33da81869ce824d8d60bdace8a90c1620390d5b617c14e4c8b3eaf
```

| Package | Exit | Identity | FAIL | WARN |
| --- | --- | --- | --- | --- |
| `firmware/dist/fm1-console-0.1.fwsc` | 0 | `FM-1_951` | 0 | 0 |
| Agent Deck `agentdeck-0.1 … 0.6.1`, `0.6` | 0 | `FM-1_961 … FM-1_966` | 0 | 0 |
| Agent Deck `agentdeck-0.6.2`, `0.6.3`, `agtdeck-0.7` | 0 | `FM-1_24356`, `FM-1_24356`, `FM-1_24357` | 0 | 0 |
| `coralflower-0.7.1.fwsc` | 0 | `FM-1_930` | 0 | 0 |
| `V15-FM-1.fwsc` | 0 | `FM-1_015` | 0 | 1 (no Felucca loader mark: the installer needs `--force`) |
| `V16-FM-1.fwsc` | 0 | `FM-1_016` | 0 | 2 (loader mark; flash.bin runs to `0xA9000`) |
| candidate with bit 7 of flash.bin byte `0x9000` flipped | **1** | `FM-1_951` | 4 (`ufw.entry.flash.bin`, `installer.damage`, `flash.app-area`, `flash.app.app.bin`) | 0 |

Candidate details from the tool: flash.bin 602,112 B (CRC `0x439D`), ota.bin 9,071 B
(SHA-256 `68bfe16a…112f`, as in `firmware-validation.md`), loader 10,472 B decompressed, app.bin 61,056 B used
(SHA-256 `5fc05856…7c63`, as in `firmware-validation.md`), chip key `0x980F`, regions VM `0x93000`, BTIF `0xE9000`,
USR `0xEA000`. The head is the SDK SPL (`53144a0a…`), the same as CoralFlower's. Felucca loaders never write it.

## Rollback images (provenance)

Stored in `/Users/dominikj/dev/personal/.fm1-rollback/` with `SHA256SUMS` (all OK).

| File | Source | SHA-256 | Check |
| --- | --- | --- | --- |
| `coralflower-0.7.1/coralflower-0.7.1.fwsc` (610,313 B) | `gh release download v0.7.1 -R FicusFicusov/CoralFlower`; tag commit `46790b943bdb5e4143212d83dc495c832eefdbb8`, published 2026-11-10 | `d87d6327e0f98000cfa740bab70487728de85d3d64fd96c3a65dfd6bbdf71bbd` | equals the release's `SHA256SUMS` and the GitHub asset digest. No build attestation (`gh attestation verify`: 404). `verify` exit 0, identity `FM-1_930`, CoralFlower boot-stub marker present |
| `coralflower-0.7.1/coralflower-0.7.1-app.bin` | same release | `62db4692f1f410ec91050142a42836f8707a28e9b64f5d0270de25bdf047dade` | equals `SHA256SUMS` |
| `stock-mvave/V15-FM-1.fwsc` (699,956 B) | M-VAVE's FM-1 V15. Copy from `github.com/Quixotic7/FM1Backups` @ `8cbc3b0` (the vendor page `m-vave.com/product?id=fm-1` now offers V16 only) | `db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a` | equals `V15_FILE_SHA256` pinned in MvaveFM1Unbricker; firmware region and head equal its V15 hashes |
| `stock-mvave/V16-FM-1.fwsc` (718,196 B) | M-VAVE's FM-1 V16 (`FM-1_016`, 2026-10-21), same mirror | `d017fb65e70aca97ee29d944470c3515a74581df5c0576bf70de917c7b2b61d5` | equals `V16_FILE_SHA256` pinned in MvaveFM1Unbricker (as M-Flasher documents it) |

The M-VAVE images are M-VAVE's firmware. They are kept outside the repo for this unit's recovery only.

## Updater compatibility: CoralFlower 0.7.1 vs FM1 CONSOLE

| Step | CoralFlower 0.7.1 | FM1 CONSOLE (Dinghy 0.5 platform) |
| --- | --- | --- |
| Handshake | `ota_service`, identity `FM-1_930` | `ota_service`, identity `FM-1_951` (`FM-1_000` in rescue) |
| Step 1 gate | `if (flash_ok) ota_session()`; `flash_ok` = `0x856014` or `0xB36014` | the same; same chips |
| Step-1 package checks | UFW CRCs; loader official (CRCs `EBAA/5881`, `0x4DE1`) or Felucca mark | identical code |
| Staging | `0xE0000`, record `ota-FM-1_015` at `0xE4F00` | identical |
| Kept loader | stays staged after an install, for the stub's OCT− rescue | erased at boot (`ota_boot_cleanup`) |
| Rescue | boot stub in sector `0x4000`: OCT− → kept loader → else ROM | app-level `recovery_main`: OCT− or two failed boots |
| ROM key | OCT−+OCT+ 5 s; SysEx `F0 22 24 35 7D F7` | SysEx only |
| Loader write order | stub-aware: marker sector erased first, `0x4000` only if different, marker last | address order from `0x4000` |
| USB name | `CoralFlower FM-1` | `FM1 CONSOLE` (needs `--port FM`) |

## Proposed flash procedure (for the orchestrator, with the operator present)

Each step must pass before the next. If a step fails, stop and report. There is no automatic recovery write.

### P0. Host preparation (no device contact)

```sh
cd /Users/dominikj/dev/personal/fm1-agent-console
bun tools/firmware-inspect/src/cli.ts verify firmware/dist/fm1-console-0.1.fwsc \
  --expect-identity FM-1_951 --expect-sha256 00b00e64ae33da81869ce824d8d60bdace8a90c1620390d5b617c14e4c8b3eaf  # exit 0
shasum -a 256 -c /Users/dominikj/dev/personal/.fm1-rollback/SHA256SUMS                                        # all OK
python3 -m venv /Users/dominikj/dev/personal/.fm1-flash-venv
/Users/dominikj/dev/personal/.fm1-flash-venv/bin/pip install mido python-rtmidi
cd /Users/dominikj/dev/personal/.fm1-upstream/MvaveFM1Unbricker
python3 -m venv .venv && .venv/bin/python fm1_unbrick.py setup
.venv/bin/python fm1_unbrick.py restore /Users/dominikj/dev/personal/fm1-agent-console/firmware/dist/fm1-console-0.1.fwsc --dry-run --yes  # mock only
```

If the candidate is rebuilt, its hash changes: update `firmware-validation.md` and this file first.

### P1. Operator at the unit

1. Charge the FM-1. Keep the data cable straight into the Mac (no hub). Quit other MIDI apps.
2. Click **Allow** for the "CoralFlower FM-1" accessory. Check:
   `bun tools/firmware-inspect/src/cli.ts device` shows `authorization: Authorized`.
3. Power-cycle the unit and note the version on the splash (`CoralFlower X.Y`). If it is below 0.7, the flash-chip
   result from P2 decides between P4 and P4-B.

### P2. Mask ROM: flash ID and double-read backup (operator-assisted)

1. On the running CoralFlower: hold **OCT− and OCT+** together for 5 s (countdown, then `UBOOT`). No host SysEx.
2. Allow `WL82 UBOOT1.00` if macOS asks. Click Ignore if macOS says the disk is not readable. Start within 30 s:

   ```sh
   cd /Users/dominikj/dev/personal/.fm1-upstream/MvaveFM1Unbricker
   B=/Users/dominikj/dev/personal/.fm1-rollback/device-backup
   P=/Users/dominikj/dev/personal/fm1-agent-console/firmware/dist/fm1-console-0.1.fwsc
   sudo -v && sudo .venv/bin/python fm1_unbrick.py backup "$B/read-a" --package "$P"
   ```

   Record the chip key (must be `0x980F`) and the flash ID (`0x856014` or `0xB36014`) from its log. That is the
   JEDEC read (b). `backup` reads the 1 MiB twice and compares before it saves.
3. Power-cycle, enter UBOOT again (step 1), and run the same command with `"$B/read-b"`.
4. Compare the two sessions and analyse the dump:

   ```sh
   cd /Users/dominikj/dev/personal/fm1-agent-console
   A=$(ls /Users/dominikj/dev/personal/.fm1-rollback/device-backup/read-a/*/full-flash-before.bin)
   B2=$(ls /Users/dominikj/dev/personal/.fm1-rollback/device-backup/read-b/*/full-flash-before.bin)
   bun tools/firmware-inspect/src/cli.ts dump "$A" --second "$B2" --package firmware/dist/fm1-console-0.1.fwsc   # exit 0
   bun tools/firmware-inspect/src/cli.ts dump "$A" --package /Users/dominikj/dev/personal/.fm1-rollback/stock-mvave/V15-FM-1.fwsc
   shasum -a 256 "$A" "$B2"
   ```

   Pass: identical reads, chip key `0x980F`, valid head, no update record. Note which stock head the unit has.
   Record the hashes in this file.
5. Power-cycle (off, wait 5 s, on). CoralFlower boots.

### P3. Re-read the identity immediately before the write

```sh
cd /Users/dominikj/dev/personal/fm1-agent-console
bun tools/firmware-inspect/src/cli.ts device              # CoralFlower FM-1, 0x1209:0x0001, Authorized
/Users/dominikj/dev/personal/.fm1-flash-venv/bin/python firmware/tools/fm1_install.py --info --port "CoralFlower FM-1"
#   expect: FM-1_930  [running]  port: CoralFlower FM-1
```

### P4. Write over USB-MIDI (primary)

```sh
/Users/dominikj/dev/personal/.fm1-flash-venv/bin/python firmware/tools/fm1_install.py \
  firmware/dist/fm1-console-0.1.fwsc --port FM
#   package: FM-1_951 ... device: FM-1_930 (CoralFlower FM-1) ... Install? y
```

No `--yes`: the operator confirms. The operator allows the `Felucca Update` and `FM1 CONSOLE` accessories as they
appear (about one minute in total). `--port FM` matches `CoralFlower FM-1` before and `FM1 CONSOLE` after. Expected
end: `done: the FM-1 runs FM-1_951`, exit 0.

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | written and identity `FM-1_951` read back | P5 |
| 3 | not found; nothing written | accessory, cable, port names; retry P3 |
| 4, step 1, "after N requests; nothing was written" | CoralFlower refused (e.g. older than 0.7 on a `0xB36014` unit) | stop; P4-B needs operator approval |
| 5 "update loader did not appear" | the unit is in update mode | allow `Felucca Update`; run the **P4-R** resume command (not the P4 command) |
| 4 or 5 during the write | the loader waits | **do not power off**; run the **P4-R** resume command |
| 5 "did not come back" | written; new firmware not seen | allow `FM1 CONSOLE`; `fm1_install.py --info --port FM` must say `FM-1_951` |
| 6 | other identity after the write | stop and report |

### P4-R. Resume an interrupted install (unit in update mode)

**Do not re-run the P4 command to resume.** `--port FM` makes the installer's first search consider only ports whose
name contains "fm" (`Updater.candidates(only_port=True)`), and the loader's port `Felucca Update` does not. That run
ends with exit 3 "no MIDI port matching 'FM' answered" while the unit sits in update mode (review 2026-11-17,
reproduced with a fake port list). Resume with the loader's own name:

```sh
/Users/dominikj/dev/personal/.fm1-flash-venv/bin/python firmware/tools/fm1_install.py \
  firmware/dist/fm1-console-0.1.fwsc --port Felucca
#   device: ota-FM-1_900 (Felucca Update) in update mode: the write will be finished
```

The write then finishes, but the installer's last step looks for the new firmware only among `Felucca…` ports and
`PORT_RE`, which does not match `FM1 CONSOLE`: expect exit 5 "did not come back" even after a good write. Confirm
with `fm1_install.py --info --port FM` (must say `FM-1_951  [running]`). Omitting `--port` behaves the same way.

### P4-B. Fallback from the mask ROM (only with operator approval)

Enter UBOOT (P2 step 1), then:

```sh
cd /Users/dominikj/dev/personal/.fm1-upstream/MvaveFM1Unbricker
sudo -v && sudo .venv/bin/python fm1_unbrick.py restore /Users/dominikj/dev/personal/fm1-agent-console/firmware/dist/fm1-console-0.1.fwsc
#   takes its own double-read backup, asks for WRITE, writes 0x4000-0x92FFF, verifies byte for byte
```

Then unplug, switch off, wait 5 s, switch on.

### P5. After the write

1. The splash shows FM1 CONSOLE; `bun tools/firmware-inspect/src/cli.ts device` shows `FM1 CONSOLE`, `0x1209:0x0001`.
2. `fm1_install.py --info --port FM` reports `FM-1_951  [running]`.
3. Start the companion. Expect the device HELLO and a negotiated protocol 1 (Phase 7 smoke tests).
4. Rollback when needed: `docs/recovery.md` tier 3 (CoralFlower) or tier 4/5 (stock or the backup image).

## What was and was not done

- Done (read-only): IORegistry reads, CoreMIDI port list (the FM-1 has no port while unauthorized, so its input was
  not opened), code reading of CoralFlower `46790b9`, the console firmware, Dinghy and MvaveFM1Unbricker, downloads
  of rollback images, `firmware-inspect` runs, an unbricker mock-device dry run.
- Not done: any MIDI or SysEx to the device, any serial or DTR on its CDC port, `fm1_install.py` (even `--info`),
  unbricker commands against hardware, tool set-up that installs third-party code.

## Adversarial review (2026-11-17)

Re-checked without device contact. Verdict unchanged: **NO-GO until the operator items (checks 1, 2, 3, 9, 10, 12)
pass.**

- Confirmed: `verify` recomputes the CRCs (single-byte flips in temp copies at the UFW header, flash.bin and ota.bin
  all exit 1; a dense flip sweep finds only the unused padding at logical `0xE0–0x3FF` and the identity-marker bytes
  uncovered, which `--expect-sha256` / `--expect-identity` catch). IORegistry: `CoralFlower FM-1`, `0x1209:0x0001`,
  bcdDevice `0x0301`, root port `0x01100000`, `Unauthorized`. Rollback hashes equal CoralFlower's release
  `SHA256SUMS` and MvaveFM1Unbricker `331f848`'s pins. CoralFlower 0.7.1 `ota.c` step 1 differs from ours only in
  the kept-loader bookkeeping and record name constant (same `ota-FM-1_015`, same layout); `fl_crc` is not passed
  in the record, so our loader does not depend on our step 1. Both accept `0x856014`/`0xB36014`.
- Rebuilt in clean copies: HEAD, working tree default and dist all `00b00e64…3eaf`; BLE `35fb158c…e655` reproduced
  (89,956 B, RAM 25,832 B, pool 38,400 B, all within budget).
- **Fixed (would bite mid-install):** the resume instruction "run the same P4 command again" fails: `--port FM`
  never tries `Felucca Update`. New step P4-R (`--port Felucca`, then `--info --port FM`); `docs/recovery.md` tier 1
  updated.
- **Fixed:** `firmware-inspect` silently ignored unknown options and an empty `--expect-sha256`, so a typo in P0
  passed without the hash check. It now exits 2.
- Open: the loader's own comment ("the SPL runs the loader again after a power loss") contradicts CoralFlower's
  dark-unit finding; treat any power cut in step 2 as tier 5/6. The BLE identity `FM-1_956` equals what a future USB
  0.6 release would get.

## Run log (2026-11-18)

- P0 PASS: `verify` exit 0 (FM-1_951, `00b00e64…3eaf`); rollback SHA256SUMS all OK; `.fm1-flash-venv` (mido, python-rtmidi) and unbricker `setup` done; mock `restore --dry-run` ran.
- P1.2 PASS: accessory allowed. IORegistry product string is now `CoralFlower FM_1`, location `0x01100000` (direct port). CoreMIDI port name is `AMB-1 FM-1`, so P3 uses `--port FM`; `--port "CoralFlower FM-1"` would not match.
- Identity (handshake query only): `fm1_install.py --info --port FM` → `FM-1_930  [running]  port: AMB-1 FM-1`.
- Passive 5 s MIDI listen: 0 messages while idle.
- Pending: P1.3 splash version, P2 mask-ROM chip ID and double-read backup (needs sudo and the operator at the unit).
