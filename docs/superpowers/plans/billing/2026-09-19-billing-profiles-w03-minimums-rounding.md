---
tracking_issue: LanternOps/breeze#4628
wave_issue: LanternOps/breeze#6334
spec: docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md
wave: W03
blast_radius: high
---
# Billing Profiles W03: Minimums, Rounding and `billable_minutes` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a per-row **minimum** and a per-card **rounding increment** actually change what a customer is billed, by giving `time_entries` a service-written `billable_minutes` column pinned by a CHECK carrying the identical expression, and switching every money and billed-quantity reader — the three summary readers, the portal, and invoice line assembly — to `COALESCE(billable_minutes, duration_minutes)` while utilization and timesheet *durations* keep actual minutes.

**Architecture:** One tiny pure module (`billableMinutes.ts`) exports **two** things that must agree forever: a TypeScript function and a Drizzle SQL fragment. A CHECK constraint on `time_entries` carries the *same* arithmetic, so any drift between the two — or any hand-written value — becomes a `23514` constraint violation instead of a wrong invoice. Both write paths that can close an entry (`stopRunningEntry`'s single-statement CAS, and `updateTimeEntry`'s PATCH-with-`endedAt`, which is how mobile replays a stop) land the column. Readers then split cleanly: **money and billed quantity** read `COALESCE(billable_minutes, duration_minutes)`; **utilization, day totals and timesheet durations** keep `duration_minutes`.

**Tech Stack:** Hono + Drizzle + postgres.js (API), hand-written idempotent SQL migrations, Vitest (unit + `vitest.integration.config.ts`), Astro + React 19 islands + react-i18next (web), `runAction` for web mutations.

**Spec:** `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md` — §3.4 (what gets stamped), §3.5 (minimums and rounding — the arithmetic this wave implements), §3.7 (overrides), §4.3 (columns), §5 (cross-spec contracts: block hours reads `COALESCE(billable_minutes, duration_minutes)`), §9 (tests + wave list; W03 is "minimums / rounding, `billable_minutes`, money + portal readers, invoice lines").

## Wave preconditions

W01 (`work_types` + `work_type_id` + dry-run report) and W02 (profile tables, Rates screen, resolver switch, stamping, conversion migration, override gate, legacy fields out of UI/API) are **merged** before this wave starts. This plan depends on the following W02 artifacts by the names the spec gives them in §3.4/§4.2/§4.3/§6:

| Artifact | Spec reference | Status |
|---|---|---|
| `time_entries.minimum_minutes` (integer, nullable) | §3.4, §4.3 | `NOT VERIFIED: confirm against merged W02` — column name and nullability |
| `time_entries.rounding_increment_minutes` (integer, nullable) | §3.4, §4.3 | `NOT VERIFIED: confirm against merged W02` |
| `time_entries.coverage` (`billable`/`included`/`non_billable`) | §3.4 | `NOT VERIFIED: confirm against merged W02` — used only for the `includedMinutes` aggregate and the "included adds no money" tests |
| `time_entries.billing_overridden` boolean NOT NULL DEFAULT false | §3.4 | `NOT VERIFIED: confirm against merged W02` |
| `resolveBillingRule()` in `apps/api/src/services/billingRuleResolver.ts`, returning at least `{ coverage, hourlyRate, minimumMinutes, roundingIncrementMinutes }` | §3.3 | `NOT VERIFIED: confirm against merged W02` — field names on the returned rule |
| `BILLED_LOCKED_ENTRY_FIELDS` extended with the new columns | §3.7 | `NOT VERIFIED: confirm against merged W02` |
| `time_entries.billable_minutes` — W02 *may* have already added the bare column with the §4.3 batch | §4.3 | The Task 2 migration is `ADD COLUMN IF NOT EXISTS`, so it is a no-op if so; the CHECK is unconditionally this wave's |
| `time_entries:manage_billing` permission + `manageBilling` on `TimeEntryActor` | §3.7 | `NOT VERIFIED: confirm against merged W02` — Task 4 gates `minimumMinutes` on it |

**Step 0 of Task 1 is a precondition check that stops the executor** if these are absent.

## Global Constraints

- **Money arithmetic is exact-decimal only.** Never a float. Currency multiplication goes through `multiplyToCurrency` (`packages/shared/src/utils/currency.ts:169`, re-exported from `@breeze/shared`) and minor-unit conversion through `toMinorUnits`/`fromMinorUnits`; `toCents` lives at `apps/api/src/services/invoiceMath.ts:7` and `packages/shared/src/utils/quoteMath.ts:17`. This wave changes only the *quantity* fed into those helpers — never how the product is rounded.
- **The labour rule is unchanged and stays one rule everywhere:** hours to 2 dp first (`(minutes / 60).toFixed(2)`), then ONE round of the product at the currency's minor unit. Every reader this wave touches already does that; only the minutes source changes.
- **`COALESCE(billable_minutes, duration_minutes)` is the *only* formula** for money and billed quantity. `NULL` billable_minutes means "pre-feature row or running timer" and must read as actual duration. No reader may use `billable_minutes` bare.
- **Utilization, day totals and displayed durations keep actual `duration_minutes`** (spec §3.5). If a task does not say "money or billed quantity", it does not change.
- **Migration discipline (CLAUDE.md):** idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$` guards); no inner `BEGIN;`/`COMMIT;`; any row-writing statement elects system scope first with `SELECT set_config('breeze.scope','system',true);`; every `UPDATE`/`DELETE` reports its count through `GET DIAGNOSTICS` + `RAISE WARNING`. Never add a file to the `apps/api/src/db/migrationRlsScope.test.ts` baseline.
- **Migration filename must sort after the newest committed migration.** As of 2026-09-19 the newest committed file in this worktree is `apps/api/migrations/2026-10-20-140000-tickets-partner-org-composite-fk.sql`. W01 and W02 land files ahead of this wave, so **re-check before naming**: `ls apps/api/migrations | sort | tail -5`. This plan uses `2026-10-23-090000-time-entries-billable-minutes.sql`; if that does not sort last, bump the date part (never an epoch prefix, never a `2026-08-06-g-` infix).
- **Cascade / export-policy registration (CLAUDE.md):** this wave adds **one column to an already-registered table**, and *`ADD COLUMN` on a `CORE_ORG_CASCADE_DELETE_ORDER` table fires the export-policy contract*. `billable_minutes` MUST be added to the `time_entries` entry in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:662`) in the same PR — bucket `included` (a monotonic integer, not a container). No new table, so no `tenantCascade.ts`, `CORE_DEVICE_CASCADE_DELETE_TABLES` or `orgMergeRegistry.ts` change.
- **Which suites are integration-only** (need real Postgres, *do not* run under `pnpm test`): everything under `apps/api/src/__tests__/integration/`, run with `--config vitest.integration.config.ts`. `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` are both integration-only — a missing export-policy entry **cannot** fail the unit job, so run them explicitly (this is the exact blind spot CLAUDE.md flags).
- **Test commands:** `cd apps/api && npx vitest run <explicit file paths>`. Never `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded literally and vitest runs the whole suite in watch mode). Never a trailing-slash directory filter. Integration: `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, and `pnpm test-stack down` when finished.
- **Eight-locale parity with real translations** for every new web string: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`. Machine-placeholder English copied into a non-English file fails `translationCoverage`.
- **All web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`). This wave adds read-only display, so no new mutation — but do not introduce a bare `fetch` POST.
- **Never catch-and-swallow a 23505/23503/23514 inside `withDbAccessContext`** — it aborts the request transaction and postgres.js substitutes the raw error back at commit. A CHECK violation from `billable_minutes` must reach the error mapper as-is.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/billableMinutes.ts` (new) | The single source of the §3.5 arithmetic: `computeBillableMinutes()` (TS) and `billableMinutesSql()` (Drizzle fragment), plus the constant `BILLABLE_MINUTES_CHECK_NAME` |
| `apps/api/src/services/billableMinutes.test.ts` (new) | Unit grid over the TS function; edge cases (null duration, zero increment, minimum only, both) |
| `apps/api/migrations/2026-10-23-090000-time-entries-billable-minutes.sql` (new) | `ADD COLUMN IF NOT EXISTS billable_minutes`, the `NOT VALID` CHECK + `VALIDATE`, and the bounded W02-gap backfill |
| `apps/api/src/db/schema/timeTracking.ts` | `billableMinutes` added to the `timeEntries` Drizzle table |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:662` | `billable_minutes` added to `time_entries`' `included` list |
| `apps/api/src/services/timeEntryService.ts` | `createTimeEntry` / `startTimer` / `stopRunningEntry` / `updateTimeEntry` write `billable_minutes`; `getTimesheet` money loop, `getTicketBillingSummary`, `listBillables` read `COALESCE(...)`; summary gains `includedMinutes` |
| `apps/api/src/services/timeEntryService.test.ts` | New/updated cases for the three readers and the two write paths |
| `apps/api/src/services/invoiceAssembly.ts` | `TimeEntryRow` gains `billableMinutes`; `entryHours` reads `COALESCE`; line description gains the "worked vs minimum" note; both select projections (`:147`, `:188`) add the column |
| `apps/api/src/services/invoiceAssembly.test.ts` | Minimum/rounding line cases + the description note |
| `apps/api/src/services/portal/supportUsage.ts` | Billed / unbilled buckets read `COALESCE`; select at `:70` adds the column |
| `apps/api/src/services/portal/supportUsage.test.ts` | Portal bucket cases |
| `apps/api/src/__tests__/integration/billableMinutesAgreement.integration.test.ts` (new) | The TS↔SQL↔CHECK grid against real Postgres; hand-written wrong value → 23514; stop-via-CAS and stop-via-PATCH both land the value |
| `apps/web/src/components/tickets/TicketTimeBilling.tsx` | Read-only "billed vs worked" line on each entry row and in the summary |
| `apps/web/src/components/tickets/TicketTimeBilling.test.tsx` | Display cases |
| `apps/web/src/components/tickets/TimesheetPage.tsx` | Same display on the timesheet entry rows; day totals stay actual |
| `apps/web/src/components/tickets/TimesheetPage.test.tsx` | Display cases + "day totals unchanged" pin |
| `apps/web/src/locales/*/tickets.json` (8 files) | `ticketTimeBilling.billedVsWorked`, `ticketTimeBilling.includedMinutes`, `timesheetPage.billedVsWorked` |

