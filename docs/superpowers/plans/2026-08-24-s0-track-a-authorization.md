---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
---

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

- [x] **Step 1: Write failing ownership tests**

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

- [x] **Step 2: Run RED**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationReferenceAuthorization.test.ts
```

Expected: FAIL because `automationReferenceAuthorization.ts` and its exported resolver do not exist.

- [x] **Step 3: Implement the minimal resolver**

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

- [x] **Step 4: Run GREEN and existing runtime tests**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationReferenceAuthorization.test.ts src/services/automationRuntime.runScript.test.ts src/services/automationRuntime.deploySoftware.test.ts
```

Expected: all selected tests pass with no warnings.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/automationReferenceAuthorization.ts apps/api/src/services/automationReferenceAuthorization.test.ts apps/api/src/services/automationRuntime.ts
git commit -m "fix(api): authorize automation resource ownership"
```

### Task 2: Persist and quarantine automation bindings

**Files:**
- Modify: `apps/api/src/db/schema/automations.ts`
- Create: `apps/api/migrations/2026-09-25-a-automation-resource-bindings.sql`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/automationResourceBindings.integration.test.ts`

**Interfaces:**
- Produces `automationResourceBindings` with `automationId`, dual owner axes (`orgId XOR partnerId`), `resourceKind`, `resourceId`, expected resource-owner axes, `state`, `reason`, timestamps and uniqueness on automation/resource identity.
- A database constraint trigger rejects any binding whose `orgId`/`partnerId` owner axes differ from its parent automation. Partner-wide bindings use `orgId = null` and the automation's `partnerId`; organization bindings use the automation's `orgId` and `partnerId = null`.
- Binding states are `active | quarantined`; only active bindings admit execution.

- [x] **Step 1: Write the real-Postgres RED suite**

Create two partners and two orgs each. Assert organization A cannot forge a binding to organization B, partner A cannot bind partner B resources, the XOR/expected-owner constraints reject malformed rows, and deleting an automation cascades its bindings. Add a bounded backfill fixture containing one valid and one foreign reference; assert the valid row becomes active and the foreign row quarantined with no execution rows.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationResourceBindings.integration.test.ts
```

Expected: FAIL because the table/migration does not exist.

- [x] **Step 3: Add schema and idempotent migration**

Create dual-axis RLS with `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and system-or-org-or-partner access policies. Add the XOR owner check and the parent-owner constraint trigger in the same migration. Register the table in `DUAL_AXIS_TENANT_TABLES`, alphabetically in organization cascade order, and in tenant-export policy; classify ordinary columns as included and any open JSON as `excludedOpen`. The migration backfill copies the parent automation owner axes and reports active and quarantined row counts with `GET DIAGNOSTICS`/`RAISE WARNING`.

- [x] **Step 4: Run GREEN plus migration contracts**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationResourceBindings.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
```

Expected: the named integration files execute and pass; migration naming/drift passes.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/automations.ts apps/api/migrations/2026-09-25-a-automation-resource-bindings.sql apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/automationResourceBindings.integration.test.ts
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

- [x] **Step 1: Write failing boundary tests**

Cover standalone create/update and configuration-policy link with valid foreign script/catalog/version/channel IDs. Cover manual, scheduled, event, webhook and forged queued retry after ownership move/delete. Each denial asserts literal zero counts for automations/links where storage fails, and for runs, executions, deployments and commands where admission fails.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/automations.test.ts src/services/configurationPolicy.test.ts src/services/automationRuntime.runScript.test.ts src/services/automationRuntime.deploySoftware.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationReferenceAuthorization.integration.test.ts
```

Expected: foreign references are currently stored or create downstream run state, so the new assertions fail.

- [x] **Step 3: Integrate resolver and bindings**

