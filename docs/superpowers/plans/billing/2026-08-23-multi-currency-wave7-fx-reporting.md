---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 7 — Reporting-Only FX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor** line; a `codex` task is written to be self-contained (codex sees only that task's text — every path, signature, fixture shape and command it needs is inside the task).

**Goal:** Ship spec §8 — a global `exchange_rates` reference table with forced RLS (tenant-read / system-write), a daily Frankfurter/ECB feed job, operator-managed manual rates that the feed can never overwrite, a staleness-bounded `convertForReporting`, and an honest per-currency segmentation + optional "≈ approximate" line on every money rollup — **without FX ever touching document math or being persisted onto a document**.

**Architecture:** Four strictly-ordered layers.

1. **Reference data (Task 1).** `exchange_rates(rate_date, base_code, quote_code, rate numeric(18,8), source, fetched_at)`, PK `(rate_date, base_code, quote_code)`, both currency columns FK'd to `supported_currencies(code)`. RLS ENABLED + FORCED with a permissive `FOR SELECT USING (true)` and a system-only `FOR ALL` policy — byte-for-byte the `supported_currencies` shape (`apps/api/migrations/2026-08-27-a-supported-currencies.sql:29-40`). Registered in `INTENTIONAL_UNSCOPED` only; no cascade, device-cascade or export-policy registration applies (no `org_id`, no `device_id`).
2. **Ingestion + resolution (Tasks 2-7).** `frankfurterClient.ts` (Frankfurter **v2 `/v2/rates`**, a flat row array — `/v2/latest` is a v1 path and 404s; explicit ECB provider selection, per-currency coverage, no synthesized 1:1) → `exchangeRateService.ts` (system-context upserts with a `WHERE exchange_rates.source <> 'manual'` conflict predicate; a SINGLE-statement `DISTINCT ON` latest-on-or-before leg snapshot with a 7-day ceiling; EUR-pivot cross rates computed in Postgres `numeric` and rounded through `multiplyToCurrency`) → a daily BullMQ job and a platform-admin manual-rate API.
3. **Reporting rollups (Tasks 8-12).** `reportingTotals.ts` + one authenticated read endpoint that converts and totals SERVER-side (target currency derived from the actor's partner, so organization-scoped viewers work), real per-currency PartnerDashboard MRR (today the API hardcodes `mrr: 0` at `apps/api/src/routes/partner.ts:181` and the UI labels it `'USD'` at `apps/web/src/components/partner/PartnerDashboard.tsx:573,584` — the last blind money sum in the repo), an arithmetic-free `selectApproxTotal` helper in a reporting-only web module, a `useApproximateTotal` hook, one `ApproximateMoneyLine` component, and its placement under six existing summary strips plus eight locale catalogs.
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
- **FX must not enter document math — enforced DENY-BY-DEFAULT.** No enumerated list of "protected files" is trustworthy: the first draft of this plan missed `quoteToContract.ts`, `stripeSettle.ts`, `quoteToPax8Order.ts`, `quoteOrderService.ts`, `stripeWebhook.ts`, `contractRenewal.ts` and `quotePay.ts`, and named `apps/api/src/services/depositMath.ts`, which **does not exist** (the real files are `packages/shared/src/utils/depositMath.ts` and `apps/portal/src/lib/invoiceDeposit.ts`). Task 13 therefore scans **every** production file under `apps/api/src`, `apps/web/src`, `apps/portal/src`, `packages/shared/src` and `ee`, and fails on any FX import that is not on a short, reasoned allowlist (the FX service, the feed client, the reporting-totals service, the sync job, the admin route, the reporting-totals endpoint, the schema file, the worker wiring, and the three web reporting files).
- **Reporting conversion happens on the SERVER, in exactly one place.** Spec §8 names `convertForReporting(amount, from, to, date)` as the reporting primitive; the browser therefore never multiplies money. `apps/api/src/services/reportingTotals.ts` converts and totals, and the web receives exact strings it only formats. Reporting presentation helpers live under `apps/web/src/lib/reporting/`, never in `apps/web/src/components/billing/shared/format.ts` — a converted value must not be one import away from a document editor.
- **Rollup totals accumulate in `bigint` minor units, never JS `number`.** `toMinorUnits` (`packages/shared/src/utils/currency.ts:65`) is `Math.round(n * 100)` on a double — correct for one line total, lossy for a portfolio. `computeReportingTotal` parses the exact fixed-scale strings textually into `bigint` and formats back the same way, and is tested above `Number.MAX_SAFE_INTEGER`.
- **`exchangeRateService.ts` is dependency-minimal**, exactly like `apps/api/src/services/orgCurrencyCore.ts:1-18`: it imports only `../db`, `../db/schema`, Drizzle primitives and `@breeze/shared` — never a domain service. Callers map its errors at their own boundary.
- **Tenancy registration — the complete, verified list.** `exchange_rates` has no `org_id` and no `device_id`, so of CLAUDE.md's four registration lists **zero** apply: do **not** add it to `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`), `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`apps/api/src/routes/devices/core.ts`), or `NOT_CASCADE_SCOPED` (`apps/api/src/__tests__/integration/tenantCascade.integration.test.ts:26`) — `supported_currencies` is in none of them either. The ONE required registration is `INTENTIONAL_UNSCOPED` at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:77-100`, adjacent to `'supported_currencies'` at `:92`. That set is documentation (auto-discovery keys on the presence of an `org_id` column), so the CI-enforced proof is the dedicated suite in Task 1.
- **Migration naming.** Exactly one file: `apps/api/migrations/2026-09-03-exchange-rates.sql`. Verify the tail first with the RUNNER's own discovery regex (`ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -5` — a bare `tail -5` returns `optional/` and `README.md`, which sort after every migration and are not migrations at all; `autoMigrate.ts:12`) → currently ends `2026-09-03-ai-agents-permissions.sql`; `exchange-rates` localeCompares after `ai-agents-permissions`, so a plain slug is correct. **Do NOT use an `-a-`/`-b-` infix on this date** — `-` (0x2D) sorts before letters, so an infixed file would sort *before* the already-shipped plain-slug file and invert the intent. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`, `DO $$ … EXCEPTION WHEN duplicate_object`), no inner `BEGIN;`/`COMMIT;`, no cleanup/backfill statements (so no `RAISE WARNING` block is required — if one is ever added it must report `GET DIAGNOSTICS … ROW_COUNT`).
- **Both new env vars are documented AND mapped — both halves, not neither.** `EXCHANGE_RATE_SYNC_ENABLED=false` is the air-gapped / self-hosted kill switch and `FRANKFURTER_BASE_URL` is the internal-mirror override; they are the whole self-host story for this wave, and a self-hoster who sets them in `.env` today would find them **inert**, because neither compose file uses `env_file:` — every variable is hand-threaded into a service `environment:` block (`docker-compose.yml:82+`, and see the rationale at `apps/api/src/config/envComposeParity.test.ts:9-38`, which exists precisely because a self-hoster's settings all silently no-op'd). Hiding them in code comments to dodge that test would ship the same bug the test was written to catch. So: add both to the relevant `.env.example` files with commented-out defaults, map both into the `api` service `environment:` block of `docker-compose.yml` and of every deploy variant that maps API vars (`${EXCHANGE_RATE_SYNC_ENABLED:-}` / `${FRANKFURTER_BASE_URL:-}`; the empty-string form is treated as unset by both readers), and run `pnpm --filter @breeze/api exec vitest run src/config/envComposeParity.test.ts` plus `src/config/composeBindMounts.test.ts` in Task 6. `STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED` is *not* the precedent to copy here — it is an internal scheduling detail with no operator story, and it is undocumented, not deliberately hidden.
- **Lock order is untouched by this wave.** Reporting reads acquire no row locks at all; FX lookups are never called from inside an invoice/payment/assembly/contract/ticket/org-currency transaction. Feed and manual upserts lock only conflicting `exchange_rates` rows and sort their keys before writing. Frankfurter I/O happens **outside** any DB context (the #1105 connection-hold rule).
- **Test stack for this worktree:** postgres `localhost:5440`, redis `localhost:6390` (already in `.env.test`, loaded by `apps/api/vitest.integration.config.ts`). Integration invocation used throughout:
  `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>`
- Unit tests follow the Drizzle mock-queue conventions in the `breeze-testing` skill. `pnpm test` green is not CI green — the integration and RLS configs are separate runners.
- Commit after every task. Every commit message ends with `(#3779)`.
- Line numbers below are pre-change references read from this worktree at `8066aedb0`. Re-grep before editing if an earlier task has already moved them.

---

### Task 1: `exchange_rates` table, Drizzle schema, RLS contract + proof

**Executor: claude**

This task defines a table's RLS policies and its tenancy registration. `AGENTS.md:203-209` keeps **multi-tenant data isolation** with Claude, and a global table whose SELECT policy is `USING (true)` is exactly the case where getting the write policy subtly wrong is invisible in a green test run. The task text below stays fully self-contained anyway, so it reads the same whoever executes it.

Context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`, branch `feature/3772-multi-currency/wave-3779`. You are adding ONE global reference table for reporting-only FX rates. It is **not** a tenant table: it has no `org_id`, no `partner_id` and no `device_id`. The house rule for such a table (see `apps/api/migrations/2026-08-27-a-supported-currencies.sql`) is: RLS **ENABLED and FORCED**, a permissive `FOR SELECT USING (true)` so ordinary org-scoped request contexts can read it, and a single system-only `FOR ALL` policy keyed on `current_setting('breeze.scope', true) = 'system'` so only the system DB context can write. Because it has no tenant column, it is registered ONLY in `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts` — it must NOT be added to `EXEMPT_TABLES`, `NOT_CASCADE_SCOPED`, `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `CORE_DEVICE_CASCADE_DELETE_TABLES` or `CORE_DEVICE_ORG_DENORMALIZED_TABLES`.

**Files:**
- Create: `apps/api/migrations/2026-09-03-exchange-rates.sql`
- Modify: `apps/api/src/db/schema/currency.ts` (currently 7 lines; `apps/api/src/db/schema/index.ts:7` already re-exports it — no barrel change needed)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (the `INTENTIONAL_UNSCOPED` set, adjacent to `'supported_currencies'` at `:92`)
- Modify: `apps/api/src/__tests__/integration/setup.ts` (`CLEANUP_TABLES`, `:214+`)
- Create: `apps/api/src/__tests__/integration/exchangeRates.integration.test.ts`

**Interfaces:**
- Produces: `export const exchangeRates` from `apps/api/src/db/schema/currency.ts`, columns `rateDate`, `baseCode`, `quoteCode`, `rate`, `source`, `fetchedAt`.
- Consumes: `supportedCurrencies` (same file, `:5-7`); `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `runOutsideDbContext`, `type DbAccessContext` from `apps/api/src/db`; `createPartner`, `createOrganization` from `apps/api/src/__tests__/integration/db-utils.ts`.

- [ ] **Step 1: Confirm the migration name sorts last.** Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7
# Filter with the RUNNER's own discovery pattern (autoMigrate.ts:12,
# /^\d{4}-.*\.sql$/). A bare `ls | tail -5` returns `optional/` and
# `README.md`, which are not migrations and sort after every real file.
ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -5
```
The last line must be `2026-09-03-ai-agents-permissions.sql`; `2026-09-03-exchange-rates.sql` sorts after it (`ex` > `ai`). Do NOT add an `-a-`/`-b-` infix — it would sort BEFORE the existing plain-slug file.
- [ ] **Step 2: Write the failing RLS suite first.** Create `apps/api/src/__tests__/integration/exchangeRates.integration.test.ts`:
```ts
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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

  // The behavioural cases above prove the OBSERVED effect. These prove the
  // CONTRACT itself: rls-coverage.integration.test.ts:845 discovers tenant
  // tables by their org_id column and from the explicit tenant-shape sets, so a
  // GLOBAL table is invisible to it — enabled/forced and the exact policy pair
  // are asserted nowhere else in the repo. supported_currencies (wave 1) is
  // asserted here too: it carries the identical contract and had the same gap.
  it.each(['exchange_rates', 'supported_currencies'])('%s has RLS ENABLED and FORCED', async (table) => {
    const [row] = (await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
      SELECT c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${table}
    `)))) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(['exchange_rates', 'supported_currencies'])('%s exposes exactly one public SELECT policy and one system-only ALL policy', async (table) => {
    const rows = (await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
      SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr,
             pg_get_expr(polwithcheck, polrelid) AS check_expr, polpermissive
      FROM pg_policy WHERE polrelid = ${table}::regclass ORDER BY polname
    `)))) as unknown as Array<{ polname: string; polcmd: string; using_expr: string | null; check_expr: string | null; polpermissive: boolean }>;

    // polcmd: 'r' = SELECT, '*' = ALL. NO unexpected extras — an added
    // permissive INSERT/UPDATE policy would silently open tenant writes.
    expect(rows).toHaveLength(2);
    const read = rows.find((r) => r.polcmd === 'r')!;
    const all = rows.find((r) => r.polcmd === '*')!;
    expect(read).toBeDefined();
    expect(read.polpermissive).toBe(true);
    expect(read.using_expr).toBe('true');
    expect(read.check_expr).toBeNull();
    expect(all).toBeDefined();
    for (const expr of [all.using_expr, all.check_expr]) {
      expect(expr).toContain("current_setting('breeze.scope'");
      expect(expr).toContain("'system'");
    }
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
- [ ] **Step 3: Add the Drizzle table FIRST** (the code block in Step 5 below) so the suite can compile. Without the `exchangeRates` export the suite fails on a missing import — a failure that proves nothing about RLS. Add the export, then move to Step 4.
- [ ] **Step 4: Run it and watch it fail** for the RIGHT reason — Postgres `42P01 relation "exchange_rates" does not exist` (not a TypeScript/import error). If the failure is an import error, Step 3 was skipped:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRates.integration.test.ts
```
- [ ] **Step 5: Write the migration.** Create `apps/api/migrations/2026-09-03-exchange-rates.sql`:
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
- [ ] **Step 6: The Drizzle table (added in Step 3).** Append to `apps/api/src/db/schema/currency.ts` (and widen the import line at `:1`):
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
- [ ] **Step 7: Register in `INTENTIONAL_UNSCOPED`.** In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, immediately after the `'supported_currencies'` entry (`:92`), add:
```ts
  'exchange_rates', // Global reporting-only FX reference data (multi-currency spec §8). No tenant axis. Forced RLS: permissive USING (true) SELECT (org-scoped request contexts read rates to render an approximate total), system-only writes. Mirrors supported_currencies. Proven by exchangeRates.integration.test.ts.
```
Do NOT touch `EXEMPT_TABLES` (`:48-61`) — this table IS tenant-readable — and do NOT touch `NOT_CASCADE_SCOPED` in `tenantCascade.integration.test.ts` (`:26`).
- [ ] **Step 8: Register `exchange_rates` in the integration cleanup list.** `exchange_rates` is a MUTABLE global table, unlike the seeded, never-truncated `supported_currencies` (deliberately absent from this list). Without an entry, rows written by one suite leak into every later suite in the same shard and the staleness/precedence cases become order-dependent. In `apps/api/src/__tests__/integration/setup.ts`, add to `CLEANUP_TABLES` (`:214+`):
```ts
  // Mutable GLOBAL reference data (multi-currency spec §8, #3779). Not tenant
  // data and not reached by any cascade, so it must be named explicitly or FX
  // rows survive between tests. supported_currencies is NOT here on purpose —
  // it is seeded reference data every suite depends on.
  'exchange_rates',
```
- [ ] **Step 9: Apply the migration to the test DB and run both suites** (postgres `localhost:5440`, redis `localhost:6390`, already in `.env.test`):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRates.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```
All three must pass.
- [ ] **Step 10: Prove no drift and no ordering regression:**
```bash
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
```
- [ ] **Step 11: Commit** — `feat(api): exchange_rates global FX reference table with forced RLS (#3779)`.

---

### Task 2: Frankfurter ECB client

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`. You are writing ONE isolated service module that fetches daily reference FX rates from the public Frankfurter API and returns them as strings, plus its co-located unit test. It touches no database and no other service. Two hard rules from the spec: (a) the **ECB provider filter must be set explicitly** — Frankfurter v2 blends providers by default and blended data is forbidden; (b) a currency the response does not cover is **unavailable** and must be reported as such — the client must NEVER synthesize a rate, and must never fall back to `1`. The base is always `EUR`.

**The external contract is FROZEN — it was verified live against the real service on 2026-08-23, not inferred from v1 docs.** Do not re-derive it, and do not port the v1 `{base, date, rates:{…}}` object shape:

```text
$ curl -sS "https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD,GBP&providers=ECB"
[{"date":"2026-08-21","base":"EUR","quote":"GBP","rate":0.8567},
 {"date":"2026-08-21","base":"EUR","quote":"USD","rate":1.1699}]

$ curl -sS "https://api.frankfurter.dev/v2/latest?base=EUR&quotes=USD"
{"status":404,"message":"not found"}          # /v2/latest DOES NOT EXIST

$ curl -sS "https://api.frankfurter.dev/v2/"
{"version":"v2","status":"current","openapi":"/v2/openapi.json","docs":"https://frankfurter.dev"}
```

So: the endpoint is **`/v2/rates`**, the response is a **flat JSON array of rows**, and **each row carries its own `date`, `base`, `quote` and `rate`** — there is no envelope, no top-level `date`, and no `rates` object. Coverage is read by comparing the returned `quote` values against the requested set. Every row must be validated individually (`base === 'EUR'`, `quote` a known currency, `rate > 0`, `date` ISO); a row that fails is a `permanent` failure, not a skipped row.

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
export function buildEcbRatesUrl(baseUrl: string, quoteCodes: readonly string[]): string;
export async function fetchLatestEcbRates(
  quoteCodes: readonly string[],
  options?: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<FrankfurterFetchResult>;
```
- Consumes: `CURRENCY_CODES`, `isKnownCurrency` from `@breeze/shared` (`packages/shared/src/utils/currency.ts:23,34`).

- [ ] **Step 1: Write the failing test first.** Create `apps/api/src/services/frankfurterClient.test.ts` with a `fetchImpl` stub (never a real network call). Every fixture below is a **flat v2 row array**:
```ts
import { describe, it, expect } from 'vitest';
import {
  buildEcbRatesUrl,
  fetchLatestEcbRates,
  FrankfurterClientError,
  FRANKFURTER_DEFAULT_BASE_URL,
} from './frankfurterClient';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('buildEcbRatesUrl', () => {
  it('targets /v2/rates and pins base=EUR, sorted unique quotes and an EXPLICIT ECB provider filter', () => {
    const url = new URL(buildEcbRatesUrl(FRANKFURTER_DEFAULT_BASE_URL, ['USD', 'GBP', 'USD']));
    // /v2/latest does not exist in v2 — it 404s (verified 2026-08-23).
    expect(url.pathname.endsWith('/v2/rates')).toBe(true);
    expect(url.searchParams.get('base')).toBe('EUR');
    expect(url.searchParams.get('quotes')).toBe('GBP,USD');
    // v2 blends providers by default — the filter is never omitted (spec §8).
    expect(url.searchParams.get('providers')).toBe('ECB');
  });

  it('never requests EUR against itself', () => {
    const url = new URL(buildEcbRatesUrl(FRANKFURTER_DEFAULT_BASE_URL, ['EUR', 'USD']));
    expect(url.searchParams.get('quotes')).toBe('USD');
  });
});

describe('fetchLatestEcbRates', () => {
  it('parses flat v2 rows, keeps each row’s own date and reports uncovered currencies as unavailable — never 1:1', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { date: '2026-08-21', base: 'EUR', quote: 'GBP', rate: 0.8567 },
        { date: '2026-08-20', base: 'EUR', quote: 'USD', rate: 1.1699 },
      ])) as unknown as typeof fetch;

    const result = await fetchLatestEcbRates(['USD', 'GBP', 'KES'], { fetchImpl });

    expect(result.rates).toEqual([
      { rateDate: '2026-08-21', baseCode: 'EUR', quoteCode: 'GBP', rate: '0.85670000' },
      { rateDate: '2026-08-20', baseCode: 'EUR', quoteCode: 'USD', rate: '1.16990000' },
    ]);
    expect(result.unavailableQuoteCodes).toEqual(['KES']);
    expect(result.rates.some((r) => r.quoteCode === 'KES')).toBe(false);
  });

  it('accepts a string rate encoding', async () => {
    const fetchImpl = (async () =>
      jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: '1.16990000' }])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
    expect(result.rates).toEqual([{ rateDate: '2026-08-21', baseCode: 'EUR', quoteCode: 'USD', rate: '1.16990000' }]);
  });

  it('ignores rows for currencies that were not requested', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 },
        { date: '2026-08-21', base: 'EUR', quote: 'CHF', rate: 0.94 },
      ])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
    expect(result.rates.map((r) => r.quoteCode)).toEqual(['USD']);
    expect(result.unavailableQuoteCodes).toEqual([]);
  });

  it.each([
    ['429', 429, 'transient'],
    ['503', 503, 'transient'],
    ['400', 400, 'permanent'],
    ['404 (wrong endpoint)', 404, 'permanent'],
  ])('classifies HTTP %s as %s', async (_label, status, kind) => {
    const fetchImpl = (async () => jsonResponse({ status, message: 'not found' }, { status })) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind });
  });

  it('treats a network throw as transient', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toBeInstanceOf(FrankfurterClientError);
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'transient' });
  });

  it.each([
    ['malformed JSON', () => jsonResponse('not json')],
    ['a v1-style envelope object instead of an array', () => jsonResponse({ base: 'EUR', date: '2026-08-21', rates: { USD: 1.1699 } })],
    ['a row with the wrong base', () => jsonResponse([{ date: '2026-08-21', base: 'USD', quote: 'GBP', rate: 0.79 }])],
    ['a row with an invalid date', () => jsonResponse([{ date: '21/08/2026', base: 'EUR', quote: 'USD', rate: 1.1699 }])],
    ['a row with a non-positive rate', () => jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 0 }])],
    ['a row for an unknown currency', () => jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'ZZZ', rate: 1.5 }])],
    ['duplicate rows for one currency', () => jsonResponse([
      { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 },
      { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.2 },
    ])],
  ])('classifies %s as permanent', async (_label, makeResponse) => {
    const fetchImpl = (async () => makeResponse()) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('rejects an over-sized body as permanent', async () => {
    const fetchImpl = (async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '2000000' } })) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('returns an empty result without fetching when no quote codes remain', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return jsonResponse([]); }) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['EUR'], { fetchImpl });
    expect(called).toBe(0);
    expect(result).toEqual({ rates: [], requestedQuoteCodes: [], unavailableQuoteCodes: [] });
  });

  it('reports EVERY requested code as unavailable for an empty array response', async () => {
    const fetchImpl = (async () => jsonResponse([])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD', 'GBP'], { fetchImpl });
    expect(result.rates).toEqual([]);
    expect(result.unavailableQuoteCodes).toEqual(['GBP', 'USD']);
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
 *  help, so the job fails without burning attempts (the worker wraps these in
 *  BullMQ's UnrecoverableError — see Task 6). */
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

/** Frankfurter **v2** — `/v2/rates`, flat row array. `/v2/latest` is a v1 path
 *  and 404s here (verified against the live service 2026-08-23). */
export function buildEcbRatesUrl(baseUrl: string, quoteCodes: readonly string[]): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/rates`);
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

/** One flat v2 row: `{ date, base, quote, rate }`. Every field is validated —
 *  a bad row fails the whole fetch rather than being silently dropped, because
 *  a silently-dropped row is indistinguishable from "the ECB does not cover
 *  this pair", and those two cases must never be conflated. */
function readRow(value: unknown): FrankfurterRate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FrankfurterClientError('Frankfurter row was not an object', 'permanent');
  }
  const row = value as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown };
  const rateDate = typeof row.date === 'string' ? row.date : '';
  if (!ISO_DATE_RE.test(rateDate)) {
    throw new FrankfurterClientError(`Frankfurter row carried an invalid date "${String(row.date)}"`, 'permanent');
  }
  const baseCode = String(row.base ?? '').trim().toUpperCase();
  if (baseCode !== ECB_REPORTING_BASE_CODE) {
    throw new FrankfurterClientError(`Frankfurter row base "${String(row.base)}", expected EUR`, 'permanent');
  }
  const quoteCode = String(row.quote ?? '').trim().toUpperCase();
  if (!isKnownCurrency(quoteCode)) {
    throw new FrankfurterClientError(`Frankfurter returned unknown currency "${String(row.quote)}"`, 'permanent');
  }
  if (typeof row.rate !== 'number' && typeof row.rate !== 'string') {
    throw new FrankfurterClientError(`Frankfurter row for ${quoteCode} carried no rate`, 'permanent');
  }
  return { rateDate, baseCode, quoteCode, rate: toFixedScale(String(row.rate)) };
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
  const url = buildEcbRatesUrl(baseUrl, requested);

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

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FrankfurterClientError('Frankfurter response was not valid JSON', 'permanent');
  }
  // v2 returns a flat ARRAY of rows. An object body means either the v1
  // envelope or an error payload — both are protocol failures.
  if (!Array.isArray(body)) {
    throw new FrankfurterClientError('Frankfurter v2 response was not a row array', 'permanent');
  }

  const wanted = new Set(requested);
  const rates: FrankfurterRate[] = [];
  const returned = new Set<string>();
  for (const raw of body) {
    const row = readRow(raw);
    if (returned.has(row.quoteCode)) {
      throw new FrankfurterClientError(`Frankfurter returned duplicate currency "${row.quoteCode}"`, 'permanent');
    }
    returned.add(row.quoteCode);
    // Extra coverage is not an error, it is just not ours to store.
    if (wanted.has(row.quoteCode)) rates.push(row);
  }

  return {
    rates,
    requestedQuoteCodes: requested,
    // A pair the provider does not cover is UNAVAILABLE, never 1:1 (spec §8).
    unavailableQuoteCodes: requested.filter((code) => !returned.has(code)),
  };
}
```
- [ ] **Step 4: Re-verify the frozen contract once** (network-permitting; the client is otherwise fully tested against stubs):
```bash
curl -sS "https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD,GBP&providers=ECB" | head -c 400
```
Expect a flat array of `{date, base, quote, rate}` rows exactly as pinned above. If the live service has moved again, correct `buildEcbRatesUrl`, `readRow`, the fixtures and the assertions together — implementation corrections are permitted here, they are not limited to the URL. The invariants that must never change are: base is EUR, the ECB provider is selected explicitly, each row's own date is preserved, and coverage is read from the response rather than assumed. If the endpoint is unreachable from this environment, note that in the commit body and leave the pinned contract as written.
- [ ] **Step 5: Run the suite** → all green:
```bash
pnpm --filter @breeze/api exec vitest run src/services/frankfurterClient.test.ts
```
- [ ] **Step 6: Commit** — `feat(api): Frankfurter v2 ECB rate client with explicit provider filter and coverage reporting (#3779)`.

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
  - `convertForReporting` never throws for absence — only for validation failures;
  - **`resolveReportingRate` issues exactly ONE table read** — assert the leg-loading statement is executed once for a non-EUR → non-EUR pair (a two-read implementation is the snapshot bug);
  - `resolveReportingRates(['USD','GBP','CAD'], 'CHF', …)` also issues exactly ONE table read, and resolves the target leg once, not once per pair.
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

/**
 * EVERY requested leg in ONE statement, so every cross rate is derived from a
 * SINGLE database snapshot. Two separate "latest leg" queries can straddle a
 * feed or manual commit and yield a hybrid cross rate that never existed at any
 * instant — the exact failure mode the manual-precedence work exists to
 * prevent, reappearing one layer up. `DISTINCT ON` keeps the "latest row on or
 * before" semantics and rides `exchange_rates_lookup_idx`.
 *
 * Reads run in the ambient context; the permissive SELECT policy makes that
 * safe from an org-scoped request.
 */
async function loadLatestLegs(
  quoteCodes: readonly string[], requestedDate: string,
): Promise<Map<string, LegLookup>> {
  const codes = [...new Set(quoteCodes)].filter((c) => c !== REPORTING_RATE_BASE_CODE);
  const out = new Map<string, LegLookup>(codes.map((c) => [c, null]));
  if (codes.length === 0) return out;
  const rows = await db.execute<{ quote_code: string; rate: string; rate_date: string; source: ExchangeRateSource }>(sql`
    SELECT DISTINCT ON (quote_code)
      quote_code, rate::text AS rate, rate_date::text AS rate_date, source
    FROM exchange_rates
    WHERE base_code = ${REPORTING_RATE_BASE_CODE}
      AND quote_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
      AND rate_date <= ${requestedDate}::date
    ORDER BY quote_code, rate_date DESC
  `);
  for (const r of rows) {
    out.set(r.quote_code.trim(), { rate: r.rate, rateDate: r.rate_date, source: r.source });
  }
  return out;
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

/** toLeg / fromLeg in Postgres numeric — never a JavaScript double division.
 *  Touches NO table (both operands are literals already read under the single
 *  leg snapshot), so it cannot introduce snapshot skew. */
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

  // ONE statement for both legs — see loadLatestLegs for why this must not be
  // two round trips.
  const lookups = await loadLatestLegs([fromCode, toCode], requestedDate);

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

/**
 * Batched AND snapshot-consistent: ONE `loadLatestLegs` call covering every
 * distinct source currency PLUS the target, then pure classification per pair.
 * Never one statement per dashboard row, and never a second read of the target
 * leg — re-reading it per pair is how a batch ends up mixing two snapshots.
 */
export async function resolveReportingRates(
  fromCodes: readonly string[], to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingRateResult[]> {
  const unique = [...new Set(fromCodes.map((c) => assertCurrency(c, 'from')))];
  const toCode = assertCurrency(to, 'to');
  const requestedDate = assertIsoDate(date);
  const lookups = await loadLatestLegs([...unique, toCode], requestedDate);
  // resolveFromLegs is the pure half of resolveReportingRate (classification +
  // cross-rate derivation) taking the pre-loaded snapshot; resolveReportingRate
  // is `loadLatestLegs` + `resolveFromLegs` for the single-pair case, so the two
  // entry points cannot drift.
  const results = await Promise.all(
    unique.map((code) => resolveFromLegs(code, toCode, requestedDate, lookups, options)),
  );
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

The manual-precedence invariant and the latest-on-or-before lookup are only meaningfully provable against real Postgres (the conflict predicate, the single-statement leg snapshot and the index-backed ordering are SQL behaviour, not TypeScript).

**Files:**
- Create: `apps/api/src/__tests__/integration/exchangeRateService.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/setup.ts` (`CLEANUP_TABLES`, `:214+`) — **already done in Task 1 Step 7**; re-confirm the entry is present before writing this suite, because every case below assumes a truncated table.

**Interfaces:**
- Consumes: `upsertFeedRates`, `setManualRate`, `deleteManualRate`, `resolveReportingRate`, `convertForReporting`, `REPORTING_RATE_BASE_CODE` from `../../services/exchangeRateService`; `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `runOutsideDbContext` from `../../db`; `exchangeRates` from `../../db/schema`; `createPartner`, `createOrganization` from `./db-utils`; `postgres`-style raw transactions from the integration `testClient` (`./setup`) for the barrier cases.

- [ ] **Step 1: Write the suite** (fixture dates are fixed literals — never `new Date()` — so the staleness boundary is deterministic; each `describe` block uses its OWN pair so no two cases can contend for a cell). Cases:
  1. **feed then manual** on the same cell → final `source='manual'` with the manual rate.
  2. **manual then feed** on the same cell → `upsertFeedRates` returns `stored: 0, manualProtected: 1` and the stored row is still the manual one.
  3. feed refresh of an existing **ecb** cell updates rate and `fetched_at`.
  4. `deleteManualRate` on an `ecb` cell returns `false` and deletes nothing.
  5. lookup selects the latest row **on or before** the requested date and ignores a future-dated row.
  6. a leg exactly 7 UTC days old resolves `available`; 8 days old resolves `unavailable` / `reason:'stale'` with `lastRateDate`.
  7. a pair with no rows resolves `unavailable` / `reason:'missing'` and **never** rate `1`.
  8. `USD → GBP` via the EUR pivot equals `round(EUR→GBP / EUR→USD, 8)` computed by Postgres.
  9. `convertForReporting('100.00','USD','JPY', …)` yields a whole-number `convertedAmount`.
  10. an ECB leg crossed with a manual leg reports `source:'mixed'` and the oldest contributing `rateDate`.
  11. a **tenant** (org-scoped) context can call `resolveReportingRate` successfully — proving the reporting read works from an ordinary request context without a system escalation.
  12. `setManualRate` called from **inside** an org-scoped context still succeeds (the `runOutsideDbContext` + system-context escape works from a request path).
- [ ] **Step 2: Prove the precedence ordering DETERMINISTICALLY with transaction barriers — not with `Promise.all`.** A bare `Promise.all([feed, manual])` does not force either commit ordering: both statements can serialize without ever contending, so the test can pass while never exercising the contested path. Hold one transaction open and make the other wait on its row lock instead. Add to the suite:
```ts
// Barrier A — the feed upsert is IN FLIGHT and uncommitted when the manual
// write arrives. The manual write blocks on the feed's row lock, then applies
// on top: final state manual.
it('manual wins when it arrives while an uncommitted feed upsert holds the row', async () => {
  const key = { rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'NOK' } as const;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });

  const feedTx = testClient.begin(async (tx) => {
    await tx`SET LOCAL breeze.scope = 'system'`;
    await tx`insert into exchange_rates (rate_date, base_code, quote_code, rate, source, fetched_at)
             values (${key.rateDate}, ${key.baseCode}, ${key.quoteCode}, '11.10000000', 'ecb', now())
             on conflict (rate_date, base_code, quote_code)
             do update set rate = excluded.rate, source = 'ecb', fetched_at = excluded.fetched_at
             where exchange_rates.source <> 'manual'`;
    await held; // keep the row locked until the manual write is queued
  });

  const manual = (async () => {
    await new Promise((r) => setTimeout(r, 100)); // manual is now waiting on the lock
    return setManualRate({ ...key, rate: '11.99000000' });
  })();

  release();
  await Promise.all([feedTx, manual]);

  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select().from(exchangeRates).where(/* key */)));
  expect(row).toMatchObject({ source: 'manual', rate: '11.99000000' });
});

