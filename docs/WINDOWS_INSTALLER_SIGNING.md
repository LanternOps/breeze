# Windows Agent Installer & Code Signing

See also: `docs/ARTIFACT_SIGNING_OPERATIONS.md` for official Breeze signing vs independent fork/self-host signing responsibilities.

## Current State

Raw `.exe` binaries built via `go build` with ldflags version embedding, distributed through GitHub Releases with SHA256 checksums. No signing, no installer, no Windows resource metadata.

## What We Need

### 1. Code Signing Certificate

| Certificate Type | Cost | SmartScreen Trust | Notes |
|---|---|---|---|
| **OV (Organization Validation)** | ~$200-400/yr | Builds over time | Standard for most software |
| **EV (Extended Validation)** | ~$400-600/yr | Immediate | Requires hardware token (USB HSM) |
| **Azure Trusted Signing** | ~$10/mo | Immediate | Microsoft-hosted, no physical token needed |

**Recommendation:** Azure Trusted Signing - no hardware token to manage, immediate SmartScreen reputation, very affordable.

### 2. Windows Resource File (.rc / .syso)

Embeds metadata (version, publisher, icon) into the `.exe` so Windows shows proper info in Properties and UAC prompts.

**Files needed:**
- `agent/resources/winres.json` - go-winres config (version, icon, manifest)
- `agent/resources/icon.ico` - Application icon (multi-size)
- `agent/resources/breeze.manifest` - UAC manifest requesting `requireAdministrator`
- Compiled to `agent/cmd/breeze-agent/rsrc_windows_amd64.syso` (Go picks this up automatically)