Normalize once, resolve within the write transaction, replace bindings atomically on update, and reject the whole write on any bad reference. At admission, resolve before inserting the run. At dispatch, use the returned maps; remove bare script and software catalog/version ID lookups. A quarantined binding returns the same stable unauthorized/unavailable error without metadata.

- [x] **Step 4: Run GREEN**

Run the RED commands again. Expected: all named files execute and pass, including explicit zero-side-effect assertions.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/automations.ts apps/api/src/services/configurationPolicy.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/services/automationRuntime.ts apps/api/src/services/softwareCurrency.ts apps/api/src/routes/automations.test.ts apps/api/src/services/configurationPolicy.test.ts apps/api/src/services/automationRuntime.runScript.test.ts apps/api/src/services/automationRuntime.deploySoftware.test.ts apps/api/src/__tests__/integration/automationReferenceAuthorization.integration.test.ts
git commit -m "fix(api): fail closed on automation reference changes"
```

### Task 4: Register explicit cross-site restore permission

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts`
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.ts`
- Create: `apps/api/migrations/2026-09-25-b-cross-site-restore-permission.sql`
- Modify: `apps/api/src/db/seed.test.ts`

**Interfaces:**
- Produces permission string `backup:cross_site_restore`.
- Default system-role grants follow the spec: only roles that deliberately administer cross-site recovery receive it; all other roles remain denied.

- [x] **Step 1: Write failing permission parity tests**

Add literal assertions that the grant exists in `PERMISSION_GRANTS`, the catalog has an action label, seeded permission and role grants match constants, and a normal site-scoped backup writer lacks it unless explicitly granted.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts
```

Expected: FAIL because `backup:cross_site_restore` is absent.

- [x] **Step 3: Implement all six registrations**

Update `PERMISSION_GRANTS`, `DEFAULT_PERMISSIONS`, intended `SYSTEM_ROLES`, `ACTION_LABELS`, an idempotent insert migration for permissions/role_permissions, and seed parity expectations. Do not broaden `backup:write` semantics.

- [x] **Step 4: Run GREEN and migration naming test**

```bash
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts src/db/autoMigrate.test.ts
```

Expected: all selected tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/shared/src/constants/permissions.ts apps/api/src/db/seed.ts apps/api/src/routes/permissionsCatalog.ts apps/api/migrations/2026-09-25-b-cross-site-restore-permission.sql apps/api/src/db/seed.test.ts
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

- [x] **Step 1: Write failing unit and integration matrices**

Use known valid source/target IDs for two sites. Assert same-site allowed, source denied, target denied, null lineage denied, cross-site without explicit permission denied, and cross-site with both site grants plus explicit permission allowed. Include the confirmed wrong-argument cancel regression.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/resilienceSiteAuthorization.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceSiteAuthorization.integration.test.ts
```

Expected: FAIL because the shared service does not exist and target-only authorization permits the source-denied fixture.

- [x] **Step 3: Implement minimal-lineage resolution**

Resolve each resource chain to `{orgId, deviceId, siteId}` only. Define site-restricted principal kinds explicitly rather than inferring from `allowedSiteIds` presence. Require all referenced sites, then require `backup:cross_site_restore` when source and target sites differ. Return authorized lineage for downstream loaders.

- [x] **Step 4: Run GREEN**

Run the RED commands again. Expected: both named files execute and pass.

- [x] **Step 5: Commit**

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

- [x] **Step 1: Write the failing mounted-route coverage matrix**

Enumerate every protected route/method as literal cases. For each, submit a known valid denied-site ID and assert the stable denial plus zero token, artifact, restore job, backup job, device command and queue rows. Add positive same-site and explicit cross-site controls.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/backup/restore.test.ts src/routes/backup/vmrestore.test.ts src/routes/backup/hyperv.test.ts src/routes/backup/mssql.test.ts src/routes/backup/bmr.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceRouteCoverage.integration.test.ts
```

Expected: source-denied restore/media/token paths fail the new assertions; cancel demonstrates the device-ID/site-ID mismatch.

