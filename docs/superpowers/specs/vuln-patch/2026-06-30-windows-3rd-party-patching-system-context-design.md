# Windows Third-Party Patching — SYSTEM-Context winget Engine (Design)

**Date:** 2026-06-30
**Status:** Approved design, pre-implementation
**Owner:** Todd Hebebrand

## Problem

Windows third-party patching (Chrome, Firefox, Zoom, Acrobat, etc.) is fully
built end-to-end — DB model, API routes, approval rings, `patchJobExecutor`,
compliance, and web UI — but the **agent execution engine at the bottom is
effectively unusable** for an MSP fleet.

Today the agent runs as **SYSTEM**, then deliberately dispatches every winget
command over IPC to the **non-elevated user helper** running in a logged-in
user's session (`agent/internal/patching/winget.go`, registered at
`agent/internal/heartbeat/heartbeat.go:549-556`, executed via
`makeUserExecFunc` → session broker → `userhelper.executeProcess`,
`agent/internal/userhelper/client.go:759`).

Consequences of that design:

- **No logged-in user → no patching.** `Scan()` returns empty, `Install()`
  errors with "requires a connected user helper session" (`winget.go:69,93`).
  Headless servers and locked-at-login machines get nothing.
- **Non-elevated.** The helper is spawned with the user's filtered token via
  `CreateProcessAsUser` (`agent/internal/sessionbroker/spawner_windows.go`), so
  machine-wide app installs (writing to `Program Files`) fail — even with a user
  logged in — while `winget upgrade` still *lists* them, producing "pending"
  patches whose installs silently fail.
- **Per-user scope only where it works at all.** A user session sees only that
  user's per-profile installs plus machine-wide apps; other users' per-profile
  apps are invisible.

Net: we can reliably patch only the currently-logged-in user's per-user apps,
non-elevated. That is not a fleet patching solution.

## Goal

Invert the design to **SYSTEM-first**. The always-running, elevated SYSTEM agent
becomes the patch engine, running winget directly against **machine scope**, with
**no dependency on a logged-in user**. This matches how mainstream RMMs
(Action1, NinjaOne, PDQ, ManageEngine) do third-party patching.

### In scope (v1)

- Machine-scope (`--scope machine`) third-party patching on Windows, executed by
  the SYSTEM agent, no login required.
- Bootstrapping winget itself onto devices where the App Installer package is
  absent (notably Windows Server 2019/2022).
- Retiring the user-helper winget path so exactly one winget provider is active.

### Out of scope (v1)

- **Per-user app patching.** Machine-scope only. Per-user installs are reported
  but not auto-patched. Revisit later only if clients demand it.
- **Fallback installer engine (approach C — Breeze-hosted installer repo).** The
  devices where winget bootstrap fails (Server Core, hardened/air-gapped boxes)
  have no third-party desktop apps to patch anyway, so skip-and-report is
  sufficient. C is a possible later phase, not v1.
- **API / DB / web changes.** Source stays `third_party`; everything above the
  agent works unchanged. Optional per-device "engine status" telemetry is a
  phase-2 nicety, noted below but not built in v1.

## Non-Goals / Constraints

- **Chocolatey** stays exactly as-is (registered if `choco` on PATH). Not touched.
- **Supply-chain hardening:** any downloaded bootstrap artifact MUST be pinned to
  a specific version and SHA-256 verified against the signed Breeze release
  manifest before use. No unpinned runtime fetches. (Fits the existing
  `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` / signed-manifest infra and
  `check-supply-chain-hardening.sh`.)
- **No new deployed binary.** The work lands inside the existing Go agent.
- **No new required endpoint egress** on customer machines: bootstrap artifacts
  are served from the Breeze API (the channel the agent already reaches), not
  from github.com / aka.ms / nuget.org.

## Architecture Decision: build into the agent

