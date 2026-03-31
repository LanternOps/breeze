# CI Pipeline: breeze-backup Binary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `breeze-backup` binary to the CI release pipeline — build, sign (Windows + macOS), bundle in installers (MSI + pkg), and publish as release assets.

**Architecture:** Mirror the existing `breeze-agent` build/sign/ship pipeline for `breeze-backup`. The backup binary is built alongside the agent in the same job, signed with the same credentials, bundled in the same installers, and published in the same GitHub release.

**Tech Stack:** GitHub Actions, Go cross-compilation, Azure Trusted Signing (Windows), Apple codesign + notarytool (macOS), WiX v4 (MSI), pkgbuild (macOS pkg)

**Spec:** `docs/superpowers/specs/2026-03-29-ci-backup-binary-design.md`

---

### Task 1: Add backup build + upload to `build-agent` job

**Files:**
- Modify: `.github/workflows/release.yml` (lines 138-158, inside `build-agent` job)

- [ ] **Step 1: Add backup build step after the agent build step**

In `.github/workflows/release.yml`, find the "Build Agent" step (around line 138). After the "Upload Agent artifact" step (around line 153-158), add:

```yaml
      - name: Build breeze-backup
        working-directory: agent
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
          CGO_ENABLED: ${{ matrix.cgo }}
          BUILD_VERSION: ${{ steps.version.outputs.version }}
          CGO_LDFLAGS_ALLOW: '-weak_framework|ScreenCaptureKit'
        run: |
          go build -ldflags="-s -w -X main.version=${BUILD_VERSION}" \
            -o "breeze-backup-${GOOS}-${GOARCH}${{ matrix.suffix }}" \
            ./cmd/breeze-backup

      - name: Upload breeze-backup artifact
        uses: actions/upload-artifact@v7
        with:
          name: breeze-backup-${{ matrix.goos }}-${{ matrix.goarch }}
          path: agent/breeze-backup-${{ matrix.goos }}-${{ matrix.goarch }}${{ matrix.suffix }}
          retention-days: 30
```

- [ ] **Step 2: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML OK"`
Expected: "YAML OK"

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add breeze-backup build to build-agent job (all platforms)"
```

---

### Task 2: Add backup binary to Windows signing + MSI

**Files:**
- Modify: `.github/workflows/release.yml` (lines 160-350, `build-windows-msi` job)
- Modify: `agent/installer/build-msi.ps1`
- Modify: `agent/installer/breeze.wxs`

- [ ] **Step 1: Add backup build to build-windows-msi job**

In `release.yml`, find the "Build Windows resources and binary" step in `build-windows-msi` (around line 208). After the agent build block (the `Pop-Location` on line ~223), add the backup build:

```yaml
          # Build breeze-backup
          Push-Location agent
          $env:GOOS = "windows"
          $env:GOARCH = "amd64"
          $env:CGO_ENABLED = "0"
          go build -ldflags="-s -w -X main.version=$env:BUILD_VERSION" -o ..\dist\breeze-backup-windows-amd64.exe .\cmd\breeze-backup
          Pop-Location
```

- [ ] **Step 2: Add backup EXE signing steps**

After the existing "Sign Windows EXE (prerelease profile)" step (around line 282), add two new signing steps for the backup binary:

```yaml
      - name: Sign backup EXE (stable profile)
        if: ${{ !contains(github.ref_name, '-') }}
        uses: azure/artifact-signing-action@v1
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE_PROD }}
          files: ${{ github.workspace }}\dist\breeze-backup-windows-amd64.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256

      - name: Sign backup EXE (prerelease profile)
        if: ${{ contains(github.ref_name, '-') }}
        uses: azure/artifact-signing-action@v1
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE_PRERELEASE }}
          files: ${{ github.workspace }}\dist\breeze-backup-windows-amd64.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256
```

- [ ] **Step 3: Update MSI build step to pass backup path**

Find the "Build MSI" step (around line 284). Update the PowerShell call to include `-BackupExePath`:

```yaml
      - name: Build MSI
        shell: pwsh
        run: |
          $root = $env:GITHUB_WORKSPACE
          $version = "${{ steps.version.outputs.version }}"
          $agentExe = Join-Path $root "dist\breeze-agent-windows-amd64.exe"
          $backupExe = Join-Path $root "dist\breeze-backup-windows-amd64.exe"
          $msiPath = Join-Path $root "dist\breeze-agent.msi"
          & (Join-Path $root "agent\installer\build-msi.ps1") -Version $version -AgentExePath $agentExe -BackupExePath $backupExe -OutputPath $msiPath
