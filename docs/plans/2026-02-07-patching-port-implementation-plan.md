# Device Patching Port Plan (apps/agent -> agent)

Date: 2026-02-07
Owner: Codex
Primary target: `/agent` (production agent)

## Goal
Implement full patching execution in the primary Go agent and wire end-to-end API workflows for macOS, Windows, and Linux.

## Current baseline
- API has patch schemas and catalog/compliance/approval routes.
- Legacy primary agent (`/agent`) reports patch inventory but does not execute install/rollback commands.
- Partial patching implementation exists in `/apps/agent/internal/patching` but is not wired to runtime command handling.

## Scope
1. Port patching provider/manager framework from `/apps/agent/internal/patching` into `/agent/internal/patching`.
2. Add patch command handling in `/agent` (`patch_scan`, `install_patches`, `rollback_patches`).
3. Keep inventory ingestion payload compatibility with `/api/v1/agents/:id/patches`.
4. Implement real scan dispatch in API (`POST /api/v1/patches/scan`).
5. Improve deployment patch command payloads to include installable metadata.
6. Preserve backward compatibility for existing command types and payloads.

## Architecture decisions
- `/agent` becomes the single implementation target for patch execution.
- Patch IDs for execution are provider-scoped where possible: `<provider>:<providerSpecificId>`.
- API continues to store patch UUIDs but passes provider metadata for install execution.
- Command result remains compatible with existing `commandResultSchema` (`status`, `exitCode`, `stdout`, `stderr`, `durationMs`, `error`).

## Work plan

### Phase 0: Contract alignment
- Add new command constants in primary agent tools:
  - `patch_scan`
  - `install_patches`
  - `rollback_patches`
  - compatibility aliases (`run_script`, etc.) where needed.
- Define patch command payload contract:
  - `patch_scan`: `{ source?: string }`
  - `install_patches`: `{ patchIds?: string[], patches?: PatchRef[] }`
  - `rollback_patches`: `{ patchIds?: string[], patches?: PatchRef[] }`

### Phase 1: Port patching core to `/agent`
- Create `/agent/internal/patching`:
  - `types.go`
  - `manager.go`
  - `windows.go` (Windows Update)
  - `chocolatey.go` (Windows packages)
  - `homebrew.go` (macOS third-party)
  - `apt.go` (Debian/Ubuntu)
- Add Linux yum/dnf provider and macOS Apple softwareupdate provider for parity with existing collector behavior.
- Add build-tagged default provider wiring (`defaults_*.go`).

### Phase 2: Integrate patch manager into heartbeat and inventory
- Add `patchMgr` to `Heartbeat` and instantiate default provider set.
- Refactor patch inventory sender to read available + installed patches from manager.
- Keep existing payload keys consumed by API ingestion route.

### Phase 3: Add patch command execution in `/agent`
- Implement command handlers in `executeCommand` for:
  - scan trigger
  - install patches
  - rollback/uninstall patches
- Return structured JSON in `stdout` with summary counts + per-item status.
- Ensure `durationMs` always set for result schema compatibility.

### Phase 4: API wiring and dispatch
- Implement real queueing in `POST /patches/scan`.
- Enforce access filtering for target devices by auth scope/org access.
- Update deployment worker patch execution to pass patch metadata (`source`, `externalId`, `title`) to agent command payload.
- Improve deployment worker success logic to infer from command status/result fields robustly.

### Phase 5: Compliance/report and workflow hardening
- Apply `source`/`severity` filters in compliance query.
- Replace compliance report TODO with queued job placeholder wired to command queue or report job system.
- Add route(s) for per-device patch install/rollback if required by UI/API contract.

### Phase 6: Validation
- Agent unit tests for manager routing and patch command handlers.
- API tests for `/patches/scan` dispatch, deployment patch payload construction, and compliance filters.
- Build/test:
  - `cd agent && go test ./...`
  - `cd apps/api && pnpm test:run`

## Parallelization strategy
- Track A (Agent core): port providers + manager + heartbeat command handlers.
- Track B (API patch routes): scan dispatch, compliance filtering, result interpretation.
- Track C (Deployment worker): patch payload mapping and completion semantics.
- Run Track A/B/C in parallel where files do not overlap.

## Risks
- Provider commands require elevated privileges on endpoints.
- Windows/macOS/Linux package manager output formats vary.
- Existing deployment worker currently relies on weak result parsing.

## Rollout strategy
1. Merge behind feature flag if needed (`enablePatchCommands`).
2. Enable for test orgs first.
3. Verify per-OS install + rollback in staging.
4. Enable globally.

## Done criteria
- Patch scan endpoint dispatches real commands.
- Agent executes install and rollback commands on all supported OS providers.
- Device patch/job state updates flow through API and can be observed via existing routes.
- No regressions to existing remote tools and script execution behavior.