---

### Task 1: The one arithmetic — TS function and SQL fragment in one module

**Files:**
- Create: `apps/api/src/services/billableMinutes.ts`
- Test: `apps/api/src/services/billableMinutes.test.ts`

**Interfaces:**
- Consumes: `sql`, `type SQL` from `drizzle-orm`; `timeEntries` from `../db/schema/timeTracking` (verified: `timeTracking.ts:22`; `tickets.ts` holds `ticketCategories`).
- Produces:
  - `export function computeBillableMinutes(input: { durationMinutes: number | null; minimumMinutes: number | null; roundingIncrementMinutes: number | null }): number | null`
  - `export function billableMinutesSql(durationExpr: SQL | number): SQL<number>` — the identical expression in SQL, taking the duration expression to inline (the CAS computes duration in the same statement, so it cannot reference the new `duration_minutes` value by column).
  - `export const BILLABLE_MINUTES_CHECK_NAME = 'time_entries_billable_minutes_chk'`

Why one module with both: the CHECK constraint is the only thing that makes drift between the two representations *visible*, and the constraint name has to be shared by the migration and the integration test. Putting the TS function, the SQL fragment and the constraint name in one file means a reviewer looking at any change sees all three at once.

- [ ] **Step 0: Precondition check — stop if W02 has not merged**

```bash
cd /path/to/worktree
grep -n "minimumMinutes\|minimum_minutes" apps/api/src/db/schema/tickets.ts
grep -n "roundingIncrementMinutes\|rounding_increment_minutes" apps/api/src/db/schema/tickets.ts
ls apps/api/src/services/billingRuleResolver.ts
```

All three must succeed. If any fails, **stop** and report: "#4628 W02 has not merged; W03 cannot start." Then open `apps/api/src/services/billingRuleResolver.ts` and record the **exact** field names the resolved rule uses for the minimum and the rounding increment — every `NOT VERIFIED: confirm against merged W02` marker in this plan resolves to those names.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/billableMinutes.test.ts
import { describe, expect, it } from 'vitest';
import { computeBillableMinutes } from './billableMinutes';

// The grid is the contract. Task 8 replays this EXACT table through Postgres
// and through the CHECK constraint; if you add a row here, add it there too.
export const BILLABLE_MINUTES_GRID: Array<{
  name: string;
  durationMinutes: number | null;
  minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
  expected: number | null;
}> = [
  { name: 'no terms at all → actual duration', durationMinutes: 37, minimumMinutes: null, roundingIncrementMinutes: null, expected: 37 },
  { name: 'running timer → null', durationMinutes: null, minimumMinutes: 60, roundingIncrementMinutes: 15, expected: null },
  { name: 'rounding only, exact multiple stays put', durationMinutes: 30, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 30 },
  { name: 'rounding only, rounds UP never down', durationMinutes: 31, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 45 },
  { name: 'rounding only, one minute rounds to a full block', durationMinutes: 1, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 15 },
  { name: 'zero-minute entry with rounding stays zero', durationMinutes: 0, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 0 },
  { name: 'minimum only, below the floor', durationMinutes: 20, minimumMinutes: 60, roundingIncrementMinutes: null, expected: 60 },
  { name: 'minimum only, above the floor', durationMinutes: 75, minimumMinutes: 60, roundingIncrementMinutes: null, expected: 75 },
  { name: 'minimum wins over rounding', durationMinutes: 20, minimumMinutes: 60, roundingIncrementMinutes: 15, expected: 60 },
  { name: 'rounding wins over minimum', durationMinutes: 61, minimumMinutes: 60, roundingIncrementMinutes: 15, expected: 75 },
  { name: 'they tie', durationMinutes: 55, minimumMinutes: 60, roundingIncrementMinutes: 60, expected: 60 },
  { name: 'increment 0 is treated as no rounding, not a divide by zero', durationMinutes: 37, minimumMinutes: null, roundingIncrementMinutes: 0, expected: 37 },
  { name: 'minimum 0 is not a floor', durationMinutes: 7, minimumMinutes: 0, roundingIncrementMinutes: null, expected: 7 },
  { name: 'increment 1 is a no-op', durationMinutes: 37, minimumMinutes: null, roundingIncrementMinutes: 1, expected: 37 },
  { name: 'increment 480 (the §4.2 ceiling)', durationMinutes: 1, minimumMinutes: null, roundingIncrementMinutes: 480, expected: 480 },
  { name: 'long entry, 6-minute increment', durationMinutes: 487, minimumMinutes: null, roundingIncrementMinutes: 6, expected: 492 },
];

