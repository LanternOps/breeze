---
title: Installer bootstrap from an independent artifact source (implementation plan)
spec: docs/superpowers/specs/installer-enrollment/2026-10-18-installer-unblockable-bootstrap-spec.md
tracking_issue: LanternOps/breeze#9832
spec_issue: LanternOps/breeze#8874
status: parked — feature LanternOps/breeze#9832 closed as not planned on 2026-10-23 before any wave merged; W1 branch feature/9832-installer-unblockable-bootstrap/wave-9833 is pushed, unmerged
depends_on: "#8868 W2 (Windows one-liner catch), for W4b only"
---

# Installer Bootstrap From an Independent Artifact Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the control plane cannot be reached at the transport level, the Windows and macOS/Linux one-liners install the same bytes from a pre-agreed GitHub Releases artifact source, pinned by per-asset SHA-256 hashes that arrived with the enrollment token. The macOS installer app hands token redemption to the bundled agent, which has ECH.

**Architecture:** `POST /devices/onboarding-token` gains an `installFallback` anchor. The API computes it per request from the signed release manifest that it already stores on the promoted `agent_versions` row, after verifying that manifest. The web builder embeds the anchor in the commands. `install.sh` becomes a checked-in asset. The API serves it, and `release.yml` attaches it to every binaries-carrying release, so it is listed in the signed manifest. The fallback engages only on a transport failure that carries no origin response. It never engages on a certificate failure. Clients trust nothing they download except bytes whose hash matches the anchor. The API never fetches from the artifact source, so `assertGithubFetchableEdition` stays intact on every serving and ingesting path. Hosted stays dark: it needs an explicit source and a signed `distribution` declaration in the hosted manifest, and both wait on Todd's repository gate.

**Tech Stack:** Hono + Zod + Drizzle (API), `@breeze/shared` validators, Astro/React (web), bash (`install.sh`), PowerShell 5.1/7 (Windows one-liner), Go 1.26 (agent), Swift 5.9/SwiftPM (macOS app), GitHub Actions (`release.yml`), Vitest, `go test -race`, `swift test`.

**Spec:** `docs/superpowers/specs/installer-enrollment/2026-10-18-installer-unblockable-bootstrap-spec.md` (approved 2026-10-22; D1–D7 decided, not reopened here). Read it alongside this plan: the trigger allowlists (§3.4) and per-client behaviour (§3.5) are normative and are not repeated here.

## Global Constraints

- **Wire anchor (exact, schema 1):** `installFallback: { schema: 1, release, baseUrl, validUntil, assets: { [name]: sha256 }, macosPkgPublisher: { teamId, signingIdentityB64 } } | null`.
  - `release` matches `^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`.
  - `baseUrl` is `https://`, has no userinfo, query or fragment, and ends with `/`.
  - `validUntil` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` (UTC, whole seconds, so it compares correctly as a string on every client).
  - Hashes are lowercase `^[0-9a-f]{64}$`. `teamId` matches `^[A-Z0-9]{10}$`. `signingIdentityB64` is standard base64 of the manifest's `signingIdentity`, the same encoding as today's `X-Breeze-MacOS-Signing-Identity-Base64` header.
- **Consumed assets (exact, all required in schema 1, spec §3.2):** `install.sh`, `breeze-agent-windows-amd64.exe`, `breeze-agent-linux-amd64`, `breeze-agent-linux-arm64`, `breeze-backup-linux-amd64`, `breeze-backup-linux-arm64`, `breeze-agent-darwin-amd64.pkg`, `breeze-agent-darwin-arm64.pkg`.
- **Lifetime (D3):** `validUntil = min(tokenExpiresAt, mintedAt + 30 days)`, truncated to whole seconds.
- **Env (exact):** `INSTALLER_FALLBACK_SOURCE` ∈ `auto` (default) | `off` | `https://github.com/<owner>/<repo>` | (self-host only) an `https://` mirror base. `auto` resolves to the GitHub repo only when `BINARY_SOURCE=github` and `BINARY_EDITION` ≠ `hosted`; otherwise it is off.
- **Telemetry (exact):** env `BREEZE_INSTALL_PATH` ∈ `control_plane | artifact_fallback | agent_redeem_fallback`. Enroll body key `installPath`. Counter `breeze_agent_enroll_install_path_total{path}`, where `path` ∈ those three or `unknown`. No table, no column, no migration.
- **`install.sh` fallback marker:** the line `# breeze-install-fallback: 1`.
- **Signed manifest additions (top-level, optional, additive):** `installFallbackInterface: 1`. `release.yml` emits it only when the attached `install.sh` carries the marker, so no anchor ever points at a release whose script cannot honour the flags. Hosted manifests also carry `distribution: { repository, release }`. The Go updater (`json.Unmarshal`, no `DisallowUnknownFields`) and the API ignore unknown top-level keys today, and Tasks 3 and 5 pin that.
- **Fallback flags (exact):** `--fallback-schema 1`, `--fallback-base`, `--fallback-release`, `--fallback-valid-until`, `--fallback-sha256 <name>=<hex>` (repeat once per asset), `--fallback-pkg-team-id`, `--fallback-pkg-identity-b64`. A script that sees a `--fallback-schema` other than the one it supports ignores every fallback flag (spec §3.3 version skew). Scripts that predate the interface already `warn` and skip unknown arguments (`install.sh` arg loop), so they behave as today.
- **Installed-version floor trust rule:** the floor only ever executes an installed binary that is a regular, non-symlink file owned by uid 0 and not group- or world-writable, inside directories that are each owned by uid 0 and not group- or world-writable, all the way up to `/`. On macOS, `/Library/Breeze/bin` is checked first and `/usr/local/bin` only under the same rule (Homebrew can own it; see `agent/installer/macos/install-location.sh`). Windows uses only `<ProgramFiles>\Breeze\breeze-agent.exe`. A binary that fails the rule is never executed: there is no floor, and the pinned release installs.
- **Fallback requests:** never carry the enrollment token, the secret or an `Authorization` header. Every fallback `curl` uses `--proto '=https' --proto-redir '=https'`.
- **Command length (D7):** see Task 17 for the budget numbers.
- **Public repo:** fixtures use `*.example` / `*.invalid` hosts. No customer names, internal hostnames or IPs. The hosted distribution repository's name is not written anywhere until Todd creates it; code and tests use `example-owner/example-dist`.
- **Scoped tests:** `cd apps/<pkg> && npx vitest run <path>`. Never `pnpm --filter … test -- --run`. Typecheck with `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`, and read the exit code.

## Review Focus

1. **A self-signed / private-CA self-host server behind a TLS interceptor on a non-English Windows box.** The fallback must not engage. Certificate classification is structural (exception type, `WebExceptionStatus.TrustFailure`, HResult family), never message text. → Task 13 `AuthenticationException inner → false`, `a localized (German) AuthenticationException message → false`, and `SecureChannelFailure wrapping HResult 0x800B0101 (expired) → false`.
2. **The metadata call succeeds, then the binary download fails at transport.** The whole run must switch: `$expectedSha` and the URL both come from the anchor. Mixing them always fails closed and looks like tampering. → Task 13 `switches the whole run when the download fails after metadata succeeded`, and Task 11 `metadata ok, binary download transport failure → binary and backup come from the fallback`.
3. **A command pasted months ago with an expired anchor, run on a blocked network.** The output must be today's error message, not a fallback attempt, and not a crash from parsing the anchor. → Task 11 `expired anchor → no fallback, today's message`, Task 12 `expired → today's [ERROR]`, and Task 13 `expired anchor with a transport failure → #8868's message, no fallback`.
4. **Re-running the one-liner on a device that has a newer agent (fallback mode).** The newer binary must be kept, and `enroll` runs with it. A Linux reinstall must not overwrite it. → Task 11 `floor: installed v9.9.9 shim → kept…`, and Task 13 `a newer installed agent → reuse branch…`.
5. **A self-host BYO fork whose release lacks the macOS pkgs (no macOS signing), or whose repo is private.** Minting must still succeed. The anchor is `null` with one WARN log, and commands are byte-identical to today. → Task 3 `missing consumed asset → null`, and Task 6 `a service rejection never fails the mint (still 200 with a token)`.

---

## Waves, PRs and blast radius

| Wave / PR | Content | Ships to customer machines? | Model | Depends on | Lab before promote (Todd) |
|---|---|---|---|---|---|
| **W1** anchor + manifest format + verification library | Shared anchor schema, `INSTALLER_FALLBACK_SOURCE` config, pure builder, manifest `distribution` reader. Dark: nothing calls it. | No | Opus (trust logic) | — | — |
| **W2a** static `install.sh` + release attach | `install.sh` moved to `apps/api/assets/scripts/install.sh` and served byte-identical. `release.yml` attaches it, so it is listed in the manifest. | **Yes**: the script runs as root. Its bytes are unchanged except the usage comments. | Opus (release workflow) | — | No (no behaviour change); `release-integrity-gate` must stay green |
| **W2b** self-host mirror mode | Onboarding-token returns `installFallback`. `installPath` intake and counter. Web consumers pass the anchor through. Commands are unchanged. | No | Opus | W1, W2a (the anchor stays `null` until a promoted release's signed manifest carries `install.sh` and `installFallbackInterface: 1`, i.e. the first full release after W4a) | — |
| **W3** agent | `BREEZE_INSTALL_PATH` → `installPath`, plus the empty-installer-path bootstrap case for the macOS app. | **Yes** (agent binary) | Opus | — | **Yes**: the §7.2 enroll leg before the agent release promotes |
| **W4a** Unix one-liner + `install.sh` fallback mode | Spec §3.3–3.5 for macOS/Linux. | **Yes** (root installer) | Opus | W2a, W2b | **Yes**: §7.2 Linux and macOS legs before the server release that carries it |
| **W4b** Windows one-liner | Spec §3.5 Windows. | **Yes** (SYSTEM PowerShell) | Opus | W2b, **#8868 W2**, W7. Live anchors also need the first full release after W4a, because the anchor is all-or-nothing. | **Yes**: §7.2 Windows legs (SYSTEM, PS 5.1 on Server 2016, non-English locale behind an interceptor) |
| **W5** macOS app | Classification, consent, agent redemption. | **Yes** (notarized app) | Opus | W3 (only for telemetry; it works without) | **Yes**: §7.2 macOS app leg before the release that carries the app |
| **W6** hosted mode behind the repository gate | Hosted source resolution and the `distribution` requirement. Publish-contract doc. Dark. | No (config stays `off`) | Opus | W1, W2b | Enabling it is Todd's Gate H (below) |
| **W7** command-length budget test | D7 budget test. | No | Sonnet | — | — |

W7 has no dependencies. It lands the null-anchor ceilings and the helper; W4a adds the anchored unix row and W4b adds the anchored Windows row. Merge it early. Each PR branches from fresh `origin/main` with the title prefix `feat(installer):` and the body `Refs #8874`. The last PR to land (W4b or W5) carries `Closes #8874` only if the others have merged; otherwise every body says `Refs`.

