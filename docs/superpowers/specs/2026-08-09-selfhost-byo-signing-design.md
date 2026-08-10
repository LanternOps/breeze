# Self-Hoster BYO Signing — Design

**Date:** 2026-08-09
**Status:** Approved design, pre-implementation. Advisor quorum: Codex (gpt-5.6-sol, xhigh, read-only) reviewed the draft and returned AGREE-with-amendments; the three blocking findings (deployment re-signing, source-commit binding, release-source unification) were verified against the code and are folded in below.
**Context:** Breeze is removing self-hoster access to officially signed agent packages. Self-hosters will instead sign the official artifacts themselves. This spec covers the tooling and documentation that makes that as user-friendly as possible.

## Goals

- Self-hosters can produce fully signed Windows + macOS agent artifacts from official **unsigned** release outputs, without forking the product repo or owning Windows/Mac hardware.
- Signing happens **once per release** (never per download) so SmartScreen/Gatekeeper reputation accrues on a stable hash. This is a hard constraint inherited from the retirement of the per-download MSI signing VM (`docs/superpowers/specs/installer-enrollment/2026-06-24-msi-filename-bootstrap-design.md`): the signed artifact is never mutated; per-org customization rides on the filename-bootstrap-token design.
- A self-hosted instance consumes the self-signed artifacts through existing, supported plumbing (`BINARY_SOURCE`), with fail-closed integrity verification end to end.

## Non-Goals / Out of Scope

