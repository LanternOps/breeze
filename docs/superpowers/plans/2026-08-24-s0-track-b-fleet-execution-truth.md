---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
---

# S0 Track B Fleet and Execution Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close RMM-QA-012, RMM-QA-039, RMM-QA-105, RMM-QA-212, RMM-QA-297, and RMM-QA-319 by replacing partial fleet selection, fabricated reachability, dispatch-as-success, and destructive partial inventory handling with server-authorized selection, explicit admission, durable terminal action state, and versioned observations.

**Architecture:** Ship four independently reversible slices: server-backed device options; reachability plus versioned self-health; script admission plus automation action terminality; and versioned software-inventory evidence plus evidence-gated vulnerability resolution. Additive schemas and tolerant readers land before agent producers. Hot agent-write child rows use short transactions with a `FOR KEY SHARE` device lock and never share a transaction with a `devices` update.

**Tech Stack:** TypeScript, Hono, Zod, Drizzle/PostgreSQL with forced RLS, Astro/React, Vitest, Go, BullMQ, and Breeze tenant cascade/export registries.

## Finding map and verified seams

| Finding | Verified implementation seams | Contract this plan closes |
|---|---|---|
| RMM-QA-012 | `apps/api/src/routes/devices/core.ts`; `apps/web/src/components/filters/DeviceTargetSelector.tsx`; the script, alert, remote, DR, patch, backup, ticket, baseline, and discovery consumers named in Task 3 | No selector may mistake a locally loaded prefix for the authorized fleet. |
| RMM-QA-039 | `apps/api/src/routes/agents/enrollment.ts`; `apps/api/src/routes/agents/heartbeat.ts`; `packages/shared/src/constants/index.ts` | Enrollment is pending and does not fabricate `lastSeenAt`; only an authenticated main heartbeat makes a device online. |
| RMM-QA-319 | `agent/internal/health/health.go`; `agent/internal/heartbeat/heartbeat.go`; `apps/api/src/routes/agents/schemas.ts`; `apps/api/src/routes/agents/heartbeat.ts` | Reachability and versioned self-health remain separate axes. |
| RMM-QA-212 | `apps/api/src/services/scriptExecution.ts`; `apps/api/src/routes/scripts.ts`; `apps/web/src/components/scripts/ScriptExecutionModal.tsx`; production callers in `routes/mobile.ts` and `routes/remediationSuggestions.ts` | Every distinct requested target receives an admission result; queued is never rendered as terminal success. |
| RMM-QA-105 | `apps/api/src/services/automationRuntime.ts`; `services/commandResultHandlers.ts`; HTTP/WS command-result seams; script/software result handlers and reapers | Script, command, and deployment dispatch remains nonterminal until durable result, cancellation, or timeout evidence arrives. |
| RMM-QA-297 | `apps/api/src/routes/agents/inventory.ts`; `apps/api/src/services/vulnerabilityCorrelation.ts`; Go software collectors | Incomplete evidence cannot erase last-known-good inventory or resolve a vulnerability by absence. |

## Global constraints and resolved controller decisions

- Device-option selection is server-owned: authorization, case-insensitive search, filtering, sorting, pagination, and label hydration all happen in the API.
- The selector accepts an optional `orgId`. The route requires `auth.canAccessOrg(orgId)`, applies it as an additional scope, and binds it into the cursor fingerprint. This preserves the verified organization-narrowing behavior in ticket, baseline, and network-change selectors.
- `includeIds` is a label-hydration union outside paging. `page.total`, `hasMore`, and `nextCursor` describe only the filtered searchable stream; authorized hydrated IDs are unioned into `data`, can make `page.returned` exceed `limit`, and never advance or alter the cursor.
- Hook state `truncated` means either at least one selected/requested `includeId` remains unresolved or a consumer requested an exhaustive set and has not paged it to completion. Ordinary non-exhaustive results remain `ready` when `hasMore` is true and expose `loadMore()`.
- The health wire key remains `healthStatus`. The server persists `deviceId` only from authenticated agent context; an optional wire `deviceId` is accepted solely to verify equality and is never authoritative.
- The minimum health reader is `GET /devices/:id/health`, returning the latest authorized observation or an explicit `unknown` view. Alert thresholds and health-driven reachability changes are out of scope.
- Script target codes are stable: `not_found_or_inaccessible`, `site_access_denied`, `script_org_mismatch`, `os_incompatible`, `device_decommissioned`, `maintenance_suppressed`, plus stable existing dispatch refusal codes. Duplicate device IDs are deduplicated in first-occurrence order and dispatch at most once.
- An inventory count collapse is rejected as `rejected_count_collapse` only when the prior accepted count is at least 50, the new claimed-complete count is below 10% of that count, and the reported source set has not changed.
- Absence resolution uses server ordering: an accepted complete observation is eligible only when its `receivedAt` is later than the finding's `detectedAt` and it remains the device's latest accepted observation. Agent `observedAt` is evidence, not ordering authority.
- Non-empty legacy inventory can refresh the visible projection only until the first accepted v2 observation. Later legacy reports remain evidence but cannot downgrade the v2 last-known-good projection. A legacy empty report always retains visible inventory.
- This replacement branch uses the verified unshipped migration names `2026-09-28-100000-agent-health-observations.sql`, `2026-09-28-100001-automation-action-results.sql`, and `2026-09-28-100002-software-inventory-observations.sql`. Reverify them with `scripts/check-migration-naming.sh` before merge; never rename or edit a shipped migration.
- Every new tenant table enables and forces RLS in its creation migration and is registered in organization/device cascade, device-org restamp, RLS coverage, and tenant export policy as applicable. JSON/JSONB evidence is `excludedOpen`.
- Immutable observation rows deny UPDATE but continue to allow erasure/cascade DELETE; do not add them to `AUDIT_ADMIN_REQUIRED_TABLES` unless DELETE itself is explicitly prohibited.
- Hot child inserts lock the authenticated device `FOR KEY SHARE` in a short transaction. Do not interleave a `devices` update in that transaction.
- Old payloads remain accepted before new producers ship. Unknown future schema versions cannot reject an otherwise valid heartbeat.
- All behavior changes follow strict RED/GREEN: record a failing targeted test before production changes, then run the same command green.
- Integration suites live under `apps/api/src/__tests__/integration/`; evidence must show the file and test count executed rather than silently skipped.
- Production deployment, hosted-fleet enablement, and customer-device rollout are out of scope.

## Shared interfaces

Create and export the following shared contracts from `packages/shared/src/types/index.ts`.

```ts
export type DeviceOption = {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  status: string;
  siteId: string | null;
  siteName: string | null;
};

export type DeviceOptionPage = {
  data: DeviceOption[];
  page: {
    nextCursor: string | null;
    returned: number;
    total: number;
    hasMore: boolean;
    observedAt: string;
  };
};

export type AgentHealthObservation = {
  schemaVersion: 1;
  deviceId: string;
  agentVersion: string;
  overall: 'healthy' | 'warning' | 'error' | 'unknown';
  metricsAvailable: boolean | null;
  components: Record<string, {
    state: 'healthy' | 'warning' | 'error' | 'unknown';
    reason?: string;
  }>;
  observedAt: string;
};

export type ScriptAdmissionResult = {
  requestId: string;
  status: 'queued' | 'partially_queued' | 'rejected';
  targets: Array<{
    requestedDeviceId: string;
    admission: 'admitted' | 'excluded' | 'suppressed' | 'denied';
    reasonCode?: string;
    executionId?: string;
    commandId?: string;
    batchId?: string;
  }>;
};

export type SoftwareInventoryObservationV2 = {
  schemaVersion: 2;
  observationId: string;
  collectorVersion: string;
  observedAt: string;
  completeness: 'complete' | 'partial' | 'failed';
  expectedSources: string[];
  succeededSources: string[];
  failedSources: Array<{ source: string; code: string }>;
  truncated: boolean;
  itemCount: number;
  items: SoftwareInventoryItem[];
};
```