describe('computeBillableMinutes', () => {
  for (const row of BILLABLE_MINUTES_GRID) {
    it(row.name, () => {
      expect(
        computeBillableMinutes({
          durationMinutes: row.durationMinutes,
          minimumMinutes: row.minimumMinutes,
          roundingIncrementMinutes: row.roundingIncrementMinutes,
        })
      ).toBe(row.expected);
    });
  }

  it('never returns a non-integer even with an awkward increment', () => {
    const out = computeBillableMinutes({ durationMinutes: 100, minimumMinutes: null, roundingIncrementMinutes: 7 });
    expect(out).toBe(105);
    expect(Number.isInteger(out)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd apps/api && npx vitest run src/services/billableMinutes.test.ts
```
Expected: FAIL — `Failed to resolve import "./billableMinutes"`.

- [ ] **Step 3: Write the module**

```ts
// apps/api/src/services/billableMinutes.ts
import { sql, type SQL } from 'drizzle-orm';
import { timeEntries } from '../db/schema/timeTracking';

/**
 * Spec §3.5. ONE arithmetic, in two representations that a CHECK constraint
 * forces to agree:
 *
 *   billable_minutes = GREATEST(COALESCE(minimum_minutes, 0),
 *     CASE WHEN rounding_increment_minutes > 0
 *          THEN CEIL(duration_minutes / rounding_increment_minutes) * rounding_increment_minutes
 *          ELSE duration_minutes END)
 *
 * NULL duration (a running timer) yields NULL: an unfinished entry has no
 * billable quantity. Pre-feature rows also stay NULL, which is why every money
 * reader uses COALESCE(billable_minutes, duration_minutes) and never the column
 * bare.
 *
 * `rounding_increment_minutes = 0` is treated as "no rounding" rather than a
 * divide-by-zero. §4.2 constrains the column to NULL or 1-480, so 0 should be
 * unreachable, but the guard has to exist in BOTH representations or the CHECK
 * and the service disagree on a row the constraint would then reject.
 */
export const BILLABLE_MINUTES_CHECK_NAME = 'time_entries_billable_minutes_chk';

export function computeBillableMinutes(input: {
  durationMinutes: number | null;
  minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
}): number | null {
  const { durationMinutes } = input;
  if (durationMinutes == null) return null;
  const increment = input.roundingIncrementMinutes ?? 0;
  const rounded = increment > 0
    ? Math.ceil(durationMinutes / increment) * increment
    : durationMinutes;
  return Math.max(input.minimumMinutes ?? 0, rounded);
}

/**
 * The same expression as a Drizzle fragment, for statements that compute the
 * duration in SQL (stopRunningEntry's CAS) and for the integration test that
 * replays the TS grid through Postgres.
 *
 * `durationExpr` is inlined TWICE on purpose: the CAS sets duration_minutes in
 * the same UPDATE, so the column reference would still see the OLD value.
 */
export function billableMinutesSql(durationExpr: SQL | number): SQL<number> {
  const d = sql`(${durationExpr})`;
  return sql<number>`GREATEST(
    COALESCE(${timeEntries.minimumMinutes}, 0),
    CASE WHEN COALESCE(${timeEntries.roundingIncrementMinutes}, 0) > 0
         THEN (CEIL(${d}::numeric / ${timeEntries.roundingIncrementMinutes}) * ${timeEntries.roundingIncrementMinutes})::int
         ELSE ${d} END
  )::int`;
}
```

> `NOT VERIFIED: confirm against merged W02` — `timeEntries.minimumMinutes` and `timeEntries.roundingIncrementMinutes` are the Drizzle property names W02 is expected to use for `minimum_minutes` / `rounding_increment_minutes`. If W02 named them differently, fix the two references here and nowhere else — every other file in this plan goes through this module.

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd apps/api && npx vitest run src/services/billableMinutes.test.ts
```
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billableMinutes.ts apps/api/src/services/billableMinutes.test.ts
git commit -m "feat(billing): one billable-minutes arithmetic in TS and SQL (#4628 W03)"
```

---

### Task 2: Migration — the column, the CHECK, and the bounded W02-gap backfill

**Files:**
- Create: `apps/api/migrations/2026-10-23-090000-time-entries-billable-minutes.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts` (the `timeEntries` table, line 22)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:662`

**Interfaces:**
- Consumes: `time_entries.minimum_minutes`, `time_entries.rounding_increment_minutes` (W02).
- Produces: `time_entries.billable_minutes` integer NULL; CHECK `time_entries_billable_minutes_chk`; the Drizzle property `timeEntries.billableMinutes`.

**Why a backfill at all, and why a narrow one.** §4.3 says *"every existing row is NULL"* and pre-feature rows stay NULL forever — readers COALESCE. But between W02 (which stamps `minimum_minutes` / `rounding_increment_minutes`) and W03 there is a window in which entries carry real card terms and **no** `billable_minutes`; those rows would silently bill at actual duration and contradict their own stamp. So the backfill covers exactly that window and nothing else:

- only rows with `ended_at IS NOT NULL` (a running timer must stay NULL),
- only rows that actually carry a term (`minimum_minutes IS NOT NULL OR rounding_increment_minutes IS NOT NULL`) — a row with no terms would compute to `duration_minutes`, which changes nothing but destroys the "NULL means pre-feature" signal,
- **never** `billing_status = 'billed'` — an invoiced row's quantity is already on a customer's invoice; recomputing it would make `COALESCE` disagree with a document that has shipped.

`time_entries` is a hot table, so the backfill is a `ctid` batch loop, not one `UPDATE`.

- [ ] **Step 1: Check the filename still sorts last**

```bash
ls apps/api/migrations | sort | tail -5
```
The new file must sort **after** every line printed. If it does not, rename it (keep `YYYY-MM-DD-HHMMSS-<slug>.sql`; never an epoch prefix; never a `2026-08-06-g-` infix).

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-10-23-090000-time-entries-billable-minutes.sql
-- #4628 W03 — spec §3.5 / §4.3.
-- Adds the service-written billable_minutes column and pins it with a CHECK
-- carrying the IDENTICAL expression to billableMinutes.ts, so drift between the
-- TypeScript function and the SQL fragment becomes a 23514 rather than a wrong
-- invoice. Not a generated column: that rewrites this hot billing table under
-- ACCESS EXCLUSIVE, and generated columns are invisible to Drizzle and
-- db:check-drift.
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT here.

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS billable_minutes integer;

COMMENT ON COLUMN time_entries.billable_minutes IS
  'Minutes actually billed after the card''s minimum and rounding (spec §3.5). NULL while a timer runs and on pre-feature rows; money readers use COALESCE(billable_minutes, duration_minutes).';

-- The CHECK. NOT VALID first so the ACCESS EXCLUSIVE lock is held only for the
-- catalog update, then VALIDATE under a weaker lock.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_billable_minutes_chk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_billable_minutes_chk
  CHECK (
    billable_minutes IS NULL
    OR (
      duration_minutes IS NOT NULL
      AND billable_minutes = GREATEST(
        COALESCE(minimum_minutes, 0),
        CASE WHEN COALESCE(rounding_increment_minutes, 0) > 0
             THEN (CEIL(duration_minutes::numeric / rounding_increment_minutes) * rounding_increment_minutes)::int
             ELSE duration_minutes END
      )
    )
  ) NOT VALID;

-- Backfill the W02→W03 window. Row-writing, so system scope is elected FIRST
-- (breeze_current_scope() defaults to 'none' and time_entries is FORCE ROW
-- LEVEL SECURITY, which binds the owner this migration runs as; without this
-- the UPDATE matches ZERO rows and the RAISE WARNING prints a truthful-looking 0).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  batch integer;
  total integer := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    UPDATE time_entries t
    SET billable_minutes = GREATEST(
      COALESCE(t.minimum_minutes, 0),
      CASE WHEN COALESCE(t.rounding_increment_minutes, 0) > 0
           THEN (CEIL(t.duration_minutes::numeric / t.rounding_increment_minutes) * t.rounding_increment_minutes)::int
           ELSE t.duration_minutes END
    )
    WHERE t.ctid IN (
      SELECT s.ctid FROM time_entries s
      WHERE s.billable_minutes IS NULL
        AND s.ended_at IS NOT NULL
        AND s.duration_minutes IS NOT NULL
        AND (s.minimum_minutes IS NOT NULL OR s.rounding_increment_minutes IS NOT NULL)
        -- An invoiced row's quantity is already on a customer's document.
        AND s.billing_status <> 'billed'
      LIMIT 5000
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch = 0;
  END LOOP;
  -- Always reported, including 0: a zero here is evidence the W02→W03 window
  -- was empty, which is what we want on a fresh database.
  RAISE WARNING 'billing profiles W03: backfilled billable_minutes on % time_entries (W02 stamp window)', total;
END $$;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT COUNT(*) INTO n FROM time_entries
  WHERE billable_minutes IS NULL
    AND ended_at IS NOT NULL
    AND billing_status = 'billed'
    AND (minimum_minutes IS NOT NULL OR rounding_increment_minutes IS NOT NULL);
  IF n > 0 THEN
    RAISE WARNING 'billing profiles W03: % already-invoiced entries carry card terms but no billable_minutes and were deliberately LEFT NULL (their invoiced quantity stands)', n;
  END IF;
END $$;

ALTER TABLE time_entries VALIDATE CONSTRAINT time_entries_billable_minutes_chk;
```

- [ ] **Step 3: Add the column to the Drizzle schema**

In `apps/api/src/db/schema/timeTracking.ts`, in the `timeEntries` table definition, immediately after the W02 `roundingIncrementMinutes` line:

```ts
  // Spec §3.5: minutes actually billed after the card's minimum and rounding.
  // Written by the service, pinned by time_entries_billable_minutes_chk. NULL
  // while a timer runs and on pre-feature rows — money readers COALESCE.
  billableMinutes: integer('billable_minutes'),
```

> `NOT VERIFIED: confirm against merged W02` — the anchor line. If W02 put the minute columns elsewhere in the table, place `billableMinutes` beside them.

- [ ] **Step 4: Register the column in the export policy**

`apps/api/src/services/tenantExportPolicyRegistry.ts:662` — append `"billable_minutes"` to `time_entries`' `included` array. It is a monotonic integer, not a container, and not a credential, so `included` is the right bucket. **This is not optional**: CLAUDE.md's export-policy row is the one registration that fires on a new *column*, and the suite that catches it is integration-only, so a unit-green PR reddens main.

```ts
  "time_entries": tablePolicy("org_id", {"included":["id","partner_id","org_id","ticket_id","user_id","started_at","ended_at","duration_minutes","billable_minutes","description","is_billable","hourly_rate","currency_code","billing_status","source","is_approved","approved_by","approved_at","created_at","updated_at", /* …W01/W02 columns… */],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

> `NOT VERIFIED: confirm against merged W02` — W02 adds `work_type_id`, `billing_profile_id`, `coverage`, `billing_overridden`, `minimum_minutes`, `rounding_increment_minutes` to this same array. Do not delete them; insert `billable_minutes` next to `duration_minutes` and leave the rest alone.

- [ ] **Step 5: Apply the migration and check for drift**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL' .env.test | cut -d= -f2-)"
pnpm db:migrate
pnpm db:check-drift
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: migration applies; `db:check-drift` reports no drift; both DB tests PASS. `migrationRlsScope.test.ts` must pass **without** adding this file to its baseline — the `SELECT set_config(...)` before the first write is what satisfies it.

- [ ] **Step 6: Run the export-policy contract suites (integration-only)**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: PASS. If you skip this step and `billable_minutes` is unclassified, CI goes red in **Integration Tests** shard, not in Test API.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-23-090000-time-entries-billable-minutes.sql \
        apps/api/src/db/schema/tickets.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(billing): time_entries.billable_minutes + pinning CHECK + export policy (#4628 W03)"
```

---

### Task 3: Write `billable_minutes` on entry creation and timer start

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` (`createTimeEntry` ~`:509`, `startTimer` ~`:636-657`)
- Test: `apps/api/src/services/timeEntryService.test.ts`

**Interfaces:**
- Consumes: `computeBillableMinutes` (Task 1); the W02 resolved rule's `minimumMinutes` / `roundingIncrementMinutes`.
- Produces: `time_entries.billable_minutes` populated on every created, already-closed entry; `NULL` on a started timer.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/timeEntryService.test.ts`:

```ts
describe('billable_minutes on create/start (#4628 W03)', () => {
  it('createTimeEntry stamps billable_minutes from the resolved minimum and increment', async () => {
    // 20 worked minutes against a 60-minute minimum bills an hour.
    const values = await captureCreateInsertValues({
      startedAt: new Date('2026-03-03T09:00:00Z'),
      endedAt: new Date('2026-03-03T09:20:00Z'),
      resolvedRule: { coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60, roundingIncrementMinutes: 15 },
    });
    expect(values.durationMinutes).toBe(20);
    expect(values.billableMinutes).toBe(60);
  });

  it('createTimeEntry with no card terms stamps billable_minutes equal to the duration', async () => {
    const values = await captureCreateInsertValues({
      startedAt: new Date('2026-03-03T09:00:00Z'),
      endedAt: new Date('2026-03-03T09:37:00Z'),
      resolvedRule: { coverage: 'billable', hourlyRate: '150.00', minimumMinutes: null, roundingIncrementMinutes: null },
    });
    expect(values.billableMinutes).toBe(37);
  });

  it('startTimer leaves billable_minutes NULL — an unfinished entry has no billable quantity', async () => {
    const values = await captureStartTimerInsertValues({
      resolvedRule: { coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60, roundingIncrementMinutes: 15 },
    });
    expect(values.durationMinutes).toBeNull();
    expect(values.billableMinutes).toBeNull();
  });
});
```

> `NOT VERIFIED: confirm against merged W02` — `captureCreateInsertValues` / `captureStartTimerInsertValues` are helpers you write against W02's existing mock harness in this file (the file already mocks `db.insert(...).values(...)`; reuse that pattern and return the captured `values` object). The `resolvedRule` shape must match what W02's `resolveBillingRule()` returns.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts -t "billable_minutes on create/start"
```
Expected: FAIL — `billableMinutes` is `undefined` in the captured insert values.

- [ ] **Step 3: Implement**

In `createTimeEntry` (`apps/api/src/services/timeEntryService.ts`, the `.values({ … })` block around `:509`), beside the existing `durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),`:

```ts
      durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
      // Spec §3.5 — the billed quantity, from the SAME terms this row stamps.
      billableMinutes: computeBillableMinutes({
        durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
        minimumMinutes: minimumMinutes,
        roundingIncrementMinutes: roundingIncrementMinutes,
      }),
```

In `startTimer`'s insert (around `:645`), beside `durationMinutes: null`:

```ts
        durationMinutes: null,
        // A running timer has no billed quantity yet; stopRunningEntry lands it.
        billableMinutes: null,
```

Add the import at the top of the file:

```ts
import { computeBillableMinutes, billableMinutesSql } from './billableMinutes';
```

> `NOT VERIFIED: confirm against merged W02` — `minimumMinutes` / `roundingIncrementMinutes` are the locals W02's stamping code already holds in `createTimeEntry` (it writes them to the row). Reuse those locals; do not re-resolve the rule.

- [ ] **Step 4: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts
```
Expected: PASS (whole file, so W02's stamping cases stay green too).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts
git commit -m "feat(billing): stamp billable_minutes on entry create; NULL on timer start (#4628 W03)"
```

---

### Task 4: Both stop paths land `billable_minutes` — the CAS and the PATCH

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` — `stopRunningEntry` (`:565-583`), `updateTimeEntry` (the duration recompute at `:812-813`)
- Test: `apps/api/src/services/timeEntryService.test.ts`

**Interfaces:**
- Consumes: `billableMinutesSql` and `computeBillableMinutes` (Task 1).
- Produces: `stopTimer` and `PATCH /time-entries/:id { endedAt }` both leave a row satisfying `time_entries_billable_minutes_chk` with a non-NULL value.

**Why both.** Spec §3.7: `stopRunningEntry` is a single-statement lock-free CAS, and **mobile replays a stop as `PATCH { endedAt }`** (`apps/mobile/src/services/timeEntryReplay.test.ts:144` pins exactly that). If only the CAS wrote the column, every mobile-replayed stop would produce a row with a stamped minimum and no billable quantity — billing at actual duration and contradicting its own stamp. The CAS computes duration in SQL, so it must use the SQL fragment with the duration expression inlined; the PATCH path has the numbers in TypeScript, so it uses the TS function. That is precisely the drift the CHECK exists to catch.

- [ ] **Step 1: Write the failing tests**

```ts
describe('both stop paths land billable_minutes (#4628 W03)', () => {
  it('stopRunningEntry (CAS) sets billable_minutes in the SAME statement, from an inlined duration expression', async () => {
    const setArg = await captureStopUpdateSet(); // reuse this file's db.update mock harness
    const rendered = String(setArg.billableMinutes);
    // The fragment must NOT reference duration_minutes as a column: the CAS is
    // setting that column in this same UPDATE, so the reference would read the
    // OLD (NULL) value and the CHECK would reject the row.
    expect(rendered).not.toMatch(/duration_minutes/);
    expect(rendered).toMatch(/GREATEST/);
    expect(rendered).toMatch(/CEIL/);
  });

  it('updateTimeEntry recomputes billable_minutes whenever it recomputes durationMinutes', async () => {
    const set = await captureUpdateSet({
      entry: {
        startedAt: new Date('2026-03-03T09:00:00Z'),
        endedAt: null,
        durationMinutes: null,
        minimumMinutes: 60,
        roundingIncrementMinutes: 15,
        billingStatus: 'not_billed',
      },
      input: { endedAt: new Date('2026-03-03T09:20:00Z') },
    });
    expect(set.durationMinutes).toBe(20);
    expect(set.billableMinutes).toBe(60);
  });

  it('updateTimeEntry does NOT touch billable_minutes when neither timestamp changed', async () => {
    const set = await captureUpdateSet({
      entry: {
        startedAt: new Date('2026-03-03T09:00:00Z'),
        endedAt: new Date('2026-03-03T09:20:00Z'),
        durationMinutes: 20,
        minimumMinutes: 60,
        roundingIncrementMinutes: 15,
        billingStatus: 'not_billed',
      },
      input: { description: 'typo fix' },
    });
    expect(set).not.toHaveProperty('billableMinutes');
  });

  it('updateTimeEntry re-derives billable_minutes when a re-price changes the minimum', async () => {
    // Spec §3.7: an entry is re-priced when its own workTypeId changes.
    const set = await captureUpdateSet({
      entry: {
        startedAt: new Date('2026-03-03T09:00:00Z'),
        endedAt: new Date('2026-03-03T09:20:00Z'),
        durationMinutes: 20,
        minimumMinutes: null,
        roundingIncrementMinutes: null,
        billingStatus: 'not_billed',
      },
      input: { workTypeId: 'wt-onsite' },
      resolvedRule: { coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60, roundingIncrementMinutes: 15 },
    });
    expect(set.minimumMinutes).toBe(60);
    expect(set.billableMinutes).toBe(60);
  });

  it('billableMinutes is in BILLED_LOCKED_ENTRY_FIELDS-protected territory: a billed entry cannot be re-timed', async () => {
    await expect(
      callUpdateTimeEntry({
        entry: { billingStatus: 'billed', startedAt: new Date('2026-03-03T09:00:00Z'), endedAt: new Date('2026-03-03T09:20:00Z') },
        input: { endedAt: new Date('2026-03-03T10:20:00Z') },
      })
    ).rejects.toMatchObject({ code: 'ENTRY_BILLED' });
  });
});
```

> `NOT VERIFIED: confirm against merged W02` — `captureUpdateSet`'s `resolvedRule` plumbing and the re-price trigger for `workTypeId` are W02's; if W02 exposed the re-price through a differently named helper, drive it through that instead. The last case only re-pins existing behaviour (`endedAt` is already in `BILLED_LOCKED_ENTRY_FIELDS`, `timeEntryService.ts:375`) — it must pass unchanged.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts -t "both stop paths land billable_minutes"
```
Expected: FAIL — `set.billableMinutes` undefined; the CAS test fails on `String(undefined)`.

- [ ] **Step 3: Implement the CAS**

Replace the `.set({...})` in `stopRunningEntry` (`apps/api/src/services/timeEntryService.ts:572-579`) with:

```ts
  // The duration expression is built ONCE and inlined in both places: the
  // column is being assigned in this same UPDATE, so a `duration_minutes`
  // reference inside billableMinutesSql would read the OLD (NULL) value and
  // the CHECK would reject the row (23514).
  const durationExpr = sql`FLOOR(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamp - ${timeEntries.startedAt})) / 60)::int`;
  const rows = await db
    .update(timeEntries)
    .set({
      endedAt: now,
      durationMinutes: durationExpr,
      // Spec §3.5 — same arithmetic as computeBillableMinutes(), pinned by
      // time_entries_billable_minutes_chk.
      billableMinutes: billableMinutesSql(durationExpr),
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.isBillable !== undefined ? { isBillable: overrides.isBillable } : {})
    })
    .where(and(eq(timeEntries.userId, actor.userId), isNull(timeEntries.endedAt)))
    .returning();
```

- [ ] **Step 4: Implement the PATCH path**

In `updateTimeEntry` (`apps/api/src/services/timeEntryService.ts:811-814`), replace the duration recompute block with:

```ts
  if ((input.startedAt !== undefined || input.endedAt !== undefined) && endedAt) {
    set.durationMinutes = computeDurationMinutes(startedAt, endedAt);
    changed.push('durationMinutes');
  }
  // Spec §3.5 — recompute the billed quantity whenever EITHER the duration or
  // the card terms on this row move. Mobile replays a stop as PATCH { endedAt }
  // (see apps/mobile/src/services/timeEntryReplay.test.ts), so this branch — not
  // just stopRunningEntry — is a real stop path.
  const nextDuration = (set.durationMinutes as number | undefined) ?? entry.durationMinutes;
  const nextMinimum = (set.minimumMinutes as number | null | undefined) ?? entry.minimumMinutes;
  const nextIncrement = (set.roundingIncrementMinutes as number | null | undefined) ?? entry.roundingIncrementMinutes;
  if (
    set.durationMinutes !== undefined ||
    set.minimumMinutes !== undefined ||
    set.roundingIncrementMinutes !== undefined
  ) {
    set.billableMinutes = computeBillableMinutes({
      durationMinutes: nextDuration ?? null,
      minimumMinutes: nextMinimum ?? null,
      roundingIncrementMinutes: nextIncrement ?? null,
    });
    changed.push('billableMinutes');
  }
```

> `NOT VERIFIED: confirm against merged W02` — `set.minimumMinutes` / `set.roundingIncrementMinutes` are set by W02's re-price branch earlier in this function. Place this block **after** that branch so a re-price and a duration change in one PATCH both feed the same recompute.

- [ ] **Step 5: Gate a hand-set `minimumMinutes` on `manage_billing`**

Spec §3.7: `minimumMinutes` is one of the three fields that require `time_entries:manage_billing` to deviate from the card. W02 implements the gate; confirm `minimumMinutes` is in its field list, and if not, add it there (service-level, via `actor.manageBilling` — **not** a route gate, because the AI tool at `aiToolsTicketing.ts:1005-1013`, the Office add-in (`apps/api/src/routes/officeAddin/time.ts`) and `intentReleaseWorker` pass billing fields straight through and would bypass one).

```bash
grep -n "manageBilling" apps/api/src/services/timeEntryService.ts
```
Expected: the override check names `hourlyRate`, `billingStatus` **and** `minimumMinutes`.
> `NOT VERIFIED: confirm against merged W02`.

- [ ] **Step 6: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts
```
Expected: PASS, whole file.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts
git commit -m "feat(billing): stop-via-CAS and stop-via-PATCH both land billable_minutes (#4628 W03)"
```

---

### Task 5: The three money readers — ticket summary, billables, timesheet

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` — `getTimesheet` (`:1168`, money loop ~`:1206-1220`), `getTicketBillingSummary` (`:1233`), `listBillables` (`:1323`)
- Test: `apps/api/src/services/timeEntryService.test.ts`

**Interfaces:**
- Consumes: `time_entries.billable_minutes`, `time_entries.coverage` (W02).
- Produces: `getTicketBillingSummary(...)` returns `time.includedMinutes: number` in addition to today's `totalMinutes`, `billableMinutes`, `billableAmounts`. `listBillables` rows' `quantity` becomes billed hours. `getTimesheet` totals' `billableAmounts` become billed-quantity money; `days[].totalMinutes` and `days[].billableMinutes` stay **actual**.

**These are "the three summary suites" of spec §9** — the readers §3.4 names as filtering on `is_billable AND hourly_rate IS NOT NULL` with no status predicate:

| Reader | File:line | Test home |
|---|---|---|
| `getTicketBillingSummary` | `apps/api/src/services/timeEntryService.ts:1233` | `timeEntryService.test.ts:1195`, and `apps/api/src/routes/tickets/parts.test.ts:313` for the route shape |
| `listBillables` (+ the billing CSV at `apps/api/src/routes/tickets/export.ts:29`) | `apps/api/src/services/timeEntryService.ts:1323` | `timeEntryService.test.ts` (imported at `:149`) |
| the timesheet money loop | `apps/api/src/services/timeEntryService.ts:1206-1220` | `timeEntryService.test.ts` |

An **included** entry (coverage `included` → `billing_status = 'contract'`, `hourly_rate` NULL) must add **no money** in all three. That already falls out of the `hourly_rate IS NOT NULL` predicate in the first, and `toFinite(null) → '0.00'` in `listBillables` (`timeEntryService.ts:1301-1308`); this task pins it with tests so a later change cannot quietly break it.

- [ ] **Step 1: Write the failing tests**

```ts
describe('money readers read COALESCE(billable_minutes, duration_minutes) (#4628 W03)', () => {
  it('getTicketBillingSummary money SQL uses COALESCE, and totalMinutes stays actual', async () => {
    const sqlText = await captureTicketSummarySql();
    expect(sqlText.money).toMatch(/COALESCE\(.*billable_minutes.*duration_minutes.*\)/s);
    // Utilization figure — actual minutes, never the billed quantity (§3.5).
    expect(sqlText.totals).toMatch(/SUM\(\s*"?time_entries"?\."?duration_minutes/);
  });

  it('getTicketBillingSummary returns includedMinutes for contract-covered entries', async () => {
    queueSummaryRows({ totalMinutes: 90, billableMinutes: 60, includedMinutes: 30 });
    const result = await getTicketBillingSummary('t-1');
    expect(result.time.includedMinutes).toBe(30);
  });

  it('an INCLUDED entry adds no money to the ticket summary', async () => {
    // coverage 'included' => billing_status 'contract', hourly_rate NULL.
    queueSummaryMoneyRows([]); // the hourly_rate IS NOT NULL predicate excluded it
    const result = await getTicketBillingSummary('t-1');
    expect(result.time.billableAmounts).toEqual([]);
  });

  it('listBillables bills the MINIMUM, not the worked minutes', async () => {
    queueBillableTimeRows([{
      date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
      description: 'On-site', technician: 'Pat',
      minutes: 20, billableMinutes: 60,
      rate: '225.00', currencyCode: 'USD', billingStatus: 'not_billed', isApproved: true,
    }]);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0].quantity).toBe('1.00');          // 60 min, not 0.33
    expect(rows[0].amount).toBe('225.00');
    expect(totalsByCurrency).toEqual([{ currencyCode: 'USD', amount: '225.00' }]);
  });

  it('listBillables falls back to duration_minutes on a pre-feature row', async () => {
    queueBillableTimeRows([{
      date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
      description: 'Remote', technician: 'Pat',
      minutes: 30, billableMinutes: null,
      rate: '100.00', currencyCode: 'USD', billingStatus: 'not_billed', isApproved: true,
    }]);
    const { rows } = await listBillables(FROM, TO);
    expect(rows[0].quantity).toBe('0.50');
    expect(rows[0].amount).toBe('50.00');
  });

  it('an INCLUDED entry appears in listBillables with no money', async () => {
    queueBillableTimeRows([{
      date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
      description: 'Covered remote', technician: 'Pat',
      minutes: 45, billableMinutes: 45,
      rate: null, currencyCode: 'USD', billingStatus: 'contract', isApproved: true,
    }]);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0].quantity).toBe('0.75');
    expect(rows[0].amount).toBe('0.00');
    expect(totalsByCurrency).toEqual([]);
  });

  it('the timesheet bills the minimum but reports ACTUAL minutes in day totals', async () => {
    queueTimesheetEntries([{
      startedAt: new Date('2026-03-03T09:00:00Z'),
      durationMinutes: 20, billableMinutes: 60,
      isBillable: true, hourlyRate: '225.00', currencyCode: 'USD',
    }]);
    const sheet = await getTimesheet('u-1', new Date('2026-03-02T00:00:00Z'));
    expect(sheet.totals.billableAmounts).toEqual([{ currencyCode: 'USD', amount: '225.00' }]);
    // Utilization is about time WORKED (§3.5).
    expect(sheet.totals.totalMinutes).toBe(20);
    expect(sheet.totals.billableMinutes).toBe(20);
  });

  it('an INCLUDED entry adds no money to the timesheet', async () => {
    queueTimesheetEntries([{
      startedAt: new Date('2026-03-03T09:00:00Z'),
      durationMinutes: 45, billableMinutes: 45,
      isBillable: true, hourlyRate: null, currencyCode: 'USD',
    }]);
    const sheet = await getTimesheet('u-1', new Date('2026-03-02T00:00:00Z'));
    expect(sheet.totals.billableAmounts).toEqual([]);
    expect(sheet.totals.billableMinutes).toBe(45);
  });
});
```

> `NOT VERIFIED: confirm against merged W02` — `captureTicketSummarySql`, `queueSummaryRows`, `queueBillableTimeRows`, `queueTimesheetEntries` are helpers over this file's existing `db.select` mock harness (see the existing `getTicketBillingSummary` case at `timeEntryService.test.ts:1195` for the pattern). Write them against whatever harness W02 left in place.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts -t "money readers read COALESCE"
```
Expected: FAIL — `includedMinutes` undefined, `quantity` `'0.33'` instead of `'1.00'`.

- [ ] **Step 3: `getTicketBillingSummary`**

`apps/api/src/services/timeEntryService.ts:1234-1252`:

```ts
  const timeRows = await db
    .select({
      // Utilization figures — ACTUAL minutes worked (§3.5). Not the billed quantity.
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)::int`,
      // Billed quantity (§3.5): the minimum/rounding result when the row has one.
      billableMinutes: sql<number>`COALESCE(SUM(COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})) FILTER (WHERE ${timeEntries.isBillable}), 0)::int`,
      // §3.4: the summary gains includedMinutes. A minimum can only sit on a
      // `billable` row (§4.2 CHECK), so for an included row COALESCE is the
      // duration — the COALESCE is kept for uniformity, not for effect.
      includedMinutes: sql<number>`COALESCE(SUM(COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})) FILTER (WHERE ${timeEntries.billingStatus} = 'contract'), 0)::int`
    })
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, ticketId));

  // Money is grouped per currency — never summed across currencies.
  const timeMoney = await db
    .select({
      currencyCode: timeEntries.currencyCode,
      // Labor rule unchanged: hours to 2 dp, then × rate, then ONE round per row
      // at the currency's minor unit. Only the MINUTES source changed (§3.5).
      amount: sql<string>`COALESCE(SUM(ROUND(ROUND(COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})::numeric / 60, 2) * ${timeEntries.hourlyRate}, ${minorUnitScaleSql(timeEntries.currencyCode)})), 0)::numeric(12,2)`
    })
```

and in the returned object, the default when `timeRows[0]` is absent:

```ts
      ...(timeRows[0] ?? { totalMinutes: 0, billableMinutes: 0, includedMinutes: 0 }),
```

- [ ] **Step 4: `listBillables`**

`apps/api/src/services/timeEntryService.ts:1345` — add to the select projection, beside `minutes: timeEntries.durationMinutes,`:

```ts
      minutes: timeEntries.durationMinutes,
      billableMinutes: timeEntries.billableMinutes,
```

and at `:1301` change the hours derivation:

```ts
  for (const r of timeRows) {
    // Billed quantity (§3.5). NULL billable_minutes = pre-feature row or a row
    // with no card terms — bill the actual duration.
    const hours = (((r.billableMinutes ?? r.minutes) ?? 0) / 60).toFixed(2);
```

- [ ] **Step 5: `getTimesheet`**

The selection at `entrySelection()` must carry `billableMinutes` (it is used by the money loop and by the web display in Task 9). Find `entrySelection()` in this file and add `billableMinutes: timeEntries.billableMinutes,`. Then, in the money loop (`:1206-1214`) — and **only** there:

```ts
  for (const entry of entries) {
    if (!entry.isBillable || entry.hourlyRate == null || entry.currencyCode == null) continue;
    // Labor rule unchanged; only the minutes source moved to the billed
    // quantity (§3.5). Day totals above deliberately keep ACTUAL minutes.
    const hours = (((entry.billableMinutes ?? entry.durationMinutes) ?? 0) / 60).toFixed(2);
    const amount = multiplyToCurrency(hours, entry.hourlyRate, entry.currencyCode);
```

Leave the day-total loop at `:1199-1203` **exactly as it is** — `day.totalMinutes` and `day.billableMinutes` are utilization.

- [ ] **Step 6: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts src/routes/tickets/parts.test.ts src/routes/tickets/export.test.ts
```
Expected: PASS. `parts.test.ts:313` mocks `getTicketBillingSummary`'s return value — add `includedMinutes: 0` to those four mocks (`:313`, `:336`, `:352`, `:375`) if the route now reads it.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts apps/api/src/routes/tickets/parts.test.ts
git commit -m "feat(billing): ticket summary, billables and timesheet bill the minimum; summary gains includedMinutes (#4628 W03)"
```

---

### Task 6: Portal readers — a customer's hours match their invoice

**Files:**
- Modify: `apps/api/src/services/portal/supportUsage.ts` (`:20`, `:70`, `:94-130`)
- Test: `apps/api/src/services/portal/supportUsage.test.ts`

**Interfaces:**
- Consumes: `time_entries.billable_minutes`.
- Produces: the portal's `billed` / `unbilled` buckets and per-ticket `billedMinutes` become billed quantity; nothing else moves.

Spec §3.5 names the portal's **billed / unbilled buckets** explicitly, with the reason: *"so a customer's hours match their invoice."* The contract-covered bucket is already the `contract` branch (`supportUsage.ts:116-124`) and the portal already renders it that way (§3.4).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/portal/supportUsage.test.ts`:

```ts
it('the portal billed bucket reports the BILLED quantity, so it matches the invoice (#4628 W03)', async () => {
  // Shape the queued rows exactly as the existing cases in this file do (see the
  // first test, ~line 60-88) and add `billableMinutes`.
  queuedRows = [
    { /* …existing row fields… */ durationMinutes: 20, billableMinutes: 60, billingStatus: 'billed', isApproved: true },
  ];
  const result = await supportUsageForOrg(args);
  expect(result.totals.billed).toEqual({ minutes: 60, hours: 1 });
  expect(result.tickets[0].billedMinutes).toBe(60);
});

it('a pre-feature portal row falls back to the actual duration (#4628 W03)', async () => {
  queuedRows = [
    { /* … */ durationMinutes: 30, billableMinutes: null, billingStatus: 'billed', isApproved: true },
  ];
  const result = await supportUsageForOrg(args);
  expect(result.totals.billed).toEqual({ minutes: 30, hours: 0.5 });
});

it('pendingReview and coveredByContract stay ACTUAL minutes (#4628 W03 scope pin)', async () => {
  queuedRows = [
    { /* … */ durationMinutes: 20, billableMinutes: 60, billingStatus: 'not_billed', isApproved: false },
    { /* … */ durationMinutes: 20, billableMinutes: null, billingStatus: 'contract', isApproved: true },
  ];
  const result = await supportUsageForOrg(args);
  expect(result.totals.pendingReview.minutes).toBe(20);
  expect(result.totals.coveredByContract.minutes).toBe(20);
});
```

**Verified against current code (2026-09-19):** the export is `supportUsageForOrg(args)` (`supportUsage.ts:36`), not `getSupportUsage`; `totals.billed` is an object `{ minutes, hours }` produced by `amount()` (`:142`), not a string — **do not change the portal DTO shape**. Scope decision (spec §3.5 names only billed / unbilled): `COALESCE(billable_minutes, duration_minutes)` applies to the **`billed` and `toBeBilled`** buckets and per-ticket `billedMinutes` only; `pendingReview` (unapproved — not yet a billed quantity) and `coveredByContract` (included entries carry no `billable_minutes`) keep actual duration. The third test pins that.

> `NOT VERIFIED:` the queued-row variable name and row field names in the existing test file — copy them from the first test in `supportUsage.test.ts` rather than from this snippet.

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/portal/supportUsage.test.ts
```
Expected: FAIL — billed reports `0.33`.

- [ ] **Step 3: Implement**

`apps/api/src/services/portal/supportUsage.ts` — add to the row type at `:20`:

```ts
  durationMinutes: number | null;
  /** Billed quantity after the card's minimum/rounding (#4628 §3.5); NULL on pre-feature rows. */
  billableMinutes: number | null;
```

add to the select at `:70`:

```ts
          durationMinutes: timeEntries.durationMinutes,
          billableMinutes: timeEntries.billableMinutes,
```

and at `:105`:

```ts
    // Actual stopwatch minutes — still what pendingReview and coveredByContract report.
    const minutes = row.durationMinutes ?? 0;
    // Billed quantity (§3.5) — ONLY the billed / toBeBilled buckets and per-ticket
    // billedMinutes use it, so a customer's hours match their invoice.
    const billedQuantity = row.billableMinutes ?? minutes;
```

Then use `billedQuantity` in exactly the `billed` and `toBeBilled` branches (and the per-ticket `billedMinutes` accumulator) at `:116-130`; leave the `contract` and unapproved branches on `minutes`. The scope-pin test from Step 1 goes red if `billedQuantity` leaks into the other two buckets.

- [ ] **Step 4: Run and watch it pass**

```bash
cd apps/api && npx vitest run src/services/portal/supportUsage.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/portal/supportUsage.ts apps/api/src/services/portal/supportUsage.test.ts
git commit -m "feat(portal): support usage buckets read the billed quantity (#4628 W03)"
```

---

### Task 7: Invoice line assembly — bill the minimum, and say so on the line

**Files:**
- Modify: `apps/api/src/services/invoiceAssembly.ts` (`:73-79`, `:88-101`, `:107-125`, and the two select projections at `:147` and `:188`)
- Test: `apps/api/src/services/invoiceAssembly.test.ts`

**Interfaces:**
- Consumes: `time_entries.billable_minutes`.
- Produces: `TimeEntryRow` gains `billableMinutes: number | null`. `timeEntryToLineSpec` and `partitionTimeEntries` bill `COALESCE(billable_minutes, duration_minutes)`. Line descriptions gain the §3.5 note when the two differ. **Lines stay one per entry** (§3.5) — no second line, no surcharge.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/invoiceAssembly.test.ts
describe('minimums and rounding on invoice lines (#4628 W03)', () => {
  const base = { id: 'te-1', ticketId: 'tk-1', isApproved: true, currencyCode: 'USD' as const };

  it('bills the minimum, not the worked minutes', () => {
    const spec = timeEntryToLineSpec(
      { ...base, description: 'On-site', durationMinutes: 30, billableMinutes: 60, hourlyRate: '225.00' },
      'USD'
    );
    expect(spec.quantity).toBe('1.00');
    expect(spec.lineTotal).toBe('225.00');
  });

  it('says on the line when the billed quantity differs from the worked time', () => {
    const spec = timeEntryToLineSpec(
      { ...base, description: 'On-site', durationMinutes: 30, billableMinutes: 60, hourlyRate: '225.00' },
      'USD'
    );
    expect(spec.description).toBe('On-site — 0.50 h worked, 1.00 h billed');
  });

  it('adds no note when the billed quantity equals the worked time', () => {
    const spec = timeEntryToLineSpec(
      { ...base, description: 'Remote', durationMinutes: 60, billableMinutes: 60, hourlyRate: '150.00' },
      'USD'
    );
    expect(spec.description).toBe('Remote');
  });

  it('a pre-feature row (NULL billable_minutes) bills exactly as before', () => {
    const spec = timeEntryToLineSpec(
      { ...base, description: 'Remote', durationMinutes: 30, billableMinutes: null, hourlyRate: '150.00' },
      'USD'
    );
    expect(spec.quantity).toBe('0.50');
    expect(spec.lineTotal).toBe('75.00');
    expect(spec.description).toBe('Remote');
  });

  it('still ONE line per entry — a minimum never adds a second line', () => {
    const result = partitionTimeEntries(
      [{ ...base, description: 'On-site', durationMinutes: 30, billableMinutes: 60, hourlyRate: '225.00' }],
      'USD'
    );
    expect(result.included).toHaveLength(1);
  });

  it('an INCLUDED entry is a missingRate gap, never a zero line — and reports its BILLED quantity', () => {
    // coverage 'included' => hourly_rate NULL (§3.4).
    const result = partitionTimeEntries(
      [{ ...base, description: 'Covered on-site', durationMinutes: 30, billableMinutes: 60, hourlyRate: null }],
      'USD'
    );
    expect(result.included).toHaveLength(0);
    expect(result.missingRate).toEqual([
      expect.objectContaining({ sourceId: 'te-1', quantity: '1.00' }),
    ]);
  });

  it('rounding-only: 31 minutes at a 15-minute increment bills 45', () => {
    const spec = timeEntryToLineSpec(
      { ...base, description: 'Remote', durationMinutes: 31, billableMinutes: 45, hourlyRate: '120.00' },
      'USD'
    );
    expect(spec.quantity).toBe('0.75');
    expect(spec.lineTotal).toBe('90.00');
    expect(spec.description).toBe('Remote — 0.52 h worked, 0.75 h billed');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/invoiceAssembly.test.ts -t "minimums and rounding on invoice lines"
```
Expected: FAIL — `quantity` is `'0.50'`; no description note.

- [ ] **Step 3: Implement**

`apps/api/src/services/invoiceAssembly.ts:73-84`:

```ts
type TimeEntryRow = {
  id: string; ticketId: string | null; description: string | null;
  durationMinutes: number | null;
  /** Billed quantity after the card's minimum/rounding (#4628 §3.5). NULL on
   *  pre-feature rows and rows with no card terms — then the duration bills. */
  billableMinutes: number | null;
  hourlyRate: string | null; isApproved: boolean;
  currencyCode?: string | null;
};

/** Billed quantity (§3.5): COALESCE(billable_minutes, duration_minutes), hours to 2 dp. */
const entryHours = (r: TimeEntryRow) => ((((r.billableMinutes ?? r.durationMinutes) ?? 0)) / 60).toFixed(2);
/** Actual time worked, for the line note only — never for money. */
const entryWorkedHours = (r: TimeEntryRow) => ((r.durationMinutes ?? 0) / 60).toFixed(2);

/** §3.5: "When they differ the invoice line says so." One line per entry,
 *  always — the note is a suffix on the description, never a second line. */
const entryDescription = (r: TimeEntryRow) => {
  const base = r.description?.trim() || 'Labor';
  const billed = entryHours(r);
  const worked = entryWorkedHours(r);
  return billed === worked ? base : `${base} — ${worked} h worked, ${billed} h billed`;
};
```

Both select projections (`:147` and `:188`) gain `billableMinutes: timeEntries.billableMinutes,` beside their existing `durationMinutes:` line. `timeEntryToLineSpec` and `partitionTimeEntries` need no other change — they already route through `entryHours` and `entryDescription`.

- [ ] **Step 4: Run and watch it pass**

```bash
cd apps/api && npx vitest run src/services/invoiceAssembly.test.ts src/services/invoiceService.test.ts
```
Expected: PASS. Existing assembly cases that construct a `TimeEntryRow` literal now need `billableMinutes: null` — add it; `null` reproduces today's behaviour exactly, which is the point.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceAssembly.ts apps/api/src/services/invoiceAssembly.test.ts
git commit -m "feat(billing): invoice lines bill the minimum and name the worked time (#4628 W03)"
```

---

### Task 8: The agreement proof — TS ↔ SQL ↔ CHECK, against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/billableMinutesAgreement.integration.test.ts`

**Interfaces:**
- Consumes: `computeBillableMinutes`, `billableMinutesSql`, `BILLABLE_MINUTES_CHECK_NAME` (Task 1); the integration harness's partner/org/ticket seed helpers.
- Produces: nothing importable — this is the wave's gate.

This test is what makes "the CHECK turns drift into a constraint violation" (§3.5) a fact rather than a claim. It must live under `apps/api/src/__tests__/integration/` — a file placed anywhere else runs zero tests under the integration config and reads green.

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/__tests__/integration/billableMinutesAgreement.integration.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { computeBillableMinutes, billableMinutesSql } from '../../services/billableMinutes';
import { BILLABLE_MINUTES_GRID } from '../../services/billableMinutes.test';

describe('billable_minutes: TS, SQL and the CHECK all agree (#4628 W03 §3.5)', () => {
  it('the REAL billableMinutesSql() fragment reproduces computeBillableMinutes() over the whole grid', async () => {
    // Call the exported fragment — do NOT re-type the formula here. A third
    // hand-transcription makes this test near-tautological: a bad cast or an
    // off-by-one CEIL inside billableMinutesSql() would sail through.
    // The fragment references "time_entries"."minimum_minutes" /
    // "rounding_increment_minutes", so a one-row CTE named time_entries shadows
    // the real table and feeds it the grid row.
    for (const row of BILLABLE_MINUTES_GRID) {
      if (row.durationMinutes === null) continue; // running timer: covered by the CHECK test below
      const [{ computed }] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.execute(sql`
            WITH time_entries (minimum_minutes, rounding_increment_minutes) AS (
              VALUES (${row.minimumMinutes}::int, ${row.roundingIncrementMinutes}::int)
            )
            SELECT ${billableMinutesSql(sql`${row.durationMinutes}::int`)} AS computed FROM time_entries
          `)
        )
      ) as unknown as Array<{ computed: number | null }>;

      expect({ case: row.name, sql: computed }).toEqual({
        case: row.name,
        sql: computeBillableMinutes(row),
      });
    }
  });

  it('a hand-written WRONG billable_minutes violates the CHECK (23514)', async () => {
    const entryId = await seedClosedTimeEntry({ durationMinutes: 20, minimumMinutes: 60, roundingIncrementMinutes: 15 });
    // Control first: the RIGHT value is accepted, so a rejection below is the
    // CHECK doing its job and not an unrelated failure.
    await expect(setBillableMinutes(entryId, 60)).resolves.toBeUndefined();
    await expect(setBillableMinutes(entryId, 20)).rejects.toMatchObject({ code: '23514' });
    await expect(setBillableMinutes(entryId, 61)).rejects.toMatchObject({ code: '23514' });
  });

  it('the CHECK forbids a billable_minutes on a running timer', async () => {
    const entryId = await seedRunningTimer({ minimumMinutes: 60, roundingIncrementMinutes: 15 });
    await expect(setBillableMinutes(entryId, 60)).rejects.toMatchObject({ code: '23514' });
  });

  it('the constraint is VALIDATED, not left NOT VALID', async () => {
    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          SELECT convalidated FROM pg_constraint
          WHERE conname = 'time_entries_billable_minutes_chk'
            AND conrelid = 'time_entries'::regclass
        `)
      )
    ) as unknown as Array<{ convalidated: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].convalidated).toBe(true);
  });

  it('stop-via-CAS lands billable_minutes', async () => {
    const { actor, entryId } = await seedRunningTimerForActor({ minimumMinutes: 60, roundingIncrementMinutes: 15, startedMinutesAgo: 20 });
    await stopTimer({}, actor);
    expect(await readBillableMinutes(entryId)).toBe(60);
  });

  it('stop-via-PATCH (how mobile replays a stop) lands the SAME value', async () => {
    const { actor, entryId, startedAt } = await seedRunningTimerForActor({ minimumMinutes: 60, roundingIncrementMinutes: 15, startedMinutesAgo: 20 });
    await updateTimeEntry(entryId, { endedAt: new Date(startedAt.getTime() + 20 * 60_000) }, actor);
    expect(await readBillableMinutes(entryId)).toBe(60);
  });

  it('a card with no minimum and no rounding stops to the actual duration', async () => {
    const { actor, entryId } = await seedRunningTimerForActor({ minimumMinutes: null, roundingIncrementMinutes: null, startedMinutesAgo: 37 });
    await stopTimer({}, actor);
    expect(await readBillableMinutes(entryId)).toBe(37);
  });
});
```

Write `seedClosedTimeEntry`, `seedRunningTimer`, `seedRunningTimerForActor`, `setBillableMinutes` and `readBillableMinutes` as local helpers in this file, following the seed pattern used by `apps/api/src/__tests__/integration/time-entries-rls.integration.test.ts`.
> `NOT VERIFIED: confirm against merged W02` — the seed helpers must set the W02 columns (`coverage`, `billing_profile_id`, `work_type_id`) to values that satisfy W02's own constraints; copy from W02's `billingProfilesPartnerRls.integration.test.ts`.

- [ ] **Step 2: Run it**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billableMinutesAgreement.integration.test.ts
```
Expected: PASS, 7 tests. If the grid test fails on one row, the TS and SQL forms have drifted — fix `billableMinutes.ts`, **not** the grid.

- [ ] **Step 3: Verify the constraint by hand as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "UPDATE time_entries SET billable_minutes = 1 WHERE billable_minutes IS NOT NULL;"
```
Expected: `ERROR: new row for relation "time_entries" violates check constraint "time_entries_billable_minutes_chk"` (or a zero-row RLS no-op if no context is set — in that case set `breeze.scope` first, per CLAUDE.md).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/billableMinutesAgreement.integration.test.ts
git commit -m "test(billing): billable_minutes TS/SQL/CHECK agreement + both stop paths (#4628 W03)"
```

---

### Task 9: Web — show billed vs worked, and MOUNT it

**Files:**
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx`
- Modify: `apps/web/src/components/tickets/TimesheetPage.tsx`
- Test: `apps/web/src/components/tickets/TicketTimeBilling.test.tsx`, `apps/web/src/components/tickets/TimesheetPage.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json`

**Interfaces:**
- Consumes: the API's `billableMinutes` on entry rows and `includedMinutes` on the ticket summary (Task 5).
- Produces: no new mutation — display only. **No `runAction` needed**, and none may be skipped elsewhere.

**This task includes the MOUNT step.** A wave that builds a component and never composes it into the page is the failure mode this repo has hit before: the last step here is a *page-level* test proving the new text renders from the real component tree, not from a unit render of a sub-component.

- [ ] **Step 1: Add the locale keys, with real translations in all eight files**

`apps/web/src/locales/en/tickets.json`, inside `"ticketTimeBilling"` (the object begins at `:195`):

```json
    "billedVsWorked": "{{worked}} h worked · {{billed}} h billed",
    "includedMinutes": "{{hours}} h included in contract"
```

and a `"timesheetPage"` sibling key `"billedVsWorked"` with the same English string.

The other seven files get real translations — not the English string copied:

| Locale | `billedVsWorked` | `includedMinutes` |
|---|---|---|
| `de-DE` | `"{{worked}} Std. gearbeitet · {{billed}} Std. abgerechnet"` | `"{{hours}} Std. im Vertrag enthalten"` |
| `es-419` | `"{{worked}} h trabajadas · {{billed}} h facturadas"` | `"{{hours}} h incluidas en el contrato"` |
| `fr-CA` | `"{{worked}} h travaillées · {{billed}} h facturées"` | `"{{hours}} h incluses au contrat"` |
| `fr-FR` | `"{{worked}} h travaillées · {{billed}} h facturées"` | `"{{hours}} h incluses au contrat"` |
| `it-IT` | `"{{worked}} h lavorate · {{billed}} h fatturate"` | `"{{hours}} h incluse nel contratto"` |
| `pt-BR` | `"{{worked}} h trabalhadas · {{billed}} h faturadas"` | `"{{hours}} h incluídas no contrato"` |
| `tr-TR` | `"{{worked}} sa çalışıldı · {{billed}} sa faturalandı"` | `"{{hours}} sa sözleşmeye dahil"` |

- [ ] **Step 2: Write the failing component tests**

```tsx
// apps/web/src/components/tickets/TicketTimeBilling.test.tsx (append)
it('shows worked vs billed when a minimum or rounding moved the quantity (#4628 W03)', async () => {
  renderTicketTimeBilling({
    entries: [{ id: 'te-1', description: 'On-site', durationMinutes: 30, billableMinutes: 60, hourlyRate: '225.00', currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed' }],
    summary: { time: { totalMinutes: 30, billableMinutes: 60, includedMinutes: 0, billableAmounts: [] }, parts: { partsCount: 0, billableTotals: [] } },
  });
  expect(await screen.findByText('0.50 h worked · 1.00 h billed')).toBeInTheDocument();
});

it('shows no worked/billed line when they are the same', async () => {
  renderTicketTimeBilling({
    entries: [{ id: 'te-1', description: 'Remote', durationMinutes: 60, billableMinutes: 60, hourlyRate: '150.00', currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed' }],
    summary: { time: { totalMinutes: 60, billableMinutes: 60, includedMinutes: 0, billableAmounts: [] }, parts: { partsCount: 0, billableTotals: [] } },
  });
  expect(screen.queryByText(/h worked ·/)).not.toBeInTheDocument();
});

it('shows contract-included hours in the summary', async () => {
  renderTicketTimeBilling({
    entries: [],
    summary: { time: { totalMinutes: 45, billableMinutes: 0, includedMinutes: 45, billableAmounts: [] }, parts: { partsCount: 0, billableTotals: [] } },
  });
  expect(await screen.findByText('0.75 h included in contract')).toBeInTheDocument();
});
```

```tsx
// apps/web/src/components/tickets/TimesheetPage.test.tsx (append)
it('the timesheet shows billed vs worked on an entry row (#4628 W03)', async () => {
  renderTimesheetPage({
    days: [{ date: '2026-03-03', totalMinutes: 30, billableMinutes: 30, entries: [
      { id: 'te-1', description: 'On-site', durationMinutes: 30, billableMinutes: 60, isBillable: true, hourlyRate: '225.00', currencyCode: 'USD', startedAt: '2026-03-03T09:00:00Z' },
    ] }],
    totals: { totalMinutes: 30, billableMinutes: 30, billableAmounts: [{ currencyCode: 'USD', amount: '225.00' }] },
  });
  expect(await screen.findByText('0.50 h worked · 1.00 h billed')).toBeInTheDocument();
});

it('day totals still report ACTUAL minutes, not the billed quantity (#4628 W03 §3.5)', async () => {
  renderTimesheetPage({
    days: [{ date: '2026-03-03', totalMinutes: 30, billableMinutes: 30, entries: [
      { id: 'te-1', description: 'On-site', durationMinutes: 30, billableMinutes: 60, isBillable: true, hourlyRate: '225.00', currencyCode: 'USD', startedAt: '2026-03-03T09:00:00Z' },
    ] }],
    totals: { totalMinutes: 30, billableMinutes: 30, billableAmounts: [{ currencyCode: 'USD', amount: '225.00' }] },
  });
  expect(await screen.findByTestId('timesheet-day-total-2026-03-03')).toHaveTextContent('0.50');
});
```

> `NOT VERIFIED: confirm against merged W02` — `renderTicketTimeBilling` / `renderTimesheetPage` are the existing harnesses in these two test files; match their current prop/fetch-mock shape. The `data-testid` on the day total may not exist yet — add it in Step 3 if so.

- [ ] **Step 3: Run and watch them fail**

```bash
cd apps/web && npx vitest run src/components/tickets/TicketTimeBilling.test.tsx src/components/tickets/TimesheetPage.test.tsx
```
Expected: FAIL — the strings are not rendered.

- [ ] **Step 4: Implement the display in both components**

Add a shared local helper at the top of each component file (duplicated locally rather than extracted — CLAUDE.md's file guidance allows this for a two-line helper):

```tsx
/** #4628 §3.5 — one line naming the worked time whenever a minimum or the
 *  card's rounding moved the billed quantity. Returns null when they agree. */
function billedVsWorked(
  t: (k: string, o?: Record<string, unknown>) => string,
  durationMinutes: number | null,
  billableMinutes: number | null
): string | null {
  const worked = ((durationMinutes ?? 0) / 60).toFixed(2);
  const billed = (((billableMinutes ?? durationMinutes) ?? 0) / 60).toFixed(2);
  if (worked === billed) return null;
  return t('ticketTimeBilling.billedVsWorked', { worked, billed });
}
```

(in `TimesheetPage.tsx`, use the key `'timesheetPage.billedVsWorked'`).

Render it under each entry row's duration, and in `TicketTimeBilling.tsx`'s summary block render `t('ticketTimeBilling.includedMinutes', { hours: (summary.time.includedMinutes / 60).toFixed(2) })` when `includedMinutes > 0`.

- [ ] **Step 5: MOUNT — prove it renders from the real page tree**

Both components are already mounted (`TicketTimeBilling` inside the ticket detail island, `TimesheetPage` as its own island), so the mount work here is **verifying the data actually reaches them**: the new `billableMinutes` / `includedMinutes` fields must survive whatever type or projection sits between the API response and the component's props.

```bash
cd /path/to/worktree
grep -rn "billableMinutes\|includedMinutes" apps/web/src/components/tickets/ apps/web/src/lib/ | grep -v "\.test\."
```

Every entry-row type between the fetch and the component must carry `billableMinutes`. Add the field to any intermediate type that drops it; a silently-dropped field is exactly how a built-but-unwired component reads green.

Then add the page-level test:

```tsx
// apps/web/src/components/tickets/TicketTimeBilling.test.tsx (append)
it('MOUNT: the worked/billed line reaches the screen from a real API payload, not a hand-built prop', async () => {
  // Mock the network, not the component's props — this is what proves the
  // field survives the fetch -> parse -> props path end to end.
  mockFetchJson('/tickets/tk-1/time-entries', {
    entries: [{ id: 'te-1', description: 'On-site', durationMinutes: 30, billableMinutes: 60, hourlyRate: '225.00', currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed', startedAt: '2026-03-03T09:00:00Z' }],
  });
  mockFetchJson('/tickets/tk-1/billing-summary', {
    time: { totalMinutes: 30, billableMinutes: 60, includedMinutes: 0, billableAmounts: [] },
    parts: { partsCount: 0, billableTotals: [] },
  });
  render(<TicketTimeBilling ticketId="tk-1" />);
  expect(await screen.findByText('0.50 h worked · 1.00 h billed')).toBeInTheDocument();
});
```

> `NOT VERIFIED: confirm against merged W02` — the two endpoint paths and `mockFetchJson`'s name; read the top of `TicketTimeBilling.test.tsx` for the file's existing fetch-mock convention and use that.

- [ ] **Step 6: Run the web suites and the i18n contracts**

```bash
cd apps/web && npx vitest run \
  src/components/tickets/TicketTimeBilling.test.tsx \
  src/components/tickets/TimesheetPage.test.tsx \
  src/lib/i18n
```
Expected: PASS, including `localeParity`, `translationCoverage` and `keyUsage`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/tickets/TicketTimeBilling.tsx \
        apps/web/src/components/tickets/TicketTimeBilling.test.tsx \
        apps/web/src/components/tickets/TimesheetPage.tsx \
        apps/web/src/components/tickets/TimesheetPage.test.tsx \
        apps/web/src/locales/*/tickets.json
git commit -m "feat(web): show worked vs billed hours and contract-included time (#4628 W03)"
```

---

### Task 10: Pin the block-hours cross-spec contract

**Files:**
- Create/Modify: `apps/api/src/services/billableMinutes.test.ts` (a documented contract block) **and** `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md` (no change — read only)
- Test: `apps/api/src/services/billableMinutes.test.ts`

**Interfaces:**
- Produces: a grep-able, executable statement of the §5 contract that block hours (#4547) will consume.

Block hours (#4547) is approved and unplanned; its drawdown will read `COALESCE(billable_minutes, duration_minutes)` (§5). W03 cannot implement drawdown, but it can make the contract impossible to break silently: a test that names the formula, and a comment on the column that names the consumer.

- [ ] **Step 1: Write the contract test**

```ts
// apps/api/src/services/billableMinutes.test.ts (append)
describe('cross-spec contract with block hours (#4547) — spec §5', () => {
  /**
   * #4547 drawdown MUST read COALESCE(billable_minutes, duration_minutes), not
   * duration_minutes. This helper is the exact expression block hours will use;
   * if someone changes the fallback here, #4547's drawdown changes with it and
   * this test says so out loud.
   */
  const drawdownMinutes = (r: { durationMinutes: number | null; billableMinutes: number | null }) =>
    (r.billableMinutes ?? r.durationMinutes) ?? 0;

  it('a block draws the BILLED quantity, so a 1 h minimum consumes an hour', () => {
    expect(drawdownMinutes({ durationMinutes: 20, billableMinutes: 60 })).toBe(60);
  });

  it('a pre-feature entry draws its actual duration', () => {
    expect(drawdownMinutes({ durationMinutes: 30, billableMinutes: null })).toBe(30);
  });

  it('INCLUDED hours never draw a block: they are born billing_status=contract, so they never reach drawdown', () => {
    // §5, decision 3 (closed 2026-09-19). "Included" means covered by the flat
    // fee; block eligibility requires a not_billed entry. This assertion pins
    // the ELIGIBILITY predicate, which is the thing that keeps them out — the
    // minute count above is irrelevant if the row is never a candidate.
    const isBlockEligible = (r: { billingStatus: string; isBillable: boolean }) =>
      r.isBillable && r.billingStatus === 'not_billed';
    expect(isBlockEligible({ billingStatus: 'contract', isBillable: true })).toBe(false);
    expect(isBlockEligible({ billingStatus: 'not_billed', isBillable: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run src/services/billableMinutes.test.ts
```
Expected: PASS.

- [ ] **Step 3: Confirm the block-hours spec carries the same amendments**

```bash
git log --oneline --all -- docs/superpowers/specs/billing/ | head
git show origin/spec/4547-block-hours:docs/superpowers/specs/billing/*block-hours*.md 2>/dev/null | grep -n "billable_minutes\|contract_line_id\|do not draw"
```
§10 records that both §5 amendments were "accepted and applied to the block-hours spec on `spec/4547-block-hours`". If the grep finds nothing, **do not amend that spec from this wave** — report it as an open item in the PR body instead.
> `NOT VERIFIED: confirm the block-hours spec amendments actually landed on `spec/4547-block-hours`.`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/billableMinutes.test.ts
git commit -m "test(billing): pin the block-hours drawdown contract (#4628 W03, #4547 §5)"
```

---

### Task 11: Full verification before the PR

**Files:** none — this task only runs things.

- [ ] **Step 1: Typecheck and unit suites**

```bash
pnpm --filter @breeze/shared build
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit
cd ../web && npx tsc --noEmit
cd ../.. && pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
```
Expected: PASS. (Note the missing `--` — see the Global Constraints.) If `tsc` on the API OOMs, that is the known 8 GB-ceiling flake, not this change.

- [ ] **Step 2: The contract suites this wave can break (integration-only)**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/billableMinutesAgreement.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/time-entries-rls.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts
```
Expected: all PASS. `rls-coverage`, `tenantCascade` and `orgLifecycleFoundations` should be untouched by this wave (no new table) — a failure there means a column landed somewhere unexpected.

- [ ] **Step 3: Tear the stack down**

```bash
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Nothing from this session may be left running.

- [ ] **Step 4: Open the PR**

Body must call out, for the reviewer:
- the two representations of the §3.5 arithmetic and the CHECK that pins them;
- the backfill's three exclusions and **why `billing_status = 'billed'` is excluded** (an invoiced quantity is already on a customer's document);
- the reader split: money/billed-quantity vs utilization/duration;
- that `billable_minutes` was added to `CORE_TENANT_EXPORT_POLICY` (the `ADD COLUMN` rule);
- the block-hours (#4547) contract and whether the spec amendment was found on `spec/4547-block-hours`.

---

## Self-review

**Spec coverage.** §3.5 arithmetic → Tasks 1, 2. `billable_minutes` column + CHECK → Task 2. Service-written on both stop paths → Tasks 3, 4. Money readers (the three summary readers) → Task 5. Portal readers → Task 6. Invoice line assembly, one line per entry, the "worked vs minimum" note → Task 7. TS↔SQL grid agreement, wrong value → CHECK violation → Task 8. Included entry adds no money → Task 5 (three readers) + Task 7 (assembly). Utilization keeps actual minutes → Tasks 5, 9. Backfill → Task 2. Block-hours contract (§5) → Task 10. `includedMinutes` on the ticket summary (§3.4) → Task 5. Registration lists (§4.4) → Task 2 Step 4.

**Not in this wave, by the spec's own wave list:** the work-type pickers on mobile and the Office add-in, report/CSV dimensions, docs, and the drop of the six legacy columns — all W04.

**Known spec-vs-code note for the reviewer.** §3.5 says the timesheet's *amounts* read `COALESCE(...)` while "timesheet durations keep actual minutes". `getTimesheet` returns `totals.billableMinutes`, which is a *duration* aggregate (`timeEntryService.ts:1203`), not money — so it stays actual. `getTicketBillingSummary.time.billableMinutes` is the ticket's *billed quantity* line and does move to `COALESCE`. The two fields share a name and now mean different things; Task 5's tests pin both so a future reader cannot conflate them.
