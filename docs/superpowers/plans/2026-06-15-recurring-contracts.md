# Recurring Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Breeze Recurring Contracts engine — MSP-defines-a-recurring-agreement that auto-generates draft invoices on a cadence from flat / per-device / per-seat / manual lines, with a `draft → active → paused → cancelled / expired` lifecycle and guaranteed once-per-period billing.

**Architecture:** Contracts are a *producer* for the Invoice Engine (sub-project 2, merged #1383), not a second invoicing system. A daily BullMQ sweep finds contracts due to bill, resolves each contract line's quantity as-of generation time, and creates an ordinary **draft** invoice through the existing `invoiceService` (pricing via the catalog's `resolvePrice`, line totals via `computeLineTotal`). A `contract_billing_periods` ledger with a `UNIQUE (contract_id, period_start)` constraint makes double-billing physically impossible. No proration: every period bills the full amount at the count taken at generation time.

**Tech Stack:** Hono + TypeScript (API), Drizzle ORM + PostgreSQL (RLS via `breeze_app`), BullMQ + Redis (events + daily sweep), Vitest (unit/RLS/integration), Zod (`@breeze/shared` validators), Astro + React islands (web).

**Spec:** `docs/superpowers/specs/2026-06-14-recurring-contracts-design.md`. **Program frame:** `docs/superpowers/specs/2026-06-14-billing-architecture-overview.md`.

**Environment reminders (this repo):**
- Prefix all `pnpm`/`vitest`/`tsx` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- API unit tests: `cd apps/api && PATH=… pnpm exec vitest run <path>` (NOT `pnpm test -- <path>`, which runs the whole suite).
- RLS/integration tests need a real DB (`DATABASE_URL`) and the gitignored `.env.test` symlink present in this worktree; confirm the DB role is **not** `BYPASSRLS` (`SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;` must be false) or forge tests pass vacuously.
- The RLS-coverage / forge contract test runs under `vitest.config.rls-coverage.ts`. The `Integration Tests` CI job (runs on `workflow_dispatch`, SKIPPED on `pull_request`) is the only job that exercises tenantCascade + RLS forge — trigger it via `gh workflow run ci.yml --ref <branch>` before merge.
- `@breeze/shared` has no build step — typecheck with `pnpm --filter @breeze/shared exec tsc --noEmit`.
- Migrations are applied by `autoMigrate` on API boot / test setup; there is no standalone `db:migrate`.
- `astro check` (not plain `tsc`) is required to catch `.astro` type errors.

---

## File Structure

**Create:**
- `apps/api/src/db/schema/contracts.ts` — `contracts`, `contractLines`, `contractBillingPeriods` tables + 3 enums.
- `apps/api/migrations/2026-06-15-b-recurring-contracts.sql` — tables, indexes, RLS, FKs, permissions. (`-b-` infix sorts after `2026-06-15-a-invoice-engine.sql`, so `invoices` exists for the ledger FK.)
- `apps/api/src/services/contractTypes.ts` — `ContractActor`, `ContractServiceError`, status/line-type unions.
- `apps/api/src/services/contractMath.ts` — pure period/quantity/status helpers (no DB).
- `apps/api/src/services/contractMath.test.ts` — pure-logic unit tests.
- `apps/api/src/services/contractQuantities.ts` — `countContractDevices` / `countContractSeats` (impure, scoped count queries).
- `apps/api/src/services/contractEvents.ts` — `emitContractEvent` (fire-and-forget BullMQ).
- `apps/api/src/services/contractService.ts` — CRUD, lines, lifecycle, generation (hub).
- `apps/api/src/services/contractService.test.ts` — service unit + integration-tagged tests.
- `apps/api/src/routes/contracts/{index.ts,contracts.ts,lines.ts,lifecycle.ts,generate.ts}` + `*.test.ts`.
- `apps/api/src/services/aiToolsContracts.ts` — light read tools (`list_contracts`, `get_contract`).
- `apps/api/src/jobs/contractWorker.ts` — daily billing sweep + expiry.
- `apps/api/src/jobs/contractWorker.test.ts` — sweep idempotency + expiry tests.
- `packages/shared/src/validators/contracts.ts` + `contracts.test.ts` — Zod schemas.
- `apps/web/src/components/contracts/{ContractsList,ContractEditor,ContractDetail}.tsx` + `apps/web/src/pages/contracts/*` — web islands (Phase 6 enumerates exact files).

**Modify:**
- `apps/api/src/db/schema/index.ts` — add `export * from './contracts';`.
- `apps/api/src/services/invoiceService.ts` — add public `addContractLine(invoiceId, input, actor)` (sets `sourceType='contract'`).
- `packages/shared/src/validators/invoices.ts` — export `ContractLineInput` type / `contractLineSchema` (consumed by `addContractLine`).
- `apps/api/src/services/permissions.ts` — add `CONTRACTS_READ/WRITE/MANAGE` to `PERMISSIONS`.
- `apps/api/src/index.ts` — mount `contractRoutes`, init/shutdown `contractWorker`.
- `apps/api/src/services/aiTools.ts` (or the registry hub that calls `registerBillingTools`) — call `registerContractTools`.
- `apps/api/src/services/tenantCascade.ts` — add `contracts`, `contract_lines`, `contract_billing_periods` to `ORG_CASCADE_DELETE_ORDER`.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — forge tests for the 3 new tables.
- `apps/web/src/lib/runActionAllowlist.ts` — only if an aggregate handler needs an exception (default: none).

**Type vocabulary (used consistently across all tasks):**
- `ContractActor = { userId: string; partnerId: string | null; accessibleOrgIds: string[] | null }` (mirrors `InvoiceActor`).
- `ContractServiceError(message, status: 400|403|404|409|500, code?: ContractServiceErrorCode)`.
- `ContractStatus = 'draft'|'active'|'paused'|'cancelled'|'expired'`.
- `ContractLineType = 'flat'|'per_device'|'per_seat'|'manual'`.
- `BillingTiming = 'advance'|'arrears'`.
- `Period = { periodStart: string; periodEnd: string }` — both ISO `YYYY-MM-DD`, `periodEnd` exclusive.
- Money/quantity are always fixed-2-decimal **strings** (`'150.00'`), matching `numeric(12,2)`.

---

## Phase 1 — Schema, migration, RLS, permissions, forge tests

Ships the data layer: three tables with RLS enforced, the `contracts` permission set, and forge tests proving tenant isolation. After this phase `pnpm db:check-drift` is clean.

### Task 1.1: Drizzle schema for contract tables

**Files:**
- Create: `apps/api/src/db/schema/contracts.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

Create `apps/api/src/db/schema/contracts.ts`:

```ts
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, date, char,
  timestamp, pgEnum, index, uniqueIndex, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const contractStatusEnum = pgEnum('contract_status', [
  'draft', 'active', 'paused', 'cancelled', 'expired'
]);
export const contractBillingTimingEnum = pgEnum('contract_billing_timing', [
  'advance', 'arrears'
]);
export const contractLineTypeEnum = pgEnum('contract_line_type', [
  'flat', 'per_device', 'per_seat', 'manual'
]);

export const contracts = pgTable('contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  status: contractStatusEnum('status').notNull().default('draft'),
  billingTiming: contractBillingTimingEnum('billing_timing').notNull().default('advance'),
  intervalMonths: integer('interval_months').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  nextBillingAt: date('next_billing_at'),
  autoIssue: boolean('auto_issue').notNull().default(false),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  notes: text('notes'),
  terms: text('terms'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('contracts_org_status_idx').on(t.orgId, t.status),
  index('contracts_partner_status_idx').on(t.partnerId, t.status),
  // Real partial index (status='active') created in SQL; drizzle-kit only needs the column for drift.
  index('contracts_next_billing_idx').on(t.nextBillingAt)
]);

export const contractLines = pgTable('contract_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  lineType: contractLineTypeEnum('line_type').notNull(),
  description: text('description').notNull(),
  // catalog_item_id + site_id FKs created in SQL (ON DELETE SET NULL) to dodge import cycles.
  catalogItemId: uuid('catalog_item_id'),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  manualQuantity: numeric('manual_quantity', { precision: 12, scale: 2 }),
  siteId: uuid('site_id'),
  taxable: boolean('taxable').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('contract_lines_contract_sort_idx').on(t.contractId, t.sortOrder),
  index('contract_lines_org_idx').on(t.orgId)
]);