---

### Task 1: Shared device-option contract and authorized selector route (RMM-QA-012)

**Files:**
- Create: `packages/shared/src/types/deviceOptions.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/api/src/routes/devices/options.ts`
- Create: `apps/api/src/routes/devices/optionsCursor.ts`
- Modify: `apps/api/src/routes/devices/index.ts`
- Create: `apps/api/src/routes/devices/options.test.ts`
- Create: `apps/api/src/routes/devices/options.mountorder.test.ts`
- Create: `apps/api/src/__tests__/integration/deviceOptions.integration.test.ts`

**Interfaces:**
- Produces `DeviceOption` and `DeviceOptionPage` from the shared-interface section.
- `GET /devices/options` accepts `search`, `cursor`, `limit` (default 50, maximum 100), `status`, `siteId`, `osType`, optional `orgId`, and up to 500 `includeIds`.
- Cursor payloads are opaque, versioned, and bound to the active search/filter/auth-scope fingerprint. A malformed or mismatched cursor returns 400.
- Option order is the normalized visible label followed by UUID; the cursor uses the same tuple.

- [x] **Step 1: Write unit and mount-order RED tests**

Add literal cases for zero rows, exactly 50 rows, 51 rows with a cursor, case-insensitive hostname/display-name search, each filter and combinations, malformed/mismatched cursors, off-page `includeIds`, inaccessible IDs, tied labels, the 100/500 caps, and an unauthorized explicit `orgId`. Add an assembled-router test proving `/devices/options` reaches the options handler instead of `GET /:id`.

- [x] **Step 2: Write the real-PostgreSQL RED matrix**

Create two partners, two organizations, and two sites with known-valid foreign IDs. Assert search and `includeIds` never expose foreign labels, a forbidden `siteId` returns 403, and every denied request creates zero side effects. Generate 10,000 devices and assert early, middle, and final matches are reachable and cursor traversal neither omits nor duplicates IDs.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/options.test.ts src/routes/devices/options.mountorder.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceOptions.integration.test.ts
```

Expected: the route/module does not exist and the assembled router currently routes `/options` as a device ID.

- [x] **Step 4: Implement the selector and cursor**

Query `devices` joined to `sites`. Apply `auth.orgCondition`, allowed-site restrictions, optional authorized `orgId`, non-ephemeral/terminal-device rules, search and filters before ordering/paging. Hydrate only authorized `includeIds`, union them outside paging, and compute `page.returned` from the final union. Mount `optionsRoutes` after `customFieldValuesRoutes` and before `coreRoutes`.

- [ ] **Step 5: Run GREEN, typecheck, and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/options.test.ts src/routes/devices/options.mountorder.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceOptions.integration.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/shared typecheck
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
git add packages/shared/src/types/deviceOptions.ts packages/shared/src/types/index.ts apps/api/src/routes/devices/options.ts apps/api/src/routes/devices/optionsCursor.ts apps/api/src/routes/devices/index.ts apps/api/src/routes/devices/options.test.ts apps/api/src/routes/devices/options.mountorder.test.ts apps/api/src/__tests__/integration/deviceOptions.integration.test.ts
git commit -m "fix(api): add authorized device option paging"
```

### Task 2: Race-safe device-options hook and reusable picker (RMM-QA-012)

**Files:**
- Create: `apps/web/src/hooks/useDeviceOptions.ts`
- Create: `apps/web/src/hooks/useDeviceOptions.test.tsx`
- Create: `apps/web/src/components/filters/DeviceOptionPicker.tsx`
- Create: `apps/web/src/components/filters/DeviceOptionPicker.test.tsx`
- Modify: `apps/web/src/components/filters/DeviceTargetSelector.tsx`
- Create: `apps/web/src/components/filters/DeviceTargetSelector.test.tsx`

**Interfaces:**

```ts
type DeviceOptionsState = 'loading' | 'ready' | 'empty' | 'error' | 'stale' | 'truncated';

type UseDeviceOptionsInput = {
  search?: string;
  status?: string;
  siteId?: string;
  osType?: string;
  orgId?: string;
  includeIds?: string[];
  limit?: number;
  enabled?: boolean;
  requireCompleteSet?: boolean;
};

type UseDeviceOptionsResult = {
  options: DeviceOption[];
  page: DeviceOptionPage['page'] | null;
  state: DeviceOptionsState;
  error: Error | null;
  canSubmit: boolean;
  loadMore(): Promise<void>;
  retry(): void;
};
```

- [x] **Step 1: Write hook RED tests**

Test all six states and `canSubmit`. With deferred fetches, request scope A, switch to B, resolve B then A, and assert A never overwrites B. Old labels may remain visible only as `stale`, with submission blocked. Test `includeIds`, pagination de-duplication, abort/retry, empty search, and the resolved truncation rule.

- [x] **Step 2: Write picker and selector RED tests**

Assert explicit loading/error/stale/truncated UI, no false empty state during a request, and disabled submit when any selected ID is unresolved. Assert `DeviceTargetSelector` never calls general `/devices`, searches server-side, and exposes select-all only after `requireCompleteSet` pagination completes.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/web exec vitest run src/hooks/useDeviceOptions.test.tsx src/components/filters/DeviceOptionPicker.test.tsx src/components/filters/DeviceTargetSelector.test.tsx
```

Expected: the hook/picker do not exist and the selector still fetches the general list.

- [x] **Step 4: Implement generation/abort semantics**

Give each logical query a monotonically increasing generation and its own `AbortController`. Normalize options by ID, ignore late generations, preserve old labels as stale only, union page results without duplicates, and set `truncated` only for unresolved `includeIds` or incomplete explicitly exhaustive requests.

- [x] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/web exec vitest run src/hooks/useDeviceOptions.test.tsx src/components/filters/DeviceOptionPicker.test.tsx src/components/filters/DeviceTargetSelector.test.tsx
git add apps/web/src/hooks/useDeviceOptions.ts apps/web/src/hooks/useDeviceOptions.test.tsx apps/web/src/components/filters/DeviceOptionPicker.tsx apps/web/src/components/filters/DeviceOptionPicker.test.tsx apps/web/src/components/filters/DeviceTargetSelector.tsx apps/web/src/components/filters/DeviceTargetSelector.test.tsx
git commit -m "fix(web): use complete device option state"
```

### Task 3: Migrate interactive selector consumers in bounded waves (RMM-QA-012)

