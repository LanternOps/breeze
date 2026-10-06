---
tracking_issue: LanternOps/breeze#4547
spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
index: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md
wave: W01 — Foundation (one PR; ships nothing user-visible)
blast_radius: high (new tenant table, RLS, composite FKs, a CHECK rewrite on contract_lines, a hot-table column on time_entries, three cascade/export/merge registrations)
---

# Block Hours W01: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every database object, Drizzle declaration, registration and compile-time guard the block-hours program needs, so W02 (drawdown engine) can be built against a stable schema. Nothing a user can see changes: no API can create an `hour_block` line, and a hand-forged one fails closed.

**Architecture:** Four hand-written idempotent migrations (enum value alone; `contract_lines` columns + CHECKs + live-block index; the `contract_hour_periods` ledger with Shape-1 RLS and three composite deferrable FKs; `time_entries.contract_line_id` with a composite deferrable FK, applied lock-safely). Drizzle mirrors them, with the SQL-only constraints commented the way the files already do. Three registration lists move in the same commits as the DDL. The two `never`-exhaustive switches in `contractService.ts` get explicit fail-closed `hour_block` arms, and the Drizzle row type widening is absorbed in the three shared-type seats it reaches.

**Tech Stack:** PostgreSQL + hand-written SQL migrations (`autoMigrate`), Drizzle ORM (type-only; drift via `pnpm db:check-drift`), Hono/TypeScript services, Vitest (unit + real-DB integration as `breeze_app`), the RLS/cascade/export/merge contract suites in `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md` — the two amendment sections at the top override the body. This wave implements the schema slice of §1 (line type + columns), §2 (`time_entries.contract_line_id`) and §3 (`contract_hour_periods`), with Decision 3 A (overage rate required) and Open Decision 10 A (`overage_mode = 'bill'` only) enforced by CHECK.

**Index:** `docs/superpowers/plans/billing/2026-10-06-block-hours-index.md` — the contract. Sections C1–C6, C10 and "Why W01 ships nothing" are implemented verbatim; every SQL name, column, constraint, Drizzle name, registration, error code and migration filename below is the index's. Private additions are listed under "Additions to the index" so reviewers can see them.

---

## Global Constraints

- Migration filenames, in this order, newest-sorting: `2026-12-14-100000-contract-line-type-hour-block.sql`, `2026-12-14-100100-contract-lines-hour-block.sql`, `2026-12-14-100200-contract-hour-periods.sql`, `2026-12-14-100300-time-entries-contract-line.sql`. Newest committed migration at planning: `2026-12-13-110200-org-erasure-fk-child-actions.sql` — re-check before committing (Task 7).
- File 1 contains **only** `ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'hour_block';`. `autoMigrate` wraps each file in one transaction and a value added by `ADD VALUE` cannot be referenced in the same transaction.
- Every migration is idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` then create). No inner `BEGIN;`/`COMMIT;`. No migration writes a row, so none needs the `set_config('breeze.scope','system',true)` preamble (`migrationRlsScope.test.ts` stays green with no baseline change).
- Hours are `numeric(12,2)`; money is `numeric(12,2)`; dates are `date` (Drizzle `mode: 'string'`, the file default); instants are `timestamptz`.
- Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE` (org merge runs `SET CONSTRAINTS ALL DEFERRED`). Four are added: `contract_hour_periods_contract_org_fk`, `contract_hour_periods_line_org_fk`, `contract_hour_periods_invoice_org_fk`, `time_entries_contract_line_org_fk`.
- `contract_hour_periods` is RLS **Shape 1** (direct `org_id`, `public.breeze_has_org_access(org_id)`), `ENABLE` + `FORCE`, four `breeze_org_isolation_{select,insert,update,delete}` policies, **not** append-only, `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app`. It is org-owned (a balance, not a policy), so the partner-wide-first rule does not apply; justification is spec §"Why org-scoped and not dual-axis".
- `time_entries` is partner-axis (Shape 3) and hot. Its new CHECKs and FK are added `NOT VALID` and then `VALIDATE`d as separate statements in a `-- @no-transaction` file with a bounded `lock_timeout`, so the validation scan does not hold an `ACCESS EXCLUSIVE` lock. Precedent: `2026-12-13-110100-device-software-device-cascade.sql` (same technique, no-transaction), `2026-12-02-100000` + `2026-12-02-100010` (NOT VALID then VALIDATE in a second file), `2026-10-24-210000-time-entries-billable-minutes.sql` (NOT VALID on this same table; it validates in the same transaction, which does not shorten the lock — the reason this file is no-transaction).
- `CONTRACT_LINE_TYPES` and `ALLOWANCE_LINE_TYPES` in `@breeze/shared` do **not** gain `hour_block` (W03 does that). `HOUR_BLOCK_LINE_TYPE`, `ROLLOVER_POLICIES`, `RolloverPolicy` are added and exported.
- `ContractServiceErrorCode` gains `'HOUR_BLOCK_NOT_ENABLED'` (HTTP 500). Both exhaustive switches get `case 'hour_block':` arms that throw `new ContractServiceError('hour_block lines are not enabled', 500, 'HOUR_BLOCK_NOT_ENABLED')`.
- `contract_lines_allowance_chk` is DROPped and re-added with the index's exact text; `contract_lines_hour_block_chk` and `contract_lines_one_live_hour_block_per_org_uq` are exactly the index's.
- Registrations in the same commits as the DDL: `CORE_ORG_CASCADE_DELETE_ORDER` (`'contract_hour_periods'` between `'contract_documents'` and `'contract_lines'`), `CORE_TENANT_EXPORT_POLICY` (new table row; five columns on `contract_lines`; `contract_line_id` on `time_entries`), `REPOINT_TABLES` (`"contract_hour_periods"` beside `"contract_documents"`). No `rls-coverage` allowlist entry (Shape 1 is auto-discovered). No device/ticket cascade lists (no `device_id`, no `ticket_id`).
- Plans are public: no vulnerability language; constraints are described neutrally ("a row for another org is rejected").

## Review Focus

The five failure modes most likely to bite in this wave, each pinned by a named test.

1. **A new enum value used in the transaction that adds it** (SQLSTATE 55P04 on a fresh database, green on a database that already ran file 1). Pinned: Task 2 keeps file 1 to a single statement and the Task 5 ordering test asserts `splitSqlStatements(file1)` equals exactly that one statement and that files sort 100000 < 100100 < 100200 < 100300; Task 2's integration test asserts `hour_block` is the last label on a freshly migrated database.
2. **A CHECK that abstains instead of rejecting (three-valued logic), and the old allowance CHECK silently reverting.** A CHECK passes on TRUE *or NULL*. Pinned: Task 3's truth table inserts every required-field-NULL, block-only-column-on-flat, 0/101 alert and zero-hours row and asserts the constraint *name* that rejects it. The same task rewrites `contractLinesAllowanceConstraints.integration.test.ts` to use `replayMigration()` — that suite re-executes the older `2026-10-08-100200` file, which re-adds `contract_lines_allowance_chk` *without* `hour_block`; replaying it bare would leave the narrower CHECK in force for every later suite in the shard. Task 3 pins the fix with a test that replays the old file and then inserts a fractional block line.
3. **A composite FK that is not deferrable, or a ledger row that crosses orgs.** Pinned: Task 4 forges each of the three ledger FKs individually as system context (RLS cannot be what stops it), asserts `condeferrable AND NOT condeferred` from `pg_constraint`, and proves the `ON DELETE SET NULL (overage_invoice_id)` column list keeps `org_id` intact. Task 5 does the same for the `time_entries` FK.
4. **A table rewrite or long lock on `time_entries`.** Pinned: Task 5's file is `-- @no-transaction`, sets `lock_timeout`, adds the CHECKs/FK `NOT VALID` and validates in separate statements; the Task 5 test asserts `convalidated = true` for all three (so the VALIDATE statements ran) and replays the file statement-by-statement on a single connection; the ordering test asserts the directive and three `VALIDATE CONSTRAINT` statements are present.
5. **A registration missed.** RLS coverage does not imply cascade coverage; code review has caught this 0/5 times and the contract tests 5/5. Pinned: each of Tasks 3, 4, 5 edits its list in the same commit and runs the suite red-then-green; Task 6 seeds a block line and a ledger row into `tenantExportErasureRoundtrip.integration.test.ts` and asserts `contract_hour_periods.json` is exported and the rows erased child-first.

## Index reconciliation — where the current code differs from the index