export const contractBillingPeriods = pgTable('contract_billing_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  // invoice_id FK created in SQL (ON DELETE SET NULL) to avoid coupling contract history to invoice deletion.
  invoiceId: uuid('invoice_id'),
  generatedAt: timestamp('generated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_billing_periods_contract_period_uq').on(t.contractId, t.periodStart),
  index('contract_billing_periods_org_idx').on(t.orgId)
]);
```

- [ ] **Step 2: Register the schema file**

In `apps/api/src/db/schema/index.ts`, add after the existing `export * from './invoices';` line:

```ts
export * from './contracts';
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS (no new errors from `contracts.ts`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/contracts.ts apps/api/src/db/schema/index.ts
git commit -m "feat(contracts): drizzle schema for recurring contract tables"
```

### Task 1.2: SQL migration — tables, indexes, RLS, FKs, permissions

**Files:**
- Create: `apps/api/migrations/2026-06-15-b-recurring-contracts.sql`

- [ ] **Step 1: Write the migration — enums, tables, indexes**

Create `apps/api/migrations/2026-06-15-b-recurring-contracts.sql`:

```sql
-- Recurring Contracts (billing program sub-project 3). Idempotent throughout.
-- Depends on invoices/catalog_items/sites from earlier migrations (sorts after 2026-06-15-a-invoice-engine.sql).

DO $$ BEGIN
  CREATE TYPE contract_status AS ENUM ('draft','active','paused','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contract_billing_timing AS ENUM ('advance','arrears');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contract_line_type AS ENUM ('flat','per_device','per_seat','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  status contract_status NOT NULL DEFAULT 'draft',
  billing_timing contract_billing_timing NOT NULL DEFAULT 'advance',
  interval_months INTEGER NOT NULL CHECK (interval_months > 0),
  start_date DATE NOT NULL,
  end_date DATE,
  next_billing_at DATE,
  auto_issue BOOLEAN NOT NULL DEFAULT FALSE,
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  notes TEXT,
  terms TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS contracts_org_status_idx ON contracts (org_id, status);
CREATE INDEX IF NOT EXISTS contracts_partner_status_idx ON contracts (partner_id, status);
CREATE INDEX IF NOT EXISTS contracts_next_billing_idx ON contracts (next_billing_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS contract_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  line_type contract_line_type NOT NULL,
  description TEXT NOT NULL,
  catalog_item_id UUID,
  unit_price NUMERIC(12,2) NOT NULL,
  manual_quantity NUMERIC(12,2),
  site_id UUID,
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_catalog_item_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS contract_lines_contract_sort_idx ON contract_lines (contract_id, sort_order);
CREATE INDEX IF NOT EXISTS contract_lines_org_idx ON contract_lines (org_id);

CREATE TABLE IF NOT EXISTS contract_billing_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  invoice_id UUID,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE contract_billing_periods ADD CONSTRAINT contract_billing_periods_invoice_fkey
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS contract_billing_periods_contract_period_uq
  ON contract_billing_periods (contract_id, period_start);
CREATE INDEX IF NOT EXISTS contract_billing_periods_org_idx ON contract_billing_periods (org_id);
```

- [ ] **Step 2: Append RLS — all three tables (shape 1, org-axis)**

Append to the same migration file:

```sql
-- RLS: shape 1 (direct/denormalized org_id) on all three tables.
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contracts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contracts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contracts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contracts;
CREATE POLICY breeze_org_isolation_select ON contracts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contracts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contracts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contracts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE contract_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_lines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_lines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_lines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_lines;
CREATE POLICY breeze_org_isolation_select ON contract_lines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_lines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_lines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_lines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE contract_billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_billing_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_billing_periods;
CREATE POLICY breeze_org_isolation_select ON contract_billing_periods
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_billing_periods
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_billing_periods
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_billing_periods
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 3: Append permission rows + role grant (guarded)**

Append (mirrors the invoice grant idiom — grant read/write/manage to partner-scope system roles that already hold `tickets:write`):

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'contracts' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('contracts', 'read', 'View contracts, lines, and billing-period history');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'contracts' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('contracts', 'write', 'Create/edit/delete draft contracts and lines');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'contracts' AND action = 'manage') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('contracts', 'manage', 'Activate/pause/resume/cancel contracts and generate invoices');
  END IF;
END $$;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'contracts' AND p2.action IN ('read','write','manage')
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
```

- [ ] **Step 4: Apply the migration & verify no drift**

Run (boot path applies pending migrations via autoMigrate, then check drift):
```bash
cd /Users/toddhebebrand/breeze
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
```
Expected: drift check reports **no drift** between `apps/api/src/db/schema/*` and the migrated DB. (If the migration hasn't applied, boot the API once against the dev DB — autoMigrate applies the file — then re-run `db:check-drift`.)

- [ ] **Step 5: Verify migration ordering regression test passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (confirms `2026-06-15-b-recurring-contracts.sql` sorts after `2026-06-15-a-invoice-engine.sql`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-15-b-recurring-contracts.sql
git commit -m "feat(contracts): migration — tables, RLS, FKs, permissions"
```

### Task 1.3: tenantCascade ordering

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`

- [ ] **Step 1: Add the three tables to `ORG_CASCADE_DELETE_ORDER`**

In `apps/api/src/services/tenantCascade.ts`, add these entries to the `ORG_CASCADE_DELETE_ORDER` frozen array, keeping the existing alphabetical placement (children before parents — `contract_billing_periods` and `contract_lines` both FK `contracts`, so list them before `contracts`):

```ts
  'contract_billing_periods',
  'contract_lines',
  'contracts',
```

(Place them in the array where they sort alphabetically among the existing entries; the three children/parent are independent of `invoices` ordering because `ON DELETE SET NULL` on `contract_billing_periods.invoice_id` means delete order between contracts and invoices is unconstrained.)

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/tenantCascade.ts
git commit -m "feat(contracts): add contract tables to org cascade-delete order"
```

### Task 1.4: RLS coverage forge tests

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

All three tables are shape-1 (direct `org_id`) and auto-discovered — **no allowlist entry needed**. Add functional `breeze_app` cross-org forge tests (only these catch a missing axis).

- [ ] **Step 1: Ensure imports**

At the top of the test file, confirm `contracts` and `contractLines` are imported from the schema (the file already imports `partners`, `organizations`, `db`, `withSystemDbAccessContext`, `withDbAccessContext`, `eq`). Add them to the schema import if missing.

- [ ] **Step 2: Write the forge test block**

Add a new `describe` block near the other shape-1 forge tests (mirrors the `invoices` block):

```ts
describe('contracts RLS forge (shape 1, org-axis)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);
  let partnerId = '';
  let orgAId = '';
  let orgBId = '';

  function orgContext(orgId: string) {
    return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db.insert(partners).values({
        name: `RLS Contracts Partner ${runSuffix}`, slug: `rls-contracts-${runSuffix}`,
        type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for contracts forge');
      partnerId = partner.id;
      const [orgA, orgB] = await db.insert(organizations).values([
        { partnerId: partner.id, name: 'RLS Contracts Org A', slug: `rls-ctr-a-${runSuffix}` },
        { partnerId: partner.id, name: 'RLS Contracts Org B', slug: `rls-ctr-b-${runSuffix}` }
      ]).returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for contracts forge');
      orgAId = orgA.id; orgBId = orgB.id;
    });
  }

  function draftContract(orgId: string) {
    return { partnerId, orgId, name: 'forge', status: 'draft' as const, intervalMonths: 1, startDate: '2026-07-01' };
  }

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contracts).values(draftContract(orgAId))
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contracts"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's contract", async () => {
    await ensureFixtures();
    let createdId = '';
    await withSystemDbAccessContext(async () => {
      const [c] = await db.insert(contracts).values(draftContract(orgAId)).returning({ id: contracts.id });
      createdId = c!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, createdId))
    );
    expect(visible).toHaveLength(0);
  });

  it.runIf(!!process.env.DATABASE_URL)('org B cannot INSERT a contract_line carrying org A org_id', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contractLines).values({
          contractId: createdContractForLines(), orgId: orgAId,
          lineType: 'flat', description: 'forge', unitPrice: '0'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contract_lines"/);
  });

  // helper: a contract in org A to hang line-forge attempts on (system-seeded once)
  let _lineContractId = '';
  function createdContractForLines(): string {
    return _lineContractId;
  }
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureFixtures();
    await withSystemDbAccessContext(async () => {
      const [c] = await db.insert(contracts).values(draftContract(orgAId)).returning({ id: contracts.id });
      _lineContractId = c!.id;
    });
  });
});
```

> Note: `beforeAll` here re-seeds inside the test module. Per the repo's "never memoize the fixture" lesson, the `ensureFixtures` guard (`if (partnerId) return`) is fine because setup.ts `beforeEach` TRUNCATE does not run for this `.rls-coverage` config; if a future change adds per-test truncation, drop the memo guard and seed per-test.

- [ ] **Step 3: Run the forge tests + full coverage contract test**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" \
  pnpm exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — coverage scan finds RLS on all three new shape-1 tables; forge cases reject cross-org insert and return empty cross-org select. If a case passes vacuously, confirm the DB role is not `BYPASSRLS` and `.env.test` symlink exists.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(contracts): RLS cross-org forge tests for 3 contract tables"
```

---

## Phase 2 — Pure period/quantity/status math + validators

Pure functions with zero DB access (fast unit tests) plus the shared Zod validators. TDD throughout.

### Task 2.1: Contract types module

**Files:**
- Create: `apps/api/src/services/contractTypes.ts`

- [ ] **Step 1: Write the types module**

Create `apps/api/src/services/contractTypes.ts`:

```ts
export type ContractStatus = 'draft' | 'active' | 'paused' | 'cancelled' | 'expired';
export type ContractLineType = 'flat' | 'per_device' | 'per_seat' | 'manual';
export type BillingTiming = 'advance' | 'arrears';

export interface ContractActor {
  userId: string;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
}

export interface Period {
  periodStart: string; // ISO YYYY-MM-DD (inclusive)
  periodEnd: string;   // ISO YYYY-MM-DD (exclusive)
}

export type ContractServiceErrorCode =
  | 'ORG_DENIED'
  | 'CONTRACT_NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'NO_LINES'
  | 'INVALID_STATE'
  | 'LINE_NOT_FOUND'
  | 'ALREADY_BILLED'
  | 'NOTHING_DUE';

export class ContractServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: ContractServiceErrorCode
  ) {
    super(message);
    this.name = 'ContractServiceError';
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/contractTypes.ts
git commit -m "feat(contracts): shared types — actor, period, typed error"
```

### Task 2.2: Period & schedule math

**Files:**
- Create: `apps/api/src/services/contractMath.ts`
- Test: `apps/api/src/services/contractMath.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/services/contractMath.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addMonthsClamped, computePeriod, periodIndexFor, nextBillingDate, isExpired } from './contractMath';

describe('addMonthsClamped', () => {
  it('preserves day-of-month when valid', () => {
    expect(addMonthsClamped('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonthsClamped('2026-01-15', 3)).toBe('2026-04-15');
  });
  it('clamps to last valid day on overflow', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29'); // leap year
  });
  it('rolls the year', () => {
    expect(addMonthsClamped('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonthsClamped('2026-06-01', 12)).toBe('2027-06-01');
  });
});

describe('computePeriod', () => {
  it('period 0 starts at start_date', () => {
    expect(computePeriod('2026-07-01', 1, 0)).toEqual({ periodStart: '2026-07-01', periodEnd: '2026-08-01' });
  });
  it('quarterly steps by 3 months', () => {
    expect(computePeriod('2026-01-15', 3, 1)).toEqual({ periodStart: '2026-04-15', periodEnd: '2026-07-15' });
  });
  it('annual steps by 12', () => {
    expect(computePeriod('2026-01-01', 12, 2)).toEqual({ periodStart: '2028-01-01', periodEnd: '2029-01-01' });
  });
});

describe('periodIndexFor', () => {
  it('returns the index of the period containing a date', () => {
    expect(periodIndexFor('2026-07-01', 1, '2026-07-01')).toBe(0);
    expect(periodIndexFor('2026-07-01', 1, '2026-07-20')).toBe(0);
    expect(periodIndexFor('2026-07-01', 1, '2026-08-01')).toBe(1);
    expect(periodIndexFor('2026-07-01', 1, '2026-09-15')).toBe(2);
  });
  it('clamps to 0 before the start', () => {
    expect(periodIndexFor('2026-07-01', 1, '2026-06-01')).toBe(0);
  });
});

describe('nextBillingDate', () => {
  it('advance fires at period start', () => {
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', periodIndex: 0 })).toBe('2026-07-01');
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', periodIndex: 1 })).toBe('2026-08-01');
  });
  it('arrears fires at period end', () => {
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'arrears', periodIndex: 0 })).toBe('2026-08-01');
  });
});

describe('isExpired', () => {
  it('true when period start is on/after end date', () => {
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2026-12-01' })).toBe(true);
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2027-01-01' })).toBe(true);
  });
  it('false when period start is before end date', () => {
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2026-11-01' })).toBe(false);
  });
  it('false when no end date', () => {
    expect(isExpired({ endDate: null, periodStart: '2099-01-01' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/contractMath.test.ts`
Expected: FAIL ("Cannot find module './contractMath'").

- [ ] **Step 3: Implement `contractMath.ts`**

Create `apps/api/src/services/contractMath.ts`:

```ts
import type { BillingTiming, Period } from './contractTypes';

// All dates are ISO YYYY-MM-DD strings handled in UTC to avoid TZ drift.
function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m: m, d };
}
function daysInMonth(year: number, month1: number): number {
  // month1 is 1-based; Date day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}
function fmt(y: number, m1: number, d: number): string {
  const mm = String(m1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = parts(iso);
  const zeroBased = (m - 1) + months;
  const ny = y + Math.floor(zeroBased / 12);
  const nm1 = (zeroBased % 12 + 12) % 12 + 1;
  const clampedDay = Math.min(d, daysInMonth(ny, nm1));
  return fmt(ny, nm1, clampedDay);
}

export function computePeriod(startDate: string, intervalMonths: number, periodIndex: number): Period {
  const periodStart = addMonthsClamped(startDate, intervalMonths * periodIndex);
  const periodEnd = addMonthsClamped(startDate, intervalMonths * (periodIndex + 1));
  return { periodStart, periodEnd };
}

export function periodIndexFor(startDate: string, intervalMonths: number, asOf: string): number {
  let idx = 0;
  // Walk forward until the next period start exceeds asOf. Bounded; contracts are short-lived in months.
  while (computePeriod(startDate, intervalMonths, idx + 1).periodStart <= asOf) {
    idx++;
    if (idx > 100000) break; // runaway guard
  }
  return idx;
}

export function nextBillingDate(input: {
  startDate: string;
  intervalMonths: number;
  billingTiming: BillingTiming;
  periodIndex: number;
}): string {
  const { periodStart, periodEnd } = computePeriod(input.startDate, input.intervalMonths, input.periodIndex);
  return input.billingTiming === 'advance' ? periodStart : periodEnd;
}

export function isExpired(input: { endDate: string | null; periodStart: string }): boolean {
  if (input.endDate === null) return false;
  return input.periodStart >= input.endDate;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/contractMath.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractMath.ts apps/api/src/services/contractMath.test.ts
git commit -m "feat(contracts): pure period/schedule math (TDD)"
```

### Task 2.3: Shared Zod validators

**Files:**
- Create: `packages/shared/src/validators/contracts.ts`
- Test: `packages/shared/src/validators/contracts.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (add `export * from './contracts';` if the package re-exports validators centrally — confirm the existing pattern in that file first)

- [ ] **Step 1: Write failing tests**

Create `packages/shared/src/validators/contracts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createContractSchema, contractLineInputSchema, updateContractSchema } from './contracts';

describe('createContractSchema', () => {
  it('accepts a valid monthly advance contract', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Acme MSP', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01', autoIssue: false
    });
    expect(r.success).toBe(true);
  });
  it('rejects intervalMonths < 1', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'x', billingTiming: 'advance', intervalMonths: 0, startDate: '2026-07-01'
    });
    expect(r.success).toBe(false);
  });
  it('rejects endDate before startDate', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'x', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: '2026-06-01'
    });
    expect(r.success).toBe(false);
  });
});

describe('contractLineInputSchema', () => {
  it('requires manualQuantity for manual lines', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'manual', description: 'licenses', unitPrice: '10.00', taxable: false
    }).success).toBe(false);
    expect(contractLineInputSchema.safeParse({
      lineType: 'manual', description: 'licenses', unitPrice: '10.00', taxable: false, manualQuantity: '3'
    }).success).toBe(true);
  });
  it('allows siteId only as an optional uuid on per_device lines', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'per_device', description: 'RMM', unitPrice: '15.00', taxable: true,
      siteId: '22222222-2222-2222-2222-222222222222'
    }).success).toBe(true);
  });
  it('accepts a flat line with no quantity fields', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: false
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/validators/contracts.test.ts`
Expected: FAIL ("Cannot find module './contracts'").

- [ ] **Step 3: Implement `contracts.ts` validators**

Create `packages/shared/src/validators/contracts.ts`. Reuse the `money` / `isoDate` helpers if they are exported from `./invoices`; otherwise define locally as shown:

```ts
import { z } from 'zod';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a 2-decimal money string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const contractLineInputSchema = z.object({
  lineType: z.enum(['flat', 'per_device', 'per_seat', 'manual']),
  description: z.string().min(1).max(2000),
  unitPrice: money,
  taxable: z.boolean(),
  catalogItemId: z.string().uuid().optional(),
  manualQuantity: money.optional(),
  siteId: z.string().uuid().optional(),
  sortOrder: z.number().int().min(0).optional()
}).refine(
  (l) => l.lineType !== 'manual' || l.manualQuantity !== undefined,
  { message: 'manualQuantity is required for manual lines', path: ['manualQuantity'] }
).refine(
  (l) => l.lineType === 'per_device' || l.siteId === undefined,
  { message: 'siteId is only valid on per_device lines', path: ['siteId'] }
);

export const createContractSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  billingTiming: z.enum(['advance', 'arrears']),
  intervalMonths: z.number().int().min(1).max(60),
  startDate: isoDate,
  endDate: isoDate.optional(),
  autoIssue: z.boolean().optional(),
  currencyCode: z.string().length(3).optional(),
  notes: z.string().max(5000).optional(),
  terms: z.string().max(5000).optional()
}).refine(
  (c) => c.endDate === undefined || c.endDate > c.startDate,
  { message: 'endDate must be after startDate', path: ['endDate'] }
);

export const updateContractSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  billingTiming: z.enum(['advance', 'arrears']).optional(),
  intervalMonths: z.number().int().min(1).max(60).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
  autoIssue: z.boolean().optional(),
  notes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(5000).nullable().optional()
});

export const listContractsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['draft', 'active', 'paused', 'cancelled', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional()
});

export type ContractLineInput = z.infer<typeof contractLineInputSchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/validators/contracts.test.ts`
Expected: PASS.
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(contracts): shared zod validators (TDD)"
```

---

## Phase 3 — Engine hook, quantity resolvers, events, contractService

The core. Contract generation reuses the merged invoice engine: `createManualInvoice`, a new `addContractLine`, `issueInvoice`, `sendInvoiceEmail`, plus the catalog's `resolvePrice`. Idempotency comes from the `contract_billing_periods` unique constraint.

### Task 3.1: `addContractLine` on the invoice engine

The engine reserved `source_type='contract'` for exactly this. Add one public function mirroring `addCatalogLine`'s use of the existing `insertLineAndRecompute` helper (see `invoiceService.ts:114` for the pattern).

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts`
- Test: `apps/api/src/services/invoiceService.test.ts` (append a case)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/invoiceService.test.ts` (follow the file's existing integration-tagged style — it already seeds a draft invoice via `createManualInvoice`; reuse that helper):

```ts
describe('addContractLine', () => {
  it.runIf(!!process.env.DATABASE_URL)('adds a contract-source line and recomputes totals', async () => {
    const actor = await seedActorWithDraft(); // existing test helper returning { actor, invoiceId, orgId }
    const line = await addContractLine(actor.invoiceId, {
      description: 'Managed services (flat)', quantity: '1', unitPrice: '500.00',
      taxable: false, catalogItemId: null, sourceId: null
    }, actor.actor);
    expect(line.sourceType).toBe('contract');
    expect(line.lineTotal).toBe('500.00');
    const inv = await getInvoice(actor.invoiceId, actor.actor);
    expect(inv.invoice.subtotal).toBe('500.00');
  });
});
```

> If `seedActorWithDraft` / `getInvoice` have different names in the existing test file, use the equivalents already present — the file already constructs a draft and an `InvoiceActor`. Do not invent new fixtures.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/invoiceService.test.ts -t addContractLine`
Expected: FAIL ("addContractLine is not a function").

- [ ] **Step 3: Implement `addContractLine`**

In `apps/api/src/services/invoiceService.ts`, add after `addBundleLine` (it reuses the file's existing `getOwnedInvoiceOr404`, `assertDraft`, `requireOrgAccess`, `insertLineAndRecompute`, `computeLineTotal`):

```ts
/** Add a line sourced from a recurring contract (sub-project 3). Quantity and
 *  unitPrice are pre-resolved by the contract engine; this snapshots them onto the
 *  invoice with source_type='contract'. sourceId carries the originating contract_line id. */
export async function addContractLine(
  invoiceId: string,
  input: {
    description: string;
    quantity: string;        // fixed-2-decimal string
    unitPrice: string;       // fixed-2-decimal string
    taxable: boolean;
    catalogItemId?: string | null;
    sourceId?: string | null; // contract_line id
  },
  actor: InvoiceActor
) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  return insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'contract', sourceId: input.sourceId ?? null, catalogItemId: input.catalogItemId ?? null,
    parentLineId: null, ticketId: null, description: input.description, quantity: input.quantity,
    unitPrice: input.unitPrice, costBasis: null, taxable: input.taxable, customerVisible: true,
    lineTotal: computeLineTotal(input.quantity, input.unitPrice), isUnapprovedTime: false
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts
git commit -m "feat(invoices): addContractLine — source_type='contract' line for the contract engine"
```

### Task 3.2: Quantity resolvers

**Files:**
- Create: `apps/api/src/services/contractQuantities.ts`
- Test: `apps/api/src/services/contractQuantities.test.ts`

Counting definitions (explicit, per spec): **billable device** = a row in `devices` for the org whose `status <> 'decommissioned'` (optionally narrowed to one `site_id`). **active seat** = a distinct user mapped to the org via `organization_users` whose `users.status = 'active'`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/services/contractQuantities.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations, sites, devices, users, organizationUsers } from '../db/schema';
import { countContractDevices, countContractSeats } from './contractQuantities';

describe('contract quantity resolvers', () => {
  let orgId = '';
  let siteAId = '';
  const sfx = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({ name: `QP ${sfx}`, slug: `qp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'QOrg', slug: `qo-${sfx}` }).returning({ id: organizations.id });
      orgId = o!.id;
      const [sA, sB] = await db.insert(sites).values([
        { orgId, name: 'A', slug: `a-${sfx}` }, { orgId, name: 'B', slug: `b-${sfx}` }
      ]).returning({ id: sites.id });
      siteAId = sA!.id;
      await db.insert(devices).values([
        { orgId, siteId: sA!.id, hostname: 'd1', status: 'online' },
        { orgId, siteId: sA!.id, hostname: 'd2', status: 'offline' },
        { orgId, siteId: sB!.id, hostname: 'd3', status: 'online' },
        { orgId, siteId: sB!.id, hostname: 'd4', status: 'decommissioned' } // excluded
      ]);
      const [u1, u2, u3] = await db.insert(users).values([
        { partnerId: p!.id, orgId, email: `u1-${sfx}@x.io`, name: 'U1', status: 'active' },
        { partnerId: p!.id, orgId, email: `u2-${sfx}@x.io`, name: 'U2', status: 'active' },
        { partnerId: p!.id, orgId, email: `u3-${sfx}@x.io`, name: 'U3', status: 'disabled' } // excluded
      ]).returning({ id: users.id });
      await db.insert(organizationUsers).values([
        { orgId, userId: u1!.id }, { orgId, userId: u2!.id }, { orgId, userId: u3!.id }
      ]);
    });
  });

  it.runIf(!!process.env.DATABASE_URL)('counts billable devices org-wide (excludes decommissioned)', async () => {
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null))).toBe(3);
  });
  it.runIf(!!process.env.DATABASE_URL)('counts billable devices filtered by site', async () => {
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, siteAId))).toBe(2);
  });
  it.runIf(!!process.env.DATABASE_URL)('counts active seats (excludes disabled)', async () => {
    expect(await withSystemDbAccessContext(() => countContractSeats(orgId))).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/contractQuantities.test.ts`
Expected: FAIL ("Cannot find module './contractQuantities'").

- [ ] **Step 3: Implement `contractQuantities.ts`**

Create `apps/api/src/services/contractQuantities.ts`:

```ts
import { and, eq, ne, sql, count, countDistinct } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizationUsers, users } from '../db/schema';

/** Billable device count for an org, optionally narrowed to a site. Excludes decommissioned.
 *  Must be called inside a db access context (system for the worker, request otherwise). */
export async function countContractDevices(orgId: string, siteId: string | null): Promise<number> {
  const conds = [eq(devices.orgId, orgId), ne(devices.status, 'decommissioned' as never)];
  if (siteId) conds.push(eq(devices.siteId, siteId));
  const [row] = await db.select({ n: count() }).from(devices).where(and(...conds));
  return Number(row?.n ?? 0);
}

/** Active-seat count for an org: distinct active users mapped via organization_users. */
export async function countContractSeats(orgId: string): Promise<number> {
  const [row] = await db.select({ n: countDistinct(organizationUsers.userId) })
    .from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active' as never)));
  return Number(row?.n ?? 0);
}
```

> `as never` casts match the repo's existing pattern for enum-column equality under postgres.js (see `runOverdueSweep`'s `inArray(... as never)` in `invoiceService.ts`). If `count`/`countDistinct` aren't exported by the installed drizzle version, use `sql<number>\`count(*)\`` / `sql<number>\`count(distinct ${organizationUsers.userId})\`` instead.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS (3 / 2 / 2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractQuantities.ts apps/api/src/services/contractQuantities.test.ts
git commit -m "feat(contracts): device/seat quantity resolvers (TDD)"
```

### Task 3.3: Contract event emitter

**Files:**
- Create: `apps/api/src/services/contractEvents.ts`

Mirror `invoiceEvents.ts` exactly (queue, fire-and-forget, Sentry on failure).

- [ ] **Step 1: Implement `contractEvents.ts`**

Create `apps/api/src/services/contractEvents.ts`:

```ts
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../config/redis'; // same import invoiceEvents.ts uses; confirm the path
import { captureException } from '../config/sentry';   // same as invoiceEvents.ts

export const CONTRACT_EVENTS_QUEUE = 'contract-events';

export type ContractEvent = {
  type: 'contract.activated' | 'contract.invoiced' | 'contract.paused' | 'contract.cancelled' | 'contract.expired';
  contractId: string;
  orgId: string;
  partnerId: string;
  invoiceId?: string;      // set on contract.invoiced
  actorUserId?: string;
};

let queue: Queue | null = null;
function getContractEventsQueue(): Queue {
  if (!queue) queue = new Queue(CONTRACT_EVENTS_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** Fire-and-forget. Never throws — a Redis hiccup must not roll back a billing transaction. */
export async function emitContractEvent(event: ContractEvent): Promise<void> {
  try {
    await getContractEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[ContractEvents] failed to enqueue', event.type, `contractId=${event.contractId}`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
```

> Open `invoiceEvents.ts` and copy its exact `getBullMQConnection` / `captureException` import paths and queue-construction idiom; the paths above are the names but confirm against that file so this matches the codebase 1:1.

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/contractEvents.ts
git commit -m "feat(contracts): contract.* event emitter (mirrors invoiceEvents)"
```

### Task 3.4: contractService — CRUD + lines

**Files:**
- Create: `apps/api/src/services/contractService.ts`
- Test: `apps/api/src/services/contractService.test.ts`

- [ ] **Step 1: Write failing tests (create/get/list + line add)**

Create `apps/api/src/services/contractService.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations } from '../db/schema';
import {
  createContract, getContract, listContracts, addContractLineToContract, type ContractActorT
} from './contractService';

async function seedOrg(): Promise<{ actor: ContractActorT; orgId: string }> {
  const sfx = Math.random().toString(36).slice(2, 8);
  let orgId = ''; let partnerId = '';
  await withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `CP ${sfx}`, slug: `cp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    partnerId = p!.id;
    const [o] = await db.insert(organizations).values({ partnerId, name: 'COrg', slug: `co-${sfx}` }).returning({ id: organizations.id });
    orgId = o!.id;
  });
  return { actor: { userId: '00000000-0000-0000-0000-000000000000', partnerId, accessibleOrgIds: [orgId] }, orgId };
}

describe('contractService CRUD', () => {
  it.runIf(!!process.env.DATABASE_URL)('creates a draft contract and reads it back', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Acme MSP', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    expect(c.status).toBe('draft');
    const got = await withSystemDbAccessContext(() => getContract(c.id, actor));
    expect(got.contract.name).toBe('Acme MSP');
    expect(got.lines).toHaveLength(0);
  });

  it.runIf(!!process.env.DATABASE_URL)('adds lines to a draft', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed', unitPrice: '500.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device', description: 'RMM', unitPrice: '15.00', taxable: true
    }, actor));
    const got = await withSystemDbAccessContext(() => getContract(c.id, actor));
    expect(got.lines).toHaveLength(2);
  });

  it.runIf(!!process.env.DATABASE_URL)('rejects access to another org', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId: a.orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, a.actor));
    await expect(withSystemDbAccessContext(() => getContract(c.id, b.actor))).rejects.toThrow(/not found|denied/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/contractService.test.ts`
Expected: FAIL ("Cannot find module './contractService'").

- [ ] **Step 3: Implement CRUD + lines in `contractService.ts`**

Create `apps/api/src/services/contractService.ts`:

```ts
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, contractBillingPeriods } from '../db/schema';
import { ContractServiceError, type ContractActor } from './contractTypes';
import type { ContractLineInput } from '@breeze/shared';