**Files:**
- Wave A: `apps/web/src/components/scripts/ScriptsPage.tsx`, `apps/web/src/components/scripts/ScriptExecutionsPage.tsx`, `apps/web/src/components/scripts/ScriptExecutionModal.tsx`, `apps/web/src/components/remote/RemoteDeviceLauncherPage.tsx`, `apps/web/src/components/alerts/AlertRuleEditPage.tsx`
- Wave B: `apps/web/src/components/dr/DRPlanEditor.tsx`, `apps/web/src/components/backup/SLAConfigDialog.tsx`, `apps/web/src/components/backup/VaultConfigDialog.tsx`, `apps/web/src/components/backup/VMRestoreWizard.tsx`, `apps/web/src/components/software/DeploymentWizard.tsx`
- Wave C: `apps/web/src/components/tickets/CreateTicketPage.tsx`, `apps/web/src/components/auditBaselines/BaselineApplyTab.tsx`, `apps/web/src/components/discovery/NetworkChangesPanel.tsx`
- Reclassify before editing: `apps/web/src/components/alerts/AlertsPage.tsx`, `apps/web/src/components/dr/DRExecutionView.tsx`, `apps/web/src/components/patches/PatchComplianceView.tsx`, and any DeviceCompare/network-detail label-only hydration path.
- Test: `apps/web/src/components/scripts/ScriptsPage.test.tsx`, `apps/web/src/components/scripts/ScriptExecutionsPage.test.tsx`, `apps/web/src/components/scripts/ScriptExecutionModal.test.tsx`, `apps/web/src/components/alerts/AlertRuleEditPage.ownerScope.test.tsx`, `apps/web/src/components/backup/VMRestoreWizard.test.tsx`, `apps/web/src/components/software/DeploymentWizard.test.tsx`, `apps/web/src/components/software/DeploymentWizard.manager.test.tsx`, `apps/web/src/components/software/DeploymentWizard.preselect.test.tsx`, `apps/web/src/components/tickets/CreateTicketPage.test.tsx`, and `apps/web/src/components/discovery/NetworkChangesPanel.test.tsx`.
- Create: `apps/web/src/components/remote/RemoteDeviceLauncherPage.test.tsx`, `apps/web/src/components/dr/DRPlanEditor.test.tsx`, `apps/web/src/components/backup/SLAConfigDialog.test.tsx`, `apps/web/src/components/backup/VaultConfigDialog.test.tsx`, and `apps/web/src/components/auditBaselines/BaselineApplyTab.test.tsx`.

**Interfaces:**
- Consumes Task 2's hook/picker. True interactive choices and selected-label hydration use `/devices/options`; full table displays remain on their fit-for-purpose readers.
- Organization-narrowed consumers pass `orgId`; preselected values pass `includeIds`.
- Device Groups persistence is explicitly out of scope.

- [ ] **Step 1: Reclassify ambiguous readers before RED**

For each ambiguous file, inspect whether the loaded devices are user-selectable targets or merely table/join display data. Record the classification in the task report. Modify only interactive selectors or selected-label hydration.

- [ ] **Step 2: Write Wave A RED tests and run them**

For each edited consumer, put the desired device outside the old prefix, preserve an off-page selected label, and assert error/stale/truncated states block submission.

```bash
pnpm --filter @breeze/web exec vitest run src/components/scripts/ScriptsPage.test.tsx src/components/scripts/ScriptExecutionsPage.test.tsx src/components/scripts/ScriptExecutionModal.test.tsx src/components/remote/RemoteDeviceLauncherPage.test.tsx src/components/alerts/AlertRuleEditPage.ownerScope.test.tsx
```

Expected: at least the beyond-prefix and blocked-submit assertions fail against local list fetching.

- [x] **Step 3: Migrate Wave A and run GREEN**

Use Task 2 directly; delete per-page high-limit fetches and local substring filters. Preserve domain filters and callback contracts.

- [x] **Step 4: Repeat strict RED/GREEN for Waves B and C**

Run adjacent targeted suites after each wave. In every organization-specific surface, assert the request includes authorized `orgId`. Do not add a silent fallback to `/devices`.

- [ ] **Step 5: Run the web selector regression set and commit**

```bash
pnpm --filter @breeze/web exec vitest run src/hooks/useDeviceOptions.test.tsx src/components/filters/DeviceOptionPicker.test.tsx src/components/filters/DeviceTargetSelector.test.tsx src/components/scripts src/components/remote src/components/alerts src/components/dr src/components/backup src/components/software src/components/tickets src/components/auditBaselines src/components/discovery
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/web exec astro check
git add apps/web/src/components
git commit -m "fix(web): migrate device selectors to server options"
```

### Task 4: Make heartbeat the reachability source of truth (RMM-QA-039)

**Files:**
- Modify: `packages/shared/src/constants/index.ts`
- Create: `packages/shared/src/constants/index.test.ts`
- Modify: `apps/api/src/routes/agents/enrollment.ts`
- Modify: `apps/api/src/routes/agents/enrollment.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Create: `apps/api/src/__tests__/integration/enrollmentReachability.integration.test.ts`

**Interfaces:**
- `DEVICE_STATUSES` includes `pending` and `updating` while retaining all currently valid statuses.
- Fresh enrollment persists `status = 'pending'` and `lastSeenAt = null`.
- Re-enrollment rotates credentials/metadata, sets or preserves `pending`, and leaves the exact previous `lastSeenAt` untouched.
- Only an authenticated main-agent heartbeat advances `lastSeenAt` and makes a nonterminal device online; watchdog heartbeat never does.

- [x] **Step 1: Write RED unit tests**

Assert shared constant/validator parity; fresh and re-enrollment behavior; pending/offline to online on main heartbeat; watchdog reachability non-mutation; and existing watchdog field updates.

- [x] **Step 2: Write concurrent real-PostgreSQL RED**

Race re-enrollment with a valid main heartbeat and assert no `40P01`. Control commit ordering and prove final reachability reflects the last committed real heartbeat, never enrollment time.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/shared exec vitest run src/constants/index.test.ts
pnpm --filter @breeze/api exec vitest run src/routes/agents/enrollment.test.ts src/routes/agents/heartbeat.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/enrollmentReachability.integration.test.ts
```

Expected: enrollment currently writes `online` and advances `lastSeenAt`; the new assertions fail.

- [x] **Step 4: Implement minimal reachability changes**

Set both enrollment branches to `pending`; omit `lastSeenAt` on insert and from the re-enrollment update. Preserve the existing main/watchdog split and terminal-device guard.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/shared exec vitest run src/constants/index.test.ts
pnpm --filter @breeze/api exec vitest run src/routes/agents/enrollment.test.ts src/routes/agents/heartbeat.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/enrollmentReachability.integration.test.ts
git add packages/shared/src/constants/index.ts packages/shared/src/constants/index.test.ts apps/api/src/routes/agents/enrollment.ts apps/api/src/routes/agents/enrollment.test.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/__tests__/integration/enrollmentReachability.integration.test.ts
git commit -m "fix(api): make heartbeat authoritative for reachability"
```

### Task 5: Persist versioned health observations and latest projection (RMM-QA-319)

**Files:**
- Create: `packages/shared/src/types/agentHealth.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/api/src/db/schema/agentHealth.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-09-28-100000-agent-health-observations.sql`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`
- Create: `apps/api/src/services/agentHealthObservations.ts`
- Create: `apps/api/src/services/agentHealthObservations.test.ts`
- Create: `apps/api/src/__tests__/integration/agentHealthObservations.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.test.ts`
- Modify: `apps/api/src/extensions/tenancyRegistry.test.ts`
- Modify: `apps/api/src/db/ensureAppRole.ts`

