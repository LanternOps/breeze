---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 7 — Reporting-Only FX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor** line; a `codex` task is written to be self-contained (codex sees only that task's text — every path, signature, fixture shape and command it needs is inside the task).

**Goal:** Ship spec §8 — a global `exchange_rates` reference table with forced RLS (tenant-read / system-write), a daily Frankfurter/ECB feed job, operator-managed manual rates that the feed can never overwrite, a staleness-bounded `convertForReporting`, and an honest per-currency segmentation + optional "≈ approximate" line on every money rollup — **without FX ever touching document math or being persisted onto a document**.

**Architecture:** Four strictly-ordered layers.

1. **Reference data (Task 1).** `exchange_rates(rate_date, base_code, quote_code, rate numeric(18,8), source, fetched_at)`, PK `(rate_date, base_code, quote_code)`, both currency columns FK'd to `supported_currencies(code)`. RLS ENABLED + FORCED with a permissive `FOR SELECT USING (true)` and a system-only `FOR ALL` policy — byte-for-byte the `supported_currencies` shape (`apps/api/migrations/2026-08-27-a-supported-currencies.sql:29-40`). Registered in `INTENTIONAL_UNSCOPED` only; no cascade, device-cascade or export-policy registration applies (no `org_id`, no `device_id`).
2. **Ingestion + resolution (Tasks 2-7).** `frankfurterClient.ts` (explicit ECB provider selection, per-currency coverage, no synthesized 1:1) → `exchangeRateService.ts` (system-context upserts with a `WHERE exchange_rates.source <> 'manual'` conflict predicate; latest-on-or-before lookup with a 7-day ceiling; EUR-pivot cross rates computed in Postgres `numeric` and rounded through `multiplyToCurrency`) → a daily BullMQ job and a platform-admin manual-rate API → one authenticated tenant read endpoint.
3. **Reporting rollups (Tasks 8-12).** Real per-currency PartnerDashboard MRR (today the API hardcodes `mrr: 0` at `apps/api/src/routes/partner.ts:181` and the UI labels it `'USD'` at `apps/web/src/components/partner/PartnerDashboard.tsx:573,584` — the last blind money sum in the repo), a pure `approxTotal` helper beside the shipped `sumByCurrency`, a `useReportingRates` hook, one `ApproximateMoneyLine` component, and its placement under six existing summary strips plus eight locale catalogs.
4. **Boundary proof + verification (Tasks 13-14).** A static negative test asserting no document/payment/PDF/accounting module imports the FX service, then the full verification round and the PR.

**Tech Stack:** Hono + Drizzle ORM 0.45.2 (`onConflictDoUpdate` with `setWhere`), BullMQ + Redis, Vitest (Drizzle-mock unit + real-DB integration), Astro + React islands (`apps/web`), hand-written SQL migrations (**one — `2026-09-03-exchange-rates.sql`**).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3779, branch `feature/3772-multi-currency/wave-3779`, worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`, base commit `8066aedb0`. Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §8 ("FX — reporting only"), §2 (central invariant), §9 (formatting), §12 (non-goals), §13 wave 7. Format precedent: `docs/superpowers/plans/billing/2026-08-22-multi-currency-wave6-org-currency-selection.md`. Waves 1-6 are merged to `main`; this branch is cut from `main` after wave 6, so the PR targets `main` directly and Integration Tests run on the PR itself.

## Global Constraints

- **Owner-fixed decisions, never relitigated:** no conversion on billing DOCUMENTS, ever — FX is reporting-only and is **never persisted onto a document**; snapshots rule (a stamped currency is never reinterpreted from a mutable setting); per-currency price books with explicit gaps; ticket rate defaults are match-or-skip; no bulk restamp of history; VAT out of scope.
- **EUR is the fixed reporting pivot**, because the feed is explicitly ECB-backed. A conversion `from → to` is `from → EUR → to` using the stored `EUR→from` and `EUR→to` legs. `from === to` is the ONLY synthetic `1.00000000`. A pair the feed does not cover is **`unavailable`** — never 1:1, never a guess.
- **Manual rates win.** `source='manual'` rows are authoritative for their `(rate_date, base_code, quote_code)` cell. The daily job's upsert carries `WHERE exchange_rates.source <> 'manual'`, so a feed run can never clobber an operator override in either commit ordering. This is the self-host / air-gapped path and it must have its own real-DB race test.
- **PK decision (the one genuine design fork, RESOLVED).** Keep the spec's literal PK `(rate_date, base_code, quote_code)`; do **not** add `source` to it. One authoritative cell per date/pair keeps the "latest on or before" lookup a single indexed scan with no provenance tiebreak. Precedence is enforced by the conditional upsert above, not by row multiplicity. The spec's "manual rates are separate rows" is satisfied in the sense that matters: a manual row is a distinct row with its own `source`, and the feed cannot overwrite it.
- **Staleness:** lookups resolve the latest row with `rate_date <= requestedDate`; age is computed in **UTC calendar days**; `0..7` days is available (exactly 7 is still valid), `>= 8` is `unavailable` with `reason:'stale'`, no prior row at all is `unavailable` with `reason:'missing'`. `DEFAULT_MAX_STALENESS_DAYS = 7` and the HTTP endpoint never lets a client raise it.
- **One unavailable leg suppresses the WHOLE approximate line.** Never a partial approximate total, never a placeholder, never a zero. The authoritative per-currency segmentation stays visible in every state.
- **FX must not enter document math.** No `convertForReporting` / `resolveReportingRate` / `exchangeRateService` import may appear in `invoiceMath.ts`, `invoiceService.ts`, `invoiceAssembly.ts`, `invoiceCheckout.ts`, `invoicePdf.ts`, `quoteMath.ts`, `quoteService.ts`, `quotePdf.ts`, `contractService.ts`, `contractMath.ts`, `catalogPricing.ts`, `depositMath.ts`, `stripeMoney.ts`, `stripeReconcile.ts`, `timeEntryService.ts`, the portal document renderers, or the accounting provider push paths. Task 13 turns this into a failing-first static test.
- **`exchangeRateService.ts` is dependency-minimal**, exactly like `apps/api/src/services/orgCurrencyCore.ts:1-18`: it imports only `../db`, `../db/schema`, Drizzle primitives and `@breeze/shared` — never a domain service. Callers map its errors at their own boundary.
- **Tenancy registration — the complete, verified list.** `exchange_rates` has no `org_id` and no `device_id`, so of CLAUDE.md's four registration lists **zero** apply: do **not** add it to `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`), `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`apps/api/src/routes/devices/core.ts`), or `NOT_CASCADE_SCOPED` (`apps/api/src/__tests__/integration/tenantCascade.integration.test.ts:26`) — `supported_currencies` is in none of them either. The ONE required registration is `INTENTIONAL_UNSCOPED` at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:77-100`, adjacent to `'supported_currencies'` at `:92`. That set is documentation (auto-discovery keys on the presence of an `org_id` column), so the CI-enforced proof is the dedicated suite in Task 1.
- **Migration naming.** Exactly one file: `apps/api/migrations/2026-09-03-exchange-rates.sql`. Verify the tail first (`ls apps/api/migrations | sort | tail -5` → currently ends `2026-09-03-ai-agents-permissions.sql`); `exchange-rates` localeCompares after `ai-agents-permissions`, so a plain slug is correct. **Do NOT use an `-a-`/`-b-` infix on this date** — `-` (0x2D) sorts before letters, so an infixed file would sort *before* the already-shipped plain-slug file and invert the intent. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`, `DO $$ … EXCEPTION WHEN duplicate_object`), no inner `BEGIN;`/`COMMIT;`, no cleanup/backfill statements (so no `RAISE WARNING` block is required — if one is ever added it must report `GET DIAGNOSTICS … ROW_COUNT`).
- **New env vars stay OUT of `.env.example`.** `EXCHANGE_RATE_SYNC_ENABLED` and `FRANKFURTER_BASE_URL` are documented in code comments only, mirroring `STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED` (0 hits in `.env.example`). `apps/api/src/config/envComposeParity.test.ts` (required **Test API** job) fails on a var that is documented in a `.env.example` but not mapped into the paired compose service's `environment:` block — document-and-map both halves or neither.
- **Lock order is untouched by this wave.** Reporting reads acquire no row locks at all; FX lookups are never called from inside an invoice/payment/assembly/contract/ticket/org-currency transaction. Feed and manual upserts lock only conflicting `exchange_rates` rows and sort their keys before writing. Frankfurter I/O happens **outside** any DB context (the #1105 connection-hold rule).
- **Test stack for this worktree:** postgres `localhost:5440`, redis `localhost:6390` (already in `.env.test`, loaded by `apps/api/vitest.integration.config.ts`). Integration invocation used throughout:
  `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>`
- Unit tests follow the Drizzle mock-queue conventions in the `breeze-testing` skill. `pnpm test` green is not CI green — the integration and RLS configs are separate runners.
- Commit after every task. Every commit message ends with `(#3779)`.
- Line numbers below are pre-change references read from this worktree at `8066aedb0`. Re-grep before editing if an earlier task has already moved them.

---

### Task 1: `exchange_rates` table, Drizzle schema, RLS contract + proof

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`, branch `feature/3772-multi-currency/wave-3779`. You are adding ONE global reference table for reporting-only FX rates. It is **not** a tenant table: it has no `org_id`, no `partner_id` and no `device_id`. The house rule for such a table (see `apps/api/migrations/2026-08-27-a-supported-currencies.sql`) is: RLS **ENABLED and FORCED**, a permissive `FOR SELECT USING (true)` so ordinary org-scoped request contexts can read it, and a single system-only `FOR ALL` policy keyed on `current_setting('breeze.scope', true) = 'system'` so only the system DB context can write. Because it has no tenant column, it is registered ONLY in `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts` — it must NOT be added to `EXEMPT_TABLES`, `NOT_CASCADE_SCOPED`, `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `CORE_DEVICE_CASCADE_DELETE_TABLES` or `CORE_DEVICE_ORG_DENORMALIZED_TABLES`.

**Files:**
- Create: `apps/api/migrations/2026-09-03-exchange-rates.sql`
- Modify: `apps/api/src/db/schema/currency.ts` (currently 7 lines; `apps/api/src/db/schema/index.ts:7` already re-exports it — no barrel change needed)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (the `INTENTIONAL_UNSCOPED` set, adjacent to `'supported_currencies'` at `:92`)
- Create: `apps/api/src/__tests__/integration/exchangeRates.integration.test.ts`

**Interfaces:**
- Produces: `export const exchangeRates` from `apps/api/src/db/schema/currency.ts`, columns `rateDate`, `baseCode`, `quoteCode`, `rate`, `source`, `fetchedAt`.
- Consumes: `supportedCurrencies` (same file, `:5-7`); `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `runOutsideDbContext`, `type DbAccessContext` from `apps/api/src/db`; `createPartner`, `createOrganization` from `apps/api/src/__tests__/integration/db-utils.ts`.

- [ ] **Step 1: Confirm the migration name sorts last.** Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7
ls apps/api/migrations | sort | tail -5
```
The last line must be `2026-09-03-ai-agents-permissions.sql`; `2026-09-03-exchange-rates.sql` sorts after it (`ex` > `ai`). Do NOT add an `-a-`/`-b-` infix — it would sort BEFORE the existing plain-slug file.
- [ ] **Step 2: Write the failing RLS suite first.** Create `apps/api/src/__tests__/integration/exchangeRates.integration.test.ts`:
```ts
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import { exchangeRates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

// exchange_rates is GLOBAL reporting reference data (multi-currency spec §8):
// no org_id / partner_id / device_id. Forced RLS with a permissive SELECT
// (rates are public facts every tenant context may read) and system-only
// writes. This suite is the CI-enforced proof of that contract — the
// INTENTIONAL_UNSCOPED entry in rls-coverage.integration.test.ts is
// documentation only (auto-discovery keys on the presence of an org_id column).
function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const KEY = { rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD' } as const;

async function systemDelete() {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.delete(exchangeRates).where(
        and(
          eq(exchangeRates.rateDate, KEY.rateDate),
          eq(exchangeRates.baseCode, KEY.baseCode),
          eq(exchangeRates.quoteCode, KEY.quoteCode),
        ),
      ),
    ),
  );
}

describe('exchange_rates tenancy contract', () => {
  beforeEach(systemDelete);

  it('system context can INSERT, SELECT, UPDATE and DELETE', async () => {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const inserted = await db
          .insert(exchangeRates)
          .values({ ...KEY, rate: '1.09000000', source: 'ecb' })
          .returning({ rate: exchangeRates.rate });
        expect(inserted).toHaveLength(1);

        const updated = await db
          .update(exchangeRates)
          .set({ rate: '1.10000000', source: 'manual' })
          .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
          .returning({ source: exchangeRates.source });
        expect(updated).toEqual([{ source: 'manual' }]);

        const deleted = await db
          .delete(exchangeRates)
          .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
          .returning({ rate: exchangeRates.rate });
        expect(deleted).toHaveLength(1);
      }),
    );
  });

  it('tenant context can SELECT (rates are public reference data)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(exchangeRates).values({ ...KEY, rate: '1.09000000', source: 'ecb' }),
      ),
    );

    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ rate: exchangeRates.rate }).from(exchangeRates)
        .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode))),
    );
    expect(rows).toEqual([{ rate: '1.09000000' }]);
  });

  it('tenant context cannot INSERT (RLS 42501)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(
      withDbAccessContext(orgContext(org.id), () =>
        db.insert(exchangeRates).values({ ...KEY, rate: '9.99000000', source: 'manual' }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant context cannot UPDATE or DELETE (RLS 42501 / zero rows)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(exchangeRates).values({ ...KEY, rate: '1.09000000', source: 'manual' }),
      ),
    );

    // FORCE + a system-only FOR ALL policy: the tenant sees the row through the
    // permissive SELECT policy but the UPDATE/DELETE USING clause excludes it,
    // so the write either raises 42501 or silently affects zero rows. Both are
    // acceptable; a MUTATED row is not.
    await withDbAccessContext(orgContext(org.id), async () => {
      await db.update(exchangeRates).set({ rate: '99.00000000' })
        .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
        .catch((err: unknown) => { expect(err).toMatchObject({ cause: { code: '42501' } }); });
      await db.delete(exchangeRates)
        .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode)))
        .catch((err: unknown) => { expect(err).toMatchObject({ cause: { code: '42501' } }); });
    });

    const [row] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.select({ rate: exchangeRates.rate }).from(exchangeRates)
          .where(and(eq(exchangeRates.rateDate, KEY.rateDate), eq(exchangeRates.baseCode, KEY.baseCode), eq(exchangeRates.quoteCode, KEY.quoteCode))),
      ),
    );
    expect(row).toEqual({ rate: '1.09000000' });
  });

  it.each([
    ['unknown source', { ...KEY, rate: '1.00000000', source: 'oracle' }, '23514'],
    ['non-positive rate', { ...KEY, rate: '0.00000000', source: 'ecb' }, '23514'],
    ['base equals quote', { rateDate: KEY.rateDate, baseCode: 'EUR', quoteCode: 'EUR', rate: '1.00000000', source: 'ecb' }, '23514'],
    ['unsupported currency', { rateDate: KEY.rateDate, baseCode: 'EUR', quoteCode: 'ZZZ', rate: '1.00000000', source: 'ecb' }, '23503'],
  ])('rejects %s under system context (%s)', async (_label, values, code) => {
    await expect(
      runOutsideDbContext(() =>
        withSystemDbAccessContext(() => db.insert(exchangeRates).values(values as never)),
      ),
    ).rejects.toMatchObject({ cause: { code } });
  });
});
```
- [ ] **Step 3: Run it and watch it fail** for the right reason (relation `exchange_rates` does not exist):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRates.integration.test.ts
```
- [ ] **Step 4: Write the migration.** Create `apps/api/migrations/2026-09-03-exchange-rates.sql`:
```sql
-- Global reporting-only FX reference data (multi-currency spec §8,
-- docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md).
--
-- Tenancy: platform-global public reference data with NO org_id, partner_id or
-- device_id axis. Mirrors supported_currencies (2026-08-27-a): forced RLS,
-- permissive public SELECT (rows contain no tenant data; ordinary org-scoped
-- request contexts read them to render an approximate reporting total),
-- system-context-only writes. Registered in INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts. No org_id/device_id column, so no cascade,
-- device-cascade or export-policy registration applies.
--
-- One authoritative cell per (rate_date, base_code, quote_code); `source`
-- records provenance. Manual precedence is enforced by the feed upsert's
-- `WHERE exchange_rates.source <> 'manual'` conflict predicate in
-- exchangeRateService.upsertFeedRates, not by row multiplicity.
--
-- Idempotent: IF NOT EXISTS + DROP POLICY IF EXISTS. No inner BEGIN/COMMIT.
-- No UPDATE/DELETE/backfill statements, so no GET DIAGNOSTICS reporting block
-- is required.

CREATE TABLE IF NOT EXISTS exchange_rates (
  rate_date date NOT NULL,
  base_code char(3) NOT NULL REFERENCES supported_currencies(code),
  quote_code char(3) NOT NULL REFERENCES supported_currencies(code),
  rate numeric(18,8) NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rates_pkey PRIMARY KEY (rate_date, base_code, quote_code),
  CONSTRAINT exchange_rates_positive_rate_chk CHECK (rate > 0),
  CONSTRAINT exchange_rates_distinct_codes_chk CHECK (base_code <> quote_code),
  CONSTRAINT exchange_rates_source_chk CHECK (source IN ('ecb', 'manual'))
);

-- The only read path is "latest rate on or before <date> for this pair"; the
-- PK's leading rate_date cannot serve it.
CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (base_code, quote_code, rate_date DESC);

ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_rates_read ON exchange_rates;
CREATE POLICY exchange_rates_read ON exchange_rates
  FOR SELECT USING (true);

DROP POLICY IF EXISTS exchange_rates_system_write ON exchange_rates;
CREATE POLICY exchange_rates_system_write ON exchange_rates
  FOR ALL
  USING (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
```
- [ ] **Step 5: Add the Drizzle table.** Append to `apps/api/src/db/schema/currency.ts` (and widen the import line at `:1`):
```ts
import { sql } from 'drizzle-orm';
import { pgTable, char, check, date, index, numeric, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// … existing supportedCurrencies …

/** Global reporting-only FX rates (multi-currency spec §8) — see
 *  2026-09-03-exchange-rates.sql for the tenancy rationale
 *  (INTENTIONAL_UNSCOPED: public read, system-only write). Consumed ONLY by
 *  dashboards/reports via exchangeRateService; never by document math, and
 *  never persisted onto a document. */
export const exchangeRates = pgTable('exchange_rates', {
  rateDate: date('rate_date').notNull(),
  baseCode: char('base_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  quoteCode: char('quote_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
  /** 'ecb' (daily Frankfurter feed) | 'manual' (operator override, never overwritten by the feed). */
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'exchange_rates_pkey', columns: [t.rateDate, t.baseCode, t.quoteCode] }),
  index('exchange_rates_lookup_idx').on(t.baseCode, t.quoteCode, t.rateDate.desc()),
  check('exchange_rates_positive_rate_chk', sql`${t.rate} > 0`),
  check('exchange_rates_distinct_codes_chk', sql`${t.baseCode} <> ${t.quoteCode}`),
  check('exchange_rates_source_chk', sql`${t.source} in ('ecb','manual')`),
]);
```
- [ ] **Step 6: Register in `INTENTIONAL_UNSCOPED`.** In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, immediately after the `'supported_currencies'` entry (`:92`), add:
```ts
  'exchange_rates', // Global reporting-only FX reference data (multi-currency spec §8). No tenant axis. Forced RLS: permissive USING (true) SELECT (org-scoped request contexts read rates to render an approximate total), system-only writes. Mirrors supported_currencies. Proven by exchangeRates.integration.test.ts.
```
Do NOT touch `EXEMPT_TABLES` (`:48-61`) — this table IS tenant-readable — and do NOT touch `NOT_CASCADE_SCOPED` in `tenantCascade.integration.test.ts` (`:26`).
- [ ] **Step 7: Apply the migration to the test DB and run both suites** (postgres `localhost:5440`, redis `localhost:6390`, already in `.env.test`):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRates.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```
All three must pass.
- [ ] **Step 8: Prove no drift and no ordering regression:**
```bash
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
```
- [ ] **Step 9: Commit** — `feat(api): exchange_rates global FX reference table with forced RLS (#3779)`.

---

### Task 2: Frankfurter ECB client

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`. You are writing ONE isolated service module that fetches daily reference FX rates from the public Frankfurter API and returns them as strings, plus its co-located unit test. It touches no database and no other service. Two hard rules from the spec: (a) the **ECB provider filter must be set explicitly** — Frankfurter v2 blends providers by default and blended data is forbidden; (b) a currency the response does not cover is **unavailable** and must be reported as such — the client must NEVER synthesize a rate, and must never fall back to `1`. The base is always `EUR`.

The fetch/timeout/size/error-classification pattern to copy is `apps/api/src/services/osvClient.ts:19-33` (module constants `OSV_TIMEOUT_MS = 15_000`, `MAX_RESPONSE_BYTES = 1_000_000`, and dedicated `OsvRateLimitError` / `OsvServerError` classes) and `apps/api/src/services/osvClient.ts:52-102` (bare `fetch` with `signal: AbortSignal.timeout(...)`).

**Files:**
- Create: `apps/api/src/services/frankfurterClient.ts`
- Create: `apps/api/src/services/frankfurterClient.test.ts`

**Interfaces:**
- Produces:
```ts
export const ECB_REPORTING_BASE_CODE = 'EUR';
export const FRANKFURTER_DEFAULT_BASE_URL = 'https://api.frankfurter.dev/v2';
export type FrankfurterFailureKind = 'transient' | 'permanent';
export class FrankfurterClientError extends Error {
  constructor(message: string, kind: FrankfurterFailureKind, status?: number);
  readonly kind: FrankfurterFailureKind;
  readonly status?: number;
}
export interface FrankfurterRate { rateDate: string; baseCode: string; quoteCode: string; rate: string; }
export interface FrankfurterFetchResult {
  rates: FrankfurterRate[];
  requestedQuoteCodes: string[];
  unavailableQuoteCodes: string[];
}
export function buildEcbLatestUrl(baseUrl: string, quoteCodes: readonly string[]): string;
export async function fetchLatestEcbRates(
  quoteCodes: readonly string[],
  options?: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<FrankfurterFetchResult>;
```
- Consumes: `CURRENCY_CODES`, `isKnownCurrency` from `@breeze/shared` (`packages/shared/src/utils/currency.ts:23,34`).

- [ ] **Step 1: Write the failing test first.** Create `apps/api/src/services/frankfurterClient.test.ts` with a `fetchImpl` stub (never a real network call):
```ts
import { describe, it, expect } from 'vitest';
import {
  buildEcbLatestUrl,
  fetchLatestEcbRates,
  FrankfurterClientError,
  FRANKFURTER_DEFAULT_BASE_URL,
} from './frankfurterClient';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('buildEcbLatestUrl', () => {
  it('pins base=EUR, sorted unique quotes and an EXPLICIT ECB provider filter', () => {
    const url = new URL(buildEcbLatestUrl(FRANKFURTER_DEFAULT_BASE_URL, ['USD', 'GBP', 'USD']));
    expect(url.searchParams.get('base')).toBe('EUR');
    expect(url.searchParams.get('quotes')).toBe('GBP,USD');
    // v2 blends providers by default — the filter is never omitted (spec §8).
    expect(url.searchParams.get('providers')).toBe('ECB');
  });

  it('never requests EUR against itself', () => {
    const url = new URL(buildEcbLatestUrl(FRANKFURTER_DEFAULT_BASE_URL, ['EUR', 'USD']));
    expect(url.searchParams.get('quotes')).toBe('USD');
  });
});

describe('fetchLatestEcbRates', () => {
  it('returns provider dates and reports uncovered currencies as unavailable — never 1:1', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ base: 'EUR', date: '2026-09-02', rates: { USD: 1.0912, GBP: 0.8534 } })) as unknown as typeof fetch;

    const result = await fetchLatestEcbRates(['USD', 'GBP', 'KES'], { fetchImpl });

    expect(result.rates).toEqual([
      { rateDate: '2026-09-02', baseCode: 'EUR', quoteCode: 'GBP', rate: '0.85340000' },
      { rateDate: '2026-09-02', baseCode: 'EUR', quoteCode: 'USD', rate: '1.09120000' },
    ]);
    expect(result.unavailableQuoteCodes).toEqual(['KES']);
    expect(result.rates.some((r) => r.quoteCode === 'KES')).toBe(false);
  });

  it('accepts a per-currency object encoding with its own date', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ base: 'EUR', date: '2026-09-02', rates: { USD: { value: '1.09120000', date: '2026-09-01' } } })) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
    expect(result.rates).toEqual([{ rateDate: '2026-09-01', baseCode: 'EUR', quoteCode: 'USD', rate: '1.09120000' }]);
  });

  it.each([
    ['429', 429, 'transient'],
    ['503', 503, 'transient'],
    ['400', 400, 'permanent'],
  ])('classifies HTTP %s as %s', async (_label, status, kind) => {
    const fetchImpl = (async () => jsonResponse({}, { status })) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind });
  });

  it('treats a network throw as transient', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toBeInstanceOf(FrankfurterClientError);
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'transient' });
  });

  it.each([
    ['malformed JSON', new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['wrong base', jsonResponse({ base: 'USD', date: '2026-09-02', rates: { GBP: 0.79 } })],
    ['invalid date', jsonResponse({ base: 'EUR', date: '02/09/2026', rates: { USD: 1.09 } })],
    ['non-positive rate', jsonResponse({ base: 'EUR', date: '2026-09-02', rates: { USD: 0 } })],
    ['unknown currency in response', jsonResponse({ base: 'EUR', date: '2026-09-02', rates: { ZZZ: 1.5 } })],
  ])('classifies %s as permanent', async (_label, response) => {
    const fetchImpl = (async () => response) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('rejects an over-sized body as permanent', async () => {
    const fetchImpl = (async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '2000000' } })) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('returns an empty result without fetching when no quote codes remain', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return jsonResponse({}); }) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['EUR'], { fetchImpl });
    expect(called).toBe(0);
    expect(result).toEqual({ rates: [], requestedQuoteCodes: [], unavailableQuoteCodes: [] });
  });
});
```
- [ ] **Step 2: Run it and watch it fail** (module not found):
```bash
pnpm --filter @breeze/api exec vitest run src/services/frankfurterClient.test.ts
```
- [ ] **Step 3: Implement `apps/api/src/services/frankfurterClient.ts`:**
```ts
import { isKnownCurrency } from '@breeze/shared';

