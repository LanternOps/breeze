# Pax8 Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP technician place, change, and cancel Pax8 subscriptions from inside Breeze — either directly on a customer's org page, or as the fulfillment step of a quote the customer approved.

**Architecture:** Two new partner-axis tables (`pax8_orders`, `pax8_order_lines`) form a staged intent ledger. Both authoring paths (org tab, quote acceptance) write a draft order; a technician submits it. Submit runs an `isMock` dry-run, claims each line in a committed transaction before the HTTP call, and on success writes the resulting quantity onto the linked contract line in the same transaction. Breeze — not Pax8 — is the source of truth for billable seat counts.

**Tech Stack:** Hono (API), Drizzle ORM, PostgreSQL + RLS, Vitest, React islands (web), hand-written SQL migrations.

**Spec:** `docs/superpowers/specs/billing/2026-07-13-pax8-ordering-design.md`

## Global Constraints

- **Read the spec first.** Every task assumes its "Pax8 API contract" section, especially the four documented defects in Pax8's own OpenAPI. Do not trust the vendor spec over `isMock`.
- **Tenancy: partner-axis (RLS shape 3).** Both new tables get `partner_id NOT NULL` with policies on `public.breeze_has_partner_access(partner_id)`. `org_id` is a linkage column, NOT a tenancy axis, and must be excluded from org auto-discovery in the contract test.
- **Migrations are idempotent and never edited once shipped.** `IF NOT EXISTS` / `DO $$`. No inner `BEGIN;`/`COMMIT;` — `autoMigrate` wraps each file in a transaction.
- **`PUT /v1/subscriptions/{id}` sends `quantity` and nothing else.** `price`, `partnerCost`, and `currencyCode` are writable on that endpoint; a read-modify-write would overwrite the customer's rate.
- **Never blind-retry a write.** A timeout or 5xx means *unknown*, not *failed*. The line goes to `needs_reconcile`.
- **No new DB enums.** Follow the existing `pax8_*` convention: `varchar` columns with SQL `CHECK` constraints, plus TypeScript union types. (Drizzle `pgEnum` + `z.enum(x.enumValues)` breaks the schema mocks used by unit tests.)
- **Permissions:** `PERMISSIONS.BILLING_MANAGE` on all routes; `requireMfa()` on every write, matching `routes/pax8.ts`.
- **Money in `numeric(12,2)`**, quantities included, matching `pax8_subscription_snapshots.quantity`.

---

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-07-13-a-pax8-ordering.sql` | Both tables, CHECKs, indexes, composite FKs, RLS |
| `apps/api/src/db/schema/pax8Orders.ts` | Drizzle definitions for the two new tables |
| `packages/shared/src/types/pax8-enums.ts` | SSOT for action / status / billing-term unions |
| `apps/api/src/services/pax8OrderService.ts` | Draft authoring: create, add/remove lines, validate preconditions |
| `apps/api/src/services/pax8OrderSubmit.ts` | The submit pipeline + reconcile. The money-critical file |
| `apps/api/src/routes/pax8Orders.ts` | HTTP surface, mounted under the existing `/api/v1/pax8` |
| `apps/api/src/services/pax8Drift.ts` | Ledger-vs-Pax8 drift comparison (replaces the quantity push) |
| `apps/web/src/components/organizations/Pax8OrgTab.tsx` | Org-page tab shell |
| `apps/web/src/components/organizations/Pax8OrderBuilder.tsx` | Add product, provisioning form, review & submit |
| `apps/web/src/lib/api/pax8Orders.ts` | Web API client |

**Modify:**
| File | Change |
|---|---|
| `apps/api/src/services/pax8Client.ts` | Add write methods; `requestJson` currently hardcodes GET |
| `apps/api/src/services/pax8SyncService.ts:232-265` | `applyEnabledPax8ContractLineLinks` stops writing `contract_lines` |
| `apps/api/src/services/quoteAcceptService.ts` | New Phase 5: stage the order in-transaction |
| `apps/api/src/db/schema/index.ts` | Export the new schema module |
| `apps/api/src/index.ts:919` | Mount `pax8OrderRoutes` |
| `apps/api/src/services/tenantCascade.ts:226` | Add both tables (alphabetical order is load-bearing) |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` + org-discovery exclusion |

---

## Task 1: Schema + migration + tenancy registration

**Files:**
- Create: `apps/api/migrations/2026-07-13-a-pax8-ordering.sql`
- Create: `apps/api/src/db/schema/pax8Orders.ts`
- Create: `packages/shared/src/types/pax8-enums.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/tenantCascade.ts:226`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/pax8OrdersPartnerRls.integration.test.ts`

**Interfaces:**
- Produces: `pax8Orders`, `pax8OrderLines` Drizzle tables. `PAX8_ORDER_ACTIONS`, `PAX8_ORDER_STATUSES`, `PAX8_SUBMIT_STATES`, `PAX8_BILLING_TERMS` const arrays and their `Pax8OrderAction` / `Pax8OrderStatus` / `Pax8SubmitState` / `Pax8BillingTerm` union types.

- [ ] **Step 1: Write the shared enums (SSOT)**

Create `packages/shared/src/types/pax8-enums.ts`:

```ts
// Pax8 order vocabularies. Append-only — order is load-bearing for any UI that
// renders these in sequence, and DB CHECK constraints mirror these lists.

export const PAX8_ORDER_ACTIONS = ['new_subscription', 'change_quantity', 'cancel'] as const;
export type Pax8OrderAction = (typeof PAX8_ORDER_ACTIONS)[number];

export const PAX8_ORDER_STATUSES = [
  'draft',
  'awaiting_details',
  'ready',
  'submitting',
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
] as const;
export type Pax8OrderStatus = (typeof PAX8_ORDER_STATUSES)[number];

export const PAX8_SUBMIT_STATES = [
  'pending',
  'in_flight',
  'succeeded',
  'failed',
  'needs_reconcile',
] as const;
export type Pax8SubmitState = (typeof PAX8_SUBMIT_STATES)[number];

// Verbatim from Pax8's CreateLineItem.billingTerm enum. These strings are sent
// on the wire exactly as written — do not lowercase or reformat them.
export const PAX8_BILLING_TERMS = ['Monthly', 'Annual', '2-Year', '3-Year', 'One-Time', 'Trial', 'Activation'] as const;
export type Pax8BillingTerm = (typeof PAX8_BILLING_TERMS)[number];

export const PAX8_ORDER_SOURCES = ['direct', 'quote'] as const;
export type Pax8OrderSource = (typeof PAX8_ORDER_SOURCES)[number];
```

Export it from `packages/shared/src/types/index.ts` alongside the existing type exports (follow whatever re-export form that file already uses).

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-07-13-a-pax8-ordering.sql`:

```sql
-- Pax8 ordering: staged intent ledger.
-- Pax8 has no idempotency key and no order status field, so THIS TABLE — not
-- Pax8 — is the record of whether money was spent. A line is claimed
-- (submit_state='in_flight') in a committed txn before the HTTP call.
-- Partner-axis (RLS shape 3), matching the five existing pax8_* tables:
-- org_id is a linkage column, never the tenancy axis.

CREATE TABLE IF NOT EXISTS pax8_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL,
  pax8_company_id VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  source VARCHAR(10) NOT NULL DEFAULT 'direct',
  source_quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  dedupe_key VARCHAR(120) NOT NULL,
  pax8_order_id VARCHAR(64),
  error TEXT,
  created_by UUID REFERENCES users(id),
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pax8_orders_status_chk CHECK (status IN (
    'draft','awaiting_details','ready','submitting','completed','partially_failed','failed','cancelled')),
  CONSTRAINT pax8_orders_source_chk CHECK (source IN ('direct','quote')),
  CONSTRAINT pax8_orders_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES pax8_integrations(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT pax8_orders_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

-- The idempotency guard. A concurrent submit of the same intent loses this race.
CREATE UNIQUE INDEX IF NOT EXISTS pax8_orders_dedupe_key_uq
  ON pax8_orders(partner_id, dedupe_key);
CREATE INDEX IF NOT EXISTS pax8_orders_partner_idx ON pax8_orders(partner_id);
CREATE INDEX IF NOT EXISTS pax8_orders_org_idx ON pax8_orders(org_id);
CREATE INDEX IF NOT EXISTS pax8_orders_status_idx ON pax8_orders(partner_id, status);
CREATE INDEX IF NOT EXISTS pax8_orders_quote_idx ON pax8_orders(source_quote_id);
-- Target for the order_lines composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS pax8_orders_id_partner_idx ON pax8_orders(id, partner_id);

CREATE TABLE IF NOT EXISTS pax8_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL,
  submit_state VARCHAR(20) NOT NULL DEFAULT 'pending',
  pax8_product_id VARCHAR(64),
  catalog_item_id UUID,
  billing_term VARCHAR(20),
  commitment_term_id VARCHAR(64),
  quantity NUMERIC(12,2),
  provisioning_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_subscription_id VARCHAR(64),
  cancel_date DATE,
  result_subscription_id VARCHAR(64),
  contract_line_id UUID,
  source_quote_line_id UUID,
  error TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pax8_order_lines_action_chk CHECK (action IN (
    'new_subscription','change_quantity','cancel')),
  CONSTRAINT pax8_order_lines_state_chk CHECK (submit_state IN (
    'pending','in_flight','succeeded','failed','needs_reconcile')),
  -- Each action carries a different payload; enforce the shape rather than
  -- trusting the service layer. A cancel with a quantity is a bug, not data.
  CONSTRAINT pax8_order_lines_action_payload_chk CHECK (
    (action = 'new_subscription'
       AND pax8_product_id IS NOT NULL AND billing_term IS NOT NULL
       AND quantity IS NOT NULL AND quantity > 0 AND target_subscription_id IS NULL)
    OR (action = 'change_quantity'
       AND target_subscription_id IS NOT NULL AND quantity IS NOT NULL AND quantity >= 0)
    OR (action = 'cancel'
       AND target_subscription_id IS NOT NULL AND quantity IS NULL)
  ),
  CONSTRAINT pax8_order_lines_order_partner_fkey
    FOREIGN KEY (order_id, partner_id)
    REFERENCES pax8_orders(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT pax8_order_lines_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT pax8_order_lines_catalog_item_partner_fkey
    FOREIGN KEY (catalog_item_id, partner_id)
    REFERENCES catalog_items(id, partner_id) ON DELETE SET NULL,
  CONSTRAINT pax8_order_lines_contract_line_org_fkey
    FOREIGN KEY (contract_line_id, org_id)
    REFERENCES contract_lines(id, org_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pax8_order_lines_order_idx ON pax8_order_lines(order_id);
CREATE INDEX IF NOT EXISTS pax8_order_lines_partner_idx ON pax8_order_lines(partner_id);
CREATE INDEX IF NOT EXISTS pax8_order_lines_org_idx ON pax8_order_lines(org_id);
CREATE INDEX IF NOT EXISTS pax8_order_lines_contract_line_idx ON pax8_order_lines(contract_line_id);
-- Finds lines stranded mid-flight (crash between claim and result).
CREATE INDEX IF NOT EXISTS pax8_order_lines_inflight_idx
  ON pax8_order_lines(submit_state) WHERE submit_state IN ('in_flight','needs_reconcile');

ALTER TABLE pax8_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE pax8_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_order_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_orders;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_orders;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_orders;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_orders;
CREATE POLICY breeze_partner_isolation_select ON pax8_orders
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_orders
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_orders
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_orders
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_order_lines;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_order_lines;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_order_lines;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_order_lines;
CREATE POLICY breeze_partner_isolation_select ON pax8_order_lines
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_order_lines
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_order_lines
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_order_lines
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 3: Write the Drizzle schema**

Create `apps/api/src/db/schema/pax8Orders.ts`:

```ts
import {
  pgTable, uuid, varchar, text, timestamp, jsonb, numeric, date, integer,
  index, uniqueIndex, foreignKey,
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { catalogItems } from './catalog';
import { contractLines } from './contracts';
import { quotes } from './quotes';
import { pax8Integrations } from './pax8';

export const pax8Orders = pgTable('pax8_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull(),
  pax8CompanyId: varchar('pax8_company_id', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  source: varchar('source', { length: 10 }).notNull().default('direct'),
  sourceQuoteId: uuid('source_quote_id').references(() => quotes.id, { onDelete: 'set null' }),
  dedupeKey: varchar('dedupe_key', { length: 120 }).notNull(),
  pax8OrderId: varchar('pax8_order_id', { length: 64 }),
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id),
  submittedBy: uuid('submitted_by').references(() => users.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  dedupeKeyIdx: uniqueIndex('pax8_orders_dedupe_key_uq').on(table.partnerId, table.dedupeKey),
  idPartnerIdx: uniqueIndex('pax8_orders_id_partner_idx').on(table.id, table.partnerId),
  partnerIdx: index('pax8_orders_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_orders_org_idx').on(table.orgId),
  statusIdx: index('pax8_orders_status_idx').on(table.partnerId, table.status),
  quoteIdx: index('pax8_orders_quote_idx').on(table.sourceQuoteId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [pax8Integrations.id, pax8Integrations.partnerId],
    name: 'pax8_orders_integration_partner_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_orders_org_partner_fkey',
  }).onDelete('cascade'),
}));

export const pax8OrderLines = pgTable('pax8_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  submitState: varchar('submit_state', { length: 20 }).notNull().default('pending'),
  pax8ProductId: varchar('pax8_product_id', { length: 64 }),
  catalogItemId: uuid('catalog_item_id'),
  billingTerm: varchar('billing_term', { length: 20 }),
  commitmentTermId: varchar('commitment_term_id', { length: 64 }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }),
  provisioningDetails: jsonb('provisioning_details').notNull().default([]),
  targetSubscriptionId: varchar('target_subscription_id', { length: 64 }),
  cancelDate: date('cancel_date'),
  resultSubscriptionId: varchar('result_subscription_id', { length: 64 }),
  contractLineId: uuid('contract_line_id'),
  sourceQuoteLineId: uuid('source_quote_line_id'),
  error: text('error'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orderIdx: index('pax8_order_lines_order_idx').on(table.orderId),
  partnerIdx: index('pax8_order_lines_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_order_lines_org_idx').on(table.orgId),
  contractLineIdx: index('pax8_order_lines_contract_line_idx').on(table.contractLineId),
  orderPartnerFk: foreignKey({
    columns: [table.orderId, table.partnerId],
    foreignColumns: [pax8Orders.id, pax8Orders.partnerId],
    name: 'pax8_order_lines_order_partner_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_order_lines_org_partner_fkey',
  }).onDelete('cascade'),
  catalogItemPartnerFk: foreignKey({
    columns: [table.catalogItemId, table.partnerId],
    foreignColumns: [catalogItems.id, catalogItems.partnerId],
    name: 'pax8_order_lines_catalog_item_partner_fkey',
  }).onDelete('set null'),
  contractLineOrgFk: foreignKey({
    columns: [table.contractLineId, table.orgId],
    foreignColumns: [contractLines.id, contractLines.orgId],
    name: 'pax8_order_lines_contract_line_org_fkey',
  }).onDelete('set null'),
}));
```

Add `export * from './pax8Orders';` to `apps/api/src/db/schema/index.ts`, directly after the existing pax8 export (~line 100).

- [ ] **Step 4: Register tenancy**

In `apps/api/src/services/tenantCascade.ts`, add to the cascade list in **alphabetical order** (it sorts by `localeCompare`; getting this wrong breaks the cascade contract test). `pax8_order_lines` and `pax8_orders` sort *before* `pax8_company_mappings`? No — check: `pax8_company_mappings` < `pax8_contract_line_links` < `pax8_order_lines` < `pax8_orders` < `pax8_subscription_snapshots`. Insert both between `pax8_contract_line_links` and `pax8_subscription_snapshots`:

```ts
  'pax8_company_mappings',
  'pax8_contract_line_links',
  'pax8_order_lines',
  'pax8_orders',
  'pax8_subscription_snapshots',
```

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`:

Add both to `PARTNER_TENANT_TABLES` (the `Map`), next to the other pax8 entries:

```ts
  ['pax8_orders', 'partner_id'],
  ['pax8_order_lines', 'partner_id'],
```

