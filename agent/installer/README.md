# Windows MSI Build

This folder contains the WiX v4 installer definition and custom action scripts for packaging `breeze-agent.exe` as an MSI.

## Prerequisites

- Windows host (or Windows CI runner)
- WiX v4 CLI (`wix`)
- PowerShell
- Built `breeze-agent-windows-amd64.exe`

## Build

From a PowerShell session:

```powershell
# from repo root
cd agent
$env:BUILD_VERSION = "1.2.3"

# Generate Windows resources (.syso) — embeds VERSIONINFO + manifest + icon
# into each cmd/breeze-*/ package. Required so MSI recognizes a FileVersion
# on the resulting EXEs (#944).
make build-winres VERSION=$env:BUILD_VERSION

# Build the Windows binary
make build-windows VERSION=$env:BUILD_VERSION

# Build MSI
powershell -ExecutionPolicy Bypass -File installer/build-msi.ps1 `
  -Version $env:BUILD_VERSION `
  -AgentExePath "$PWD\\bin\\breeze-agent-windows-amd64.exe" `
  -OutputPath "$PWD\\..\\dist\\breeze-agent.msi"
```

## Silent Install with Enrollment

```powershell
msiexec /i breeze-agent.msi /qn SERVER_URL=https://rmm.example.com ENROLLMENT_KEY=ek_abc123
```

The MSI will:
- Install `breeze-agent.exe` under `C:\Program Files\Breeze\`
- Create `C:\ProgramData\Breeze\{data,logs}`
- Install Windows service `BreezeAgent` with executable args `run` (startup type `Manual` by default)
- Register scheduled task `\Breeze\AgentUserHelper`
- If `SERVER_URL` and `ENROLLMENT_KEY` are provided, run enrollment and switch the service to `Automatic` + start it

Notes:
- `SERVER_URL` and `ENROLLMENT_KEY` must be provided together (or both omitted).
- Major upgrades are scheduled after install execution for safer rollback semantics.

## Uninstall

```powershell
msiexec /x breeze-agent.msi /qn
```

Uninstall removes service, binaries, and scheduled task. `ProgramData` content is intentionally preserved.

## Kill-Processes Contract

The `KillBreezeProcesses` custom action runs `taskkill /F /T /IM` against
`breeze-agent.exe`, `breeze-user-helper.exe`, `breeze-watchdog.exe`,
`breeze-desktop-helper.exe`, and `breeze-backup.exe` before `InstallValidate`
on **every install path except uninstall** (`Condition="NOT REMOVE"`).

Why "every install path", not just upgrades:

- A fresh MSI install can land on top of a `Program Files\Breeze\` directory
  populated by a previous uninstall (binaries can survive uninstall if MSI
  was forced to retain them via `/qn` rollback) or by a non-MSI deployment
  (older PowerShell-based installer, manual drop-in). Without an embedded
  `FileVersion` on those leftover EXEs, MSI 5 applies the "preserve
  user-modified unversioned files" rule and refuses to overwrite a locked
  copy.
- The companion fix in `agent/Makefile build-winres` and
  `.github/workflows/release.yml` embeds `VERSIONINFO` (via `go-winres
  simply`) into every Windows binary so MSI's "newer-wins" rule applies and
  this fallback shouldn't routinely trigger — but the kill-CA is the
  belt-and-braces guarantee for the upgrade-from-pre-VERSIONINFO case.

The `taskkill ... & exit /b 0` shell pattern means missing-process errors
return success, so the CA is idempotent on boxes with nothing to kill. The
CA uses `Return="ignore"` for the same reason: a `taskkill` quirk should
not roll back the install.

See issue #944.