**Interfaces:**
- The heartbeat wire field is optional `healthStatus`. V1 matches `Omit<AgentHealthObservation, 'deviceId'> & { deviceId?: string }`; legacy unversioned maps and unknown versions are tolerated without rejecting reachability.
- Produces immutable `agentHealthObservations` and mutable `deviceAgentHealthLatest` tables with direct `orgId`/`deviceId` ownership, server `receivedAt`, observation identity, and latest compare-and-set ordering. V1 retry identity is unique `(deviceId, observedAt)` because the approved wire type has no `observationId`; an exact retry is idempotent and the same identity with a different payload is rejected as equivocation.

```ts
export async function recordAgentHealthObservation(input: {
  device: { id: string; orgId: string };
  observation: AgentHealthObservation;
  receivedAt: Date;
}): Promise<{ observationId: string; becameLatest: boolean }>;
```

- [x] **Step 1: Reverify the migration filename, then write parser RED tests**

Run `bash scripts/check-migration-naming.sh`; the verified replacement-branch chronology reserves `2026-09-28-100000-agent-health-observations.sql` after shipped main migrations through `2026-09-27-technician-ticket-write-permissions.sql`. Test old omission, current unversioned `healthStatus`, valid v1, mismatched optional wire device ID, unknown version, and malformed components. Every unsupported health case must leave the otherwise valid heartbeat accepted.

- [x] **Step 2: Write service and real-PostgreSQL RED tests**

Assert the service locks the authenticated device `FOR KEY SHARE` before child insert. In real PostgreSQL prove cross-org isolation, forced RLS, denied observation UPDATE, allowed cascade deletion, complete cascade/restamp/export registration, exact-retry idempotency, equivocation rejection, and deterministic latest projection for duplicate/out-of-order receipts. Generic RLS coverage still expects structural policies for all four DML operations; prove immutability through revoked app-role UPDATE privilege plus a database trigger, not by omitting the UPDATE policy.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts src/services/agentHealthObservations.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/agentHealthObservations.integration.test.ts
```

Expected: schema/table/service are absent and the new contracts fail.

- [x] **Step 4: Add the additive schema, migration, parser, and service**

Enable and force RLS in the creation migration. Register both tables in all applicable contracts; classify `components` as `excludedOpen`. In a short system transaction, lock the authenticated device, verify its organization, insert immutable evidence, then compare-and-set latest using `(receivedAt, observationId)`. Persist authoritative `deviceId` from authenticated context and reject only an explicit unequal wire value from persistence, without rejecting reachability. Because startup blanket grants would otherwise restore UPDATE, modify `ensureAppRole.ts` to re-revoke observation UPDATE on every boot; retain a structural UPDATE RLS policy for coverage and use the trigger/privilege boundary as immutability enforcement.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts src/services/agentHealthObservations.test.ts src/services/tenantCascade.test.ts src/extensions/tenancyRegistry.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/agentHealthObservations.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
bash scripts/check-migration-naming.sh
pnpm db:check-drift
git add packages/shared/src/types/agentHealth.ts packages/shared/src/types/index.ts apps/api/src/db/schema/agentHealth.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-09-28-100000-agent-health-observations.sql apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts apps/api/src/services/agentHealthObservations.ts apps/api/src/services/agentHealthObservations.test.ts apps/api/src/__tests__/integration/agentHealthObservations.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantCascade.test.ts apps/api/src/extensions/tenancyRegistry.test.ts apps/api/src/db/ensureAppRole.ts
git commit -m "fix(db): persist versioned agent health observations"
```

### Task 6: Ingest health outside the heartbeat transaction and emit typed Go health (RMM-QA-319)

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Create: `apps/api/src/routes/devices/health.ts`
- Create: `apps/api/src/routes/devices/health.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts`
- Modify: `agent/internal/health/health.go`
- Modify: `agent/internal/health/health_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`
- Modify: any dead `userHelpers` health-map mutation path identified by discovery

**Interfaces:**
- `GET /devices/:id/health` authorizes tenant and site access and returns `{ status: 'unknown', observation: null }` or `{ status: 'known', observation: AgentHealthObservation, receivedAt: string }`.
- The Go snapshot maps `health.Healthy -> healthy`, `health.Degraded -> warning`, `health.Unhealthy -> error`, and `health.Unknown -> unknown`; `Check.Message` becomes optional component `reason`; `metricsAvailable` is `boolean | null`.
- Only the main agent sends `healthStatus`. Health persistence never writes `devices.status`.

- [x] **Step 1: Write API RED tests**

Prove valid v1 health is recorded after main heartbeat, omission writes no observation, health insert failure is captured/logged without failing reachability, and only the existing main branch changes reachability. For the read route, prove site/tenant denial, no foreign metadata leak, and explicit `unknown` with no observation.

- [x] **Step 2: Write Go RED and race tests**

Assert every status/reason mapping, schema version, timestamp, metrics availability, optional device identity, and a self-consistent immutable snapshot while component updates happen concurrently.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts src/routes/devices/health.test.ts
(cd agent && go test -race ./internal/health ./internal/heartbeat)
```

Expected: no observation call/read route exists and Go still emits an untyped map.

- [x] **Step 4: Implement post-transaction ingest and typed producer**

Call `recordAgentHealthObservation` immediately after `withDbAccessContext(...)` returns and after `if (scoped instanceof Response) return scoped;`, where the request-long transaction has released. The service itself uses `runOutsideDbContext`, a short system transaction, and `FOR KEY SHARE`. Treat persistence failure as health-observability failure, not heartbeat failure. Replace `Summary() map[string]any` upload use with a locked typed immutable snapshot, retain the `healthStatus` JSON key, and remove the dead/unconsumed `userHelpers` health-map mutation rather than carrying it into the typed payload.

- [x] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts src/routes/devices/health.test.ts src/services/agentHealthObservations.test.ts
(cd agent && go test -race ./internal/health ./internal/heartbeat)
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/routes/devices/health.ts apps/api/src/routes/devices/health.test.ts apps/api/src/routes/devices/index.ts agent/internal/health/health.go agent/internal/health/health_test.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go
git commit -m "fix(agent): report health independently of reachability"
```

## Verified corrections for Tasks 7–11

The following current-state corrections override narrower file lists or interfaces in Tasks 7–11 below:

- Task 7 also changes `scriptExecution.test.ts`, `multi-tenant-isolation.test.ts`, and `openapi.ts`. Normalize duplicate requested IDs by first occurrence and return one ordered target result per distinct ID. Gate in oracle-safe order: missing/inaccessible, site, script-org, OS, decommissioned, maintenance. Zero admission is a valid rejected admission, not a global error. Route audit occurs only when at least one target is admitted; mobile/remediation locate results by requested device ID and mutate nothing on zero admission.
- Task 8 also migrates `ScriptTestRunner`, `deviceActions`, `DevicesPage`, `DeviceDetailPage`, their tests, and locale parity. All consumers parse `ScriptAdmissionResult`; only `ScriptTestRunner` polls a real admitted execution to terminal state. A rejected 201 is never toasted or rendered as success.
- Task 9 uses the verified replacement-branch migration name `2026-09-28-100001-automation-action-results.sql` after `2026-09-28-100000-agent-health-observations.sql`. Persist `terminalSource` plus `terminalIsProvisional`; only a reaper timeout is replaceable by later guarded real evidence. Seed derives org ownership under a device `FOR KEY SHARE` lock. Reconciliation locks the run `FOR UPDATE`, recomputes rather than increments, preserves legacy zero-action runs, and publishes a terminal event only on the effective parent CAS.
- Task 10 also changes config-policy runtime tests, `softwareDeployment.ts` and its tests, and `automationWorker.ts`/tests. Software fanout returns an exact per-device `deploymentResultId`; mixed-action batching retains original normalized indexes. Ordinary and config-policy runs seed before dispatch. The worker must not hold a long ambient system transaction around the new short action transactions.
- Task 11 also changes `agentWs.test.ts`, `software.ts`, and `software.test.ts`. HTTP and WS share a guarded command-to-action mapping and invoke it after an effective command CAS even when result validation later rejects the frame. Script/software handlers return the effective transitioned row ID; cancellation and every reaper reconcile only returned/guarded source changes. Direct WS and queued software paths are both covered.

### Task 7: Canonical per-target script admission (RMM-QA-212)

**Files:**
- Create: `packages/shared/src/types/scriptAdmission.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/api/src/services/scriptExecution.ts`
- Create: `apps/api/src/services/scriptExecution.admission.test.ts`
- Modify: `apps/api/src/routes/scripts.ts`
- Modify: `apps/api/src/routes/scripts.test.ts`
- Modify: `apps/api/src/routes/mobile.ts`
- Modify: `apps/api/src/routes/mobile.test.ts`
- Modify: `apps/api/src/routes/remediationSuggestions.ts`
- Modify: `apps/api/src/routes/remediationSuggestions.test.ts`
- Create: `apps/api/src/__tests__/integration/scriptAdmission.integration.test.ts`

**Interfaces:**
- Produces the shared `ScriptAdmissionResult` exactly as the valid 201 response body.

```ts
type ExecuteScriptOnDevicesSuccess = {
  ok: true;
  admission: ScriptAdmissionResult;
  script: typeof scripts.$inferSelect;
  auditOrgId: string | null;
  triggerType: 'manual' | 'scheduled' | 'alert' | 'policy';
  runAs: string;
  ignoredParameters: string[];
};
```

- Authentication, malformed input, missing script, and internal failure remain HTTP errors. Per-target conditions become entries. `queued` means all distinct targets admitted, `partially_queued` means a mix, and `rejected` means none admitted.

- [x] **Step 1: Write service/route RED matrix**

Cover admitted, not found/inaccessible, site denied, script-org mismatch, OS mismatch, decommissioned, maintenance suppressed, dispatch refused, and dispatched. Assert stable codes, first-occurrence de-duplication, no double dispatch, no vanished IDs, exact per-org batch IDs, and the exact route body.

- [x] **Step 2: Write real-PostgreSQL and caller RED tests**

Use two partners, two orgs, and two sites with known foreign IDs; assert no commands, executions, or batches for denied targets and no metadata leak. Assert mobile and remediation callers handle zero admission without indexing an empty result or recording false execution.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/scriptExecution.admission.test.ts src/routes/scripts.test.ts src/routes/mobile.test.ts src/routes/remediationSuggestions.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptAdmission.integration.test.ts
```

Expected: targets are currently dropped or globally rejected and callers consume the legacy split result.

- [x] **Step 4: Implement one admission map and migrate every caller**

Deduplicate before querying while preserving order. Initialize one entry per distinct request, fill it through authorization, compatibility, maintenance, and dispatch, and dispatch admitted targets only. Keep request/script/internal errors all-or-nothing. Preserve existing execution/batch ownership and failed-dispatch rows; admission wraps those writes rather than duplicating them.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/scriptExecution.admission.test.ts src/routes/scripts.test.ts src/routes/mobile.test.ts src/routes/remediationSuggestions.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptAdmission.integration.test.ts
git add packages/shared/src/types/scriptAdmission.ts packages/shared/src/types/index.ts apps/api/src/services/scriptExecution.ts apps/api/src/services/scriptExecution.admission.test.ts apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.test.ts apps/api/src/routes/mobile.ts apps/api/src/routes/mobile.test.ts apps/api/src/routes/remediationSuggestions.ts apps/api/src/routes/remediationSuggestions.test.ts apps/api/src/__tests__/integration/scriptAdmission.integration.test.ts
git commit -m "fix(api): return explicit script admission results"
```

### Task 8: Render script admission without terminal-success claims (RMM-QA-212)

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptExecutionModal.tsx`
- Modify: `apps/web/src/components/scripts/ScriptExecutionModal.test.tsx`
- Modify: `apps/web/src/components/scripts/ScriptsPage.tsx`
- Modify: `apps/web/src/components/scripts/ScriptsPage.test.tsx`
- Modify: `apps/web/src/components/scripts/ScriptExecutionsPage.tsx`
- Modify: `apps/web/src/components/scripts/ScriptExecutionsPage.test.tsx`

**Interfaces:**
- The modal callback is `(input) => Promise<ScriptAdmissionResult>`.
- Presentation states are `admitted | partially_admitted | rejected`; none means completed/succeeded.

- [x] **Step 1: Write RED UI tests**

Require the typed callback; assert all-admitted says queued/admitted, partial keeps the modal open with every target/reason, rejected remains open past 1.5 seconds, and transport failure remains distinct from admission rejection.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/web exec vitest run src/components/scripts/ScriptExecutionModal.test.tsx src/components/scripts/ScriptsPage.test.tsx src/components/scripts/ScriptExecutionsPage.test.tsx
```

Expected: the callback is `Promise<void>` and a successful request renders terminal success.

- [x] **Step 3: Render the shared result directly**

Return parsed admission from both page callbacks. Render every admitted/excluded/suppressed/denied target and reason. Refresh execution history only when at least one target is admitted; never infer completion from HTTP 201.

- [x] **Step 4: Run GREEN and commit**

```bash
pnpm --filter @breeze/web exec vitest run src/components/scripts/ScriptExecutionModal.test.tsx src/components/scripts/ScriptsPage.test.tsx src/components/scripts/ScriptExecutionsPage.test.tsx
git add apps/web/src/components/scripts/ScriptExecutionModal.tsx apps/web/src/components/scripts/ScriptExecutionModal.test.tsx apps/web/src/components/scripts/ScriptsPage.tsx apps/web/src/components/scripts/ScriptsPage.test.tsx apps/web/src/components/scripts/ScriptExecutionsPage.tsx apps/web/src/components/scripts/ScriptExecutionsPage.test.tsx
git commit -m "fix(web): distinguish script admission from completion"
```

### Task 9: Automation action-result schema and state machine (RMM-QA-105)

**Files:**
- Modify: `apps/api/src/db/schema/automations.ts`
- Create: `apps/api/migrations/2026-09-28-100001-automation-action-results.sql`
- Create: `apps/api/src/services/automationActionResults.ts`
- Create: `apps/api/src/services/automationActionResults.test.ts`
- Create: `apps/api/src/__tests__/integration/automationActionResults.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.test.ts`
- Modify: `apps/api/src/extensions/tenancyRegistry.test.ts`

