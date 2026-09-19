---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
parent_plan: ./2026-08-24-s0-track-e-pam-actuation.md
design_spec: ../specs/2026-08-26-s0-track-e-pam-device-move-guard-design.md
---

# Track E PAM Device Organization-Move Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject every cross-organization move for a device with durable PAM actuation history without mutating evidence, weakening ownership, or starting Track E Task 8.

**Architecture:** A fix-forward PostgreSQL trigger is the universal ownership boundary and rejects `devices.org_id` changes when an exact source-owned PAM actuation exists. The HTTP route performs the same check for a stable 409 response, while PAM tables are removed from both explicit and dynamic organization-rewrite registries so an allowed move never attempts an invalid evidence update.

**Tech Stack:** TypeScript, Hono, Drizzle/raw PostgreSQL SQL, PostgreSQL triggers/RLS/FKs, Vitest, real-Postgres integration tests.

## Global Constraints

- Implement only this pre-Task-8 Track E closure item.
- A single `pam_actuations` row blocks the move in every lifecycle state.
- Do not add an override flag, system bypass, retention shortcut, evidence transfer, ownership detachment, or state exception.
- Do not update/delete/rewrite `pam_actuation_results` or change its grants, append-only trigger, RLS, or foreign keys.
- Do not change `pam_actuations` or durable agent-ledger columns, RLS, ownership foreign keys, or exact result checks.
- Keep PAM tables in device permanent-delete and organization-erasure registrations; remove them only from organization-move rewrite discovery.
- Add only the fix-forward migration `apps/api/migrations/2026-09-17-pam-device-move-guard.sql`; do not edit or renumber existing migrations.
- Preserve current device-move auth, MFA, source/target access, currency, site, audit, disconnect, and peripheral-reconciliation behavior for eligible devices.
- Strict RED/GREEN: prove each failure before implementation, make the minimum change, and rerun the named gate.
- No production deployment, `/opt/breeze` change, hosted-admission change, customer-device mutation, or Task 8 work.

---

### Task 1: Add the database no-transfer boundary and rewrite exclusions

**Files:**
- Create: `apps/api/migrations/2026-09-17-pam-device-move-guard.sql`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/routes/devices/moveOrg.coverage.test.ts`
- Create: `apps/api/src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/pamActuationLifecycle.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/db/autoMigrate.test.ts`

**Interfaces:**
- Produces PostgreSQL trigger function `public.breeze_guard_pam_device_org_move()`.
- Produces trigger `devices_pam_history_move_guard` on `devices`.
- The trigger raises SQLSTATE `23514` and constraint name `devices_pam_history_move_guard`.
- `getDeviceOrgDenormalizedTables()` no longer returns `pam_actuations` or `pam_actuation_results`.
- `getDeviceCascadeDeleteTables()` continues returning both tables.

- [x] **Step 1: Write the database RED test**

Create two organizations and sites under one partner, one device in the source,
and one valid source-owned PAM actuation. Assert a direct admin connection
cannot change only `devices.org_id`:

```ts
await expectPgError(
  () => adminDb.execute(sql`
    UPDATE devices SET org_id = ${targetOrgId}::uuid
    WHERE id = ${deviceId}::uuid
  `),
  { code: '23514', constraint: 'devices_pam_history_move_guard' },
);
```

Repeat with representative actuation states `pending_dispatch`,
`verified_active`, `cleanup_pending`, `cleaned`, `failed`, and
`legacy_untracked`. Assert a control device with no actuation can change
organization when all ordinary denormalized fixtures are valid.

- [x] **Step 2: Run the database test and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts
```

Expected: FAIL because `devices_pam_history_move_guard` does not exist and/or
the current dynamic cascade attempts to rewrite PAM evidence.

- [x] **Step 3: Add the fix-forward trigger migration**

Create the function and trigger with the exact contract:

```sql
CREATE OR REPLACE FUNCTION public.breeze_guard_pam_device_org_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     AND EXISTS (
       SELECT 1
       FROM public.pam_actuations
       WHERE device_id = OLD.id
         AND org_id = OLD.org_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'devices_pam_history_move_guard',
      MESSAGE = 'device organization move blocked by durable PAM lifecycle evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devices_pam_history_move_guard ON public.devices;
CREATE TRIGGER devices_pam_history_move_guard
  BEFORE UPDATE OF org_id ON public.devices
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_guard_pam_device_org_move();
```

In the same migration, replace `public.breeze_device_child_orgid_tables()`
using the complete body from `2026-09-06-a-agent-runs-org-immutable.sql` and
extend only its exclusion predicate:

```sql
AND t.relname NOT IN (
  'ai_agent_runs',
  'pam_actuations',
  'pam_actuation_results'
)
```

Do not abbreviate or partially replace the function body.

- [x] **Step 4: Remove PAM from the explicit move registry and pin coverage**

Remove only these two names from `CORE_DEVICE_ORG_DENORMALIZED_TABLES`:

```ts
'pam_actuations', 'pam_actuation_results',
```

Add both to `INTENTIONALLY_NO_ORG_ID` in `moveOrg.coverage.test.ts` with a
comment that their org IDs are frozen by the no-transfer guard. Add assertions:

```ts
expect(getDeviceOrgDenormalizedTables()).not.toContain('pam_actuations');
expect(getDeviceOrgDenormalizedTables()).not.toContain('pam_actuation_results');
expect(getDeviceCascadeDeleteTables()).toContain('pam_actuations');
expect(getDeviceCascadeDeleteTables()).toContain('pam_actuation_results');
```

- [x] **Step 5: Run GREEN database and governance gates**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
pnpm --filter @breeze/api exec vitest run src/routes/devices/moveOrg.coverage.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api db:check-drift
bash scripts/check-migration-naming.sh
```

Expected: all named files execute and pass; drift and migration naming pass;
the append-only PAM result contract is unchanged.

- [x] **Step 6: Commit the database boundary**

```bash
git add apps/api/migrations/2026-09-17-pam-device-move-guard.sql apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/moveOrg.coverage.test.ts apps/api/src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts
git commit -m "fix(db): block PAM device ownership moves"
```

### Task 2: Return a stable ownership conflict from the move route

**Files:**
- Create: `apps/api/src/services/pamDeviceMoveGuard.ts`
- Create: `apps/api/src/services/pamDeviceMoveGuard.test.ts`
- Modify: `apps/api/src/routes/devices/moveOrg.ts`
- Modify: `apps/api/src/routes/devices/moveOrg.test.ts`
- Modify: `apps/api/src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/deviceMoveOrgCurrency.integration.test.ts`

**Interfaces:**

```ts
export type PamDeviceMoveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class PamDeviceMoveBlockedError extends Error {
  readonly code = 'PAM_DEVICE_MOVE_BLOCKED';
}

export async function assertPamDeviceOrgMoveAllowed(
  tx: PamDeviceMoveTx,
  input: { deviceId: string; sourceOrgId: string },
): Promise<void>;
```

- [x] **Step 1: Write service and route RED tests**

The service test must assert this exact owned-scope query behavior:

```text
no source-owned actuation                 -> resolves
source-owned actuation in any state       -> PamDeviceMoveBlockedError
same device UUID with contradictory org   -> ignored by service query
```

The route test must assert:

```ts
expect(response.status).toBe(409);
expect(await response.json()).toEqual({
  error: 'Device organization move is blocked because durable PAM lifecycle evidence exists',
  code: 'PAM_DEVICE_MOVE_BLOCKED',
});
expect(captureExceptionMock).not.toHaveBeenCalled();
expect(disconnectAgent).not.toHaveBeenCalled();
expect(schedulePeripheralPolicyDeviceMock).not.toHaveBeenCalled();
```

Assert the check runs after both organization SHARE locks but before the first
device update. Also simulate a trigger-race error with SQLSTATE `23514` and
`constraint_name='devices_pam_history_move_guard'`; it must map to the same
409, while unrelated `23514` errors still use the existing generic failure
path.

- [x] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamDeviceMoveGuard.test.ts src/routes/devices/moveOrg.test.ts
```

Expected: FAIL because the service, typed error, and route mapping do not exist.

- [x] **Step 3: Implement the read-only service**

Use one parameterized query and expose no row contents:

```ts
const row = rows<{ blocked: boolean }>(await tx.execute(sql`
  SELECT EXISTS (
    SELECT 1
    FROM pam_actuations
    WHERE device_id = ${input.deviceId}::uuid
      AND org_id = ${input.sourceOrgId}::uuid
  ) AS blocked
`))[0];
if (row?.blocked) throw new PamDeviceMoveBlockedError();
```

Do not select state, result, command, subject, target, or evidence fields.

- [x] **Step 4: Integrate the guard and exact error mapper**

Call `assertPamDeviceOrgMoveAllowed(tx, { deviceId, sourceOrgId })` immediately
after the source/target organization SHARE barrier and before updating the
device row.

In the route catch, map `PamDeviceMoveBlockedError` directly. For the trigger
race, unwrap with `pgErrorNode(err)` and match both:

```ts
node?.code === '23514'
  && node?.constraint_name === 'devices_pam_history_move_guard'
```

