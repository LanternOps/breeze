# Software Deployment Visibility — fix the status pipeline + wire the Deployments UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make software deployments observable end-to-end. Today the deploy wizard is write-only: it POSTs a deployment, shows a raw UUID, and there is no page anywhere that shows what happened. Worse, the underlying status data lies — scheduled deployments never dispatch, offline devices are counted as dispatched, and stuck rows stay `pending` forever. This plan fixes the pipeline so the data is trustworthy, then wires the (currently mock-data) `DeploymentList` / `DeploymentProgress` components into a real Deployments tab on the Software Library page.

**Architecture decision — fix System A in place; do NOT converge on System B.** The repo has two unrelated deployment systems:

- **System A** (`software_deployments` + `deployment_results`, `apps/api/src/routes/software.ts`, `services/softwareDeployment.ts`) — what the wizard, the agent handler (`agent/internal/remote/tools/software_install.go`), and result ingestion (`routes/agents/commands.ts:174-222`) actually use.
- **System B** (`deployments` + `deployment_devices`, `routes/deployments.ts`, `jobs/deploymentWorker.ts`) — a mature generic engine (batched rollout, pause/resume, retry, timeout reaping, notifications) with almost no UI and no connection to the wizard.

Converging the wizard onto System B means rewriting its create path, migrating data, and reconciling two result-ingestion formats — an epic, not a wiring job. Instead this plan **borrows System B's proven patterns** (stale reaper at `jobs/staleCommandReaper.ts:462-509`, maintenance-window gating at `jobs/deploymentWorker.ts:668-694`, repeatable-job registration at `staleCommandReaper.ts:838-851`) and applies them to System A. Convergence stays a future discussion.

**Tech stack:** Existing only — Hono routes, Drizzle, BullMQ repeatable jobs, React islands, Vitest (+ Drizzle mocks per `breeze-testing`), Playwright for e2e. Two small idempotent SQL migrations (new columns on existing tables — no new tables, so **no RLS or cascade-registration work**; both tables are already covered).

**Related issues:** #2866 (bulk-selection loss into the wizard — PR 3 touches the same files, coordinate or land it alongside).

**Out of scope:**
- System B convergence (future discussion doc, not this plan)
- Implementing `uninstall` / `update` deployment types — they are **rejected at create** instead of silently accepted (today they insert rows that sit `pending` forever)
- Agent-side cancel of an in-flight install (killing an MSI mid-write is worse than letting it finish; cancel = "don't start what hasn't started")
- Agent download/install progress percentage (PR 4 sketches phase reporting as an optional follow-up; PRs 1–3 stand alone without it)

---

## Background: the four findings this plan fixes

1. **Dispatch is fire-and-forget.** `services/softwareDeployment.ts:310-311` calls `sendCommandToAgent(...)` and discards the boolean; when the agent has no live WS socket it returns `false` and queues **nothing** — yet the device is still pushed to `dispatchedDeviceIds`. The row stays `pending` forever.
2. **Only `immediate` + `install` ever dispatches.** The gate at `softwareDeployment.ts:129` means `scheduled` / `maintenance_window` deployments (and all `uninstall`/`update`) insert rows and permanently sit `pending`. No worker consumes `scheduledAt`.
3. **No stuck detection.** `jobs/staleCommandReaper.ts` reaps System B's `deployment_devices` but not `deployment_results`. A device that dies mid-install leaves the aggregate status `in_progress` indefinitely. (Agent-side ceilings: 15 min download + 30 min install, `agent/internal/remote/tools/software_install.go:22-26` — with no server-side counterpart.)
4. **Zero UI.** `GET /software/deployments`, `/:id`, `/:id/results`, `/:id/cancel` have no callers in the web app. `DeploymentList.tsx` and `DeploymentProgress.tsx` are 100% hardcoded mock data, exported from the barrel and imported by no page. The wizard's success card (`DeploymentWizard.tsx:638-668`) dead-ends on a UUID.

Also being fixed along the way: `retryCount` on `deployment_results` exists but nothing writes it; cancel (`software.ts:1406-1444`) only flips `pending`→`cancelled` in the DB; list pagination happens in JS after a full-org fetch (`software.ts:1073-1085`); `POST /software/deploy` (L1174-1375) is a drifting duplicate of `createSoftwareDeployment`; the WS orphan-result path (`routes/agentWs.ts` `processOrphanedCommandResult`) has no `sw-install` branch, so a lost HTTP result POST strands the row.

---

## PR 1 — Backend correctness: honest dispatch, scheduler, reaper, retry

The UI is pointless if the rows lie, so this lands first.

### 1.1 Migrations (two idempotent files)

