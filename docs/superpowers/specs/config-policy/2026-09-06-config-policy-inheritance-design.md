---
title: Configuration policy inheritance (persisted parent, one level)
status: draft
date: 2026-09-06
origin: "#5023 browser walk paper cut: 'inherited policy state only shows with ?linked='"
---

# Configuration policy inheritance

## Problem

The configuration-policy editor sells inheritance it does not have. "Link to Existing" on the
create page picks a "Master Policy", POSTs an ordinary policy, and redirects to
`/configuration-policies/<id>?linked=<parentId>`. The detail page reads `?linked=` from
`window.location`, fetches the parent, and renders every feature tab as *Configured (inherited)*
with an **Override** button. Nothing is persisted and nothing is resolved:

- `configuration_policies` has no parent column. The link lives only in the URL, so a reload,
  a bookmark, or the list page loses it. That is the symptom reported on #5023.
- Every effective-config reader (the generic resolver, `featureConfigResolver.ts`, the agent
  config-payload builders in `routes/agents/helpers.ts`, the lifecycle/helper/warranty resolvers,
  the backup/patch/automation schedulers) joins `config_policy_feature_links` on the **assigned
  policy's own id**. A device assigned to a "linked" child receives **nothing** for any tab the
  tech did not explicitly override, while the UI says it is inherited.
- Thirteen of the eighteen feature tabs stamp the parent *configuration policy* id into
  `featurePolicyId` on save. `featurePolicyId` means a standalone feature entity (update ring,
  backup profile, software policy). The value is never read back for inline-settings features,
  but it is the wrong kind of id in a persisted column.
- Three tabs (Security, Sensitive Data, Remote Access) ignore the parent entirely, so even the
  display is inconsistent.

Advisor quorum (Fable + Codex xhigh, 2026-09-06) agreed: persist the parent and make resolution
honour it. Persisting the parent for display only was rejected (it persists a lie); copying the
parent's links at create time was rejected unless the product becomes "duplicate policy".

## Goals

1. A policy's parent is a persisted, validated, tenant-safe fact returned by the API.
2. Every reader that decides what a device gets sees the child's own links **plus** the parent's
   links for feature types the child lacks. One definition, used everywhere, with a contract test
   that keeps it that way.
3. The web app derives all inheritance state from the API. No URL parameter.
4. The feature-tab save payloads stop conflating id kinds.

## Non-goals

- Multi-level chains. A parent cannot itself have a parent (enforced).
- Changing or detaching a parent after create. `parent_policy_id` is set at create only.
  A "detach"/"re-parent" affordance is a natural follow-up once the invariants below exist.
- Field-level merging. A child link is a complete override of the parent's link for that feature.
- Backfill. No persisted state exists today, so there is nothing to migrate. Policies created
  through the old "linked" flow were never linked; they stay plain policies.
- AI tool support for creating linked policies (`aiToolsConfigPolicy.ts`). Follow-up.

## Semantics

**Effective links of a policy P** = P's own `config_policy_feature_links` rows, plus, when P has
a parent, the parent's rows whose `feature_type` P has no row for.

- An inherited link competes at the **child's** assignment level and priority. The parent's own
  assignments are unaffected and unrelated.
- The parent's `status` does not gate inheritance. Archiving a baseline does not silently strip
  security, patch, or backup configuration from every child; only the assigned child's own
  `status = active` matters, as today. The parent's detail page shows how many policies inherit
  from it so the operator can see the blast radius.
- A parent's link change propagates live. That is the point of a baseline.
- Provenance: the resolved feature carries `sourcePolicyId` = the assigned child (which
  assignment won) and, when the link came from the parent, `inheritedFromPolicyId` /
  `inheritedFromPolicyName`.