export type ContractActorT = ContractActor;

function requireOrgAccess(actor: ContractActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new ContractServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

async function getOwnedContractOr404(contractId: string, actor: ContractActor) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  requireOrgAccess(actor, c.orgId);
  return c;
}

function assertDraft(c: { status: string }): void {
  if (c.status !== 'draft') throw new ContractServiceError('Contract is not a draft', 409, 'NOT_A_DRAFT');
}

function assertEditable(c: { status: string }): void {
  if (c.status !== 'draft' && c.status !== 'active') {
    throw new ContractServiceError('Lines editable only on draft/active contracts', 409, 'INVALID_STATE');
  }
}

export async function createContract(input: {
  orgId: string; name: string; billingTiming: 'advance' | 'arrears'; intervalMonths: number;
  startDate: string; endDate?: string; autoIssue?: boolean; currencyCode?: string; notes?: string; terms?: string;
}, actor: ContractActor) {
  requireOrgAccess(actor, input.orgId);
  if (actor.partnerId === null) throw new ContractServiceError('Partner scope required', 403, 'ORG_DENIED');
  const [row] = await db.insert(contracts).values({
    partnerId: actor.partnerId, orgId: input.orgId, name: input.name, status: 'draft',
    billingTiming: input.billingTiming, intervalMonths: input.intervalMonths,
    startDate: input.startDate, endDate: input.endDate ?? null,
    autoIssue: input.autoIssue ?? false, currencyCode: input.currencyCode ?? 'USD',
    notes: input.notes ?? null, terms: input.terms ?? null, createdBy: actor.userId
  }).returning();
  return row!;
}