```

- [ ] **Step 4: Add backup to signature verification**

Find the "Verify signatures" step (around line 317). Add the backup EXE to the `$targets` array:

```powershell
          $targets = @(
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-agent-windows-amd64.exe"),
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-backup-windows-amd64.exe"),
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-agent.msi")
          )
```

- [ ] **Step 5: Add backup artifact upload**

After the "Upload Windows MSI artifact" step (around line 347), add:

```yaml
      - name: Upload signed backup EXE artifact
        uses: actions/upload-artifact@v7
        with:
          name: breeze-backup-windows-amd64
          path: dist/breeze-backup-windows-amd64.exe
          overwrite: true
          retention-days: 30
```

- [ ] **Step 6: Update build-msi.ps1**

In `agent/installer/build-msi.ps1`, add the `BackupExePath` parameter to the param block:

```powershell
param(
    [Parameter(Mandatory = $false)]
    [string]$Version = "0.1.0",

    [Parameter(Mandatory = $false)]
    [string]$AgentExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$BackupExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ""
)
```

Add the `-d "BackupExePath=$BackupExePath"` flag to the `$wixArgs` array, after the `AgentExePath` line:

```powershell
    "-d", "BackupExePath=$BackupExePath",
```

- [ ] **Step 7: Update breeze.wxs**

In `agent/installer/breeze.wxs`:

**Add variable declaration** (after the `AgentExePath` declaration, around line 6):

```xml
<?ifndef BackupExePath?>
<?define BackupExePath=..\breeze-backup-windows-amd64.exe?>
<?endif?>
```

**Add component** (after the `cmpBreezeAgentExe` component closing tag, around line 67):

```xml
        <Component Id="cmpBreezeBackupExe" Guid="*">
          <File Id="filBreezeBackupExe" Name="breeze-backup.exe"
                Source="$(var.BackupExePath)" KeyPath="yes" />
        </Component>
```

**Add ComponentRef** to the Feature section (after `cmpBreezeAgentExe` ref, around line 169):

```xml
      <ComponentRef Id="cmpBreezeBackupExe" />
```

- [ ] **Step 8: Verify YAML + PowerShell syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML OK"
pwsh -Command "Get-Command -Syntax agent/installer/build-msi.ps1" 2>/dev/null || echo "pwsh not available, skip"
```

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/release.yml agent/installer/build-msi.ps1 agent/installer/breeze.wxs
git commit -m "ci: sign breeze-backup EXE and bundle in Windows MSI installer"
```

---

### Task 3: Add backup binary to macOS signing + pkg

**Files:**
- Modify: `.github/workflows/release.yml` (lines 352-517, `build-macos-agent` job)
- Modify: `agent/installer/macos/build-pkg.sh`

- [ ] **Step 1: Add backup artifact downloads**

In `release.yml`, find the `build-macos-agent` job's download steps (around line 360). After the existing darwin/arm64 download, add:

```yaml
      - name: Download backup darwin/amd64 artifact
        uses: actions/download-artifact@v8
        with:
          name: breeze-backup-darwin-amd64
          path: staging/

      - name: Download backup darwin/arm64 artifact
        uses: actions/download-artifact@v8
        with:
          name: breeze-backup-darwin-arm64
          path: staging/
```

- [ ] **Step 2: Update signing loop to include backup binaries**

The existing "Sign binaries" step (around line 396) uses a glob `staging/breeze-agent-darwin-*`. Update it to also sign backup binaries:

```yaml
      - name: Sign binaries
        if: vars.ENABLE_MACOS_SIGNING == 'true'
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
        run: |
          for bin in staging/breeze-agent-darwin-* staging/breeze-backup-darwin-*; do
            [ -f "$bin" ] || continue
            codesign --force --options runtime \
              --entitlements agent/entitlements/agent-macos.entitlements.plist \
              --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$bin"
            codesign --verify --verbose "$bin"
            echo "Signed: $bin"
          done
```

- [ ] **Step 3: Update notarization loop to include backup binaries**

The existing "Notarize binaries" step (around line 409) uses `staging/breeze-agent-darwin-*`. Update:

```yaml
      - name: Notarize binaries
        if: vars.ENABLE_MACOS_SIGNING == 'true'
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          for bin in staging/breeze-agent-darwin-* staging/breeze-backup-darwin-*; do
            [ -f "$bin" ] || continue
            ZIP_PATH="${bin}.zip"
            ditto -c -k --keepParent "$bin" "$ZIP_PATH"

            echo "Submitting $(basename "$bin") for notarization..."
            xcrun notarytool submit "$ZIP_PATH" \
              --apple-id "$APPLE_ID" \
              --password "$APPLE_PASSWORD" \
              --team-id "$APPLE_TEAM_ID" \
              --wait --timeout 30m

            rm -f "$ZIP_PATH"
            echo "Notarized: $(basename "$bin")"
          done