- **Hosted distribution mechanics.** Droplets run `BINARY_SOURCE=github` against public release assets today. How hosted keeps receiving signed artifacts once they leave the public release (private assets + token, or the GHCR `binaries-init` image) is a companion operational decision that must be made **before the removal ships**, but is not designed here.
- **In-app signing.** Rejected: rebuilding MSIs in a Linux container is fragile, notarization requires long-running Apple-credentialed calls server-side, and it recreates the complexity the `MSI_SIGNING_URL` VM was retired for.
- **Linux packaging/signing.** Nothing is signed on Linux today; unchanged. (But the self-hoster's release must still *mirror* the unsigned Linux assets — see Deliverable 2.)
- **Viewer/Helper (Tauri) apps.** Technician-side tools; Gatekeeper right-click is tolerable. The guide gets a short appendix pointing at the relevant `release.yml` jobs for self-hosters who want to go further. Their unsigned official assets are mirrored, not re-signed.

## Background (current state)

- All signing lives in `.github/workflows/release.yml`: Windows via `azure/artifact-signing-action` (Azure Artifact Signing, formerly Trusted Signing), gated on `vars.ENABLE_WINDOWS_SIGNING` + 6 Azure secrets; macOS via Developer ID + `notarytool`, gated on `vars.ENABLE_MACOS_SIGNING` + 7 Apple secrets.
- Build order matters on Windows: the signing job **rebuilds** the resource-stamped exes itself (`release.yml:308-425` — agent, backup, watchdog, user-helper), signs them, then `agent/installer/build-msi.ps1` (WiX v4) builds the MSI from them, then the MSI is signed. The generic build-matrix outputs are *not* the exact pre-signing inputs — **on Windows only**; the macOS job never rebuilds, it signs the untouched `build-agent` matrix outputs in place, then `build-pkg.sh` → `productsign` → notarize + staple. `Breeze Installer.app` embeds the already-built arch-specific PKGs (`release.yml:1034`).
- Release integrity: `release-artifact-manifest.json` (name, sha256, size, `platformTrust` per asset) signed with minisign + raw Ed25519. The API verifies it against `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` and fails closed in production. The manifest generator classifies trust **by file extension** (`release.yml:2088` — every `.exe`/`.msi` → `windows-authenticode-required`), and trust is only enforced where a caller passes an expected value (`releaseArtifactManifest.ts:281`).
- Release-source identity is fragmented: `binarySource.ts:3` hardcodes `lanternops/breeze` for download URLs; `binarySync.ts:17` separately uses `GITHUB_REPO` (env, default `LanternOps/breeze`) for release sync; `BINARY_GITHUB_REPOSITORY` affects **manifest-repository validation only** and is absent from the config schema and compose env mappings.
- Agent update trust: github-mode sync stamps assets with `signingKeyId: "release-artifact-manifest-ed25519"` (`binarySync.ts:240`), which agents bind to the **embedded official key** (`agent/internal/updater/updater.go:266`); an ID-bearing response is verified against exactly that one key (`updater.go:637`). The per-deployment Ed25519 key (`manifestSigning.ts`, delivered via enrollment/heartbeat TOFU) is today only used when registering **local** binaries (`binarySync.ts:317`). The embedded official key is always merged into the agent trust set (`updater.go:510`) — it is *not* a source-scoped fallback. `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID` defaults off.
- `apps/api/src/services/msiSigning.ts` (the old per-download signing client) is dead code with live docs and live production config validation.
- Recovery media verifies the backup binary against **static expected hashes** (`recoveryMediaService.ts:92`, `binaryManifest.ts:61`), not the release manifest.

## Trust model (the spine of the design)

Three layers, deliberately separated:

1. **Official source trust** — the self-hoster's signing workflow verifies unsigned inputs against the official Ed25519-signed release manifest *and* checks out build scripts at the manifest-recorded `sourceCommit` SHA. LanternOps is trusted as the **source of code**, verified cryptographically before any signing credential is exposed.
2. **Self-hoster release trust** — the self-hoster's workflow signs artifacts with their platform credentials and publishes their own release manifest signed with **their** Ed25519 key. Their API verifies syncs against that key (`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`).
3. **Deployment→agent trust** — the API **re-signs** a normalized update manifest with its existing per-deployment key and serves the `deploy-*` key ID to agents. Agents never need to know or trust the self-hoster's release key; they trust their deployment's TOFU-pinned key, exactly as local mode works today.

Explicit policy decision: the embedded official key remains in every agent's trust set (the binaries are official builds). Self-hosters who want to fully cut LanternOps out as a potential update signer set `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=true` after their fleet has pinned the deployment key; the guide documents this as an optional hardening step, not a default.

## Deliverable 1 — Publish unsigned artifacts from the official release

`release.yml` uploads unsigned build outputs with an explicit `-unsigned` suffix, **captured from the signing jobs immediately before signing** (not from the generic build matrix — the signing job's resource-stamped rebuilds are the true inputs):

| Artifact | Source |
|---|---|
| `breeze-agent-windows-amd64-unsigned.exe` | signing job, pre-sign |
| `breeze-backup-windows-amd64-unsigned.exe` | " |
| `breeze-watchdog-windows-amd64-unsigned.exe` | " |
| `breeze-user-helper-windows-amd64-unsigned.exe` | " |
| `breeze-{agent,backup,desktop-helper,watchdog}-darwin-{amd64,arm64}-unsigned` | macOS job, pre-sign |

Notes:

- **No unsigned `Breeze Installer.app.zip`.** The app embeds the arch-specific PKGs, which the self-hoster produces themselves — their workflow builds the app from the tag-pinned source *after* signing its PKGs.
- **Manifest modeling:** unsigned inputs get manifest entries with a new field `intendedUse: "signing-input"` and `platformTrust: "none"` — `platformTrust` is not overloaded. The generator's extension-based classification (`release.yml:2088`) must handle the `-unsigned` rule **before** the `.exe`/`.msi` branch.
- **`sourceCommit`:** the manifest gains the release's **peeled** commit SHA (`git rev-parse 'HEAD^{commit}'`, not raw `$GITHUB_SHA`, which can name the tag *object* for annotated tags), so downstream workflows can bind the tag checkout to the exact signed source revision (tags are movable; the manifest is not).
- When signing is disabled (`ENABLE_WINDOWS_SIGNING`/`ENABLE_MACOS_SIGNING` false), the unsigned *capture and upload* still runs — but `release-integrity-gate` still hard-requires the signing jobs on tags, so a signing-disabled tag produces no release at all until rollout step 4 flips that end-state. Phase 1 only makes the capture signing-var-independent.
- `release-integrity-gate` must not regress: unsigned uploads are additive and must not weaken the platform-trust assertions on the signed set.

## Deliverable 2 — Template repo `breeze-selfhost-signing`

A public template repository owned by lanternops. Self-hoster clicks "Use this template", adds secrets, runs the workflow. Contents:

- `README.md` — quickstart + secrets table (mirrors the guide).
- `official-release-key.pub` — the official manifest Ed25519 public key, **committed and review-controlled** (not a workflow input; rotations arrive as template updates).
- `.github/workflows/sign-release.yml` — `workflow_dispatch` with inputs:
  - `version` (required, strictly validated `X.Y.Z[-suffix]`; the workflow refuses to overwrite an existing release of the same version)
  - `signing-mode`: `azure-artifact-signing` (default) | `pfx` — PFX mode is labeled **legacy/internal-PKI only**: since June 2023 the CA/B Forum requires publicly trusted code-signing keys to live in hardware modules, so exportable PFX files are generally unavailable for newly issued OV certs. The realistic alternatives are Azure Artifact Signing or a CA cloud-signing service (out of scope for v1, noted in the guide).
  - `platforms`: `all` (default) | `windows` | `macos` — Windows-only shops don't need Apple secrets.
  - `dry-run`: runs download + verify + build with signing stubbed; no secrets or certs needed. Lets the template be CI-tested and lets self-hosters validate setup before paying for anything.
- `scripts/generate-manifest-key.sh` — one-shot Ed25519 keygen; only the **private** key goes into repo secrets, the public key and the exact compose `environment:` block are printed in the workflow run summary.

All third-party actions pinned to full commit SHAs (same pattern as `release.yml`). WiX is version-pinned (the product CI currently floats it — pin both).

### Jobs

**Common preamble (each platform job):** download the official manifest + `.ed25519` signature for `v${version}`; verify against the committed official key **before any secret is exposed**; resolve the tag and require it to match the manifest's `sourceCommit`; checkout `lanternops/breeze` at that immutable SHA (build scripts, WiX sources, entitlements, winres config); download unsigned inputs and verify sha256 + size against the manifest. **Fail closed at every step.**

**`windows`** (`windows-latest`):
1. Sign the 4 exes — `azure/artifact-signing-action` (their secrets) or `signtool` + PFX per `signing-mode`.
2. Build the MSI via `agent/installer/build-msi.ps1`; sign the MSI.
3. Verify: `Get-AuthenticodeSignature` sweep (tolerating `UnknownError` for fresh ACS roots, same as `release.yml:618`).

**`macos`** (`macos-latest`):
1. Ephemeral keychain import of their Developer ID Application cert (deleted in `always()` cleanup).
2. `codesign --options runtime` with the repo's entitlements files over all darwin binaries; notarize via `notarytool` with Apple ID + app-specific password + team ID (matching `scripts/release/notarize-submit.sh` — ASC API-key auth is **not** promised in v1).
3. `build-pkg.sh` → `productsign` with their Developer ID Installer cert → notarize + `stapler staple`.
4. Build `Breeze Installer.app` from the checked-out source embedding **their** signed PKGs; sign, notarize, staple, zip.
5. Verify: `codesign --verify --strict`, `pkgutil --check-signature`, `spctl --assess`.

**`publish`** (needs both, tolerates a skipped platform):
1. Assemble signed artifacts + `checksums.txt`.
2. **Mirror every retained canonical asset** from the official release that the API's URL helpers expect — Linux agent/backup/watchdog binaries, viewer/helper installers, `latest.json` — so a repointed instance doesn't 404 on non-Windows/macOS paths (source of truth: `binarySync.ts` target arrays + `binarySource.ts` filename maps). Install scripts are *not* release assets — `install.sh` is generated by the API.
3. Build and sign **their** `release-artifact-manifest.json` (+ `.ed25519`) with their manifest key, same format and `platformTrust` vocabulary the API already understands.
4. Create release `v${version}` on their repo with everything attached.

### Secrets

- Azure mode: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_CERT_PROFILE` (single profile; no prod/prerelease split), with OIDC federated credential preferred over `AZURE_CLIENT_SECRET`.
- PFX mode: `WINDOWS_PFX_BASE64`, `WINDOWS_PFX_PASSWORD`.
- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_INSTALLER_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Manifest: `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` only (public derived).
- README recommends a GitHub Environment with required reviewers around the signing secrets.

### Maintenance stance

The template workflow is a **distilled copy** of the `release.yml` signing jobs, not a reusable workflow referenced from our repo — self-hosters' runs must not break when we refactor `release.yml`, and their secrets must never flow through our workflow definitions. Drift risk is accepted and mitigated by (a) the `sourceCommit`-pinned checkout putting all version-sensitive parts in the product repo, and (b) a release-checklist item to diff the template whenever `release.yml` signing steps change.

## Deliverable 3 — API: unified release source + deployment re-signing

### 3a. One validated release-source helper

A single helper (strict `owner/repository` validation) resolves the release source from `BINARY_GITHUB_REPOSITORY` (default `lanternops/breeze`) and is used by **every** consumer: release-page/download URLs (`binarySource.ts:3`), GitHub API sync (`binarySync.ts:17` — retiring the separate `GITHUB_REPO` env or aliasing it through the helper), expected-manifest-repository validation, and the installer/support/recovery/viewer/helper URL builders. Added to the config schema (`validate.ts`) and the compose `environment:` mappings (a value in `.env` is not sufficient — it must be mapped, per the deploy contract).

Production validation: overriding the repository requires `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` to be explicitly set; the docs make unambiguous that it must then be **their** key.

### 3b. Deployment re-signing on github-mode sync (the fix that makes T1 work)

When syncing from an overridden repository, the API:
1. Verifies the self-hoster's release manifest against `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` (repository, release, filename, hash, size, platform trust).
2. Registers assets with a **normalized update manifest re-signed by the per-deployment key** (`manifestSigning.ts`), stamping the `deploy-*` key ID — instead of today's hardcoded `signingKeyId: "release-artifact-manifest-ed25519"` (`binarySync.ts:240`), which agents can only verify against the embedded official key.

Agents then verify updates against their TOFU-pinned deployment key with zero agent-side changes. For the unmodified official-repo path, behavior is unchanged. (Design choice: re-sign *only* for overridden repos, keeping the official path byte-identical; unifying both paths onto deployment signing is a possible later simplification, not required here.)

### 3c. Positive trust enforcement at ingestion

Replace expected-value-only checking with a positive allowlist wherever assets are registered or served: canonical Windows executables/MSIs require `windows-authenticode-required`; canonical macOS assets require `macos-developer-id-notarization-required`; `intendedUse: "signing-input"` assets are **never registrable or serveable**; unknown `platformTrust` values fail closed. Enforcement must sit centrally (sync + serve layers) because several public surfaces proxy or redirect without inspecting a manifest (`routes/agents/download.ts:41`, `supportPublic.ts:192`).

### 3d. Recovery media expected hashes

`recoveryMediaService.ts` verifies the backup binary against static hashes (github branch starts ~line 92, static check ~111-118); a self-signed backup binary has a different hash, so recovery-media verification would fail on BYO deployments. Implementation item: in github mode, source expected hashes from the active (deployment-verified) release manifest instead of the static table. **Scope decision (plan phase):** local mode (T2) has no verified manifest, so the static table + existing `BINARY_CHECKSUM_MANIFEST` override remain its path — unchanged behavior.

### Supported topologies (documented)

- **T1 (recommended):** `BINARY_SOURCE=github`, `BINARY_GITHUB_REPOSITORY=theirorg/breeze-selfhost-signing`, `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=<their pubkey>`. Instance auto-pulls their signed releases; agents update via the deployment key (3b).
- **T2 (zero-code fallback, works today):** `BINARY_SOURCE=local`, signed artifacts dropped into `AGENT_BINARY_DIR`.
- Migration guidance for both: set `AGENT_AUTO_PROMOTE=false` (defaults true) during first adoption; verify every required platform synced, then promote explicitly.

## Deliverable 4 — The guide (`apps/docs`, new deploy page: "Sign Your Own Agent Packages")

The centerpiece. Structure:

- **Part 0 — Overview**: why signing matters (SmartScreen, Gatekeeper, AV); what you'll have at the end; cost + time expectations (Azure Artifact Signing — formerly Trusted Signing — Basic ~US$9.99/mo, identity validation takes days; available to organizations and, in the US/Canada, individuals; Apple Developer Program US$99/yr). Decision table: Azure Artifact Signing vs. CA cloud signing vs. legacy PFX (adapted from `docs/signing/WINDOWS_INSTALLER_SIGNING.md`).
- **Part 1 — Azure Artifact Signing from zero**: create the resource, identity validation walkthrough, cert profile, Entra app registration, GitHub OIDC federated credential, role assignment. Portal-level step-by-step.
- **Part 2 — Apple Developer ID**: enroll, create Developer ID Application + Installer certs, export `.p12`, app-specific password.
- **Part 3 — Create your signing repo**: use the template, fill the secrets table, generate your manifest key, dry-run.
- **Part 4 — Run the workflow**: dispatch, what each job does, how to verify outputs locally.
- **Part 5 — Point your instance at your builds**: T1 and T2, env tables (including compose mapping), `AGENT_AUTO_PROMOTE=false` migration flow, how the fleet picks up the new version, optional hardening via `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=true`.
- **Troubleshooting**: SmartScreen reputation ramp-up (signed ≠ instantly clean; reputation accrues per cert + hash), notarization rejections, AV exclusions (`antivirus-exceptions.mdx` cross-link), manifest verification failures.
- **Appendix**: viewer/helper signing pointers; PFX-mode details and its legacy status.

### Related doc fixes (same effort)

- `apps/docs/src/content/docs/deploy/code-signing.mdx`: fix the stale AzureSignTool/Key Vault claim (actual: `azure/artifact-signing-action`); **delete** the `MSI_SIGNING_URL` per-download section; link the new guide.
- `deploy/binaries.mdx` + `deploy/environment.mdx`: document the unified `BINARY_GITHUB_REPOSITORY` semantics and the unsigned-artifact set.
- `docs/signing/WINDOWS_INSTALLER_SIGNING.md` `## Current State` is badly stale ("No signing, no installer") — refresh or replace with a pointer.
- `docs/signing/ARTIFACT_SIGNING_OPERATIONS.md` Model B: point at the new template/guide as the preferred path (fork-and-rebrand remains documented for full forks).

## Deliverable 5 — Cleanup: retire `msiSigning.ts`

Delete `apps/api/src/services/msiSigning.ts` + `msiSigning.test.ts`, the `MSI_SIGNING_*` env vars, their validation in `apps/api/src/config/validate.ts:594-598,1358-1369`, the `system.ts:75` health flag, every docs/`.env.example` mention, **plus** the stale mocks/imports in installer route tests (e.g. `enrollmentKeys_installer.test.ts:98`) and the outdated comment at `installerBuilder.ts:32`.

## Testing

- **API**: unit tests for the release-source helper (URL derivation, strict validation, every consumer wired); deployment re-signing on overridden-repo sync (asserts `deploy-*` key ID, not the official ID); positive-allowlist trust enforcement incl. `signing-input` rejection and unknown-value fail-closed; config-validation tests for the override rules. Extend `ci-smoke-binary-source-github.yml` (or add a variant) to exercise the override against a fixture repo/manifest.
- **Trust-chain E2E**: one test that walks all three layers with **distinct keys** — official source key → self-hoster release key → deployment key — ending in real Go-updater verification of the served manifest (`agent/internal/updater` test or harness).
- **Template workflow**: `dry-run` exercised in the template repo's own CI; signed-path validation via a manual run against a real prerelease with a scratch Azure account before the template is published; install the resulting MSI/pkg on test VMs.
- **Release changes**: assert manifest gains `sourceCommit` + `intendedUse` entries with correct classification order; assert the integrity gate still passes.

## Risks & Edge Cases

- **SmartScreen expectations**: even correctly signed, non-EV reputations ramp over time. The guide must set expectations to avoid "I signed it and it still warns" support load.
- **Signing-credential exposure to our repo**: the self-hoster's workflow runs our build scripts while holding their credentials. Mitigated by manifest-verified `sourceCommit` checkout (a moved tag cannot inject scripts) and SHA-pinned actions.
- **Eligibility gaps**: Azure identity validation can still exclude some self-hosters (region/entity); PFX-legacy and CA cloud signing are the documented escape hatches.
- **Publisher-name semantics**: self-hosters sign Breeze-branded binaries under their own cert — their org name appears as publisher on "Breeze Agent". Acceptable and documented; full rebrand belongs to the fork path (Model B).
- **Asset-mirroring completeness**: a repointed instance serves *all* binary types from the one repository; the publish job's mirror list must be contract-tested against the API's expected-asset list or missing assets surface as user-facing 404s.
- **Existing fleets**: already-installed agents keep updating fine — update trust becomes the per-deployment key (3b), and the swap to self-signed binaries is a normal version promotion. Called out in Part 5.
- **Drift between template and product**: mitigated per the maintenance stance; residual risk accepted.

## Rollout Order

1. Deliverable 1 + the manifest changes (`sourceCommit`, `intendedUse`) ship first: purely additive and harmless while signed packages are still public, and the template can't be validated without them.
2. Deliverable 3 (API) ships next — re-signing and trust enforcement are self-contained and inert for unmodified deployments.
3. Deliverables 2, 4, 5 follow (template validated end-to-end against a prerelease containing the unsigned set, guide, cleanup). Self-hosters get a migration window while both signed and unsigned artifacts are public.
4. The actual removal of public signed artifacts happens last, after the hosted-distribution decision (out of scope here) is implemented, with a deprecation notice in release notes at least one release ahead.