export async function getContract(contractId: string, actor: ContractActor) {
  const contract = await getOwnedContractOr404(contractId, actor);
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  const periods = await db.select().from(contractBillingPeriods)
    .where(eq(contractBillingPeriods.contractId, contractId)).orderBy(desc(contractBillingPeriods.periodStart));
  return { contract, lines, periods };
}

export async function listContracts(query: {
  orgId?: string; status?: string; limit?: number;
}, actor: ContractActor) {
  const conds = [];
  if (query.orgId) { requireOrgAccess(actor, query.orgId); conds.push(eq(contracts.orgId, query.orgId)); }
  if (query.status) conds.push(eq(contracts.status, query.status as never));
  const rows = await db.select().from(contracts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(contracts.createdAt))
    .limit(Math.min(query.limit ?? 50, 100));
  // RLS already scopes to accessible orgs; the requireOrgAccess above guards an explicit orgId filter.
  return rows;
}

export async function updateContract(contractId: string, patch: Record<string, unknown>, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  await db.update(contracts).set({ ...patch, updatedAt: new Date() }).where(eq(contracts.id, contractId));
  return getOwnedContractOr404(contractId, actor);
}

export async function deleteDraftContract(contractId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertDraft(c);
  await db.delete(contracts).where(eq(contracts.id, contractId)); // lines cascade
}

