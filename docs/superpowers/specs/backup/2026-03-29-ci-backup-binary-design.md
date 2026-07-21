# CI Pipeline: breeze-backup Binary Build, Sign, and Ship

**Date:** 2026-03-29
**Status:** Approved design, pending implementation

## Problem

The `breeze-backup` binary is built locally via `make build-backup` but is not built, signed, or shipped in the CI/release pipeline. The agent spawns it as a subprocess for enterprise backup operations (Hyper-V, MSSQL, system image, file backup with provider upload). Without it in the installer, backup features fail silently on customer machines — the agent tries to spawn a binary that doesn't exist.

## Decision: Bundle in Installer

`breeze-backup` is bundled in the MSI (Windows) and .pkg (macOS) installers alongside `breeze-agent`. It shares the agent's Go module, IPC protocol, and provider implementations — version coupling is intentional. On-demand download (like breeze-helper) was considered but rejected: the complexity of a download manager isn't justified for a ~5-10MB binary, and backup should work immediately after install without waiting for a heartbeat cycle.

Linux agents get the binary from GitHub release assets (manual download, same as the agent itself).

## Changes

### 1. Build Job (`release.yml` — `build-agent` job)

Add a second build step to the existing `build-agent` job. Same matrix (Linux amd64, macOS amd64/arm64, Windows amd64), same Go version, same ldflags.

```yaml
- name: Build breeze-backup
  env:
    GOOS: ${{ matrix.goos }}
    GOARCH: ${{ matrix.goarch }}
    CGO_ENABLED: ${{ matrix.cgo }}
  run: |
    cd agent
    go build -ldflags="-s -w -X main.version=${BUILD_VERSION}" \
      -o "breeze-backup-${{ matrix.goos }}-${{ matrix.goarch }}${{ matrix.suffix }}" \
      ./cmd/breeze-backup

- name: Upload breeze-backup artifact
  uses: actions/upload-artifact@v4
  with:
    name: breeze-backup-${{ matrix.goos }}-${{ matrix.goarch }}
    path: agent/breeze-backup-${{ matrix.goos }}-${{ matrix.goarch }}${{ matrix.suffix }}
    retention-days: 30
```

### 2. Windows Signing + MSI (`build-windows-msi` job)

**Build backup binary with Windows resources:**

```yaml
- name: Build breeze-backup (Windows)
  run: |
    cd agent
    GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
      go build -ldflags="-s -w -X main.version=${{ env.BUILD_VERSION }}" \
        -o "../dist/breeze-backup-windows-amd64.exe" \
        ./cmd/breeze-backup
```

**Sign the backup EXE** using the same Azure Trusted Signing steps as the agent EXE. Both stable and prerelease profiles.

**Update `build-msi.ps1`** to accept a new `-BackupExePath` parameter and pass it to WiX:

```powershell
param(
    [string]$Version = "0.1.0",
    [string]$AgentExePath,
    [string]$BackupExePath,    # NEW
    [string]$OutputPath
)
# ...
wix build breeze.wxs `
  -d "BackupExePath=$BackupExePath" `
  # ... existing -d flags
```

**Update `breeze.wxs`** to add a new component:

```xml
<!-- Backup Binary -->
<Component Id="cmpBreezeBackupExe" Guid="*">
  <File Id="filBreezeBackupExe" Name="breeze-backup.exe"
        Source="$(var.BackupExePath)" KeyPath="yes" />
</Component>
```

Add `<ComponentRef Id="cmpBreezeBackupExe" />` to the `MainFeature`.

**Verify signature** of breeze-backup.exe alongside breeze-agent.exe.

**Upload signed backup artifact** alongside signed agent artifact.

### 3. macOS Signing + pkg (`build-macos-agent` job)

**Download backup artifacts** for both architectures (amd64, arm64).

**Sign backup binaries** with the same codesign identity and entitlements:

```bash
codesign --force --options runtime \
  --entitlements agent/entitlements/agent-macos.entitlements.plist \
  --sign "$APPLE_SIGNING_IDENTITY" --timestamp \
  "staging/breeze-backup-darwin-${arch}"
```

**Notarize backup binaries** alongside agent binaries (zip and submit together or separately).

**Update `build-pkg.sh`** to accept and install the backup binary:

```bash
#!/bin/bash
# Updated usage: build-pkg.sh <agent-binary> <backup-binary> <version> <arch> <output>
AGENT_BIN="$1"
BACKUP_BIN="$2"
VERSION="$3"
ARCH="$4"
OUTPUT="$5"

# Install both binaries
cp "$AGENT_BIN" "$PAYLOAD/usr/local/bin/breeze-agent"
cp "$BACKUP_BIN" "$PAYLOAD/usr/local/bin/breeze-backup"
chmod 755 "$PAYLOAD/usr/local/bin/breeze-backup"
```

**Update the CI step** that calls build-pkg.sh to pass the backup binary path.

**Sign and notarize the .pkg** as before (contains both binaries now).

### 4. Release Artifacts (`create-release` job)

**Update artifact download pattern:**

```yaml
pattern: '{api-dist,web-dist,breeze-agent-*,breeze-backup-*,breeze-viewer-*,breeze-helper-*}'
```

**Add backup binaries to release assets:**

```bash
# Copy backup binaries
for dir in artifacts/breeze-backup-*; do
  if [ -d "$dir" ] && ls "$dir"/* >/dev/null 2>&1; then
    cp "$dir"/* release-assets/
  fi
done
```

**Include in SHA256 checksum generation** (already covered by the `sha256sum release-assets/*` pattern).

### 5. No Agent Code Changes

The agent spawns `breeze-backup` by looking in its own directory or on PATH. Both the MSI install directory and `/usr/local/bin/` satisfy this. No Go changes needed.

## Files Changed

| File | Change |
|------|--------|
| `.github/workflows/release.yml` | Add backup build step to `build-agent`, sign in `build-windows-msi`, sign in `build-macos-agent`, download in `create-release` |
| `agent/installer/build-msi.ps1` | Add `-BackupExePath` parameter, pass to WiX |
| `agent/installer/breeze.wxs` | Add `BackupExePath` variable, `cmpBreezeBackupExe` component |
| `agent/installer/macos/build-pkg.sh` | Accept and install backup binary |

## Out of Scope

- On-demand download infrastructure (decided against — bundle instead)
- Linux installer/package (Linux agents use direct binary download from release assets)
- breeze-backup Windows resource manifest (winres.json) — not needed for a subprocess, only the agent service needs Windows metadata
- Docker image inclusion (backup is an agent-side binary, not a server component)