winget.exe *is* the external engine; our code orchestrates it. The agent already
provides SYSTEM context, always-on execution, the `PatchProvider` architecture,
subprocess exec with timeouts, artifact download, and the full
scan → report → job → install → report flow. A separate binary would only
re-introduce a second artifact to deploy/sign/update plus IPC — the exact
complexity we are removing.

Two new units under `agent/internal/patching/`:

1. `winget_bootstrap_windows.go` — **ensure-winget** (detect + provision).
2. `winget_system.go` — **SYSTEM-context winget provider** (scan / install /
   uninstall against machine scope).

Shared, context-free helpers (table-output parsers, HRESULT/reboot mapping)
currently in `winget.go` are refactored into a shared file
(`winget_parse.go`) reused by both the retiring user-helper provider (until
removed) and the new SYSTEM provider.

## Component 1 — ensure-winget (`winget_bootstrap_windows.go`)

Runs as a **preflight** before every third-party scan; result cached with a TTL
and re-checked on version drift.

### Detect

- Resolve `winget.exe` by globbing
  `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe`
  (SYSTEM has no `winget` PATH alias; the versioned exe path is the supported
  SYSTEM entry point — confirmed by community/RMM practice).
- Pick the highest-version match. If present and version ≥ `minWingetVersion`,
  bootstrap is a no-op; return the resolved path.

### Provision (only when missing / below min)

- Fetch the pinned bootstrap artifact set from the **Breeze API** (see Component
  4): App Installer `.msixbundle`, dependency packages (`Microsoft.VCLibs`,
  `Microsoft.UI.Xaml`), and the App Installer **license XML**.
- Verify each artifact's SHA-256 against the signed manifest.
- Install machine-wide via
  `Add-AppxProvisionedPackage -Online -PackagePath <bundle> -DependencyPackagePath <dep>... -LicensePath <license.xml>`
  (PowerShell/DISM, SYSTEM context). The `-LicensePath` is required on Server
  2022, which has no Store to verify entitlement ("No applicable app licenses"
  error otherwise).
- Re-resolve the exe path; confirm `winget --version` runs.

### OS-aware behavior

| Target | Expected bootstrap |
|---|---|
| Win10 (1809+) / Win11 | Usually present; update only if below min |
| Windows Server 2025 | winget is a built-in system component (updated via Windows Update); usually present |
| Windows Server 2019 / 2022 | Full sideload (bundle + deps + license) |
| Server Core / hardened / no Appx stack | Provision fails → **skip-and-report** |

### Failure handling

On any bootstrap failure (missing Appx/DISM stack, blocked, provision error):
do **not** register the winget provider on this device; report engine status
`unavailable` with a reason. The device reports 0 third-party patches, which is
accurate. Never crash the patch flow.

## Component 2 — SYSTEM winget provider (`winget_system.go`)

Implements `PatchProvider` (`ID() == "winget"`, mapped to `third_party` by
`heartbeat.go:2082`). Execs the resolved `winget.exe` **directly in the SYSTEM
agent process** — no IPC, no session broker, no login.

- **Scan:**
  `winget upgrade --include-unknown --scope machine --source winget --accept-source-agreements --disable-interactivity`
- **Install:**
  `winget install --exact --id <id> --scope machine --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --source winget`
- **Uninstall:** analogous with `--scope machine`.
- **Source pinned to `winget`** (community) — **never `msstore`**, which requires
  user identity/entitlement and cannot run as SYSTEM.
- Reuses `winget_parse.go` for table parsing and `hresult.go` for exit-code /
  reboot-required interpretation.
- Package-ID validation (`validWingetPkgID`) preserved.
- Source health: if the `winget` source is stale/missing, run
  `winget source update` (or reset) before scan.

Machine-scope means per-user apps do not appear (accepted). Apps that winget only
offers user-scope will not surface under `--scope machine`; if one slips through
and a machine install is impossible, mark the result skipped with a reason rather
than failing the job.

