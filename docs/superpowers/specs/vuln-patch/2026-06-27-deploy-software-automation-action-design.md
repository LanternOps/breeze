# Software Deployment automation action — design

**Issue:** [#1981](https://github.com/LanternOps/breeze/issues/1981) — `[Automations] Add "Software Deployment" as an automation action type`
**Origin:** Feature request from @win-wxx on the #1854 Configuration Policy umbrella issue: *"could you please also consider adding Software Deployment as an automation action type? That would be incredibly useful for our MSP workflows."*
**Date:** 2026-06-27

## Problem

Automations (Configuration Policy → automation feature, and standalone automations) support four action types today — `run_script`, `execute_command`, `send_notification`, `create_alert` — driven by `schedule` and `event` (e.g. device-online) triggers. There is no way to install software from an automation, even though Breeze already has a complete software-deployment subsystem. MSPs want "keep these apps current on these devices" as a scheduled automation.

## Key finding: reuse, don't build

Breeze already has the full deployment path:

- `softwareCatalog` → `softwareVersions` (download URL, checksum, `silentInstallArgs`, `supportedOs`, `isLatest`) → `softwareDeployments` → `deploymentResults` (per-device status: pending/downloading/installing/completed/failed).
- The agent already accepts a `software_install` command over WebSocket.
- `POST /deployments` (`routes/software.ts`) resolves targets, creates records, and dispatches the command.
- `software_inventory` (`deviceId`, `catalogId`, `version`) records what's installed per device.

So this feature is **a new automation action that drives the existing deployment path** — not new deployment infrastructure.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Version semantics | **Latest of a catalog entry** — resolve `isLatest` at run time | Fits MSP "keep Chrome/Zoom current" scheduled workflow; pairs naturally with skip-if-current |
| Result tracking | **Create real `softwareDeployments` + `deploymentResults` rows** | Appears in the existing Software Deployments UI with live status; reuses all read-back |
| Idempotency | **Skip if already current** — deploy only to devices missing/older than latest | Safe to run nightly; no redundant reinstalls |

## Action shape — no new tables

A fifth action type in the automation `actions[]` JSONB, referencing a catalog entry the same way `run_script` references a `scriptId`:

```ts
{ type: 'deploy_software', catalogId: string }   // semantics: "ensure latest installed"
```

No `softwareVersionId` pinning, no force-reinstall flag — minimal by the decisions above. Reuses all existing software tables and the agent `software_install` command.

## Execution flow

Implemented in `apps/api/src/services/automationRuntime.ts`, alongside the existing action handlers and pre-fetch maps.

**Pre-fetch (batch, mirrors `scriptsById`):** collect every `catalogId` referenced by `deploy_software` actions in the run; batch-resolve the current `isLatest` `softwareVersions` row plus catalog name into a `latestVersionByCatalogId` Map. Catalogs with no latest version are recorded as resolution failures.

**Per device** (inside the existing `runWithConcurrency(deviceRows, 5, …)`), for each `deploy_software` action:

1. **OS gate** — if `device.osType` ∉ `version.supportedOs`, log `unsupported OS` and skip the device for this action.
2. **Skip-if-current** — look up `software_inventory` for `(deviceId, catalogId)`. If an installed `version >= latest`, log `already current` and skip. If no inventory row, or the installed version is unknown/unparseable, treat as **not current → deploy** (safe default: ensures latest gets installed).
3. Otherwise the device is a deploy target for this action.

**Create real records + dispatch:** for the deploy-target devices of each `deploy_software` action, call the new `createSoftwareDeployment()` service (see refactor below) once per action: it inserts one `softwareDeployments` row (`deploymentType:'install'`, `scheduleType:'immediate'`, `targetType:'devices'`, `targetIds` = resolved device ids, `createdBy` = system/automation marker), inserts `deploymentResults` per device (status `pending`), and dispatches the `software_install` command to each device's agent. Status read-back flows through the existing `deploymentResults` path and Software Deployments UI.

**Run logging:** each device gets an `automation_runs.logs` entry per action — one of `deployed`, `already current`, `unsupported OS`, or `failed` (with reason). These roll into `devicesSucceeded` / `devicesFailed` on the run, consistent with the other action types. `onFailure` policy (`stop`/`continue`) is respected exactly as for other actions.

## Targeted refactor

The deployment-create + agent-dispatch logic is currently inline in the `POST /deployments` route handler (`apps/api/src/routes/software.ts`, ~lines 1021–1189). Extract it into a reusable service function:

```ts
// apps/api/src/services/softwareDeployment.ts (new or existing service module)
createSoftwareDeployment(input: {
  orgId, softwareVersionId, deploymentType, deviceIds,
  scheduleType, createdBy, options?
}): Promise<{ deploymentId: string; results: DeploymentResultRow[] }>
```

Both the route and the automation action call this single path, so checksum handling, `deploymentResults` creation, and `software_install` dispatch are not duplicated. This is the one piece of "improve the code we're touching" included in scope; no unrelated refactoring.

## Tenancy / RLS

- `softwareDeployments.orgId` = the run's org. Both standalone automations and config policies are org-scoped, so a single automation run targets devices in exactly one org — no cross-org grouping needed.
- `automation_runs.config_policy_id` = the **resolved policy id**, never the feature-link id — the #1855 tenant-key contract. The worker runs under `withSystemDbAccessContext`, so writes succeed and org-scoped readers can still see the rows via the RLS EXISTS-join.
- `software_inventory` reads are org-scoped; under system context in the worker they resolve correctly.

## Validation + frontend

- **Zod:** extend the automation action validator (`packages/shared/src/validators`) with the `deploy_software` variant: `{ type: 'deploy_software', catalogId: z.string().uuid() }`. Applies to both standalone automation actions and config-policy automation `inlineSettings`.
- **Frontend:** in the automation feature tab's action editor (`apps/web/src/components/configurationPolicies/featureTabs/` and the standalone automation editor), add a "Deploy Software" action type with a **catalog picker** (reuse the existing `softwareCatalog` list endpoint) and helper text: *"Installs the latest version of the selected software; skips devices that already have it."*

## Error handling / edge cases

| Case | Behavior |
|---|---|
| Catalog entry has no `isLatest` version | Action fails for all devices with a clear log line; respects `onFailure` |
| Device OS not in `supportedOs` | Skip device for that action, log `unsupported OS` (not a failure) |
| Installed version unknown/unparseable | Treat as not-current → deploy (safe default) |
| Device offline / no live agent | Same behavior as the manual `POST /deployments` path (deploymentResult stays `pending`; no special queueing added here) |
| Version comparison | Prefer `catalogId`-matched inventory row; best-effort semantic version comparator; ties/unknown → deploy |

## Testing

- `automationRuntime` unit tests for the new handler: deploy path, skip-if-current, unsupported-OS skip, missing-latest failure, mixed-device run counts.
- Validator test for the `deploy_software` action shape.
- Run-recording test asserting `automation_runs.config_policy_id` is the policy id (not feature-link id) and `softwareDeployments`/`deploymentResults` rows are created with the right org.
- Mirror existing `automationRuntime` test patterns (Drizzle mocks, pre-fetch maps).

## Out of scope (YAGNI — note as future)

- Uninstall / update-specific action variants (this action is install-or-update-to-latest).
- Pinned exact-version mode and a force-reinstall toggle.
- Package-manager-by-name installs (winget/choco direct) — bypasses catalog/checksum/inventory.
- Offline-device install queueing beyond the existing manual-deploy behavior.

## Files touched (anticipated)

| File | Change |
|---|---|
| `apps/api/src/services/automationRuntime.ts` | New `deploy_software` handler + pre-fetch map + dispatch in `executeAction` |
| `apps/api/src/services/softwareDeployment.ts` | New `createSoftwareDeployment()` service (extracted) |
| `apps/api/src/routes/software.ts` | `POST /deployments` calls the extracted service |
| `packages/shared/src/validators/index.ts` | `deploy_software` action validator |
| `apps/web/src/components/configurationPolicies/featureTabs/` (+ standalone automation editor) | "Deploy Software" action UI with catalog picker |
| Co-located `*.test.ts` | Handler, validator, and run-recording tests |