Return the stable 409 body and write only the existing source failure audit
with `{ code: 'PAM_DEVICE_MOVE_BLOCKED' }`. Do not report this expected conflict
to Sentry.

- [x] **Step 5: Extend and run real-Postgres route proof**

In `pamDeviceMoveGuard.integration.test.ts`, drive the real route with PAM
actuation and result fixtures. Assert 409 and byte-for-byte equality of source
and target device, ticket, actuation, result, and command fixtures before and
after. Assert exactly one source-side failed-move audit containing only the
stable failure code and no target-side success audit. Assert no `UPDATE pam_actuations` or
`UPDATE pam_actuation_results` permission is granted by the migration.

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts src/__tests__/integration/agentRunMoveSemantics.integration.test.ts src/__tests__/integration/deviceMoveOrgCurrency.integration.test.ts
```

Expected: all three files execute and pass.

- [x] **Step 6: Commit the route behavior**

```bash
git add apps/api/src/services/pamDeviceMoveGuard.ts apps/api/src/services/pamDeviceMoveGuard.test.ts apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts apps/api/src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts
git commit -m "fix(api): reject PAM device organization moves"
```

### Task 3: Prove the create-versus-move race and exact-head closure gates

**Files:**
- Modify: `apps/api/src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts`
- Modify: `docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md`
- Modify: `docs/superpowers/plans/2026-08-26-s0-track-e-pam-device-move-guard.md`

**Interfaces:**
- Produces a two-connection race proof with no split ownership outcome.
- Produces exact-head local and CI evidence without changing Task 8.

- [x] **Step 1: Write the two-connection RED race**

Use two independent test connections and explicit barriers:

```text
connection A: begin device org move and hold before commit
connection B: attempt source-org PAM actuation insert
release A; collect both outcomes
```

Run the inverse ordering as a second case. Accept only:

```text
actuation commits -> move returns PAM_DEVICE_MOVE_BLOCKED
move commits      -> old-org actuation insert fails ownership FK
```

Reject any outcome where both commit, where the result table changes, or where
the device and actuation end in different committed ownership without an
error.

- [x] **Step 2: Run the race and verify RED/GREEN evidence**

Run before the Task 1 migration implementation to preserve the unsafe or
generic-failure RED observation, then after Tasks 1-2:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts
```

Expected after implementation: PASS with both orderings executed.

- [x] **Step 3: Run the complete focused regression gate**

```bash
pnpm --filter @breeze/api exec vitest run src/services/pamDeviceMoveGuard.test.ts src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts src/__tests__/integration/pamActuationResults.integration.test.ts src/__tests__/integration/pamReconciliationBinding.integration.test.ts src/__tests__/integration/agentRunMoveSemantics.integration.test.ts src/__tests__/integration/deviceMoveOrgCurrency.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
pnpm --filter @breeze/api db:check-drift
bash scripts/check-migration-naming.sh
git diff --check
```

Expected: all named files execute and pass; typecheck, drift, migration naming,
and diff checks pass.

- [x] **Step 4: Run exact-head core CI**

Push the exact candidate, dispatch the existing core workflow against that
exact SHA, and record every job conclusion. Do not describe stacked-PR
attached checks as the core run.

Expected: the previously failing integration shard passes; only the expected
Main Red Alert may be skipped. Any other failure remains a blocker.

Closure evidence (2026-08-27): exact implementation candidate
`949b91123ccde2caf40acd81ff932bbe76f1be68` passed manual core run
[`33038259871`](https://github.com/LanternOps/breeze/actions/runs/33038259871)
with 41 successful jobs, only the expected skipped Main Red Alert, and no
failures. All three checks attached to stacked PR #4105 passed at the same SHA.

- [x] **Step 5: Record closure without starting Task 8**

Check this addendum only after every local gate and exact-head core CI pass.
Update issue #4060 and PR #4105 with the exact SHA, attached-check count, manual
core-run URL/job totals, the permanent PAM device-move restriction, and all
remaining non-claims. Leave Task 8 and the dispatch wire-contract repair
unchecked.

- [x] **Step 6: Commit documentation evidence**

```bash
git add docs/superpowers/plans/2026-08-24-s0-track-e-pam-actuation.md docs/superpowers/plans/2026-08-26-s0-track-e-pam-device-move-guard.md
git commit -m "docs(pam): record device move ownership gate"
```

## Completion Non-Claims

- No historical PAM transfer model or override exists.
- No dispatch wire-contract repair is included.
- No Task 6 `received` production transport is included.
- No native signed-Windows execution, physical enforcement, deployment,
  hosted reachability, customer mutation, canary, or rollout evidence exists.
- Task 8 remains unstarted.
