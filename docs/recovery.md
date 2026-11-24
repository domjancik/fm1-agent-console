# FM-1 recovery

Date: 2026-11-17. Scope: the CoralFlower FM-1 on this Mac (USB `0x1209:0x0001`) before and after the FM1 CONSOLE
firmware (`FM-1_951`) is installed. Pre-flash checks and the flash plan: `reports/preflight.md`.

Read this first:

- The FM-1 flash has **one bank**. An update rewrites the app in place. There is no second copy to fall back to.
- Every rescue below except the mask ROM depends on code in the flash. **Do not assume that OCT− at power-on works
  if the app or the loader is damaged.** Plan for the mask ROM (tier 5) and, last, the hardware route (tier 6).
- Nothing in this repository sends SysEx to the device or writes its flash. Every write below is an operator step.

## Flash map (1 MiB SPI NOR)

| Range | Contents | Written by |
| --- | --- | --- |
| `0x00000–0x03FFF` | Boot head: JieLi SPL (`uboot.boot`), `isd_config.ini` with the chip key (`0x980F`) | Only the official M-VAVE loader and the unbricker's `full-restore` |
| `0x04000–0x92FFF` | App area (SFC-encrypted with the chip key) | Every firmware update; the unbricker's `restore` |
| `0x93000–0xDFFFF` | Firmware data (VM, projects, settings; layout depends on the firmware; V16 puts VM at `0xBA000`) | The running firmware |
| `0xE0000–0xE4FFF` | Update staging: the next loader, the update record at `0xE4F00` | Step 1 of an update |
| `0xE9000–0xE9FFF` | Bluetooth data (per unit) | Never by updates |
| `0xEA000–0xFBFFF` | Factory voices on stock units; Felucca-family data | Some firmwares overwrite it; only a backup restores it |
| `0xFC000–0xFEFFF` | Settings (Dinghy: `0xFC000`; FM1 CONSOLE saves none) | The running firmware |
| `0xFF000–0xFFFFF` | `key_mac` (per unit) | Never |

Sources: `firmware/tools/fm1pkg_make.py`, `firmware/firmware/src/ota.c`, `firmware/firmware/src/store.h`,
MvaveFM1Unbricker `README.md` ("full-restore").

## Where the backups and rollback images are

| What | Path | SHA-256 |
| --- | --- | --- |
| CoralFlower 0.7.1 package (GitHub release `v0.7.1`, commit `46790b9`) | `/Users/dominikj/dev/personal/.fm1-rollback/coralflower-0.7.1/coralflower-0.7.1.fwsc` | `d87d6327e0f98000cfa740bab70487728de85d3d64fd96c3a65dfd6bbdf71bbd` |
| Official M-VAVE V15 (`FM-1_015`) | `/Users/dominikj/dev/personal/.fm1-rollback/stock-mvave/V15-FM-1.fwsc` | `db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a` |
| Official M-VAVE V16 (`FM-1_016`) | `/Users/dominikj/dev/personal/.fm1-rollback/stock-mvave/V16-FM-1.fwsc` | `d017fb65e70aca97ee29d944470c3515a74581df5c0576bf70de917c7b2b61d5` |
| Full flash backup of this unit | `/Users/dominikj/dev/personal/.fm1-rollback/device-backup/` (**not taken yet**; preflight step P2) | recorded at backup time |

Check them with `shasum -a 256 -c /Users/dominikj/dev/personal/.fm1-rollback/SHA256SUMS` and
`bun tools/firmware-inspect/src/cli.ts verify FILE`. All four pass (`reports/preflight.md`, check 7).

## Tools

- `firmware/tools/fm1_install.py`: the USB-MIDI installer (Dinghy upstream, unchanged). Needs `mido` and
  `python-rtmidi` (not installed on this Mac yet). It finds the device by port name: `PORT_RE` matches `fm-1`,
  `felucca`, `ota` and others. **`PORT_RE` does not match `FM1 CONSOLE`.** Use `--port FM` with this firmware: it matches
  `CoralFlower FM-1`, `FM1 CONSOLE` and its rescue mode. The loader (`Felucca Update`) matches `PORT_RE`, so a fresh
  install with `--port FM` still finds it after step 1, but resuming a unit that is already in update mode needs
  `--port Felucca` (tier 1).
  `--info` sends one identity query (SysEx `F0 00 32 45 …`); there is no mode that sends nothing.
