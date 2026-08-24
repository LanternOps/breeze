# S0 Track A Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close RMM-QA-099 and RMM-QA-134 by enforcing referenced-resource ownership and source/target site authorization before any side effect.

**Architecture:** Two shared authorization services become the only loaders for their protected resources. Automation stores normalized ownership bindings and revalidates them at admission/dispatch; resilience routes and workers resolve minimal lineage and authorize every source and target before loading metadata or issuing work.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL RLS, Vitest unit/integration suites, BullMQ.

## Global Constraints

- Partner-wide automation may reference only partner-owned rows (`org_id IS NULL AND partner_id = owner`) or `scripts.is_system = true`; `partner_id` alone is never sufficient for scripts.
- Organization automation may reference same-organization rows, explicitly shareable same-partner rows, or system scripts; it may never reference another organization's row.
- Unknown, deleted, moved, malformed or ownership-changed references fail before run, execution, deployment, command, queue, provider or success-audit side effects.
- Cross-site restore requires source-site access, target-site access and `backup:cross_site_restore`; same-organization membership is insufficient.
- Authorization resolves only minimal identity/lineage before metadata, secrets, provider or command work.
- All new tenant tables enable and force RLS in their creation migration and are registered in cascade and tenant-export policy where applicable.
- JSON/JSONB export columns are `excludedOpen`; migrations are idempotent and never edit shipped files.
- Hot agent-write child inserts use short transactions and never interleave a `devices` row update.
- Integration tests must live under paths discovered by `vitest.integration.config.ts`; completion evidence includes the executed test-file line.
- Production deployment and production mutation are out of scope.

---

### Task 1: Automation ownership resolver

**Files:**
- Create: `apps/api/src/services/automationReferenceAuthorization.ts`
- Create: `apps/api/src/services/automationReferenceAuthorization.test.ts`
- Modify: `apps/api/src/services/automationRuntime.ts`

**Interfaces:**
- Produces: `AutomationReferenceOwner`, `ResolvedAutomationReferences`, `AutomationReferenceAuthorizationError`, and `resolveOwnedAutomationReferences(tx, owner, targetOrgIds, actions, notificationTargets)`.
- `ResolvedAutomationReferences` contains maps for scripts, software catalogs/versions and notification channels. Callers consume those rows and do not reload by ID.

- [ ] **Step 1: Write failing ownership tests**

Add table-driven cases using complete Drizzle fixtures. At minimum:

```ts
it.each([
  ['partner rejects org-owned script sharing its partnerId', partnerOwner, orgOwnedScript],
  ['org rejects foreign-org script', orgOwnerA, orgOwnedScriptB],
  ['org accepts same-org script', orgOwnerA, orgOwnedScriptA],
  ['partner accepts partner-owned script with null orgId', partnerOwner, partnerScript],
  ['either owner accepts is_system script', orgOwnerA, systemScript],
])('%s', async (_name, owner, script) => {
  const outcome = resolveFixture(owner, script);
  expect(outcome.ok).toBe(/* literal expected for the row */);
});
```

Add equivalent catalog/version/channel cases, including deleted and unknown IDs, and assert the resolver error contains a stable reason code without foreign metadata.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationReferenceAuthorization.test.ts
```

Expected: FAIL because `automationReferenceAuthorization.ts` and its exported resolver do not exist.

- [ ] **Step 3: Implement the minimal resolver**

Use per-table predicates:

```ts
export type AutomationReferenceOwner =
  | { scope: 'organization'; orgId: string; partnerId: string }
  | { scope: 'partner'; orgId: null; partnerId: string };

export async function resolveOwnedAutomationReferences(
  tx: DbTransaction,
  owner: AutomationReferenceOwner,
  targetOrgIds: readonly string[],
  actions: readonly NormalizedAutomationAction[],
  notificationTargets: readonly string[],
): Promise<ResolvedAutomationReferences>;
```

For scripts, partner ownership is `is_system OR (org_id IS NULL AND partner_id = owner.partnerId)`. For an organization owner it is `is_system OR org_id = owner.orgId` plus any existing explicitly shareable partner-owned rule. Catalog/version ownership resolves through the catalog row. Notification channels use their XOR owner axes. Query by both ID and owner; compare requested IDs with returned IDs and throw stable `unknown_or_unauthorized_reference` on any difference.

- [ ] **Step 4: Run GREEN and existing runtime tests**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationReferenceAuthorization.test.ts src/services/automationRuntime.runScript.test.ts src/services/automationRuntime.deploySoftware.test.ts
```