- [x] `apps/api/migrations/2026-XX-XX-software-deployments-dispatched-at.sql`
  - `ALTER TABLE software_deployments ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;`
  - Backfill for shipped rows: `UPDATE software_deployments SET dispatched_at = created_at WHERE schedule_type = 'immediate' AND dispatched_at IS NULL;` (wrapped in the `DO $$ ... GET DIAGNOSTICS ... RAISE WARNING` row-count pattern per CLAUDE.md).
  - Purpose: idempotent claim marker so the scheduler can `UPDATE ... SET dispatched_at = now() WHERE id = $1 AND dispatched_at IS NULL RETURNING id` and never double-dispatch across API instances.
- [x] `apps/api/migrations/2026-XX-XX-deployment-results-device-command-id.sql`
  - `ALTER TABLE deployment_results ADD COLUMN IF NOT EXISTS device_command_id uuid;` (nullable, no FK to keep the agent hot path unconstrained — `device_commands` is intentionally RLS-free/system-scoped).
  - Purpose: links a result row to the queued `device_commands` row when the offline fallback (1.2) is used, enabling result reconciliation, cancel purge (PR 2), and "queued — device offline" display (PR 3).
- [x] Mirror both columns in `apps/api/src/db/schema/software.ts`; run `pnpm db:check-drift`.
- [x] No RLS/cascade work: no new tables. Confirm `rls-coverage` and `tenantCascade` suites still pass untouched.

### 1.2 Honest dispatch with offline queueing

- [x] Extract the per-device dispatch loop (`softwareDeployment.ts:253-312`) into a shared `dispatchSoftwareInstallToDevice(deployment, device, command)` helper (same file) so the scheduler (1.3) and retry (1.5) reuse it — including variable resolution, EDR resolution, and the failure pre-writes, which already work well.
- [x] In the helper: try `sendCommandToAgent(device.agentId, command)`. On `false`, fall back to `queueCommand(device.id, 'software_install', payload, createdBy)` (`services/commandQueue.ts:454`) — this writes a `device_commands` row that the agent claims on its next poll/reconnect. Store the returned UUID in `deployment_results.device_command_id` for that row.
  - The queued payload must carry `deploymentId` and the same fields as the WS command payload (`softwareDeployment.ts:296-308`); the agent handler (`handlers_software_install.go`) dispatches on command `type`, so both transports hit the same code.
- [x] Set `software_deployments.dispatched_at = now()` when the immediate path runs.
- [x] **Result reconciliation for the queued path.** Queued commands report results with their UUID id, which flows through the UUID branch of `routes/agents/commands.ts` (L239+) into `device_commands` — but nothing updates `deployment_results`. After the existing `device_commands` update, add: if `command.type === 'software_install'` and `command.payload.deploymentId` is set, apply the same status mapping as the `sw-install-` branch (L184-219: exit-code check, redaction, `status='pending'` guard) to the matching `deployment_results` row. Extract that mapping into a small shared helper rather than duplicating it.
- [x] **WS orphan-result branch.** Add a `sw-install-` branch to `processOrphanedCommandResult` (`routes/agentWs.ts:1050+`) mirroring the `commands.ts` regex handler, so a result that arrives over WS still lands if the agent's HTTP POST goroutine (`heartbeat.go:4075-4081`) fails. The `status='pending'` guard makes double-delivery a no-op.

### 1.3 Scheduler for `scheduled` and `maintenance_window` deployments

- [x] New `apps/api/src/jobs/softwareDeploymentScheduler.ts`, BullMQ repeatable job every 60s (registration pattern: `staleCommandReaper.ts:838-851` — remove existing repeatables first, then `repeat: { every: ... }`). Register wherever the reaper is registered at boot.
- [x] Each tick, under `withSystemDbAccessContext`:
  - Select `software_deployments` where `dispatched_at IS NULL` and (`schedule_type = 'scheduled' AND scheduled_at <= now()`, or `schedule_type = 'maintenance_window'` and the linked window is currently open — copy the window-evaluation logic from `jobs/deploymentWorker.ts:668-694`).
  - Claim each via the `dispatched_at IS NULL` conditional update; skip rows another instance claimed.
  - Run the shared dispatch helper for each pending result row of the claimed deployment.
- [x] Worker-created writes stay System A (`deployment_results`) — no new tables, no new tenancy questions.

### 1.4 Reject what never runs

- [x] In the create route + shared Zod validator (`POST /software/deployments`, `software.ts:1095-1172`, and `packages/shared` validator if the schema lives there): reject `deploymentType: 'uninstall' | 'update'` with a 400 and a clear "not yet supported" message. Accepted-then-ignored is the current behavior and the worst option.
- [x] Require `maintenanceWindowId` when `scheduleType = 'maintenance_window'`, and `scheduledAt` (in the future) when `scheduleType = 'scheduled'`.

