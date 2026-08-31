---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
---

# S0 Track E PAM Actuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close RMM-QA-445 by making PAM apply and cleanup durable, generation-ordered, capability-gated, endpoint-verifiable, and truthful across server, agent, restart, reboot, and result-transport boundaries.

**Closure decisions:** [`2026-08-29-s0-track-e-pam-closure-decisions.md`](../specs/2026-08-29-s0-track-e-pam-closure-decisions.md) adopts the 2-second p95 / 5-second maximum production cleanup SLO with a hosted-canary re-measure condition and records the Product-owned v0.109 shipping-entitlement non-applicability disposition with an explicit reopen trigger.

**Architecture:** One mutable `pam_actuations` row holds desired generation/state and the latest accepted observation, while append-only `pam_actuation_results` rows preserve endpoint evidence. Approval or cleanup transition, actuation mutation, and publication intent commit atomically through the existing physical `intent_outbox`; a dedicated worker dispatches capability-gated v2 commands, and one result service handles REST and WebSocket reports. On Windows, v2 is token-launch-only: the manager launches suspended, assigns the process to a deterministic named Job Object configured with kill-on-close, persists the revocable identity, and resumes only after successful attachment.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL RLS, BullMQ/Redis, Vitest, Go, Windows Win32 token/process/Job Object APIs.

## Global Constraints

- This track closes only RMM-QA-445; adjacent PAM convergence, readiness, audit, and idempotency findings may consume the foundation but do not broaden this plan.
- Execute Track E only after Track D is complete because both tracks change `devices`, heartbeat capability payloads, command/result registries, agent handlers, migrations, and tenant registries.
- Every behavior change is strict RED/GREEN: add the exact failing assertion, run it and preserve the failure, implement only that task, rerun the named tests, then commit the task checkpoint.
- Keep exactly one physical transactional outbox table named `intent_outbox`. Make `intent_id` nullable, add nullable `pam_actuation_id`, enforce exactly one parent, and do not create `pam_outbox` or any second physical outbox shape.
- Keep exactly one mutable desired-state row per request revision in `pam_actuations`; keep every accepted endpoint observation as an append-only `pam_actuation_results` row.
- Generation 1 is the initial apply or cleanup-only denial generation. Cleanup increments the current generation and is an irreversible tombstone: no later write may reduce the generation or restore desired state to `active`.
- Protocol v2 apply is token-launch-only. The existing SendInput/`consent.exe` path and the v1 `actuate_elevation` route are never v2-capable and never satisfy RMM-QA-445 closure.
- The exact v2 Windows revocation primitive is a named Job Object `Global\Breeze.PAM.<lowercase-actuation-uuid>.g<generation>` created without an inheritable handle and configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Neither breakaway limit flag is enabled and the target is not created with `CREATE_BREAKAWAY_FROM_JOB`. The target is created suspended, assigned to that job, durably recorded, and only then resumed.
- Cleanup first durably writes the higher-generation tombstone, then terminates/closes the Job Object, proves zero members, demotes/rotates/disables and verifies the local elevation account, and proves the recorded PID plus process-creation identity no longer holds a privileged token. Unverifiable state is `failed`, never `cleaned`.
- Heartbeat advertises and persists `pamLifetimeProtocolVersion`. Missing, zero, non-Windows, unavailable Job Object primitives, or unavailable account-verification primitives fail closed for new apply admission.
- Cleanup is dispatched only to v2-capable agents. Existing v1 `active`/`actuating` rows are exposed as `legacy_untracked` with disposition `blocked_manual_remediation`; they are never backfilled as cleaned and their endpoints remain blocked from new PAM admission.
- REST and WebSocket result paths must call the same registered handler and persistence service. Transport-specific code may authenticate and parse an envelope but may not implement PAM state transitions.
- Request compatibility status (`revoked`/`expired`) is distinct from endpoint enforcement status. Only an accepted current-generation `cleaned` observation writes `session_ended_at`, terminal cleanup audit, `cleaned_at`, or enforcement status `cleaned`.
- Instrument cleanup latency from the agent's durable `cleanup_received`/`received` observation. The 2-second p95 and 5-second maximum is adopted as the production cleanup SLO by the 2026-08-29 closure decision after the exact candidate passed it. The lab result is not a fleet measurement: the hosted 5/25-device canary must re-measure and pass it before any rollout expansion.
- Entitlement removal is not presumed to have a caller. Task 3 must discover the shipping entitlement-removal owner and wire and test it if present. Product's v0.109 decision records PAM as available on all plan tiers and not separately entitled; this disposition reopens immediately if PAM becomes plan- or billing-gated, and that producer must call `removePamEntitlement` in its winning transaction.
- All new tenant tables use direct `org_id` tenancy, enable and force RLS in the creation migration, and are registered in organization/device cascade and tenant-export policy. JSON/JSONB evidence is `excludedOpen`; append-only results use audit-admin erasure handling.
- Migrations are additive, idempotent, ordered after shipped migrations, never edit shipped files, and report every quarantine/backfill row count. Agent-write result transactions remain short and never update a `devices` parent row in the same transaction as a child insert.
- Queue publication, Redis calls, command delivery, provider work, and audit/event fan-out happen outside request/system database transaction contexts except for the durable SQL rows that define the transaction boundary.
- New protocol rollout is additive and disabled by default: schema/tolerant readers first, inert capability telemetry next, internal Windows lab only, then 5/25-device canaries only after explicit deployment authorization. This branch does not deploy or mutate production.
- Code-complete remains `fixed-unverified` until real-Postgres and disposable signed-Windows evidence passes against the exact candidate and shipping artifacts.

## File Responsibility Map

- `apps/api/src/db/schema/elevations.ts`: request revision, mutable actuation state, and append-only result evidence.
- `apps/api/src/db/schema/actionIntents.ts`: the single generalized physical outbox with an XOR parent.
- `apps/api/src/db/schema/devices.ts`: persisted PAM lifetime capability only; it does not become an enforcement-state projection.
- `apps/api/src/services/pamActuationLifecycle.ts`: the only transaction-scoped creator/mutator of PAM desired state and PAM outbox rows.
- `apps/api/src/jobs/pamActuationWorker.ts`: idempotent current-generation command admission and dispatch preparation.
- `apps/api/src/services/pamActuationResult.ts`: one idempotent result validator/reconciler used by REST and WebSocket transports.
- `apps/api/src/services/pamEntitlementCleanup.ts`: explicit entitlement-removal integration boundary and discovery/closure gate.
- `agent/internal/pamlifetime/`: generation ledger, manager contract, Windows Job Object ownership, cleanup, and reconciliation.
- `agent/internal/heartbeat/handlers_actuate.go`: command-envelope adaptation only; lifetime policy stays in `pamlifetime.Manager`.

---

### Task 1: Persist actuation truth, generalize the physical outbox, and quarantine legacy state

**Files:**
- Modify: `apps/api/src/db/schema/elevations.ts`
- Modify: `apps/api/src/db/schema/actionIntents.ts`
- Modify: `apps/api/src/db/schema/devices.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-09-16-pam-actuation-lifecycle.sql`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/pamActuationLifecycle.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
- Test: `apps/api/src/db/autoMigrate.test.ts`