export async function addContractLineToContract(contractId: string, input: ContractLineInput, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  const [row] = await db.insert(contractLines).values({
    contractId, orgId: c.orgId, lineType: input.lineType, description: input.description,
    catalogItemId: input.catalogItemId ?? null, unitPrice: input.unitPrice,
    manualQuantity: input.lineType === 'manual' ? (input.manualQuantity ?? '0') : null,
    siteId: input.lineType === 'per_device' ? (input.siteId ?? null) : null,
    taxable: input.taxable, sortOrder: input.sortOrder ?? 0
  }).returning();
  return row!;
}

export async function removeContractLine(contractId: string, lineId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  await db.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts
git commit -m "feat(contracts): contractService CRUD + line ops (TDD)"
```

### Task 3.5: contractService — lifecycle transitions

**Files:**
- Modify: `apps/api/src/services/contractService.ts`
- Test: `apps/api/src/services/contractService.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `contractService.test.ts`:

```ts
import { activateContract, pauseContract, resumeContract, cancelContract } from './contractService';
import { nextBillingDate } from './contractMath';

describe('contractService lifecycle', () => {
  it.runIf(!!process.env.DATABASE_URL)('activate requires a line and sets next_billing_at', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await expect(withSystemDbAccessContext(() => activateContract(c.id, actor))).rejects.toThrow(/line/i);
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'm', unitPrice: '500.00', taxable: false
    }, actor));
    const active = await withSystemDbAccessContext(() => activateContract(c.id, actor));
    expect(active.status).toBe('active');
    expect(active.nextBillingAt).toBe('2026-07-01'); // advance → period 0 start
  });

  it.runIf(!!process.env.DATABASE_URL)('pause clears the pointer; resume recomputes forward', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'flat', description: 'm', unitPrice: '1.00', taxable: false }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor));
    const paused = await withSystemDbAccessContext(() => pauseContract(c.id, actor));
    expect(paused.status).toBe('paused');
    expect(paused.nextBillingAt).toBeNull();
    const resumed = await withSystemDbAccessContext(() => resumeContract(c.id, actor, '2026-06-10'));
    expect(resumed.status).toBe('active');
    // resumes at the current period's trigger, never back-bills Jan–May
    expect(resumed.nextBillingAt).toBe('2026-06-01');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/contractService.test.ts -t lifecycle`
Expected: FAIL ("activateContract is not a function").

- [ ] **Step 3: Implement lifecycle in `contractService.ts`**

Add these imports at the top of `contractService.ts` (`contracts`/`contractLines`/`contractBillingPeriods` are already imported from `../db/schema` in Task 3.4 — do not re-import them) and the functions at the end:

```ts
import { computePeriod, periodIndexFor, nextBillingDate, isExpired } from './contractMath';
import { emitContractEvent } from './contractEvents';

function todayISO(asOf: Date = new Date()): string {
  return asOf.toISOString().slice(0, 10);
}

export async function activateContract(contractId: string, actor: ContractActor, asOf: Date = new Date()) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status !== 'draft' && c.status !== 'paused') {
    throw new ContractServiceError('Only draft/paused contracts can be activated', 409, 'INVALID_STATE');
  }
  const [{ n }] = await db.select({ n: db.$count(contractLines, eq(contractLines.contractId, contractId)) });
  if (Number(n) === 0) throw new ContractServiceError('Contract needs at least one line', 409, 'NO_LINES');
  const idx = periodIndexFor(c.startDate, c.intervalMonths, todayISO(asOf));
  const nextAt = nextBillingDate({ startDate: c.startDate, intervalMonths: c.intervalMonths, billingTiming: c.billingTiming, periodIndex: idx });
  const [row] = await db.update(contracts)
    .set({ status: 'active', nextBillingAt: nextAt, updatedAt: asOf })
    .where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.activated', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}

export async function pauseContract(contractId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status !== 'active') throw new ContractServiceError('Only active contracts can be paused', 409, 'INVALID_STATE');
  const [row] = await db.update(contracts).set({ status: 'paused', nextBillingAt: null, updatedAt: new Date() }).where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.paused', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}

export async function resumeContract(contractId: string, actor: ContractActor, asOfISO: string = todayISO()) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status !== 'paused') throw new ContractServiceError('Only paused contracts can be resumed', 409, 'INVALID_STATE');
  const idx = periodIndexFor(c.startDate, c.intervalMonths, asOfISO);
  const nextAt = nextBillingDate({ startDate: c.startDate, intervalMonths: c.intervalMonths, billingTiming: c.billingTiming, periodIndex: idx });
  const [row] = await db.update(contracts).set({ status: 'active', nextBillingAt: nextAt, updatedAt: new Date() }).where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.activated', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}

export async function cancelContract(contractId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status === 'cancelled') return c;
  const [row] = await db.update(contracts).set({ status: 'cancelled', nextBillingAt: null, updatedAt: new Date() }).where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.cancelled', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}
```

> The `db.$count(...)` / `db.$count` helper exists in recent drizzle; if unavailable, count with `const rows = await db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, contractId)); if (rows.length === 0) ...`.

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts
git commit -m "feat(contracts): lifecycle transitions (activate/pause/resume/cancel, TDD)"
```

### Task 3.6: contractService — invoice generation (the core)

Generates one draft invoice per due period, idempotent via the ledger unique constraint. Order: create draft → add lines → claim ledger row (`ON CONFLICT DO NOTHING`); on conflict, delete the just-created draft and skip (race loser); else optionally auto-issue/send, then advance the pointer (or expire).

**Files:**
- Modify: `apps/api/src/services/contractService.ts`
- Test: `apps/api/src/services/contractService.test.ts` (append)

- [ ] **Step 1: Write failing tests (generation + idempotency)**

Append to `contractService.test.ts`:

```ts
import { generateDueInvoice } from './contractService';
import { contractBillingPeriods } from '../db/schema';
import { eq } from 'drizzle-orm';

describe('contractService generation', () => {
  it.runIf(!!process.env.DATABASE_URL)('generates one draft invoice for the due period', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'flat', description: 'Managed', unitPrice: '500.00', taxable: false }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T08:00:00Z')));

    const res = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T08:00:00Z')));
    expect(res.generated).toBe(true);
    expect(res.invoiceId).toBeTruthy();

    // second run for the same period is a no-op (idempotent)
    const again = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T09:00:00Z')));
    expect(again.generated).toBe(false);

    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, c.id)));
    expect(periods).toHaveLength(1); // exactly one period billed
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/contractService.test.ts -t generation`
Expected: FAIL ("generateDueInvoice is not a function").

- [ ] **Step 3: Implement generation in `contractService.ts`**

Add imports + function. Reuses the merged engine (`createManualInvoice`, `addContractLine`, `issueInvoice`, `sendInvoiceEmail`) and `resolvePrice` from the catalog:

```ts
import { sql } from 'drizzle-orm';
import { createManualInvoice, addContractLine, issueInvoice, sendInvoiceEmail, deleteDraftInvoice } from './invoiceService';
import { resolvePrice } from './catalogService';
import { countContractDevices, countContractSeats } from './contractQuantities';
import type { InvoiceActor } from './invoiceTypes';

interface GenerateResult { generated: boolean; invoiceId?: string; skipped?: 'already_billed' | 'expired' | 'not_due'; }

/** Generate the invoice for whatever period is currently due on this contract.
 *  Idempotent: the (contract_id, period_start) unique constraint guarantees one invoice per period.
 *  MUST be called inside a system db access context (the worker provides it). */
