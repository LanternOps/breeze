# Recurring Contracts — Auto-Renew + Renewal Notices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP mark a fixed-term recurring contract as **auto-renewing**, so that when its term reaches `end_date` the contract rolls forward in place (term extended, billing uninterrupted) instead of expiring, and the MSP's own users receive an **advance renewal notice** (configurable lead time) plus a **renewal confirmation** — delivered both in-app and by email.

**Architecture:** This is a pure *extension* of the shipped Recurring Contracts engine (PRs #1411/#1442). Three columns are added to `contracts` (`auto_renew`, `renewal_term_months`, `renewal_notice_days`) and one small idempotency-ledger table (`contract_renewal_notices`, `UNIQUE(contract_id, end_date, kind)`) is added — mirroring the bulletproof `contract_billing_periods` pattern. A new **renewal pre-pass** (`runContractRenewalSweep`) runs inside the existing daily `contract-jobs` worker *before* the billing sweep: it (a) emits advance notices for contracts inside their notice window, then (b) extends `end_date` for any auto-renew contract whose next billable period would otherwise trip the existing `isExpired` gate, emits a `contract.auto_renewed` event, and sends a renewal-confirmation notice. Because the extension runs before billing in the same sweep, a renewing contract never expires and the `contract_billing_periods` ledger stays continuous. Renewal mechanics are **extend-in-place** (no new contract rows, no proration). Notices target the **MSP only** (org + partner users with access) — no customer-facing email — reusing `sendInAppNotification()` and `getEmailService().sendEmail()`.

**Tech Stack:** Hono + TypeScript (API), Drizzle ORM + PostgreSQL (RLS via `breeze_app`), BullMQ + Redis (daily sweep), Vitest (unit/RLS/integration), Zod (`@breeze/shared` validators), Astro + React islands (web).

**Spec / lineage:** Roadmap item from `docs/superpowers/plans/billing/2026-06-15-recurring-contracts.md` ("Deferred to v2 → Fixed-term + auto-renew with renewal notices"). The contracts engine, routes, web UI, and daily sweep already shipped; this plan adds only the auto-renew capability on top.

## Global Constraints

- **Node/tooling:** Prefix all `pnpm`/`vitest`/`tsx` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Fresh worktrees need `pnpm install`.
- **API unit tests:** `cd apps/api && PATH=… pnpm exec vitest run <path>` (NOT `pnpm test -- <path>`, which runs the whole suite).
- **Real-DB tests** (RLS forge, renewal-sweep integration) need a real `DATABASE_URL` and the gitignored `.env.test` symlink present in this worktree; confirm the DB role is **not** `BYPASSRLS` (`SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;` must be false) or forge/integration tests pass vacuously.
- **Real-DB test placement:** real-DB tests MUST live in `apps/api/src/__tests__/integration/*.integration.test.ts` (the BLOCKING `Integration Tests` job; runs as `breeze_app`, autoMigrate + TRUNCATE-per-test, seed fresh per `it`). The unit `test-api` job has no `DATABASE_URL`, so `it.runIf(!!process.env.DATABASE_URL)` cases skip there.
- **Migrations:** hand-written SQL under `apps/api/migrations/`, `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS` / `DO $$ … EXCEPTION`), no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration. Applied by `autoMigrate` on boot/test-setup (there is no standalone `db:migrate`). New file: `2026-06-21-contracts-auto-renew.sql` (sorts after `2026-06-15-b-recurring-contracts.sql`).
- **RLS:** the new `contract_renewal_notices` table is tenancy **shape 1** (direct `org_id`) — auto-discovered by rls-coverage, **no allowlist entry needed** — but RLS enabled+forced+policies must ship in the same migration, and a functional `breeze_app` cross-org forge test is the only thing that catches a missing axis.
- **Cascade:** add `contract_renewal_notices` to `ORG_CASCADE_DELETE_ORDER` in `tenantCascade.ts`, **localeCompare-sorted** (it sorts right before `contracts`: `contract_billing_periods` < `contract_lines` < `contract_renewal_notices` < `contracts`).
- **`@breeze/shared`** has no build step — typecheck with `pnpm --filter @breeze/shared exec tsc --noEmit`.
- **`astro check`** (not plain `tsc`) is required to catch `.astro`/web type errors.
- **Money/quantity** are fixed-2-decimal **strings** (`'150.00'`). Dates are ISO `YYYY-MM-DD` strings handled in UTC. `end_date` exclusive-of-term semantics: `isExpired` ⇔ `periodStart >= endDate`.
- **Idempotency is mandatory** — the sweep runs daily; every notice and every extension is guarded so re-runs are no-ops (`contract_renewal_notices` unique claim for notices; the `isExpired` gate naturally bounds extension).
- **Trigger the `Integration Tests` CI job** explicitly before merge (`gh workflow run ci.yml --ref <branch>`) — it is SKIPPED on `pull_request` and is the only job that runs tenantCascade + RLS forge.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-21-contracts-auto-renew.sql` — `ALTER TABLE contracts ADD COLUMN` (×3) + `CREATE TABLE contract_renewal_notices` + indexes + RLS.
- `apps/api/src/services/contractRenewal.ts` — the renewal pre-pass (`runContractRenewalSweep`), advance-notice + auto-extend logic, MSP recipient resolution, notice dispatch. Hub for this feature's impure logic.
- `apps/api/src/services/contractRenewal.integration.test.ts` — local-only service tests (extend continuity, notice idempotency, opt-out). *(Note: local-only `*.integration.test.ts` next to source runs only with a local DB; the BLOCKING job runs `src/__tests__/integration/*`.)*
- `apps/api/src/services/contractRenewalTemplate.ts` — `buildContractRenewalEmail(params)` → `{ subject, html, text }` (mirrors `buildInvoiceTemplate`).
- `apps/api/src/services/contractRenewalTemplate.test.ts` — pure template unit tests.
- `apps/api/src/__tests__/integration/contract-renewal-rls.integration.test.ts` — `breeze_app` cross-org forge for `contract_renewal_notices` (BLOCKING job).

**Modify:**
- `apps/api/src/db/schema/contracts.ts` — 3 new columns on `contracts`; new `contractRenewalNotices` table + `contractRenewalNoticeKindEnum`.
- `apps/api/src/services/contractMath.ts` — add pure `addDaysISO`, `duePeriodStartFor`, `isWithinNoticeWindow`, `extendTermPastDue`.
- `apps/api/src/services/contractMath.test.ts` — tests for the four new helpers.
- `apps/api/src/services/contractEvents.ts` — extend `ContractEvent['type']` union with `'contract.auto_renewed'` and `'contract.renewal_notice'`.
- `apps/api/src/jobs/contractWorker.ts` — run `runContractRenewalSweep()` before `runContractBillingSweep()` inside the `billing-sweep` job.
- `apps/api/src/jobs/contractWorker.test.ts` — assert renewal runs before billing (if this file exists; otherwise add an integration test).
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — forge block for `contract_renewal_notices`.
- `apps/api/src/services/tenantCascade.ts` — add `contract_renewal_notices` to `ORG_CASCADE_DELETE_ORDER`.
- `packages/shared/src/validators/contracts.ts` — `auto_renew`/`renewal_term_months`/`renewal_notice_days` on create + update schemas, with cross-field refinement.
- `packages/shared/src/validators/contracts.test.ts` — validator cases (if this file exists; else create it).
- `apps/web/src/lib/api/contracts.ts` — add the three fields to `ContractSummary`.
- `apps/web/src/components/contracts/ContractEditor.tsx` — auto-renew toggle + term + notice-days inputs (shown when auto-renew is on).
- `apps/web/src/components/contracts/ContractDetail.tsx` — read-only "Auto-renews / Renews on / Notice" panel.

**Type vocabulary (used consistently across all tasks):**
- `RenewalNoticeKind = 'advance' | 'renewed'`.
- A contract is **auto-renewing** iff `auto_renew = true AND end_date IS NOT NULL AND renewal_term_months IS NOT NULL`. (Indefinite contracts — `end_date NULL` — never renew; the flag is inert.)
- `renewal_term_months` (int > 0): months to push `end_date` forward per renewal. Stored explicitly because `end_date` moves on each renewal, so it cannot be re-derived from `end_date - start_date` after the first cycle.
- `renewal_notice_days` (int ≥ 0, default 30): lead time for the advance notice.
- `duePeriodStart`: the ISO start date of the period the billing sweep is about to bill — `advance` ⇒ `nextBillingAt`; `arrears` ⇒ `addMonthsClamped(nextBillingAt, -intervalMonths)`. The renewal extension gate is exactly `isExpired({ endDate, periodStart: duePeriodStart })`.

---

## Phase 1 — Schema, migration, RLS, cascade, validators

Ships the data layer: three new `contracts` columns, the `contract_renewal_notices` idempotency ledger (RLS-forced), cascade + forge coverage, and the shared validators. After this phase `pnpm db:check-drift` is clean and the contracts API accepts the new fields.

### Task 1.1: Drizzle schema — columns + ledger table

**Files:**
- Modify: `apps/api/src/db/schema/contracts.ts`

- [ ] **Step 1: Add the three columns to the `contracts` table builder**

In `apps/api/src/db/schema/contracts.ts`, inside the `contracts = pgTable('contracts', { … })` column object, add after `autoIssue`:

```ts
  autoRenew: boolean('auto_renew').notNull().default(false),
  renewalTermMonths: integer('renewal_term_months'),
  renewalNoticeDays: integer('renewal_notice_days'),
```

- [ ] **Step 2: Add the notice-kind enum + ledger table**

At the top of the file, next to the existing contract enums, add:

```ts
export const contractRenewalNoticeKindEnum = pgEnum('contract_renewal_notice_kind', [
  'advance', 'renewed'
]);
```

After the `contractBillingPeriods` table definition, add:

```ts
export const contractRenewalNotices = pgTable('contract_renewal_notices', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // The end_date the notice pertains to. For 'advance' this is the term about to lapse;
  // for 'renewed' this is the NEW end_date after extension. (contract_id, end_date, kind)
  // is UNIQUE — that triple is the once-per-term idempotency key.
  endDate: date('end_date').notNull(),
  kind: contractRenewalNoticeKindEnum('kind').notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_renewal_notices_uq').on(t.contractId, t.endDate, t.kind),
  index('contract_renewal_notices_org_idx').on(t.orgId)
]);
```

Confirm `pgEnum`, `date`, and `uniqueIndex` are already imported at the top of the file (they are used by the existing tables); add any that are missing.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS (no new errors from `contracts.ts`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/contracts.ts
git commit -m "feat(contracts): schema for auto-renew columns + renewal-notice ledger"
```

### Task 1.2: SQL migration

**Files:**
- Create: `apps/api/migrations/2026-06-21-contracts-auto-renew.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-21-contracts-auto-renew.sql`:

```sql
-- Contracts auto-renew + renewal notices. Idempotent throughout.
-- Sorts after 2026-06-15-b-recurring-contracts.sql (contracts table already exists).

-- 1. New columns on contracts.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS renewal_term_months INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS renewal_notice_days INTEGER;
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_renewal_term_months_positive
    CHECK (renewal_term_months IS NULL OR renewal_term_months > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_renewal_notice_days_nonneg
    CHECK (renewal_notice_days IS NULL OR renewal_notice_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Notice-kind enum + idempotency-ledger table.
DO $$ BEGIN
  CREATE TYPE contract_renewal_notice_kind AS ENUM ('advance','renewed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS contract_renewal_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  end_date DATE NOT NULL,
  kind contract_renewal_notice_kind NOT NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_renewal_notices_uq
  ON contract_renewal_notices (contract_id, end_date, kind);
CREATE INDEX IF NOT EXISTS contract_renewal_notices_org_idx
  ON contract_renewal_notices (org_id);

-- 3. RLS: shape 1 (direct org_id).
ALTER TABLE contract_renewal_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_renewal_notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_renewal_notices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_renewal_notices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_renewal_notices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_renewal_notices;
CREATE POLICY breeze_org_isolation_select ON contract_renewal_notices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_renewal_notices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_renewal_notices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_renewal_notices
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 2: Apply migration & verify no drift**

Run:
```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/contracts-web-ui-p5
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
```
Expected: **no drift** between `apps/api/src/db/schema/*` and the migrated DB. (If the migration hasn't applied yet, boot the API once against the dev DB — autoMigrate applies pending files — then re-run.)

- [ ] **Step 3: Verify migration-ordering regression test passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (confirms `2026-06-21-…` sorts after `2026-06-15-b-…`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-06-21-contracts-auto-renew.sql
git commit -m "feat(contracts): migration — auto-renew columns + renewal-notice ledger + RLS"
```

### Task 1.3: tenantCascade ordering

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`

- [ ] **Step 1: Add `contract_renewal_notices` to `ORG_CASCADE_DELETE_ORDER`**

In `apps/api/src/services/tenantCascade.ts`, add the entry to `ORG_CASCADE_DELETE_ORDER` in its localeCompare slot — immediately **before** `'contracts'` and after `'contract_lines'`:

```ts
  'contract_lines',
  'contract_renewal_notices',
  'contracts',
```

(`contract_billing_periods` < `contract_lines` < `contract_renewal_notices` < `contracts`; verify the surrounding entries match this ordering. The list-contract test in the BLOCKING `Integration Tests` job enforces the sort.)

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/tenantCascade.ts
git commit -m "feat(contracts): add contract_renewal_notices to org cascade-delete order"
```

### Task 1.4: RLS coverage forge tests

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/contract-renewal-rls.integration.test.ts`

`contract_renewal_notices` is shape 1 (direct `org_id`) and auto-discovered — **no allowlist entry needed**. Add a functional `breeze_app` cross-org forge (only this catches a missing axis).

- [ ] **Step 1: Confirm schema imports in rls-coverage test**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, confirm `contractRenewalNotices` is importable from the schema; add it to the schema import alongside `contracts` / `contractLines` if missing. (The file already imports `partners`, `organizations`, `db`, `withSystemDbAccessContext`, `withDbAccessContext`, `eq`.)

- [ ] **Step 2: Write the forge block**

Create `apps/api/src/__tests__/integration/contract-renewal-rls.integration.test.ts`. Re-seed fixtures per the repo's "never memoize the fixture" lesson (TRUNCATE-per-test wipes module-scope fixtures), and gate every real-DB case on `DATABASE_URL`:

```ts
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext, withDbAccessContext } from '../../db';
import { partners, organizations, contracts, contractRenewalNotices } from '../../db/schema';
import { eq } from 'drizzle-orm';

function orgContext(orgId: string) {
  return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seed() {
  const sfx = Math.random().toString(36).slice(2, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `RN Partner ${sfx}`, slug: `rn-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
    }).returning({ id: partners.id });
    const [orgA, orgB] = await db.insert(organizations).values([
      { partnerId: p!.id, name: 'RN Org A', slug: `rn-a-${sfx}` },
      { partnerId: p!.id, name: 'RN Org B', slug: `rn-b-${sfx}` }
    ]).returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: orgA!.id, name: 'rn', status: 'active',
      intervalMonths: 1, startDate: '2026-07-01', endDate: '2027-07-01',
      autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30
    }).returning({ id: contracts.id });
    return { partnerId: p!.id, orgAId: orgA!.id, orgBId: orgB!.id, contractId: c!.id };
  });
}

describe('contract_renewal_notices RLS forge (shape 1, org-axis)', () => {
  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK', async () => {
    const { orgAId, orgBId, contractId } = await seed();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contractRenewalNotices).values({
          contractId, orgId: orgAId, endDate: '2027-07-01', kind: 'advance'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const c = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = c?.cause?.message ?? c?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contract_renewal_notices"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's renewal notice", async () => {
    const { orgAId, orgBId, contractId } = await seed();
    let id = '';
    await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(contractRenewalNotices).values({
        contractId, orgId: orgAId, endDate: '2027-07-01', kind: 'renewed'
      }).returning({ id: contractRenewalNotices.id });
      id = row!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: contractRenewalNotices.id }).from(contractRenewalNotices).where(eq(contractRenewalNotices.id, id))
    );
    expect(visible).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Add a coverage-scan presence check (rls-coverage file)**

In `rls-coverage.integration.test.ts`, no allowlist change is required (shape 1). Just run the full coverage contract test to confirm the scanner finds RLS enabled+forced on the new table.

- [ ] **Step 4: Run forge + coverage**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" \
  pnpm exec vitest run --config vitest.config.rls-coverage.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/contract-renewal-rls.integration.test.ts
```
Expected: PASS — coverage scan finds RLS on `contract_renewal_notices`; forge rejects cross-org insert and returns empty cross-org select. If a case passes vacuously, confirm the DB role is not `BYPASSRLS` and `.env.test` symlink exists.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/contract-renewal-rls.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(contracts): RLS cross-org forge for contract_renewal_notices"
```

### Task 1.5: Shared Zod validators

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts`
- Modify/Create: `packages/shared/src/validators/contracts.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/shared/src/validators/contracts.test.ts` (create the file with the standard `import { describe, it, expect } from 'vitest'` + `import { createContractSchema, updateContractSchema } from './contracts';` header if it does not exist):

```ts
describe('auto-renew fields', () => {
  const base = {
    orgId: '11111111-1111-1111-1111-111111111111',
    name: 'Acme', billingTiming: 'advance' as const, intervalMonths: 1, startDate: '2026-07-01'
  };
  it('accepts a fixed-term auto-renew contract', () => {
    const r = createContractSchema.safeParse({
      ...base, endDate: '2027-07-01', autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30
    });
    expect(r.success).toBe(true);
  });
  it('rejects autoRenew without an endDate (cannot renew an indefinite contract)', () => {
    const r = createContractSchema.safeParse({ ...base, autoRenew: true, renewalTermMonths: 12 });
    expect(r.success).toBe(false);
  });
  it('rejects autoRenew without a renewalTermMonths', () => {
    const r = createContractSchema.safeParse({ ...base, endDate: '2027-07-01', autoRenew: true });
    expect(r.success).toBe(false);
  });
  it('rejects renewalTermMonths < 1', () => {
    const r = createContractSchema.safeParse({
      ...base, endDate: '2027-07-01', autoRenew: true, renewalTermMonths: 0
    });
    expect(r.success).toBe(false);
  });
  it('allows clearing auto-renew on update', () => {
    expect(updateContractSchema.safeParse({ autoRenew: false }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/validators/contracts.test.ts`
Expected: FAIL (new fields not yet on the schema).

- [ ] **Step 3: Add the fields + refinement**

In `packages/shared/src/validators/contracts.ts`, add to the `createContractSchema` object (before the closing `})`):

```ts
  autoRenew: z.boolean().optional(),
  renewalTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
```

Then add a `.refine` after the existing `endDate` refinement:

```ts
.refine(
  (c) => !c.autoRenew || (c.endDate != null && c.renewalTermMonths != null),
  { message: 'auto-renew requires both endDate and renewalTermMonths', path: ['autoRenew'] }
)
```

Add the same three optional fields to `updateContractSchema`:

```ts
  autoRenew: z.boolean().optional(),
  renewalTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  renewalNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
```

> Note: `updateContractSchema` is a bare object (no cross-field refine today). A partial update can set `autoRenew:true` without re-sending `endDate`; the **service** (Task 3.4 / existing `updateContract`) must re-validate the post-merge invariant against the persisted row. Add that guard where `updateContract` applies the patch: after merging, if the resulting row has `auto_renew = true` then `end_date` and `renewal_term_months` must both be non-null, else throw `ContractServiceError('auto-renew requires an end date and renewal term', 400)`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/validators/contracts.test.ts`
Expected: PASS.
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts
git commit -m "feat(contracts): validators for auto-renew fields (TDD)"
```

---

## Phase 2 — Pure renewal math (TDD)

Four pure, DB-free helpers on `contractMath.ts`. Fast unit tests, no fixtures.

### Task 2.1: Date + renewal helpers

**Files:**
- Modify: `apps/api/src/services/contractMath.ts`
- Modify: `apps/api/src/services/contractMath.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/services/contractMath.test.ts`:

```ts
import { addDaysISO, duePeriodStartFor, isWithinNoticeWindow, extendTermPastDue } from './contractMath';

describe('addDaysISO', () => {
  it('adds and subtracts days across month/year boundaries (UTC)', () => {
    expect(addDaysISO('2026-07-01', -30)).toBe('2026-06-01');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29'); // leap
  });
});

describe('duePeriodStartFor', () => {
  it('advance ⇒ nextBillingAt itself', () => {
    expect(duePeriodStartFor('advance', '2027-07-01', 1)).toBe('2027-07-01');
  });
  it('arrears ⇒ nextBillingAt minus one interval', () => {
    expect(duePeriodStartFor('arrears', '2027-08-01', 1)).toBe('2027-07-01');
    expect(duePeriodStartFor('arrears', '2027-10-01', 3)).toBe('2027-07-01');
  });
});

describe('isWithinNoticeWindow', () => {
  it('true inside [endDate - noticeDays, endDate)', () => {
    expect(isWithinNoticeWindow('2026-06-15', '2026-07-01', 30)).toBe(true); // 16 days out
    expect(isWithinNoticeWindow('2026-06-01', '2026-07-01', 30)).toBe(true); // exactly at window start
  });
  it('false before the window and on/after endDate', () => {
    expect(isWithinNoticeWindow('2026-05-31', '2026-07-01', 30)).toBe(false);
    expect(isWithinNoticeWindow('2026-07-01', '2026-07-01', 30)).toBe(false);
  });
});

describe('extendTermPastDue', () => {
  it('pushes endDate forward by whole terms until the due period no longer expires', () => {
    // due period starts exactly at endDate ⇒ one 12-month roll
    expect(extendTermPastDue({ endDate: '2027-07-01', duePeriodStart: '2027-07-01', termMonths: 12 }))
      .toEqual({ newEndDate: '2028-07-01', renewed: true });
  });
  it('catches up multiple terms when the sweep was down (term < gap)', () => {
    // due period is 2 months past a 1-month term ⇒ rolls 3 times to clear it
    expect(extendTermPastDue({ endDate: '2027-07-01', duePeriodStart: '2027-09-01', termMonths: 1 }))
      .toEqual({ newEndDate: '2027-10-01', renewed: true });
  });
  it('no-op when the due period is still inside the term', () => {
    expect(extendTermPastDue({ endDate: '2027-07-01', duePeriodStart: '2027-06-01', termMonths: 12 }))
      .toEqual({ newEndDate: '2027-07-01', renewed: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/contractMath.test.ts`
Expected: FAIL (helpers not exported).

- [ ] **Step 3: Implement the helpers**

Append to `apps/api/src/services/contractMath.ts` (reuses the file's existing `addMonthsClamped`, `isExpired`, and UTC `parts`/`fmt` helpers):

```ts
import type { BillingTiming } from './contractTypes';

/** Add (or subtract) whole days to an ISO YYYY-MM-DD date, in UTC. */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** ISO start of the period the billing sweep is about to bill. */
export function duePeriodStartFor(billingTiming: BillingTiming, nextBillingAt: string, intervalMonths: number): string {
  return billingTiming === 'advance' ? nextBillingAt : addMonthsClamped(nextBillingAt, -intervalMonths);
}