And add both to the org-auto-discovery exclusion set (the `Set` that already lists `'pax8_company_mappings'`, `'pax8_subscription_snapshots'`, `'pax8_contract_line_links'`), extending the existing comment block:

```ts
  'pax8_company_mappings',
  'pax8_subscription_snapshots',
  'pax8_contract_line_links',
  // pax8_orders / pax8_order_lines (2026-07-13, ordering): same shape — org_id
  // is the customer the order is FOR, not the tenancy axis. Ordering is an
  // MSP-side act; an org-scoped token must never see one.
  'pax8_orders',
  'pax8_order_lines',
```

- [ ] **Step 5: Write the failing RLS test**

Create `apps/api/src/__tests__/integration/pax8OrdersPartnerRls.integration.test.ts`. Copy the structure of the existing `pax8-rls.integration.test.ts` (same file directory) — reuse its fixture helpers verbatim rather than inventing new ones. The suite must prove:

```ts
it('rejects a cross-partner forged order insert with 42501', async () => {
  // Partner A's context, forging partner B's partner_id.
  await expect(
    withPartnerContext(partnerA.id, () =>
      db.insert(pax8Orders).values({
        integrationId: integrationB.id,
        partnerId: partnerB.id,
        orgId: orgB.id,
        pax8CompanyId: 'forged-co',
        dedupeKey: 'forge-test-1',
      }),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('hides another partner\'s orders from SELECT', async () => {
  const rows = await withPartnerContext(partnerA.id, () =>
    db.select().from(pax8Orders).where(eq(pax8Orders.id, orderB.id)),
  );
  expect(rows).toHaveLength(0);
});

it('rejects a second order with the same (partner_id, dedupe_key)', async () => {
  await expect(
    withPartnerContext(partnerA.id, () =>
      db.insert(pax8Orders).values({ ...validOrderA, dedupeKey: existingOrderA.dedupeKey }),
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

it('rejects a cancel line carrying a quantity (action payload CHECK)', async () => {
  await expect(
    withPartnerContext(partnerA.id, () =>
      db.insert(pax8OrderLines).values({
        orderId: orderA.id, partnerId: partnerA.id, orgId: orgA.id,
        action: 'cancel', targetSubscriptionId: 'sub-1', quantity: '5.00',
      }),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
```

**Do not memoize the partner fixtures across tests** — a shared memoized fixture is how a forge test goes vacuously green (it ends up forging against itself).

- [ ] **Step 6: Run the tests — expect failure**

```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts pax8OrdersPartnerRls
```
Expected: FAIL — `relation "pax8_orders" does not exist`.

- [ ] **Step 7: Apply the migration and re-run**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:migrate && pnpm vitest run --config vitest.integration.config.ts pax8OrdersPartnerRls
```
Expected: PASS, 4 tests.

- [ ] **Step 8: Verify as the unprivileged role**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "INSERT INTO pax8_orders (integration_id, partner_id, org_id, pax8_company_id, dedupe_key) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 'x');"
```
Expected: `ERROR: new row violates row-level security policy for table "pax8_orders"`.

- [ ] **Step 9: Check for drift, run the contract test, commit**

```bash
pnpm db:check-drift
cd apps/api && pnpm vitest run --config vitest.integration.config.ts rls-coverage
git add apps/api/migrations/2026-07-13-a-pax8-ordering.sql apps/api/src/db/schema/pax8Orders.ts apps/api/src/db/schema/index.ts packages/shared/src/types/pax8-enums.ts packages/shared/src/types/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/pax8OrdersPartnerRls.integration.test.ts
git commit -m "feat(pax8): add pax8_orders + pax8_order_lines staged intent ledger"
```

---

## Task 2: Pax8 write client

**Files:**
- Modify: `apps/api/src/services/pax8Client.ts`
- Test: `apps/api/src/services/pax8Client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, on `Pax8Client`:
  - `createOrder(input: Pax8CreateOrderInput, opts?: { isMock?: boolean }): Promise<Pax8OrderResult>`
  - `updateSubscriptionQuantity(subscriptionId: string, quantity: number): Promise<void>`
  - `cancelSubscription(subscriptionId: string, cancelDate?: string | null): Promise<void>`
  - `getProvisionDetails(productId: string): Promise<Pax8ProvisionDetail[]>`
  - `getProductDependencies(productId: string): Promise<Pax8ProductDependencies>`
  - Types `Pax8CreateOrderInput`, `Pax8OrderLineInput`, `Pax8OrderResult`, `Pax8ProvisionDetail`, `Pax8Commitment`, `Pax8ProductDependencies`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/pax8Client.test.ts` (create it if absent, following the existing service-test style — inject a stub `fetch` via `Pax8ClientOptions.fetch`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { Pax8Client, Pax8ApiError } from './pax8Client';

function clientWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return new Pax8Client({
    credentials: { clientId: 'id', clientSecret: 'secret', accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3_600_000) },
    fetch: fetchImpl as never,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('Pax8Client.updateSubscriptionQuantity', () => {
  it('sends ONLY quantity — never price, partnerCost, or currencyCode', async () => {
    const doFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'sub-1', quantity: 11 }));
    await clientWith(doFetch).updateSubscriptionQuantity('sub-1', 11);

    const [url, init] = doFetch.mock.calls[0];
    expect(url).toBe('https://api.pax8.com/v1/subscriptions/sub-1');
    expect(init.method).toBe('PUT');
    // The whole point: PUT is a partial update and price IS writable. A body
    // with any extra key can silently overwrite the customer's rate.
    expect(JSON.parse(init.body)).toEqual({ quantity: 11 });
  });
});

describe('Pax8Client.cancelSubscription', () => {
  it('DELETEs with no body and no cancelDate when none given', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' } as Response);
    await clientWith(doFetch).cancelSubscription('sub-9');

    const [url, init] = doFetch.mock.calls[0];
    expect(url).toBe('https://api.pax8.com/v1/subscriptions/sub-9');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('passes cancelDate as a query param', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' } as Response);
    await clientWith(doFetch).cancelSubscription('sub-9', '2026-09-01');
    expect(doFetch.mock.calls[0][0]).toBe('https://api.pax8.com/v1/subscriptions/sub-9?cancelDate=2026-09-01');
  });
});

describe('Pax8Client.createOrder', () => {
  it('posts companyId + lineItems and sets isMock when asked', async () => {
    const doFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'ord-1', lineItems: [{ id: 'li-1', subscriptionId: 'sub-1' }] }));
    const res = await clientWith(doFetch).createOrder({
      companyId: 'co-1',
      lineItems: [{
        lineItemNumber: 1,
        productId: 'prod-1',
        quantity: 5,
        billingTerm: 'Monthly',
        provisioningDetails: [{ key: 'msDomain', values: ['acme'] }],
      }],
    }, { isMock: true });

    const [url, init] = doFetch.mock.calls[0];
    expect(url).toBe('https://api.pax8.com/v1/orders?isMock=true');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      companyId: 'co-1',
      lineItems: [{
        lineItemNumber: 1, productId: 'prod-1', quantity: 5, billingTerm: 'Monthly',
        provisioningDetails: [{ key: 'msDomain', values: ['acme'] }],
      }],
    });
    expect(res.pax8OrderId).toBe('ord-1');
    expect(res.lineItems[0].subscriptionId).toBe('sub-1');
  });

  it('surfaces Pax8 422 details verbatim on Pax8ApiError.body', async () => {
    const body = { status: 422, message: 'Invalid order', details: [{ message: 'msDomain is required' }] };
    const doFetch = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => JSON.stringify(body) } as Response);
    await expect(clientWith(doFetch).createOrder({ companyId: 'co-1', lineItems: [] }))
      .rejects.toMatchObject({ name: 'Pax8ApiError', status: 422 });
  });
});