export async function generateDueInvoice(contractId: string, asOf: Date = new Date()): Promise<GenerateResult> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  if (c.status !== 'active' || c.nextBillingAt === null) return { generated: false, skipped: 'not_due' };
  if (c.nextBillingAt > todayISO(asOf)) return { generated: false, skipped: 'not_due' };

  // Which period does this billing run cover?
  // advance: the period whose START == nextBillingAt. arrears: the period whose END == nextBillingAt.
  const idx = c.billingTiming === 'advance'
    ? periodIndexFor(c.startDate, c.intervalMonths, c.nextBillingAt)
    : periodIndexFor(c.startDate, c.intervalMonths, c.nextBillingAt) - 1;
  const period = computePeriod(c.startDate, c.intervalMonths, Math.max(0, idx));

  // Expiry: if this period starts on/after the end date, expire instead of billing.
  if (isExpired({ endDate: c.endDate, periodStart: period.periodStart })) {
    await db.update(contracts).set({ status: 'expired', nextBillingAt: null, updatedAt: asOf }).where(eq(contracts.id, contractId));
    await emitContractEvent({ type: 'contract.expired', contractId, orgId: c.orgId, partnerId: c.partnerId });
    return { generated: false, skipped: 'expired' };
  }

  const actor: InvoiceActor = { userId: c.createdBy ?? '00000000-0000-0000-0000-000000000000', partnerId: c.partnerId, accessibleOrgIds: [c.orgId] };
  const lines = await db.select().from(contractLines).where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);

  // 1. Draft invoice. Carry contract notes + terms onto the invoice notes (engine has no terms param on create).
  const noteParts = [c.notes, c.terms].filter(Boolean) as string[];
  const inv = await createManualInvoice({ orgId: c.orgId, notes: noteParts.length ? noteParts.join('\n\n') : undefined }, actor);

  // 2. Resolve + add each contract line.
  for (const l of lines) {
    let qty = '1';
    if (l.lineType === 'manual') qty = l.manualQuantity ?? '0';
    else if (l.lineType === 'per_device') qty = String(await countContractDevices(c.orgId, l.siteId));
    else if (l.lineType === 'per_seat') qty = String(await countContractSeats(c.orgId));
    const unitPrice = l.catalogItemId
      ? (await resolvePrice(l.catalogItemId, c.orgId, actor)).unitPrice
      : l.unitPrice;
    await addContractLine(inv.id, {
      description: l.description, quantity: qty, unitPrice, taxable: l.taxable,
      catalogItemId: l.catalogItemId, sourceId: l.id
    }, actor);
  }

  // 3. Claim the period (idempotency). On conflict, this run lost a race → bin the draft and skip.
  const claimed = await db.insert(contractBillingPeriods).values({
    contractId, orgId: c.orgId, periodStart: period.periodStart, periodEnd: period.periodEnd, invoiceId: inv.id
  }).onConflictDoNothing({ target: [contractBillingPeriods.contractId, contractBillingPeriods.periodStart] }).returning({ id: contractBillingPeriods.id });

  if (claimed.length === 0) {
    await deleteDraftInvoice(inv.id, actor); // still a draft at this point — safe to remove
    return { generated: false, skipped: 'already_billed' };
  }

  // 4. Auto-issue + send when the contract opts in.
  if (c.autoIssue) {
    await issueInvoice(inv.id, actor);
    await sendInvoiceEmail(inv.id, actor);
  }

  // 5. Advance the pointer to the next period (or expire if the next period is past end_date).
  const nextIdx = Math.max(0, idx) + 1;
  const nextPeriod = computePeriod(c.startDate, c.intervalMonths, nextIdx);
  if (isExpired({ endDate: c.endDate, periodStart: nextPeriod.periodStart })) {
    await db.update(contracts).set({ status: 'expired', nextBillingAt: null, updatedAt: asOf }).where(eq(contracts.id, contractId));
    await emitContractEvent({ type: 'contract.expired', contractId, orgId: c.orgId, partnerId: c.partnerId });
  } else {
    const nextAt = c.billingTiming === 'advance' ? nextPeriod.periodStart : nextPeriod.periodEnd;
    await db.update(contracts).set({ nextBillingAt: nextAt, updatedAt: asOf }).where(eq(contracts.id, contractId));
  }

  await emitContractEvent({ type: 'contract.invoiced', contractId, orgId: c.orgId, partnerId: c.partnerId, invoiceId: inv.id });
  return { generated: true, invoiceId: inv.id };
}
```

> **Known v1 edge (documented, not fixed):** if the process crashes between step 1 (draft created) and step 3 (claim), a stray *draft* invoice with no ledger row is left behind; the pointer hasn't advanced, so the next sweep re-generates correctly. The stray draft is harmless (never issued) and can be reaped by a future "drafts with contract lines but no ledger row" cleanup. Proration and stray-draft-GC are explicitly v2.

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2.
Expected: PASS (generated true, second run false, exactly one period row).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts
git commit -m "feat(contracts): idempotent invoice generation via period ledger (TDD)"
```

---

## Phase 4 — Permissions, routes, mounting, AI tools

### Task 4.1: Permission constants

**Files:**
- Modify: `apps/api/src/services/permissions.ts`

- [ ] **Step 1: Add constants**

In `apps/api/src/services/permissions.ts`, add to the `PERMISSIONS` object next to the `INVOICES_*` block:

```ts
  CONTRACTS_READ: { resource: 'contracts', action: 'read' },
  CONTRACTS_WRITE: { resource: 'contracts', action: 'write' },
  CONTRACTS_MANAGE: { resource: 'contracts', action: 'manage' },
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/permissions.ts
git commit -m "feat(contracts): CONTRACTS_READ/WRITE/MANAGE permission constants"
```

### Task 4.2: REST routes

**Files:**
- Create: `apps/api/src/routes/contracts/index.ts`
- Create: `apps/api/src/routes/contracts/contracts.ts`
- Create: `apps/api/src/routes/contracts/lines.ts`
- Create: `apps/api/src/routes/contracts/lifecycle.ts`
- Create: `apps/api/src/routes/contracts/generate.ts`
- Test: `apps/api/src/routes/contracts/contracts.test.ts`

Mirrors the invoice route structure (`routes/invoices/`). `authMiddleware`, `requireScope('partner','system')`, `requirePermission`, `zValidator`, and the shared `contractActorFrom` / `handleContractError` helpers.

- [ ] **Step 1: Shared helpers + CRUD routes**

Create `apps/api/src/routes/contracts/contracts.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope } from '../../middleware/scope';        // confirm path against routes/invoices/lifecycle.ts
import { requirePermission } from '../../middleware/permission';
import { PERMISSIONS } from '../../services/permissions';
import { createContractSchema, updateContractSchema, listContractsQuerySchema } from '@breeze/shared';
import {
  createContract, getContract, listContracts, updateContract, deleteDraftContract
} from '../../services/contractService';
import { ContractServiceError, type ContractActor } from '../../services/contractTypes';
import type { AuthContext } from '../../middleware/auth';     // confirm path

export function contractActorFrom(c: { get: (k: string) => unknown }): ContractActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}

export function handleContractError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContractServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().uuid() });

export const contractCrudRoutes = new Hono();

contractCrudRoutes.get('/', scopes, readPerm, zValidator('query', listContractsQuerySchema), async (c) => {
  try { return c.json({ data: await listContracts(c.req.valid('query'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await getContract(c.req.valid('param').id, contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.post('/', scopes, writePerm, zValidator('json', createContractSchema), async (c) => {
  try { return c.json({ data: await createContract(c.req.valid('json'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateContractSchema), async (c) => {
  try { return c.json({ data: await updateContract(c.req.valid('param').id, c.req.valid('json'), contractActorFrom(c)) }); }
  catch (err) { return handleContractError(c, err); }
});
contractCrudRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { await deleteDraftContract(c.req.valid('param').id, contractActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleContractError(c, err); }
});
```

- [ ] **Step 2: Line routes**

Create `apps/api/src/routes/contracts/lines.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope } from '../../middleware/scope';
import { requirePermission } from '../../middleware/permission';
import { PERMISSIONS } from '../../services/permissions';
import { contractLineInputSchema } from '@breeze/shared';
import { addContractLineToContract, removeContractLine } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';

const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);

export const contractLineRoutes = new Hono();

contractLineRoutes.post('/:id/lines', scopes, writePerm,
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator('json', contractLineInputSchema), async (c) => {
    try { return c.json({ data: await addContractLineToContract(c.req.valid('param').id, c.req.valid('json'), contractActorFrom(c)) }); }
    catch (err) { return handleContractError(c, err); }
  });

contractLineRoutes.delete('/:id/lines/:lineId', scopes, writePerm,
  zValidator('param', z.object({ id: z.string().uuid(), lineId: z.string().uuid() })), async (c) => {
    try { const p = c.req.valid('param'); await removeContractLine(p.id, p.lineId, contractActorFrom(c)); return c.json({ data: { ok: true } }); }
    catch (err) { return handleContractError(c, err); }
  });
```

- [ ] **Step 3: Lifecycle + generate routes**

Create `apps/api/src/routes/contracts/lifecycle.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope } from '../../middleware/scope';
import { requirePermission } from '../../middleware/permission';
import { PERMISSIONS } from '../../services/permissions';
import { activateContract, pauseContract, resumeContract, cancelContract } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';

const scopes = requireScope('partner', 'system');
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);
const idParam = z.object({ id: z.string().uuid() });

export const contractLifecycleRoutes = new Hono();
const transitions = [
  ['activate', activateContract], ['pause', pauseContract], ['resume', resumeContract], ['cancel', cancelContract]
] as const;
for (const [verb, fn] of transitions) {
  contractLifecycleRoutes.post(`/:id/${verb}`, scopes, managePerm, zValidator('param', idParam), async (c) => {
    try { return c.json({ data: await fn(c.req.valid('param').id, contractActorFrom(c)) }); }
    catch (err) { return handleContractError(c, err); }
  });
}
```

