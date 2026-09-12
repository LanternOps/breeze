---
tracking_issue: LanternOps/breeze#5650
---
# Fleet Designer W03: Apply and Rollback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician approves a Fleet Design section by section, sees exactly what will be created, retired and displaced, applies it, and can roll it back — the clean-slate migration as a product step.

**Architecture:** `rationale` columns land on `config_policy_alert_rules`, `config_policy_monitoring_watches` and `alert_templates`, threaded through the inline-settings validators and the decompose/assemble paths so a rationale survives every save. A new shape-1 table `fleet_design_applied_items` is the apply ledger: one row per applied item ref with the ids it created and a before-image, `UNIQUE (report_run_id, item_ref)` for idempotency. `services/fleetDesign/apply.ts` runs the numbered steps under the request's ambient transaction, each step in its own savepoint (`db.transaction` nests as `SAVEPOINT` inside `withDbAccessContext`), so a failure in step N leaves steps < N applied and recorded. Function policies target one static device group per function at `device_group` level with NULL role/OS filters; because a group-level assignment out-ranks site/org/partner assignments for the same feature type (`configurationPolicy.ts:2237-2247`), the preview evaluates `resolveEffectiveConfig` for every device in the group and lists each policy the new one displaces for explicit approval. Rollback reverses the ledger in reverse order and refuses any item whose objects changed since apply (state comparison against the ledger snapshot, not `updated_at`). The web adds the Fleet Design page with the section viewer, the apply drawer (diff → confirm → result) and Rollback.

**Tech Stack:** PostgreSQL + hand-written SQL migration, Drizzle, Hono + Zod, Vitest, React + Astro + react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md` §4.6, §4.8 (steps 1, 2, 3, 5; step 4 is W04), §4.10 (apply/rollback routes, Fleet Design page), §4.11, §4.13, §4.14; index amendments 7, 8, 9, 15, 16. Advisor quorum (D1, D3, 2026-09-12): agree with amendments, all adopted: ledger table with before-images; displacement preview; NULL filters on Fleet Design assignments; group identity persisted in the ledger and reused per (org, function); role-correction precedence over discovery.

## Global Constraints

- Migration `2026-10-15-180300-fleet-design-apply.sql`: idempotent, DDL only, no inner transaction; RLS enabled + forced + four shape-1 policies on the ledger in the same file. `fleet_design_applied_items.report_run_id → report_runs(id) ON DELETE CASCADE` (erasure pre-clears report runs; a NO ACTION FK would abort it).
- Register the ledger in the same PR: `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical: after `fleet_design_…` nothing exists yet, so it sorts before `fleet_findings`), `CORE_TENANT_EXPORT_POLICY` (`created_refs`, `before_image` → `excludedOpen`), `orgMergeRegistry.ts` `REPOINT_TABLES`. `alert_templates.rationale` → `included` in the export policy; the two `config_policy_*` tables are not in the cascade list and need no entry.
- Apply and rollback require `devices:write` + MFA and an org-unrestricted site authority (`permissions.allowedSiteIds === null`); a site-restricted user gets 403 `site_restricted`. Scripts (W04) additionally require `scripts:write`.
- Every existing guard stays: `createConfigPolicy` owner union, `updateConfigPolicy(auth)` partner-wide checks, `assignPolicy`'s `onConflictDoNothing`, `validateManualMembershipDevices` before memberships, `deviceGroupDelete.ts`'s child/billing/quote guards on rollback.
- Never swallow a unique-violation inside the ambient transaction (it aborts the request at COMMIT); use `onConflictDoNothing` + null checks, exactly as `assignPolicy` does.
- Fleet Design assignments: level `device_group`, `priority: 100`, `roleFilter: undefined`, `osFilter: undefined`.
- Tests: `cd apps/api && npx vitest run <path>`; the apply integration suite runs on the test stack; run the whole unit suite before the PR.
- Web mutations through `runAction`; new i18n keys in all 8 locales; `Sidebar.nav.test.tsx` updated for the new AI entry.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `feature/5650-fleet-designer/wave-5653`; PR body `Closes #5653`. `get_feature_status` first.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-180300-fleet-design-apply.sql` | `rationale` columns; `fleet_design_applied_items` (Task 1) |
| `apps/api/src/db/schema/configurationPolicies.ts`, `alerts.ts`, `fleetDesignAppliedItems.ts` (new), `schema/index.ts` | Drizzle (Task 1) |
| `tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | registrations (Task 1) |
| `packages/shared/src/validators/index.ts:1024-1037`, `:1059-1081`; `apps/api/src/services/configurationPolicy.ts:701-720`, `:1188-1360` | `rationale` through validate → decompose → assemble (Task 2) |
| `packages/shared/src/types/fleetDesignApply.ts`, `validators/fleetDesignApply.ts` | `FleetDesignApproval`, `FleetDesignApplyPreview`, `FleetDesignApplyResult`, `FleetDesignLedgerItem` (Task 3) |
| `apps/api/src/services/fleetDesign/ledger.ts`, `preview.ts`, `apply.ts`, `rollback.ts` (+ tests) | ledger reads/writes; preview; apply steps 1–3, 5; rollback (Tasks 3–5) |
| `apps/api/src/services/deviceFunction.ts` | `restoreDeviceFunction` (Task 5) |
| `apps/api/src/jobs/discoveryWorker.ts:1128` | discovery never overwrites an `ai` role (Task 5) |
| `apps/api/src/routes/fleetDesign.ts` (+ test) | preview, apply, rollback, ledger routes (Task 6) |
| `apps/api/src/__tests__/integration/fleetDesignApply.integration.test.ts` | end-to-end apply/rollback on Postgres (Task 7) |
| `apps/web/src/pages/ai-agents/fleet-design.astro`, `components/fleetDesign/FleetDesignPage.tsx`, `FleetDesignViewer.tsx`, `ApplyDrawer.tsx`, `useDesignSelection.ts`, `lib/api/fleetDesign.ts`, `layout/Sidebar.tsx`, `configurationPolicies/featureTabs/MonitoringTab.tsx`, `AlertRuleTab.tsx`, locales | Fleet Design page, apply drawer, rollback, rationale display (Task 8) |