## Component 3 — provider wiring (`defaults_windows.go` + heartbeat)

- In `NewDefaultManager` (or heartbeat init), run **ensure-winget**; on success
  register the **SYSTEM winget provider** as the default Windows third-party
  engine. Gate is bootstrap success, **not** `sessionBroker != nil`.
- **Retire** the user-helper winget registration at `heartbeat.go:549-556`.
  Exactly one winget provider is ever registered → no duplicate scans, no dedup
  logic. (`makeUserExecFunc` and the helper `executeProcess` path may remain for
  other uses but are no longer wired to patching.)
- Chocolatey registration unchanged.

## Component 4 — bootstrap artifact delivery (Breeze-mirrored)

- Breeze mirrors the Microsoft-published bundles (winget-cli GitHub release
  assets + VCLibs/UI.Xaml + license XML) as **pinned, versioned release
  artifacts** in the existing signed-manifest artifact system.
- Mirroring ≠ rebuilding: bundles remain Microsoft-signed; Breeze caches a pinned
  copy and serves it over the API the agent already trusts.
- The agent downloads them from the Breeze API on demand (Server 2019/2022 and
  edge cases only — a minority of the fleet), verifies SHA-256 against the
  manifest, then provisions.
- **Maintenance task:** a periodic "pull latest App Installer from MS → publish
  to Breeze artifacts" refresh (manual or scheduled). Version pin bumped
  deliberately, not "latest at runtime."

## Data Flow (v1, machine scope, no user required)

1. Patch-scan tick fires in the SYSTEM agent.
2. ensure-winget preflight: resolve or provision winget; cache result.
3. If unavailable → report engine status, emit 0 third-party patches, done.
4. SYSTEM winget provider `Scan()` → `winget upgrade --scope machine` → parsed
   `AvailablePatch`es, source `third_party`.
5. Existing ingestion (`routes/agents/patches.ts`), catalog enrichment, approval
   rings, `patchJobExecutor` — unchanged.
6. Approved patch → install command dispatched → SYSTEM winget provider
   `Install()` → `winget install --scope machine` elevated → result + reboot flag
   reported.

## Error Handling

- Bootstrap failure → skip-and-report `unavailable`; never break the scan loop.
- winget non-zero exit with empty stdout → error surfaced to the job result with
  stderr; HRESULT decoded where possible.
- Machine-scope-impossible package → `skipped` with reason, not job failure.
- Artifact SHA mismatch → abort provision, report `unavailable`, log a warning
  (supply-chain signal), do **not** install an unverified package.

## Testing

- **Table-driven Go unit tests** (CI-runnable, no Windows needed):
  - exe path resolution / highest-version selection (synthetic dir layouts)
  - OS-detection → bootstrap-action decision matrix
  - parser reuse (`winget_parse.go`) — migrate existing `winget_test.go` cases
  - command-string assembly (correct flags, `--scope machine`, `--source winget`)
- **Integration test** (`integration_windows_test.go` pattern): gated on
  admin + winget presence, graceful skip otherwise.
- **Live verification** on the Windows Test VM and a Server 2022 VM for the
  bootstrap path (via `make dev-push` + diagnostic logs).
- **Security review** (`security-review` skill): SYSTEM-context download +
  `Add-AppxProvisionedPackage` provisioning is privileged; verify SHA pinning,
  no unpinned fetch, no injection via package IDs.

## Rollout

- Gate behind the existing config-policy `patch` feature with
  `sources: ['third_party']`; add a staged feature flag so it can be enabled
  per-partner and rolled back without an agent release.
- Watch first cohort's engine-status + install-result telemetry before wider
  enablement.

## Open items for spec review

- Exact `minWingetVersion` floor and cache TTL for the preflight.
- Whether to ship the optional phase-2 per-device "engine status" surface in v1
  (recommended: emit the status field now, add UI later).
- Confirm the artifact-refresh cadence/owner for the MS bundle mirror.