Create `apps/api/src/routes/contracts/generate.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope } from '../../middleware/scope';
import { requirePermission } from '../../middleware/permission';
import { PERMISSIONS } from '../../services/permissions';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getContract, generateDueInvoice } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';

const scopes = requireScope('partner', 'system');
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);

export const contractGenerateRoutes = new Hono();

// Manual "generate now" — authorizes via the request actor, then runs generation under system context
// (generation writes invoices/ledger across orgs-of-one and must satisfy RLS as the worker does).
contractGenerateRoutes.post('/:id/generate', scopes, managePerm,
  zValidator('param', z.object({ id: z.string().uuid() })), async (c) => {
    try {
      const id = c.req.valid('param').id;
      await getContract(id, contractActorFrom(c)); // 404/403 gate on the caller's access
      const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => generateDueInvoice(id)));
      return c.json({ data: res });
    } catch (err) { return handleContractError(c, err); }
  });
```

Create `apps/api/src/routes/contracts/index.ts`:

```ts
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth'; // confirm the export name against routes/invoices/index.ts
import { contractCrudRoutes } from './contracts';
import { contractLineRoutes } from './lines';
import { contractLifecycleRoutes } from './lifecycle';
import { contractGenerateRoutes } from './generate';

export const contractRoutes = new Hono();
contractRoutes.use('*', authMiddleware);
contractRoutes.route('/', contractLifecycleRoutes); // /:id/activate ... (before crud's /:id)
contractRoutes.route('/', contractGenerateRoutes);  // /:id/generate
contractRoutes.route('/', contractLineRoutes);      // /:id/lines ...
contractRoutes.route('/', contractCrudRoutes);      // /, /:id
```

- [ ] **Step 4: Route test**

Create `apps/api/src/routes/contracts/contracts.test.ts` following the structure of `routes/invoices/invoices.test.ts` (same app-bootstrap + auth-stub helpers that file uses). Cover: `POST /contracts` creates a draft (201/200 with `data.id`); `GET /contracts/:id` returns it; `POST /contracts/:id/lines` then `POST /:id/activate` returns `status:'active'`; unauthenticated request → 401; a `contracts:read`-only token cannot `POST` (→403). Reuse the invoice test's auth/permission stubs verbatim — do not invent a new harness.

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/routes/contracts/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/contracts/
git commit -m "feat(contracts): REST routes (crud, lines, lifecycle, generate) + tests"
```

### Task 4.3: Mount routes + wire nothing else yet

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Mount**

In `apps/api/src/index.ts`, next to `api.route('/invoices', invoiceRoutes);`, add:

```ts
import { contractRoutes } from './routes/contracts';
// ...
api.route('/contracts', contractRoutes);
```

- [ ] **Step 2: Typecheck + smoke**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(contracts): mount /contracts routes"
```

### Task 4.4: AI read tools

**Files:**
- Create: `apps/api/src/services/aiToolsContracts.ts`
- Modify: the AI tools registry hub that calls `registerBillingTools` (grep for `registerBillingTools(` to find it)

Mirror `aiToolsBilling.ts` (`registerBillingTools`) — read-only `list_contracts` / `get_contract`, org-scope enforced at the service layer.

- [ ] **Step 1: Implement `aiToolsContracts.ts`**

Create `apps/api/src/services/aiToolsContracts.ts`:

```ts
import type { AiTool, AiToolTier } from './aiToolsTypes'; // confirm the type import path used by aiToolsBilling.ts
import type { AuthContext } from '../middleware/auth';
import { listContracts, getContract } from './contractService';
import { ContractServiceError, type ContractActor } from './contractTypes';

function actorFromAuth(auth: AuthContext): ContractActor {
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof ContractServiceError) return JSON.stringify({ error: err.message, code: err.code });
  return null;
}

export function registerContractTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_contracts', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_contracts',
      description: 'List recurring contracts for the orgs the caller can access. Optionally filter by org or status. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Filter to a single organization (UUID)' },
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'cancelled', 'expired'], description: 'Filter by status' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      try {
        const rows = await listContracts(
          { orgId: input.orgId ? String(input.orgId) : undefined, status: input.status ? String(input.status) : undefined, limit },
          actorFromAuth(auth)
        );
        return JSON.stringify({ contracts: rows, showing: rows.length });
      } catch (err) { const j = serviceErrorToJson(err); if (j) return j; throw err; }
    }
  });

  aiTools.set('get_contract', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'get_contract',
      description: 'Get one recurring contract with its lines and billing-period history. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: { contractId: { type: 'string', description: 'Contract UUID' } },
        required: ['contractId']
      }
    },
    handler: async (input, auth) => {
      try { return JSON.stringify(await getContract(String(input.contractId), actorFromAuth(auth))); }
      catch (err) { const j = serviceErrorToJson(err); if (j) return j; throw err; }
    }
  });
}
```

- [ ] **Step 2: Register in the hub**

In the registry hub that calls `registerBillingTools(aiTools)`, add directly after it:

```ts
import { registerContractTools } from './aiToolsContracts';
// ...
registerContractTools(aiTools);
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiTools.ts
git commit -m "feat(contracts): read-only AI tools (list/get), org-scope guarded"
```

---

## Phase 5 — Daily billing sweep worker

A BullMQ scheduled job that finds active contracts due to bill and calls `generateDueInvoice` for each. Mirrors `invoiceWorker.ts` (queue, repeatable cron, init/shutdown).

### Task 5.1: contractWorker

**Files:**
- Create: `apps/api/src/jobs/contractWorker.ts`
- Test: `apps/api/src/jobs/contractWorker.test.ts`

- [ ] **Step 1: Write the failing sweep test**

Create `apps/api/src/jobs/contractWorker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations, contracts, contractLines, contractBillingPeriods } from '../db/schema';
import { eq } from 'drizzle-orm';
import { runContractBillingSweep } from './contractWorker';

describe('runContractBillingSweep', () => {
  it.runIf(!!process.env.DATABASE_URL)('bills every active contract due on/before asOf, idempotently', async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    let contractId = '';
    await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({ name: `SW ${sfx}`, slug: `sw-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'O', slug: `o-${sfx}` }).returning({ id: organizations.id });
      const [ctr] = await db.insert(contracts).values({
        partnerId: p!.id, orgId: o!.id, name: 'C', status: 'active', billingTiming: 'advance',
        intervalMonths: 1, startDate: '2026-07-01', nextBillingAt: '2026-07-01'
      }).returning({ id: contracts.id });
      contractId = ctr!.id;
      await db.insert(contractLines).values({ contractId, orgId: o!.id, lineType: 'flat', description: 'm', unitPrice: '500.00', taxable: false });
    });

    const first = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
    expect(first.billed).toBe(1);
    const second = await runContractBillingSweep(new Date('2026-07-01T06:05:00Z'));
    expect(second.billed).toBe(0); // pointer advanced to Aug 1; nothing due

    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId)));
    expect(periods).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/jobs/contractWorker.test.ts`
Expected: FAIL ("Cannot find module './contractWorker'").

- [ ] **Step 3: Implement `contractWorker.ts`**

Create `apps/api/src/jobs/contractWorker.ts` (mirror `invoiceWorker.ts` — confirm `getBullMQConnection` / queue idioms against it):

```ts
import { Queue, Worker } from 'bullmq';
import { and, eq, lte, isNotNull } from 'drizzle-orm';
import { getBullMQConnection } from '../config/redis';
import { captureException } from '../config/sentry';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { contracts } from '../db/schema';
import { generateDueInvoice } from '../services/contractService';

const CONTRACT_QUEUE = 'contract-jobs';
const BILLING_SWEEP_CRON = '0 5 * * *'; // daily 05:00, before the invoice overdue sweep (06:00)

let queue: Queue | null = null;
let worker: Worker | null = null;
function getContractQueue(): Queue {
  if (!queue) queue = new Queue(CONTRACT_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** Bill every active contract whose next_billing_at <= asOf. Returns count billed.
 *  Each contract is independent — one failure does not abort the rest. */
export async function runContractBillingSweep(asOf: Date = new Date()): Promise<{ billed: number; failed: number }> {
  const today = asOf.toISOString().slice(0, 10);
  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: contracts.id }).from(contracts)
      .where(and(eq(contracts.status, 'active' as never), isNotNull(contracts.nextBillingAt), lte(contracts.nextBillingAt, today)))
  ));
  let billed = 0; let failed = 0;
  for (const row of due) {
    try {
      const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => generateDueInvoice(row.id, asOf)));
      if (res.generated) billed++;
    } catch (err) {
      failed++;
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[ContractWorker] generation failed', `contractId=${row.id}`, err);
    }
  }
  return { billed, failed };
}