Expected: all selected tests pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/automationReferenceAuthorization.ts apps/api/src/services/automationReferenceAuthorization.test.ts apps/api/src/services/automationRuntime.ts
git commit -m "fix(api): authorize automation resource ownership"
```

### Task 2: Persist and quarantine automation bindings

**Files:**
- Modify: `apps/api/src/db/schema/automations.ts`
- Create: `apps/api/migrations/2026-08-24-automation-resource-bindings.sql`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/automationResourceBindings.integration.test.ts`

**Interfaces:**
- Produces `automationResourceBindings` with `automationId`, dual owner axes (`orgId XOR partnerId`), `resourceKind`, `resourceId`, expected resource-owner axes, `state`, `reason`, timestamps and uniqueness on automation/resource identity.
- A database constraint trigger rejects any binding whose `orgId`/`partnerId` owner axes differ from its parent automation. Partner-wide bindings use `orgId = null` and the automation's `partnerId`; organization bindings use the automation's `orgId` and `partnerId = null`.
- Binding states are `active | quarantined`; only active bindings admit execution.

- [ ] **Step 1: Write the real-Postgres RED suite**

Create two partners and two orgs each. Assert organization A cannot forge a binding to organization B, partner A cannot bind partner B resources, the XOR/expected-owner constraints reject malformed rows, and deleting an automation cascades its bindings. Add a bounded backfill fixture containing one valid and one foreign reference; assert the valid row becomes active and the foreign row quarantined with no execution rows.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationResourceBindings.integration.test.ts
```

Expected: FAIL because the table/migration does not exist.

- [ ] **Step 3: Add schema and idempotent migration**

Create dual-axis RLS with `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and system-or-org-or-partner access policies. Add the XOR owner check and the parent-owner constraint trigger in the same migration. Register the table in `DUAL_AXIS_TENANT_TABLES`, alphabetically in organization cascade order, and in tenant-export policy; classify ordinary columns as included and any open JSON as `excludedOpen`. The migration backfill copies the parent automation owner axes and reports active and quarantined row counts with `GET DIAGNOSTICS`/`RAISE WARNING`.

- [ ] **Step 4: Run GREEN plus migration contracts**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationResourceBindings.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
```

Expected: the named integration files execute and pass; migration naming/drift passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/automations.ts apps/api/migrations/2026-08-24-automation-resource-bindings.sql apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/automationResourceBindings.integration.test.ts
git commit -m "fix(db): bind automation resources to tenant ownership"
```

### Task 3: Enforce automation ownership at storage and execution boundaries

**Files:**
- Modify: `apps/api/src/routes/automations.ts`
- Modify: `apps/api/src/services/configurationPolicy.ts`
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts`
- Modify: `apps/api/src/services/automationRuntime.ts`
- Modify: `apps/api/src/services/softwareCurrency.ts`
- Test: adjacent route/runtime tests and `apps/api/src/__tests__/integration/automationReferenceAuthorization.integration.test.ts`

**Interfaces:**
- Consumes the Task 1 resolver and Task 2 bindings.
- Storage writes normalized active bindings in the same transaction as automation/link changes.
- Admission re-resolves current ownership before creating `automation_runs`; dispatch consumes resolved rows.

- [ ] **Step 1: Write failing boundary tests**

Cover standalone create/update and configuration-policy link with valid foreign script/catalog/version/channel IDs. Cover manual, scheduled, event, webhook and forged queued retry after ownership move/delete. Each denial asserts literal zero counts for automations/links where storage fails, and for runs, executions, deployments and commands where admission fails.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/automations.test.ts src/services/configurationPolicy.test.ts src/services/automationRuntime.runScript.test.ts src/services/automationRuntime.deploySoftware.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationReferenceAuthorization.integration.test.ts
```

Expected: foreign references are currently stored or create downstream run state, so the new assertions fail.

- [ ] **Step 3: Integrate resolver and bindings**

Normalize once, resolve within the write transaction, replace bindings atomically on update, and reject the whole write on any bad reference. At admission, resolve before inserting the run. At dispatch, use the returned maps; remove bare script and software catalog/version ID lookups. A quarantined binding returns the same stable unauthorized/unavailable error without metadata.

- [ ] **Step 4: Run GREEN**