// Barrier B — the reverse: an uncommitted MANUAL write holds the row when the
// feed upsert arrives. The feed blocks, re-evaluates `setWhere` against the
// COMMITTED manual row, and updates zero rows.
it('feed cannot clobber a manual row it had to wait for', async () => {
  // …same structure, roles swapped; assert upsertFeedRates() resolves
  // { stored: 0, manualProtected: 1 } and the stored row is still manual.
});
```
  Assert the stored `source` **and** `rate` after each forced interleaving. If either barrier case fails, the fix is in the SQL predicate — never a retry, a sleep bump or a relaxed assertion.
- [ ] **Step 3: Prove the cross-rate snapshot is atomic.** `resolveReportingRate` fetches both legs in ONE statement (Task 4), so a commit landing between the legs can never produce a hybrid cross rate. Add:
```ts
it('never derives a cross rate from two different database snapshots', async () => {
  // Seed EUR→USD and EUR→GBP. Then, from a second connection, hold a
  // transaction that updates EUR→GBP and commits WHILE a tight loop of
  // resolveReportingRate('USD','GBP',…) runs. Every observed result must equal
  // round(oldGbp/usd, 8) or round(newGbp/usd, 8) — never a mix with a third
  // value, and never an `unavailable`.
});
```
- [ ] **Step 4: Run it:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/exchangeRateService.integration.test.ts
```
All cases green.
- [ ] **Step 5: Commit** — `test(api): real-DB proof of manual precedence, staleness ceiling and EUR-pivot cross rates (#3779)`.

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
  - a `FrankfurterClientError` with `kind:'transient'` rethrows AS-IS so BullMQ retries;
  - a `FrankfurterClientError` with `kind:'permanent'` (and any misconfiguration — unknown/unsupported currency in the curated list, an unparseable `FRANKFURTER_BASE_URL`) is rethrown wrapped in **BullMQ's `UnrecoverableError`**. "Should not retry" is not a property of a plain `Error`: without `UnrecoverableError` BullMQ burns all 3 attempts on a request that cannot succeed. Repo precedent: `apps/api/src/services/bullmqValidation.ts:1,27` (`throw new UnrecoverableError(...)`). Assert the thrown value `toBeInstanceOf(UnrecoverableError)` and, in a worker-level case, that a job failing this way is not re-attempted (`attemptsMade === 1`);
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
  Then `getExchangeRateSyncQueue`, `createExchangeRateSyncWorker` (the `job.name !== JOB_NAME` guard, `concurrency: 1`, a `console.log` of the stats line, and a `catch` that rethrows a transient `FrankfurterClientError` unchanged but wraps a `kind:'permanent'` one in `new UnrecoverableError(...)` imported from `bullmq`), `scheduleExchangeRateSync` (remove repeatables by key first; return early when disabled; `queue.add(JOB_NAME, {}, { jobId: REPEAT_JOB_ID, repeat: { pattern: DAILY_CRON }, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 25 } })` then the boot one-shot `queue.add(JOB_NAME, { reason: 'boot' }, { jobId: BOOT_JOB_ID, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true, removeOnFail: true })`), `initializeExchangeRateSyncWorker`, `shutdownExchangeRateSyncWorker`, and the `__testOnly` export — each a literal transcription of the Stripe template's shape with the names above.
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
  - PUT with a body carrying `source: 'ecb'` → **400**, and `setManualRate` is NEVER called (assert the mock's call count is 0). `manualExchangeRateBodySchema` is `.strict()`, so an unknown key is a validation error — "silently ignored but still processed" would contradict the schema and is the weaker contract anyway: an operator who thinks they are pinning an ECB rate should be told they cannot, not have the field dropped. The provenance guarantee is still belt-and-braces in the handler, which builds its `setManualRate` argument from the validated param + `rate` only and never spreads the raw body;
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
```
`reportingTotalsQuerySchema` (the read side) is added by Task 8, in the same file and the same style — do not add it here.
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

### Task 8: Server-side reporting totals — service + authenticated endpoint

**Executor: claude**

Authorization and scope design (AGENTS.md "Keep with Claude: authentication/authorization logic"), plus the money arithmetic that used to live in the browser.

**The conversion happens on the SERVER.** Spec §8 defines `convertForReporting(amount, from, to, date)` as *the* reporting conversion primitive; an endpoint that returned bare rates would leave it unused and would re-implement multiplication in the web client, where a document editor could reuse a converted value. The endpoint therefore accepts the caller's per-currency groups and returns **converted minor-unit-exact amounts plus provenance**. The client only displays what it is given.

**The target currency is derived server-side.** `to` is OPTIONAL; when omitted the endpoint resolves the authenticated actor's partner reporting currency from `partners.currency_code` (`apps/api/src/db/schema/orgs.ts:73`) via `auth.partnerId`. This is what makes the endpoint usable by ORGANIZATION-scoped viewers: `usePartnerCurrency` (`apps/web/src/lib/usePartnerCurrency.ts:64`) reads `GET /orgs/partners/me`, which is gated `requireScope('partner')` (`apps/api/src/routes/orgs.ts:723`) — an org-scoped user calling it gets a 403 and would silently lose the approximate line. Deriving the target here removes that dependency entirely; the web hook never calls `usePartnerCurrency`. There is **no client-side default and no USD fallback** anywhere in the chain.

**Files:**
- Create: `apps/api/src/services/reportingTotals.ts`
- Create: `apps/api/src/services/reportingTotals.test.ts`
- Modify: `apps/api/src/routes/invoices/settings.ts` (append after the handler ending at `:48`)
- Modify: `apps/api/src/routes/invoices/settings.test.ts`
- Modify: `apps/api/src/routes/invoices/authScope.test.ts` (extend the "still requires auth on the billing-settings routes" case at `:63-71`)
- Modify: `packages/shared/src/validators/currency.ts` (append `reportingTotalsQuerySchema` beside the Task 7 admin schemas)

**Interfaces:**
- Produces (`apps/api/src/services/reportingTotals.ts`):
```ts
export interface ReportingMoneyGroup { currencyCode: string; amount: string }
export interface ReportingConvertedGroup extends ReportingMoneyGroup {
  convertedAmount: string | null;
  rate: string | null;
  rateDate: string | null;
  source: 'identity' | 'ecb' | 'manual' | 'mixed' | null;
  reason?: 'missing' | 'stale';
}
export interface ReportingTotal {
  status: 'available' | 'unavailable' | 'not-needed';
  targetCurrencyCode: string;
  requestedDate: string;
  maxStalenessDays: number;
  /** OLDEST contributing leg date — the label never claims more freshness than its weakest leg. */
  rateDate: string | null;
  /** Exact, or null. NEVER a partial sum. */
  total: string | null;
  groups: ReportingConvertedGroup[];
  unavailableCurrencyCodes: string[];
}
export async function computeReportingTotal(
  groups: readonly ReportingMoneyGroup[],
  targetCurrencyCode: string,
  date: string,
): Promise<ReportingTotal>;
export async function resolvePartnerReportingCurrency(partnerId: string): Promise<string | null>;
```
- Consumes: `convertForReporting`, `DEFAULT_MAX_STALENESS_DAYS`, `ExchangeRateServiceError` from `./exchangeRateService`; `isKnownCurrency`, `minorUnitExponent` from `@breeze/shared`; `db` + `partners` for the currency read.

**Summation is exact.** `toMinorUnits` (`packages/shared/src/utils/currency.ts:65`) is `Math.round(n * 100)` on a JS `number` — fine for one line total, wrong for a portfolio rollup near `Number.MAX_SAFE_INTEGER`. `computeReportingTotal` accumulates **`bigint` minor units** parsed textually from the exact fixed-scale strings `convertForReporting` returns:
```ts
const exp = minorUnitExponent(target);            // 0 (JPY) or 2
function toMinorBigInt(amount: string, exp: number): bigint {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m) throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Amount "${amount}" is not a decimal`);
  const [, whole, frac = ''] = m;
  if (frac.replace(/0+$/, '').length > exp) {
    // convertForReporting already rounded at the target minor unit, so a
    // residue here means an unrounded value slipped in — fail loudly.
    throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Amount "${amount}" is not exact at the ${exp}-decimal minor unit`);
  }
  return BigInt(whole) * 10n ** BigInt(exp) + BigInt((frac + '0'.repeat(exp)).slice(0, exp) || '0');
}
```
and formats back with the same textual rule — never `Number`.

Routes:
```text
GET /api/v1/billing/reporting-totals?groups=USD:12300.00,EUR:4100.00&date=2026-09-03[&to=CAD]
```
Mounted on the existing root-mounted billing-settings router `apps/api/src/routes/invoices/settings.ts` (the header at `:11-15` explains why auth is per-route and never `use('*')` — the #1383 regression; follow it exactly). `billing` is **already** in `RESERVED_ROUTE_NAMESPACES` (`packages/extension-sdk/src/manifest.ts:33`), so no namespace registration is needed. Authorization is `authMiddleware` + `requireScope('organization', 'partner', 'system')` and **no domain permission** — rates are public reference facts and a timesheet viewer must not need invoice permissions. Declare a separate read-scope const; do **not** reuse the file's `scopes` (`:17`) or `writePerm` (`:18`).

- [ ] **Step 1: Write the failing service test** `apps/api/src/services/reportingTotals.test.ts` (mock `./exchangeRateService`):
  - every group already in the target currency → `status:'not-needed'`, `total` still returned as the exact native sum;
  - an empty group list → `status:'not-needed'`, `total: null`;
  - mixed groups with all legs available → `status:'available'`, `total` exactly equal to the sum of `convertedAmount`s plus native groups, `rateDate` the OLDEST contributing date;
  - **one** unavailable leg → `status:'unavailable'`, `total: null`, the failing code in `unavailableCurrencyCodes`, and every group still echoed with its own `reason` — never a partial total;
  - a JPY target rounds each conversion at the zero-decimal minor unit and totals whole yen;
  - a portfolio summing above `Number.MAX_SAFE_INTEGER` minor units (e.g. 12 groups of `'99999999999999.99'`) totals **exactly** — assert the digit string, proving the `bigint` path (a `number` accumulator fails this case);
  - `convertForReporting` is called once per DISTINCT source currency, not once per group;
  - an unknown target or an unknown group currency raises `ExchangeRateServiceError` with status 400.
- [ ] **Step 2: Write the failing route tests.** In `apps/api/src/routes/invoices/settings.test.ts` (mock `../../services/reportingTotals`):
  - `GET /billing/reporting-totals?groups=USD:12300.00,EUR:4100.00&to=CAD&date=2026-09-03` → 200 with the service result under `data`;
  - **with `to` omitted**, an ORGANIZATION-scoped token still gets 200 and `data.targetCurrencyCode` equal to the partner's currency (assert `resolvePartnerReportingCurrency` was called with `auth.partnerId`) — this is the org-scoped regression guard;
  - a partner with no resolvable currency → 409 `NO_REPORTING_CURRENCY`, never a USD substitute;
  - a malformed `groups` value (`USD`, `USD:`, `:12`, `USD:abc`, `USD:-5`) → 400;
  - more than 34 groups, or a duplicated currency in `groups` → 400;
  - an unknown code (`ZZZ:1.00`) → 400;
  - a missing `date` → 400 (**never** defaulted to today server-side);
  - a service result with `status:'unavailable'` is returned with HTTP **200** inside `data`, not an error status;
  - `date` is passed through verbatim; the client cannot widen `maxStalenessDays` (no such query param exists);
  - an `ExchangeRateServiceError` maps to its `.status`.
  In `apps/api/src/routes/invoices/authScope.test.ts`, extend the billing-settings auth case with:
```ts
    const totals = await app.request('/billing/reporting-totals?groups=USD:1.00&date=2026-09-03');
    expect(totals.status).toBe(401);
