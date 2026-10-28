---
title: Partner-owned device groups — implementation plan
issue: 10498
spec: docs/superpowers/specs/devices/2026-10-28-partner-owned-device-groups-spec.md
status: draft
tracking_issue: LanternOps/breeze#10521
waves: [W0, W1, W2a, W2b, W3, W4]
---

# Partner-owned device groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a partner (MSP) define one dynamic device group that spans every customer org, such as "every device with PowerChute Business Edition Agent installed", and target it once from a partner-owned configuration policy or a partner-wide monitor's Deploy-to.

**Architecture:** `device_groups` becomes `org_id XOR partner_id` (Partner-Wide First, #2135). Memberships stay materialized and keep the **device's** org. A deferred, NULL-safe constraint trigger replaces the `(group_id, org_id)` composite FK. Partner groups are evaluated per org, each org in its own transaction, by a revisioned BullMQ job, with a 6 h safety sweep. Every resolver keeps reading memberships by device id, so effective config needs no resolver change.

**Tech Stack:** PostgreSQL (hand-written SQL migrations, RLS, constraint triggers), Hono + Drizzle (`apps/api`), BullMQ, Vitest (unit, integration, RLS coverage), React islands (`apps/web`), Starlight docs (`apps/docs`).

**Spec:** `docs/superpowers/specs/devices/2026-10-28-partner-owned-device-groups-spec.md` (Gate A approved 2026-10-28; OD1 = (A); every **Recommend** line in §6 is the ruling). Executors read both documents.

Evidence labels: **verified** = read in source on `main` `bd22427dfe` (= `origin/main` on 2026-10-28) while writing this plan; **inferred** = reasoned from code, not executed. Paths are relative to the repo root unless a section says otherwise.

## Wave map

| Wave | Title | Size | Depends on | Migration | Rigor |
|---|---|---|---|---|---|
| W0 | Software-change and org-move group re-evaluation (#10497) | S | — | no | low (TDD, no ceremony) |
| W1 | Schema, membership integrity, RLS, registrations, fail-closed gating | L | — (lands after W0 by convention) | **yes, 3 files** | **full** (tenancy, RLS, migrations) |
| W2a | Type flip and readers: nullable `orgId`, partner-aware joins, write refusals (dark) | L | W1 | no | **full** (tenancy fan-out) |
| W2b | Evaluation engine: per-device path, per-org job, revisions, sweep, benchmark (dark) | L | W2a | no | **full** (concurrency, locks) |
| W3 | Create and assign API: `ownerScope`, gate, preview, delete pre-lock, assignment branch, AI tools | M | W2b | no | **full** (auth gate) |
| W4 | UI and docs | M | W3 | no | low |

Each wave is one PR to `main` and mergeable on its own. No partner group can exist before W3, because the W3 create route is the only writer. There is no feature flag. W0's sub-issue is #10497 itself; attach it as a wave at registration instead of minting a new issue.

## Spec deviations and clarifications

- **D1 (W0 event type).** The spec (§3.3.1) and #10497 name `device.software_changed`. The re-evaluation job carries only `'device.created' | 'device.updated'` (`apps/api/src/jobs/deviceGroupJobs.ts:90`), and its coalescing lattice `mergeReevaluationRequests` (`:127-137`) knows only those two (verified). W0 therefore enqueues `eventType: 'device.updated'` with `changedFields: ['software.installed','software.notInstalled']`. Dotted fields pass through `mapChangedFieldsToFilterFields` unchanged (`apps/api/src/events/deviceEvents.ts:180-185`, verified). The unused `device.software_changed` handler is left as is.
- **D2 (W0 parked-device no-op).** Parked-device assignment, also an org move, requests `device.updated` with no `changedFields` (`apps/api/src/services/unassignedPool/assignParkedDevice.ts:460-466`). The `device.updated` handler runs only when `changedFields.length > 0` (`deviceEvents.ts:228-236`), so the request is a no-op (verified by reading, not executed). W0 switches both this call and the move route to `eventType: 'device.created'`. The lattice documents that event as "evaluates EVERY dynamic group in the org" (`deviceGroupJobs.ts:120-126`).
- **D3 (Drizzle nullability lands in W2a, not W1).** W1 makes the DB column nullable but keeps Drizzle `orgId: .notNull()`. Flipping the type breaks compilation at every `group.orgId: string` consumer. The flip also turns `device_groups` into a partner-axis table for `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, whose rule is "`partner_id` column whose `org_id` is absent or NULLABLE" (verified). Both effects belong to the W2 sweep, so the flip opens W2a. During W1 the Drizzle type is a known, documented lie with zero runtime exposure, because no partner row can exist until W3. W1 tests insert partner rows with raw SQL. `pnpm db:check-drift` does not compare Drizzle to the DB (`apps/api/scripts/check-drift.ts:17-27`, verified).
- **D4 (W2 split).** Spec §7's W2 ("readers and evaluation") ships as two waves: W2a (type flip, readers, refusals) and W2b (evaluation engine and benchmark). Together they touch about 50 files, more than one review can cover. Both stay dark.
- **D5 (three migration files, not two).** Spec §4.1 Migration B becomes B1 (membership integrity) and B2 (the seven assignment-integrity functions). B2 alone copies about 900 lines of function bodies verbatim, and a file of its own keeps its diff against the sources reviewable. All three files land in the W1 PR.
- **D6 (no `UPDATE OF` list to extend).** Spec §4.1 says "add `partner_id` to the `UPDATE OF` lists on `device_groups`". No such trigger remains: `2026-07-30-serialize-bulk-config-assignment-target-moves.sql:424-427` dropped them all. The surviving owner triggers are statement-level `AFTER UPDATE` and `AFTER DELETE` with no column list (`:483-491`, verified). The change therefore moves into `breeze_serialize_config_policy_assignment_owner_updates`, whose shared `ELSE` branch compares `(id, org_id)` for sites, devices and groups (`:216-220`). B2 splits out an `ELSIF TG_TABLE_NAME = 'device_groups'` branch that compares `(id, org_id, partner_id)`. Sites and devices have no `partner_id`.
- **D7 (FK-name assertions).** Five tests pin `device_group_memberships_group_org_fk` (verified):
  - `apps/api/src/routes/devices/moveOrg.coverage.test.ts:1536-1550` (unit). It greps migrations, so it would keep passing on the 2026-10-09 file after the FK is dropped.
  - Integration suites `deviceGroupMembershipTenantFks` (`:199`), `groupMembership.resolve` (`:110`), `groupMembership.parity` (`:141`) and `dynamicGroupMembershipMaterialization` (`:265`).

  W1 re-points all five at the new trigger name. Spec §4.2 names only the first suite.
- **D8 (trigger classification).** The new `BEFORE UPDATE` row trigger on `device_groups`, an `org_id` table, must be classified in `ORG_ID_BENIGN_TRIGGERS` in `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts:323`. Otherwise that suite fails closed (`:840-856`, verified). Spec §4.2 does not list this.
- **D9 (partner purge pre-clears).** Spec §4.2 adds a pre-step that clears assignments. W1 also pre-clears `group_membership_log` and `device_group_memberships` rows whose `group_id` is a partner group. Both tables FK `device_groups` with no `ON DELETE` (`apps/api/src/db/schema/devices.ts:744-748`, verified). Such rows outlive the per-org cascades when their org was reparented away or is a held shell that `cascadeDeletePartner` skips (`apps/api/src/services/tenantCascade.ts:2741-2756`) (inferred).
- **D10 (writer-lock order).** Spec §3.3.4 says both writers take `pg_advisory_xact_lock(hash(group_id, org_id))`. The per-device job is one transaction across several groups, because `withDbAccessContext` opens a transaction (`apps/api/src/db/index.ts:898-912`, verified). If that job took each lock lazily, it could hold a `devices` row lock from an earlier group's `breeze_touch_devices_after_membership_*` write while it waits on a whole-group writer that needs the same row. That is a 40P01 deadlock (inferred). W2b therefore takes **all** of a device's `(group, org)` locks up front, in ascending group-id order, before its first membership write.
- **D11 (error codes).** W2a adds `PARTNER_GROUP_TARGET_UNSUPPORTED` and `PARTNER_GROUP_READ_ONLY` to `packages/shared/src/constants/errorCodes.ts`; W3 adds `PARTNER_GROUP_FILTER_UNSUPPORTED`. Each code needs an `errors.json` key in all 8 web locales. The spec does not list them.
- **D12 (Deploy-to does not wait for #9408).** The spec says this work "lands after #10014". #10014 is the merged plan PR; the implementation (#9408) is still open. The API already accepts `createPolicyFor.level = 'device_group'` (`apps/api/src/routes/monitorDefinitions.ts:337`), and the dialog already lists groups from `/groups` (`apps/web/src/components/monitoring/DeployMonitorDialog.tsx:59`) (verified). W4 only asks for `ownerScope=partner` when the monitor is partner-wide. If #9408's PR lands first, W4 rebases onto it.
- **D13 (issue summary).** The #10498 issue comment lists the zero-device expansion join under W1. Spec §4.3 puts it in W2, and this plan follows the spec (W2a, Task 2a.3).

## Global Constraints

- **Ownership:**
  - `device_groups` rows are `org_id XOR partner_id` (`device_groups_one_owner_chk`).
  - A partner row has `site_id IS NULL AND parent_id IS NULL` (`device_groups_partner_shape_chk`).
  - `partner_id` is immutable. `org_id` changes only NOT NULL → NOT NULL, which is the merge repoint. Owner kinds never convert.
- **v1 partner groups are dynamic only:** no static groups, pinning, manual add or nesting. A partner group refuses `groupId` and `orgId` filter conditions; `siteId` stays legal. An org group may not reference a partner group.
- **Membership org:** `device_group_memberships.org_id` is always the **device's** org. So is every `group_membership_log.org_id` written for that membership.
- **Who may target a partner group:** only **partner-owned** configuration policies. The assignment is `device_group` level, priority 4 (`apps/api/src/services/featureConfigResolver.ts:62-66`), so it beats org- and site-level assignments of other policies. The docs must say so.
- **v1 target surfaces:** config-policy assignments and monitor Deploy-to. Every other write surface answers a partner group id with **400 `PARTNER_GROUP_TARGET_UNSUPPORTED`**. None resolves it silently to zero targets.
- **Org span:** a partner group covers every org of its partner except Quick Support orgs (`excludeQuickSupportOrgs()`, `apps/api/src/services/quickSupportOrg.ts:12`) and the holding org (`notHoldingOrgCondition()`, `apps/api/src/services/unassignedPool/selectorPredicate.ts:41`).
- **Org-scope responses** redact `filterConditions` and `rules` on partner groups, and show only the caller's own org's members and count.
- **Write gate:** writes to partner groups are gated on `canManagePartnerWidePolicies(auth)` (`apps/api/src/services/partnerWideAccess.ts:25-29`). The partner id always comes from the token.
- **List default:** `GET /groups` defaults to `ownerScope=organization`.
- **Partner preview:** evaluated per org within a 5 s total budget, returning `partial: true` when the budget runs out.
- **Freshness:** events plus a 6 h jittered sweep. No SLA wording in the UI, the docs or API copy.
- **Software predicate:** name only (`software.installed` / `software.notInstalled`).
- **Settings:** no setting is added (see Settings rule 9 below).

## Review Focus

1. **Device move between two orgs of the same partner.** The move trigger deletes every membership (`breeze_cascade_device_org_id`, newest body `apps/api/migrations/2026-11-05-100000-…:93-99`). Partner-group membership must come back through W0's re-evaluation. Test: W2b Task 2b.5, "same-partner move restores partner-group membership".
2. **A new org, or a device in Quick Support or the holding org.** A device enrolled in a brand-new org joins through `device.created`. QS and holding devices never join. Tests: W2b Task 2b.2.
3. **Filter edit while a job is mid-pagination.** The stale job re-enqueues, and `evaluated_revision` never moves backwards. Test: W2b Task 2b.4.
4. **Deleting a partner group** with members in many orgs and several assignments. It runs in one transaction with no "ascending UUID" lock abort. Test: W3 Task 3.3.
5. **Partner user with `orgAccess = selected`.** List, count and member list are limited to accessible orgs, orgs outside the selection never produce a 500, and every write returns 403. Test: W3 Task 3.2.

## Partner-Wide First playbook mapped to waves

| Step | Where |
|---|---|
| 1. Migration (XOR, CHECK, partner index, one dual-axis policy) | W1 Migration A |
| 2. Write gate `canManagePartnerWidePolicies`; `ownerScope` on create, omitted on update | W3 Tasks 3.2 and 3.5. W2a makes partner groups read-only until then |
| 3. Reads: SELECT-only `device_groups_partner_wide_select`; app-layer owner-aware reads | W1 Migration A (RLS); W2a Task 2a.5 (owner-aware get, redaction); W3 Task 3.1 (`ownerScope` list) |
| 4. Linkage: assignment validation and DB triggers | W1 Migration B2 (DB functions); W3 Task 3.4 (`validateAssignmentTarget`). No feature-type registration: groups are targets, not feature links |
| 5. Fan-out by the device org's partner | W2a Task 2a.3 (expansion joins and the fan-out integration test); W2b (evaluation) |
| 6. Tests and UI | W1 Task 1.4 (`DUAL_AXIS_TENANT_TABLES`, `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, `deviceGroupsPartnerRls.integration.test.ts`); W4 (scope selector, "All orgs" badge) |
| 7. Repo-wide `deviceGroups.orgId` sweep | Next section |

## `device_groups.org_id` sweep by wave (playbook step 7)

`rg -l 'deviceGroups\.orgId' apps packages ee` over non-test files returns **35** (verified, matching spec §4.3). The table below also covers raw-SQL readers, membership readers, shared types and web. Paths are under `apps/api/src/` unless they start with `apps/` or `packages/`.

| Wave | Files (class) |
|---|---|
| W1 | `db/schema/devices.ts` (`partnerId`, revision columns, drop the `groupOrgFk` declaration); `services/executionTargetGating.ts` (fail closed); `services/tenantCascade.ts` (partner pre-clears); `services/tenantExportPolicyRegistry.ts:410`. DUAL through RLS, no code change: `services/aiToolsFleet.ts:658-664`, `services/configurationPolicy.ts` `authorizeAssignmentTarget` (`:2616-2627`), `routes/devices/core.ts:1683-1694` |
| W2a | `db/schema/devices.ts` (nullable `orgId`). **NULL:** `services/configPolicyAssignmentDevices.ts:187-205`, `jobs/automationWorker.ts:956-1000`, `routes/partnerApi/configuration.ts:216-235`, `routes/groups.ts:169-232,255-281`. **DUAL display:** `services/wisp/readiness.ts`, `services/aiAgents/designEvidence.ts:526`, `services/maintenanceSiteScope.ts`, `routes/peripheralControl.ts`. **ORG refuse:** `routes/maintenance.ts`, `services/peripheralEffectivePolicy.ts`, `routes/backup/sla.ts`, `routes/alerts/rules.ts`, `routes/alertTemplates/siteScope.ts`, `services/scriptRunTargets.ts`, `services/deploymentTargetResolver.ts`, `services/automationRuntime.ts`, `routes/software.ts`, `routes/endpointMessages/resolveTargets.ts`, `services/aiAgents/runResourceScope.ts`, `services/enrollmentDefaultGroup.ts`, `routes/orgs.ts`, `services/effectiveSettings.ts`, `modules/mcpInvites/tools/configureDefaults.ts`, `routes/users.ts`, `routes/devices/groups.ts`. **ORG billing and composite FK:** `services/groupMembership.ts` (`groupIncludesDevice`, prune, pin, manual add), `services/contractService.ts`, `services/contractSnapshot.ts`, `services/deviceCoverage.ts`, `services/quoteService.ts`, `services/quoteAcceptService.ts`, `services/contacts/responsibilities.ts`. **Compile-only (org groups only):** `services/fleetDesign/{apply,ledger,rollback,preview,drift}.ts`, `services/flows/{fleetGroups,ownedReferences}.ts`, `services/deviceGroupDelete.ts`, `services/groupFilterRefs.ts`, `services/automationTargetValidation.ts`, `jobs/backupSlaWorker.ts`, `services/monitors/conversion/convert.ts`, `db/seedE2eFixtures.ts` |
| W2b | `services/groupMembership.ts` (evaluation core, per-device path, whole-group path); `events/deviceEvents.ts:107-126,266-308` |
| W3 | `routes/groups.ts` (list, create, patch, delete, preview, DTO); `services/deviceGroupDelete.ts`; `services/groupFilterRefs.ts`; `services/auditFallbackOrg.ts:100-116`; `services/aiToolsFleet.ts:1665-1966`; `services/configurationPolicy.ts:2417-2530`; `packages/shared/src/types/index.ts:350-360`; `packages/shared/src/types/filters.ts:205-218` |
| W4 | `apps/web/src/components/devices/{CreateGroupModal,DeviceGroupsPage}.tsx`, `apps/web/src/components/configurationPolicies/OrganizationScopePanel.tsx`, `apps/web/src/components/monitoring/DeployMonitorDialog.tsx`, `apps/docs/src/content/docs/features/device-groups.mdx` |
| Unchanged | **MEM** (read memberships by device id): `services/featureConfigResolver.ts`, `services/monitors/monitorResolver.ts`, `services/alertService.ts`, `routes/agents/helpers.ts`, `services/warrantyPolicyResolution.ts`, `services/deviceOrgMove/moveDeviceOrgInTransaction.ts` (its detach deletes every membership of a moved device). **ORG registries:** `services/orgMergeRegistry.ts:1012-1013` (`repoint` stays), `extensions/tenancyTripwire.ts:44`, `db/schema/contactRoles.ts`. **Web org-only pickers**, safe because of the list default: `ContractEditor`, `QuoteLineRows`, `QuoteBlockCard`, `OrgDefaultsEditor`, `GroupTargetPicker`, `DeviceTargetSelector`, `AutomationEditPage`, `PolicyEditPage`, `SLAConfigDialog`, `DevicesPage` |

## CI traps (copy into every wave brief)

- **Stacked PRs get no CI.** `ci.yml` triggers on `pull_request: branches: [main]`. If a wave branches from an unmerged wave, run `gh workflow run CI --ref <branch>` before merging it. Better: base each wave on `main` once the previous wave has merged.
- **`pnpm test` does not run the contract suites.** Start a per-worktree stack with `pnpm test-stack up`, then run:
  - integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>.integration.test.ts`
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`

  Finish with `pnpm test-stack down`. The org-cascade, export-policy, merge-registry and RLS-coverage suites fail only under **Integration Tests** (`integration-test`), never under **Test API**.
- **Scoped runs.** Use `cd apps/api && npx vitest run <path>`. Never use `pnpm --filter … test -- --run <path>`. Path filters are substring matches.
- **Typecheck like CI.** Run `NODE_OPTIONS=--max-old-space-size=20480 npx tsc --build apps/api/tsconfig.tests.json; echo exit=$?`. Plain `tsc -p` runs out of memory at 12 GB locally, and piping through `tail` hides the OOM.
- **New `apps/api/src/services/*` files** must be classified in `apps/api/src/__tests__/parkedFanout.contract.test.ts`: `deviceGroupOwnership.ts` (W2a), `partnerGroupEvaluation.ts` (W2b), `partnerGroupPreview.ts` (W3).
- **New job modules** need an entry in `services/workerRegistry.ts`. `services/workerEntrypointClosure.contract.test.ts` and `jobs/workerReadinessManifest.test.ts` check it (W2b).
- **New paths.** No new route path is planned. The new files under `apps/api/scripts` (W2b) must pass `node --test .github/scripts/ci-area-gating.test.mjs`. A new route module would also need an `MCP_COVERAGE` entry in `services/mcpCoverage.ts`.
- **Locale keys.** Add every new `en` key to all 8 locales (en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR), then run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/locales`. If you remove or reword an `en` key listed in `apps/web/src/locales/humanizedKeyBaseline.json`, drop its entry.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`), enforced by `no-silent-mutations.test.ts` with exceptions in `runActionAllowlist.ts`. W4 converts `CreateGroupModal.tsx` and removes it from the allowlist.
- **No settings page and no deleted config file.** `settingsPageRegistry.test.ts` and `apps/api/src/config/composeBindMounts.test.ts` stay untouched.
- **AI tools (W3).** `services/aiTools.userOwnedRelease.contract.test.ts` keys `SAFE_WRITE_SITES` by line number, and `services/aiTools.descriptionBudget.contract.test.ts` caps description length. Re-key any write site that an edit shifts.
- **Migrations.**
  - Run `scripts/check-migration-naming.sh --staged`; the pre-push hook re-runs it with `--against-ref origin/main`.
  - If main overtakes the chosen slots before merge, rename the **unshipped** files so they sort last. Never rename a shipped file.
  - Then run `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`, followed by `pnpm db:migrate && pnpm db:check-drift`.