Run the RED commands again. Expected: all named files execute and pass, including explicit zero-side-effect assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/automations.ts apps/api/src/services/configurationPolicy.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/services/automationRuntime.ts apps/api/src/services/softwareCurrency.ts apps/api/src/routes/automations.test.ts apps/api/src/services/configurationPolicy.test.ts apps/api/src/services/automationRuntime.runScript.test.ts apps/api/src/services/automationRuntime.deploySoftware.test.ts apps/api/src/__tests__/integration/automationReferenceAuthorization.integration.test.ts
git commit -m "fix(api): fail closed on automation reference changes"
```

### Task 4: Register explicit cross-site restore permission

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts`
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.ts`
- Create: `apps/api/migrations/2026-08-24-cross-site-restore-permission.sql`
- Modify: `apps/api/src/db/seed.test.ts`

**Interfaces:**
- Produces permission string `backup:cross_site_restore`.
- Default system-role grants follow the spec: only roles that deliberately administer cross-site recovery receive it; all other roles remain denied.

- [ ] **Step 1: Write failing permission parity tests**

Add literal assertions that the grant exists in `PERMISSION_GRANTS`, the catalog has an action label, seeded permission and role grants match constants, and a normal site-scoped backup writer lacks it unless explicitly granted.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts
```

Expected: FAIL because `backup:cross_site_restore` is absent.

- [ ] **Step 3: Implement all six registrations**

Update `PERMISSION_GRANTS`, `DEFAULT_PERMISSIONS`, intended `SYSTEM_ROLES`, `ACTION_LABELS`, an idempotent insert migration for permissions/role_permissions, and seed parity expectations. Do not broaden `backup:write` semantics.

- [ ] **Step 4: Run GREEN and migration naming test**

```bash
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts src/db/autoMigrate.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/permissions.ts apps/api/src/db/seed.ts apps/api/src/routes/permissionsCatalog.ts apps/api/migrations/2026-08-24-cross-site-restore-permission.sql apps/api/src/db/seed.test.ts
git commit -m "fix(authz): add explicit cross-site restore grant"
```

### Task 5: Shared resilience lineage/site authorization service

**Files:**
- Create: `apps/api/src/services/resilienceSiteAuthorization.ts`
- Create: `apps/api/src/services/resilienceSiteAuthorization.test.ts`
- Create: `apps/api/src/__tests__/integration/resilienceSiteAuthorization.integration.test.ts`

**Interfaces:**
- Produces `ResilienceResourceRef`, `AuthorizedResilienceResources`, and `authorizeResilienceResources({orgId, principal, refs, operation})` from the approved spec.
- Stable denial is `403 site_access_denied` for an authenticated known resource; not-found/foreign-org remains indistinguishable 404 according to existing route policy.

- [ ] **Step 1: Write failing unit and integration matrices**

Use known valid source/target IDs for two sites. Assert same-site allowed, source denied, target denied, null lineage denied, cross-site without explicit permission denied, and cross-site with both site grants plus explicit permission allowed. Include the confirmed wrong-argument cancel regression.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/resilienceSiteAuthorization.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceSiteAuthorization.integration.test.ts
```

Expected: FAIL because the shared service does not exist and target-only authorization permits the source-denied fixture.

- [ ] **Step 3: Implement minimal-lineage resolution**

Resolve each resource chain to `{orgId, deviceId, siteId}` only. Define site-restricted principal kinds explicitly rather than inferring from `allowedSiteIds` presence. Require all referenced sites, then require `backup:cross_site_restore` when source and target sites differ. Return authorized lineage for downstream loaders.

- [ ] **Step 4: Run GREEN**

Run the RED commands again. Expected: both named files execute and pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/resilienceSiteAuthorization.ts apps/api/src/services/resilienceSiteAuthorization.test.ts apps/api/src/__tests__/integration/resilienceSiteAuthorization.integration.test.ts
git commit -m "fix(api): authorize resilience source and target lineage"
```

### Task 6: Apply resilience authorization to every direct route

**Files:**
- Modify: `apps/api/src/routes/backup/restore.ts`
- Modify: `apps/api/src/routes/backup/vmrestore.ts`
- Modify: `apps/api/src/routes/backup/hyperv.ts`
- Modify: `apps/api/src/routes/backup/mssql.ts`
- Modify: `apps/api/src/routes/backup/snapshots.ts`
- Modify: `apps/api/src/routes/backup/bmr.ts`
- Modify: `apps/api/src/services/recoveryMediaService.ts`
- Modify: `apps/api/src/services/recoveryBootMediaService.ts`
- Modify: `apps/api/src/services/recoveryDownloadService.ts`
- Test: adjacent route tests plus `apps/api/src/__tests__/integration/resilienceRouteCoverage.integration.test.ts`