### 1.5 Stale reaper for `deployment_results`

- [x] Add `reapStaleSoftwareDeploymentResults()` to `jobs/staleCommandReaper.ts`, called from the same tick as the System B reaper (`:462-509`, use it as the template). Two tiers:
  - **Delivered but silent:** result rows `pending` whose command was actually delivered (WS-dispatched, or `device_command_id` row in status `sent`/`completed`) and whose deployment `dispatched_at` is older than `SOFTWARE_INSTALL_TIMEOUT_MS` (55 min — above the agent's 15 min download + 30 min install ceilings) → `failed`, `errorMessage: 'Server-side timeout: no response from agent'`.
  - **Queued, never delivered** (offline device, `device_commands` row still `pending`): leave alone until `SOFTWARE_QUEUED_EXPIRY_MS` (7 days), then → `failed`, `'Device did not come online before the deployment expired'`, and mark the linked `device_commands` row `cancelled` so it can't fire later.
- [x] Export both constants for tests.

### 1.6 Retry endpoint

- [x] `POST /software/deployments/:id/retry` in `routes/software.ts`. Optional body `{ deviceIds?: string[] }` to retry a subset; default = all `failed` rows.
- [x] For each targeted `failed` row: reset `status='pending'`, increment `retryCount`, null out `startedAt/completedAt/exitCode/output/errorMessage/device_command_id`, then re-dispatch via the shared helper. Return `{ retriedDeviceIds, skippedDeviceIds }`.
- [x] Audit as `software.deployment.retry` (alongside the existing `.create` at `software.ts:1159` and `.cancel` at `:1434`).

### 1.7 Tests (PR 1)

- [x] `services/softwareDeployment.test.ts`: offline fallback queues a `device_commands` row + records `device_command_id`; WS-success path does not queue; `dispatched_at` set.
- [x] `routes/agents/commands.test.ts`: queued-path result updates both `device_commands` and `deployment_results`; second result is a no-op (pending guard); shared mapping helper covered for exit-code → failed.
- [x] `jobs/softwareDeploymentScheduler.test.ts`: due `scheduled` row dispatches once (claim races: second claim no-ops); future `scheduledAt` untouched; closed maintenance window untouched, open window dispatches.
- [x] `jobs/staleCommandReaper.test.ts`: both reap tiers, constants respected, System B reaping unaffected.
- [x] Route tests: create rejects `uninstall`/`update` and bad schedule combos; retry resets rows, increments `retryCount`, skips non-failed rows.
- [x] `autoMigrate.test.ts` ordering still green; `pnpm db:check-drift` clean.

---

## PR 2 — API polish: results enrichment, real pagination, honest cancel, dedupe

- [x] **Results endpoint** (`GET /software/deployments/:id/results`, `software.ts:1447-1468`): join `devices` for `hostname` (the UI must not render UUIDs or do N+1 fetches); add `?status=` filter and limit/offset pagination in SQL. Include a derived `queuedOffline: boolean` (result `pending` + linked `device_commands` row still `pending`) so the UI can show "queued — device offline" instead of a misleading spinner.
- [x] **List endpoint** (`GET /software/deployments`, `software.ts:1060-1092`): move pagination into SQL with a total count (today it fetches every org row then `.slice()`s); extend `getDeploymentStatusMap` (`:194-225`) to also return per-status counts per deployment (`{ pending, inProgress, completed, failed, cancelled }`) so list progress bars are one fetch.
- [x] **Summary endpoint** `GET /software/deployments/summary`: counts by aggregate status (active, scheduled, completed last 7d, failed last 7d) for the overview cards. Cheap: one grouped query over deployments + results.
- [x] **Honest cancel** (`POST /:id/cancel`, `software.ts:1406-1444`): in addition to flipping `pending` results → `cancelled`, mark linked not-yet-delivered `device_commands` rows (via `device_command_id`, status still `pending`) as `cancelled` so a cancelled deployment can't execute when an offline agent reconnects. In-flight installs are left to finish (see out-of-scope) — their results still land via the pending-guard (already `cancelled`, so the update no-ops; acceptable).
- [x] **Dedupe legacy route**: collapse `POST /software/deploy` (`software.ts:1174-1375`) into a thin wrapper over `createSoftwareDeployment` — it has already drifted (hardcodes `forceReinstall: false`, `deploymentType: 'install'`). Preserve the existing response shape.
- [x] Tests: results join/filter/pagination; list SQL pagination + counts; summary; cancel purges queued commands but not delivered ones; legacy route parity (same effects as canonical route for the same input).

---

## PR 3 — UI: Deployments tab on Software Library

Placement decision: a **"Deployments" tab on `/software`** (the Software Library / `SoftwareCatalog` page) rather than a new sidebar entry — it's where the user already is when the wizard finishes. Tab + selection state via `window.location.hash` per the repo convention (`#deployments`, `#deployment=<id>`) — **not** query params.

- [x] **Tab shell** in `SoftwareCatalog.tsx` (or a thin wrapper page component): `Catalog` | `Deployments`, hash-driven, catalog remains the default.
- [x] **Overview cards** at the top of the tab from `GET /software/deployments/summary`: In progress / Scheduled / Completed (7d) / Failed (7d).
- [x] **Rewire `DeploymentList.tsx`**: delete the mock array (L69-120); fetch `GET /software/deployments` with server pagination; status/type filters map to the computed aggregate statuses; progress bar from the per-status counts; row click sets `#deployment=<id>`. **Fix the two i18n bugs** (L323, L351): status is compared against *translated* strings (`item.status === i18n.t(...)`), so the progress bar and Cancel button never render — compare against canonical status constants and translate only for display.
- [x] **Rewire `DeploymentProgress.tsx`**: take `deploymentId`; fetch `GET /:id` + `/:id/results` (hostnames now included); per-device table with status, started/completed, exit code, error message, and "queued — device offline" for `queuedOffline` rows; poll every 5s while the aggregate is `pending`/`in_progress` and stop on terminal states; replace the decorative "Live updates enabled" pill with an honest auto-refresh indicator. Wire **Retry failed** → `POST /:id/retry` and **Cancel** → `POST /:id/cancel`.
- [x] **`runAction` everywhere**: retry and cancel go through `runAction` (`apps/web/src/lib/runAction.ts`) with the standard catch pattern; keep `no-silent-mutations.test.ts` green (no allowlist entries expected — these are simple mutations).
- [x] **Close the wizard loop**: the success card (`DeploymentWizard.tsx:638-668`) gets a "View deployment" button → `/software#deployment=<id>` replacing the bare UUID dead-end.
- [x] **#2866 tie-in**: this PR touches `SoftwareCatalog.tsx` and `DeploymentWizard.tsx`; implement (or rebase onto) the `initialDeviceIds` preselect fix so hash parsing for `#deploy=<ids>` and `#deployment=<id>` is designed once, coherently.
- [x] `data-testid` attributes on tab, cards, list rows, progress table, retry/cancel buttons (e2e convention).
- [x] i18n: all new strings through the existing i18n setup; no raw literals.
- [x] Tests: component tests for `DeploymentList` (fetch, filters, progress bar renders for in-progress status — regression for the i18n bug) and `DeploymentProgress` (polling starts/stops on terminal status, retry/cancel invoke `runAction`, offline-queued row rendering); wizard success-card link test alongside `DeploymentWizard.preselect.test.tsx`.
- [x] Optional e2e: `e2e-tests/tests/software-deployments.spec.ts` — create → tab shows deployment → detail shows per-device rows.

---

## PR 4 (optional follow-up) — Progress fidelity + failure surfacing

Not required for the plan to deliver value; sketched so it isn't lost.

- [ ] **Agent phase reporting**: emit `software_install_progress` WS messages (phases `downloading` → `installing`, optional download %) from `software_install.go`, following the existing `backup_progress` pattern (`routes/agentWs.ts:2453-2481` server-side). Server writes interim `deployment_results.status` transitions (`pending` → `downloading` → `installing`), finally using the dead enum values in `deploymentStatusEnum` (`db/schema/deployments.ts:15-26`). Guarded updates so a terminal status never regresses. Old agents that never send phases keep working (binary pending → terminal).
- [ ] **Failure surfacing**: on a deployment reaching `failed` / `completed_with_errors`, raise an alert/notification (template: System B's `sendDeploymentPausedNotifications`, `jobs/deploymentWorker.ts:50+`) and write device event-log entries. Today a failed deployment produces no signal anywhere.
- [ ] UI: phase text + download % in `DeploymentProgress`.

---

## Verification checklist (whole plan)

- [ ] `pnpm test --filter=@breeze/api` and `--filter=@breeze/web` green
- [ ] `pnpm db:check-drift` clean after migrations
- [ ] Manual: deploy to an **online** device → tab shows in-progress → completed with exit code
- [ ] Manual: deploy to an **offline** device → row shows "queued — device offline"; start the agent → install runs → row completes
- [ ] Manual: scheduled deployment with `scheduledAt` 2 min out → dispatches within ~1 min of the mark
- [ ] Manual: kill the agent mid-install → row flips to failed with server-side-timeout after the reaper window
- [ ] Manual: cancel a deployment with queued-offline rows → agent reconnect does NOT install
- [ ] Retry on a failed row re-dispatches and increments `retryCount`