## Settings rule 9

No setting is added.
- **Home:** none.
- **Default enrollment group:** stays org-only, configured in 1 place before and after (the org Defaults tab, `apps/api/src/routes/orgs.ts:868-873`).
- **`ownerScope`:** a create-time attribute, not a setting.

---

## W0 — Software-change and org-move re-evaluation (#10497)

**Goal:** Software-keyed dynamic groups re-evaluate when a device's set of installed names changes, and a device moved to another org is evaluated against the target org's groups. This fixes the per-org workaround on its own.

**Files:**
- Modify: `apps/api/src/services/softwareInventoryObservations.ts`, `apps/api/src/routes/devices/moveOrg.ts`, `apps/api/src/services/unassignedPool/assignParkedDevice.ts`
- Tests: `apps/api/src/services/softwareInventoryObservations.test.ts`, `apps/api/src/routes/devices/moveOrg.test.ts`, `apps/api/src/services/unassignedPool/assignParkedDevice.test.ts`, `apps/api/src/__tests__/integration/dynamicGroupReevaluation.integration.test.ts`

**Interfaces:**
- Produces: `replaceSoftwareInventoryProjection(tx, input): Promise<{ installedNamesChanged: boolean }>` (today it returns `Promise<void>`, `:230-237`).
- Consumes: `requestDeviceGroupReevaluationAfterCommit(request)` (`jobs/deviceGroupJobs.ts:292`).