/** The ECB publishes against EUR, so EUR is the fixed pivot for every stored
 *  rate and every cross rate derived from them (multi-currency spec §8). */
export const ECB_REPORTING_BASE_CODE = 'EUR';

/** Deployment override (`FRANKFURTER_BASE_URL`) exists for self-hosted mirrors
 *  and air-gapped installs pointing at an internal proxy. It is trusted
 *  deployment config, NEVER request input. */
export const FRANKFURTER_DEFAULT_BASE_URL = 'https://api.frankfurter.dev/v2';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_SCALE = 8;

export type FrankfurterFailureKind = 'transient' | 'permanent';

/** `transient` = retry the same job (429/5xx/timeout/network). `permanent` =
 *  a protocol or validation failure; retrying the identical request cannot
 *  help, so the job fails without burning attempts. */
export class FrankfurterClientError extends Error {
  constructor(
    message: string,
    public readonly kind: FrankfurterFailureKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'FrankfurterClientError';
  }
}

export interface FrankfurterRate {
  rateDate: string;
  baseCode: string;
  quoteCode: string;
  rate: string;
}

export interface FrankfurterFetchResult {
  rates: FrankfurterRate[];
  requestedQuoteCodes: string[];
  /** Requested codes the provider did not return. These are UNAVAILABLE — the
   *  caller must not store anything for them, and must never assume 1:1. */
  unavailableQuoteCodes: string[];
}

function normalizeQuoteCodes(codes: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of codes) {
    const code = String(raw ?? '').trim().toUpperCase();
    if (!code || code === ECB_REPORTING_BASE_CODE) continue;
    if (!isKnownCurrency(code)) continue;
    set.add(code);
  }
  return [...set].sort();
}