- Override = the child gains its own link for that feature (today's tabs already do this by
  POSTing the parent-seeded form state). Revert = delete the child's link, falling back to the
  parent (today's "Revert to Parent"). Both keep working unchanged.

## Ownership rule (tenancy)

`configuration_policies` is org-XOR-partner owned (`configuration_policies_one_owner_chk`). A
child may reference a parent only when:

| child | allowed parent |
|---|---|
| org-owned (`org_id = O`, org O belongs to partner P) | same org (`parent.org_id = O`), **or** partner-wide of the same partner (`parent.org_id IS NULL AND parent.partner_id = P`) |
| partner-wide (`partner_id = P`) | partner-wide of the same partner only |

Plus: `parent.parent_policy_id IS NULL` (one level), `parent.id <> child.id`.

Enforced twice:

1. **App layer** in `createConfigPolicy`, inside the insert's transaction: read the parent through
   the request's RLS context, check the rule, then insert. No row lock: an org token cannot take
   `FOR KEY SHARE` on a partner-wide parent (row locks apply the UPDATE policy, which the
   partner-wide SELECT-only branch does not satisfy). The race that a lock would close, the
   parent being deleted between check and insert, is closed by the FK: the insert fails with
   23503 and is mapped to the same 400 as "parent not found". The other race, the parent gaining
   a parent, cannot happen because `parent_policy_id` is immutable after create.
2. **Database trigger** `configuration_policies_parent_guard` (BEFORE INSERT, and BEFORE UPDATE
   OF `parent_policy_id`) as defense in depth. It re-checks the rule by selecting the parent as
   the invoking role, so under FORCE RLS a parent the caller cannot see is treated as not found.
   It also rejects any UPDATE that changes a non-null `parent_policy_id` (immutability). It
   deliberately does **not** fire on `UPDATE OF org_id`: org merge re-points `org_id` on parent
   and child in separate statements inside one transaction, and both rows move to the same
   target org, so the rule holds again by commit. The guard raises SQLSTATE 23514 with a fixed
   constraint name so the route can map it to a 400 with a stable error code.

Error surface: `400 { error: 'INVALID_PARENT_POLICY' }` for not-found / not-eligible /
cross-tenant / has-its-own-parent, one message for all of them so it is not an existence oracle.

## Deletion

- `DELETE /configuration-policies/:id` on a policy that has children returns
  `409 { error: 'POLICY_HAS_CHILDREN', children: [{ id, name }] }`. The FK is the backstop: a
  23503 from the self-FK maps to the same 409.
- FK action is the default `NO ACTION` (not `RESTRICT`, not `SET NULL`). Verified on
  PostgreSQL 16.15 (the prod version): a single `DELETE ... WHERE org_id = X` that removes parent
  and children together succeeds under both, and deleting a parent alone is refused. `NO ACTION`
  is the repo convention and stays deferrable-compatible for org merge. `SET NULL` was rejected
  because a baseline deletion would silently un-configure every child.
- Org cascade (`tenantCascade`) deletes all of an org's policies in one statement, so parents and
  children in the same org go together. A partner-wide parent with children in the erased org:
  the children go, the parent stays. Partner erasure deletes partner-wide rows after every org's
  rows, so no child can outlive its parent there either. No change to the cascade lists is
  needed (no new table); `tenantCascade.integration.test.ts` must still pass.

## Data model

Migration `apps/api/migrations/2026-10-12-100000-config-policy-inheritance.sql` (name must sort
after the newest committed migration at the time it is written; verify against `origin/main`).
Idempotent, no DML, so no `breeze.scope` election is needed.

```sql
ALTER TABLE configuration_policies
  ADD COLUMN IF NOT EXISTS parent_policy_id uuid;
-- self-FK, default NO ACTION
ALTER TABLE configuration_policies DROP CONSTRAINT IF EXISTS configuration_policies_parent_policy_id_fkey;
ALTER TABLE configuration_policies ADD CONSTRAINT configuration_policies_parent_policy_id_fkey
  FOREIGN KEY (parent_policy_id) REFERENCES configuration_policies(id);
ALTER TABLE configuration_policies DROP CONSTRAINT IF EXISTS configuration_policies_not_own_parent_chk;
ALTER TABLE configuration_policies ADD CONSTRAINT configuration_policies_not_own_parent_chk
  CHECK (parent_policy_id IS NULL OR parent_policy_id <> id);
CREATE INDEX IF NOT EXISTS config_policies_parent_policy_id_idx
  ON configuration_policies (parent_policy_id) WHERE parent_policy_id IS NOT NULL;
-- trigger function + trigger: see Ownership rule. CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS, CREATE TRIGGER.
```

**Effective-links view** (first view in the repo; the reasons it is a view and not a helper are
in Resolver sweep):

```sql
CREATE OR REPLACE VIEW config_policy_effective_feature_links
  WITH (security_invoker = true) AS
  SELECT l.id, l.config_policy_id, l.config_policy_id AS source_policy_id,
         l.feature_type, l.feature_policy_id, l.inline_settings, l.created_at, l.updated_at,
         false AS inherited
    FROM config_policy_feature_links l
  UNION ALL
  SELECT pl.id, c.id AS config_policy_id, pl.config_policy_id AS source_policy_id,
         pl.feature_type, pl.feature_policy_id, pl.inline_settings, pl.created_at, pl.updated_at,
         true AS inherited
    FROM configuration_policies c
    JOIN config_policy_feature_links pl ON pl.config_policy_id = c.parent_policy_id
   WHERE c.parent_policy_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM config_policy_feature_links own
                      WHERE own.config_policy_id = c.id AND own.feature_type = pl.feature_type);
GRANT SELECT ON config_policy_effective_feature_links TO breeze_app;
```

- `security_invoker = true` (PostgreSQL 15+; prod is 16.15) makes the base tables' RLS apply to
  the caller. An org-scoped context sees a partner-wide parent's links through the existing
  `config_policy_feature_links_partner_wide_select` branch, which is also populated on the
  agent-auth path (`currentPartnerId`), so agent config delivery inherits correctly without any
  system-context escalation.
- Drizzle: declare with `pgView(...).existing()` so drizzle-kit never tries to manage it; the
  `id` column is the underlying link id (an inherited row reuses the parent link's id, which is
  what feature-link-id keyed readers such as the automation schedule trigger already expect).
- `pnpm db:check-drift` must be run in W01 to confirm the drift checker is view-neutral; if it is
  not, the fix is in `scripts/check-drift.ts`, not in the migration.
- `rls-coverage.integration.test.ts` enumerates tables; a view carries no RLS of its own and must
  not be added to any allowlist. W01 runs the suite to confirm.

Drizzle schema: `parentPolicyId: uuid('parent_policy_id')` on `configurationPolicies` with the
self-reference declared via the `AnyPgColumn` pattern.

Registries: `tenantExportPolicyRegistry.ts` → add `parent_policy_id` to the `included` bucket of
`configuration_policies` (a plain tenant identifier). No cascade-list change (no new table, no new
`device_id`). Org merge: `configuration_policies` is already in `REPOINT_TABLES`; nothing to add.
Export note: an org export may carry a `parent_policy_id` that points at a partner-wide parent
outside the export set. There is no import path today (the roundtrip suite exports and erases),
so this is documented on the registry entry, not handled.

## API

- `POST /configuration-policies`: `parentPolicyId?: uuid` (shared validator
  `createConfigPolicySchema`). Validated per Ownership rule. `updateConfigPolicySchema` does not
  accept it.
- `GET /configuration-policies/:id`: adds `parentPolicyId: string | null`,
  `parentPolicy: { id, name, status } | null`, `childPolicies: { id, name }[]`. `featureLinks`
  stays the policy's **own** links (the editor must never show inherited rows as authored).
- `GET /configuration-policies` (list): adds `parentPolicyId` per row (and `parentName` when
  cheap via the existing join) so the list can badge children and the create page can filter
  eligible parents client-side (`parentPolicyId === null` and owner-compatible).
- `GET /configuration-policies/effective/:deviceId` and the diff preview: each resolved feature
  adds `inheritedFromPolicyId: string | null` and `inheritedFromPolicyName: string | null`.
- `DELETE /configuration-policies/:id`: `409 POLICY_HAS_CHILDREN` as above.
- Partner API configuration export (`routes/partnerApi/configuration.ts`): add `parentPolicyId`
  to the policy shape. Links remain the authored form (own links only) plus the parent pointer;
  consumers derive the effective set. This keeps the per-org export clocks correct without fanning
  a partner-wide parent's change out to every child org.

## Resolver sweep

Every reader classified as *effective-config resolver*, *agent-facing delivery*, or
*worker/scheduler* in the 2026-09-06 inventory switches its join from `configPolicyFeatureLinks`
to the view (`configPolicyEffectiveFeatureLinks`). The join shape is identical
(`config_policy_id = configuration_policies.id AND feature_type = X`), which is why a view beats a
TypeScript helper here: 25 independently coded queries change one identifier each instead of being
restructured around a post-fetch merge.

Readers that must switch (file → functions):

- `services/configurationPolicy.ts` → `resolveEffectiveConfigWithExecutor` (+ provenance fields)
- `services/featureConfigResolver.ts` → `resolveGoverningAlertRulePolicyForDevice`,
  `resolveAlertRulesForDevice`, `resolveAutomationsForDevice`, `resolvePatchConfigForDevice`,
  `resolvePatchConfigDetailsForDevice`, `resolveBackupConfigForDevice`,
  `resolveMaintenanceConfigForDevice`, `resolveComplianceRulesForDevice`,
  `resolveSoftwarePolicyForDevice`, `resolveDeviceIdsForSoftwarePolicy`,
  `resolveVulnerabilityEnabledForDevice`, `resolveAllVulnerabilityEnabledDevices`,
  `resolveAllBackupAssignedDevices`, `resolveBackupProtectionForDevice`,
  `scanScheduledAutomations`, `scanDueComplianceChecks`
- `routes/agents/helpers.ts` → event_log, monitoring, helper, pam, onedrive_helper resolvers and
  their `build*ConfigUpdate` callers
- `services/deviceLifecyclePolicy.ts` → `getOrgPurgeRemovedAfterDays`
- `services/helperPermissions.ts` → `resolveHelperPermissionLevelForDevice`
- `services/warrantyAlertEvaluator.ts` → `resolveWarrantySettings`, `evaluateWarrantyAlerts`
- `routes/remote/helpers.ts` → `resolveRemoteSessionPromptConfig`
- `jobs/automationWorker.ts` → `processTriggerConfigPolicySchedule` (**id-keyed**: it resolves a
  `featureLinkId` to a policy; through the view one link id maps to the parent **and** every
  child, so the plan must decide per call site whether the dispatch fans out per assigned
  policy or stays keyed on the authoring policy. Do not switch it blindly.)
- `jobs/backupWorker.ts` → `processCheckSchedules`
- `jobs/patchSchedulerWorker.ts` → `scanAndCreateJobs`
- `services/patchJobService.ts` → `createPatchJobFromConfigPolicy`,
  `createPatchJobForDeviceFromPolicy`
- `services/automationRuntime.ts` → `resolveConfigPolicyAutomationContext`

Readers that keep the base table (they edit or report a policy's **own** links):
`configurationPolicy.ts` link CRUD (`addFeatureLink`, `updateFeatureLink`, `removeFeatureLink`,
`listFeatureLinks`), `routes/updateRingsHelpers.ts`, `routes/policyManagement/*`,
`routes/scripts.ts` delete guard, `routes/backup/profiles.ts` delete guard,
`routes/softwareInventory.ts` `ensureDefaultConfigPolicyLink`, `aiTools*.ts`,
`routes/partnerApi/configuration.ts`, `scripts/migrateToConfigPolicies.ts`,
`services/alertCorrelationRca.ts` (evidence naming). Where a "which devices does this standalone
policy govern" reverse lookup exists (`resolveDeviceIdsForSoftwarePolicy`, update-ring device
counts, backup profile `referencingPolicies`), it switches to the view too when it feeds
enforcement, and stays on the base table when it only guards deletion of the standalone entity.
The plan lists each with its classification.

**Contract test** `apps/api/src/services/featureLinkReaders.contract.test.ts` (unit job): reads
the source tree, and fails if any file outside a fixed allowlist imports `configPolicyFeatureLinks`
or mentions `config_policy_feature_links` in a query. The allowlist is the "keep the base table"
set above. This is the mechanical guard, in the spirit of the cascade lists: a new feature type
that adds its own resolver against the base table goes red in **Test API**, not in production.

**Integration proof** `configPolicyInheritance.integration.test.ts` (real Postgres):
1. Org-scoped token creates a child of a same-org parent; a child of a partner-wide parent of the
   same partner; both succeed. A child of another org's parent, a child of another partner's
   partner-wide policy, and a child of a policy that already has a parent all fail with
   `INVALID_PARENT_POLICY`. A forged insert as `breeze_app` bypassing the route hits the trigger.
2. A device assigned to the child receives the parent's link for an un-overridden feature and the
   child's link for an overridden one, through the generic resolver, through one
   `featureConfigResolver` function, and through one agent helper (event_log) under the **agent
   auth context** with a partner-wide parent.
3. Deleting the parent alone → 409; deleting the child, then the parent → ok; org cascade with
   parent and child in the org → ok.
4. Effective-config provenance reports `inheritedFromPolicyId` on the inherited feature only.

## Web

- **Create page**: "Link to Existing" sends `parentPolicyId` in the POST and no longer appends
  `?linked=`. `PolicyLinkSelector` gets an `eligibleParent` filter: `parentPolicyId === null`
  and owner-compatible with the chosen owner scope (same org, or partner-wide; partner-wide child
  → partner-wide parents only), excluding the policy being created. Server validation is the
  authority; the filter is a courtesy.
- **Detail page**: `linkedPolicyId` comes from `policy.parentPolicyId`; the parent name from
  `policy.parentPolicy`. The existing second fetch of the parent's feature links stays (RLS lets
  an org user read a partner-wide parent). The `?linked=` initializer is deleted. New: a
  "Inherited by N policies" line with links on a parent's Overview tab.
