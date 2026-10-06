# srprobe — System Restore struct-layout harness (#4752)

Throwaway Windows diagnostic for Open Decision 1 of #4609 (wave W01, #4752):
which memory layout of `RESTOREPOINTINFOW` / `STATEMGRSTATUS` does
`srclient!SRSetRestorePointW` actually use? **Not shipped** — it is not part of
any agent build target, and it is deleted once all four target verdicts below
are recorded.

It creates real restore points. Run it only on a disposable test machine,
never on a host running a Breeze agent you care about. It does not change any
System Restore configuration itself.

## The three candidate layouts

| | `RESTOREPOINTINFOW` | `STATEMGRSTATUS` |
|---|---|---|
| **A** — shipped before #4752 | seq `uint32` @8, `szDescription` @12, 524 bytes | seq `uint32` @4, 8 bytes |
| **B** — `INT64`, natural alignment | seq `int64` @8, `szDescription` @16, 528 bytes | seq `int64` @8, 16 bytes |
| **C** — SDK header (`#pragma pack(1)`) | seq `int64` @8, `szDescription` @16, 528 bytes | seq `int64` @4, 12 bytes |

`srrestoreptapi.h` (Windows SDK; the mingw-w64 copy is identical) wraps both
structs in `#pragma pack(1)`, so **C** is what the header declares. #4752
moves the agent to C and pins it with `internal/patching/restorepoint_abi_test.go`.
The hardware runs below are the empirical check.

## What the harness does

1. Prints the OS build and `SystemRestorePointCreationFrequency`.
2. **Probe A**: the shipped call byte-for-byte (layout A, `BEGIN_SYSTEM_CHANGE`
   only) with description `BREEZE-PROBE-A-<hhmmss>`.
3. **Probe C**: layout C, `BEGIN_SYSTEM_CHANGE` with `BREEZE-PROBE-C-<hhmmss>`,
   then `END_SYSTEM_CHANGE` using the sequence number decoded per C.
4. Every status buffer is 16 bytes pre-filled with `0xCC`, and the hex dump
   shows exactly which bytes the DLL wrote, decoded three ways (A/B/C).
5. Enumerates `root/default:SystemRestore`.

## Reading the verdict

| Observation | Meaning |
|---|---|
| Status bytes 0–11 written, 12–15 still `cc` | `STATEMGRSTATUS` is 12 bytes → **C** (layout A's 8-byte buffer was too small for what the DLL writes) |
| Probe A's point enumerates as `EEZE-PROBE-A-…` (first two characters missing) | `szDescription` is at offset 16 → **B/C**, not A |
| Probe A's point enumerates as `BREEZE-PROBE-A-…` intact | `szDescription` is at offset 12 → **A** |
| Probe C's END returns `ret=1`, `nStatus=0` | The sequence decoded at offset 4 is the real one → **C** |
| Only one new point appears, both probes report the same sequence | Creation-frequency throttle — set the frequency to 0 for the run (below) and re-run |
| `SRSetRestorePointW not available` | System Restore is not present on this SKU; the layout cannot be observed here |

## Running it on a pending target

Build on any machine with Go (from the repo's `agent/` directory):

```bash
GOOS=windows GOARCH=amd64 go build -o srprobe.exe ./cmd/srprobe
```

Copy `srprobe.exe` to the test machine and run from an **elevated** PowerShell:

```powershell
Get-ComputerRestorePoint | Format-List                         # before
Enable-ComputerRestore -Drive "C:\"                            # test box only
# Lift the 24h creation throttle for this run only (test box only):
$k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
New-ItemProperty -Path $k -Name SystemRestorePointCreationFrequency -PropertyType DWord -Value 0 -Force | Out-Null
.\srprobe.exe 2>&1 | Tee-Object -FilePath "srprobe-$env:COMPUTERNAME.txt"
Remove-ItemProperty -Path $k -Name SystemRestorePointCreationFrequency   # restore default
Get-ComputerRestorePoint | Format-List                         # after
```

Paste `srprobe-<host>.txt` and both `Get-ComputerRestorePoint` listings into a
comment on #4752 (and append a row to the table below).

## Results

| Target | Build | Verdict | Run |
|---|---|---|---|
| Windows Server 2022 Standard (Evaluation) 21H2 | 20348.5256 | **System Restore unavailable** — `srclient.dll` not present, `root/default:SystemRestore` is an invalid class. Layout not observable on this SKU. | 2026-10-06, lab VM |
| Windows 11 (24H2+) | — | **PENDING** | — |
| Windows 10 22H2 | — | **PENDING** | — |
| Windows Server 2025 | — | **PENDING** (expected to match Server 2022: no System Restore on Server SKUs) | — |

### Windows Server 2022 — raw output (2026-10-06)

```
=== Get-ComputerRestorePoint available? ===
srprobe — 2026-10-06T03:22:24Z
Go struct sizes:
  A: sizeof(RESTOREPOINTINFOW)=524 offsetof(szDescription)=12 sizeof(STATEMGRSTATUS)=8
  C: sizeof(RESTOREPOINTINFOW)=528 offsetof(szDescription)=16 sizeof(STATEMGRSTATUS)=12 (SDK, pack(1))
OS: Windows Server 2022 Standard Evaluation 21H2 (Server) build 20348.5256
SystemRestorePointCreationFrequency: key unreadable (The system cannot find the file specified.)
RESULT: SRSetRestorePointW not available: The specified module could not be found.
VERDICT: unsupported on this machine (entry point missing); layout cannot be observed here
Name
----
Get-ComputerRestorePoint
=== root/default:SystemRestore (before) ===
CIM error: Invalid class
=== sr*.dll in System32 ===
(no srclient.dll; only unrelated sr*.dll files: srchadmin, SRH, srm*, srpapi, srum*, srvcli, srvsvc, …)
srprobe exit code: 2
```

(`Get-ComputerRestorePoint` exists as a cmdlet on Server, but the WMI class it
reads does not.) On this SKU the agent's patch-install path has always returned
`SRSetRestorePoint not available` and logged it at debug level — no restore
point was ever created there, independent of the layout question.
