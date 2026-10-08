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
| Windows 11 Pro 25H2 (physical Dell, `dell70601`) | 26200.8653 | **Layout C (SDK, `pack(1)`) confirmed.** The status buffer had bytes 0–11 written and 12–15 still `cc`. Probe A's point enumerates as `EEZE-PROBE-A-…`. Probe C BEGIN `ret=1 nStatus=0 seq=4`, then END `ret=1 nStatus=0`, and its point enumerates intact as `BREEZE-PROBE-C-…` seq 4. With SR disabled (as found), both calls return `ret=0`, `nStatus=1058` (ERROR_SERVICE_DISABLED). | 2026-10-08, lab box |
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

### Windows 11 Pro 25H2 — raw output (2026-10-08)

The machine is a physical Dell, build 26200.8653. Before the run, System Restore was **off** on `C:`: there were no restore points, no shadow-storage association, and no `SystemRestorePointCreationFrequency` value. The run went as follows:

1. Ran the harness once as found, with System Restore disabled.
2. Ran `Enable-ComputerRestore -Drive C:\` and set the creation frequency to 0.
3. Ran the harness again.
4. Removed the frequency override and ran `Disable-ComputerRestore`.
5. Deleted the two probe shadows. The shadow-storage association went with them, so the box ended in its original state.

The harness `OS:` line reads `Windows 10 Pro` because it reports the `ProductName` registry value, which still says "Windows 10" on Windows 11. `Win32_OperatingSystem.Caption` is `Microsoft Windows 11 Pro`.

**Disabled (as found):**
```
srprobe — 2026-10-08T16:40:50Z
Go struct sizes:
  A: sizeof(RESTOREPOINTINFOW)=524 offsetof(szDescription)=12 sizeof(STATEMGRSTATUS)=8
  C: sizeof(RESTOREPOINTINFOW)=528 offsetof(szDescription)=16 sizeof(STATEMGRSTATUS)=12 (SDK, pack(1))
OS: Windows 10 Pro 25H2 (Client) build 26200.8653
SystemRestorePointCreationFrequency: not set (default 1440 minutes)
SRSetRestorePointW: found

Probe A (shipped layout, BEGIN only): ret=0 callErr=The specified module could not be found. desc="BREEZE-PROBE-A-164050"
  A status bytes: 220400000000000000000000cccccccc (highest offset changed from canary: 11)
    decode A (uint32 seq @4):  nStatus=1058 seq=0
    decode B (int64 seq @8):   nStatus=1058 seq=-3689348818177884160
    decode C (int64 seq @4):   nStatus=1058 seq=0

Probe C (SDK layout, BEGIN): ret=0 callErr=The specified module could not be found. desc="BREEZE-PROBE-C-164050"
  C-begin status bytes: 220400000000000000000000cccccccc (highest offset changed from canary: 11)
    decode A (uint32 seq @4):  nStatus=1058 seq=0
    decode B (int64 seq @8):   nStatus=1058 seq=-3689348818177884160
    decode C (int64 seq @4):   nStatus=1058 seq=0

--- root\default:SystemRestore enumeration ---
```

**Enabled, frequency 0 (`Get-ComputerRestorePoint` before: empty):**
```
srprobe — 2026-10-08T16:40:52Z
Go struct sizes:
  A: sizeof(RESTOREPOINTINFOW)=524 offsetof(szDescription)=12 sizeof(STATEMGRSTATUS)=8
  C: sizeof(RESTOREPOINTINFOW)=528 offsetof(szDescription)=16 sizeof(STATEMGRSTATUS)=12 (SDK, pack(1))
OS: Windows 10 Pro 25H2 (Client) build 26200.8653
SystemRestorePointCreationFrequency: 0 minutes
SRSetRestorePointW: found

Probe A (shipped layout, BEGIN only): ret=1 callErr=The operation completed successfully. desc="BREEZE-PROBE-A-164052"
  A status bytes: 000000000200000000000000cccccccc (highest offset changed from canary: 11)
    decode A (uint32 seq @4):  nStatus=0 seq=2
    decode B (int64 seq @8):   nStatus=0 seq=-3689348818177884160
    decode C (int64 seq @4):   nStatus=0 seq=2

Probe C (SDK layout, BEGIN): ret=1 callErr=The operation completed successfully. desc="BREEZE-PROBE-C-164052"
  C-begin status bytes: 000000000400000000000000cccccccc (highest offset changed from canary: 11)
    decode A (uint32 seq @4):  nStatus=0 seq=4
    decode B (int64 seq @8):   nStatus=0 seq=-3689348818177884160
    decode C (int64 seq @4):   nStatus=0 seq=4

Probe C (SDK layout, END seq=4): ret=1 callErr=The operation completed successfully.
  C-end status bytes: 000000000400000000000000cccccccc (highest offset changed from canary: 11)
    decode A (uint32 seq @4):  nStatus=0 seq=4
    decode B (int64 seq @8):   nStatus=0 seq=-3689348818177884160
    decode C (int64 seq @4):   nStatus=0 seq=4

--- root\default:SystemRestore enumeration ---
SequenceNumber   : 2
Description      : EEZE-PROBE-A-164052
CreationTime     : 20261008164052.938952-000
RestorePointType : 0
EventType        : 100
```

`root/default:SystemRestore` about 15 s later, after probe C's END had finalized:
```
SequenceNumber Description           RestorePointType EventType CreationTime
-------------- -----------           ---------------- --------- ------------
             2 EEZE-PROBE-A-164052                  0       100 20261008164052.938952-000
             4 BREEZE-PROBE-C-164052                0       100 20261008164105.014630-000
```
The run immediately after the END enumerated only seq 2: probe C's point is not listed until its END finishes, which took about 13 s. Probe A was never ENDed, matching the shipped BEGIN-only call. It still produced a listed point, but the first two characters of the description are missing, as layout A predicts.

The Windows test binary (`GOOS=windows go test -c ./internal/patching`) ran natively on this machine. `TestRestorePointInfoLayout`, `TestStatemgrStatusLayout`, `TestStatemgrStatusSequenceDecode`, and `TestRestorePointCallFailed` (5 subtests) all PASS.