**Interfaces:**
- Consumes Task 5 authorization and loads metadata only through returned authorized lineage.
- Covers list, by-ID, create, restore, verify, legal hold, immutability, token, revoke, media download/signature and cancel paths.

- [ ] **Step 1: Write the failing mounted-route coverage matrix**

Enumerate every protected route/method as literal cases. For each, submit a known valid denied-site ID and assert the stable denial plus zero token, artifact, restore job, backup job, device command and queue rows. Add positive same-site and explicit cross-site controls.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/backup/restore.test.ts src/routes/backup/vmrestore.test.ts src/routes/backup/hyperv.test.ts src/routes/backup/mssql.test.ts src/routes/backup/bmr.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceRouteCoverage.integration.test.ts
```

Expected: source-denied restore/media/token paths fail the new assertions; cancel demonstrates the device-ID/site-ID mismatch.

- [ ] **Step 3: Replace duplicated route checks**

Call the shared service before resource metadata/secret/provider reads. Fix cancel to authorize resolved lineage rather than passing a device ID to a site helper. List routes filter through authorized device/site lineage without leaking denied counts.

- [ ] **Step 4: Run GREEN**

Run the RED commands again. Expected: all enumerated routes execute and pass with zero denied side effects.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/backup apps/api/src/services/recoveryMediaService.ts apps/api/src/services/recoveryBootMediaService.ts apps/api/src/__tests__/integration/resilienceRouteCoverage.integration.test.ts
git commit -m "fix(api): enforce site scope across recovery routes"
```

### Task 7: Revalidate queued recovery work

**Files:**
- Modify: `apps/api/src/db/schema/backup.ts`
- Modify: `apps/api/src/db/schema/recoveryTokens.ts`
- Create: `apps/api/migrations/2026-08-24-recovery-authorization-subject.sql`
- Modify: `apps/api/src/jobs/recoveryMediaWorker.ts`
- Modify: `apps/api/src/jobs/recoveryBootMediaWorker.ts`
- Test: adjacent worker tests and `apps/api/src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts`

**Interfaces:**
- Job input carries stable initiating principal identity and authorization revision.
- Every worker invokes Task 5 immediately before provider/queue/command side effects.
- Legacy jobs without a recoverable subject transition to `quarantined_authorization_unknown`.

- [ ] **Step 1: Write failing queued/retry tests**

Cover site access revoked after enqueue, source moved after enqueue, delayed retry, API-key/service-principal subject, and a legacy job without subject. Assert zero provider calls, queues and device commands after denial; assert the job's durable quarantined/denied state.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/*restore*.test.ts src/jobs/*recovery*.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts
```

Expected: queued work currently lacks subject/revalidation and the denial assertions fail.

- [ ] **Step 3: Add additive subject storage and worker gate**

Use existing actor/principal storage patterns. Register any added columns in tenant export policy, classifying open JSON as `excludedOpen`. Quarantine legacy jobs and revalidate current subject/grant/site lineage immediately before each irreversible boundary.

- [ ] **Step 4: Run GREEN and Track A regression suites**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationReferenceAuthorization.test.ts src/services/resilienceSiteAuthorization.test.ts src/routes/automations.test.ts src/routes/backup/restore.test.ts src/routes/backup/vmrestore.test.ts src/routes/backup/hyperv.test.ts src/routes/backup/mssql.test.ts src/routes/backup/bmr.test.ts src/jobs/*restore*.test.ts src/jobs/*recovery*.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationResourceBindings.integration.test.ts src/__tests__/integration/automationReferenceAuthorization.integration.test.ts src/__tests__/integration/resilienceSiteAuthorization.integration.test.ts src/__tests__/integration/resilienceRouteCoverage.integration.test.ts src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm db:check-drift
```

Expected: every named test file is reported as executed and passes; drift check passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/migrations/2026-08-24-recovery-authorization-subject.sql
git commit -m "fix(workers): reauthorize queued recovery work"
```

## Track completion gate

Before Track A is marked code-complete:

```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/api build
pnpm lint
git diff --check 80b498ecee73bb1c3f5f58e47dce65a016dc892c..HEAD
```

The full branch review occurs once after all five tracks, per repository instructions. Track A proceeds on its targeted and integration evidence; any environment-only proof remains fixed-unverified and is recorded for the final candidate packet.
