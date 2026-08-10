# BYO Signing Phase 3: Template Repo + Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Deliverable 2 (the public `breeze-selfhost-signing` template repository) and Deliverable 4 (the "Sign Your Own Agent Packages" docs guide plus related doc fixes) of the approved spec `docs/superpowers/specs/2026-08-09-selfhost-byo-signing-design.md`. Self-hosters click "Use this template", add their Azure/Apple/manifest secrets, dispatch one workflow, and get a complete signed release (Windows MSI + exes, macOS pkgs + Installer.app, mirrored Linux/viewer/helper assets, their own Ed25519-signed manifest) that a repointed Breeze instance consumes via `BINARY_SOURCE=github` + `BINARY_GITHUB_REPOSITORY`.

**Architecture:** The template's full contents are authored under a new top-level monorepo directory `selfhost-signing-template/` so they are reviewable and lintable in-repo (GitHub never executes workflows outside the root `.github/`, so the nested workflow files are inert here). The workflow is a **distilled copy** of the `release.yml` signing jobs (maintenance stance per spec §Deliverable 2): a shared verify preamble (local composite action + Node Ed25519 verifier) authenticates the official release manifest against a **committed** official public key and binds the tag to the manifest's `sourceCommit` **before any secret-consuming step**, then three jobs (`windows`, `macos`, `publish`) sign the official unsigned inputs with the self-hoster's credentials, mirror the never-signed canonical assets, and publish a release + self-signed manifest on the self-hoster's repo. A final, user-confirmed task pushes the directory contents as the root of the standalone public repo `lanternops/breeze-selfhost-signing` and marks it a template.

**Tech Stack:** GitHub Actions YAML, PowerShell, bash, Astro/Starlight mdx docs

## Global Constraints

- Workflow inputs: `version` (required, strictly validated `X.Y.Z[-suffix]`, regex `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$`, no leading `v`); `signing-mode`: `azure-artifact-signing` (default) | `pfx`; `platforms`: `all` (default) | `windows` | `macos`; `dry-run` (boolean, default false).
- The official manifest key ships **committed** as `official-release-key.pub` (PEM, SPKI body `MCowBQYDK2VwAyEAyzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=`, raw form `yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=`) — never a workflow input; rotations arrive as template updates.
- Every platform job verifies the official manifest signature AND resolves the tag to the manifest's `sourceCommit` SHA **before** any step that carries a secret in its `env`/`with`; secrets appear only on individual post-verify steps, never at job/workflow `env` level.
- All third-party actions pinned to full commit SHAs copied verbatim from `release.yml` (checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-dotnet `a98b56852c35b8e3190ac28c8c2271da59106c68`, setup-go `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e`, azure/login `532459ea530d8321f2fb9bb10d1e0bcf23869a43`, azure/artifact-signing-action `c7ab2a863ab5f9a846ddb8265964877ef296ee82`, upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, download-artifact `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`, softprops/action-gh-release `3d0d9888cb7fd7b750713d6e236d1fcb99157228`).
- WiX is version-pinned (`dotnet tool install --global wix --version 7.0.1` + `wix eula accept wix7`); implementation must confirm the exact 7.x version against the most recent green official release run log and adjust the pin before merging.
- PFX mode is labeled **legacy/internal-PKI only** everywhere it appears (CA/B Forum requires HSM-resident keys for publicly trusted certs since June 2023).
- Azure mode uses OIDC federated credentials only (`azure/login` with `client-id`+`tenant-id`, `allow-no-subscriptions: true`); single cert profile secret `AZURE_CERT_PROFILE` (no prod/prerelease split).
- Only `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` is stored as a secret; the public key is derived from it at publish time and the full compose `environment:` block is printed in the workflow run summary.
- The publish job refuses to overwrite an existing `v${version}` release on the self-hoster's repo (checked in `validate` and again immediately before `gh release create`).
- Mirror list covers every asset the API URL helpers reference that the platform jobs don't produce: `breeze-{agent,backup,watchdog}-linux-{amd64,arm64}`, `breeze-viewer-{windows.msi,macos.dmg,linux.AppImage}`, `latest.json`, `breeze-helper-{windows.msi,macos.dmg,linux.AppImage}` (per `binarySync.ts` `AGENT_TARGETS`/`HELPER_TARGETS`/`WATCHDOG_TARGETS` and `binarySource.ts` `VIEWER_FILENAMES`/`HELPER_FILENAMES`; no install scripts exist as release assets — `install.sh` is served by the API itself).
- Notarization auth is Apple ID + app-specific password + team ID only (matches `scripts/release/notarize-submit.sh`; **no** ASC API key in v1).
- Manifest format matches the official generator (`schemaVersion: 1`, `repository`, `release`, sorted `assets[]` with `name`/`sha256`/`size`/`platformTrust`, `json.dumps(indent=2, sort_keys=True)`) plus Phase 1's `sourceCommit`; `platformTrust` vocabulary is exactly `windows-authenticode-required` | `macos-developer-id-notarization-required` | `release-workflow-produced`; any `-unsigned` filename in `release-assets/` aborts publish.
- Unsigned inputs are only accepted when their manifest entry carries `intendedUse: "signing-input"`; mirrored assets are rejected if they carry it.
- The docs guide's only sanctioned uncertainty marker is `{/* verify-against-portal */}` (the MDX comment form — literal HTML `<!-- -->` comments are a build error in MDX v3, so the sanctioned marker is expressed as an MDX comment) and it appears only in the Azure portal walkthrough (Part 1) and Apple enrollment (Part 2).
- Docs validation: `pnpm --filter @breeze/docs build` (package name confirmed in `apps/docs/package.json`); template validation: `actionlint` + `bash -n` + `node --check` + the verifier self-test.
- This plan modifies nothing outside `selfhost-signing-template/`, `apps/docs/`, `docs/signing/`, and the final gated publish task; Deliverables 1 (unsigned assets + `sourceCommit`/`intendedUse`) and 3 (API re-signing + `BINARY_GITHUB_REPOSITORY` unification) are separate phases that ship first — the template's live dry-run can only pass against a release that contains the Phase 1 unsigned set.
- Commit at each working state; every commit message ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do **not** run the final publish task (Task 9) without explicit user confirmation in-session — it is an outward-facing action creating a public repo.

---

### Task 1: Template repo skeleton — README, official key, keygen script

**Files:**
- `selfhost-signing-template/README.md` (new)
- `selfhost-signing-template/official-release-key.pub` (new)
- `selfhost-signing-template/scripts/generate-manifest-key.sh` (new)
- `selfhost-signing-template/.gitignore` (new)

**Interfaces:**
- `official-release-key.pub`: PEM SPKI Ed25519 public key; consumed by `scripts/verify-manifest.mjs` (Task 2) via `--key`.
- `generate-manifest-key.sh`: no args; prints the private-key PEM (for the `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` secret), the raw-base64 public key, and the compose mapping block; writes nothing outside a self-deleting temp dir.

**Steps:**

- [ ] Create `selfhost-signing-template/official-release-key.pub` with exactly the content of `internal/release-keys/release-manifest.ed25519.pub` (readable in this workspace; if a fresh clone lacks the gitignored `internal/` dir, use the known value — it is the public trust anchor also published at `.env.example:354`):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=
-----END PUBLIC KEY-----
```

- [ ] Sanity-check the committed key derives the documented raw form: `openssl pkey -pubin -in selfhost-signing-template/official-release-key.pub -outform DER | tail -c 32 | base64` must print `yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=` (procedure mirrors `internal/release-keys/README.md`).

- [ ] Create `selfhost-signing-template/.gitignore`:

```
*.key
*.pfx
*.p12
release-assets/
dist/
staging/
out/
node_modules/
```

- [ ] Create `selfhost-signing-template/scripts/generate-manifest-key.sh` (mode 755):

```bash
#!/usr/bin/env bash
# generate-manifest-key.sh — one-shot Ed25519 release-manifest keypair for
# breeze-selfhost-signing. Mirrors the official keygen procedure
# (openssl genpkey ed25519 -> SPKI DER -> raw 32-byte suffix, base64).
#
# Only the PRIVATE key is ever stored (as the GitHub Actions secret
# RELEASE_MANIFEST_ED25519_PRIVATE_KEY). The workflow derives the public key
# from it on every run and prints your instance env block in the run summary,
# so nothing here needs committing. Run locally; nothing is uploaded.
set -euo pipefail

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

openssl genpkey -algorithm ed25519 -out "$tmp/release-manifest.key" 2>/dev/null
raw_b64="$(openssl pkey -in "$tmp/release-manifest.key" -pubout -outform DER | tail -c 32 | base64)"

cat <<EOF

==========================================================================
1) GitHub secret — in YOUR copy of this repo:
   Settings -> Secrets and variables -> Actions -> New repository secret
   Name : RELEASE_MANIFEST_ED25519_PRIVATE_KEY
   Value: exactly the PEM below, including the BEGIN/END lines
==========================================================================
$(cat "$tmp/release-manifest.key")

==========================================================================
2) Your Breeze instance .env — add or replace:
==========================================================================
RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=${raw_b64}

==========================================================================
3) Your docker-compose.yml — the api service must MAP the variable
   (a value in .env alone never reaches the container):
==========================================================================
  api:
    environment:
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: \${RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS}