**Interfaces:**
- Produces `PamDesiredState = 'active' | 'cleanup'`, `PamObservedState = 'pending_dispatch' | 'dispatched' | 'received' | 'verified_active' | 'cleanup_pending' | 'cleaned' | 'failed' | 'legacy_untracked'`, and `PamResultKind = 'received' | 'verified_active' | 'cleaned' | 'failed'`.
- Produces `pamActuations`, unique by `(elevationRequestId, requestRevision)`, with monotonic `generation >= 1`, desired state, latest observation, command identity, target identity, expiry, cleanup/cleaned timestamps, failure code, and open JSON evidence.
- Produces append-only `pamActuationResults`, idempotent by `(actuationId, generation, resultKind, observationId)`.
- Generalizes `intentOutbox` to nullable `intentId` plus nullable `pamActuationId` with SQL CHECK `((intent_id IS NULL) <> (pam_actuation_id IS NULL))`.
- Adds `devices.pamLifetimeProtocolVersion`, persisted as integer default `0`, and `elevation_requests.revision`, persisted as integer default `1` and incremented only by a new request revision transition.

- [x] **Step 1: Write the real-Postgres RED contract**

Create two partners and two organizations with one device each. The test must assert literal PostgreSQL outcomes and row counts:

```ts
expect(await forgeActuationAsOrgB(orgAActuation)).toMatchObject({ code: '42501' });
expect(await insertActuationWithForeignRequest()).toMatchObject({ code: '23503' });
expect(await insertOutbox({ intentId: null, pamActuationId: null })).toMatchObject({ code: '23514' });
expect(await insertOutbox({ intentId, pamActuationId })).toMatchObject({ code: '23514' });
expect(await insertActuation({ generation: 0 })).toMatchObject({ code: '23514' });
expect(await updatePamResultEvidence()).toMatchObject({ code: '42501' });
expect(await deletePamResultAsApp()).toMatchObject({ code: '42501' });
```

Also prove organization erasure, device erasure, FK ordering, and export classification. Seed legacy `active` and `actuating` requests and assert migration output creates `legacy_untracked` actuation rows with `desired_state='cleanup'`, `cleaned_at IS NULL`, no fabricated result, and no endpoint terminal audit.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts
```

Expected: FAIL because the tables, capability column, outbox PAM parent, and quarantine state do not exist.

- [x] **Step 3: Add schema and the idempotent migration**

Implement the schema with these minimum columns and constraints:

```ts
export const pamActuations = pgTable('pam_actuations', {
  id, orgId, deviceId, elevationRequestId, requestRevision,
  generation, desiredState, observedState, currentCommandId,
  targetExecutablePath, targetExecutableHash, subjectUsername,
  expiresAt, cleanupRequestedAt, cleanedAt, failureCode,
  latestEvidence, createdAt, updatedAt,
});

export const pamActuationResults = pgTable('pam_actuation_results', {
  id, observationId, orgId, deviceId, actuationId, generation,
  resultKind, failureCode, evidence, observedAt, receivedAt,
});
```

Use composite tenant FKs `(elevation_request_id, org_id) -> elevation_requests(id, org_id)` and `(actuation_id, org_id) -> pam_actuations(id, org_id)`. Add due-dispatch and active/cleanup reconciliation indexes. Enable and force direct-org RLS on both tables. Revoke UPDATE/DELETE on results, add its immutability trigger, and retain audit-admin erasure capability.

Generalize the existing `intent_outbox` in place; retain its name, publisher cursor, retry columns, and intent behavior. Add an idempotent bounded legacy backfill/quarantine loop and use `GET DIAGNOSTICS` plus `RAISE WARNING` for all affected-row counts. Do not infer cleanup from old request status.

- [x] **Step 4: Register every tenancy and migration contract**

Add both tables alphabetically to `CORE_ORG_CASCADE_DELETE_ORDER`; add both to device cascade lists because both carry `device_id`; add their denormalized-org registration; add `pam_actuation_results` to `AUDIT_ADMIN_REQUIRED_TABLES`. Register all columns in `CORE_TENANT_EXPORT_POLICY`, classifying `latest_evidence` and `evidence` as `excludedOpen`. Register both direct-org tables in RLS coverage and export them from the schema index.

- [x] **Step 5: Run GREEN and database contracts**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm --filter @breeze/api db:check-drift
bash scripts/check-migration-naming.sh
```

Expected: every named file executes and passes; drift and migration naming are clean.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/elevations.ts apps/api/src/db/schema/actionIntents.ts apps/api/src/db/schema/devices.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-09-16-pam-actuation-lifecycle.sql apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/pamActuationLifecycle.integration.test.ts
git commit -m "fix(db): persist PAM actuation lifecycle"
```

### Task 2: Build the lifecycle service, generalized outbox publisher, and durable dispatch worker

**Files:**
- Create: `apps/api/src/services/pamActuationLifecycle.ts`
- Create: `apps/api/src/services/pamActuationLifecycle.test.ts`
- Create: `apps/api/src/jobs/pamActuationWorker.ts`
- Create: `apps/api/src/jobs/pamActuationWorker.test.ts`
- Modify: `apps/api/src/jobs/intentOutboxPublisher.ts`
- Modify: `apps/api/src/jobs/intentOutboxPublisher.test.ts`
- Modify: `apps/api/src/index.ts`
- Test: worker readiness registration tests adjacent to `apps/api/src/index.ts`

**Interfaces:**
- Produces `createPamDecisionIntent(tx, input): Promise<PamActuationRef>` and `requestPamCleanup(tx, input): Promise<PamActuationRef>`.
- Produces `processPamActuationEvent({ actuationId, generation }): Promise<'dispatched' | 'duplicate' | 'stale' | 'unsupported' | 'blocked'>`.
- Publishes PAM outbox rows to a dedicated BullMQ `pam-actuation` queue while keeping intent rows on the existing intent queue.

```ts
type PamRequestSnapshot = {
  id: string; orgId: string; deviceId: string;
  targetExecutablePath: string; targetExecutableHash: string | null;
  subjectUsername: string;
};
type PamActuationRef = {
  actuationId: string; elevationRequestId: string;
  requestRevision: number; generation: number;
  desiredState: 'active' | 'cleanup';
};
```

- [x] **Step 1: Write lifecycle and worker RED tests**

Use the exact service contract:

```ts
type PamLifecycleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createPamDecisionIntent(tx: PamLifecycleTx, input: {
  request: PamRequestSnapshot;
  requestRevision: number;
  decision: 'approved' | 'auto_approved' | 'denied';
  expiresAt: Date | null;
}): Promise<PamActuationRef>;

export async function requestPamCleanup(tx: PamLifecycleTx, input: {
  elevationRequestId: string;
  cause: 'denied' | 'revoked' | 'expired' | 'policy_removed'
    | 'approval_failed' | 'entitlement_removed';
}): Promise<PamActuationRef>;
```

Assert approval creates exactly one generation-1 `active` actuation/outbox row, denial creates exactly one generation-1 cleanup-only row, concurrent cleanup requests increment once, duplicate outbox delivery inserts one `device_commands` row, lower generation never dispatches, cleanup never regresses to apply, and missing/zero capability inserts no command. Assert queue methods run only after the SQL transaction/context has ended.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamActuationLifecycle.test.ts src/jobs/pamActuationWorker.test.ts src/jobs/intentOutboxPublisher.test.ts
```

Expected: FAIL because the lifecycle service, PAM queue route, and worker do not exist.

- [x] **Step 3: Implement atomic desired-state changes**