export function buildEcbLatestUrl(baseUrl: string, quoteCodes: readonly string[]): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/latest`);
  url.searchParams.set('base', ECB_REPORTING_BASE_CODE);
  url.searchParams.set('quotes', normalizeQuoteCodes(quoteCodes).join(','));
  // EXPLICIT provider selection. v2 blends providers by default and a blended
  // series is not the ECB reference rate the spec requires (§8).
  url.searchParams.set('providers', 'ECB');
  return url.toString();
}

/** Fixed-scale decimal string with no float formatting surprises: the value is
 *  normalized textually, never via toFixed on a parsed double. */
function toFixedScale(raw: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(raw.trim());
  if (!m) throw new FrankfurterClientError(`Unparseable rate "${raw}"`, 'permanent');
  const [, sign, whole, frac = ''] = m;
  if (sign === '-') throw new FrankfurterClientError(`Negative rate "${raw}"`, 'permanent');
  if (frac.length > RATE_SCALE) throw new FrankfurterClientError(`Rate "${raw}" exceeds ${RATE_SCALE} decimals`, 'permanent');
  if (/^0+$/.test(whole) && /^0*$/.test(frac)) throw new FrankfurterClientError(`Non-positive rate "${raw}"`, 'permanent');
  return `${Number(whole)}.${frac.padEnd(RATE_SCALE, '0')}`;
}

/** Tolerates both the scalar encoding (`{"USD": 1.0912}`) and the per-currency
 *  object encoding (`{"USD": {"value": "1.0912", "date": "2026-09-01"}}`) so a
 *  provider-side response-shape change is not an outage. */
function readRateEntry(value: unknown, fallbackDate: string): { rate: string; rateDate: string } {
  if (typeof value === 'number' || typeof value === 'string') {
    return { rate: toFixedScale(String(value)), rateDate: fallbackDate };
  }
  if (value && typeof value === 'object') {
    const obj = value as { value?: unknown; rate?: unknown; date?: unknown };
    const raw = obj.value ?? obj.rate;
    if (typeof raw === 'number' || typeof raw === 'string') {
      const date = typeof obj.date === 'string' && ISO_DATE_RE.test(obj.date) ? obj.date : fallbackDate;
      return { rate: toFixedScale(String(raw)), rateDate: date };
    }
  }
  throw new FrankfurterClientError('Unrecognized rate entry shape', 'permanent');
}

export async function fetchLatestEcbRates(
  quoteCodes: readonly string[],
  options: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FrankfurterFetchResult> {
  const requested = normalizeQuoteCodes(quoteCodes);
  if (requested.length === 0) {
    return { rates: [], requestedQuoteCodes: [], unavailableQuoteCodes: [] };
  }

  const baseUrl = options.baseUrl ?? process.env.FRANKFURTER_BASE_URL?.trim() ?? FRANKFURTER_DEFAULT_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const url = buildEcbLatestUrl(baseUrl, requested);

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FrankfurterClientError(`Frankfurter request failed: ${(err as Error).message}`, 'transient');
  }

  if (res.status === 429 || res.status >= 500) {
    throw new FrankfurterClientError(`Frankfurter responded ${res.status}`, 'transient', res.status);
  }
  if (!res.ok) {
    throw new FrankfurterClientError(`Frankfurter responded ${res.status}`, 'permanent', res.status);
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    throw new FrankfurterClientError(`Frankfurter response too large (${declared} bytes)`, 'permanent');
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new FrankfurterClientError(`Frankfurter response too large (${text.length} bytes)`, 'permanent');
  }

  let body: { base?: unknown; date?: unknown; rates?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new FrankfurterClientError('Frankfurter response was not valid JSON', 'permanent');
  }

  if (String(body.base ?? '').toUpperCase() !== ECB_REPORTING_BASE_CODE) {
    throw new FrankfurterClientError(`Frankfurter returned base "${String(body.base)}", expected EUR`, 'permanent');
  }
  const fallbackDate = typeof body.date === 'string' ? body.date : '';
  if (!ISO_DATE_RE.test(fallbackDate)) {
    throw new FrankfurterClientError(`Frankfurter returned an invalid date "${String(body.date)}"`, 'permanent');
  }
  if (!body.rates || typeof body.rates !== 'object') {
    throw new FrankfurterClientError('Frankfurter response carried no rates object', 'permanent');
  }

  const rates: FrankfurterRate[] = [];
  const returned = new Set<string>();
  for (const [rawCode, rawValue] of Object.entries(body.rates as Record<string, unknown>)) {
    const quoteCode = rawCode.trim().toUpperCase();
    if (!isKnownCurrency(quoteCode)) {
      throw new FrankfurterClientError(`Frankfurter returned unknown currency "${rawCode}"`, 'permanent');
    }
    if (quoteCode === ECB_REPORTING_BASE_CODE) continue;
    if (returned.has(quoteCode)) {
      throw new FrankfurterClientError(`Frankfurter returned duplicate currency "${quoteCode}"`, 'permanent');
    }
    returned.add(quoteCode);
    const { rate, rateDate } = readRateEntry(rawValue, fallbackDate);
    rates.push({ rateDate, baseCode: ECB_REPORTING_BASE_CODE, quoteCode, rate });
  }

  rates.sort((a, b) => a.quoteCode.localeCompare(b.quoteCode));
  return {
    rates,
    requestedQuoteCodes: requested,
    // A pair the provider does not cover is UNAVAILABLE, never 1:1 (spec §8).
    unavailableQuoteCodes: requested.filter((code) => !returned.has(code)),
  };
}
```
- [ ] **Step 4: Verify the live URL contract once** (network-permitting; the client is otherwise fully tested against stubs):
```bash
curl -sS "https://api.frankfurter.dev/v2/latest?base=EUR&quotes=USD,GBP&providers=ECB" | head -c 400
```
If the live service names the parameters differently, correct **only** `buildEcbLatestUrl` and the two URL assertions in Step 1 — the invariants that must never change are: base is EUR, the ECB provider is selected explicitly, and coverage is read from the response rather than assumed. If the endpoint is unreachable from this environment, note that in the commit body and leave the pinned contract as written.
- [ ] **Step 5: Run the suite** → all green:
```bash
pnpm --filter @breeze/api exec vitest run src/services/frankfurterClient.test.ts
```
- [ ] **Step 6: Commit** — `feat(api): Frankfurter ECB rate client with explicit provider filter and coverage reporting (#3779)`.

---

### Task 3: `exchangeRateService` — persistence and manual precedence

**Executor: claude**

Financial write path with a concurrency invariant (the feed must never clobber a manual override), so it stays with Claude. This task ships persistence only; resolution/conversion is Task 4.

**Files:**
- Create: `apps/api/src/services/exchangeRateService.ts`
- Create: `apps/api/src/services/exchangeRateService.test.ts`

**Interfaces:**
- Produces:
```ts
export const REPORTING_RATE_BASE_CODE = 'EUR';
export const DEFAULT_MAX_STALENESS_DAYS = 7; // consumed by Task 4 and by the HTTP endpoint in Task 8
export type ExchangeRateSource = 'ecb' | 'manual';
export class ExchangeRateServiceError extends Error {
  constructor(status: number, code: 'INVALID_RATE' | 'INVALID_DATE' | 'INVALID_CURRENCY' | 'UNSUPPORTED_BASE', message: string);
  readonly status: number;
  readonly code: string;
}
export interface ExchangeRateKey { rateDate: string; baseCode: string; quoteCode: string; }
export interface FeedRateInput extends ExchangeRateKey { rate: string; fetchedAt: Date; }
export interface ManualRateInput extends ExchangeRateKey { rate: string; }
export interface ExchangeRateRecord extends ExchangeRateKey { rate: string; source: ExchangeRateSource; fetchedAt: Date; }
export interface FeedUpsertResult { submitted: number; stored: number; manualProtected: number; }
export async function upsertFeedRates(rates: readonly FeedRateInput[]): Promise<FeedUpsertResult>;
export async function setManualRate(input: ManualRateInput): Promise<ExchangeRateRecord>;
export async function deleteManualRate(key: ExchangeRateKey): Promise<boolean>;
export async function listExchangeRates(input?: {
  baseCode?: string; quoteCode?: string; source?: ExchangeRateSource; onOrBefore?: string; limit?: number;
}): Promise<ExchangeRateRecord[]>;
```
- Consumes: `db`, `withSystemDbAccessContext`, `runOutsideDbContext` from `../db`; `exchangeRates` from `../db/schema`; `isKnownCurrency` from `@breeze/shared`. **Nothing else** — this module must import no domain service (the `orgCurrencyCore.ts:1-18` rule).

- [ ] **Step 1: Write the failing unit test** `apps/api/src/services/exchangeRateService.test.ts` covering validation and the shape of the conflict predicate, with the standard Drizzle mock queue (`breeze-testing` skill). Minimum cases:
  - `upsertFeedRates` rejects a non-EUR base with `UNSUPPORTED_BASE`;
  - rejects `baseCode === quoteCode` with `INVALID_CURRENCY`;
  - rejects a rate with more than 8 decimals, a zero rate and a negative rate with `INVALID_RATE`;
  - rejects a non-ISO `rateDate` (`'02/09/2026'`, `'2026-13-01'`) with `INVALID_DATE`;
  - deduplicates identical keys (last write wins) and sorts the batch by `(rateDate, baseCode, quoteCode)` before writing — assert the ordering of the values array handed to the insert builder;
  - runs its write inside `runOutsideDbContext(() => withSystemDbAccessContext(...))` — assert both mocks were called;
  - `setManualRate` always writes `source: 'manual'` even if the caller smuggles a `source` field;
  - `deleteManualRate` builds a `WHERE … AND source = 'manual'` clause — walk the bound parameters of the generated condition and assert `'manual'` is present (a vacuous `expect(where).toBeDefined()` does not count).
- [ ] **Step 2: Run it and watch it fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/services/exchangeRateService.test.ts
```
- [ ] **Step 3: Implement the persistence half of `apps/api/src/services/exchangeRateService.ts`:**
```ts
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { isKnownCurrency } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { exchangeRates } from '../db/schema';

/**
 * Reporting-only FX rates (multi-currency spec §8).
 *
 * DEPENDENCY RULE (mirrors orgCurrencyCore.ts:1-18): this module imports ONLY
 * `../db`, the schema and `@breeze/shared` — never a domain service. It is
 * consumed by dashboards and reports; every caller maps ExchangeRateServiceError
 * at its own boundary. FX NEVER touches document math and is never persisted
 * onto a document.
 */
export const REPORTING_RATE_BASE_CODE = 'EUR';
export const DEFAULT_MAX_STALENESS_DAYS = 7;
const RATE_SCALE = 8;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ExchangeRateSource = 'ecb' | 'manual';
export type ExchangeRateServiceErrorCode =
  | 'INVALID_RATE' | 'INVALID_DATE' | 'INVALID_CURRENCY' | 'UNSUPPORTED_BASE';

export class ExchangeRateServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ExchangeRateServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeRateServiceError';
  }
}

export interface ExchangeRateKey { rateDate: string; baseCode: string; quoteCode: string; }
export interface FeedRateInput extends ExchangeRateKey { rate: string; fetchedAt: Date; }
export interface ManualRateInput extends ExchangeRateKey { rate: string; }
export interface ExchangeRateRecord extends ExchangeRateKey { rate: string; source: ExchangeRateSource; fetchedAt: Date; }
export interface FeedUpsertResult { submitted: number; stored: number; manualProtected: number; }

export function assertIsoDate(value: string): string {
  if (!ISO_DATE_RE.test(value)) {
    throw new ExchangeRateServiceError(400, 'INVALID_DATE', `"${value}" is not an ISO calendar date (YYYY-MM-DD)`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const asUtc = new Date(Date.UTC(y!, m! - 1, d!));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() + 1 !== m || asUtc.getUTCDate() !== d) {
    throw new ExchangeRateServiceError(400, 'INVALID_DATE', `"${value}" is not a real calendar date`);
  }
  return value;
}

function assertCurrency(code: string, label: string): string {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (!isKnownCurrency(normalized)) {
    throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', `${label} "${code}" is not a supported currency`);
  }
  return normalized;
}

function assertRate(raw: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(String(raw).trim());
  if (!m) throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Rate "${raw}" is not a positive decimal`);
  const [, whole, frac = ''] = m;
  if (frac.length > RATE_SCALE) {
    throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Rate "${raw}" exceeds ${RATE_SCALE} decimal places`);
  }
  if (/^0+$/.test(whole) && /^0*$/.test(frac)) {
    throw new ExchangeRateServiceError(400, 'INVALID_RATE', 'Rate must be greater than zero');
  }
  return `${Number(whole)}.${frac.padEnd(RATE_SCALE, '0')}`;
}

function normalizeKey(key: ExchangeRateKey): ExchangeRateKey {
  const baseCode = assertCurrency(key.baseCode, 'base');
  const quoteCode = assertCurrency(key.quoteCode, 'quote');
  if (baseCode !== REPORTING_RATE_BASE_CODE) {
    // The table is structurally generic, but wave 7 stores exactly one pivot:
    // ECB publishes against EUR, so a second pivot would silently create
    // incomparable cross rates.
    throw new ExchangeRateServiceError(400, 'UNSUPPORTED_BASE', `Only ${REPORTING_RATE_BASE_CODE}-based rates are stored`);
  }
  if (baseCode === quoteCode) {
    throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', 'base and quote currency must differ');
  }
  return { rateDate: assertIsoDate(key.rateDate), baseCode, quoteCode };
}

/**
 * Store feed rows. THE manual-precedence invariant lives in the conflict
 * predicate: `WHERE exchange_rates.source <> 'manual'`. Whichever transaction
 * commits first, the final state of a contested cell is the manual rate —
 * feed-then-manual overwrites, manual-then-feed updates zero rows.
 */
export async function upsertFeedRates(rates: readonly FeedRateInput[]): Promise<FeedUpsertResult> {
  const byKey = new Map<string, FeedRateInput & { rate: string }>();
  for (const raw of rates) {
    const key = normalizeKey(raw);
    byKey.set(`${key.rateDate}|${key.baseCode}|${key.quoteCode}`, { ...key, rate: assertRate(raw.rate), fetchedAt: raw.fetchedAt });
  }
  const values = [...byKey.values()].sort((a, b) =>
    a.rateDate.localeCompare(b.rateDate) || a.baseCode.localeCompare(b.baseCode) || a.quoteCode.localeCompare(b.quoteCode),
  );
  if (values.length === 0) return { submitted: 0, stored: 0, manualProtected: 0 };

  const stored = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .insert(exchangeRates)
        .values(values.map((v) => ({ ...v, source: 'ecb' as const })))
        .onConflictDoUpdate({
          target: [exchangeRates.rateDate, exchangeRates.baseCode, exchangeRates.quoteCode],
          set: { rate: sql`excluded.rate`, source: sql`'ecb'`, fetchedAt: sql`excluded.fetched_at` },
          setWhere: sql`${exchangeRates.source} <> 'manual'`,
        })
        .returning({ quoteCode: exchangeRates.quoteCode }),
    ),
  );

  return { submitted: values.length, stored: stored.length, manualProtected: values.length - stored.length };
}

/** Operator override. Always writes source='manual'; a caller cannot choose the
 *  provenance. This is the self-host / air-gapped path. */
export async function setManualRate(input: ManualRateInput): Promise<ExchangeRateRecord> {
  const key = normalizeKey(input);
  const rate = assertRate(input.rate);
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .insert(exchangeRates)
        .values({ ...key, rate, source: 'manual' })
        .onConflictDoUpdate({
          target: [exchangeRates.rateDate, exchangeRates.baseCode, exchangeRates.quoteCode],
          set: { rate: sql`excluded.rate`, source: sql`'manual'`, fetchedAt: sql`now()` },
        })
        .returning(),
    ),
  );
  return row as ExchangeRateRecord;
}

/** Deletes ONLY a manual cell. Deleting does not resurrect a previously
 *  replaced ECB row: the lookup falls back to an earlier eligible row, and an
 *  online deployment repopulates the cell on the next feed run. */
export async function deleteManualRate(key: ExchangeRateKey): Promise<boolean> {
  const k = normalizeKey(key);
  const deleted = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .delete(exchangeRates)
        .where(and(
          eq(exchangeRates.rateDate, k.rateDate),
          eq(exchangeRates.baseCode, k.baseCode),
          eq(exchangeRates.quoteCode, k.quoteCode),
          eq(exchangeRates.source, 'manual'),
        ))
        .returning({ rateDate: exchangeRates.rateDate }),
    ),
  );
  return deleted.length > 0;
}

