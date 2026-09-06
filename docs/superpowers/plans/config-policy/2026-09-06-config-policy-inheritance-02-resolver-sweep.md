# Config Policy Inheritance — W02 Resolver Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every reader that decides what a device gets, delivers config to an agent, or schedules work reads `config_policy_effective_feature_links` instead of `config_policy_feature_links`, carries the assigned policy id wherever a link id used to stand alone, and a contract test keeps it that way.

**Architecture:** The view has the same join shape as the base table (`config_policy_id = configuration_policies.id AND feature_type = X`), so most sites change one identifier. Three families need more: (1) the generic effective-config resolver adds provenance; (2) automation scheduling gains an execution identity `(automation id, assigned policy id)` through grouping, job payload, job ids, the run-time ownership clamp, and a one-execution-per-device filter; (3) patch uses the resolver's `configPolicyId` instead of reverse-mapping a link id, and the policy-local patch loader reads the view. A source-tree contract test fails on any new direct reader outside the CRUD allowlist.

**Tech Stack:** Drizzle ORM, BullMQ, Vitest (unit with the `vi.mock('../db')` chain pattern from `featureConfigResolver.test.ts`; integration against real Postgres).

**Spec:** `docs/superpowers/specs/config-policy/2026-09-06-config-policy-inheritance-design.md` (sections *Semantics*, *Resolver sweep*, *Risks*)

**Depends on:** W01 merged (view + column exist; `configPolicyEffectiveFeatureLinks` exported from the schema).

## Global Constraints

- Readers that **edit or report a policy's own links** keep `configPolicyFeatureLinks`. Readers that **resolve, deliver, or schedule** switch to `configPolicyEffectiveFeatureLinks`. The allowlist in Task 1 is the authority; a reader not on it that imports the base table fails **Test API**.
- An inherited link competes at the **child's** assignment level and priority; `sourcePolicyId` (existing field) stays the assigned child; new `inheritedFromPolicyId` / `inheritedFromPolicyName` are set only when `inherited = true`.
- Wherever a `featureLinkId` identified a policy on its own, the **assigned `configPolicyId` travels with it**. No `.limit(1)` reverse map from link id to policy remains on the switched paths.
- One execution per device per tick: a per-policy automation dispatch keeps only devices whose winning automation assignment is that dispatch's policy.
- Before the PR, `EXPLAIN (ANALYZE, BUFFERS)` for `resolveDeviceEventLogSettings` as `breeze_app` before/after; no sequential scan on `config_policy_feature_links` introduced.
- Every task: red test first, `tsc`, targeted tests, commit.

---

### Task 1: Contract test — no direct feature-link readers outside the allowlist

**Files:**
- Create: `apps/api/src/services/featureLinkReaders.contract.test.ts`

- [ ] **Step 1: Write the test (it is red until the sweep completes; land it first, keep it red-listed in the PR description until Task 9)**

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Files allowed to read config_policy_feature_links DIRECTLY: they edit or
// report a policy's OWN (authored) links. Everything that resolves, delivers,
// or schedules must read config_policy_effective_feature_links (the view) so a
// child policy inherits its parent's links. Adding a resolver here is a
// design decision, not a fix — see the spec's Resolver sweep section.
const DIRECT_READ_ALLOWLIST = new Set([
  'db/schema/configurationPolicies.ts',
  'db/schema/backup.ts',
  'db/schema/onedriveHelper.ts',
  'services/configurationPolicy.ts',          // link CRUD + listFeatureLinks; its resolver imports the view
  'services/configPolicyPatching.ts',          // authored-vs-effective split inside (Task 6)
  'services/alertCorrelationRca.ts',           // evidence naming only
  'services/aiToolsConfigPolicy.ts',
  'services/aiToolsFleet.ts',
  'services/aiToolsBackup.ts',
  'routes/configurationPolicies/featureLinks.ts',
  'routes/updateRingsHelpers.ts',
  'routes/policyManagement/helpers.ts',
  'routes/policyManagement/compliance.ts',
  'routes/scripts.ts',
  'routes/backup/profiles.ts',
  'routes/softwareInventory.ts',
  'routes/partnerApi/configuration.ts',
  'scripts/migrateToConfigPolicies.ts',
]);