```
- [ ] **Step 3: Run both and watch them fail:**
```bash
pnpm --filter @breeze/api exec vitest run src/services/reportingTotals.test.ts src/routes/invoices/settings.test.ts src/routes/invoices/authScope.test.ts
```
- [ ] **Step 4: Add the validator** to `packages/shared/src/validators/currency.ts`, reusing `currencyCodeSchema` (never `z.string().length(3)` — defect B9), and export it from the validators barrel:
```ts
/** `groups` is `CODE:amount` pairs — the caller's own per-currency segmentation,
 *  which the server converts. Amount is a decimal STRING; a JS number would lose
 *  precision on a large portfolio. */
export const reportingTotalsQuerySchema = z.object({
  groups: z.string().min(1).max(1024),
  to: currencyCodeSchema.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
}).strict();
```
- [ ] **Step 5: Implement `reportingTotals.ts`,** then append the route to `apps/api/src/routes/invoices/settings.ts`:
```ts
// Multi-currency wave 7 (#3779): reporting-only FX totals for the optional
// "≈ approximate" line beneath per-currency dashboard totals. READ-ONLY and
// deliberately permission-free — rates are public reference facts (the table's
// RLS policy is `FOR SELECT USING (true)`), and a timesheet viewer must not
// need invoice permissions to see an approximate total. Conversion happens
// HERE, never in the browser, so there is exactly one implementation of
// reporting money math (spec §8). `to` defaults to the actor's PARTNER
// currency, resolved server-side, so organization-scoped viewers work without
// /orgs/partners/me (which is partner-scope only). An unavailable result is
// DATA, never an HTTP failure: the client then renders segmented totals only.
// Per-route middleware, never `use('*')` (#1383).
const readScopes = requireScope('organization', 'partner', 'system');