```

- [ ] **Step 4: Update build-pkg.sh to accept backup binary**

Replace the content of `agent/installer/macos/build-pkg.sh` with:

Read the file first. The current signature is `build-pkg.sh <agent-binary> <version> <arch> <output>`. Change to `build-pkg.sh <agent-binary> <backup-binary> <version> <arch> <output>`.

Update the argument parsing at the top:

```bash
AGENT_BIN="$1"
BACKUP_BIN="$2"
VERSION="$3"
ARCH="$4"
OUTPUT="$5"
```

After the existing `cp` and `chmod` for the agent binary into `$PAYLOAD/usr/local/bin/`, add:

```bash
# Install backup binary
cp "$BACKUP_BIN" "$PAYLOAD/usr/local/bin/breeze-backup"
chmod 755 "$PAYLOAD/usr/local/bin/breeze-backup"
```

Update the usage comment at the top to reflect the new signature.

- [ ] **Step 5: Update build-pkg.sh call in release.yml**

Find the "Build macOS .pkg installers" step (around line 447). Update the call to pass the backup binary:

```yaml
      - name: Build macOS .pkg installers
        env:
          BUILD_VERSION: ${{ github.ref_name }}
        run: |
          VERSION="${BUILD_VERSION#v}"
          chmod +x agent/installer/macos/build-pkg.sh
          for arch in amd64 arm64; do
            agent/installer/macos/build-pkg.sh \
              "staging/breeze-agent-darwin-${arch}" \
              "staging/breeze-backup-darwin-${arch}" \
              "$VERSION" \
              "$arch" \
              "staging/breeze-agent-darwin-${arch}.pkg"
          done
```

- [ ] **Step 6: Verify YAML + shell syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML OK"
bash -n agent/installer/macos/build-pkg.sh && echo "Shell OK"
```

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release.yml agent/installer/macos/build-pkg.sh
git commit -m "ci: sign breeze-backup on macOS and bundle in .pkg installer"
```

---

### Task 4: Add backup binaries to release assets

**Files:**
- Modify: `.github/workflows/release.yml` (lines 1022-1099, `create-release` job)

- [ ] **Step 1: Update artifact download pattern**

Find the "Download all artifacts" step in `create-release` (around line 1045). Update the pattern to include backup:

```yaml
      - name: Download all artifacts
        uses: actions/download-artifact@v8
        with:
          path: artifacts
          pattern: '{api-dist,web-dist,breeze-agent-*,breeze-backup-*,breeze-viewer-*,breeze-helper-*}'
          merge-multiple: false
```

- [ ] **Step 2: Add backup binary copy to asset preparation**

Find the "Prepare release assets" step (around line 1052). After the agent binary copy loop (`for dir in artifacts/breeze-agent-*`), add:

```bash
          # Copy backup binaries
          for dir in artifacts/breeze-backup-*; do
            if [ -d "$dir" ] && ls "$dir"/* >/dev/null 2>&1; then
              cp "$dir"/* release-assets/
            fi
          done
```

- [ ] **Step 3: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML OK"`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: include breeze-backup binaries in GitHub release assets"
```

---

### Task 5: Verify complete pipeline

- [ ] **Step 1: Verify all file changes are consistent**

```bash
git diff main -- .github/workflows/release.yml | grep -c "breeze-backup"
```

Expected: 15+ occurrences (build, sign stable, sign prerelease, MSI build, verify, upload, macOS download x2, sign loop, notarize loop, pkg build, release download, release copy).

- [ ] **Step 2: Verify YAML is valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML OK"
```

- [ ] **Step 3: Verify shell scripts**

```bash
bash -n agent/installer/macos/build-pkg.sh && echo "build-pkg.sh OK"
```

- [ ] **Step 4: Verify WiX has backup component**

```bash
grep -c "BackupExe" agent/installer/breeze.wxs
```

Expected: 3+ (variable declaration, File Source, ComponentRef)

- [ ] **Step 5: Verify PowerShell accepts new param**

```bash
grep "BackupExePath" agent/installer/build-msi.ps1 | wc -l
```

Expected: 3+ (param declaration, wix -d flag)