The private key above exists only in a temp dir that is deleted when this
script exits — copy it into the GitHub secret NOW. Never commit it. If you
lose it, rerun this script and update both the secret and your .env
(during rotation you can trust both keys at once:
RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=oldkey,newkey).
EOF
```

- [ ] Create `selfhost-signing-template/README.md`:

````markdown
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
4. It mirrors the never-signed official assets (Linux binaries,
   viewer/helper installers) after verifying them, generates **your** release
   manifest, signs it with **your** Ed25519 manifest key, and publishes
   release `v<version>` on this repository.

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
| `platforms` | `all` (default), `windows`, `macos` | Skip a platform **only if your fleet has no such devices** — a skipped platform's assets are absent from your release and those downloads will 404. |
| `dry-run` | `false` (default), `true` | Download + verify + build with signing stubbed; no secrets or certs needed. Publishes nothing — assets land as a workflow artifact. |

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

Signed by you: `breeze-agent.msi`, `breeze-agent-windows-amd64.exe`,
`breeze-backup-windows-amd64.exe`, `breeze-watchdog-windows-amd64.exe`,
`breeze-user-helper-windows-amd64.exe`,
`breeze-{agent,backup,desktop-helper,watchdog}-darwin-{amd64,arm64}`,
`breeze-agent-darwin-{amd64,arm64}.pkg`, `Breeze Installer.app.zip`.

Mirrored from the official release (verified, never signed by anyone):
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
````

- [ ] `bash -n selfhost-signing-template/scripts/generate-manifest-key.sh` passes; `chmod +x` applied.
- [ ] Commit: `feat(selfhost-signing): template skeleton — README, official key, manifest keygen`.

---

### Task 2: Shared verify preamble — composite action + Node verifier + asset downloader

**Files:**
- `selfhost-signing-template/.github/actions/verify-official-release/action.yml` (new)
- `selfhost-signing-template/scripts/verify-manifest.mjs` (new)
- `selfhost-signing-template/scripts/download-verified-asset.sh` (new)
- `selfhost-signing-template/scripts/verify-manifest.test.mjs` (new)

**Interfaces:**
- Composite action `verify-official-release`: input `version`; outputs `source-commit` (verified 40-hex SHA) and `manifest-path` (verified manifest JSON on disk). MUST be the first functional step of every job; carries no secrets (only `github.token` for the tag-resolution API read).
- `verify-manifest.mjs verify --manifest M --signature S --key K --repository R --release T` → prints `sourceCommit` on stdout, exits non-zero on any failure.
- `verify-manifest.mjs check-asset --manifest M --name N --file F [--expect-signing-input|--forbid-signing-input]` → verifies sha256 + size (+ `intendedUse` policy), exits non-zero on mismatch.
- `download-verified-asset.sh <version> <asset-name> <dest-path> [--expect-signing-input|--forbid-signing-input]` → curl + check-asset; requires env `OFFICIAL_MANIFEST_PATH`.

**Steps:**

- [ ] Create `selfhost-signing-template/scripts/verify-manifest.mjs`:

```js
#!/usr/bin/env node
// verify-manifest.mjs — verify the official Breeze release-artifact-manifest
// (raw Ed25519, base64 signature) and check downloaded assets against it.
// Pure node:crypto so it runs identically on ubuntu/windows/macos runners and
// matches the verifier the Breeze API itself uses.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function loadPublicKey(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (text.includes('BEGIN PUBLIC KEY')) return createPublicKey(text);
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 32) {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, decoded]),
      format: 'der',
      type: 'spki',
    });
  }
  return createPublicKey({ key: decoded, format: 'der', type: 'spki' });
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
function has(name) {
  return process.argv.includes(name);
}
function die(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const cmd = process.argv[2];

if (cmd === 'verify') {
  const manifestPath = arg('--manifest');
  const sigPath = arg('--signature');
  const keyPath = arg('--key');
  const repository = arg('--repository');
  const release = arg('--release');
  if (!manifestPath || !sigPath || !keyPath || !repository || !release) {
    die('verify: --manifest, --signature, --key, --repository, --release are all required');
  }
  const manifestBytes = readFileSync(manifestPath);
  const signature = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64');
  const key = loadPublicKey(keyPath);
  if (!edVerify(null, manifestBytes, key, signature)) {
    die('release manifest Ed25519 signature verification FAILED — refusing to continue');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.repository !== repository) {
    die(`manifest repository mismatch: expected ${repository}, got ${manifest.repository}`);
  }
  if (manifest.release !== release) {
    die(`manifest release mismatch: expected ${release}, got ${manifest.release}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? '')) {
    die('manifest has no valid sourceCommit — this Breeze release predates BYO-signing support (need a release with the unsigned asset set)');
  }
  process.stdout.write(`${manifest.sourceCommit}\n`);
} else if (cmd === 'check-asset') {
  const manifestPath = arg('--manifest');
  const name = arg('--name');
  const file = arg('--file');
  if (!manifestPath || !name || !file) {
    die('check-asset: --manifest, --name, --file are all required');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = (manifest.assets ?? []).find((a) => a.name === name);
  if (!entry) die(`asset ${name} is not present in the signed manifest`);
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.sha256) {
    die(`sha256 mismatch for ${name}: manifest=${entry.sha256} actual=${sha256}`);
  }
  if (bytes.length !== entry.size) {
    die(`size mismatch for ${name}: manifest=${entry.size} actual=${bytes.length}`);
  }
  if (has('--expect-signing-input') && entry.intendedUse !== 'signing-input') {
    die(`${name} is not marked intendedUse=signing-input — refusing to treat a distributable asset as a signing input`);
  }
  if (has('--forbid-signing-input') && entry.intendedUse === 'signing-input') {
    die(`${name} is a signing input, not a distributable asset — refusing to mirror it`);
  }
  console.log(`ok ${name} sha256=${sha256} size=${bytes.length}`);
} else {
  die(`unknown command: ${cmd} (expected 'verify' or 'check-asset')`);
}
```

- [ ] Create `selfhost-signing-template/scripts/download-verified-asset.sh` (mode 755):

```bash
#!/usr/bin/env bash
# download-verified-asset.sh <version> <asset-name> <dest-path> [policy-flag]
# Downloads one official release asset and verifies sha256+size (and the
# intendedUse policy) against the already-verified official manifest.
# Requires: OFFICIAL_MANIFEST_PATH env (set from the verify-official-release
# action's manifest-path output). policy-flag defaults to
# --forbid-signing-input; pass --expect-signing-input for unsigned inputs.
set -euo pipefail

VERSION="$1"
ASSET="$2"
DEST="$3"
POLICY="${4:---forbid-signing-input}"
MANIFEST="${OFFICIAL_MANIFEST_PATH:?OFFICIAL_MANIFEST_PATH not set — run verify-official-release first}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

url="https://github.com/lanternops/breeze/releases/download/v${VERSION}/${ASSET}"
mkdir -p "$(dirname "$DEST")"
curl -fsSL --retry 3 --retry-delay 5 -o "$DEST" "$url"
node "$SCRIPT_DIR/verify-manifest.mjs" check-asset \
  --manifest "$MANIFEST" --name "$ASSET" --file "$DEST" "$POLICY"
```

- [ ] Create `selfhost-signing-template/.github/actions/verify-official-release/action.yml`:

```yaml
name: Verify official Breeze release
description: >-
  Download the official release-artifact-manifest for the requested version,
  verify its Ed25519 signature against the COMMITTED official key, and bind
  the release tag to the manifest's sourceCommit. This action must run before
  any step that exposes a signing credential; it carries no secrets itself.
inputs:
  version:
    description: Official Breeze release version, without the leading v
    required: true
outputs:
  source-commit:
    description: Verified 40-char commit SHA the official release was built from
    value: ${{ steps.verify.outputs.source-commit }}
  manifest-path:
    description: Path to the verified official manifest JSON
    value: ${{ steps.verify.outputs.manifest-path }}
runs:
  using: composite
  steps:
    - id: verify
      shell: bash
      env:
        VERSION: ${{ inputs.version }}
        GH_TOKEN: ${{ github.token }}
      run: |
        set -euo pipefail
        base="https://github.com/lanternops/breeze/releases/download/v${VERSION}"
        dir="${RUNNER_TEMP}/official-manifest"
        mkdir -p "$dir"
        curl -fsSL --retry 3 --retry-delay 5 \
          -o "$dir/release-artifact-manifest.json" \
          "$base/release-artifact-manifest.json"
        curl -fsSL --retry 3 --retry-delay 5 \
          -o "$dir/release-artifact-manifest.json.ed25519" \
          "$base/release-artifact-manifest.json.ed25519"

        source_commit="$(node "${GITHUB_WORKSPACE}/scripts/verify-manifest.mjs" verify \
          --manifest "$dir/release-artifact-manifest.json" \
          --signature "$dir/release-artifact-manifest.json.ed25519" \
          --key "${GITHUB_WORKSPACE}/official-release-key.pub" \
          --repository "lanternops/breeze" \
          --release "v${VERSION}")"

        # Tags are movable; the signed manifest is not. Bind them.
        tag_commit="$(gh api "repos/lanternops/breeze/commits/v${VERSION}" --jq .sha)"
        if [ "$tag_commit" != "$source_commit" ]; then
          echo "::error::tag v${VERSION} resolves to ${tag_commit} but the signed manifest records sourceCommit ${source_commit} — the tag has moved; refusing to continue"
          exit 1
        fi

        echo "source-commit=${source_commit}" >> "$GITHUB_OUTPUT"
        echo "manifest-path=${dir}/release-artifact-manifest.json" >> "$GITHUB_OUTPUT"
        echo "Verified official manifest for v${VERSION}; sourceCommit=${source_commit}"
```

- [ ] Create `selfhost-signing-template/scripts/verify-manifest.test.mjs` — self-contained test that generates an ephemeral Ed25519 keypair, writes a fixture manifest + signature + asset file to a temp dir, and asserts: (1) `verify` succeeds and prints the sourceCommit; (2) `verify` fails on a tampered manifest byte; (3) `verify` fails when `sourceCommit` is missing; (4) `check-asset` passes on the correct file, fails on wrong hash; (5) `--expect-signing-input` / `--forbid-signing-input` enforce `intendedUse`:

```js
#!/usr/bin/env node
// verify-manifest.test.mjs — self-test for verify-manifest.mjs. Run: node scripts/verify-manifest.test.mjs
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-manifest.mjs');
const dir = mkdtempSync(join(tmpdir(), 'verify-manifest-test-'));
let failures = 0;

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}
function expect(label, cond) {
  if (cond) console.log(`PASS ${label}`);
  else { console.error(`FAIL ${label}`); failures += 1; }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const keyPath = join(dir, 'key.pub');
writeFileSync(keyPath, `${rawPub}\n`);

const asset = Buffer.from('unsigned-binary-bytes');
const assetPath = join(dir, 'breeze-agent-windows-amd64-unsigned.exe');
writeFileSync(assetPath, asset);

const manifest = {
  schemaVersion: 1,
  repository: 'lanternops/breeze',
  release: 'v9.9.9',
  sourceCommit: 'a'.repeat(40),
  assets: [
    {
      name: 'breeze-agent-windows-amd64-unsigned.exe',
      sha256: createHash('sha256').update(asset).digest('hex'),
      size: asset.length,
      platformTrust: 'none',
      intendedUse: 'signing-input',
    },
    {
      name: 'breeze-agent-linux-amd64',
      sha256: createHash('sha256').update(asset).digest('hex'),
      size: asset.length,
      platformTrust: 'release-workflow-produced',
    },
  ],
};
const manifestPath = join(dir, 'manifest.json');
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(manifestPath, manifestBytes);
const sigPath = join(dir, 'manifest.json.ed25519');
writeFileSync(sigPath, sign(null, manifestBytes, privateKey).toString('base64') + '\n');

const okVerify = run(['verify', '--manifest', manifestPath, '--signature', sigPath,
  '--key', keyPath, '--repository', 'lanternops/breeze', '--release', 'v9.9.9']);
expect('verify: valid manifest', okVerify.status === 0 && okVerify.stdout.trim() === 'a'.repeat(40));

const tamperedPath = join(dir, 'tampered.json');
writeFileSync(tamperedPath, Buffer.concat([manifestBytes, Buffer.from(' ')]));
const badVerify = run(['verify', '--manifest', tamperedPath, '--signature', sigPath,
  '--key', keyPath, '--repository', 'lanternops/breeze', '--release', 'v9.9.9']);
expect('verify: tampered manifest rejected', badVerify.status !== 0);

const noCommit = { ...manifest };
delete noCommit.sourceCommit;
const noCommitBytes = Buffer.from(JSON.stringify(noCommit, null, 2));
const noCommitPath = join(dir, 'nocommit.json');
writeFileSync(noCommitPath, noCommitBytes);
writeFileSync(`${noCommitPath}.ed25519`, sign(null, noCommitBytes, privateKey).toString('base64'));
const noCommitVerify = run(['verify', '--manifest', noCommitPath, '--signature', `${noCommitPath}.ed25519`,
  '--key', keyPath, '--repository', 'lanternops/breeze', '--release', 'v9.9.9']);
expect('verify: missing sourceCommit rejected', noCommitVerify.status !== 0);

const okAsset = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', assetPath, '--expect-signing-input']);
expect('check-asset: valid signing input', okAsset.status === 0);

const wrongFile = join(dir, 'wrong.bin');
writeFileSync(wrongFile, 'different-bytes');
const badAsset = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', wrongFile, '--expect-signing-input']);
expect('check-asset: hash mismatch rejected', badAsset.status !== 0);

const mirrorRejected = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', assetPath, '--forbid-signing-input']);
expect('check-asset: signing input rejected as mirror', mirrorRejected.status !== 0);

const mirrorOk = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-linux-amd64', '--file', assetPath, '--forbid-signing-input']);
expect('check-asset: distributable mirror accepted', mirrorOk.status === 0);

rmSync(dir, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('all verify-manifest tests passed');
```

- [ ] Validate: `node --check selfhost-signing-template/scripts/verify-manifest.mjs`, `bash -n selfhost-signing-template/scripts/download-verified-asset.sh`, and `node selfhost-signing-template/scripts/verify-manifest.test.mjs` (all PASS lines, exit 0).
- [ ] Commit: `feat(selfhost-signing): manifest verify preamble (composite action + node verifier + tests)`.

---

### Task 3: `sign-release.yml` — workflow header, validate job, windows job

**Files:**
- `selfhost-signing-template/.github/workflows/sign-release.yml` (new — this task writes the header, `validate`, and `windows` jobs; Tasks 4–5 append `macos` and `publish` to the same file)

**Interfaces:**
- `validate` job: outputs `version` (echoed input) — fails fast on bad version format or an existing `v<version>` release on the self-hoster's repo (skipped in dry-run).
- `windows` job: consumes the 4 official unsigned exes, produces artifact `signed-windows` containing `breeze-agent-windows-amd64.exe`, `breeze-backup-windows-amd64.exe`, `breeze-watchdog-windows-amd64.exe`, `breeze-user-helper-windows-amd64.exe`, `breeze-agent.msi` (all signed unless dry-run).
- `workflow_call` trigger mirrors `workflow_dispatch` inputs so the template's own CI (Task 6) can exercise dry-run.

**Steps:**

- [ ] Create `selfhost-signing-template/.github/workflows/sign-release.yml` with the following content (header + `validate` + `windows`):

```yaml
name: Sign Breeze Release

# Distilled from the signing jobs of lanternops/breeze .github/workflows/release.yml.
# Maintenance stance: this is a COPY, not a reusable workflow — your secrets never
# flow through LanternOps workflow definitions, and refactors of the product repo's
# release.yml cannot break your runs. Version-sensitive build logic lives in the
# product repo and is checked out at the manifest-verified sourceCommit.

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Breeze release version to sign (X.Y.Z or X.Y.Z-suffix, no leading v)'
        required: true
        type: string
      signing-mode:
        description: 'Windows signing backend (pfx is legacy/internal-PKI only)'
        required: true
        default: azure-artifact-signing
        type: choice
        options:
          - azure-artifact-signing
          - pfx
      platforms:
        description: 'Platforms to sign'
        required: true
        default: all
        type: choice
        options:
          - all
          - windows
          - macos
      dry-run:
        description: 'Download + verify + build with signing stubbed (no secrets needed)'
        required: true
        default: false
        type: boolean
  workflow_call:
    inputs:
      version:
        required: true
        type: string
      signing-mode:
        required: false
        default: azure-artifact-signing
        type: string
      platforms:
        required: false
        default: all
        type: string
      dry-run:
        required: false
        default: false
        type: boolean

permissions:
  contents: write   # publish the signed release on this repository
  id-token: write   # Azure OIDC federated login (azure-artifact-signing mode)

concurrency:
  group: sign-release-${{ inputs.version }}
  cancel-in-progress: false

jobs:
  validate:
    name: Validate inputs
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.check.outputs.version }}
    steps:
      - name: Validate version format
        id: check
        env:
          VERSION: ${{ inputs.version }}
        run: |
          set -euo pipefail
          if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
            echo "::error::version '$VERSION' is not X.Y.Z or X.Y.Z-suffix (no leading v)"
            exit 1
          fi
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

      - name: Refuse to overwrite an existing release
        if: inputs.dry-run == false
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ inputs.version }}
        run: |
          set -euo pipefail
          if gh release view "v${VERSION}" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            echo "::error::release v${VERSION} already exists on ${GITHUB_REPOSITORY}. Signing must happen once per release so SmartScreen/Gatekeeper reputation accrues on a stable hash — delete the release manually first if you truly need to re-sign."
            exit 1
          fi
          echo "no existing release v${VERSION} — ok to proceed"

  windows:
    name: Sign Windows artifacts
    needs: [validate]
    if: inputs.platforms == 'all' || inputs.platforms == 'windows'
    runs-on: windows-latest
    environment: signing
    steps:
      - name: Checkout signing repo
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false

      # ---- Trust boundary: everything below `verify` may assume the official
      # ---- release is authentic. No secrets appear above or inside it.
      - name: Verify official release manifest
        id: verify
        uses: ./.github/actions/verify-official-release
        with:
          version: ${{ needs.validate.outputs.version }}

      - name: Checkout Breeze source at manifest sourceCommit
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          repository: lanternops/breeze
          ref: ${{ steps.verify.outputs.source-commit }}
          path: breeze
          persist-credentials: false

      - name: Download and verify unsigned signing inputs
        shell: bash
        env:
          VERSION: ${{ needs.validate.outputs.version }}
          OFFICIAL_MANIFEST_PATH: ${{ steps.verify.outputs.manifest-path }}
        run: |
          set -euo pipefail
          for pair in \
            "breeze-agent-windows-amd64-unsigned.exe:breeze-agent-windows-amd64.exe" \
            "breeze-backup-windows-amd64-unsigned.exe:breeze-backup-windows-amd64.exe" \
            "breeze-watchdog-windows-amd64-unsigned.exe:breeze-watchdog-windows-amd64.exe" \
            "breeze-user-helper-windows-amd64-unsigned.exe:breeze-user-helper-windows-amd64.exe"
          do
            src="${pair%%:*}"; dst="${pair##*:}"
            # explicit `bash` prefix: the exec bit is not reliable after a
            # Windows checkout, and git-bash is the shell here
            bash scripts/download-verified-asset.sh "$VERSION" "$src" "dist/$dst" --expect-signing-input
          done

      - name: Setup .NET SDK
        uses: actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6
        with:
          dotnet-version: '8.0.x'

      - name: Install WiX CLI (pinned)
        shell: pwsh
        run: |
          # Version-pinned, unlike the product CI which floats — a WiX minor
          # bump must not change your MSI bytes out from under you.
          dotnet tool install --global wix --version 7.0.1
          if ($LASTEXITCODE -ne 0) { throw "wix install failed with exit code $LASTEXITCODE" }
          "$env:USERPROFILE\.dotnet\tools" | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
          wix eula accept wix7

      - name: Validate Azure signing secrets
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        shell: pwsh
        env:
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_SIGNING_ENDPOINT: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          AZURE_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          AZURE_CERT_PROFILE: ${{ secrets.AZURE_CERT_PROFILE }}
        run: |
          $required = @("AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT_NAME", "AZURE_CERT_PROFILE")
          foreach ($name in $required) {
            if ([string]::IsNullOrWhiteSpace((Get-Item "env:$name" -ErrorAction SilentlyContinue).Value)) {
              throw "Missing required signing secret: $name (see README secrets table)"
            }
          }

      - name: Validate PFX signing secrets
        if: inputs.signing-mode == 'pfx' && inputs.dry-run == false
        shell: pwsh
        env:
          WINDOWS_PFX_BASE64: ${{ secrets.WINDOWS_PFX_BASE64 }}
          WINDOWS_PFX_PASSWORD: ${{ secrets.WINDOWS_PFX_PASSWORD }}
        run: |
          foreach ($name in @("WINDOWS_PFX_BASE64", "WINDOWS_PFX_PASSWORD")) {
            if ([string]::IsNullOrWhiteSpace((Get-Item "env:$name" -ErrorAction SilentlyContinue).Value)) {
              throw "Missing required signing secret: $name (see README secrets table)"
            }
          }

      - name: Azure Login (OIDC)
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        uses: azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43 # v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - name: Sign agent EXE (Azure Artifact Signing)
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        uses: azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82 # v2.0.0
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\dist\breeze-agent-windows-amd64.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256

      - name: Sign backup EXE (Azure Artifact Signing)
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        uses: azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82 # v2.0.0
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\dist\breeze-backup-windows-amd64.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256

      - name: Sign watchdog EXE (Azure Artifact Signing)
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        uses: azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82 # v2.0.0
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\dist\breeze-watchdog-windows-amd64.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256

      - name: Sign user-helper EXE (Azure Artifact Signing)
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        uses: azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82 # v2.0.0
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\dist\breeze-user-helper-windows-amd64.exe
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256

      - name: Sign EXEs (PFX — legacy/internal PKI)
        if: inputs.signing-mode == 'pfx' && inputs.dry-run == false
        shell: pwsh
        env:
          WINDOWS_PFX_BASE64: ${{ secrets.WINDOWS_PFX_BASE64 }}
          WINDOWS_PFX_PASSWORD: ${{ secrets.WINDOWS_PFX_PASSWORD }}
          PFX_TIMESTAMP_URL: ${{ vars.PFX_TIMESTAMP_URL || 'http://timestamp.digicert.com' }}
        run: |
          $ErrorActionPreference = "Stop"
          $pfxPath = Join-Path $env:RUNNER_TEMP "signing.pfx"
          [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_PFX_BASE64))
          $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
          if (-not $signtool) { throw "signtool.exe not found in Windows SDK" }
          $targets = @(
            "dist\breeze-agent-windows-amd64.exe",
            "dist\breeze-backup-windows-amd64.exe",
            "dist\breeze-watchdog-windows-amd64.exe",
            "dist\breeze-user-helper-windows-amd64.exe"
          )
          foreach ($f in $targets) {
            & $signtool sign /fd SHA256 /f $pfxPath /p $env:WINDOWS_PFX_PASSWORD /tr $env:PFX_TIMESTAMP_URL /td SHA256 $f
            if ($LASTEXITCODE -ne 0) { throw "signtool failed for $f with exit code $LASTEXITCODE" }
          }

      - name: Build MSI
        shell: pwsh
        env:
          VERSION: ${{ needs.validate.outputs.version }}
        run: |
          $ErrorActionPreference = "Stop"
          $root = $env:GITHUB_WORKSPACE
          $agentExe = Join-Path $root "dist\breeze-agent-windows-amd64.exe"
          $backupExe = Join-Path $root "dist\breeze-backup-windows-amd64.exe"
          $watchdogExe = Join-Path $root "dist\breeze-watchdog-windows-amd64.exe"
          $userHelperExe = Join-Path $root "dist\breeze-user-helper-windows-amd64.exe"
          $msiPath = Join-Path $root "dist\breeze-agent.msi"
          & (Join-Path $root "breeze\agent\installer\build-msi.ps1") `
            -Version $env:VERSION `
            -AgentExePath $agentExe `
            -BackupExePath $backupExe `
            -WatchdogExePath $watchdogExe `
            -UserHelperExePath $userHelperExe `
            -OutputPath $msiPath

      - name: Sign MSI (Azure Artifact Signing)
        if: inputs.signing-mode == 'azure-artifact-signing' && inputs.dry-run == false
        uses: azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82 # v2.0.0
        with:
          endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
          signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT_NAME }}
          certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
          files: ${{ github.workspace }}\dist\breeze-agent.msi
          file-digest: SHA256
          timestamp-rfc3161: http://timestamp.acs.microsoft.com
          timestamp-digest: SHA256

      - name: Sign MSI (PFX — legacy/internal PKI)
        if: inputs.signing-mode == 'pfx' && inputs.dry-run == false
        shell: pwsh
        env:
          WINDOWS_PFX_BASE64: ${{ secrets.WINDOWS_PFX_BASE64 }}
          WINDOWS_PFX_PASSWORD: ${{ secrets.WINDOWS_PFX_PASSWORD }}
          PFX_TIMESTAMP_URL: ${{ vars.PFX_TIMESTAMP_URL || 'http://timestamp.digicert.com' }}
        run: |
          $ErrorActionPreference = "Stop"
          $pfxPath = Join-Path $env:RUNNER_TEMP "signing.pfx"
          if (-not (Test-Path $pfxPath)) {
            [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_PFX_BASE64))
          }
          $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
          & $signtool sign /fd SHA256 /f $pfxPath /p $env:WINDOWS_PFX_PASSWORD /tr $env:PFX_TIMESTAMP_URL /td SHA256 "dist\breeze-agent.msi"
          if ($LASTEXITCODE -ne 0) { throw "signtool failed for MSI with exit code $LASTEXITCODE" }

      - name: Remove PFX from disk
        if: always() && inputs.signing-mode == 'pfx'
        shell: pwsh
        run: Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:RUNNER_TEMP "signing.pfx")

      - name: Verify signatures
        if: inputs.dry-run == false
        shell: pwsh
        run: |
          $targets = @(
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-agent-windows-amd64.exe"),
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-backup-windows-amd64.exe"),
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-watchdog-windows-amd64.exe"),
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-user-helper-windows-amd64.exe"),
            (Join-Path $env:GITHUB_WORKSPACE "dist\breeze-agent.msi")
          )
          foreach ($target in $targets) {
            $sig = Get-AuthenticodeSignature -FilePath $target
            # Valid = fully trusted chain; UnknownError = signed but the Azure
            # Artifact Signing root is not yet in the runner's local trust store
            # (normal for new accounts).
            if ($sig.Status -ne "Valid" -and $sig.Status -ne "UnknownError") {
              throw "Signature validation failed for $target. Status: $($sig.Status)"
            }
            if ($sig.Status -eq "UnknownError") {
              Write-Host "::warning::$target signed but root cert not yet trusted locally (Status: UnknownError). This is normal for new Azure Artifact Signing accounts."
            }
            Write-Host "Verified: $target - Status: $($sig.Status) - Signer: $($sig.SignerCertificate.Subject)"
          }

      - name: Assert dry-run outputs exist
        if: inputs.dry-run == true
        shell: pwsh
        run: |
          foreach ($f in @("dist\breeze-agent-windows-amd64.exe", "dist\breeze-backup-windows-amd64.exe", "dist\breeze-watchdog-windows-amd64.exe", "dist\breeze-user-helper-windows-amd64.exe", "dist\breeze-agent.msi")) {
            if (-not (Test-Path $f) -or (Get-Item $f).Length -eq 0) { throw "dry-run output missing or empty: $f" }
            Write-Host "dry-run output ok: $f"
          }

      - name: Upload Windows artifacts
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: signed-windows
          path: |
            dist/breeze-agent-windows-amd64.exe
            dist/breeze-backup-windows-amd64.exe
            dist/breeze-watchdog-windows-amd64.exe
            dist/breeze-user-helper-windows-amd64.exe
            dist/breeze-agent.msi
          retention-days: 7
```

- [ ] Before merging, confirm the WiX pin: open the most recent green official release run (`gh run list --repo lanternops/breeze --workflow release.yml`), read the "Install WiX CLI" step log for the resolved `wix` tool version, and set `--version` in the "Install WiX CLI (pinned)" step to exactly that version (the `7.0.1` written above is the expected current 7.x line; the log is authoritative).
- [ ] Validate: `actionlint selfhost-signing-template/.github/workflows/sign-release.yml` (install locally via `brew install actionlint` if missing). Note: the file is incomplete until Task 5 appends `publish`; run actionlint after each task — the partial file is still valid YAML/workflow syntax because each task appends whole jobs.
- [ ] Commit: `feat(selfhost-signing): sign-release workflow — validate + windows signing job`.
---

### Task 4: `sign-release.yml` — macOS job (binaries, pkgs, Installer.app)

**Files:**
- `selfhost-signing-template/.github/workflows/sign-release.yml` (append the `macos` job after `windows`)

**Interfaces:**
- `macos` job: consumes the 8 official unsigned darwin binaries; produces artifact `signed-macos` containing the 8 signed binaries (canonical names), `breeze-agent-darwin-{amd64,arm64}.pkg`, and `Breeze Installer.app.zip` — all flattened into `out/`. Merges the product repo's `build-macos-agent` and `build-macos-installer-app` jobs into one job (one keychain lifecycle, one runner).

**Steps:**

- [ ] Append the `macos` job to `sign-release.yml`:

```yaml
  macos:
    name: Sign macOS artifacts
    needs: [validate]
    if: inputs.platforms == 'all' || inputs.platforms == 'macos'
    runs-on: macos-latest
    environment: signing
    steps:
      - name: Checkout signing repo
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false

      # ---- Trust boundary: everything below `verify` may assume the official
      # ---- release is authentic. No secrets appear above or inside it.
      - name: Verify official release manifest
        id: verify
        uses: ./.github/actions/verify-official-release
        with:
          version: ${{ needs.validate.outputs.version }}

      - name: Checkout Breeze source at manifest sourceCommit
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          repository: lanternops/breeze
          ref: ${{ steps.verify.outputs.source-commit }}
          path: breeze
          persist-credentials: false

      - name: Download and verify unsigned signing inputs
        env:
          VERSION: ${{ needs.validate.outputs.version }}
          OFFICIAL_MANIFEST_PATH: ${{ steps.verify.outputs.manifest-path }}
        run: |
          set -euo pipefail
          for component in agent backup desktop-helper watchdog; do
            for arch in amd64 arm64; do
              scripts/download-verified-asset.sh "$VERSION" \
                "breeze-${component}-darwin-${arch}-unsigned" \
                "staging/breeze-${component}-darwin-${arch}" \
                --expect-signing-input
            done
          done
          chmod 755 staging/breeze-*

      - name: Validate macOS signing secrets
        if: inputs.dry-run == false
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_INSTALLER_IDENTITY: ${{ secrets.APPLE_INSTALLER_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          set -euo pipefail
          missing=0
          for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_INSTALLER_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
            if [ -z "${!name:-}" ]; then
              echo "::error::Missing required signing secret: $name (see README secrets table)"
              missing=1
            fi
          done
          [ "$missing" -eq 0 ]

      - name: Import certificates into ephemeral keychain
        if: inputs.dry-run == false
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        run: |
          set -euo pipefail
          CERT_PATH="$RUNNER_TEMP/cert.p12"
          KEYCHAIN_PATH="$RUNNER_TEMP/signing.keychain-db"
          KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"

          echo "$APPLE_CERTIFICATE" | base64 --decode > "$CERT_PATH"

          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security import "$CERT_PATH" -P "$APPLE_CERTIFICATE_PASSWORD" \
            -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
          security set-key-partition-list -S apple-tool:,apple: \
            -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security list-keychains -d user -s "$KEYCHAIN_PATH" \
            $(security list-keychains -d user | tr -d '"')

          rm -f "$CERT_PATH"

      - name: Sign binaries (hardened runtime + entitlements)
        if: inputs.dry-run == false
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
        run: |
          set -euo pipefail
          for bin in staging/breeze-agent-darwin-* staging/breeze-backup-darwin-* staging/breeze-desktop-helper-darwin-* staging/breeze-watchdog-darwin-*; do
            [ -f "$bin" ] || continue
            case "$bin" in *.pkg|*.zip) continue ;; esac
            codesign --force --options runtime \
              --entitlements breeze/agent/entitlements/agent-macos.entitlements.plist \
              --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$bin"
            codesign --verify --verbose "$bin"
            echo "Signed: $bin"
          done

      - name: Notarize binaries
        if: inputs.dry-run == false
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          set -euo pipefail
          chmod +x breeze/scripts/release/notarize-submit.sh
          for bin in staging/breeze-agent-darwin-* staging/breeze-backup-darwin-* staging/breeze-desktop-helper-darwin-* staging/breeze-watchdog-darwin-*; do
            [ -f "$bin" ] || continue
            case "$bin" in *.pkg|*.zip) continue ;; esac
            ZIP_PATH="${bin}.zip"
            ditto -c -k --keepParent "$bin" "$ZIP_PATH"
            breeze/scripts/release/notarize-submit.sh "$ZIP_PATH"
            rm -f "$ZIP_PATH"
          done

      - name: Build macOS .pkg installers
        env:
          VERSION: ${{ needs.validate.outputs.version }}
        run: |
          set -euo pipefail
          chmod +x breeze/agent/installer/macos/build-pkg.sh
          for arch in amd64 arm64; do
            breeze/agent/installer/macos/build-pkg.sh \
              "staging/breeze-agent-darwin-${arch}" \
              "staging/breeze-desktop-helper-darwin-${arch}" \
              "staging/breeze-backup-darwin-${arch}" \
              "staging/breeze-watchdog-darwin-${arch}" \
              "$VERSION" \
              "$arch" \
              "staging/breeze-agent-darwin-${arch}.pkg"
          done

      - name: Sign .pkg installers
        if: inputs.dry-run == false
        env:
          APPLE_INSTALLER_IDENTITY: ${{ secrets.APPLE_INSTALLER_IDENTITY }}
        run: |
          set -euo pipefail
          for pkg in staging/*.pkg; do
            SIGNED="${pkg%.pkg}-signed.pkg"
            productsign --sign "$APPLE_INSTALLER_IDENTITY" "$pkg" "$SIGNED"
            mv "$SIGNED" "$pkg"
            echo "Signed: $(basename "$pkg")"
          done

      - name: Notarize and staple .pkg installers
        if: inputs.dry-run == false
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          set -euo pipefail
          for pkg in staging/*.pkg; do
            breeze/scripts/release/notarize-submit.sh "$pkg"
            xcrun stapler staple "$pkg"
            xcrun stapler validate "$pkg"
            echo "Notarized and stapled: $(basename "$pkg")"
          done

      - name: Build Breeze Installer.app from source
        run: |
          set -euo pipefail
          chmod +x breeze/agent/installer/macos-app/build-app-bundle.sh
          breeze/agent/installer/macos-app/build-app-bundle.sh \
            --pkg-amd64 staging/breeze-agent-darwin-amd64.pkg \
            --pkg-arm64 staging/breeze-agent-darwin-arm64.pkg \
            --output "build/Breeze Installer.app"

      - name: Sign Installer.app
        if: inputs.dry-run == false
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
        run: |
          set -euo pipefail
          codesign --force --options runtime \
            --entitlements breeze/agent/installer/macos-app/entitlements.plist \
            --sign "$APPLE_SIGNING_IDENTITY" --timestamp \
            --deep "build/Breeze Installer.app"
          codesign --verify --verbose=2 "build/Breeze Installer.app"

      - name: Notarize + staple Installer.app
        if: inputs.dry-run == false
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          set -euo pipefail
          ditto -c -k --keepParent "build/Breeze Installer.app" build/installer-notarize.zip
          breeze/scripts/release/notarize-submit.sh build/installer-notarize.zip
          xcrun stapler staple "build/Breeze Installer.app"
          xcrun stapler validate "build/Breeze Installer.app"
          spctl -a -t exec -vv "build/Breeze Installer.app"

      - name: Verify macOS signatures and notarization
        if: inputs.dry-run == false
        run: |
          set -euo pipefail
          # Raw Mach-O binaries: verify signature + hardened runtime + Developer ID.
          # Do NOT run `spctl -a -t exec` against raw command-line binaries —
          # Gatekeeper's exec assessment is bundle-aware and rejects raw Mach-O
          # even when signing/notarization are correct. The user-facing
          # assessment happens at the .pkg layer below.
          for bin in staging/breeze-agent-darwin-* staging/breeze-backup-darwin-* staging/breeze-desktop-helper-darwin-* staging/breeze-watchdog-darwin-*; do
            [ -f "$bin" ] || continue
            case "$bin" in *.pkg|*.zip) continue ;; esac
            codesign --verify --strict --verbose=2 "$bin"
            DETAILS=$(codesign -dvvv "$bin" 2>&1)
            if ! grep -q 'flags=.*runtime' <<<"$DETAILS"; then
              echo "::error::$bin missing hardened runtime flag"
              echo "$DETAILS"
              exit 1
            fi
            if ! grep -q 'Authority=Developer ID Application' <<<"$DETAILS"; then
              echo "::error::$bin not signed by Developer ID Application"
              echo "$DETAILS"
              exit 1
            fi
          done

          for pkg in staging/*.pkg; do
            [ -f "$pkg" ] || continue
            pkgutil --check-signature "$pkg"
            xcrun stapler validate "$pkg"
            spctl -a -vv -t install "$pkg"
          done

      - name: Package Installer.app for release
        run: |
          set -euo pipefail
          ditto -c -k --sequesterRsrc --keepParent \
            "build/Breeze Installer.app" \
            "build/Breeze Installer.app.zip"

      - name: Collect outputs
        run: |
          set -euo pipefail
          mkdir -p out
          for component in agent backup desktop-helper watchdog; do
            for arch in amd64 arm64; do
              cp "staging/breeze-${component}-darwin-${arch}" out/
            done
          done
          cp staging/breeze-agent-darwin-amd64.pkg staging/breeze-agent-darwin-arm64.pkg out/
          cp "build/Breeze Installer.app.zip" out/
          ls -lh out/

      - name: Upload macOS artifacts
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: signed-macos
          path: out/*
          retention-days: 7

      - name: Cleanup keychain
        if: always() && inputs.dry-run == false
        run: security delete-keychain "$RUNNER_TEMP/signing.keychain-db" || true
```

- [ ] Validate: `actionlint selfhost-signing-template/.github/workflows/sign-release.yml`.
- [ ] Commit: `feat(selfhost-signing): macos signing job (binaries, pkgs, Installer.app)`.

---

### Task 5: `sign-release.yml` — publish job (mirror + manifest + release)

**Files:**
- `selfhost-signing-template/.github/workflows/sign-release.yml` (append the `publish` job after `macos`)

**Interfaces:**
- `publish` job: needs `validate`, `windows`, `macos`; runs when at least one platform job succeeded and none failed. Assembles `release-assets/` from the platform artifacts + verified mirrors, generates + signs the self-hoster's manifest, writes `checksums.txt`, publishes `v<version>` on the self-hoster's repo (or uploads a `dry-run-release-assets` artifact), and prints the instance env block in `$GITHUB_STEP_SUMMARY`.
- Mirror list (bash array `MIRROR_ASSETS`) is the contract with the API URL helpers; asset names verified against `apps/api/src/services/binarySync.ts` (`AGENT_TARGETS` at ~line 25, `HELPER_TARGETS`, `USER_HELPER_TARGETS`, `WATCHDOG_TARGETS`) and `apps/api/src/services/binarySource.ts` (`VIEWER_FILENAMES`/`HELPER_FILENAMES` at ~line 109, `getGithubBackupUrl`).

**Steps:**

- [ ] Append the `publish` job to `sign-release.yml`:

```yaml
  publish:
    name: Publish signed release
    needs: [validate, windows, macos]
    if: >-
      always() && !cancelled()
      && needs.validate.result == 'success'
      && (needs.windows.result == 'success' || needs.windows.result == 'skipped')
      && (needs.macos.result == 'success' || needs.macos.result == 'skipped')
      && !(needs.windows.result == 'skipped' && needs.macos.result == 'skipped')
    runs-on: ubuntu-latest
    environment: signing
    steps:
      - name: Checkout signing repo
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false

      - name: Verify official release manifest
        id: verify
        uses: ./.github/actions/verify-official-release
        with:
          version: ${{ needs.validate.outputs.version }}

      - name: Download signed Windows artifacts
        if: needs.windows.result == 'success'
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
        with:
          name: signed-windows
          path: release-assets/

      - name: Download signed macOS artifacts
        if: needs.macos.result == 'success'
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
        with:
          name: signed-macos
          path: release-assets/

      - name: Mirror never-signed official assets (verified)
        env:
          VERSION: ${{ needs.validate.outputs.version }}
          OFFICIAL_MANIFEST_PATH: ${{ steps.verify.outputs.manifest-path }}
        run: |
          set -euo pipefail
          # Contract: every canonical asset the Breeze API's URL helpers can
          # request from a repointed repository, minus what the platform jobs
          # produce. Sources of truth in the product repo:
          #   apps/api/src/services/binarySync.ts   (AGENT/WATCHDOG/HELPER/USER_HELPER targets)
          #   apps/api/src/services/binarySource.ts (VIEWER_FILENAMES, HELPER_FILENAMES,
          #                                          getGithubBackupUrl, getGithubInstallerAppUrl)
          MIRROR_ASSETS=(
            breeze-agent-linux-amd64
            breeze-agent-linux-arm64
            breeze-backup-linux-amd64
            breeze-backup-linux-arm64
            breeze-watchdog-linux-amd64
            breeze-watchdog-linux-arm64
            breeze-viewer-windows.msi
            breeze-viewer-macos.dmg
            breeze-viewer-linux.AppImage
            latest.json
            breeze-helper-windows.msi
            breeze-helper-macos.dmg
            breeze-helper-linux.AppImage
          )
          for asset in "${MIRROR_ASSETS[@]}"; do
            scripts/download-verified-asset.sh "$VERSION" "$asset" "release-assets/$asset" --forbid-signing-input
          done

      - name: Generate release artifact manifest
        env:
          SIGN_VERSION: ${{ needs.validate.outputs.version }}
          SOURCE_COMMIT: ${{ steps.verify.outputs.source-commit }}
        run: |
          python3 <<'PY'
          import hashlib
          import json
          import os
          import re
          from pathlib import Path

          release_dir = Path("release-assets")
          excluded = {
              "checksums.txt",
              "release-artifact-manifest.json",
              "release-artifact-manifest.json.ed25519",
              "release-artifact-manifest.json.minisig",
          }

          # Same classifier and platformTrust vocabulary as the official
          # generator in lanternops/breeze release.yml — the Breeze API
          # already understands exactly these values.
          DARWIN_BINARY_RE = re.compile(
              r"^breeze-(agent|backup|desktop-helper|watchdog)-darwin-(amd64|arm64)$"
          )

          def platform_trust(name):
              if name.endswith(".msi") or name.endswith(".exe"):
                  return "windows-authenticode-required"
              if (
                  name.endswith(".pkg")
                  or name.endswith(".app.zip")
                  or name.endswith(".dmg")
              ):
                  return "macos-developer-id-notarization-required"
              if DARWIN_BINARY_RE.match(name):
                  return "macos-developer-id-notarization-required"
              return "release-workflow-produced"

          assets = []
          for path in sorted(release_dir.iterdir(), key=lambda item: item.name):
              if not path.is_file() or path.name in excluded:
                  continue
              if "-unsigned" in path.name:
                  raise SystemExit(
                      f"refusing to publish signing input {path.name} — "
                      "unsigned inputs must never reach a distributable release"
                  )
              assets.append({
                  "name": path.name,
                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "size": path.stat().st_size,
                  "platformTrust": platform_trust(path.name),
              })

          if not assets:
              raise SystemExit("release-assets/ is empty — nothing to publish")

          manifest = {
              "schemaVersion": 1,
              "repository": os.environ["GITHUB_REPOSITORY"],
              "release": f"v{os.environ['SIGN_VERSION']}",
              "sourceCommit": os.environ["SOURCE_COMMIT"],
              "assets": assets,
          }
          (release_dir / "release-artifact-manifest.json").write_text(
              json.dumps(manifest, indent=2, sort_keys=True) + "\n"
          )
          print(f"manifest written with {len(assets)} assets")
          PY

      - name: Sign release artifact manifest (your Ed25519 key)
        env:
          RELEASE_MANIFEST_ED25519_PRIVATE_KEY: ${{ secrets.RELEASE_MANIFEST_ED25519_PRIVATE_KEY }}
          DRY_RUN: ${{ inputs.dry-run }}
        run: |
          node <<'NODE'
          const {
            createPrivateKey,
            createPublicKey,
            generateKeyPairSync,
            sign,
            verify,
          } = require('node:crypto');
          const { readFileSync, writeFileSync } = require('node:fs');

          const dryRun = process.env.DRY_RUN === 'true';
          const raw = (process.env.RELEASE_MANIFEST_ED25519_PRIVATE_KEY ?? '').trim();

          let privateKey;
          if (!raw) {
            if (!dryRun) {
              throw new Error(
                'RELEASE_MANIFEST_ED25519_PRIVATE_KEY secret is not set — run scripts/generate-manifest-key.sh and add it (see README)'
              );
            }
            ({ privateKey } = generateKeyPairSync('ed25519'));
            console.log('dry-run: signing with an ephemeral throwaway key');
          } else {
            privateKey = raw.includes('BEGIN PRIVATE KEY')
              ? createPrivateKey(raw)
              : createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
          }

          const publicKey = createPublicKey(privateKey);
          const rawPub = publicKey
            .export({ format: 'der', type: 'spki' })
            .subarray(-32)
            .toString('base64');

          const manifest = readFileSync('release-assets/release-artifact-manifest.json');
          const signature = sign(null, manifest, privateKey);
          if (!verify(null, manifest, publicKey, signature)) {
            throw new Error('Ed25519 manifest signature self-verification failed');
          }
          writeFileSync(
            'release-assets/release-artifact-manifest.json.ed25519',
            `${signature.toString('base64')}\n`,
            { mode: 0o644 }
          );
          writeFileSync('derived-public-key.txt', `${rawPub}\n`);
          console.log(`manifest signed; derived public key: ${rawPub}`);
          NODE

      - name: Generate release checksums
        run: |
          cd release-assets
          sha256sum * > checksums.txt

      - name: Verify release asset integrity
        run: |
          set -euo pipefail
          if [ ! -s "release-assets/checksums.txt" ]; then
            echo "::error::checksums.txt missing or empty"
            exit 1
          fi
          count=0
          for path in release-assets/*; do
            asset="$(basename "$path")"
            [ "$asset" = "checksums.txt" ] && continue
            count=$((count + 1))
            if [ ! -s "$path" ]; then
              echo "::error::release asset missing or empty: $asset"
              exit 1
            fi
            if ! grep -Fq "  $asset" release-assets/checksums.txt; then
              echo "::error::checksums.txt missing SHA-256 entry for $asset"
              exit 1
            fi
          done
          if [ "$count" -eq 0 ]; then
            echo "::error::no release assets assembled"
            exit 1
          fi
          echo "Verified $count release assets against checksums.txt"

      - name: Upload dry-run assets as workflow artifact
        if: inputs.dry-run == true
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: dry-run-release-assets
          path: release-assets/*
          retention-days: 7

      - name: Create release
        if: inputs.dry-run == false
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ needs.validate.outputs.version }}
        run: |
          set -euo pipefail
          # Re-check immediately before create: a concurrent run may have
          # published between validate and now.
          if gh release view "v${VERSION}" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            echo "::error::release v${VERSION} appeared on ${GITHUB_REPOSITORY} while this run was in flight — refusing to overwrite"
            exit 1
          fi
          gh release create "v${VERSION}" release-assets/* \
            --repo "$GITHUB_REPOSITORY" \
            --title "Breeze ${VERSION} (self-signed)" \
            --notes "Breeze ${VERSION} agent packages signed with this organization's certificates. Built from official unsigned artifacts of https://github.com/lanternops/breeze/releases/tag/v${VERSION}, verified against the official Ed25519 release manifest before signing."

      - name: Write instance configuration summary
        env:
          VERSION: ${{ needs.validate.outputs.version }}
          DRY_RUN: ${{ inputs.dry-run }}
        run: |
          set -euo pipefail
          pubkey="$(cat derived-public-key.txt)"
          {
            echo "## Point your Breeze instance at this release"
            echo ""
            if [ "$DRY_RUN" = "true" ]; then
              echo "> **Dry run** — nothing was published and the key below is a throwaway. Real runs print your real key here."
              echo ""
            fi
            echo '```bash'
            echo "BINARY_SOURCE=github"
            echo "BINARY_GITHUB_REPOSITORY=${GITHUB_REPOSITORY}"
            echo "BINARY_VERSION=${VERSION}"
            echo "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=${pubkey}"
            echo "AGENT_AUTO_PROMOTE=false   # recommended: promote explicitly after verifying sync"
            echo '```'
            echo ""
            echo "Map each variable in your compose file's \`api\` service \`environment:\` block — a value in \`.env\` alone never reaches the container. Full walkthrough: the \"Sign Your Own Agent Packages\" guide in the Breeze docs."
          } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] Verification sweep before commit: `grep -n 'githubDownloadBase\|FILENAMES\|getGithub' apps/api/src/services/binarySource.ts` and confirm every URL helper's asset name is either produced by a platform job or present in `MIRROR_ASSETS` (`Breeze.Installer.app.zip` is produced by the macos job; `install.sh` is API-generated, not a release asset). Also `grep -rn 'breeze-desktop-helper-windows' apps/api agent/internal/updater` — if any consumer fetches a Windows desktop-helper release asset, add `breeze-desktop-helper-windows-amd64.exe` to `MIRROR_ASSETS` and record the finding in the PR description (as of this plan's research, no URL helper references it).
- [ ] Validate: `actionlint selfhost-signing-template/.github/workflows/sign-release.yml`; also `python3 -c "compile(open('/tmp/x.py').read(),'x','exec')"`-style spot check is unnecessary — instead extract the python heredoc to a temp file and run `python3 -m py_compile` on it once during implementation.
- [ ] Commit: `feat(selfhost-signing): publish job — verified mirrors, self-signed manifest, release creation`.

---

### Task 6: Template CI — lint, verifier self-test, gated live dry-run

**Files:**
- `selfhost-signing-template/.github/workflows/ci.yml` (new)

**Interfaces:**
- `lint` job: actionlint (pinned via Go module version) + `bash -n` + `node --check` + `node scripts/verify-manifest.test.mjs`.
- `dry-run` job: calls `sign-release.yml` via `workflow_call` with `dry-run: true`; gated on repository variable `DRY_RUN_VERSION` being set, because it can only pass against an official release that ships the Phase 1 unsigned asset set. LanternOps sets the variable on the template repo once such a release exists; template consumers inherit a no-op until they set it.

**Steps:**

- [ ] Create `selfhost-signing-template/.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  lint:
    name: Lint workflows and scripts
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false

      - name: Setup Go (for actionlint)
        uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7
        with:
          go-version: '1.24'

      - name: actionlint
        run: |
          set -euo pipefail
          go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
          "$(go env GOPATH)/bin/actionlint" -color

      - name: Shell and Node syntax checks
        run: |
          set -euo pipefail
          bash -n scripts/generate-manifest-key.sh
          bash -n scripts/download-verified-asset.sh
          node --check scripts/verify-manifest.mjs

      - name: Verifier self-test
        run: node scripts/verify-manifest.test.mjs

      - name: Committed official key sanity check
        run: |
          set -euo pipefail
          raw="$(openssl pkey -pubin -in official-release-key.pub -outform DER | tail -c 32 | base64 -w0)"
          if [ ${#raw} -ne 44 ]; then
            echo "::error::official-release-key.pub does not decode to a 32-byte Ed25519 key"
            exit 1
          fi
          echo "official key ok: $raw"

  # Full end-to-end dry run against a real official release (no secrets).
  # Gated on the DRY_RUN_VERSION repository variable: it can only pass against
  # an official Breeze release that publishes the unsigned signing-input asset
  # set. Set the variable (Settings -> Secrets and variables -> Actions ->
  # Variables) to e.g. 0.106.0 to enable.
  dry-run:
    name: Dry-run sign workflow
    needs: [lint]
    if: vars.DRY_RUN_VERSION != ''
    uses: ./.github/workflows/sign-release.yml
    with:
      version: ${{ vars.DRY_RUN_VERSION }}
      signing-mode: azure-artifact-signing
      platforms: all
      dry-run: true
```

- [ ] Validate: `actionlint selfhost-signing-template/.github/workflows/ci.yml` and re-run `actionlint` on `sign-release.yml` (the `workflow_call` trigger added in Task 3 is what makes the `uses:` reference legal — actionlint will confirm input compatibility).
- [ ] Post-publish (Task 9) note: after Deliverable 1 ships in an official release, set `DRY_RUN_VERSION` on `lanternops/breeze-selfhost-signing` to that version so template CI exercises the real dry-run path; until then CI is lint + self-test only.
- [ ] Commit: `feat(selfhost-signing): template CI — lint, verifier self-test, gated dry-run`.
---

### Task 7: The guide — `apps/docs` deploy page "Sign Your Own Agent Packages"

**Files:**
- `apps/docs/src/content/docs/deploy/sign-your-own-packages.mdx` (new)

**Interfaces:**
- Starlight page, sidebar order 8 (between Code Signing at 7 and Cloudflare Access Trust at 9), conventions copied from `binaries.mdx`/`code-signing.mdx` (frontmatter shape, `@astrojs/starlight/components` imports, `---` section separators).
- The ONLY sanctioned uncertainty markers are `{/* verify-against-portal */}` MDX comments, confined to Part 1 (Azure portal) and Part 2 (Apple enrollment) — everything else states verified behavior.
- Cross-links: `/deploy/binaries/`, `/deploy/environment/`, `/deploy/upgrades/#controlled-agent-fleet-rollout`, `/deploy/antivirus-exceptions/`, `/deploy/code-signing/`.

**Steps:**

- [ ] Create `apps/docs/src/content/docs/deploy/sign-your-own-packages.mdx` with the following content:

````mdx
---
title: Sign Your Own Agent Packages
description: Sign official Breeze agent releases with your own Windows and macOS certificates using the breeze-selfhost-signing template.
sidebar:
  order: 8
  label: Sign Your Own Packages
---

import { Steps, Aside, Tabs, TabItem } from '@astrojs/starlight/components';

Self-hosted Breeze deployments sign the official agent packages with **their
own** code-signing certificates. LanternOps publishes every release's build
outputs *unsigned* alongside a cryptographically signed manifest; the
[`breeze-selfhost-signing`](https://github.com/lanternops/breeze-selfhost-signing)
template repository turns those into fully signed Windows and macOS packages
under your identity — no fork, no build environment, no Windows or Mac
hardware of your own.

---

## Part 0 — Overview

### Why signing matters

An RMM agent installs silently, runs as SYSTEM/root, and captures screens —
exactly the profile operating systems and AV engines are paranoid about.
Unsigned agent packages mean SmartScreen interception on every Windows
install, Gatekeeper refusal on macOS, and elevated AV false-positive rates.
Signing *once per release* also matters: reputation systems score the
certificate **and the file hash**, so a stable signed artifact accrues trust
where per-download re-signing never could.

### What you'll have at the end

- A private GitHub repo (from the template) that signs each Breeze release
  with one button press and publishes it as `v<version>` on that repo.
- Signed + timestamped Windows `breeze-agent.msi` and component exes; signed,
  notarized, stapled macOS pkgs and `Breeze Installer.app`.
- Your own Ed25519-signed release manifest that your Breeze API verifies
  end-to-end.
- Your instance pulling from your repo via `BINARY_GITHUB_REPOSITORY`,
  with agents updating through the existing per-deployment trust chain.

### Cost and time expectations

| Item | Cost | Lead time |
|---|---|---|
| Azure Artifact Signing (formerly Trusted Signing), Basic tier | ~US$9.99/mo | Identity validation typically takes **1–7 business days**; available to organizations and, in the US and Canada, individuals |
| Apple Developer Program | US$99/yr | Enrollment usually 1–2 days (D-U-N-S lookup can add time for organizations) |
| GitHub Actions | Free minutes generally suffice (one run per Breeze release) | — |

### Choosing a Windows signing path

Adapted from the maintainer decision matrix in
`docs/signing/WINDOWS_INSTALLER_SIGNING.md`:

| Option | Fit | Notes |
|---|---|---|
| **Azure Artifact Signing** (recommended) | Most self-hosters | No hardware token, HSM-backed keys, OIDC from GitHub Actions, cheap. The template's default mode. |
| **CA cloud-signing service** (DigiCert KeyLocker, SSL.com eSigner, …) | Orgs already invested in a CA | Works in principle (they expose `signtool`-compatible flows) but is **not wired into the template in v1** — you would adapt the PFX steps yourself. |
| **PFX file** | Legacy / internal PKI **only** | Since June 2023 the CA/B Forum requires publicly trusted code-signing keys to live in hardware modules, so newly issued OV certs are generally **not exportable** as PFX. Use only with an internal enterprise CA whose root your fleet already trusts. |

<Aside type="caution" title="SmartScreen is not instant">
  A valid signature is necessary but not sufficient. SmartScreen reputation
  ramps per certificate and per file hash over days-to-weeks of installs.
  Expect "Windows protected your PC" on early installs of a brand-new
  certificate — see [Troubleshooting](#troubleshooting).
</Aside>

---

## Part 1 — Azure Artifact Signing from zero

You will create four things: an Artifact Signing account, a validated
identity, a certificate profile, and an Entra app registration with a GitHub
OIDC federated credential.

{/* verify-against-portal */}
### 1. Create the Artifact Signing account

<Steps>

1. In the [Azure portal](https://portal.azure.com), search for **Artifact
   Signing** (formerly *Trusted Signing*) and select **Create**.

2. Pick your subscription and a resource group, an **account name** (this
   becomes the `AZURE_SIGNING_ACCOUNT_NAME` secret), and a region. Note the
   region's endpoint URL, e.g. `https://eus.codesigning.azure.net` for East
   US — this becomes `AZURE_SIGNING_ENDPOINT`.

3. Select the **Basic** SKU and create the account.

</Steps>

{/* verify-against-portal */}
### 2. Complete identity validation

<Steps>

1. In your Artifact Signing account, open **Identity validations** →
   **New identity** → **Public**.

2. Enter your legal organization name, registration number, and address
   exactly as legally registered. For US/Canada individuals, choose the
   individual flow and complete the identity-verification session.

3. Submit and wait. Validation is performed by Microsoft's verification
   partner and typically completes in 1–7 business days; you'll get email
   updates. You cannot create a certificate profile until the identity shows
   **Completed**.

</Steps>

{/* verify-against-portal */}
### 3. Create a certificate profile

<Steps>

1. In the account, open **Certificate profiles** → **Create** →
   **Public Trust**.

2. Name the profile (this becomes `AZURE_CERT_PROFILE`) and bind it to your
   completed identity validation. The generated certificates are short-lived
   and rotated by Azure automatically — nothing to renew.

</Steps>

{/* verify-against-portal */}
### 4. App registration + GitHub OIDC federated credential

<Steps>

1. In **Microsoft Entra ID** → **App registrations** → **New registration**,
   create an app (e.g. `breeze-selfhost-signing`). Record the **Application
   (client) ID** (`AZURE_CLIENT_ID`) and **Directory (tenant) ID**
   (`AZURE_TENANT_ID`).

2. In the app: **Certificates & secrets** → **Federated credentials** →
   **Add credential** → scenario **GitHub Actions deploying Azure
   resources**. Enter your GitHub org, the signing repo name, and entity type
   **Environment** with value `signing` (the workflow's signing jobs run in
   the `signing` environment). No client secret is created — the workflow
   authenticates with short-lived OIDC tokens.

3. Back in the Artifact Signing account: **Access control (IAM)** → **Add
   role assignment** → role **Trusted Signing Certificate Profile Signer** →
   assign to the app registration's service principal.

</Steps>

---

## Part 2 — Apple Developer ID

{/* verify-against-portal */}
### 1. Enroll and create certificates

<Steps>

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/)
   (US$99/yr). Organizations need a D-U-N-S number; the legal entity name
   becomes the publisher string users see.

2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list),
   create **two** certificates: **Developer ID Application** (signs the
   binaries and the Installer.app) and **Developer ID Installer** (signs the
   `.pkg` files). Generate the CSRs in Keychain Access on any Mac
   (Certificate Assistant → Request a Certificate From a Certificate
   Authority), or via `openssl` if you have no Mac.

3. Install both certificates into the same Keychain Access keychain, select
   the two certificates **with their private keys**, and export as a single
   `.p12` with a strong password.

</Steps>

{/* verify-against-portal */}
### 2. App-specific password for notarization

<Steps>

1. Sign in at [account.apple.com](https://account.apple.com) with the Apple
   ID that belongs to (or is invited to) your developer team.

2. Under **Sign-In and Security** → **App-Specific Passwords**, generate one
   (label it e.g. `breeze-notarytool`). This is the `APPLE_PASSWORD` secret —
   notarization does not accept your account password, and the template does
   not support App Store Connect API keys in v1.

3. Find your 10-character **Team ID** under
   [Membership details](https://developer.apple.com/account#MembershipDetailsCard)
   (`APPLE_TEAM_ID`).

</Steps>

Compute the secret values:

```bash
base64 -i developer-id-export.p12 | pbcopy   # -> APPLE_CERTIFICATE
security find-identity -v -p codesigning     # copy the exact strings for
                                             # APPLE_SIGNING_IDENTITY, e.g.
                                             # "Developer ID Application: Example Org (ABCDE12345)"
```

`APPLE_INSTALLER_IDENTITY` is the matching
`Developer ID Installer: Example Org (ABCDE12345)` string (installer
identities don't appear under `-p codesigning`; use
`security find-identity -v` and pick the Installer entry).

---

## Part 3 — Create your signing repo

<Steps>

1. Open [`lanternops/breeze-selfhost-signing`](https://github.com/lanternops/breeze-selfhost-signing)
   and click **Use this template** → **Create a new repository**. Private is
   fine — the workflow only reads public official releases.

2. Clone it and run `./scripts/generate-manifest-key.sh`. Store the printed
   PEM as the `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` Actions secret and keep
   the printed `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` line for Part 5. Only
   the private key is ever stored; the workflow re-derives the public key on
   every run.

3. Create a GitHub **Environment** named `signing`
   (Settings → Environments) and add yourself as a **required reviewer**.
   The workflow's signing jobs run in this environment, so every run that
   can touch your certificates waits for your approval. Add the secrets to
   this environment (or as repository secrets if you skip the reviewer
   gate).

4. Add the platform secrets from Parts 1–2. The full tables live in the
   template's README: Azure mode needs `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT_NAME`,
   `AZURE_CERT_PROFILE`; macOS needs `APPLE_CERTIFICATE`,
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
   `APPLE_INSTALLER_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`,
   `APPLE_TEAM_ID`.

5. Validate the plumbing with a **dry run**: Actions → *Sign Breeze
   Release* → Run workflow → set `dry-run: true` and a current Breeze
   version. A dry run downloads and verifies the official inputs and builds
   the MSI/pkgs/app with signing stubbed — it needs **no secrets and no
   certificates**, so you can do this before paying anyone.

</Steps>

---

## Part 4 — Run the workflow

Dispatch **Sign Breeze Release** with the version from the official release
you want (e.g. `0.106.0` — no leading `v`). What each job does:

| Job | What it does |
|---|---|
| `validate` | Checks the version format and refuses to overwrite an existing `v<version>` release on your repo (signing must happen once per release so reputation accrues on a stable hash). |
| `windows` | Verifies the official manifest against the committed official key, pins the tag to the manifest's `sourceCommit`, checks out the Breeze build scripts at that commit, downloads + hash-verifies the four unsigned exes, signs them (Azure Artifact Signing or PFX), builds the MSI with WiX v4, signs the MSI, and sweeps everything with `Get-AuthenticodeSignature`. |
| `macos` | Same verify preamble; imports your `.p12` into an ephemeral keychain (deleted even on failure), codesigns all eight darwin binaries with hardened runtime + the repo's entitlements, notarizes them, builds both pkgs, `productsign`s, notarizes + staples, builds `Breeze Installer.app` from source around **your** pkgs, signs/notarizes/staples it, then verifies with `codesign --verify --strict`, `pkgutil --check-signature`, and `spctl -a -t install`. |
| `publish` | Mirrors the never-signed official assets (Linux agent/backup/watchdog, viewer, helper — each hash-verified against the official manifest), generates **your** `release-artifact-manifest.json` (+ `.ed25519` signed with your manifest key), writes `checksums.txt`, and creates release `v<version>` on your repo. The run summary prints the exact env block for Part 5. |

<Aside type="note" title="Verifying outputs locally">
  Windows: `Get-AuthenticodeSignature .\breeze-agent.msi` should report your
  organization as signer (Status `Valid`, or `UnknownError` on a machine that
  hasn't yet cached the Azure Artifact Signing root — that status still means
  "signed"). macOS: `pkgutil --check-signature breeze-agent-darwin-arm64.pkg`
  and `spctl -a -vv -t install breeze-agent-darwin-arm64.pkg` should show
  your Developer ID and `source=Notarized Developer ID`. Then install the MSI
  and pkg on clean test VMs before promoting to your fleet.
</Aside>

---

## Part 5 — Point your instance at your builds

### T1 (recommended): repointed GitHub mode

Add to your instance `.env`:

```bash
BINARY_SOURCE=github
BINARY_GITHUB_REPOSITORY=your-org/your-signing-repo
BINARY_VERSION=0.106.0        # the version you signed (or rely on BREEZE_VERSION)
RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=<your raw base64 key from Part 3>
AGENT_AUTO_PROMOTE=false      # recommended during first adoption
```

**And map every one of them** in your compose file's `api` service — a value
in `.env` alone never reaches the container:

```yaml
  api:
    environment:
      BINARY_SOURCE: ${BINARY_SOURCE:-github}
      BINARY_GITHUB_REPOSITORY: ${BINARY_GITHUB_REPOSITORY:-}
      BINARY_VERSION: ${BINARY_VERSION:-}
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: ${RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS}
      AGENT_AUTO_PROMOTE: ${AGENT_AUTO_PROMOTE:-true}
```

<Aside type="caution" title="The key must be YOURS">
  In production, overriding `BINARY_GITHUB_REPOSITORY` requires
  `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` to be set explicitly — and it must
  be **your** manifest key, not the official Breeze key. The official key
  cannot verify your releases; leaving it in place fails closed at sync time.
</Aside>

On restart, the API fetches your release, verifies your manifest, registers
the binaries, and re-signs update manifests with its **per-deployment key** —
agents keep trusting the same deployment key they pinned at enrollment, so no
agent-side changes are needed.

### T2 (zero-config fallback): local mode

Download your signed release assets and drop them into the API's binary
directories (`AGENT_BINARY_DIR`, `VIEWER_BINARY_DIR`, `HELPER_BINARY_DIR`)
with `BINARY_SOURCE=local`. See [Binary Distribution](/deploy/binaries/) for
directory layout and S3 offload. This works today on any version and needs no
repository override — at the cost of manual downloads per release.

### Migration flow for an existing fleet

<Steps>

1. Set `AGENT_AUTO_PROMOTE=false` **before** the switch, so registering your
   release does not instantly become the fleet upgrade target.

2. Apply the T1 env changes and restart the API. Watch the logs for the
   sync: every platform/arch your fleet uses must register successfully
   (a missing asset here means a skipped platform in your signing run).

3. Verify a manual download of each platform installer from your instance,
   install on a test device, confirm it enrolls and heartbeats.

4. Promote explicitly (platform admin, Settings → Agent Versions, or
   `POST /agent-versions/promote`) — see
   [Controlled agent fleet rollout](/deploy/upgrades/#controlled-agent-fleet-rollout).
   Existing agents upgrade to your signed build like any normal version
   promotion.

</Steps>

### Optional hardening

Once the whole fleet has pinned your deployment key, you can set
`AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=true` so agents refuse update
manifests that don't name an explicit trusted key — removing the embedded
official key as a possible update signer. Leave this off until every agent
has upgraded at least once through your instance.

---

## Troubleshooting

**SmartScreen still warns after signing.**
Expected at first. Reputation accrues per certificate and per file hash;
a brand-new Azure Artifact Signing identity starts near zero. It clears
after enough real installs — typically days to a few weeks. Verify the
signature is actually present (`Get-AuthenticodeSignature`) and keep the
release stable (never re-sign an already-published version; the workflow
enforces this).

**`UnknownError` from `Get-AuthenticodeSignature`.**
The file *is* signed; the machine just hasn't chained to the Azure Artifact
Signing root yet. The workflow treats this status as success with a warning,
matching the official pipeline.

**Notarization rejected (`status: Invalid`).**
The workflow prints the full `notarytool log` on failure. The most common
causes: the `.p12` is missing the private key (re-export from Keychain
Access with the key selected), the Apple ID isn't a member of the team in
`APPLE_TEAM_ID`, or `APPLE_PASSWORD` is an account password instead of an
app-specific password.

**Manifest verification failed / `sourceCommit` mismatch.**
The template refuses to run when the official manifest signature doesn't
verify or the release tag no longer points at the manifest's recorded
commit. Both indicate the official release changed after publication —
do not work around this; check the official repository's security
announcements and open an issue.

**`asset ... not present in signed manifest` on an older version.**
Unsigned signing inputs ship with Breeze releases from the BYO-signing
release onward. You cannot self-sign releases older than that.

**Your API refuses to sync your release.**
Check that `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` is your key (raw base64,
44 chars), that it's mapped in the compose `environment:` block, and that
`BINARY_VERSION`/`BREEZE_VERSION` matches a release that exists on your
signing repo.

**AV flags your signed agent.**
Some engines flag new publishers regardless of signature. Add the
recommended exclusions per platform — see
[Antivirus Exceptions](/deploy/antivirus-exceptions/) — and submit
false-positive reports with your signed binaries; a stable hash makes those
reports effective.

---

## Appendix

### Viewer and Helper apps

The technician-side Viewer and Helper (Tauri) apps are mirrored from the
official release as-is. If you want to sign those under your identity too,
the relevant official jobs are `build-viewer`, `sign-windows-tauri`,
`build-viewer-macos`, and `build-helper-macos` in
`.github/workflows/release.yml` — that path is closer to a fork than to this
template, and Gatekeeper's right-click-open flow is generally tolerable for
technician tooling.

### PFX mode details

`signing-mode: pfx` signs with `signtool sign /fd SHA256 /tr <timestamp> /td
SHA256` using `WINDOWS_PFX_BASE64` + `WINDOWS_PFX_PASSWORD`, with the
timestamp server overridable via the `PFX_TIMESTAMP_URL` repository
variable. It exists for internal-PKI deployments (your enterprise CA root is
already in your fleet's trust store via GPO/MDM). It is **not** a path to
public trust: publicly trusted code-signing keys must live in HSMs, so a
file-based key either predates that rule or is internal-only. SmartScreen
reputation never accrues for internal CAs — pair PFX mode with the
[AV exclusions](/deploy/antivirus-exceptions/) and GPO trust configuration.

### Relationship to the fork path

This template signs **official, unmodified** Breeze builds — your
organization appears as publisher on Breeze-branded software, which is
expected and documented. If you need your own branding (product name,
identifiers, icons), that is the fork path: see Model B in
`docs/signing/ARTIFACT_SIGNING_OPERATIONS.md` in the repository.
````

- [ ] Validate: `pnpm --filter @breeze/docs build` passes (catches MDX syntax, broken component imports; Starlight link checking flags any bad internal hrefs).
- [ ] Grep the built page source for `verify-against-portal` — the marker must appear only within Part 1 and Part 2 sections (6 occurrences as written).
- [ ] Commit: `docs(deploy): Sign Your Own Agent Packages guide`.

---

### Task 8: Related doc fixes — code-signing.mdx, environment.mdx, binaries.mdx, signing docs

**Files:**
- `apps/docs/src/content/docs/deploy/code-signing.mdx` (edit)
- `apps/docs/src/content/docs/deploy/environment.mdx` (edit)
- `apps/docs/src/content/docs/deploy/binaries.mdx` (edit)
- `docs/signing/WINDOWS_INSTALLER_SIGNING.md` (edit)
- `docs/signing/ARTIFACT_SIGNING_OPERATIONS.md` (edit)

**Interfaces:** none new — corrections and cross-links. Note: the `BINARY_GITHUB_REPOSITORY` semantics documented here are the **unified** semantics shipped by the Phase 2 (Deliverable 3) plan; this task must land after (or in the same release as) that phase.

**Steps:**

- [ ] `code-signing.mdx` — fix the stale AzureSignTool/EV claims (lines ~30-67):
  - In the "Signed Artifacts" table, replace every `Azure Code Signing (EV certificate)` cell with `Azure Artifact Signing (formerly Trusted Signing)`.
  - Replace the Windows "How it works" intro sentence and steps 2–3. Old step 2: `The `AzureSignTool` utility authenticates to Azure Key Vault using a service principal.` Old step 3: `Each binary is signed with the EV certificate stored in Azure Key Vault.` New text:

```mdx
Windows binaries are signed using **Azure Artifact Signing** (formerly Azure Trusted Signing). The signing happens in the GitHub Actions release workflow.

### How it works

<Steps>

1. The release workflow rebuilds the resource-stamped Windows binaries (agent, backup, watchdog, user-helper) and signs each with the `azure/artifact-signing-action`, authenticating via an OIDC federated credential (no stored client secret).

2. Each binary is signed and RFC 3161-timestamped against the Azure Artifact Signing endpoint; the certificates are short-lived and HSM-backed — the private key never exists outside Azure.

3. The MSI installer is built from the signed binaries with WiX v4, then signed as a separate step.

4. The workflow verifies every signature with `Get-AuthenticodeSignature` before upload (tolerating `UnknownError`, which means "signed, root not yet cached locally").

5. Signed artifacts are uploaded to the GitHub release together with a signed release manifest.

</Steps>
```

  - Replace the `<Aside>` at ~65-67 with: `Azure Artifact Signing keys are HSM-backed and never exportable, meeting the CA/Browser Forum hardware requirements for publicly trusted code signing. Certificates are short-lived and rotated automatically — there is nothing to renew.`
- [ ] `code-signing.mdx` — **delete** the entire "Installer Download Signing" section (heading at ~108 through the `See [Environment Variables]...` line at ~128, including the `MSI_SIGNING_URL` table). Replace it with:

```mdx
## Signing Your Own Packages (Self-Hosted)

Self-hosted deployments sign the official agent packages with their own
certificates — per release, never per download, so SmartScreen and
Gatekeeper reputation accrues on a stable hash. See
[Sign Your Own Agent Packages](/deploy/sign-your-own-packages/).
```

- [ ] `code-signing.mdx` — in Troubleshooting, update the SmartScreen paragraph's stale EV sentence (`EV certificates build reputation faster than standard OV certificates.`) to: `Azure Artifact Signing certificates build reputation faster than traditional OV certificates because Microsoft attests the identity validation.` and append a sentence linking the new guide for self-hosters.
- [ ] `environment.mdx` — Binary Distribution table (~line 132-146): fix the `BINARY_SOURCE` default cell from `local` to `github` (code: `binarySource.ts:9` defaults to github; `binaries.mdx` already says github). Add a new row directly under `BINARY_SOURCE`:

```
| `BINARY_GITHUB_REPOSITORY` | `lanternops/breeze` | | GitHub `owner/repository` used for **all** release consumption in `github` mode — download redirects, release sync, and manifest validation. Point it at your signing repo to serve self-signed packages (see [Sign Your Own Agent Packages](/deploy/sign-your-own-packages/)). In production, overriding it requires `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` to be explicitly set to **your** manifest key. |
```

- [ ] `environment.mdx` — update the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` row's description: after "only change it if you sign your own binaries." add "When `BINARY_GITHUB_REPOSITORY` points at your own signing repository, this **must** be your own manifest key (the workflow run summary prints it)."
- [ ] `environment.mdx` — **delete** the entire "MSI Installer Signing" section (~499-507: the `## MSI Installer Signing` heading, its 3-row table, and the `<Aside>` beneath it). No replacement — the per-download signing path is retired (Deliverable 5 removes the code).
- [ ] `binaries.mdx` — in the "GitHub Mode (Default)" section, after the `BINARY_VERSION` paragraph (~line 31), insert:

```mdx
The repository itself is configurable: `BINARY_GITHUB_REPOSITORY` (default
`lanternops/breeze`) controls where downloads redirect and where release
sync reads from. Self-hosters who [sign their own agent
packages](/deploy/sign-your-own-packages/) point this at their signing
repository and set `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` to their own
manifest key.
```

- [ ] `binaries.mdx` — at the end of the "Manifest trust root" subsection, add a short "Unsigned signing inputs" note: official releases also publish `*-unsigned` build outputs with manifest entries marked `intendedUse: "signing-input"` and `platformTrust: "none"`; these exist solely as inputs for self-signing and are never registrable or downloadable through the API.
- [ ] `docs/signing/WINDOWS_INSTALLER_SIGNING.md` — replace the stale `## Current State` body (~5-7: "Raw `.exe` binaries... No signing, no installer, no Windows resource metadata.") with:

```markdown
## Current State

Fully implemented in `.github/workflows/release.yml`: resource-stamped exes
(go-winres) signed via `azure/artifact-signing-action` (Azure Artifact
Signing, formerly Trusted Signing) with OIDC auth, a WiX v4 MSI built from
the signed exes and then itself signed, and a `Get-AuthenticodeSignature`
verification sweep. Official releases additionally publish the pre-signing
unsigned outputs (`*-unsigned.exe`) as manifest-tracked signing inputs so
self-hosters can sign with their own certificates — see the
`breeze-selfhost-signing` template and the "Sign Your Own Agent Packages"
docs page. The rest of this document is the original design/evaluation
record.
```

- [ ] `docs/signing/ARTIFACT_SIGNING_OPERATIONS.md` — in the "Model B: Independent Self-Host or Fork Distribution" section (~120-154), insert directly after the `### Goal` paragraph:

```markdown
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
```

- [ ] Validate: `pnpm --filter @breeze/docs build`; `grep -rn "MSI_SIGNING" apps/docs/src` returns nothing; `grep -rn "AzureSignTool" apps/docs/src` returns nothing.
- [ ] Commit: `docs: fix stale signing docs; retire MSI_SIGNING docs; document BINARY_GITHUB_REPOSITORY`.

---

### Task 9: Publish the standalone template repo (GATED — requires explicit user confirmation)

**Files:** none in-repo (operates on `selfhost-signing-template/` contents and github.com)

**Interfaces:** creates public repo `lanternops/breeze-selfhost-signing` with the template directory's contents at its root, marked as a template repository.

> **STOP: do not execute this task without the user explicitly confirming in-session.** It creates a public, outward-facing repository under the lanternops org. Everything before this task is fully reviewable in-repo.

**Steps:**

- [ ] Preflight: all prior tasks merged to `main`; `actionlint`, `node scripts/verify-manifest.test.mjs`, and the docs build are green on `main`.
- [ ] **Ask the user for confirmation** (name the exact repo and visibility). Only proceed on an explicit yes.
- [ ] Create and push (contents become the repo **root**, not a subdirectory):

```bash
gh repo create lanternops/breeze-selfhost-signing --public \
  --description "Sign official Breeze RMM agent releases with your own certificates" \
  --homepage "https://github.com/lanternops/breeze"

SCRATCH="$(mktemp -d)"
cp -R selfhost-signing-template/. "$SCRATCH/"
cd "$SCRATCH"
git init -b main
git add -A
git commit -m "feat: initial breeze-selfhost-signing template

Distilled from lanternops/breeze .github/workflows/release.yml signing jobs.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git remote add origin "https://github.com/lanternops/breeze-selfhost-signing.git"
git push -u origin main
```

- [ ] Mark it a template repository (works regardless of gh version):

```bash
gh api -X PATCH repos/lanternops/breeze-selfhost-signing -f is_template=true
```

- [ ] Verify: `gh repo view lanternops/breeze-selfhost-signing --json isTemplate,visibility` shows `"isTemplate": true, "visibility": "PUBLIC"`; the CI workflow's `lint` job runs green on the pushed commit (the `dry-run` job stays skipped until `DRY_RUN_VERSION` is set).
- [ ] Once an official release containing the Phase 1 unsigned asset set exists: `gh variable set DRY_RUN_VERSION --repo lanternops/breeze-selfhost-signing --body "<that version>"` and confirm the CI dry-run passes end-to-end (this is the template's live validation gate from the spec's Testing section; the *signed*-path validation against a scratch Azure account + test-VM installs is a manual release-checklist item before announcing the template).
- [ ] Update the "Use this template" URL in `sign-your-own-packages.mdx` if the final repo slug differs (it should not).

---

## Self-review notes (performed while drafting — already folded in)

- **Spec Deliverable 2 coverage**: README + secrets tables + environment recommendation (Task 1); committed official key, never an input (Task 1); all four workflow inputs with exact validation (Task 3); verify-before-secrets preamble with tag↔`sourceCommit` binding (Tasks 2–5); Azure/PFX/macOS jobs mirroring `release.yml` step-for-step with the exact pinned action SHAs and parameter shapes (Tasks 3–4); publish job with verified mirror list, official-format manifest + `sourceCommit`, refuse-overwrite, checksums (Task 5); dry-run wired through every job + template CI (Tasks 3–6); WiX pinned where the product CI floats (Task 3).
- **Spec Deliverable 4 coverage**: guide Parts 0–5, troubleshooting, appendix, antivirus cross-link (Task 7); all five doc fixes incl. the `MSI_SIGNING_URL` section deletion and the Model B pointer with the release-checklist diff item (Task 8).
- **Asset-name consistency**: unsigned input names match spec Deliverable 1's table exactly (4 Windows `-unsigned.exe`, 8 darwin `-unsigned`); produced/mirrored names match `binarySource.ts`/`binarySync.ts` helpers (`breeze-agent.msi`, `Breeze Installer.app.zip` → served as `Breeze.Installer.app.zip`, viewer/helper filename maps).
- **Zero placeholders** outside the six `{/* verify-against-portal */}` markers in guide Parts 1–2; the WiX `7.0.1` pin and CI `DRY_RUN_VERSION` gate each carry an explicit in-plan verification step rather than a placeholder value.

## Spec assumptions found WRONG in the code (carried into this plan)

1. **"Install scripts" are not release assets.** Spec Deliverable 2's mirror list says to mirror "install scripts"; `release.yml`'s `Prepare release assets` step uploads none, and `GET /api/v1/agents/install.sh` is generated by the API. The mirror list therefore omits them.
2. **`binarySync.ts:25` is `AGENT_TARGETS`, not `GH_PLATFORM_MAP`** (that map is at line 19) — the mirror-list contract in this plan cites the actual target arrays (`AGENT_TARGETS`, `HELPER_TARGETS`, `USER_HELPER_TARGETS`, `WATCHDOG_TARGETS`).
3. **HTML comments are illegal in MDX** — the sanctioned `<!-- verify-against-portal -->` marker is expressed as `{/* verify-against-portal */}` in the guide, since a literal HTML comment fails `pnpm --filter @breeze/docs build`.
4. **`environment.mdx` documents `BINARY_SOURCE` default as `local`; the code default is `github`** (`binarySource.ts:9`) — fixed in Task 8 beyond the spec's listed corrections.
5. **The official Windows verify sweep omits the user-helper exe** (`release.yml:618` checks agent/backup/watchdog/MSI only); the template's sweep adds `breeze-user-helper-windows-amd64.exe` — a deliberate, noted improvement, not a copy bug.
6. **`internal/release-keys/` is readable in this workspace** (the gitignore does not hide it from the working tree), so `official-release-key.pub` is copied directly; the `.env.example:354` value `yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=` matches its SPKI suffix, confirming both sources agree.