### The private pipeline's publish contract (interface only)

For each hosted release `R`, the private release pipeline:
1. Publishes a release tagged `R` in the public distribution repository (Todd creates it and grants publish rights). It carries exactly the eight consumed assets, `release-artifact-manifest.json` and its `.ed25519` and `.minisig`.
   - The assets are byte-identical to what the hosted control plane serves. They are already-signed bytes, never re-signed copies.
   - `install.sh` is taken from this repository's `apps/api/assets/scripts/install.sh` at the release's `sourceCommit`.
2. Writes, inside the signed hosted manifest, a top-level `distribution: { repository: "<owner>/<repo>", release: "R" }`, and `installFallbackInterface: 1` when `install.sh` carries the marker. It also lists `install.sh` with `platformTrust: "release-workflow-produced"` and `edition: "hosted"`.
3. Downloads every consumed asset anonymously from the public URL, compares each SHA-256 to the manifest, and aborts on any mismatch.
4. Only then places the manifest and binaries where the hosted control plane promotes them to `isLatest`.

It never publishes signing inputs or `-unsigned` files there, and never publishes anything to the official self-host repository. Yanking a release means deleting its assets from the distribution release.

That is the whole interface this repo depends on. W6 enforces steps 1–2 on the API side.

### Gate H — hosted enablement (Todd)

Hosted `INSTALLER_FALLBACK_SOURCE` stays unset, so hosted resolves to `off`, until all of these hold:
- (a) the distribution repository exists;
- (b) the first hosted release is published there under the contract above;
- (c) W6 is deployed;
- (d) the §7.2 SNI-selective-proxy lab passes against hosted for every OS.

The flip is one env var on the hosted API, set to `https://github.com/<owner>/<repo>`. The rollback is `off`.

---

## W1 — Anchor format and verification library

### Task 1: Shared anchor schema

**Files:**
- Create: `packages/shared/src/validators/installFallback.ts`, `packages/shared/src/validators/installFallback.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (add `export * from './installFallback';`)

**Interfaces:**
- Produces:
  - `INSTALL_FALLBACK_SCHEMA_VERSION = 1 as const`
  - `INSTALL_FALLBACK_ASSETS` (readonly tuple of the eight names, Global Constraints order)
  - `type InstallFallbackAssetName`
  - Regex constants: `INSTALL_FALLBACK_RELEASE_RE`, `INSTALL_FALLBACK_VALID_UNTIL_RE`, `SHA256_HEX_RE`, `MACOS_TEAM_ID_RE`
  - `installFallbackSchema` (Zod, `.strict()` at every level; `assets` is a strict object with exactly the eight keys)
  - `type InstallFallback = z.infer<typeof installFallbackSchema>`
  - `parseInstallFallback(value: unknown): InstallFallback | null`, which never throws and returns null for anything invalid
  - `isSafeInstallFallbackBaseUrl(url: string): boolean`, which accepts https only and rejects userinfo, query, fragment, a missing trailing `/`, and any character outside `[A-Za-z0-9._~/:-]`, so that the value is safe inside both a PowerShell single-quoted and a bash double-quoted string

- [ ] **Step 1: Write the failing tests.**
  - `parses a complete schema-1 anchor` (use `https://github.com/example-owner/example-repo/releases/download/v0.124.0/` and eight `'a'.repeat(64)`-style hashes)
  - `rejects: missing asset, extra asset, uppercase hash, 63-hex hash, http base, base with ?q, base with user@, base without trailing slash, validUntil with offset +02:00, validUntil with fractional seconds, teamId of 9 chars, schema 2` (each → `parseInstallFallback` returns `null`)
  - `rejects a base containing a quote, backtick, $ or space`
  - `null and undefined → null`
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/installFallback.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the exports above.
- [ ] **Step 4: Run** the Step 2 command, then typecheck `packages/shared`. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** `feat(shared): install-fallback anchor schema (#8874)`.

### Task 2: `INSTALLER_FALLBACK_SOURCE` config and resolution

**Files:**
- Modify: `apps/api/src/config/validate.ts` (schema entry beside `BINARY_EDITION` ~L609; production check inside the hosted block ~L1646), `apps/api/src/config/validate.test.ts` (new `describe('INSTALLER_FALLBACK_SOURCE')` beside `describe('BINARY_EDITION (hosted fail-closed)')` ~L963)
- Create: `apps/api/src/services/installFallback/source.ts`, `source.test.ts`
- Modify (wiring that the env-parity suites enforce):
  - `docker-compose.yml` `x-api-env` (beside `BINARY_EDITION` ~L320): `INSTALLER_FALLBACK_SOURCE: ${INSTALLER_FALLBACK_SOURCE:-auto}`
  - `deploy/docker-compose.prod.yml` (~L288): same line
  - `.env.example` and `deploy/.env.example`: a commented entry with a one-paragraph explanation
  - `apps/api/src/system/connections/registry.ts`: add to the `agent-binaries` entry's `vars` (~L595–610)
  - `apps/docs/src/content/docs/deploy/environment.mdx`: a row for the new var. It names `off` as the rollback for every deployment: new anchors become `null` at once, and already-copied commands keep theirs until `validUntil` (spec §7.4).
- Run (do not pre-emptively edit): `apps/api/src/__tests__/parkedFanout.contract.test.ts`. It discovers only service files that read `devices` or carry Quick Support markers (`DEVICE_READ` / `EXCLUSION_MARKERS`, ~L78–107) and rejects stale entries (~L476–490). The new files read `agent_versions`, env and the metrics registry, so expect no entry. Add one only if the test names the file.

**Interfaces:**
- Produces:
  - `type InstallFallbackSource = { kind: 'off' } | { kind: 'github'; repository: string } | { kind: 'mirror'; base: string }`
  - `resolveInstallFallbackSource(env?: NodeJS.ProcessEnv): InstallFallbackSource`. It uses `getBinarySource()` (`binarySource.ts`), `getBinaryEdition()` (`binaryEdition.ts`), `getReleaseSourceRepository()` and `isOfficialReleaseSource()` (`releaseSource.ts`).
  - The repository is lower-cased `<owner>/<repo>`.
  - A mirror base is normalized to end with `/`.

- [ ] **Step 1: Write failing tests.**
  - `source.test.ts`:
    - `auto + github + self-host → github(BINARY_GITHUB_REPOSITORY or the official default)`
    - `auto + local → off`
    - `auto + hosted → off`
    - `off → off`
    - `explicit github URL → github(owner/repo)` (accepts `https://github.com/o/r` and `https://github.com/o/r/`; rejects `/releases`, a query, userinfo)
    - `explicit mirror on self-host → mirror`
    - `explicit mirror on hosted → off` (hosted may only use a GitHub repo)
    - `unparseable value → off`
  - `validate.test.ts`:
    - `production: hosted + INSTALLER_FALLBACK_SOURCE resolving to the official repo is a boot error` (explicit `https://github.com/lanternops/breeze`, matching `OFFICIAL_RELEASE_REPOSITORY`, case-insensitive; path `['INSTALLER_FALLBACK_SOURCE']`). `auto` needs no new rule: hosted already requires `BINARY_SOURCE=local` (`validate.ts` ~L1646–1654), and `auto + local` is off.
    - `production: hosted + explicit non-GitHub mirror is a boot error`
    - `any env: a malformed value is a boot error` (`ftp://…`, `https://u@x.example/`, `https://x.example/?a`)
    - `self-host + explicit mirror is valid`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/installFallback/source.test.ts src/config/validate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Zod entry: blank → undefined; otherwise refine against `auto|off|https://…`.
  - Production check inside the existing `binaryEdition === 'hosted'` block.
  - `resolveInstallFallbackSource` returns `off` on any parse failure and never throws (validation already gated boot).
- [ ] **Step 4: Run** the Step 2 command, then `cd apps/api && npx vitest run src/config/envComposeParity.test.ts src/config/envReadComposeCoverage.test.ts src/__tests__/parkedFanout.contract.test.ts`, then typecheck `apps/api`. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** `feat(api): INSTALLER_FALLBACK_SOURCE config (#8874)`.

### Task 3: Pure anchor builder and manifest `distribution` reader

**Files:**
- Modify: `apps/api/src/services/releaseArtifactManifest.ts` (add `distribution: unknown` to the internal `ReleaseArtifactManifest` type ~L160–233; new export below `verifyReleaseArtifactManifestIntegrity` ~L766)
- Create: `apps/api/src/services/installFallback/build.ts`, `build.test.ts`
- Test fixtures: generate an Ed25519 keypair in the test and sign the fixture manifests. Follow `releaseArtifactManifest.test.ts`'s existing key-injection pattern for `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`.