- **List page**: a small "inherits ← <parent>" badge on child rows. Delete of a parent shows the
  409 children list in the confirm modal's error state.
- **Feature tabs**: the 13 inline-settings tabs send `featurePolicyId: null` (not
  `linkedPolicyId`). Security, Sensitive Data, and Remote Access gain the same
  `isInherited` / `effectiveLink` / Override / Revert treatment via `FeatureTabShell`. Backup,
  Peripheral Control, and Software Policy already handle the feature entity id correctly and
  stay as they are.
- **Effective configuration tab** (`DeviceEffectiveConfigTab.tsx`): when a feature carries
  `inheritedFromPolicyId`, render "via <child> ← inherited from <parent>".
- i18n: new keys in all 8 locales; the existing `inheritingFrom` / `parentPolicy` /
  `overrideIndividualTabsToCustomizeSettings` keys are reused.
- Tests: create page posts `parentPolicyId` and filters the selector; detail page renders the
  banner from API data with no URL param and lists children; list badge; a tab test proving the
  save payload carries `featurePolicyId: null`; the three newly inheriting tabs each get an
  "inherited → Override" test (pattern: `DeviceLifecycleTab.test.tsx:129`).

## Waves

| wave | scope | depends on |
|---|---|---|
| W01 API foundation | migration (column, FK, CHECK, index, trigger, view, grant), Drizzle schema + existing-view, shared validator, create validation + delete 409, GET/list/partner-API shapes, export-policy bucket, unit tests, integration suite parts 1, 3 | — |
| W02 Resolver sweep | switch every listed reader to the view, provenance fields, contract test, integration suite parts 2, 4 | W01 |
| W03 Web + docs | create/detail/list/tabs/effective tab, i18n, web tests, `apps/docs` configuration-policies page, release-notes entry | W01 (API shape); parallel with W02 |

