# Dell Command Update test data

## `captured/`: real output (W10 lab, #11075)

Captured on 2026-11-19 from Dell Command | Update **5.7.2** (`dcu-cli.exe` 5.7.2.42, Windows Universal, Dell driver ID M9H5F) on a lab Dell OptiPlex 7060 desktop (BIOS 1.17.0, Windows 11 Pro). Stdout is the raw bytes a pipe sees (ASCII, CRLF). Nothing in these files names the machine, its service tag or a user.

| File | What it is |
|---|---|
| `scan-driver-application.txt` | `dcu-cli /scan -updateType=driver,application` stdout, exit 0. Lines look like `<ID>: <title> - <Type> -- <Urgency> -- <code>`. |
| `scan-report-all.xml` | `/scan -report=<folder>` output: `DCUApplicableUpdates.xml`. `-report` takes a **folder**. The file lists one BIOS, three drivers and two applications. |
| `apply-application-installed.txt` | `/applyUpdates -updateType=application -reboot=disable -autoSuspendBitLocker=enable` stdout, exit 0. Items look like `[<n>] <ID>, <title>, <version>`, followed by `<n> of <m> update(s) successfully installed.` **There is no per-item result line and no type.** |
| `apply-no-updates.txt` | The same apply run again, exit **500**: `No update information found.` |
| `settings-export-baseline.xml` | `/configure -exportSettings=<folder>` on a fresh install: `DellCommandUpdateSettings.xml`. Most properties are `Default="ValueIsDefault"`, with no value. |
| `settings-export-after-takeover.xml` | Export after `/configure -scheduleManual -updatesNotification=disable`. `ScheduleMode=ManualUpdates`, `DisableNotification=true`. |
| `settings-export-after-import-baseline.xml` | Export after `/configure -importSettings=<baseline file>`. `DisableNotification` went back to default, but **`ScheduleMode` stayed `ManualUpdates`**. Importing a default-valued export does not reset a value. `-scheduleAuto` writes an explicit `Auto`, not the default either. |

### What the lab showed (W10 D1 and D3)

- **Reserved folders.** `-outputLog`, `-report`, `-exportSettings` and `-importSettings` refuse any path under `C:\ProgramData`, `C:\Program Files` or `C:\Windows`, including the SYSTEM profile. DCU exits **107** with "The path provided for option '…' is a reserved folder that may not be used."
  - Every agent-owned directory is under one of those, so the lane passes no path and parses stdout instead. Without `-silent`, because that hides stdout.
  - Schedule takeover still exports under ProgramData, so it cannot work as built (see the W10 PR).
- **`-localblockedswb` is a `/configure` option**, not an `/applyUpdates` one (per `dcu-cli /help`).
  - Set through `/configure`, it does hide that release ID from `/scan`. But DCU then offered a different release ID for the same component: NP58K was blocked, and 4VJ35 (Intel ME Components) appeared.
  - The lane refuses a run with blocked IDs (`blocked_ids_unsupported`).
- **Installer.** The DUP `/s /l=<log>` install succeeds with exit **2**. It also installs Dell Core Services 1.15.18.0. The .NET Desktop Runtime prerequisite is needed: DCU 5.7.2 requires 10.0.8 or later.
- **Signers** (Authenticode leaf CN):
  - DCU installer and `dcu-cli.exe`: `Dell Technologies Inc.`
  - .NET Desktop Runtime 10.0.15 installer: `.NET` (O=Microsoft Corporation)
- **Exit codes seen:** 0 (installed), 500 (no updates), 107 (reserved path / missing import file), 106 (option not valid for the command). The rest of the table is still Dell's documentation.

## `doc-derived/`: still from documentation

`settings-export.xml` is the original guess at the export schema. The takeover fake still uses it. The real schema is close: nested `Group`/`Property` with `<Value>` children. The real export also marks defaults as `Default="ValueIsDefault"` with no value, which the guess does not model. Replace it when takeover is redesigned around the reserved-folder finding.