Inside the caller's transaction, lock the request/actuation row, compare request revision and desired generation, mutate the actuation, and insert the PAM-parent outbox row. Use a uniqueness key derived from `actuationId:generation`; retries return the existing `PamActuationRef`. The cleanup branch must behave as:

```ts
if (actuation.desiredState === 'cleanup') return currentRef;
const nextGeneration = actuation.generation + 1;
await tx.update(pamActuations).set({
  generation: nextGeneration,
  desiredState: 'cleanup',
  observedState: 'cleanup_pending',
  cleanupRequestedAt: now,
});
await insertPamOutbox(tx, actuation.id, nextGeneration);
```

Never publish to Redis from this service.
An approved/auto-approved apply requires non-null `expiresAt`; reject a missing or elapsed expiry before creating active desired state. Denial may create cleanup-only generation 1 with null expiry.

- [x] **Step 4: Implement physical-outbox routing and capability-gated dispatch**

Extend `intentOutboxPublisher.ts` to discriminate the XOR parent and enqueue either the existing intent event or `{ actuationId, generation }` on `pam-actuation`. In the PAM worker, use a short system-context transaction, lock the actuation, require exact current generation, verify request/device/org identity, and require `pamLifetimeProtocolVersion >= 2` before apply or cleanup dispatch. Insert at most one `pam_apply_v2` or `pam_cleanup_v2` command and bind `currentCommandId`; mark capability failures as blocked/failed without fabricating endpoint evidence. Initialize queue/worker/readiness lifecycle in `index.ts` with shutdown symmetry.

- [x] **Step 5: Run GREEN and typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamActuationLifecycle.test.ts src/jobs/pamActuationWorker.test.ts src/jobs/intentOutboxPublisher.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: all focused tests pass, including duplicate delivery and queue-outside-context assertions.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/pamActuationLifecycle.ts apps/api/src/services/pamActuationLifecycle.test.ts apps/api/src/jobs/pamActuationWorker.ts apps/api/src/jobs/pamActuationWorker.test.ts apps/api/src/jobs/intentOutboxPublisher.ts apps/api/src/jobs/intentOutboxPublisher.test.ts apps/api/src/index.ts
git commit -m "fix(api): dispatch durable PAM generations"
```

### Task 3: Make every request transition atomic and gate entitlement removal on a real owner

**Files:**
- Modify: `apps/api/src/routes/pam.ts`
- Modify: `apps/api/src/routes/pam.test.ts`
- Modify: `apps/api/src/routes/approvals.ts`
- Modify: `apps/api/src/routes/approvals.test.ts`
- Modify: `apps/api/src/routes/agents/elevationRequests.ts`
- Modify: `apps/api/src/routes/agents/elevationRequests.test.ts`
- Modify: `apps/api/src/jobs/pamJobs.ts`
- Modify: `apps/api/src/jobs/pamJobs.test.ts`
- Create: `apps/api/src/services/pamEntitlementCleanup.ts`
- Create: `apps/api/src/services/pamEntitlementCleanup.test.ts`
- Create: `apps/api/src/__tests__/integration/pamActuationTransitions.integration.test.ts`
- Modify/Test: exact policy delete/disable and entitlement-removal callers discovered in Step 1

**Interfaces:**
- Consumes Task 2 lifecycle functions inside the winning database transaction.
- Produces `removePamEntitlement(tx, { orgId, deviceId, subjectId, source }): Promise<readonly PamActuationRef[]>`, where `source` is `{ kind: 'license' | 'subscription' | 'policy'; id: string }`; it is the only allowed shipping boundary for entitlement-triggered cleanup.
- Route responses keep compatibility `status` and add nonterminal enforcement state; they do not claim endpoint cleanup.

- [x] **Step 1: Discover and record every transition producer before editing**

Use the codebase graph to trace all writes of `elevation_requests.status`, all callers that remove/disable PAM policies, and every shipping entitlement/license removal path. Save the exact path/function inventory in the task report. The implementation gate is:

```ts
type EntitlementOwnerDisposition =
  | { kind: 'shipping_caller'; qualifiedName: string; shippingSku: string }
  | { kind: 'not_applicable'; shippingSku: string; productDecisionRef: string };
```

Do not invent a caller. If a shipping producer exists, it must call `removePamEntitlement` in its winning transaction and have an integration test. If none exists, the service and tests still ship, but Track E closure remains blocked until Product supplies the named `not_applicable` disposition; absence from search is not a disposition.

- [x] **Step 2: Write transition RED tests**

Cover web approve, mobile approve, auto-approve, deny, revoke, expiry, policy removal, approval failure, and the discovered entitlement disposition. For each transition assert request mutation, actuation mutation, and outbox insertion all commit or all roll back. Inject audit/outbox failure and assert zero privileged transition. Assert cross-org/site rejection leaves request, actuation, outbox, and commands unchanged. Revoke/expiry must return or project `enforcementStatus: 'cleanup_pending'`, not terminal endpoint success.

- [x] **Step 3: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/pam.test.ts src/routes/approvals.test.ts src/routes/agents/elevationRequests.test.ts src/jobs/pamJobs.test.ts src/services/pamEntitlementCleanup.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationTransitions.integration.test.ts
```

Expected: at least approval/revoke/expiry transitions commit without atomic actuation/outbox state and the new entitlement boundary is absent.

- [x] **Step 4: Integrate every server transition**

Call `createPamDecisionIntent` or `requestPamCleanup` inside the same transaction as the winning request decision. Remove the best-effort PAM mobile mirror. Change expiry from status-only CTE behavior to a bounded lock/return loop that creates cleanup intent before commit. Preserve legacy request statuses for compatibility, but return accepted/pending cleanup unless endpoint evidence is already cleaned. Wire policy deletion/disable to cause `policy_removed`. Wire the discovered shipping entitlement caller to `removePamEntitlement` with cause `entitlement_removed`; if no caller exists, expose and test the service without claiming transition coverage.

- [x] **Step 5: Run GREEN and enforce the entitlement gate**

Run the RED commands again. Then inspect the task report/coverage assertion: it must name the wired shipping caller and test, or name the Product-owned non-applicability decision. Otherwise mark this task code-complete but closure-blocked; do not silently check off entitlement-removal coverage.