Rigor: high on W01 and W02 (migration, RLS-adjacent trigger, agent-shipped config). W03 is UI.
Each wave: TDD, `tsc`, targeted tests, then the contract suites that a live DB needs
(`rls-coverage`, `tenantCascade`, `tenant-export-policy`, the new inheritance suite) before PR.

## Risks and mitigations

- **First view in the repo.** Unknowns are the drift checker and any test that enumerates
  relations. Both are checked in W01 before anything depends on the view. There is no fallback
  to a plain view: without `security_invoker` a view runs as its owner and bypasses RLS. The
  repo already requires PostgreSQL 15+ (the #3258 pre-release gate confirmed prod is on 16);
  the release notes restate it.
- **Missed reader.** The contract test turns a missed reader into a unit-job failure. The plan's
  reader list is the inventory above; W02 re-greps at start.
- **Performance.** Policies number in the dozens per tenant; the view is a `UNION ALL` with a
  correlated `NOT EXISTS` on an indexed `(config_policy_id, feature_type)` unique index. Agent
  config delivery already runs several of these joins per heartbeat; W02 compares `EXPLAIN` for
  one agent helper before/after as `breeze_app`.
- **Org merge.** Trigger excluded from `UPDATE OF org_id`; `orgLifecycleFoundations` and
  `orgMerge` integration suites run in W01.
- **Semantics surprise: archived parent still inherited.** Surfaced in the UI (children count on
  the parent, "inherited from <parent> (inactive)" banner state on the child) and in docs.

## Release notes

- New: configuration policies can inherit from a baseline policy (same org or partner-wide).
  Migration adds `configuration_policies.parent_policy_id` and a view
  `config_policy_effective_feature_links`; requires PostgreSQL 15+ (`security_invoker`).
- Behaviour: policies created earlier through "Link to Existing" were never linked; re-create
  them as linked policies to get inheritance.