/** True when asOf is in [endDate - noticeDays, endDate). */
export function isWithinNoticeWindow(asOf: string, endDate: string, noticeDays: number): boolean {
  const windowStart = addDaysISO(endDate, -noticeDays);
  return asOf >= windowStart && asOf < endDate;
}

/** Roll endDate forward by whole terms until the due period no longer trips isExpired. */
export function extendTermPastDue(input: { endDate: string; duePeriodStart: string; termMonths: number }):
  { newEndDate: string; renewed: boolean } {
  let endDate = input.endDate;
  let renewed = false;
  let guard = 0;
  while (isExpired({ endDate, periodStart: input.duePeriodStart })) {
    endDate = addMonthsClamped(endDate, input.termMonths);
    renewed = true;
    if (++guard > 100000) break; // runaway guard (mirrors periodIndexFor)
  }
  return { newEndDate: endDate, renewed };
}
```

> If `contractMath.ts` already imports from `./contractTypes`, merge the `BillingTiming` import into the existing import line rather than adding a duplicate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/contractMath.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractMath.ts apps/api/src/services/contractMath.test.ts
git commit -m "feat(contracts): pure renewal/date math helpers (TDD)"
```

---

## Phase 3 — Renewal service, email template, events

The core. A renewal pre-pass that emits advance notices and extends terms in place, idempotent via the ledger, dispatching MSP-only in-app + email notices.