invoiceSettingsRoutes.get('/billing/reporting-totals', authMiddleware, readScopes,
  zValidator('query', reportingTotalsQuerySchema),
  async (c) => {
    const { groups, to, date } = c.req.valid('query');
    const auth = c.get('auth');
    try {
      const parsed = parseGroupsParam(groups); // throws ExchangeRateServiceError(400) on any malformed pair
      const target = to ?? (auth.partnerId ? await resolvePartnerReportingCurrency(auth.partnerId) : null);
      if (!target) {
        return c.json({ error: { code: 'NO_REPORTING_CURRENCY', message: 'No reporting currency is configured for this partner' } }, 409);
      }
      return c.json({ data: await computeReportingTotal(parsed, target, date) });
    } catch (err) { return handleServiceError(c, err); }
  });
```
`parseGroupsParam` lives in `reportingTotals.ts` and is unit-tested there. If `handleServiceError` does not already translate an error carrying `.status` + `.code`, add an explicit `catch` that does so here rather than changing `handleServiceError`.
- [ ] **Step 6: Run:**
```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/reportingTotals.test.ts \
  src/routes/invoices/settings.test.ts \
  src/routes/invoices/authScope.test.ts \
  src/extensions/reservedRouteNamespaces.test.ts
pnpm --filter @breeze/shared test
```
All green — `reservedRouteNamespaces.test.ts` must stay green because `billing` is already reserved and no new root mount was added.
- [ ] **Step 7: Commit** — `feat(api): server-side reporting totals endpoint with partner-derived target currency (#3779)`.

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
- Consumes: `contracts`, `contractLines` from `../db/schema`; `countContractDevices`, `countContractSeats` from `./contractQuantities` (`:12`, `:24`); `roundToCurrency` from `@breeze/shared` (`packages/shared/src/utils/currency.ts:158`); the **wave-3 `resolvePrice` price-book resolver** (`apps/api/src/services/catalogPricing.ts`), read-only.

**Reported MRR must agree with the invoices it predicts.** Recurring invoice generation does not bill contract-line snapshots: `apps/api/src/services/contractService.ts:870-899` calls `addContractLine`, which "resolves the catalog price in the contract's currency when `catalogItemId` is set (falling back to this stamped snapshot on a price-book gap)" — spec §6's `resolvePrice` chain. A rollup computed straight off `contract_lines.unit_price` therefore drifts from the invoice the moment a partner edits a price-book row, and the dashboard becomes a number nobody can reconcile. Resolve catalog lines through the same resolver (read-only, no writes, no side effects), reproducing the documented fallback rules exactly: org-specific override in the target currency → price-book row for the contract's stamped currency → the line's stamped `unitPrice`. **Never** convert, and never fall through to another currency's price. Resolve once per distinct `(itemId, currencyCode, orgId)` and cache within the call, alongside the existing device/seat caches.

- [ ] **Step 1: Write the failing service test** in `apps/api/src/services/contractService.test.ts`:
  - only `status = 'active'` contracts contribute;
  - a 12-month contract of `1200.00` contributes `100.00` monthly; a 3-month contract of `300.00` contributes `100.00`;
  - **two active contracts in different currencies under ONE org produce two entries**, never a sum (this is legitimate after an org-default change — history keeps its stamp);
  - per-contract monthly value is rounded in that contract's **own** currency (`roundToCurrency`), so a JPY contract yields a whole-yen string and never `100.50`;
  - an org with no active contracts is absent from the map (the caller renders `—`, not a zero in an assumed currency);
  - device/seat counts are batched: with 3 orgs × 2 per_device lines each, `countContractDevices` is called once per distinct `(orgId, siteId)`, not once per contract line;
  - the function does not route through `listContracts` and therefore does not inherit its `limit(Math.min(query.limit ?? 50, 100))` cap at `:149`;
  - **a catalog-backed line is priced through the wave-3 price book, not the line snapshot, whenever the book covers the contract's currency** — assert the resolver is consulted and its price is what lands in the total;
  - **on a price-book gap the line falls back to its stamped `unitPrice`**, exactly as billing does — assert the snapshot value is used and that no conversion and no other currency's price is ever substituted;
  - a NON-catalog line (`catalogItemId === null`) always uses its stamped `unitPrice` and never touches the resolver.
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

### Task 10: Reporting-only presentation helpers (web)

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave7`. You are adding ONE pure, dependency-free module used only by reporting/dashboard surfaces. **It performs no currency arithmetic.** The API endpoint `GET /billing/reporting-totals` (already shipped by an earlier task) converts and totals server-side and returns exact strings; this module only builds the request parameter and selects what to display from the response.

**Do NOT put these helpers in `apps/web/src/components/billing/shared/format.ts`.** That file is canonical DOCUMENT formatting shared by invoice/quote/contract editors, and a converted reporting value must never be reachable from document math (spec §2/§8). The new module lives under `apps/web/src/lib/reporting/`, and the Task-13 boundary guard asserts that no document component imports it.

**DO NOT change `sumByCurrency`** in `format.ts` (`:28-39`) — `apps/web/src/components/billing/shared/format.test.ts:35-73` pins it and five call sites depend on it. You are not editing `format.ts` at all.

**Files:**
- Create: `apps/web/src/lib/reporting/approximateTotal.ts`
- Create: `apps/web/src/lib/reporting/approximateTotal.test.ts`

**Interfaces:**
- Produces:
```ts
/** One converted group exactly as the API returns it. Amounts are exact
 *  decimal STRINGS computed server-side; this module never multiplies. */
export interface ReportingConvertedGroup {
  currencyCode: string;
  amount: string;
  convertedAmount: string | null;
  rate: string | null;
  rateDate: string | null;
  source: 'identity' | 'ecb' | 'manual' | 'mixed' | null;
  reason?: 'missing' | 'stale';
}
export interface ReportingTotalResponse {
  status: 'available' | 'unavailable' | 'not-needed';
  targetCurrencyCode: string;
  requestedDate: string;
  maxStalenessDays: number;
  rateDate: string | null;
  total: string | null;
  groups: ReportingConvertedGroup[];
  unavailableCurrencyCodes: string[];
}
export type ApproxTotalView =
  | { status: 'hidden' }
  | { status: 'available'; amount: string; currencyCode: string; rateDate: string };

/** `USD:12300.00,EUR:4100.00` — sorted, deduplicated, amounts normalized to a
 *  plain decimal string. Returns '' when there is nothing to ask about. */
export function buildGroupsParam(byCurrency: readonly { code: string; amount: string | number }[]): string;

/** The ONLY display decision: show the server's total, or show nothing. */
export function selectApproxTotal(response: ReportingTotalResponse | null): ApproxTotalView;
```

- [ ] **Step 1: Write the failing tests** in `apps/web/src/lib/reporting/approximateTotal.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  buildGroupsParam,
  selectApproxTotal,
  type ReportingTotalResponse,
} from './approximateTotal';