Verified against this checkout (`origin/main` @ `327fa66b11`, which includes the index's `9b9f3fc28d`). None blocks W01; each has an action below.

1. **The `REPOINT_TABLES` line number.** Index C5 cites `orgMergeRegistry.ts:731`. That is the array *declaration* (`const REPOINT_TABLES: readonly string[] = [`); the `contract_documents` / `contract_lines` entries are at `:833` / `:834`. Insert between them. (Task 4.)
2. **"4 `ADD COLUMN IF NOT EXISTS`" (index C1, W01 row 2)** versus five columns in C2. C2 is the table of record; this plan adds five.
3. **Drizzle row-type widening reaches more than the two switches.** The index lists two compile errors. Widening `contractLineTypeEnum` also changes `typeof contractLines.$inferSelect['lineType']`, which flows into three seats typed as the narrower shared `ContractLineType`: `ContractLineAudit.lineType` (`contractTypes.ts:151`), `CoverageLine.lineType` (`contractCoverage.ts:25`) and `mergeContractLinePatch(current, …)` in `updateContractLine` (`contractService.ts:1671`, `PersistedContractLine` in `packages/shared/src/validators/contracts.ts:285`). Task 2 handles them without changing `CONTRACT_LINE_TYPES`.
4. **`ON DELETE RESTRICT` raises 23503, not 23001.** Postgres reports a RESTRICT violation as `foreign_key_violation`; Task 4's test asserts `23503` on `contract_hour_periods_line_org_fk`.
5. **The one-live-block-per-org index and org merge.** Index "Spec deltas" §6 says org merge is unaffected. For the *ledger* and the `time_entries` FK that holds (both deferrable). But `contract_lines` is a plain `repoint` (`orgMergeRegistry.ts:834`), and `contract_lines_one_live_hour_block_per_org_uq` is a unique index on `(org_id)`: merging two orgs that each hold a live block would raise 23505 when the second org's line is repointed. Nothing can create a block line until W03, so W01 cannot trigger it, but W02/W03 need a decision (a merge preflight that refuses with a clear message, or a `custom` merge policy) before the feature opens. **Recorded here and to be raised on the tracking issue; not a W01 deliverable.**
6. **Fail-closed has a wide read blast radius.** `resolveLineQty` is also called by the contracts list (`:481`) and the MRR rollup (`:1062`), whose `catch` blocks rethrow anything other than `GROUP_EVALUATION_FAILED`. One forged `hour_block` row on an active contract therefore fails the whole list/rollup with a 500 until W03 replaces the arm. Intended by the index (loud, never billed); unreachable through the API. Task 2's test pins the estimate path only.

## Additions to the index (private; reviewers may reject)

- `hourBlockNotEnabled()` and `assertNotHourBlock()` helpers in `contractService.ts`; a pre-flight loop in `generateDueInvoice` so a forged row makes the run a no-write result (the in-switch arm still exists for exhaustiveness).
- Explicit constraint names on the ledger CHECKs: `contract_hour_periods_period_chk`, `contract_hour_periods_hours_nonneg_chk`, `contract_hour_periods_close_source_chk`.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON contract_hour_periods TO breeze_app` (the shipped evidence tables carry it explicitly).
- `ContractLineAudit.lineType` / `CoverageLine.lineType` widened to `ContractLineType | typeof HOUR_BLOCK_LINE_TYPE`.

## File structure

| File | Change |
|---|---|
| `packages/shared/src/validators/contracts.ts` | + `HOUR_BLOCK_LINE_TYPE`, `ROLLOVER_POLICIES`, `RolloverPolicy` (Task 1) |
| `packages/shared/src/validators/contracts.test.ts` | + constants test (Task 1) |
| `apps/api/migrations/2026-12-14-100000-…`, `…100100-…`, `…100200-…`, `…100300-…` | new (Tasks 2, 3, 4, 5) |
| `apps/api/src/db/schema/contracts.ts` | enum value, 5 columns + index on `contractLines`, new `contractHourPeriods` (Tasks 2–4) |
| `apps/api/src/db/schema/timeTracking.ts` | `contractLineId` + index (Task 5) |
| `apps/api/src/services/contractTypes.ts` | error code, `ContractLineAudit.lineType` widening (Task 2) |
| `apps/api/src/services/contractCoverage.ts` | `CoverageLine.lineType` widening (Task 2) |
| `apps/api/src/services/contractService.ts` | fail-closed arms, pre-flight, guard (Task 2) |
| `apps/api/src/services/contractService.test.ts` | fail-closed unit tests (Task 2) |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | registrations (Tasks 3–5) |
| `apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts` | new, grows over Tasks 2–5 |
| `apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts` | replay via `replayMigration` (Task 3) |
| `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` | seed + assertions (Task 6) |
| `apps/api/src/db/autoMigrate.test.ts` | ordering/shape test (Task 5) |

---

### Task 1: Shared constants

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts` (after the `OVERAGE_MODES` block, currently lines 20-26)
- Test: `packages/shared/src/validators/contracts.test.ts` (imports at lines 1-7; append a `describe` at the end, currently line 732)

**Interfaces:**
- Consumes: nothing.
- Produces: `HOUR_BLOCK_LINE_TYPE: 'hour_block'`, `ROLLOVER_POLICIES: readonly ['none','carry_forward']`, `type RolloverPolicy`. `CONTRACT_LINE_TYPES` (`:17`) and `ALLOWANCE_LINE_TYPES` (`:29`) are untouched.

- [ ] **Step 1: Write the failing test.** In `packages/shared/src/validators/contracts.test.ts` change the import block to add the three names plus the two existing arrays:

```ts
import {
  createContractSchema, contractLineInputSchema, updateContractSchema, changeContractCurrencySchema,
  updateContractLineSchema, contractLineInvariantIssues, mergeContractLinePatch, patchHasKey,
  isSiteDeletedLine,
  CONTRACT_LINE_TYPES, ALLOWANCE_LINE_TYPES, HOUR_BLOCK_LINE_TYPE, ROLLOVER_POLICIES,
  type RolloverPolicy,
  type ContractLineShape, type PersistedContractLine,
} from './contracts';
```

Append at the end of the file:

```ts
describe('hour_block constants (#4547 W01)', () => {
  it('exports the line-type literal and the rollover policies', () => {
    expect(HOUR_BLOCK_LINE_TYPE).toBe('hour_block');
    expect([...ROLLOVER_POLICIES]).toEqual(['none', 'carry_forward']);
    const p: RolloverPolicy = 'carry_forward';
    expect(ROLLOVER_POLICIES).toContain(p);
  });

  it('does NOT add hour_block to CONTRACT_LINE_TYPES or ALLOWANCE_LINE_TYPES until W03', () => {
    expect((CONTRACT_LINE_TYPES as readonly string[]).includes(HOUR_BLOCK_LINE_TYPE)).toBe(false);
    expect((ALLOWANCE_LINE_TYPES as readonly string[]).includes(HOUR_BLOCK_LINE_TYPE)).toBe(false);
  });

  it('the line input schema still rejects hour_block, so no API can create one', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'hour_block', description: 'Prepaid hours', unitPrice: '500.00', taxable: false,
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: FAIL — the new `describe` fails (`HOUR_BLOCK_LINE_TYPE` is `undefined`, so `toBe('hour_block')` fails; `[...undefined]` throws "ROLLOVER_POLICIES is not iterable").

- [ ] **Step 3: Implement.** In `packages/shared/src/validators/contracts.ts`, directly after the `OVERAGE_MODES` / `OverageMode` declarations (after line 21's block, before the `ALLOWANCE_LINE_TYPES` doc comment), add:

```ts
// #4547 (block hours) W01. Exported ahead of the feature on purpose: the API's
// fail-closed arms and the audit/coverage types name the literal, but
// CONTRACT_LINE_TYPES (the set the validators and the web editor accept) does
// NOT gain 'hour_block' until W03. The DB twin is contract_line_type /
// contract_lines_hour_block_chk.
export const HOUR_BLOCK_LINE_TYPE = 'hour_block' as const;
export const ROLLOVER_POLICIES = ['none', 'carry_forward'] as const;
export type RolloverPolicy = typeof ROLLOVER_POLICIES[number];
```

- [ ] **Step 4: Run it and watch it pass, then typecheck the package.**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts && npx tsc --noEmit`
Expected: PASS (all tests in the file), `tsc` exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts
git commit -m "feat(billing): shared hour_block constants, not yet accepted by validators (#4547)

Adds HOUR_BLOCK_LINE_TYPE, ROLLOVER_POLICIES and RolloverPolicy. The line-type
and allowance-type sets are unchanged, so nothing can create a block line yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Enum migration, fail-closed arms, error code, typecheck fallout

**Files:**
- Create: `apps/api/migrations/2026-12-14-100000-contract-line-type-hour-block.sql`
- Create: `apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
- Modify: `apps/api/src/db/schema/contracts.ts:16-18` (enum list)
- Modify: `apps/api/src/services/contractTypes.ts` (`:1` import, `:49-115` error union, `:151` audit type)
- Modify: `apps/api/src/services/contractCoverage.ts` (`:7` import, `:25` line type)
- Modify: `apps/api/src/services/contractService.ts` (`:8` area import; helpers after `assertRoleLineHasRoles` `:610-617`; `resolveLineQty` `:674-708`; `updateContractLine` `:1671`; `generateDueInvoice` pre-flight after `:2064` and switch `:2103-2125`)
- Test: `apps/api/src/services/contractService.test.ts` (append after the `generateDueInvoice surfaces price-book gaps` describe, which ends at `:589`)

**Interfaces:**
- Consumes: `HOUR_BLOCK_LINE_TYPE` (Task 1).
- Produces: PG enum value `hour_block` (last label); `contractLineTypeEnum` includes `'hour_block'`; `ContractServiceErrorCode` includes `'HOUR_BLOCK_NOT_ENABLED'`; `ContractLineAudit.lineType` and `CoverageLine.lineType` accept `'hour_block'`.

- [ ] **Step 1: Bring up the integration stack (once; leave it up through Task 7).**

Run: `pnpm test-stack up`
Expected: private Postgres + Redis for this worktree; `.env.test` written at the repo root. (Tear down in Task 7.)

- [ ] **Step 2: Write the failing integration test.** Create `apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts`:

```ts
/**
 * Block hours W01 (#4547): real-DB proof of the schema this wave adds —
 * contract_line_type.hour_block, the contract_lines block columns and CHECKs,
 * the contract_hour_periods ledger (RLS Shape 1, three composite deferrable
 * FKs) and time_entries.contract_line_id.
 *
 * Harness copied from contractLinesAllowanceConstraints.integration.test.ts
 * (seed / insert / pgErrorFields / replay via the superuser client) and
 * billingEvidenceRls.integration.test.ts (breeze_app context + 42501 check).
 * Suite grows across the W01 tasks.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { CONTRACT_LINE_TYPES } from '@breeze/shared';
import { getTestDb } from './setup';

describe('contract_line_type.hour_block (real DB) #4547 W01', () => {
  it('is the last label, and every existing label is still present', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'contract_line_type' ORDER BY e.enumsortorder
    `) as unknown as Array<{ enumlabel: string }>;
    const labels = rows.map((r) => r.enumlabel);
    expect(labels.at(-1)).toBe('hour_block');
    expect(labels).toEqual(expect.arrayContaining([...CONTRACT_LINE_TYPES, 'hour_block']));
  });
});
```

- [ ] **Step 3: Write the failing unit tests.** Append to `apps/api/src/services/contractService.test.ts`:

```ts
// #4547 W01: the enum value exists before the engine does. A forged row must
// fail loudly and bill nothing; W02 replaces the generateDueInvoice arm and W03
// the resolveLineQty arm.
describe('hour_block fails closed until its engine ships (#4547 W01)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const contract = {
    id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'active', currencyCode: 'USD',
    startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-07-01',
    endDate: null, autoIssue: false, createdBy: 'u1', notes: null, terms: null,
  };
  const noAllowance = { includedQuantity: null, overageMode: null, overageUnitPrice: null };
  const flatLine = {
    id: 'cl-flat', lineType: 'flat', description: 'Fee', unitPrice: '80.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: null, siteName: null, deviceRoles: null, ...noAllowance,
  };
  const blockLine = {
    id: 'cl-block', contractId: 'c1', orgId: 'org1', lineType: 'hour_block', description: 'Prepaid hours',
    unitPrice: '500.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, siteName: null,
    deviceRoles: null, deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '95.00',
    rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
    hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null,
  };

  it('generateDueInvoice refuses a forged hour_block line before any invoice exists', async () => {
    queueResult([contract]);                 // locked contract
    queueResult([flatLine, blockLine]);      // lines — the flat line must not be billed either
    await expect(svc.generateDueInvoice('c1', new Date('2026-07-01T06:00:00Z')))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_NOT_ENABLED', status: 500 });
    expect(createManualInvoice).not.toHaveBeenCalled();
    expect(addContractLine).not.toHaveBeenCalled();
  });

  it('computeContractEstimate (resolveLineQty) refuses a forged hour_block line', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' }]);
    queueResult([blockLine]);
    await expect(svc.computeContractEstimate('c1', actor))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_NOT_ENABLED', status: 500 });
  });

  it('updateContractLine refuses to patch a forged hour_block line', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'Acme MSA', status: 'draft', currencyCode: 'USD' }]);
    queueResult([blockLine]);
    await expect(svc.updateContractLine('c1', 'cl-block', { description: 'x' } as never, actor))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_NOT_ENABLED', status: 500 });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });
});
```

- [ ] **Step 4: Run both and watch them fail.**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts -t "hour_block fails closed"`
Expected: FAIL — three failures: the generateDueInvoice case reaches the switch `default` (or a `TypeError` on the unmocked invoice) instead of `HOUR_BLOCK_NOT_ENABLED`; the estimate case throws `INVALID_STATE` ("Unknown contract line type"); the update case does not throw.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
Expected: FAIL — `expected 'manual' to be 'hour_block'` (the test database has no such label yet; `globalSetup` migrates from the files on disk, and file 1 does not exist).

- [ ] **Step 5: Write the migration.** Create `apps/api/migrations/2026-12-14-100000-contract-line-type-hour-block.sql` (exactly this; the ordering test in Task 5 asserts it is a single statement):

```sql
-- #4547 W01 (block hours): the hour_block contract line type.
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate wraps
-- each file in one, so every statement that names the new value lives in
-- 2026-12-14-100100-contract-lines-hour-block.sql and later.
-- (Precedent: 2026-10-06-100000-contract-line-type-per-device-group.sql.)
--
-- ADD VALUE appends to the end of the enum, which is why the Drizzle list in
-- apps/api/src/db/schema/contracts.ts names it last.

ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'hour_block';
```

- [ ] **Step 6: Drizzle enum.** In `apps/api/src/db/schema/contracts.ts` replace lines 16-18:

```ts
export const contractLineTypeEnum = pgEnum('contract_line_type', [
  'flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual', 'hour_block'
]);
```

- [ ] **Step 7: Error code and widened audit type.** In `apps/api/src/services/contractTypes.ts`:

Replace line 1:

```ts
import type { ContractLineType, HOUR_BLOCK_LINE_TYPE } from '@breeze/shared';
```

(`HOUR_BLOCK_LINE_TYPE` is a value; it is used below only in `typeof`, which `import type` permits.)

Replace the tail of the error union (`| 'CATALOG_ITEM_NOT_FOUND';`, currently line 115) with:

```ts
  | 'CATALOG_ITEM_NOT_FOUND'
  // #4547 W01: an hour_block row reached a billing/estimate path before the
  // engine that understands it shipped. 500: only a hand-forged row gets here,
  // because no validator accepts the type until W03.
  | 'HOUR_BLOCK_NOT_ENABLED';
```

Replace line 151 (`  lineType: ContractLineType;` inside `ContractLineAudit`):

```ts
  // Widened (not ContractLineType): this is filled from persisted rows, whose
  // Drizzle type now includes 'hour_block'. CONTRACT_LINE_TYPES is unchanged.
  lineType: ContractLineType | typeof HOUR_BLOCK_LINE_TYPE;
```

- [ ] **Step 8: Widen `CoverageLine`.** In `apps/api/src/services/contractCoverage.ts` replace line 7 and line 25:

```ts
import type { ContractLineType, HOUR_BLOCK_LINE_TYPE } from '@breeze/shared';
```

```ts
  // Widened for persisted rows (see ContractLineAudit); matchReason's default
  // arm already returns null for any non-device type, so an hour_block row
  // matches no device.
  lineType: ContractLineType | typeof HOUR_BLOCK_LINE_TYPE;
```

- [ ] **Step 9: Service helpers and arms.** In `apps/api/src/services/contractService.ts`:

(a) Add `type ContractLineType` to the existing value import from `'@breeze/shared'` (the block at lines 9-14 ends `type DeviceRole, type UpdateContractLineInput,`):

```ts
  type ContractLineType, type DeviceRole, type UpdateContractLineInput,
```

(b) Directly after `assertRoleLineHasRoles` (closing brace at line 617, before the `BILLABLE_DEVICE_ROLE_SET` constant), add:

```ts
/** #4547 W01: the fail-closed error for an hour_block row reaching a path that
 *  cannot price it. W02 replaces the generateDueInvoice arm; W03 the
 *  resolveLineQty arm and the updateContractLine guard. */
function hourBlockNotEnabled(): ContractServiceError {
  return new ContractServiceError('hour_block lines are not enabled', 500, 'HOUR_BLOCK_NOT_ENABLED');
}

/** Throws on a block row; otherwise narrows the row's `lineType` to the shared
 *  ContractLineType so the pure shared helpers (which are typed against
 *  CONTRACT_LINE_TYPES) accept it. */
function assertNotHourBlock<T extends { lineType: string }>(
  line: T,
): asserts line is T & { lineType: ContractLineType } {
  if (line.lineType === 'hour_block') throw hourBlockNotEnabled();
}
```

(c) In `resolveLineQty`, add an arm immediately before `default:` (currently line 702, after the `per_seat` case):

```ts
    case 'hour_block':
      // #4547 W01: the DB accepts the type, the engine does not exist yet. A
      // forged row must fail loudly, never count as a quantity. W03 replaces
      // this with the fee-only arm.
      throw hourBlockNotEnabled();
```

(d) In `updateContractLine`, directly after `if (!current) throw new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND');` (line 1671):

```ts
    assertNotHourBlock(current);
```

(e) In `generateDueInvoice`, directly after the `#4693` site-deleted loop closes (line 2064) and before `const hasDeviceLine = lines.some(isDeviceLine);` (line 2066):

```ts
  // #4547 W01: same no-write rule as the site check above. Refuse before the
  // draft invoice exists, so a forged hour_block row can neither bill nor leave
  // a half-built invoice for the caller's transaction to roll back.
  for (const l of lines) {
    if (l.lineType === 'hour_block') throw hourBlockNotEnabled();
  }
```

(f) In the `generateDueInvoice` line switch, add an arm immediately before `default:` (currently ~line 2121, after `case 'per_seat':`):

```ts
      case 'hour_block':
        // Unreachable: the pre-flight above refuses first. Kept so the switch
        // stays exhaustive; W02 replaces it with the fee-only arm.
        throw hourBlockNotEnabled();
```

- [ ] **Step 10: Typecheck — mandatory, and read the whole output.** Widening the Drizzle enum can surface errors this plan could not enumerate without a compiler.

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "exit=$?"` (do not pipe to `tail`; an out-of-memory crash masks as green)
Expected: `exit=0`. If errors remain, they are the same class as the three seats above (a persisted row's `lineType` flowing into a parameter typed `ContractLineType`). Fix each by (i) widening the receiving type with `| typeof HOUR_BLOCK_LINE_TYPE` when the code is a pure reader that already has a `default`/non-device branch, or (ii) calling `assertNotHourBlock(row)` at the read site when the code must not process a block row. Do **not** add `'hour_block'` to `CONTRACT_LINE_TYPES`. Record every extra site you touch in the commit message.

Then: `cd packages/shared && npx tsc --noEmit ; echo "exit=$?"` (expected `exit=0`) and `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit ; echo "exit=$?"` (web imports `ContractLineType` from shared only, so no change is expected).

- [ ] **Step 11: Run and watch them pass.**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts src/services/contractService.siteScope.test.ts`
Expected: PASS (the three new cases and every pre-existing case).

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 12: Commit.**

```bash
git add apps/api/migrations/2026-12-14-100000-contract-line-type-hour-block.sql \
  apps/api/src/db/schema/contracts.ts apps/api/src/services/contractTypes.ts \
  apps/api/src/services/contractCoverage.ts apps/api/src/services/contractService.ts \
  apps/api/src/services/contractService.test.ts \
  apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts
git commit -m "feat(billing): hour_block line type fails closed until its engine ships (#4547)

Adds the enum value in its own migration, explicit hour_block arms in
resolveLineQty and generateDueInvoice (HOUR_BLOCK_NOT_ENABLED, 500), a
no-write pre-flight before the draft invoice, and widens the audit/coverage
row types. No validator accepts the type, so nothing can create a block line.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `contract_lines` columns, CHECKs, live-block index, Drizzle, export policy

**Files:**
- Create: `apps/api/migrations/2026-12-14-100100-contract-lines-hour-block.sql`
- Modify: `apps/api/src/db/schema/contracts.ts` (`:1` import, `:88` columns, `:104` index)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:322` (`contract_lines` row)
- Modify: `apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts` (imports at `:12-20`, the replay test at `:145-153`)

**Interfaces:**
- Consumes: enum value (Task 2).
- Produces: `contract_lines.rollover_policy | rollover_cap_hours | hour_block_alert_pct | hour_block_first_period_start | hour_block_retired_at`; constraints `contract_lines_allowance_chk` (re-added), `contract_lines_hour_block_chk`; unique index `contract_lines_one_live_hour_block_per_org_uq`; Drizzle `contractLines.rolloverPolicy | rolloverCapHours | hourBlockAlertPct | hourBlockFirstPeriodStart | hourBlockRetiredAt`.

- [ ] **Step 1: Write the failing tests.** In `contractHourBlockSchema.integration.test.ts` replace the import block with:

```ts
import './setup';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { CONTRACT_LINE_TYPES } from '@breeze/shared';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';
```

Append (after the existing enum `describe`):

```ts
const MIGRATIONS_DIR = join(__dirname, '../../../migrations/');
const F_LINES = '2026-12-14-100100-contract-lines-hour-block.sql';
const F_ALLOWANCE_OLD = '2026-10-08-100200-contract-lines-allowance-overage.sql';

async function replay(file: string): Promise<void> {
  await getTestDb().execute(sql.raw(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')));
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const admin = getTestDb();
  const mkContract = async (orgId: string) => {
    const id = randomUUID();
    await admin.execute(sql`
      INSERT INTO contracts (id, partner_id, org_id, name, interval_months, start_date, currency_code)
      VALUES (${id}::uuid, ${partner.id}::uuid, ${orgId}::uuid, 'Block hours', 1, '2026-12-01', 'USD')
    `);
    return id;
  };
  return {
    partnerId: partner.id as string,
    orgA: orgA.id as string,
    orgB: orgB.id as string,
    contractA: await mkContract(orgA.id as string),
    contractB: await mkContract(orgB.id as string),
  };
}
type F = Awaited<ReturnType<typeof seed>>;

type LineOpts = {
  lineType?: string; included?: string | null; mode?: string | null; price?: string | null;
  rollover?: string | null; cap?: string | null; alertPct?: number | null; first?: string | null;
  retiredAt?: string | null; siteId?: string | null; siteName?: string | null;
  manualQuantity?: string | null; contractId?: string; orgId?: string;
};

/** Insert one line as the superuser (superuser connection: RLS not applied, CHECKs and FKs still apply).
 *  Defaults to a VALID live hour_block; each test overrides the field under test. */
async function insertLine(f: F, o: LineOpts = {}): Promise<Array<{ id: string }>> {
  const v = {
    lineType: 'hour_block', included: '10.00', mode: 'bill', price: '95.00', rollover: 'none',
    cap: null, alertPct: null, first: '2026-12-01', retiredAt: null, siteId: null, siteName: null,
    manualQuantity: null, contractId: f.contractA, orgId: f.orgA, ...o,
  } as Required<LineOpts>;
  return await getTestDb().execute(sql`
    INSERT INTO contract_lines
      (contract_id, org_id, line_type, description, unit_price, taxable, site_id, site_name, manual_quantity,
       included_quantity, overage_mode, overage_unit_price,
       rollover_policy, rollover_cap_hours, hour_block_alert_pct, hour_block_first_period_start, hour_block_retired_at)
    VALUES
      (${v.contractId}::uuid, ${v.orgId}::uuid, ${v.lineType}::contract_line_type, 'Prepaid hours', 500.00, false,
       ${v.siteId}::uuid, ${v.siteName}, ${v.manualQuantity}::numeric,
       ${v.included}::numeric, ${v.mode}::contract_overage_mode, ${v.price}::numeric,
       ${v.rollover}, ${v.cap}::numeric, ${v.alertPct}::int, ${v.first}::date, ${v.retiredAt}::timestamptz)
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

/** A line that is not a block: the allowance columns and every block column off. */
const FLAT: LineOpts = { lineType: 'flat', included: null, mode: null, price: null, rollover: null, first: null };

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

/** The operation must fail with `code`, and the constraint that fired must be one of `constraints`.
 *  Postgres evaluates CHECKs in name order, so a row that violates two reports the earlier name. */
async function expectConstraint(
  op: () => Promise<unknown>, code: string, constraints: string[], label: string,
): Promise<void> {
  let raised: unknown;
  try { await op(); } catch (error) { raised = error; }
  if (raised === undefined) throw new Error(`expected ${code} on ${constraints.join(' | ')}: ${label}`);
  const f = pgErrorFields(raised);
  expect(f.code, label).toBe(code);
  expect(constraints, label).toContain(f.constraint);
}

const HB = 'contract_lines_hour_block_chk';
const AL = 'contract_lines_allowance_chk';
const SITE_STAMP = 'contract_lines_site_stamp_chk';
const LIVE_UQ = 'contract_lines_one_live_hour_block_per_org_uq';

describe('contract_lines hour_block CHECKs (real DB) #4547 W01', () => {
  it('rejects each malformed block, naming the constraint that fires', async () => {
    const f = await seed();
    const [site] = await getTestDb().execute(sql`
      INSERT INTO sites (org_id, name) VALUES (${f.orgA}::uuid, 'HQ') RETURNING id
    `) as unknown as Array<{ id: string }>;
    const cases: Array<[string, LineOpts, string[]]> = [
      // Required fields NULL. (included_quantity NULL also needs mode/price NULL, or the allowance CHECK fires first.)
      ['included_quantity NULL', { included: null, mode: null, price: null }, [HB]],
      ['overage_mode NULL', { mode: null, price: null }, [AL, HB]],
      ['overage_mode flag (Open Decision 10 A)', { mode: 'flag', price: null }, [HB]],
      ['overage price NULL under bill', { price: null }, [AL]],
      ['rollover_policy NULL', { rollover: null }, [HB]],
      ['rollover_policy not in the set', { rollover: 'weekly' }, [HB]],
      ['hour_block_first_period_start NULL', { first: null }, [HB]],
      // Zero hours; the allowance CHECK's "> 0" conjunct.
      ['included_quantity 0', { included: '0.00' }, [AL]],
      // Scoping columns a block may not carry.
      ['site_id on a block', { siteId: site!.id, siteName: 'HQ' }, [HB, SITE_STAMP]],
      ['manual_quantity on a block', { manualQuantity: '2.00' }, [HB]],
      // Cap only under carry_forward, and > 0.
      ['rollover_cap_hours under none', { rollover: 'none', cap: '5.00' }, [HB]],
      ['rollover_cap_hours 0 under carry_forward', { rollover: 'carry_forward', cap: '0.00' }, [HB]],
      // Alert percentage is 1..100.
      ['alert_pct 0', { alertPct: 0 }, [HB]],
      ['alert_pct 101', { alertPct: 101 }, [HB]],
    ];
    for (const [label, opts, constraints] of cases) {
      await expectConstraint(() => insertLine(f, opts), '23514', constraints, label);
    }
  });

  it('accepts fractional hours and every legal combination (retired, so the live-block index is not in play)', async () => {
    const f = await seed();
    const retiredAt = '2026-12-02T00:00:00Z';
    const accepted: Array<[string, LineOpts]> = [
      ['plain block', {}],
      ['7.5 hours (fractional — exempt from the integrality conjunct)', { included: '7.50' }],
      ['carry_forward, uncapped', { rollover: 'carry_forward', cap: null }],
      ['carry_forward, capped 40.5h', { rollover: 'carry_forward', cap: '40.50' }],
      ['alert_pct 1', { alertPct: 1 }],
      ['alert_pct 100', { alertPct: 100 }],
      ['overage rate 0.00 (itemised at no charge)', { price: '0.00' }],
    ];
    for (const [label, opts] of accepted) {
      await expect(insertLine(f, { retiredAt, ...opts }), label).resolves.toHaveLength(1);
    }
  });

  it('rejects every block-only column on a non-block line and accepts a plain flat line', async () => {
    const f = await seed();
    await expect(insertLine(f, FLAT)).resolves.toHaveLength(1);
    const onFlat: Array<[string, LineOpts]> = [
      ['rollover_policy', { rollover: 'none' }],
      ['rollover_cap_hours', { cap: '5.00' }],
      ['hour_block_alert_pct', { alertPct: 50 }],
      ['hour_block_first_period_start', { first: '2026-12-01' }],
      ['hour_block_retired_at', { retiredAt: '2026-12-02T00:00:00Z' }],
    ];
    for (const [label, opts] of onFlat) {
      await expectConstraint(() => insertLine(f, { ...FLAT, ...opts }), '23514', [HB], `${label} on flat`);
    }
    // And on a counted type that legitimately carries an allowance.
    await expectConstraint(
      () => insertLine(f, { lineType: 'per_device', included: '25.00', mode: 'flag', price: null, rollover: null, first: null, retiredAt: '2026-12-02T00:00:00Z' }),
      '23514', [HB], 'retired_at on per_device',
    );
  });

  it('the fractional-hours exemption does not leak to device lines', async () => {
    const f = await seed();
    await expectConstraint(
      () => insertLine(f, { lineType: 'per_device', included: '25.50', mode: 'flag', price: null, rollover: null, first: null }),
      '23514', [AL], 'fractional included on per_device',
    );
  });

  it('allows one live block per org, frees the slot when it is retired, and is per org', async () => {
    const f = await seed();
    const [first] = await insertLine(f);
    await expectConstraint(() => insertLine(f), '23505', [LIVE_UQ], 'second live block, same org');
    await expect(insertLine(f, { contractId: f.contractB, orgId: f.orgB }), 'other org').resolves.toHaveLength(1);
    // A retired block never counts, so any number of them may sit beside a live one.
    await expect(insertLine(f, { retiredAt: '2026-12-02T00:00:00Z' })).resolves.toHaveLength(1);
    await getTestDb().execute(sql`UPDATE contract_lines SET hour_block_retired_at = now() WHERE id = ${first!.id}::uuid`);
    await expect(insertLine(f), 'successor after retirement').resolves.toHaveLength(1);
  });

  it('re-applying the migration is a no-op and the CHECKs still fire', async () => {
    const f = await seed();
    await replay(F_LINES);
    await expectConstraint(() => insertLine(f, { rollover: 'weekly' }), '23514', [HB], 'after replay');
    await expect(insertLine(f, { included: '7.50' })).resolves.toHaveLength(1);
  });

  it('replaying the OLDER allowance migration (as contractLinesAllowanceConstraints does) leaves hour_block admitted', async () => {
    const f = await seed();
    // replayMigration re-applies every later file that rewrites the same
    // constraint name, so this file's DROP + re-ADD (without hour_block) is
    // followed by F_LINES. A bare db.execute of the old file would not be.
    await replayMigration(F_ALLOWANCE_OLD);
    await expect(insertLine(f, { included: '7.50' })).resolves.toHaveLength(1);
  });
});
```

Also rewrite the replay test in `contractLinesAllowanceConstraints.integration.test.ts`. Its imports (lines 12-20) currently are:

```ts
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { partners, organizations, contracts } from '../../db/schema';
```

Replace them with (`readFileSync`, `join` and `getTestDb` were used only by the replay test):

```ts
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { replayMigration } from './replayMigration';
import { partners, organizations, contracts } from '../../db/schema';
```

Replace the body of the last test (lines 145-153):

```ts
  it('re-applying the migration is a no-op and the CHECK still fires', async () => {
    const f = await seed();
    // replayMigration, not a bare execute: #4547 re-adds this same CHECK in a
    // later file (with hour_block in its type list), and a bare replay would
    // leave the narrower definition in force for every later suite in the shard.
    await replayMigration(MIGRATION);
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: I }), 'after replay');
    await expect(insertLine(f, { lineType: 'per_device', includedQuantity: I, overageMode: 'flag' })).resolves.toBeDefined();
  });