### Task 0.1: Inventory ingest requests re-evaluation when the name set changes

- [ ] **Red.** In `softwareInventoryObservations.test.ts`, add:
  - `it('requests a software re-evaluation when the installed-name set changes')`: prior rows `['A','B']`, report `['A','C']`. Expect exactly one call to `requestDeviceGroupReevaluationAfterCommit` with `{ deviceId, orgId, eventType: 'device.updated', changedFields: ['software.installed','software.notInstalled'], reason: 'software_inventory_change' }`.
  - `it('does not request one when only versions change')`.
  - `it('does not request one for a rejected_out_of_order report')`.

  Run `cd apps/api && npx vitest run src/services/softwareInventoryObservations.test.ts` and expect FAIL.
- [ ] **Green.**
  - Before the `DELETE` (`:248`), read the device's distinct `software_inventory.name` set. Compare it with the new item names as an exact set (no case folding), and return `installedNamesChanged`.
  - In `ingestSoftwareInventoryReportInner`, call `requestDeviceGroupReevaluationAfterCommit` inside the transaction callback when `decision.acceptedForInventory && installedNamesChanged`.
  - The idempotent V2 replay path (`:387-397`) returns before this point and must not enqueue.

  Re-run and expect PASS.
- [ ] **Commit:** `fix(groups): re-evaluate software-keyed groups on inventory change (#10497)`

### Task 0.2: Org moves request a full re-evaluation

- [ ] **Red.**
  - In `moveOrg.test.ts`, add `it('requests a full group re-evaluation for the target org after commit')`. Expect `requestDeviceGroupReevaluationAfterCommit` with `{ deviceId, orgId: targetOrgId, eventType: 'device.created', reason: 'device_org_moved' }`.
  - In `assignParkedDevice.test.ts`, change the existing re-evaluation expectation to `eventType: 'device.created'` (D2).

  Expect FAIL.
- [ ] **Green.** Make the call in `moveOrg.ts`, next to the other post-commit effects (`:340-357`). Change `assignParkedDevice.ts:460-466` to `'device.created'`. Expect PASS.
- [ ] **Integration (red first).** In `dynamicGroupReevaluation.integration.test.ts`, add `describe('software inventory and org moves re-evaluate groups (#10497)')` with:
  - `runDb('a device joins then leaves a software.installed group as its inventory changes')`: group filter `software.installed equals 'PowerChute Business Edition Agent'`. Call `ingestSoftwareInventoryReport` with the name, then without it, running `runDeviceGroupReevaluationJob` after each call. Assert the membership is present, then absent.
  - `runDb('an accepted report with identical names enqueues nothing')`.
  - `runDb('a device moved to org B joins B\'s matching dynamic group')`.

  Run it with `pnpm test-stack up` and the integration command.
- [ ] **Commit:** `fix(groups): full re-evaluation after device org moves (#10497)`

**CI:** Test API; Integration Tests (`dynamicGroupReevaluation`).
**Exit:** all three integration cases are green in CI, and the job's event union is unchanged.
**PR:** `fix(groups): re-evaluate dynamic groups on software inventory changes and org moves (#10497)`, body `Closes #10497`, `Refs #10498`.

