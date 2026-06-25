# MSI Filename-Bootstrap Enrollment (macOS parity for Windows)

**Date:** 2026-06-24
**Status:** Design — approved, pending spec review
**Owner:** Todd Hebebrand

## Problem

Every Windows MSI download currently triggers a per-customer build-and-sign round-trip
to a remote Windows signing VM (`apps/api/src/services/msiSigning.ts` →
`buildAndSignMsi` → POST to the signing service behind a Cloudflare Access tunnel). The
service injects `SERVER_URL` / `ENROLLMENT_KEY` / `ENROLLMENT_SECRET` as MSI properties
and Authenticode-signs the result. This has three costs:

1. **Per-download dependency on on-prem infra** — a ~120s round-trip to a Windows VM that
   must stay alive, reachable, and credentialed (Azure Trusted Signing on the VM, CF Access
   tokens on the API).
2. **Permanent SmartScreen zero-reputation** — every customer MSI has a unique file hash, so
   each one starts at zero reputation and gets flagged on manual browser download (documented
   in the MSI signing pipeline notes).
3. **Larger secret exposure** — a 64-char enrollment key is baked into the binary handed to
   the customer.

macOS already solved the equivalent problem the simple way: ship **one** generic, CI-signed
(and notarized) `Breeze Installer.app`, and carry enrollment in a single-use **bootstrap
token** embedded in the download filename (`Breeze Installer [TOKEN@HOST].app`). The app reads
the token from its own filename, redeems it at `POST /api/v1/installer/bootstrap` for a fresh
child enrollment key, and enrolls. No per-customer signing.

This spec ports that pattern to Windows.

## Key existing facts this builds on

- **CI already signs a generic `breeze-agent.msi`** with Azure Trusted Signing via
  `azure/artifact-signing-action@v2` in `.github/workflows/release.yml`, gated by
  `vars.ENABLE_WINDOWS_SIGNING == 'true'`. All six secrets are present:
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SIGNING_ENDPOINT`,
  `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_CERT_PROFILE_PROD`, `AZURE_CERT_PROFILE_PRERELEASE`.
  The static signed artifact we need **already exists** — this is not "add CI signing."
- CI also builds an unsigned `breeze-agent-template.msi` explicitly marked for
  "re-signed server-side after patching" (`release.yml`, `agent/installer/build-msi.ps1`).
  This artifact and the server-side signing path are what we retire.
- The server-side bootstrap infrastructure is already platform-agnostic and in production for
  macOS: the `installerBootstrapTokens` table, `issueBootstrapTokenForKey()`
  (`apps/api/src/routes/enrollmentKeys.ts`), and `redeemBootstrapToken()` /
  `POST /api/v1/installer/bootstrap` (`apps/api/src/routes/installer.ts`). Redemption mints a
  child enrollment key with a **fresh TTL independent of the parent** — the bug that bit the
  MSI direct-enroll path is already avoided here.
- The macOS filename parser is `agent/installer/macos-app/Sources/BreezeInstaller/FilenameTokenParser.swift`,
  regex `\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]`. The Go side mirrors this.

## Goals

- Serve one static, CI-signed MSI per release; never modify it server-side.
- Carry enrollment via a single-use, short-TTL bootstrap token in the download filename.
- Preserve enterprise/mass-deploy enrollment via explicit `msiexec` properties.
- Eliminate the per-download signing-VM round-trip and the template MSI.

## Non-goals

- Changing the self-hosted zip fallback (`buildWindowsInstallerZip`) — it stays as-is for
  installs where no signed MSI is available.
- Changing macOS behavior.
- Adding new CI signing infrastructure (it already exists).
- Rotating or migrating Azure Trusted Signing credentials.
- Deleting the dormant `MsiSigningService` / its env vars, or decommissioning the signing VM —
  deferred to a follow-up PR. This effort only removes the call site so the download path stops
  using it.

## Architecture

```
Today:
  download → mint child enrollment key → POST signing VM → build+sign per-customer MSI
            (unique hash, baked-in 64-char key) → serve

Target:
  download → mint single-use bootstrap token → serve the static CI-signed breeze-agent.msi
            renamed "Breeze Agent [TOKEN@HOST].msi" (one shared hash, no baked-in key)
  install  → WiX immediate CA captures the launched MSI path
           → WiX deferred CA runs `breeze-agent.exe bootstrap`
           → POST /api/v1/installer/bootstrap (redeem token)
           → server mints fresh child enrollment key
           → agent enrolls