**Interfaces:**

```ts
type AutomationActionResultStatus =
  | 'pending' | 'queued' | 'delivered' | 'running'
  | 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';

seedAutomationActionResults(input: {
  runId: string;
  device: { id: string; orgId: string };
  actions: Array<{ actionIndex: number; actionType: string }>;
}): Promise<void>;

recordAutomationActionDispatch(input: {
  runId: string;
  deviceId: string;
  actionIndex: number;
  status: 'queued' | 'delivered' | 'running' | 'failed' | 'skipped';
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  message?: string;
}): Promise<boolean>;

applyAutomationActionTerminal(input: {
  source: 'command' | 'script_execution' | 'deployment_result' | 'timeout' | 'cancellation' | 'reaper';
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  output?: string | null;
  error?: string | null;
  completedAt: Date;
}): Promise<boolean>;

reconcileAutomationRun(runId: string): Promise<void>;
```

- Table constraints: unique `(run_id, device_id, action_index)`; partial unique indexes for non-null `command_id`, `script_execution_id`, and `deployment_result_id`; indexes on `run_id`, `device_id`, `org_id`, and `(status, updated_at)`. Correlation IDs are not FKs; table FKs only to runs, devices, and organizations.
- Terminal states are `succeeded`, `failed`, `skipped`, `timed_out`, and `cancelled`. Terminal rows never regress; duplicates are no-ops; a late real result replaces only a provisional reaper timeout under existing script late-result rules. `reconcileAutomationRun` is the sole parent terminal aggregate writer once action rows exist.

- [x] **Step 1: Reverify migration ordering and write state-machine RED**

Test every allowed transition, forbidden terminal regression, duplicates, reordered terminal events, provisional timeout replacement, action-index uniqueness, and aggregate behavior while any action is nonterminal.

- [x] **Step 2: Write real-PostgreSQL tenant/locking RED**

Prove forced RLS, cross-org denial, all unique constraints, device/org cascade and restamp, export classification, and `FOR KEY SHARE` before seeding a device child row.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationActionResults.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationActionResults.integration.test.ts
```

Expected: enum/table/service do not exist.

- [x] **Step 4: Implement schema and single state service**

Create the table with direct `org_id`, forced RLS, constraints/indexes, and all registries. Use guarded compare-and-set updates and recompute parent aggregates from child rows rather than incrementing counters. Store output only after existing redaction chokepoints.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationActionResults.test.ts src/services/tenantCascade.test.ts src/extensions/tenancyRegistry.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationActionResults.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
bash scripts/check-migration-naming.sh
pnpm db:check-drift
git add apps/api/src/db/schema/automations.ts apps/api/migrations apps/api/src/services/automationActionResults.ts apps/api/src/services/automationActionResults.test.ts apps/api/src/__tests__/integration/automationActionResults.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantCascade.test.ts apps/api/src/extensions/tenancyRegistry.test.ts
git commit -m "fix(db): persist automation action terminal state"
```

### Task 10: Make automation dispatch nonterminal (RMM-QA-105)

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts`
- Modify: `apps/api/src/services/automationRuntime.runScript.test.ts`
- Modify: `apps/api/src/services/automationRuntime.deploySoftware.test.ts`
- Modify: `apps/api/src/services/automationRuntime.test.ts`

**Interfaces:**
- Consumes all Task 9 interfaces.
- Action execution returns dispatch/terminal state plus exact source IDs, not a boolean success.
- `run_script`, raw command, and software deployment remain nonterminal after accepted dispatch. Synchronous actions may terminalize immediately.
- Original normalized `actionIndex` survives filtering/deployment batching.

- [x] **Step 1: Write runtime RED tests**

Assert script dispatch records execution and command IDs and leaves action/device/run nonterminal; raw command records command ID; software records the exact per-device `deployment_results.id`; mixed actions preserve original indexes; synchronous actions terminalize; unexecuted actions after `onFailure: stop|notify` become `skipped`; and refusal fails only the affected action under current on-failure semantics.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationRuntime.runScript.test.ts src/services/automationRuntime.deploySoftware.test.ts src/services/automationRuntime.test.ts
```

Expected: runtime currently reports dispatch as success, reindexes deployment actions, and finalizes parents immediately.

- [x] **Step 3: Seed and link action rows at runtime**

Seed rows before each device action list. Return exact correlation IDs from dispatch handlers and call `recordAutomationActionDispatch`. Retain original indexes instead of using filtered-array `.entries()`. Replace direct success finalization in `finally` with `reconcileAutomationRun`; keep `completedAt` null while any admitted child is nonterminal.

- [x] **Step 4: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationActionResults.test.ts src/services/automationRuntime.runScript.test.ts src/services/automationRuntime.deploySoftware.test.ts src/services/automationRuntime.test.ts
git add apps/api/src/services/automationRuntime.ts apps/api/src/services/automationRuntime.runScript.test.ts apps/api/src/services/automationRuntime.deploySoftware.test.ts apps/api/src/services/automationRuntime.test.ts
git commit -m "fix(api): keep automation dispatch nonterminal"
```

### Task 11: Reconcile automation from results, cancellation, timeout, and reapers (RMM-QA-105)

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts`
- Modify: `apps/api/src/routes/agents/commands.ts`
- Modify: `apps/api/src/routes/agents/commands.test.ts`
- Modify: `apps/api/src/services/commandResultHandlers.ts`
- Create: `apps/api/src/services/commandResultHandlers.automation.test.ts`
- Modify: `apps/api/src/services/softwareDeploymentResult.ts`
- Modify: `apps/api/src/services/softwareDeploymentResult.test.ts`
- Modify: `apps/api/src/routes/scripts.ts`
- Modify: `apps/api/src/routes/scripts.test.ts`
- Modify: `apps/api/src/jobs/staleCommandReaper.ts`
- Modify: `apps/api/src/jobs/staleCommandReaper.test.ts`
- Create: `apps/api/src/__tests__/integration/automationTerminalReconciliation.integration.test.ts`

**Interfaces:**
- HTTP and WebSocket command-result transports both call the same terminal service only after their guarded `device_commands` compare-and-set succeeds, including validation-failure terminal paths.
- `handleScriptResult` reconciles by `script_execution_id`; `applySoftwareInstallResult` returns the effective transitioned `deployment_results.id`; explicit cancellation and reapers reconcile only after their source row transition succeeds.

- [x] **Step 1: Write transport/result RED matrix**

Cover script result, raw command result, deployment result, explicit script cancellation, command timeout, script-execution reaper, deployment reaper, duplicate, reversed arrival, and allowed late result after provisional timeout. Run command cases through both HTTP and WebSocket seams and assert identical child/parent state.

- [x] **Step 2: Write concurrency and real-PostgreSQL RED**