Closure decision (2026-08-29): Product records
`{ kind: 'not_applicable', shippingSku: 'breeze-rmm v0.109 — PAM available on all plan tiers; not a separately entitled SKU', productDecisionRef: 'docs/superpowers/specs/2026-08-29-s0-track-e-pam-closure-decisions.md#decision-2-shipping-entitlement-disposition' }`.
The disposition reopens immediately if PAM becomes plan- or billing-gated; the
new producer must call `removePamEntitlement` inside its winning transaction and
pass the real-PostgreSQL transition contract before shipping.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/routes/pam.ts apps/api/src/routes/pam.test.ts apps/api/src/routes/approvals.ts apps/api/src/routes/approvals.test.ts apps/api/src/routes/agents/elevationRequests.ts apps/api/src/routes/agents/elevationRequests.test.ts apps/api/src/jobs/pamJobs.ts apps/api/src/jobs/pamJobs.test.ts apps/api/src/services/pamEntitlementCleanup.ts apps/api/src/services/pamEntitlementCleanup.test.ts apps/api/src/__tests__/integration/pamActuationTransitions.integration.test.ts
git commit -m "fix(api): bind PAM transitions to cleanup intent"
```

### Task 4: Unify REST and WebSocket results and expose truthful enforcement status

**Files:**
- Create: `apps/api/src/services/pamActuationResult.ts`
- Create: `apps/api/src/services/pamActuationResult.test.ts`
- Modify: `apps/api/src/services/commandResultHandlers.ts`
- Modify: `apps/api/src/services/commandResultHandlers.test.ts`
- Modify: `apps/api/src/routes/agents/commands.ts`
- Modify: `apps/api/src/routes/agents/commands.test.ts`
- Modify: `apps/api/src/routes/agentWs.ts`
- Modify: `apps/api/src/routes/agentWs.test.ts`
- Modify: `apps/api/src/routes/pam.ts`
- Modify: `apps/api/src/routes/pam.test.ts`
- Modify: `apps/api/src/routes/devices/actuateElevation.ts`
- Modify: `apps/api/src/routes/devices/actuateElevation.test.ts`
- Create: `apps/api/src/__tests__/integration/pamActuationResults.integration.test.ts`

**Interfaces:**
- Produces `recordPamActuationResult(input): Promise<'applied' | 'duplicate' | 'stale' | 'rejected'>` with exact input `{ agentId: string; deviceId: string; commandId: string; result: PamAgentResultV2 }`.
- Consumes the exact v2 result contract in both transports:

```ts
type PamAgentResultV2 = {
  protocolVersion: 2;
  observationId: string;
  actuationId: string;
  generation: number;
  state: 'received' | 'verified_active' | 'cleaned' | 'failed';
  observedAt: string;
  failureCode?: string;
  evidence: {
    bootId: string;
    windowsSessionId?: number;
    pid?: number;
    processCreationTime?: string;
    jobName?: string;
    jobMemberCount?: number;
    accountEnabled?: boolean;
    accountInAdministrators?: boolean;
    privilegedTokenPresent?: boolean;
    targetHash?: string;
  };
};
```

- Produces PAM response fields `enforcementStatus`, `enforcementGeneration`, `enforcementReason`, `endpointObservedAt`, `cleanupReceivedAt`, and `manualRemediationDisposition`.

- [x] **Step 1: Write result-ordering and transport-parity RED tests**

Test REST/WS twins for accepted current-device/current-generation results and assert the same DB rows and return classification. Test duplicate observation, foreign org/device, wrong command, stale/lower generation, reordered states, malformed evidence, and verified-active arriving after a cleanup tombstone. Assert only `verified_active` sets `session_started_at`; only a valid `cleaned` result with zero job members, disabled/non-admin account, and no privileged token sets `session_ended_at`, `cleaned_at`, and terminal cleanup audit. A cleanup failure stays failed/pending, and v1 success cannot update v2 state.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamActuationResult.test.ts src/services/commandResultHandlers.test.ts src/routes/agents/commands.test.ts src/routes/agentWs.test.ts src/routes/pam.test.ts src/routes/devices/actuateElevation.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationResults.integration.test.ts
```

Expected: FAIL because PAM is absent from the shared result registry and endpoint state is not persisted.

- [x] **Step 3: Implement one result transaction**

Authenticate command/device/organization identity, validate protocol and evidence, lock current actuation, compare exact generation and command ownership, insert the immutable result idempotently, and advance only legal observed-state transitions. Treat an already-present unique observation as `duplicate`. Treat older generations as `stale` without state mutation. Never accept `verified_active` after desired cleanup. Derive server receipt time separately from agent `observedAt`.

- [x] **Step 4: Register both transports and truthful API projection**

Register `pam_apply_v2` and `pam_cleanup_v2` in `commandResultHandlers.ts`. Keep REST and WS transport code limited to envelope authentication and invoking that handler. Update PAM reads/revoke responses to expose compatibility status separately from enforcement. Map `legacy_untracked` to `manualRemediationDisposition: 'blocked_manual_remediation'` and reject new admission on that endpoint. Keep the env-gated v1 route as legacy only and remove any ability for it to claim v2 cleaned/active evidence.

- [x] **Step 5: Run GREEN**

Run the RED commands again. Expected: all transport twins and the real-Postgres ordering matrix execute and pass.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/pamActuationResult.ts apps/api/src/services/pamActuationResult.test.ts apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.test.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/commands.test.ts apps/api/src/routes/agentWs.ts apps/api/src/routes/agentWs.test.ts apps/api/src/routes/pam.ts apps/api/src/routes/pam.test.ts apps/api/src/routes/devices/actuateElevation.ts apps/api/src/routes/devices/actuateElevation.test.ts apps/api/src/__tests__/integration/pamActuationResults.integration.test.ts
git commit -m "fix(api): reconcile PAM endpoint evidence"
```

### Task 5: Add the v2 agent protocol, durable generation tombstones, and fail-closed capability telemetry

**Files:**
- Create: `agent/internal/pamlifetime/types.go`
- Create: `agent/internal/pamlifetime/store.go`
- Create: `agent/internal/pamlifetime/store_test.go`
- Create: `agent/internal/pamlifetime/manager_stub.go`
- Create: `agent/internal/pamlifetime/manager_stub_test.go`
- Modify: `agent/internal/remote/tools/types.go`
- Modify: `agent/internal/heartbeat/handlers.go`
- Modify: `agent/internal/heartbeat/handlers_actuate.go`
- Modify: `agent/internal/heartbeat/handlers_actuate_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`
- Modify: `apps/api/src/routes/agents/schemas.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`

**Interfaces:**
- Produces cross-platform `pamlifetime.Manager`:

```go
type Manager interface {
    Apply(context.Context, ApplyCommand) Result
    Cleanup(context.Context, CleanupCommand) Result
    Reconcile(context.Context) []Result
    SetEnabled(context.Context, bool) error
}
```

- Produces exact wire commands:

```ts
type PamApplyV2 = {
  protocolVersion: 2; actuationId: string; generation: number;
  requestId: string; deviceId: string; orgId: string;
  targetPath: string; targetHash: string | null; subjectUsername: string;
  expiresAt: string; serverTime: string; maxRemainingLifetimeMs: number;
};
type PamCleanupV2 = {
  protocolVersion: 2; actuationId: string; generation: number;
  requestId: string; deviceId: string; orgId: string;
};
```

- The local ledger contains only actuation/request/device/org identity, generation, desired state, PID, process creation time, Job Object name, boot ID, and timestamps; it never stores credentials, password material, tokens, or command secrets.

- [x] **Step 1: Write protocol/store/capability RED tests**

Add table-driven cases for malformed identity, wrong device/org, expired/max-lifetime input, lower/equal generation, duplicate apply/cleanup, cleanup tombstone, and crash points between durable write, OS action, and result emission. Add concurrent duplicate/reordered race tests. Assert old-agent heartbeat omission persists protocol `0`; non-Windows and missing primitives do not advertise version 2.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -race ./internal/pamlifetime ./internal/heartbeat/...
pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts
```

Expected: FAIL because `pamlifetime`, v2 commands, and heartbeat capability do not exist. If the API heartbeat test has a different adjacent filename after Track D, run the exact discovered file and record it in the task report.

- [x] **Step 3: Implement durable protocol parsing and tombstone rules**

Write ledger updates to a same-directory temporary file, flush, atomically replace, and enforce owner-only access. Persist desired state before invoking OS operations. Reject any apply whose generation is at or below the highest cleanup generation. Equal apply is idempotent only if identity and bound command content match; equal generation with a different digest is failure. Return structured v2 results with stable failure codes and a random UUID observation ID.