```

## Components

### 1. Server download handler — `apps/api/src/routes/enrollmentKeys.ts` (Windows branch, ~line 1119)

- **Remove** the `signingService.buildAndSignMsi({ version, properties: { SERVER_URL,
  ENROLLMENT_KEY, ENROLLMENT_SECRET } })` call for the Windows MSI path.
- **Replace** with the macOS-style flow:
  - `issueBootstrapTokenForKey()` to mint a single-use token (set `installerPlatform: "windows"`).
  - Serve the static signed `breeze-agent.msi` (from the GitHub release / on-disk binary cache —
    same source the zip fallback already uses) with
    `Content-Disposition: attachment; filename="Breeze Agent [<TOKEN>@<apiHost>].msi"`.
- **No child enrollment key is created at download time** — the child key is minted on
  redemption inside `redeemBootstrapToken()`, exactly as macOS does.
- The token format and host derivation match macOS: 10-char `[A-Z0-9]` token, `apiHost` from the
  same source macOS uses (`allowLegacyMacosInstallerFilenameToken()` host logic / `PUBLIC_API_URL`).

### 2. Agent `bootstrap` subcommand — `agent/internal/agentapp/main.go`

New `breeze-agent.exe bootstrap` Cobra command. Resolves enrollment inputs by precedence:

1. **Explicit properties** — if `--server` and an enrollment key are supplied, use the existing
   direct `enroll` path (the `enrollDevice` logic) unchanged. (Covers `msiexec /i ...
   SERVER_URL=... ENROLLMENT_KEY=...`.)
2. **`--token`** — a bootstrap token passed from the `BOOTSTRAP_TOKEN` MSI property; redeem at
   `POST /api/v1/installer/bootstrap`.
3. **`--installer-path`** — parse `[TOKEN@HOST]` from the MSI file's basename (Go port of the
   Swift regex `\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]`); redeem.

Redemption returns `{ serverUrl, enrollmentKey, enrollmentSecret }`; the command then calls the
existing `enrollDevice` logic with those values. Errors are written to `agent.log` via the
existing `initEnrollLogging` helper; `--quiet` is honored as in `enroll`.

The filename parser is a pure, testable helper (`parseInstallerFilenameToken(name string)
(token, host string, err error)`) so it can be unit-tested without an MSI, mirroring
`TestTrimEnrollInputs`.

### 3. WiX wiring — `agent/installer/breeze.wxs`

The deferred CA cannot reliably read the launched MSI path: by deferred execution the package
has been cached to `C:\Windows\Installer\*.msi` (renamed, token gone). The launched path is only
trustworthy during immediate execution via the `OriginalDatabase` property. Standard
capture-then-defer pattern:

- **Immediate** type-51 CA `CaptureInstallerPath`: sets the deferred CA's property
  (`BootstrapEnroll`) = `[OriginalDatabase]`. Scheduled after `CostFinalize`, before `InstallFiles`.
- **Deferred** type-18 CA `BootstrapEnroll` (Execute="deferred", Impersonate="no", Return="check"):
  `enroll`-style invocation — `breeze-agent.exe bootstrap --installer-path "[CustomActionData]"
  --token "[BOOTSTRAP_TOKEN]" --quiet`. Scheduled `Before="InstallServices"`.
- Keep the existing `EnrollAgent` CA for explicit-property installs.
- Condition the two so **exactly one** fires:
  - `EnrollAgent`: `Condition = NOT Installed AND SERVER_URL AND ENROLLMENT_KEY`
  - `BootstrapEnroll`: `Condition = NOT Installed AND NOT (SERVER_URL AND ENROLLMENT_KEY)`
- Declare a `BOOTSTRAP_TOKEN` property (`Secure="yes"`) alongside the existing
  `SERVER_URL` / `ENROLLMENT_KEY` / `ENROLLMENT_SECRET`.

`build-msi.ps1` continues to produce the regular MSI; only the `-Template` variant is removed
(see §4).

### 4. Retire the per-download signing path

- **API:** remove the `buildAndSignMsi` **call site** in the Windows download branch so the
  download path no longer hits the signing VM. **Leave `MsiSigningService` and its env vars
  (`MSI_SIGNING_URL`, `MSI_SIGNING_CF_ACCESS_ID`, `MSI_SIGNING_CF_ACCESS_SECRET`) in place but
  dormant** — deleting the now-unused service, its references, and the env vars is deferred to a
  follow-up PR. The on-prem signing VM and its Cloudflare tunnel are no longer in the download
  path (decommission tracked separately).
- **CI:** stop building and publishing `breeze-agent-template.msi` in `release.yml`; remove the
  `-Template` branch from `agent/installer/build-msi.ps1`. The signed `breeze-agent.msi` step is
  unchanged.
- **Self-hosted zip fallback** (`buildWindowsInstallerZip`) stays unchanged for installs with no
  signed MSI available.

## Data flow (target, double-click install)

1. Admin clicks "Download Windows installer" in the UI.
2. API mints a single-use bootstrap token (parent enrollment key → `installerBootstrapTokens`
   row, `installerPlatform:"windows"`), serves the static signed `breeze-agent.msi` named
   `Breeze Agent [TOKEN@HOST].msi`.
3. Admin runs the MSI. Immediate CA captures `OriginalDatabase`; deferred CA runs
   `breeze-agent.exe bootstrap --installer-path "...Breeze Agent [TOKEN@HOST].msi"`.
4. Agent parses `TOKEN`/`HOST` from the basename, POSTs the token to
   `https://HOST/api/v1/installer/bootstrap` (`X-Breeze-Bootstrap-Token` header).