Race duplicate results and assert exactly one effective terminal transition, stable aggregates, and no counter drift. Prove delivered remains running and the last action alone terminalizes the parent.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/commands.test.ts src/services/commandResultHandlers.automation.test.ts src/services/softwareDeploymentResult.test.ts src/routes/scripts.test.ts src/jobs/staleCommandReaper.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationTerminalReconciliation.integration.test.ts
```

Expected: source results currently do not update durable action rows and parents can already be terminal.

- [x] **Step 4: Wire every guarded terminal seam**

Resolve command action rows by `command_id` after transport CAS, script rows by `script_execution_id` after guarded script update, and deployments by the transitioned `deployment_result_id`. Invoke the same service after effective cancellation/reaper transitions. Recompute device/run aggregates after each effective child change; do not add independent increment counters.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/commands.test.ts src/services/commandResultHandlers.automation.test.ts src/services/softwareDeploymentResult.test.ts src/routes/scripts.test.ts src/jobs/staleCommandReaper.test.ts src/services/automationActionResults.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationTerminalReconciliation.integration.test.ts
git add apps/api/src/routes/agentWs.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/commands.test.ts apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.automation.test.ts apps/api/src/services/softwareDeploymentResult.ts apps/api/src/services/softwareDeploymentResult.test.ts apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.test.ts apps/api/src/jobs/staleCommandReaper.ts apps/api/src/jobs/staleCommandReaper.test.ts apps/api/src/__tests__/integration/automationTerminalReconciliation.integration.test.ts
git commit -m "fix(api): reconcile automation from terminal evidence"
```

### Task 12: Inventory observation schema, tolerant API, and acceptance service (RMM-QA-297)

**Files:**
- Create: `packages/shared/src/types/softwareInventoryObservation.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/api/src/db/schema/software.ts`
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts`
- Create: `apps/api/migrations/2026-09-28-100002-software-inventory-observations.sql`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/inventory.ts`
- Modify: `apps/api/src/routes/agents/inventory.test.ts`
- Create: `apps/api/src/services/softwareInventoryObservations.ts`
- Create: `apps/api/src/services/softwareInventoryObservations.test.ts`
- Create: `apps/api/src/__tests__/integration/softwareInventoryObservations.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.test.ts`
- Modify: `apps/api/src/extensions/tenancyRegistry.test.ts`

**Interfaces:**
- Parser accepts `LegacySoftwareInventoryReport = { software: SoftwareInventoryItem[] }` or the shared discriminated v2 shape.
- Schema concepts: immutable `software_inventory_observations`; one mutable `device_software_inventory_state` per device; nullable `software_inventory.observation_id`; nullable `device_vulnerabilities.resolved_observation_id`.

```ts
ingestSoftwareInventoryReport(input: {
  device: { id: string; orgId: string; agentVersion: string | null };
  report: LegacySoftwareInventoryReport | SoftwareInventoryObservationV2;
  receivedAt: Date;
}): Promise<{
  observationId: string;
  acceptedForInventory: boolean;
  absenceResolutionEligible: boolean;
  reasonCode: string;
  visibleItemCount: number;
}>;
```

- The service owns existing ordered vulnerability-row locking/relink behavior. Rejected evidence is retained but never deletes/reinserts visible inventory. Duplicate observation IDs are idempotent and cannot bind to another device/org.

- [x] **Step 1: Reverify migration ordering and write parser/acceptance RED**

Cover legacy non-empty before v2, legacy empty retention, legacy after first v2, accepted complete v2, partial/failed/truncated retention, duplicate ID, cross-device collision, out-of-order evidence, source-set change, and the exact collapse threshold: prior count >=50, new count <10%, unchanged sources -> `rejected_count_collapse`.

- [x] **Step 2: Write locking/link and real-PostgreSQL RED**

Prove an accepted replacement preserves ordered vulnerability lock/relink behavior; rejected evidence leaves visible inventory and links byte-identical. Prove forced RLS, denied observation UPDATE, cascade/restamp/export registration, evidence FKs, and device `FOR KEY SHARE` before hot child insert.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/inventory.test.ts src/services/softwareInventoryObservations.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/softwareInventoryObservations.integration.test.ts
```

Expected: legacy empty currently wipes inventory and no observation contract exists.

- [x] **Step 4: Add additive evidence/projection storage and acceptance**

Enable/force RLS and register all tables/columns. Classify source arrays/raw items as `excludedOpen`; keep acceptance/reason fields included. Move wipe/reinsert plus vulnerability locking/relink behind acceptance. Legacy non-empty updates visible inventory only before an accepted v2 projection; legacy empty never deletes. A short transaction locks the device before observation insert and does not update `devices`.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/agents/inventory.test.ts src/services/softwareInventoryObservations.test.ts src/services/tenantCascade.test.ts src/extensions/tenancyRegistry.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/softwareInventoryObservations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
bash scripts/check-migration-naming.sh
pnpm db:check-drift
git add packages/shared/src/types/softwareInventoryObservation.ts packages/shared/src/types/index.ts apps/api/src/db/schema/software.ts apps/api/src/db/schema/vulnerabilityManagement.ts apps/api/migrations apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/inventory.ts apps/api/src/routes/agents/inventory.test.ts apps/api/src/services/softwareInventoryObservations.ts apps/api/src/services/softwareInventoryObservations.test.ts apps/api/src/__tests__/integration/softwareInventoryObservations.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantCascade.test.ts apps/api/src/extensions/tenancyRegistry.test.ts
git commit -m "fix(db): retain versioned software inventory evidence"
```

### Task 13: Emit v2 software observations from each Go collector (RMM-QA-297)

**Files:**
- Modify: `agent/internal/collectors/software.go`
- Modify: `agent/internal/collectors/software_linux.go`
- Modify: `agent/internal/collectors/software_linux_test.go`
- Modify: `agent/internal/collectors/software_darwin.go`
- Modify: `agent/internal/collectors/software_darwin_test.go`
- Modify: `agent/internal/collectors/software_windows.go`
- Create or modify: `agent/internal/collectors/software_windows_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`

**Interfaces:**
- Adds typed `CollectObservation() (SoftwareInventoryObservationV2, error)` while retaining `Collect() ([]SoftwareItem, error)` for change tracking, feature CLI, and uninstall post-condition callers.
- Source identities and failure codes are stable constants. Every platform has a 5,000-item bound and reports `truncated = true` when hit.
- Completeness is `failed` when all applicable sources fail, `partial` when some fail or truncation occurs, and `complete` only when all applicable sources succeed without truncation.

- [x] **Step 1: Write per-platform RED tests**

Assert expected/succeeded/failed source identities/codes, all/some/no failure completeness, 5,000 cap including Windows, `itemCount === len(items)`, UUID observation identity unique per collection, and timestamp/collector version.

- [x] **Step 2: Write compatibility-caller RED tests**

Prove existing uninstall verification, change tracking, and test-feature callers retain the slice/error API and cannot treat partial evidence as proof of absence. Prove only `sendSoftwareInventory` uploads v2.

- [ ] **Step 3: Run RED**

```bash
(cd agent && go test -race ./internal/collectors ./internal/heartbeat)
```

Expected: collectors return only items/error and cap/source evidence is not on the wire.

- [x] **Step 4: Implement typed collection without breaking callers**

Refactor each build-tag collector to return items plus source evidence using constants, then adapt `Collect()` as a compatibility wrapper. Stamp `observedAt` after collection and set `collectorVersion` from the running agent version. Emit v2 only from `sendSoftwareInventory`.

- [x] **Step 5: Run GREEN and commit**