**Tool:** [go-winres](https://github.com/tc-hib/go-winres) or `windres` from MinGW

### 3. MSI Installer (WiX Toolset v4)

An MSI (not just a raw `.exe`) is critical for enterprise deployment because:
- Group Policy can deploy MSIs silently
- RMM tools (including Breeze itself) expect MSI for software deployment
- Clean install/uninstall/upgrade lifecycle
- Windows Installer logs for troubleshooting

The installer needs to:
- Install `breeze-agent.exe` to `C:\Program Files\Breeze\`
- Create `C:\ProgramData\Breeze\` for config/data/logs
- Register the Windows Service (or scheduled task for user-helper)
- Accept enrollment parameters (`ENROLLMENT_KEY`, `SERVER_URL`) as MSI properties
- Treat enrollment secrets as sensitive MSI data:
  - Add `ENROLLMENT_KEY` to `MsiHiddenProperties` so it is redacted in Windows Installer logs
  - Add `ENROLLMENT_KEY;SERVER_URL` to `SecureCustomProperties` so values survive the elevation boundary
  - Pass values to deferred custom actions only via `CustomActionData` (not direct property reads)
- Support silent install: `msiexec /i breeze-agent.msi /qn ENROLLMENT_KEY=xxx SERVER_URL=https://...`
- Handle upgrades (WiX `MajorUpgrade` element)

### 4. Signing Pipeline (CI/CD)

Build sequence:
```
go-winres make → go build (with .syso) → sign .exe → wix build → sign .msi → upload to release
```

**For Azure Trusted Signing in GitHub Actions (OIDC + profile separation):**
```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    allow-no-subscriptions: true

- uses: azure/artifact-signing-action@v1
  with:
    endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
    signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
    certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE_PROD }}
    files: ${{ github.workspace }}\dist\breeze-agent-windows-amd64.exe
    file-digest: SHA256
    timestamp-rfc3161: http://timestamp.acs.microsoft.com
    timestamp-digest: SHA256
```

Recommended environment setup in GitHub:
- `signing-production` environment: holds production profile secret(s), requires reviewer approval.
- `signing-prerelease` environment: holds prerelease profile secret(s), lower-friction approvals.

Secrets used by the current release workflow:
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SIGNING_ENDPOINT`
- `AZURE_SIGNING_ACCOUNT_NAME`
- `AZURE_CERT_PROFILE_PROD`
- `AZURE_CERT_PROFILE_PRERELEASE`

**For traditional OV/EV certs:**
- Use `signtool.exe` (Windows SDK) or `osslsigncode` (cross-platform)
- Store cert in GitHub Secrets (PFX + password) or use cloud HSM

### 5. WiX v4 Build Commands (Implementation Baseline)

Assuming WiX v4 CLI is installed (`wix --version`) and `agent/installer/breeze.wxs` exists:

```bash
# from repo root
mkdir -p dist

# Build the Windows agent binary first
cd agent
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build \
  -ldflags="-s -w -X main.version=${BUILD_VERSION}" \
  -o ../dist/breeze-agent.exe ./cmd/breeze-agent
cd ..

# Build MSI with WiX v4
wix build agent/installer/breeze.wxs \
  -arch x64 \
  -d AgentExePath=dist/breeze-agent.exe \
  -o dist/breeze-agent.msi
```

If using signing, sign `dist/breeze-agent.exe` before `wix build`, then sign `dist/breeze-agent.msi` after build.

## Enrollment Integration

### Current Flow

```
Manual: breeze-agent enroll <KEY> --server <URL>
  → POST /api/v1/agents/enroll
  → Server returns: agentId, authToken, orgId, siteId, config
  → Saves to C:\ProgramData\Breeze\agent.yaml
  → Then: breeze-agent run
```

The agent already supports `BREEZE_` env vars via Viper in `agent/internal/config/config.go` (`viper.AutomaticEnv()` + `viper.SetEnvPrefix("BREEZE")`).

### MSI Install Sequence (Custom Actions)

For silent enterprise deployment:
```
msiexec /i breeze-agent.msi /qn SERVER_URL=https://rmm.example.com ENROLLMENT_KEY=ek_abc123
```

1. **Install files** - copy `breeze-agent.exe` to `C:\Program Files\Breeze\`
2. **Create directories** - `C:\ProgramData\Breeze\{config,data,logs}`
3. **Run enrollment** (deferred custom action, runs as SYSTEM):
   ```
   breeze-agent.exe enroll <ENROLLMENT_KEY> --server <SERVER_URL>
   ```
4. **Register Windows Service** (or scheduled task for user-helper)
5. **Start service** - `breeze-agent.exe run`

The enrollment custom action must be **deferred** (not immediate) because it needs SYSTEM privileges and the files need to be on disk first.

For security and correctness with deferred custom actions:
- Schedule an immediate custom action that writes `CustomActionData` for the deferred action.
- Mark sensitive properties as hidden (`MsiHiddenProperties=ENROLLMENT_KEY`).
- Do not log command lines containing raw enrollment keys.

### Deployment Models

| Model | How | Use Case |
|---|---|---|
| **MSI properties** | Pass `SERVER_URL` + `ENROLLMENT_KEY` at install time | GPO, Intune, RMM deployment |
| **Pre-baked MSI** | Generate per-customer MSI with values embedded | Download link per customer in Breeze dashboard |

Both are standard. Pre-baked is nicer UX (customer just downloads and runs), while properties are more flexible for automation.

**For the pre-baked model**, the Breeze server would need an API endpoint:
```
GET /api/v1/enrollment-keys/{keyId}/installer?platform=windows
```
That dynamically generates (or serves a cached) MSI with the server URL and enrollment key baked in via an MSI transform (`.mst`) or by patching the MSI property table.

## Files to Create

| File | Purpose |
|---|---|
| `agent/resources/winres.json` | go-winres config (version, icon, manifest) |
| `agent/resources/icon.ico` | App icon (multi-size) |
| `agent/resources/breeze.manifest` | UAC/security manifest for embedded resources |
| `agent/installer/breeze.wxs` | WiX installer definition |
| `agent/installer/build-msi.ps1` | Reproducible WiX build wrapper script |
| `agent/installer/enroll-agent.ps1` | Deferred custom action for enrollment |
| `agent/installer/remove-windows-task.ps1` | Uninstall custom action to remove helper task |
| `agent/service/windows/breeze-agent-user-task.xml` | Scheduled task XML (already exists; reference from installer) |
| `.github/workflows/release.yml` | Updated with signing + MSI steps |

## Estimated Effort

| Task | Complexity |
|---|---|
| Azure Trusted Signing setup | 1-2 hours (Azure portal + GitHub secrets) |
| Windows resource file (go-winres) | 1-2 hours |
| WiX installer definition | 4-6 hours (bulk of the work) |
| CI/CD pipeline updates | 2-3 hours |
| Testing (silent install, upgrade, uninstall) | 2-3 hours |

## Phased Approach

### Phase 1: Minimum Viable (signed binary)
1. Set up Azure Trusted Signing
2. Add go-winres for resource embedding
3. Sign the `.exe` in CI
4. Keep distributing raw `.exe` + install script (but now signed)

### Phase 2: Full Solution (MSI installer)
5. Create WiX MSI with `SERVER_URL` / `ENROLLMENT_KEY` properties
6. Deferred custom action for enrollment
7. Sign the MSI
8. Support silent deployment via GPO/RMM/Intune

### Phase 3: Self-Service (pre-baked installers)
9. Server-side installer generation endpoint
10. Per-customer download links in Breeze dashboard

## Acceptance Checks (Required Before Release)

Run these on a clean Windows VM:

```powershell
# Silent install with enrollment properties
msiexec /i breeze-agent.msi /qn /l*v install.log SERVER_URL=https://rmm.example.com ENROLLMENT_KEY=ek_abc123

# Verify service/task is present and running
sc query "BreezeAgent"
schtasks /Query /TN "Breeze Agent User Task"

# Verify upgrade path (install old MSI, then new MSI with same UpgradeCode)
msiexec /i breeze-agent-old.msi /qn
msiexec /i breeze-agent-new.msi /qn /l*v upgrade.log

# Silent uninstall
msiexec /x breeze-agent.msi /qn /l*v uninstall.log
```

Expected outcomes:
- Install succeeds silently (`ExitCode=0`) and agent is enrolled/started.
- Upgrade replaces prior version without orphaned files/services/tasks.
- Uninstall removes binaries/services/tasks and leaves only intentional persistent data.
- `install.log` / `upgrade.log` do not expose raw `ENROLLMENT_KEY` values.