export function createContractWorker(): Worker {
  return new Worker(CONTRACT_QUEUE, async (job) => {
    if (job.name === 'billing-sweep') return runContractBillingSweep();
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

async function scheduleContractJobs(): Promise<void> {
  const q = getContractQueue();
  for (const j of await q.getRepeatableJobs()) await q.removeRepeatableByKey(j.key);
  await q.add('billing-sweep', { type: 'billing-sweep' }, {
    repeat: { pattern: BILLING_SWEEP_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 }
  });
}

export async function initializeContractWorkers(): Promise<void> {
  worker = createContractWorker();
  worker.on('failed', (job, err) => { captureException(err); console.error('[ContractWorker] job failed', job?.id, err); });
  worker.on('error', (err) => { captureException(err); });
  await scheduleContractJobs();
}

export async function shutdownContractWorkers(): Promise<void> {
  if (worker) await worker.close();
  if (queue) await queue.close();
  worker = null; queue = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS (first sweep bills 1, second bills 0, one period row).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/contractWorker.ts apps/api/src/jobs/contractWorker.test.ts
git commit -m "feat(contracts): daily billing sweep worker (idempotent, TDD)"
```

### Task 5.2: Wire worker into the API lifecycle

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Register init/shutdown**

In `apps/api/src/index.ts`, next to the invoice worker wiring (`['invoiceWorker', initializeInvoiceWorkers]` and the shutdown list), add:

```ts
import { initializeContractWorkers, shutdownContractWorkers } from './jobs/contractWorker';
// ...in the workers init loop, alongside invoiceWorker:
['contractWorker', initializeContractWorkers],
// ...in the shutdown sequence, alongside shutdownInvoiceWorkers():
await shutdownContractWorkers();
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/index.ts
git commit -m "feat(contracts): init/shutdown contract billing worker"
```

---

## Phase 6 — Web UI

Astro + React islands, mirroring the invoice web pages shipped in #1383 (`apps/web/src/components/invoices/*`, `apps/web/src/pages/invoices/*` — open these as the working template for data-fetching, `runAction`, toast, and `data-testid` conventions). Mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); transient UI state uses `window.location.hash`.

### Task 6.1: Contracts list page + API client

**Files:**
- Create: `apps/web/src/lib/api/contracts.ts` (typed fetch wrappers)
- Create: `apps/web/src/components/contracts/ContractsList.tsx`
- Create: `apps/web/src/pages/contracts/index.astro`

- [ ] **Step 1: API client wrappers**

Create `apps/web/src/lib/api/contracts.ts` (follow the invoice client's `apiFetch` import + shape):

```ts
import { apiFetch } from '../apiClient'; // confirm the helper name used by lib/api/invoices.ts

export interface ContractSummary {
  id: string; orgId: string; name: string; status: 'draft'|'active'|'paused'|'cancelled'|'expired';
  billingTiming: 'advance'|'arrears'; intervalMonths: number; startDate: string; endDate: string | null;
  nextBillingAt: string | null; autoIssue: boolean; currencyCode: string;
}
export interface ContractLine {
  id: string; lineType: 'flat'|'per_device'|'per_seat'|'manual'; description: string;
  unitPrice: string; manualQuantity: string | null; siteId: string | null; catalogItemId: string | null; taxable: boolean; sortOrder: number;
}
export interface ContractBillingPeriod { id: string; periodStart: string; periodEnd: string; invoiceId: string | null; generatedAt: string; }

export const listContracts = (q: { orgId?: string; status?: string } = {}) =>
  apiFetch<{ data: ContractSummary[] }>(`/contracts?${new URLSearchParams(q as Record<string,string>)}`);
export const getContract = (id: string) =>
  apiFetch<{ data: { contract: ContractSummary; lines: ContractLine[]; periods: ContractBillingPeriod[] } }>(`/contracts/${id}`);
export const createContract = (body: unknown) => apiFetch(`/contracts`, { method: 'POST', body: JSON.stringify(body) });
export const updateContract = (id: string, body: unknown) => apiFetch(`/contracts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const addContractLine = (id: string, body: unknown) => apiFetch(`/contracts/${id}/lines`, { method: 'POST', body: JSON.stringify(body) });
export const removeContractLine = (id: string, lineId: string) => apiFetch(`/contracts/${id}/lines/${lineId}`, { method: 'DELETE' });
export const contractTransition = (id: string, verb: 'activate'|'pause'|'resume'|'cancel') => apiFetch(`/contracts/${id}/${verb}`, { method: 'POST' });
export const generateContractInvoice = (id: string) => apiFetch(`/contracts/${id}/generate`, { method: 'POST' });
```

- [ ] **Step 2: List component**

Create `apps/web/src/components/contracts/ContractsList.tsx`. A table with columns: Name, Org, Status badge, Cadence (`Monthly`/`Quarterly`/`Annual`/`Every N months` derived from `intervalMonths`), Next bill (`nextBillingAt ?? '—'`), and a "New contract" button linking to the editor. Status filter via `window.location.hash` (`#status=active`). Each row links to `/contracts/{id}`. Use `data-testid="contracts-list"`, `data-testid="contract-row-{id}"`, `data-testid="new-contract-btn"`. Read-only fetch on mount via `listContracts`; surface load errors with the page's standard error banner (mirror the invoices list).

- [ ] **Step 3: Astro page**

Create `apps/web/src/pages/contracts/index.astro` mounting `<ContractsList client:load />` inside the standard app layout (copy the frontmatter/layout import from `pages/invoices/index.astro`).

- [ ] **Step 4: Verify build + commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check`
Expected: PASS (no `.astro`/TS errors).

```bash
git add apps/web/src/lib/api/contracts.ts apps/web/src/components/contracts/ContractsList.tsx apps/web/src/pages/contracts/index.astro
git commit -m "feat(contracts-web): contracts list page + API client"
```

### Task 6.2: Contract editor (draft/active) + detail

**Files:**
- Create: `apps/web/src/components/contracts/ContractEditor.tsx`
- Create: `apps/web/src/components/contracts/ContractDetail.tsx`
- Create: `apps/web/src/pages/contracts/[id].astro`

- [ ] **Step 1: Editor component**

Create `apps/web/src/components/contracts/ContractEditor.tsx` for `draft`/`active` contracts. Header form: org picker (create only), name, `billingTiming` select, `intervalMonths` (presets 1/3/12 + custom number), start/end date, `autoIssue` toggle. Line builder: a row per line with `lineType` select, description, unit price, taxable checkbox, an optional site picker shown only when `lineType==='per_device'`, and a catalog-item link (optional). All create/update/add-line/remove-line calls wrapped in `runAction` so success and failure toast. Show a live "Estimated this period" total: for `flat`/`manual` use the entered qty×price; for `per_device`/`per_seat`, fetch current counts via a small read (reuse an existing devices/users count endpoint if present, else display "auto" with no number — do NOT block the editor on counts). `data-testid`: `contract-editor`, `add-line-btn`, `line-row-{idx}`, `save-contract-btn`, `activate-contract-btn`.

- [ ] **Step 2: Detail component**

Create `apps/web/src/components/contracts/ContractDetail.tsx` (read-mostly). Renders the header (read-only), the lines, lifecycle buttons (`activate`/`pause`/`resume`/`cancel` — shown per current status), a "Generate now" button (calls `generateContractInvoice`, wrapped in `runAction`), and the **billing-period history** table from `periods` (each row links to `/invoices/{invoiceId}` when set). Include the informational "hours under contract this period" stat as a labelled read-only number sourced from an existing time-entry read filtered by `billing_status='contract'` for the org+period (if no such endpoint exists yet, render the label with `—` and a `title` tooltip "available when contract-time reporting ships" — do not build a new endpoint in this plan). `data-testid`: `contract-detail`, `generate-now-btn`, `period-row-{id}`, lifecycle buttons `contract-{verb}-btn`.

- [ ] **Step 3: Astro page (mode by status)**

Create `apps/web/src/pages/contracts/[id].astro` that loads the contract and renders `<ContractEditor>` when status is `draft` (or an "Edit" toggle when `active`), else `<ContractDetail>`. Mirror how `pages/invoices/[id].astro` switches between editor (draft) and detail (issued).

- [ ] **Step 4: Register mutation components in the no-silent-mutations guard**

Add `ContractEditor.tsx` and `ContractDetail.tsx` to the adopted set checked by `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (they already use `runAction`, so they pass — this just records them as covered). If the test auto-discovers components, no change is needed; if it uses an explicit list, append them.

- [ ] **Step 5: Verify + commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check`
Expected: PASS.
Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

```bash
git add apps/web/src/components/contracts/ apps/web/src/pages/contracts/
git commit -m "feat(contracts-web): contract editor (draft) + detail (history, lifecycle, generate)"
```

### Task 6.3: Org "Contracts" tab

**Files:**
- Modify: the org detail page (`apps/web/src/components/organizations/OrganizationsPage.tsx` or the org detail island — grep for the existing tab set, e.g. where an "Invoices" tab is rendered)

- [ ] **Step 1: Add the tab**

Add a "Contracts" tab next to the org's "Invoices" tab (hash-routed like the others), rendering `<ContractsList />` pre-filtered to the org (`listContracts({ orgId })`) with a "New contract" CTA that deep-links to the editor with the org pre-selected. Reuse the existing tab component and `data-testid` convention; add `data-testid="org-tab-contracts"`.

- [ ] **Step 2: Verify + commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check`
Expected: PASS.

```bash
git add apps/web/src/components/organizations/
git commit -m "feat(contracts-web): org Contracts tab"
```

---

## Final verification

- [ ] **API typecheck:** `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit` → PASS.
- [ ] **Shared typecheck:** `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec tsc --noEmit` → PASS.
- [ ] **Web check:** `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec astro check` → PASS.
- [ ] **Schema drift:** `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift` → no drift.
- [ ] **Contract math + validators + service (with DB):** run the new unit + integration tests green (single-fork to avoid the known suite-parallel flakiness).
- [ ] **RLS forge + coverage:** `cd apps/api && PATH=… DATABASE_URL=… pnpm exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts` → PASS (confirm DB role is not BYPASSRLS first).
- [ ] **Integration job (CI):** push the branch and trigger the `Integration Tests` job explicitly (`gh workflow run ci.yml --ref <branch>`) — it is SKIPPED on `pull_request` and is the only job that runs tenantCascade + RLS forge.
- [ ] **PR gate:** before `--admin` merge, hard-stop on any failing required check (Test API / Web / Agent, Integration, Type Check); ignore only Trivy/Cargo/doc-verify.

## Deferred to v2 (explicitly out of scope here)
- Proration (mid-period and start/cancel-edge).
- Hour allowances / overage on contract-status time (v1 = covered-by-fee, reporting-only).
- Fixed-term + auto-renew with renewal notices.
- Rich quantity filters (device group / OS / tag).
- Stray-draft garbage collection (drafts created when a sweep crashes mid-generation).
- Threading contract `terms` into a dedicated invoice `terms` field (v1 folds notes+terms into invoice `notes`).