**Interfaces:**
- Consumes:
  - `verifyReleaseArtifactManifestIntegrity(manifestBytes, signatureBytes)` and `verifyReleaseArtifactManifestAsset(args)` (existing)
  - `assertDistributableReleaseAsset(args)` (`releaseAssetTrust.ts`)
  - `INSTALL_FALLBACK_ASSETS`, `parseInstallFallback` (Task 1)
  - `InstallFallbackSource` (Task 2)
- Produces:
  - `readVerifiedManifestDistribution(manifestBytes: Buffer, signatureBytes: Buffer): { repository: string; release: string } | null`. It verifies first and returns null when the field is absent or malformed (`repository` must pass `isValidReleaseSourceRepository`, `release` must match `INSTALL_FALLBACK_RELEASE_RE`).
  - `computeInstallFallbackValidUntil(tokenExpiresAt: Date, mintedAt: Date): string`
  - `buildInstallFallback(input: { source: InstallFallbackSource; edition: 'self-host' | 'hosted'; manifest: { bytes: Buffer; signature: Buffer } | null; promotedRows: Array<{ platform: 'windows' | 'linux' | 'macos'; architecture: 'amd64' | 'arm64'; version: string; checksum: string }>; tokenExpiresAt: Date; now: Date }): { anchor: InstallFallback | null; reason: InstallFallbackNullReason | null }`
    - Versions are compared normalized: `v${row.version.replace(/^v/, '')}` must equal `manifest.release`, the same normalization as `agentVersions.ts` ~L603. Rows store `0.124.0` (`binarySync.ts` ~L1596 strips the `v`).
    - Each promoted row's `checksum` must equal the manifest entry for that platform's raw agent asset: `breeze-agent-windows-amd64.exe`, `breeze-agent-linux-<arch>`, `breeze-agent-darwin-<arch>`. A mismatch gives `row_checksum_mismatch`. Platforms commit independently (`binarySync.ts` ~L1739–1755), so a matching version alone does not prove matching bytes.
  - `type InstallFallbackNullReason = 'source_off' | 'no_manifest' | 'signature' | 'not_binaries_release' | 'interface_missing' | 'version_disagreement' | 'row_checksum_mismatch' | 'repository_mismatch' | 'asset_missing' | 'asset_duplicate' | 'edition_mismatch' | 'platform_trust' | 'signing_input' | 'publisher_missing' | 'hosted_not_enabled' | 'hosted_not_mirrored' | 'expired' | 'schema'` (`hosted_not_mirrored` is first returned in W6)
  - `readVerifiedManifestInstallFallbackInterface(manifestBytes: Buffer, signatureBytes: Buffer): number | null`, beside the distribution reader

- [ ] **Step 1: Write failing tests** in `build.test.ts`. Each null case asserts both `anchor === null` and the exact `reason`:
  - `source off → source_off`
  - `null manifest → no_manifest`
  - `bad signature → signature`
  - `releaseKind server-only → not_binaries_release`. Promoted rows always come from the binaries release (`binarySync.ts` refuses a server-only release by name ~L198–216), so a server-only manifest on a row is a defect.
  - `manifest without installFallbackInterface, or with 2 → interface_missing`
  - `rows disagree (0.124.0 and 0.123.0) → version_disagreement`
  - `rows all 0.123.0, manifest release v0.124.0 → version_disagreement`
  - `rows store 0.124.0 (no v) and the manifest says v0.124.0 → anchor` (real-shape fixture; guards against comparing raw strings)
  - `linux/arm64 row checksum differs from the manifest's breeze-agent-linux-arm64 entry → row_checksum_mismatch`
  - `github source repo ≠ manifest.repository → repository_mismatch`
  - `each consumed asset missing in turn → asset_missing` (`it.each(INSTALL_FALLBACK_ASSETS)`)
  - `duplicate entry → asset_duplicate`
  - `self-host deployment + a hosted asset → edition_mismatch`, and the reverse
  - `windows exe with platformTrust none on a hosted edition → platform_trust`
  - `asset with intendedUse signing-input → signing_input`
  - `pkg without signingTeamId → publisher_missing`
  - `hosted edition, any source → hosted_not_enabled` (W1 keeps hosted dark; W6 replaces this branch)
  - `token already expired → expired`
  - Happy paths:
    - `self-host github`: `baseUrl === 'https://github.com/example-owner/example-repo/releases/download/v0.124.0/'`, every hash equals the manifest's, `validUntil` equals `computeInstallFallbackValidUntil`, and the output passes `parseInstallFallback`.
    - `self-host mirror`: `baseUrl === '<base>v0.124.0/'`.
  - `computeInstallFallbackValidUntil`: a token expiring in 365 d gives mint + 30 d; a token expiring in 2 h gives token expiry; fractional seconds are truncated; the output is a `…Z` string.
  - `readVerifiedManifestDistribution`: absent → null; valid → object; `repository: "../x"` → null; bad signature → null.
  - `existing verifiers tolerate the new top-level keys`: a manifest carrying `installFallbackInterface` and `distribution` still passes `verifyReleaseArtifactManifestAsset` and `verifyReleaseArtifactManifestIdentity`. Add this to `releaseArtifactManifest.test.ts`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/installFallback/build.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Hosted always returns `hosted_not_enabled` in W1. W6 owns the hosted branch.
  - The final step is `parseInstallFallback(candidate)`. If that is null, return `reason: 'schema'` and never emit an unvalidated anchor.
- [ ] **Step 4: Run** the Step 2 command, plus `npx vitest run src/services/releaseArtifactManifest.test.ts src/services/releaseAssetTrust.test.ts`, plus the parkedFanout contract test and the `apps/api` typecheck. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** `feat(api): install-fallback anchor builder (#8874)`. Open the W1 PR: `feat(installer): install-fallback anchor format and builder (#8874)`.

---

## W2a — `install.sh` becomes a released, checked-in file

### Task 4: Serve `install.sh` from a checked-in asset

**Files:**
- Create: `apps/api/assets/scripts/install.sh`. This is the current rendered output of `generateInstallScript`, with the six `${serverUrl}` usage-comment interpolations (`download.ts` L952–968) replaced by `https://breeze.example.com`.
- Create: `apps/api/src/services/installScript.ts`, which resolves the path with the same cwd-then-`__dirname` candidate order as `documentThemes.ts`'s font resolver (L30–50)
- Modify: `apps/api/src/routes/agents/download.ts` (route L740–761 reads the asset; delete `generateInstallScript` L946–1521)
- Modify: `apps/api/src/routes/agents/download.test.ts` (tests that asserted the server URL in usage comments now assert the placeholder)
- Run: the parkedFanout contract test (no entry expected; see Task 2)

**Interfaces:**
- Produces: `loadInstallScript(): string`. The file is read once and cached in module scope, and the function throws a clear `Error('install.sh asset not found; looked in: …')` if it is missing. `INSTALL_SCRIPT_ASSET_RELATIVE_PATH = 'assets/scripts/install.sh'`.