- [x] **Step 3: Replace duplicated route checks**

Call the shared service before resource metadata/secret/provider reads. Fix cancel to authorize resolved lineage rather than passing a device ID to a site helper. List routes filter through authorized device/site lineage without leaking denied counts.

- [x] **Step 4: Run GREEN**

Run the RED commands again. Expected: all enumerated routes execute and pass with zero denied side effects.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/backup apps/api/src/services/recoveryMediaService.ts apps/api/src/services/recoveryBootMediaService.ts apps/api/src/__tests__/integration/resilienceRouteCoverage.integration.test.ts
git commit -m "fix(api): enforce site scope across recovery routes"
```

### Task 7: Persist and rehydrate queued recovery authorization subjects

**Files:**
- Modify: `apps/api/src/db/schema/backup.ts`
- Modify: `apps/api/src/db/schema/recoveryTokens.ts`
- Modify: `apps/api/src/db/schema/drPlans.ts`
- Modify: `apps/api/src/db/schema/c2c.ts`
- Create: `apps/api/migrations/2026-09-25-c-recovery-authorization-subject.sql`
- Create: `apps/api/src/services/recoveryAuthorizationSubject.ts`
- Create: `apps/api/src/services/recoveryAuthorizationSubject.test.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Test: migration, export-policy, and RLS integration contracts

**Interfaces:**
- Durable work rows embed `authorizationPrincipalKind`, stable `authorizationPrincipalId`, `authorizationGrantRevision`, `authorizationState`, `authorizationDenialCode`, and `authorizationCheckedAt`; no mutable permission snapshot is authoritative.
- Principal IDs identify the actual user, API key, OAuth grant, AI run, or an allowlisted versioned system reason. `agent`, `helper`, and unknown identities are not accepted authorization subjects.
- `captureRecoveryAuthorizationSubject`, `rehydrateRecoveryAuthorizationSubject`, and `authorizeQueuedRecoveryWork` reload live principal status, delegated scope/base permission, and Task 5 lineage on every attempt.
- Matching revisions are audit evidence only and never skip live authorization. Known denial is non-retriable; transient dependency failure remains retriable.
- Legacy nonterminal work with no safely recoverable subject becomes `quarantined_authorization_unknown`; terminal history becomes `not_required` without rewriting operational status.

- [x] **Step 1: Write RED schema, migration, and subject-resolution tests**

Cover active and disabled users; human and service-principal API keys; revoked/expired OAuth grants and blocked clients; disabled AI runs/effective policy changes; allowlisted system reasons; rejected unknown/system strings; revision drift; and transient lookup failure. Assert no subject can be reconstructed from `createdBy`/`initiatedBy` alone.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/recoveryAuthorizationSubject.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: the subject tuple/service/migration do not exist and the new export/migration assertions fail.

- [x] **Step 3: Implement additive storage and live rehydration**

Use idempotent `ADD COLUMN IF NOT EXISTS`, checked kind/state allowlists, and claim indexes. Add `operationKind` to C2C jobs so sync and restore are not conflated. Register ordinary subject fields in tenant export policy. Do not create a polymorphic subject table and do not grant service API keys through their creators. Base permission/delegated scope and current site lineage are both required.

- [x] **Step 4: Run GREEN plus migration contracts**

Run the RED commands plus:

```bash
bash scripts/check-migration-naming.sh
pnpm --filter @breeze/api check:migrations
pnpm db:check-drift
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/db apps/api/src/services/recoveryAuthorizationSubject.ts apps/api/src/services/recoveryAuthorizationSubject.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration apps/api/migrations/2026-09-25-c-recovery-authorization-subject.sql
git commit -m "fix(db): persist recovery authorization subjects"
```

### Task 8: Reauthorize recovery media and boot-media work

