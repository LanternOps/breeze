---
tracking_issue: LanternOps/breeze#10725
---

# Org-Subject Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an alert be owned by a device, a topology site or a SaaS backup workload, so device-less conditions get the normal alert pipeline without any device-centric consumer widening, merging or leaking.

**Architecture:** `alerts.device_id` becomes nullable and two columns, `owner_kind` and `owner_ref`, name the owner. A CHECK pins legal combinations and a partial unique index gives each non-device owner one open alert. Making `alerts.deviceId` nullable in the Drizzle schema turns every device-assuming consumer into a type error. Each one is fixed with an explicit guard from the spec's consumer table (G1–G12).

**Tech Stack:** PostgreSQL (hand-written migration), Drizzle (queries only), Hono, BullMQ, Vitest (unit + real-DB integration), React (W2).

**Spec:** `docs/superpowers/specs/monitoring/2026-10-29-org-subject-alerts-design.md` (approved 2026-10-29)

## Global Constraints

- **Owner kinds** are exactly `'device' | 'topology_site' | 'backup_workload'`, stored as `varchar(30)` with a CHECK, never a pg enum.
- **Owner ref for `backup_workload`** is `backup_provider_devices.id` as text, with no FK.
- **Open statuses** are `('active', 'acknowledged', 'suppressed')`, the same set `alerts_open_rule_device_subject_uidx` uses.
- **Skip reason** for any device-only consumer that meets a device-less alert is the literal `alert_has_no_device`.
- **Site-restricted callers** never see `backup_workload` alerts (decision 1). `topology_site` alerts follow `topology_site_id`.
- **Org-level alerts are sourced only.** They never go through `createAlert`, alert rules, cooldowns or maintenance windows (decision 2).
- **Migration rules:**
  - Sort after the newest committed migration (today `2027-01-16-200000-*`), and re-check `origin/main` before the final push.
  - Idempotent, with no `BEGIN`/`COMMIT`.
  - Write rows only after `SELECT set_config('breeze.scope', 'system', true);`.
  - Then run `pnpm db:check-drift`.
- **Locales:** a new web locale key goes into all 8 locales.
- **Tenancy suites:** org-cascade, merge and export suites run only under Integration Tests. Run them locally with `pnpm test-stack up` before the PR.
- **Typecheck command:** `NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --build tsconfig.tests.json`. Check the exit code; never pipe it to `tail`.

## Review Focus

1. **A partner-wide `alert.triggered` automation receives a device-less alert.** Expected: it runs on no device and is skipped with `alert_has_no_device`. Pinned by Task 3, test `skips a partner-wide alert automation for a device-less alert`.
2. **Two sync runs race to raise the same workload alert.** Expected: one open alert, and the loser returns `null` without publishing. Pinned by Task 2, real-DB test `second open backup_workload alert for the same owner is rejected`.
3. **A site-restricted technician with an empty site list.** Expected: they see no `backup_workload` alert and no topology alert. Pinned by Task 4, test `empty allowlist sees no org-level alerts`.
4. **A channel with a throttle receives device-less alerts for two different workloads.** Expected: each workload has its own budget, so one does not starve the other. Pinned by Task 5, test `throttles device-less alerts per owner`.
5. **Deleting the origin device of a topology alert.** Expected: the alert survives with `device_id = NULL`, and its notifications and correlations stay. Pinned by Task 11 (W4), test `preserves topology_site alerts when the origin device is deleted`.

---

## Wave 1: Foundation and guards (full rigor)

No producer creates device-less alerts in this wave. Every task is a red test first.

### Task 1: Migration, schema and owner-key helper

