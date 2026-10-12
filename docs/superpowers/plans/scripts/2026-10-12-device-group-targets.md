---
issue: 5237
status: draft-for-approval
---

# Device-Group Targets for Run Script + Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator run a script on a saved device group (static or dynamic) from the Run Script modal and the API, and pick groups in the automation editor, without adding a seventh "target" vocabulary.

**Architecture:** Reuse the existing `DeploymentTargetConfig` (`devices|groups|filter|all`) and `resolveDeploymentTargetsWithWarnings` as the single target contract. W1 adds a script-run resolver in front of the unchanged admission pipeline and a server-side validator for automation `conditions`. W2 wires the web pickers. W3 extends the AI tool surface.

**Tech Stack:** Hono + Zod (API), Drizzle (queries only), Vitest, React islands + `DeviceTargetSelector` (web), `@breeze/shared` validators.

**Spec:** Issue #5237 (split from #4981). No separate spec doc exists; this plan is the design record.

## Premise check (what the issue gets wrong)

The issue predates several merges. Verified against `origin/main` at plan time:

- **Automations already resolve group targets at run time.** `resolveAutomationTargetDeviceIds` (`apps/api/src/services/automationRuntime.ts`) detects `isDeploymentTargetConfig(automation.conditions)` and loops `resolveDeploymentTargets` per owner org; legacy array conditions also support `{type:'group'}`. The runtime is not the gap.
- **The real automation gaps are three:** (1) `AutomationForm.tsx` renders `DeviceTargetSelector` with `modes={['all','filter']}`, so `groups` cannot be authored; (2) `routes/automations.ts` takes `conditions: z.unknown()`, so nothing validates a target shape (an empty `groupIds`, a cross-org id, or a typo all persist); (3) the runtime drops resolver warnings, and a deleted/empty/refused group silently resolves to zero devices.
- **The form already persists correctly.** `AutomationEditPage.tsx` (~line 365) sends `conditions: values.targetConfig ?? values.conditions`, so a `DeploymentTargetConfig` lands in the existing `conditions` jsonb. No schema change.
- **Why `groups` is disabled in the form has no recorded reason.** `git blame` on the line leads only to a squash commit whose message is about an unrelated agent fix. Do not assume intent; Task 7 decides it explicitly (Open Decision 1).
- **The Run Script gap is real.** `executeScriptSchema` (`apps/api/src/services/scriptRunRequest.ts`) takes only `deviceIds` (`min(1).max(500)`); `ScriptExecutionModal.tsx` has no group picker. `DeviceGroupsPage.tsx` already composes a group run client-side (`GET /device-groups/:id/devices`, served by `apps/api/src/routes/groups.ts`, then one `POST /scripts/:id/execute`; #3429/#7054) and is the precedent.
- **Siblings #5234, #5235, #5236 are maintenance-window work, unrelated and unshipped.** Out of scope.

## Global Constraints

- No migration expected (see "Migrations"). Never `drizzle-kit generate/push`.
- Reuse `DeploymentTargetConfig` / `deploymentTargetConfigSchema` (`packages/shared`). Do not add another target enum (existing ones: `alert_rules.target_type`, `deployments.target_type`, `software_policies.target_type`, `maintenance_windows.target_type`, `peripheralPolicyTargetTypeEnum`, openapi `all|sites|groups|tags|devices`).
- `POST /scripts/:id/execute` stays registered in `middleware/selfManagedDbContextRoutes.ts` with no held transaction (#7103). Group resolution must not hold a connection across the dispatch loop.
- Execution-refused (agent-reported field) groups stay refused as execution targets (`executionTargetGating.ts`). Nothing here weakens that.
- Never `z.undefined()` in an AI tool schema. AI-tool contract tests key `SAFE_WRITE_SITES` by line number: re-run them after any edit that shifts lines. All four `run_script` declarations change together.
- New web strings: add the `en` key and all 7 locales (`apps/web/src/lib/i18n`, `localeParity.test.ts`).
- Web mutations go through `runAction`. Transient UI state uses `window.location.hash`.
- Public repo: no customer names, hostnames, IPs, handles or session IDs anywhere.
- Test commands (no `--` before flags): `cd apps/api && npx vitest run <files>`; `cd apps/web && npx vitest run <files>`. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo exit=$?` (same for `apps/web`) and read the exit code; never pipe to `tail`.
- Stacked PRs get no CI (`ci.yml` triggers only on PRs to `main`). Waves are sequential PRs off `main`; if one must be stacked, `gh workflow run CI --ref <branch>`. Integration-only contracts (RLS/cascade/export, real-Postgres fan-out) fail only under **Integration Tests**, not Test API.

## Migrations: none expected

Evidence, to be re-run at implementation time:

- Group membership already carries the org triangle (`device_group_memberships` composite FKs pin group.org = membership.org = device.org, `apps/api/src/db/schema/devices.ts` ~632-680). Script-run targets are request-shaped; automations store targets in the existing `automations.conditions` jsonb.
- The audit record for a script run uses the existing `script.execute` audit `details` jsonb.
- Proof no tenant-scoped table or column is added: `git diff origin/main --stat -- apps/api/migrations apps/api/src/db/schema` must be empty on every wave. Newest committed migration at plan time: `2026-12-23-100000-tier1-sweep-indexes.sql`.
- If a migration turns out to be needed (for example persisting a per-run target snapshot), stop and use the slot `2026-12-23-170000-<slug>.sql` after re-checking `git ls-tree origin/main apps/api/migrations/`. Then every CLAUDE.md registration applies and must be spelled out in that wave: RLS enabled + forced + policies in the same migration; `SELECT set_config('breeze.scope','system',true);` before any write; composite FKs referencing `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`; registration in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` (json/jsonb/bytea columns are `excludedOpen`), plus the device/ticket lists if it has those columns; the partner-wide-first `org_id` XOR `partner_id` default; `pnpm db:check-drift`; and the cascade/export suites under `pnpm test-stack up` (tear down with `pnpm test-stack down`).

## Design decisions (recommended; alternatives in Open Decisions)

**Script-run contract (W1).** `executeScriptSchema` accepts one of two mutually exclusive shapes: `deviceIds` (unchanged) or `target`, a `DeploymentTargetConfig` narrowed to `type: 'groups'` with `groupIds` `min(1)`. `targetSessionId` requires exactly one explicit device, so a `target` request is rejected when it is set. A new service `resolveScriptRunTargets({ auth, permissions, target })` runs before `admitTargets` and returns the concrete device list. That list flows through the unchanged admission pipeline, which already enforces org access, the site allowlist, script-org match, OS compatibility, decommissioned and maintenance suppression per device.

**Tenancy for the script path.** Groups are single-org (`device_groups.org_id NOT NULL`). The resolver looks up the requested groups' org ids and drops any the caller cannot reach (`auth.canAccessOrg`) or whose own `siteId` the caller's allowlist excludes (mirroring `groupSiteAllowed` in `routes/groups.ts`). It does not shrink silently: the response names the unusable group ids, with one message for "missing" and "inaccessible" so existence is not leaked. It then resolves per org through `resolveDeploymentTargetsWithWarnings({ orgId, targetConfig })`, which keeps `eq(devices.orgId, orgId)` on every query, and applies the caller's site allowlist to the merged set (the same idea as `checkAutomationTargetsWithinSiteScope` for automations). `resolveExecutionSafeGroupIds` (no org predicate) is the primitive for the refusal check across orgs. The route's `requireScope` list stays `organization|partner|system`. A partner caller may mix groups from several orgs and the existing per-org batch split in `scriptExecution.ts` handles the fan-out. A script owned by one org run on another org's group yields `script_org_mismatch` per device, as today.

**Dynamic groups.** Membership is materialized into `device_group_memberships` by `deviceGroupJobs.ts` with ~5 s coalescing lag. For script runs read the materialized membership: it is the set the user sees on the Groups page and in the picker preview, it is cheap, and the lag is small and bounded. Live `evaluateFilter` is rejected as the default because it can diverge from the displayed membership and re-runs a potentially expensive filter inside a request the user is watching. The refusal tier still applies: groups whose `filterFieldsUsed` include agent-reported fields are excluded with a warning and an audit event, never executed on.

**Max-target guard.** The 500 cap protects the DB pool (un-awaited per-device audit transactions, see the comment in `scriptRunRequest.ts`). Enforce it after resolution and before admission: a 400 naming the resolved count and the cap, with per-group counts so the user can split the run. No truncation, no silent batching. Raising or batching is deferred (Open Decision 5) because it needs a pool-load study outside this plan.

**Audit.** The `script.execute` audit `details` gains `target: { type: 'groups', groupIds }` and `resolvedGroups: [{ id, orgId, memberCount, refused }]`. The resolved device ids are already in `details.targets[]`, so "who ran what on whom" survives later membership changes.

**Automations (W1 validator, W2 editor).** Add server-side validation of `conditions` target shapes on create/update: `automationTargetConfigSchema` (`deploymentTargetConfigSchema` plus refinements: `groups` needs non-empty `groupIds`, `devices` needs non-empty `deviceIds`, `filter` needs a filter) and an existence/org check on every id. The legacy array form and the trigger `deviceIds` form pass untouched. Resolution stays at execution time (already true). A deleted, empty or refused group fails the run visibly with a logged reason instead of completing as a zero-device success, and resolver warnings are written to the run log.

**Site-scope gap to close (found during verification).** `isUnboundedOrgWideTarget` treats `groups` as bounded ("enumerate a concrete set"). That is wrong for dynamic groups and for static groups that gain members later: a site-restricted creator passes the save-time check, and a scheduled run later resolves devices outside their sites with no caller context. W1 treats a `groups` target as bounded for a restricted creator only when every group is static and its `siteId` is inside the allowlist, and confirms that `loadAutomationTargetAdmission` partitioning moves out-of-scope devices out at execution time (adds it if not).

**Partner-wide automations (headline decision).** A group id exists in exactly one org. Today a partner-wide (`org_id` NULL) automation with a `groups` target silently matches only the org that owns the id (the per-org loop's `filterOutExecutionRefusedGroups(orgId, ids)` drops other orgs' ids). Recommended: **reject `groups` and `devices` targets on partner-wide automations at validation time** with a clear message, and keep `all` and `filter`, which already fan out per org. By-name resolution is attractive but group names are unique only per org and a same-named group in another org can be an unrelated set, so it needs its own design (Open Decisions 1 and 9). A stored partner-wide `groups` automation that predates the validator fails its run visibly (Task 6).

**AI surface (W3).** `run_script` caps `deviceIds` at 10 on every declaration and the handler slices to 10. The approval snapshot (`actionIntents/runScriptSnapshot.ts`, the `run_script` resolver in `actionIntents/effectDigest.ts`) pins `{scriptId, deviceIds}`, so a group must be resolved to a concrete list before `createIntent`, otherwise the approved set diverges from the executed set. The approver sees the count and a hash of the resolved ids. Because 10 is far below a typical group, the AI path rejects a group whose resolved set exceeds its cap, naming the count (Open Decision 11).

## Review Focus

Input classes the spec implies but no single task would exercise; each has a test in the owning task:

1. A group with more than 500 members: clear 400 naming the count, nothing dispatched, nothing truncated (Task 3, 4).
2. A group id from an org the caller cannot access, or a deleted group id: named in the response, never silently shrunk to a smaller run (Task 3).
3. An empty group (zero members): `NO_TARGETS` with a message, not a 201 with zero targets (Task 3).
4. A dynamic group whose membership changes between preview and run: the audit record holds the ids actually resolved (Task 4).
5. Partner-wide automation with a `groups` target: rejected at save with a clear message; a stored one fails the run visibly (Tasks 5, 6).
6. Site-restricted creator with a dynamic group target: rejected at save, re-checked at run time (Task 6).
7. Execution-refused group mixed with an allowed group: allowed members run, refusal shown as a warning and audited (Task 3).
8. Same device in two groups: runs once (Task 3).
9. Group target together with `targetSessionId`: rejected (Task 2).
10. Membership changes between AI approval and release: digest mismatch fails closed (Task 10).

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/validators/filters.ts` | `scriptRunGroupTargetSchema`, `automationTargetConfigSchema` on top of `deploymentTargetConfigSchema` |
| `apps/api/src/services/scriptRunTargets.ts` (new) | `resolveScriptRunTargets`: tenancy, site gating, cap |
| `apps/api/src/services/scriptRunRequest.ts` | `executeScriptSchema` XOR `deviceIds` / `target` |
| `apps/api/src/routes/scripts.ts` | resolve before `executeScriptOnDevices`; audit details |
| `apps/api/src/services/automationTargetValidation.ts` (new) | validate `conditions` target shapes |
| `apps/api/src/routes/automations.ts` | call the validator on create/update |
| `apps/api/src/services/automationRuntime.ts` | fail-visible on bad groups; site-scope fix |
| `apps/web/src/components/scripts/ScriptExecutionModal.tsx`, `GroupTargetPicker.tsx` (new) | group picker, preview, submit `target` |
| `apps/web/src/components/automations/AutomationForm.tsx` | enable `groups` mode |
| `apps/api/src/services/aiToolsScripts.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `scriptBuilderTools.ts` | `groupId` arg, resolve before intent |

---

# Wave 1: API target resolver + validators

Mergeable alone with CI green. **If W2 never ships:** the API `target` field and the automation validation are live and tested, the web UI is unchanged (the modal still sends `deviceIds`; the automation editor still offers all|filter). Safe: `deviceIds` requests are byte-for-byte unchanged and automations with valid existing targets keep running.

### Task 1: Shared target schemas

**Files:**
- Modify: `packages/shared/src/validators/filters.ts` (after `deploymentTargetConfigSchema`, ~line 262)
- Test: `packages/shared/src/validators/filters.test.ts` (extend if present, else create beside the other validator tests)

**Interfaces:**
- Produces: `scriptRunGroupTargetSchema` = `{ type: 'groups', groupIds: string[] (min 1, max 100) }`; `automationTargetConfigSchema` = `deploymentTargetConfigSchema` with a `superRefine` (`groups` ⇒ non-empty `groupIds`, `devices` ⇒ non-empty `deviceIds`, `filter` ⇒ `filter` present).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { scriptRunGroupTargetSchema, automationTargetConfigSchema } from './filters';

const G = '11111111-1111-4111-8111-111111111111';

describe('scriptRunGroupTargetSchema', () => {
  it('accepts a groups target', () => {
    expect(scriptRunGroupTargetSchema.safeParse({ type: 'groups', groupIds: [G] }).success).toBe(true);
  });
  it('rejects empty groupIds and non-groups types', () => {
    expect(scriptRunGroupTargetSchema.safeParse({ type: 'groups', groupIds: [] }).success).toBe(false);
    expect(scriptRunGroupTargetSchema.safeParse({ type: 'all' }).success).toBe(false);
  });
});

describe('automationTargetConfigSchema', () => {
  it('rejects empty or missing members for groups, devices and filter', () => {
    expect(automationTargetConfigSchema.safeParse({ type: 'groups' }).success).toBe(false);
    expect(automationTargetConfigSchema.safeParse({ type: 'groups', groupIds: [] }).success).toBe(false);
    expect(automationTargetConfigSchema.safeParse({ type: 'devices', deviceIds: [] }).success).toBe(false);
    expect(automationTargetConfigSchema.safeParse({ type: 'filter' }).success).toBe(false);
  });
  it('accepts all, and groups with ids', () => {
    expect(automationTargetConfigSchema.safeParse({ type: 'all' }).success).toBe(true);
    expect(automationTargetConfigSchema.safeParse({ type: 'groups', groupIds: [G] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/filters.test.ts`
Expected: FAIL (exports not defined).

- [ ] **Step 3: Implement**

```ts
export const scriptRunGroupTargetSchema = z.object({
  type: z.literal('groups'),
  groupIds: z.array(z.string().guid()).min(1).max(100),
});

export const automationTargetConfigSchema = deploymentTargetConfigSchema.superRefine((t, ctx) => {
  const need = (ok: boolean, path: string, message: string) => {
    if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  if (t.type === 'groups') need((t.groupIds?.length ?? 0) > 0, 'groupIds', 'groups target requires at least one group');
  if (t.type === 'devices') need((t.deviceIds?.length ?? 0) > 0, 'deviceIds', 'devices target requires at least one device');
  if (t.type === 'filter') need(t.filter !== undefined, 'filter', 'filter target requires a filter');
});
```

Export both from the package validators index if `filters.ts` is re-exported by name.

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): script-run group target + automation target validators (#5237)`

### Task 2: `executeScriptSchema` accepts `target`

**Files:**
- Modify: `apps/api/src/services/scriptRunRequest.ts`
- Test: the existing co-located `executeScriptSchema` test (find with `grep -rln executeScriptSchema apps/api/src --include='*.test.ts'`); extend it

**Interfaces:**
- Consumes: `scriptRunGroupTargetSchema` (Task 1).
- Produces: `ExecuteScriptRequest` with exactly one of `deviceIds` (1-500) or `target` (`{type:'groups', groupIds}`), plus the unchanged shared fields.

- [ ] **Step 1: Write the failing tests** (use the file's existing id constants; `G` and `D` are valid GUIDs)

```ts
it('accepts a groups target in place of deviceIds', () => {
  expect(executeScriptSchema.safeParse({ target: { type: 'groups', groupIds: [G] } }).success).toBe(true);
});
it('rejects both deviceIds and target, and neither', () => {
  expect(executeScriptSchema.safeParse({ deviceIds: [D], target: { type: 'groups', groupIds: [G] } }).success).toBe(false);
  expect(executeScriptSchema.safeParse({}).success).toBe(false);
});
it('rejects targetSessionId with a group target', () => {
  const r = executeScriptSchema.safeParse({ target: { type: 'groups', groupIds: [G] }, runAs: 'user', targetSessionId: 2 });
  expect(r.success).toBe(false);
});
it('still caps explicit deviceIds at 500', () => {
  const ids = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  expect(executeScriptSchema.safeParse({ deviceIds: ids }).success).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails:** `cd apps/api && npx vitest run <that test file>`. Expected: FAIL (target not accepted).
- [ ] **Step 3: Implement.** Make `deviceIds` optional and add `target: scriptRunGroupTargetSchema.optional()`. Add `.refine((d) => (d.deviceIds != null) !== (d.target != null), { message: 'provide exactly one of deviceIds or target', path: ['target'] })`. Change the single-device refine to `d.targetSessionId == null || (d.deviceIds?.length === 1 && d.target == null)`. Keep the pool-starvation comment above `deviceIds`. Fix type fallout in every consumer of `data.deviceIds` (`routes/scripts.ts`, the fleet remediate route, the AI run-context parse in `aiToolsScripts.ts`, `scriptBuilderTools.ts`): narrow or default.
- [ ] **Step 4: Run** the test file, then `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo exit=$?`. Expected: PASS, exit=0.
- [ ] **Step 5: Commit** `feat(scripts): execute schema accepts a group target (#5237)`

### Task 3: `resolveScriptRunTargets` service

**Files:**
- Create: `apps/api/src/services/scriptRunTargets.ts`
- Test: `apps/api/src/services/scriptRunTargets.test.ts` (mocking style from `scriptExecution.admission.test.ts`)

**Interfaces:**
- Consumes: `resolveDeploymentTargetsWithWarnings` (`deploymentTargetResolver.ts`), `resolveExecutionSafeGroupIds` (`executionTargetGating.ts`), `ScriptExecutionAuth` (`canAccessOrg`), `UserPermissions` (`allowedSiteIds`).
- Produces:

```ts
export const MAX_SCRIPT_RUN_TARGETS = 500; // keep equal to the deviceIds cap in executeScriptSchema
export type ResolvedScriptRunGroup = { id: string; orgId: string; memberCount: number; refused: boolean };
export type ResolveScriptRunTargetsResult =
  | { ok: true; deviceIds: string[]; warnings: string[]; resolvedGroups: ResolvedScriptRunGroup[] }
  | { ok: false; status: 400 | 404; error: string; code: 'GROUP_NOT_FOUND' | 'NO_TARGETS' | 'TOO_MANY_TARGETS'; groupIds?: string[]; count?: number };
export function resolveScriptRunTargets(input: {
  auth: ScriptExecutionAuth;
  permissions: UserPermissions | undefined;
  target: { type: 'groups'; groupIds: string[] };
}): Promise<ResolveScriptRunTargetsResult>;
```

- [ ] **Step 1: Write the failing tests** (mock `db`, the resolver and gating helpers; helpers `mockGroups`, `mockResolve`, `id(i)` are local to the test file)

```ts
it('returns TOO_MANY_TARGETS naming the count when groups resolve to more than 500 devices', async () => {
  mockGroups([{ id: G1, orgId: O1, siteId: null }]);
  mockResolve(O1, Array.from({ length: 501 }, (_, i) => id(i)));
  const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: { type: 'groups', groupIds: [G1] } });
  expect(r).toMatchObject({ ok: false, code: 'TOO_MANY_TARGETS', count: 501 });
});
it('names missing or inaccessible group ids instead of shrinking the run', async () => {
  mockGroups([{ id: G1, orgId: O1, siteId: null }]); // G2 absent
  const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: { type: 'groups', groupIds: [G1, G2] } });
  expect(r).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND', groupIds: [G2] });
});
it('returns NO_TARGETS for an empty group', async () => {
  mockGroups([{ id: G1, orgId: O1, siteId: null }]);
  mockResolve(O1, []);
  const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: { type: 'groups', groupIds: [G1] } });
  expect(r).toMatchObject({ ok: false, code: 'NO_TARGETS' });
});
it('dedupes a device that is in two groups', async () => {
  mockGroups([{ id: G1, orgId: O1, siteId: null }, { id: G2, orgId: O1, siteId: null }]);
  mockResolve(O1, [id(1), id(1), id(2)]);
  const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: { type: 'groups', groupIds: [G1, G2] } });
  expect(r.ok && r.deviceIds).toEqual([id(1), id(2)]);
});
it('keeps allowed groups, surfaces a warning for a refused one', async () => {
  mockGroups([{ id: G1, orgId: O1, siteId: null }, { id: G2, orgId: O1, siteId: null }]);
  mockResolve(O1, [id(1)], ['Device group G2 was excluded ...']);
  const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: { type: 'groups', groupIds: [G1, G2] } });
  expect(r.ok && r.warnings).toHaveLength(1);
});
it('applies the site allowlist to the resolved set', async () => {
  mockGroups([{ id: G1, orgId: O1, siteId: null }]);
  mockResolve(O1, [id(1), id(2)]);
  mockDevicesInSites([id(1)]);
  const r = await resolveScriptRunTargets({ auth: authAll, permissions: { allowedSiteIds: [S1] } as never, target: { type: 'groups', groupIds: [G1] } });
  expect(r.ok && r.deviceIds).toEqual([id(1)]);
});
```

- [ ] **Step 2: Run to verify it fails:** `cd apps/api && npx vitest run src/services/scriptRunTargets.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** (a) `select id, org_id, site_id from device_groups where id in (...)`; (b) any requested id missing, `!auth.canAccessOrg(orgId)`, or failing the group-site check ⇒ `GROUP_NOT_FOUND` listing those ids; (c) `resolveExecutionSafeGroupIds(ids)` for the refused set; (d) per org call `resolveDeploymentTargetsWithWarnings({ orgId, targetConfig: { type: 'groups', groupIds: idsInOrg } })`, merging device ids and warnings; (e) if `permissions?.allowedSiteIds`, intersect with `select id from devices where id in (...) and site_id in (...)`; (f) dedupe; (g) empty ⇒ `NO_TARGETS`; (h) more than `MAX_SCRIPT_RUN_TARGETS` ⇒ `TOO_MANY_TARGETS` with `count`; (i) build `resolvedGroups` with per-group member counts. No `db.transaction`; runs inside the caller's short context.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): resolve group targets for script runs (#5237)`

### Task 4: Wire the route and the audit record

**Files:**
- Modify: `apps/api/src/routes/scripts.ts` (`POST /:id/execute`, ~line 1292)
- Test: `apps/api/src/routes/scripts.execute.groupTarget.test.ts` (new; model on the existing execute-route tests)

- [ ] **Step 1: Write the failing tests:** (a) `{ target: {type:'groups', groupIds:[G]} }` calls `executeScriptOnDevices` with the resolved `deviceIds` and returns 201; (b) the `script.execute` audit `details` contains `target` and `resolvedGroups`; (c) `TOO_MANY_TARGETS` returns 400 with `count` and does NOT call `executeScriptOnDevices`; (d) `GROUP_NOT_FOUND` returns 404 with `groupIds`; (e) the 201 body carries `warnings` when a group was refused; (f) a `deviceIds` request calls the service with exactly those ids (regression guard); (g) the audited device set equals the resolved set even when the mocked membership differs on a second resolve (Review Focus 4).
- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/routes/scripts.execute.groupTarget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** When `data.target` is set, call `resolveScriptRunTargets` via `withAuthDbAccessContext(auth, ...)` (short context, committed before dispatch, as #7103), map `ok:false` to `c.json({ error, code, groupIds, count }, status)`, pass the resolved ids to `executeScriptOnDevices`, add `target` / `resolvedGroups` to the audit `details`, and add `warnings` (additive) to the 201 body.
- [ ] **Step 4: Run** the new test, `src/services/scriptExecution.test.ts`, `src/services/scriptExecution.admission.test.ts`; then under `pnpm test-stack up`: `cd apps/api && npx vitest run src/__tests__/integration/runScriptNoHeldTransaction.integration.test.ts`; then `pnpm test-stack down`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): execute route accepts group targets and audits the resolved set (#5237)`

### Task 5: Server-side validation of automation `conditions` targets

**Files:**
- Create: `apps/api/src/services/automationTargetValidation.ts`
- Modify: `apps/api/src/routes/automations.ts` (create ~1349, update ~1456; the `conditions: z.unknown()` fields at ~745/759 stay, validation runs after owner resolution)
- Test: `apps/api/src/services/automationTargetValidation.test.ts`, `apps/api/src/routes/automations.targetValidation.test.ts`

**Interfaces:**
- Consumes: `automationTargetConfigSchema` (Task 1).
- Produces: `validateAutomationTargetConditions(input: { owner: { orgId: string | null; partnerId: string | null }; conditions: unknown }): Promise<{ ok: true } | { ok: false; error: string; code: 'INVALID_TARGET'; groupIds?: string[] }>`. Array, null or undefined `conditions` return `ok`.

- [ ] **Step 1: Write the failing tests:** `{type:'groups',groupIds:[]}` rejected; a group id from another org rejected for an org-owned automation; a nonexistent group id rejected; partner-wide owner + `groups` rejected with a message steering to all/filter; partner-wide owner + `devices` rejected; partner-wide + `all`/`filter` accepted; legacy array conditions accepted unchanged; an update that omits `conditions` skips validation.
- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/automationTargetValidation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Parse with `automationTargetConfigSchema` only when the value is an object whose `type` is one of the four target types; then one `select id, org_id from device_groups where id in (...)` (and `devices` likewise) in the caller's context, comparing each org to `owner.orgId`. Call it in create and update before the site-scope gate; respond 400 `{ error, code: 'INVALID_TARGET', groupIds }`.
- [ ] **Step 4: Run** both test files, then under the test stack `automationsPartnerRls.integration.test.ts` (partner-wide behaviour); tear the stack down. Expected: PASS.
- [ ] **Step 5: Commit** `feat(automations): validate target config on write, reject partner-wide group targets (#5237)`

### Task 6: Runtime fails visibly; close the site-scope gap

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts` (`resolveAutomationTargetDeviceIds` ~1058, `isUnboundedOrgWideTarget` ~1100, run start ~4050)
- Test: `apps/api/src/services/automationRuntime.groupTargets.test.ts` (new; model on `automationRuntime.runScript.test.ts`), `apps/api/src/__tests__/integration/automationGroupTargetFanout.integration.test.ts` (new)

- [ ] **Step 1: Write the failing tests (unit):** (a) a run whose `groups` target references a deleted group, or resolves to zero, ends `failed` with a log entry naming the group id and reason, not `completed` with 0 devices; (b) a refused group's warning is in the run log; (c) `isUnboundedOrgWideTarget` is true for a `groups` target containing a dynamic group or a group whose `siteId` is outside a restricted creator's allowlist; (d) a stored partner-wide `groups` automation fails with the "group targets are not supported on partner-wide automations" reason.
  **Integration (real Postgres):** two orgs under one partner, each with a group; an org-owned automation targeting org A's group resolves only org A's devices; a partner-wide `all` target fans out to both orgs; a partner-wide automation holding org A's group id never resolves org B's devices (proves `eq(devices.orgId, orgId)` holds per owner org).
- [ ] **Step 2: Run:** unit `cd apps/api && npx vitest run src/services/automationRuntime.groupTargets.test.ts` (FAIL); integration after `pnpm test-stack up`: `cd apps/api && npx vitest run src/__tests__/integration/automationGroupTargetFanout.integration.test.ts` (FAIL).
- [ ] **Step 3: Implement.** Add `resolveAutomationTargetsDetailed` returning `{ deviceIds, warnings, problems }`; `resolveAutomationTargetDeviceIds` becomes a thin wrapper so every existing caller is unchanged. At run start, non-empty `problems` finishes the run `failed` with those reasons. Verify `loadAutomationTargetAdmission` already moves out-of-scope devices out at execution time; add the site partition if not. Leave `onFailure` (`stop|continue|notify`) semantics untouched. No new dispatch cap for automations in this wave (Open Decision 5).
- [ ] **Step 4: Run** unit and integration; `pnpm test-stack down`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(automations): fail group-target runs visibly, treat dynamic groups as unbounded for site-restricted owners (#5237)`

### Wave 1 gate

- [ ] Typecheck `apps/api` (12 GB heap, read the exit code), `packages/shared` tests, all touched API tests, `pnpm db:check-drift` clean, and `git diff origin/main --stat -- apps/api/migrations apps/api/src/db/schema` empty. Open the PR `feat(scripts): device-group targets API (#5237)` with body `Refs #5237` and no closing keyword.

---

# Wave 2: Web (Run Script modal + automation editor)

Depends on W1 merged to `main` (sequential PRs, no stacking). **If W3 never ships:** the full human workflow is complete; only the AI tool lacks group targets, which is today's behaviour.

### Task 7: Enable `groups` in the automation editor

**Files:**
- Modify: `apps/web/src/components/automations/AutomationForm.tsx` (~line 682 `modes`)
- Test: `apps/web/src/components/automations/AutomationForm.test.tsx`

- [ ] **Step 1: Write the failing tests:** for an org-owned automation the `groups` mode is offered and a saved `{type:'groups', groupIds:[...]}` appears in the payload `targetConfig`; with `ownerScope === 'partner'` the `groups` mode is NOT offered and an inline note says why; editing a stored partner-wide automation whose target is `groups` shows a blocking notice.
- [ ] **Step 2: Run:** `cd apps/web && npx vitest run src/components/automations/AutomationForm.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement:** `modes={ownerIsPartner ? ['all', 'filter'] : ['all', 'groups', 'filter']}`; pass `orgId` so the selector self-fetches that org's groups. Add the `en` strings and all 7 locales.
- [ ] **Step 4: Run** the test plus `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): group targets in the automation editor (#5237)`

### Task 8: Group picker in the Run Script modal

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptExecutionModal.tsx`
- Create: `apps/web/src/components/scripts/GroupTargetPicker.tsx` (small; reuses the `DeviceTargetSelector` groups mode or the `DeviceGroupsPage` fetch pattern)
- Test: `apps/web/src/components/scripts/ScriptExecutionModal.test.tsx`

- [ ] **Step 1: Write the failing tests:** choosing "Device group" and picking groups shows the member count and the count compatible with `script.osTypes` (the modal's existing OS rule); submit sends `{ target: { type: 'groups', groupIds } }` and no `deviceIds`; a count above 500 disables submit with a sentence naming the count; offline members are shown with the existing queued-offline copy (server semantics from #5131 unchanged); `TOO_MANY_TARGETS` / `GROUP_NOT_FOUND` responses surface through `runAction` toasts; refusal `warnings` in the 201 body are displayed.
- [ ] **Step 2: Run:** `cd apps/web && npx vitest run src/components/scripts/ScriptExecutionModal.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the picker with member preview from `GET /device-groups/:id/devices` (already site-scoped). Wrap the POST in `runAction`. Mode state in component state unless the modal already uses `window.location.hash`. New strings in all 7 locales.
- [ ] **Step 4: Run** the modal test, `src/components/devices/DeviceGroupsPage.bulkScript.test.tsx` (the precedent must still pass), `src/lib/i18n/localeParity.test.ts`, and typecheck `apps/web` (12 GB heap, exit code). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): run a script on device groups from the modal (#5237)`

### Task 9 (conditional on Open Decisions 7 and 8)

"Save as dynamic group" from the Advanced filters panel and the device-list "Apply saved group as filter" are not part of W2 by default. If approved, each is its own task and PR; neither adds API surface (group create and the filter API exist).

---

# Wave 3: AI tool args + docs

Depends on W1. **If W3 never ships:** AI `run_script` keeps explicit `deviceIds` (max 10), which is today's behaviour; nothing is stranded.

### Task 10: `groupId` for AI `run_script`, resolved before the intent

**Files:**
- Modify: `apps/api/src/services/aiToolsScripts.ts` (definition ~784-807, proposal path ~257, library path ~362, `deviceArgs`), `aiToolSchemas.ts` (~1012), `aiAgentSdkTools.ts` (~1820), `scriptBuilderTools.ts` (`execute_script_on_device`), `actionIntents/runScriptSnapshot.ts`, `actionIntents/effectDigest.ts` (`run_script` resolver ~208), `mcpCoverage.ts` (~412, ~586), `aiGuardrails.ts`
- Test: `aiToolsScripts.runScript.orgEquality.test.ts`, `aiToolSchemas.runScriptProposal.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts`, `actionIntents/effectDigest.test.ts`, and new `aiToolsScripts.runScript.groupTarget.test.ts`

- [ ] **Step 1: Write the failing tests:** (a) all four declarations accept an optional `groupId` (UUID) and enforce exactly one of `deviceIds`/`groupId` (no `z.undefined()`); (b) the group is resolved to concrete ids at intent creation, the digest material pins the resolved ids and a count, and the approval summary shows the count and a short hash of the ids; (c) a resolved set above the AI cap (10) is rejected with the count, not truncated; (d) org equality: a group outside the caller's org access is refused (extend the orgEquality test); (e) release recomputes the digest and fails closed when membership changed between approval and release; (f) `mcpCoverage` still maps `run_script` for both route files; (g) the SAFE_WRITE_SITES line-keyed contract tests stay green after the edit.
- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/aiToolsScripts.runScript.groupTarget.test.ts src/services/aiToolsScripts.runScript.orgEquality.test.ts src/services/aiToolSchemas.runScriptProposal.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/actionIntents/effectDigest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Resolve in the pre-approval step with `resolveScriptRunTargets` (the same service as the route) so the intent's `args.deviceIds` is always the resolved list and the existing digest, `deviceArgs` org-equality and `.slice(0, 10)` logic apply unchanged. `manage_automations` follows Open Decision 10 (default: no change; add a test proving it cannot bypass Task 5 validation).
- [ ] **Step 4: Run** the files above plus the guardrail tests (`cd apps/api && npx vitest run src/services/aiGuardrails`) and typecheck (exit code). Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): group target for run_script, resolved before approval (#5237)`

### Task 11: Docs

**Files:**
- Modify: the scripts and automations pages under `apps/docs/` (locate with `grep -rln "Run script" apps/docs/src/content`) and the API reference entry for `POST /scripts/:id/execute`.

- [ ] Document static vs dynamic membership and the ~5 s lag, the 500 cap and its error, refused-field groups, the partner-wide automation limitation, and the audit record. Run the docs build named in `apps/docs/package.json`; commit `docs: device-group targets (#5237)`.

---

## Self-review

- Coverage: (a) modal picker → Task 8, server expansion → Tasks 3-4, cap → Task 3, save-as-dynamic-group → Open Decision 7; (b) automation `target` → Tasks 5-7 (the shape already exists as `DeploymentTargetConfig`, extended not duplicated); (c) apply-as-filter → Open Decision 8; audit → Task 4; AI → Task 10.
- Placeholders: none. The one "find with grep" (the existing schema test file) is a lookup the implementer does in seconds; all other paths are verified.
- Type consistency: `resolveScriptRunTargets`, `ResolveScriptRunTargetsResult`, `scriptRunGroupTargetSchema`, `automationTargetConfigSchema`, `MAX_SCRIPT_RUN_TARGETS` are named identically in Tasks 1-4, 8 and 10.

## Open Decisions

1. **Partner-wide automation + group target semantics.** Options: (a) disallow `groups`/`devices` on partner-wide automations; (b) resolve per org by group NAME; (c) allow ids, silently matching one org (today). **Recommend (a)**: (c) is a silent footgun and (b) needs a name-uniqueness rule that does not exist; revisit (b) with its own design.
2. **Script-run expansion location.** Options: client expands to `deviceIds` (no API change, keeps the cap, nothing for AI/API consumers); server accepts `target`. **Recommend server `target`**: AI, API consumers and the audit record all need server-side resolution, and the client path already exists as a fallback.
3. **Dynamic group membership source for runs.** Options: read materialized memberships (~5 s lag); live `evaluateFilter`. **Recommend materialized**: it matches what the user previewed and is cheap; the lag is small and bounded.
4. **Automation timing and bad-group behaviour.** Options: resolve at save/schedule time; resolve at execution time. **Recommend execution** (already the runtime behaviour), and a deleted/empty/refused group fails the run visibly instead of completing with zero devices.
5. **Max-target policy.** Options: reject above 500 naming the count; truncate; batch/queue server-side; raise the cap. **Recommend reject**: the cap protects the pool and silent truncation misleads; batching needs a pool-load study. Automations keep existing per-run behaviour with no new cap this wave.
6. **Execution-refused (agent-reported field) groups.** Options: block + warn; allow with confirmation. **Recommend block + warn + audit** (current gating): an allow path needs an audited per-group opt-in design.
7. **"Save as dynamic group" from the modal's Advanced filters.** Options: in scope; follow-up. **Recommend follow-up**: no new API surface but it doubles the modal's state and test surface; the picker ships value first.
8. **Device-list "Apply saved group as filter".** Options: in scope; follow-up. **Recommend follow-up**: different page, independent of script targeting.
9. **Extend `DeploymentTargetConfig` vs a new type.** Options: extend (for example a future `groupNames`); new script-specific type. **Recommend extend, adding nothing now**: the existing type already covers `groups`; W1 narrows it at the script boundary with `scriptRunGroupTargetSchema` instead of a new vocabulary.
10. **Should AI `manage_automations` accept group targets?** Options: yes via the shared validator; no change. **Recommend no change in this plan**: Task 5 validation already applies to anything it passes through; widening AI authoring is a separate gate decision.
11. **AI `run_script` cap (10) vs group size.** Options: reject groups resolving above 10; raise the AI cap; resolve and truncate with the count shown. **Recommend reject above the AI cap**: never inherit the 500 cap silently, and raising an unattended-execution cap is a separate safety decision.
12. **Site-scope handling of group targets for restricted creators.** Options: treat dynamic/out-of-site groups as unbounded (reject at save); allow and re-check at run time only. **Recommend both**: reject at save when a group is dynamic or outside the allowlist, and re-check at run time through the existing admission partitioning.
13. **Wave cut.** Options: W1 API / W2 web / W3 AI+docs (this plan); API+web in one wave; web-only client expansion first. **Recommend this cut**: each wave merges alone, W1 carries the tenancy risk with the least UI churn, and W3 can slip without stranding anything.