**Files:**
- Modify: `apps/api/src/routes/backup/bmr.ts`
- Modify: `apps/api/src/services/recoveryMediaService.ts`
- Modify: `apps/api/src/services/recoveryBootMediaService.ts`
- Modify: `apps/api/src/jobs/recoveryMediaWorker.ts`
- Modify: `apps/api/src/jobs/recoveryBootMediaWorker.ts`
- Modify: `apps/api/src/jobs/queueSchemas.ts` only if the queue envelope carries a diagnostic revision
- Test: adjacent route/service/worker tests

**Interfaces:**
- New and explicitly retried media/boot work captures a complete current subject in the same transaction as the durable row/reset.
- Workers reload the durable subject and authorize current source/target lineage immediately before atomically claiming `building`; queue payload permissions are never authority.
- Denied and legacy-unknown work records a durable denial/quarantine and performs zero builder, storage, signing, provider, queue, or command effects.

- [x] **Step 1: Write failing producer/retry/worker tests**

Cover revocation after enqueue, source device moved sites, delayed retry, a previously authorized retry, each supported principal kind, and a legacy unknown row. Assert literal zero builder/storage/signing calls and that observing an existing job does not replace its subject.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/backup/bmr.test.ts src/services/recoveryMediaService.test.ts src/jobs/recoveryMediaWorker.test.ts src/jobs/recoveryBootMediaWorker.test.ts
```

- [x] **Step 3: Capture, rehydrate, authorize, and claim**

Wire Task 7 at every producer and worker attempt. A retry requested by a different currently authorized caller replaces the prior subject atomically; passive reads do not. Use BullMQ `UnrecoverableError` for known authorization denial and preserve retries for transient failures.

- [x] **Step 4: Run GREEN and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/backup/bmr.test.ts src/services/recoveryMediaService.test.ts src/jobs/recoveryMediaWorker.test.ts src/jobs/recoveryBootMediaWorker.test.ts src/services/recoveryAuthorizationSubject.test.ts src/services/resilienceSiteAuthorization.test.ts
git add apps/api/src/routes/backup/bmr.ts apps/api/src/services/recoveryMediaService.ts apps/api/src/services/recoveryBootMediaService.ts apps/api/src/jobs/recoveryMediaWorker.ts apps/api/src/jobs/recoveryBootMediaWorker.ts apps/api/src/jobs/queueSchemas.ts
git commit -m "fix(workers): reauthorize recovery media builds"
```

### Task 9: Reauthorize delayed disaster-recovery reconciliation

**Files:**
- Modify: `apps/api/src/services/drExecutionService.ts`
- Modify: `apps/api/src/jobs/drExecutionWorker.ts`
- Modify: `apps/api/src/routes/dr.ts`
- Modify: `apps/api/src/services/aiToolsDR.ts`
- Modify: `apps/api/src/routes/agents/commands.ts`
- Modify: `apps/api/src/routes/agentWs.ts`
- Modify: `apps/api/src/routes/backup/drResultHandler.ts`
- Modify: `apps/api/src/jobs/staleCommandReaper.ts`
- Test: adjacent DR, AI, agent-result, and stale-reaper tests

**Interfaces:**
- Replace mutable `results.authorizedDeviceIds` as dispatch authority with the durable Task 7 subject.
- Preserve the subject through HTTP result, WebSocket result, stale-command recovery, and delayed self-reconcile entry points.
- Reauthorize immediately before every command insertion and before scheduling each next cycle; denial creates neither commands nor follow-on jobs.
- Resolve provider-facing snapshot IDs to exactly one organization-scoped internal snapshot row before Task 5 authorization; ambiguous external IDs fail closed.
- Reuse the stable BullMQ job by moving the active job to delayed after the database commit and throwing `DelayedError`; do not suppress the successor by treating the active job as an already-scheduled reusable job.

- [x] **Step 1: Write RED for all four re-entry paths**