---

### Task 0: Quorum record

- [ ] **Step 1:** Append to the spec §5: `D1/D3 amendments adopted (W03): fleet_design_applied_items ledger with before-images; displacement preview with per-policy approval; NULL role/OS filters; group ids persisted and reused per (org, function); discovery may not overwrite an 'ai' role.` Commit with the wave's first commit.

### Task 1: Migration, schema, registrations

**Files:**
- Create: `apps/api/migrations/2026-10-15-180300-fleet-design-apply.sql`, `apps/api/src/db/schema/fleetDesignAppliedItems.ts`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:185-201` + `:392+` (add `rationale: text('rationale')`), `apps/api/src/db/schema/alerts.ts:44-64` (same), `schema/index.ts`, `tenantCascade.ts`, `tenantExportPolicyRegistry.ts` (`alert_templates` entry :99 + new entry), `orgMergeRegistry.ts` (`REPOINT_TABLES`)

**Interfaces:**
- Produces: `config_policy_alert_rules.rationale text`, `config_policy_monitoring_watches.rationale text`, `alert_templates.rationale text`; table `fleet_design_applied_items`; Drizzle `fleetDesignAppliedItems`.

- [ ] **Step 1: Migration**

```sql
-- Fleet Designer W03 (spec §4.6, §4.8, §4.11). DDL only; idempotent; no inner txn.

-- 1. Rationale on the objects a design materialises --------------------------
ALTER TABLE config_policy_alert_rules       ADD COLUMN IF NOT EXISTS rationale text NULL;
ALTER TABLE config_policy_monitoring_watches ADD COLUMN IF NOT EXISTS rationale text NULL;
ALTER TABLE alert_templates                 ADD COLUMN IF NOT EXISTS rationale text NULL;