- [x] **Step 4: Wire handlers and heartbeat fail-closed capability**

Register `pam_apply_v2` and `pam_cleanup_v2` handlers that delegate to the manager and return the shared structured result body. Add `pamLifetimeProtocolVersion` to heartbeat JSON and the server validator/persistence path established by Track D. Advertise `2` only on Windows when token launch, named Job Object management, durable ledger, and account verification are all available; otherwise omit or send `0`. Server admission continues to require persisted value `>= 2`.

- [x] **Step 5: Run GREEN and race tests**

```bash
cd agent && go test -race ./internal/pamlifetime ./internal/heartbeat/...
pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: all table/race tests pass and old-agent omission remains compatible.

- [x] **Step 6: Commit**

```bash
git add agent/internal/pamlifetime agent/internal/remote/tools/types.go agent/internal/heartbeat/handlers.go agent/internal/heartbeat/handlers_actuate.go agent/internal/heartbeat/handlers_actuate_test.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts apps/api/src/routes/agents/schemas.test.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(agent): add PAM lifetime protocol v2"
```

### Task 6: Implement token-launch-only Windows named Job Object apply and verified cleanup

**Files:**
- Create: `agent/internal/pamlifetime/manager_windows.go`
- Create: `agent/internal/pamlifetime/job_windows.go`
- Create: `agent/internal/pamlifetime/manager_windows_test.go`
- Create: `agent/internal/pamlifetime/job_contract_test.go`
- Modify: `agent/internal/pamactuator/tokenlaunch_windows.go`
- Modify: `agent/internal/pamactuator/tokenlaunch_test.go`
- Modify: `agent/internal/elevaccount/elevaccount_windows.go`
- Modify: `agent/internal/elevaccount/elevaccount_windows_test.go`
- Add: platform-neutral Win32 seam/fake files adjacent to the Windows implementation as needed

**Interfaces:**
- Consumes Task 5 `Manager`, `ApplyCommand`, `CleanupCommand`, ledger, and `Result`.
- Produces `JobName(actuationID string, generation uint64) string` returning the logical Windows object name exactly as `Global\Breeze.PAM.<lowercase-actuation-uuid>.g<generation>` (the Go source literal is `"Global\\Breeze.PAM.%s.g%d"`).
- Produces suspended token-launch ownership containing PID, process creation time, process handle, primary-thread handle, and target hash; the caller, not the old session helper, owns lifecycle closure.
- Extends the elevation-account boundary with `VerifyClean(context.Context) (AccountEvidence, error)` and `Deprovision(context.Context) (AccountEvidence, error)`.

- [x] **Step 1: Write the Windows contract RED tests against a fake Win32 seam**

Assert this exact order for apply:

```text
validate identity/generation/hash/lifetime
persist desired active generation
CreateProcessAsUser(CREATE_SUSPENDED)
CreateJobObjectW(logical name "Global\Breeze.PAM.<uuid>.g<N>")
SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
AssignProcessToJobObject
persist PID + process creation time + job name
ResumeThread
emit received, then verified_active only after verification
```

Assert the Job Object handle is non-inheritable and remains owned by the long-lived manager. Assert neither `JOB_OBJECT_LIMIT_BREAKAWAY_OK` nor `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` is set and the target launch omits `CREATE_BREAKAWAY_FROM_JOB`, so child processes join the job and cannot escape. Assert no v2 code calls SendInput or treats a closed `consent.exe` window as execution proof.

For cleanup, assert tombstone persistence precedes OS action; `TerminateJobObject`/kill-on-close covers the whole tree; zero members are observed; PID creation-time prevents reuse confusion; account password is rotated, Administrators membership removed, account disabled, and all are verified; privileged-token absence is verified before `cleaned`. Helper loss or any unverifiable step returns `failed`.

- [x] **Step 2: Run RED and Windows compile gate**

```bash
cd agent && go test ./internal/pamlifetime ./internal/pamactuator ./internal/elevaccount
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/pamlifetime -o /tmp/breeze-pamlifetime.test.exe
```

Expected: fake-seam contract tests fail and/or Windows cross-compile fails because Job Object ownership is absent.

- [x] **Step 3: Refactor token launch to transfer suspended-process ownership**

Split the current launch path so v1 compatibility may continue to wait/demote, while v2 receives a suspended-process handle bundle. Do not share v1's SendInput path with v2. Validate canonical target path and optional SHA-256 hash before resume. Close every handle exactly once on failure and preserve the manager-owned Job Object handle on success.

- [x] **Step 4: Implement exact Job Object and cleanup semantics**

Create the deterministic name, call `SetInformationJobObject` with `JOBOBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign before resume, and persist identity before resume. Cleanup must reopen/own the named job when possible, call `TerminateJobObject`, wait for `JobObjectBasicProcessIdList.NumberOfAssignedProcesses == 0`, close the owning handle, then perform and verify account cleanup and privileged-token absence. Any ambiguity remains failed/pending and retains the tombstone.

- [x] **Step 5: Run GREEN, race, and cross-compile gates**

```bash
cd agent && go test ./internal/pamlifetime ./internal/pamactuator ./internal/elevaccount ./internal/heartbeat
cd agent && go test -race ./internal/pamlifetime ./internal/heartbeat/...
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/pamlifetime -o /tmp/breeze-pamlifetime.test.exe
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/pamactuator -o /tmp/breeze-pamactuator.test.exe
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/elevaccount -o /tmp/breeze-elevaccount.test.exe
```

Expected: native seam/race tests pass and all Windows test binaries compile. Native Windows execution remains required in Task 8.

- [x] **Step 6: Commit**

```bash
git add agent/internal/pamlifetime agent/internal/pamactuator/tokenlaunch_windows.go agent/internal/pamactuator/tokenlaunch_test.go agent/internal/elevaccount/elevaccount_windows.go agent/internal/elevaccount/elevaccount_windows_test.go
git commit -m "fix(agent): revoke PAM process trees"
```

### Task 7: Reconcile restart/reboot and make PAM disable perform verified cleanup

**Files:**
- Modify: `agent/internal/agentapp/main.go`
- Modify: `agent/internal/agentapp/main_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/uac_interception_test.go`
- Modify: `agent/internal/pamlifetime/manager_windows.go`
- Modify: `agent/internal/pamlifetime/manager_windows_test.go`
- Modify: PAM configuration parsing files and tests discovered through `handleUACInterception`
- Modify: API heartbeat policy response only if Track D's versioned protocol envelope requires an explicit PAM-enable field

**Interfaces:**
- Consumes Task 6 manager and durable ledger.
- Agent startup calls `Manager.Reconcile` before PAM command admission.
- `handleUACInterception(false)` calls `Manager.SetEnabled(ctx, false)` and returns/report failure until cleanup and account deprovision are verified.

- [x] **Step 1: Write restart/reboot/disable RED tests**

Cover restart with desired active and a reopenable job, restart after crash-triggered kill-on-close, startup with a cleanup tombstone, reboot with vanished process, disable during active work, disable with helper loss, and concurrent command arrival during reconciliation. Assert command admission stays closed until reconciliation finishes. A rebooted/vanished process is evidence to investigate, not automatic `cleaned`. Disabling stops capture first, requests cleanup for every ledger entry, deprovisions/verifies the account, and only then reports disabled.

