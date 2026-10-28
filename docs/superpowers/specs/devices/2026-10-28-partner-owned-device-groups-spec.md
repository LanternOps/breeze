---
title: Partner-owned (cross-org) device groups with dynamic rules
status: draft 2026-10-28 — awaiting decisions (§6); advisor quorum Opus + Codex gpt-6-astra xhigh (§8)
date: 2026-10-28
issues: "#10498 (this spec); #10497 (prerequisite, Wave 0)"
related: "#8957 (per-assignment filters), #7414 (tag filter on partner-wide assignments), #9408 / plan #10014 (monitor Deploy-to targets), #6339 (picker lists other orgs' groups), #2135 (Partner-Wide First), #3182 (membership composite FKs), #9179 (group exclusion)"
---

# Partner-owned device groups

Evidence labels: **verified** = read in source at `bd22427dfe` (main, 2026-10-28); **inferred** =
reasoned from code, not executed. File paths are relative to `apps/api/src/` unless they start with
`apps/`, `docs/` or `migrations/` (= `apps/api/migrations/`).

## 1. Problem

An MSP wants one target such as "every device, in every customer org, that has PowerChute Business
Edition Agent installed" and wants to hang monitors on it once. That is the ConnectWise Automate
pattern. An MSP prospect migrating from Automate named its absence a blocker.

- A device group belongs to exactly one org: `device_groups.org_id NOT NULL`, no `partner_id`
  (`db/schema/devices.ts:685-701`). Memberships pin `group.org_id = membership.org_id =
  device.org_id` with two composite FKs (`:703-735`; `migrations/2026-10-09-000200-…:129-156`).
  (verified)
- So the MSP builds one dynamic group per org, plus one `device_group` assignment per group on a
  partner-wide policy (`services/configurationPolicy.ts:2460-2470`), and repeats both for every new
  org and every new product. (verified)
- The predicate already exists: `software.installed` / `software.notInstalled` compile to `EXISTS` on
  `software_inventory.name` (`services/filterEngine.ts:130-131, 479-515`). A trigram index covers
  `name` (`db/schema/software.ts:250`). (verified)