describe('Pax8Client.getProvisionDetails', () => {
  it('returns the discoverable field descriptors', async () => {
    const doFetch = vi.fn().mockResolvedValue(jsonResponse({ content: [
      { key: 'msCustExists', label: 'Existing Microsoft account?', valueType: 'Single-Value', possibleValues: ['No', 'Yes'] },
      { key: 'msDomain', label: 'Domain prefix', valueType: 'Input', possibleValues: null },
    ] }));
    const details = await clientWith(doFetch).getProvisionDetails('prod-1');
    expect(doFetch.mock.calls[0][0]).toBe('https://api.pax8.com/v1/products/prod-1/provision-details');
    expect(details).toHaveLength(2);
    expect(details[1]).toMatchObject({ key: 'msDomain', valueType: 'Input', possibleValues: null });
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd apps/api && pnpm vitest run src/services/pax8Client.test.ts
```
Expected: FAIL — `client.updateSubscriptionQuantity is not a function`.

- [ ] **Step 3: Generalize `requestJson` to take a method and body**

`requestJson` at `pax8Client.ts:300` hardcodes a GET (it never sets `method`). Replace it with a method-aware version, keeping the existing GET call sites working by defaulting to GET:

```ts
  private async requestJson(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {},
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    const res = await this.doFetch(url.toString(), {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    } as RequestInit & { timeoutMs?: number });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Pax8 puts per-line-item validation failures in `details[]`. Keep the raw
      // body — the UI shows it verbatim rather than guessing at what's wrong,
      // because requiredness is NOT discoverable from their spec.
      throw new Pax8ApiError(`Pax8 API returned ${res.status}`, res.status, body.slice(0, 4000));
    }
    if (res.status === 204) return null;
    return res.json();
  }
```

Note the two changes beyond the method: a 204 returns `null` (cancel returns no content), and the error body slice grows from 500 to 4000 chars so a multi-line `details[]` survives.

- [ ] **Step 4: Add the write methods and their types**

Add near the other exported interfaces:

```ts
export interface Pax8ProvisioningDetailInput {
  key: string;
  values: string[];   // ALWAYS an array, even for a single scalar input.
}

export interface Pax8OrderLineInput {
  lineItemNumber: number;
  productId: string;
  quantity: number;
  billingTerm: string;
  commitmentTermId?: string;
  provisioningDetails?: Pax8ProvisioningDetailInput[];
}

export interface Pax8CreateOrderInput {
  companyId: string;
  lineItems: Pax8OrderLineInput[];
  orderedBy?: 'Pax8 Partner' | 'Customer' | 'Pax8';
  orderedByUserEmail?: string;
}

export interface Pax8OrderResult {
  pax8OrderId: string | null;
  lineItems: Array<{ lineItemNumber: number | null; productId: string | null; subscriptionId: string | null }>;
}

export interface Pax8ProvisionDetail {
  key: string;
  label: string | null;
  description: string | null;
  valueType: 'Input' | 'Single-Value' | 'Multi-Value' | null;
  possibleValues: string[] | null;
}

export interface Pax8Commitment {
  id: string;
  term: string | null;
  allowForQuantityIncrease: boolean;
  allowForQuantityDecrease: boolean;
  allowForEarlyCancellation: boolean;
  cancellationFeeApplied: boolean;
}

export interface Pax8ProductDependencies {
  commitments: Pax8Commitment[];
}
```

And the methods on `Pax8Client`:

```ts
  /**
   * POST /v1/orders. Pax8 has NO idempotency key — calling this twice creates
   * two real, billable orders, and Order.createdDate is a DATE (not a timestamp)
   * so you cannot tell them apart afterward. Callers MUST claim their intent row
   * in a committed transaction before invoking this, and MUST NOT retry on
   * timeout. See pax8OrderSubmit.ts.
   *
   * `isMock: true` validates without touching Pax8's database. It is the ONLY
   * machine-checkable oracle for whether provisioningDetails are complete,
   * because their provision-details endpoint does not expose requiredness.
   */
  async createOrder(input: Pax8CreateOrderInput, opts: { isMock?: boolean } = {}): Promise<Pax8OrderResult> {
    const payload = await this.requestJson(
      '/orders',
      opts.isMock ? { isMock: true } : {},
      { method: 'POST', body: input },
    );
    const record = asRecord(payload);
    const lineItems = extractArray(record?.lineItems).map((raw) => {
      const li = asRecord(raw);
      return {
        lineItemNumber: li ? firstNumber(li, ['lineItemNumber']) : null,
        productId: li ? firstString(li, ['productId', 'product_id']) : null,
        subscriptionId: li ? firstString(li, ['subscriptionId', 'subscription_id']) : null,
      };
    });
    return { pax8OrderId: record ? firstString(record, ['id', 'orderId']) : null, lineItems };
  }

  /**
   * PUT /v1/subscriptions/{id}. Despite the verb this is a PARTIAL update, and
   * `price`, `partnerCost`, `currencyCode`, `startDate`, and `endDate` are all
   * writable. We send `quantity` and nothing else — a read-modify-write would
   * re-send pricing and can overwrite the customer's rate. Do not "helpfully"
   * add fields to this body.
   */
  async updateSubscriptionQuantity(subscriptionId: string, quantity: number): Promise<void> {
    await this.requestJson(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {},
      { method: 'PUT', body: { quantity } },
    );
  }

  /** DELETE /v1/subscriptions/{id}. No body. Cancel is terminal — Pax8 exposes no reactivate. */
  async cancelSubscription(subscriptionId: string, cancelDate?: string | null): Promise<void> {
    await this.requestJson(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      cancelDate ? { cancelDate } : {},
      { method: 'DELETE' },
    );
  }

  async getProvisionDetails(productId: string): Promise<Pax8ProvisionDetail[]> {
    const payload = await this.requestJson(`/products/${encodeURIComponent(productId)}/provision-details`);
    return extractArray(payload).map((raw): Pax8ProvisionDetail | null => {
      const r = asRecord(raw);
      const key = r ? firstString(r, ['key']) : null;
      if (!r || !key) return null;
      const valueType = firstString(r, ['valueType']);
      const possible = Array.isArray(r.possibleValues)
        ? r.possibleValues.filter((v): v is string => typeof v === 'string')
        : null;
      return {
        key,
        label: firstString(r, ['label']),
        description: firstString(r, ['description']),
        valueType: (valueType as Pax8ProvisionDetail['valueType']) ?? null,
        possibleValues: possible,
      };
    }).filter((d): d is Pax8ProvisionDetail => d !== null);
  }

  async getProductDependencies(productId: string): Promise<Pax8ProductDependencies> {
    const payload = await this.requestJson(`/products/${encodeURIComponent(productId)}/dependencies`);
    const root = asRecord(payload);
    const commitments = extractArray(root?.commitmentDependencies).map((raw): Pax8Commitment | null => {
      const r = asRecord(raw);
      const id = r ? firstString(r, ['id']) : null;
      if (!r || !id) return null;
      return {
        id,
        term: firstString(r, ['term']),
        allowForQuantityIncrease: r.allowForQuantityIncrease === true,
        allowForQuantityDecrease: r.allowForQuantityDecrease === true,
        allowForEarlyCancellation: r.allowForEarlyCancellation === true,
        cancellationFeeApplied: r.cancellationFeeApplied === true,
      };
    }).filter((c): c is Pax8Commitment => c !== null);
    return { commitments };
  }
```

- [ ] **Step 5: Run — expect pass**

```bash
cd apps/api && pnpm vitest run src/services/pax8Client.test.ts
```
Expected: PASS. Then re-run the existing pax8 suites to prove the `requestJson` change didn't break the read paths:

```bash
cd apps/api && pnpm vitest run pax8
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/pax8Client.ts apps/api/src/services/pax8Client.test.ts
git commit -m "feat(pax8): add order/subscription write methods to Pax8Client"
```

---

## Task 3: Draft order authoring service

**Files:**
- Create: `apps/api/src/services/pax8OrderService.ts`
- Test: `apps/api/src/services/pax8OrderService.test.ts`

**Interfaces:**
- Consumes: `pax8Orders`, `pax8OrderLines` (Task 1); `Pax8OrderAction`, `Pax8BillingTerm` (Task 1).
- Produces:
  - `getOrCreateDraftOrder(input: { partnerId, orgId, actorUserId }): Promise<Pax8OrderRow>`
  - `addOrderLine(input: AddOrderLineInput): Promise<Pax8OrderLineRow>`
  - `removeOrderLine(input: { partnerId, orderId, lineId }): Promise<{ removed: boolean }>`
  - `getOrderWithLines(input: { partnerId, orderId }): Promise<{ order: Pax8OrderRow; lines: Pax8OrderLineRow[] }>`
  - `Pax8OrderError` (class with `.status`)
  - `buildDedupeKey(orderId: string): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/pax8OrderService.test.ts`. Mock `../db` following the Drizzle-mock pattern already used by the sibling service tests (see `breeze-testing` skill; the schema proxy mock needs a `has` trap). Cover:

```ts
describe('getOrCreateDraftOrder', () => {
  it('throws 409 when the org has no Pax8 company mapping', async () => {
    mockCompanyMappingLookup(null);
    await expect(getOrCreateDraftOrder({ partnerId: 'p1', orgId: 'o1', actorUserId: 'u1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('not mapped to a Pax8 company') });
  });

  it('reuses the existing open draft rather than creating a second one', async () => {
    mockCompanyMappingLookup({ pax8CompanyId: 'co-1', integrationId: 'i1' });
    mockExistingDraft({ id: 'ord-existing', status: 'draft' });
    const order = await getOrCreateDraftOrder({ partnerId: 'p1', orgId: 'o1', actorUserId: 'u1' });
    expect(order.id).toBe('ord-existing');
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('addOrderLine', () => {
  it('rejects a change_quantity whose commitment forbids a decrease', async () => {
    mockSubscriptionSnapshot({ pax8SubscriptionId: 'sub-1', quantity: '10.00', orgId: 'o1' });
    mockDependencies({ commitments: [{ id: 'c1', allowForQuantityDecrease: false, allowForQuantityIncrease: true }] });
    await expect(addOrderLine({
      partnerId: 'p1', orderId: 'ord-1', action: 'change_quantity',
      targetSubscriptionId: 'sub-1', quantity: '5.00',
    })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('decrease') });
  });

  it('rejects a line targeting a subscription in a different org', async () => {
    mockSubscriptionSnapshot({ pax8SubscriptionId: 'sub-1', orgId: 'OTHER-ORG' });
    await expect(addOrderLine({
      partnerId: 'p1', orderId: 'ord-1', action: 'cancel', targetSubscriptionId: 'sub-1',
    })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses to modify an order that is not draft/awaiting_details', async () => {
    mockOrder({ id: 'ord-1', status: 'submitting' });
    await expect(addOrderLine({ partnerId: 'p1', orderId: 'ord-1', action: 'cancel', targetSubscriptionId: 'sub-1' }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('buildDedupeKey', () => {
  it('is stable for the same order', () => {
    expect(buildDedupeKey('ord-1')).toBe(buildDedupeKey('ord-1'));
  });
});
```

- [ ] **Step 2: Run — expect failure (module not found)**

```bash
cd apps/api && pnpm vitest run src/services/pax8OrderService.test.ts
```

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/pax8OrderService.ts`. Key behaviors, in order:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { pax8Orders, pax8OrderLines, pax8CompanyMappings, pax8SubscriptionSnapshots } from '../db/schema';
import type { Pax8OrderAction, Pax8BillingTerm } from '@breeze/shared';

export class Pax8OrderError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 | 409 | 422) {
    super(message);
    this.name = 'Pax8OrderError';
  }
}

export type Pax8OrderRow = typeof pax8Orders.$inferSelect;
export type Pax8OrderLineRow = typeof pax8OrderLines.$inferSelect;

/** Stable per-order. The unique index on (partner_id, dedupe_key) is what makes
 *  a concurrent submit lose the race — see pax8OrderSubmit.claimLine. */
export function buildDedupeKey(orderId: string): string {
  return `order:${orderId}`;
}

const MUTABLE_STATUSES = new Set(['draft', 'awaiting_details']);
```

`getOrCreateDraftOrder` must:
1. Look up the org's `pax8_company_mappings` row (by `partnerId` + `orgId`, `ignored = false`). If absent or `orgId` unset → `Pax8OrderError('This organization is not mapped to a Pax8 company. Map it before ordering.', 409)`.
2. Return the existing order for that org whose status is in `MUTABLE_STATUSES`, if one exists.
3. Otherwise insert one with `status: 'draft'`, `source: 'direct'`, `dedupeKey: buildDedupeKey(<the new id>)` — generate the id client-side (`crypto.randomUUID()`) so the dedupe key can reference it in the same insert.

`addOrderLine` must, for every action:
1. Load the order; reject if its status is not in `MUTABLE_STATUSES` → 409.
2. For `change_quantity` and `cancel`: load the `pax8_subscription_snapshots` row by `(integrationId, pax8SubscriptionId)`. Reject if missing (404) or if its `orgId` ≠ the order's `orgId` (403 — this is the cross-tenant guard, do not skip it).
3. For `change_quantity`: fetch `getProductDependencies(productId)` via `createPax8ClientForIntegration`, and if the new quantity is below the snapshot quantity, require `allowForQuantityDecrease`; if above, require `allowForQuantityIncrease`. Reject with 422 naming the direction.
4. For `cancel`: require `allowForEarlyCancellation`; reject 422 otherwise.
5. For `new_subscription`: require `pax8ProductId`, a `billingTerm` in `PAX8_BILLING_TERMS`, and `quantity > 0`.
6. Insert the line. The DB `CHECK` constraint is the backstop; these checks exist to produce a readable message instead of a 23514.

The Pax8 HTTP calls in steps 3–4 must run via `runOutsideDbContext(...)` — never hold a pooled connection across an HTTP round-trip (#1697).

- [ ] **Step 4: Run — expect pass**

```bash
cd apps/api && pnpm vitest run src/services/pax8OrderService.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pax8OrderService.ts apps/api/src/services/pax8OrderService.test.ts
git commit -m "feat(pax8): draft order authoring service with commitment guards"
```

---

## Task 4: The submit pipeline

This is the money-critical file. Every rule in it exists because Pax8 has no idempotency key.

**Files:**
- Create: `apps/api/src/services/pax8OrderSubmit.ts`
- Test: `apps/api/src/services/pax8OrderSubmit.test.ts`
- Test: `apps/api/src/__tests__/integration/pax8OrderSubmit.integration.test.ts`

**Interfaces:**
- Consumes: `Pax8Client.createOrder / updateSubscriptionQuantity / cancelSubscription` (Task 2); `pax8Orders`, `pax8OrderLines` (Task 1); `Pax8OrderError` (Task 3).
- Produces:
  - `preflightOrder(input: { partnerId, orderId }): Promise<{ ok: true } | { ok: false; errorBody: string }>`
  - `submitOrder(input: { partnerId, orderId, actorUserId }): Promise<SubmitResult>` where `SubmitResult = { orderId: string; status: Pax8OrderStatus; lines: Array<{ lineId: string; submitState: Pax8SubmitState; error: string | null }> }`
  - `reconcileOrder(input: { partnerId, orderId }): Promise<{ resolved: number; stillUnknown: number }>`

- [ ] **Step 1: Write the failing unit tests**

Create `apps/api/src/services/pax8OrderSubmit.test.ts`:

```ts
describe('submitOrder', () => {
  it('runs the isMock preflight BEFORE any real write, and aborts on 422', async () => {
    const client = stubClient();
    client.createOrder.mockRejectedValueOnce(new Pax8ApiError('Pax8 API returned 422', 422, '{"details":[{"message":"msDomain is required"}]}'));

    const res = await submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    // Exactly ONE call — the mock. The real order was never attempted.
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.createOrder.mock.calls[0][1]).toEqual({ isMock: true });
    expect(res.status).toBe('failed');
    expect(res.lines[0].error).toContain('msDomain is required');
  });

  it('marks a line needs_reconcile — NOT failed — when the write times out', async () => {
    const client = stubClient();
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })          // isMock preflight OK
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const res = await submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.lines[0].submitState).toBe('needs_reconcile');
    // A timeout means UNKNOWN. Retrying here is how you buy the licenses twice.
    expect(client.createOrder).toHaveBeenCalledTimes(2);  // preflight + the one real attempt
  });

  it('does not re-send a line already in_flight', async () => {
    mockOrderLines([{ id: 'l1', submitState: 'in_flight', action: 'new_subscription' }]);
    const client = stubClient();
    await expect(submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('records partially_failed when the POST succeeds but a PUT 422s', async () => {
    const client = stubClient();
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({ pax8OrderId: 'ord-x', lineItems: [{ lineItemNumber: 1, productId: 'prod-1', subscriptionId: 'sub-new' }] });
    client.updateSubscriptionQuantity.mockRejectedValueOnce(new Pax8ApiError('Pax8 API returned 422', 422, '{"message":"seat decrease not allowed"}'));

    const res = await submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.status).toBe('partially_failed');
    expect(res.lines.find((l) => l.lineId === 'line-new')!.submitState).toBe('succeeded');
    expect(res.lines.find((l) => l.lineId === 'line-change')!.submitState).toBe('failed');
  });
});
```

- [ ] **Step 2: Write the failing integration test (real Postgres)**

Create `apps/api/src/__tests__/integration/pax8OrderSubmit.integration.test.ts`. This one proves the atomicity claim that a mocked test cannot:

```ts
it('writes the contract-line quantity in the SAME transaction that marks the line succeeded', async () => {
  // A new_subscription line linked to a manual contract line, quantity 7.
  const { orderId, lineId, contractLineId } = await seedOrderWithContractLine({ quantity: '7.00' });

  await submitOrder({ partnerId: partner.id, orderId, actorUserId: user.id });

  const [line] = await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.id, lineId));
  const [cl] = await db.select().from(contractLines).where(eq(contractLines.id, contractLineId));
  expect(line.submitState).toBe('succeeded');
  expect(cl.manualQuantity).toBe('7.00');   // ordering and billing are ONE act
});

it('leaves the contract line untouched when the order fails', async () => {
  const { orderId, contractLineId } = await seedOrderWithContractLine({ quantity: '7.00', failWith: 422 });
  await submitOrder({ partnerId: partner.id, orderId, actorUserId: user.id });
  const [cl] = await db.select().from(contractLines).where(eq(contractLines.id, contractLineId));
  expect(cl.manualQuantity).toBeNull();
});

it('rejects a concurrent second submit via the dedupe_key unique index', async () => {
  const { orderId } = await seedOrderWithContractLine({ quantity: '3.00' });
  const results = await Promise.allSettled([
    submitOrder({ partnerId: partner.id, orderId, actorUserId: user.id }),
    submitOrder({ partnerId: partner.id, orderId, actorUserId: user.id }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
```

- [ ] **Step 3: Run both — expect failure**

```bash
cd apps/api && pnpm vitest run src/services/pax8OrderSubmit.test.ts
cd apps/api && pnpm vitest run --config vitest.integration.config.ts pax8OrderSubmit
```

- [ ] **Step 4: Implement `preflightOrder`**

Builds the `Pax8CreateOrderInput` from the order's `new_subscription` lines (assigning `lineItemNumber` from `sort_order + 1`) and calls `client.createOrder(input, { isMock: true })`. Returns `{ ok: false, errorBody }` on `Pax8ApiError` with the raw `.body`, `{ ok: true }` otherwise. An order with no `new_subscription` lines skips the preflight and returns `{ ok: true }` — `isMock` only validates orders, not subscription updates.

- [ ] **Step 5: Implement `submitOrder`**

The sequence, and none of it is negotiable:

```
1. Load order + lines. Reject 409 if status not in {draft, awaiting_details, ready}
   or if ANY line is already in_flight (a crashed prior submit — force reconcile).
2. Flip order -> 'submitting' in a COMMITTED txn. If the (partner_id, dedupe_key)
   unique index rejects, a concurrent submit won it: throw 409.
3. Preflight: preflightOrder(). On failure, mark every new_subscription line
   'failed' with the raw body, order -> 'failed', return. NOTHING was sent.
4. Claim ALL lines: submit_state 'pending' -> 'in_flight', COMMITTED, before any
   HTTP call. If the process dies after this, the lines are visibly in_flight and
   a human must reconcile — which is exactly the intent.
5. runOutsideDbContext(...) around the HTTP work:
     a. All new_subscription lines -> ONE client.createOrder(input)  (no isMock)
     b. Each change_quantity line -> client.updateSubscriptionQuantity(subId, qty)
     c. Each cancel line          -> client.cancelSubscription(subId, cancelDate)
   Classify each outcome:
     - resolved OK                     -> succeeded
     - Pax8ApiError with a status 4xx  -> failed   (Pax8 definitively rejected it)
     - anything else (timeout, 5xx,
       network, no status)             -> needs_reconcile   (UNKNOWN — never retry)
6. Persist results. For EACH succeeded line, in the SAME transaction:
     - set result_subscription_id (matched from the createOrder response by
       lineItemNumber, falling back to productId)
     - if contract_line_id is set AND action != 'cancel':
         UPDATE contract_lines SET manual_quantity = <line.quantity>
           WHERE id = contract_line_id AND line_type = 'manual'
     - if action = 'cancel' AND contract_line_id is set:
         UPDATE contract_lines SET manual_quantity = '0'
   Order status: all succeeded -> 'completed'; any needs_reconcile or a mix ->
   'partially_failed'; all failed -> 'failed'.
```

The `contract_lines` write is guarded on `line_type = 'manual'` exactly as `applyEnabledPax8ContractLineLinks` does today — a `per_seat`/`per_device` line resolves its quantity at bill time and must not be overwritten.

- [ ] **Step 6: Implement `reconcileOrder`**

For each `needs_reconcile` line, fetch `GET /v1/orders?companyId=` and `GET /v1/subscriptions?companyId=` (the client's existing `listSubscriptions`, filtered) and match on `productId` + `quantity`. A match → the write landed: mark `succeeded` and run the same contract-line write as step 6 above. No match → mark `failed`. **`reconcileOrder` never issues a write to Pax8.** It only reads and re-classifies.

Note in a comment that `Order.createdDate` is a date, not a timestamp, so same-day disambiguation is coarse — this is why reconcile is human-triggered and not automatic.

- [ ] **Step 7: Run both suites — expect pass**

```bash
cd apps/api && pnpm vitest run src/services/pax8OrderSubmit.test.ts
cd apps/api && pnpm vitest run --config vitest.integration.config.ts pax8OrderSubmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/pax8OrderSubmit.ts apps/api/src/services/pax8OrderSubmit.test.ts apps/api/src/__tests__/integration/pax8OrderSubmit.integration.test.ts
git commit -m "feat(pax8): order submit pipeline with isMock preflight and no-blind-retry"
```

---

## Task 5: HTTP routes

**Files:**
- Create: `apps/api/src/routes/pax8Orders.ts`
- Modify: `apps/api/src/index.ts` (near line 919, where `pax8Routes` is mounted)
- Test: `apps/api/src/routes/pax8Orders.test.ts`

**Interfaces:**
- Consumes: every export of Tasks 3 and 4.
- Produces: `pax8OrderRoutes` (a `Hono` instance), mounted at `/api/v1/pax8/orders`.

Routes, all `requireScope('partner', 'system')` + `BILLING_MANAGE`, writes additionally `requireMfa()`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/orders?orgId=` | List orders for an org (or all pending for the partner) |
| GET | `/orders/:id` | Order + lines |
| POST | `/orders` | `getOrCreateDraftOrder` |
| POST | `/orders/:id/lines` | `addOrderLine` |
| DELETE | `/orders/:id/lines/:lineId` | `removeOrderLine` |
| POST | `/orders/:id/preflight` | `preflightOrder` — returns the raw Pax8 422 body on failure |
| POST | `/orders/:id/submit` | `submitOrder` (MFA) |
| POST | `/orders/:id/reconcile` | `reconcileOrder` (MFA) |
| GET | `/products/:productId/provision-details` | Proxy for the dynamic form |
| GET | `/products/:productId/dependencies` | Commitment terms + the allowFor* flags |

Copy the `resolvePartnerId(auth, requested)` helper from `routes/pax8.ts:31` verbatim — an org-scoped token must be refused with *"Pax8 ordering is managed at partner scope"*, exactly as the existing routes refuse it. Every write calls `writeRouteAudit(...)` following the pattern already in `routes/pax8.ts`.

Map `Pax8OrderError.status` onto the HTTP status; map `Pax8ApiError` to a 502 carrying the raw body.

- [ ] **Step 1: Write the failing route tests** — assert the org-scope refusal (403), that `POST /orders/:id/submit` without MFA is rejected, and that a `Pax8OrderError(…, 409)` surfaces as a 409 with its message.
- [ ] **Step 2: Run — expect failure.** `cd apps/api && pnpm vitest run src/routes/pax8Orders.test.ts`
- [ ] **Step 3: Implement the routes.**
- [ ] **Step 4: Mount** in `apps/api/src/index.ts` next to the existing `app.route('/api/v1/pax8', pax8Routes)`: `app.route('/api/v1/pax8', pax8OrderRoutes)`. Hono merges the two routers on the same prefix; keep the order-routes mount *after* the existing one so the more specific `/orders/*` paths are unambiguous.
- [ ] **Step 5: Run — expect pass.**
- [ ] **Step 6: Commit.** `git commit -m "feat(pax8): order routes"`

---

## Task 6: Stage the order on quote acceptance

**Files:**
- Modify: `apps/api/src/services/quoteAcceptService.ts` (after the Phase 4 contract loop, ~line 250-255)
- Create: `apps/api/src/services/quoteToPax8Order.ts`
- Test: `apps/api/src/services/quoteToPax8Order.test.ts`
- Test: `apps/api/src/__tests__/integration/quoteAcceptPax8Order.integration.test.ts`

**Interfaces:**
- Consumes: `pax8Orders`, `pax8OrderLines` (Task 1); `buildDedupeKey` (Task 3).
- Produces: `stagePax8OrderFromQuote(input: StagePax8OrderInput): Promise<{ orderId: string | null; lineCount: number }>` — returns `{ orderId: null, lineCount: 0 }` when the quote has no Pax8-backed lines.

- [ ] **Step 1: Write the failing tests**

`quoteToPax8Order.test.ts`:

```ts
it('returns null when the quote has no Pax8-backed lines', async () => {
  const res = await stagePax8OrderFromQuote({ ...baseInput, lines: [{ catalogItemId: 'cat-plain', ... }] });
  expect(res.orderId).toBeNull();
});

it('stages one new_subscription line per Pax8-backed quote line', async () => { ... });

it('attaches the contract line created by Phase 4, matched on catalog_item_id', async () => { ... });

it('leaves contract_line_id null for a one_time Pax8 line', async () => {
  // one_time lines bill on the invoice and produce NO contract line.
  const res = await stagePax8OrderFromQuote({ ...baseInput, lines: [pax8Line({ recurrence: 'one_time' })] });
  expect(stagedLines[0].contractLineId).toBeNull();
});

it('claims each contract line at most once when two quote lines share a catalog item', async () => { ... });
```

`quoteAcceptPax8Order.integration.test.ts` (real Postgres) — the one that matters:

```ts
it('stages the order INSIDE the accept transaction, atomic with the contracts', async () => {
  const quote = await seedSentQuoteWithPax8Line();
  const res = await acceptQuote({ quoteId: quote.id, signerName: 'A Customer' });

  const [order] = await db.select().from(pax8Orders).where(eq(pax8Orders.sourceQuoteId, quote.id));
  expect(order.status).toBe('awaiting_details');
  expect(order.source).toBe('quote');

  const [line] = await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.orderId, order.id));
  expect(line.action).toBe('new_subscription');
  expect(line.contractLineId).not.toBeNull();   // wired to the contract Phase 4 made
  expect(res.contractIds).toContain(contractIdOf(line.contractLineId));
});

it('stages nothing when the accept rolls back', async () => {
  const quote = await seedSentQuoteWithPax8Line();
  await expect(acceptQuoteWithForcedFailureAfterPhase5(quote.id)).rejects.toThrow();
  const orders = await db.select().from(pax8Orders).where(eq(pax8Orders.sourceQuoteId, quote.id));
  expect(orders).toHaveLength(0);   // the whole point of staging in-transaction
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement `stagePax8OrderFromQuote`**

It must:
1. Resolve which quote lines are Pax8-backed: join `catalog_item_id` → `pax8_product_mappings.catalog_item_id` (scoped to the partner's active integration). A line with no mapping is not Pax8-backed and is skipped.
2. Return early with `{ orderId: null, lineCount: 0 }` if none.
3. Require the quote's org to have a `pax8_company_mappings` row. If it doesn't, **do not throw** — a missing mapping must never block a customer's acceptance. Stage the order anyway with `status: 'awaiting_details'` and set `order.error` to *"Organization is not mapped to a Pax8 company — map it before submitting."* The technician fixes it before submitting.
4. Re-read `contract_lines` for the contracts Phase 4 just created (`inArray(contractLines.contractId, contractIds)`), and match each Pax8-backed quote line to a contract line on `catalog_item_id`, claiming each contract line at most once (a `Set` of claimed ids). A `one_time` line gets `contractLineId: null`.
5. Insert the `pax8_orders` row (`source: 'quote'`, `sourceQuoteId`, `status: 'awaiting_details'`, `dedupeKey: buildDedupeKey(id)`) and its lines, mapping `quantity` from the quote line's `quantity`, `billingTerm` from the quote line's `recurrence` (`monthly` → `'Monthly'`, `annual` → `'Annual'`, `one_time` → `'One-Time'`), and `pax8ProductId` from the mapping.
6. Leave `provisioningDetails` as `[]` — that is precisely what the technician supplies before submit.

- [ ] **Step 4: Wire it into `acceptQuote` as Phase 5**

In `quoteAcceptService.ts`, immediately after the `for (const spec of contractSpecs)` loop that populates `contractIds`, and **before** the final `SELECT` that builds the return value:

```ts
  // Phase 5: stage a Pax8 order for any Pax8-backed lines. IN-TRANSACTION,
  // alongside Phase 4 — a staged order that references contract lines which
  // rolled back would be unfixable. Nothing is sent to Pax8 here: the customer's
  // approval stages the order, a technician submits it. Provisioning details are
  // the technician's job (the customer cannot supply an M365 tenant domain).
  const pax8Staged = await stagePax8OrderFromQuote({
    quoteId: quote.id,
    orgId: quote.orgId,
    partnerId: quote.partnerId,
    contractIds,
    lines: lines.map((l) => ({
      id: l.id,
      catalogItemId: l.catalogItemId ?? null,
      quantity: l.quantity,
      recurrence: l.recurrence,
      customerVisible: l.customerVisible,
    })),
    actorUserId: params.actorUserId ?? null,
  });
```

Add `pax8OrderId: pax8Staged.orderId` to the returned object so the accept response can surface it, and extend the `AcceptQuoteResult` type accordingly. Update `emitAcceptInvoiceIssued`'s callers only if they destructure the result exhaustively (they don't — it takes a `Pick`, so no change is needed).

- [ ] **Step 5: Run both suites, plus the full quote suite** (this touches the accept path — regressions here break every quote):

```bash
cd apps/api && pnpm vitest run quote
cd apps/api && pnpm vitest run --config vitest.integration.config.ts quoteAcceptPax8Order
```
Expected: PASS, with no pre-existing quote test broken.

- [ ] **Step 6: Commit.** `git commit -m "feat(pax8): stage a Pax8 order on quote acceptance (in-transaction Phase 5)"`

---

## Task 7: Demote the nightly quantity push to drift detection

This changes shipped behavior. See the spec's "billing-truth problem".

**Files:**
- Modify: `apps/api/src/services/pax8SyncService.ts:232-265`
- Create: `apps/api/src/services/pax8Drift.ts`
- Test: `apps/api/src/services/pax8Drift.test.ts`
- Modify: `apps/api/src/services/pax8SyncService.test.ts` (the existing apply-links tests now assert the opposite)

**Interfaces:**
- Produces: `detectPax8Drift(integrationId: string): Promise<Pax8DriftRow[]>` where `Pax8DriftRow = { contractLineId: string; orgId: string; pax8SubscriptionId: string; productName: string | null; breezeQuantity: string; pax8Quantity: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// NOTE: applyEnabledPax8ContractLineLinks is RENAMED to
// recordPax8SubscriptionObservations in Step 3. Write the test against the new
// name; it will not compile until the rename lands, which is the point.
describe('recordPax8SubscriptionObservations', () => {
  it('NO LONGER writes contract_lines.manual_quantity', async () => {
    // Pax8's Subscription.quantity is stale and does not match what Pax8 invoices.
    // Breeze's order ledger is the source of truth. This sync must never write it.
    await recordPax8SubscriptionObservations('int-1');
    expect(contractLinesUpdateSpy).not.toHaveBeenCalled();
  });
});

describe('detectPax8Drift', () => {
  it('reports a link whose Pax8 quantity differs from the contract line', async () => {
    mockLink({ contractLineId: 'cl-1', manualQuantity: '5.00', snapshotQuantity: '8.00' });
    const drift = await detectPax8Drift('int-1');
    expect(drift).toEqual([expect.objectContaining({
      contractLineId: 'cl-1', breezeQuantity: '5.00', pax8Quantity: '8.00',
    })]);
  });

  it('reports nothing when they agree', async () => {
    mockLink({ contractLineId: 'cl-1', manualQuantity: '5.00', snapshotQuantity: '5.00' });
    expect(await detectPax8Drift('int-1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure** (the current implementation *does* write).

- [ ] **Step 3: Rewrite `applyEnabledPax8ContractLineLinks`**

Delete the `db.update(contractLines)` call entirely. Keep the link-row bookkeeping (`lastAppliedQuantity` / `lastAppliedAt` become "last *observed*") and rename the function to `recordPax8SubscriptionObservations`.

**Sweep every consumer of the renamed output before calling this done** — the `Pax8SyncResult` field rename (`appliedContractLines` → `observedContractLines`) is an output-contract change, and its readers live outside this file:

```bash
grep -rn "applyEnabledPax8ContractLineLinks\|appliedContractLines" apps/ packages/
```

Known call sites: `pax8SyncService.ts:317` (inside `syncPax8Integration`), the `Pax8SyncResult` interface at `pax8SyncService.ts:267-274`, `jobs/pax8SyncWorker.ts` (logs the counts), and `routes/pax8.ts` (`POST /sync` returns them to the UI). If `apps/web/src/components/integrations/Pax8Integration.tsx` renders the count, update it too.

Leave a comment at the top explaining *why*, in full:

```ts
/**
 * Records what Pax8 currently REPORTS for each linked subscription. It does NOT
 * write contract_lines.manual_quantity — that was the old behavior and it was a
 * billing bug: Pax8's API Subscription.quantity is stale and does not match the
 * seat counts Pax8 actually invoices the partner for, so every sync_enabled link
 * was feeding a wrong number into the contract billing sweep and out onto the
 * customer's invoice.
 *
 * Breeze's order ledger (pax8_orders / pax8_order_lines) is the source of truth
 * for billable quantity: we know what the customer has because every add, change,
 * and cancel went through us. Pax8 is now only a DRIFT DETECTOR — see
 * detectPax8Drift(), which surfaces the disagreement (someone changed seats in
 * the Pax8 portal, bypassing Breeze) instead of silently overwriting the bill.
 */
```

- [ ] **Step 4: Implement `detectPax8Drift`** in `pax8Drift.ts` — the same join the old function used, returning the rows where `contract_lines.manual_quantity IS DISTINCT FROM pax8_subscription_snapshots.quantity` rather than updating them.

- [ ] **Step 5: Expose it** — add `GET /api/v1/pax8/drift?integrationId=` to `routes/pax8Orders.ts` (read perm, no MFA).

- [ ] **Step 6: Run the full pax8 suite** — the existing `pax8SyncService.test.ts` assertions about applying quantities must be inverted, not deleted, so the regression stays pinned.

```bash
cd apps/api && pnpm vitest run pax8
```

- [ ] **Step 7: Commit.**

```bash
git commit -m "fix(pax8): stop billing customers off Pax8's stale subscription quantity

Pax8's API Subscription.quantity does not match the seat counts Pax8
invoices. The nightly sync was pushing it into contract_lines.manual_quantity,
which the contract billing sweep then invoiced the customer from. Breeze's
order ledger is now the source of truth; the sync only detects drift."
```

---

## Task 8: Web — the Pax8 tab on the org page

**Files:**
- Create: `apps/web/src/lib/api/pax8Orders.ts`
- Create: `apps/web/src/components/organizations/Pax8OrgTab.tsx`
- Create: `apps/web/src/components/organizations/Pax8OrderBuilder.tsx`
- Create: `apps/web/src/components/organizations/Pax8ProvisioningForm.tsx`
- Modify: the org detail page's tab registry (follow `DeviceDetails.tsx` — tabs key off `window.location.hash`, never a query param)
- Test: `apps/web/src/components/organizations/Pax8OrderBuilder.test.tsx`

All mutations go through `runAction` (`apps/web/src/lib/runAction.ts`) — the `no-silent-mutations` test enforces it.

The provisioning form renders from `GET /pax8/products/:id/provision-details`: `valueType: 'Input'` → text field; `'Single-Value'` → select over `possibleValues`; `'Multi-Value'` → multiselect. **Every field is optional in the UI** — requiredness is not discoverable from Pax8, so the form must not invent it. The Submit button runs the preflight first and renders Pax8's raw `details[]` inline against the offending line when it fails. That error text is the only reliable statement of what's missing.

The subscription list shows Breeze's ledger quantity as the primary number, the Pax8-reported quantity secondary, and a drift badge when they disagree.

- [ ] **Step 1: Write the failing component test** — assert that a `Single-Value` provisioning field renders a `<select>` with exactly its `possibleValues` as options, and that a preflight 422 renders the raw Pax8 message.
- [ ] **Step 2: Run — expect failure.** `cd apps/web && pnpm vitest run Pax8OrderBuilder`
- [ ] **Step 3: Implement the API client + components.**
- [ ] **Step 4: Run — expect pass.** Also run `cd apps/web && pnpm vitest run no-silent-mutations`.
- [ ] **Step 5: Commit.**

---

## Task 9: Web — surface the staged order on the accepted quote

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteDetail.tsx`
- Test: `apps/web/src/components/billing/quotes/QuoteDetail.test.tsx`

A converted quote with a staged Pax8 order shows a panel: *"This quote staged a Pax8 order (N items) awaiting provisioning details"* with a deep link to the org's Pax8 tab. That plus the org tab is the entire discoverability story — no notifications, no queue page. The customer is not waiting on it; the technician is the user.

- [ ] **Step 1: Failing test** — a converted quote with `pax8OrderId` renders the panel and the deep link; one without renders nothing.
- [ ] **Step 2: Run — expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect pass. Commit.**

---

## Task 10: Docs + release notes

**Files:**
- Modify: `apps/docs/src/content/docs/features/distributor-integrations.mdx`
- Modify: `apps/docs/src/content/docs/reference/api.mdx`

Document the ordering flow, and **call out the behavior change explicitly**: partners with `sync_enabled` Pax8 links will see contract-line quantities stop auto-updating from Pax8. That is intentional — Pax8's reported quantity does not match what Pax8 invoices, and Breeze's order ledger is now the source of truth. Drift is surfaced rather than silently applied.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Build the docs** — `cd apps/docs && pnpm build`. Expected: no broken links.
- [ ] **Step 3: Commit.**

---

## Follow-ups (NOT in this plan — file as issues)

1. **The `PROVISIONING` webhook receiver.** The only way to learn *why* an order is stuck. Cannot be spec'd from documentation — Pax8 publishes neither the topic strings nor the status enum, so `GET /webhooks/topic-definitions` must be called with live credentials first. `pax8_integrations.webhook_secret_encrypted` already exists, unused, for this.
2. **Confirm write permission on the Pax8 API key** with the Pax8 rep before Task 2 ships to production. A documented `403 "insufficient permissions"` exists and there is no way to tell in advance — this is the difference between working in test and 403ing in prod.
3. **Verify empirically whether `POST /v1/orders` returns `lineItems[].subscriptionId` synchronously** or null-until-provisioned. Two research passes disagreed. Task 4 handles both (a null falls to the nightly sync to fill in by product+company match), but the answer determines whether that fallback is dead code or load-bearing.