```

- [ ] **Step 2: Run and watch it fail.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
Expected: FAIL — `column "rollover_policy" of relation "contract_lines" does not exist` (42703) in every `insertLine` test.

- [ ] **Step 3: Write the migration.** Create `apps/api/migrations/2026-12-14-100100-contract-lines-hour-block.sql`:

```sql
-- #4547 W01 (block hours): the hour_block columns on contract_lines and the
-- CHECKs that make a block line well-formed.
-- Spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
-- Contract: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md (C2).
--
-- Requires 2026-12-14-100000 (the enum value must already be committed). This
-- file writes no rows, so it needs no system-scope election.
--
-- Fields reuse the shipped allowance columns (#4607): included_quantity is the
-- block's hours, overage_unit_price its overage rate, overage_mode must be
-- 'bill' on a block (Decision 3 A; Open Decision 10 A).

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS rollover_policy text;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS rollover_cap_hours numeric(12,2);
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS hour_block_alert_pct integer;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS hour_block_first_period_start date;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS hour_block_retired_at timestamptz;

COMMENT ON COLUMN contract_lines.hour_block_first_period_start IS
  'First billing period this block entitles hours for. Server-stamped at insert (never client-supplied, never patchable); a block added mid-period starts at the NEXT period so no free hours are granted.';
COMMENT ON COLUMN contract_lines.hour_block_retired_at IS
  'NULL = live. Set instead of deleting a block that has closed periods, and when the contract expires or is cancelled; frees the one-live-block-per-org index.';

-- contract_lines_allowance_chk, re-added: 'hour_block' joins the type list and is
-- exempt from the integrality conjunct (hours are fractional; devices and seats
-- are not). Every other conjunct and the ELSE branch are unchanged. DROP + re-ADD
-- is the only way to widen a shipped CHECK (2026-10-08-100200 is content-hash
-- immutable). Every conjunct is NULL-safe: each side of every `=` is a non-null
-- boolean and the CASE is total.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_allowance_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_allowance_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat', 'hour_block') THEN
    ((included_quantity IS NULL) = (overage_mode IS NULL))
    AND (included_quantity IS NULL OR included_quantity > 0)
    -- Devices and seats are whole; hours are not (#4547).
    AND (line_type = 'hour_block' OR included_quantity IS NULL OR included_quantity = floor(included_quantity))
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  ELSE
    included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  END
);

-- The block's own shape. Total over line_type: a block carries every required
-- column and no scoping column; every other type carries none of the five new
-- columns. NULL-safe — each conjunct is a non-null boolean (IS NULL / IS NOT
-- NULL / IS NOT DISTINCT FROM), and the two OR arms guard their comparisons.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_hour_block_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_hour_block_chk CHECK (
  CASE WHEN line_type = 'hour_block' THEN
    included_quantity IS NOT NULL
    AND overage_mode IS NOT DISTINCT FROM 'bill'
    AND site_id IS NULL AND site_name IS NULL
    AND device_roles IS NULL AND device_group_id IS NULL AND device_group_name IS NULL
    AND manual_quantity IS NULL
    AND rollover_policy IS NOT NULL AND rollover_policy IN ('none', 'carry_forward')
    AND (rollover_cap_hours IS NULL OR (rollover_policy = 'carry_forward' AND rollover_cap_hours > 0))
    AND (hour_block_alert_pct IS NULL OR hour_block_alert_pct BETWEEN 1 AND 100)
    AND hour_block_first_period_start IS NOT NULL
  ELSE
    rollover_policy IS NULL AND rollover_cap_hours IS NULL AND hour_block_alert_pct IS NULL
    AND hour_block_first_period_start IS NULL AND hour_block_retired_at IS NULL
  END
);

-- One LIVE block per org (Decision 2). Retired blocks do not count, so a
-- successor contract can start a new block once the old one is retired.
CREATE UNIQUE INDEX IF NOT EXISTS contract_lines_one_live_hour_block_per_org_uq
  ON contract_lines (org_id)
  WHERE line_type = 'hour_block' AND hour_block_retired_at IS NULL;
```

- [ ] **Step 4: Drizzle.** In `apps/api/src/db/schema/contracts.ts`:

Line 1 becomes:

```ts
import type { DeviceRole, RolloverPolicy } from '@breeze/shared';
```

After `overageUnitPrice` (line 88) add (inside `contractLines`, before `deviceGroupId`'s comment):

```ts
  // #4547 W01: hour_block columns. NULL on every other line type. The shape is
  // pinned by contract_lines_hour_block_chk (SQL-only, like the allowance and
  // device-role CHECKs above); contract_lines_allowance_chk was re-added to list
  // 'hour_block' and exempt it from integrality. included_quantity /
  // overage_mode / overage_unit_price above double as the block's hours and
  // overage terms. hour_block_first_period_start is server-stamped at insert.
  rolloverPolicy: text('rollover_policy').$type<RolloverPolicy>(),
  rolloverCapHours: numeric('rollover_cap_hours', { precision: 12, scale: 2 }),
  hourBlockAlertPct: integer('hour_block_alert_pct'),
  hourBlockFirstPeriodStart: date('hour_block_first_period_start'),
  hourBlockRetiredAt: timestamp('hour_block_retired_at', { withTimezone: true }),
```

In the table's index list, directly after `uniqueIndex('contract_lines_id_org_uq').on(t.id, t.orgId)` (line 104), add a comma and:

```ts
  // #4547: one LIVE block per org. The real partial unique index lives in SQL
  // (2026-12-14-100100); this mirrors it so db:check-drift stays clean.
  uniqueIndex('contract_lines_one_live_hour_block_per_org_uq').on(t.orgId)
    .where(sql`${t.lineType} = 'hour_block' AND ${t.hourBlockRetiredAt} IS NULL`),
```

- [ ] **Step 5: Export policy (red first, then green).** Run the export-policy suite before editing the registry:

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: FAIL — the suite names `contract_lines` columns `rollover_policy`, `rollover_cap_hours`, `hour_block_alert_pct`, `hour_block_first_period_start`, `hour_block_retired_at` as unclassified.

Then in `apps/api/src/services/tenantExportPolicyRegistry.ts` replace line 322 with (five columns appended after `"overage_unit_price"`; all `included` — none is `json`/`jsonb`/`bytea` and none matches a suspicious-name part):

```ts
  "contract_lines": tablePolicy("org_id", {"included":["id","contract_id","org_id","line_type","description","catalog_item_id","unit_price","manual_quantity","site_id","site_name","device_roles","device_group_id","device_group_name","included_quantity","overage_mode","overage_unit_price","rollover_policy","rollover_cap_hours","hour_block_alert_pct","hour_block_first_period_start","hour_block_retired_at","taxable","sort_order","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 6: Run and watch it pass.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: PASS. Check the reported file count is 6 (a path filter is a substring match).

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "exit=$?"` — expected `exit=0`.

- [ ] **Step 7: Commit.**

```bash
git add apps/api/migrations/2026-12-14-100100-contract-lines-hour-block.sql \
  apps/api/src/db/schema/contracts.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts \
  apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts
git commit -m "feat(billing): contract_lines hour_block columns, CHECKs and live-block index (#4547)

Five columns, the allowance CHECK re-added with hour_block (fractional hours
exempt), the block shape CHECK, and one live block per org. Export policy
classifies the new columns in the same commit. The allowance replay test now
uses replayMigration so the older file cannot narrow the CHECK for later suites.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `contract_hour_periods` table, RLS, Drizzle, registrations

**Files:**
- Create: `apps/api/migrations/2026-12-14-100200-contract-hour-periods.sql`
- Modify: `apps/api/src/db/schema/contracts.ts` (new export after `contractBillingPeriods`, currently ends `:119`)
- Modify: `apps/api/src/services/tenantCascade.ts:488-489`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:321-322`
- Modify: `apps/api/src/services/orgMergeRegistry.ts:833-834`
- Modify: `apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts`

**Interfaces:**
- Consumes: `contract_lines (id, org_id)` unique index `contract_lines_id_org_uq` (`2026-06-18-a-pax8-billing-sync.sql:136`), `contracts_id_org_uq` (`2026-09-02-a-invoice-line-source-contract-lineage.sql:23`), `invoices_id_org_uq` (`2026-06-15-b-invoice-engine-constraints.sql:12`) — all already shipped.
- Produces: table `contract_hour_periods` (columns per index C3), `UNIQUE INDEX contract_hour_periods_line_period_uq`, indexes `contract_hour_periods_org_idx`, `contract_hour_periods_contract_idx`, FKs `contract_hour_periods_contract_org_fk | _line_org_fk | _invoice_org_fk`, RLS policies; Drizzle `contractHourPeriods`.

- [ ] **Step 1: Write the failing tests.** In `contractHourBlockSchema.integration.test.ts` add to the imports:

```ts
import { db, withDbAccessContext } from '../../db';
```

Append:

```ts
const F_LEDGER = '2026-12-14-100200-contract-hour-periods.sql';
const LEDGER_FKS = [
  'contract_hour_periods_contract_org_fk',
  'contract_hour_periods_line_org_fk',
  'contract_hour_periods_invoice_org_fk',
] as const;

type PeriodOpts = {
  lineId: string; contractId: string; orgId: string;
  periodStart?: string; periodEnd?: string; consumed?: string; overage?: string;
  closeSource?: string; invoiceId?: string | null;
};
type Exec = { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown> };

/** Insert one ledger row through `exec` (the superuser client by default; the
 *  breeze_app `db` inside withDbAccessContext for the RLS tests). */
async function insertPeriod(o: PeriodOpts, exec: Exec = getTestDb() as unknown as Exec): Promise<Array<{ id: string }>> {
  const v = {
    periodStart: '2026-12-01', periodEnd: '2027-01-01', consumed: '7.50', overage: '0.00',
    closeSource: 'billing_run', invoiceId: null, ...o,
  };
  return await exec.execute(sql`
    INSERT INTO contract_hour_periods
      (contract_line_id, contract_id, org_id, period_start, period_end,
       included_hours, carried_in_hours, consumed_hours, overage_hours, carried_out_hours,
       entry_count, overage_unit_price, currency_code, overage_invoice_id, close_source)
    VALUES
      (${v.lineId}::uuid, ${v.contractId}::uuid, ${v.orgId}::uuid, ${v.periodStart}::date, ${v.periodEnd}::date,
       10.00, 0.00, ${v.consumed}::numeric, ${v.overage}::numeric, 2.50,
       3, 95.00, 'USD', ${v.invoiceId}::uuid, ${v.closeSource})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

async function seedLedger() {
  const f = await seed();
  const [a] = await insertLine(f);
  const [b] = await insertLine(f, { contractId: f.contractB, orgId: f.orgB });
  return { ...f, lineA: a!.id, lineB: b!.id };
}

const ctxFor = (orgId: string, partnerId: string) =>
  ({ scope: 'organization' as const, orgId, partnerId, accessibleOrgIds: [orgId], userId: null });

describe('contract_hour_periods (real DB) #4547 W01', () => {
  it('stores fractional hours exactly and enforces one row per (line, period_start)', async () => {
    const f = await seedLedger();
    const base = { lineId: f.lineA, contractId: f.contractA, orgId: f.orgA };
    await expect(insertPeriod(base)).resolves.toHaveLength(1);
    const [row] = await getTestDb().execute(sql`
      SELECT consumed_hours::text AS c, carried_out_hours::text AS o, foreign_currency_hours::text AS fx
      FROM contract_hour_periods WHERE contract_line_id = ${f.lineA}::uuid
    `) as unknown as Array<{ c: string; o: string; fx: string }>;
    expect(row).toEqual({ c: '7.50', o: '2.50', fx: '0.00' });
    await expectConstraint(() => insertPeriod(base), '23505', ['contract_hour_periods_line_period_uq'], 'double close of one period');
    await expect(insertPeriod({ ...base, periodStart: '2027-01-01', periodEnd: '2027-02-01' })).resolves.toHaveLength(1);
  });

  it('rejects an inverted period, a negative hours column and an unknown close_source', async () => {
    const f = await seedLedger();
    const base = { lineId: f.lineA, contractId: f.contractA, orgId: f.orgA };
    await expectConstraint(() => insertPeriod({ ...base, periodEnd: '2026-12-01' }), '23514', ['contract_hour_periods_period_chk'], 'period_end = period_start');
    await expectConstraint(() => insertPeriod({ ...base, consumed: '-0.01' }), '23514', ['contract_hour_periods_hours_nonneg_chk'], 'negative consumed');
    await expectConstraint(() => insertPeriod({ ...base, overage: '-1.00' }), '23514', ['contract_hour_periods_hours_nonneg_chk'], 'negative overage');
    await expectConstraint(() => insertPeriod({ ...base, closeSource: 'manual' }), '23514', ['contract_hour_periods_close_source_chk'], 'close_source');
  });

  it('rejects a row whose line, contract or invoice belongs to another org — as system context, so only the FK can be the guard', async () => {
    const f = await seedLedger();
    const [inv] = await getTestDb().execute(sql`
      INSERT INTO invoices (partner_id, org_id, currency_code, status)
      VALUES (${f.partnerId}::uuid, ${f.orgA}::uuid, 'USD', 'draft') RETURNING id
    `) as unknown as Array<{ id: string }>;
    // Row is for org B; the line is org A's.
    await expectConstraint(
      () => insertPeriod({ lineId: f.lineA, contractId: f.contractB, orgId: f.orgB }),
      '23503', ['contract_hour_periods_line_org_fk'], 'line from another org');
    // Row is for org B; the contract is org A's.
    await expectConstraint(
      () => insertPeriod({ lineId: f.lineB, contractId: f.contractA, orgId: f.orgB }),
      '23503', ['contract_hour_periods_contract_org_fk'], 'contract from another org');
    // Row is for org B; the overage invoice is org A's.
    await expectConstraint(
      () => insertPeriod({ lineId: f.lineB, contractId: f.contractB, orgId: f.orgB, invoiceId: inv!.id }),
      '23503', ['contract_hour_periods_invoice_org_fk'], 'invoice from another org');
  });

  it('deleting a block line that has a ledger row is refused (RESTRICT), and allowed once the ledger row is gone', async () => {
    const f = await seedLedger();
    await insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA });
    // Postgres reports RESTRICT as foreign_key_violation (23503).
    await expectConstraint(
      () => getTestDb().execute(sql`DELETE FROM contract_lines WHERE id = ${f.lineA}::uuid`),
      '23503', ['contract_hour_periods_line_org_fk'], 'delete block with history');
    await getTestDb().execute(sql`DELETE FROM contract_hour_periods WHERE contract_line_id = ${f.lineA}::uuid`);
    await expect(getTestDb().execute(sql`DELETE FROM contract_lines WHERE id = ${f.lineA}::uuid`)).resolves.toBeDefined();
  });

  it('deleting the overage invoice nulls only overage_invoice_id (the SET NULL column list keeps org_id)', async () => {
    const f = await seedLedger();
    const [inv] = await getTestDb().execute(sql`
      INSERT INTO invoices (partner_id, org_id, currency_code, status)
      VALUES (${f.partnerId}::uuid, ${f.orgA}::uuid, 'USD', 'draft') RETURNING id
    `) as unknown as Array<{ id: string }>;
    await insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA, overage: '1.00', invoiceId: inv!.id });
    await getTestDb().execute(sql`DELETE FROM invoices WHERE id = ${inv!.id}::uuid`);
    const [row] = await getTestDb().execute(sql`
      SELECT overage_invoice_id, org_id FROM contract_hour_periods WHERE contract_line_id = ${f.lineA}::uuid
    `) as unknown as Array<{ overage_invoice_id: string | null; org_id: string }>;
    expect(row).toEqual({ overage_invoice_id: null, org_id: f.orgA });
  });

  it('all three composite FKs are DEFERRABLE INITIALLY IMMEDIATE, with the intended delete actions', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT conname, condeferrable, condeferred, confdeltype::text AS del, (confdelsetcols IS NOT NULL) AS has_cols
      FROM pg_constraint WHERE conrelid = 'public.contract_hour_periods'::regclass AND contype = 'f'
      ORDER BY conname
    `) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean; del: string; has_cols: boolean }>;
    const byName = new Map(rows.map((r) => [r.conname, r]));
    for (const name of LEDGER_FKS) {
      expect(byName.get(name), name).toMatchObject({ condeferrable: true, condeferred: false });
    }
    expect(byName.get('contract_hour_periods_contract_org_fk')!.del).toBe('c'); // CASCADE
    expect(byName.get('contract_hour_periods_line_org_fk')!.del).toBe('r');     // RESTRICT
    expect(byName.get('contract_hour_periods_invoice_org_fk')).toMatchObject({ del: 'n', has_cols: true }); // SET NULL (overage_invoice_id)
  });

  it('RLS is enabled and forced with the four org-isolation policies, and breeze_app holds the grants', async () => {
    const [cls] = await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.contract_hour_periods'::regclass
    `) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await getTestDb().execute(sql`
      SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_hour_periods' ORDER BY policyname
    `) as unknown as Array<{ policyname: string; cmd: string }>;
    expect(policies).toEqual([
      { policyname: 'breeze_org_isolation_delete', cmd: 'DELETE' },
      { policyname: 'breeze_org_isolation_insert', cmd: 'INSERT' },
      { policyname: 'breeze_org_isolation_select', cmd: 'SELECT' },
      { policyname: 'breeze_org_isolation_update', cmd: 'UPDATE' },
    ]);
  });

  it('as breeze_app: a row for another org is rejected with 42501; each org sees only its own ledger', async () => {
    const f = await seedLedger();
    await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () =>
      insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA }, db as unknown as Exec));
    // Forged: org-A context writing a row stamped for org B (the FK targets all exist in B).
    let raised: unknown;
    try {
      await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () =>
        insertPeriod({ lineId: f.lineB, contractId: f.contractB, orgId: f.orgB }, db as unknown as Exec));
    } catch (error) { raised = error; }
    expect(raised, 'expected forced RLS to reject the row').toBeDefined();
    const wrapped = raised as { code?: string; cause?: { code?: string; message?: string } };
    expect(wrapped.cause?.code ?? wrapped.code).toBe('42501');
    expect(wrapped.cause?.message).toMatch(/new row violates row-level security policy/);
    const inA = await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () =>
      db.execute(sql`SELECT id FROM contract_hour_periods`));
    const inB = await withDbAccessContext(ctxFor(f.orgB, f.partnerId), () =>
      db.execute(sql`SELECT id FROM contract_hour_periods`));
    expect(inA.length).toBe(1);
    expect(inB.length).toBe(0);
  });

  it('re-applying the migration is a no-op: the row survives and the policies and FKs are unchanged', async () => {
    const f = await seedLedger();
    await insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA });
    await replay(F_LEDGER);
    const [n] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM contract_hour_periods`) as unknown as Array<{ n: number }>;
    expect(n!.n).toBe(1);
    const fks = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.contract_hour_periods'::regclass AND contype = 'f' AND condeferrable AND NOT condeferred
    `) as unknown as Array<{ n: number }>;
    expect(fks[0]!.n).toBe(3);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
Expected: FAIL — `relation "contract_hour_periods" does not exist` (42P01) in the new describe; the earlier Task 2/3 tests still pass.

- [ ] **Step 3: Write the migration.** Create `apps/api/migrations/2026-12-14-100200-contract-hour-periods.sql`:

```sql
-- #4547 W01 (block hours): the contract_hour_periods ledger.
-- Spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md §3
-- Contract: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md (C3).
--
-- One row per CLOSED block period: what the block included, what rolled in,
-- what was drawn, what overflowed, what rolled out. UNIQUE (contract_line_id,
-- period_start) is the idempotency key W02's close path relies on.
--
-- Tenancy: RLS Shape 1 (direct org_id, breeze_has_org_access). This is a
-- balance — a transactional record of one customer's prepaid entitlement — not
-- a configuration policy, so the org-XOR-partner rule does not apply (same
-- reasoning as contract_billing_periods and its siblings). Not append-only:
-- org merge repoints org_id by UPDATE, so UPDATE must stay legal.
--
-- Writes no rows, so no system-scope election is needed.

CREATE TABLE IF NOT EXISTS contract_hour_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_line_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  -- Half-open [period_start, period_end), the contract's billing period.
  period_start date NOT NULL,
  period_end date NOT NULL,
  included_hours numeric(12,2) NOT NULL,
  carried_in_hours numeric(12,2) NOT NULL,
  consumed_hours numeric(12,2) NOT NULL,
  overage_hours numeric(12,2) NOT NULL,
  carried_out_hours numeric(12,2) NOT NULL,
  -- Hours absorbed from entries stamped in a currency other than the
  -- contract's (Decision 8 flag).
  foreign_currency_hours numeric(12,2) NOT NULL DEFAULT 0,
  entry_count integer NOT NULL,
  -- Snapshots at close, so a later edit of the line cannot rewrite history.
  overage_unit_price numeric(12,2) NOT NULL,
  currency_code char(3) NOT NULL,
  -- NULL when overage_hours = 0. Deliberately NO CHECK tying the two: the
  -- invoice FK below is ON DELETE SET NULL, so a deleted draft must stay legal.
  overage_invoice_id uuid,
  close_source text NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_hour_periods_period_chk CHECK (period_end > period_start),
  CONSTRAINT contract_hour_periods_hours_nonneg_chk CHECK (
    included_hours >= 0 AND carried_in_hours >= 0 AND consumed_hours >= 0
    AND overage_hours >= 0 AND carried_out_hours >= 0 AND foreign_currency_hours >= 0
  ),
  CONSTRAINT contract_hour_periods_close_source_chk CHECK (close_source IN ('billing_run', 'close_out'))
);

-- Composite FKs: the same-org guarantee is the FK, not RLS. DEFERRABLE INITIALLY
-- IMMEDIATE because org merge repoints parent and child org_id in separate
-- statements under SET CONSTRAINTS ALL DEFERRED (a non-deferrable one aborts the
-- merge with 23503). DROP + re-ADD converges any drifted shape on re-apply.
ALTER TABLE contract_hour_periods DROP CONSTRAINT IF EXISTS contract_hour_periods_contract_org_fk;
ALTER TABLE contract_hour_periods ADD CONSTRAINT contract_hour_periods_contract_org_fk
  FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- RESTRICT: a block line with closed periods can never be hard-deleted (it is
-- retired instead, W03). Postgres reports it as 23503.
ALTER TABLE contract_hour_periods DROP CONSTRAINT IF EXISTS contract_hour_periods_line_org_fk;
ALTER TABLE contract_hour_periods ADD CONSTRAINT contract_hour_periods_line_org_fk
  FOREIGN KEY (contract_line_id, org_id) REFERENCES contract_lines (id, org_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;

-- The PG15 column list is mandatory: without it SET NULL nulls EVERY FK column
-- including the NOT NULL org_id, which aborts the invoice delete with 23502.
-- Same lesson as 2026-10-08-101200-billing-evidence.sql.
ALTER TABLE contract_hour_periods DROP CONSTRAINT IF EXISTS contract_hour_periods_invoice_org_fk;
ALTER TABLE contract_hour_periods ADD CONSTRAINT contract_hour_periods_invoice_org_fk
  FOREIGN KEY (overage_invoice_id, org_id) REFERENCES invoices (id, org_id)
  ON DELETE SET NULL (overage_invoice_id) DEFERRABLE INITIALLY IMMEDIATE;

-- The idempotency key; its leading column also serves the line FK's child side.
CREATE UNIQUE INDEX IF NOT EXISTS contract_hour_periods_line_period_uq
  ON contract_hour_periods (contract_line_id, period_start);
CREATE INDEX IF NOT EXISTS contract_hour_periods_org_idx ON contract_hour_periods (org_id);
-- Per-contract history, newest first; also the contract FK's child side.
CREATE INDEX IF NOT EXISTS contract_hour_periods_contract_idx
  ON contract_hour_periods (contract_id, period_start DESC);

-- RLS: Shape 1, verbatim from contract_billing_periods
-- (2026-06-15-d-recurring-contracts.sql).
ALTER TABLE contract_hour_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_hour_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_hour_periods;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_hour_periods;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_hour_periods;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_hour_periods;
CREATE POLICY breeze_org_isolation_select ON contract_hour_periods
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_hour_periods
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_hour_periods
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_hour_periods
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE is required for the org-merge repoint; see the header.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_hour_periods TO breeze_app;
```

- [ ] **Step 4: Drizzle.** In `apps/api/src/db/schema/contracts.ts`, directly after the `contractBillingPeriods` table (its `]);` at line 119) add:

```ts
/**
 * #4547 W01: one row per CLOSED block-hours period (RLS Shape 1, org-owned — a
 * balance, not a policy). UNIQUE (contract_line_id, period_start) is the close
 * path's idempotency key. Written by W02; nothing writes it in W01.
 *
 * SQL-ONLY constraints (migration 2026-12-14-100200-contract-hour-periods.sql),
 * all DEFERRABLE INITIALLY IMMEDIATE:
 *   - (contract_id, org_id)        -> contracts(id, org_id)       ON DELETE CASCADE
 *   - (contract_line_id, org_id)   -> contract_lines(id, org_id)  ON DELETE RESTRICT
 *   - (overage_invoice_id, org_id) -> invoices(id, org_id)        ON DELETE SET NULL (overage_invoice_id)
 * CHECKs: contract_hour_periods_period_chk (period_end > period_start),
 * contract_hour_periods_hours_nonneg_chk (every hours column >= 0),
 * contract_hour_periods_close_source_chk. There is deliberately NO CHECK tying
 * overage_hours to overage_invoice_id: the invoice FK is SET NULL.
 */
export const contractHourPeriods = pgTable('contract_hour_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractLineId: uuid('contract_line_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Half-open [periodStart, periodEnd).
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  includedHours: numeric('included_hours', { precision: 12, scale: 2 }).notNull(),
  carriedInHours: numeric('carried_in_hours', { precision: 12, scale: 2 }).notNull(),
  consumedHours: numeric('consumed_hours', { precision: 12, scale: 2 }).notNull(),
  overageHours: numeric('overage_hours', { precision: 12, scale: 2 }).notNull(),
  carriedOutHours: numeric('carried_out_hours', { precision: 12, scale: 2 }).notNull(),
  // Hours absorbed from entries stamped in another currency (Decision 8 flag).
  foreignCurrencyHours: numeric('foreign_currency_hours', { precision: 12, scale: 2 }).notNull().default('0'),
  entryCount: integer('entry_count').notNull(),
  // Snapshots at close.
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  overageInvoiceId: uuid('overage_invoice_id'),
  closeSource: text('close_source').$type<'billing_run' | 'close_out'>().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_hour_periods_line_period_uq').on(t.contractLineId, t.periodStart),
  index('contract_hour_periods_org_idx').on(t.orgId),
  index('contract_hour_periods_contract_idx').on(t.contractId, desc(t.periodStart)),
]);
```

- [ ] **Step 5: Run the contract suites red, then register.** With the table now migrated and nothing registered:

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts`
Expected: FAIL — `tenantCascade` reports `contract_hour_periods` has an `org_id` column but is not in `CORE_ORG_CASCADE_DELETE_ORDER`; the export-policy suite reports it has no policy; `orgMergeRegistry` reports no merge policy for it.

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: PASS already (Shape 1 is auto-discovered and the migration ships the policies). If it fails, the migration's RLS block is wrong — fix the migration, not the allowlist.

