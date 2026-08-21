# Security Review Wave 4: Atomic Provisioning Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make partner device-quota enforcement authoritative and race-safe during device provisioning.

**Architecture:** Keep request authorization at the route, then enter one privileged service transaction that resolves authoritative ownership, serializes quota decisions on the partner row, counts all active partner devices outside request RLS, and inserts only while capacity remains.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL transactions/row locks, Vitest, OrbStack.

**Global Constraints:** Do not widen caller authorization; count every organization belonging to the partner; exclude only decommissioned devices; perform external work after commit; preserve the provisioning response contract.

**Finding:** SR1-04.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-04-atomic-provisioning-quota-design.md`

## File map

- Create `apps/api/src/services/deviceProvisioning.ts` and adjacent tests.
- Modify `apps/api/src/routes/devices/provision.ts` and `provision.test.ts`.
- Add `apps/api/src/__tests__/integration/deviceProvisioningQuota.integration.test.ts`.

## Task 1: Define the privileged service boundary

- [ ] Add failing unit tests for invalid org/site ownership, missing partner, unlimited quota, below-limit success, at-limit denial, and decommissioned-device exclusion.
- [ ] Define explicit input/output types:

```ts
export interface ProvisionDeviceWithinPartnerQuotaInput {
  orgId: string;
  siteId: string;
  device: NewDevice;
}

export async function provisionDeviceWithinPartnerQuota(
  input: ProvisionDeviceWithinPartnerQuotaInput,
): Promise<ProvisionedDevice>;
```

- [ ] Run `pnpm --filter=@breeze/api test -- services/deviceProvisioning.test.ts`; expect RED.
- [ ] Implement validation using authoritative database rows, not caller-provided `partnerId`.
- [ ] Re-run; expect GREEN.
- [ ] Commit: `fix(provisioning): add authoritative quota service`.

## Task 2: Serialize and enforce quota in one transaction

- [ ] Extend tests to assert the order: begin system transaction, resolve org/site, lock partner `FOR UPDATE`, count, insert, commit.
- [ ] Use `runOutsideDbContext` before `withSystemDbAccessContext` when invoked from a request.
- [ ] Lock the partner row before the count. Count devices joined through organizations where device status is not `decommissioned`; treat `maxDevices IS NULL` as unlimited and `count >= maxDevices` as denial.
- [ ] Insert the device in the same transaction. Throw a typed quota error mapped to the existing route status/body.
- [ ] Ensure no event, command, queue, or network side effect happens inside the transaction.
- [ ] Run focused service tests; expect GREEN.
- [ ] Commit: `fix(provisioning): enforce quota under partner lock`.

## Task 3: Route integration without authorization regression

- [ ] Add route tests proving unauthenticated, wrong-org, wrong-site, and insufficient-permission callers never enter the privileged service.
- [ ] Replace the route's pre-count/insert sequence with one call to `provisionDeviceWithinPartnerQuota` after existing auth and validation.
- [ ] Move post-provisioning side effects after successful service return and make failure behavior explicit.
- [ ] Run `pnpm --filter=@breeze/api test -- routes/devices/provision.test.ts services/deviceProvisioning.test.ts`; expect GREEN.
- [ ] Commit: `fix(provisioning): route device creation through atomic quota gate`.

## Task 4: Real concurrency proof in OrbStack

- [ ] Add an integration test with a partner having exactly one slot left and two independent PostgreSQL connections provisioning concurrently.
- [ ] Use a barrier so both requests begin before either commits; assert exactly one insert succeeds, the other receives quota denial, and final active count equals the limit.
- [ ] Add cases for cross-partner devices not affecting the count and decommissioned devices freeing capacity.
- [ ] Run the integration test against OrbStack PostgreSQL using the repository integration config; expect GREEN on repeated runs (`--repeat=10` if supported, otherwise a shell loop).
- [ ] Commit: `test(provisioning): prove concurrent quota enforcement`.

## Task 5: Full verification

- [ ] Run `pnpm --filter=@breeze/api test -- routes/devices/provision.test.ts services/deviceProvisioning.test.ts`.
- [ ] Run the new integration test with a real database.
- [ ] Run `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`, `pnpm db:check-drift`, and `git diff --check`.
- [ ] Inspect SQL logging to confirm the partner lock precedes count and insert and that no cross-partner data is returned to the request.
- [ ] Commit any verification-only fixtures as `test(provisioning): complete quota regression coverage`.