/** Read path runs in the AMBIENT context — the permissive `USING (true)` SELECT
 *  policy is exactly what makes an org-scoped request able to read rates. */
export async function listExchangeRates(input: {
  baseCode?: string; quoteCode?: string; source?: ExchangeRateSource; onOrBefore?: string; limit?: number;
} = {}): Promise<ExchangeRateRecord[]> {
  const conds = [];
  if (input.baseCode) conds.push(eq(exchangeRates.baseCode, assertCurrency(input.baseCode, 'base')));
  if (input.quoteCode) conds.push(eq(exchangeRates.quoteCode, assertCurrency(input.quoteCode, 'quote')));
  if (input.source) conds.push(eq(exchangeRates.source, input.source));
  if (input.onOrBefore) conds.push(lte(exchangeRates.rateDate, assertIsoDate(input.onOrBefore)));
  const rows = await db
    .select()
    .from(exchangeRates)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(exchangeRates.rateDate), exchangeRates.baseCode, exchangeRates.quoteCode)
    .limit(Math.min(input.limit ?? 200, 500));
  return rows as ExchangeRateRecord[];
}
```
- [ ] **Step 4: Run the unit suite** → green:
```bash
pnpm --filter @breeze/api exec vitest run src/services/exchangeRateService.test.ts
```
- [ ] **Step 5: Commit** — `feat(api): exchange-rate persistence with feed-can-never-overwrite-manual precedence (#3779)`.

---

### Task 4: `convertForReporting` — cross rates, staleness, explicit unavailability

**Executor: claude**

Financial arithmetic and the discriminated `unavailable` contract that every consuming surface depends on.

**Files:**
- Modify: `apps/api/src/services/exchangeRateService.ts` (append the resolution half)
- Modify: `apps/api/src/services/exchangeRateService.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ReportingRateLeg {
  currencyCode: string; kind: 'identity' | 'stored'; rate: string; rateDate: string;
  source: 'identity' | ExchangeRateSource;
}
export interface ReportingUnavailableLeg { currencyCode: string; reason: 'missing' | 'stale'; lastRateDate?: string; }
export type ReportingRateResult =
  | { status: 'available'; fromCode: string; toCode: string; requestedDate: string; rate: string; rateDate: string;
      source: 'identity' | 'ecb' | 'manual' | 'mixed'; legs: ReportingRateLeg[] }
  | { status: 'unavailable'; fromCode: string; toCode: string; requestedDate: string; unavailableLegs: ReportingUnavailableLeg[] };
export interface ReportingRateOptions { maxStalenessDays?: number }
export async function resolveReportingRate(from: string, to: string, date: string, options?: ReportingRateOptions): Promise<ReportingRateResult>;
export async function resolveReportingRates(fromCodes: readonly string[], to: string, date: string, options?: ReportingRateOptions): Promise<ReportingRateResult[]>;
export type ReportingConversionResult =
  | (Extract<ReportingRateResult, { status: 'available' }> & { amount: string; convertedAmount: string })
  | Extract<ReportingRateResult, { status: 'unavailable' }>;
export async function convertForReporting(amount: string | number, from: string, to: string, date: string, options?: ReportingRateOptions): Promise<ReportingConversionResult>;
```
- Consumes: `multiplyToCurrency` from `@breeze/shared` (`packages/shared/src/utils/currency.ts:169`) for the final exact half-up round at the TARGET currency's minor unit; Postgres `numeric` for the leg division.

- [ ] **Step 1: Extend the failing unit test** with the resolution contract (mocked leg rows):
  - `from === to` returns `status:'available'`, `rate:'1.00000000'`, `source:'identity'` and performs **zero** DB reads;
  - a `from` of EUR with a stored `EUR→USD` leg returns that leg's rate directly;
  - a non-EUR → non-EUR pair derives `toLeg.rate / fromLeg.rate`;
  - a leg whose latest row is 7 UTC days old is **available**; 8 days old is `unavailable` with `reason:'stale'` and `lastRateDate` populated;
  - a leg with no row at or before the requested date is `unavailable` with `reason:'missing'`;
  - a future-dated row is never selected;
  - one unavailable leg makes the whole result unavailable (both legs listed when both fail);
  - `rateDate` on an available result is the **oldest** contributing stored leg date;
  - a manual leg crossed with an ECB leg reports `source:'mixed'`;
  - `convertForReporting('100', 'USD', 'JPY', …)` returns a whole-yen `convertedAmount` (zero-decimal rounding through `multiplyToCurrency`);
  - `convertForReporting` never throws for absence — only for validation failures.
- [ ] **Step 2: Run it and watch the new cases fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/services/exchangeRateService.test.ts
```
- [ ] **Step 3: Implement, appending to `apps/api/src/services/exchangeRateService.ts`.** Merge the `@breeze/shared` import into the existing one at the top of the file (Task 3 already imports `isKnownCurrency` from it) rather than adding a second import statement; `assertIsoDate`, `assertCurrency`, `assertRate`, `RATE_SCALE` and `DEFAULT_MAX_STALENESS_DAYS` are already in scope from Task 3.
```ts
import { isKnownCurrency, multiplyToCurrency } from '@breeze/shared'; // widen the existing Task 3 import

export interface ReportingRateLeg {
  currencyCode: string;
  kind: 'identity' | 'stored';
  rate: string;
  rateDate: string;
  source: 'identity' | ExchangeRateSource;
}
export interface ReportingUnavailableLeg {
  currencyCode: string;
  reason: 'missing' | 'stale';
  lastRateDate?: string;
}
export type ReportingRateResult =
  | {
      status: 'available';
      fromCode: string; toCode: string; requestedDate: string;
      rate: string; rateDate: string;
      source: 'identity' | 'ecb' | 'manual' | 'mixed';
      legs: ReportingRateLeg[];
    }
  | {
      status: 'unavailable';
      fromCode: string; toCode: string; requestedDate: string;
      unavailableLegs: ReportingUnavailableLeg[];
    };
export interface ReportingRateOptions { maxStalenessDays?: number }

function utcDayDiff(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000);
}

type LegLookup = { rate: string; rateDate: string; source: ExchangeRateSource } | null;

/** Latest EUR→code row with rate_date <= requestedDate. Reads run in the
 *  ambient context; the permissive SELECT policy makes that safe. */
async function loadLatestLeg(quoteCode: string, requestedDate: string): Promise<LegLookup> {
  const [row] = await db
    .select({ rate: exchangeRates.rate, rateDate: exchangeRates.rateDate, source: exchangeRates.source })
    .from(exchangeRates)
    .where(and(
      eq(exchangeRates.baseCode, REPORTING_RATE_BASE_CODE),
      eq(exchangeRates.quoteCode, quoteCode),
      lte(exchangeRates.rateDate, requestedDate),
    ))
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  return row ? { rate: row.rate, rateDate: row.rateDate, source: row.source as ExchangeRateSource } : null;
}

function classifyLeg(code: string, row: LegLookup, requestedDate: string, maxStalenessDays: number):
  { ok: true; leg: ReportingRateLeg } | { ok: false; leg: ReportingUnavailableLeg } {
  if (!row) return { ok: false, leg: { currencyCode: code, reason: 'missing' } };
  const age = utcDayDiff(row.rateDate, requestedDate);
  if (age > maxStalenessDays) {
    // Beyond the ceiling the number is not honest enough to show. The caller
    // renders segmented totals only — never a guessed conversion.
    return { ok: false, leg: { currencyCode: code, reason: 'stale', lastRateDate: row.rateDate } };
  }
  return { ok: true, leg: { currencyCode: code, kind: 'stored', rate: row.rate, rateDate: row.rateDate, source: row.source } };
}

/** toLeg / fromLeg in Postgres numeric — never a JavaScript double division. */
async function deriveCrossRate(fromRate: string, toRate: string): Promise<string> {
  const [row] = await db.execute<{ rate: string }>(
    sql`select round(${toRate}::numeric / ${fromRate}::numeric, ${RATE_SCALE}) as rate`,
  );
  return String(row!.rate);
}