-- 2. The apply ledger --------------------------------------------------------
-- TENANCY: RLS shape 1 (direct org_id). One row per applied item ref; the
-- UNIQUE below is the idempotency key. report_run_id cascades because the
-- org erasure pre-clears report_runs before deleting reports
-- (tenantCascade.ts) — a NO ACTION FK here would abort it.
CREATE TABLE IF NOT EXISTS fleet_design_applied_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations (id),
  report_run_id         uuid NOT NULL REFERENCES report_runs (id) ON DELETE CASCADE,
  item_ref              text NOT NULL,
  item_kind             text NOT NULL,
  status                text NOT NULL DEFAULT 'applied',
  step                  smallint NOT NULL,
  created_refs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_image          jsonb NULL,
  error                 text NULL,
  applied_by_user_id    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  applied_at            timestamptz NOT NULL DEFAULT now(),
  rolled_back_by_user_id uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  rolled_back_at        timestamptz NULL,
  CONSTRAINT fleet_design_applied_items_kind_chk CHECK (item_kind IN ('function', 'policy', 'watch', 'rule', 'retired', 'script', 'role_correction')),
  CONSTRAINT fleet_design_applied_items_status_chk CHECK (status IN ('applied', 'rolled_back', 'failed')),
  CONSTRAINT fleet_design_applied_items_step_chk CHECK (step BETWEEN 1 AND 5),
  CONSTRAINT fleet_design_applied_items_rollback_chk CHECK ((status = 'rolled_back') = (rolled_back_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_design_applied_items_run_ref_uq
  ON fleet_design_applied_items (report_run_id, item_ref);
CREATE INDEX IF NOT EXISTS fleet_design_applied_items_org_run_idx
  ON fleet_design_applied_items (org_id, report_run_id);

ALTER TABLE fleet_design_applied_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_design_applied_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON fleet_design_applied_items;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON fleet_design_applied_items;
DROP POLICY IF EXISTS breeze_org_isolation_update ON fleet_design_applied_items;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON fleet_design_applied_items;
CREATE POLICY breeze_org_isolation_select ON fleet_design_applied_items FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON fleet_design_applied_items FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON fleet_design_applied_items FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON fleet_design_applied_items FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_design_applied_items TO breeze_app;
```

- [ ] **Step 2: Drizzle + registrations**

`fleetDesignAppliedItems.ts` mirrors the SQL (`jsonb('created_refs').$type<FleetDesignCreatedRefs>()`, `jsonb('before_image').$type<FleetDesignBeforeImage | null>()`, `smallint('step')`, checks as `check(...)`). Add `rationale: text('rationale')` to the three tables. Registrations:
- `tenantCascade.ts`: `'fleet_design_applied_items',` in alphabetical position (`localeCompare`: before `fleet_findings`).
- `tenantExportPolicyRegistry.ts`: `"fleet_design_applied_items": tablePolicy("org_id", {"included":["id","org_id","report_run_id","item_ref","item_kind","status","step","error","applied_by_user_id","applied_at","rolled_back_by_user_id","rolled_back_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["created_refs","before_image"]}),` and add `"rationale"` to the `alert_templates` `included` list.
- `orgMergeRegistry.ts` `REPOINT_TABLES`: `"fleet_design_applied_items"` with the comment `// (Fleet Designer W03): plain repoint; UNIQUE (report_run_id, item_ref) cannot collide across orgs because report_run_id is unique.`

- [ ] **Step 3: Verify, commit**

Run: `scripts/check-migration-naming.sh --staged; cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/tenantCascade.test.ts src/services/orgMergeRegistry.test.ts src/services/tenantExportPolicy.test.ts; pnpm db:migrate && pnpm db:check-drift`

```bash
git add apps/api/migrations/2026-10-15-180300-fleet-design-apply.sql apps/api/src/db/schema apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(db): rationale on rules, watches and templates; fleet_design_applied_items ledger"
```

### Task 2: Rationale through validate → decompose → assemble

**Files:**
- Modify: `packages/shared/src/validators/index.ts:1024-1037` (`alertRuleItemSchema`), `:1059-1081` (monitoring watch item)
- Modify: `apps/api/src/services/configurationPolicy.ts:701-720` (`decomposeInlineSettings` alert_rule + monitoring cases), `:1188-1360` (`assembleInlineSettings` alert_rule + monitoring cases)
- Tests: `packages/shared/src/validators/configPolicy*.test.ts` (whichever covers `alertRuleItemSchema` — grep), `apps/api/src/services/configurationPolicy.test.ts`

- [ ] **Step 1: Failing tests**

Shared: `alertRuleItemSchema.parse({ …, rationale: 'x'.repeat(2001) })` fails; `rationale` omitted parses to `undefined`; monitoring watch likewise. API: `addFeatureLink(policyId, 'alert_rule', null, { items: [{ …, rationale: 'because' }] })` inserts `rationale: 'because'`; `listFeatureLinks(policyId)` returns it in `inlineSettings.items[0].rationale`; a watch round-trips the same way.
Run: `cd packages/shared && npx vitest run src/validators; cd ../../apps/api && npx vitest run src/services/configurationPolicy.test.ts` → FAIL on the new cases.

- [ ] **Step 2: Implement**

Add `rationale: z.string().trim().max(2000).nullable().optional(),` to both item schemas. In `decomposeInlineSettings`: `rationale: item.rationale ?? null` in the `alert_rule` values map (:713-720) and in the monitoring watches insert (find the `configPolicyMonitoringWatches` insert in the `monitoring` case). In `assembleInlineSettings`: select `rationale` in both projections and emit it on each item/watch.

- [ ] **Step 3: Run, commit**

```bash
git add packages/shared/src/validators/index.ts apps/api/src/services/configurationPolicy.ts packages/shared/src/validators apps/api/src/services/configurationPolicy.test.ts
git commit -m "feat(config-policy): rationale on alert rule items and monitoring watches, end to end"
```

### Task 3: Shared apply types and the ledger module

**Files:**
- Create: `packages/shared/src/types/fleetDesignApply.ts`, `packages/shared/src/validators/fleetDesignApply.ts` (+ `.test.ts`), barrels
- Create: `apps/api/src/services/fleetDesign/ledger.ts`, `apps/api/src/services/fleetDesign/ledger.test.ts`

**Interfaces:**
- Produces (shared):
```ts
export interface FleetDesignApproval {
  functions: string[];        // functionKeys
  monitoring: string[];       // item refs monitoring:<key>:watch:<n> | monitoring:<key>:rule:<n>
  retired: string[];          // retired:<n>
  automation: string[];       // automation:<key>:script:<n> (W04)
  legacy: string[];           // legacy:<scriptId> (W04, informational)
  roleCorrections: string[];  // deviceIds
  displacementsAccepted: string[]; // policyIds the technician accepts to displace (preview output)
}
export const fleetDesignApprovalSchema: z.ZodType<FleetDesignApproval>;  // every array max 2000, uuid/ref regexes, .strict()
export interface FleetDesignApplyPreview {
  functions: { functionKey: string; label: string; groupId: string | null; groupName: string; deviceCount: number; devicesAdded: string[]; devicesRemoved: string[]; keptManual: number; missingDevices: string[] }[];
  policies: { functionKey: string; policyName: string; watchCount: number; ruleCount: number; displaces: { policyId: string; policyName: string; featureType: 'monitoring' | 'alert_rule'; deviceCount: number }[] }[];
  retired: { itemRef: string; policyId: string; policyName: string; kind: 'watch' | 'rule'; itemName: string; found: boolean; editable: boolean }[];
  roleCorrections: { deviceId: string; hostname: string; from: string; to: string; billingRelevant: true }[];
  alreadyApplied: string[];   // item refs with a ledger row (skipped)
  blockers: { itemRef: string; reason: string }[];
}
export interface FleetDesignApplyResult { applied: string[]; skipped: string[]; partial: { failedStep: number; reason: string } | null; rollbackAvailable: boolean }
export interface FleetDesignLedgerItem { id: string; itemRef: string; itemKind: string; status: 'applied' | 'rolled_back' | 'failed'; step: number; createdRefs: Record<string, unknown>; error: string | null; appliedAt: string; rolledBackAt: string | null }
export type FleetDesignCreatedRefs = { groupId?: string; groupCreated?: boolean; assessmentIds?: string[]; policyId?: string; monitoringLinkId?: string; alertRuleLinkId?: string; assignmentId?: string; linksSnapshot?: { monitoring: unknown; alertRule: unknown }; membershipSnapshot?: string[]; scriptId?: string };
export type FleetDesignBeforeImage = { inlineSettings?: unknown; deviceRole?: string; deviceRoleSource?: string; priorAssessmentIdByDevice?: Record<string, string | null>; memberships?: string[] };
```
- Produces (api `ledger.ts`): `loadLedger(reportRunId, orgId): Promise<FleetDesignLedgerRow[]>`; `recordApplied(row: { orgId; reportRunId; itemRef; itemKind; step; createdRefs; beforeImage; userId })` (insert with `onConflictDoNothing` on `(report_run_id, item_ref)`, returns the row or null when it already existed); `recordFailed(...)` (same, `status: 'failed'`, `error`); `markRolledBack(ids, userId)`; `findReusableGroup(orgId, functionKey): Promise<{ groupId } | null>` (latest `applied` ledger row of kind `function` for this org+ref whose `created_refs.groupId` still exists in `device_groups` for this org); `lockReportRun(reportRunId, orgCondition)` (`SELECT … FROM report_runs JOIN reports … FOR UPDATE OF report_runs`, returns the org id or null).

- [ ] **Step 1: Failing tests** — shared schema (rejects unknown keys and bad refs; accepts an empty approval); ledger (`recordApplied` twice for the same ref returns null the second time and issues no second insert; `findReusableGroup` ignores rolled-back rows and deleted groups; `lockReportRun` includes `FOR UPDATE`).
- [ ] **Step 2: Implement** as specified. `lockReportRun` reads the summary too (`result`) so callers get the `FleetDesignOutcome` in the same round trip.
- [ ] **Step 3: Run, commit**

```bash
git add packages/shared/src apps/api/src/services/fleetDesign
git commit -m "feat(api): fleet design apply types and ledger module"
```

### Task 4: Preview and apply

**Files:**
- Create: `apps/api/src/services/fleetDesign/preview.ts`, `apps/api/src/services/fleetDesign/apply.ts` (+ `.test.ts` each)

**Interfaces:**
- `previewFleetDesignApply(auth: AuthContext, reportRunId: string, approval: FleetDesignApproval): Promise<FleetDesignApplyPreview>`
- `applyFleetDesign(auth: AuthContext, reportRunId: string, approval: FleetDesignApproval): Promise<FleetDesignApplyResult>`
- Consumes: `applyDesignFunctions`, `getDeviceFunction` (W02); `createConfigPolicy`, `updateConfigPolicy`, `addFeatureLink`, `updateFeatureLink`, `listFeatureLinks`, `assignPolicy`, `resolveEffectiveConfig` (`configurationPolicy.ts:273, 612, 1474, 1562, 1697, 1759, 2335` — read each signature before use); `validateManualMembershipDevices`, `addManualGroupMemberships` (`services/groupMembership.ts:802-830` and the validator the groups route calls at `routes/groups.ts:908`); `writeRouteAudit`.

- [ ] **Step 1: Failing unit tests** (Drizzle mock harness; assert service call sequences)

`preview.test.ts`:
```ts
it('lists devices added/removed against a reusable group and counts manual-kept devices', …);
it('computes displaced policies per feature type from resolveEffectiveConfig over the function\'s devices, deduped with device counts', …);
it('marks a retired item not found when the current link no longer has the named watch/rule', …);
it('marks a retired item non-editable when the policy is partner-wide and the caller cannot manage partner-wide policies', …);
it('reports item refs that already have an applied ledger row under alreadyApplied', …);
```
`apply.test.ts`:
```ts
it('refuses a displaced policy that is not in displacementsAccepted (blocker, nothing written)', …);
it('step 1: writes assessments, creates or reuses the group, sets membership to the approved set, records the ledger row with before-image memberships', …);
it('step 2: rewrites the feature link with the watch disabled / the rule removed and records the previous inlineSettings', …);
it('step 3: creates the policy inactive, adds monitoring and alert_rule links with rationale, assigns at device_group priority 100 with null filters, activates, records policy + item rows', …);
it('step 5: updates device_role with source ai, audits each device, records before-image', …);
it('a failure in step 3 leaves step 1 and 2 rows applied, records a failed row with the error, returns partial with failedStep 3', …);
it('re-apply skips refs with applied rows and applies only new ones', …);
```
Run: `cd apps/api && npx vitest run src/services/fleetDesign` → FAIL.

- [ ] **Step 2: `preview.ts`**

```ts
export async function previewFleetDesignApply(auth, reportRunId, approval) {
  const locked = await lockReportRun(reportRunId, auth.orgCondition.bind(auth));
  if (!locked) throw new FleetDesignApplyError('not_found');
  const { orgId, outcome } = locked;
  const ledger = await loadLedger(reportRunId, orgId);
  const applied = new Set(ledger.filter((r) => r.status === 'applied').map((r) => r.itemRef));
  const orgDevices = await loadOrgDeviceIndex(orgId);   // Map<deviceId, { hostname, deviceRole, deviceRoleSource, deviceFunctionSource }>
  const functions = [];
  for (const key of approval.functions) {
    const entry = outcome.sections.functions.find((f) => f.functionKey === key);
    if (!entry) { blockers.push({ itemRef: `functions:${key}`, reason: 'not_in_design' }); continue; }
    const reuse = await findReusableGroup(orgId, key);
    const current = reuse ? await loadGroupMemberDeviceIds(reuse.groupId, orgId) : [];
    const wanted = entry.deviceIds.filter((d) => orgDevices.has(d));
    functions.push({
      functionKey: key, label: entry.label ?? DEVICE_FUNCTION_LABELS[key] ?? key,
      groupId: reuse?.groupId ?? null, groupName: `Fleet Design: ${label}`,
      deviceCount: wanted.length,
      devicesAdded: wanted.filter((d) => !current.includes(d)),
      devicesRemoved: current.filter((d) => !wanted.includes(d)),
      keptManual: wanted.filter((d) => orgDevices.get(d)!.deviceFunctionSource === 'manual').length,
      missingDevices: entry.deviceIds.filter((d) => !orgDevices.has(d)),
    });
  }
  // Displacement: for each function with approved monitoring items, evaluate the
  // CURRENT winner per feature type for every device the group will hold.
  for (const fn of functions) {
    const items = approval.monitoring.filter((ref) => ref.startsWith(`monitoring:${fn.functionKey}:`));
    if (!items.length) continue;
    const displaced = new Map<string, { policyId; policyName; featureType; deviceCount }>();
    for (const deviceId of wantedDevices(fn)) {
      const eff = await resolveEffectiveConfig(deviceId);           // read the real signature at configurationPolicy.ts:2335
      for (const featureType of ['monitoring', 'alert_rule'] as const) {
        const winner = eff.features?.[featureType];
        if (!winner || winner.policyId === undefined) continue;
        const k = `${winner.policyId}:${featureType}`;
        const row = displaced.get(k) ?? { policyId: winner.policyId, policyName: winner.policyName, featureType, deviceCount: 0 };
        row.deviceCount += 1; displaced.set(k, row);
      }
    }
    policies.push({ functionKey: fn.functionKey, policyName: fn.groupName, watchCount, ruleCount, displaces: [...displaced.values()] });
  }
  // retired: resolve each ref against listFeatureLinks(policyId); found = item present; editable = policy org-owned OR canManagePartnerWidePolicies(auth)
  // roleCorrections: from outcome.sections.unsure.roleCorrections filtered by approval, hostname from orgDevices
  return { functions, policies, retired, roleCorrections, alreadyApplied: [...applied].filter(inApproval), blockers };
}
```
The displacement pass is `O(devices)` calls to `resolveEffectiveConfig`; preview is an explicit human action, and the device bound is 2,000. Note the cost in the function docstring.

- [ ] **Step 3: `apply.ts`**

```ts
export async function applyFleetDesign(auth, reportRunId, approval): Promise<FleetDesignApplyResult> {
  const preview = await previewFleetDesignApply(auth, reportRunId, approval);   // re-locks; same transaction
  const unaccepted = preview.policies.flatMap((p) => p.displaces).filter((d) => !approval.displacementsAccepted.includes(d.policyId));
  if (preview.blockers.length || unaccepted.length) throw new FleetDesignApplyError('blocked', { blockers: preview.blockers, unaccepted });
  const { orgId, outcome } = /* from the lock */;
  const applied: string[] = []; const skipped = [...preview.alreadyApplied];
  const steps: Array<[number, () => Promise<void>]> = [
    [1, () => stepFunctions(ctx)], [2, () => stepRetire(ctx)], [3, () => stepMonitoring(ctx)], [5, () => stepRoleCorrections(ctx)],
  ];
  for (const [n, run] of steps) {
    try {
      await db.transaction(async () => { await run(); });   // SAVEPOINT inside the request transaction
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await recordFailed({ orgId, reportRunId, itemRef: `step:${n}`, itemKind: stepKind(n), step: n, error: reason, userId: auth.user.id });
      return { applied, skipped, partial: { failedStep: n, reason }, rollbackAvailable: applied.length > 0 };
    }
  }
  return { applied, skipped, partial: null, rollbackAvailable: applied.length > 0 };
}
```
Step bodies:
- `stepFunctions`: per approved function (skip if `functions:<key>` applied): `applyDesignFunctions({ orgId, reportRunId, runId: outcome-run id from the report summary, userId, functions: [entry] })`; group: reuse or `db.insert(deviceGroups).values({ orgId, name, type: 'static' }).returning()`; memberships: `validateManualMembershipDevices` then `addManualGroupMemberships({ groupId, orgId, deviceIds: devicesAdded })` and `db.delete(deviceGroupMemberships).where(groupId ∧ orgId ∧ inArray(deviceId, devicesRemoved))` (the same delete the groups route's `DELETE /:id/devices/:deviceId` performs — call the existing removal service if one is exported from `groupMembership.ts`, else the delete above followed by `schedulePeripheralMembershipChanges(removed, 'manual_membership_changed')`); ledger `recordApplied({ itemRef: 'functions:<key>', itemKind: 'function', step: 1, createdRefs: { groupId, groupCreated, assessmentIds, membershipSnapshot: wanted }, beforeImage: { memberships: current, priorAssessmentIdByDevice } })`; `writeRouteAudit(c…)` is not available in a service — use `writeAuditEvent` (`services/auditEvents.ts`) with `actorType: 'user'`, action `fleet_design.apply.function`.
- `stepRetire`: per approved `retired:<n>`: `listFeatureLinks(policyId)` → find the link of type `monitoring` (watch) or `alert_rule` (rule); compute `next` = watch `enabled: false` / rule removed by name; `updateFeatureLink(link.id, { inlineSettings: next }, policyId)`; ledger kind `retired`, `beforeImage: { inlineSettings: link.inlineSettings }`, `createdRefs: { policyId, linkId: link.id }`.
- `stepMonitoring`: per function with approved items (watch/rule refs): if a `policy:<key>` ledger row exists for this run → union previously applied items with new ones and `updateFeatureLink` both links; else `createConfigPolicy({ orgId }, { name: \`Fleet Design: ${label}\`, description: \`Created by Fleet Design on ${date} from report run ${reportRunId}\`, status: 'inactive' }, userId)`, `addFeatureLink(policyId, 'monitoring', null, { checkIntervalSeconds: 60, watches: approvedWatches.map(toWatchItem) })`, `addFeatureLink(policyId, 'alert_rule', null, { items: approvedRules.map(toRuleItem) })` where `toRuleItem` sets `rationale: \`${r.rationale} [Action: ${describeAction(r.action)}; Paging: ${r.paging}]\``, `assignPolicy(policyId, 'device_group', groupId, 100, userId)` (null → the assignment already existed, fine), `updateConfigPolicy(policyId, { status: 'active' }, auth)`; ledger rows: `policy:<key>` (kind `policy`, createdRefs `{ policyId, monitoringLinkId, alertRuleLinkId, assignmentId, linksSnapshot }`) and one row per applied watch/rule ref (kind `watch` / `rule`, createdRefs `{ policyId }`).
- `stepRoleCorrections`: per approved deviceId present in `outcome.sections.unsure.roleCorrections`: read current role/source; `db.update(devices).set({ deviceRole: proposedRole, deviceRoleSource: 'ai', updatedAt })` where `id ∧ orgId ∧ deviceRoleSource <> 'manual'`; audit `device.role.ai_correction` per device with `{ from, to, reportRunId }`; ledger kind `role_correction`, `beforeImage: { deviceRole, deviceRoleSource }`.
Group name collision: names are not unique; the ledger's `groupId` is the identity. A technician-renamed group is still reused by id.

- [ ] **Step 4: Run, typecheck, commit**

```bash
git add apps/api/src/services/fleetDesign
git commit -m "feat(api): fleet design apply preview and stepwise apply with ledger"
```

### Task 5: Rollback, `restoreDeviceFunction`, discovery precedence

**Files:**
- Create: `apps/api/src/services/fleetDesign/rollback.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/deviceFunction.ts` (add `restoreDeviceFunction({ deviceId, orgId, assessmentId, userId })`: lock device; supersede the active row; set `active = true, superseded_at = NULL` on `assessmentId` when given; rewrite the projection from it or NULL)
- Modify: `apps/api/src/jobs/discoveryWorker.ts:1128`: `sql\`${devices.deviceRoleSource} NOT IN ('manual', 'ai')\`` (+ a test in `discoveryWorker.test.ts` asserting the predicate)

**Interfaces:**
- `rollbackFleetDesign(auth, reportRunId): Promise<{ rolledBack: string[]; refused: { itemRef: string; reason: 'modified_since_apply' | 'group_has_other_members' | 'policy_missing' }[] }>`

- [ ] **Step 1: Failing tests** — reverse order (5 → 3 → 2 → 1); a policy whose links no longer equal `createdRefs.linksSnapshot` is refused with `modified_since_apply` and its ledger row stays `applied`; a matching one is archived (`updateConfigPolicy(status:'archived')`), its assignment deleted, links left with the archived policy; retired items restore `before_image.inlineSettings` only when the current settings equal the post-apply value (recompute from before-image + the same rewrite; else refuse); groups created by the apply are deleted through `deviceGroupDelete.ts`'s service only when membership equals `membershipSnapshot`, otherwise memberships added by the apply are removed and the group kept; functions call `restoreDeviceFunction` per device with `priorAssessmentIdByDevice`; role corrections restore the before-image only while `device_role_source = 'ai'`; all handled rows get `markRolledBack`.
- [ ] **Step 2: Implement** as the tests describe, one savepoint per ledger row so a refusal never aborts the others.
- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/services/fleetDesign/rollback.ts apps/api/src/services/fleetDesign/rollback.test.ts apps/api/src/services/deviceFunction.ts apps/api/src/services/deviceFunction.test.ts apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.test.ts
git commit -m "feat(api): fleet design rollback; discovery never overwrites an ai-corrected role"
```

### Task 6: Routes

**Files:**
- Modify: `apps/api/src/routes/fleetDesign.ts` (W01) + `fleetDesign.test.ts`

**Interfaces:**
- `POST /ai/fleet-design/:reportRunId/apply/preview` body `FleetDesignApproval` → 200 `FleetDesignApplyPreview`
- `POST /ai/fleet-design/:reportRunId/apply` body `FleetDesignApproval` → 200 `FleetDesignApplyResult` | 409 `{ error: 'blocked', blockers, unaccepted }` | 403 `{ error: 'site_restricted' }`
- `POST /ai/fleet-design/:reportRunId/rollback` → 200 `{ rolledBack, refused }`
- `GET /ai/fleet-design/:reportRunId/applied` → `{ items: FleetDesignLedgerItem[] }`

- [ ] **Step 1: Failing route tests** — preview forwards the validated body; apply requires `devices:write` + MFA; a site-restricted `permissions.allowedSiteIds` array → 403 before any service call; `FleetDesignApplyError('blocked')` → 409 with its payload; `not_found` → 404; rollback and ledger listing wired; every route audits (`fleet_design.apply`, `fleet_design.rollback`) with `{ reportRunId, applied: n }`.
- [ ] **Step 2: Implement** with `requirePermission(PERMISSIONS.DEVICES_WRITE…)`, `requireMfa()`, `zValidator('json', fleetDesignApprovalSchema)`; the site check reads `c.get('permissions')` as `routes/groups.ts:447` does.
- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/routes/fleetDesign.ts apps/api/src/routes/fleetDesign.test.ts
git commit -m "feat(api): fleet design apply preview, apply, rollback and ledger routes"
```

### Task 7: Integration suite (live Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/fleetDesignApply.integration.test.ts`

- [ ] **Step 1: Cases** (seed: org A with 3 devices, one manual function on device 3, one existing org policy with a monitoring watch `Spooler` assigned at organization level; a persisted design report run whose outcome proposes function `file_server` for devices 1–3, one watch, one rule, retires `Spooler`, and corrects device 2's role)
1. Preview lists `keptManual: 1`, `displaces` the existing policy for `monitoring` with `deviceCount: 3`, `retired[0].found === true`.
2. Apply without `displacementsAccepted` → `blocked`, nothing written (no ledger rows, no policies).
3. Apply with acceptance: one group with 3 members; assessments for devices 1 and 2 (`ai`), device 3 unchanged (`manual`); policy `Fleet Design: File server` active with two links, watch and rule carrying `rationale`, assignment at `device_group`/100/NULL filters; `Spooler` watch `enabled = false` in the existing link; device 2 `device_role_source = 'ai'`; ledger rows for every ref with `status = 'applied'`.
4. Re-apply the same approval → `skipped` contains every ref, nothing created twice (count policies, groups, assessments).
5. Cross-org: apply as an org-B token on org A's report run → 404; a forged ledger insert as org B under `orgContext(B)` for org A → 42501.
6. Rollback: policy archived, assignment gone, `Spooler` re-enabled, group deleted (membership unchanged), device 2 role restored, assessments superseded and device 1's projection NULL again; ledger rows `rolled_back`.
7. Rollback refusal: after apply, edit the created policy's watch by hand (`updateFeatureLink`), then rollback → that policy refused with `modified_since_apply`, everything else rolled back.
8. Partial apply: make step 3 fail (e.g. a watch name of 300 chars that the validator rejects) → steps 1 and 2 applied, `partial.failedStep === 3`, a `failed` ledger row; then rollback restores steps 1 and 2.
9. Org erasure succeeds with ledger rows and a design report present.
10. Contract suites (`rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`) pass with the ledger table.

- [ ] **Step 2: Run** on the test stack, confirm every case RAN; `pnpm test-stack down` after.
- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/fleetDesignApply.integration.test.ts
git commit -m "test(api): fleet design apply, idempotency, rollback, partial apply and erasure"
```

### Task 8: Web — Fleet Design page, apply drawer, rollback, rationale display

**Files:**
- Create: `apps/web/src/pages/ai-agents/fleet-design.astro` (copy `impact.astro`, mount `FleetDesignPage`), `apps/web/src/components/fleetDesign/FleetDesignPage.tsx`, `FleetDesignViewer.tsx`, `ApplyDrawer.tsx`, `useDesignSelection.ts`, `apps/web/src/lib/api/fleetDesign.ts` (typed fetch wrappers: `listDesigns(orgId)`, `getDesign(reportRunId)`, `previewApply`, `apply`, `rollback`, `listApplied`, `startDesignRun(orgId, siteId?)`)
- Modify: `apps/web/src/components/layout/Sidebar.tsx:222-241` (add `{ name: 'Fleet Design', labelKey: 'nav.fleetDesign', href: '/ai-agents/fleet-design', icon: DraftingCompass, requiredPermission: { resource: 'ai_agents', action: 'read' } }` after AI Impact), `Sidebar.nav.test.tsx:112-114` (add `/ai-agents/fleet-design` to the AI hrefs), `apps/web/src/locales/*/common.json` (`nav.fleetDesign`)
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx` (W01's "Open in Fleet Design" link now points at `/ai-agents/fleet-design#<reportRunId>`)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx`, `AlertRuleTab.tsx` — render `rationale` under each watch/rule as read-only text with an "Edit rationale" affordance that opens a textarea bound to the item's `rationale` (saved with the tab's existing save path, which already round-trips `inlineSettings`)
- Locales (8): new namespace `fleetDesign.json` — page title, org picker, "Start a Fleet Design", site scope option, list columns (generated, functions, watches, rules, applied), section titles (mirror `FLEET_DESIGN_SECTION_TITLES`), item labels, drawer copy (`creates`, `retires`, `displaces` with `{{count}} devices`, `roleCorrections` with a billing warning, `acceptDisplacement`, `confirm`, `nothingSelected`), result copy (`applied`, `partial` with step, `rollback`, `rollbackRefused`), errors (`site_restricted`, `blocked`, `no_designer_agent`)
- Tests: `FleetDesignPage.test.tsx` (list → select → viewer renders all eight sections from a fixture; hash `#<reportRunId>` selects the design), `ApplyDrawer.test.tsx` (blocks confirm with nothing selected; shows displacements and requires each accepted before confirm; posts the approval body; partial result offers Rollback), `useDesignSelection.test.ts`, `MonitoringTab.test.tsx` / `AlertRuleTab.test.tsx` (rationale displayed and edited), `Sidebar.nav.test.tsx`, locale gates, `no-silent-mutations`.

Page behaviour:
- Org picker (partner scope) → `GET /ai/fleet-design?orgId=`; "Start a Fleet Design" button → `POST /ai/fleet-design/runs` through `runAction` (toast on skip reasons via `friendly`), optional site select.
- Selecting a row sets `window.location.hash = reportRunId` (URL-state convention) and loads `GET /ai/fleet-design/:id` + `/applied`.
- Viewer: eight sections in order; per-item checkbox (`useDesignSelection` keyed by `itemRef`; functions select by `functions:<key>`; selecting a monitoring item auto-selects its function); items with an `applied` ledger row render a badge and are not selectable; "Download PDF" via the W01 `exportReport` path.
- Apply drawer (`Drawer`, `closeDisabled` while in flight): on open, `POST …/apply/preview` with the current selection; shows Creates (groups, policies with counts), Retires, Displaces (each with an Accept checkbox), Role corrections (billing warning), Already applied, Blockers; Confirm disabled until nothing is blocked and every displacement is accepted; Confirm → `POST …/apply`; result view; `partial` → "Roll back what was applied" button.
- Rollback button on the design header when the ledger has `applied` rows → `POST …/rollback` → shows refused items with reasons.

- [ ] **Step 1: Failing tests**, **Step 2: implement**, **Step 3: run** `cd apps/web && npx vitest run src/components/fleetDesign src/components/configurationPolicies/featureTabs src/components/layout/Sidebar.nav.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx astro check && pnpm lint`.
- [ ] **Step 4: Commit and PR**

```bash
git add apps/web/src
git commit -m "feat(web): Fleet Design page with apply drawer, rollback and rationale display"
```
Before the PR: `cd apps/api && npx vitest run`; Task 7's integration suites; `pnpm db:check-drift`. PR body: the ledger table (shape 1, registrations), the three `rationale` columns, the displacement rule, `Closes #5653`.