Register, in the same commit:

1. `apps/api/src/services/tenantCascade.ts` lines 488-489 — insert between `'contract_documents',` and `'contract_lines',` (`localeCompare`: `contract_documents` < `contract_hour_periods` < `contract_lines`):

```ts
  'contract_documents',
  'contract_hour_periods',
  'contract_lines',
```

2. `apps/api/src/services/tenantExportPolicyRegistry.ts` — insert a new row between line 321 (`"contract_documents"`) and the `"contract_lines"` row (every column `included`; no json/jsonb/bytea, no suspicious-name part):

```ts
  "contract_hour_periods": tablePolicy("org_id", {"included":["id","contract_line_id","contract_id","org_id","period_start","period_end","included_hours","carried_in_hours","consumed_hours","overage_hours","carried_out_hours","foreign_currency_hours","entry_count","overage_unit_price","currency_code","overage_invoice_id","close_source","closed_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

3. `apps/api/src/services/orgMergeRegistry.ts` — in `REPOINT_TABLES` (declared at `:731`; the entries are at `:833-834`; the index's `:731` is the declaration, not the insertion point) insert between `"contract_documents",` and `"contract_lines",`:

```ts
  "contract_documents",
  "contract_hour_periods",
  "contract_lines",
```

- [ ] **Step 6: Run and watch it pass.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Expected: PASS, 5 files. `orgLifecycleFoundations` is the "merge contract" that asserts every composite FK referencing an `org_id` column is deferrable.

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` — expected PASS.

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "exit=$?"` — expected `exit=0`.

- [ ] **Step 7: Commit.**

```bash
git add apps/api/migrations/2026-12-14-100200-contract-hour-periods.sql \
  apps/api/src/db/schema/contracts.ts apps/api/src/services/tenantCascade.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts \
  apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts
