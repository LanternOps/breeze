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

# Optional: generate Windows resources (.syso)
make build-winres

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