- [x] **Step 2: Run RED**

```bash
cd agent && go test -race ./internal/agentapp ./internal/pamlifetime ./internal/heartbeat/...
```

Expected: FAIL because startup does not own the manager and `handleUACInterception(false)` only toggles interception state.

- [x] **Step 3: Start and reconcile the manager before command admission**

Construct the manager during agent startup, load the durable ledger, and block PAM v2 handler readiness until `Reconcile` completes. For desired active, verify/reopen the named job if it exists; if crash closure already killed it, verify process/account/token state and emit evidence without claiming cleaned unless every cleanup predicate passes. For cleanup tombstones, finish cleanup before any lower/equal apply can run.

Implementation closure (2026-08-26): startup reconciliation now assigns deterministic per-boot observation identity, resolves the exact current owned PAM command through the authenticated read-only resolver, durably queues evidence in the non-expiring PAM namespace, and submits it over the acknowledged REST result route. Admission remains closed for unresolved, enqueue-failed, unreadable, or quarantined evidence. The frozen command-result transaction still performs the final exact command/device/organization/actuation/generation ownership check; no command-ID bypass, ledger expansion, alternate result transaction, or WebSocket reconciliation path was added. Implementation checkpoints are committed through `49ba664ed`.

Authoritative design addendum (2026-08-26): [`2026-08-26-s0-track-e-pam-reconciliation-binding-design.md`](../specs/2026-08-26-s0-track-e-pam-reconciliation-binding-design.md) defines the implemented agent-authenticated read-only binding resolver, durable startup-evidence handoff, rejected re-resolution, telemetry, recovery, and narrow terminal-PAM observation forwarding through the existing frozen result transaction.

Executable Step 3 addendum (2026-08-26): [`2026-08-26-s0-track-e-pam-reconciliation-binding.md`](2026-08-26-s0-track-e-pam-reconciliation-binding.md) records completed strict RED/GREEN checkpoints for the resolver, acknowledged REST result, deterministic identity/durable outbox, startup barrier/re-resolution, telemetry/runbooks, and final gates. The exact focused API, real-Postgres, API typecheck, full Task 7 agent race, Windows amd64 compile, and governance gates passed. This is not native Windows execution, deployment, hosted reachability, customer mutation, or rollout evidence; Task 8 remains separate.

- [x] **Step 4: Bind PAM disable to cleanup and account lifecycle**

Change `handleUACInterception(false)` to stop new UAC capture, invoke manager disable/cleanup for all active rows, deprovision and verify the local account, persist/report failures, then clear the enabled state only after proof. Re-enable does not resurrect old desired-active generations. Capability advertisement drops to zero while reconciliation or verification is unavailable.

- [x] **Step 5: Run GREEN and Windows compile**

```bash
cd agent && go test -race ./internal/agentapp ./internal/pamlifetime ./internal/heartbeat/...
cd agent && GOOS=windows GOARCH=amd64 go test -c ./internal/agentapp -o /tmp/breeze-agentapp.test.exe
```

Expected: restart/reboot/disable state-machine tests pass and Windows startup wiring compiles.

- [x] **Step 6: Commit**

```bash
git add agent/internal/agentapp agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/uac_interception_test.go agent/internal/pamlifetime
git commit -m "fix(agent): reconcile PAM cleanup on restart"
```

### Task 7A: Preserve immutable PAM ownership across device organization moves

**Authoritative design:** [`2026-08-26-s0-track-e-pam-device-move-guard-design.md`](../specs/2026-08-26-s0-track-e-pam-device-move-guard-design.md)

**Executable plan:** [`2026-08-26-s0-track-e-pam-device-move-guard.md`](2026-08-26-s0-track-e-pam-device-move-guard.md)

The exact-head core run exposed an ownership conflict outside the original
Task 7 Step 3 transport: `POST /devices/:id/move-org` treats
`pam_actuation_results` as an ordinary denormalized child and attempts to
rewrite its `org_id`, but accepted PAM results are append-only and carry exact
device/organization/actuation ownership foreign keys.

The wrap-first decision is fail-closed and contains no transfer mechanism: a
device with any durable `pam_actuations` row cannot move between organizations.
The route must return a stable 409 and a database trigger must enforce the same
predicate for every writer. PAM tables leave organization-move rewrite
registries but remain in device/organization deletion and retention contracts.
No override, state exception, evidence mutation, ownership detachment, command
bypass, durable-agent-ledger expansion, or Task 8 work is permitted.

- [x] **Step 1: Implement and pass the database no-transfer boundary**
- [x] **Step 2: Implement and pass the stable route conflict**
- [x] **Step 3: Pass the two-connection race, focused regressions, and exact-head core CI**
- [x] **Step 4: Synchronize issue #4060 and PR #4105 at the exact passing SHA**