---

## W1 — Schema, membership integrity, RLS, registrations, fail-closed gating

**Goal:** The database can hold a partner group and protects it, while no app path can create one yet. Full rigor: review the SQL as part of plan review before writing it, and run one independent code review.

**Migrations.** The newest migration on `main` is `2027-01-10-110000-pam-user-notify-capability.sql` (verified). Slots start at `2027-01-11-100000`.

**`apps/api/migrations/2027-01-11-100000-device-groups-partner-ownership.sql` (A)**
- First statement: `SELECT set_config('breeze.scope','system',true);`.
- Columns:
  - `ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public.partners(id)`, and `ALTER COLUMN org_id DROP NOT NULL`.
  - Add `filter_revision integer NOT NULL DEFAULT 1`, `evaluated_revision integer NOT NULL DEFAULT 0`, `evaluated_at timestamp`, `evaluation_failed_orgs integer NOT NULL DEFAULT 0`.
- Constraints, each guarded by `DO $$ … pg_constraint`:
  - `device_groups_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))`
  - `device_groups_partner_shape_chk CHECK (partner_id IS NULL OR (site_id IS NULL AND parent_id IS NULL))`
- Index: `device_groups_partner_id_idx ON device_groups(partner_id) WHERE partner_id IS NOT NULL`.
- `BEFORE UPDATE` trigger `device_groups_owner_immutable` → `breeze_device_groups_owner_immutable()`. Raises 23514 with `CONSTRAINT = 'device_groups_owner_immutable'` when `NEW.partner_id IS DISTINCT FROM OLD.partner_id` or `(OLD.org_id IS NULL) <> (NEW.org_id IS NULL)`.
- Deferred constraint trigger `device_groups_parent_owner_kind` (`AFTER INSERT OR UPDATE OF parent_id, org_id, partner_id`, `DEFERRABLE INITIALLY DEFERRED`). It re-reads the row and raises 23514 if the parent is a partner group.
- RLS:
  - Re-assert `ENABLE` and `FORCE`.
  - Drop the four `breeze_org_isolation_*` policies (`0001-baseline.sql:15575,16436,17297,18158`, verified).
  - Create `device_groups_owner_isolation` FOR ALL, with USING and WITH CHECK `breeze_current_scope()='system' OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))`. Template: `2026-10-27-130100-reports-partner-ownership.sql:183-197`.
  - Create `device_groups_partner_wide_select` FOR SELECT, USING `org_id IS NULL AND partner_id = public.breeze_current_partner_id()`. Template: `2026-10-05-110000-config-policy-partner-wide-select.sql`.
- No backfill. `device_groups_id_org_id_uniq` stays.

**`apps/api/migrations/2027-01-11-100100-device-group-membership-owner-integrity.sql` (B1)**
- System scope first. `DROP CONSTRAINT IF EXISTS device_group_memberships_group_org_fk`.
- **Forward check.** `breeze_check_device_group_membership_owner()` is SECURITY DEFINER and elevates and restores the GUCs as `2026-07-30-…:14-29` does.
  - It re-reads `(group_id, org_id)` for `(NEW.device_id, NEW.group_id)`, and returns if the row is gone or superseded.
  - It raises 23503 with `CONSTRAINT = 'device_group_memberships_group_owner_check'` unless this is true: `EXISTS(SELECT 1 FROM device_groups g LEFT JOIN organizations o ON o.id = m.org_id WHERE g.id = m.group_id AND (g.org_id = m.org_id OR (g.org_id IS NULL AND g.partner_id = o.partner_id)))`.
  - It runs as constraint trigger `device_group_memberships_group_owner_check`: `AFTER INSERT OR UPDATE OF group_id, org_id`, `DEFERRABLE INITIALLY DEFERRED`, `FOR EACH ROW`.
- **Reverse check.** Constraint trigger `device_groups_membership_owner_revalidate` (`AFTER UPDATE OF org_id, partner_id ON device_groups`, deferred) → `breeze_revalidate_device_group_memberships()`. At COMMIT it applies the same predicate to every membership of the group.
- **Reparent.** Trigger `organizations_detach_partner_group_memberships` (`AFTER UPDATE OF partner_id ON organizations FOR EACH ROW WHEN (OLD.partner_id IS DISTINCT FROM NEW.partner_id)`) → `breeze_detach_partner_group_memberships_on_reparent()`. In order, the function:
  1. calls `breeze_partner_export_lock_partners_exclusive(sorted ARRAY[old,new])`;
  2. calls `breeze_partner_export_lock_orgs_under_exclusive_partners(...)`;
  3. deletes the org's memberships in the old partner's groups;
  4. raises a WARNING with the count.
- **Device move.** `CREATE OR REPLACE breeze_cascade_device_org_id()`, copied verbatim from `2026-11-05-100000-…:40-295`. Only two things change: the safety-net predicate (`:266-271`) becomes `AND NOT EXISTS (<the valid-owner predicate above>)`, and the now-stale "no partner axis" comment is updated.

**`apps/api/migrations/2027-01-11-100200-config-assignment-partner-device-group-targets.sql` (B2)**
- `CREATE OR REPLACE` each function from its newest body, changing only the `device_group` branch:
  - from `2026-07-29-serialize-config-policy-assignment-integrity.sql`: `breeze_lock_config_policy_assignment_rows`, `breeze_validate_config_policy_assignment_target`, `breeze_validate_config_policy_assignment_new_rows`;
  - from `2026-07-30-…`: `breeze_enforce_config_policy_assignment_integrity`, `breeze_serialize_config_policy_assignment_owner_updates`;
  - from `2026-10-15-120001-…`: `breeze_serialize_config_policy_assignment_owner_deletes`;
  - from `2026-07-24-…:223-241`: `breeze_partner_export_assignment_orgs`.
- The group branch resolves `target_partner = COALESCE(g.partner_id, owner_org.partner_id)` via `LEFT JOIN organizations owner_org ON owner_org.id = g.org_id`.
- A `device_group` target with `target_org_id IS NULL` is valid only when `policy_org_id IS NULL` and the partners match.
- Lock identities gain `'partner:' || g.partner_id`.
- `_owner_updates` gets its own `device_groups` branch comparing `(id, org_id, partner_id)` (D6).
- `_assignment_orgs` matches `dg.org_id = o.id OR (dg.org_id IS NULL AND dg.partner_id = o.partner_id)`.
- Re-issue each function's `REVOKE` lines. The file writes no rows; set system scope anyway.

### Task 1.1: Migration A and the Drizzle columns

- [ ] **Red.** Create `apps/api/src/__tests__/integration/deviceGroupsPartnerRls.integration.test.ts`, inserting partner rows with raw SQL (D3):
  - `runDb('XOR: both owners or neither → 23514 device_groups_one_owner_chk')`
  - `runDb('partner row with site_id or parent_id → 23514 device_groups_partner_shape_chk')`
  - `runDb('partner_id change and org_id NULL↔NOT NULL flips raise device_groups_owner_immutable; org A→B on an org group succeeds')`
  - `runDb('an org group whose parent is a partner group fails at COMMIT')`
  - `runDb('partner A context inserting partner_id = B → 42501')`
  - `runDb('org token of partner P sees P\'s partner group, UPDATE/DELETE affect 0 rows; org token of partner Q sees none')`
  - `runDb('agent-auth context (currentPartnerId = device partner) sees the partner group')`
  - `runDb('org isolation: org A cannot see org B\'s group')`
- [ ] **Green.**
  - Write Migration A.
  - In `apps/api/src/db/schema/devices.ts`, add `partnerId: uuid('partner_id').references(() => partners.id)`, `filterRevision`, `evaluatedRevision`, `evaluatedAt` and `evaluationFailedOrgs`. Keep `orgId` `.notNull()` with a comment citing D3.
  - Run the suite and `migrationRlsScope.test.ts`.
- [ ] **Commit:** `feat(groups): device_groups org XOR partner ownership with partner read branch (#10498)`

### Task 1.2: Membership integrity (B1) and the FK-name tests