git commit -m "feat(billing): contract_hour_periods ledger with org RLS and deferrable FKs (#4547)

New org-owned table (RLS Shape 1) with three composite deferrable FKs, a
(line, period_start) idempotency key, and registration in the org cascade
order, tenant export policy and org-merge repoint list in the same commit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `time_entries.contract_line_id`

**Files:**
- Create: `apps/api/migrations/2026-12-14-100300-time-entries-contract-line.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts` (`:77` column, `:94-96` index list)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:859` (`time_entries` row)
- Modify: `apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
- Modify: `apps/api/src/db/autoMigrate.test.ts` (add a test in `describe('migration filename conventions'` after the W07 test, currently ends `:675`)

**Interfaces:**
- Consumes: `contract_lines_id_org_uq`, `time_entries_org_partner_fk` (#4596, already shipped, `2026-10-06-110000`).
- Produces: `time_entries.contract_line_id uuid`; `time_entries_contract_line_org_fk`, `time_entries_contract_line_org_chk`, `time_entries_contract_line_chk`, partial index `time_entries_contract_line_idx`; Drizzle `timeEntries.contractLineId`.

- [ ] **Step 1: Write the failing tests.** In `contractHourBlockSchema.integration.test.ts` extend the imports:

```ts
import postgres from 'postgres';
import { splitSqlStatements } from '../../db/autoMigrate';
import { createOrganization, createPartner, createUser } from './db-utils';
```

(replace the existing `./db-utils` import line with the one above). Change `seed()` to also create a user — replace its `return { … }` with:

```ts
  const user = await createUser({ partnerId: partner.id, email: `bh-${randomUUID()}@example.test` });
  return {
    partnerId: partner.id as string,
    userId: user.id as string,
    orgA: orgA.id as string,
    orgB: orgB.id as string,
    contractA: await mkContract(orgA.id as string),
    contractB: await mkContract(orgB.id as string),
  };
```

Append:

```ts
const F_ENTRIES = '2026-12-14-100300-time-entries-contract-line.sql';
const TE_FK = 'time_entries_contract_line_org_fk';
const TE_ORG_CHK = 'time_entries_contract_line_org_chk';
const TE_STATUS_CHK = 'time_entries_contract_line_chk';

/** Replay a no-transaction file the way autoMigrate does: one statement per
 *  command on a single connection (CREATE INDEX CONCURRENTLY cannot share a
 *  simple-query transaction). Pattern: topology-foundation.integration.test.ts. */
async function replayNoTransaction(file: string): Promise<void> {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    for (const statement of splitSqlStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))) {
      await admin.unsafe(statement);
    }
  } finally { await admin.end(); }
}

async function insertEntry(
  f: { partnerId: string; userId: string },
  o: { orgId: string | null; lineId: string | null; billingStatus?: string },
): Promise<Array<{ id: string }>> {
  return await getTestDb().execute(sql`
    INSERT INTO time_entries
      (partner_id, org_id, user_id, started_at, ended_at, duration_minutes, currency_code, billing_status, contract_line_id)
    VALUES
      (${f.partnerId}::uuid, ${o.orgId}::uuid, ${f.userId}::uuid, '2026-12-03T09:00:00'::timestamp, '2026-12-03T10:00:00'::timestamp,
       60, ${o.orgId === null ? null : 'USD'}, ${o.billingStatus ?? 'contract'}::billing_status, ${o.lineId}::uuid)
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

describe('time_entries.contract_line_id (real DB) #4547 W01', () => {
  it('accepts a contract-status entry that names a line of its own org', async () => {
    const f = await seedLedger();
    await expect(insertEntry(f, { orgId: f.orgA, lineId: f.lineA })).resolves.toHaveLength(1);
    // And an ordinary entry with no line is untouched by any of this.
    await expect(insertEntry(f, { orgId: f.orgA, lineId: null, billingStatus: 'not_billed' })).resolves.toHaveLength(1);
  });

  it('rejects a line id with a NULL org (the composite FK is MATCH SIMPLE and would skip it)', async () => {
    const f = await seedLedger();
    await expectConstraint(() => insertEntry(f, { orgId: null, lineId: f.lineA }), '23514', [TE_ORG_CHK], 'contract_line_id with org_id NULL');
  });

  it("rejects a line id on an entry that is not 'contract' (the line id is only ever written with the status)", async () => {
    const f = await seedLedger();
    for (const billingStatus of ['not_billed', 'no_charge']) {
      await expectConstraint(() => insertEntry(f, { orgId: f.orgA, lineId: f.lineA, billingStatus }), '23514', [TE_STATUS_CHK], `billing_status ${billingStatus}`);
    }
  });

  it("rejects another org's line and a line that does not exist", async () => {
    const f = await seedLedger();
    // Entry is org B's (same partner, so time_entries_org_partner_fk passes); the line is org A's.
    await expectConstraint(() => insertEntry(f, { orgId: f.orgB, lineId: f.lineA }), '23503', [TE_FK], "other org's line");
    await expectConstraint(() => insertEntry(f, { orgId: f.orgA, lineId: randomUUID() }), '23503', [TE_FK], 'unknown line');
  });

  it('deleting the line nulls only contract_line_id (the SET NULL column list keeps org_id and the status)', async () => {
    const f = await seedLedger();
    const [e] = await insertEntry(f, { orgId: f.orgA, lineId: f.lineA });
    await getTestDb().execute(sql`DELETE FROM contract_lines WHERE id = ${f.lineA}::uuid`);
    const [row] = await getTestDb().execute(sql`
      SELECT contract_line_id, org_id, billing_status::text AS status FROM time_entries WHERE id = ${e!.id}::uuid
    `) as unknown as Array<{ contract_line_id: string | null; org_id: string; status: string }>;
    expect(row).toEqual({ contract_line_id: null, org_id: f.orgA, status: 'contract' });
  });

  it('all four new composite FKs are DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint
      WHERE contype = 'f' AND conname IN (
        'contract_hour_periods_contract_org_fk', 'contract_hour_periods_line_org_fk',
        'contract_hour_periods_invoice_org_fk', 'time_entries_contract_line_org_fk')
      ORDER BY conname
    `) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
    expect(rows.map((r) => r.conname)).toEqual([
      'contract_hour_periods_contract_org_fk', 'contract_hour_periods_invoice_org_fk',
      'contract_hour_periods_line_org_fk', 'time_entries_contract_line_org_fk',
    ]);
    for (const r of rows) expect(r, r.conname).toMatchObject({ condeferrable: true, condeferred: false });
  });

  it('the NOT VALID constraints were validated, and the partial index is valid', async () => {
    const cons = await getTestDb().execute(sql`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = 'public.time_entries'::regclass
        AND conname IN ('time_entries_contract_line_org_fk', 'time_entries_contract_line_org_chk', 'time_entries_contract_line_chk')
      ORDER BY conname
    `) as unknown as Array<{ conname: string; convalidated: boolean }>;
    expect(cons).toEqual([
      { conname: 'time_entries_contract_line_chk', convalidated: true },
      { conname: 'time_entries_contract_line_org_chk', convalidated: true },
      { conname: 'time_entries_contract_line_org_fk', convalidated: true },
    ]);
    const [idx] = await getTestDb().execute(sql`
      SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'time_entries_contract_line_idx'
    `) as unknown as Array<{ indisvalid: boolean; def: string }>;
    expect(idx!.indisvalid).toBe(true);
    expect(idx!.def).toMatch(/WHERE \(?contract_line_id IS NOT NULL\)?/);
  });

  it('re-applying the file (statement by statement, as autoMigrate does) is a no-op', async () => {
    const f = await seedLedger();
    const [e] = await insertEntry(f, { orgId: f.orgA, lineId: f.lineA });
    await replayNoTransaction(F_ENTRIES);
    const [row] = await getTestDb().execute(sql`SELECT contract_line_id FROM time_entries WHERE id = ${e!.id}::uuid`) as unknown as Array<{ contract_line_id: string }>;
    expect(row!.contract_line_id).toBe(f.lineA);
    await expectConstraint(() => insertEntry(f, { orgId: null, lineId: f.lineA }), '23514', [TE_ORG_CHK], 'after replay');
  });
});
```

In `apps/api/src/db/autoMigrate.test.ts`, check the file's imports include `splitSqlStatements`, `hasNoTransactionDirective`, `readFileSync`, `readdirSync`, `path` (all already used by tests in this file). Add inside `describe('migration filename conventions', …)`, directly after the W07 test (ends at line 675):

```ts
  it('#4547 W01: the block-hours migrations sort 100000 < 100100 < 100200 < 100300; the enum file is one statement; only the time_entries file is no-transaction and validates its constraints', () => {
    const dir = path.join(__dirname, '../../migrations');
    const names = [
      '2026-12-14-100000-contract-line-type-hour-block.sql',
      '2026-12-14-100100-contract-lines-hour-block.sql',
      '2026-12-14-100200-contract-hour-periods.sql',
      '2026-12-14-100300-time-entries-contract-line.sql',
    ];
    const sorted = readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
    const at = names.map((n) => sorted.indexOf(n));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The block-hours files sit after the ceiling they were planned against.
    expect(names[0]! > '2026-12-13-110200-org-erasure-fk-child-actions.sql').toBe(true);
    const body = (n: string) => readFileSync(path.join(dir, n), 'utf8');
    // A value added by ADD VALUE cannot be used in the same transaction, so this file holds nothing else.
    expect(splitSqlStatements(body(names[0]!))).toEqual([
      "ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'hour_block'",
    ]);
    expect(names.map((n) => hasNoTransactionDirective(body(n)))).toEqual([false, false, false, true]);
    // The hot-table file adds NOT VALID and validates as separate statements.
    const entries = splitSqlStatements(body(names[3]!));
    expect(entries.filter((s) => /VALIDATE CONSTRAINT/.test(s))).toHaveLength(3);
    expect(entries.some((s) => /\bNOT VALID\b/.test(s))).toBe(true);
    expect(entries.some((s) => /^SET lock_timeout/i.test(s))).toBe(true);
    // No file writes a row (no scope election needed).
    for (const n of names) expect(body(n)).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/im);
  });
```

- [ ] **Step 2: Run and watch them fail.**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts -t "block-hours migrations"`
Expected: FAIL — `at.every(i > -1)` is false (the fourth file does not exist).

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
Expected: FAIL — `column "contract_line_id" of relation "time_entries" does not exist` in the new describe; the earlier describes pass.

- [ ] **Step 3: Write the migration.** Create `apps/api/migrations/2026-12-14-100300-time-entries-contract-line.sql` — the first line must be the directive:

```sql
-- @no-transaction
-- #4547 W01 (block hours): time_entries.contract_line_id — which block line, if
-- any, drew this entry. Server-written only (W02's close path stamps it together
-- with billing_status = 'contract'); no Zod schema accepts it.
-- Contract: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md (C4).
--
-- time_entries is a large, hot, partner-axis table. A plain ADD CONSTRAINT on it
-- validates inside the same statement while holding a heavy lock, and inside a
-- transaction the ACCESS EXCLUSIVE lock from adding a NOT VALID constraint would
-- still be held while a following VALIDATE scanned the table. So this file runs
-- outside a transaction and:
--   1. adds the column (catalog-only: nullable, no default, no rewrite);
--   2. adds the FK and both CHECKs NOT VALID in ONE ALTER TABLE statement
--      (catalog only, no scan; every new row is checked from this point on).
--      Dropping the old definition first makes a re-apply converge;
--   3. VALIDATEs each as its own statement, which takes only SHARE UPDATE
--      EXCLUSIVE (the FK also ROW SHARE on contract_lines), so writes continue
--      during the scan. The column is new and entirely NULL, so every
--      constraint passes trivially;
--   4. builds the partial index CONCURRENTLY.
-- lock_timeout bounds how long step 2 may queue behind a long-running
-- transaction: the statement fails after 5s instead of stalling every reader and
-- writer of time_entries; autoMigrate aborts boot and the file re-runs cleanly
-- on the next start. It is set per session (each statement is sent on its own)
-- and RESET at the end. Precedent: 2026-12-13-110100-device-software-device-cascade.sql.
--
-- Idempotent: re-applying re-swaps and re-validates the same definitions. A
-- failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would
-- skip; an operator must DROP INDEX it before the next deploy (same contract as
-- 2026-10-08-101100-billing-evidence-fk-targets.sql).
--
-- No row is written, so no system-scope election is needed.

SET lock_timeout = '5s';

ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS contract_line_id uuid;

ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_contract_line_org_fk,
  DROP CONSTRAINT IF EXISTS time_entries_contract_line_org_chk,
  DROP CONSTRAINT IF EXISTS time_entries_contract_line_chk,
  -- Composite so the line must belong to the entry's own org. MATCH SIMPLE (the
  -- default) skips a row whose org_id is NULL, which is exactly why the _org_chk
  -- below exists. ON DELETE SET NULL (contract_line_id): the PG15 column list
  -- nulls only that column; a bare SET NULL would also null org_id.
  -- DEFERRABLE INITIALLY IMMEDIATE: org merge repoints this table and
  -- contract_lines in separate statements under SET CONSTRAINTS ALL DEFERRED.
  ADD CONSTRAINT time_entries_contract_line_org_fk
    FOREIGN KEY (contract_line_id, org_id) REFERENCES public.contract_lines (id, org_id)
    ON DELETE SET NULL (contract_line_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT time_entries_contract_line_org_chk
    CHECK (contract_line_id IS NULL OR org_id IS NOT NULL) NOT VALID,
  -- A line id is only ever written together with billing_status = 'contract'
  -- (spec amendment 2026-09-19: 'contract' is terminal only when a line id is set).
  ADD CONSTRAINT time_entries_contract_line_chk
    CHECK (contract_line_id IS NULL OR billing_status = 'contract') NOT VALID;

ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_contract_line_org_fk;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_contract_line_org_chk;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_contract_line_chk;

-- The FK's child side (a line delete must find its entries) and the per-line
-- drawdown read. Partial: nearly every entry has no line.
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_contract_line_idx
  ON public.time_entries (contract_line_id) WHERE contract_line_id IS NOT NULL;

RESET lock_timeout;
```

- [ ] **Step 4: Drizzle.** In `apps/api/src/db/schema/timeTracking.ts`:

After `billableMinutes` (line 77) add:

```ts
  // #4547 W01: which block-hours line drew this entry. Server-written only
  // (W02's close path stamps it together with billing_status = 'contract'); no
  // zod schema in @breeze/shared accepts it. Plain column here; the real
  // constraints are SQL-only (2026-12-14-100300-time-entries-contract-line.sql),
  // added NOT VALID then validated (hot table):
  //   - time_entries_contract_line_org_fk (contract_line_id, org_id) ->
  //     contract_lines (id, org_id) ON DELETE SET NULL (contract_line_id),
  //     DEFERRABLE INITIALLY IMMEDIATE. MATCH SIMPLE, so ...
  //   - time_entries_contract_line_org_chk: contract_line_id IS NULL OR org_id IS NOT NULL
  //   - time_entries_contract_line_chk:     contract_line_id IS NULL OR billing_status = 'contract'
  contractLineId: uuid('contract_line_id'),
```

In the table's index list, replace the last entry (lines 94-96, ending `]);`):

```ts
  index('time_entries_org_started_at_idx')
    .on(t.orgId, t.startedAt)
    .where(sql`${t.orgId} IS NOT NULL`)
]);
```

with:

```ts
  index('time_entries_org_started_at_idx')
    .on(t.orgId, t.startedAt)
    .where(sql`${t.orgId} IS NOT NULL`),
  // Partial index (WHERE contract_line_id IS NOT NULL), built CONCURRENTLY in
  // SQL (2026-12-14-100300); this mirrors it so db:check-drift stays clean.
  index('time_entries_contract_line_idx')
    .on(t.contractLineId)
    .where(sql`${t.contractLineId} IS NOT NULL`)
]);
```

- [ ] **Step 5: Export policy.** Run the suite red, then edit.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: FAIL — `time_entries.contract_line_id` is unclassified.

In `apps/api/src/services/tenantExportPolicyRegistry.ts` replace the `time_entries` row (line 859), adding `"contract_line_id"` after `"billable_minutes"`:

```ts
  "time_entries": tablePolicy("org_id", {"included":["id","partner_id","org_id","ticket_id","user_id","started_at","ended_at","duration_minutes","billable_minutes","contract_line_id","description","is_billable","hourly_rate","currency_code","billing_status","work_type_id","billing_profile_id","coverage","billing_overridden","minimum_minutes","rounding_increment_minutes","source","is_approved","approved_by","approved_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 6: Run and watch it pass.**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`
Expected: PASS (`migrationRlsScope` — no new offender; the new migrations write no rows).

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Expected: PASS, 3 files.

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "exit=$?"` — expected `exit=0`.

- [ ] **Step 7: Commit.**

```bash
git add apps/api/migrations/2026-12-14-100300-time-entries-contract-line.sql \
  apps/api/src/db/schema/timeTracking.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/contractHourBlockSchema.integration.test.ts \
  apps/api/src/db/autoMigrate.test.ts
git commit -m "feat(billing): time_entries.contract_line_id with a lock-safe composite FK (#4547)

Nullable column, deferrable composite FK to the entry's own org's line, a NULL-org
CHECK (the FK is MATCH SIMPLE) and a status CHECK, added NOT VALID and validated
as separate statements outside a transaction. Export policy classifies the column.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Erasure round-trip seed and the registration contract suites

**Files:**
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` (seed after the group line `:300-302`; manifest assertion `:460`; archive assertion after `:543`; erasure assertions `:720`, `:746`, `:776`)

**Interfaces:**
- Consumes: Tasks 3–5 (columns, table, registrations).
- Produces: a block line and one ledger row in org A of the seed, asserted exported and erased.

- [ ] **Step 1: Write the failing assertions first (they will fail until the seed exists).** In `tenantExportErasureRoundtrip.integration.test.ts`:

(a) In the manifest test, after `expect(byName.get('contract_lines.json')?.rowCount).toBe(2);` (line 460) change that line and add the ledger count:

```ts
    expect(byName.get('contract_lines.json')?.rowCount).toBe(3);
    // #4547 W01: the block-hours ledger is exported (every column `included`).
    expect(byName.get('contract_hour_periods.json')?.rowCount).toBe(1);
```

(b) After the `groupLine` assertions (after `expect(groupLine?.device_group_name).toBe(groupName);`, line 542) add:

```ts
    // #4547 W01: the block line carries its new columns through the export...
    const blockLine = contractLines.find((line) => line.description === 'Prepaid hours');
    expect(blockLine).toMatchObject({
      line_type: 'hour_block',
      included_quantity: '10.00',
      overage_mode: 'bill',
      overage_unit_price: '95.00',
      rollover_policy: 'carry_forward',
      rollover_cap_hours: '5.00',
      hour_block_alert_pct: 80,
    });
    // ...and its ledger row is exported readably.
    const hourPeriods = await archiveTable(archive, 'contract_hour_periods');
    expect(hourPeriods).toHaveLength(1);
    expect(hourPeriods[0]).toMatchObject({
      org_id: orgA, consumed_hours: '7.50', carried_out_hours: '2.50', close_source: 'billing_run',
    });
```

(c) In the erasure test: after `expect(await rowCount(db, 'contract_billing_period_outcomes', orgA)).toBe(1);` (line 720) add:

```ts
    expect(await rowCount(db, 'contract_hour_periods', orgA)).toBe(1);
```

After `expect(await rowCount(db, 'contract_billing_period_outcomes', orgA)).toBe(0);` (line 752) add:

```ts
    expect(await rowCount(db, 'contract_hour_periods', orgA)).toBe(0);
```

Replace `expect(stats.tablesDeleted['contract_lines']).toBeGreaterThanOrEqual(2);` (line 776) with:

```ts
    expect(stats.tablesDeleted['contract_lines']).toBeGreaterThanOrEqual(3);
    // Erased child-first: the RESTRICT FK from the ledger to the line means the
    // ledger rows must go before the block line, or the erasure would abort.
    expect(stats.tablesDeleted['contract_hour_periods']).toBe(1);
```

- [ ] **Step 2: Run and watch it fail.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
Expected: FAIL — `contract_lines.json` rowCount is 2 (expected 3) and `contract_hour_periods.json` is missing from the archive.

- [ ] **Step 3: Add the seed.** In `seedTwoOrgs`, directly after the `per_device_group` line insert (the `INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_group_id, device_group_name)` statement ends at line 302), add:

```ts
  // #4547 W01: an hour_block line with a closed period, so contract_lines.json
  // carries the block columns, contract_hour_periods.json is exported, and
  // erasure has to delete the ledger row BEFORE the line it restricts.
  const blockLineId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO contract_lines (
      id, contract_id, org_id, line_type, description, unit_price, taxable,
      included_quantity, overage_mode, overage_unit_price,
      rollover_policy, rollover_cap_hours, hour_block_alert_pct, hour_block_first_period_start
    ) VALUES (
      ${blockLineId}, ${contractId}, ${orgA}, 'hour_block', 'Prepaid hours', 500.00, false,
      10.00, 'bill', 95.00,
      'carry_forward', 5.00, 80, '2026-07-01'
    )
  `);
  await db.execute(sql`
    INSERT INTO contract_hour_periods (
      contract_line_id, contract_id, org_id, period_start, period_end,
      included_hours, carried_in_hours, consumed_hours, overage_hours, carried_out_hours,
      entry_count, overage_unit_price, currency_code, close_source
    ) VALUES (
      ${blockLineId}, ${contractId}, ${orgA}, '2026-07-01', '2026-08-01',
      10.00, 0.00, 7.50, 0.00, 2.50,
      3, 95.00, 'USD', 'billing_run'
    )
  `);
```

- [ ] **Step 4: Run and watch it pass; then the full contract set.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
Expected: PASS.

Run (contract suites; each must be green, and the reported file count must match):
`cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts`
Expected: PASS, 6 files.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "test(billing): erasure round-trip covers a block line and its ledger row (#4547)

Seeds an hour_block line and one closed period into the two-org fixture and
asserts the ledger is exported and erased before the line it restricts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification and PR

**Files:** none (verification only; a fix lands in the task that owns it).

- [ ] **Step 1: Re-check the migration ceiling.**

Run: `ls apps/api/migrations | LC_ALL=C sort | tail -1` prints `preflight` (the `README.md`, `optional` and `preflight` entries sort after the dated files), so use the dated filter instead:

Run: `ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | LC_ALL=C sort | tail -5`
Expected: the last four lines are this wave's four files, preceded by `2026-12-13-110200-org-erasure-fk-child-actions.sql`.

Then fetch `origin/main` and list its newest migrations: `git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | grep -E '/[0-9]{4}-.*\.sql$' | LC_ALL=C sort | tail -3`. If anything there now sorts after `2026-12-14-100300-time-entries-contract-line.sql`, rename this wave's files to sort after it, keeping their relative order, and update the filename constants in `contractHourBlockSchema.integration.test.ts` and `autoMigrate.test.ts`. A missed reference is an `ENOENT` minutes into Integration Tests; the `autoMigrate.test.ts` case that resolves every core migration path referenced from `apps/api/src` catches it earlier.

- [ ] **Step 2: Naming guard against `origin/main`.**

Run: `bash scripts/check-migration-naming.sh --against-ref origin/main`
Expected: exit 0. (The commit-time hook already vetted each commit with `--staged`.)

- [ ] **Step 3: Unit tests (touched files, then the full API suite).**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts src/services/contractService.siteScope.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts src/services/orgMerge.test.ts`
Expected: PASS.

Run (`orgMerge.test.ts` walks the cascade order and reds only in the full unit suite): `pnpm --filter @breeze/api test --run`
Expected: PASS. (Drop the `--` — `pnpm … test -- --run` runs the whole suite in watch mode.)

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit ; echo "exit=$?"` — expected PASS, `exit=0`.

- [ ] **Step 4: Typecheck every touched package.**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "exit=$?"` and the same in `apps/web`. Expected `exit=0` for both. Check the exit code, never pipe to `tail`.

- [ ] **Step 5: Integration and contract suites.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockSchema.integration.test.ts src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts src/__tests__/integration/contractLinesDeviceRolesConstraints.integration.test.ts src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts src/__tests__/integration/contractLinesSiteStampConstraints.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/contractService.integration.test.ts src/__tests__/integration/contractEstimate.integration.test.ts src/__tests__/integration/contractWorker.integration.test.ts`
Expected: PASS, 13 files. (The last three prove the existing contract paths are unaffected by the widened enum and CHECK.)

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: PASS with **no allowlist edit** (Shape 1 is auto-discovered).

- [ ] **Step 6: Drift check against the migrated test database.**

Run: `cd apps/api && DATABASE_URL="$(grep '^DATABASE_URL=' ../../.env.test | cut -d= -f2-)" pnpm db:check-drift ; echo "exit=$?"`
Expected: `exit=0`, no drift (new enum label, five `contract_lines` columns, the live-block partial index, `contract_hour_periods` and its three indexes, `time_entries.contract_line_id` and its partial index). If drift is reported for a CHECK or composite FK, it belongs in the Drizzle file as a comment only — those are SQL-only by convention.

- [ ] **Step 7: Manual forge as `breeze_app`.** Against the test stack's database (connection details in `.env.test`; `breeze_app` is the unprivileged role), open `psql` as `breeze_app` and run, in one transaction:

```sql
BEGIN;
SELECT set_config('breeze.scope', 'organization', true),
       set_config('breeze.org_id', '11111111-1111-4111-8111-111111111111', true),
       set_config('breeze.accessible_org_ids', '11111111-1111-4111-8111-111111111111', true);
-- A ledger row stamped for a DIFFERENT org than the session's.
INSERT INTO contract_hour_periods
  (contract_line_id, contract_id, org_id, period_start, period_end, included_hours, carried_in_hours,
   consumed_hours, overage_hours, carried_out_hours, entry_count, overage_unit_price, currency_code, close_source)
VALUES (gen_random_uuid(), gen_random_uuid(), '22222222-2222-4222-8222-222222222222',
        '2026-12-01', '2027-01-01', 10, 0, 1, 0, 9, 1, 95, 'USD', 'billing_run');
ROLLBACK;
```

Expected: `ERROR:  new row violates row-level security policy for table "contract_hour_periods"` (the policy check runs before the FK triggers, so random ids are fine). Repeat the `SELECT … FROM contract_hour_periods` under a different `breeze.org_id` and confirm zero rows. Record both outcomes in the PR.

- [ ] **Step 8: Tear down.**

Run: `pnpm test-stack down` and `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'`. Say in the PR what, if anything, was left running.

- [ ] **Step 9: Open the PR.** Read the wave issue number from the feature tracker (`get_feature_status` for `LanternOps/breeze#4547`; branch `feature/4547-block-hours/wave-<W01 sub-issue>`; `start_wave` before pushing). Body (neutral wording; scrub it before enqueue — the merge queue freezes the squash message at enqueue):

```
## What
Block hours foundation (#4547 W01): the hour_block line type, five contract_lines
columns with their CHECKs and a one-live-block-per-org index, the contract_hour_periods
ledger (org RLS, three composite deferrable FKs), and time_entries.contract_line_id.
Registered in the org cascade order, tenant export policy and org-merge repoint list.
hour_block arms in resolveLineQty / generateDueInvoice fail closed
(HOUR_BLOCK_NOT_ENABLED, 500). No validator accepts the type, so no user-visible change.

## Verification
- contractHourBlockSchema integration suite (CHECK truth table, live-block index, ledger FK/RLS/RESTRICT/SET NULL, time_entries constraints, replays)
- tenantCascade / tenant-export-policy / tenantExportErasureRoundtrip / orgMergeRegistry / orgLifecycleFoundations integration suites; test:rls-coverage with no allowlist change
- db:check-drift clean; full API unit suite
- Manual: a ledger row for another org as breeze_app is rejected (row-level security)

## Notes for reviewers
- time_entries changes are applied outside a transaction with NOT VALID + VALIDATE and a bounded lock_timeout.
- Org merge and the one-live-block index: see "Index reconciliation" item 5 in the W01 plan; to be decided before the feature opens (W03).

Closes #<W01 sub-issue>
```

End the body with the attribution line from the session's commit/PR instructions. Run `/pr-review-toolkit:review-pr` once (blast radius is high: tenancy, migrations, billing) and act only on confirmed, consequential findings; re-review only if a fix touches RLS, a FK or a migration. Then `gh pr merge <N>` (no strategy flag, no `--admin`).

---

## Self-review

**Spec coverage (W01 slice).** Spec §1 line type + columns → Tasks 2–3 (enum; five columns; allowance CHECK widened; block CHECK; live-block index; `overage_mode = 'bill'` per Open Decision 10 A; fractional hours per the allowance-CHECK exemption). §2 `time_entries.contract_line_id` → Task 5 (composite deferrable FK, NULL-org CHECK, status CHECK per the 2026-09-19 amendment, partial index; server-written only — no shared Zod schema is touched). §3 `contract_hour_periods` → Task 4 (all C3 columns, `foreign_currency_hours`, `close_source`, idempotency key, three FKs with the stated delete actions, Shape-1 RLS). Registrations (C5) → Tasks 3, 4, 5, with the erasure round-trip in Task 6. Shared constants (C6) → Task 1. Error code and the two exhaustive switches (C10, "Why W01 ships nothing") → Task 2. Not in W01 by design: the drawdown engine, validators, estimate, portal, alerts, org-move refusals (W02–W04).

**Placeholder scan.** No "TBD"/"similar to"/"add validation". Every SQL file, Drizzle edit, test and registration edit is shown in full. Two intentional runtime lookups, not placeholders: the W01 sub-issue number (read from the feature tracker in Task 7) and the extra typecheck-fallout sites (Task 2 Step 10 lists the three known seats with code, and gives the exact rule for any further site the compiler reports — the plan cannot enumerate those without running `tsc`).

**Type and name consistency vs the index.** Migration filenames, constraint/index/FK names, Drizzle names (`rolloverPolicy`, `rolloverCapHours`, `hourBlockAlertPct`, `hourBlockFirstPeriodStart`, `hourBlockRetiredAt`, `contractHourPeriods`, `contractLineId`), `HOUR_BLOCK_LINE_TYPE` / `ROLLOVER_POLICIES` / `RolloverPolicy`, `HOUR_BLOCK_NOT_ENABLED` (500) and the registration targets match C1–C6 and C10 verbatim; the allowance and block CHECK text is the index's, with comments added. Deviations are enumerated under "Index reconciliation" (six items) and "Additions to the index". Task order differs from the suggested split in one respect: registrations ride with the DDL that needs them (Tasks 3–5) rather than in a separate task, so every commit leaves the contract suites green; Task 6 is the erasure seed.