```bash
(cd agent && go test -race ./internal/collectors ./internal/heartbeat)
git add agent/internal/collectors/software.go agent/internal/collectors/software_linux.go agent/internal/collectors/software_linux_test.go agent/internal/collectors/software_darwin.go agent/internal/collectors/software_darwin_test.go agent/internal/collectors/software_windows.go agent/internal/collectors/software_windows_test.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go
git commit -m "fix(agent): report software inventory completeness"
```

### Task 14: Resolve vulnerabilities only from exact accepted evidence (RMM-QA-297)

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts`
- Modify: `apps/api/src/services/vulnerabilityCorrelation.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/vulnerabilityObservationResolution.integration.test.ts`
- No vulnerability API or UI response expansion is authorized in this task; the exact resolving observation remains durable database evidence.

**Interfaces:**
- A finding can resolve by absence only from the device's current latest accepted, complete, nontruncated, noncollapsed v2 observation whose server `receivedAt` is later than `detectedAt`.
- Resolution writes that exact observation ID to `resolvedObservationId` in the same guarded update. Positive detection from visible inventory remains independent of absence eligibility.

- [x] **Step 1: Write evidence-gating RED**

Assert partial, failed, truncated, collapsed, legacy, and stale observations cannot resolve by absence. Assert a current complete accepted observation received after detection resolves the absent finding and records its exact ID; one device cannot resolve another; a newer rejected observation authorizes nothing; reruns are idempotent and preserve the original resolving ID.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelation.integration.test.ts src/__tests__/integration/vulnerabilityObservationResolution.integration.test.ts
```

Expected: correlation currently resolves unmatched open software findings without accepted observation evidence.

- [x] **Step 3: Gate the absence update**

Join each candidate to `device_software_inventory_state`, require its latest accepted observation and `absenceResolutionEligible`, compare server `receivedAt > detectedAt`, and set `resolvedObservationId` atomically with resolved status/time. Leave positive correlation against visible inventory unchanged.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelation.integration.test.ts src/__tests__/integration/vulnerabilityObservationResolution.integration.test.ts src/__tests__/integration/softwareInventoryObservations.integration.test.ts
git add apps/api/src/services/vulnerabilityCorrelation.ts apps/api/src/services/vulnerabilityCorrelation.integration.test.ts apps/api/src/__tests__/integration/vulnerabilityObservationResolution.integration.test.ts
git commit -m "fix(api): require inventory evidence for resolution"
```

## Serialization and dependency contract

```text
Task 1 -> Task 2 -> Task 3

Task 4
Task 5 -> Task 6

Task 7 -> Task 8
Task 9 -> Task 10 -> Task 11

Task 12 -> Task 13
Task 12 -> Task 14
```

Tasks 1, 4, 5, 7, 9, and 12 are behaviorally independent, but execution in this shared worktree remains serialized. In particular, only one task at a time may modify each collision zone:

- `packages/shared/src/types/index.ts`;
- `apps/api/src/db/schema/index.ts` and migration lexical ordering;
- tenant cascade, device cascade/restamp, RLS coverage, and tenant export registries/tests;
- `apps/api/src/routes/agents/schemas.ts` and heartbeat producers.

Prefer schema/tolerant reader before producer: Tasks 5, 9, and 12 before Tasks 6, 10–11, and 13. Within each dependency chain, do not hand later tasks to an implementer until the prior checkpoint is committed and independently verified by the controller.

## Track completion verification

Run from the repository root. Load `.env.test` when the local integration stack requires it, and capture output proving each named file executed.

### Targeted TypeScript, web, and Go suites

```bash
pnpm --filter @breeze/shared exec vitest run src/constants/index.test.ts
pnpm --filter @breeze/api exec vitest run \
  src/routes/devices/options.test.ts \
  src/routes/devices/options.mountorder.test.ts \
  src/routes/agents/enrollment.test.ts \
  src/routes/agents/heartbeat.test.ts \
  src/routes/agents/schemas.heartbeatTolerance.test.ts \
  src/services/agentHealthObservations.test.ts \
  src/services/scriptExecution.admission.test.ts \
  src/routes/scripts.test.ts \
  src/routes/mobile.test.ts \
  src/routes/remediationSuggestions.test.ts \
  src/services/automationActionResults.test.ts \
  src/services/automationRuntime.runScript.test.ts \
  src/services/automationRuntime.deploySoftware.test.ts \
  src/services/automationRuntime.test.ts \
  src/services/commandResultHandlers.automation.test.ts \
  src/services/softwareDeploymentResult.test.ts \
  src/jobs/staleCommandReaper.test.ts \
  src/services/softwareInventoryObservations.test.ts \
  src/routes/agents/inventory.test.ts
pnpm --filter @breeze/web exec vitest run \
  src/hooks/useDeviceOptions.test.tsx \
  src/components/filters/DeviceOptionPicker.test.tsx \
  src/components/filters/DeviceTargetSelector.test.tsx \
  src/components/scripts/ScriptExecutionModal.test.tsx \
  src/components/scripts/ScriptsPage.test.tsx \
  src/components/scripts/ScriptExecutionsPage.test.tsx
(cd agent && go test -race ./internal/health ./internal/heartbeat ./internal/collectors)
```

### Real PostgreSQL, RLS, cascade, and export suites

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceOptions.integration.test.ts \
  src/__tests__/integration/enrollmentReachability.integration.test.ts \
  src/__tests__/integration/agentHealthObservations.integration.test.ts \
  src/__tests__/integration/scriptAdmission.integration.test.ts \
  src/__tests__/integration/automationActionResults.integration.test.ts \
  src/__tests__/integration/automationTerminalReconciliation.integration.test.ts \
  src/__tests__/integration/softwareInventoryObservations.integration.test.ts \
  src/__tests__/integration/vulnerabilityObservationResolution.integration.test.ts

pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts

pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```

### Migration, type, and full relevant suites

```bash
bash scripts/check-migration-naming.sh
pnpm db:check-drift
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/shared typecheck
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/web exec astro check
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
(cd agent && go test -race ./...)
git diff --check 80b498ecee73bb1c3f5f58e47dce65a016dc892c..HEAD
```

## Evidence and closure boundary

Passing code tests makes Track B code-complete; it does not by itself make the six findings fixed-verified. Preserve candidate-bound evidence for:

- selector fixtures from 0 through 10,000 devices, including early/middle/final matches, cursor completeness, and delayed stale-scope races;
- two-partner/two-org/two-site real-PostgreSQL authorization matrices with known-valid foreign IDs and literal zero-side-effect assertions;
- script/automation admission, delivery, terminal, timeout, cancellation, duplicate, and reordered results through both HTTP and WebSocket transports;
- old-agent omission for health and legacy inventory;
- Linux, macOS, and Windows collector evidence from the exact candidate agent artifacts, including truncation/source failures;
- database lock/pool evidence for concurrent enrollment, heartbeat, health, and inventory writes, including zero `40P01` errors;
- CI shard log lines proving every new integration suite actually executed.

Until those packets pass against the exact shipping commit and artifacts, report RMM-QA-012, 039, 105, 212, 297, and 319 as `code-complete` or `fixed-unverified`, not `fixed`. This plan authorizes no production deployment or hosted-fleet rollout.
