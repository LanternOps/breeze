---
tracking_issue: LanternOps/breeze#9408
status: plan-drafted
---

# Monitor Deploy to… — device-group and device targets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Deploy to…" on a monitor can target a device group or one or more specific devices directly, and the editor shows where the monitor is deployed by target, not only by policy name.

**Architecture:**
- The deployment unit stays the configuration policy. Deploy to… mints a dedicated policy named after the monitor and assigns it at the chosen level. The device's effective config is still resolved in one place (`resolveEffectiveConfigWithExecutor`, `resolveMonitorsForDevice`), and both resolvers already honor `level = 'device'` (`configurationPolicy.ts:2775`, `monitorResolver.ts:312`). No second targeting system.
- The API change is the gap between the attach route and the rest of the policy system: `attachSchema` stops at `device_group` while `config_assignment_level` already includes `device` and `validateAssignmentTarget` / `authorizeAssignmentTarget` already handle it (`configurationPolicy.ts:2447`, `:2507`, `:2619`). One policy may receive several device assignments in one call.
- Dynamic group membership is materialized by the `device-group-reevaluation` queue (`apps/api/src/jobs/deviceGroupJobs.ts:82`) and read live by both resolvers, so a register that joins the "Cash" group later picks the monitor up with no new code.
- The editor's Deployed card gains the assignment targets of each attached policy, and the devices table's empty Source column is fixed (the endpoint omits `sourcePolicyName`).

**Tech Stack:** Hono + Zod (API), Drizzle (queries only), React + react-i18next (web), Vitest.

**Spec:** GitHub issue #9408 (problem statement, proposed solution, alternatives) plus the maintainer position in the 2026-10-21 comment: keep the configuration policy as the deployment unit, add the device level, show the source in the editor. No separate spec document.

**Out of scope (tracked elsewhere):**
- `create_ticket` as a monitor response is #5238 (track:spec). This plan does not add it; the Deployed card and targets are useful without it.
- Dynamic assignment filters beyond role/OS are #8957.
- Changing the existing-policy picker (which policies it lists) is not touched.

## Global Constraints