- [ ] **Red.**
  - In `deviceGroupMembershipTenantFks.integration.test.ts`, re-point the REJECTS cases at `device_group_memberships_group_owner_check` and add:
    - `runDb('insert then delete of an invalid row in one transaction commits')`
    - `runDb('invalid then corrected org_id in one transaction commits')`
    - `runDb('same-partner membership in a partner group commits; foreign-partner membership fails at COMMIT')`
    - `runDb('device move deletes a partner-group membership')`
    - `runDb('moving an org group to another org with surviving memberships fails at COMMIT')`
    - `runDb('org reparent deletes memberships in the old partner\'s groups and keeps org-group memberships')`
    - `runDb('merge repoint of group and memberships in two statements under SET CONSTRAINTS ALL DEFERRED commits')`
  - Update the other four FK-name assertions (D7).
  - In `moveOrg.coverage.test.ts:1536`, replace the FK pin with `it('pins the deferred membership owner trigger')`. It greps the newest migration for `CREATE CONSTRAINT TRIGGER device_group_memberships_group_owner_check` … `DEFERRABLE INITIALLY DEFERRED`, and for the FK `DROP`.
  - In `orgLifecycleFoundations.integration.test.ts`, add `it('device_group_memberships owner trigger is deferrable (merge contract)')`, asserting `pg_trigger.tgdeferrable AND tginitdeferred`.
- [ ] **Green.**
  - Write B1.
  - Remove `groupOrgFk` from the Drizzle schema (`devices.ts:722-726`) and update the comment block above it (`:711-721`).
  - Add `'device_groups.device_groups_owner_immutable'` to `ORG_ID_BENIGN_TRIGGERS`, with the reason that it allows NOT NULL → NOT NULL `org_id` repoints (D8).
- [ ] **Commit:** `feat(groups): deferred owner trigger replaces the membership group FK (#10498)`

### Task 1.3: Assignment integrity functions (B2)

- [ ] **Red.** In `apps/api/src/__tests__/integration/configPolicyPartnerLevelAssignments.integration.test.ts`, add:
  - `runDb('a partner-owned policy may target its own partner group (raw INSERT)')`
  - `runDb('an org-owned policy targeting a partner group → 23503 config_policy_assignments_target_owner_fk')`
  - `runDb('a policy targeting another partner\'s group → 23503')`
  - `runDb('breeze_partner_export_assignment_orgs returns every non-holding org of the partner for a partner-group assignment')`
- [ ] **Green.** Write B2. The PR body carries a `diff -u` of each function against its source.
- [ ] **Commit:** `feat(config-policy): DB assignment integrity accepts partner device groups (#10498)`

### Task 1.4: Registrations, partner purge, fail-closed gating

- [ ] **Red.**
  - `tenant-export-policy.integration.test.ts` fails on the five new columns until they are classified.
  - Add `it('pre-clears assignments, memberships and logs of the partner\'s groups')` to `apps/api/src/services/tenantCascade.partner.test.ts`.
  - Create `apps/api/src/__tests__/integration/deviceGroupsPartnerLifecycle.integration.test.ts`:
    - `runDb('erasing one org keeps the partner group and other orgs\' memberships')`
    - `runDb('full partner purge succeeds, and a retry after partial progress succeeds')`
    - `runDb('merge with a partner-group member keeps a valid membership')`
    - `runDb('org export: own memberships and logs are in, partner group definitions are out')`
  - In `apps/api/src/services/executionTargetGating.test.ts`, add `it('returns an id with no visible row as refused with refusedFields [\'unresolvable\']')` and `it('words the unresolvable warning without naming agent-reported fields')`.
- [ ] **Green.**
  - `tenantExportPolicyRegistry.ts:410`: add `partner_id`, `filter_revision`, `evaluated_revision`, `evaluated_at` and `evaluation_failed_orgs` to `included`. None of them is json, jsonb or bytea.
  - `rls-coverage.integration.test.ts`: add `device_groups` to `DUAL_AXIS_TENANT_TABLES` (`:565`) and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`:1038`), with the same comment format as the neighbouring entries.
  - `tenantCascade.ts`: add three entries to `partnerAssociatedPreClears` (`:2770`) (D9).
  - `CORE_ORG_CASCADE_DELETE_ORDER` (`:599-600`) and `orgMergeRegistry.ts:1012-1013` do not change. Confirm both by grep.
  - `executionTargetGating.ts:60-67`: diff the requested ids against the returned rows. `warningsForRefusedExecutionGroups` gets a special case for `unresolvable`.
- [ ] **Verify.** Run the RLS-coverage command, then the integration suites `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations` and `rls-coverage`, then `pnpm db:migrate && pnpm db:check-drift`.
- [ ] **Commit:** `feat(groups): register partner device groups in export, RLS and purge contracts (#10498)`

**CI:** Test API (`moveOrg.coverage`, `migrationRlsScope`, `migrationPartnerExportLocks`, `autoMigrate`, `executionTargetGating`, `tenantCascade.partner`); Integration Tests (every suite above).
**Exit:** the full Integration Tests job passes, not only Test API (spec §7).
**PR:** `feat(groups): partner-owned device group schema and integrity (#10498 W1)`, body `Closes #<W1 sub-issue>`, `Refs #10498`, plus the function diffs and the five registration rows.

---

## W2a — Type flip, partner-aware readers and write refusals (dark)

**Goal:** Every reader and writer handles `org_id IS NULL` correctly, with the compiler doing the sweep. Partner groups resolve through assignment expansion and are refused everywhere else.

**Files:**
- Create: `apps/api/src/services/deviceGroupOwnership.ts` and `deviceGroupOwnership.test.ts`.
- Modify: every W2a row of the sweep table, plus `packages/shared/src/constants/errorCodes.ts`, `apps/web/src/locales/*/errors.json` (8 locales), `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` and `apps/api/src/__tests__/parkedFanout.contract.test.ts`.

**Interfaces (produced):**
- `isPartnerOwnedGroup(g: { orgId: string | null }): boolean`
- `groupOwnerMatchesMembershipOrg(): SQL`. Requires `organizations` joined on `device_group_memberships.org_id`.
- `findPartnerOwnedGroupIds(ids: readonly string[]): Promise<string[]>`
- `partnerGroupTargetRefusal(ids: string[]): { error: string; code: 'PARTNER_GROUP_TARGET_UNSUPPORTED'; groupIds: string[] }`
- `PARTNER_GROUP_READ_ONLY_BODY`

### Task 2a.1: Ownership helpers, error codes and the type flip

- [ ] **Red.**
  - In `deviceGroupOwnership.test.ts`, test each helper. For example, `findPartnerOwnedGroupIds` returns only the ids whose row has `org_id` NULL, and ignores unknown ids.
  - Add the two codes to `ERROR_CODES` with en text. `translationCoverage.test.ts` then fails until every locale has them.
- [ ] **Green.** Implement the helpers. Add the `errors.json` keys in all 8 locales. Flip `orgId` to nullable in `apps/api/src/db/schema/devices.ts`.
- [ ] **Compile sweep.** Run the CI tsc command and fix each error according to its class in the sweep table.
  - ORG and compile-only sites fail closed: `if (group.orgId === null)` → not found, or refuse.
  - The W2b evaluation sites (`groupMembership.ts:113-135,301-374,413-478`) skip partner groups with `console.warn('[groupMembership] partner group … skipped until W2b')`.
- [ ] **Contracts.**
  - `partner-wide-write-coverage.test.ts` now discovers the `device_groups` writers (verified list: `routes/groups.ts`, `routes/devices/groups.ts`, `services/aiToolsFleet.ts`, `services/deviceGroupDelete.ts`, `services/fleetDesign/apply.ts`, `services/groupMembership.ts`).
  - Add each one to `ALLOWED_WITHOUT_CAPABILITY_CHECK` with its real reason. The reasons are: "refuses any `org_id IS NULL` row before writing (W2a)", "system-context evaluator", or "data access, gate in routes/groups.ts".
  - W3 replaces the `routes/groups.ts` entry with the real gate.
  - Classify `services/deviceGroupOwnership.ts` in `parkedFanout.contract.test.ts` as EXEMPT ("ownership predicates; selects no devices").
- [ ] **Commit:** `refactor(groups): nullable device group org with fail-closed callers (#10498)`

### Task 2a.2: Write refusals and composite-FK 400s