- [ ] **Step 1: Write failing tests** in `download.test.ts`:
  - `GET /install.sh body is byte-identical to apps/api/assets/scripts/install.sh` (`readFileSync` of the asset vs `await res.text()`)
  - `keeps text/plain, Cache-Control no-cache, the install-script-download rate limit, and 503 when no server URL is configured` (the last three already exist; keep them green)
  - `both API Dockerfiles copy apps/api/assets into the runtime image`. Read `docker/Dockerfile.api` and `apps/api/Dockerfile` and assert a `COPY` of `apps/api/assets` in the runtime stage. This guards against the asset silently missing from the image, because tsup does not bundle it.
  - The existing `bash -n` syntax test now reads the asset.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/agents/download.test.ts`. Expected: the byte-identity test FAILs (asset missing). The Dockerfile guard passes immediately, because both Dockerfiles already copy `apps/api/assets` (`docker/Dockerfile.api` ~L85, `apps/api/Dockerfile` ~L72). Prove it discriminates by temporarily deleting one `COPY` line, watching it go red, and reverting.
- [ ] **Step 3: Implement.** Produce the asset by rendering `generateInstallScript('https://breeze.example.com')` once and writing the output. Then `diff` the asset against a render with a real-looking URL. The only differing lines must be the six usage-comment lines. Paste that diff summary into the PR body.
- [ ] **Step 4: Run** the Step 2 command, plus `npx vitest run src/routes/agents/downloadRateLimits.test.ts`, plus the parkedFanout contract test and the `apps/api` typecheck. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** `refactor(api): serve install.sh from a checked-in asset (#8874)`.

### Task 5: `release.yml` attaches `install.sh`, and the manifest lists it

**Files:**
- Modify: `.github/workflows/release.yml`:
  - Job `create-release`, step "Prepare release assets" (~L2717): copy `apps/api/assets/scripts/install.sh` into `release-assets/` for `release_kind == 'full'` only.
  - Step "Verify signing-input manifest entries" (~L3012–3116): assert exactly one `install.sh` entry with `platformTrust == "release-workflow-produced"`, `edition == "self-host"`, and no `intendedUse`.
  - Step "Verify server-only release assets" (~L3142–3217): assert `install.sh` is absent.
  - Manifest generator (Python heredoc ~L2827–3006): set top-level `installFallbackInterface: 1` iff `release-assets/install.sh` contains the exact line `# breeze-install-fallback: 1`. Until W4a adds the marker, the key is omitted, so anchors stay `null` (`interface_missing`) even after W2b deploys.
- Modify: `scripts/release/release-workflow-server-only.test.mjs` (the executed-generator test "manifest: a full release differs from today only by…" ~L578 gains `install.sh` in its expected asset set)
- Modify: `docs/runbooks/2026-08-29-release-lineage-promotion.md`. Add a `## Yanking a bad release` section with two steps. First, delete the release's assets from its artifact source, which makes every already-copied anchor pinned to it fail closed. Second, promote a good release (or roll `isLatest` back), because new anchors follow the promoted row and keep pointing at the yanked release until it changes.
- Modify: `scripts/release/binary-affecting-paths.txt` (add `apps/api/assets/scripts/install.sh`), with a case in `binary-affecting-paths.coverage.test.mjs`

- [ ] **Step 1: Write failing tests** in `release-workflow-server-only.test.mjs`:
  - `full release: prepare step copies apps/api/assets/scripts/install.sh into release-assets` (`stepRun` text assertion)
  - `full release manifest lists install.sh as release-workflow-produced self-host` (run the generator as the existing test does, with an `install.sh` placed in the fixture's `release-assets`)
  - `server-only verification rejects a manifest that carries install.sh`
  - `generator emits installFallbackInterface: 1 only when install.sh carries the marker` (two fixture runs)
- And in Go, `agent/internal/updater/updater_test.go`: `TestVerifyReleaseArtifactManifestToleratesFallbackFields`. A signed manifest with `installFallbackInterface` and `distribution` verifies exactly as before. No agent code changes; this pins today's tolerance.
- [ ] **Step 2: Run** `node --test scripts/release/release-workflow-server-only.test.mjs` and `cd agent && go test ./internal/updater/ -run ToleratesFallbackFields`. Expected: the workflow tests FAIL. The Go test is expected to pass on first run, because it pins existing behaviour. Prove it discriminates by temporarily adding `DisallowUnknownFields` and watching it go red, then revert.
- [ ] **Step 3: Implement** the workflow edits. `checksums.txt` picks the file up automatically. Confirm that the `create-release` job's checkout contains `apps/api/assets`, and do not add a sparse checkout.
- [ ] **Step 4: Run** the Step 2 command, plus `node --test .github/scripts/check-workflow-security.test.mjs scripts/security/check-release-trust-allowlist.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `ci(release): attach install.sh to binaries releases (#8874)`. Open the W2a PR: `feat(installer): ship install.sh as a signed release asset (#8874)`. The body states that the script is byte-identical except for the six usage-comment lines, and that `release-integrity-gate` is untouched.

---

## W2b — Self-host mirror mode

### Task 6: Onboarding-token returns `installFallback`

**Files:**
- Create: `apps/api/src/services/installFallback/index.ts`, `index.test.ts`
- Modify: `apps/api/src/routes/devices/core.ts` (response L1072–1083), `apps/api/src/routes/devices.test.ts` (`describe('POST /devices/onboarding-token')` ~L387)

**Interfaces:**
- Consumes: `buildInstallFallback`, `resolveInstallFallbackSource`, `getBinaryEdition()`.
- Produces: `getInstallFallbackForMint(args: { tokenExpiresAt: Date; now?: Date }): Promise<InstallFallback | null>`.
  - One query reads every `agent_versions` row with `component = 'agent'`, `is_latest = true` and `edition = getBinaryEdition()` for the five tuples `windows/amd64`, `linux/amd64`, `linux/arm64`, `macos/amd64`, `macos/arm64`. It selects `version, release_manifest, manifest_signature`.
  - It also selects `checksum`, `platform` and `architecture` for `promotedRows`.
  - Manifest resolution, first hit wins:
    1. The windows/amd64 row's `release_manifest`/`manifest_signature`, when it is a schema-1 release artifact manifest. This is true for the official repository (raw pass-through) and for local mode with an official manifest pair (`binarySync.ts` ~L930).
    2. `BINARY_SOURCE=local`: the volume's manifest pair, through the existing `loadOfficialLocalManifestPair` (`binarySync.ts` ~L702). Export it if needed; do not write a second reader.
    3. `BINARY_SOURCE=github` (covers BYO forks, whose rows carry deployment-signed per-asset manifests from `applyDeploymentSigning`, `binarySync.ts` ~L2124–2154): fetch `getGithubReleaseArtifactManifestUrl(tag)` and `getGithubReleaseArtifactManifestSignatureUrl(tag)` (`binarySource.ts` ~L130–134). Use the same `safeFetchFollowingRedirects` + 1 MiB cap that `fetchSmallBuffer` uses (export a shared helper; do not copy it), with a 5 s timeout. Cache the verified pair in-process per tag for 1 h; failures are not cached.
       - This fetches only the manifest from the repository the API already syncs from. It never fetches an asset and never touches the hosted distribution repo, so D5(a) holds.
  - Nothing found, or the pair is not schema 1 → `no_manifest`.
  - It runs under the caller's DB context.
  - It never throws: any error → `null`, plus one `console.warn('[installFallback] anchor withheld', { reason })` per distinct reason per process.

- [ ] **Step 1: Write failing tests.**
  - `index.test.ts` (DB mocked as in `devices.test.ts`):
    - `self-host github with a schema-1 manifest row → anchor`
    - `local mode with explicit INSTALLER_FALLBACK_SOURCE (mirror) + per-binary manifest row + a valid volume manifest pair → anchor` (step 2). Local mode needs an explicit source; `auto + local` is off (spec §3.8).
    - `local per-binary manifest row + no volume pair → null (no_manifest)`
    - `BYO GitHub fork: row carries a deployment-signed per-asset manifest → fetches the release manifest pair once, verifies it, returns an anchor; a second mint within 1 h does not refetch` (step 3; build the row with the real `applyDeploymentSigning` output shape)
    - `GitHub manifest fetch times out → null, mint unaffected`
    - `step-3 manifest is server-only → null (not_binaries_release)`. By design, the anchor resolves through the promoted row's tag, which is always a binaries release, so `binariesRelease` is never followed.
    - `db throws → null, no throw`
    - `INSTALLER_FALLBACK_SOURCE=off → null and no DB query`
  - `devices.test.ts`:
    - `response carries installFallback from the service`
    - `response carries installFallback: null when the service returns null`
    - `the service receives the same expiresAt the response returns`
    - `a service rejection never fails the mint (still 200 with a token)`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/installFallback/index.test.ts src/routes/devices.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The key is always present in the response (`installFallback: anchor ?? null`). No new route, no middleware change, no MCP or RLS registration (spec §4).
- [ ] **Step 4: Run** the Step 2 command and the typecheck. Then, on a per-worktree stack (`pnpm wt-stack up`, copy the root `.env` with the AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET`/`BREEZE_CADDY_IP`), run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/onboardingTokenSiteScope.integration.test.ts`. Then `pnpm wt-stack down`. Expected: PASS, with counts recorded.
- [ ] **Step 5: Commit** `feat(api): onboarding token carries the install-fallback anchor (#8874)`.

### Task 7: `installPath` intake, audit and counter

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts` (`enrollSchema` L37–68), `apps/api/src/routes/agents/enrollment.ts` (success audit L1086–1112)
- Create: `apps/api/src/services/installPathMetrics.ts` (leaf counter, same pattern as `agentWsCredentialMetrics.ts`, registered on `metricsRegistry`), `installPathMetrics.test.ts`
- Modify: `packages/shared/src/validators/installFallback.ts` (+ test; `INSTALL_PATHS`, `normalizeInstallPath`)
- Modify: the enrollment route test (the existing `enrollment*.test.ts` beside `enrollment.ts`); run the parkedFanout contract test

**Interfaces:**
- Produces:
  - `INSTALL_PATHS = ['control_plane', 'artifact_fallback', 'agent_redeem_fallback'] as const`, exported from `packages/shared/src/validators/installFallback.ts` (Task 1's file)
  - `normalizeInstallPath(v: unknown): InstallPath | 'unknown'`
  - `recordEnrollInstallPath(path: InstallPath | 'unknown'): void`
  - The counter is `breeze_agent_enroll_install_path_total{path}`, pre-seeded at 0 for all four labels.

- [ ] **Step 1: Write failing tests.**
  - `enrollSchema accepts installPath: "artifact_fallback"`
  - `an unknown installPath string, a number, or an object never rejects the enroll` (schema field is `z.unknown().optional()`; the value is normalized in the handler)
  - `success audit details include installPath (normalized; absent → "unknown")`
  - `counter increments on success only` (a denied or error enroll does not count)
  - `labels are pre-seeded`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/installPathMetrics.test.ts src/routes/agents/` (directory filter; it matches the enrollment tests). Expected: FAIL.
- [ ] **Step 3: Implement.** Call `recordEnrollInstallPath` right after `recordAgentEnrollment('success', …)` (~L1084).
- [ ] **Step 4: Run** the Step 2 command, plus the typecheck and the parkedFanout contract test. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** `feat(api): record the install path on enrollment (#8874)`.

### Task 8: Web consumers pass the anchor through (commands unchanged)

**Files:**
- Modify: `apps/web/src/lib/installCommands.ts` (`InstallCommandOptions` gains `installFallback?: InstallFallback | null`; still unused here)
- Modify: `apps/web/src/components/devices/AddDeviceModal.tsx` (L420–440, L1293), `apps/web/src/components/setup/EnrollDeviceStep.tsx` (L86–91, L484)
- Test: `apps/web/src/components/devices/AddDeviceModal.test.tsx`, `apps/web/src/lib/installCommands.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `AddDeviceModal passes parseInstallFallback(response.installFallback) to buildInstallCommands` (spy the module)
  - `a malformed installFallback in the response is passed as null`
  - `installCommands: output with a valid anchor is byte-identical to output without one` (removed in W4a/W4b when the anchor starts being used)
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/devices/AddDeviceModal.test.tsx src/lib/installCommands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `parseInstallFallback` from `@breeze/shared`. No new UI string, so no locale keys (Gate B 13).
- [ ] **Step 4: Run** the Step 2 command and the `apps/web` typecheck. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** and open the W2b PR: `feat(installer): self-host install-fallback anchor on onboarding tokens (#8874)`. Settings rule 9: "deployment env var, not a product setting; 0 → 0 places configured in the UI". The docs PR section names `INSTALLER_FALLBACK_SOURCE`.

---

## W3 — Agent (ships to customer machines; lab before promote)

### Task 9: `BREEZE_INSTALL_PATH` → `installPath` on the enroll body

**Files:**
- Modify: `agent/pkg/api/client.go` (`EnrollRequest` L38–53: add `InstallPath string \`json:"installPath,omitempty"\``)
- Create: `agent/internal/agentapp/install_path.go`, `install_path_test.go`
- Modify: `agent/internal/agentapp/main.go` (`enrollReq := &api.EnrollRequest{…}` ~L1818–1848)

**Interfaces:**
- Produces: `installPathFromEnv() string`. It reads `os.Getenv("BREEZE_INSTALL_PATH")` and trims it. It returns the value only if it is one of the three allowed values (Global Constraints), else `""`, which omits the key.

- [ ] **Step 1: Write failing tests.**
  - `TestInstallPathFromEnv` (table: each allowed value; empty; `"evil"`; `" artifact_fallback "` → trimmed)
  - `TestEnrollSendsInstallPathFromEnv`: an httptest server captures the `/api/v1/agents/enroll` body. `t.Setenv("BREEZE_INSTALL_PATH","artifact_fallback")` → body has `"installPath":"artifact_fallback"`. With the env unset, the body has no `installPath` key.
  - `TestRunBootstrap_ForwardsInstallPath`: extend the existing `TestRunBootstrap_CancelsSlotOn4xxEnrollRejection` fixture pattern. The bootstrap path reaches the same `enrollWithConfig` and carries the key.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/agentapp/ ./pkg/api/ -run 'InstallPath|ForwardsInstallPath'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/agentapp/... ./pkg/api/...`, then `make lint` (or the repo's `golangci-lint run ./...`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): report the install path on enrollment (#8874)`.

### Task 10: Empty-installer-path bootstrap (the macOS app's agent-redeem form)

Decision (Gate B 7): the macOS app reuses `bootstrap --install-data "|<token>|https://<host>"`, with no new flags.
- `resolveBootstrapInputs` already lets the token and server properties win over the path (`bootstrap.go` L104–133).
- The major-upgrade guard (already enrolled → log and exit 0) is acceptable for a reinstall. The app's agent-redeem Done copy (Task 15) does not claim a fresh enrollment.

**Files:**
- Modify: `agent/internal/agentapp/bootstrap_test.go` (`TestResolveBootstrapInputs` L20)
- Create: `agent/internal/agentapp/bootstrap_agent_redeem_test.go`
- Modify (only if Step 2 shows a Windows-only assumption): `bootstrap.go` `runBootstrap` (L246), guarded by `runtime.GOOS`

- [ ] **Step 1: Write failing tests.**
  - The `TestResolveBootstrapInputs` case `"empty installer path with property token + server (macOS agent-redeem form)"`: input `"|tok123|https://breeze.example.com"` → `("tok123","https://breeze.example.com",nil)`.
  - `TestRunBootstrap_EmptyInstallerPathRedeemsAndEnrolls`: with `osExit` and the redeem and enroll seams stubbed as in the existing `runBootstrap` tests, `bootstrapInstallData = "|tok|https://breeze.example.com"`, an unenrolled config, and a self-host host policy. Asserts that `gateBootstrapServer` saw the server, redeem got the token, `enrollDevice` ran with the redeemed key, and the exit is 0.
  - `TestRunBootstrap_EmptyInstallerPathHostedRefusesNonAllowlistedHost`, mirroring `TestRunBootstrapNeverDisclosesTokenToNonAllowlistedHost`.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/agentapp/ -run 'ResolveBootstrapInputs|EmptyInstallerPath'`. Expected: the new `runBootstrap` tests FAIL only if a Windows-only step (`configFileInMachineDir` / `reclaimConfigDirFn`) breaks on darwin/linux. If both pass on first run, record that and verify the test discriminates: temporarily make `resolveBootstrapInputs` ignore the property token, confirm the tests go red, then revert.
- [ ] **Step 3: Implement** by branch:
  - Green in Step 2: the deliverable is the tests plus the recorded discrimination proof, with no `bootstrap.go` change.
  - Red: guard the failing Windows-only call (`configFileInMachineDir` / `reclaimConfigDirFn`) with `runtime.GOOS == "windows"`, and change nothing else.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/agentapp/...` and the linter. Expected: PASS.
- [ ] **Step 5: Commit** and open the W3 PR: `feat(agent): install-path telemetry and agent-redeem bootstrap coverage (#8874)`. The body lists the §7.2 enroll leg as Todd's pre-promote gate.

---

## W4a — Unix one-liner and `install.sh` fallback mode (ships to customer machines)

### Task 11: `install.sh` fallback interface

**Files:**
- Modify: `apps/api/assets/scripts/install.sh`
- Test: `apps/api/src/routes/agents/download.test.ts`. Add a new `describe('install.sh fallback mode (#8874)')` beside the functional pre-flight block (L1530–1843), reusing its `runScript`, `shimDir` and local-server pattern.

**Behaviour to implement (normative detail in spec §3.3–3.5):**
- Marker line `# breeze-install-fallback: 1` directly under the shebang comment block. Adding it is what makes the next full release's manifest carry `installFallbackInterface: 1` (Task 5), which is what turns anchors on for self-host. So the release that carries W4a is the first one with live anchors. W4b's Windows fallback also waits for it, because the anchor is all-or-nothing.
- Parse the seven fallback flags. Validate every value with the Global Constraints regexes, plus the asset name allowlist. Any invalid or missing value disarms the whole fallback, with one `warn` line that does not echo the values. `fallback_armed` is true only when all values are valid and `date -u +%Y-%m-%dT%H:%M:%SZ` is lexicographically less than `--fallback-valid-until`.
- `is_transport_failure <curl_rc> <http_code> <http_connect>`: true iff `rc ∈ {6,7,35,52,56}`, `http_code == 000` and `http_connect == 000`. Every other combination is false, including 60, 22, 28 and 5.
  - The pre-flight curl becomes `-w '%{http_code}:%{http_connect}'`.
  - When armed and the classifier says transport, print `Breeze: <server> is unreachable from this network (curl error <rc>); using the pinned release <tag> from the fallback source` and set `FALLBACK_ACTIVE=1`. Otherwise, today's `fatal` branches run unchanged. Rc 35 stays "TLS problem" when not armed.
- Once `FALLBACK_ACTIVE=1`, every later fetch in the run uses `fetch_fallback_asset <name> <dest>`:
  - `curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 -o <dest> "<base><name>"`, with no token, secret or header.
  - Then a `verify_sha256 <dest> <anchor hash>` that `rm`s and `fatal`s on mismatch with `Checksum mismatch from the fallback source for <name>; refusing to install`.
- Metadata, binary, backup and pkg fetches each check transport failure too (Review Focus 2). A transport failure on any later control-plane fetch while armed switches the rest of the run.
- Version metadata in fallback mode is the anchor's `release` and hash; there is no metadata fetch.
- macOS pkg in fallback mode: the expected SHA, team ID and identity come from the anchor flags, replacing the `X-Breeze-*` headers. The `xar!` check, `pkgutil --check-signature` identity binding and `spctl --assess --type install` stay.
- Backup in fallback mode uses `breeze-backup-linux-<arch>`. A missing anchor entry gives the existing non-fatal warning.
- Parse `--fallback-schema`. Any value other than `1` disarms the fallback with one `warn`.
- Installed-version floor, in fallback mode only:
  - Candidate: on Linux `"$INSTALL_DIR/$BINARY_NAME"`; on macOS `/Library/Breeze/bin/breeze-agent`, then `/usr/local/bin/breeze-agent`. Execute it only if `trusted_root_owned_path <file>` passes the Global Constraints trust rule (`stat` owner and mode on the file and every ancestor; use `stat -c` on Linux and `stat -f` on macOS). Otherwise, there is no floor.
  - Run `<candidate> version` by absolute path. The spec says `--version`, but the agent has no such flag; the `version` subcommand (`main.go` L271–277) is canonical, the same probe as the existing `MIN_AGENT_VERSION` check.
  - Parse with the existing `DOWNLOADED_VERSION` sed and compare with the existing `sort -t. -k1,1n -k2,2n -k3,3n` idiom.
  - If installed > pinned: skip download and replacement, print `Keeping the installed agent v<x> (newer than the pinned v<y>)`, and enroll with the installed binary.
  - An unparseable installed version means no floor.
- `export BREEZE_INSTALL_PATH=control_plane` at start; `artifact_fallback` once `FALLBACK_ACTIVE=1`. This is exported before `enroll`.

- [ ] **Step 1: Write failing tests.** Fixture: a `curl` shim in `shimDir` that maps the `https://fallback.invalid/` prefix to a local HTTP server, strips only `--proto`/`--proto-redir` (and records that both were present), records every argv to a log, and execs the real curl for everything else. The primary server is a raw `net.createServer` that writes `HTTP/1.1 302 Found\r\nLocation: http://blocked.example/\r\n\r\n` on connect, so the real curl to `https://127.0.0.1:<port>` exits 35, as the real filter does.
  - `plaintext-302 filter + armed anchor → installs from the fallback; agent and backup hashes verified; BREEZE_INSTALL_PATH=artifact_fallback reaches enroll` (an `enroll` shim binary records its env)
  - `connection refused (port 1, rc 7) + armed → fallback`
  - `HTTP 503, HTTP 404, an HTML 200, and rc 60 (shim) → no fallback, today's message`
  - `proxy CONNECT 407 (shim: rc 56, http_connect 407) → no fallback`
  - `expired anchor → no fallback, today's message`
  - `one invalid flag (base with ?q) → fallback disarmed, warn printed, values not echoed`
  - `tampered agent at the fallback source → refused; nothing written to INSTALL_DIR`
  - `metadata ok, binary download transport failure → binary and backup come from the fallback`
  - `floor: installed v9.9.9 shim → kept, no download of the agent asset, enroll uses it` (run with a `stat` shim that reports uid 0 / mode 755 along the path, because CI is not root)
  - `floor: installed binary in a group-writable dir (or owned by uid 501) → never executed (a sentinel file it would touch stays absent), pinned release installs`
  - `--fallback-schema 2 → fallback disarmed, today's behaviour`
  - `fallback requests carry no token, secret or Authorization` (assert on the curl argv log)
  - `darwin: pkg from the fallback with a wrong team ID → refused` (existing `uname`/`pkgutil`/`spctl`/`installer` shim pattern from L1658–1699)
  - `no fallback flags → behaviour byte-for-byte as before`. The existing pre-flight tests stay green unchanged.
  - `served script contains the marker line exactly once`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/agents/download.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** in `install.sh`.
- [ ] **Step 4: Run** the Step 2 command (the `bash -n` test included) and `shellcheck apps/api/assets/scripts/install.sh` if it is installed. Expected: PASS.
- [ ] **Step 5: Commit** `feat(installer): install.sh fallback mode (#8874)`.

### Task 12: Unix one-liner embeds the anchor

**Files:**
- Modify: `apps/web/src/lib/installCommands.ts` (`unixCmd` L36–40)
- Create: `apps/web/src/lib/installCommands.unix.exec.test.ts` (executes the command with `bash -c`; shims for `curl`, `sudo` (`exec "$@"`), `sha256sum`/`shasum` pass-through, and an `install.sh` served by a local server)
- Modify: `apps/web/src/lib/installCommands.test.ts` (string tests; delete Task 8's interim byte-identity-with-anchor test)

**Behaviour:**
- With `installFallback` null, the output is byte-identical to today.
- With an anchor, the fetch captures `rc` and `%{http_code}:%{http_connect}`. A transport failure (same rule as Task 11) and an unexpired anchor fetch `<base>install.sh` with the https-only flags. The hash is checked in the user shell for an early friendly error.
- Then `sudo sh -c` creates a root-owned `mktemp -d` (mode 700), copies the file into it, re-checks the hash on that copy, and `exec bash`es that exact copy with `--server`, `--token`, the secret flag, and every `--fallback-*` flag (spec §3.5 "verify as root"). Any failure exits before `exec`.
- The primary path also passes the `--fallback-*` flags, so `install.sh` can switch mid-run.
- Every embedded value is re-validated with the shared regexes before interpolation. If any fails, the whole command falls back to the null-anchor form. Values go inside double quotes; Task 1's charset makes that safe.

- [ ] **Step 1: Write failing tests.**
  - Exec tests:
    - `primary ok → runs the control-plane install.sh with the fallback flags`
    - `primary rc 7 → fetches the fallback install.sh, verifies it, runs the root copy`
    - `tampered fallback install.sh → refused before sudo`
    - `source swapped after the user-shell hash check` (a `sudo` shim that overwrites `$f` with a malicious script, then execs the rest) `→ the root-side hash check refuses; the malicious script never runs` (sentinel file absent). This proves the second check is load-bearing.
    - `root-side copy or hash failure → exits non-zero without executing anything`
    - `neither sha256sum nor shasum on PATH → fails closed before sudo` (spec §3.5)
    - `HTML 200 from primary → today's [ERROR], no fallback`
    - `expired → today's [ERROR]`
    - `no fallback request carries the token`
  - String tests:
    - `null anchor → output identical to the pre-change snapshot` (inline the current string as the expected literal)
    - `a hash failing validation → null-anchor form`
    - `uses --proto '=https' --proto-redir '=https' on the fallback fetch`
    - `token, secret and every --fallback-* value appear only inside their double quotes` (tokenize the command with a quote-aware splitter and assert that each value is a whole quoted argument; spec §7.1)
- [ ] **Step 2: Add** W7's anchored-unix budget row (`unix with a full anchor ≤ 4,096`) to `installCommands.budget.test.ts`. **Run** `cd apps/web && npx vitest run src/lib/installCommands.unix.exec.test.ts src/lib/installCommands.test.ts src/lib/installCommands.budget.test.ts`. Expected: the exec and string tests FAIL; the budget row passes as a ceiling.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command and the `apps/web` typecheck. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** and open the W4a PR: `feat(installer): macOS/Linux one-liner falls back to the pinned release (#8874)`. Write the release-notes entry in `docs/release-notes/next-release-draft.md` with the four statements from spec §7.4 (listed under Lab gates). Also update `apps/docs/src/content/docs/agents/advanced-install.mdx` with a short section: what the fallback is, its source, that it pins the release current at copy time, the 30-day re-copy rule, and that a failed fallback leaves no server trace. The body lists the §7.2 Linux and macOS legs as Todd's gate before the server release.

---

## W4b — Windows one-liner (blocked on #8868 W2)

### Task 13: Classifier, whole-run switch, floor

**Precondition:** #8868 W2 has merged (it rewrites the same `winFetchChecksum` `catch`). Rebase onto it, and keep its base-exception message as the not-fallback branch.

**Files:**
- Modify: `apps/web/src/lib/installCommands.ts` (`winFetchChecksum` L110–115, `winDownload` L153–160, enroll line)
- Modify: `apps/web/src/lib/installCommands.test.ts`
- Create: `apps/web/src/lib/installCommands.pwsh.test.ts` (executes the classifier and the switch logic under `pwsh`)

**Behaviour (spec §3.4 and §3.5 Windows):**
- With a null anchor, the output is byte-identical to the post-#8868-W2 command.
- With an anchor, the command defines:
  - `$fb` (base, release, validUntil, Windows hash), embedding only the Windows asset to save length.
  - A script-block classifier `$bzT`. It walks `InnerException`, and returns false on any certificate marker:
    - `[Security.Authentication.AuthenticationException]` anywhere
    - `WebExceptionStatus.TrustFailure`
    - an HResult in the certificate family, compared as signed int32: `(h -band 0xFFFFFF00) -eq 0x800B0100` (every `CERT_E_*`, including expired `0x800B0101`, untrusted root `0x800B0109` and CN mismatch `0x800B010F`), or `h` ∈ {`0x80090325` SEC_E_UNTRUSTED_ROOT, `0x80090327` SEC_E_CERT_UNKNOWN, `0x80090328` SEC_E_CERT_EXPIRED, `0x80090349` SEC_E_CERT_WRONG_USAGE, `0x80096004` TRUST_E_CERT_SIGNATURE}
  - Also false when any `WebException` has a `Response`, or for `ProxyNameResolutionFailure`.
  - It returns true for a `WebException` with status in spec §3.4's set and no `Response`, or for an `HttpRequestException` with no `StatusCode` whose inner chain holds a `SocketException` or `IOException`.
- The metadata `catch`: if `$bzT` is true and `[string]::CompareOrdinal([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), $fb.u) -lt 0`, then:
  - set `$src='fb'`;
  - print `Breeze: <api> is unreachable from this network (<base message>); downloading the pinned release from the fallback source`;
  - set `$expectedSha=$fb.h` and `$url=$fb.b+'breeze-agent-windows-amd64.exe'`.
  - Otherwise, throw #8868's message.
- The download `catch` applies the same rule when `$src` is still `'cp'`, re-binding the URL and the hash together (Review Focus 2).
- Fallback download (Gate B 9): resolve redirects with an https-only walker of at most five hops (`[Net.HttpWebRequest]` with `AllowAutoRedirect=$false`, reading `Location`). Then `Invoke-WebRequest -OutFile $exe -MaximumRedirection 0` on the final URL. The staging dir, MZ, Authenticode and checksum checks are unchanged.
- Floor (fallback mode only): `$inst=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Breeze\breeze-agent.exe'`. Confirm `installDirName` in `agent/internal/serviceinstall/paths.go` is `Breeze`. If it exists and `[version]` of `& $inst version` (parsed `\d+\.\d+\.\d+`) is greater than the pinned version, the run takes a separate **reuse** branch: no download and no MZ, Authenticode or anchor-checksum check (those verify a downloaded artifact, and the anchor hash cannot match a newer binary). Then `& $inst enroll …` and `& $inst service install`. The staging directory is not created.
- `$env:BREEZE_INSTALL_PATH` is `control_plane` or `artifact_fallback` before `& $exe enroll`.

- [ ] **Step 1: Write failing tests.**
  - `installCommands.pwsh.test.ts`. Guard: `const hasPwsh = spawnSync('pwsh',['-v']).status === 0; if (process.env.CI && !hasPwsh) throw new Error('pwsh required in CI')`. Then `describe.runIf(hasPwsh)`. Extract `$bzT` from the built command and run it against constructed exceptions:
    - `WebException ConnectFailure no Response → true`
    - `NameResolutionFailure → true`
    - `TrustFailure → false`
    - `AuthenticationException inner → false`
    - `HResult 0x800B0109 inner → false`
    - `ProtocolError with a Response → false`
    - `HttpRequestException(StatusCode=null, inner SocketException) → true`
    - `HttpRequestException(StatusCode=503) → false`
    - `ProxyNameResolutionFailure → false`
    - `a localized (German) AuthenticationException message → false` (proves message text is not used)
    - `SecureChannelFailure wrapping HResult 0x800B0101 (expired) → false`, and the same for `0x80090328`
  - Switch logic (pwsh-executed, `Invoke-RestMethod` stubbed to throw ConnectFailure): `expired anchor with a transport failure → #8868's message, no fallback`
  - Floor (pwsh-executed, with the version probe stubbed): `a newer installed agent → reuse branch; the anchor checksum is never compared against it; enroll targets $inst`
  - String tests:
    - `null anchor → identical to the post-#8868-W2 snapshot`
    - `switches the whole run when the download fails after metadata succeeded` (the download catch re-assigns both `$expectedSha` and the URL)
    - `fallback download refuses a non-https hop`
    - `embeds only the windows asset hash`
    - `sets BREEZE_INSTALL_PATH before enroll`
    - `the fallback never sends the token`: no `${token}` occurs before `enroll`
    - The existing drive-qualified-variable heuristic stays green.
- [ ] **Step 2: Add** W7's anchored-Windows budget row (`windows plain, max token + secret + full anchor ≤ 8,191`) to `installCommands.budget.test.ts`. **Run** `cd apps/web && npx vitest run src/lib/installCommands.pwsh.test.ts src/lib/installCommands.test.ts src/lib/installCommands.budget.test.ts`. Expected: the pwsh and string tests FAIL. The budget rows pass, because they are ceilings; they become binding once Step 3 lands.
- [ ] **Step 3: Implement.** Keep identifiers short; W7's budget is the ceiling.
- [ ] **Step 4: Run** the Step 2 command (W7's budget test included) and the typecheck. In the PR, confirm that a CI `test-web` shard actually executed the pwsh suite: read its log for the `installCommands.pwsh` test count, because a skipped suite is a false green.
- [ ] **Step 5: Commit** and open the W4b PR: `feat(installer): Windows one-liner falls back to the pinned release (#8874)`. The body lists the §7.2 Windows legs (SYSTEM, PS 5.1 on Server 2016, non-English locale behind an interceptor) as Todd's gate.

---

## W5 — macOS installer app (ships to customer machines)

### Task 14: URLSession failure classification

**Files:**
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/BootstrapFailureClass.swift`, `Tests/BreezeInstallerTests/BootstrapFailureClassTests.swift`
- Modify: `Sources/BreezeInstaller/BootstrapClient.swift`. A task delegate records whether a response or redirect was seen. `Error.network` gains `sawResponse: Bool`; update the call sites and `BootstrapClientSecurityTests.swift`.

**Interfaces:**
- Produces: `enum BootstrapFailureClass { case transportNoResponse, ambiguous, definitive }` and `static func classify(_ error: BootstrapClient.Error) -> BootstrapFailureClass`.
  - `transportNoResponse`: only `.network` with `sawResponse == false`, an `NSURLErrorDomain` code ∈ {`CannotFindHost`, `CannotConnectToHost`, `DNSLookupFailed`, `SecureConnectionFailed`}, and, for `SecureConnectionFailed`, no nested `NSURLErrorServerCertificate*` / `kCFStreamErrorDomainSSL` trust error in `NSUnderlyingErrorKey`.
  - `ambiguous`: `TimedOut`, or any `.network` with `sawResponse == true`.
  - `definitive`: everything else (`.http`, `.untrustedResponse`, `.untrustedServer`, `.decoding`, certificate errors).

- [ ] **Step 1: Write failing tests.** One test per row of spec §3.4's URLSession line, including `SecureConnectionFailed with nested ServerCertificateUntrusted → definitive`, `TimedOut → ambiguous`, `CannotConnectToHost after a redirect → ambiguous`, and `.http(404) → definitive`.
- [ ] **Step 2: Run** `cd agent/installer/macos-app && swift test --filter BootstrapFailureClassTests`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `swift test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(macos-installer): classify bootstrap transport failures (#8874)`.

### Task 15: Consent, then agent redemption

**Files:**
- Modify: `Sources/BreezeInstaller/InstallerApp.swift` (`InstallState` gains `consentAgentRedeem(host: String)` and `doneAgentRedeem`; the `InstallController` routes `.transportNoResponse` to consent, and `.ambiguous` to a non-retryable error with recovery copy)
- Modify: `Sources/BreezeInstaller/Installer.swift`
- Create: `Sources/BreezeInstaller/Views/ConsentAgentRedeemView.swift`
- Modify: `Views/DoneView.swift`
- Tests: `Tests/BreezeInstallerTests/InstallerShellEscapeTests.swift`, new `InstallControllerRoutingTests.swift`

**Interfaces:**
- Produces: `static func agentRedeemCommand(pkgPath: String, token: String, host: String) -> String`. It reuses `privilegedCommand`'s installed-binary discovery and ends with `BREEZE_INSTALL_PATH=agent_redeem_fallback "$B" bootstrap --install-data <escaped "|token|https://host"> --quiet`. Every value goes through `Installer.shellEscape`.
- The primary `privilegedCommand` prefixes `BREEZE_INSTALL_PATH=control_plane` before `"$B" enroll`.

**Copy (exact):**
- Consent:
  - "This Mac can't reach `<host>` directly. The agent can try an encrypted connection after it is installed. Install anyway?"
  - Secondary line: "You won't see which organization this Mac joins until it appears in the console."
- Agent-redeem Done (bootstrap exited 0; it either enrolled synchronously or found the Mac already enrolled, `bootstrap.go` ~L275–280): "The Breeze agent is installed. Check the console to confirm this Mac appears under the expected organization."
- Agent-redeem failure (bootstrap exited non-zero): show the agent's output and "The installer link may already be used. Download a fresh installer from the console and try again." `recoverable: false`, because a retry could replay a consumed single-use token. Today `InstallerApp.swift` ~L85–88 marks every installer failure retryable, so this mode must override that.
- Ambiguous error: "The connection to `<host>` dropped after the request was sent, so this installer link may already be used. Download a fresh installer from the console and try again."

- [ ] **Step 1: Write failing tests.**
  - `testAgentRedeemCommandEscapesTokenAndHost` (a token containing `'` and `;`)
  - `testAgentRedeemCommandSetsInstallPath`
  - `testPrimaryCommandSetsControlPlaneInstallPath`
  - `testTransportFailureRoutesToConsent`
  - `testAmbiguousFailureIsNotRecoverable`
  - `testRetryUsesTheSameClassification`
  - `testDefinitiveFailureKeepsTodaysError`
  - `testAgentRedeemCommandFailureIsNotRecoverable` (a `commandFailed` from the agent-redeem command → `recoverable: false`, fresh-installer copy)
- [ ] **Step 2: Run** `swift test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The app strings are English-only, as today; the app has no localization.
- [ ] **Step 4: Run** `swift test`. Expected: PASS. In the PR, confirm that the CI `Build Agent (darwin/arm64)` job's "Test macOS installer" step ran these tests.
- [ ] **Step 5: Commit** and open the W5 PR: `feat(macos-installer): agent-side redemption when the control plane is unreachable (#8874)`. The body lists the §7.2 app leg and notarization in `release.yml` `build-macos-installer-app` as Todd's gate.

---

## W6 — Hosted mode behind the repository gate (dark)

### Task 16: Hosted source and `distribution` enforcement

**Files:**
- Modify: `apps/api/src/services/installFallback/build.ts` and `build.test.ts`. Replace W1's `hosted_not_enabled` branch: a hosted edition requires a `github` source (Task 2 already maps hosted + mirror → off, and boot-refuses the official repo), plus `readVerifiedManifestDistribution` returning `repository` equal to the source repository. The `baseUrl` is built from `distribution.repository` and `distribution.release`.
- Modify: `apps/api/src/services/installFallback/index.test.ts`
- Create: `docs/release/hosted-distribution-contract.md`. It states only the outputs the API depends on: what the distribution release contains, the `distribution` and `installFallbackInterface` fields, `install.sh`'s edition and trust labels, and the rule that a release is mirrored before it is promoted. It also carries the Gate H checklist. No pipeline steps.
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (one sentence: hosted operators set an explicit distribution repository; `auto` is off for hosted)

- [ ] **Step 1: Write failing tests.**
  - `hosted + explicit https://github.com/example-owner/example-dist + a hosted manifest with matching distribution + every asset edition hosted → anchor, with baseUrl on example-owner/example-dist and the distribution.release tag`
  - `hosted + explicit source + a manifest without distribution → null (hosted_not_mirrored)`
  - `hosted + distribution.repository ≠ source repository → null (hosted_not_mirrored)`
  - `hosted + a self-host-edition asset → null (edition_mismatch)`
  - `hosted + auto → null and no DB query`
  - `assertGithubFetchableEdition is never called by the installFallback module` (static check: the module does not import `fetchVerifiedGithubReleaseArtifact`, `peekVerifiedGithubReleaseArtifact` or any fetch). This pins D5(a): the API never fetches from the mirror.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/installFallback/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command and the typecheck. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** and open the W6 PR: `feat(installer): hosted install fallback behind the distribution gate (#8874)`. The body says that hosted stays `off` until Gate H, and names the env flip and rollback.

---

## W7 — Command-length budget (D7)

### Task 17: Budget test

**Files:**
- Create: `apps/web/src/lib/installCommands.budget.test.ts`

**Budget numbers (Gate B 8).** Measured on main `8d20504960` with a 64-char token and a 64-char secret: Windows plain is 3,023 chars and the UTF-16 Base64 form is 8,064. Real onboarding tokens are `enroll_` + 48 hex (55 chars).
- (added by W4b, Task 13) `windows` plain, with the maximum token (55) + secret (64) + a full anchor: **≤ 8,191**
- `windows` as `-EncodedCommand` (UTF-16LE Base64), with a **null** anchor and the maximum token + secret: **≤ 8,191** (no regression on today's wrapper path)
- `windows` encoded **with** an anchor: no ceiling. `advanced-install.mdx` says that wrappers needing `-EncodedCommand` should save the one-liner to a `.ps1` and run the file. The "download as script" button is the D7(b) follow-up.
- (added by W4a, Task 12) `unix` with a full anchor: **≤ 4,096**, a conservative cap for RMM text fields.
- (W7) `windows` plain and `unix` with a null anchor and the maximum token + secret: **≤ 8,191** and **≤ 4,096** respectively.

- [ ] **Step 1: Write the test.**
  - `budgetFor(cmd: string): { plain: number; encoded: number }`
  - `it.each` over the W7 rows above (the null-anchor ceilings). W4a and W4b append their anchored rows.
  - Control: `budget assertion trips on an over-length command` (feed `'x'.repeat(8192)` through the same `assertWithinBudget` helper and expect a throw). This proves the assertion discriminates before it is trusted.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/installCommands.budget.test.ts`. Expected: FAIL with `assertWithinBudget is not defined`, because the test calls the helper before Step 3 defines it.
- [ ] **Step 3: Implement** the helper inside the test file.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** and open the W7 PR: `test(installer): command-length budget for install one-liners (#8874)`.

---

## CI traps (read before each PR)

- **New `apps/api/src/services/*` files** (`installFallback/*`, `installScript.ts`, `installPathMetrics.ts`): run `parkedFanout.contract.test.ts`. It classifies only device-reading files and rejects stale entries, so none of these should need an entry; do not add one pre-emptively. New paths may need an entry in the per-area gating contract (`.github/scripts/ci-area-gating.test.mjs`, which runs in the Lint job).
- **Server-only eligibility:** `apps/api/assets/scripts/install.sh` becomes a signed binaries-release asset. Task 5 adds it to `scripts/release/binary-affecting-paths.txt`, so a change to it forces a full release. Otherwise a server-only release could serve a script that differs from the signed copy the anchors pin. Run `binary-affecting-paths.coverage.test.mjs`.
- **Env parity:** `envComposeParity.test.ts` and `envReadComposeCoverage.test.ts` fail unless `INSTALLER_FALLBACK_SOURCE` is in both compose files, both `.env.example` files and `CONNECTION_REGISTRY`. Do not add it to the frozen `COMPOSE_INTENTIONALLY_UNMAPPED` baseline.
- **`release.yml` edits:** `release-workflow-server-only.test.mjs` executes the manifest generator, and `check-workflow-security.test.mjs` lints the workflow. Run both locally. A real tag run is the only end-to-end proof, so the W2a PR names the first tag that carries `install.sh` as its verification point. Inspect that release's manifest for the `install.sh` entry.
- **`install.sh` asset not in the image:** tsup does not bundle it. Task 4's Dockerfile assertion guards this. Smoke-check `GET /api/v1/agents/install.sh` on the first deployed image.
- **Swift tests** run only inside `Build Agent (darwin/arm64)`, and **pwsh tests** run only where `pwsh` exists. Read the job log for the test count; never trust a green job whose suite was skipped.
- **Typecheck heap:** `NODE_OPTIONS=--max-old-space-size=12288 … ; echo "exit=$?"`. Never pipe tsc to `tail`.
- **Integration:** no table or column is added, so the RLS, cascade and export-policy suites are unaffected. W2b still runs `onboardingTokenSiteScope.integration.test.ts`, because the response shape changes.
- **Stacked PRs** get no CI: `gh workflow run CI --ref <branch>`. Branch every wave from fresh `origin/main` instead.

## Lab gates (Todd; never on a host with an installed production agent)

Spec §7.2's SNI-selective proxy recipe (nginx `stream` + `ssl_preread`, with the control-plane SNI going to the plaintext-302 responder from `docs/superpowers/plans/2026-10-16-agent-ech-lab.md` §1, and every other SNI passed through).

| Gate | Before | Legs |
|---|---|---|
| L-W3 | the agent release carrying W3 promotes past canary | `enroll` and `bootstrap` over one-shot ECH report `installPath` |
| L-W4a | the server release carrying W4a | Linux amd64/arm64 and macOS one-liner fall back, verify and enroll over ECH. Negatives: tampered mirror asset, proxy 407, untrusted interceptor, expired anchor, newer installed agent kept. Capture fallback-host requests and assert no token, secret or `Authorization`. |
| L-W4b | the server release carrying W4b, run on a stack whose promoted release carries `installFallbackInterface: 1` | Windows SYSTEM runner; PS 5.1 on Server 2016; a non-English locale behind an untrusted interceptor (must not fall back); the same negatives |
| L-W5 | the release carrying the W5 app | app reaches consent; the agent redeems; Done copy shown |
| Gate H | hosted `INSTALLER_FALLBACK_SOURCE` flip | every leg above against hosted, after the distribution repo carries a hosted release |

Every leg, Gate H included, captures the fallback host's requests and asserts that none carries the token, the secret or an `Authorization` header. Every leg also records, for the fallback run versus a primary-path run on the same host, any Defender/EDR detection, SmartScreen prompt or Gatekeeper prompt (spec §3.7: tested, not promised). A difference blocks the gate until it is understood.

Release notes for the release that carries W4a/W4b (written in Task 12 Step 5) state four things: the fallback exists and which source it uses; it pins the release that was current when the command was copied; the 30-day re-copy rule; and that a failed fallback leaves no server-side trace.

## Advisor quorum (Claude position, then `codex exec` read-only, xhigh)

The quorum agreed with 14 of the 15 Gate B defaults. It disagreed on item 7's completion copy, which is now fixed. It found eight defects, all verified in code and folded in above:
1. The floor could execute an attacker-owned `/usr/local/bin` binary as root. Fixed with the trust rule in Global Constraints and Task 11.
2. BYO forks' rows carry deployment-signed per-asset manifests, so they would never get anchors. Fixed with manifest resolution step 3 in Task 6.
3. Row versions lack the `v`. Fixed with normalization in Task 3.
4. A matching version does not mean matching bytes across independently committed platforms. Fixed with `row_checksum_mismatch` in Task 3.
5. The Windows floor kept the anchor checksum against a newer binary. Fixed with the reuse branch in Task 13.
6. The certificate HResult list was too narrow. Fixed with the family rule in Task 13.
7. The root-side copy check was untested. Fixed with the swap-after-check test in Task 12.
8. The macOS copy promised deferred enrollment, and retry after a consumed token was possible. Fixed in Task 15.

It also found two coverage gaps, both closed: the script-side schema flag (`--fallback-schema`) and the reputation observations in the lab gates.

## Gate B — decisions for Todd (default in brackets)

1. **How a hosted release is declared mirrored (D5 ordering).** [A signed top-level `distribution: {repository, release}` in the hosted manifest, checked against the configured source.] The alternative, a config minimum mirrored release, cannot prove that a later release is mirrored.
2. **`install.sh` source of truth.** [`apps/api/assets/scripts/install.sh`, read at runtime and attached by `release.yml`.] The alternative is the `uninstall.sh` precedent: a TS template plus golden copies, which means two places to edit.
3. **`install.sh` fallback interface.** [Seven separate argv flags (including `--fallback-schema`), with the identity passed as base64.] The alternative is one `--fallback-spec` string.
4. **Anchor completeness.** [All eight assets and the publisher are required (spec §3.2), so a BYO fork without macOS signing gets no fallback on any OS.] The alternative is per-OS partial anchors.
5. **Non-GitHub mirror layout.** [`<base><tag>/<asset>`.]
6. **Version reference.** [Every promoted agent row present must name the same version as the manifest; otherwise `null`.]
7. **macOS app redemption.** [Reuse `bootstrap --install-data "|token|server"`; no new agent flags. Bootstrap is synchronous, so exit 0 means enrolled or already enrolled. The Done copy claims neither and points at the console. A non-zero exit is non-retryable, with fresh-installer guidance.] (The quorum flagged the earlier "finishes on its own" copy; corrected.)
8. **Length budgets.** [Plain Windows with an anchor ≤ 8,191; encoded Windows without an anchor ≤ 8,191; encoded with an anchor unbounded and documented; unix ≤ 4,096.]
9. **PS 5.1 redirects.** [An https-only redirect walker, about 350 chars.] The alternative is hash-only integrity and accepting whatever .NET follows.
10. **Executed `pwsh` tests in `test-web`.** [Yes. The suite fails in CI if `pwsh` is missing.] The alternative is string-only tests, leaving the lab as the only PowerShell execution.
11. **`validUntil` format.** [UTC, whole seconds, `Z`, compared as a string.]
12. **Release gating.** [W4a/W4b may merge; the release that carries each needs that OS's lab leg. W3 needs L-W3 before promote.]
13. **Console hint "includes a fallback download source".** [None in v1, so no locale keys.]
14. **Primary path sets `BREEZE_INSTALL_PATH=control_plane`.** [Yes.] Absent stays `unknown`, as for the MSI, the pkg and old scripts.
15. **Interface gating.** [A signed `installFallbackInterface: 1` that `release.yml` emits from the `install.sh` marker. Anchors stay `null` until the first full release that carries W4a.] The alternative is a hard-coded `FIRST_RELEASE_WITH_INSTALL_FALLBACK` tag constant, which needs the release number guessed at merge time.
16. **`install.sh` forces a full release.** [Add it to `binary-affecting-paths.txt` (Task 5).] The alternative is to list it only in `agent-facing-paths.txt` and accept served/signed script skew between full releases.

## Deferred (not in this plan)

- A "download as `.ps1`/`.sh`" button (D7(b)).
- An API-side distribution verifier job (D5(b)), if the lab or the field shows mirror drift.
- The composition test with #8870 (primary blocked, alternate reachable → alternate is used, not the artifact source). Required once #8870 ships.
- Reporting failed fallback attempts to the server.