- Migrations: none. `config_assignment_level` already contains `device` (`apps/api/src/db/schema/configurationPolicies.ts:70-76`).
- Every new user-visible string lands in all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR` under `apps/web/src/locales/<code>/monitoring.json` (localeParity test in `apps/web/src/lib/i18n`).
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); the dialog already does.
- Device-target limit per call: **100** (matches no existing constant; declare `MAX_DEVICE_TARGETS_PER_ATTACH = 100` in the route file).
- Default policy name when the client sends none: `Monitor: <monitor.name>` (existing server default, unchanged).
- Test commands: `cd apps/api && npx vitest run <file>` and `cd apps/web && npx vitest run <file>`. Never `pnpm --filter … test -- --run`.
- Settings Rule 9 (PR template): this adds no setting; it adds a target level to an existing action. Places the concept "where a monitor is deployed" is configured: before 1 (Deploy to… dialog), after 1.

## Review Focus

1. **A device in the list that belongs to another org.** Expect 403 from `authorizeAssignmentTarget` / `validateAssignmentTarget` for *that* id and no policy created. Pinned in Task 1 (test "rejects when any device target fails validation; no policy row is written").
2. **The same device twice in `targetIds`.** Expect one assignment and one audit row. `assignPolicy` is `ON CONFLICT DO NOTHING` on `(configPolicyId, level, targetId)`, so the index will not fail, but the de-duplication keeps `targetCount` honest. Pinned in Task 1 (de-duplicate before the transaction; test "duplicate device ids collapse to one assignment").
3. **A partner-wide monitor deployed to devices.** The owner is `{ partnerId }`; `validateAssignmentTarget` must see the device under that partner. Pinned in Task 1 (test "partner-wide monitor → device target under a partner org").
4. **A device removed from a dynamic group after deploy.** No code in this plan; the resolver reads memberships live. Pinned in Task 2 by asserting the devices endpoint only lists resolved devices (existing behaviour, regression test).
5. **Deployed card for a policy with 40 device assignments.** Show a count, not 40 names. Pinned in Task 4 (test "more than three targets render as a count").

---

### Task 1: API — `device` level and multiple targets on `POST /monitor-definitions/:id/attachments`

**Files:**
- Modify: `apps/api/src/routes/monitorDefinitions.ts:329-344` (schema), `:386-435` (create branch)
- Test: `apps/api/src/routes/monitorDefinitions.test.ts` (extend `describe('POST /monitor-definitions/:id/attachments')` at `:488`)

**Interfaces:**
- Consumes: `validateAssignmentTarget(policyOwner, level, targetId)` (`configurationPolicy.ts:2392`), `authorizeAssignmentTarget(auth, level, targetId)` (`:2555`), `createConfigPolicy(owner, data, userId, executor)` (`:315`), `assignPolicy(configPolicyId, level, targetId, priority, userId, roleFilter?, osFilter?, executor)` (`:2351`).
- Produces: request shape
  ```ts
  createPolicyFor: {
    level: 'organization' | 'site' | 'device_group' | 'device';
    targetId?: string;      // uuid; required unless targetIds is given
    targetIds?: string[];   // uuid[], 1..100, only valid with level 'device'
    name?: string;          // 1..255
  }
  ```
  Response unchanged: `201 { data: { configPolicyId, monitorId } }`.

- [ ] **Step 1: Write the failing tests** in `monitorDefinitions.test.ts`, following the existing `createPolicyFor` cases at `:950` for mocks:

```ts
it('createPolicyFor level=device creates one policy and one device assignment', async () => {
  // POST with { createPolicyFor: { level: 'device', targetId: DEVICE_A } }
  expect(res.status).toBe(201);
  expect(assignPolicy).toHaveBeenCalledWith(POLICY_ID, 'device', DEVICE_A, 0, USER_ID);
  expect(createConfigPolicy).toHaveBeenCalledWith(expect.anything(), { name: `Monitor: ${MONITOR_NAME}` }, USER_ID);
});
it('createPolicyFor level=device with targetIds creates one policy and N assignments', async () => {
  // targetIds: [DEVICE_A, DEVICE_B, DEVICE_C]
  expect(createConfigPolicy).toHaveBeenCalledTimes(1);
  expect(assignPolicy).toHaveBeenCalledTimes(3);
});
it('duplicate device ids collapse to one assignment', async () => {
  // targetIds: [DEVICE_A, DEVICE_A]
  expect(assignPolicy).toHaveBeenCalledTimes(1);
});
it('rejects when any device target fails validation; no policy row is written', async () => {
  // validateAssignmentTarget resolves { valid:false, error:'…' } for DEVICE_B only
  expect(res.status).toBe(403);
  expect(createConfigPolicy).not.toHaveBeenCalled();
});
it('rejects targetIds with a non-device level', async () => {
  // { level: 'site', targetIds: [SITE_A] } → 400 from zod refine
  expect(res.status).toBe(400);
});
it('rejects more than 100 device targets', async () => { expect(res.status).toBe(400); });
it('partner-wide monitor → device target under a partner org validates against { partnerId }', async () => {
  expect(validateAssignmentTarget).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER_ID }, 'device', DEVICE_A);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/monitorDefinitions.test.ts -t "device"`
Expected: FAIL (zod rejects `level: 'device'` with 400 today).

- [ ] **Step 3: Change `attachSchema`** in `monitorDefinitions.ts:329-344`: add `'device'` to the enum, make `targetId` optional, add `targetIds: z.array(z.string().uuid()).min(1).max(MAX_DEVICE_TARGETS_PER_ATTACH).optional()`, and a `.superRefine` on `createPolicyFor` that requires exactly one of `targetId` / `targetIds` and allows `targetIds` only when `level === 'device'`. Note zod 4.6: `superRefine` is skipped after an earlier failed check in the same object, so keep the uuid/array checks on the fields and the exclusivity rule in the refine.

- [ ] **Step 4: Change the create branch** at `:386-435`: compute `const targets = [...new Set(body.createPolicyFor.targetIds ?? [body.createPolicyFor.targetId!])]`; run `validateAssignmentTarget` then `authorizeAssignmentTarget` for **every** id before opening the transaction (first failure returns 403 with that error); inside the existing `db.transaction`, call `createConfigPolicy` once and `assignPolicy(policy.id, level, id, 0, auth.user.id)` per target, exactly as the existing branch does at `:425-431` (the callers run inside the request transaction context, so a failed assignment rolls the policy back without an explicit executor). Keep the audit action `monitor.attach`; add `targetLevel` and `targetCount` to its details.

- [ ] **Step 5: Run the file**

Run: `cd apps/api && npx vitest run src/routes/monitorDefinitions.test.ts`
Expected: PASS, including the pre-existing site-ceiling cases at `:950`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.test.ts
git commit -m "feat(monitors): Deploy to… accepts a device level and multiple device targets (#9408)"
```

### Task 2: API — attachment targets on `GET /monitor-definitions/:id`, and `sourcePolicyName` on `/devices`

**Files:**
- Modify: `apps/api/src/routes/monitorDefinitions.ts:227-258` (GET one), `:664-683` (GET devices)
- Test: `apps/api/src/routes/monitorDefinitions.test.ts`

