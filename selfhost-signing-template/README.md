# breeze-selfhost-signing

Sign official [Breeze RMM](https://github.com/lanternops/breeze) agent
releases with **your own** code-signing certificates — no fork, no Windows or
Mac hardware, no per-download signing. One workflow run per Breeze release
produces a complete signed release on this repository that your self-hosted
Breeze instance consumes directly.

Full walkthrough (Azure Artifact Signing from zero, Apple Developer ID
enrollment, pointing your instance at your builds): **Sign Your Own Agent
Packages** in the Breeze docs (`/deploy/sign-your-own-packages/`).

## How it works

1. The workflow downloads the official release's signed
   `release-artifact-manifest.json` and verifies it against the official
   Ed25519 key **committed in this repo** (`official-release-key.pub`) —
   before it touches any of your secrets.
2. It resolves the release tag and requires it to match the manifest's
   `sourceCommit` (a moved tag aborts the run), then checks out the Breeze
   build scripts at that exact commit.
3. It downloads the official **unsigned** build outputs
   (`*-unsigned.exe`, `breeze-*-darwin-*-unsigned`), verifies each SHA-256
   against the manifest, signs them with your certificates, builds the MSI /
   pkgs / `Breeze Installer.app`, and verifies every signature.
4. It mirrors the official assets this workflow does not re-sign (Linux
   binaries, viewer/helper installers) after verifying them, generates
   **your** release manifest, signs it with **your** Ed25519 manifest key,
   and publishes release `v<version>` on this repository.
5. Nothing in the manifest is guessed from a filename. Each asset's
   `platformTrust` comes either from the platform job's signing attestation
   — proof that `codesign` / `Get-AuthenticodeSignature` actually inspected
   those bytes on a runner that had the tools — or, for mirrored assets,
   from the official manifest already verified in step 1. `publish` refuses
   to build a manifest covering an asset that neither accounts for, so a
   component that slips past a signing step fails the run instead of being
   published as "signed".

Your agents never trust this repo's key directly — your Breeze API re-signs
update manifests with its per-deployment key (standard since the BYO-signing
release), so fleet trust is unchanged.

## Quickstart

1. Click **Use this template** (a private copy is fine — the workflow only
   reads public official releases).
2. Run `./scripts/generate-manifest-key.sh` locally and follow its output:
   store the private key as the `RELEASE_MANIFEST_ED25519_PRIVATE_KEY`
   secret; keep the printed env block for step 6.
3. Add the platform secrets for your signing mode (tables below).
4. **Recommended:** create a GitHub Environment named `signing`
   (Settings → Environments), move the secrets there, and add yourself as a
   required reviewer — every signing run then needs an explicit approval.
   The workflow's signing jobs reference the `signing` environment.
   Dry-run executions also run in the `signing` environment, so with required
   reviewers even secret-free dry runs wait for your approval — this is
   expected and is a useful smoke test of the approval gate.
5. Actions → **Sign Breeze Release** → Run workflow. Do a `dry-run: true`
   pass first (no secrets needed) to validate the plumbing, then a real run.
6. Point your instance at your builds (the run summary prints this block
   with your real key):

   ```bash
   BINARY_SOURCE=github
   BINARY_GITHUB_REPOSITORY=<your-org>/<this-repo>
   BINARY_VERSION=<version>
   RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=<your raw base64 public key>
   AGENT_AUTO_PROMOTE=false   # recommended for first adoption; promote explicitly
   ```

## Workflow inputs

| Input | Values | Notes |
|---|---|---|
| `version` | `X.Y.Z` or `X.Y.Z-suffix` (no leading `v`) | Must be an official Breeze release that publishes unsigned signing inputs. The run refuses to overwrite an existing `v<version>` release here. |
| `signing-mode` | `azure-artifact-signing` (default), `pfx` | PFX is **legacy / internal-PKI only** — publicly trusted code-signing keys must live in HSMs (CA/B Forum, June 2023), so exportable PFX files are generally unavailable for new OV certs. |
| `platforms` | `all` (default), `windows`, `macos` | Skip a platform **only if your fleet has no such devices** — a skipped platform's assets are absent from your release and those downloads will 404. A partial run also **consumes the version**: the release now exists, so a later run for the same version is refused and you would have to delete the release in the GitHub UI to add the other platform. |
| `dry-run` | `false` (default), `true` | Download + verify + build with signing stubbed; no secrets or certs needed. Publishes nothing — assets land as the `dry-run-unsigned-assets` workflow artifact. Your manifest key is **never** used: the manifest is signed with a throwaway key generated in-run, and every asset is recorded `platformTrust: none`, so a dry-run bundle cannot be mistaken for a release. |

## Secrets

### Manifest signing (always required for real runs)

| Secret | Value |
|---|---|
| `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` | PEM output of `scripts/generate-manifest-key.sh`. The public key is derived from it at run time — nothing else to store. |

### Windows — `azure-artifact-signing` mode (default)

Uses OIDC federated credentials (no client secret stored). The guide's Part 1
walks through creating each of these.

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | App registration (client) ID with a GitHub OIDC federated credential for this repo |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SIGNING_ENDPOINT` | Artifact Signing account endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT_NAME` | Artifact Signing account name |
| `AZURE_CERT_PROFILE` | Certificate profile name (one profile — this repo does not split prod/prerelease) |

### Windows — `pfx` mode (legacy / internal PKI only)

| Secret | Value |
|---|---|
| `WINDOWS_PFX_BASE64` | `base64 -w0 your-cert.pfx` (macOS: `base64 -i your-cert.pfx`) |
| `WINDOWS_PFX_PASSWORD` | PFX password |

Optional repository **variable** `PFX_TIMESTAMP_URL` overrides the RFC 3161
timestamp server (default `http://timestamp.digicert.com`).

### macOS

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of a `.p12` export containing BOTH your **Developer ID Application** and **Developer ID Installer** certificates + keys |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Org (TEAMID)` |
| `APPLE_INSTALLER_IDENTITY` | e.g. `Developer ID Installer: Your Org (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | App-specific password for that Apple ID (not your account password; ASC API keys are not supported) |
| `APPLE_TEAM_ID` | 10-character team ID |

## What a run publishes

The Windows MSI builds under the **self-hosted edition** identity —
`ProductName` "Breeze Agent (Self-Hosted)" and its own permanent
`UpgradeCode`, distinct from the `ProductName` "Breeze Agent" that hosted
Breeze distribution uses. This is intentional: the two identities can never
install on top of each other, and the self-hosted `UpgradeCode` is what your
fleet's upgrade lineage tracks — matching the public unsigned self-host MSI
Breeze publishes with each release, so signing it here doesn't fork your
fleet onto a different upgrade path. Signing a release from before this
edition parameter existed builds the original ("Breeze Agent") identity,
matching what that release actually shipped.

Signed by you: `breeze-agent.msi`, `breeze-agent-windows-amd64.exe`,
`breeze-backup-windows-amd64.exe`, `breeze-watchdog-windows-amd64.exe`,
`breeze-user-helper-windows-amd64.exe`,
`breeze-{agent,backup,desktop-helper,watchdog}-darwin-{amd64,arm64}`,
`breeze-agent-darwin-{amd64,arm64}.pkg`, `Breeze Installer.app.zip`.

Mirrored from the official release (hash-verified against the official
manifest; not re-signed here — the viewer/helper installers keep LanternOps'
original Authenticode/Developer ID signatures, and their `platformTrust` is
carried over from the official manifest rather than re-derived):
`breeze-{agent,backup,watchdog}-linux-{amd64,arm64}`,
`breeze-viewer-{windows.msi,macos.dmg,linux.AppImage}`, `latest.json`,
`breeze-helper-{windows.msi,macos.dmg,linux.AppImage}`.

Generated: `release-artifact-manifest.json` + `.ed25519` (signed with your
manifest key), `checksums.txt`.

## Expectations

- **SmartScreen reputation ramps over time.** A correct signature does not
  mean an instant clean install experience — reputation accrues per
  certificate and per file hash. Signing once per release (what this repo
  does) is what lets it accrue at all.
- **Publisher name**: your organization appears as the publisher on
  Breeze-branded binaries. That is expected; a full rebrand is the fork path
  (`docs/signing/ARTIFACT_SIGNING_OPERATIONS.md`, Model B).
- **Key rotation**: when LanternOps rotates the official manifest key,
  `official-release-key.pub` changes here — pull template updates before
  signing a release made with the new key.