const base = {
  targetCurrencyCode: 'CAD',
  requestedDate: '2026-09-03',
  maxStalenessDays: 7,
  groups: [],
  unavailableCurrencyCodes: [],
} as const;

describe('buildGroupsParam', () => {
  it('sorts, deduplicates by summing nothing and normalizes amounts to strings', () => {
    expect(buildGroupsParam([{ code: 'usd', amount: 12300 }, { code: 'EUR', amount: '4100.00' }]))
      .toBe('EUR:4100.00,USD:12300');
  });
  it('is empty for an empty book', () => {
    expect(buildGroupsParam([])).toBe('');
  });
  it('drops groups with a blank code rather than sending a malformed pair', () => {
    expect(buildGroupsParam([{ code: '', amount: 1 }, { code: 'USD', amount: 2 }])).toBe('USD:2');
  });
});

describe('selectApproxTotal', () => {
  it('shows the server total verbatim — this module never multiplies', () => {
    const res: ReportingTotalResponse = {
      ...base, status: 'available', rateDate: '2026-09-01', total: '23336.00',
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'available', amount: '23336.00', currencyCode: 'CAD', rateDate: '2026-09-01',
    });
  });

  it.each([
    ['a null response (not loaded / failed)', null],
    ['not-needed (single-currency book)', { ...base, status: 'not-needed', rateDate: null, total: '540.00' }],
    ['unavailable (any missing or stale leg)', { ...base, status: 'unavailable', rateDate: null, total: null, unavailableCurrencyCodes: ['EUR'] }],
    ['available but with no total', { ...base, status: 'available', rateDate: '2026-09-01', total: null }],
    ['available but with no rate date', { ...base, status: 'available', rateDate: null, total: '1.00' }],
  ])('hides the line for %s', (_label, res) => {
    expect(selectApproxTotal(res as ReportingTotalResponse | null)).toEqual({ status: 'hidden' });
  });
});
```
- [ ] **Step 2: Run and watch it fail:**
```bash
pnpm --filter @breeze/web exec vitest run src/lib/reporting/approximateTotal.test.ts
```
- [ ] **Step 3: Implement `apps/web/src/lib/reporting/approximateTotal.ts`** with this header comment and nothing more than string handling:
```ts
/**
 * Reporting-only presentation helpers (multi-currency spec §8).
 *
 * NOT document code. Conversion and summation happen server-side in
 * `apps/api/src/services/reportingTotals.ts` via `convertForReporting`; this
 * module builds the query parameter and decides whether to render the line.
 * It performs NO arithmetic, so there is no second implementation of money
 * math in the browser and no converted figure a document editor can reuse.
 *
 * Display rules that are not negotiable:
 * - a book already entirely in the target currency shows no approximate line;
 * - ANY missing, stale or incomplete leg hides the WHOLE line (the server
 *   returns status 'unavailable' and total null — a partial approximation is a
 *   dishonest number);
 * - the disclosed rate date is whatever the server reports as the OLDEST
 *   contributing leg;
 * - the authoritative per-currency segmentation above this line always stays
 *   visible, in every state.
 */