**Interfaces:**
- Consumes: `configPolicyAssignments` (`schema/configurationPolicies.ts:206-220`), `sites` (`schema/orgs.ts:289`), `deviceGroups` (`schema/devices.ts:675`), `devices` (`schema/devices.ts:15`), `configurationPolicies`.
- Produces: each item in `data.attachments` gains
  ```ts
  assignments: Array<{ level: 'partner'|'organization'|'site'|'device_group'|'device'; targetId: string; targetName: string | null }>
  ```
  and each row of `GET /monitor-definitions/:id/devices` gains `sourcePolicyName: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('GET /monitor-definitions/:id returns assignments with target names per attachment', async () => {
  // one attachment whose policy has assignments: device_group GROUP_A ("Cash registers"), device DEVICE_A ("POS-01")
  expect(res.body.data.attachments[0].assignments).toEqual([
    { level: 'device_group', targetId: GROUP_A, targetName: 'Cash registers' },
    { level: 'device', targetId: DEVICE_A, targetName: 'POS-01' },
  ]);
});
it('an organization-level assignment carries the org name; an unknown target carries null', …);
it('GET /monitor-definitions/:id/devices returns sourcePolicyName for each row', async () => {
  expect(res.body.data[0].sourcePolicyName).toBe('Monitor: POS process');
});
it('GET /monitor-definitions/:id/devices lists only devices the resolver resolves the monitor for', …); // regression pin for Review Focus 4
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/monitorDefinitions.test.ts -t "assignments|sourcePolicyName"`
Expected: FAIL (`assignments` undefined; `sourcePolicyName` undefined).

- [ ] **Step 3: Implement `loadAssignmentTargets(policyIds: string[]): Promise<Map<string, Assignment[]>>`** as a local helper in `monitorDefinitions.ts` (or `apps/api/src/services/monitors/monitorAttachments.ts` if it already exports helpers of this kind): one `select` on `configPolicyAssignments where configPolicyId in (...)`, then one lookup per level that appears (`sites.name`, `deviceGroups.name`, `devices.displayName ?? hostname`, `organizations.name`; partner level → `null` name). Attach the result to each attachment in the GET-one handler. Device display name must follow the same `displayName || hostname` rule the devices endpoint uses at `:667`.

- [ ] **Step 4: Add `sourcePolicyName`** to the devices endpoint using the same pattern as `apps/api/src/routes/devices/monitors.ts:82-99` (collect `sourcePolicyId`s, one `select id,name from configurationPolicies`, map).

- [ ] **Step 5: Run the file**

Run: `cd apps/api && npx vitest run src/routes/monitorDefinitions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.test.ts apps/api/src/services/monitors/monitorAttachments.ts
git commit -m "feat(monitors): attachment targets and source policy name on the monitor read endpoints (#9408)"
```

### Task 3: Web — device target in `DeployMonitorDialog`

