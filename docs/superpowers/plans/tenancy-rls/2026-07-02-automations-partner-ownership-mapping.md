# Partner-Wide Automations: Call-Site Mapping (#2133)

> Pre-implementation mapping for converting the standalone `automations` table to
> dual-ownership (org XOR partner) per the partner-wide-first playbook (epic #2135).
> Produced 2026-07-02 by a repo-wide sweep; line numbers are as of main @ `01e46a73e`.

## 0. Scope disambiguation — three "automation" concepts

| System | Tables | Ownership today | Status |
|---|---|---|---|
| **Standalone automations** (this issue) | `automations`, `automation_runs` | `org_id` NOT NULL | Not converted; CRUD route deprecated but trigger runtime fully active |
| Config-policy "automation" feature | `config_policy_automations` (inline under `configuration_policies`) | inherits dual-axis from parent | Already partner-wide (2026-06-27 migration) |
| Compliance rule sets (`automationPolicies`, same schema file) | `automation_policies`, `automation_policy_compliance` | dual-owned | Already converted (#2129) — **closest reference implementation** |

## 1. Schema — `apps/api/src/db/schema/automations.ts`

- `automations` (L13-29): `orgId NOT NULL` → the table to convert; no `partnerId` yet.
- `automationRuns` (L31-44): child, nullable FK to `automations` (config-policy runs
  use `configPolicyId` instead); no own `orgId` — tenant via parent join.
- `automationPolicies` (L52-71): already dual-owned — copy-paste template.

## 2. `automations.orgId` call sites

### Routes — `apps/api/src/routes/automations.ts`
- L427-446: list-route scope filtering — partner-scope caller silently **excludes
  partner-wide rows** today (uses `accessibleOrgIds` only).
- L239-256 `getAutomationWithOrgCheck`: `auth.canAccessOrg(automation.orgId)` —
  needs a partner-wide branch (`canAccessOrg(null)` always denies).
- L658-736, 854-858, 930-936: create/update/delete keyed by resolved orgId; create
  (deprecated route) has no `ownerScope` field.
- L499-521 `/runs/:runId`: already treats `configurationPolicies.orgId === null`
  (partner-wide policy) deliberately as 404 on the org-scoped path — precedent to copy.
- L1039-1150 webhook trigger: loads by id, no org gate — unaffected.

### AI tool — `apps/api/src/services/aiToolsFleet.ts` (`manage_automations`)
- L1188-1319: plain `orgWhere(auth, automations.orgId)` on list/get/enable/disable/
  delete/run. Copy the dual-axis idiom already in the same file: `alertRuleWhere`
  (L85-95) / `notificationChannelWhere` (L100-105), gated on `auth.scope === 'partner'`.
- Create/update/delete are disabled in this tool ("manage through configuration
  policies") — narrows the write-side blast radius.

### MCP resource — `apps/api/src/routes/mcpServer.ts:1464`
- `readOrgScopedResource(..., orgCond(automations.orgId))` — org-only. NOTE: the
  `scripts` resource read (L1455) has the same gap even though scripts are already
  dual-owned — fix both while here.

### Policy remediation bridge — `apps/api/src/services/policyEvaluationService.ts`
The most consequential seam (playbook item 5):
- L940-961 `resolvePolicyRemediationAutomationIdForOrg`: `eq(automations.orgId, orgId)`
  — must also search partner-wide automations owned by the device org's partner.
- L1078-1100 `triggerRemediationAutomation`: `eq(automations.orgId, device.orgId)` —
  the exact playbook anti-pattern.
- L1765-1861 `triggerConfigPolicyRemediation`: same bug duplicated (L1782, L1818).
- L1221-1236 `evaluatePolicy`: already memoizes remediation lookup per DEVICE org
  (`remediationIdByOrg`) — the fan-out entry point to extend.

### Manual remediation — `apps/api/src/routes/policyManagement/actions.ts:189-215`
Partner-aware for the *policy* axis (inArray over partner's orgs) but still assumes
the *automation* is org-owned — a partner-wide automation matches neither branch →
404. Add `OR (automations.orgId IS NULL AND automations.partnerId = ...)`.

### No-change call sites
- `services/encryptedColumnRegistry.ts:58` (`automations.trigger` encrypted column).
- `services/tenantCascade.ts:89`: `automations` in `ORG_CASCADE_DELETE_ORDER` —
  partner-wide rows correctly survive org erasure; `purgeSyntheticPartner`
  auto-discovers `partner_id` columns, so no static list update.
- Permission labels / guardrail tiers / output truncation lists (aiGuardrails,
  aiToolSchemasFleet, aiToolOutput, roles.ts, permissionsCatalog.ts).

## 3. Trigger evaluation — `apps/api/src/jobs/automationWorker.ts`

**Already runs under system DB context** (`runWithSystemDbAccess` wraps the BullMQ
processor at L664-700 and the event-bus callback at L821-840) — RLS is not the
blocker; the blocker is app-layer `eq(automations.orgId, ...)` returning zero rows
for partner-wide automations.

| Site | Line | Gap |
|---|---|---|
| `processScanSchedules` | L324-327 | none — scans ALL enabled automations globally; partner-wide rows flow through once schema allows |
| `processTriggerSchedule` / `processTriggerEvent` | L404-409 / L445-450 | none — id lookups |
| **`queueEventTriggers`** | **L730-733** | **THE fan-out hook**: `eq(automations.orgId, event.orgId)` — needs resolve event org → partner, `OR (org_id IS NULL AND partner_id = <partner>)` |
| `resolveDeviceIdsForAssignment` | L504-563 | existing `'partner'` case = reference fan-out implementation to copy |

## 4. RLS

- `automations`: four per-command `breeze_org_isolation_*` policies in
  `0001-baseline.sql` (L15432/16293/17154/18015) → replace with ONE dual-axis
  `automations_isolation` policy, per `2026-07-01-automation-policies-partner-ownership.sql`.
- `automation_runs`: dual-parent EXISTS policies in
  `2026-05-30-fk-child-tables-rls.sql:46-69`. The `automations` branch needs the
  dual-axis parent predicate (`(a.org_id IS NOT NULL AND breeze_has_org_access(a.org_id))
  OR (a.partner_id IS NOT NULL AND breeze_has_partner_access(a.partner_id))`) —
  same shape as `maintenance_occurrences` Step 3 in
  `2026-07-01-maintenance-windows-partner-ownership.sql`. The
  `configuration_policies` branch is already dual-axis-correct.

## 5. Org-specific references inside automation definitions (`services/automationRuntime.ts`)

| Concern | Location | Fix |
|---|---|---|
| Notification channels | `notificationChannelOwnershipCondition(orgId: string)` L40-55, called L1458 with `automation.orgId` | Already dual-axis for #2130 channels but requires a non-null org — accept `{orgId, partnerId}` derived from device context |
| **Alert row org** | `executeCreateAlertAction` L1044-1081 | `alerts.orgId = automation.orgId` violates playbook rule 5 (child rows take the DEVICE's org; NULL would fail NOT NULL). Add `orgId` to `ActionExecutionContext.device` (L735-741) |
| Notification payload orgId | L1009, L892 | derive from device, not automation (cosmetic today) |
| Target resolution | `resolveAutomationTargetDeviceIds` L519-548, `resolveLegacyConditionTargets` L426-517, `checkAutomationTargetsWithinSiteScope` L616-619 | all `eq(devices.orgId, automation.orgId)` — central fan-out gap; copy `resolveDeviceIdsForAssignment`'s partner case |
| Deployment targets | L520-524 → `deploymentTargetResolver.ts:9-11` | `ResolveTargetOptions.orgId` is hard non-null and shared — loop per partner org and merge, don't change the shared contract |
| `run_script` script lookup | L1425-1436, L1900-1907 | no org filter (by id only); scripts already dual-owned — no new logic, but note there's no execution-time ownership check |
| Run-started event | `createAutomationRunRecord` L1346-1356 | `publishEvent('automation.started', automation.orgId)` — NULL for partner-wide; decide: per-device-org events, or skip |

## 6. Web UI

- `apps/web/src/components/automations/AutomationForm.tsx` / `AutomationList.tsx` /
  `AutomationEditPage.tsx`: no org/ownerScope references today — add create-only
  ownerScope selector + "All orgs" badge.
- **Copy from** `software/PolicyForm.tsx` (L14-22, 42-49, 88-111) and
  `software/ComplianceDashboard.tsx:424-427` — NOT from
  `automations/PolicyForm.tsx` (the #2129 UI never got its ownerScope selector;
  its list shows the badge but creates are org-only — flagged as a #2129 UI
  follow-up gap).

## 7. Config-policy linkage

None needed: the config-policy `automation` feature stores rows inline in
`config_policy_automations`, not via `featurePolicyId` → `automations`. Do NOT add
`automation` to `FEATURE_TABLE_MAP` / `PARTNER_LINKABLE_FEATURE_TYPES`.

## 8. Tests

- Add `automations` to `DUAL_AXIS_TENANT_TABLES`
  (`rls-coverage.integration.test.ts:204-307`), comment style per the
  `automation_policies` entry (L265-273).
- `PARENT_FK_JOIN_POLICY_TABLES` entry for `automation_runs` stays (still
  two-parent child); underlying policy gains the dual-axis predicate.
- New `automationsPartnerRls.integration.test.ts` mirroring
  `automationPoliciesPartnerRls.integration.test.ts` (L102-227 forge/XOR/isolation;
  L228-328 fan-out) — the fan-out block must prove `queueEventTriggers` matches a
  partner-wide automation for a device event in a member org, against real Postgres.
- Existing unit suites to extend: `routes/automations.test.ts`,
  `automationRuntime*.test.ts`, `automationWorker.test.ts` (no dual-axis cases today).

## 9. Migration plan

New `2026-07-0X-automations-partner-ownership.sql` combining:
- Step 1+2 of `2026-07-01-automation-policies-partner-ownership.sql`
  (`partner_id` column, `org_id` DROP NOT NULL, `automations_one_owner_chk`,
  `automations_partner_id_idx`, single `automations_isolation` dual-axis policy).
- Step 3 of `2026-07-01-maintenance-windows-partner-ownership.sql` shape for the
  `automation_runs` EXISTS-join policies (re-issue same policy names; keep the
  `configuration_policies` OR-branch untouched).

## 10. Implementation sweep checklist (playbook item 7)

1. `routes/automations.ts` — ownerScope + dual-axis reads gated on partner scope
2. `services/aiToolsFleet.ts` — `automationWhere` per `alertRuleWhere`
3. `routes/mcpServer.ts` — automations resource (+ fix the same gap on scripts)
4. `services/policyEvaluationService.ts` — three `eq(automations.orgId, deviceOrg)` sites
5. `routes/policyManagement/actions.ts` — partner-wide-automation OR-branch
6. `jobs/automationWorker.ts` `queueEventTriggers` — core event fan-out + integration test
7. `services/automationRuntime.ts` — target resolution fan-out; device-org child rows;
   channel condition signature; run-started event shape
8. Web UI ownerScope + badge
9. `rls-coverage` allowlist + new partner RLS integration suite