- [ ] **Red.** Write one test per surface. Each sends a partner group id and expects `400` with `code: 'PARTNER_GROUP_TARGET_UNSUPPORTED'`.

  | Surface | Test file |
  |---|---|
  | Maintenance windows | `routes/maintenance.test.ts` |
  | Backup SLA create and update | `routes/backup/sla.test.ts` |
  | Alert rules | `routes/alerts/rules.test.ts` |
  | Alert templates | `routes/alertTemplates/*.test.ts` |
  | Script runs | `services/scriptRunTargets.test.ts` |
  | Deployments | `services/deploymentTargetResolver.test.ts`, `routes/software*.test.ts` |
  | Automation runtime targets | its existing test file |
  | Endpoint messages | `routes/endpointMessages/*.test.ts` |
  | Agent run scope | its existing test file |
  | Peripheral targets | its existing test file |
  | Org defaults and enrollment group | `routes/orgs*.test.ts`, `services/enrollmentDefaultGroup.test.ts` |
  | MCP `configureDefaults` | its existing test file |
  | `organization_users.device_group_ids` | `routes/users*.test.ts` |
  | Legacy `routes/devices/groups.ts` | its existing test file |

  Contract, quote and contact-role writes expect `400`, not a 500, when the composite FK raises 23503. Where a surface already rejects the id through its org predicate, the test passes on first run. Keep it as a characterization test and say so in the PR.
- [ ] **Green.** At each write, call `findPartnerOwnedGroupIds` before persisting and return `partnerGroupTargetRefusal`. Workers keep their org filters.
- [ ] **Commit:** `feat(groups): refuse partner groups at unsupported target writes (#10498)`

### Task 2a.3: Assignment expansion and fan-out

- [ ] **Red.**
  - In `services/configPolicyAssignmentDevices.test.ts`, add `it('expands a partner-group assignment to members in every partner org, clamped')`.
  - Create `apps/api/src/__tests__/integration/partnerDeviceGroupFanout.integration.test.ts`:
    - `runDb('two orgs, one partner policy assigned to a partner group (memberships inserted by SQL): effective config resolves on both devices')`
    - `runDb('precedence: the partner-group assignment (priority 4) beats an org-level assignment of another policy')`
    - `runDb('automation schedule on a partner-owned policy resolves both orgs\' members')`
- [ ] **Green.**
  - Replace `eq(deviceGroups.orgId, deviceGroupMemberships.orgId)` with `groupOwnerMatchesMembershipOrg()` at `configPolicyAssignmentDevices.ts:192-195` and `automationWorker.ts:962-967,993-998`. Join `organizations` where a query lacks it, and keep every subset clamp.
  - `routes/partnerApi/configuration.ts:228-230` becomes `dg.org_id = eo.id OR (dg.org_id IS NULL AND dg.partner_id = eo.partner_id)`.
- [ ] **Commit:** `fix(config-policy): partner-aware device-group expansion joins (#10498)`

### Task 2a.4: Display readers

- [ ] **Red, then green.** Write one test per file, then fix it. `wisp/readiness`, `aiAgents/designEvidence` (`:526` joins through the membership org), `maintenanceSiteScope` and `peripheralControl` must not label a partner group "stale" or "foreign".
- [ ] **Commit:** `fix(groups): partner groups in display readers (#10498)`

### Task 2a.5: Owner-aware group reads and the read-only refusal

- [ ] **Red.** Create `apps/api/src/routes/groups_partnerOwned.test.ts`:
  - `it('org scope GET /:id of a partner group returns name, badge fields, own-org count; filterConditions and rules are null')`
  - `it('partner scope GET /:id returns the filter')`
  - `it('PATCH/DELETE/add/remove/pin on a partner group → 400 PARTNER_GROUP_READ_ONLY')`
  - `it('GET /:id/devices includes an orgId column')`
- [ ] **Green.**
  - In `getGroupWithAccess` (`routes/groups.ts:199-218`), replace `ensureOrgAccess(group.orgId)` with `canReadGroup(group, auth)`. An org group uses `ensureOrgAccess`. A partner group requires `group.partnerId === auth.partnerId` for partner and org scope; system scope always passes.
  - `mapGroupRow` (`:255-281`) takes `redact: boolean`, which is set for org scope on partner groups.
  - Every mutating handler, plus `pinDeviceToGroup`, `pruneGroupMembershipsOutsideSite` and `addManualGroupMemberships`, refuses partner groups.
- [ ] **Commit:** `feat(groups): read-only partner groups in the groups API (#10498)`

**CI:** Test API (tsc, `partner-wide-write-coverage`, `parkedFanout`, route tests); Test Web (locale parity, translation coverage); Integration Tests (the fan-out suite plus the W1 suites).
**Exit:** tsc is clean with the CI command, and every refusal surface is listed with its test.
**PR:** `feat(groups): partner-aware readers and target refusals (#10498 W2a)`, body `Closes #<W2a sub-issue>`.

---

## W2b — Evaluation engine (dark)

**Goal:** Partner groups materialize and stay fresh through three paths: the per-device path, a revisioned per-org job and a 6 h sweep. The wave cannot merge until the measured benchmark passes.

**Files:**
- Create:
  - `apps/api/src/services/partnerGroupEvaluation.ts` and its `.test.ts`
  - `apps/api/src/jobs/partnerGroupEvaluationJobs.ts` and its `.test.ts`
  - `apps/api/scripts/partner-group-eval-benchmark.ts`, `apps/api/scripts/partner-group-eval-benchmark.lib.ts` and `.lib.test.ts`
  - `apps/api/src/__tests__/integration/partnerDeviceGroupEvaluation.integration.test.ts`
- Modify: `apps/api/src/services/groupMembership.ts`, `apps/api/src/events/deviceEvents.ts`, `apps/api/src/services/deviceGroupOwnership.ts`, `apps/api/src/services/workerRegistry.ts`, `apps/api/package.json` (script `partner-group-eval:benchmark`), `apps/api/src/__tests__/parkedFanout.contract.test.ts`.

**Interfaces (produced):**
- `resolveEffectiveGroupMembers(group: GroupForResolution, evaluationOrgId: string)`. `GroupForResolution` gains `partnerId`. An org group must pass its own org.
- `acquireGroupOrgMembershipLocks(pairs: ReadonlyArray<{ groupId: string; orgId: string }>): Promise<void>`, in `deviceGroupOwnership.ts`. Sorts the pairs, then locks `hashtextextended('device_group_membership:'||group||':'||org, 0)` for each.
- `listPartnerGroupEvaluationOrgIds(partnerId: string, afterOrgId: string | null, limit?: number): Promise<string[]>`
- `evaluatePartnerGroupForOrg(groupId: string, orgId: string): Promise<PartnerGroupOrgResult>`
- `requestPartnerGroupEvaluationAfterCommit(groupId: string, reason: string): void`
- `processPartnerGroupEvaluation(data: PartnerGroupEvaluationJobData): Promise<{ status: 'continued' | 'finalized' | 'superseded' | 'gone'; evaluatedOrgs: number }>`
- `runPartnerGroupSweep(): Promise<{ partnerGroups: number; orgGroups: number }>`
- Constants: `PARTNER_GROUP_EVALUATION_QUEUE = 'partner-group-evaluation'`, `PARTNER_GROUP_ORG_PAGE_SIZE = 50`, `PARTNER_GROUP_SWEEP_INTERVAL_MS = 21_600_000`, `PARTNER_GROUP_SWEEP_JITTER_MS = 900_000`.

### Task 2b.1: One evaluation core

- [ ] **Red.** In `groupMembership.resolve.integration.test.ts`, add `runDb('partner group resolves per evaluation org and reads only that org\'s membership rows')` and `runDb('groupIncludesDevice is false for a partner group')`. Expect FAIL.
- [ ] **Green.** Change the core to the signature above. Billing callers keep an org-only guard: `groupIncludesDevice` (`:171-197`) and contract snapshots. Remove the W2a skip from the core.
- [ ] **Commit:** `feat(groups): per-org evaluation core for partner groups (#10498)`

### Task 2b.2: Per-device path

- [ ] **Red.** In `partnerDeviceGroupEvaluation.integration.test.ts`:
  - `runDb('updateDeviceMembership adds a matching device in any partner org, writing the device org to membership and log')`
  - `runDb('device.created in a brand-new org joins the partner group')`
  - `runDb('Quick Support and holding-org devices never join')`
  - `runDb('a foreign partner\'s device never joins')`
- [ ] **Green.**
  - `updateDeviceMembership` (`:545-612`), `getGroupsFilteringOnFields` (`deviceEvents.ts:107-126`) and the `device.created` handler (`:266-308`) select `org_id = $org OR (org_id IS NULL AND partner_id = $devicePartner)`. They skip QS and holding orgs and keep `ORDER BY id`.
  - The per-device job calls `acquireGroupOrgMembershipLocks` once, for every group it will evaluate (D10).
  - `evaluateDeviceMembershipForGroup` replaces the guard at `:301` with an owner check, and writes `device.orgId` at `:353` and in the log rows.
- [ ] **Commit:** `feat(groups): per-device evaluation of partner groups (#10498)`