- Software-keyed groups never re-evaluate after save, because nothing emits `device.software_changed`
  (#10497; `events/deviceEvents.ts:257-262` handles the event, but no code emits it). (verified)

## 2. Users and scope

**Partner (MSP) level is the new capability.**
- A partner user with full org access (`canManagePartnerWidePolicies`,
  `partnerWideAccess.ts:25-29`) creates, edits and deletes partner-owned groups.
- A group spans every org of the partner except Quick Support and the unassigned-pool holding org.
- A partner-owned policy targets the group with one `device_group` assignment, and monitors reach
  devices through that policy.
- A partner user with `orgAccess = selected` can read partner groups but not write them, and sees
  only the members in orgs they can access. (inferred from RLS)

**Organization level: authoring is unchanged, visibility is read-only.**
- Org groups keep today's behaviour, including site binding.
- Org users see a partner group as its name, a badge, and their own org's members; the filter is
  redacted (Open Decision 5).
- In v1 an org user cannot reference a partner group from an org policy or an org group rule (Open
  Decision 2).

## 3. Proposed design

### 3.1 Shape

- `device_groups` becomes `org_id XOR partner_id`, following the Partner-Wide First playbook.
- A partner row has `org_id IS NULL`, `site_id IS NULL` and `parent_id IS NULL`, all enforced by
  CHECK constraints. Partner groups do not nest in v1.
- An org group cannot have a partner parent. A deferred constraint trigger checks only the owner
  kind, so the order in which a merge repoints rows cannot trip it (`parent_id` has no FK).
- The owner is fixed at create time:
  - `partner_id` is immutable.
  - `org_id` changes only NOT NULL → NOT NULL, which is the merge repoint.
  - No conversion between owner kinds.
- v1 partner groups are **dynamic only, with no pinning** (Open Decision 4). The schema does not
  forbid static rows.
- **v1 filter limits.**
  - A partner group refuses `groupId` and `orgId` conditions, and an org group may not reference a
    partner group.
  - `groupId` is refused because it hides the referenced group's provenance from execution gating
    (§3.4). It also escapes event freshness, since the referencing group's `filter_fields_used` is
    just `['groupId']` (`groupMembership.ts:596`).
  - `orgId` is refused because `orgId = <loser>` stops matching after a merge
    (`orgMergeExecutors.ts:40` never rewrites filter literals).
  - `siteId` stays legal, as a cross-org value list.

### 3.2 Membership integrity

**Shape.** `device_group_memberships.org_id` stays the **device's** org, so membership RLS is
unchanged. `device_group_memberships_group_org_fk` is dropped, because it cannot express "the group's
partner is the device org's partner". The single-column `group_id` FK and
`device_group_memberships_device_org_fk` stay.

**Forward check.** `breeze_check_device_group_membership_owner()` is a constraint trigger:
`AFTER INSERT OR UPDATE OF group_id, org_id`, `FOR EACH ROW`, `DEFERRABLE INITIALLY DEFERRED`,
`SECURITY DEFINER`.
- It elevates to system scope and restores the caller's GUCs, as `2026-07-30-…:14-29` does.
- It **re-reads the current row**, because a deferred trigger holds a historical `NEW`. It skips
  when the row is gone or has been superseded.
- It raises 23503 when `g.org_id = m.org_id OR (g.org_id IS NULL AND g.partner_id = o.partner_id)`
  **`IS NOT TRUE`**. A plain `NOT (…)` evaluates to NULL for a foreign-partner group and would pass.

**Why DEFERRED, not IMMEDIATE (verified).** The FK it replaces is already `INITIALLY DEFERRED`, on
purpose: `IMMEDIATE` 23503'd device moves in CI, and the move trigger's second cleanup pass relies on
a COMMIT-time check (`2026-10-09-000200-…:98-134`). The merge needs only deferrability. The CLAUDE.md
`IMMEDIATE` rule covers new composite FKs.

**Reverse check.** The FK also policed the parent side; two triggers replace that.
- A BEFORE UPDATE trigger on `device_groups` rejects any `partner_id` change and any `org_id`
  NULL↔NOT NULL flip.
- A deferred constraint trigger `AFTER UPDATE OF org_id, partner_id ON device_groups` revalidates
  that group's surviving memberships at COMMIT. This lets the merge's two-statement repoint pass.

**Org reparent.** An `organizations` `AFTER UPDATE OF partner_id` trigger deletes the org's
memberships in the old partner's groups, with a WARNING count.
- It takes **exclusive** export locks on the old and new partners first, then
  `breeze_partner_export_lock_orgs_under_exclusive_partners`.
- That order is forced (verified). The org-update export trigger needs exclusive partner locks
  (`2026-07-21-…:140-150`), and a shared→exclusive upgrade raises (`2026-07-22-…:35`).
- Reparenting is test-only today (verified by grep).

**Device move.** `breeze_cascade_device_org_id()` (newest body: `2026-11-05-100000`) already deletes a
moved device's memberships. Its safety net `g.org_id <> dgm.org_id` (`:266-270`) becomes the trigger
predicate `IS NOT TRUE`.

### 3.3 Evaluation

Membership stays **materialized**. Resolvers read memberships by device id
(`featureConfigResolver.ts:142-144, 772-774, 1535-1537`), so effective config, monitors and patching
need nothing beyond §3.4. (verified)

1. **W0 = #10497, shipped alone.** When an accepted report changes the device's installed-name set
   (exact set compare), the inventory ingest (`routes/agents/inventory.ts:108-160` →
   `softwareInventoryObservations.ts:319`) calls `requestDeviceGroupReevaluationAfterCommit`
   (`device.software_changed`). The device org-move path also requests a full re-evaluation; today it
   requests none (verified). W0 fixes the per-org workaround on its own.
2. **One evaluation core.** `resolveEffectiveGroupMembers` (`groupMembership.ts:100-138`) also
   powers evaluation, so it is not billing-only. It becomes `(group, evaluationOrgId)`. Billing
   callers (`groupIncludesDevice`, contracts) keep an org-only guard.
3. **Per-device path.**
   - `updateDeviceMembership` (`:545-612`) and the `device.created` handler (`deviceEvents.ts:265-305`)
     also select `org_id IS NULL AND partner_id = <device org's partner>`, keeping `ORDER BY id`
     (#3911). Holding-org and Quick Support devices are skipped.
   - `evaluateDeviceMembershipForGroup` (`:281-379`) replaces the `devices.org_id = group.org_id`
     guard (`:301`). It writes the **device** org to the membership and its log; today it writes
     `group.orgId`, at `:353`.
4. **Whole-group path.** Create, filter edit and the sweep enqueue `evaluate-partner-group` after
   commit, keyed by group id.
   - *Revisions.* Migration A adds `filter_revision`, `evaluated_revision`, `evaluated_at` and
     `evaluation_failed_orgs` (integer). An edit bumps `filter_revision`. A job that finishes on a
     stale revision re-enqueues itself, as the active-job follow-up does (`deviceGroupJobs.ts:169`).
     The API returns `evaluation: { state, evaluatedAt, failedOrgs }`.
   - *Org discovery.* Partner orgs are listed with `excludeQuickSupportOrgs()` and
     `notHoldingOrgCondition()` (`monitorScriptWorker.ts:100-135`), paged by ascending UUID cursor,
     50 per job. The 500-org cap there is not copied: it returns an empty list
     (`monitorScriptWorker.ts:126`).
   - *One fresh DB context per org.* Discovery's `withSystemDbAccessContext` is closed before any org
     is touched; each org then gets its own context and transaction. Nested contexts would reuse the
     ambient one (`db/index.ts:911`) and give savepoints. Separate transactions are needed because
     membership writes fire `breeze_touch_devices_after_membership_*` → `UPDATE devices` →
     partner-export org locks, which must ascend by UUID within a transaction
     (`2026-07-18-partner-export-org-locks.sql:120-150`). The rule is verified; the trigger chain is
     inferred from the `2026-10-09` header.
   - *Writer coordination.* The per-org write and the per-device path both take
     `pg_advisory_xact_lock(hash(group_id, org_id))` and recompute their diff under it, so a
     whole-group diff cannot overwrite a newer per-device result.
   - *Timeout isolation.* The 500 ms `statement_timeout` (`filterEngine.ts:874`) applies per org. A
     failing org keeps its previous members, is never read as "zero matches", and counts in
     `evaluation_failed_orgs`. The UI shows "N orgs not evaluated · last good evaluation <time>".
     Peripheral scheduling (`groupMembership.ts:30`, an unbounded `Promise.all`) moves to after
     commit, batched per org.
5. **Safety sweep.** Every 6 h, jittered, at queue concurrency 1, the sweep re-runs (4) for dynamic
   partner groups and for org groups whose filter fields overlap `software.*`. It is a retry
   cadence, not a freshness guarantee. Events carry freshness, and no SLA is promised.

**Load (unmeasured; benchmarking is a W2 exit criterion).**
- 200 orgs × 10 partner groups is 2,000 per-org filter queries per sweep, plus diffs and triggers.
- At the timeout ceiling, that is about 17 min of filter time.
- A software rollout to 10k devices across 10 groups is about 100k per-device evaluations, coalesced.
- W2 benchmarks a 2,000-device org and a 10k-device churn, and bounds concurrency from the results.

### 3.4 Assignment resolution and execution gating

- **Who may target a partner group:** in v1, partner-owned policies only (Open Decision 2).
  - `validateAssignmentTarget`'s partner branch (`configurationPolicy.ts:2460-2470`) also accepts
    `g.partner_id = policy.partnerId`.
  - The org branch (`:2521-2529`) already rejects a NULL `org_id`. Its error text changes to say why.
  - `authorizeAssignmentTarget` (`:2616-2640`) already fails closed for site-restricted callers,
    because a partner group has `site_id NULL`. (verified)
- **DB functions.** Each of these is replaced from its newest body. The `device_group` branch
  resolves `COALESCE(g.partner_id, owner_org.partner_id)` and treats `target_org_id IS NULL` as
  partner-owned. Advisory-lock identities gain `partner:<g.partner_id>`.
  - `breeze_validate_config_policy_assignment_target`, `_lock_config_policy_assignment_rows` and
    `_validate_config_policy_assignment_new_rows` (`2026-07-29`).
  - `breeze_enforce_config_policy_assignment_integrity` and `_serialize_…_owner_updates`
    (`2026-07-30`). The owner-tuple compare adds `partner_id`.
  - `_owner_deletes` (`2026-10-15-120001`).
  - `breeze_partner_export_assignment_orgs` (`2026-07-24:224-241`). A partner-group assignment
    touches every partner org, the same as partner level.
- **Expansion.** The join `eq(deviceGroups.orgId, deviceGroupMemberships.orgId)` resolves **zero
  devices** for a partner group, silently. It appears in `configPolicyAssignmentDevices.ts:194`
  and `jobs/automationWorker.ts:964,995` (config-policy automation schedules). It becomes
  `(g.org_id = m.org_id OR (g.org_id IS NULL AND g.partner_id = organizations.partner_id))`, keeping
  each subset clamp. The same fix applies at `routes/partnerApi/configuration.ts:228`.
- **Precedence.** A partner-group assignment is `device_group` level, priority 4
  (`featureConfigResolver.ts:62-66`). It therefore beats org- and site-level assignments of other
  policies, where a partner-level assignment (priority 1) would lose. This is the same rule as for org
  groups, and the docs must say so.
- **Gating tiering is unchanged.** Software-keyed groups are refused for execution-gated features and
  allowed for protective ones. W1 also hardens `resolveExecutionSafeGroupIds`
  (`executionTargetGating.ts:60-67`) so that an id with no visible row comes back as refused, with
  `refusedFields: ['unresolvable']`; the SELECT-only partner branch must never widen an execution
  target. `featureConfigResolver.ts:1417` already fails closed. Partner groups refuse `groupId` rules
  (§3.1), so field provenance never crosses a group boundary for them.

### 3.5 Other target surfaces

- **Monitor Deploy-to (#9408, plan #10014).** `createPolicyFor` already mints a partner-owned policy
  for a partner-wide monitor and calls `validateAssignmentTarget`
  (`routes/monitorDefinitions.ts:329-420`). After §3.4 it accepts a partner group unchanged; only the
  dialog's group list changes. This lands after #10014.
- **Refused in v1 (Open Decision 3).** Each of these surfaces answers a partner group with an
  explicit 400 at the write endpoint, never a silent zero-target resolution:
  - script runs and direct automation targets
  - software deployments (`routes/software.ts:1168`)
  - endpoint messages and agent run scope
  - maintenance windows (`routes/maintenance.ts:420`)
  - peripheral targets (`peripheralEffectivePolicy.ts:123`)
  - alert rules and templates
  - backup SLA configs: refuse at `routes/backup/sla.ts:46,128`, not in the worker
  - contract lines, quote lines and contact roles: already impossible through their composite FK;
    the 23503 maps to 400
  - the enrollment default group and `organization_users.device_group_ids`
  - Fleet Design, flows, and the legacy `routes/devices/groups.ts` API
- Partner-wide automations already refuse group ids (`automationTargetValidation.ts:68`, verified).

### 3.6 Visibility, API and AI tools

- **RLS.** One dual-axis policy replaces the four baseline policies
  (`0001-baseline.sql:15575, 16436, 17297, 18158`): `system OR org-access(org_id) OR
  partner-access(partner_id)`.
  - A separate `FOR SELECT` policy, `device_groups_partner_wide_select`, adds `org_id IS NULL AND
    partner_id = breeze_current_partner_id()` (template `2026-10-05-110000-…`).
  - The agent-auth path needs that policy for the gating read in §3.4.
  - `XOR_OWNERSHIP_DUAL_AXIS_TABLES` asserts the policy exists
    (`rls-coverage.integration.test.ts:1021-1070`).
- **List default.** `GET /groups` gains `ownerScope=organization|partner|all`, and the default is
  `organization`.
  - Every existing picker therefore sees org groups only, with no change: contracts, quotes, org
    defaults, script targets, `AutomationEditPage.tsx:280`, `PolicyEditPage.tsx:79`,
    `SLAConfigDialog.tsx:69` and `DevicesPage.tsx:739`.
  - Only `DeviceGroupsPage`, the partner-policy assignment picker and Deploy-to ask for more.
- **Reads.**
  - Partner scope uses `orgCondition OR (org_id IS NULL AND partner_id = auth.partnerId)`.
  - Org scope gets the same predicate, read-only, through the SELECT branch.
    `ensureOrgAccess(group.orgId)` (`routes/groups.ts:199-218`) becomes an owner-aware helper.
  - Org-scope responses **redact** `filterConditions` and `rules`, which `routes/groups.ts:268`
    returns today, because a filter can name other customers' site ids.
  - Counts and member lists are read under membership RLS. The member list gains an org column.
- **Writes.** `POST /groups` takes `ownerScope`.
  - `partner` requires `canManagePartnerWidePolicies`, and the partner id comes from the token.
  - `partner` refuses `orgId`, `siteId`, `parentId`, `type: 'static'`, and `groupId` or `orgId`
    filter conditions.
  - `PATCH` omits `ownerScope`. Add, remove and pin are refused for partner groups.
  - Partner preview runs per org within a 5 s budget and returns `partial: true` when it runs out.
- **Delete.** `deviceGroupDelete.ts:94-110` deletes memberships (member orgs) and then assignments
  (every partner org), which can request a lower-UUID org late. Fix: pre-lock the union first,
  partners exclusive, then the orgs under them.
- **AI tools.** `manage_groups` (`aiToolsFleet.ts:1665-1966`) reads partner groups, redacted for org
  scope, and refuses all mutations on them. No tool is added.

### 3.7 Relationship to #8957 and #7414, and the alternatives

- **#8957 is complementary.** A partner group is a reusable, named, cross-org object. An
  assignment filter is criteria owned by one policy, together with the `config_assignments_unique`
  relaxation. Both share the filter catalog and the provenance tiering.
- **#7414 is largely covered.** A tag-keyed partner group on a partner policy reaches the same
  devices. Two differences remain: the assignment is priority 4, not 1 (§3.4), and tags stay
  execution-refused. Open Decision 8 settles it.
- **Alternatives** (Open Decision 1, raised by the quorum):
  - **(B) Partner templates materialized as managed org groups.** Keeps the FKs and resolvers, but
    needs provisioning for new orgs, propagation of template edits, N×M groups across orgs, and N
    assignments per policy.
  - **(C) Partner-level assignment predicates** (#8957 extended). No ownership change, and it keeps
    partner precedence. But the predicate repeats on every policy and every deployment, and there
    is no named object to preview or reuse.

## 4. Tenancy and data model impact

### 4.1 Migrations

Two hand-written files. Both sort after `2027-01-10-110000-pam-user-notify-capability.sql`, the
newest migration on main; the plan names them.

- **A: reshape `device_groups` (W1).** It elects system scope first.
  - `partner_id uuid REFERENCES partners(id)`; `org_id` becomes nullable.
  - `device_groups_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`.
  - For partner rows, a CHECK that `site_id IS NULL AND parent_id IS NULL`.
  - A partner index and the revision columns (§3.3).
  - The owner-immutability BEFORE UPDATE trigger and the deferred parent-kind trigger.
  - The four baseline policies are replaced by the dual-axis policy plus the SELECT branch.
  - No backfill is needed. `device_groups_id_org_id_uniq` stays as the target of the contract, quote
    and contact-role FKs.
- **B: membership and assignment integrity (W1, same PR).**
  - Drop `device_group_memberships_group_org_fk`.
  - Add the forward and reverse triggers and the reparent detach (§3.2).
  - `CREATE OR REPLACE` the seven §3.4 functions and `breeze_cascade_device_org_id()`. Each starts
    from its newest body, verbatim, and only the device-group branch changes; the PR carries a diff
    against the source migration.
  - Add `partner_id` to the `UPDATE OF` lists on `device_groups`.
- Integration suites replay migrations through `replayMigration`.

### 4.2 Registrations (grep, don't judge)

| Contract | Change |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:599-600`) | Entries unchanged. Org erasure deletes that org's memberships (`org_id` is the device org) and its org groups, and leaves partner groups alone. Test: erasing one org keeps the partner group and the other orgs' memberships. |
| Partner purge, `cascadeDeletePartner` (`tenantCascade.ts:2707-2960`) | The `partner_id` column makes discovery automatic. No FK orders polymorphic assignments before `device_groups`, and the group-delete trigger raises on a still-targeted group (inferred). Add an explicit pre-step that clears assignments targeting the partner's groups. Test a full purge, and a retry after partial progress. |
| `orgMergeRegistry.ts:1012-1013` | `repoint` stays. Merges are intra-partner only (`orgMerge.ts:486, 562, 835`). The deferred reverse trigger allows the two-statement repoint, and partner filters carry no `orgId` literals (§3.1). Test: merge with a partner-group member. |
| `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:410`) | Add `partner_id` and the four revision columns to `included`. Partner rows never appear in an org export, because `tenantExport.ts:159` selects by org. Partner-group memberships are exported as org data, carrying an external group id; the precedent is `parent_policy_id` (`:336`). Boundary test: own memberships and logs are in, partner definitions are out. |
| `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES` | Add `device_groups`. New `deviceGroupsPartnerRls.integration.test.ts`: cross-partner forge 42501; XOR and site/parent CHECK 23514; org isolation; the SELECT branch from org and agent contexts; a cross-partner membership rejected at COMMIT. |
| `deviceGroupMembershipTenantFks.integration.test.ts` | Re-point the REJECTS cases at the trigger. Add: insert→delete and invalid→corrected inside one transaction (both commit); a device-move cleanup; a group owner change with surviving memberships (rejected); an org reparent that holds memberships. |
| `orgLifecycleFoundations` merge contract | It no longer sees the dropped FK. Add an assertion that the trigger is deferrable. |

### 4.3 `device_groups.org_id` dependency sweep (playbook step 7)

**Counts.** The literal `rg -l 'deviceGroups\.orgId'` over non-test files finds 35 files (the
issue's count, confirmed by the quorum). The full dependency sweep finds 65 non-test files: 55 API,
2 shared, 8 web. It adds raw SQL on `device_groups`, generic `table.orgId` readers, and web and
shared consumers, plus nine migrations that define live objects.

**Method.** The sweep was delegated. Six of its claims were checked in source (verified):
`auditFallbackOrg.ts:107`, `automationWorker.ts:964/995`, `monitors/conversion/convert.ts:885`,
`automationTargetValidation.ts:68`, `devices/core.ts:1693` and `backupSlaWorker.ts:126`. The quorum
added and verified the rows marked †.

**Classes.**
- **NULL**: breaks silently on a NULL `org_id`.
- **DUAL**: must also read partner groups.
- **GATE**: a write path that needs the owner gate.
- **ORG**: stays org-only and refuses partner groups.
- **MEM**: resolves via memberships, so it needs no change.

| File : lines | Class | Action (wave) |
|---|---|---|
| `groupMembership.ts:100-138` (eval core)†, `:301,353,413,438,583` | NULL | `(group, evaluationOrgId)` core; device-org writes; partner scan (W2) |
| `groupMembership.ts:172,185` (`groupIncludesDevice`), contract billing callers | ORG | Reject partner groups (W2) |
| `groupMembership.ts:501-534, 615-663, 802-831` (prune, pin, manual add) | ORG (v1) | Refuse partner groups (W2) |
| `configPolicyAssignmentDevices.ts:194`; `jobs/automationWorker.ts:964,995` | NULL | Partner-aware join, §3.4 (W2) |
| `events/deviceEvents.ts:120,277` | DUAL | Include the device-org partner's groups (W2) |
| `routes/groups.ts:199-218` (`ensureOrgAccess(null)`), `:268` (DTO)† | NULL | Owner-aware helper; redaction (W2) |
| `routes/groups.ts:303-321, 1189-1192` (list, preview) | DUAL | `ownerScope` param, default `organization`; partner preview (W3) |
| `routes/groups.ts:520-941` (POST, PATCH, DELETE); `:1009-1151, 1223-1360` (add, remove, pin) | GATE | §3.6 writes (W3) |
| `routes/devices/groups.ts:59-548` (legacy duplicate API) | ORG | Stays `?orgId`-only; refuse partner ids (W2) |
| `deviceGroupDelete.ts:73-76, 94-110` | GATE | Owner-aware lookup; pre-lock (W3) |
| `groupFilterRefs.ts:66` | GATE | Reject `groupId` refs to or from partner groups (W3) |
| `auditFallbackOrg.ts:107-114` | NULL | Partner-group writes audited partner-level (W3) |
| `aiToolsFleet.ts:1710,1743,1808` (read), `:1836-1966` (writes) | DUAL / GATE | Read with redaction; refuse writes (W3) |
| `aiToolsFleet.ts:658-664`; `configurationPolicy.ts:2617-2621`; `routes/devices/core.ts:1693` | DUAL (RLS) | Correct once the SELECT branch exists (W1) |
| `configurationPolicy.ts:2461-2466` / `:2522-2526` | DUAL / ORG | Partner-policy branch accepts; org branch keeps rejecting (W3) |
| `routes/partnerApi/configuration.ts:227-229`; `wisp/readiness.ts:159`; `aiAgents/designEvidence.ts:526` | DUAL | Join through the membership or device org (W2) |
| `maintenanceSiteScope.ts:108,196-200`; `routes/peripheralControl.ts:287-299,333-336` | DUAL | Partner group is not "stale" or "foreign" in display (W2) |
| `routes/maintenance.ts:420`†; `peripheralEffectivePolicy.ts:123`†; `routes/backup/sla.ts:46,128`†; `routes/alerts/rules.ts:79-86`; `routes/alertTemplates/siteScope.ts:71-80` | ORG (v1) | Refuse at write; workers keep org filters (W2) |
| `scriptRunTargets.ts:78-112`; `deploymentTargetResolver.ts:81,192`; `automationRuntime.ts:1094-1100`; `routes/software.ts:1168`; `routes/endpointMessages/resolveTargets.ts:71-79`; `aiAgents/runResourceScope.ts:53` | ORG (v1) | Refuse at write, explicit 400 (W2) |
| `automationTargetValidation.ts:68-79`; `jobs/backupSlaWorker.ts:126`; `monitors/conversion/convert.ts:885-889` | ORG | Already refuses, or predates partner groups |
| `contractService.ts:231-238,367-371`; `contractSnapshot.ts:66`; `deviceCoverage.ts:165`; `quoteService.ts:1058,1721`; `quoteAcceptService.ts:349`; `contacts/responsibilities.ts:152,270` | ORG | Composite FK forbids; 23503 → 400 (W2) |
| `enrollmentDefaultGroup.ts:50`; `routes/orgs.ts:870-875`; `effectiveSettings.ts:92-103`; `mcpInvites/tools/configureDefaults.ts:62`; `routes/users.ts:141,1800` | ORG | Reject partner ids. `organization_users.device_group_ids` is stored but never enforced (W2) |
| `fleetDesign/{apply,ledger,rollback,preview,drift}.ts`; `flows/{fleetGroups,ownedReferences}.ts` | ORG | Org groups only |
| `orgMergeRegistry.ts:1013`; `tenantCascade.ts:600`; `tenantExportPolicyRegistry.ts:410`; `extensions/tenancyTripwire.ts:44` | ORG | §4.2 |
| About 20 membership readers, e.g. `featureConfigResolver.ts:144,774,1352`, `monitors/monitorResolver.ts:309`, `alertService.ts:998`, `routes/agents/helpers.ts:2264…3878` | MEM | Unchanged |
| `packages/shared/src/types/index.ts:352`; `types/filters.ts:210` | Type | `orgId: string \| null`, `partnerId` (W3) |
| Web org-only pickers: `ContractEditor.tsx:514`, `QuoteLineRows.tsx:309`, `QuoteBlockCard.tsx:149`, `OrgDefaultsEditor.tsx:183`, `GroupTargetPicker.tsx:80`, `DeviceTargetSelector.tsx:178`, `AutomationEditPage.tsx:280`†, `PolicyEditPage.tsx:79`†, `SLAConfigDialog.tsx:69`†, `DevicesPage.tsx:739`† | ORG | Unchanged thanks to the list default |
| `AssignmentsTab.tsx:131-155, 488`†; `DeviceGroupsPage.tsx:259,326`; `CreateGroupModal.tsx`; `DeployMonitorDialog.tsx` | DUAL | W4. Partner policies render `OrganizationScopePanel` (`:488`), which has no group section; one must be added |

## 5. Out of scope

- Static partner groups, pinning and nesting (Open Decision 4).
- Partner groups as targets outside config-policy assignments and Deploy-to (Open Decision 3).
- Org-owned policies, or org-group rules, referencing partner groups (Open Decision 2).
- Vendor and version predicates (Open Decision 6).
- A partner-level default enrollment group.
  - No setting is added. Under Settings rule 9 the count stays at 1, the org Defaults tab
    (`routes/orgs.ts:868-873`).
  - `ownerScope` is a create-time attribute, not a setting.
- Partner-owned saved filters (`db/schema/filters.ts:7`).
- `config_assignments_unique` changes (#8957).
- Converting owner kinds.

## 6. Open Decisions

> **Gate A ruling, 2026-10-28:** the owner chose (A) for OD1 and accepted the recommendation on every other decision below (OD2–OD8). Each **Recommend** line is now the ruling.

1. **Approach.** Options: (A) partner-owned groups, as this spec proposes; (B) partner templates
   materialized as managed org groups; (C) partner-level assignment predicates (#8957 extended).
   §3.7 has the detail. (A) is the largest tenancy change but the only one that gives a named,
   reusable cross-org object. (B) keeps the FKs but needs a reconciler and N×M copies. (C) changes
   no ownership and keeps partner precedence, but repeats the predicate on every policy.
   **Evidence for (C), added 2026-10-28 (verified):** a filter is already a first-class execution
   target elsewhere. `DeploymentTargetConfig` has `type: 'filter'`
   (`packages/shared/src/validators/filters.ts:270-301`); `DeviceTargetSelector.tsx:232-234` lets
   the user pick a saved view and copies its conditions into the target; Automations (partner-owned
   allowed, `schema/automations.ts:43-51`), Software Deployment and Security Sweeps use it; and
   `deploymentTargetResolver.ts:92-126` evaluates it per org at run time with the same
   execution-tier refusal as groups (`inlineFilterHasExecutionRefusedFields`, `:99-113`). Saved
   views themselves are org rows (`saved_filters.org_id NOT NULL`, `routes/filters.ts:300-335`) but
   their conditions carry no org, and the device-list preview already spans every accessible org
   for a partner user (`routes/filters.ts:140-150`). So a variant (C′) exists: add `type: 'filter'`
   to config-policy assignments (#8957), reusing the target config, selector and resolver, and
   optionally make `saved_filters` org XOR partner so the view is the named, reusable object.
   (C′) needs no ownership change on `device_groups`, no membership trigger and no 65-file sweep;
   its costs are the ~20 resolver call sites #8957 already counted and the lack of a materialized,
   browsable membership (no member list, no "what will this hit" page, per-evaluation filter cost
   on the effective-config path). For the requesting prospect's case (monitors only) (C′) would
   be sufficient. **Owner ruling, 2026-10-28: (A).** The owner wants the materialized cross-org
   membership for its resolver cost at scale (one indexed read per device instead of a filter
   evaluation per policy per device), audit by membership row, one consistent answer for every
   consumer, and the later options it enables (pinning, exclusions, join/leave hooks). (C′) stays
   the complementary per-assignment mechanism under #8957 and is not replaced by this spec.
2. **Who may reference a partner group.** Options: (a) partner-owned policies only, and no org-group
   rule may reference one; (b) org-owned policies too, clamped to the policy's org
   (`configPolicyAssignmentDevices.ts:129` already clamps), with `groupId` references allowed.
   **Recommend (a).** Option (b) reopens the provenance and freshness gaps in §3.1.
3. **v1 target surfaces.** Options: (a) config-policy assignments and monitor Deploy-to only, with an
   explicit 400 at every other write; (b) also scripts, automations, maintenance and peripheral
   targets. **Recommend (a)**, with (b) as a follow-up issue.
4. **Static partner groups, pinning and nesting.** Options: (a) dynamic only, with no pinning and no
   nesting; (b) all three in v1. **Recommend (a).** The schema allows (b) later. A hand-picked
   cross-org list fits device-level assignments (#9408) better.
5. **What org users see.** Options: (a) the name, a badge, and their own org's members and count,
   with the filter redacted; (b) hidden from org-scope list and get. The RLS SELECT branch stays
   either way, because the agent path needs it. **Recommend (a).** The quorum agrees, provided the
   filter stays redacted; without redaction it prefers (b).
6. **Software predicate breadth.** Options: (a) name only, as today; (b) vendor and version.
   **Recommend (a)**, and file (b) as its own issue, since it applies to org groups too.
7. **Freshness.** Options: (a) event-driven plus a 6 h sweep; (b) an hourly sweep; (c) a daily
   sweep. **Recommend (a)**, with no SLA wording. W2 measures queue latency and shows per-org
   failures.
8. **#7414 disposition.** Options: (a) close it after W4, if the requester accepts group-level
   precedence; (b) fold the remainder into #8957. **Recommend keeping #7414 open until W4, then
   (a)**, with a precedence test and docs; otherwise (b). This recommendation changed after the
   quorum (§8).

## 7. Test and rollout notes

Each wave ships on its own. No partner group can exist before W3, so the create route is the gate
and no feature flag is needed.

- **W0 — #10497.** Software-change and org-move re-evaluation. Integration test: a device gains and
  then loses membership in a software-keyed group as its inventory reports change.
- **W1 — schema and integrity.** Migrations A and B, the §4.2 registrations and tests, and
  fail-closed execution gating. Exit: the full Integration Tests job passes, not just Test API.
- **W2 — readers and evaluation, dark.** The §4.3 NULL, DUAL and ORG rows; the evaluation core; the
  job with revisions, pagination and writer locks; the sweep; refusals at write endpoints. Tests: a
  fan-out integration test (two orgs, a partner policy, effective config on both devices) and a
  precedence test. Exit: the §3.3 load benchmarks.
- **W3 — create and assign API.** `ownerScope` and its gate, preview, the
  `validateAssignmentTarget` branch, redaction, the delete pre-lock and AI tools. Route tests: 403
  for `orgAccess = selected` and for org scope.
- **W4 — UI and docs.**
  - `CreateGroupModal.tsx` gets a scope selector (pattern: `software/PolicyForm.tsx`).
  - `DeviceGroupsPage.tsx` gets a badge, status and an org column.
  - `OrganizationScopePanel` gets a device-group section for partner policies.
  - `DeployMonitorDialog.tsx` follows once #10014 lands.
  - `apps/docs/.../features/device-groups.mdx` lines 8 and 31 currently say groups are org-only.
    Update them and document the group-level precedence.

## 8. Advisor quorum

The author (Opus) wrote this spec first. Codex `gpt-6-astra` at reasoning effort `xhigh` then
reviewed it read-only against `bd22427dfe`, with source access. The output is in the session
scratchpad as `codex-10498.md`. Verdict: **"revise before implementation; the ownership model is
viable; Wave 0 is worth shipping independently."** Every Codex point was checked in source before it
was adopted. Codex reviewed an earlier draft whose Open Decisions 1–7 are 2–8 here; the
numbers below use this document's numbering.

**Agreed.**
- The `org_id XOR partner_id` shape.
- A deferred trigger in place of the composite FK. Codex accepted DEFERRED over IMMEDIATE.
- The registrations and the partner-purge pre-clear.
- Open Decisions 3, 4 and 6 at (a). Open Decision 2 at (a), with org→partner references deferred too.

**Raised by Codex and adopted** (now in the body):
- **Trigger and locks:**
  - reverse revalidation when a group's owner changes
  - re-reading the current row in the deferred trigger
  - `IS NOT TRUE` to avoid the NULL trap
  - exclusive partner locks for the reparent detach (`2026-07-22:35` rejects a shared→exclusive
    upgrade; verified)
  - a pre-lock when deleting a partner group
- **Org merge:** parent ordering and `orgId` filter literals. Resolved by giving partner groups no
  parent and refusing `orgId` and `groupId` filters.
- **Evaluation:**
  - one evaluation core, since `resolveEffectiveGroupMembers` is not billing-only
  - a fresh DB context per org, because nested contexts become savepoints
  - revisions, writer locks and a visible failure status
  - cursor pagination instead of the 500-org cap, which returns an empty list
  - the load estimate marked unmeasured, with benchmarks as a W2 exit criterion
- **Surfaces I missed:**
  - the `OrganizationScopePanel` partner-policy UI (`AssignmentsTab.tsx:488`)
  - backup SLA, maintenance-window and peripheral targets, now refused at write
  - four unqualified web pickers, made safe by the `ownerScope=organization` list default
  - org-scope filter redaction
- **Counts:** the literal grep finds 35 files and the dependency sweep 65. Both are stated in §4.3.

**Disagreements.**
- **#7414.** I had called partner groups "exact" coverage of #7414, but Codex showed the precedence
  differs: group priority is 4, partner priority is 1. Resolved Codex's way: Open Decision 8 now
  waits for W4 and a precedence test.
- **Approach.** Codex wants (B) and (C) weighed before committing to the full migration. I still
  recommend (A). Left open as Open Decision 1.
- **Freshness.** Codex conditions 7(a) on four things. Dependency propagation is now moot, because
  references are refused. Resumable fan-out, failure visibility and measured latency are W2 exit
  criteria.