Implementation closure (2026-08-27): commits `a20069f49`, `4e933707b`, and
`949b91123` enforce the no-transfer predicate in PostgreSQL and the API,
preserve append-only evidence and exact ownership, and prove both transaction
orderings without split ownership. Exact implementation candidate
`949b91123ccde2caf40acd81ff932bbe76f1be68` passed manual core run
[`33038259871`](https://github.com/LanternOps/breeze/actions/runs/33038259871)
with 41 successful jobs, only the expected skipped Main Red Alert, and no
failures; all three stacked-PR checks attached at that SHA also passed. Issue
#4060 and PR #4105 record the same evidence. No dispatch wire-contract repair,
Task 8 work, native Windows evidence, deployment, hosted mutation, or customer
mutation is claimed.

### Task 7B: Repair the frozen PAM v2 dispatch wire contract

**Authoritative design:** [`2026-08-27-s0-track-e-pam-dispatch-wire-contract-design.md`](../specs/2026-08-27-s0-track-e-pam-dispatch-wire-contract-design.md)

**Executable plan:** [`2026-08-27-s0-track-e-pam-dispatch-wire-contract.md`](2026-08-27-s0-track-e-pam-dispatch-wire-contract.md)

The API worker previously emitted aliases and server-only fields that did not
decode into the exact `PamApplyV2` and `PamCleanupV2` structures frozen above.
This pre-Task-8 repair makes the server conform to the unchanged strict agent
decoder. It does not add a new protocol, relax decoding, change the durable
ledger or result transaction, or claim endpoint execution.

- [x] **Step 1: Pin the exact apply/cleanup contract in TypeScript, Go, and one shared fixture**
- [x] **Step 2: Store and atomically bind the exact primary-agent command payloads**
- [x] **Step 3: Pass focused, real-PostgreSQL, Go race/cross-compile, governance, and exact-head core CI gates**
- [x] **Step 4: Synchronize issue #4060 and PR #4105 without starting Task 8**

Implementation closure (2026-08-27): commits `ad57b5cbf` and `40a436690`
make the server emit the exact frozen v2 apply/cleanup payloads, preserve the
unchanged strict Go decoder, normalize the real PostgreSQL expiry representation,
use one server-time expiry authority, explicitly target the primary agent role,
and bind the command atomically to the exact owned generation. Exact candidate
`40a4366902f8fe2c88c1752577a1918152d192fd` passed manual core run
[`33136440945`](https://github.com/LanternOps/breeze/actions/runs/33136440945)
with 41 successful jobs, only the expected skipped Main Red Alert, and no
failures; all three attached checks also passed. No Go production file, ledger,
result transaction, migration, alternate transport, Task 6 `received` path,
Task 8 work, native Windows evidence, deployment, hosted mutation, or customer
mutation is claimed.

### Task 7C: Transport the internally ordered Task 6 `received` observation

**Authoritative design:** [`2026-08-27-s0-track-e-pam-received-observation-transport-design.md`](../specs/2026-08-27-s0-track-e-pam-received-observation-transport-design.md)

**Executable plan:** [`2026-08-27-s0-track-e-pam-received-observation-transport.md`](2026-08-27-s0-track-e-pam-received-observation-transport.md)

The Windows manager already emits `received` after `ResumeThread` and before
active Job Object verification, but production has only the frozen singular
returned result. This pre-Task-8 repair uses an invocation-scoped concrete
manager callback to durably enqueue that observation with the exact authenticated
command-envelope ID, then submits it through a primary-agent-only supplemental
REST route into the existing frozen PAM result transaction. It does not change
the Manager interface, command/result schemas, durable ledger, WebSocket result
path, or command ownership checks.

- [x] **Step 1: Add and prove the authenticated supplemental server route**
- [x] **Step 2: Add and prove the invocation-scoped durable manager handoff**
- [x] **Step 3: Bind exact command ownership, acknowledged retry, and apply-only readiness**
- [x] **Step 4: Pass focused, real-PostgreSQL, race/cross-compile, governance, and exact-head CI gates; synchronize issue #4060 and PR #4105**

Implementation closure (2026-08-28): commits `5c0e15556`, `b5f21747b`,
`12585acfd`, `2b5a0bb3b`, `757c6a3a5`, and CI-governance fix
`efd34dfe3` implement the approved exact-command `received` handoff and
acknowledged supplemental route without changing the frozen ledger, result
transaction, Manager interface, or WebSocket path. Exact implementation
candidate `efd34dfe3a523d3999e12ed1bc1437bc37c0ea9a` passed 450 focused API
tests, 16 real-PostgreSQL tests, 7 site-scope checks, 75 RLS checks, API
TypeScript no-emit, race gates for agentapp/pamlifetime/heartbeat, Windows
amd64 agentapp cross-compile, 576-file migration drift, migration naming,
whitespace, and Task 7C scope guards. Manual core run
[`33179007091`](https://github.com/LanternOps/breeze/actions/runs/33179007091)
passed 41 jobs with only the expected skipped Main Red Alert; the exact head
was pushed, the stacked draft PR remained mergeable/CLEAN, and all three
attached checks passed. Task 8 is unstarted, and entitlement disposition
remains open. No native signed-Windows execution, physical enforcement,
deployment, hosted/customer mutation, canary, or rollout evidence is claimed.
No additional Task 6 or Task 7 reviewer may be dispatched.

### Task 8: Prove the failure matrix and produce exact-candidate Windows evidence

**Files:**
- Create: `apps/api/src/__tests__/integration/pamActuationFailureMatrix.integration.test.ts`
- Create: `agent/internal/pamlifetime/state_machine_test.go`
- Create: `agent/internal/pamlifetime/state_machine_fuzz_test.go`
- Create locally (gitignored): `internal/qa/pam-actuation/README.md`
- Create locally (gitignored): `internal/qa/pam-actuation/evidence-template.md`
- Create locally (gitignored): `internal/qa/pam-actuation/run-windows-candidate.ps1`
- Modify: CI/private-run configuration only if required to execute, never to fabricate PASS evidence

**Interfaces:**
- Produces automated server and agent state-machine evidence for lost, duplicate, reordered, delayed, offline/reconnect, clock-skew, crash/restart, and reboot cases.
- Produces a private disposable-Windows runner and evidence template under the repository's gitignored `internal/` boundary; it does not contain customer data, secrets, internal infrastructure addresses, or prewritten PASS claims, and it is not force-added to Git.
- Produces measured cleanup latency from durable agent `received` acknowledgement to accepted `cleaned` result, reported against the candidate 2-second p95/5-second maximum target without calling it an adopted production SLO.

- [x] **Step 1: Write the failure-matrix RED tests**

For two organizations and two devices, enumerate command/result permutations and assert: no cross-tenant row/command/audit side effect; no stale apply at or below a cleanup tombstone; no false cleaned result; duplicate delivery is idempotent; offline cleanup remains queued; reconnect dispatches current cleanup generation only; clock skew cannot extend server-bounded lifetime; crash/restart/reboot never regress desired state. Go state-machine/property tests generate sequences of apply, cleanup, duplicate, reorder, restart, reboot, disable, and result emission and preserve the same invariants.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationFailureMatrix.integration.test.ts
cd agent && go test -race ./internal/pamlifetime -run 'TestStateMachine|FuzzStateMachine'
```

Expected: FAIL until the matrix harness and any missing edge-case handling exist.

- [x] **Step 3: Complete only the edge-case implementation required by the matrix**

Fix uncovered compare-and-set, retry, offline, clock-bound, restart, or result-ordering gaps without weakening any earlier invariant. Do not add a bypass for unsupported agents, legacy rows, helper loss, or unverifiable endpoint state. Rerun the smallest failing case after each change, then the full matrix.

- [x] **Step 4: Add the private Windows exact-candidate harness**

The PowerShell harness must require a disposable signed Windows fixture and capture candidate Git SHA, agent/API artifact digests, OS build, boot ID, device/org IDs redacted to fixture aliases, command generations, API/worker/agent logs, and relevant database rows. It must execute at least 20 normal/failure/restart cases including normal cleanup, child/grandchild processes, offline/reconnect, duplicate/reordered commands/results, helper loss, agent crash/restart, endpoint reboot, and two organizations. It must independently inspect Job Object membership, account enabled/admin state, PID/process creation identity, and privileged-token absence.

The harness calculates p95 and maximum from durable cleanup receipt to accepted cleaned evidence. It reports `candidate_target_passed` or `candidate_target_failed`; it may report `production_slo_adopted` only when a named Security/Product/Operations decision reference is supplied. `legacy_untracked` cases remain `blocked_manual_remediation` and require an operator-entered independent verification disposition; the harness never converts them automatically.

- [x] **Step 5: Run the complete automated gate**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts src/__tests__/integration/pamActuationTransitions.integration.test.ts src/__tests__/integration/pamActuationResults.integration.test.ts src/__tests__/integration/pamActuationFailureMatrix.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
pnpm --filter @breeze/api test:rls
pnpm --filter @breeze/api test
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd agent && go test -race ./...
```

Expected: all named integration files print an executed-file line and pass; API/unit/typecheck and agent race suites pass. A green job whose PAM suite was skipped by `runIf` is not evidence.

- [x] **Step 6: Run the exact-candidate environment gate**

On the disposable Windows fixture, after explicit lab authorization:

```powershell
powershell -ExecutionPolicy Bypass -File internal/qa/pam-actuation/run-windows-candidate.ps1 `
  -CandidateSha <exact-git-sha> `
  -EvidenceDirectory <private-evidence-directory>
```

Expected: at least 20 executed cases, two fixture organizations, zero surviving privileged token/process tree after every accepted cleanup, no terminal claim before proof, and measured candidate target results. Replace angle-bracket arguments with the lab's values; never commit them.

- [x] **Step 7: Record closure disposition and commit**

Record RMM-QA-445 as `fixed-unverified` unless all of these are present: exact-candidate Windows evidence, executed real-Postgres suites, explicit candidate-target adoption/revision, and a resolved entitlement-removal disposition. The code commit remains valid while closure is blocked.

```bash
git add apps/api/src/__tests__/integration/pamActuationFailureMatrix.integration.test.ts agent/internal/pamlifetime/state_machine_test.go agent/internal/pamlifetime/state_machine_fuzz_test.go
git commit -m "test(pam): prove actuation cleanup matrix"
```

Implementation closure (2026-08-28): commit
`3de86327032d7c335c09689878fa086bba1cfdf7` adds the two-organization
real-PostgreSQL failure matrix and the durable-ledger state-machine/fuzz tests.
The RED matrix exposed one exact edge case: an already-accepted `cleaned`
observation was classified `stale` before observation-identity deduplication.
The minimal fix keeps schema, generation, desired-state, independent-cleanup,
command, device, agent, organization, and tenant checks ahead of deduplication,
then classifies an already-present valid observation as `duplicate` before the
reordered-state check. No ownership check or frozen transaction input changed.

The four named PAM integration files executed 21 tests against real PostgreSQL;
RLS coverage passed 75 checks and the configured RLS runtime suite passed 22;
API typecheck passed; the repository-pinned Node 22.23.2 API suite passed 1,493
files and 25,763 tests with only its expected skips; `go test -race ./...` passed;
the bounded state-machine fuzz campaign passed; and the `pamlifetime`,
`pamactuator`, `elevaccount`, and `agentapp` Windows amd64 test binaries compiled.
The gitignored private harness and templates are syntax-checked and require an
explicit lab authorization reference, a disposable signed fixture, two
organization aliases, distinct execution/inspection adapters, 20-plus executed
cases, independent process/account/token inspection, and real latency evidence.

RMM-QA-445 remains `fixed-unverified`. Step 6 is deliberately unchecked because
no authorized disposable signed-Windows fixture or private evidence directory
was supplied. The candidate 2-second p95/5-second maximum remains unadopted, and
the shipping entitlement-removal disposition remains unresolved. This closure
does not claim native Windows execution, physical enforcement, deployment,
hosted reachability, customer mutation, production SLO adoption, or rollout.

Exact-candidate closure (2026-08-29, rc.3 `a11d432a6`): the disposable
signed-Windows fixture (Server 2022 endpoints, physical Windows 11 harness host,
lab authorization LAB-2026-08-28-S0-445-DELL70601) executed all 25 matrix cases
against the SSL.com-signed hosted-gap agent (`9cf3bcb4…9be7`) and the candidate
API image with **zero invariant failures** and zero missing `received` receipts:
21 `accepted_cleanup`, `refused_stale_apply`, two `rejected_cross_org`, and
`legacy_untracked` retained as `blocked_manual_remediation` under an
operator-entered disposition. Independent process/account/token inspection was
clean after every accepted cleanup. Measured cleanup latency over 21 accepted
cases: p95 442.75 ms, maximum 612 ms → `candidate_target_passed`;
`productionSloAdopted` is false because no Security/Product/Operations decision
reference was supplied. The run was made possible by two rc.3 fixes recorded in
`docs/superpowers/specs/2026-08-28-s0-track-e-pam-rc3-design.md`: #4196
(crash-during-grant cleanup proven by independent endpoint evidence; job absent
with the exact process alive still fails closed as `job_absent_process_alive`)
and the synchronous `received` acknowledgement before `Resume`. rc.2 had
executed 17/25 before #4196 blocked it; the three replay cases that rc.2 could
not exercise ran for real on rc.3 (`duplicate`, `duplicate`, `stale`).

Closure decision (2026-08-29): the exact-candidate Windows and real-PostgreSQL
evidence above remain the verification basis. The 2-second p95 / 5-second
maximum is now an adopted production cleanup SLO with mandatory hosted-canary
re-measurement before rollout expansion, and Product records PAM in v0.109 as
available on all plan tiers and not separately entitled. The entitlement
disposition reopens immediately if PAM becomes plan- or billing-gated. These
decisions satisfy the remaining Task 8 Step 7 inputs, so RMM-QA-445 may leave
`fixed-unverified`; no production deployment, hosted canary, or rollout is
claimed. The authoritative reference is
[`2026-08-29-s0-track-e-pam-closure-decisions.md`](../specs/2026-08-29-s0-track-e-pam-closure-decisions.md).

## Dependency and Rollout Gate

```text
Track D complete
  -> E1 schema/RLS/outbox/quarantine
  -> E2 lifecycle/outbox publisher/worker
  -> E3 all server transitions + entitlement owner gate
  -> E4 one REST/WS result path + truthful status
  -> E5 v2 protocol/store/capability
  -> E6 Windows token-launch Job Object contract
  -> E7 restart/reboot/disable reconciliation
  -> E8 automated matrix + exact-candidate Windows evidence
```

- Keep v1 `actuate_elevation` only for rollout compatibility. It is not eligible for new v2 admission, cannot advertise v2, and cannot close RMM-QA-445.
- Land schema and tolerant parsing before any producer emits protocol v2. Land the inert agent capability before server admission is enabled.
- PAM stays internal-lab-only until restart/reboot cases and the adopted 5-second maximum pass. The exact candidate met those prerequisites; hosted 5/25-device canaries still require separate explicit deployment authorization and must re-measure the adopted 2-second p95 / 5-second maximum before any rollout expansion.
- Pause expansion on any foreign-scope rejection, digest/identity equivocation, cleanup timeout, unverified state, legacy command claim, or material queue backlog.
- One independent whole-branch review occurs after all remediation tracks, not per Task E1-E8. Review fixes use targeted tests; re-review only when a fix changes tenancy, migrations, concurrency, or shipped-agent behavior.

## Completion Evidence Checklist

- [x] RMM-QA-445 is the only finding claimed by this track.
- [x] One physical `intent_outbox` handles both intent and PAM parents with an XOR constraint.
- [x] `pam_actuations` is mutable desired/latest state; `pam_actuation_results` is append-only evidence.
- [x] Legacy active/actuating v1 rows surface `legacy_untracked` / `blocked_manual_remediation` and are never marked cleaned.
- [x] Missing or unsupported heartbeat capability prevents v2 apply admission.
- [x] REST and WebSocket results use the same registered service.
- [x] Only token-launch v2 uses the named kill-on-close Job Object contract; SendInput remains v1 only (`TestV2WindowsImplementationDoesNotUseConsentOrSendInputProof`).
- [x] Cleanup tombstones reject delayed older apply commands across restart/reboot.
- [x] Only verified current-generation endpoint evidence advances session/terminal cleanup truth.
- [x] Entitlement removal names a wired shipping caller or a Product-owned shipping-SKU non-applicability disposition (v0.109 Product decision; reopens on plan/billing gating).
- [x] Real-Postgres suites execute rather than skip and prove two-org isolation and zero side effects.
- [x] Go race/state-machine tests pass and Windows binaries cross-compile.
- [x] Disposable signed-Windows evidence covers at least 20 cases and proves zero surviving privileged token/process tree (rc.3, 25/25, 2026-08-29).
- [x] The 2-second p95 / 5-second maximum is adopted by the 2026-08-29 closure decision; hosted 5/25-device canaries must re-measure it before rollout expansion.
- [x] No production deployment, customer rollout, or destructive production migration occurred from this branch.