export async function resolveReportingRate(
  from: string, to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingRateResult> {
  const fromCode = assertCurrency(from, 'from');
  const toCode = assertCurrency(to, 'to');
  const requestedDate = assertIsoDate(date);
  const maxStalenessDays = options.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS;

  // The ONLY synthetic 1:1 in the whole program. A pair the feed does not cover
  // is unavailable, never 1:1 (spec §8).
  if (fromCode === toCode) {
    return {
      status: 'available', fromCode, toCode, requestedDate,
      rate: '1.00000000', rateDate: requestedDate, source: 'identity',
      legs: [{ currencyCode: fromCode, kind: 'identity', rate: '1.00000000', rateDate: requestedDate, source: 'identity' }],
    };
  }

  const needed = [fromCode, toCode].filter((c) => c !== REPORTING_RATE_BASE_CODE);
  const rows = await Promise.all(needed.map((code) => loadLatestLeg(code, requestedDate)));
  const lookups = new Map(needed.map((code, i) => [code, rows[i]!]));

  const legs: ReportingRateLeg[] = [];
  const unavailableLegs: ReportingUnavailableLeg[] = [];
  for (const code of [fromCode, toCode]) {
    if (code === REPORTING_RATE_BASE_CODE) {
      legs.push({ currencyCode: code, kind: 'identity', rate: '1.00000000', rateDate: requestedDate, source: 'identity' });
      continue;
    }
    const classified = classifyLeg(code, lookups.get(code) ?? null, requestedDate, maxStalenessDays);
    if (classified.ok) legs.push(classified.leg); else unavailableLegs.push(classified.leg);
  }
  if (unavailableLegs.length > 0) {
    return { status: 'unavailable', fromCode, toCode, requestedDate, unavailableLegs };
  }

  const fromLeg = legs.find((l) => l.currencyCode === fromCode)!;
  const toLeg = legs.find((l) => l.currencyCode === toCode)!;
  const rate = fromLeg.kind === 'identity'
    ? toLeg.rate
    : await deriveCrossRate(fromLeg.rate, toLeg.rate);

  const stored = legs.filter((l) => l.kind === 'stored');
  const sources = new Set(stored.map((l) => l.source));
  return {
    status: 'available', fromCode, toCode, requestedDate, rate,
    // The single disclosed date is the OLDEST contributing leg — conservative,
    // so the UI never claims a rate is fresher than its weakest leg.
    rateDate: stored.map((l) => l.rateDate).sort()[0] ?? requestedDate,
    source: sources.size === 1 ? ([...sources][0] as 'ecb' | 'manual') : 'mixed',
    legs,
  };
}

/** Batched: one leg read per distinct currency, never one per dashboard row. */
export async function resolveReportingRates(
  fromCodes: readonly string[], to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingRateResult[]> {
  const unique = [...new Set(fromCodes.map((c) => assertCurrency(c, 'from')))];
  const toCode = assertCurrency(to, 'to');
  const requestedDate = assertIsoDate(date);
  const results = await Promise.all(unique.map((code) => resolveReportingRate(code, toCode, requestedDate, options)));
  const byCode = new Map(results.map((r) => [r.fromCode, r]));
  return fromCodes.map((code) => byCode.get(assertCurrency(code, 'from'))!);
}

export type ReportingConversionResult =
  | (Extract<ReportingRateResult, { status: 'available' }> & { amount: string; convertedAmount: string })
  | Extract<ReportingRateResult, { status: 'unavailable' }>;

/**
 * Reporting-only conversion. Consumed by dashboards and reports ONLY — the
 * result is display data, is labelled approximate with its rate date, is never
 * written to a money column, and never reaches document math. There is
 * deliberately NO assertRepresentable guard: this is not a persisted amount.
 */
export async function convertForReporting(
  amount: string | number, from: string, to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingConversionResult> {
  const resolved = await resolveReportingRate(from, to, date, options);
  if (resolved.status === 'unavailable') return resolved;
  return {
    ...resolved,
    amount: String(amount),
    // Exact half-up at the TARGET currency's minor unit (JPY → whole yen).
    convertedAmount: multiplyToCurrency(amount, resolved.rate, resolved.toCode),
  };
}
```
- [ ] **Step 4: Run the unit suite** → green:
```bash
pnpm --filter @breeze/api exec vitest run src/services/exchangeRateService.test.ts
```
- [ ] **Step 5: Commit** — `feat(api): convertForReporting with EUR-pivot cross rates and a 7-day staleness ceiling (#3779)`.

---

### Task 5: Real-DB proof of precedence, staleness and cross rates

**Executor: claude**

The manual-precedence invariant and the latest-on-or-before lookup are only meaningfully provable against real Postgres (the conflict predicate and the index-backed ordering are SQL behaviour, not TypeScript).

**Files:**
- Create: `apps/api/src/__tests__/integration/exchangeRateService.integration.test.ts`

**Interfaces:**
- Consumes: `upsertFeedRates`, `setManualRate`, `deleteManualRate`, `resolveReportingRate`, `convertForReporting`, `REPORTING_RATE_BASE_CODE` from `../../services/exchangeRateService`; `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `runOutsideDbContext` from `../../db`; `exchangeRates` from `../../db/schema`; `createPartner`, `createOrganization` from `./db-utils`.

- [ ] **Step 1: Write the suite** (fixture dates are fixed literals — never `new Date()` — so the staleness boundary is deterministic). Cases:
  1. **feed then manual** on the same cell → final `source='manual'` with the manual rate.
  2. **manual then feed** on the same cell → `upsertFeedRates` returns `stored: 0, manualProtected: 1` and the stored row is still the manual one.
  3. **concurrent** feed and manual upserts for the same cell issued without awaiting in between (`await Promise.all([...])`) → final state is manual in either interleaving; run the pair 5 times.
  4. feed refresh of an existing **ecb** cell updates rate and `fetched_at`.
  5. `deleteManualRate` on an `ecb` cell returns `false` and deletes nothing.
  6. lookup selects the latest row **on or before** the requested date and ignores a future-dated row.
  7. a leg exactly 7 UTC days old resolves `available`; 8 days old resolves `unavailable` / `reason:'stale'` with `lastRateDate`.
  8. a pair with no rows resolves `unavailable` / `reason:'missing'` and **never** rate `1`.
  9. `USD → GBP` via the EUR pivot equals `round(EUR→GBP / EUR→USD, 8)` computed by Postgres.
  10. `convertForReporting('100.00','USD','JPY', …)` yields a whole-number `convertedAmount`.
  11. an ECB leg crossed with a manual leg reports `source:'mixed'` and the oldest contributing `rateDate`.
  12. a **tenant** (org-scoped) context can call `resolveReportingRate` successfully — proving the reporting read works from an ordinary request context without a system escalation.
  13. `setManualRate` called from **inside** an org-scoped context still succeeds (the `runOutsideDbContext` + system-context escape works from a request path).
- [ ] **Step 2: Run it:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRateService.integration.test.ts
```
All cases green. If case 3 is flaky, the fix is in the SQL predicate, never a retry or a relaxed assertion.
- [ ] **Step 3: Commit** — `test(api): real-DB proof of manual precedence, staleness ceiling and EUR-pivot cross rates (#3779)`.

---

### Task 6: Daily BullMQ sync job + boot one-shot

**Executor: claude**

Worker lifecycle plus the network/DB-context separation rule and three wiring sites in `index.ts`.

**Files:**
- Create: `apps/api/src/jobs/exchangeRateSync.ts`
- Create: `apps/api/src/jobs/exchangeRateSync.test.ts`
- Modify: `apps/api/src/index.ts` (import block `:219-223`, worker-init array `:1440`, shutdown list `:1676`)

**Interfaces:**
- Produces:
```ts
export interface ExchangeRateSyncStats {
  requested: number; received: number; stored: number; manualProtected: number; unavailable: string[];
}
export async function syncEcbExchangeRates(): Promise<ExchangeRateSyncStats>;
export function getExchangeRateSyncQueue(): Queue;
export function createExchangeRateSyncWorker(): Worker;
export async function scheduleExchangeRateSync(queue?: Queue): Promise<void>;
export async function initializeExchangeRateSyncWorker(): Promise<void>;
export async function shutdownExchangeRateSyncWorker(): Promise<void>;
export const __testOnly: { QUEUE_NAME: string; JOB_NAME: string; REPEAT_JOB_ID: string; BOOT_JOB_ID: string; DAILY_CRON: string; isSyncEnabled: () => boolean };
```
- Consumes: `fetchLatestEcbRates`, `FrankfurterClientError` from `../services/frankfurterClient`; `upsertFeedRates` from `../services/exchangeRateService`; `getBullMQConnection` from `../services/redis`; `captureException` from `../services/sentry`; `CURRENCY_CODES` from `@breeze/shared`.

Lifecycle template to mirror exactly: `apps/api/src/jobs/stripeAccountCacheRefresh.ts` — constants `:48-52`, env gate `:54-59`, lazy queue `:118-126`, worker with the `job.name !== JOB_NAME` guard and `concurrency: 1` `:128-147`, `schedule*` removing existing repeatables by key before re-adding `:149-188`, `initialize*` wiring `error`/`failed` → `captureException` `:191-211`, `shutdown*` `:213-222`, `__testOnly` `:225-232`.

- [ ] **Step 1: Write the failing test** `apps/api/src/jobs/exchangeRateSync.test.ts` with `vi.mock` on `../services/frankfurterClient`, `../services/exchangeRateService` and `../services/redis`:
  - `syncEcbExchangeRates` requests every `CURRENCY_CODES` entry **except EUR** (assert the array handed to `fetchLatestEcbRates` has length `CURRENCY_CODES.length - 1` and excludes `'EUR'`);
  - it forwards only returned rows to `upsertFeedRates` and returns the client's `unavailableQuoteCodes` in `stats.unavailable` — nothing is stored for an uncovered currency;
  - a `FrankfurterClientError` with `kind:'transient'` rethrows (BullMQ retries) while `kind:'permanent'` rethrows a distinguishable error the worker does not retry;
  - `__testOnly.DAILY_CRON === '15 17 * * *'`;
  - `isSyncEnabled()` is `true` when `EXCHANGE_RATE_SYNC_ENABLED` is unset/empty and `false` for `'0'|'false'|'no'|'off'`;
  - `scheduleExchangeRateSync(queueStub)` removes pre-existing repeatables whose `name === JOB_NAME` and then adds the repeat job with `jobId: REPEAT_JOB_ID` plus the boot one-shot with `jobId: BOOT_JOB_ID`;
  - with the env flag disabled, `scheduleExchangeRateSync` removes repeatables and adds **nothing**.
- [ ] **Step 2: Run it and watch it fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/jobs/exchangeRateSync.test.ts
```
- [ ] **Step 3: Implement `apps/api/src/jobs/exchangeRateSync.ts`.** Structure, with the parts that differ from the Stripe template spelled out:
```ts
import { Queue, Worker, type Job } from 'bullmq';
import { CURRENCY_CODES } from '@breeze/shared';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { fetchLatestEcbRates, FrankfurterClientError, ECB_REPORTING_BASE_CODE } from '../services/frankfurterClient';
import { upsertFeedRates } from '../services/exchangeRateService';

const QUEUE_NAME = 'exchange-rate-sync';
const JOB_NAME = 'exchange-rate-sync';
const REPEAT_JOB_ID = 'exchange-rate-sync-daily';
const BOOT_JOB_ID = 'exchange-rate-sync-boot';
// The ECB publishes its daily reference rates around 16:00 CET, so a UTC-morning
// run would always store yesterday's figures. 17:15 UTC also avoids every cron
// slot already taken in this repo (02:00 reliability, 03:00 oauthCleanup,
// 03:30 auditRetention, 03:45 stripeAccountCacheRefresh, 04:15 auditChainVerify,
// hourly cisJobs).
const DAILY_CRON = '15 17 * * *';

/** Default ON. `EXCHANGE_RATE_SYNC_ENABLED=false` is the air-gapped/self-hosted
 *  switch: no outbound calls, manual rates only. Deliberately NOT documented in
 *  .env.example — envComposeParity.test.ts requires a documented var to also be
 *  mapped into every compose `environment:` block (same posture as
 *  STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED). */
function isSyncEnabled(): boolean {
  const raw = process.env.EXCHANGE_RATE_SYNC_ENABLED;
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

export interface ExchangeRateSyncStats {
  requested: number; received: number; stored: number; manualProtected: number; unavailable: string[];
}

export async function syncEcbExchangeRates(): Promise<ExchangeRateSyncStats> {
  const quoteCodes = CURRENCY_CODES.filter((c) => c !== ECB_REPORTING_BASE_CODE);
  // Network I/O happens OUTSIDE any DB context — a pooled connection must never
  // be held across provider latency (#1105).
  const fetched = await fetchLatestEcbRates(quoteCodes);
  const fetchedAt = new Date();
  const result = await upsertFeedRates(fetched.rates.map((r) => ({ ...r, fetchedAt })));

  if (fetched.unavailableQuoteCodes.length > 0) {
    // A pair the provider does not cover stays UNAVAILABLE. We never write a
    // placeholder, never write 1:1, and never delete a prior row just because
    // today's response omitted it — the staleness ceiling governs its usability.
    console.warn(`[ExchangeRateSync] No ECB coverage for: ${fetched.unavailableQuoteCodes.join(', ')}`);
  }
  return {
    requested: fetched.requestedQuoteCodes.length,
    received: fetched.rates.length,
    stored: result.stored,
    manualProtected: result.manualProtected,
    unavailable: fetched.unavailableQuoteCodes,
  };
}
```
  Then `getExchangeRateSyncQueue`, `createExchangeRateSyncWorker` (the `job.name !== JOB_NAME` guard, `concurrency: 1`, a `console.log` of the stats line, and a `catch` that rethrows after tagging a `FrankfurterClientError` with `kind:'permanent'` as non-retryable), `scheduleExchangeRateSync` (remove repeatables by key first; return early when disabled; `queue.add(JOB_NAME, {}, { jobId: REPEAT_JOB_ID, repeat: { pattern: DAILY_CRON }, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 25 } })` then the boot one-shot `queue.add(JOB_NAME, { reason: 'boot' }, { jobId: BOOT_JOB_ID, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true, removeOnFail: true })`), `initializeExchangeRateSyncWorker`, `shutdownExchangeRateSyncWorker`, and the `__testOnly` export — each a literal transcription of the Stripe template's shape with the names above.
- [ ] **Step 4: Wire the three sites in `apps/api/src/index.ts`.** After the import block ending at `:223`:
```ts
import {
  initializeExchangeRateSyncWorker,
  shutdownExchangeRateSyncWorker,
} from './jobs/exchangeRateSync';
```
In the worker-init array, immediately after `:1440`:
```ts
    // Wave 7 (#3779): daily ECB reference-rate feed for reporting-only FX
    // (boot one-shot + 17:15 UTC cron, after the ECB's ~16:00 CET publication).
    ['exchangeRateSync', initializeExchangeRateSyncWorker],
```
In the shutdown list, immediately after `:1676`:
```ts
    shutdownExchangeRateSyncWorker,
```
- [ ] **Step 5: Run the job test and the build:**
```bash
pnpm --filter @breeze/api exec vitest run src/jobs/exchangeRateSync.test.ts
pnpm --filter @breeze/api build
```
- [ ] **Step 6: Commit** — `feat(api): daily ECB exchange-rate sync worker with boot one-shot (#3779)`.

---

### Task 7: Platform-admin manual-rate API

**Executor: claude**

Global mutation authorization: `exchange_rates` has no tenant axis, so a partner-scoped write would be a cross-tenant mutation (partner A's override would move partner B's dashboard). **DECIDED: manual rates are platform-admin only in wave 7**, mounted under `/api/v1/admin/*` — the same posture `third_party_package_catalog` already carries ("writes gated by platform-admin role at the route layer", `rls-coverage.integration.test.ts:90`). No partner-scoped manual-rate endpoint, and no admin UI in this wave; the API is the self-host/air-gapped management path.

**Files:**
- Create: `apps/api/src/routes/admin/exchangeRates.ts`
- Create: `apps/api/src/routes/admin/exchangeRates.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts` (`:1-17`)
- Modify: `packages/shared/src/validators/currency.ts` (append the two schemas; `currencyCodeSchema` is at `:7`)

**Interfaces:**
- Produces (validators, `packages/shared/src/validators/currency.ts`):
```ts
export const exchangeRateKeyParamSchema: z.ZodType<{ rateDate: string; baseCode: string; quoteCode: string }>;
export const manualExchangeRateBodySchema: z.ZodType<{ rate: string }>;
export const exchangeRateListQuerySchema: z.ZodType<{ baseCode?: string; quoteCode?: string; source?: 'ecb' | 'manual'; onOrBefore?: string; limit?: number }>;
```
- Produces (routes): `export const exchangeRateAdminRoutes: Hono`, mounted as `adminRoutes.route('/exchange-rates', exchangeRateAdminRoutes)`.
- Consumes: `listExchangeRates`, `setManualRate`, `deleteManualRate`, `ExchangeRateServiceError` from `../../services/exchangeRateService`; `requireMfa` from `../../middleware/auth` (the `admin/tenantErasure.ts:28` precedent); `zValidator` from `../../lib/validation`.

Routes:
```text
GET    /api/v1/admin/exchange-rates            (platform admin)
PUT    /api/v1/admin/exchange-rates/:rateDate/:baseCode/:quoteCode   (platform admin + MFA), body { rate: string }
DELETE /api/v1/admin/exchange-rates/:rateDate/:baseCode/:quoteCode   (platform admin + MFA)
```

- [ ] **Step 1: Write the failing route test** `apps/api/src/routes/admin/exchangeRates.test.ts` with the service mocked:
  - unauthenticated → 401; authenticated non-platform-admin → 403 (assert `platformAdminMiddleware` is what rejects);
  - PUT/DELETE without MFA → the `requireMfa` rejection status;
  - PUT with `baseCode` other than `EUR` → 400 `UNSUPPORTED_BASE` (mapped from `ExchangeRateServiceError`);
  - PUT with `rate: '1.123456789'` (9 decimals), `'0'`, `'-1'` → 400 `INVALID_RATE`;
  - PUT with `rateDate: '2026-02-30'` → 400 `INVALID_DATE`;
  - PUT with a body carrying `source: 'ecb'` → the value is ignored and `setManualRate` is called without it (assert the call argument shape);
  - PUT success → 200 with the persisted record;
  - DELETE on a non-manual/absent cell (`deleteManualRate` resolves `false`) → 404;
  - DELETE success → 200/204.
- [ ] **Step 2: Run it and watch it fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/routes/admin/exchangeRates.test.ts
```
- [ ] **Step 3: Add the validators** to `packages/shared/src/validators/currency.ts`, reusing `currencyCodeSchema` (never `z.string().length(3)` — defect B9):
```ts
/** Reporting-only FX (multi-currency spec §8). `rate` is a positive decimal
 *  STRING with at most 8 places — a JS number would lose precision at the
 *  numeric(18,8) boundary. The service re-validates; this is the user-facing
 *  error. */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const positiveRateSchema = z.string().regex(/^\d+(\.\d{1,8})?$/, 'Expected a positive decimal with at most 8 places')
  .refine((s) => Number(s) > 0, { message: 'Rate must be greater than zero' });

export const exchangeRateKeyParamSchema = z.object({
  rateDate: isoDateSchema,
  baseCode: currencyCodeSchema,
  quoteCode: currencyCodeSchema,
}).strict().refine((v) => v.baseCode !== v.quoteCode, {
  message: 'base and quote currency must differ', path: ['quoteCode'],
});

export const manualExchangeRateBodySchema = z.object({ rate: positiveRateSchema }).strict();

export const exchangeRateListQuerySchema = z.object({
  baseCode: currencyCodeSchema.optional(),
  quoteCode: currencyCodeSchema.optional(),
  source: z.enum(['ecb', 'manual']).optional(),
  onOrBefore: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export const reportingRateQuerySchema = z.object({
  /** Comma-separated source currencies, deduplicated, at most the full curated list. */
  from: z.string().min(3),
  to: currencyCodeSchema,
  date: isoDateSchema,
}).strict();
```
Export them from the validators barrel the same way `changeCurrencySchema` is exported today.
- [ ] **Step 4: Implement `apps/api/src/routes/admin/exchangeRates.ts`** — a `Hono` router whose handlers call the service and translate `ExchangeRateServiceError` into `c.json({ error: { code, message } }, err.status)`; `requireMfa` applied to the PUT and DELETE routes only; the PUT handler builds its `setManualRate` argument from the validated param + body **exclusively** (no spread of the raw body, so `source` can never be smuggled in).
- [ ] **Step 5: Mount it.** In `apps/api/src/routes/admin/index.ts`, after `:16`:
```ts
// Wave 7 (#3779): manual FX overrides. exchange_rates is a GLOBAL table with no
// tenant axis, so a partner-scoped write would move every other partner's
// dashboard — platform-admin only, with MFA on the mutating verbs (same posture
// as tenant-erasure above and third_party_package_catalog).
adminRoutes.route('/exchange-rates', exchangeRateAdminRoutes);
```
- [ ] **Step 6: Run:**
```bash
pnpm --filter @breeze/api exec vitest run src/routes/admin/exchangeRates.test.ts
pnpm --filter @breeze/shared test
```
- [ ] **Step 7: Commit** — `feat(api): platform-admin manual exchange-rate API (#3779)`.

---

### Task 8: Authenticated tenant reporting-rate endpoint

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`. You are adding ONE authenticated read endpoint that returns reporting FX rates so web dashboards can render an optional "≈ approximate" line beneath their per-currency totals. The service that computes them already exists: `apps/api/src/services/exchangeRateService.ts` exports `resolveReportingRates(fromCodes: readonly string[], to: string, date: string): Promise<ReportingRateResult[]>` and `ExchangeRateServiceError` (with `.status` and `.code`); each result is a discriminated union with `status: 'available' | 'unavailable'` — an unavailable rate is DATA, not an HTTP failure.

Mount it on the existing root-mounted billing-settings router `apps/api/src/routes/invoices/settings.ts` (the file's header at `:11-15` explains why auth is applied PER-ROUTE and never via `use('*')` — the #1383 regression; follow that convention exactly). The path is `/billing/reporting-rates`, and `billing` is **already** in `RESERVED_ROUTE_NAMESPACES` (`packages/extension-sdk/src/manifest.ts:33`), so no namespace registration is needed and `apps/api/src/extensions/reservedRouteNamespaces.test.ts` stays green. Authorization is `authMiddleware` + `requireScope('organization', 'partner', 'system')` and **no domain permission** — rates are public reference facts, and a ticket/timesheet viewer must not need invoice permissions to see an approximate total. Note this differs deliberately from the PATCH routes in the same file, which use `requireScope('partner','system')` (the `scopes` const at `:17`) plus `writePerm` (`:18`) — do not reuse `scopes`, declare a separate read-scope const.

**Files:**
- Modify: `apps/api/src/routes/invoices/settings.ts` (append after the handler ending at `:48`)
- Modify: `apps/api/src/routes/invoices/settings.test.ts`
- Modify: `apps/api/src/routes/invoices/authScope.test.ts` (extend the "still requires auth on the billing-settings routes" case at `:63-71`)

**Interfaces:**
- Consumes: `resolveReportingRates`, `DEFAULT_MAX_STALENESS_DAYS`, `ExchangeRateServiceError` from `../../services/exchangeRateService`; `reportingRateQuerySchema` from `@breeze/shared`; `authMiddleware`, `requireScope` from `../../middleware/auth`; `zValidator` from `../../lib/validation`; `handleServiceError` from `./invoices`.
- Produces the response body:
```ts
{ data: { targetCurrencyCode: string; requestedDate: string; maxStalenessDays: number; rates: ReportingRateResult[] } }
```

- [ ] **Step 1: Write the failing tests first.** In `apps/api/src/routes/invoices/settings.test.ts`, add cases (mock `../../services/exchangeRateService`):
  - `GET /billing/reporting-rates?from=EUR,GBP&to=CAD&date=2026-09-03` → 200, `data.rates` in the REQUESTED order (`EUR` then `GBP`), `data.targetCurrencyCode === 'CAD'`, `data.maxStalenessDays === 7`;
  - a duplicated `from` (`from=EUR,EUR,GBP`) resolves each currency once but the response still carries one entry per requested code;
  - a `from` list longer than 34 codes → 400;
  - an unknown code (`from=ZZZ`) → 400;
  - a missing `to` or missing `date` → 400 (**never** defaulted to USD or to today server-side);
  - a service result with `status:'unavailable'` is returned with HTTP **200** inside `data.rates`, not an error status;
  - an `ExchangeRateServiceError` thrown by the service maps to its `.status`.
  In `apps/api/src/routes/invoices/authScope.test.ts`, extend the billing-settings auth case with:
```ts
    const rates = await app.request('/billing/reporting-rates?from=EUR&to=USD&date=2026-09-03');
    expect(rates.status).toBe(401);
```
- [ ] **Step 2: Run them and watch them fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/routes/invoices/settings.test.ts src/routes/invoices/authScope.test.ts
```
- [ ] **Step 3: Implement.** Append to `apps/api/src/routes/invoices/settings.ts`:
```ts
// Multi-currency wave 7 (#3779): reporting-only FX rates for the optional
// "≈ approximate" line beneath per-currency dashboard totals. READ-ONLY and
// deliberately permission-free — rates are public reference facts (the table's
// RLS policy is `FOR SELECT USING (true)`), and a timesheet viewer must not
// need invoice permissions to see an approximate total. An unavailable rate is
// DATA (a discriminated union member), never an HTTP failure: the client then
// renders segmented totals only. Per-route middleware, never `use('*')`
// (#1383). The client cannot widen the staleness ceiling.
const readScopes = requireScope('organization', 'partner', 'system');

invoiceSettingsRoutes.get('/billing/reporting-rates', authMiddleware, readScopes,
  zValidator('query', reportingRateQuerySchema),
  async (c) => {
    const { from, to, date } = c.req.valid('query');
    const fromCodes = from.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (fromCodes.length === 0 || fromCodes.length > CURRENCY_CODES.length) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'from must list 1..34 currency codes' } }, 400);
    }
    try {
      return c.json({
        data: {
          targetCurrencyCode: to,
          requestedDate: date,
          maxStalenessDays: DEFAULT_MAX_STALENESS_DAYS,
          rates: await resolveReportingRates(fromCodes, to, date),
        },
      });
    } catch (err) { return handleServiceError(c, err); }
  });
```
Add `CURRENCY_CODES`, `reportingRateQuerySchema` to the existing `@breeze/shared` import at `:6`, and import `resolveReportingRates`, `DEFAULT_MAX_STALENESS_DAYS` from `../../services/exchangeRateService`. If `handleServiceError` does not already translate an error carrying `.status` + `.code`, add an explicit `catch` that does so here rather than changing `handleServiceError`.
- [ ] **Step 4: Run:**
```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/invoices/settings.test.ts \
  src/routes/invoices/authScope.test.ts \
  src/extensions/reservedRouteNamespaces.test.ts
```
All green — `reservedRouteNamespaces.test.ts` must stay green because `billing` is already reserved and no new root mount was added.
- [ ] **Step 5: Commit** — `feat(api): authenticated reporting-rate read endpoint (#3779)`.

---

### Task 9: Real per-currency PartnerDashboard MRR (API)

**Executor: claude**

The one remaining blind money sum in the repo. `apps/api/src/routes/partner.ts:181` emits a hardcoded `mrr: 0` for every org, and `apps/web/src/components/partner/PartnerDashboard.tsx:573,584` labels it `'USD'`. This task builds the real, per-currency number; Task 12 replaces the UI. The widget is not dropped.

**Files:**
- Modify: `apps/api/src/services/contractService.ts` (new export beside `listContracts` at `:134-174`, reusing the `resolveLineQty` / `DeviceCache` / `SeatCache` machinery at `:176-198`)
- Modify: `apps/api/src/services/contractService.test.ts`
- Modify: `apps/api/src/routes/partner.ts` (the `/dashboard` handler `:92-187`)
- Modify: `apps/api/src/routes/partner.test.ts` (the dashboard case at `:195-231`)

**Interfaces:**
- Produces:
```ts
// apps/api/src/services/contractService.ts
export interface OrgCurrencyMrr { currencyCode: string; amount: string }
export async function summarizeActiveContractMrrByOrg(orgIds: readonly string[]): Promise<Map<string, OrgCurrencyMrr[]>>;
```
- Produces (API contract change): each `/partner/dashboard` org row gains `mrrByCurrency: OrgCurrencyMrr[]` and **keeps** `mrr: number` for one release (deprecated, always `0`) so the shipped web bundle cannot break mid-deploy.
- Consumes: `contracts`, `contractLines` from `../db/schema`; `countContractDevices`, `countContractSeats` from `./contractQuantities` (`:12`, `:24`); `roundToCurrency` from `@breeze/shared` (`packages/shared/src/utils/currency.ts:158`).

- [ ] **Step 1: Write the failing service test** in `apps/api/src/services/contractService.test.ts`:
  - only `status = 'active'` contracts contribute;
  - a 12-month contract of `1200.00` contributes `100.00` monthly; a 3-month contract of `300.00` contributes `100.00`;
  - **two active contracts in different currencies under ONE org produce two entries**, never a sum (this is legitimate after an org-default change — history keeps its stamp);
  - per-contract monthly value is rounded in that contract's **own** currency (`roundToCurrency`), so a JPY contract yields a whole-yen string and never `100.50`;
  - an org with no active contracts is absent from the map (the caller renders `—`, not a zero in an assumed currency);
  - device/seat counts are batched: with 3 orgs × 2 per_device lines each, `countContractDevices` is called once per distinct `(orgId, siteId)`, not once per contract line;
  - the function does not route through `listContracts` and therefore does not inherit its `limit(Math.min(query.limit ?? 50, 100))` cap at `:149`.
- [ ] **Step 2: Run and watch it fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/services/contractService.test.ts
```
- [ ] **Step 3: Implement `summarizeActiveContractMrrByOrg`** in `apps/api/src/services/contractService.ts`:
```ts
export interface OrgCurrencyMrr { currencyCode: string; amount: string }

/**
 * Estimated monthly recurring revenue per org, GROUPED BY the contract's own
 * stamped currency (multi-currency spec §8: honest per-currency segmentation,
 * never a cross-currency sum). One org can legitimately hold active contracts
 * in several currencies after an org-default change — history keeps its stamp.
 *
 * "Estimated" because per_device/per_seat quantities are resolved live; the
 * figure is never persisted. No FX happens here: converting to a single
 * reporting currency is the CALLER's optional, explicitly-approximate step.
 */
export async function summarizeActiveContractMrrByOrg(
  orgIds: readonly string[],
): Promise<Map<string, OrgCurrencyMrr[]>> {
  const out = new Map<string, OrgCurrencyMrr[]>();
  if (orgIds.length === 0) return out;

  const rows = await db.select().from(contracts)
    .where(and(inArray(contracts.orgId, [...orgIds]), eq(contracts.status, 'active' as never)));
  if (rows.length === 0) return out;

  const allLines = await db.select().from(contractLines)
    .where(inArray(contractLines.contractId, rows.map((r) => r.id)));
  const byContract = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = byContract.get(l.contractId);
    if (list) list.push(l); else byContract.set(l.contractId, [l]);
  }

  // Shared across ALL orgs in this call, so a distinct (org, site) device count
  // and a distinct org seat count each run exactly once for the whole dashboard.
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  const totals = new Map<string, Map<string, number>>(); // orgId -> currency -> monthly

  for (const c of rows) {
    let periodValue = 0;
    for (const l of byContract.get(c.id) ?? []) {
      const { quantity } = await resolveLineQty(c.orgId, l, dc, sc);
      periodValue += Number(l.unitPrice) * quantity;
    }
    const months = c.intervalMonths > 0 ? c.intervalMonths : 1;
    // Round each contract in ITS OWN currency before grouping — a JPY contract
    // must never contribute a fractional yen.
    const monthly = Number(roundToCurrency(periodValue / months, c.currencyCode));
    const perOrg = totals.get(c.orgId) ?? new Map<string, number>();
    perOrg.set(c.currencyCode, (perOrg.get(c.currencyCode) ?? 0) + monthly);
    totals.set(c.orgId, perOrg);
  }

  for (const [orgId, perCurrency] of totals) {
    out.set(orgId, [...perCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, amount]) => ({ currencyCode, amount: roundToCurrency(amount, currencyCode) })));
  }
  return out;
}
```
- [ ] **Step 4: Write the failing route test** in `apps/api/src/routes/partner.test.ts`. The file mocks `../db` wholesale (`:4-14`), so mock the service rather than extending the `db.select` mock queue:
```ts
vi.mock('../services/contractService', () => ({
  summarizeActiveContractMrrByOrg: vi.fn(async () => new Map([
    ['org-123', [{ currencyCode: 'EUR', amount: '410.00' }, { currencyCode: 'USD', amount: '1230.00' }]],
  ])),
}));
```
Assert the dashboard row carries `mrrByCurrency` in that exact shape, that `mrr` is still present and `0` (deprecated compatibility field), and that an org missing from the map gets `mrrByCurrency: []`.
- [ ] **Step 5: Implement the route change.** In `apps/api/src/routes/partner.ts`, after the device rollup at `:170` and before the `data` map at `:172`:
```ts
  // Wave 7 (#3779): real per-currency MRR. `mrr` was a hardcoded 0 that the web
  // rendered with a hardcoded 'USD' label; it stays for ONE release so an
  // already-loaded bundle keeps rendering, and is always 0 — mrrByCurrency is
  // the truth. Never sum across currencies here or in the client.
  const mrrByOrg = await summarizeActiveContractMrrByOrg(orgIdList);
```
and in the row mapper replace `mrr: 0,` with:
```ts
      mrr: 0, // deprecated (wave 7 #3779) — read mrrByCurrency
      mrrByCurrency: mrrByOrg.get(org.id) ?? [],
```
- [ ] **Step 6: Run:**
```bash
pnpm --filter @breeze/api exec vitest run src/services/contractService.test.ts src/routes/partner.test.ts
```
- [ ] **Step 7: Commit** — `feat(api): real per-currency partner dashboard MRR (#3779)`.

---

### Task 10: Pure `approxTotal` helper (web)

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`. You are adding ONE pure function beside the shipped `sumByCurrency` in `apps/web/src/components/billing/shared/format.ts` (the file is 47 lines; `sumByCurrency` is at `:28-39` and returns `{ code: string; amount: number }[]` in first-seen order). The new function takes those per-currency groups plus the partner's own currency plus already-fetched reporting rates, and returns either a single approximate total or an explicit unavailability — it must NEVER return a partial total and never invent a rate.

Multiplication must go through `multiplyToCurrency(amount, rate, currencyCode)` from `@breeze/shared` (`packages/shared/src/utils/currency.ts:169`) — exact half-up rounding at the target currency's minor unit, computed in scaled-integer space. Converted group amounts are accumulated in exact **target minor units** via `toMinorUnits`/`fromMinorUnits` from the same module — never by adding JavaScript floats. `minorUnitExponent(currency)` (`:60`) returns `0` for zero-decimal currencies (JPY) and `2` otherwise.

**DO NOT change `sumByCurrency`'s signature** — `apps/web/src/components/billing/shared/format.test.ts:35-73` pins it and five call sites depend on it.

**Files:**
- Modify: `apps/web/src/components/billing/shared/format.ts`
- Modify: `apps/web/src/components/billing/shared/format.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ReportingRateView {
  status: 'available' | 'unavailable';
  fromCode: string;
  toCode: string;
  rate?: string;
  rateDate?: string;
}
export type ApproxTotalResult =
  | { status: 'not-needed' }
  | { status: 'available'; amount: string; currencyCode: string; rateDate: string }
  | { status: 'unavailable'; missingCurrencyCodes: string[] };
export function approxTotal(
  byCurrency: readonly { code: string; amount: string | number }[],
  partnerCurrency: string,
  rates: readonly ReportingRateView[],
): ApproxTotalResult;
```

- [ ] **Step 1: Write the failing tests** in `apps/web/src/components/billing/shared/format.test.ts`:
```ts
import { approxTotal } from './format';

describe('approxTotal', () => {
  const rate = (fromCode: string, r: string, rateDate: string): ReportingRateView =>
    ({ status: 'available', fromCode, toCode: 'CAD', rate: r, rateDate });

  it('is not-needed when every group is already the target currency', () => {
    expect(approxTotal([{ code: 'CAD', amount: 100 }], 'CAD', [])).toEqual({ status: 'not-needed' });
  });

  it('is not-needed for an empty book', () => {
    expect(approxTotal([], 'CAD', [])).toEqual({ status: 'not-needed' });
  });

  it('converts and sums foreign groups in exact target minor units', () => {
    const result = approxTotal(
      [{ code: 'USD', amount: '12300.00' }, { code: 'EUR', amount: '4100.00' }, { code: 'CAD', amount: '540.00' }],
      'CAD',
      [rate('USD', '1.36000000', '2026-09-02'), rate('EUR', '1.48000000', '2026-09-01')],
    );
    expect(result).toEqual({
      status: 'available',
      // 12300 × 1.36 = 16728.00; 4100 × 1.48 = 6068.00; + 540.00 native
      amount: '23336.00',
      currencyCode: 'CAD',
      rateDate: '2026-09-01', // OLDEST contributing rate date
    });
  });

  it('rounds at a zero-decimal target minor unit', () => {
    const result = approxTotal([{ code: 'USD', amount: '10.00' }], 'JPY',
      [{ status: 'available', fromCode: 'USD', toCode: 'JPY', rate: '150.55000000', rateDate: '2026-09-02' }]);
    // 10.00 × 150.55 = 1505.50 → half-up at JPY's minor unit = 1506. Note
    // fromMinorUnits returns a fixed-2 string for EVERY currency (currency.ts:72),
    // so the carried value is '1506.00'; formatMoney renders it as ¥1,506.
    expect(result).toEqual({ status: 'available', amount: '1506.00', currencyCode: 'JPY', rateDate: '2026-09-02' });
  });

  it.each([
    ['a missing rate', [] as ReportingRateView[]],
    ['an unavailable rate', [{ status: 'unavailable', fromCode: 'EUR', toCode: 'CAD' }] as ReportingRateView[]],
    ['a malformed rate', [{ status: 'available', fromCode: 'EUR', toCode: 'CAD', rate: 'abc', rateDate: '2026-09-01' }] as ReportingRateView[]],
    ['a rate with no date', [{ status: 'available', fromCode: 'EUR', toCode: 'CAD', rate: '1.48000000' }] as ReportingRateView[]],
  ])('suppresses the ENTIRE total for %s', (_label, rates) => {
    const result = approxTotal([{ code: 'USD', amount: '100' }, { code: 'EUR', amount: '100' }], 'CAD',
      [rate('USD', '1.36000000', '2026-09-02'), ...rates]);
    expect(result).toEqual({ status: 'unavailable', missingCurrencyCodes: ['EUR'] });
  });

  it('is unavailable when the target currency itself is unknown', () => {
    expect(approxTotal([{ code: 'USD', amount: '100' }], '', [])).toEqual({ status: 'unavailable', missingCurrencyCodes: ['USD'] });
  });
});
```
- [ ] **Step 2: Run and watch it fail:**
```bash
pnpm --filter @breeze/web exec vitest run src/components/billing/shared/format.test.ts
```
- [ ] **Step 3: Implement**, appending to `apps/web/src/components/billing/shared/format.ts`:
```ts
import { fromMinorUnits, isKnownCurrency, multiplyToCurrency, toMinorUnits } from '@breeze/shared';

/** One reporting rate as delivered by GET /billing/reporting-rates. An
 *  `unavailable` entry is DATA (the pair is uncovered or the stored rate is
 *  past the staleness ceiling), not an error. */
export interface ReportingRateView {
  status: 'available' | 'unavailable';
  fromCode: string;
  toCode: string;
  rate?: string;
  rateDate?: string;
}

export type ApproxTotalResult =
  | { status: 'not-needed' }
  | { status: 'available'; amount: string; currencyCode: string; rateDate: string }
  | { status: 'unavailable'; missingCurrencyCodes: string[] };

/**
 * Optional "≈ X <partner currency>" companion to the authoritative per-currency
 * segmentation (multi-currency spec §8). Rules that are NOT negotiable:
 *
 * - a book already entirely in the target currency needs no approximation;
 * - ANY missing, stale, malformed or dateless leg suppresses the WHOLE total —
 *   a partial approximation is a dishonest number;
 * - converted groups are accumulated in exact target MINOR UNITS, never by
 *   adding floats;
 * - the disclosed rate date is the OLDEST contributing one, so the label never
 *   claims more freshness than the weakest leg;
 * - the segmented total this sits under always stays visible.
 */
export function approxTotal(
  byCurrency: readonly { code: string; amount: string | number }[],
  partnerCurrency: string,
  rates: readonly ReportingRateView[],
): ApproxTotalResult {
  const target = String(partnerCurrency ?? '').trim().toUpperCase();
  const foreign = byCurrency.filter((g) => (g.code || '').toUpperCase() !== target);
  if (byCurrency.length === 0 || foreign.length === 0) return { status: 'not-needed' };
  if (!isKnownCurrency(target)) {
    return { status: 'unavailable', missingCurrencyCodes: foreign.map((g) => g.code.toUpperCase()) };
  }

  const byFrom = new Map(rates.filter((r) => r.toCode?.toUpperCase() === target).map((r) => [r.fromCode.toUpperCase(), r]));
  const missing: string[] = [];
  const dates: string[] = [];
  // Integer minor units of the TARGET currency. toMinorUnits returns an integer
  // number (currency.ts:65), so this accumulation is exact — no float addition
  // of converted decimal strings.
  let minor = 0;

  for (const group of byCurrency) {
    const code = (group.code || '').toUpperCase();
    if (code === target) {
      minor += toMinorUnits(group.amount, target);
      continue;
    }
    const view = byFrom.get(code);
    if (!view || view.status !== 'available' || !view.rate || !view.rateDate || !/^\d+(\.\d+)?$/.test(view.rate)) {
      missing.push(code);
      continue;
    }
    minor += toMinorUnits(multiplyToCurrency(group.amount, view.rate, target), target);
    dates.push(view.rateDate);
  }

  if (missing.length > 0) return { status: 'unavailable', missingCurrencyCodes: missing };
  return {
    status: 'available',
    amount: fromMinorUnits(minor, target),
    currencyCode: target,
    rateDate: dates.sort()[0]!,
  };
}
```
`toMinorUnits` (`packages/shared/src/utils/currency.ts:65`, returns an integer `number`) and `fromMinorUnits` (`:72`, returns a fixed-2 major-unit string for every currency, zero-decimal included) are already exported from `@breeze/shared` — `apps/api/src/services/timeEntryService.ts:7` imports both. Do not add a new shared export in this task, and do not accumulate converted decimal strings with `+`.
- [ ] **Step 4: Run** → green, and confirm the pre-existing `sumByCurrency` cases at `:35-73` are untouched:
```bash
pnpm --filter @breeze/web exec vitest run src/components/billing/shared/format.test.ts
```
- [ ] **Step 5: Commit** — `feat(web): approxTotal helper for optional approximate reporting totals (#3779)`.

---

### Task 11: `useReportingRates` hook + `ApproximateMoneyLine` + `StatCard` detail slot

**Executor: claude**

Async UI state, module-wide request de-duplication, and the one component every rollup surface reuses.

**Files:**
- Create: `apps/web/src/lib/useReportingRates.ts`
- Create: `apps/web/src/lib/__tests__/useReportingRates.test.tsx`
- Create: `apps/web/src/components/billing/shared/ApproximateMoneyLine.tsx`
- Create: `apps/web/src/components/billing/shared/ApproximateMoneyLine.test.tsx`
- Modify: `apps/web/src/components/billing/shared/StatCard.tsx` (props interface `:3-21`, render `:39-45`)
- Modify: `apps/web/src/components/billing/shared/StatCard.test.tsx`

**Interfaces:**
- Produces:
```ts
// useReportingRates.ts
export interface ReportingRatesState {
  rates: ReportingRateView[];
  targetCurrency: string | null;
  loading: boolean;
  failed: boolean;
}
export function useReportingRates(fromCodes: readonly string[], date?: string): ReportingRatesState;
export function resetReportingRateCache(): void;
```
```tsx
// ApproximateMoneyLine.tsx
export function ApproximateMoneyLine(props: {
  byCurrency: readonly { code: string; amount: string | number }[];
  date?: string;
  testId?: string;
}): JSX.Element | null;
```
```ts
// StatCard.tsx — additive only
detail?: ReactNode; // rendered beneath the value, above `hint`
```
- Consumes: `usePartnerCurrency` (`apps/web/src/lib/usePartnerCurrency.ts:88`, no-USD-fallback contract at `:6-18`); `fetchWithAuth` from `../stores/auth`; `approxTotal`, `formatMoney`, `type ReportingRateView` from `@/components/billing/shared/format`; `useTranslation('common')`.

- [ ] **Step 1: Write the failing hook test** `apps/web/src/lib/__tests__/useReportingRates.test.tsx`:
  - it requests `GET /billing/reporting-rates?from=<sorted,deduped>&to=<partner currency>&date=<given or today UTC>`;
  - it does **not** fetch while `usePartnerCurrency` is still resolving (`currency === null`, `loading`), and never substitutes `'USD'`;
  - a foreign-code list that is empty (everything already in the partner currency) fetches nothing;
  - two components mounting with the same key share ONE in-flight request (assert `fetchWithAuth` called once);
  - a non-OK response sets `failed` and leaves `rates` empty — the caller then shows segmentation only;
  - only validated results are cached; a failed request is retried on the next mount;
  - `resetReportingRateCache()` clears it.
- [ ] **Step 2: Write the failing component test** `apps/web/src/components/billing/shared/ApproximateMoneyLine.test.tsx`:
  - renders nothing (`null`) when `approxTotal` is `not-needed` (single-currency book) — proving no existing single-currency summary strip changes;
  - renders nothing when the result is `unavailable` — no placeholder, no partial total;
  - renders `≈ CA$22,940.00 approximate · rates as of 2026-08-21` (via the i18n key, with `{{amount}}` and `{{rateDate}}` interpolated) when available;
  - carries a stable `data-testid` so the page suites can assert it.
- [ ] **Step 3: Run both and watch them fail:**
```bash
pnpm --filter @breeze/web exec vitest run \
  src/lib/__tests__/useReportingRates.test.tsx \
  src/components/billing/shared/ApproximateMoneyLine.test.tsx
```
- [ ] **Step 4: Implement `useReportingRates.ts`** — a module-level `Map<string, ReportingRateView[]>` cache keyed by `${target}|${date}|${sortedFromCodes.join(',')}`, a module-level in-flight `Map<string, Promise<...>>` for de-duplication, `usePartnerCurrency()` for the target (rendering nothing until it resolves — never `'USD'`), and a `useEffect` that skips the fetch entirely when there are no foreign codes. Rates are global public facts and the key already carries the target and date, so the cache does **not** need a logout reset; export `resetReportingRateCache` anyway for tests.
- [ ] **Step 5: Implement `ApproximateMoneyLine.tsx`:**
```tsx
/**
 * The optional "≈ X <partner currency>" companion line (multi-currency spec §8).
 * It NEVER replaces the authoritative per-currency segmentation above it, and it
 * renders nothing at all when a single leg is missing or stale — an approximate
 * total that silently drops a currency is worse than no total.
 */
export function ApproximateMoneyLine({ byCurrency, date, testId }: {
  byCurrency: readonly { code: string; amount: string | number }[];
  date?: string;
  testId?: string;
}) {
  const { t } = useTranslation('common');
  const foreignCodes = useMemo(() => byCurrency.map((g) => g.code), [byCurrency]);
  const { rates, targetCurrency, loading, failed } = useReportingRates(foreignCodes, date);
  if (loading || failed || !targetCurrency) return null;
  const result = approxTotal(byCurrency, targetCurrency, rates);
  if (result.status !== 'available') return null;
  return (
    <div className="text-xs text-muted-foreground" data-testid={testId ?? 'approximate-money-line'}>
      {t('money.approximateTotal', {
        amount: formatMoney(result.amount, result.currencyCode),
        rateDate: result.rateDate,
      })}
    </div>
  );
}
```
- [ ] **Step 6: Add the `detail` slot to `StatCard.tsx`** — one optional prop, rendered between the value div (`:42`) and the hint (`:43`), with a test asserting a card without `detail` renders byte-identically to today.
- [ ] **Step 7: Run:**
```bash
pnpm --filter @breeze/web exec vitest run \
  src/lib/__tests__/useReportingRates.test.tsx \
  src/components/billing/shared/ApproximateMoneyLine.test.tsx \
  src/components/billing/shared/StatCard.test.tsx
```
- [ ] **Step 8: Commit** — `feat(web): reporting-rate hook, approximate money line and StatCard detail slot (#3779)`.

---

### Task 12: Wire segmentation + the approximate line into every money rollup

**Executor: claude**

The repo-wide surface sweep, the PartnerDashboard rebuild, and eight locale catalogs.

**Files:**
- Modify: `apps/web/src/components/billing/InvoicesPage.tsx` (summary `:352-371`, render `:407-409`)
- Modify: `apps/web/src/components/billing/quotes/QuotesPage.tsx` (summary `:281-298`, render `:395-403`)
- Modify: `apps/web/src/components/contracts/ContractsList.tsx` (summary `:236-252`, render `:352-360`)
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx` (`CurrencyAmounts` `:33-44`, render `:136-158`)
- Modify: `apps/web/src/components/time/TimesheetPage.tsx` (footer totals `:584-607`)
- Modify: `apps/web/src/components/partner/PartnerDashboard.tsx` (`Customer` type `:56-59`, `CustomerOverview` `:66-76`, `resolveMrr` `:207-209`, `normalizeCustomerData` `:228-253`, `totalMrr` `:352-354`, billing table `:559-586`)
- Create: `apps/web/src/components/partner/PartnerDashboard.test.tsx` (**no test file exists for this component today** — this is the wave's only real UI regression risk)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json`

**Interfaces:**
- Consumes: `ApproximateMoneyLine` from `@/components/billing/shared/ApproximateMoneyLine`; `sumByCurrency`, `formatMoney` from `@/components/billing/shared/format`; the `detail` prop added to `StatCard` in Task 11; the `mrrByCurrency` field added to `/partner/dashboard` in Task 9.

- [ ] **Step 1: Add the locale key to all eight catalogs.** In `apps/web/src/locales/en/common.json`, add under a new `money` object at the top level:
```json
  "money": {
    "approximateTotal": "≈ {{amount}} approximate · rates as of {{rateDate}}"
  },
```
and a **real translation** (not the English string) in `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`, each retaining both `{{amount}}` and `{{rateDate}}`. An English duplicate would trip the per-namespace duplicate baselines in `apps/web/src/lib/i18n/translationCoverage.test.ts:15+`; missing interpolations trip `apps/web/src/lib/i18n/localeParity.test.ts`.
- [ ] **Step 2: Write the failing PartnerDashboard test** `apps/web/src/components/partner/PartnerDashboard.test.tsx`:
  - a single-currency portfolio (`mrrByCurrency: [{ currencyCode: 'EUR', amount: '410.00' }]`) renders `€410.00` — **never** a `$` label;
  - a mixed portfolio renders `$12,300.00 + €4,100.00` for the total, per `sumByCurrency`, and never a single summed number;
  - an org with `mrrByCurrency: []` renders `—`, not `$0`;
  - with rates stubbed available, the approximate line appears **beneath** the segmented total and both are present;
  - with the rates endpoint failing, the segmented total is unchanged and no approximate line renders.
- [ ] **Step 3: Run it and watch it fail:**
```bash
pnpm --filter @breeze/web exec vitest run src/components/partner/PartnerDashboard.test.tsx
```
- [ ] **Step 4: Rebuild the PartnerDashboard money path.** Replace the scalar `mrr` with `mrrByCurrency: { currencyCode: string; amount: string }[]` on `Customer` and `CustomerOverview`; replace `resolveMrr` (`:207-209`) with a normalizer that reads `customer.mrrByCurrency ?? customer.billing?.mrrByCurrency ?? []`; replace `totalMrr` (`:352-354`) with `sumByCurrency` over every org's groups; replace both `formatCurrency(…, 'USD', …)` call sites (`:573`, `:584`) with a per-currency renderer using `formatMoney(amount, currencyCode)` (`—` for an empty list), and hang one `<ApproximateMoneyLine byCurrency={portfolioByCurrency} testId="partner-dashboard-mrr-approx" />` under the portfolio total at `:581-586`.
- [ ] **Step 5: Add the approximate line to the five shipped segmentation surfaces** — each is an ADDITIVE change; the existing `sumByCurrency` computations and their `' + '` join strings must not change:
  - `InvoicesPage.tsx` — pass `detail={<ApproximateMoneyLine byCurrency={summary.byCurrency} testId="invoices-outstanding-approx" />}` to the Outstanding `StatCard` at `:409`;
  - `QuotesPage.tsx` — same on the out-for-signature card at `:398-402`;
  - `ContractsList.tsx` — same on the MRR card at `:353-359`;
  - `TicketTimeBilling.tsx` — one line under the labor amounts row (`:148-150`) and one under the parts row (`:154-156`), each fed by that row's own `CurrencyAmount[]` mapped to `{ code, amount }`;
  - `TimesheetPage.tsx` — one line under the footer chips at `:594-606`, passing `date` = the earlier of today (UTC) and the selected week's end date, since a timesheet is historical.
- [ ] **Step 6: Run the affected web suites:**
```bash
pnpm --filter @breeze/web exec vitest run \
  src/components/partner/PartnerDashboard.test.tsx \
  src/components/billing/InvoicesPage.test.tsx \
  src/components/billing/quotes/QuotesPage.test.tsx \
  src/components/contracts/ContractsList.search-sort.test.tsx \
  src/components/tickets/TicketTimeBilling.test.tsx \
  src/components/time/TimesheetPage.test.tsx \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/localeParity.test.ts
```
Every pre-existing single-currency assertion must still pass **unchanged** — because `ApproximateMoneyLine` returns `null` for a single-currency book, no shipped summary string moves. If one does move, the component is rendering when it must not; fix the component, never the assertion.
- [ ] **Step 7: Commit** — `feat(web): per-currency MRR and approximate reporting totals across every money rollup (#3779)`.

---

### Task 13: Document-boundary guard

**Executor: claude**

The architectural invariant of this entire wave, turned into a test that fails if a future change imports FX into document math.

**Files:**
- Create: `apps/api/src/services/exchangeRateBoundary.test.ts`

**Interfaces:**
- Consumes: `node:fs` (`readFileSync`), `node:path` — a static source scan, the same technique as `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts`. No runtime imports of the modules under test.

- [ ] **Step 1: Write the test**, which reads each protected file and asserts it contains none of `exchangeRateService`, `convertForReporting`, `resolveReportingRate`, `resolveReportingRates`, `frankfurterClient`:
```ts
const PROTECTED_FILES = [
  'src/services/invoiceMath.ts',
  'src/services/invoiceService.ts',
  'src/services/invoiceAssembly.ts',
  'src/services/invoiceCheckout.ts',
  'src/services/invoicePdf.ts',
  'src/services/quoteMath.ts',
  'src/services/quoteService.ts',
  'src/services/quotePdf.ts',
  'src/services/quoteAcceptService.ts',
  'src/services/contractService.ts',
  'src/services/contractMath.ts',
  'src/services/catalogPricing.ts',
  'src/services/depositMath.ts',
  'src/services/stripeMoney.ts',
  'src/services/stripeReconcile.ts',
  'src/services/timeEntryService.ts',
  'src/services/accounting/quickbooksProvider.ts',
  'src/jobs/contractWorker.ts',
];
```
plus a directory sweep of `src/services/accounting/**` and `apps/portal/src/components/portal/**`. Resolve each path first and **fail loudly if a listed file does not exist** — a silently-skipped path is a guard that guards nothing. Include the rationale in a header comment: FX is reporting-only, is never persisted onto a document, and a converted figure entering document math would violate the central invariant (spec §2) by reinterpreting a stamped amount.
- [ ] **Step 2: Prove the test is not vacuous.** Temporarily add `import { convertForReporting } from './exchangeRateService';` to `apps/api/src/services/invoiceMath.ts`, run the test, confirm it **fails**, then revert:
```bash
pnpm --filter @breeze/api exec vitest run src/services/exchangeRateBoundary.test.ts
```
- [ ] **Step 3: Run it clean** → passes with the revert in place.
- [ ] **Step 4: Sweep for accidental leakage** and confirm every hit is a dashboard/report/admin surface:
```bash
grep -rn "exchangeRateService\|convertForReporting\|resolveReportingRate" apps/api/src apps/web/src apps/portal/src ee | grep -v "__tests__\|\.test\." 
```
- [ ] **Step 5: Commit** — `test(api): static guard that FX never enters document math (#3779)`.

---

### Task 14: Full verification + PR

**Executor: claude**

- [ ] **Step 1: Unit + build.**
```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm build
pnpm lint
git diff --check
```
- [ ] **Step 2: The wave-7 integration suites together** (postgres `:5440` / redis `:6390`):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRates.integration.test.ts \
  src/__tests__/integration/exchangeRateService.integration.test.ts
```
- [ ] **Step 3: Tenancy-contract hygiene** — a NEW TABLE shipped, so re-run the contract suites even though no cascade/export registration applies (proving the "no registration needed" conclusion, not assuming it):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
- [ ] **Step 4: Migration hygiene.**
```bash
ls apps/api/migrations | sort | tail -5   # 2026-09-03-exchange-rates.sql must sort last
pnpm db:check-drift                        # no drift
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
```
Then prove idempotency by applying the migration file twice against the test database and confirming the second run is a clean no-op.
- [ ] **Step 5: The whole integration config** — `pnpm --filter @breeze/api test:integration` (see the `integration_suite_needs_fsync_off_tmpfs_locally` note if it looks hung; it isn't).
- [ ] **Step 6: Manual RLS forgery check** as the unprivileged role, per CLAUDE.md:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "insert into exchange_rates values ('2026-09-03','EUR','USD',1.1,'manual',now());"
```
Must fail with `new row violates row-level security policy`, while `select * from exchange_rates limit 1;` succeeds.
- [ ] **Step 7: Confirm the two owner-fixed invariants by grep**, not by memory:
```bash
grep -rn "convertForReporting\|resolveReportingRate" apps/api/src/services | grep -v exchangeRate | grep -v "\.test\."
grep -rn "exchange_rate\|exchangeRate" apps/api/migrations | grep -v 2026-09-03-exchange-rates.sql
```
The first must return only dashboard/report/route consumers; the second must return nothing (no FX column was added to any document table).
- [ ] **Step 8: One independent review round** (repo policy: at most one, unless a fix itself touches a high-blast-radius surface — this wave adds a table with RLS policies and a global-mutation admin route, so re-review any fix that changes a policy, the conflict predicate, or the platform-admin gate).
- [ ] **Step 9: Push the branch and OPEN the PR** — `gh pr create --base main --head feature/3772-multi-currency/wave-3779`. Title: `feat: multi-currency wave 7 — reporting-only FX, exchange rates and dashboard segmentation (#3779)`. Body: the `exchange_rates` tenancy contract and its dedicated proof suite; the EUR-pivot decision and why a missing pair is `unavailable` rather than 1:1; the manual-precedence conflict predicate with its race proof; the 7-day staleness ceiling; the daily ECB job (cron, env flag, air-gapped path); the platform-admin-only manual-rate API and why a partner-scoped write would be cross-tenant; the real per-currency PartnerDashboard MRR replacing a hardcoded `mrr: 0` / `'USD'` label, with the one-release `mrr` compatibility field; the approximate-line rules (suppressed entirely on any missing leg, oldest rate date disclosed); and the static document-boundary guard. State explicitly that no document, line, payment, PDF or accounting payload gained an FX column or a converted amount. The PR targets `main` (not stacked), so Integration Tests run on the PR itself. Body ends with `Closes #3779`.
- [ ] **Step 10: STOP.** This task ends at an open PR. Do not merge — the orchestrator runs the review round and merges.

---

## Self-Review Notes

- **Spec coverage, §8 sentence by sentence.** "New global table `exchange_rates` … PK `(rate_date, base_code, quote_code)`" → Task 1 (exact columns and PK, both currency columns FK'd to `supported_currencies` as §4 requires of every program-added currency column). "added to `INTENTIONAL_UNSCOPED`, but RLS still enabled + forced — tenant-context `SELECT USING (true)`, writes only under system context; a dedicated integration test proves tenant-read-ok / tenant-write-denied / system-write-ok" → Task 1 Steps 2/6/7. "Same treatment for `supported_currencies`" → **already shipped in wave 1 and verified**: `apps/api/migrations/2026-08-27-a-supported-currencies.sql:29-40` carries the identical policy pair, `rls-coverage.integration.test.ts:92` carries the registration, and `apps/api/src/__tests__/integration/supportedCurrencies.integration.test.ts:37,48,59` already proves tenant-read / tenant-write-denied / system-write. Wave 7 writes the `exchange_rates` twin as a **new** file rather than extending that suite, because the wave-1 suite also pins a `CURRENCY_CODES` parity property (`:26`) and a literal `toHaveLength(34)` (`:45`) that have no `exchange_rates` analogue. "Daily BullMQ job … Frankfurter with the ECB provider filter" → Tasks 2 + 6, with `providers=ECB` pinned by a URL-contract assertion. "Coverage checked per currency; an uncovered pair is unavailable, never 1:1" → Task 2 (`unavailableQuoteCodes`, no synthesized row) and Task 4 (identity only when `from === to`). "Manual rates … deterministic precedence … the daily job can never overwrite them" → Task 3's `setWhere` predicate plus Task 5's both-orderings and concurrent race proofs. "Staleness … latest on or before … 7-day ceiling … explicitly unavailable and the UI shows segmented totals only" → Task 4 (`reason:'stale'` / `'missing'`, age in UTC days, 7 available / 8 unavailable) and Tasks 10-12 (any missing leg suppresses the whole line; segmentation always renders). "`convertForReporting(amount, from, to, date)` (cross-rate via the base) consumed ONLY by dashboards/reports" → Task 4 plus the Task 13 static guard. "Every money rollup shows honest per-currency segmentation (extend `sumByCurrency` to PartnerDashboard MRR, ticket summaries, any revenue widget) plus an optional '≈ X <partner currency>' line labelled approximate WITH the rate date" → Task 9 (the API side of the only remaining blind sum) + Task 12 (six surfaces + eight locales). "FX never touches document math and is never persisted onto a document" → Task 13 and the Task 14 Step 7 greps.
- **Rollup inventory is complete, not assumed.** Verified in this worktree: ticket summaries (`apps/api/src/services/timeEntryService.ts:1081-1132`, `:1162-1293`), timesheet chips (`apps/web/src/components/time/TimesheetPage.tsx:594-606`), invoices (`InvoicesPage.tsx:360,369-371`), quotes (`QuotesPage.tsx:286,296-298`), contracts (`ContractsList.tsx:240,250-252`), ticket UI (`TicketTimeBilling.tsx:33-44`) and the portal ledger are **already** per-currency — wave 7 only adds the optional approximate line to them. The single genuine blind sum left is PartnerDashboard MRR (`apps/web/src/components/partner/PartnerDashboard.tsx:353,573,584` against `apps/api/src/routes/partner.ts:181`), which is why it is its own two tasks. AI-budget surfaces (`AiUsagePage.tsx`, `AiCostIndicator.tsx`) stay `$` deliberately per spec §9 and are out of scope.
- **Deliberate decisions, flagged rather than buried.** (a) **PK stays three-column**; manual precedence is a conditional upsert, not row multiplicity — adding `source` to the PK would force every lookup to carry an `ORDER BY (source='manual') DESC` tiebreak and let two contradictory rates coexist for one date/pair. (b) **Manual rates are platform-admin only.** The table has no tenant axis and its SELECT policy is `USING (true)`, so a partner-scoped write is a cross-tenant mutation by construction; adding a partner axis would contradict §8's "global table". The spec frames manual rates as the self-host/air-gapped path, which this satisfies — on hosted, a partner cannot set a rate, and that is stated in the PR body for the owner to overrule if the product intent differs. (c) **EUR is the fixed pivot**, because the feed is ECB; the schema stays generic so a second pivot is a migration, not a rewrite. (d) `mrr` is kept as a deprecated always-zero field for one release so an already-loaded web bundle cannot break mid-deploy. (e) No `.env.example` entries, mirroring `STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED`, because `envComposeParity.test.ts` requires documented-and-mapped or neither.
- **Type consistency.** `ReportingRateResult` is defined once in `exchangeRateService.ts` and flows unchanged through the HTTP response (`data.rates`) into the web's structurally-compatible `ReportingRateView` (a narrower read-only view, deliberately not imported from the API package — the web imports only from `@breeze/shared`). Money crossing a boundary is always a **string** (`rate`, `amount`, `convertedAmount`, `OrgCurrencyMrr.amount`); the only `number` accumulations are inside `sumByCurrency`, which is pre-existing and unchanged. `approxTotal` accumulates in `bigint` minor units, never floats. `CurrencyAmount` (`timeEntryService.ts:1002`) uses `{ currencyCode, amount }` while `sumByCurrency` returns `{ code, amount }`; Task 12 Step 5 maps between them explicitly rather than widening either shape.
- **Known breakage, predicted with its fix.** `pnpm db:check-drift` reds if the Drizzle table and the SQL disagree on precision/scale/PK order/index name (Task 1 Step 8). `autoMigrate.test.ts` and `check-migration-naming.sh` red on a mis-sorted or infixed migration name (Task 1 Step 1). `partner.test.ts:195-231` asserts the dashboard payload shape — Task 9 Step 4 updates it by mocking `contractService` rather than extending the `db.select` mock queue, because `partner.test.ts:4-14` mocks `../db` wholesale. The web page suites are protected by `ApproximateMoneyLine` returning `null` for single-currency books, so no shipped summary string moves. `translationCoverage.test.ts` / `localeParity.test.ts` red on a missing locale or a dropped interpolation (Task 12 Step 1). `rls-coverage.integration.test.ts` will **not** red without the `INTENTIONAL_UNSCOPED` entry (auto-discovery keys on `org_id`), which is exactly why Task 1 also ships the dedicated proof suite.
- **Placeholders:** none. Every file path, line number, signature, SQL statement and command above was read from this worktree at `8066aedb0`. The one externally-dependent detail — Frankfurter's exact query-parameter names — is pinned as a contract with a single verification step (Task 2 Step 4) that may correct only `buildEcbLatestUrl` and its two URL assertions, never the invariants (EUR base, explicit ECB provider, coverage read from the response).