5. Server validates+consumes the token, mints a fresh-TTL child enrollment key, returns
   `{ serverUrl, enrollmentKey, enrollmentSecret }`.
6. Agent enrolls via the existing `enrollDevice` path; service starts with a valid `agent.yaml`.

## Wins

- **SmartScreen reputation:** one shared MSI hash accrues reputation instead of every customer
  starting at zero.
- **No on-prem dependency** in the download path; no 120s round-trip; no VM/tunnel to keep alive.
- **Smaller secret exposure:** 10-char single-use, short-TTL token in the filename vs. a 64-char
  enrollment key baked into the binary.
- **Fewer moving parts:** template MSI and server-side signing service removed.

## Testing

### Go (`agent/...`)
- Table-driven `parseInstallerFilenameToken` tests: clean name, browser `(1)` suffix
  (`Breeze Agent [TOKEN@HOST] (1).msi`), missing/malformed brackets, wrong token length, host
  with dots/hyphens, non-MSI path. Mirror `TestTrimEnrollInputs`.
- `bootstrap` precedence resolution: explicit-properties > `--token` > `--installer-path`.
- Bootstrap redemption: happy path, expired token, already-consumed token (each surfaces a
  distinct logged outcome; HTTP error mapping).

### API (`apps/api/...`)
- Windows download serves the static MSI with the correct `[TOKEN@HOST]` `Content-Disposition`
  filename and makes **no** signing-service call.
- Download mints exactly one `installerBootstrapTokens` row with `installerPlatform:"windows"`
  and creates **no** child enrollment key at download time.
- `/installer/bootstrap` mints a child key with a fresh TTL independent of the parent for the
  Windows-platform token (reuse the existing macOS coverage shape).

### Manual (Windows test VM — Tailscale 100.101.150.55)
- Double-click install with `[TOKEN@HOST]` filename → enrolls.
- Browser `(1)`-suffixed filename → still parses and enrolls.
- Silent `msiexec /i ... SERVER_URL=... ENROLLMENT_KEY=... /qn` → property fallback enrolls.
- Renamed file with no token and no properties → no crash; logged "no enrollment input" outcome;
  MSI install still completes (does not 1603 the whole install — see risks).

## Risks & mitigations

- **Filename survival:** double-click and mainstream browsers preserve `[TOKEN@HOST]`; brackets,
  `@`, dots, and spaces are all legal in Windows filenames and the regex matches the bracket
  group anywhere in the name (so the `(1)` suffix is fine). Mass-deploy tooling that renames the
  file must use the property fallback — documented and supported.
- **`OriginalDatabase` timing:** the launched path is only valid in an immediate CA before
  caching — verified on the test VM before shipping. If capture fails, the agent falls back to
  the `BOOTSTRAP_TOKEN` property (when supplied).
- **Install rollback on enrollment failure (#411):** `<ServiceInstall Vital="yes">` +
  `ServiceControl Start` makes a failed enrollment roll back the whole install with 1603. The
  `BootstrapEnroll` CA must fail soft (log and continue) when there is genuinely no enrollment
  input, so a token-less manual install still produces an installed-but-unenrolled agent rather
  than a 1603. Enrollment failure with a *present-but-bad* token is a real error and may fail the
  install (matches current behavior). This boundary is decided during implementation and covered
  by the manual matrix above.
- **Cross-region:** EU / US / self-host each serve their own static signed MSI; the `HOST` in the
  token disambiguates which `apiHost` the agent redeems against.
- **Token expiry race:** mitigated by the existing fresh-TTL-on-redeem behavior in
  `redeemBootstrapToken()` — the child key TTL starts at redemption, not at download.

## Rollout

- Ship behind the existing release flow; no new env vars required on droplets (the change removes
  env vars rather than adding them).
- Old per-customer MSIs already in the wild keep working — they carry baked-in enrollment and
  never call the bootstrap endpoint.
- Decommission the signing VM + Cloudflare tunnel only after a release has verified the static
  MSI path in EU and US.
