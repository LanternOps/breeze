# Artifact Signing Operations

This document defines signing instructions for two deployment models:
- **Official Breeze distribution** (your production releases).
- **Independent self-host/fork distribution** (third parties shipping their own build).

Do not share signing credentials across these models.

## Model A: Official Breeze Distribution

### Goal

Maintain trusted publisher reputation for public customer distribution.

### Required controls

1. Use dedicated production signing identity and infrastructure.
2. Keep private keys non-exportable (service-managed/HSM-backed).
3. Require human approval before production signing.
4. Sign all public Windows artifacts (EXE and MSI) and timestamp signatures.
5. Keep prerelease/test signing separate from production signing.

### Current repo wiring (Windows)

Release pipeline already expects this model in `.github/workflows/release.yml`:
- GitHub environments:
  - `signing-production`
  - `signing-prerelease`
- Secrets:
  - `AZURE_CLIENT_ID`
  - `AZURE_TENANT_ID`
  - `AZURE_SIGNING_ENDPOINT`
  - `AZURE_SIGNING_ACCOUNT_NAME`
  - `AZURE_CERT_PROFILE_PROD`
  - `AZURE_CERT_PROFILE_PRERELEASE`

Windows signing references:
- Workflow: `.github/workflows/release.yml`
- Installer doc: `docs/WINDOWS_INSTALLER_SIGNING.md`

### Production checklist

1. Configure `signing-production` environment with required reviewers.
2. Configure `signing-prerelease` environment for non-production tags.
3. Restrict who can create release tags.
4. Ensure signed artifact verification step is required and blocking.
5. Log and monitor signing events in Azure and GitHub.
6. Define emergency procedure: revoke/disable profile, rotate identity, rebuild, republish.

## Model B: Independent Self-Host or Fork Distribution

### Goal

Allow third parties to deploy this project with their own trust identity, without inheriting or affecting official Breeze signing reputation.

### Rules

1. **Never use official Breeze signing credentials** in forks.
2. Create your own signing identity:
   - Windows: your own Azure Trusted Signing account/profile (or your own OV/EV cert).
   - macOS: your own Apple Developer ID certificates + notarization setup.
   - Linux: your own GPG keys for packages/repositories.
3. Keep your own separate CI environments and secrets.

### Strongly recommended identity changes for forks

To avoid publisher confusion and reputation coupling, change branding identifiers before release:
- Windows installer manufacturer and product naming:
  - `agent/installer/breeze.wxs`
  - `agent/resources/winres.json`
  - `agent/resources/breeze.manifest`
- macOS package identifier and signing subject:
  - `docs/MACOS_LINUX_INSTALLER_SIGNING.md` build examples (`com.breeze.agent` and Developer ID subject).
- Release naming/docs:
  - `docs/WINDOWS_INSTALLER_SIGNING.md`
  - `docs/MACOS_LINUX_INSTALLER_SIGNING.md`

### Fork checklist

1. Replace signing secrets with your own values.
2. Replace certificate profile names with your own profile(s).
3. Replace publisher/manufacturer/identifier strings with your org/product values.
4. Verify signatures in CI and on clean VMs before release.
5. Publish revocation/incident contact and process for your users.

## Unsigned/Internal Builds

If signing is not available yet:
- Limit use to internal/lab environments.
- Do not treat unsigned artifacts as production-ready customer deliverables.
- Plan to migrate to signed release artifacts before broad distribution.
