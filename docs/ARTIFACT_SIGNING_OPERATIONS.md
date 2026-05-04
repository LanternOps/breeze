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

### Release artifact manifest and installer fallback prerequisite

Enrollment-key installer fallback paths can fetch release assets such as
`breeze-agent.msi`, `breeze-agent-darwin-arm64.pkg`, and
`Breeze Installer.app.zip` before wrapping enrollment material. The release
workflow publishes `checksums.txt`; that is useful for detecting accidental
corruption, but it is not a trust root because a release asset writer can
replace both the asset and the checksum file.

Tag releases must also publish:

- `release-artifact-manifest.json`
- `release-artifact-manifest.json.minisig`
- `release-artifact-manifest.json.ed25519`

The manifest is signed in `.github/workflows/release.yml` with minisign for
operator tooling and with a raw Ed25519 signature that the API can verify in
Node.js before wrapping release assets. The tag release job fails closed unless
these GitHub secrets are configured:

- `RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY`
- `RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY`
- `RELEASE_MANIFEST_ED25519_PRIVATE_KEY`
- `RELEASE_MANIFEST_ED25519_PUBLIC_KEY`

The Ed25519 private key secret must be a base64 PKCS#8 DER private key or PEM
private key. The Ed25519 public key secret should be the base64 raw 32-byte
public key; SPKI DER and PEM public keys are also accepted by the workflow.
Generate a key pair with:

```bash
node - <<'NODE'
const { generateKeyPairSync } = require('node:crypto');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
console.log('RELEASE_MANIFEST_ED25519_PRIVATE_KEY=' + privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
console.log('RELEASE_MANIFEST_ED25519_PUBLIC_KEY=' + publicDer.subarray(publicDer.length - 32).toString('base64'));
NODE
```

The manifest covers every released artifact with:

1. Artifact filename.
2. SHA-256 digest.
3. Size in bytes.
4. Release tag/version.
5. Platform trust expectation, for example Windows Authenticode or macOS
   Developer ID notarization.

The manifest key must be separate from platform signing keys and usable by
non-interactive CI signing. If the private key is stored as a GitHub secret,
restrict it to the protected tag release environment and plan migration to an
external/HSM-backed signer.

API fallback wrapping enforces the signed manifest when one of these API
environment variables is configured with one or more comma-separated Ed25519
public keys:

- `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`
- `BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`

When configured and `BINARY_SOURCE=github`, the API fetches
`release-artifact-manifest.json` and `release-artifact-manifest.json.ed25519`,
verifies the Ed25519 signature in Node.js, then enforces the selected asset's
SHA-256 digest and size before returning a wrapped MSI/PKG/app zip. Production
API startup and runtime fallback fetching fail closed when `BINARY_SOURCE=github`
and the public-key trust root is not configured. Non-production environments can
omit the key for compatibility, but those fetches do not claim release-manifest
verification.

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