const SRC = join(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('feature-link readers contract', () => {
  it('only allowlisted files read config_policy_feature_links directly', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      const src = readFileSync(file, 'utf8');
      const readsBase = /\bconfigPolicyFeatureLinks\b/.test(src) || /config_policy_feature_links\b/.test(src);
      if (readsBase && !DIRECT_READ_ALLOWLIST.has(rel)) offenders.push(rel);
    }
    expect(offenders, `switch these to configPolicyEffectiveFeatureLinks or add them to the allowlist with a reason:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry still exists (stale entries hide regressions)', () => {
    const missing = [...DIRECT_READ_ALLOWLIST].filter((rel) => { try { statSync(join(SRC, rel)); return false; } catch { return true; } });
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run src/services/featureLinkReaders.contract.test.ts` → FAIL listing every reader from the spec's sweep list (this is the work queue for Tasks 2–8). Tune the allowlist only for files the spec names as "keep the base table".

- [ ] **Step 3: Commit** — `git commit -m "test(config-policy): feature-link reader contract (red until the sweep lands)"`.

---

### Task 2: Generic effective-config resolver + provenance

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` — `ResolvedFeature` (:154-163), `resolveEffectiveConfigWithExecutor` (:1814-2031)
- Modify: `packages/shared/src/types` effective-configuration type if one exists (`grep -rn "sourcePolicyName" packages/shared/src`)
- Test: `apps/api/src/routes/configurationPolicies/resolution.test.ts` (append)

**Interfaces:**
- Produces: `ResolvedFeature.inheritedFromPolicyId: string | null`, `ResolvedFeature.inheritedFromPolicyName: string | null` on `GET /configuration-policies/effective/:deviceId` and the diff preview.

- [ ] **Step 1: Failing test** — with the mocked select returning a row `{ ..., inherited: true, sourcePolicyId: 'parent-1', inheritedFromPolicyName: 'Baseline' }`, expect `features.event_log.inheritedFromPolicyId === 'parent-1'` and `sourcePolicyId === '<assigned child id>'`; with `inherited: false` both new fields are `null`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — in the query at ~:1900-1935: replace `configPolicyFeatureLinks` with `configPolicyEffectiveFeatureLinks` (alias `efl`), add `inherited: efl.inherited, linkSourcePolicyId: efl.sourcePolicyId` to the select, and a `leftJoin(aliasedTable(configurationPolicies, 'parent_policy'), eq(parent.id, efl.sourcePolicyId))` selecting `inheritedFromPolicyName: parent.name`. In the first-match block (:1965-1977):

```ts
        sourcePolicyId: row.policyId,            // the ASSIGNED policy (unchanged)
        sourcePolicyName: row.policyName,
        sourcePriority: row.assignmentPriority,
        inheritedFromPolicyId: row.inherited ? row.linkSourcePolicyId : null,
        inheritedFromPolicyName: row.inherited ? row.inheritedFromPolicyName : null,
```

Extend `ResolvedFeature` accordingly. If a shared type mirrors it, extend it too (optional fields, additive).

- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(config-policy): effective-config resolver reads the view, reports inheritedFrom provenance"`.

---

### Task 3: `featureConfigResolver.ts` — mechanical switch

**Files:**
- Modify: `apps/api/src/services/featureConfigResolver.ts` — every function in the spec list: `resolveGoverningAlertRulePolicyForDevice`, `resolveAlertRulesForDevice`, `resolveAutomationsForDevice`, `resolvePatchConfigDetailsForDevice`, `resolveBackupConfigForDevice`, `resolveMaintenanceConfigForDevice`, `resolveComplianceRulesForDevice`, `resolveSoftwarePolicyForDevice`, `resolveDeviceIdsForSoftwarePolicy`, `resolveVulnerabilityEnabledForDevice`, `resolveAllVulnerabilityEnabledDevices`, `resolveAllBackupAssignedDevices`, `resolveBackupProtectionForDevice`, `scanScheduledAutomations`, `scanDueComplianceChecks`
- Test: `apps/api/src/services/featureConfigResolver.test.ts` (existing mocks stub `../db/schema` as string maps — add `configPolicyEffectiveFeatureLinks` to that stub with the same keys plus `sourcePolicyId`, `inherited`)

- [ ] **Step 1: Failing test** — one representative per join shape:
  - `resolveAlertRulesForDevice` builds its join against `configPolicyEffectiveFeatureLinks` (assert the mocked `innerJoin` receives the view stub).
  - `scanScheduledAutomations` returns `policyId` = the assigned policy while joining `configPolicyAutomations.featureLinkId = efl.id` (an inherited row's id is the parent link's id, so the automation row is found through the child).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — import `configPolicyEffectiveFeatureLinks`; in each listed function replace the table in `.from(...)`/`.innerJoin(...)` and in every `eq(configPolicyFeatureLinks.<col>, ...)`. Where a function's `select` exposes `featureLinkId: configPolicyFeatureLinks.id`, keep the same column from the view (it is the parent link id when inherited, which downstream settings joins need). For `scanScheduledAutomations` the join order becomes `configPolicyAutomations → efl (on featureLinkId = efl.id) → configurationPolicies (on efl.configPolicyId = policies.id, status active) → assignments`. Do **not** touch `resolveDeviceIdsForSoftwarePolicy` if its only caller is the software-policy delete guard; if it feeds the compliance worker (check `grep -rn resolveDeviceIdsForSoftwarePolicy apps/api/src`), switch it.

- [ ] **Step 4: Run** the whole file's suites: `npx vitest run src/services/featureConfigResolver` → PASS. Commit — `git commit -m "feat(config-policy): featureConfigResolver reads effective links"`.

---

### Task 4: Agent config delivery — `routes/agents/helpers.ts`, `routes/remote/helpers.ts`, lifecycle, helper permissions, warranty

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (event_log :1818-1840, monitoring :2092, helper :2619-2625, pam :2777-2783, onedrive_helper :2961-2965), `apps/api/src/routes/remote/helpers.ts:453-459`, `apps/api/src/services/deviceLifecyclePolicy.ts:94-104`, `apps/api/src/services/helperPermissions.ts:80-92`, `apps/api/src/services/warrantyAlertEvaluator.ts:136-147`
- Test: the co-located tests for each (`helpers.test.ts` variants, `deviceLifecyclePolicy.test.ts`, `helperPermissions.test.ts`, `warrantyAlertEvaluator.test.ts`) — add the view to their schema stubs and one assertion per file that the join target is the view.

- [ ] **Step 1: Failing tests** (one per file, same shape as Task 3).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — identifier swap in each join; the settings joins (`configPolicyEventLogSettings.featureLinkId = efl.id`, etc.) are unchanged.
- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(config-policy): agent delivery, remote prompt, lifecycle, helper, warranty read effective links"`.

---

### Task 5: Automation execution identity

**Files:**
- Modify: `apps/api/src/jobs/queueSchemas.ts:264-284` (`trigger-config-policy-schedule` gains `configPolicyId`; `execute-config-policy-run` gains `configPolicyId`)
- Modify: `apps/api/src/jobs/automationWorker.ts` — `collectDueConfigPolicyScheduleDispatches` (:196-235: group key), the enqueue at :421 (jobId), `processTriggerConfigPolicySchedule` (:769-866: ownership clamp, per-device winner filter, run jobId), `processExecuteConfigPolicyRun` (pass `configPolicyId` through)
- Modify: `apps/api/src/services/automationRuntime.ts:2835-2875` — `resolveConfigPolicyAutomationContext(tx, featureLinkId, configPolicyId)`
- Test: `apps/api/src/jobs/automationWorker.test.ts`, `apps/api/src/services/automationRuntime.configPolicy.test.ts`

**Interfaces:**
- Produces: `DueConfigPolicyScheduleDispatch.policyId` is the **assigned** policy; job ids `cp-automation-schedule-<automationId>-<policyId>-<slotKey>` and `cp-automation-run:<automationId>:<policyId>:<slotKey>`; `ExecuteConfigPolicyRunJobData.configPolicyId: string`.

- [ ] **Step 1: Failing tests**

```ts
it('groups due schedules by (automation id, assigned policy id)', () => {
  // two candidates, same automation, policyId 'child-a' and 'child-b' → two dispatches
});
it('schedule job id includes the assigned policy id', ...);
it('run-time clamp reads ownership from the ASSIGNED policy, not from the link', ...);   // db mock: configurationPolicies select by id, no configPolicyFeatureLinks join
it('keeps only devices whose winning automation assignment is this dispatch\'s policy', ...); // resolveAutomationsForDevice mocked: device-1 wins with child-a, device-2 wins with child-b → dispatch child-a keeps device-1 only
it('resolveConfigPolicyAutomationContext verifies the link is effective for the given policy through the view', ...);
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

`collectDueConfigPolicyScheduleDispatches`: `const key = \`${cpAutomation.id}:${candidate.policyId}\`; let entry = grouped.get(key); ... grouped.set(key, entry);`.

Enqueue (:421): `jobId: \`cp-automation-schedule-${dispatch.configPolicyAutomationId}-${dispatch.policyId}-${slotKey}\`` and add `configPolicyId: dispatch.policyId` to the payload (the existing `policyId` field stays for back-compat; new code reads `configPolicyId ?? policyId`).

`processTriggerConfigPolicySchedule`:

```ts
  const assignedPolicyId = data.configPolicyId ?? data.policyId;
  // Ownership clamp re-reads the ASSIGNED policy (#2286). Through the effective
  // view one link id belongs to the parent AND every child, so a link→policy
  // reverse map would pick an arbitrary owner.
  const [policyOwner] = await db
    .select({ orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId, status: configurationPolicies.status })
    .from(configurationPolicies).where(eq(configurationPolicies.id, assignedPolicyId)).limit(1);
  if (!policyOwner || policyOwner.status !== 'active') return { skipped: 'config_policy_not_found' };
  const [effective] = await db.select({ id: configPolicyEffectiveFeatureLinks.id })
    .from(configPolicyEffectiveFeatureLinks)
    .where(and(eq(configPolicyEffectiveFeatureLinks.id, cpAutomation.featureLinkId),
               eq(configPolicyEffectiveFeatureLinks.configPolicyId, assignedPolicyId))).limit(1);
  if (!effective) return { skipped: 'automation_not_effective_for_policy' };
```

After the maintenance filter, add the winner filter:

```ts
  // One execution per device per tick: a device covered by two assigned policies
  // that both carry this (inherited) automation runs it under the WINNING policy only.
  const winners: string[] = [];
  for (const deviceId of eligibleDeviceIds) {
    const automations = await resolveAutomationsForDevice(deviceId);
    const winner = automations.find((a) => a.automation.id === cpAutomation.id);
    if (winner && winner.policyId === assignedPolicyId) winners.push(deviceId);
  }
  if (winners.length === 0) return { skipped: 'no_winning_devices' };
```

(`resolveAutomationsForDevice` already returns per-automation rows with the winning `policyId`; if its return shape lacks `policyId`, add it in Task 3.) Run enqueue: `configPolicyId: assignedPolicyId`, `targetDeviceIds: winners.sort()`, stable id `cp-automation-run:${cpAutomation.id}:${assignedPolicyId}:${data.slotKey}`.

`resolveConfigPolicyAutomationContext(tx, featureLinkId, configPolicyId)`: select from `configPolicyEffectiveFeatureLinks` joined to `configurationPolicies` on `efl.configPolicyId = policies.id`, `where(and(eq(efl.id, featureLinkId), eq(efl.configPolicyId, configPolicyId)))`. Its caller at :2870 passes `options.configPolicyId` (thread it from the run job data through `admitConfigPolicyAutomationRun`'s options).

- [ ] **Step 4: Run → PASS; typecheck; commit** — `git commit -m "feat(config-policy): automation execution identity = (automation, assigned policy); one run per device per tick"`.

---

### Task 6: Patch — effective loader and resolver-provided policy id

**Files:**
- Modify: `apps/api/src/services/configPolicyPatching.ts:282-345` (`loadPolicyLocalPatchConfig`), `apps/api/src/services/patchJobService.ts:113-135`, `apps/api/src/jobs/patchSchedulerWorker.ts:496-530`
- Test: `apps/api/src/services/configPolicyPatching.test.ts`, `apps/api/src/services/patchJobService.test.ts`, `apps/api/src/jobs/patchSchedulerWorker.test.ts`

**Interfaces:**
- Produces: `PolicyLocalPatchConfig.sourcePolicyId: string` and `.inherited: boolean`; `loadPolicyLocalPatchConfig(configPolicyId)` returns the parent's patch link for a child that has none of its own.

- [ ] **Step 1: Failing tests**
  - `loadPolicyLocalPatchConfig('child')` with the view mock returning the parent's link (`inherited: true, sourcePolicyId: 'parent'`) returns a config with `configPolicyId: 'child'`, `sourcePolicyId: 'parent'`, `inherited: true`, and the patch settings joined by the parent link id.
  - `createPatchJobForDeviceFromPolicy` calls `createPatchJobFromConfigPolicy(deviceId, settings, orgId, resolved.configPolicyId)` with no `configPolicyFeatureLinks` select.
  - `scanAndCreateJobs` enumerates through the view (a child of a parent with a patch link is a candidate).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
  - `loadPolicyLocalPatchConfig`: switch the inner join to `configPolicyEffectiveFeatureLinks` (alias `efl`), select `sourcePolicyId: efl.sourcePolicyId, inherited: efl.inherited`, keep `leftJoin(configPolicyPatchSettings, eq(configPolicyPatchSettings.featureLinkId, efl.id))`, add the two fields to `PolicyLocalPatchConfig`. The authored-only readers in this file (reference classification for the editor, if any) keep the base table — that is why the file stays on the allowlist; mark each query with a one-line `// authored` or `// effective` comment.
  - `createPatchJobForDeviceFromPolicy`: replace the `resolvePatchConfigForDevice` + reverse map with `const resolved = await resolvePatchConfigDetailsForDevice(deviceId); if (!resolved) return null; return createPatchJobFromConfigPolicy(deviceId, resolved.settings, orgId, resolved.configPolicyId);`.
  - `scanAndCreateJobs`: switch the `configPolicyFeatureLinks` join to the view.

- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(config-policy): patch scheduler and job creation inherit through the effective loader"`.

---

### Task 7: Remaining workers — backup scheduler

**Files:**
- Modify: `apps/api/src/jobs/backupWorker.ts:149-180` (`processCheckSchedules`)
- Test: `apps/api/src/jobs/backupWorker.test.ts`

- [ ] **Step 1: Failing test** — the schedule scan joins the view; `config_policy_backup_settings.feature_link_id = efl.id` unchanged.
- [ ] **Step 2: Run → FAIL.** **Step 3:** identifier swap. **Step 4:** PASS; commit — `git commit -m "feat(config-policy): backup schedule scan reads effective links"`.

---

### Task 8: Contract test green

- [ ] **Step 1:** `cd apps/api && npx vitest run src/services/featureLinkReaders.contract.test.ts` → PASS with **zero** allowlist additions beyond Task 1's list. If a file still fails, it is either a missed resolver (switch it) or an authored-only reader the spec named (add it with a reason comment). `npx tsc --noEmit` clean.
- [ ] **Step 2:** Commit — `git commit -m "test(config-policy): reader contract green"`.

---

### Task 9: Integration proof — inheritance reaches devices and agents

**Files:**
- Modify: `apps/api/src/__tests__/integration/configPolicyInheritance.integration.test.ts` (W01 suite; add a `describe('resolution')`)

- [ ] **Step 1: Write the cases** (seed: partner P1, orgs A1, A2; parent partner-wide `Baseline` with `event_log` + `alert_rule` + one scheduled `automation` link; child `A1-child` in A1 assigned at org level with its own `alert_rule` link; child `A2-child` in A2 assigned at org level; device D1 in A1, D2 in A2)

```ts
it('generic resolver: D1 gets event_log from Baseline (inheritedFromPolicyId = Baseline) and alert_rule from A1-child (inheritedFromPolicyId null)', ...);
it('featureConfigResolver.resolveAlertRulesForDevice(D2) returns Baseline rules through A2-child at org priority', ...);
it('agent helper resolveDeviceEventLogSettings(D1) under the AGENT context (org A1, currentPartnerId P1) returns Baseline settings', ...);
it('automation tick: two children → two schedule dispatches with distinct job ids, each run scoped to its own org devices', ...);
it('overlapping assignments (Baseline also assigned at org A1, A1-child at site) → D1 runs the automation once, under A1-child', ...);
it('provenance: only the inherited feature carries inheritedFromPolicyId', ...);
```

Use `withDbAccessContext(orgContext(A1, P1), ...)` for the agent-shaped case and `SYSTEM_CTX` for worker paths; for the automation cases call `collectDueConfigPolicyScheduleDispatches(await scanScheduledAutomations(), due)` and `processTriggerConfigPolicySchedule` directly with a fake queue (the existing automationWorker integration test shows the harness; if none exists, assert on the enqueue call via `vi.spyOn`).

- [ ] **Step 2: Run** with the test stack up: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/configPolicyInheritance.integration.test.ts` → PASS, test count matches.
- [ ] **Step 3: Commit** — `git commit -m "test(config-policy): inheritance resolution proof — resolver, agent context, automation identity"`.

---

### Task 10: EXPLAIN check, full suites, PR

- [ ] **Step 1:** As `breeze_app` on the test stack, `EXPLAIN (ANALYZE, BUFFERS)` the event_log resolver query (copy it from `resolveDeviceEventLogSettings` with real ids) before (checkout main) and after; paste both plans into the PR description. No new seq scan on the links table; if the planner does not push `feature_type` into the view's second arm, add `CREATE INDEX IF NOT EXISTS config_feature_links_policy_type_idx ON config_policy_feature_links (config_policy_id, feature_type)` in a small follow-up migration (the unique index `config_feature_links_unique` already covers this pair; verify before adding anything).
- [ ] **Step 2:** `pnpm --filter @breeze/api test --run src/services src/jobs src/routes/agents src/routes/configurationPolicies` green; `npx tsc --noEmit`; `pnpm lint`.
- [ ] **Step 3:** Live suites: `configPolicyInheritance`, `configPolicyAutomationRunRls`, `configurationPolicyPartnerResolution`, `configPolicyPartnerWideSelect`, `rls-coverage` (all under `vitest.integration.config.ts`) — each must show it ran.
- [ ] **Step 4:** Merge `origin/main`, re-run, push, open the PR with `Closes #<wave sub-issue>`, run `pr-review-toolkit:review-pr`, fix confirmed findings inline, **stop at the open PR**.
