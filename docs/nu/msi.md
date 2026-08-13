# NU Windows MSI

The NU-branded Windows installer. Source: `agent/installer/nu-agent.wxs`.
See also [branding.md](branding.md) (what may/may not be renamed),
[known-issues.md](known-issues.md) (semver trap), [operations.md](operations.md).

## Identity

| Field | Value | Notes |
|---|---|---|
| ProductName | "NU Agent" | Passed as a build param (`-d ProductName=…`); the wxs `ifndef` default is "Breeze Agent" (nu-agent.wxs line 16) |
| Manufacturer | "Nodes Unlimited" | nu-agent.wxs line 55 |
| Service DisplayNames | "NU Agent" / "NU Agent Watchdog" | Hardcoded in nu-agent.wxs lines 350, 385 |
| Internal service names | `BreezeAgent` / `BreezeWatchdog` | **PROTOCOL — never rename.** Agent code and watchdog reference them; renaming orphans existing installs. |
| Exe filenames | `nu-agent.exe`, `nu-watchdog.exe`, `nu-user-helper.exe`, `nu-backup.exe`, `nu-desktop-helper.exe` | **PROTOCOL** — referenced by the wxs ServiceControl/taskkill custom actions and the watchdog. |

## UpgradeCode — deliberate lineage reuse

`UpgradeCode = {70A57B7A-4F72-4E18-B8D3-7D2783C2C1A9}` — the ORIGINAL Hosted
edition's GUID, ON PURPOSE (nu-agent.wxs lines 15-19 and the preprocessor
comment block):

- Existing stock (Hosted) installs upgrade in place to the NU MSI.
- Enrollment SURVIVES the upgrade: `RemoveExistingProducts` is scheduled
  `afterInstallExecute` (nu-agent.wxs ~line 248), so the old product's
  RemoveFile rows for `secrets.yaml` / `agent.yaml` do NOT fire during an
  upgrade — the config directory carries over (see the comments at
  nu-agent.wxs lines 65-96).
- `AllowSameVersionUpgrades="yes"` (line 107) covers equal-version swaps
  (ProductCode is auto-generated per build).
- `{787838E2-1A3E-4B61-8514-75DD922A6B1B}` is the PERMANENT UpgradeCode of the
  separate Self-Hosted edition; a cross-edition `Upgrade`/Launch guard prevents
  the two products coexisting. Never let the editions share an UpgradeCode.

## Build paths

**Local:** `agent/installer/build-msi.ps1`. Requires the dotnet SDK plus the
WiX v4 CLI (`dotnet tool install --global wix`). Parameters: `-Version`,
`-Edition Hosted|SelfHost`, exe path overrides, `-OutputPath`
(default `dist/nu-agent.msi`). It expects the four `nu-*-windows-amd64.exe`
binaries next to the agent root.

**CI:** `.github/workflows/nu-msi.yml` builds the NU MSI on windows-latest
(triggers: `nu-v*` tag push, or `workflow_dispatch` with an explicit agent
`version` input). It runs `make build-winres` first — the embedded FileVersion
is what gives the MSI normal "newer wins" upgrade semantics (without it, an
exe that was ever modified on disk is never overwritten on upgrade — Makefile
`build-winres` comment, issue #944) — then cross-builds the four exes
(amd64 + arm64) and packages the x64 MSI via `build-msi.ps1`. The MSI is
downloaded from the workflow run's artifacts. arm64 MSI packaging is a
TODO (the wxs `-arch` is hardcoded x64 in `build-msi.ps1`).

## Version discipline

The agent version stamped into the MSI (`-Version`) MUST exactly equal the
server's binaries-volume `VERSION` file, or devices loop forever in "updating"
— see the semver prerelease trap in [known-issues.md](known-issues.md) and the
staging procedure in [operations.md](operations.md). Server image tags may use
`-nu.N` suffixes; agent artifacts may not.