**Files:**
- Modify: `apps/web/src/components/monitoring/DeployMonitorDialog.tsx` (`TargetLevel` `:16`, state `:39-48`, name effect `:65-74`, submit `:76-108`, level list `:174`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json` (`deploy.*`)
- Test: `apps/web/src/components/monitoring/DeployMonitorDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 request shape; `GET /devices?orgId=<orgId>&limit=…` (the editor already loads `/devices` at `MonitorEditor.tsx:613`; reuse the same fetch helper).
- Produces: `type TargetLevel = 'organization' | 'site' | 'device_group' | 'device'`; new state `selectedDeviceIds: string[]`; payload `createPolicyFor: { level: 'device', targetIds: selectedDeviceIds, name }`.

- [ ] **Step 1: Add locale keys** (en values; translate for the other 7):
  - `deploy.levels.device`: "specific devices"
  - `deploy.selectDevices`: "Devices"
  - `deploy.devicesSelected_one`: "{{count}} device selected", `deploy.devicesSelected_other`: "{{count}} devices selected"
  - `deploy.deviceSearch`: "Search devices"
  - `deploy.noDevicesSelected`: "Pick at least one device."
  - `deploy.tooManyDevices`: "Pick at most {{max}} devices."

- [ ] **Step 2: Write the failing tests** in `DeployMonitorDialog.test.tsx` under the existing `describe` (mock `fetchWithAuth` per `:5`):

```ts
it('offers a device level and posts targetIds for the selected devices', async () => {
  // choose level "specific devices", check POS-01 and POS-02, submit
  expect(postBody.createPolicyFor).toEqual({ level: 'device', targetIds: [DEVICE_1, DEVICE_2], name: 'Monitor: POS process' });
});
it('keeps Attach disabled until at least one device is checked', …);
it('auto-names the policy "Monitors — <device name>" for one device and "Monitor: <monitor name>" for several', …);
it('filters the device list by the search box', …);
```
  (Auto-name rule: one device → `Monitors — ${deviceName}` to match the site/group pattern at `:65-74`; several → leave `policyName` empty so the server default `Monitor: <monitor.name>` applies.)

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/monitoring/DeployMonitorDialog.test.tsx`
Expected: FAIL (no "specific devices" option).

- [ ] **Step 4: Implement**: extend `TargetLevel`; add `devices` + `selectedDeviceIds` + `deviceQuery` state; load `/devices` for the dialog's `orgId` when `level === 'device'` (same `fetchWithAuth` + `UNAUTHORIZED` pattern as sites/groups at `:50-62`); render a checkbox list (max height, scroll, `data-testid="deploy-monitor-device-<id>"`) with a search input and a selected-count line; disable Attach when `selectedDeviceIds.length === 0` or `> 100`; add `'device'` to the level array at `:174`; in `handleSubmit` send `targetIds` for the device level and `targetId` otherwise.

- [ ] **Step 5: Run the file and the locale parity test**

Run: `cd apps/web && npx vitest run src/components/monitoring/DeployMonitorDialog.test.tsx src/lib/i18n`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/monitoring/DeployMonitorDialog.tsx apps/web/src/components/monitoring/DeployMonitorDialog.test.tsx apps/web/src/locales/*/monitoring.json
git commit -m "feat(web): Deploy monitor to specific devices (#9408)"
```

### Task 4: Web — Deployed card shows targets; Source column populated

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx:1103-1141` (Deployed card list items), the `attachments` type near the fetch of `GET /monitor-definitions/:id`
- Modify: `apps/web/src/locales/*/monitoring.json` (`editor.*`)
- Test: `apps/web/src/components/monitoring/MonitorEditor.test.tsx`, `apps/web/src/components/monitoring/MonitorDevicesTable.test.tsx` (both exist)

**Interfaces:**
- Consumes: Task 2 `assignments[]` and `sourcePolicyName`.
- Produces: no new exports.

- [ ] **Step 1: Add locale keys** (en; translate ×7):
  - `editor.target.organization`: "Organization: {{name}}", `editor.target.site`: "Site: {{name}}", `editor.target.device_group`: "Device group: {{name}}", `editor.target.device`: "Device: {{name}}", `editor.target.partner`: "Partner-wide"
  - `editor.targetCount_one`: "{{count}} target", `editor.targetCount_other`: "{{count}} targets"
  - `editor.noTargets`: "Policy has no assignments"

- [ ] **Step 2: Write the failing tests**

```ts
it('renders each attachment with its targets under the policy name', async () => {
  // attachments: [{ policyName:'Monitor: POS process', assignments:[{level:'device_group',targetName:'Cash registers'}] }]
  expect(screen.getByText('Device group: Cash registers')).toBeInTheDocument();
});
it('more than three targets render as a count', async () => {
  // 5 device assignments → "5 targets", not five names
  expect(screen.getByText('5 targets')).toBeInTheDocument();
  expect(screen.queryByText('Device: POS-04')).toBeNull();
});
it('a policy with no assignments says so', …);
it('MonitorDevicesTable shows sourcePolicyName in the Source column', …);
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/monitoring/MonitorEditor.test.tsx src/components/monitoring/MonitorDevicesTable.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement** in the Deployed card `<li>`: keep the policy link; below it a muted line listing up to **3** targets joined by " · " using `editor.target.<level>`, or `editor.targetCount` when there are more than 3, or `editor.noTargets` when empty. `MonitorDevicesTable.tsx:90` already renders `row.sourcePolicyName`; no change beyond the test once Task 2 ships.

- [ ] **Step 5: Run the files**

Run: `cd apps/web && npx vitest run src/components/monitoring`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/monitoring apps/web/src/locales/*/monitoring.json
git commit -m "feat(web): monitor Deployed card lists assignment targets (#9408)"
```

### Task 5: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/features/monitors.mdx` (the Deploy to… section)

- [ ] **Step 1: Document** the four targets (existing policy, organization, site, device group, specific devices), that Deploy to… creates a dedicated policy named `Monitor: <name>` assigned at that level, that dynamic group membership changes are picked up automatically, and that the Deployed card lists the targets. One short paragraph plus the updated list; no screenshots required.

- [ ] **Step 2: Build check**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/features/monitors.mdx
git commit -m "docs(monitors): Deploy to… device group and device targets (#9408)"
```

---

## PR checklist

- Branch `fix/9408-monitor-deploy-device-targets`, PR body `Closes #9408`, Refs #5238 and #8957 (do not use closing keywords for those).
- CI: `test-api`, `test-web` cover every task; no migration, so Check Migrations and the RLS/cascade suites are unaffected. No new `apps/api/src/services` file unless `loadAssignmentTargets` is placed in `monitorAttachments.ts` (existing file, so `parkedFanout.contract.test.ts` needs no entry).
- Lab leg: none (no agent change).