### Task 3.1: Extend the contract event union

**Files:**
- Modify: `apps/api/src/services/contractEvents.ts`

- [ ] **Step 1: Add the two event types**

In `apps/api/src/services/contractEvents.ts`, change the `type` union of `ContractEvent` to include the renewal events:

```ts
  type: 'contract.activated' | 'contract.invoiced' | 'contract.paused' | 'contract.cancelled' | 'contract.expired'
      | 'contract.auto_renewed' | 'contract.renewal_notice';
```

(The bus is still an intentionally-unconsumed reserved queue — these events are emitted for the future webhook/notification worker. Delivery in this plan is direct, via Task 3.4, not via a consumer of this queue.)

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/contractEvents.ts
git commit -m "feat(contracts): add auto_renewed + renewal_notice event types"
```

### Task 3.2: Renewal email template

**Files:**
- Create: `apps/api/src/services/contractRenewalTemplate.ts`
- Create: `apps/api/src/services/contractRenewalTemplate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/services/contractRenewalTemplate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildContractRenewalEmail } from './contractRenewalTemplate';

describe('buildContractRenewalEmail', () => {
  const base = { contractName: 'Acme Managed Services', orgName: 'Acme Inc', endDate: '2027-07-01', contractUrl: 'https://app/contracts/abc' };

  it('advance notice names the contract, org, and date and has a plain-text fallback', () => {
    const out = buildContractRenewalEmail({ ...base, kind: 'advance', noticeDays: 30 });
    expect(out.subject).toMatch(/renew/i);
    expect(out.subject).toContain('Acme Managed Services');
    expect(out.html).toContain('Acme Inc');
    expect(out.html).toContain('2027-07-01');
    expect(out.text).toContain('Acme Managed Services');
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('renewed confirmation states the new term end date', () => {
    const out = buildContractRenewalEmail({ ...base, kind: 'renewed', endDate: '2028-07-01' });
    expect(out.subject).toMatch(/renewed/i);
    expect(out.html).toContain('2028-07-01');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/contractRenewalTemplate.test.ts`
Expected: FAIL ("Cannot find module './contractRenewalTemplate'").

- [ ] **Step 3: Implement the template**

Create `apps/api/src/services/contractRenewalTemplate.ts`, reusing the shared email layout helpers (open `apps/api/src/services/email.ts` and `emailLayout.ts` to confirm the exact exported names — `renderLayout` / `renderButton` / `supportFooter` per the invoice template; if a name differs, use the actual one):

```ts
import { renderLayout, renderButton } from './emailLayout';

export interface ContractRenewalEmailParams {
  kind: 'advance' | 'renewed';
  contractName: string;
  orgName: string;
  endDate: string;       // advance: term about to lapse; renewed: the new term end
  contractUrl: string;
  noticeDays?: number;   // advance only
}

export interface ContractRenewalEmail { subject: string; html: string; text: string; }

export function buildContractRenewalEmail(p: ContractRenewalEmailParams): ContractRenewalEmail {
  if (p.kind === 'advance') {
    const subject = `Contract "${p.contractName}" renews on ${p.endDate}`;
    const lead = `The contract "${p.contractName}" for ${p.orgName} is set to auto-renew on ${p.endDate}` +
      `${p.noticeDays != null ? ` (${p.noticeDays}-day notice)` : ''}. No action is needed to renew. ` +
      `To stop the renewal, turn off auto-renew before that date.`;
    const html = renderLayout({
      title: 'Upcoming contract renewal',
      body: `<p>${lead}</p>${renderButton('View contract', p.contractUrl)}`
    });
    const text = `${lead}\n\nView contract: ${p.contractUrl}`;
    return { subject, html, text };
  }
  const subject = `Contract "${p.contractName}" renewed through ${p.endDate}`;
  const lead = `The contract "${p.contractName}" for ${p.orgName} has auto-renewed. ` +
    `Its term now runs through ${p.endDate} and billing continues uninterrupted.`;
  const html = renderLayout({
    title: 'Contract renewed',
    body: `<p>${lead}</p>${renderButton('View contract', p.contractUrl)}`
  });
  const text = `${lead}\n\nView contract: ${p.contractUrl}`;
  return { subject, html, text };
}
```

> `renderLayout`/`renderButton` parameter shapes vary — match the signatures actually used by `buildInvoiceTemplate` in `email.ts`. The test only asserts on `subject`/`html`/`text` content, so adapt the layout calls to whatever the real helpers expect while keeping the asserted strings present.

- [ ] **Step 4: Run tests + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/contractRenewalTemplate.test.ts`
Expected: PASS.

```bash
git add apps/api/src/services/contractRenewalTemplate.ts apps/api/src/services/contractRenewalTemplate.test.ts
git commit -m "feat(contracts): renewal email template (advance + renewed)"
```

### Task 3.3: Renewal service — sweep, extend, notices

**Files:**
- Create: `apps/api/src/services/contractRenewal.ts`
- Create: `apps/api/src/services/contractRenewal.integration.test.ts` (local-only — runs with a local DB; see note in File Structure)

This service assumes it is called **inside** a system DB-access context (the worker wraps it, exactly like `generateDueInvoice`). All DB calls use the ambient context — do not open a bare pool.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/services/contractRenewal.integration.test.ts`. Seed a fixed-term auto-renew contract whose next bill lands at the term boundary, run the sweep, and assert the term extended, a `renewed` notice was logged, and a second run is a no-op:

```ts
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { partners, organizations, contracts, contractLines, contractRenewalNotices } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { runContractRenewalSweep } from './contractRenewal';

async function seedAutoRenew(opts: { nextBillingAt: string; endDate: string; noticeDays?: number }) {
  const sfx = Math.random().toString(36).slice(2, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `R ${sfx}`, slug: `r-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'ROrg', slug: `ro-${sfx}` }).returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Renew Me', status: 'active', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: opts.endDate, nextBillingAt: opts.nextBillingAt,
      autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: opts.noticeDays ?? 30
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({ contractId: c!.id, orgId: o!.id, lineType: 'flat', description: 'svc', unitPrice: '500.00' });
    return { orgId: o!.id, contractId: c!.id };
  });
}

describe('runContractRenewalSweep', () => {
  it.runIf(!!process.env.DATABASE_URL)('extends the term when the next bill would expire, logs a renewed notice, idempotent', async () => {
    // Next bill lands exactly at endDate ⇒ would expire ⇒ must renew first.
    const { contractId } = await seedAutoRenew({ nextBillingAt: '2027-07-01', endDate: '2027-07-01' });

    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-07-01T05:00:00Z'))));

    const [after] = await withSystemDbAccessContext(() =>
      db.select({ endDate: contracts.endDate, status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)));
    expect(after.endDate).toBe('2028-07-01');
    expect(after.status).toBe('active');

    const renewed = await withSystemDbAccessContext(() =>
      db.select().from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, contractId), eq(contractRenewalNotices.kind, 'renewed'))));
    expect(renewed).toHaveLength(1);

    // Second run: no further extension, no duplicate notice.
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-07-01T05:00:00Z'))));
    const [after2] = await withSystemDbAccessContext(() =>
      db.select({ endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
    expect(after2.endDate).toBe('2028-07-01');
    const renewed2 = await withSystemDbAccessContext(() =>
      db.select().from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, contractId), eq(contractRenewalNotices.kind, 'renewed'))));
    expect(renewed2).toHaveLength(1);
  });

  it.runIf(!!process.env.DATABASE_URL)('emits a single advance notice inside the window and does not extend', async () => {
    // 16 days before endDate; not yet at the billing boundary.
    const { contractId } = await seedAutoRenew({ nextBillingAt: '2027-08-01', endDate: '2027-07-15' });
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-06-29T05:00:00Z'))));
    const advance = await withSystemDbAccessContext(() =>
      db.select().from(contractRenewalNotices).where(and(eq(contractRenewalNotices.contractId, contractId), eq(contractRenewalNotices.kind, 'advance'))));
    expect(advance).toHaveLength(1);
    const [c] = await withSystemDbAccessContext(() => db.select({ endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
    expect(c.endDate).toBe('2027-07-15'); // unchanged
  });

  it.runIf(!!process.env.DATABASE_URL)('does nothing for a contract with auto_renew = false', async () => {
    const { contractId } = await seedAutoRenew({ nextBillingAt: '2027-07-01', endDate: '2027-07-01' });
    await withSystemDbAccessContext(() => db.update(contracts).set({ autoRenew: false }).where(eq(contracts.id, contractId)));
    await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(new Date('2027-07-01T05:00:00Z'))));
    const [c] = await withSystemDbAccessContext(() => db.select({ endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
    expect(c.endDate).toBe('2027-07-01'); // not extended — billing sweep will expire it normally
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/contractRenewal.integration.test.ts`
Expected: FAIL ("Cannot find module './contractRenewal'").

- [ ] **Step 3: Implement the renewal service**

Create `apps/api/src/services/contractRenewal.ts`. Resolve MSP recipients by mirroring the query in `apps/api/src/services/notificationSenders/inAppSender.ts` (active org users + active partner users with access to the org). Read that file to copy the exact join/`orgAccess` predicate.

```ts
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  contracts, contractRenewalNotices, organizations, organizationUsers, partnerUsers, users
} from '../db/schema';
import { emitContractEvent } from './contractEvents';
import { sendInAppNotification } from './notificationSenders/inAppSender';
import { getEmailService } from './email';
import { buildContractRenewalEmail } from './contractRenewalTemplate';
import { duePeriodStartFor, extendTermPastDue, isWithinNoticeWindow } from './contractMath';
import { captureException } from './sentry';

const WEB_BASE = process.env.PUBLIC_WEB_URL ?? '';

interface RenewalCandidate {
  id: string; orgId: string; partnerId: string; name: string;
  billingTiming: 'advance' | 'arrears'; intervalMonths: number;
  endDate: string | null; nextBillingAt: string | null;
  autoRenew: boolean; renewalTermMonths: number | null; renewalNoticeDays: number | null;
}

/** Resolve the MSP's notifiable users (active org users + active partner users with access). */
async function resolveMspRecipients(orgId: string, partnerId: string): Promise<{ userId: string; email: string }[]> {
  const orgUsers = await db.select({ userId: organizationUsers.userId, email: users.email })
    .from(organizationUsers).innerJoin(users, eq(organizationUsers.userId, users.id))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active')));
  const pUsers = await db.select({ userId: partnerUsers.userId, email: users.email })
    .from(partnerUsers).innerJoin(users, eq(partnerUsers.userId, users.id))
    .where(and(
      eq(partnerUsers.partnerId, partnerId), eq(users.status, 'active'),
      or(eq(partnerUsers.orgAccess, 'all'),
         and(eq(partnerUsers.orgAccess, 'selected'), sql`${orgId} = ANY(${partnerUsers.orgIds})`))
    ));
  const byId = new Map<string, string>();
  for (const u of [...orgUsers, ...pUsers]) if (u.email) byId.set(u.userId, u.email);
  return [...byId.entries()].map(([userId, email]) => ({ userId, email }));
}

/** Claim a (contract, end_date, kind) notice slot. Returns true iff this caller won the claim. */
async function claimNotice(c: RenewalCandidate, endDate: string, kind: 'advance' | 'renewed'): Promise<boolean> {
  const rows = await db.insert(contractRenewalNotices)
    .values({ contractId: c.id, orgId: c.orgId, endDate, kind })
    .onConflictDoNothing({ target: [contractRenewalNotices.contractId, contractRenewalNotices.endDate, contractRenewalNotices.kind] })
    .returning({ id: contractRenewalNotices.id });
  return rows.length > 0;
}

/** Best-effort dispatch: in-app to MSP users + email to MSP users. Never throws. */
async function dispatchNotice(c: RenewalCandidate, kind: 'advance' | 'renewed', endDate: string): Promise<void> {
  try {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, c.orgId)).limit(1);
    const orgName = org?.name ?? 'your customer';
    const contractUrl = `${WEB_BASE}/contracts/${c.id}`;
    const summary = kind === 'advance'
      ? `Contract "${c.name}" for ${orgName} auto-renews on ${endDate}.`
      : `Contract "${c.name}" for ${orgName} auto-renewed through ${endDate}.`;

    await sendInAppNotification({
      alertId: `contract-renewal-${c.id}-${endDate}-${kind}`,
      alertName: kind === 'advance' ? 'Contract renewal upcoming' : 'Contract renewed',
      severity: 'info', message: summary, orgId: c.orgId, link: `/contracts/${c.id}`
    });

    const emailService = getEmailService();
    if (emailService) {
      const recipients = await resolveMspRecipients(c.orgId, c.partnerId);
      if (recipients.length > 0) {
        const tpl = buildContractRenewalEmail({
          kind, contractName: c.name, orgName, endDate, contractUrl,
          noticeDays: kind === 'advance' ? (c.renewalNoticeDays ?? undefined) : undefined
        });
        await emailService.sendEmail({ to: recipients.map((r) => r.email), subject: tpl.subject, html: tpl.html, text: tpl.text });
      }
    }
  } catch (err) {
    console.error('[ContractRenewal] notice dispatch failed', `contractId=${c.id}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Renewal pre-pass. Runs (inside a system DB context) BEFORE the billing sweep so an
 * about-to-expire auto-renew contract has its term extended before billing decides expiry.
 *  Pass A: advance notice for contracts inside their notice window.
 *  Pass B: extend the term for contracts whose next billable period would expire, then confirm.
 */
export async function runContractRenewalSweep(asOf: Date = new Date()): Promise<{ noticed: number; renewed: number }> {
  const today = asOf.toISOString().slice(0, 10);

  const candidates = await db.select({
    id: contracts.id, orgId: contracts.orgId, partnerId: contracts.partnerId, name: contracts.name,
    billingTiming: contracts.billingTiming, intervalMonths: contracts.intervalMonths,
    endDate: contracts.endDate, nextBillingAt: contracts.nextBillingAt,
    autoRenew: contracts.autoRenew, renewalTermMonths: contracts.renewalTermMonths, renewalNoticeDays: contracts.renewalNoticeDays
  }).from(contracts).where(and(eq(contracts.status, 'active' as never), eq(contracts.autoRenew, true), isNotNull(contracts.endDate)));

  let noticed = 0;
  let renewed = 0;

  for (const c of candidates as RenewalCandidate[]) {
    if (!c.endDate || c.renewalTermMonths == null) continue;

    // Pass A — advance notice (based on the CURRENT end_date).
    const noticeDays = c.renewalNoticeDays ?? 30;
    if (isWithinNoticeWindow(today, c.endDate, noticeDays)) {
      if (await claimNotice(c, c.endDate, 'advance')) {
        await dispatchNotice(c, 'advance', c.endDate);
        noticed++;
      }
    }

    // Pass B — extend if the next billable period would expire.
    if (c.nextBillingAt) {
      const duePeriodStart = duePeriodStartFor(c.billingTiming, c.nextBillingAt, c.intervalMonths);
      const { newEndDate, renewed: didRenew } = extendTermPastDue({ endDate: c.endDate, duePeriodStart, termMonths: c.renewalTermMonths });
      if (didRenew) {
        await db.update(contracts).set({ endDate: newEndDate, updatedAt: asOf }).where(eq(contracts.id, c.id));
        await emitContractEvent({ type: 'contract.auto_renewed', contractId: c.id, orgId: c.orgId, partnerId: c.partnerId });
        if (await claimNotice(c, newEndDate, 'renewed')) {
          await dispatchNotice({ ...c, endDate: newEndDate }, 'renewed', newEndDate);
        }
        renewed++;
      }
    }
  }

  return { noticed, renewed };
}
```

> Confirm against the real source while implementing: (a) `sendInAppNotification`'s exact payload field names (`alertId`/`alertName`/`severity`/`message`/`orgId`/`link`) — match `inAppSender.ts`; (b) `getEmailService()`/`sendEmail` param names — match `email.ts`; (c) `partnerUsers.orgAccess` enum values (`'all'`/`'selected'`) and the array column name (`orgIds`) — match the schema; (d) the web base-URL env var actually used elsewhere for building absolute links (search for how invoice emails build `contractUrl`/links — reuse that exact env var instead of `PUBLIC_WEB_URL` if it differs).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/contractRenewal.integration.test.ts`
Expected: PASS (extend continuity, single advance notice, opt-out no-op, idempotent re-run).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractRenewal.ts apps/api/src/services/contractRenewal.integration.test.ts
git commit -m "feat(contracts): renewal sweep — extend-in-place + MSP advance/confirmation notices (TDD)"
```

---

## Phase 4 — Worker wiring

Run the renewal pre-pass before the billing sweep in the existing daily `contract-jobs` worker.

### Task 4.1: Run renewal before billing

**Files:**
- Modify: `apps/api/src/jobs/contractWorker.ts`

- [ ] **Step 1: Import + call the renewal sweep inside the `billing-sweep` job**

In `apps/api/src/jobs/contractWorker.ts`, add the import near the other service imports:

```ts
import { runContractRenewalSweep } from '../services/contractRenewal';
```

Change the job handler in `createContractWorker` so the renewal pre-pass runs first (it manages its own system DB context internally is **not** assumed — wrap it the same way billing is wrapped):

```ts
    async (job) => {
      if (job.name === 'billing-sweep') {
        // Renewal pre-pass MUST run before billing so an about-to-expire auto-renew
        // contract has its term extended before generateDueInvoice decides expiry.
        await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep()));
        return runContractBillingSweep();
      }
      throw new Error(`Unknown contract job: ${job.name}`);
    },
```

(`runOutsideDbContext` and `withSystemDbAccessContext` are already imported in this file.)

- [ ] **Step 2: Add a worker-level integration test (renewal runs before billing)**

If `apps/api/src/jobs/contractWorker.test.ts` exists, append a case; otherwise create `apps/api/src/jobs/contractWorker.renewal.integration.test.ts`. Seed an auto-renew contract whose next bill is at the term boundary, invoke the same orchestration the job runs (call `runContractRenewalSweep(asOf)` then `runContractBillingSweep(asOf)`), and assert: the contract did **not** expire, its `end_date` advanced, and a billing period was claimed (it billed instead of expiring):

```ts
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { partners, organizations, contracts, contractLines, contractBillingPeriods } from '../db/schema';
import { eq } from 'drizzle-orm';
import { runContractRenewalSweep, /* if exported */ } from '../services/contractRenewal';
import { runContractBillingSweep } from './contractWorker';

it.runIf(!!process.env.DATABASE_URL)('renewal before billing keeps an at-boundary contract billing instead of expiring', async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const { contractId } = await withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `W ${sfx}`, slug: `w-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'WOrg', slug: `wo-${sfx}` }).returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Boundary', status: 'active', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: '2027-07-01', nextBillingAt: '2027-07-01',
      autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({ contractId: c!.id, orgId: o!.id, lineType: 'flat', description: 'svc', unitPrice: '100.00' });
    return { contractId: c!.id };
  });

  const asOf = new Date('2027-07-01T05:00:00Z');
  await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep(asOf)));
  await runContractBillingSweep(asOf);

  const [c] = await withSystemDbAccessContext(() => db.select({ status: contracts.status, endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, contractId)));
  expect(c.status).toBe('active');
  expect(c.endDate).toBe('2028-07-01');
  const periods = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId)));
  expect(periods.length).toBe(1); // billed, not expired
});
```

- [ ] **Step 3: Run + typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/jobs/contractWorker.renewal.integration.test.ts`
Expected: PASS.
Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/contractWorker.ts apps/api/src/jobs/contractWorker.renewal.integration.test.ts
git commit -m "feat(contracts): run renewal pre-pass before the daily billing sweep"
```

---

## Phase 5 — Web UI (extend the shipped editor + detail)

The contracts web UI already exists (`ContractsList`/`ContractEditor`/`ContractDetail`/`ContractWorkspace`, `/contracts` route). This phase only surfaces the new fields. Mutations already flow through `runAction`; `ContractEditor.tsx`/`ContractDetail.tsx` are already in the `no-silent-mutations` `TARGET_GLOBS`, so no test-allowlist change is needed.

### Task 5.1: API client types

**Files:**
- Modify: `apps/web/src/lib/api/contracts.ts`

- [ ] **Step 1: Add the three fields to `ContractSummary`**

In `apps/web/src/lib/api/contracts.ts`, add to the `ContractSummary` interface (after `autoIssue`):

```ts
  autoRenew: boolean;
  renewalTermMonths: number | null;
  renewalNoticeDays: number | null;
```

The create/update wrappers already take `body: unknown`, so no signature change is needed — the editor sends the new fields in its payload object.

- [ ] **Step 2: Typecheck (astro check) + commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check`
Expected: PASS.

```bash
git add apps/web/src/lib/api/contracts.ts
git commit -m "feat(contracts-web): auto-renew fields on ContractSummary type"
```

### Task 5.2: Editor — auto-renew controls

**Files:**
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx`

- [ ] **Step 1: Add form state + controls**

Open `ContractEditor.tsx` and locate the header-form state and the existing `autoIssue` toggle + `endDate` field (use them as the styling template). Add local state initialized from the loaded contract:

```tsx
const [autoRenew, setAutoRenew] = useState<boolean>(contract?.autoRenew ?? false);
const [renewalTermMonths, setRenewalTermMonths] = useState<string>(contract?.renewalTermMonths != null ? String(contract.renewalTermMonths) : '');
const [renewalNoticeDays, setRenewalNoticeDays] = useState<string>(contract?.renewalNoticeDays != null ? String(contract.renewalNoticeDays) : '30');
```

Render (next to `autoIssue`, gated on an end date being set since auto-renew requires a fixed term):

```tsx
<label className="flex items-center gap-2" data-testid="contract-auto-renew-toggle">
  <input type="checkbox" checked={autoRenew} disabled={!endDate}
    onChange={(e) => setAutoRenew(e.target.checked)} />
  <span>Auto-renew at end of term{!endDate ? ' (set an end date first)' : ''}</span>
</label>
{autoRenew && (
  <div className="mt-2 grid grid-cols-2 gap-3" data-testid="contract-renewal-fields">
    <label className="flex flex-col text-sm">
      Renewal term (months)
      <input type="number" min={1} max={120} value={renewalTermMonths}
        onChange={(e) => setRenewalTermMonths(e.target.value)}
        data-testid="contract-renewal-term" />
    </label>
    <label className="flex flex-col text-sm">
      Advance notice (days)
      <input type="number" min={0} max={365} value={renewalNoticeDays}
        onChange={(e) => setRenewalNoticeDays(e.target.value)}
        data-testid="contract-renewal-notice-days" />
    </label>
  </div>
)}
```

- [ ] **Step 2: Thread the fields into the create/update payload**

In the existing save/create handler (the one already wrapped in `runAction`), add the three fields to the request body object:

```tsx
  autoRenew,
  renewalTermMonths: autoRenew ? Number(renewalTermMonths) : null,
  renewalNoticeDays: autoRenew ? (renewalNoticeDays === '' ? null : Number(renewalNoticeDays)) : null,
```

Match the existing payload's null/number convention (the create form already sends `endDate || null`). Do **not** send `undefined` for these — send explicit `null` when auto-renew is off, mirroring the billing UI↔Zod money/null lesson. When `autoRenew` is true the client should also block submit if `renewalTermMonths` is empty (the server enforces it too via the validator refinement, but a pre-check gives a cleaner toast).

- [ ] **Step 3: Verify build + commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check`
Expected: PASS.
Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (no new bare mutations).

```bash
git add apps/web/src/components/contracts/ContractEditor.tsx
git commit -m "feat(contracts-web): auto-renew toggle + term/notice inputs in editor"
```

### Task 5.3: Detail — read-only renewal panel

**Files:**
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx`

- [ ] **Step 1: Render renewal status**

In `ContractDetail.tsx`, in the read-only header block (next to where `endDate`/`autoIssue` are shown), add:

```tsx
<div data-testid="contract-renewal-status" className="text-sm">
  {contract.autoRenew ? (
    <>
      <span className="font-medium">Auto-renews</span>
      {' '}every {contract.renewalTermMonths ?? '—'} months
      {contract.endDate ? <> · current term ends {contract.endDate}</> : null}
      {contract.renewalNoticeDays != null ? <> · {contract.renewalNoticeDays}-day notice</> : null}
    </>
  ) : (
    <span className="text-muted-foreground">Does not auto-renew</span>
  )}
</div>
```

- [ ] **Step 2: Verify build + commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check`
Expected: PASS.

```bash
git add apps/web/src/components/contracts/ContractDetail.tsx
git commit -m "feat(contracts-web): read-only renewal status on contract detail"
```

---

## Final verification

- [ ] **API typecheck:** `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit` → PASS.
- [ ] **Shared typecheck:** `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec tsc --noEmit` → PASS.
- [ ] **Web check:** `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check` → PASS.
- [ ] **Schema drift:** `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift` → no drift.
- [ ] **Unit tests (no DB):** contractMath + validators + template green via single-fork (`pnpm exec vitest run src/services/contractMath.test.ts src/services/contractRenewalTemplate.test.ts` and the shared validators) — avoids the known suite-parallel flakiness.
- [ ] **Renewal + worker integration (with DB):** `pnpm exec vitest run src/services/contractRenewal.integration.test.ts src/jobs/contractWorker.renewal.integration.test.ts` → PASS.
- [ ] **RLS forge + coverage:** `cd apps/api && PATH=… DATABASE_URL=… pnpm exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/contract-renewal-rls.integration.test.ts` → PASS (confirm DB role is not BYPASSRLS first).
- [ ] **Integration job (CI):** push the branch and trigger `Integration Tests` explicitly (`gh workflow run ci.yml --ref <branch>`) — it is SKIPPED on `pull_request` and is the only job that runs tenantCascade (the `contract_renewal_notices` cascade ordering) + RLS forge.
- [ ] **Manual breeze_app forge:** `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and attempt a cross-tenant insert into `contract_renewal_notices` — must fail with `new row violates row-level security policy`.
- [ ] **PR gate:** before `--admin` merge, hard-stop on any failing required check (Test API / Web / Agent, Integration, Type Check); ignore only Trivy/Cargo/doc-verify.

## Self-review notes (coverage map)

- **Auto-renew model (extend-in-place):** Tasks 1.1–1.2 (columns), 2.1 (`extendTermPastDue`), 3.3 (sweep extension), 4.1 (ordering before billing). ✓
- **Renewal notices (MSP in-app + email, advance + confirmation):** 3.2 (template), 3.3 (`dispatchNotice`, both kinds, both channels), idempotency via `contract_renewal_notices` (1.1/1.2 + `claimNotice`). ✓
- **Tenant safety:** RLS in 1.2, forge in 1.4, cascade in 1.3, coverage scan in 1.4. ✓
- **Configurability + invariants:** validators + cross-field refine in 1.5; service re-check of the update invariant noted in 1.5 Step 3. ✓
- **Web exposure:** 5.1–5.3. ✓

## Explicitly out of scope (deferred)

- Customer-facing renewal email (decision: MSP-only recipients). Adding it later = a second `dispatchNotice` branch resolving `organizations.billingContact` + a customer-tone template; no schema change.
- Proration on renewal (extend-in-place bills the full next period at the count taken at generation time — consistent with the v1 no-proration rule).
- Per-term repricing / line changes on renewal (would require the clone-into-new-contract model that was explicitly not chosen).
- A consumer for the `contract-events` bus (the `contract.auto_renewed` / `contract.renewal_notice` events are emitted for a future webhook/notification worker; delivery here is direct).
- Auto-renew cap (e.g. "renew at most N times") and renewal price escalation.
