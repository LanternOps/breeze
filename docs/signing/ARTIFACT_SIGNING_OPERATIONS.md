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

### Where signing secrets live

Every secret that signs a released artifact, or lets a job sign one, is a
GitHub **environment secret** in `signing-production` and/or
`signing-prerelease`. None of them is a repository secret. Both environments
restrict deployments to `v*` tags, so only a tag release job can read them.

Each `release.yml` job that reads one declares the environment with the same
selector the Windows signing jobs use:

```yaml
environment:
  name: ${{ contains(github.ref_name, '-') && 'signing-prerelease' || 'signing-production' }}
```

A prerelease tag (`vX.Y.Z-rc.N`, anything with a `-`) runs in
`signing-prerelease`; every other `v*` tag runs in `signing-production`. A
secret both kinds of release need must therefore be set in **both**
environments under the same name.

| Secret | `signing-production` | `signing-prerelease` | Read by (`release.yml` jobs) |
|---|---|---|---|
| `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` | yes | yes | `create-release` |
| `RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY` | yes | yes | `create-release` |
| `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one) | yes | yes | `build-viewer`, `build-viewer-macos`, `package-windows-updater` |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | yes | yes | `build-macos-agent`, `build-macos-installer-app`, `build-viewer-macos`, `build-helper-macos` |
| `APPLE_INSTALLER_IDENTITY` | yes | yes | `build-macos-agent` |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT_NAME` | yes | yes | `sign-windows-tauri-azure` |
| `AZURE_CERT_PROFILE_PROD` | yes | — | `sign-windows-tauri-azure` (stable tags) |
| `AZURE_CERT_PROFILE_PRERELEASE` | — | yes | `sign-windows-tauri-azure` (prerelease tags) |
| `SSLCOM_*` (six secrets, `SSLCOM_ENVIRONMENT_LABEL` set to the environment's own name) | yes | yes | `sign-windows-tauri-sslcom` |

The release-manifest **public** keys (`RELEASE_MANIFEST_ED25519_PUBLIC_KEY`,
`RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY`) stay repository secrets. The Ed25519
public key is read outside the signing environments by release promotion
(`release-promotion.yml`, `promote-release-images.yml`) and by the verification
steps in `classify-release`, `carry-forward-binaries` and
`promote-signed-release-images`. The minisign public key is read only by
`create-release`, but it is a public value too (both are committed under
`internal/release-keys/`), so it needs no environment scope.

Jobs that declare a signing environment also see that environment's
**variables**, which override repository variables of the same name in step
expressions but not in job-level `if:` conditions. Keep release-control
variables (`ENABLE_MACOS_SIGNING`, `ENABLE_WINDOWS_SIGNING`,
`WINDOWS_SIGNING_PROVIDER`, `RELEASE_DRAFT_FIRST`) at repository level only.

Azure Trusted Signing authenticates through OIDC, so the secret scope above is
only half of the control: the Entra app's federated credentials should name the
environments (`repo:LanternOps/breeze:environment:signing-production` and
`...:environment:signing-prerelease`), not a branch or a bare repository.

Developer builds (`dev-build-agent.yml`) are unsigned. A signed macOS build
for testing comes from a prerelease tag through `release.yml`.

`.github/scripts/check-workflow-security.mjs` (rule
`signing-secrets-must-use-signing-environment`, run by CI through
`pnpm test:workflow-security`) fails any workflow job that names one of these
secrets — or reads the whole secrets context, a dynamic `secrets[...]` index,
or `secrets: inherit` — without declaring one of the two signing environments.

Windows signing references:
- Workflow: `.github/workflows/release.yml`
- Installer doc: `docs/signing/WINDOWS_INSTALLER_SIGNING.md`

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

- `RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY` (environment secret, both signing environments)
- `RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY` (repository secret)
- `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` (environment secret, both signing environments)
- `RELEASE_MANIFEST_ED25519_PUBLIC_KEY` (repository secret)

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
non-interactive CI signing. The private keys are stored only as environment
secrets of the tag-restricted signing environments (see "Where signing secrets
live" above); plan migration to an external/HSM-backed signer.

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

### Preferred path: the signing template

For self-hosters who want their own signing identity on **unmodified**
official builds, the supported path is the `breeze-selfhost-signing`
template repository (docs: "Sign Your Own Agent Packages" deploy page). It
verifies the official release manifest + `sourceCommit` before signing and
publishes a manifest-signed release the API consumes via
`BINARY_GITHUB_REPOSITORY`. The template's source of truth lives in this
monorepo at `selfhost-signing-template/` — **whenever the signing steps in
`.github/workflows/release.yml` change, diff the template against them and
push an update** (release-checklist item). The fork checklist below remains
the path for full rebrands.

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
  - The `go-winres simply` invocations in `agent/Makefile` (`build-winres` target) and `.github/workflows/release.yml` — update `--product-name`, `--file-description`, `--copyright`, and the `--admin`/`--manifest gui` choices to match your fork's identity
- macOS package identifier and signing subject:
  - `docs/signing/MACOS_LINUX_INSTALLER_SIGNING.md` build examples (`com.breeze.agent` and Developer ID subject).
- Release naming/docs:
  - `docs/signing/WINDOWS_INSTALLER_SIGNING.md`
  - `docs/signing/MACOS_LINUX_INSTALLER_SIGNING.md`

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