Cover site/base permission revoked between groups, source moved after first dispatch, ambiguous provider snapshot IDs, delayed self-reconcile, HTTP and WebSocket result re-entry, `drResultHandler`, stale reaper, and legacy unknown work. Assert no command insertion, running transition, or next queue after denial. Prove the active stable job moves to delayed after commit and wakes correctly on result events without replacing its subject.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/drExecutionWorker.test.ts src/services/drExecutionService.test.ts src/routes/backup/drResultHandler.test.ts src/routes/dr.test.ts src/services/aiToolsDR.siteScope.test.ts src/jobs/staleCommandReaper.test.ts
```

- [x] **Step 3: Persist and enforce the initiating subject**

Capture for route and AI producers, rehydrate on every re-entry, and authorize live lineage at the command boundary. Keep snapshot fields only as audit context, never authority.

- [x] **Step 4: Run GREEN and commit**

Run the RED command, then:

```bash
git add apps/api/src/services/drExecutionService.ts apps/api/src/jobs/drExecutionWorker.ts apps/api/src/routes/dr.ts apps/api/src/routes/backup/drResultHandler.ts apps/api/src/services/aiToolsDR.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agentWs.ts apps/api/src/jobs/staleCommandReaper.ts
git commit -m "fix(workers): reauthorize DR reconciliation"
```

### Task 10: Classify C2C restore and scheduled verification authority

**Files:**
- Modify: `apps/api/src/jobs/c2cEnqueue.ts`
- Modify: `apps/api/src/jobs/c2cBackupWorker.ts`
- Modify: `apps/api/src/services/c2cJobCreation.ts`
- Modify: `apps/api/src/routes/c2c/items.ts`
- Modify: `apps/api/src/routes/c2c/jobs.ts`
- Modify: `apps/api/src/services/aiToolsC2C.ts`
- Modify: `apps/api/src/jobs/backupVerificationJobs.ts`
- Modify: `apps/api/src/routes/backup/verificationService.ts`
- Modify: `apps/api/src/routes/backup/verificationScheduled.ts`
- Create: a focused C2C queued-owner authorization service/test if needed
- Test: adjacent C2C and scheduled-verification tests

**Interfaces:**
- All five C2C producers explicitly distinguish sync from restore and capture the correct live Task 7 subject. Only scheduled sync may use `c2c-sync-scheduler`; ordinary request and AI sync/restore retain their real subjects. Unknown legacy work quarantines.
- Both C2C operations are currently provider stubs. An authorized restore transitions directly `pending -> failed` with `c2c_restore_not_implemented`; it never claims `running`. Mismatched queue/stored kinds and unreauthorized work stop before metadata/secrets/provider access.
- Scheduled backup verification uses a private fixed `backup-verification-scheduler` wrapper and revalidates current snapshot/device lineage before command insertion. It resolves the internal snapshot row by `backup_jobs.id`; the provider-facing `backup_jobs.snapshot_id` string is never treated as the internal snapshot UUID.
- System classification is narrow and cannot be supplied by an ordinary request principal.

- [x] **Step 1: Write failing C2C/system-boundary tests**

Cover every request/AI/scheduler C2C producer; user/API key/OAuth/AI revocation before claim; config/source connection/storage config/item/target connection owner changes; queue/stored kind mismatch; duplicate item IDs; sync versus restore; legacy unknown kind/subject; forged system reasons; and scheduled verification whose current job/snapshot/device lineage no longer matches. Assert zero running claims, provider/secret/storage calls, and commands on denial. Prove passive active-sync deduplication never rebinds authority and authorized stub restore never enters `running`.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/c2cEnqueue.test.ts src/jobs/c2cBackupWorker.test.ts src/services/c2cJobCreation.test.ts src/routes/c2c/items.test.ts src/routes/c2c/jobs.test.ts src/services/aiToolsC2C.test.ts src/routes/backup/verificationScheduled.test.ts src/routes/backup/verificationService.test.ts src/services/recoveryAuthorizationSubject.test.ts src/services/resilienceSiteAuthorization.test.ts
```