### Task 2b.3: Per-org evaluation service

- [ ] **Red.** In `partnerGroupEvaluation.test.ts` and the integration suite:
  - `it('pages orgs by ascending UUID, 50 per page, excluding QS and holding orgs, with no 500-org cap')`
  - `runDb('each org runs in its own transaction; a filter timeout in one org keeps its previous members and reports ok: false')`. Force the timeout with `pg_sleep` in a stubbed condition, or with `SET statement_timeout`.
  - `runDb('a per-device write racing a whole-group write for the same (group, org) does not lose the newer result')`
- [ ] **Green.**
  - Discovery runs inside `withSystemDbAccessContext`, and that context is closed before any org is touched.
  - Each org then runs under `runOutsideDbContext(() => withSystemDbAccessContext(...))`: take the advisory lock, then diff, write and log.
  - Peripheral scheduling for changed devices moves to `runAfterDbContextCommit`, in chunks of 100. This replaces the unbounded `Promise.all` at `groupMembership.ts:30-40` for every caller.
  - Classify the file in `parkedFanout.contract.test.ts` as a FANOUT module, since it uses `notHoldingOrgCondition`. Add it to `ALLOWED_WITHOUT_CAPABILITY_CHECK` as a system-context evaluator.
- [ ] **Commit:** `feat(groups): per-org partner group evaluation (#10498)`

### Task 2b.4: Job, revisions, sweep

- [ ] **Red.** In `partnerGroupEvaluationJobs.test.ts`:
  - `it('head job reads filter_revision, continues with afterOrgId cursor, finalizes evaluated_revision/evaluated_at/evaluation_failed_orgs')`
  - `it('finalize on a stale revision enqueues a fresh head job and never lowers evaluated_revision')`
  - `it('coalesces requests under jobId partner-group-eval-<groupId>')`
  - `it('sweep enqueues every dynamic partner group with jitter ≤ 15 min and re-evaluates org groups whose filter_fields_used overlap software.*')`

  In the integration suite: `runDb('filter edit mid-pagination ends at the newest revision')`.
- [ ] **Green.**
  - Implement the job module. The repeatable sweep follows the pattern at `jobs/peripheralJobs.ts:562`.
  - Sweep worker concurrency is 1 and evaluation worker concurrency is 1, both revisited in Task 2b.6.
  - Register `partnerGroupEvaluationJobs` in `services/workerRegistry.ts` with `placement: 'socket-owner'`, for the same closure reason as `deviceGroupJobs` (`:1276-1286`).
  - Run `workerEntrypointClosure.contract.test.ts` and `workerReadinessManifest.test.ts`.
- [ ] **Commit:** `feat(groups): revisioned partner group evaluation job and 6h sweep (#10498)`

### Task 2b.5: End-to-end freshness

- [ ] **Red, then green.** In `partnerDeviceGroupEvaluation.integration.test.ts`:
  - `runDb('inventory report in org A and org B adds both devices to the software partner group; the partner policy\'s effective config reaches both')`
  - `runDb('same-partner move restores partner-group membership after the move re-evaluation')` (Review Focus 1)
- [ ] **Commit:** `test(groups): partner group freshness end to end (#10498)`

### Task 2b.6: Measured load benchmark (W2b exit criterion)

- [ ] **Red.** In `partner-group-eval-benchmark.lib.test.ts`, test `evaluateBenchmarkResult(result): { pass: boolean; failures: string[] }` against `PARTNER_GROUP_BENCHMARK_PASS_CRITERIA`. Fix the criteria **before** the first run. Precedent: `apps/api/scripts/m365-sync-benchmark.ts:1-35`.
- [ ] **Fleet.** The script seeds one partner with 200 orgs: 199 orgs of 40 devices and one org of 2,000, about 10k devices. Each device gets about 120 `software_inventory` rows, and 10% have `PowerChute Business Edition Agent`. Ten partner groups use `software.installed` filters.
- [ ] **Measures and acceptance (proposed):**

| Measure | Acceptance |
|---|---|
| (a) Cold partner-wide evaluation of one `software.installed` group, through `processPartnerGroupEvaluation`, all pages | ≤ **60 s** wall clock, **0** failed orgs |
| (b) Steady-state re-run | ≤ 30 s, 0 membership writes |
| (c) Per-org filter p95 | ≤ 250 ms (`SLOW_GROUP_EVALUATION_MS`, `groupMembership.ts:85`) |
| (c) The 2,000-device org's filter | ≤ 400 ms (80% of `FILTER_QUERY_TIMEOUT_MS = 500`, `filterEngine.ts:874`) |
| (d) Churn: 10k devices' inventory flips × 10 groups through `device-group-reevaluation` at its concurrency of 4 | drain ≤ 15 min, job p95 ≤ 200 ms, 0 failed jobs, no 40P01 |
| (e) Sweep: 10 groups × 200 orgs | ≤ 10 min (spec ceiling estimate: 17 min) |
| Foreground probe query during (a) and (e) | p95 ≤ 50 ms |

- [ ] **Run.**
  - Use production-class Postgres (the 1 vCPU managed class), never a laptop container.
  - Record the numbers in the PR and on #10498.
  - If any criterion fails, tune `PARTNER_GROUP_ORG_PAGE_SIZE` and worker concurrency, then re-run.
  - W2b does not merge until every criterion passes, or until the owner accepts revised numbers in writing on #10498.
- [ ] **Commit:** `perf(groups): partner group evaluation benchmark and results (#10498)`

**CI:** Test API (job and service tests, `parkedFanout`, worker closure, `ci-area-gating` for `apps/api/scripts`); Integration Tests (`partnerDeviceGroupEvaluation`, `groupMembership.*`, `dynamicGroup*`).
**Exit:** the benchmark table passes, the churn run shows no 40P01, and queue latency is reported (OD7).
**PR:** `feat(groups): partner group evaluation engine (#10498 W2b)`, body `Closes #<W2b sub-issue>`.

---

## W3 — Create and assign API

**Goal:** Full-access partner users can create, edit, preview, delete and assign partner groups. Everyone else can read them as specified.

**Files:**
- Modify: `apps/api/src/routes/groups.ts`, `apps/api/src/services/deviceGroupDelete.ts`, `apps/api/src/services/groupFilterRefs.ts`, `apps/api/src/services/auditFallbackOrg.ts`, `apps/api/src/services/configurationPolicy.ts`, `apps/api/src/services/aiToolsFleet.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/types/filters.ts`, `packages/shared/src/constants/errorCodes.ts` (plus 8 `errors.json` files).
- Create: `apps/api/src/services/partnerGroupPreview.ts` and its test.
- Tests: `routes/groups_partnerOwned.test.ts`, `routes/groups_list.test.ts`, `__tests__/integration/partnerDeviceGroupsApi.integration.test.ts`, `services/configurationPolicy*.test.ts`, `services/aiToolsFleet*.test.ts`.

### Task 3.1: Types, DTO and the list scope

- [ ] **Red.** In `groups_list.test.ts`:
  - `it('defaults to ownerScope=organization (no partner groups)')`
  - `it('ownerScope=partner returns org_id IS NULL AND partner_id = auth.partnerId')`
  - `it('ownerScope=all for org scope returns own org groups plus own partner\'s groups, redacted')`
- [ ] **Green.**
  - Shared types: `DeviceGroup.orgId: string | null` and `partnerId: string | null`.
  - The DTO adds `ownerScope` and `evaluation: { state: 'pending' | 'current' | 'partial'; evaluatedAt: string | null; failedOrgs: number } | null`. `pending` means `evaluated_revision < filter_revision`; `partial` means `failedOrgs > 0`.
  - The query schema adds `ownerScope: z.enum(['organization','partner','all']).default('organization')`.
- [ ] **Commit:** `feat(groups): ownerScope list filter and partner group DTO (#10498)`

### Task 3.2: Writes, gate and preview

- [ ] **Red.** In `groups_partnerOwned.test.ts` (Review Focus 5):
  - `it('POST ownerScope=partner → 403 for orgAccess=selected and for org scope')`
  - `it('POST ownerScope=partner ignores ?orgId and rejects orgId/siteId/parentId/type=static with 400')`
  - `it('POST with a groupId or orgId condition → 400 PARTNER_GROUP_FILTER_UNSUPPORTED')`
  - `it('PATCH filter bumps filter_revision and enqueues evaluation after commit')`
  - `it('PATCH ignores ownerScope')`
  - `it('add/remove/pin stay 400 PARTNER_GROUP_READ_ONLY')`
  - `it('preview returns partial: true when the 5 s budget runs out')`
  - `it('selected-access partner user sees members and counts of accessible orgs only')`