```
- [ ] **Step 4: Run** → green:
```bash
pnpm --filter @breeze/web exec vitest run src/lib/reporting/approximateTotal.test.ts
```
Also confirm `format.ts` is untouched: `git diff --stat apps/web/src/components/billing/shared/` must be empty.
- [ ] **Step 5: Commit** — `feat(web): reporting-only approximate-total selection helpers (#3779)`.

---

### Task 11: `useApproximateTotal` hook + `ApproximateMoneyLine` + `StatCard` detail slot

**Executor: claude**

Async UI state, module-wide request de-duplication, and the one component every rollup surface reuses.

**No `usePartnerCurrency` in this chain.** That hook reads `GET /orgs/partners/me`, which is `requireScope('partner')` (`apps/api/src/routes/orgs.ts:723`) — an ORGANIZATION-scoped viewer gets a 403 and the approximate line would silently vanish for exactly the users who see the most cross-currency data. The reporting-totals endpoint derives the target currency server-side and returns it as `data.targetCurrencyCode` (Task 8), so the hook needs no currency of its own. Do not add a client-side default; there is no USD fallback anywhere in this chain.

**Files:**
- Create: `apps/web/src/lib/useApproximateTotal.ts`
- Create: `apps/web/src/lib/__tests__/useApproximateTotal.test.tsx`
- Create: `apps/web/src/components/billing/shared/ApproximateMoneyLine.tsx`
- Create: `apps/web/src/components/billing/shared/ApproximateMoneyLine.test.tsx`
- Modify: `apps/web/src/components/billing/shared/StatCard.tsx` (props interface `:3-21`, render `:39-45`)
- Modify: `apps/web/src/components/billing/shared/StatCard.test.tsx`

**Interfaces:**
- Produces:
```ts
// useApproximateTotal.ts
export interface ApproximateTotalState {
  response: ReportingTotalResponse | null;
  loading: boolean;
  failed: boolean;
}
export function useApproximateTotal(
  byCurrency: readonly { code: string; amount: string | number }[],
  date?: string,
): ApproximateTotalState;
export function resetApproximateTotalCache(): void;
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
- Consumes: `fetchWithAuth` from `../stores/auth`; `buildGroupsParam`, `selectApproxTotal`, `type ReportingTotalResponse` from `@/lib/reporting/approximateTotal`; `formatMoney` from `@/components/billing/shared/format`; `useTranslation('common')`.

- [ ] **Step 1: Write the failing hook test** `apps/web/src/lib/__tests__/useApproximateTotal.test.tsx`:
  - it requests `GET /billing/reporting-totals?groups=<buildGroupsParam output>&date=<given or today UTC>` and sends **no `to` parameter** — the server derives the target;
  - it does not fetch at all for an empty book;
  - it never sends a currency the caller did not provide, and never substitutes `'USD'` anywhere;
  - two components mounting with the same key share ONE in-flight request (assert `fetchWithAuth` called once);
  - a 403/409/500 response sets `failed`, leaves `response` null, and the caller then shows segmentation only;
  - a `409 NO_REPORTING_CURRENCY` body is treated as `failed`, not as an error toast — a partner with no reporting currency simply gets no approximate line;
  - only validated results are cached; a failed request is retried on the next mount;
  - `resetApproximateTotalCache()` clears it.
- [ ] **Step 2: Write the failing component test** `apps/web/src/components/billing/shared/ApproximateMoneyLine.test.tsx`:
  - renders nothing (`null`) while loading, on failure, and for a `not-needed` single-currency book — proving no existing single-currency summary strip changes;
  - renders nothing when the server returns `status:'unavailable'` — no placeholder, no partial total, no `1.0` conversion;
  - renders `≈ CA$22,940.00 approximate · rates as of 2026-08-21` (via the i18n key, with `{{amount}}` and `{{rateDate}}` interpolated) when available;
  - carries a stable `data-testid` so the page suites can assert it.
- [ ] **Step 3: Run both and watch them fail:**
```bash
pnpm --filter @breeze/web exec vitest run \
  src/lib/__tests__/useApproximateTotal.test.tsx \
  src/components/billing/shared/ApproximateMoneyLine.test.tsx
```
- [ ] **Step 4: Implement `useApproximateTotal.ts`** — a module-level `Map<string, ReportingTotalResponse>` cache keyed by `${date}|${groupsParam}`, a module-level in-flight `Map<string, Promise<...>>` for de-duplication, and a `useEffect` that skips the fetch entirely for an empty `groupsParam`. Responses are per-viewer (the target currency comes from the caller's own partner), so the cache **is** reset on logout — wire `resetApproximateTotalCache` into the same place the auth store clears other caches, and export it for tests.
- [ ] **Step 5: Implement `ApproximateMoneyLine.tsx`:**
```tsx
/**
 * The optional "≈ X <partner currency>" companion line (multi-currency spec §8).
 * It NEVER replaces the authoritative per-currency segmentation above it, and it
 * renders nothing at all when a single leg is missing or stale — an approximate
 * total that silently drops a currency is worse than no total. All conversion
 * and summation happened on the server; this component only formats.
 */
export function ApproximateMoneyLine({ byCurrency, date, testId }: {
  byCurrency: readonly { code: string; amount: string | number }[];
  date?: string;
  testId?: string;
}) {
  const { t } = useTranslation('common');
  const { response, loading, failed } = useApproximateTotal(byCurrency, date);
  if (loading || failed) return null;
  const view = selectApproxTotal(response);
  if (view.status !== 'available') return null;
  return (
    <div className="text-xs text-muted-foreground" data-testid={testId ?? 'approximate-money-line'}>
      {t('money.approximateTotal', {
        amount: formatMoney(view.amount, view.currencyCode),
        rateDate: view.rateDate,
      })}
    </div>
  );
}
```
- [ ] **Step 6: Add the `detail` slot to `StatCard.tsx`** — one optional prop, rendered between the value div (`:42`) and the hint (`:43`), with a test asserting a card without `detail` renders byte-identically to today.
- [ ] **Step 7: Run:**
```bash
pnpm --filter @breeze/web exec vitest run \
  src/lib/__tests__/useApproximateTotal.test.tsx \
  src/components/billing/shared/ApproximateMoneyLine.test.tsx \
  src/components/billing/shared/StatCard.test.tsx
```
- [ ] **Step 8: Commit** — `feat(web): approximate-total hook, approximate money line and StatCard detail slot (#3779)`.

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
  - `QuotesPage.tsx` — same on the out-for-signature card at `:398-402`, `testId="quotes-signature-approx"`;
  - `ContractsList.tsx` — same on the MRR card at `:353-359`, `testId="contracts-mrr-approx"`;
  - `TicketTimeBilling.tsx` — one line under the labor amounts row (`:148-150`, `testId="ticket-labor-approx"`) and one under the parts row (`:154-156`, `testId="ticket-parts-approx"`), each fed by that row's own `CurrencyAmount[]` mapped to `{ code, amount }`;
  - `TimesheetPage.tsx` — one line under the footer chips at `:594-606`, `testId="timesheet-total-approx"`, passing `date` = the earlier of today (UTC) and the selected week's end date, since a timesheet is historical.
- [ ] **Step 6: Prove EVERY rollup, not just the new dashboard.** Task 12 touches six surfaces; asserting only the one with a brand-new test file leaves five untested against the failure modes that matter. Add a **parameterized** case set — one table driving all six — to the surface suites (`PartnerDashboard.test.tsx`, `InvoicesPage.test.tsx`, `QuotesPage.test.tsx`, `ContractsList.search-sort.test.tsx`, `TicketTimeBilling.test.tsx`, `TimesheetPage.test.tsx`), each surface identified by the `testId` it passes to `ApproximateMoneyLine`:
```ts
const SURFACES = [
  { name: 'partner dashboard MRR', testId: 'partner-dashboard-mrr-approx', render: renderPartnerDashboard },
  { name: 'invoices outstanding',  testId: 'invoices-outstanding-approx',  render: renderInvoicesPage },
  { name: 'quotes out for signature', testId: 'quotes-signature-approx',   render: renderQuotesPage },
  { name: 'contracts MRR',         testId: 'contracts-mrr-approx',         render: renderContractsList },
  { name: 'ticket labor',          testId: 'ticket-labor-approx',          render: renderTicketTimeBilling },
  { name: 'ticket parts',          testId: 'ticket-parts-approx',          render: renderTicketTimeBilling },
  { name: 'timesheet footer',      testId: 'timesheet-total-approx',       render: renderTimesheetPage },
];
```
For each surface assert all five states (stub `/billing/reporting-totals`):
  1. **mixed-currency book, rates available** → the segmented total renders unchanged AND the approximate line renders with its amount and rate date;
  2. **single-currency book** (`status:'not-needed'`) → no approximate line, and the shipped summary string is byte-identical to today;
  3. **a stale leg** (`status:'unavailable'`, `reason:'stale'`) → segmentation only, no approximate line;
  4. **an uncovered pair** (`status:'unavailable'`, `reason:'missing'`) → segmentation only, and assert the rendered text contains **neither** a `1.0`-converted figure nor the target currency symbol against a foreign group — the no-silent-1:1 guard;
  5. **endpoint failure** (500) → segmentation unchanged, no approximate line, no error toast.
  Where a surface's suite has no render helper yet, add the smallest one that mounts the component with stubbed data; do not restructure the existing tests.
- [ ] **Step 7: Run the affected web suites:**
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
- [ ] **Step 8: Commit** — `feat(web): per-currency MRR and approximate reporting totals across every money rollup (#3779)`.

---

### Task 13: Document-boundary guard (deny-by-default)

**Executor: claude**

The architectural invariant of this entire wave, turned into a test that fails if a future change imports FX into document math.

**A hand-maintained denylist is not a guard.** An earlier draft of this plan enumerated ~18 "protected files" and missed live document/payment writers — `apps/api/src/services/quoteToContract.ts`, `apps/api/src/services/stripeSettle.ts`, `apps/api/src/services/quoteToPax8Order.ts`, `apps/api/src/services/quoteOrderService.ts`, `apps/api/src/services/stripeWebhook.ts`, `apps/api/src/services/contractRenewal.ts`, `apps/api/src/services/quotePay.ts` — and it named `apps/api/src/services/depositMath.ts`, **which does not exist** (the real implementations are `packages/shared/src/utils/depositMath.ts` and `apps/portal/src/lib/invoiceDeposit.ts`). Invert it: **every production file is denied, and only an explicit allowlist may import FX.**

**Files:**
- Create: `apps/api/src/services/exchangeRateBoundary.test.ts`

**Interfaces:**
- Consumes: `node:fs` (`readdirSync`, `readFileSync`), `node:path` — a static source scan, the same technique as `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts`. No runtime imports of the modules under test.

- [ ] **Step 1: Write the test.** Scan every `.ts`/`.tsx` file under `apps/api/src`, `apps/web/src`, `apps/portal/src`, `packages/shared/src` and `ee` (excluding `**/*.test.*`, `**/__tests__/**` and `node_modules`) for a reference to any FX identifier:
```ts
const FX_MODULES = [
  'exchangeRateService',
  'frankfurterClient',
  'reportingTotals',
  'lib/reporting/approximateTotal',
];
const FX_SYMBOLS = [
  'convertForReporting',
  'resolveReportingRate',
  'resolveReportingRates',
  'computeReportingTotal',
  'upsertFeedRates',
  'setManualRate',
  'exchange_rates',
  'exchangeRates',      // the Drizzle table export
];

// Deny by default: any production file importing an FX module or naming an FX
// symbol must appear here, with the reason it is allowed to. Reporting, admin
// and job surfaces only — never a document, line, payment, PDF, accounting or
// portal path. Adding a file here is a REVIEW DECISION, not a formality.
const FX_IMPORT_ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/exchangeRateService.ts': 'the FX service itself',
  'apps/api/src/services/frankfurterClient.ts': 'the feed client itself',
  'apps/api/src/services/reportingTotals.ts': 'reporting-only conversion + totalling',
  'apps/api/src/jobs/exchangeRateSync.ts': 'the daily feed job',
  'apps/api/src/routes/admin/exchangeRates.ts': 'platform-admin manual-rate API',
  'apps/api/src/routes/invoices/settings.ts': 'the read-only reporting-totals endpoint',
  'apps/api/src/db/schema/currency.ts': 'the table definition',
  'apps/api/src/index.ts': 'worker init/shutdown wiring only',
  'apps/web/src/lib/reporting/approximateTotal.ts': 'reporting-only presentation helper (no arithmetic)',
  'apps/web/src/lib/useApproximateTotal.ts': 'reporting-only hook',
  'apps/web/src/components/billing/shared/ApproximateMoneyLine.tsx': 'the approximate line component',
};
```
  Assertions:
  1. every file referencing an FX module or symbol is in the allowlist — the failure message names the offending file, the matched token and this rationale: *FX is reporting-only, is never persisted onto a document, and a converted figure entering document math would violate the central invariant (spec §2) by reinterpreting a stamped amount*;
  2. every allowlist key resolves to an existing file (a stale entry fails loudly — a silently-skipped path is a guard that guards nothing);
  3. no allowlisted path matches `invoice|quote|contract|deposit|payment|stripe|accounting|pdf|portal|timeEntry` **except** the two deliberate ones (`routes/invoices/settings.ts`, `routes/admin/exchangeRates.ts`), each named explicitly in a second small map so adding a third requires editing the assertion;
  4. `apps/web/src/components/billing/shared/format.ts` and `packages/shared/src/utils/currency.ts` contain no FX identifier — the canonical formatting/money modules stay FX-free;
  5. the scan actually walked files: assert a floor (`expect(scannedFiles.length).toBeGreaterThan(500)`), so a broken glob cannot make the guard vacuously green.
- [ ] **Step 2: Prove the test is not vacuous** with three temporary edits, each reverted after confirming a FAILURE:
```bash
# a) a document-math file
printf "import { convertForReporting } from './exchangeRateService';\n" | cat - apps/api/src/services/invoiceMath.ts > /tmp/x && mv /tmp/x apps/api/src/services/invoiceMath.ts
# b) a payment writer the old denylist missed
printf "import { convertForReporting } from './exchangeRateService';\n" | cat - apps/api/src/services/stripeSettle.ts > /tmp/x && mv /tmp/x apps/api/src/services/stripeSettle.ts
# c) a portal document path
printf "// convertForReporting\n" | cat - apps/portal/src/lib/invoiceDeposit.ts > /tmp/x && mv /tmp/x apps/portal/src/lib/invoiceDeposit.ts
pnpm --filter @breeze/api exec vitest run src/services/exchangeRateBoundary.test.ts   # MUST fail, naming all three
git checkout -- apps/api/src/services/invoiceMath.ts apps/api/src/services/stripeSettle.ts apps/portal/src/lib/invoiceDeposit.ts
```
- [ ] **Step 3: Run it clean** → passes with the reverts in place.
- [ ] **Step 4: Sweep manually and confirm every hit is a dashboard/report/admin/job surface:**
```bash
grep -rn "exchangeRateService\|convertForReporting\|resolveReportingRate\|reportingTotals\|frankfurterClient" \
  apps/api/src apps/web/src apps/portal/src packages/shared/src ee \
  | grep -v "__tests__\|\.test\."
```
- [ ] **Step 5: Commit** — `test(api): deny-by-default guard that FX never enters document math (#3779)`.

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
# Same runner regex as Task 1 — a bare `tail -5` shows `optional/` and README.md.
ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -5
# → 2026-09-03-exchange-rates.sql must be the last line
pnpm db:check-drift                        # no drift
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
```
Then prove idempotency by **executing** the file twice against the disposable test database and diffing the catalog, rather than asserting it by inspection. `DROP POLICY … / CREATE POLICY` is not a literal no-op — it drops and recreates an object — so the success criterion is an **equivalent final catalog state**, not an unchanged one:
```bash
# `docker exec` connects over the container's local socket, which the postgres
# image trusts — no credential belongs in this command.
PGC=$(docker ps --filter name=breeze-postgres-test -q)
PSQL="docker exec -i $PGC psql -U breeze -d breeze_test -v ON_ERROR_STOP=1 -At"
snapshot() { $PSQL -c "SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.oid='exchange_rates'::regclass;
  SELECT polname, polcmd, pg_get_expr(polqual,polrelid), pg_get_expr(polwithcheck,polrelid) FROM pg_policy WHERE polrelid='exchange_rates'::regclass ORDER BY polname;
  SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='exchange_rates'::regclass ORDER BY conname;
  SELECT indexname, indexdef FROM pg_indexes WHERE tablename='exchange_rates' ORDER BY indexname;"; }
$PSQL -f - < apps/api/migrations/2026-09-03-exchange-rates.sql && snapshot > /tmp/mig1.txt
$PSQL -f - < apps/api/migrations/2026-09-03-exchange-rates.sql && snapshot > /tmp/mig2.txt
diff /tmp/mig1.txt /tmp/mig2.txt   # must be empty; the second run must also raise no error
```
- [ ] **Step 5: The whole integration config** — `pnpm --filter @breeze/api test:integration` (see the `integration_suite_needs_fsync_off_tmpfs_locally` note if it looks hung; it isn't).
- [ ] **Step 6: Manual RLS forgery check** as the unprivileged role, per CLAUDE.md — **against the DISPOSABLE test database, never the dev one**. `breeze-postgres` / `breeze` is the developer's working database; a forgery probe that unexpectedly SUCCEEDS would write a row into it. The isolated stack is `breeze-postgres-test` / `breeze_test` (`docker-compose.test.yml:15-20`, container name overridable via `BREEZE_TEST_PG_CONTAINER`). No `-it` — this must run non-interactively:
```bash
# `docker exec` uses the container's local socket (trusted by the postgres
# image), so no credential appears in these commands.
PGC=$(docker ps --filter name=breeze-postgres-test -q)
# 1. tenant/app role CAN read (public reference data)
docker exec -i "$PGC" \
  psql -U breeze_app -d breeze_test -At -c "select count(*) from exchange_rates;"
# 2. tenant/app role CANNOT write
docker exec -i "$PGC" \
  psql -U breeze_app -d breeze_test -v ON_ERROR_STOP=1 -At \
  -c "insert into exchange_rates (rate_date, base_code, quote_code, rate, source) values ('2026-09-03','EUR','USD',1.1,'manual');"
```
(1) must succeed; (2) must fail with `new row violates row-level security policy`. Repeat (2) as an `UPDATE` and a `DELETE`. If any write succeeds, STOP — the policy is wrong; do not proceed to the PR.
- [ ] **Step 7: Confirm the two owner-fixed invariants by grep**, not by memory:
```bash
grep -rn "convertForReporting\|resolveReportingRate\|reportingTotals" apps/api/src/services | grep -v exchangeRate | grep -v "\.test\."
grep -rn "exchange_rate\|exchangeRate" apps/api/migrations | grep -v 2026-09-03-exchange-rates.sql
```
The first must return only dashboard/report/route consumers; the second must return nothing (no FX column was added to any document table).
- [ ] **Step 8: One independent review round** (repo policy: at most one, unless a fix itself touches a high-blast-radius surface — this wave adds a table with RLS policies and a global-mutation admin route, so re-review any fix that changes a policy, the conflict predicate, or the platform-admin gate).
- [ ] **Step 9: Push the branch and OPEN the PR** — `gh pr create --base main --head feature/3772-multi-currency/wave-3779`. Title: `feat: multi-currency wave 7 — reporting-only FX, exchange rates and dashboard segmentation (#3779)`. Body: the `exchange_rates` tenancy contract and its dedicated proof suite; the EUR-pivot decision and why a missing pair is `unavailable` rather than 1:1; the manual-precedence conflict predicate with its race proof; the 7-day staleness ceiling; the daily ECB job (cron, env flag, air-gapped path); the platform-admin-only manual-rate API and why a partner-scoped write would be cross-tenant; the real per-currency PartnerDashboard MRR replacing a hardcoded `mrr: 0` / `'USD'` label, with the one-release `mrr` compatibility field; the approximate-line rules (suppressed entirely on any missing leg, oldest rate date disclosed); the deny-by-default document-boundary guard; that **all reporting conversion happens server-side** so `convertForReporting` is the single implementation and the browser does no money math; that the reporting endpoint derives the target currency from the actor's partner so organization-scoped viewers keep their approximate line; that MRR resolves catalog lines through the wave-3 price book so the dashboard agrees with the invoices it predicts; and that `EXCHANGE_RATE_SYNC_ENABLED` / `FRANKFURTER_BASE_URL` are both documented AND compose-mapped (an unmapped var is inert — the whole air-gap story depends on it).

  **Flag one spec-wording resolution for the owner, explicitly:** §8 calls manual rates "separate rows" in the same sentence that fixes the PK as `(rate_date, base_code, quote_code)`, which makes two rows for one date/pair impossible. This wave keeps the spec's literal PK and enforces precedence with the conditional upsert, so the owner-fixed invariant — the daily job can never overwrite a manual rate — holds under both commit orderings. The consequence: deleting a manual override does not restore that day's replaced feed value (the next feed run repopulates it online; air-gapped, the lookup falls back to an earlier eligible row). Say so in the body rather than burying it. State explicitly that no document, line, payment, PDF or accounting payload gained an FX column or a converted amount. The PR targets `main` (not stacked), so Integration Tests run on the PR itself. Body ends with `Closes #3779`.
- [ ] **Step 10: STOP.** This task ends at an open PR. Do not merge — the orchestrator runs the review round and merges.

---

## Self-Review Notes

- **Spec coverage, §8 sentence by sentence.** "New global table `exchange_rates` … PK `(rate_date, base_code, quote_code)`" → Task 1 (exact columns and PK, both currency columns FK'd to `supported_currencies` as §4 requires of every program-added currency column). "added to `INTENTIONAL_UNSCOPED`, but RLS still enabled + forced — tenant-context `SELECT USING (true)`, writes only under system context; a dedicated integration test proves tenant-read-ok / tenant-write-denied / system-write-ok" → Task 1 Steps 2/7/9, with explicit `pg_class`/`pg_policy` catalog assertions (the behavioural cases alone never prove ENABLED+FORCED or the absence of an extra permissive policy). "Same treatment for `supported_currencies`" → **already shipped in wave 1 and verified**: `apps/api/migrations/2026-08-27-a-supported-currencies.sql:29-40` carries the identical policy pair, `rls-coverage.integration.test.ts:92` carries the registration, and `apps/api/src/__tests__/integration/supportedCurrencies.integration.test.ts:37,48,59` already proves tenant-read / tenant-write-denied / system-write. Wave 7 writes the `exchange_rates` twin as a **new** file rather than extending that suite, because the wave-1 suite also pins a `CURRENCY_CODES` parity property (`:26`) and a literal `toHaveLength(34)` (`:45`) that have no `exchange_rates` analogue. "Daily BullMQ job … Frankfurter with the ECB provider filter" → Tasks 2 + 6, with `providers=ECB` pinned by a URL-contract assertion. The v2 wire format was verified LIVE on 2026-08-23, not inferred: `/v2/rates` returns a flat array of `{date, base, quote, rate}` rows, and `/v2/latest` returns `{"status":404,"message":"not found"}`. "Coverage checked per currency; an uncovered pair is unavailable, never 1:1" → Task 2 (`unavailableQuoteCodes`, no synthesized row) and Task 4 (identity only when `from === to`). "Manual rates … deterministic precedence … the daily job can never overwrite them" → Task 3's `setWhere` predicate plus Task 5's both-orderings and its two forced transaction-barrier interleavings (a `Promise.all` proves nothing here — it forces no commit order). "Staleness … latest on or before … 7-day ceiling … explicitly unavailable and the UI shows segmented totals only" → Task 4 (`reason:'stale'` / `'missing'`, age in UTC days, 7 available / 8 unavailable) and Tasks 10-12 (any missing leg suppresses the whole line; segmentation always renders). "`convertForReporting(amount, from, to, date)` (cross-rate via the base) consumed ONLY by dashboards/reports" → Task 4 (the primitive), Task 8 (`reportingTotals.ts`, the only production consumer, server-side), and the Task 13 deny-by-default guard. The browser never multiplies money. "Every money rollup shows honest per-currency segmentation (extend `sumByCurrency` to PartnerDashboard MRR, ticket summaries, any revenue widget) plus an optional '≈ X <partner currency>' line labelled approximate WITH the rate date" → Task 9 (the API side of the only remaining blind sum) + Task 12 (six surfaces + eight locales). "FX never touches document math and is never persisted onto a document" → the deny-by-default Task 13 guard and the Task 14 Step 7 greps.
- **Rollup inventory is complete, not assumed.** Verified in this worktree: ticket summaries (`apps/api/src/services/timeEntryService.ts:1081-1132`, `:1162-1293`), timesheet chips (`apps/web/src/components/time/TimesheetPage.tsx:594-606`), invoices (`InvoicesPage.tsx:360,369-371`), quotes (`QuotesPage.tsx:286,296-298`), contracts (`ContractsList.tsx:240,250-252`), ticket UI (`TicketTimeBilling.tsx:33-44`) and the portal ledger are **already** per-currency — wave 7 only adds the optional approximate line to them. The single genuine blind sum left is PartnerDashboard MRR (`apps/web/src/components/partner/PartnerDashboard.tsx:353,573,584` against `apps/api/src/routes/partner.ts:181`), which is why it is its own two tasks. AI-budget surfaces (`AiUsagePage.tsx`, `AiCostIndicator.tsx`) stay `$` deliberately per spec §9 and are out of scope.
- **Deliberate decisions, flagged rather than buried.** (a) **PK stays three-column**; manual precedence is a conditional upsert, not row multiplicity — adding `source` to the PK would force every lookup to carry an `ORDER BY (source='manual') DESC` tiebreak and let two contradictory rates coexist for one date/pair. (b) **Manual rates are platform-admin only.** The table has no tenant axis and its SELECT policy is `USING (true)`, so a partner-scoped write is a cross-tenant mutation by construction; adding a partner axis would contradict §8's "global table". The spec frames manual rates as the self-host/air-gapped path, which this satisfies — on hosted, a partner cannot set a rate, and that is stated in the PR body for the owner to overrule if the product intent differs. (c) **EUR is the fixed pivot**, because the feed is ECB; the schema stays generic so a second pivot is a migration, not a rewrite. (d) `mrr` is kept as a deprecated always-zero field for one release so an already-loaded web bundle cannot break mid-deploy. (e) **Both env vars are documented AND compose-mapped** (`EXCHANGE_RATE_SYNC_ENABLED`, `FRANKFURTER_BASE_URL`), per Global Constraints — `envComposeParity.test.ts` requires documented-and-mapped or neither, and these two are the whole self-host story for this wave, so "neither" would ship them inert. (Superseded an earlier draft bullet that proposed omitting them, mirroring `STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED`.)
- **Codex review, folded in (2026-08-23).** Both blockers were real and are fixed at the root, not patched: the Frankfurter v2 endpoint/shape (verified against the live service, fixtures and parser rewritten to flat rows, and implementation corrections are now explicitly permitted beyond the URL assertion), and the boundary guard, which was a hand-maintained denylist naming a file that does not exist — it is now deny-by-default over every production file with a reasoned allowlist. Also applied: server-side conversion so `convertForReporting` is actually the reporting primitive (§8) and the web does no money math; the reporting endpoint derives the target currency from the actor's partner, so organization-scoped viewers keep their approximate line (`/orgs/partners/me` is partner-scope only, `routes/orgs.ts:723`); MRR resolves catalog lines through the wave-3 price book so the dashboard agrees with the invoices it predicts (`contractService.ts:870-899`); explicit `pg_class`/`pg_policy` catalog assertions for BOTH global tables, since `rls-coverage.integration.test.ts:845` discovers tenant tables by `org_id` and never sees them; `exchange_rates` added to the integration `CLEANUP_TABLES`; a single-statement `DISTINCT ON` leg snapshot so a cross rate can never straddle two commits; transaction-barrier precedence tests replacing a `Promise.all` that forced no ordering; `bigint` totals; `UnrecoverableError` for permanent job failures; both env vars documented AND compose-mapped (the "keep them out of `.env.example`" position was backwards — it would have shipped an inert air-gap switch); the strict-schema route test corrected to expect 400; the RLS forgery probe pointed at the disposable test database; the migration `tail` filtered by the runner's own regex and idempotency proven by executing the file twice and diffing the catalog; and per-rollup parameterized coverage for all six surfaces. **Rejected — finding 11** (store manual overrides as separate rows keyed by source): the spec fixes the PK as `(rate_date, base_code, quote_code)` in the same sentence that calls manual rates "separate rows", so source-multiplicity is impossible under the spec's own schema. The invariant the owner fixed — *the daily job can never overwrite a manual rate* — is fully enforced by the conditional upsert and proven under both forced interleavings. Consequence, stated rather than hidden: deleting a manual override does not resurrect that day's replaced feed value; the next feed run repopulates the cell (online), and on an air-gapped install the lookup falls back to an earlier eligible row. This is called out in the PR body for the owner to overrule.
- **Type consistency.** `ReportingRateResult` is defined once in `exchangeRateService.ts`; `ReportingTotal` is defined once in `reportingTotals.ts` and flows unchanged through the HTTP response (`data`) into the web's structurally-compatible `ReportingTotalResponse` (a narrower read-only view, deliberately not imported from the API package — the web imports only from `@breeze/shared`), which the web test file imports explicitly rather than relying on a name being in scope. Money crossing a boundary is always a **string** (`rate`, `amount`, `convertedAmount`, `OrgCurrencyMrr.amount`); the only `number` accumulations are inside `sumByCurrency`, which is pre-existing and unchanged. `computeReportingTotal` accumulates in `bigint` minor units, never floats, and the web accumulates nothing at all. `CurrencyAmount` (`timeEntryService.ts:1002`) uses `{ currencyCode, amount }` while `sumByCurrency` returns `{ code, amount }`; Task 12 Step 5 maps between them explicitly rather than widening either shape.
- **Known breakage, predicted with its fix.** `pnpm db:check-drift` reds if the Drizzle table and the SQL disagree on precision/scale/PK order/index name (Task 1 Step 8). `autoMigrate.test.ts` and `check-migration-naming.sh` red on a mis-sorted or infixed migration name (Task 1 Step 1). `partner.test.ts:195-231` asserts the dashboard payload shape — Task 9 Step 4 updates it by mocking `contractService` rather than extending the `db.select` mock queue, because `partner.test.ts:4-14` mocks `../db` wholesale. The web page suites are protected by `ApproximateMoneyLine` returning `null` for single-currency books, so no shipped summary string moves. `translationCoverage.test.ts` / `localeParity.test.ts` red on a missing locale or a dropped interpolation (Task 12 Step 1). `rls-coverage.integration.test.ts` will **not** red without the `INTENTIONAL_UNSCOPED` entry (auto-discovery keys on `org_id`), which is exactly why Task 1 also ships the dedicated proof suite.
- **Placeholders:** none. Every file path, line number, signature, SQL statement and command above was read from this worktree at `8066aedb0`. The one externally-dependent detail — Frankfurter's endpoint, parameters and row shape — was verified against the live v2 service on 2026-08-23 and is pinned as a frozen contract, with a re-verification step (Task 2 Step 4) that may correct the URL builder, the row parser, the fixtures and the assertions together if the provider moves again; the invariants that never change are EUR base, explicit ECB provider selection, each row's own date preserved, and coverage read from the response rather than assumed.

## Executor Split

| Executor | Tasks |
|---|---|
| **claude** | 1 (global-table RLS + tenancy registration — `AGENTS.md:203-209` keeps tenant isolation with Claude), 3, 4, 5, 6, 7, 8 (authorization/scope design — same rule), 9, 11, 12, 13, 14 |
| **codex** | 2 (isolated client against a FROZEN, live-verified external contract), 10 (one pure, arithmetic-free presentation module) |

Both codex tasks are self-contained and touch no tenancy, auth or money arithmetic. Tasks 1 and 8 were re-assigned from codex after review: a global table's RLS policy pair and a scope/permission decision are exactly the two categories `AGENTS.md` reserves.