- [x] **Step 3: Add explicit operation/system contracts**

Wire all five C2C producers to Task 7. Before a C2C claim, re-resolve the durable job, operation kind, config, source connection, optional storage config, unique items, and optional target connection by current organization ownership. Preserve direct pending-to-failed hard-disable behavior for the unimplemented restore provider path. Gate scheduled verification with a private allowlisted system wrapper plus live internal snapshot/device lineage; caller-controlled `source` strings cannot select system authority.

- [x] **Step 4: Run GREEN and commit**

Run the RED command, then:

```bash
git add apps/api/src/jobs/c2cEnqueue.ts apps/api/src/jobs/c2cBackupWorker.ts apps/api/src/services/c2cJobCreation.ts apps/api/src/routes/c2c/items.ts apps/api/src/routes/c2c/jobs.ts apps/api/src/services/aiToolsC2C.ts apps/api/src/jobs/backupVerificationJobs.ts apps/api/src/routes/backup
git commit -m "fix(workers): classify queued recovery authority"
```

### Task 11: Prove queued recovery authorization end to end

**Files:**
- Create: `apps/api/src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts`
- Modify: adjacent integration fixtures only as required

**Interfaces:**
- Execute exported direct media, boot-media, DR, C2C, and scheduled-verification processors against the real unprivileged application database; dependency injection replaces only provider/builder/command/BullMQ effects, never the production DB module.
- The matrix contains eight tests: one authorized five-family wiring smoke plus seven post-capture live-mutation denials covering user session, human API key, service-principal API key, OAuth grant, AI run, system, and unknown provenance.
- Every denial proves both zero mocked boundary calls and unchanged literal durable effect counts/state. Clear permission caches after raw grant/membership mutation.

- [x] **Step 1: Write the real-PostgreSQL RED matrix before Tasks 8–10 GREEN**

Use two partners, two organizations, and two sites. Capture each known subject while live, persist durable work, then mutate its actual grant/site/source before invoking the real processor. Cover: user source-site move on media; revoked human key on boot media; disabled service principal and disabled/tool-revoked AI on DR; revoked OAuth grant on C2C restore; system snapshot/device mismatch on scheduled verification; and legacy unknown media work. Assert durable denial/quarantine plus zero provider/builder/command/BullMQ follow-on effects. The positive wiring smoke proves each mocked boundary is genuinely reachable, including DR `DelayedError`, C2C direct stub failure, and scheduled verification persistence.

- [x] **Step 2: Run the complete worker authorization matrix**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts src/__tests__/integration/resilienceSiteAuthorization.integration.test.ts src/__tests__/integration/lateCommandResultRecovery.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: the new matrix reports exactly eight passing, non-skipped tests; every named integration file reports executed and passes. RLS coverage runs separately because the general integration config excludes that file.

- [x] **Step 3: Run all Track A targeted regressions and commit proof**

```bash
pnpm --filter @breeze/api exec vitest run src/services/automationReferenceAuthorization.test.ts src/services/resilienceSiteAuthorization.test.ts src/services/recoveryAuthorizationSubject.test.ts src/routes/automations.test.ts src/routes/backup/restore.test.ts src/routes/backup/vmrestore.test.ts src/routes/backup/hyperv.test.ts src/routes/backup/mssql.test.ts src/routes/backup/bmr.test.ts src/jobs/recoveryMediaWorker.test.ts src/jobs/recoveryBootMediaWorker.test.ts src/jobs/drExecutionWorker.test.ts src/jobs/c2cBackupWorker.test.ts src/routes/backup/verificationScheduled.test.ts
pnpm db:check-drift
git add apps/api/src/__tests__/integration/resilienceWorkerAuthorization.integration.test.ts
git commit -m "test(api): prove queued recovery authorization"
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