- [ ] **Green.**
  - `createGroupSchema` gains `ownerScope: z.enum(['organization','partner']).default('organization')`.
  - The partner branch requires `canManagePartnerWidePolicies(auth)` and `auth.scope === 'partner'`. System scope gets a 400 in v1; this is a reversible default.
  - The partner branch stamps `partnerId = auth.partnerId`, and calls `requestPartnerGroupEvaluationAfterCommit` instead of the synchronous `evaluateGroupMembership`.
  - Replace the W2a allowlist entry for `routes/groups.ts` with the real gate.
  - Add `previewPartnerGroup(group, auth, { budgetMs: 5000 }): Promise<{ deviceIds: string[]; total: number; partial: boolean; evaluatedOrgs: number; totalOrgs: number }>` in `partnerGroupPreview.ts`, and classify the file in `parkedFanout`.
- [ ] **Commit:** `feat(groups): create, edit and preview partner device groups (#10498)`

### Task 3.3: Delete, filter references, audit

- [ ] **Red.**
  - `runDb('deleting a partner group with members in 5 orgs (including one with a lower UUID than the policy org) and 3 partner-policy assignments commits')` (Review Focus 4)
  - `it('an org group rule referencing a partner group id → 400')`
  - `it('partner-group writes audit with orgId null')`
- [ ] **Green.**
  - `deleteDeviceGroup(groupId, owner: { orgId: string } | { partnerId: string })`. For a partner group, pre-lock before any delete: first `breeze_partner_export_lock_partners_exclusive([partnerId])`, then `…_orgs_under_exclusive_partners` over the union of member orgs and partner orgs.
  - `groupFilterRefs.ts` rejects `groupId` references to or from partner groups.
  - `auditFallbackOrg.ts` returns `null` for partner groups.
- [ ] **Commit:** `feat(groups): partner group delete pre-lock, filter refs, audit (#10498)`

### Task 3.4: Assignment validation

- [ ] **Red.** In `services/configurationPolicy.test.ts`:
  - `it('partner policy may target its partner group')`
  - `it('org policy targeting a partner group → "Partner-wide device groups can only be targeted by partner-wide policies"')`
  - `it('authorizeAssignmentTarget fails closed for site-restricted callers')`

  Integration: `runDb('POST /configuration-policies/:id/assignments with a partner group expands to both orgs')`.
- [ ] **Green.** In `validateAssignmentTarget` (`:2417`), the partner branch's group query (`:2460-2471`) also accepts `deviceGroups.partnerId = partnerId`. The org branch (`:2521-2530`) changes only its error text.
- [ ] **Commit:** `feat(config-policy): partner policies target partner device groups (#10498)`

### Task 3.5: AI tools

- [ ] **Red, then green.** In `aiToolsFleet*.test.ts`:
  - `it('manage_groups list/get include own partner\'s groups, filter redacted for org scope')`
  - `it('every manage_groups mutation on a partner group returns a refusal')`

  Re-key `aiTools.userOwnedRelease` if line numbers shift, and keep the copy within `descriptionBudget`.
- [ ] **Commit:** `feat(ai-tools): manage_groups reads partner groups, refuses writes (#10498)`

**CI:** Test API (route, service and AI-tool contracts, `partner-wide-write-coverage`, `parkedFanout`); Test Web (locale parity for the new code); Integration Tests (`partnerDeviceGroupsApi` and the W1/W2 suites).
**Exit:** tests pin the 403 matrix across org scope, selected access, full access and system scope.
**PR:** `feat(groups): partner-owned device group API (#10498 W3)`, body `Closes #<W3 sub-issue>`, with the gate table.

---

## W4 — UI and docs

**Goal:** Partner users can create a partner group, see its status and org column, assign it from a partner policy and deploy a partner-wide monitor to it. The docs match.

**Files:**
- Modify: `apps/web/src/components/devices/CreateGroupModal.tsx`, `apps/web/src/components/devices/DeviceGroupsPage.tsx`, `apps/web/src/components/configurationPolicies/OrganizationScopePanel.tsx`, `apps/web/src/components/monitoring/DeployMonitorDialog.tsx`, `apps/web/src/lib/runActionAllowlist.ts`, `apps/web/src/locales/*/devices.json` and `policies.json` (8 locales each), `apps/docs/src/content/docs/features/device-groups.mdx`.
- Tests sit beside each component: `CreateGroupModal.ownerScope.test.tsx`, `DeviceGroupsPage.partnerGroups.test.tsx`, `OrganizationScopePanel.test.tsx`, `DeployMonitorDialog.test.tsx`.

### Task 4.1: Create modal scope selector

- [ ] **Red.**
  - `it('full-access partner sees "All organizations" scope; selecting it hides site, parent and Static and sends ownerScope: partner')`
  - `it('org users and selected-access partners see no selector')`
  - `it('create goes through runAction')`
- [ ] **Green.**
  - Follow the pattern in `apps/web/src/components/software/PolicyForm.tsx:28,195-207`.
  - Convert the POST (`CreateGroupModal.tsx:51`) to `runAction`, and drop the file from `runActionAllowlist.ts:15`.
  - Add `data-testid="group-owner-scope"`.
- [ ] **Commit.**

### Task 4.2: Groups page

- [ ] **Red.**
  - `it('fetches ownerScope=all, shows an "All orgs" badge and evaluation status ("N orgs not evaluated · last good evaluation <time>")')`
  - `it('partner group detail lists members with an Organization column')`
  - `it('hides edit, pin and add controls on partner groups for users without the capability')`
- [ ] **Green.** Implement in `DeviceGroupsPage.tsx` (`:259,326`). The status copy carries no SLA wording.
- [ ] **Commit.**

### Task 4.3: Partner policy assignment picker

- [ ] **Red.** In `OrganizationScopePanel.test.tsx`, add `it('partner policy offers a Device groups section listing /device-groups?ownerScope=partner and POSTs a device_group assignment via runAction')`.
- [ ] **Green.** Add the section to `OrganizationScopePanel.tsx`, which `AssignmentsTab.tsx:489` renders for partner policies.
- [ ] **Commit.**

### Task 4.4: Deploy-to

- [ ] **Red.** In `DeployMonitorDialog.test.tsx`, add `it('partner-wide monitor lists partner groups (ownerScope=partner); org monitor lists org groups')`.
- [ ] **Green.** Change the fetch at `DeployMonitorDialog.tsx:59` (D12).
- [ ] **Commit.**

### Task 4.5: Docs, locales, #7414

- [ ] **Docs.** Use the `update-breeze-docs` skill.
  - In `device-groups.mdx`, update lines 8 and 31, which say groups are org-only.
  - Document partner groups: dynamic only, the v1 limits, what org users see, and freshness, with no SLA wording.
  - State that a partner-group assignment is `device_group` level and beats org- and site-level assignments of other policies.
- [ ] **Locales.** Add every new key to all 8 locales, run locale parity and translation coverage, and check `humanizedKeyBaseline.json`.
- [ ] **#7414 (OD8).** Comment on #7414 with links to the W2a precedence test and the docs. Close #7414 only if the requester accepts group-level precedence; otherwise fold the remainder into #8957. This is an owner action.

**CI:** Test Web (component tests, `no-silent-mutations`, locale parity); Docs build.
**Exit:**
- The component suite is green (no Playwright).
- A manual click-through on a `worktree-stack` covers create → assign → effective config on two orgs, with screenshots in the PR.

**PR:** `feat(web): partner-owned device groups UI and docs (#10498 W4)`, body `Closes #<W4 sub-issue>`, `Closes #10498` (this is the last wave), `Refs #7414`.

---

## Self-review notes

- **Spec coverage:** §3.1 → W1 A, W3 3.2 · §3.2 → W1 B1 · §3.3 → W0, W2b · §3.4 → W1 B2, W2a 2a.3, W3 3.4 · §3.5 → W2a 2a.2, W4 4.4 · §3.6 → W1 A, W2a 2a.5, W3, W4 · §4.1 → W1 · §4.2 → W1 1.2–1.4 · §4.3 → sweep table · §5 holds · §6 rulings → Global Constraints · §7 load → W2b 2b.6.
- **Names used across waves.** `device_group_memberships_group_owner_check`, `PARTNER_GROUP_TARGET_UNSUPPORTED`, `acquireGroupOrgMembershipLocks`, `requestPartnerGroupEvaluationAfterCommit` and `evaluation.state` are each defined once and reused unchanged.