- `tools/firmware-inspect` (this repo, read-only): `verify PKG.fwsc`, `dump FULL.bin [--second B] [--package P]`,
  `device`.
- MvaveFM1Unbricker (`/Users/dominikj/dev/personal/.fm1-upstream/MvaveFM1Unbricker`, commit `331f848`): mask-ROM
  access through jl-uboot-tool. Not set up yet (needs `setup`, a venv, and `sudo` on macOS).

## macOS accessory security (applies to every tier)

This Mac asks before a new USB accessory may connect. On 2026-11-17 the FM-1 on the direct USB-C port showed
`AuthorizationStatusDescription = "Unauthorized"`, policy "Ask for New Accessories". In that state macOS gives it
no MIDI port and no serial port, so every tool reports "not found". The operator must click **Allow**.

During an update the device appears under three USB identities, and each may raise its own prompt:
`CoralFlower FM-1` (`0x1209:0x0001`), `Felucca Update` (`0x1209:0x0002`, the loader), and `FM1 CONSOLE`
(`0x1209:0x0001`). The mask ROM appears as `WL82 UBOOT1.00` (`0x4C4A:0x8057`). Someone must be at the Mac to allow
each one. `bun tools/firmware-inspect/src/cli.ts device` shows the current state.

## Tier 1: normal update over USB-MIDI

The running firmware checks the package and stages its loader (step 1). The loader then writes the app area and
restarts (step 2). Both CoralFlower 0.7.1 and FM1 CONSOLE run the same step-1 checks (`ota.c` `ota_stage`).

```sh
cd /Users/dominikj/dev/personal/fm1-agent-console
PY=/Users/dominikj/dev/personal/.fm1-flash-venv/bin/python      # venv with mido + python-rtmidi
$PY firmware/tools/fm1_install.py --info --port FM                # identity only
$PY firmware/tools/fm1_install.py PACKAGE.fwsc --port FM          # asks before writing
```

- Exit 0: done. Exit 3: not found (accessory not allowed, wrong port, another app holds the port). Exit 4 in step 1
  ("after N requests; nothing was written"): the firmware refused, nothing changed. Exit 4 or 5 in step 2: the unit
  stays in update mode; **do not power off**; allow the `Felucca Update` accessory and resume with
  `$PY firmware/tools/fm1_install.py PACKAGE.fwsc --port Felucca` (the installer resumes a loader named
  `ota-FM-1_9XX`). **Not `--port FM`:** its first search only tries ports whose name contains "fm", and `Felucca Update`
  does not, so it exits 3 with the unit still in update mode. After a resumed write the installer cannot see
  `FM1 CONSOLE` (it is neither `Felucca…` nor `PORT_RE`) and exits 5 "did not come back"; confirm with `--info --port FM`. Exit 5 "did not come back" after a finished write: allow
  the new accessory and run `--info --port FM`.
- The Felucca-family loader writes only `0x4000–0x92FFF`, skips sectors that are already equal, verifies each
  sector, and refuses a package that does not decrypt with this unit's chip key before it erases anything.
- A Felucca-family firmware runs the updater only when it recognises the flash chip. CoralFlower before 0.7 and
  Dinghy 0.4 know only `0x856014`. On a `0xB36014` unit they ignore the update request (installer exit 4, nothing
  written). This is the "firmware lock": go to tier 5.

## Tier 2: rescue at power-on (OCT− alone)

**On CoralFlower (now).** CoralFlower's boot stub lives in flash sector `0x4000`. It samples OCT− at power-on and
then starts the loader that CoralFlower keeps staged at `0xE0000` after its own install. If there is no valid
staged loader, or the rescue fails twice, the stub enters the mask ROM. The stub also refuses to boot an app body
without its commit marker. Limits:

- Step 1 of any install erases the staging area. After a refused or failed install the kept loader is gone, and
  OCT− then leads to the mask ROM.
- Installing FM1 CONSOLE replaces sector `0x4000`, so the CoralFlower stub is gone after (and during) that install.

**On FM1 CONSOLE (after the flash).** The rescue is part of the app (Dinghy's `recovery.c`): hold OCT− alone at
power-on; the screen shows `FM1 CONSOLE USB RESCUE`; the unit answers the installer as `FM-1_000`. Install with
tier 1 (`--port FM`). The boot guard also enters rescue after two failed boots, and enters the mask ROM when the
rescue itself resets. All of this needs the app's startup code and USB stack intact. It cannot help when the app
fails before it runs.

**Do not assume OCT− works if the loader or the app is damaged.** Go to tier 5.

## Tier 3: restoring CoralFlower

From FM1 CONSOLE, over USB-MIDI (CoralFlower's loader passes FM1 CONSOLE's step-1 checks; `firmware-inspect verify`
shows `loader.updater-accepts` PASS for `coralflower-0.7.1.fwsc`):

```sh
$PY firmware/tools/fm1_install.py /Users/dominikj/dev/personal/.fm1-rollback/coralflower-0.7.1/coralflower-0.7.1.fwsc --port FM
```

CoralFlower's web installer matches the port name "FM-1", which `FM1 CONSOLE` does not contain: use the command
above. From the mask ROM: `fm1_unbrick.py restore coralflower-0.7.1.fwsc` (tier 5). CoralFlower's projects come
back only from the full flash backup (`full-restore --image`, tier 5).

## Tier 4: official M-VAVE firmware

- **V15** (`FM-1_015`) is the image the unbricker's `restore` accepts. **V16** runs to `0xA8FFF` and brings a
  larger boot head: only `full-restore V16-FM-1.fwsc` writes it.
- Which one applies depends on the boot head now on the unit. Read it from the backup:
  `bun tools/firmware-inspect/src/cli.ts dump BACKUP.bin --package /Users/dominikj/dev/personal/.fm1-rollback/stock-mvave/V15-FM-1.fwsc`
  reports the head as "stock M-VAVE V15 boot head", "… V16 …" or unknown, and whether it equals the package's.
- Over USB-MIDI, the official loader rewrites the whole flash.bin, head included, so the running Felucca-family
  updater accepts an official package only when the package's head equals the unit's head. A V15 package on a
  unit with the V16 head is refused (nothing written). `fm1_install.py` also needs `--force` for an official package
  (it has no Felucca loader mark). **Do not downgrade to V15 without this check.**
- After going back to stock, garbled presets come from the other firmware's data in the settings areas: the
  unbricker's `repair-settings` puts them back to factory state.

## Tier 5: mask-ROM UBOOT with MvaveFM1Unbricker

The chip's mask ROM (`WL82 UBOOT1.00`, `0x4C4A:0x8057`) cannot be erased by any update. From it the whole flash can
be read and written.

Ways in:

1. **CoralFlower (now):** hold **OCT− and OCT+ together for 5 s** while it runs. A countdown, then `UBOOT`. No
   host message is needed (`CoralFlower firmware/src/main.c:313`).
2. Any Felucca-family firmware, FM1 CONSOLE included: the SysEx soft key `F0 22 24 35 7D F7`
   (`fm1_unbrick.py softkey`). FM1 CONSOLE has no OCT−+OCT+ key combination.
3. CoralFlower's boot stub with no valid staged loader; FM1 CONSOLE's boot guard when the rescue resets.
4. A soft-bricked unit often enumerates as `WL82 UBOOT1.00` by itself. Not guaranteed.

A power cycle leaves the mask ROM and boots the flash again.

Set-up on this Mac (once; downloads jl-uboot-tool at its pinned commit and pip packages):

```sh
cd /Users/dominikj/dev/personal/.fm1-upstream/MvaveFM1Unbricker
python3 -m venv .venv && .venv/bin/python fm1_unbrick.py setup
```

macOS needs `sudo` for every command that opens the device. macOS releases the device after about 30 s, so start
the command right after entering UBOOT. If macOS says the disk is not readable, click **Ignore** (never
Initialize). Allow the `WL82 UBOOT1.00` accessory if asked.

```sh
sudo -v
sudo .venv/bin/python fm1_unbrick.py info                       # chip key 0x980F, flash JEDEC ID (read-only)
sudo .venv/bin/python fm1_unbrick.py backup DIR [--package P]   # whole 1 MiB read twice, compared, saved
sudo .venv/bin/python fm1_unbrick.py restore PACKAGE.fwsc       # backup, then 0x4000-0x92FFF, verified byte for byte
sudo .venv/bin/python fm1_unbrick.py full-restore --image FULL.bin   # everything from a backup, head included
```

- `restore` accepts official V15 and Felucca-family packages (`FM-1_951` checked with `--dry-run` on a mock
  device: firmware region SHA-256 `115f8fd5db65ed4338cb96f896840ac3994d18ac7401221163afafd80793bb95`, the same
  value `firmware-inspect` computes).
- `full-restore --image` puts back this unit's own backup byte for byte, factory voices and projects included. It
  keeps the unit's Bluetooth and `key_mac` areas unless told otherwise.
- If a write does not verify: **do not power off**; run the command again (another cable or port helps).
- Tested by the unbricker's author on an Apple-silicon Mac with a `0x856014` unit (2026-11-10).

## Tier 6: hardware

A unit that shows nothing on USB in any mode needs the FM-1 Transporter (a Seeed XIAO RP2040 on the USB data lines
that forces the chip into the ROM mode): `MvaveFM1Unbricker/TRANSPORTER-GUIDE.md` and
`fm1_transporter_recover.py`. It writes only `0x4000–0x92FFF` and cannot write the boot head.

## Hardware risks

- **Single bank.** A cut during the app write leaves part old, part new code. Nothing boots it.
- **Power loss during step 2.** Felucca's and Dinghy's loaders say the SPL runs the loader again from the flash copy
  of the update record after a power loss. CoralFlower's authors found on a dark unit that the SPL does **not** do
  this on a cold boot (`CoralFlower firmware/loader/ldr_core.c:29-31`); their boot stub exists for that reason. The
  FM1 CONSOLE loader writes in address order with no stub, so a power cut mid-write probably means tier 5 or 6.
  Keep the battery charged and the cable in; a USB disconnect alone is fine because the loader keeps running and
  the installer resumes.
- **Interrupted step 1** writes nothing outside the staging area and is safe. It does remove CoralFlower's kept
  rescue loader.
- **Boot head.** Felucca-family loaders never write it. Only the official loader and `full-restore` do. A bad head
  needs `full-restore` from the ROM.
- **Flash chip.** Both known chips (`0x856014` Puya P25Q80, `0xB36014` UCUN UC25HQ80) are accepted by FM1 CONSOLE,
  its loader and CoralFlower 0.7.x. Firmware that knows only `0x856014` locks a `0xB36014` unit.
- **Data areas.** A new firmware leaves the old firmware's data in `0x93000–0xFEFFF`. FM1 CONSOLE calls no store
  function (`console.c`), so CoralFlower's projects stay in place. At every boot it erases the staging area
  `0xE0000–0xE4FFF` if anything is there (`ota_boot_cleanup`). Factory voices that another firmware overwrote come
  back only from a backup.
- **Hubs and cables.** Use a data cable straight into the Mac. The unit is on the built-in port `0x01100000` now
  (it was behind a hub at `0x02142000` earlier).

## Rules

- Take and double-check the full backup before the first write. Keep it outside the repo.
- Re-read the device identity right before any write.
- One device on USB during recovery.
- Never `erasechip`; never write below `0x4000` except with `full-restore` from a verified head.
- If a write fails, stop and report. No automatic recovery write (operator authorization in
  `docs/discovery/connected-device.md`).