**Files:**
- Create: `apps/api/migrations/2027-01-17-120000-alerts-owner-kind.sql`
- Modify: `apps/api/src/db/schema/alerts.ts` (the `alerts` table, around line 131)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:214` (add `owner_kind` and `owner_ref` to `alerts.included`)
- Create: `apps/api/src/services/alertOwner.ts`
- Test: `apps/api/src/services/alertOwner.test.ts`
- Test: `apps/api/src/__tests__/integration/alertsOwner.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AlertOwnerKind = 'device' | 'topology_site' | 'backup_workload';
  export interface AlertOwnerFields {
    ownerKind: AlertOwnerKind; ownerRef: string | null; deviceId: string | null;
    topologySiteId: string | null; topologySourceKey: string | null;
  }
  /** Stable identity for throttles and logs. Throws on an illegal combination. */
  export function alertOwnerKey(alert: AlertOwnerFields): string;
  export function isDeviceOwned(alert: Pick<AlertOwnerFields, 'deviceId'>): alert is { deviceId: string };
  ```
- Schema: `deviceId: uuid('device_id').references(() => devices.id)` (nullable). Add `ownerKind: varchar('owner_kind', { length: 30 }).$type<AlertOwnerKind>().notNull().default('device')` and `ownerRef: varchar('owner_ref', { length: 128 })`.

- [ ] **Step 1: Write the failing unit tests** in `alertOwner.test.ts`.
  - `alertOwnerKey` returns `device:d1` for a device owner.
  - It returns `topology:s1:k1` for `{ownerKind:'topology_site', topologySiteId:'s1', topologySourceKey:'k1'}`, whether `deviceId` is set or `null`.
  - It returns `backup_workload:r1` for `{ownerKind:'backup_workload', ownerRef:'r1', deviceId:null}`.
  - It throws for `{ownerKind:'device', deviceId:null}`.
  - It throws for `{ownerKind:'backup_workload', ownerRef:null}`.
- [ ] **Step 2: Write the failing real-DB tests** in `alertsOwner.integration.test.ts`.
  - **CHECK constraint.** An insert of `owner_kind='backup_workload'` with `device_id` set fails with `23514`. An insert of `owner_kind='device'` with `device_id NULL` fails with `23514`.
  - **Unique index.** A second `active` `backup_workload` alert with the same `(org_id, owner_ref)` fails with `23505`. A second alert after the first one is `resolved` succeeds.
  - **Backfill.** An existing row with `topology_site_id` set reads `owner_kind='topology_site'` after migrate.
  - **RLS.** An org-B context cannot read an org-A `backup_workload` alert.
- [ ] **Step 3: Run both** with `pnpm test-stack up`, then `pnpm --filter @breeze/api exec vitest run src/services/alertOwner.test.ts` and the integration file through the command in `docs/agents/testing.md`. Expected: FAIL (module missing, columns missing).
- [ ] **Step 4: Write the migration**, using the spec's SQL verbatim, with these additions:
  - `set_config('breeze.scope','system',true)` before the backfill.
  - Drop and re-add `alerts_owner_chk` so the migration is idempotent.
  - `WHERE ... status IN ('active','acknowledged','suppressed')` on `alerts_open_owner_uidx`.

  Then update the schema and the export policy, and implement `alertOwner.ts`.
- [ ] **Step 5: Run the tests and `pnpm db:check-drift`.** Expected: PASS, no drift.
- [ ] **Step 6: Commit:** `feat(alerts): owner_kind/owner_ref and nullable device_id (W1)`.

### Task 2: `createSourcedAlert` accepts an org-level owner

**Files:**
- Modify: `apps/api/src/services/alertService.ts:134-160` (publish helper), `:383-420` (params), `:442-505` (body)
- Modify: every other `insert(alerts)` call site (the nine paths in the spec) to set `ownerKind` explicitly
- Test: `apps/api/src/services/alertService.test.ts`
- Test: `apps/api/src/__tests__/alertInsertOwnerKind.contract.test.ts`
- Test: extend `alertsOwner.integration.test.ts`

**Interfaces:**
- Consumes: `AlertOwnerKind` (Task 1).
- Produces:
  ```ts
  export type SourcedAlertOwner = { kind: 'backup_workload'; ref: string };
  // CreateSourcedAlertParams becomes a union:
  //   { deviceId: string; owner?: undefined; ... }  |  { deviceId: null; owner: SourcedAlertOwner; ... }
  ```
  The published `alert.triggered` payload gains `owner: { kind, ref } | null` and `ownerKey: string`. `publishAlertTriggeredOrRollback` takes `deviceId: string | null`.

- [ ] **Step 1: Write the failing tests.**
  - An owner alert inserts `owner_kind='backup_workload'`, `owner_ref=ref`, `device_id=null`.
  - It publishes with `siteId: null` and `deviceId: null`, plus `owner` and `ownerKey: 'backup_workload:<ref>'`.
  - It does **not** call `resolveDeviceSiteId` or `enqueueAlertCorrelationForDevice` (G7).
  - **Real-DB test `second open backup_workload alert for the same owner is rejected`:** two concurrent calls with the same owner return one id and one `null`, and only one `alert.triggered` is published.
  - **Contract test:** every non-test `src/**/*.ts` that contains `.insert(alerts)` or `INSERT INTO alerts` sets `ownerKind`/`owner_kind` within that statement. The test fails on the current tree and lists the offending files.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The owner branch inserts with `.onConflictDoNothing({ target: [alerts.orgId, alerts.ownerKind, alerts.ownerRef], where: sql\`owner_kind NOT IN ('device','topology_site') AND status IN ('active','acknowledged','suppressed')\` })`.
  - No returned row means a duplicate: return `null` without publishing or reporting to Sentry.
  - Device inserts and the nine direct paths set `ownerKind: 'device'`. `topology/monitoringAlerts.ts` sets `'topology_site'`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(alerts): sourced alerts may be owned by a backup workload (W1)`.

### Task 3: G1 automation targeting (lands before any later task merges)

**Files:**
- Modify: `apps/api/src/jobs/automationWorker.ts:835-945` (the event-trigger binding block)
- Modify: `apps/api/src/services/flows/eventTrigger.ts` (only if the audit finds device fan-out)
- Test: `apps/api/src/jobs/automationWorker.test.ts`

**Interfaces:**
- Produces the trigger result `{ skipped: 'alert_has_no_device' }`.

- [ ] **Step 1: Write the failing tests**, each with an `alert.triggered` payload `{ alertId, deviceId: null, owner: { kind: 'backup_workload', ref } }`.
  - `skips an org alert automation for a device-less alert`: no conditions, no trigger deviceIds. Expected `{ skipped: 'alert_has_no_device' }`, and the runtime is not invoked.
  - `skips a partner-wide alert automation for a device-less alert`: `orgId: null, partnerId: P`. Same expectation.
  - `skips an automation with explicit device targets`: `conditions.type='devices'`. Same expectation, so device actions never run on a static set from an org-level alert.
  - **Control:** the same automation with `deviceId: D` still binds `[D]`.
- [ ] **Step 2: Run them.** Expected: the first three FAIL, because the runtime falls through to static targets.
- [ ] **Step 3: Implement.** Immediately after `shouldTriggerEventAutomation`, add:

  > If `data.eventType` starts with `alert.` and `typeof payload.deviceId !== 'string'`, return `{ skipped: 'alert_has_no_device' }` and log the automation id.

  **Plan decision (narrower than spec G1):** v1 skips the whole automation, not just its device actions. Org-level notifications already reach channels through delivery routing, not automations. Running notify-only automations for org alerts is a follow-up.

  Audit `flows/eventTrigger.ts` for device fan-out and apply the same rule if it has any. Record the finding in the PR body.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `fix(automation): never resolve device targets from a device-less alert (G1)`.

### Task 4: G5 site scope fails closed

**Files:**
- Modify: `apps/api/src/routes/alerts/helpers.ts:61-74` (`alertSiteScopeCondition`) and `:205-219` (by-id gate)
- Modify: `apps/api/src/routes/tickets/siteScope.ts:~50`, `apps/api/src/routes/mobile.ts:~421`, `apps/api/src/services/aiToolsAlerts.ts:102-117`, `apps/api/src/services/aiToolsFleet.ts:~614`
- Test: `apps/api/src/routes/alerts/helpers.test.ts`, plus a real-DB case in `alertsOwner.integration.test.ts`

- [ ] **Step 1: Write the failing tests.** Seed a device alert at site S1, a topology alert owned by S1, and a `backup_workload` alert.
  - **Allowlist `[S1]`:** sees the first two, not the workload alert.
  - **Test `empty allowlist sees no org-level alerts`:** allowlist `[]` sees none of the three.
  - **Unrestricted (`undefined`):** sees all three.
  - **By-id read** of the workload alert as `[S1]` returns `null`.
- [ ] **Step 2: Run them.** Expected: FAIL, because the `isNull(alerts.deviceId)` arm is fail-open.
- [ ] **Step 3: Implement.**
  - Restricted callers match only `(topology_site_id IN allowed)` OR `(topology_site_id IS NULL AND device_id IS NOT NULL AND devices.site_id IN allowed)`. An empty allowlist matches nothing.
  - Update the doc comment, which currently says "deviceless alerts are org-wide".
  - Apply the same rule at each listed site.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `fix(alerts): site-restricted callers fail closed on org-level alerts (G5)`.

### Task 5: G4 notification throttle and G6 delivery routing

**Files:**
- Modify: `apps/api/src/services/notificationDispatcher.ts:~648-665`
- Test: `apps/api/src/services/notificationDispatcher.test.ts`, `apps/api/src/services/delivery/resolveDelivery.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `throttles device-less alerts per owner`: a channel with cap 1. Workload alerts for ref A and ref B both send. A second alert for A is throttled. The throttle key equals `alertOwnerKey(alert)`.
  - **Delivery routing:** a rule with a site filter does not match a `backup_workload` alert, and a rule without one does. This pins the current behaviour.
- [ ] **Step 2: Run them.** Expected: the throttle test FAILS, because both alerts share `device:null`.
- [ ] **Step 3: Implement.** Replace `` `device:${alert.deviceId}` `` with `alertOwnerKey(alert)`, and select `ownerKind`, `ownerRef` and the topology columns wherever the dispatcher loads the alert. Device alerts keep the key `device:<id>`, so existing buckets are unchanged.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `fix(notifications): throttle by alert owner, not device (G4)`.

### Task 6: Nullable `deviceId` sweep (G3, G7, G8, G11 and everything tsc finds)

**Files:**
- Modify: every file `tsc` flags after Task 1, including at least:
  - `apps/api/src/jobs/alertCorrelation.ts:~434`
  - `apps/api/src/services/alertCorrelationRca.ts`
  - `apps/api/src/services/aiAgents/alertVerdictSubscriber.ts:~201`
  - `apps/api/src/services/alertCooldown.ts` callers
- Test: alongside each touched file

- [ ] **Step 1: Run the Global Constraints typecheck** and save the error list to the PR body. Each error is classified as one of:
  - (a) **Rule-only path.** It is reached only by `createAlert` or a rule. Narrow with `isDeviceOwned`, and throw `alert_has_no_device` if the guard is ever hit.
  - (b) **Skippable consumer.** Skip, and log the reason `alert_has_no_device`.
  - (c) **Display.** Pass `null` through.

  No `!` non-null assertions are allowed.
- [ ] **Step 2: Write the failing tests** for each consumer in class (b).
  - **Verdict subscriber:** for a device-less alert it logs `{ reason: 'alert_has_no_device' }` and never calls `loadDeviceContext`.
  - **Correlation:** a device-less alert is never a correlation candidate.
  - **RCA text:** it never renders the string `null`.
  - **G11:** a device org move leaves a `backup_workload` alert's `org_id` unchanged. This is a real-DB test.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement** the guards until `tsc` exits 0.
- [ ] **Step 5: Run the API unit suite and the touched tests.** Expected: PASS.
- [ ] **Step 6: Commit:** `fix(alerts): explicit guards for every device-assuming consumer (W1)`.

### Task 7: Device-less consumer contract test and pre-PR gates

**Files:**
- Create: `apps/api/src/__tests__/integration/deviceLessAlertConsumers.integration.test.ts`

- [ ] **Step 1: Write the test.** It inserts one `backup_workload` alert through `createSourcedAlert` and drives it through:
  - The alert list and by-id routes, as unrestricted and as site-restricted callers.
  - The notification dispatcher's prepare step.
  - `processTriggerEvent` for an org automation and a partner-wide automation.
  - The verdict subscriber.
  - Correlation enqueue.
  - Deleting an unrelated device.
  - The Partner API alert feed and webhook enrichment (these must return `deviceId: null` without throwing).

  It asserts each outcome from the spec table.
- [ ] **Step 2: Run it.** Expected: PASS, because Tasks 1–6 are in. If anything fails, that is a missed guard: fix it in the owning task's file, red first.
- [ ] **Step 3: Run the full API suite and the org-cascade, merge and export contract suites locally.** Expected: PASS.
- [ ] **Step 4: Commit, then open the PR** with `Closes #<W1 sub-issue>`. The body must include:
  - the tsc error classification;
  - the flows audit result;
  - the G1 plan decision.

---

## Wave 2: Surfaces (G9, G12)

### Task 8: Templates and payloads (G9)

**Files:** `apps/api/src/services/notificationDispatcher.ts:~738-742`, the event payload builders that read the alert, and `packages/shared/src/types/` (alert DTOs gain `ownerKind`, `ownerLabel` and `subjectName`)

**Changes:**
- Template fields gain `ownerKind`, `ownerLabel` and `subjectName`. `{{device}}` renders `subjectName` when there is no device.
- `subjectName` for `backup_workload` is the D5 workload label plus the customer name. The workload label uses `portalShowProviderName` rules for portal-facing text.

**Tests:**
- An email or webhook rendered for a workload alert contains `"Microsoft 365 mail backup"` and never contains `"null"`.
- The Partner API DTO includes `owner`.

**Commit:** `feat(alerts): owner-aware notification templates and payloads (W2)`.

### Task 9: Web UI (G12)

**Files:**
- `apps/web/src/components/alerts/AlertDetailPage.tsx`
- `AlertDeviceInfo.tsx`
- `AlertList.tsx`
- `AlertsPage.tsx`
- `CorrelatedAlertGroups.tsx`
- `AlertsFeed.tsx`
- `OrgOverviewTab.tsx`
- New: `AlertSubjectChip.tsx`
- Locales: all 8

**Changes:**
- For non-device owners, render a subject chip instead of the device block, and link to backup health (`/backup#health`) or to the topology site.
- Hide device actions (DelegateToOperator, the device filter) for non-device owners.
- Verify mobile is null-safe; this is a check, not a change.

**Tests:**
- Component tests: no `href` contains `/devices/null`, and no device action renders for a workload alert.
- Playwright E2E (`data-testid` only): the alert list and the detail page for a seeded workload alert.

**Commit:** `feat(web): render alerts that are not about a device (W2)`.

---

## Wave 3: SaaS backup producer

### Task 10: Raise `backup_workload` alerts from backup-provider sync

**Files:**
- `apps/api/src/services/backupProviders/alerts.ts:~250-310`
- `docs/release-notes/next-release-draft.md` (append under its own heading)
- `apps/docs` backup page

**Changes:**
- For SaaS rows (`accountType` in `m365`, `gws`) that are mapped to an org and in the `raised` phase, call `createSourcedAlert` with:
  - `deviceId: null`
  - `owner: { kind: 'backup_workload', ref: row.id }`
  - `context: { source: BACKUP_PROVIDER_ALERT_SOURCE, providerDeviceId: row.id, condition }`. This is the same context shape endpoint alerts use, so the existing `alertsResolve.ts` paths close it unchanged.
  - Title: `"<Workload label> backup <condition> — <customer/org name>"`.
- Remove the "SaaS rows get events only" branch.
- The `backup.provider_device_*` events are unchanged.
- Cove M365 rows are included (decision 3).

**Tests:**
- Two-poll hysteresis raises exactly one alert.
- A cleared condition resolves it.
- Deleting the row resolves it.
- An unmapped customer raises nothing.
- A condition change (stale → failed) updates the open alert instead of opening a second one: assert exactly one open row for the owner.

**Commit:** `feat(backup): SaaS backup failures raise alerts (W3)`.

---

## Wave 4: Topology preservation (#7269)

### Task 11: Keep `topology_site` alerts when the origin device is deleted (G10)

**Files:**
- `apps/api/src/services/deviceDeletion.ts:~275-300` (`deleteOriginDeviceTopologyAlerts`)
- The topology alert UI link in the W2 components

**Changes:**
- Replace the delete with `UPDATE alerts SET device_id = NULL WHERE owner_kind = 'topology_site' AND device_id = $1`.
- Exclude those rows from `deviceAlertIds` so their notifications, correlations and PSA mappings survive.
- The caller's audit count becomes "detached".

**Tests:**
- Real-DB test `preserves topology_site alerts when the origin device is deleted`: the row, its `alert_notifications` and its `alert_correlations` remain, and `device_id` is NULL.
- Device-owned alerts are still deleted.
- The org-cascade suite passes.

**Commit:** `fix(topology): device deletion keeps site-owned alert history (#7269)`.

---

## Wave order

W1 merges first; Task 3 lands even if the rest of W1 slips. W2 and W4 can then run in parallel. W3 needs W1 and W2.
