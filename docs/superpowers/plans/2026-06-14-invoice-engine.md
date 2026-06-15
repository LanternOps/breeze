# Invoice Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Breeze Invoice Engine — MSP-bills-customer invoices assembled from time entries, ticket parts, catalog items, bundles, and manual lines, with a draft→sent→partially_paid→overdue→paid→void lifecycle, partial manual payments, async PDF, email, and a read-only customer portal view.

**Architecture:** Materialize-on-draft (source rows are snapshot-copied into `invoice_lines` immediately; lines are editable until issue, then frozen). All pricing flows through the shipped `catalogService.resolvePrice` / `computeBundleEconomics`. Service-layer-first: all logic in `invoiceService` + pure helpers; routes, AI tools, portal, and BullMQ jobs are thin consumers. RLS shape 1 (direct/denormalized `org_id`) on all three core tables; partner-axis sequence table for numbering.

**Tech Stack:** Hono + TypeScript (API), Drizzle ORM + PostgreSQL (RLS via `breeze_app`), BullMQ + Redis (events, PDF render, overdue sweep), Vitest (unit/RLS/integration), Zod (`@breeze/shared` validators), Astro + React islands (web), headless Chromium (PDF).

**Spec:** `docs/superpowers/specs/2026-06-14-invoice-engine-design.md`. **Program frame:** `docs/superpowers/specs/2026-06-14-billing-architecture-overview.md`.

**Branch note:** This work is on `docs/2026-06-14-invoice-engine-spec`, stacked on the catalog branch (`docs/2026-06-14-billing-catalog-spec`, PR #1365) because it imports `resolvePrice`, `computeBundleEconomics`, the `catalog_item_id` snapshot pattern, and catalog enums. Rebase onto `main` once #1365 merges.

**Environment reminders (this repo):**
- Prefix all `pnpm`/`vitest`/`tsx` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- API unit tests: `cd apps/api && PATH=… pnpm exec vitest run <path>` (NOT `pnpm test -- <path>`, which runs the whole suite).
- RLS/integration tests need a real DB (`DATABASE_URL`) and the gitignored `.env.test` symlink present in this worktree; confirm the DB role is **not** `BYPASSRLS` or forge tests pass vacuously.
- `@breeze/shared` has no build step — typecheck with `pnpm --filter @breeze/shared exec tsc --noEmit`.
- Migrations are applied by `autoMigrate` on API boot / test setup; there is no standalone `db:migrate`.

---

## File Structure

**Create:**
- `apps/api/src/db/schema/invoices.ts` — `invoices`, `invoiceLines`, `invoicePayments`, `partnerInvoiceSequences` tables + 3 enums.
- `apps/api/migrations/2026-06-14-b-invoice-engine.sql` — tables, indexes, RLS, FKs, org/partner column adds, permissions. (`-b-` infix: sorts after `2026-06-14-product-catalog.sql` / `2026-06-14-a-…`, so the catalog enums/tables it depends on exist first.)
- `apps/api/src/services/invoiceMath.ts` — pure money/tax/status helpers (no DB).
- `apps/api/src/services/invoiceMath.test.ts` — pure-logic unit tests.
- `apps/api/src/services/invoiceNumbers.ts` — partner-scoped number allocation + format.
- `apps/api/src/services/invoiceEvents.ts` — `emitInvoiceEvent` (fire-and-forget BullMQ).
- `apps/api/src/services/invoiceAssembly.ts` — org-run / per-ticket source-gathering queries.
- `apps/api/src/services/invoiceService.ts` — CRUD, lines, lifecycle, payments, status recompute (hub).
- `apps/api/src/services/invoiceService.test.ts` — service unit tests (mocked DB where pure; integration-tagged where not).
- `apps/api/src/services/invoicePdf.ts` — HTML→PDF render + artifact store.
- `apps/api/src/routes/invoices/{index.ts,invoices.ts,lifecycle.ts,payments.ts,assembly.ts,pdf.ts}` + `*.test.ts`.
- `apps/api/src/routes/portal/invoices.ts` + test.
- `apps/api/src/services/aiToolsBilling.ts` — light read tools.
- `apps/api/src/jobs/invoiceWorker.ts` — PDF render job + daily overdue sweep.
- `packages/shared/src/validators/invoices.ts` + `invoices.test.ts` — Zod schemas.
- `apps/web/src/...` — invoices list/editor/detail islands, org/partner billing settings, ticket button, portal invoice view (Phase 6 enumerates exact files).

**Modify:**
- `apps/api/src/db/schema/index.ts` — add `export * from './invoices';`.
- `apps/api/src/db/schema/orgs.ts` — add tax/billing-address columns to `organizations`, billing-config columns to `partners`.
- `apps/api/src/services/permissions.ts` — add `INVOICES_*` to `PERMISSIONS`.
- `apps/api/src/index.ts` — mount `invoiceRoutes`, mount portal invoice routes, init/shutdown `invoiceWorker`.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist `partner_invoice_sequences`; add forge tests for `invoices`/`invoice_lines`/`invoice_payments`.
- `apps/web/src/lib/runActionAllowlist.ts` — only if a typed/aggregate handler needs an exception (default: none).

**Type vocabulary (used consistently across all tasks):**
- `InvoiceActor = { userId: string; partnerId: string | null; accessibleOrgIds: string[] | null }` (mirrors `CatalogActor`).
- `InvoiceServiceError(message, status: 400|403|404|409, code?: InvoiceServiceErrorCode)`.
- `InvoiceStatus = 'draft'|'sent'|'partially_paid'|'overdue'|'paid'|'void'`.
- `InvoiceLineSourceType = 'time_entry'|'part'|'catalog'|'bundle'|'manual'|'contract'`.
- Money is always fixed-2-decimal **strings** (`'150.00'`), matching `numeric(12,2)`.

---

## Phase 1 — Schema, migration, RLS, permissions

Ships the data layer: four tables with RLS enforced, org/partner column additions, the `invoices` permission set, and forge tests proving tenant isolation. After this phase the DB is ready and `pnpm db:check-drift` is clean.

### Task 1.1: Drizzle schema for invoice tables

**Files:**
- Create: `apps/api/src/db/schema/invoices.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

Create `apps/api/src/db/schema/invoices.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void'
]);
export const invoiceLineSourceTypeEnum = pgEnum('invoice_line_source_type', [
  'time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract'
]);
export const paymentMethodEnum = pgEnum('payment_method', [
  'cash', 'check', 'bank_transfer', 'card', 'other'
]);

// Partial-index predicate helpers (real partial indexes created in SQL migration;
// drizzle-kit only needs these for drift detection).
function sqlNumberPresent(t: { invoiceNumber: unknown }): SQL {
  return sql`${t.invoiceNumber} IS NOT NULL`;
}
function sqlOpenForOverdue(t: { status: unknown }): SQL {
  return sql`${t.status} IN ('sent','partially_paid')`;
}

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // site_id FK created in SQL (ON DELETE SET NULL) to avoid an import cycle with sites.
  siteId: uuid('site_id'),
  invoiceNumber: varchar('invoice_number', { length: 40 }),
  status: invoiceStatusEnum('status').notNull().default('draft'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  issueDate: date('issue_date'),
  dueDate: date('due_date'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 6, scale: 3 }),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  amountPaid: numeric('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),
  balance: numeric('balance', { precision: 12, scale: 2 }).notNull().default('0'),
  billToName: varchar('bill_to_name', { length: 255 }),
  billToAddress: jsonb('bill_to_address'),
  billToTaxId: varchar('bill_to_tax_id', { length: 100 }),
  billToTaxExempt: boolean('bill_to_tax_exempt').notNull().default(false),
  notes: text('notes'),
  terms: text('terms'),
  sentAt: timestamp('sent_at'),
  firstViewedAt: timestamp('first_viewed_at'),
  viewedAt: timestamp('viewed_at'),
  paidAt: timestamp('paid_at'),
  markedOverdueAt: timestamp('marked_overdue_at'),
  voidedAt: timestamp('voided_at'),
  voidReason: text('void_reason'),
  // self-FKs created in SQL (ON DELETE SET NULL) to keep drizzle types simple
  replacesInvoiceId: uuid('replaces_invoice_id'),
  replacedByInvoiceId: uuid('replaced_by_invoice_id'),
  pdfDocumentRef: text('pdf_document_ref'),
  pdfSha256: char('pdf_sha256', { length: 64 }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('invoices_org_status_idx').on(t.orgId, t.status),
  index('invoices_partner_status_idx').on(t.partnerId, t.status),
  index('invoices_org_issue_date_idx').on(t.orgId, t.issueDate),
  index('invoices_due_overdue_idx').on(t.dueDate).where(sqlOpenForOverdue(t)),
  uniqueIndex('invoices_partner_number_uq').on(t.partnerId, t.invoiceNumber).where(sqlNumberPresent(t))
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: invoiceLineSourceTypeEnum('source_type').notNull(),
  // sourceId is polymorphic (time_entries|ticket_parts) — FK-by-convention, no DB FK.
  sourceId: uuid('source_id'),
  // catalog_item_id + ticket_id FKs created in SQL (ON DELETE SET NULL) to avoid coupling
  // issued-invoice history to catalog/ticket deletion and dodge import cycles.
  catalogItemId: uuid('catalog_item_id'),
  parentLineId: uuid('parent_line_id').references((): AnyPgColumn => invoiceLines.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id'),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 12, scale: 2 }),
  revenueAllocation: numeric('revenue_allocation', { precision: 12, scale: 2 }),
  taxable: boolean('taxable').notNull().default(false),
  customerVisible: boolean('customer_visible').notNull().default(true),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull().default('0'),
  isUnapprovedTime: boolean('is_unapproved_time').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('invoice_lines_invoice_sort_idx').on(t.invoiceId, t.sortOrder),
  index('invoice_lines_org_idx').on(t.orgId),
  index('invoice_lines_source_idx').on(t.sourceType, t.sourceId)
]);

export const invoicePayments = pgTable('invoice_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  method: paymentMethodEnum('method').notNull(),
  reference: varchar('reference', { length: 255 }),
  receivedAt: date('received_at').notNull(),
  recordedBy: uuid('recorded_by').references(() => users.id),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('invoice_payments_invoice_idx').on(t.invoiceId),
  index('invoice_payments_org_idx').on(t.orgId)
]);

export const partnerInvoiceSequences = pgTable('partner_invoice_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.partnerId, t.year] })
]);
```

- [ ] **Step 2: Register the schema file**

In `apps/api/src/db/schema/index.ts`, add after the existing `export * from './timeTracking';` line:

```ts
export * from './invoices';
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS (no new errors from `invoices.ts`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/invoices.ts apps/api/src/db/schema/index.ts
git commit -m "feat(invoices): drizzle schema for invoice engine tables"
```

### Task 1.2: Org & partner billing columns (schema)

**Files:**
- Modify: `apps/api/src/db/schema/orgs.ts`

- [ ] **Step 1: Add columns to `organizations`**

In `apps/api/src/db/schema/orgs.ts`, inside the `organizations` pgTable definition, add these columns after `billingContact: jsonb('billing_contact'),`:

```ts
  taxId: varchar('tax_id', { length: 100 }),
  taxExempt: boolean('tax_exempt').notNull().default(false),
  taxRate: numeric('tax_rate', { precision: 6, scale: 3 }),
  billingAddressLine1: varchar('billing_address_line1', { length: 255 }),
  billingAddressLine2: varchar('billing_address_line2', { length: 255 }),
  billingAddressCity: varchar('billing_address_city', { length: 120 }),
  billingAddressRegion: varchar('billing_address_region', { length: 120 }),
  billingAddressPostalCode: varchar('billing_address_postal_code', { length: 40 }),
  billingAddressCountry: char('billing_address_country', { length: 2 }),
```

- [ ] **Step 2: Add columns to `partners`**

In the same file, inside the `partners` pgTable, add after `stripeCustomerId: text('stripe_customer_id'),`:

```ts
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  defaultTaxRate: numeric('default_tax_rate', { precision: 6, scale: 3 }),
  invoiceNumberPrefix: varchar('invoice_number_prefix', { length: 12 }).notNull().default('INV'),
  invoiceTermsDays: integer('invoice_terms_days').notNull().default(30),
  invoiceFooter: text('invoice_footer'),
```

- [ ] **Step 3: Ensure imports**

Confirm `apps/api/src/db/schema/orgs.ts` imports `numeric` and `char` from `drizzle-orm/pg-core` (the first line of `orgs.ts` is a single destructured import — add `numeric, char` to it if absent). `varchar, boolean, integer, text, jsonb` are already imported.

- [ ] **Step 4: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/db/schema/orgs.ts
git commit -m "feat(invoices): tax/billing columns on organizations + partners"
```

### Task 1.3: SQL migration — tables, indexes, RLS, FKs

**Files:**
- Create: `apps/api/migrations/2026-06-14-b-invoice-engine.sql`

- [ ] **Step 1: Write the migration — enums, tables, indexes**

Create `apps/api/migrations/2026-06-14-b-invoice-engine.sql`:

```sql
-- Invoice Engine (billing program sub-project 2). Idempotent throughout.
-- Depends on catalog enums/tables from 2026-06-14-product-catalog.sql (sorts first).

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft','sent','partially_paid','overdue','paid','void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invoice_line_source_type AS ENUM ('time_entry','part','catalog','bundle','manual','contract');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash','check','bank_transfer','card','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  site_id UUID,
  invoice_number VARCHAR(40),
  status invoice_status NOT NULL DEFAULT 'draft',
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  issue_date DATE,
  due_date DATE,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,3),
  tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  bill_to_name VARCHAR(255),
  bill_to_address JSONB,
  bill_to_tax_id VARCHAR(100),
  bill_to_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  terms TEXT,
  sent_at TIMESTAMP,
  first_viewed_at TIMESTAMP,
  viewed_at TIMESTAMP,
  paid_at TIMESTAMP,
  marked_overdue_at TIMESTAMP,
  voided_at TIMESTAMP,
  void_reason TEXT,
  replaces_invoice_id UUID,
  replaced_by_invoice_id UUID,
  pdf_document_ref TEXT,
  pdf_sha256 CHAR(64),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- self / cross-table FKs (SQL-only to avoid drizzle import cycles)
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_replaces_fkey
    FOREIGN KEY (replaces_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_replaced_by_fkey
    FOREIGN KEY (replaced_by_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS invoices_org_status_idx ON invoices (org_id, status);
CREATE INDEX IF NOT EXISTS invoices_partner_status_idx ON invoices (partner_id, status);
CREATE INDEX IF NOT EXISTS invoices_org_issue_date_idx ON invoices (org_id, issue_date);
CREATE INDEX IF NOT EXISTS invoices_due_overdue_idx ON invoices (due_date)
  WHERE status IN ('sent','partially_paid');
CREATE UNIQUE INDEX IF NOT EXISTS invoices_partner_number_uq ON invoices (partner_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_type invoice_line_source_type NOT NULL,
  source_id UUID,
  catalog_item_id UUID,
  parent_line_id UUID REFERENCES invoice_lines(id) ON DELETE CASCADE,
  ticket_id UUID,
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  cost_basis NUMERIC(12,2),
  revenue_allocation NUMERIC(12,2),
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_unapproved_time BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_catalog_item_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_ticket_fkey
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_sort_idx ON invoice_lines (invoice_id, sort_order);
CREATE INDEX IF NOT EXISTS invoice_lines_org_idx ON invoice_lines (org_id);
CREATE INDEX IF NOT EXISTS invoice_lines_source_idx ON invoice_lines (source_type, source_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method payment_method NOT NULL,
  reference VARCHAR(255),
  received_at DATE NOT NULL,
  recorded_by UUID REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_payments_org_idx ON invoice_payments (org_id);

CREATE TABLE IF NOT EXISTS partner_invoice_sequences (
  partner_id UUID NOT NULL REFERENCES partners(id),
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, year)
);
```

- [ ] **Step 2: Append RLS — invoices, invoice_lines, invoice_payments (shape 1 org-axis)**

Append to the same migration file:

```sql
-- RLS: shape 1 (direct/denormalized org_id) on the three core tables.
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoices;
CREATE POLICY breeze_org_isolation_select ON invoices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoices
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_lines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_lines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_lines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_lines;
CREATE POLICY breeze_org_isolation_select ON invoice_lines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_lines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_lines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_lines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_payments;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_payments;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_payments;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_payments;
CREATE POLICY breeze_org_isolation_select ON invoice_payments
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_payments
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_payments
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_payments
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- RLS: partner_invoice_sequences is partner-axis (shape 3), system bypass for allocation.
ALTER TABLE partner_invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_invoice_sequences FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY partner_invoice_sequences_partner_access ON partner_invoice_sequences
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 3: Append org/partner column adds**

Append:

```sql
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_id VARCHAR(100);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,3);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_line1 VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_line2 VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_city VARCHAR(120);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_region VARCHAR(120);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_postal_code VARCHAR(40);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_country CHAR(2);

ALTER TABLE partners ADD COLUMN IF NOT EXISTS currency_code CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_tax_rate NUMERIC(6,3);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_number_prefix VARCHAR(12) NOT NULL DEFAULT 'INV';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_terms_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_footer TEXT;
```

- [ ] **Step 4: Append permission rows + role grant (guarded)**

Append (mirrors the catalog grant idiom — grant read/write/send/export to partner-scope system roles that already hold `tickets:write`):

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'read', 'View invoices, lines, and payments');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'write', 'Create/edit/delete draft invoices and lines, run assembly');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'send') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'send', 'Issue, send, void invoices and record payments');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'export') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'export', 'Download invoice PDF/CSV');
  END IF;
END $$;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'invoices' AND p2.action IN ('read','write','send','export')
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
```

- [ ] **Step 5: Apply the migration & verify no drift**

Run (applies pending migrations via the autoMigrate path, then checks drift):
```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/invoice-engine-spec
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec tsx src/db/runMigrations.ts 2>/dev/null || true
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
```
Expected: drift check reports **no drift** between `apps/api/src/db/schema/*` and the migrated DB. (If `runMigrations.ts` doesn't exist, boot the API once against the dev DB — autoMigrate applies the file — then re-run `db:check-drift`.)

- [ ] **Step 6: Verify migration ordering regression test passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (confirms `2026-06-14-b-invoice-engine.sql` sorts after the catalog migration).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-06-14-b-invoice-engine.sql
git commit -m "feat(invoices): migration — tables, RLS, FKs, billing columns, permissions"
```

### Task 1.4: RLS coverage allowlist + forge tests

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Allowlist the partner-axis sequence table**

`invoices`, `invoice_lines`, `invoice_payments` are shape-1 (direct `org_id`) and auto-discovered — do **not** add them to any allowlist. Only `partner_invoice_sequences` needs allowlisting. In the `PARTNER_TENANT_TABLES` map, add after `['partner_ticket_sequences', 'partner_id'],`:

```ts
  ['partner_invoice_sequences', 'partner_id'],
```

- [ ] **Step 2: Write a failing forge test for cross-org invoice insert**

Add a new `describe` block (near the other forge tests). It seeds one partner + two orgs, then asserts org B cannot insert an invoice carrying org A's `org_id`:

```ts
describe('invoices RLS forge (shape 1, org-axis)', () => {
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
        name: `RLS Invoices Partner ${runSuffix}`, slug: `rls-invoices-${runSuffix}`,
        type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for invoices forge');
      partnerId = partner.id;
      const [orgA, orgB] = await db.insert(organizations).values([
        { partnerId: partner.id, name: 'RLS Invoices Org A', slug: `rls-inv-a-${runSuffix}` },
        { partnerId: partner.id, name: 'RLS Invoices Org B', slug: `rls-inv-b-${runSuffix}` }
      ]).returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for invoices forge');
      orgAId = orgA.id; orgBId = orgB.id;
    });
  }

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(invoices).values({ partnerId, orgId: orgAId, status: 'draft' })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "invoices"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's invoice", async () => {
    await ensureFixtures();
    let createdId = '';
    await withSystemDbAccessContext(async () => {
      const [inv] = await db.insert(invoices).values({ partnerId, orgId: orgAId, status: 'draft' }).returning({ id: invoices.id });
      createdId = inv!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, createdId))
    );
    expect(visible).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Ensure imports**

At the top of the test file, confirm `invoices` is imported from the schema (the file already imports `partners`, `organizations`, `db`, `withSystemDbAccessContext`, `withDbAccessContext`, `eq`). Add `invoices` to the schema import if missing.

- [ ] **Step 4: Run the forge tests + full coverage contract test**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" \
  pnpm exec vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — the coverage scan finds RLS on all three new shape-1 tables, the sequence table is allowlisted, and both forge cases pass (cross-org insert rejected, cross-org select empty). If a forge case passes vacuously, confirm the DB role is not `BYPASSRLS` (`SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;` must be false) and the `.env.test` symlink exists.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(invoices): RLS coverage allowlist + cross-org forge tests"
```

---

## Phase 2 — Pure money/tax/status logic + validators

Pure functions with zero DB access (fast unit tests, the math the whole engine relies on) and the shared Zod validators. TDD throughout.

### Task 2.1: Money & line-total helpers

**Files:**
- Create: `apps/api/src/services/invoiceMath.ts`
- Test: `apps/api/src/services/invoiceMath.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/services/invoiceMath.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeLineTotal, computeInvoiceTotals, resolveEffectiveTaxRate, deriveInvoiceStatus } from './invoiceMath';

describe('computeLineTotal', () => {
  it('rounds half-up to cents', () => {
    expect(computeLineTotal('1.5', '150')).toBe('225.00');
    expect(computeLineTotal('3', '0.335')).toBe('1.01'); // 1.005 -> half-up 1.01
  });
  it('handles zero', () => {
    expect(computeLineTotal('0', '99.99')).toBe('0.00');
  });
});

describe('computeInvoiceTotals', () => {
  it('sums customer-visible lines and applies tax to taxable visible lines', () => {
    const lines = [
      { lineTotal: '100.00', taxable: true, customerVisible: true },
      { lineTotal: '50.00', taxable: false, customerVisible: true },
      { lineTotal: '999.00', taxable: true, customerVisible: false } // hidden bundle child — excluded
    ];
    const t = computeInvoiceTotals(lines, '0.085'); // 8.5%
    expect(t.subtotal).toBe('150.00');
    expect(t.taxTotal).toBe('8.50');  // 100.00 * 0.085
    expect(t.total).toBe('158.50');
  });
  it('zero tax rate yields zero tax', () => {
    const t = computeInvoiceTotals([{ lineTotal: '100.00', taxable: true, customerVisible: true }], null);
    expect(t.taxTotal).toBe('0.00');
    expect(t.total).toBe('100.00');
  });
});

describe('resolveEffectiveTaxRate', () => {
  it('exempt overrides everything', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: true, orgRate: '0.1', partnerRate: '0.2' })).toBe('0.000');
  });
  it('org rate beats partner rate', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: '0.075', partnerRate: '0.2' })).toBe('0.075');
  });
  it('falls back to partner then zero', () => {
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: null, partnerRate: '0.2' })).toBe('0.200');
    expect(resolveEffectiveTaxRate({ taxExempt: false, orgRate: null, partnerRate: null })).toBe('0.000');
  });
});

describe('deriveInvoiceStatus', () => {
  const asOf = new Date('2026-06-14T00:00:00Z');
  it('void wins', () => {
    expect(deriveInvoiceStatus({ voided: true, issued: true, total: '100', amountPaid: '0', dueDate: null, asOf })).toBe('void');
  });
  it('not issued is draft', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: false, total: '0', amountPaid: '0', dueDate: null, asOf })).toBe('draft');
  });
  it('balance<=0 is paid', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '100', dueDate: '2026-01-01', asOf })).toBe('paid');
  });
  it('past due with balance is overdue (precedence over partial)', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '40', dueDate: '2026-06-01', asOf })).toBe('overdue');
  });
  it('partial when paid>0 and not past due', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '40', dueDate: '2026-12-01', asOf })).toBe('partially_paid');
  });
  it('sent when issued and nothing paid and not past due', () => {
    expect(deriveInvoiceStatus({ voided: false, issued: true, total: '100', amountPaid: '0', dueDate: '2026-12-01', asOf })).toBe('sent');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceMath.test.ts`
Expected: FAIL ("Cannot find module './invoiceMath'").

- [ ] **Step 3: Implement `invoiceMath.ts`**

Create `apps/api/src/services/invoiceMath.ts`:

```ts
import type { InvoiceStatus } from './invoiceTypes';

// Local cents helpers (same contract as catalogPricing.ts; kept local to avoid
// cross-service coupling). Round-half-up at the cent boundary.
function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return Math.round(Number(v) * 100);
}
function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
// Round-half-up of a fractional cent amount.
function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

export function computeLineTotal(quantity: string, unitPrice: string): string {
  // quantity * unitPrice, both up to 2dp; compute in fractional cents then round half-up.
  const fractionalCents = Number(quantity) * toCents(unitPrice);
  return fromCents(roundHalfUp(fractionalCents));
}

export interface TotalsLine {
  lineTotal: string;
  taxable: boolean;
  customerVisible: boolean;
}

export function computeInvoiceTotals(
  lines: TotalsLine[],
  taxRate: string | null
): { subtotal: string; taxTotal: string; total: string } {
  let subtotalCents = 0;
  let taxableCents = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    const c = toCents(l.lineTotal);
    subtotalCents += c;
    if (l.taxable) taxableCents += c;
  }
  const rate = taxRate ? Number(taxRate) : 0;
  const taxCents = roundHalfUp(taxableCents * rate);
  const totalCents = subtotalCents + taxCents;
  return { subtotal: fromCents(subtotalCents), taxTotal: fromCents(taxCents), total: fromCents(totalCents) };
}

export function resolveEffectiveTaxRate(input: {
  taxExempt: boolean;
  orgRate: string | null;
  partnerRate: string | null;
}): string {
  if (input.taxExempt) return '0.000';
  const rate = input.orgRate ?? input.partnerRate ?? '0';
  return Number(rate).toFixed(3);
}

export function deriveInvoiceStatus(input: {
  voided: boolean;
  issued: boolean;
  total: string;
  amountPaid: string;
  dueDate: string | null; // ISO date
  asOf: Date;
}): InvoiceStatus {
  if (input.voided) return 'void';
  if (!input.issued) return 'draft';
  const balanceCents = toCents(input.total) - toCents(input.amountPaid);
  if (balanceCents <= 0) return 'paid';
  const pastDue = input.dueDate !== null && new Date(input.dueDate + 'T23:59:59Z').getTime() < input.asOf.getTime();
  if (pastDue) return 'overdue';
  if (toCents(input.amountPaid) > 0) return 'partially_paid';
  return 'sent';
}
```

- [ ] **Step 4: Add the shared `InvoiceStatus` type module**

Create `apps/api/src/services/invoiceTypes.ts`:

```ts
export type InvoiceStatus =
  | 'draft' | 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void';
export type InvoiceLineSourceType =
  | 'time_entry' | 'part' | 'catalog' | 'bundle' | 'manual' | 'contract';
export type PaymentMethod =
  | 'cash' | 'check' | 'bank_transfer' | 'card' | 'other';

export interface InvoiceActor {
  userId: string;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
}

export type InvoiceServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ORG_DENIED'
  | 'INVOICE_NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'NOTHING_TO_INVOICE'
  | 'NO_VISIBLE_LINES'
  | 'SOURCE_ALREADY_BILLED'
  | 'OVERPAYMENT'
  | 'INVALID_STATE'
  | 'LINE_NOT_FOUND';

export class InvoiceServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
    public code?: InvoiceServiceErrorCode
  ) {
    super(message);
    this.name = 'InvoiceServiceError';
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceMath.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/invoiceMath.ts apps/api/src/services/invoiceMath.test.ts apps/api/src/services/invoiceTypes.ts
git commit -m "feat(invoices): pure money/tax/status helpers (TDD)"
```

### Task 2.2: Shared Zod validators

**Files:**
- Create: `packages/shared/src/validators/invoices.ts`
- Test: `packages/shared/src/validators/invoices.test.ts`
- Modify: `packages/shared/src/index.ts` (or the validators barrel — match how `catalog` validators are exported)

- [ ] **Step 1: Write failing validator tests**

Create `packages/shared/src/validators/invoices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  assembleFromOrgSchema, manualLineSchema, recordPaymentSchema,
  partnerBillingSettingsSchema, orgBillingSettingsSchema
} from './invoices';

describe('assembleFromOrgSchema', () => {
  it('accepts a valid org-run window', () => {
    const r = assembleFromOrgSchema.safeParse({ orgId: '11111111-1111-1111-1111-111111111111', from: '2026-06-01', to: '2026-06-30' });
    expect(r.success).toBe(true);
  });
  it('rejects missing orgId', () => {
    expect(assembleFromOrgSchema.safeParse({ from: '2026-06-01', to: '2026-06-30' }).success).toBe(false);
  });
});

describe('manualLineSchema', () => {
  it('requires positive quantity and non-negative price at 2dp', () => {
    expect(manualLineSchema.safeParse({ description: 'Onsite', quantity: 1, unitPrice: 150, taxable: false }).success).toBe(true);
    expect(manualLineSchema.safeParse({ description: 'x', quantity: -1, unitPrice: 1, taxable: false }).success).toBe(false);
    expect(manualLineSchema.safeParse({ description: 'x', quantity: 1, unitPrice: 1.005, taxable: false }).success).toBe(false);
  });
});

describe('recordPaymentSchema', () => {
  it('requires positive amount and a method', () => {
    expect(recordPaymentSchema.safeParse({ amount: 50, method: 'check', receivedAt: '2026-06-14' }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ amount: 0, method: 'check', receivedAt: '2026-06-14' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: 50, method: 'crypto', receivedAt: '2026-06-14' }).success).toBe(false);
  });
});

describe('partnerBillingSettingsSchema', () => {
  it('accepts currency, tax rate, prefix, terms', () => {
    expect(partnerBillingSettingsSchema.safeParse({ currencyCode: 'USD', defaultTaxRate: 0.085, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/validators/invoices.test.ts`
Expected: FAIL ("Cannot find module './invoices'").

- [ ] **Step 3: Implement validators**

Create `packages/shared/src/validators/invoices.ts`:

```ts
import { z } from 'zod';

const money = z.number().nonnegative().multipleOf(0.01);
const positiveQty = z.number().positive().multipleOf(0.01);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const taxRate = z.number().min(0).max(1); // fraction, e.g. 0.085

export const assembleFromOrgSchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  from: isoDate,
  to: isoDate
});

export const manualLineSchema = z.object({
  description: z.string().min(1).max(2000),
  quantity: positiveQty,
  unitPrice: money,
  taxable: z.boolean(),
  costBasis: money.optional()
});

export const catalogLineSchema = z.object({
  catalogItemId: z.string().uuid(),
  quantity: positiveQty
});

export const bundleLineSchema = z.object({
  bundleId: z.string().uuid(),
  quantity: positiveQty
});

export const updateLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional()
});

export const createManualInvoiceSchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  notes: z.string().max(5000).optional()
});

export const updateInvoiceSchema = z.object({
  notes: z.string().max(5000).optional(),
  siteId: z.string().uuid().nullable().optional(),
  dueDate: isoDate.optional()
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive().multipleOf(0.01),
  method: z.enum(['cash', 'check', 'bank_transfer', 'card', 'other']),
  reference: z.string().max(255).optional(),
  receivedAt: isoDate,
  note: z.string().max(2000).optional()
});

export const voidInvoiceSchema = z.object({
  reason: z.string().min(1).max(2000),
  reissue: z.boolean().optional()
});

export const listInvoicesQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional()
});

export const partnerBillingSettingsSchema = z.object({
  currencyCode: z.string().length(3),
  defaultTaxRate: taxRate.nullable().optional(),
  invoiceNumberPrefix: z.string().min(1).max(12),
  invoiceTermsDays: z.number().int().min(0).max(365),
  invoiceFooter: z.string().max(5000).nullable().optional()
});

export const orgBillingSettingsSchema = z.object({
  taxId: z.string().max(100).nullable().optional(),
  taxExempt: z.boolean().optional(),
  taxRate: taxRate.nullable().optional(),
  billingAddressLine1: z.string().max(255).nullable().optional(),
  billingAddressLine2: z.string().max(255).nullable().optional(),
  billingAddressCity: z.string().max(120).nullable().optional(),
  billingAddressRegion: z.string().max(120).nullable().optional(),
  billingAddressPostalCode: z.string().max(40).nullable().optional(),
  billingAddressCountry: z.string().length(2).nullable().optional()
});

export type AssembleFromOrgInput = z.infer<typeof assembleFromOrgSchema>;
export type ManualLineInput = z.infer<typeof manualLineSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type PartnerBillingSettingsInput = z.infer<typeof partnerBillingSettingsSchema>;
export type OrgBillingSettingsInput = z.infer<typeof orgBillingSettingsSchema>;
```

- [ ] **Step 4: Export from the shared barrel**

In `packages/shared/src/index.ts` (or wherever `./validators/catalog` is re-exported — grep for `validators/catalog`), add alongside it:

```ts
export * from './validators/invoices';
```

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/validators/invoices.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec tsc --noEmit
```
Expected: tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/invoices.ts packages/shared/src/validators/invoices.test.ts packages/shared/src/index.ts
git commit -m "feat(invoices): shared zod validators (TDD)"
```

---

## Phase 3 — invoiceService: numbering, events, assembly, lines, lifecycle, payments

The engine core. After this phase, invoices can be assembled, edited, issued (with gapless numbering + double-bill protection), paid (partial), and voided/reissued — all behind the service layer, with status kept correct by a single recompute function.

**Spec gap resolved here:** the spec §3.1 says part lines snapshot `taxable`, but `ticket_parts` has no `taxable` column. Resolution for v1: **part lines default `taxable = true`** (materials are typically taxable); labor (time-entry) lines are `taxable = false`. Catalog/bundle/manual lines carry their resolved/entered `taxable`. (A future `ticket_parts.taxable` column can refine this without schema churn on invoices.)

### Task 3.1: Partner-scoped invoice numbering

**Files:**
- Create: `apps/api/src/services/invoiceNumbers.ts`
- Test: `apps/api/src/services/invoiceNumbers.test.ts`

- [ ] **Step 1: Write failing format test**

Create `apps/api/src/services/invoiceNumbers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatInvoiceNumber } from './invoiceNumbers';

describe('formatInvoiceNumber', () => {
  it('zero-pads to 4 digits with prefix and year', () => {
    expect(formatInvoiceNumber('INV', 2026, 1)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber('ACME', 2026, 1234)).toBe('ACME-2026-1234');
  });
  it('does not truncate counters beyond 4 digits', () => {
    expect(formatInvoiceNumber('INV', 2026, 12345)).toBe('INV-2026-12345');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceNumbers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `invoiceNumbers.ts`**

Mirrors `ticketNumbers.ts` (race-safe `INSERT … ON CONFLICT … DO UPDATE … RETURNING` in a system-scope context, outside the request tx — see that file for the rationale comment).

```ts
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';

export function formatInvoiceNumber(prefix: string, year: number, counter: number): string {
  return `${prefix}-${year}-${String(counter).padStart(4, '0')}`;
}

/**
 * Allocate the next partner-scoped invoice counter for `year`. Race-safe via
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING. Runs in a system-scope context
 * outside the caller's request transaction (partner_invoice_sequences is
 * partner-axis; an org-scoped request context can't satisfy its RLS policy, and
 * gaps from a failed issue are harmless).
 */
export async function allocateInvoiceCounter(partnerId: string, year: number): Promise<number> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO partner_invoice_sequences (partner_id, year, counter)
        VALUES (${partnerId}, ${year}, 1)
        ON CONFLICT (partner_id, year)
        DO UPDATE SET counter = partner_invoice_sequences.counter + 1
        RETURNING counter
      `)
    )
  );
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) throw new Error('Failed to allocate invoice number');
  return counter;
}
```

> Confirm the exact import path/name of `withSystemDbAccessContext` / `runOutsideDbContext` against `apps/api/src/db/index.ts` (catalog/ticketNumbers import them from `../db`). Match whatever `ticketNumbers.ts` imports.

- [ ] **Step 4: Run format test (passes) + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceNumbers.test.ts`
Expected: PASS (the format test; `allocateInvoiceCounter` is covered by the issue integration test in Task 3.6).

```bash
git add apps/api/src/services/invoiceNumbers.ts apps/api/src/services/invoiceNumbers.test.ts
git commit -m "feat(invoices): partner-scoped invoice number allocation"
```

### Task 3.2: Invoice lifecycle events

**Files:**
- Create: `apps/api/src/services/invoiceEvents.ts`

- [ ] **Step 1: Implement `invoiceEvents.ts`** (mirror `catalogEvents.ts` / `timeEntryEvents.ts` exactly — fire-and-forget, never throws)

```ts
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../jobs/bullConnection';
import { captureException } from '../lib/sentry';

export type InvoiceEvent =
  | { type: 'invoice.issued' | 'invoice.sent' | 'invoice.viewed' | 'invoice.overdue' | 'invoice.paid' | 'invoice.voided'; invoiceId: string; orgId: string; partnerId: string; actorUserId?: string }
  | { type: 'payment.recorded' | 'payment.voided'; invoiceId: string; orgId: string; partnerId: string; paymentId: string; actorUserId?: string };

const INVOICE_EVENTS_QUEUE = 'invoice-events';
let queue: Queue | null = null;
function getInvoiceEventsQueue(): Queue {
  if (!queue) queue = new Queue(INVOICE_EVENTS_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function emitInvoiceEvent(event: InvoiceEvent): Promise<void> {
  try {
    await getInvoiceEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[InvoiceEvents] failed to enqueue', event.type, `invoiceId=${event.invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
```

> Verify the exact import paths for `getBullMQConnection` and `captureException` against `catalogEvents.ts` in this repo; copy them verbatim from there (they may live at slightly different paths).

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/invoiceEvents.ts
git commit -m "feat(invoices): lifecycle event emitter"
```

### Task 3.3: Assembly source-gathering

**Files:**
- Create: `apps/api/src/services/invoiceAssembly.ts`
- Test: `apps/api/src/services/invoiceAssembly.test.ts`

Produces an array of **draft line specs** (not DB rows) from unbilled billable source rows. Pure shaping over query results, so the row-mapping is unit-testable in isolation from DB via an exported pure mapper.

- [ ] **Step 1: Write failing tests for the pure mappers**

Create `apps/api/src/services/invoiceAssembly.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { timeEntryToLineSpec, ticketPartToLineSpec } from './invoiceAssembly';

describe('timeEntryToLineSpec', () => {
  it('converts minutes to hours and computes line total; flags unapproved; non-taxable', () => {
    const spec = timeEntryToLineSpec({
      id: 'te1', ticketId: 'tk1', description: 'Onsite repair',
      durationMinutes: 90, hourlyRate: '120.00', isApproved: false
    });
    expect(spec).toMatchObject({
      sourceType: 'time_entry', sourceId: 'te1', ticketId: 'tk1',
      description: 'Onsite repair', quantity: '1.50', unitPrice: '120.00',
      taxable: false, customerVisible: true, lineTotal: '180.00', isUnapprovedTime: true
    });
  });
  it('defaults description and rate', () => {
    const spec = timeEntryToLineSpec({ id: 'te2', ticketId: null, description: null, durationMinutes: 0, hourlyRate: null, isApproved: true });
    expect(spec.description).toBe('Labor');
    expect(spec.unitPrice).toBe('0.00');
    expect(spec.lineTotal).toBe('0.00');
    expect(spec.isUnapprovedTime).toBe(false);
  });
});

describe('ticketPartToLineSpec', () => {
  it('maps qty/price/cost; parts are taxable by default', () => {
    const spec = ticketPartToLineSpec({
      id: 'p1', ticketId: 'tk1', catalogItemId: 'c1', description: 'SSD 1TB',
      quantity: '2', unitPrice: '95.00', costBasis: '60.00'
    });
    expect(spec).toMatchObject({
      sourceType: 'part', sourceId: 'p1', ticketId: 'tk1', catalogItemId: 'c1',
      description: 'SSD 1TB', quantity: '2', unitPrice: '95.00', costBasis: '60.00',
      taxable: true, customerVisible: true, lineTotal: '190.00', isUnapprovedTime: false
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceAssembly.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `invoiceAssembly.ts`**

```ts
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import { timeEntries, ticketParts } from '../db/schema';
import { computeLineTotal } from './invoiceMath';
import type { InvoiceLineSourceType } from './invoiceTypes';

export interface DraftLineSpec {
  sourceType: InvoiceLineSourceType;
  sourceId: string | null;
  catalogItemId: string | null;
  ticketId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  costBasis: string | null;
  taxable: boolean;
  customerVisible: boolean;
  lineTotal: string;
  isUnapprovedTime: boolean;
}

export function timeEntryToLineSpec(r: {
  id: string; ticketId: string | null; description: string | null;
  durationMinutes: number | null; hourlyRate: string | null; isApproved: boolean;
}): DraftLineSpec {
  const hours = ((r.durationMinutes ?? 0) / 60).toFixed(2);
  const unitPrice = r.hourlyRate != null ? Number(r.hourlyRate).toFixed(2) : '0.00';
  return {
    sourceType: 'time_entry', sourceId: r.id, catalogItemId: null, ticketId: r.ticketId,
    description: r.description?.trim() || 'Labor',
    quantity: hours, unitPrice, costBasis: null, taxable: false, customerVisible: true,
    lineTotal: computeLineTotal(hours, unitPrice), isUnapprovedTime: !r.isApproved
  };
}

export function ticketPartToLineSpec(r: {
  id: string; ticketId: string | null; catalogItemId: string | null; description: string;
  quantity: string; unitPrice: string; costBasis: string | null;
}): DraftLineSpec {
  return {
    sourceType: 'part', sourceId: r.id, catalogItemId: r.catalogItemId, ticketId: r.ticketId,
    description: r.description,
    quantity: r.quantity, unitPrice: r.unitPrice, costBasis: r.costBasis ?? null,
    taxable: true, customerVisible: true,
    lineTotal: computeLineTotal(r.quantity, r.unitPrice), isUnapprovedTime: false
  };
}

/** Unbilled billable time entries for an org within [from, to] (by ended_at). */
export async function gatherOrgTimeEntries(orgId: string, from: Date, to: Date): Promise<DraftLineSpec[]> {
  const rows = await db.select({
    id: timeEntries.id, ticketId: timeEntries.ticketId, description: timeEntries.description,
    durationMinutes: timeEntries.durationMinutes, hourlyRate: timeEntries.hourlyRate, isApproved: timeEntries.isApproved
  }).from(timeEntries).where(and(
    eq(timeEntries.orgId, orgId),
    eq(timeEntries.isBillable, true),
    eq(timeEntries.billingStatus, 'not_billed'),
    sql`${timeEntries.endedAt} IS NOT NULL`,
    gte(timeEntries.endedAt, from),
    lte(timeEntries.endedAt, to)
  ));
  return rows.map(timeEntryToLineSpec);
}

/** Unbilled billable ticket parts for an org within [from, to] (by created_at). */
export async function gatherOrgParts(orgId: string, from: Date, to: Date): Promise<DraftLineSpec[]> {
  const rows = await db.select({
    id: ticketParts.id, ticketId: ticketParts.ticketId, catalogItemId: ticketParts.catalogItemId,
    description: ticketParts.description, quantity: ticketParts.quantity, unitPrice: ticketParts.unitPrice, costBasis: ticketParts.costBasis
  }).from(ticketParts).where(and(
    eq(ticketParts.orgId, orgId),
    eq(ticketParts.isBillable, true),
    eq(ticketParts.billingStatus, 'not_billed'),
    gte(ticketParts.createdAt, from),
    lte(ticketParts.createdAt, to)
  ));
  return rows.map(ticketPartToLineSpec);
}

/** Per-ticket: all unbilled billable time + parts for one ticket. */
export async function gatherTicketBillables(ticketId: string): Promise<DraftLineSpec[]> {
  const te = await db.select({
    id: timeEntries.id, ticketId: timeEntries.ticketId, description: timeEntries.description,
    durationMinutes: timeEntries.durationMinutes, hourlyRate: timeEntries.hourlyRate, isApproved: timeEntries.isApproved
  }).from(timeEntries).where(and(
    eq(timeEntries.ticketId, ticketId), eq(timeEntries.isBillable, true), eq(timeEntries.billingStatus, 'not_billed'),
    sql`${timeEntries.endedAt} IS NOT NULL`
  ));
  const parts = await db.select({
    id: ticketParts.id, ticketId: ticketParts.ticketId, catalogItemId: ticketParts.catalogItemId,
    description: ticketParts.description, quantity: ticketParts.quantity, unitPrice: ticketParts.unitPrice, costBasis: ticketParts.costBasis
  }).from(ticketParts).where(and(
    eq(ticketParts.ticketId, ticketId), eq(ticketParts.isBillable, true), eq(ticketParts.billingStatus, 'not_billed')
  ));
  return [...te.map(timeEntryToLineSpec), ...parts.map(ticketPartToLineSpec)];
}
```

- [ ] **Step 4: Run the pure-mapper tests (pass) + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceAssembly.test.ts`
Expected: PASS.

```bash
git add apps/api/src/services/invoiceAssembly.ts apps/api/src/services/invoiceAssembly.test.ts
git commit -m "feat(invoices): assembly source-gathering + pure line mappers (TDD)"
```

### Task 3.4: invoiceService — create, read, lines, totals recompute

**Files:**
- Create: `apps/api/src/services/invoiceService.ts`
- Test: `apps/api/src/services/invoiceService.test.ts`

Helper conventions copied from `catalogService.ts`: `requirePartner(actor)` (throws `PARTNER_UNRESOLVABLE` 400), `requireOrgAccess(actor, orgId)` (throws `ORG_DENIED` 403 when `accessibleOrgIds` is non-null and excludes the org), `getOwnedInvoiceOr404(id, actor)` (selects the invoice in request context; throws `INVOICE_NOT_FOUND` 404 if absent — RLS already scopes the select).

- [ ] **Step 1: Implement create/read/list + line ops + `recomputeInvoiceTotals`**

Create `apps/api/src/services/invoiceService.ts` with these exports (full bodies below; the line-CRUD bodies are short and uniform):

```ts
import { and, eq, desc, lt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceLines, organizations } from '../db/schema';
import { computeLineTotal, computeInvoiceTotals } from './invoiceMath';
import { resolvePrice, computeBundleEconomics } from './catalogService';
import { catalogBundleComponents, catalogItems } from '../db/schema';
import { InvoiceServiceError } from './invoiceTypes';
import type { InvoiceActor } from './invoiceTypes';
import type { ManualLineInput } from '@breeze/shared';

function requirePartner(actor: InvoiceActor): string {
  if (!actor.partnerId) throw new InvoiceServiceError('Partner could not be resolved', 400, 'PARTNER_UNRESOLVABLE');
  return actor.partnerId;
}
function requireOrgAccess(actor: InvoiceActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new InvoiceServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}
async function getOwnedInvoiceOr404(id: string) {
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!rows[0]) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  return rows[0];
}
function assertDraft(inv: { status: string }): void {
  if (inv.status !== 'draft') throw new InvoiceServiceError('Invoice is not a draft', 409, 'NOT_A_DRAFT');
}

export async function createManualInvoice(input: { orgId: string; siteId?: string; notes?: string }, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  const rows = await db.insert(invoices).values({
    partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft',
    notes: input.notes ?? null, createdBy: actor.userId
  }).returning();
  return rows[0]!;
}

/** Recompute subtotal/tax/total/balance from the invoice's current lines. Draft-time
 *  uses the org's effective rate; on issue the snapshotted tax_rate is passed instead. */
export async function recomputeInvoiceTotals(invoiceId: string, taxRateOverride?: string | null) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  const lines = await db.select({
    lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible
  }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const taxRate = taxRateOverride !== undefined ? taxRateOverride : await effectiveRateForOrg(inv.orgId, inv.partnerId);
  const totals = computeInvoiceTotals(lines, taxRate);
  const balance = (Number(totals.total) - Number(inv.amountPaid)).toFixed(2);
  await db.update(invoices).set({
    subtotal: totals.subtotal, taxRate, taxTotal: totals.taxTotal, total: totals.total, balance, updatedAt: new Date()
  }).where(eq(invoices.id, invoiceId));
}

async function effectiveRateForOrg(orgId: string, partnerId: string): Promise<string> {
  const [org] = await db.select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  // partner default fetched in system context only at issue; for draft preview, use org rate or 0.
  const { resolveEffectiveTaxRate } = await import('./invoiceMath');
  return resolveEffectiveTaxRate({ taxExempt: org?.taxExempt ?? false, orgRate: org?.taxRate ?? null, partnerRate: null });
}

async function insertLineAndRecompute(invoiceId: string, orgId: string, spec: Omit<typeof invoiceLines.$inferInsert, 'invoiceId' | 'orgId'>) {
  const sortRows = await db.select({ max: invoiceLines.sortOrder }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(desc(invoiceLines.sortOrder)).limit(1);
  const nextSort = (sortRows[0]?.max ?? 0) + 1;
  const [line] = await db.insert(invoiceLines).values({ ...spec, invoiceId, orgId, sortOrder: nextSort }).returning();
  await recomputeInvoiceTotals(invoiceId);
  return line!;
}

export async function addManualLine(invoiceId: string, input: ManualLineInput, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  const lineTotal = computeLineTotal(String(input.quantity), String(input.unitPrice));
  return insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'manual', sourceId: null, catalogItemId: null, parentLineId: null, ticketId: null,
    description: input.description, quantity: String(input.quantity), unitPrice: Number(input.unitPrice).toFixed(2),
    costBasis: input.costBasis != null ? Number(input.costBasis).toFixed(2) : null,
    taxable: input.taxable, customerVisible: true, lineTotal, isUnapprovedTime: false
  });
}

export async function addCatalogLine(invoiceId: string, catalogItemId: string, quantity: number, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  const resolved = await resolvePrice(catalogItemId, inv.orgId, { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds });
  const [item] = await db.select({ name: catalogItems.name, isBundle: catalogItems.isBundle }).from(catalogItems).where(eq(catalogItems.id, catalogItemId)).limit(1);
  if (item?.isBundle) throw new InvoiceServiceError('Use addBundleLine for bundles', 400, 'INVALID_STATE');
  const qty = String(quantity);
  return insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'catalog', sourceId: null, catalogItemId, parentLineId: null, ticketId: null,
    description: item?.name ?? 'Catalog item', quantity: qty, unitPrice: resolved.unitPrice,
    costBasis: resolved.costBasis, taxable: resolved.taxable, customerVisible: true,
    lineTotal: computeLineTotal(qty, resolved.unitPrice), isUnapprovedTime: false
  });
}

export async function addBundleLine(invoiceId: string, bundleId: string, quantity: number, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  const catalogActor = { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds };
  const econ = await computeBundleEconomics(bundleId, inv.orgId, catalogActor); // throws NOT_A_BUNDLE etc.
  const [bundle] = await db.select({ name: catalogItems.name }).from(catalogItems).where(eq(catalogItems.id, bundleId)).limit(1);
  const qty = String(quantity);
  const parent = await insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'bundle', sourceId: null, catalogItemId: bundleId, parentLineId: null, ticketId: null,
    description: bundle?.name ?? 'Bundle', quantity: qty, unitPrice: econ.headlinePrice,
    costBasis: econ.totalCost, taxable: true, customerVisible: true,
    lineTotal: computeLineTotal(qty, econ.headlinePrice), isUnapprovedTime: false
  });
  // child component lines (unit_price 0, visibility per show_on_invoice)
  const comps = await db.select({
    componentItemId: catalogBundleComponents.componentItemId, quantity: catalogBundleComponents.quantity,
    showOnInvoice: catalogBundleComponents.showOnInvoice, revenueAllocation: catalogBundleComponents.revenueAllocation,
    name: catalogItems.name, costBasis: catalogItems.costBasis
  }).from(catalogBundleComponents)
    .innerJoin(catalogItems, eq(catalogItems.id, catalogBundleComponents.componentItemId))
    .where(eq(catalogBundleComponents.bundleItemId, bundleId));
  for (const comp of comps) {
    await db.insert(invoiceLines).values({
      invoiceId, orgId: inv.orgId, sourceType: 'bundle', sourceId: null, catalogItemId: comp.componentItemId,
      parentLineId: parent.id, ticketId: null, description: comp.name, quantity: comp.quantity, unitPrice: '0.00',
      costBasis: comp.costBasis, revenueAllocation: comp.revenueAllocation, taxable: false,
      customerVisible: comp.showOnInvoice, lineTotal: '0.00', isUnapprovedTime: false,
      sortOrder: parent.sortOrder // children sort directly under the parent
    });
  }
  await recomputeInvoiceTotals(invoiceId);
  return parent;
}

export async function updateLine(invoiceId: string, lineId: string, patch: { description?: string; quantity?: number; unitPrice?: number; taxable?: boolean; customerVisible?: boolean }, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  const [existing] = await db.select().from(invoiceLines).where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId))).limit(1);
  if (!existing) throw new InvoiceServiceError('Line not found', 404, 'LINE_NOT_FOUND');
  const quantity = patch.quantity != null ? String(patch.quantity) : existing.quantity;
  const unitPrice = patch.unitPrice != null ? Number(patch.unitPrice).toFixed(2) : existing.unitPrice;
  await db.update(invoiceLines).set({
    description: patch.description ?? existing.description, quantity, unitPrice,
    taxable: patch.taxable ?? existing.taxable, customerVisible: patch.customerVisible ?? existing.customerVisible,
    lineTotal: computeLineTotal(quantity, unitPrice)
  }).where(eq(invoiceLines.id, lineId));
  await recomputeInvoiceTotals(invoiceId);
  return getOwnedInvoiceOr404(invoiceId);
}

export async function removeLine(invoiceId: string, lineId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  // cascade FK removes bundle children when a parent is deleted
  await db.delete(invoiceLines).where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId)));
  await recomputeInvoiceTotals(invoiceId);
  return getOwnedInvoiceOr404(invoiceId);
}

export async function deleteDraftInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireOrgAccess(actor, inv.orgId);
  await db.delete(invoices).where(eq(invoices.id, invoiceId)); // lines cascade
}

export async function getInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); requireOrgAccess(actor, inv.orgId);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);
  return { invoice: inv, lines }; // accounting view (all lines)
}

export async function getCustomerInvoice(invoiceId: string) {
  const inv = await getOwnedInvoiceOr404(invoiceId); // RLS scopes; portal context supplies org access
  const lines = await db.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, invoiceId), eq(invoiceLines.customerVisible, true))).orderBy(invoiceLines.sortOrder);
  return { invoice: inv, lines };
}

export async function listInvoices(query: { orgId?: string; status?: string; limit: number; cursor?: string }, actor: InvoiceActor) {
  const conds = [] as ReturnType<typeof eq>[];
  if (query.orgId) { requireOrgAccess(actor, query.orgId); conds.push(eq(invoices.orgId, query.orgId)); }
  if (query.status) conds.push(eq(invoices.status, query.status as never));
  if (query.cursor) conds.push(lt(invoices.id, query.cursor)); // simple keyset; or use createdAt+id
  const rows = await db.select().from(invoices).where(conds.length ? and(...conds) : undefined).orderBy(desc(invoices.createdAt)).limit(query.limit);
  return rows;
}
```

> Note: `recomputeInvoiceTotals` does a draft-time tax preview using the org rate only (partner default is applied at issue, in system context, where the partner row is readable). This keeps draft math non-authoritative; the issue step snapshots the true rate. The dynamic `import('./invoiceMath')` inside `effectiveRateForOrg` can be hoisted to a top-level import — shown inline only to keep the snippet self-contained.

- [ ] **Step 2: Write service tests (mocked DB)** — assert line math + draft guards

Create `apps/api/src/services/invoiceService.test.ts`. Mock `../db` and `./catalogService`; assert: `addManualLine` rejects on a non-draft invoice (`NOT_A_DRAFT` 409), `addManualLine` computes `lineTotal` and calls recompute, `addCatalogLine` routes a bundle item to an error, `requireOrgAccess` throws 403 for a non-accessible org. Use the `vi.mock('../db', …)` Drizzle chain-mock pattern from `catalogService.test.ts` (mock `select().from().where().limit()` and `insert().values().returning()` to return canned rows).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock the db module with a chainable builder (mirror catalogService.test.ts).
const state: any = {};
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of ['select','from','where','limit','orderBy','insert','values','returning','update','set','delete']) c[m] = vi.fn(() => c);
    c.then = undefined;
    return c;
  };
  return { db: chain(), withSystemDbAccessContext: (f: any) => f(), runOutsideDbContext: (f: any) => f() };
});
vi.mock('./catalogService', () => ({ resolvePrice: vi.fn(), computeBundleEconomics: vi.fn() }));

import * as svc from './invoiceService';
import { InvoiceServiceError } from './invoiceTypes';

// Because the db mock returns the same chain, tests here focus on guard logic that
// branches before/after db calls. For full data-path coverage, see the integration
// test (Task 3.6) which runs against a real DB.
describe('invoiceService guards', () => {
  beforeEach(() => vi.clearAllMocks());
  it('requireOrgAccess: actor without org is denied', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    // getOwnedInvoiceOr404 returns a draft for orgId 'org1' (configure the mock per catalogService.test.ts pattern)
    // expect addManualLine to throw ORG_DENIED 403
    await expect(async () => {
      // arrange mock to return { id:'i1', status:'draft', orgId:'org1' } then call:
      await svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 1, taxable: false }, actor as any);
    }).rejects.toBeInstanceOf(InvoiceServiceError);
  });
});
```

> The mocked-DB unit test mainly locks the guard/branch logic. The data-path correctness (totals, bundle expansion, snapshots) is verified end-to-end in the integration test in Task 3.6, which is the authoritative coverage for this service.

- [ ] **Step 3: Run unit tests + typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/invoiceService.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts
git commit -m "feat(invoices): service create/read/list + line ops + totals recompute"
```

### Task 3.5: Assemble draft from org / ticket

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts`

- [ ] **Step 1: Add `assembleDraftFromOrg` and `assembleDraftFromTicket`**

Append to `invoiceService.ts`:

```ts
import { gatherOrgTimeEntries, gatherOrgParts, gatherTicketBillables, type DraftLineSpec } from './invoiceAssembly';
import { tickets } from '../db/schema';

async function materializeLines(invoiceId: string, orgId: string, specs: DraftLineSpec[]): Promise<void> {
  if (specs.length === 0) return;
  let sort = 0;
  await db.insert(invoiceLines).values(specs.map((s) => ({
    invoiceId, orgId, sourceType: s.sourceType, sourceId: s.sourceId, catalogItemId: s.catalogItemId,
    parentLineId: null, ticketId: s.ticketId, description: s.description, quantity: s.quantity,
    unitPrice: s.unitPrice, costBasis: s.costBasis, taxable: s.taxable, customerVisible: s.customerVisible,
    lineTotal: s.lineTotal, isUnapprovedTime: s.isUnapprovedTime, sortOrder: sort++
  })));
}

export async function assembleDraftFromOrg(input: { orgId: string; siteId?: string; from: string; to: string }, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  const from = new Date(input.from + 'T00:00:00Z');
  const to = new Date(input.to + 'T23:59:59Z');
  const specs = [...(await gatherOrgTimeEntries(input.orgId, from, to)), ...(await gatherOrgParts(input.orgId, from, to))];
  if (specs.length === 0) throw new InvoiceServiceError('No unbilled billable work in range', 409, 'NOTHING_TO_INVOICE');
  const [inv] = await db.insert(invoices).values({ partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft', createdBy: actor.userId }).returning();
  await materializeLines(inv!.id, input.orgId, specs);
  await recomputeInvoiceTotals(inv!.id);
  return getInvoice(inv!.id, actor);
}

export async function assembleDraftFromTicket(ticketId: string, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  const [tk] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!tk) throw new InvoiceServiceError('Ticket not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, tk.orgId);
  const specs = await gatherTicketBillables(ticketId);
  if (specs.length === 0) throw new InvoiceServiceError('Nothing billable on this ticket', 409, 'NOTHING_TO_INVOICE');
  const [inv] = await db.insert(invoices).values({ partnerId, orgId: tk.orgId, status: 'draft', createdBy: actor.userId }).returning();
  await materializeLines(inv!.id, tk.orgId, specs);
  await recomputeInvoiceTotals(inv!.id);
  return getInvoice(inv!.id, actor);
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/services/invoiceService.ts
git commit -m "feat(invoices): org-run + per-ticket draft assembly"
```

### Task 3.6: Issue invoice (numbering, double-bill guard, freeze, snapshot) — integration test

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts`
- Test: `apps/api/src/services/invoiceService.issue.integration.test.ts`

- [ ] **Step 1: Write a failing integration test (real DB)**

Create `apps/api/src/services/invoiceService.issue.integration.test.ts`. It seeds (system context) a partner, org, two time entries (one approved, one not) with `billing_status='not_billed'`, assembles a draft from the org, issues it, and asserts: invoice gets a number `INV-<year>-0001`, status `sent`, `due_date` = issue+30d, both source time entries flip to `billed`, lines are frozen (a subsequent `addManualLine` throws `NOT_A_DRAFT`), and totals are correct. A second test seeds a part already `billed` into a fresh draft (forced) and asserts issue throws `SOURCE_ALREADY_BILLED`.

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db, withSystemDbAccessContext, withDbAccessContext } from '../db';
import { partners, organizations, timeEntries, invoices, invoiceLines } from '../db/schema';
import { eq } from 'drizzle-orm';
import * as svc from './invoiceService';

const RUN = !!process.env.DATABASE_URL;
const suffix = Math.random().toString(36).slice(2, 8);
let partnerId = '', orgId = '', userId = 'system';

function actor() { return { userId, partnerId, accessibleOrgIds: [orgId] }; }
function ctx() { return { scope: 'partner' as const, orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId }; }

beforeAll(async () => {
  if (!RUN) return;
  await withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `Inv Issue ${suffix}`, slug: `inv-issue-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    partnerId = p!.id;
    const [o] = await db.insert(organizations).values({ partnerId, name: 'Issue Org', slug: `inv-issue-org-${suffix}` }).returning({ id: organizations.id });
    orgId = o!.id;
    const now = new Date();
    await db.insert(timeEntries).values([
      { partnerId, orgId, userId: null as never, startedAt: now, endedAt: now, durationMinutes: 60, description: 'Approved hr', isBillable: true, hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: true },
      { partnerId, orgId, userId: null as never, startedAt: now, endedAt: now, durationMinutes: 30, description: 'Unapproved hr', isBillable: true, hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: false }
    ]);
  });
});

describe.runIf(RUN)('issueInvoice', () => {
  it('assembles, numbers, freezes, flips source rows to billed', async () => {
    const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const { invoice } = await withDbAccessContext(ctx(), () => svc.assembleDraftFromOrg({ orgId, from, to }, actor()));
    const issued = await withDbAccessContext(ctx(), () => svc.issueInvoice(invoice.id, actor()));
    expect(issued.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
    expect(issued.status).toBe('sent');
    expect(issued.total).toBe('150.00'); // 1.0h + 0.5h @ 100, non-taxable
    const te = await withSystemDbAccessContext(() => db.select({ s: timeEntries.billingStatus }).from(timeEntries).where(eq(timeEntries.orgId, orgId)));
    expect(te.every((r) => r.s === 'billed')).toBe(true);
    await expect(withDbAccessContext(ctx(), () => svc.addManualLine(invoice.id, { description: 'x', quantity: 1, unitPrice: 1, taxable: false }, actor()))).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/invoiceService.issue.integration.test.ts`
Expected: FAIL (`svc.issueInvoice is not a function`).

- [ ] **Step 3: Implement `issueInvoice`**

Append to `invoiceService.ts`:

```ts
import { allocateInvoiceCounter, formatInvoiceNumber } from './invoiceNumbers';
import { resolveEffectiveTaxRate } from './invoiceMath';
import { emitInvoiceEvent } from './invoiceEvents';
import { partners, timeEntries, ticketParts } from '../db/schema';
import { sql } from 'drizzle-orm';

export async function issueInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  assertDraft(inv);
  requireOrgAccess(actor, inv.orgId);

  // Gather source rows referenced by lines, for the double-bill guard + flip.
  const lines = await db.select({ id: invoiceLines.id, sourceType: invoiceLines.sourceType, sourceId: invoiceLines.sourceId, customerVisible: invoiceLines.customerVisible }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  if (!lines.some((l) => l.customerVisible)) throw new InvoiceServiceError('Invoice has no customer-visible lines', 409, 'NO_VISIBLE_LINES');
  const timeIds = lines.filter((l) => l.sourceType === 'time_entry' && l.sourceId).map((l) => l.sourceId!) as string[];
  const partIds = lines.filter((l) => l.sourceType === 'part' && l.sourceId).map((l) => l.sourceId!) as string[];

  // Snapshot bill-to + tax + currency (system context: partner row + sequence).
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, inv.orgId)).limit(1);
    const [partner] = await db.select().from(partners).where(eq(partners.id, inv.partnerId)).limit(1);

    // Double-bill guard: re-lock referenced source rows; any already billed → abort.
    if (timeIds.length) {
      const billed = await db.select({ id: timeEntries.id }).from(timeEntries).where(and(inArray(timeEntries.id, timeIds), sql`${timeEntries.billingStatus} <> 'not_billed'`)).for('update');
      if (billed.length) throw new InvoiceServiceError(`Time entries already billed: ${billed.map((b) => b.id).join(', ')}`, 409, 'SOURCE_ALREADY_BILLED');
    }
    if (partIds.length) {
      const billed = await db.select({ id: ticketParts.id }).from(ticketParts).where(and(inArray(ticketParts.id, partIds), sql`${ticketParts.billingStatus} <> 'not_billed'`)).for('update');
      if (billed.length) throw new InvoiceServiceError(`Parts already billed: ${billed.map((b) => b.id).join(', ')}`, 409, 'SOURCE_ALREADY_BILLED');
    }

    const taxRate = resolveEffectiveTaxRate({ taxExempt: org?.taxExempt ?? false, orgRate: org?.taxRate ?? null, partnerRate: partner?.defaultTaxRate ?? null });
    const issueDate = new Date();
    const dueDate = new Date(issueDate.getTime() + (partner?.invoiceTermsDays ?? 30) * 86400000);
    const year = issueDate.getUTCFullYear();
    const counter = await allocateInvoiceCounter(inv.partnerId, year);
    const number = formatInvoiceNumber(partner?.invoiceNumberPrefix ?? 'INV', year, counter);

    // Recompute totals with the snapshotted rate, then write everything atomically.
    const lineRows = await db.select({ lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    const { subtotal, taxTotal, total } = computeInvoiceTotals(lineRows, taxRate);
    const billToAddress = {
      line1: org?.billingAddressLine1 ?? null, line2: org?.billingAddressLine2 ?? null,
      city: org?.billingAddressCity ?? null, region: org?.billingAddressRegion ?? null,
      postalCode: org?.billingAddressPostalCode ?? null, country: org?.billingAddressCountry ?? null
    };

    await db.update(invoices).set({
      status: 'sent', invoiceNumber: number, currencyCode: partner?.currencyCode ?? 'USD',
      issueDate: issueDate.toISOString().slice(0, 10), dueDate: dueDate.toISOString().slice(0, 10),
      taxRate, subtotal, taxTotal, total, balance: total, sentAt: issueDate,
      billToName: org?.name ?? null, billToAddress, billToTaxId: org?.taxId ?? null,
      billToTaxExempt: org?.taxExempt ?? false, terms: partner?.invoiceFooter ?? null, updatedAt: issueDate
    }).where(eq(invoices.id, invoiceId));

    if (timeIds.length) await db.update(timeEntries).set({ billingStatus: 'billed', updatedAt: issueDate }).where(inArray(timeEntries.id, timeIds));
    if (partIds.length) await db.update(ticketParts).set({ billingStatus: 'billed', updatedAt: issueDate }).where(inArray(ticketParts.id, partIds));
    return { number };
  }));

  await emitInvoiceEvent({ type: 'invoice.issued', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });
  // PDF render enqueued in Phase 5 (renderInvoicePdf job) — hook added there.
  void result;
  return getOwnedInvoiceOr404(invoiceId);
}
```

> The whole snapshot+flip runs in `withSystemDbAccessContext` so the partner row and sequence are readable and the source-row `FOR UPDATE` locks are scoped to this short system transaction (same rationale as `allocateInternalTicketNumber`). `db.execute`/`.for('update')` inside one `withSystemDbAccessContext` callback share its transaction — confirm `withSystemDbAccessContext` wraps the callback in a single tx in `db/index.ts`; if it does not, wrap the body in `db.transaction(async (tx) => …)` and use `tx` for the guard+update so the lock and writes are atomic.

- [ ] **Step 4: Run the integration test (passes)**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/invoiceService.issue.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.issue.integration.test.ts
git commit -m "feat(invoices): issue — numbering, double-bill guard, freeze, source flip (TDD)"
```

### Task 3.7: Payments + status recompute

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts`
- Test: extend `apps/api/src/services/invoiceService.issue.integration.test.ts` (or a sibling `…payments.integration.test.ts`)

- [ ] **Step 1: Write a failing integration test**

Add a test: issue an invoice (total 150.00), record a 50.00 payment → status `partially_paid`, balance `100.00`; record 100.00 → status `paid`, `paid_at` set, balance `0.00`; a third payment of 1.00 throws `OVERPAYMENT`.

```ts
it('partial then full payment transitions status and balance', async () => {
  const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { invoice } = await withDbAccessContext(ctx(), () => svc.assembleDraftFromTicketOrOrgFixture(orgId, actor())); // helper or reuse org-run
  const issued = await withDbAccessContext(ctx(), () => svc.issueInvoice(invoice.id, actor()));
  await withDbAccessContext(ctx(), () => svc.recordPayment(issued.id, { amount: 50, method: 'check', receivedAt: '2026-06-14' }, actor()));
  let cur = await withDbAccessContext(ctx(), () => svc.getInvoice(issued.id, actor()));
  expect(cur.invoice.status).toBe('partially_paid'); expect(cur.invoice.balance).toBe('100.00');
  await withDbAccessContext(ctx(), () => svc.recordPayment(issued.id, { amount: 100, method: 'check', receivedAt: '2026-06-14' }, actor()));
  cur = await withDbAccessContext(ctx(), () => svc.getInvoice(issued.id, actor()));
  expect(cur.invoice.status).toBe('paid'); expect(cur.invoice.balance).toBe('0.00'); expect(cur.invoice.paidAt).not.toBeNull();
  await expect(withDbAccessContext(ctx(), () => svc.recordPayment(issued.id, { amount: 1, method: 'check', receivedAt: '2026-06-14' }, actor()))).rejects.toMatchObject({ code: 'OVERPAYMENT' });
});
```

> If reusing org-run assembly for a fresh invoice here is awkward because the first test already billed the org's entries, seed a dedicated org+entries in `beforeAll` for the payments test, or add a small fixture helper. Keep each test's source rows disjoint.

- [ ] **Step 2: Implement `recordPayment`, `voidPayment`, `recomputeInvoiceStatus`**

Append to `invoiceService.ts`:

```ts
import { invoicePayments } from '../db/schema';
import { deriveInvoiceStatus } from './invoiceMath';
import type { RecordPaymentInput } from '@breeze/shared';

export async function recomputeInvoiceStatus(invoiceId: string): Promise<void> {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  const paidRows = await db.select({ amount: invoicePayments.amount }).from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
  const amountPaid = paidRows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2);
  const balance = (Number(inv.total) - Number(amountPaid)).toFixed(2);
  const issued = inv.invoiceNumber !== null;
  const status = deriveInvoiceStatus({ voided: inv.voidedAt !== null, issued, total: inv.total, amountPaid, dueDate: inv.dueDate, asOf: new Date() });
  const patch: Record<string, unknown> = { amountPaid, balance, status, updatedAt: new Date() };
  if (status === 'paid' && inv.paidAt === null) patch.paidAt = new Date();
  if (status === 'overdue' && inv.markedOverdueAt === null) patch.markedOverdueAt = new Date();
  await db.update(invoices).set(patch).where(eq(invoices.id, invoiceId));
}

export async function recordPayment(invoiceId: string, input: RecordPaymentInput, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireOrgAccess(actor, inv.orgId);
  if (inv.status === 'draft') throw new InvoiceServiceError('Cannot record payment on a draft', 409, 'INVALID_STATE');
  if (inv.status === 'void') throw new InvoiceServiceError('Cannot record payment on a void invoice', 409, 'INVALID_STATE');
  const balance = Number(inv.balance);
  if (Number(input.amount) > balance + 1e-9) throw new InvoiceServiceError('Payment exceeds balance', 400, 'OVERPAYMENT');
  const [payment] = await db.insert(invoicePayments).values({
    invoiceId, orgId: inv.orgId, amount: Number(input.amount).toFixed(2), method: input.method,
    reference: input.reference ?? null, receivedAt: input.receivedAt, recordedBy: actor.userId, note: input.note ?? null
  }).returning();
  await recomputeInvoiceStatus(invoiceId);
  await emitInvoiceEvent({ type: 'payment.recorded', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, paymentId: payment!.id, actorUserId: actor.userId });
  const updated = await getOwnedInvoiceOr404(invoiceId);
  if (updated.status === 'paid') await emitInvoiceEvent({ type: 'invoice.paid', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });
  return updated;
}

export async function voidPayment(paymentId: string, actor: InvoiceActor) {
  const [pay] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, paymentId)).limit(1);
  if (!pay) throw new InvoiceServiceError('Payment not found', 404, 'LINE_NOT_FOUND');
  requireOrgAccess(actor, pay.orgId);
  await db.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
  await recomputeInvoiceStatus(pay.invoiceId);
  const inv = await getOwnedInvoiceOr404(pay.invoiceId);
  await emitInvoiceEvent({ type: 'payment.voided', invoiceId: pay.invoiceId, orgId: pay.orgId, partnerId: inv.partnerId, paymentId, actorUserId: actor.userId });
  return inv;
}

export async function listPayments(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireOrgAccess(actor, inv.orgId);
  return db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId)).orderBy(invoicePayments.receivedAt);
}
```

- [ ] **Step 3: Run integration test (passes) + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/invoiceService.issue.integration.test.ts`
Expected: PASS.

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.issue.integration.test.ts
git commit -m "feat(invoices): partial payments + status recompute (TDD)"
```

### Task 3.8: Void + reissue + overdue sweep

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts`

- [ ] **Step 1: Implement `voidInvoice` and `runOverdueSweep`**

Append:

```ts
export async function voidInvoice(invoiceId: string, reason: string, opts: { reissue?: boolean }, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireOrgAccess(actor, inv.orgId);
  if (inv.status === 'draft') throw new InvoiceServiceError('Delete drafts instead of voiding', 409, 'INVALID_STATE');
  if (inv.status === 'void') throw new InvoiceServiceError('Already void', 409, 'INVALID_STATE');

  const lines = await db.select({ sourceType: invoiceLines.sourceType, sourceId: invoiceLines.sourceId }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const timeIds = lines.filter((l) => l.sourceType === 'time_entry' && l.sourceId).map((l) => l.sourceId!) as string[];
  const partIds = lines.filter((l) => l.sourceType === 'part' && l.sourceId).map((l) => l.sourceId!) as string[];

  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();
    await db.update(invoices).set({ status: 'void', voidedAt: now, voidReason: reason, updatedAt: now }).where(eq(invoices.id, invoiceId));
    // release source rows so they can be re-invoiced
    if (timeIds.length) await db.update(timeEntries).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(timeEntries.id, timeIds));
    if (partIds.length) await db.update(ticketParts).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(ticketParts.id, partIds));
  }));

  await emitInvoiceEvent({ type: 'invoice.voided', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });

  if (opts.reissue) {
    // clone source-backed lines into a fresh draft (released rows are not_billed again)
    const [draft] = await db.insert(invoices).values({ partnerId: inv.partnerId, orgId: inv.orgId, siteId: inv.siteId, status: 'draft', notes: inv.notes, replacesInvoiceId: invoiceId, createdBy: actor.userId }).returning();
    await db.update(invoices).set({ replacedByInvoiceId: draft!.id }).where(eq(invoices.id, invoiceId));
    const srcLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);
    if (srcLines.length) {
      await db.insert(invoiceLines).values(srcLines.map((l) => ({
        invoiceId: draft!.id, orgId: l.orgId, sourceType: l.sourceType, sourceId: l.sourceId, catalogItemId: l.catalogItemId,
        parentLineId: null, ticketId: l.ticketId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        costBasis: l.costBasis, revenueAllocation: l.revenueAllocation, taxable: l.taxable, customerVisible: l.customerVisible,
        lineTotal: l.lineTotal, isUnapprovedTime: l.isUnapprovedTime, sortOrder: l.sortOrder
      })));
    }
    await recomputeInvoiceTotals(draft!.id);
    return getInvoice(draft!.id, actor);
  }
  return getInvoice(invoiceId, actor);
}

/** Daily sweep: flip sent/partially_paid past their due date (balance>0) to overdue. */
export async function runOverdueSweep(asOf: Date = new Date()): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const today = asOf.toISOString().slice(0, 10);
    const due = await db.select({ id: invoices.id, orgId: invoices.orgId, partnerId: invoices.partnerId })
      .from(invoices)
      .where(and(inArray(invoices.status, ['sent', 'partially_paid'] as never), lt(invoices.dueDate, today), sql`${invoices.balance} > 0`));
    for (const r of due) {
      await db.update(invoices).set({ status: 'overdue', markedOverdueAt: asOf, updatedAt: asOf }).where(eq(invoices.id, r.id));
      await emitInvoiceEvent({ type: 'invoice.overdue', invoiceId: r.id, orgId: r.orgId, partnerId: r.partnerId });
    }
    return due.length;
  }));
}

/** Portal/email open: stamp viewed timestamps (independent of status). */
export async function markViewed(invoiceId: string): Promise<void> {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  const now = new Date();
  await db.update(invoices).set({ viewedAt: now, firstViewedAt: inv.firstViewedAt ?? now }).where(eq(invoices.id, invoiceId));
  if (inv.firstViewedAt === null) await emitInvoiceEvent({ type: 'invoice.viewed', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId });
}
```

- [ ] **Step 2: Add a void+overdue integration test**

Add tests: voiding a `sent` invoice with `reissue:true` sets status `void`, releases source rows to `not_billed`, creates a linked draft (`replaces/replaced_by` set); `runOverdueSweep` with an `asOf` past a seeded invoice's `due_date` flips it to `overdue`.

- [ ] **Step 3: Run + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm exec vitest run src/services/invoiceService.issue.integration.test.ts`
Expected: PASS.

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.issue.integration.test.ts
git commit -m "feat(invoices): void+reissue, overdue sweep, viewed tracking (TDD)"
```

---

## Phase 4 — Routes, permissions, AI tools

Exposes the service over HTTP with auth/permission gating and adds light AI read tools. After this phase the engine is fully usable via the API.

### Task 4.1: Register the `invoices` permission set

**Files:**
- Modify: `apps/api/src/services/permissions.ts`

- [ ] **Step 1: Add `INVOICES_*` to the `PERMISSIONS` object**

In `apps/api/src/services/permissions.ts`, inside the `PERMISSIONS` const, after the `CATALOG_*` block, add:

```ts
  // Invoices (billing/invoicing program — sub-project 2)
  INVOICES_READ: { resource: 'invoices', action: 'read' },
  INVOICES_WRITE: { resource: 'invoices', action: 'write' },
  INVOICES_SEND: { resource: 'invoices', action: 'send' },
  INVOICES_EXPORT: { resource: 'invoices', action: 'export' },
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS (the `as const` object widens automatically; `KNOWN_PERMISSIONS` picks them up). The migration in Task 1.3 already seeds the matching `permissions` rows + grants.

```bash
git add apps/api/src/services/permissions.ts
git commit -m "feat(invoices): invoices permission set (read/write/send/export)"
```

### Task 4.2: Invoice routes

**Files:**
- Create: `apps/api/src/routes/invoices/index.ts`, `invoices.ts`, `lifecycle.ts`, `payments.ts`, `assembly.ts`
- Create: `apps/api/src/routes/invoices/invoices.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Implement the route files** (mirror the catalog route skeleton verbatim: `requireScope`, `requirePermission(PERMISSIONS.X.resource, PERMISSIONS.X.action)`, `zValidator`, `actorFrom(c)`, `handleServiceError`)

Create `apps/api/src/routes/invoices/invoices.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createManualInvoiceSchema, updateInvoiceSchema, manualLineSchema, catalogLineSchema,
  bundleLineSchema, updateLineSchema, listInvoicesQuerySchema
} from '@breeze/shared';
import {
  createManualInvoice, getInvoice, listInvoices, addManualLine, addCatalogLine, addBundleLine,
  updateLine, removeLine, deleteDraftInvoice
} from '../../services/invoiceService';
import { InvoiceServiceError, type InvoiceActor } from '../../services/invoiceTypes';

export const invoiceCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);
const idParam = z.object({ id: z.string().uuid() });
const lineParam = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });

export function invoiceActorFrom(c: { get: (k: string) => unknown }): InvoiceActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
export function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof InvoiceServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

invoiceCrudRoutes.get('/', scopes, readPerm, zValidator('query', listInvoicesQuerySchema), async (c) => {
  try { return c.json({ data: await listInvoices(c.req.valid('query'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/', scopes, writePerm, zValidator('json', createManualInvoiceSchema), async (c) => {
  try { return c.json({ data: await createManualInvoice(c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await getInvoice(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { await deleteDraftInvoice(c.req.valid('param').id, invoiceActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', manualLineSchema), async (c) => {
  try { return c.json({ data: await addManualLine(c.req.valid('param').id, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/:id/lines/catalog', scopes, writePerm, zValidator('param', idParam), zValidator('json', catalogLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addCatalogLine(c.req.valid('param').id, b.catalogItemId, b.quantity, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/:id/lines/bundle', scopes, writePerm, zValidator('param', idParam), zValidator('json', bundleLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addBundleLine(c.req.valid('param').id, b.bundleId, b.quantity, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.patch('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), zValidator('json', updateLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await updateLine(p.id, p.lineId, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await removeLine(p.id, p.lineId, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
```

Create `apps/api/src/routes/invoices/lifecycle.ts` (issue/send/void — `INVOICES_SEND`):

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { voidInvoiceSchema } from '@breeze/shared';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';
import { sendInvoiceEmail } from '../../services/invoicePdf'; // added in Phase 5
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().uuid() });

invoiceLifecycleRoutes.post('/:id/issue', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await issueInvoice(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await sendInvoiceEmail(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceLifecycleRoutes.post('/:id/void', scopes, sendPerm, zValidator('param', idParam), zValidator('json', voidInvoiceSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await voidInvoice(c.req.valid('param').id, b.reason, { reissue: b.reissue }, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
```

Create `apps/api/src/routes/invoices/payments.ts` (record/list/void payment — read for list, send for mutate):

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { recordPaymentSchema } from '@breeze/shared';
import { recordPayment, listPayments, voidPayment } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoicePaymentRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().uuid() });
const payParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });

invoicePaymentRoutes.get('/:id/payments', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await listPayments(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoicePaymentRoutes.post('/:id/payments', scopes, sendPerm, zValidator('param', idParam), zValidator('json', recordPaymentSchema), async (c) => {
  try { return c.json({ data: await recordPayment(c.req.valid('param').id, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoicePaymentRoutes.delete('/:id/payments/:pid', scopes, sendPerm, zValidator('param', payParam), async (c) => {
  try { return c.json({ data: await voidPayment(c.req.valid('param').pid, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
```

Create `apps/api/src/routes/invoices/assembly.ts` (org-run + per-ticket — `INVOICES_WRITE`):

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { assembleFromOrgSchema } from '@breeze/shared';
import { assembleDraftFromOrg, assembleDraftFromTicket } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceAssemblyRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);

// Mounted at top level so the paths read /orgs/:orgId/invoices/assemble and /tickets/:ticketId/invoice
invoiceAssemblyRoutes.post('/orgs/:orgId/invoices/assemble', scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().uuid() })),
  zValidator('json', assembleFromOrgSchema.omit({ orgId: true })),
  async (c) => {
    try { const orgId = c.req.valid('param').orgId; const b = c.req.valid('json');
      return c.json({ data: await assembleDraftFromOrg({ orgId, ...b }, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
invoiceAssemblyRoutes.post('/tickets/:ticketId/invoice', scopes, writePerm,
  zValidator('param', z.object({ ticketId: z.string().uuid() })),
  async (c) => {
    try { return c.json({ data: await assembleDraftFromTicket(c.req.valid('param').ticketId, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
```

Create `apps/api/src/routes/invoices/index.ts`:

```ts
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { invoiceCrudRoutes } from './invoices';
import { invoiceLifecycleRoutes } from './lifecycle';
import { invoicePaymentRoutes } from './payments';
import { invoicePdfRoutes } from './pdf'; // added in Phase 5

export const invoiceRoutes = new Hono();
invoiceRoutes.use('*', authMiddleware);
invoiceRoutes.route('/', invoiceLifecycleRoutes);  // /:id/issue, /:id/send, /:id/void
invoiceRoutes.route('/', invoicePaymentRoutes);    // /:id/payments...
invoiceRoutes.route('/', invoicePdfRoutes);        // /:id/pdf (Phase 5)
invoiceRoutes.route('/', invoiceCrudRoutes);       // /, /:id, /:id/lines... (param matchers last)
```

> Order matters: literal-suffix routes (`/:id/issue`, `/:id/payments`, `/:id/pdf`) register before the bare `/:id` CRUD matcher, mirroring the tickets hub.

- [ ] **Step 2: Mount in the API hub**

In `apps/api/src/index.ts`: import `{ invoiceRoutes }` from `./routes/invoices` and `{ invoiceAssemblyRoutes }` from `./routes/invoices/assembly` near the other route imports, then mount (after `catalogRoutes`):

```ts
app.route('/api/invoices', invoiceRoutes);
app.route('/api', invoiceAssemblyRoutes); // /api/orgs/:orgId/invoices/assemble, /api/tickets/:ticketId/invoice
```

> The assembly routes mount at `/api` (not `/api/invoices`) so they nest under existing `/orgs` and `/tickets` namespaces — confirm there is no conflicting handler and that `invoiceAssemblyRoutes` applies `authMiddleware` (add `invoiceAssemblyRoutes.use('*', authMiddleware)` at its top, or move it under a hub that already does).

- [ ] **Step 3: Write route tests (mock service + auth)** — mirror `catalog.test.ts`

Create `apps/api/src/routes/invoices/invoices.test.ts`: mock `../../services/invoiceService` (all exported fns as `vi.fn()`) and `../../services/invoicePdf`, mock `../../middleware/auth` to inject a partner-scoped actor and pass-through `requireScope`/`requirePermission`. Assert: `POST /` creates, `POST /:id/lines` validates (reject negative qty → 400), `POST /:id/issue` calls `issueInvoice`, `POST /:id/payments` validates amount, and `InvoiceServiceError` maps to its status (e.g. `NOTHING_TO_INVOICE` → 409). Reuse the exact `vi.mock` + `app().request(...)` shape from `catalog.test.ts`.

- [ ] **Step 4: Run route tests + typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/routes/invoices/ && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS. (`invoicePdfRoutes`/`sendInvoiceEmail` are stubbed until Phase 5 — to keep this phase green, create thin stub files `pdf.ts` exporting an empty `invoicePdfRoutes = new Hono()` and `invoicePdf.ts` exporting `sendInvoiceEmail`/`renderInvoicePdf` no-ops, replaced in Phase 5.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/invoices apps/api/src/index.ts
git commit -m "feat(invoices): REST routes (crud, lines, lifecycle, payments, assembly) + tests"
```

### Task 4.3: Light AI read tools

**Files:**
- Create: `apps/api/src/services/aiToolsBilling.ts`
- Modify: the `aiTools` hub registration file (grep for `aiToolsCatalog` to find it)

- [ ] **Step 1: Implement `list_invoices` + `get_invoice` tools**

Mirror `aiToolsCatalog.ts`. Both are tier-2 reads, **org-scope-guarded at the tool layer** (do not rely on the route scanner — the known aiTools site/org-scope gap): each tool resolves an `InvoiceActor` from the AI session's partner/org context and calls `listInvoices` / `getInvoice`, which already enforce `requireOrgAccess`. Register in the hub alongside `aiToolsCatalog`. Write tools are deferred.

- [ ] **Step 2: Typecheck + commit**

```bash
git add apps/api/src/services/aiToolsBilling.ts <hub-file>
git commit -m "feat(invoices): light AI read tools (list/get), org-scope guarded"
```

---

## Phase 5 — PDF, email, customer portal, worker

Adds artifact rendering, email delivery, the read-only portal view, and the BullMQ worker (PDF render job + daily overdue sweep).

### Task 5.1: `invoice_documents` table + PDF render/store

**Files:**
- Create: `apps/api/src/db/schema/invoiceDocuments.ts` (+ register in `schema/index.ts`)
- Create: `apps/api/migrations/2026-06-14-c-invoice-documents.sql`
- Create: `apps/api/src/services/invoicePdf.ts` (replaces the Phase 4 stub)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (forge note; shape-1 auto-discovered)

- [ ] **Step 1: Schema + migration for `invoice_documents`** (org-axis shape 1)

`invoice_documents`: `id uuid pk`, `invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE`, `org_id uuid NOT NULL REFERENCES organizations(id)` (denormalized RLS axis), `pdf bytea NOT NULL`, `sha256 char(64) NOT NULL`, `generated_at timestamp NOT NULL DEFAULT NOW()`, unique on `invoice_id`. RLS shape 1 (the same four `breeze_has_org_access(org_id)` policies as Task 1.3). Migration `2026-06-14-c-invoice-documents.sql` (sorts after `-b-`). Add a cross-org forge test mirroring Task 1.4.

- [ ] **Step 2: Implement `invoicePdf.ts`**

```ts
// renderInvoicePdf(invoiceId): load customer view, render HTML, convert to PDF (headless
// Chromium via Playwright — already a repo dep), upsert invoice_documents, set
// invoices.pdf_document_ref + pdf_sha256. sendInvoiceEmail(invoiceId, actor): issue if
// still draft, ensure PDF exists, send via getEmailService() with the PDF attached,
// stamp sent_at. getInvoicePdf(invoiceId): return the stored bytea.
```

Provide: `renderInvoiceHtml(invoice, lines, branding)` (pure, unit-testable — returns an HTML string of the customer view: header with org branding, bill-to block, line table of `customer_visible` lines grouped by ticket, subtotal/tax/total, terms/footer), `renderInvoicePdf(invoiceId)` (HTML→Buffer via Playwright `chromium.launch()` → `page.setContent(html)` → `page.pdf({ format: 'A4' })`, then store), `getInvoicePdf(invoiceId)`, and `sendInvoiceEmail(invoiceId, actor)` (uses `buildInvoiceTemplate` from Task 5.2; attaches the PDF; calls `markSent`/stamps `sent_at`; `markViewed` is portal-side).

- [ ] **Step 3: Unit-test `renderInvoiceHtml`** (pure) — asserts hidden lines are excluded, totals render, bill-to present. Then commit.

```bash
git add apps/api/src/db/schema/invoiceDocuments.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-14-c-invoice-documents.sql apps/api/src/services/invoicePdf.ts apps/api/src/services/invoicePdf.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(invoices): invoice_documents table + HTML/PDF render + email send"
```

### Task 5.2: Invoice email template + PDF route

**Files:**
- Modify: `apps/api/src/services/email.ts` (add `buildInvoiceTemplate`)
- Create: `apps/api/src/routes/invoices/pdf.ts` (replaces the Phase 4 stub)

- [ ] **Step 1: Add `buildInvoiceTemplate`** to `email.ts` — mirror `buildInviteTemplate` (returns `{ subject, html, text }` via `renderLayout`/`renderButton`/`escapeHtml`); subject `Invoice {number} from {partnerName}`, body with total + due date + a portal link.

- [ ] **Step 2: Implement `pdf.ts` route** — `GET /:id/pdf` behind `INVOICES_EXPORT`; calls `getInvoicePdf`, returns the bytea with `Content-Type: application/pdf` and `Content-Disposition: attachment; filename="<number>.pdf"`.

- [ ] **Step 3: Typecheck + commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/routes/invoices/pdf.ts
git commit -m "feat(invoices): invoice email template + PDF download route"
```

### Task 5.3: Customer portal invoice routes

**Files:**
- Create: `apps/api/src/routes/portal/invoices.ts`
- Modify: `apps/api/src/index.ts` (mount under the portal hub)

- [ ] **Step 1: Implement portal routes** — follow the existing `routes/portal/tickets.ts` auth pattern (portal context provides org scope). Endpoints: `GET /portal/invoices` (list this org's `status != 'draft'` invoices via a portal-scoped `getCustomerInvoice`/`listInvoices` variant), `GET /portal/invoices/:id` (calls `getCustomerInvoice` + `markViewed`), `GET /portal/invoices/:id/pdf` (stream stored PDF). Read-only; no payment endpoints (deferred to Stripe #4).

- [ ] **Step 2: Mount + commit**

Mount in the portal route hub the same way `routes/portal/tickets.ts` is mounted.

```bash
git add apps/api/src/routes/portal/invoices.ts apps/api/src/index.ts
git commit -m "feat(invoices): read-only customer portal invoice view"
```

### Task 5.4: Invoice worker (PDF render job + daily overdue sweep)

**Files:**
- Create: `apps/api/src/jobs/invoiceWorker.ts`
- Modify: `apps/api/src/services/invoiceService.ts` (enqueue render on issue)
- Modify: `apps/api/src/index.ts` (init/shutdown the worker)

- [ ] **Step 1: Implement `invoiceWorker.ts`** — mirror `alertWorker.ts`: a `'invoice-jobs'` queue + worker; job types `{ type: 'render-pdf', invoiceId }` and `{ type: 'overdue-sweep' }`; the worker runs `renderInvoicePdf(invoiceId)` / `runOverdueSweep()` inside `runWithSystemDbAccess`. Schedule a repeatable `overdue-sweep` daily (`repeat: { pattern: '0 6 * * *' }` or `every: 24*60*60*1000`); clear repeatables before re-scheduling. Export `enqueueInvoicePdfRender(invoiceId)`, `initializeInvoiceWorkers()`, `shutdownInvoiceWorkers()`.

- [ ] **Step 2: Enqueue render on issue** — in `issueInvoice` (Task 3.6), replace the `// PDF render enqueued in Phase 5` comment with `await enqueueInvoicePdfRender(invoiceId);` (imported from the worker).

- [ ] **Step 3: Wire startup/shutdown** — call `initializeInvoiceWorkers()` where `initializeAlertWorkers()` is called in `index.ts`, and `shutdownInvoiceWorkers()` alongside the other shutdowns.

- [ ] **Step 4: Typecheck + smoke + commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add apps/api/src/jobs/invoiceWorker.ts apps/api/src/services/invoiceService.ts apps/api/src/index.ts
git commit -m "feat(invoices): BullMQ worker — async PDF render + daily overdue sweep"
```

---

## Phase 6 — Web UI

MSP-facing invoice management + billing settings, plus the portal view. Astro + React islands, `data-testid` only, all mutations via `runAction`, URL state via `window.location.hash`. Todd UI-tests this phase in-session.

### Task 6.1: Invoices list + assemble action

**Files:** Create an Astro page `apps/web/src/pages/billing/invoices.astro` + island `apps/web/src/components/billing/InvoicesPage.tsx` (+ test).

- [ ] **Step 1:** Build the list (columns: number, org, issue/due date, total, balance, status badge — overdue highlighted; filters: org/status/date via hash state) and an "Assemble invoice" action (org + optional site + date-range picker → `POST /api/orgs/:orgId/invoices/assemble` via `runAction`, navigate to the new draft).
- [ ] **Step 2:** Component test (render rows, status badge, filter). Run `apps/web` vitest.
- [ ] **Step 3:** Commit.

### Task 6.2: Invoice editor (draft) + detail (issued)

**Files:** `apps/web/src/components/billing/InvoiceEditor.tsx`, `InvoiceDetail.tsx` (+ tests).

- [ ] **Step 1: Editor (draft):** line table (add catalog/bundle/manual via pickers; edit qty/price/visibility; remove), live subtotal/tax/total, an unapproved-time warning banner (count of `is_unapproved_time` lines), bill-to preview, notes; **Issue** and **Issue & Send** buttons (`POST /:id/issue`, `/:id/send` via `runAction`). All mutations through `runAction`.
- [ ] **Step 2: Detail (issued):** read-only lines with an accounting-view toggle (show cost/margin + hidden bundle components), payments panel (record partial payment, list, void), PDF download (`/:id/pdf`), Void (with reason) + reissue.
- [ ] **Step 3:** Component tests (line add/remove updates totals via mocked fetch; issue disabled when no visible lines; payment form validation). Run `apps/web` vitest.
- [ ] **Step 4:** Commit.

### Task 6.3: Ticket "Create invoice" button + billing settings

**Files:** modify the ticket detail island to add the button (`POST /api/tickets/:id/invoice` → navigate to draft); create `PartnerBillingSettings.tsx` (currency, default tax rate, number prefix, terms days, footer → a `PATCH /api/partner/billing-settings` route mirroring existing partner-settings routes) and `OrgBillingSettings.tsx` (tax id/exempt/rate, billing address → `PATCH /api/orgs/:id/billing-settings`).

> These two settings routes are small additions — add them to the invoices route set (Task 4.2 sibling) behind `INVOICES_WRITE`, validated by `partnerBillingSettingsSchema` / `orgBillingSettingsSchema`. Add their service functions (`updatePartnerBillingSettings`, `updateOrgBillingSettings`) to `invoiceService.ts`. (Listed here because they're driven by the settings UI; an executor may pull them earlier into Phase 4.)

- [ ] **Step 1:** Settings routes + service fns + validators wiring + tests.
- [ ] **Step 2:** UI islands (runAction), ticket button.
- [ ] **Step 3:** Commit.

### Task 6.4: Portal invoice view

**Files:** `apps/portal/src/...` list + detail pages consuming `GET /portal/invoices*`, reusing `OrgBrandingEditor` styling; read-only with PDF download.

- [ ] **Step 1:** Build list + detail; download PDF.
- [ ] **Step 2:** Commit.

### Task 6.5: runAction allowlist + full regression

- [ ] **Step 1:** Run the `no-silent-mutations` guard: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS (every new mutation handler wrapped in `runAction`; only add to `runActionAllowlist.ts` for a legitimate typed/aggregate handler — default none).
- [ ] **Step 2:** Run the affected API + web test files once more single-fork; confirm green. Commit any allowlist change.

---

## Self-Review

**Spec coverage** (each spec §, where implemented):
- §2 data model → Tasks 1.1–1.3 (tables, columns, enums) + 5.1 (`invoice_documents`). ✓
- §3 assembly & pricing → 3.3 (gather), 3.4 (catalog/bundle/manual lines, totals), 3.5 (org/ticket assembly); money math 2.1. ✓ (part-`taxable` spec gap resolved at Phase 3 intro.)
- §4 lifecycle → 3.6 (issue + double-bill guard + freeze + flip), 3.7 (recompute status), 3.8 (void/reissue, overdue sweep, viewed); status truth-table 2.1. ✓
- §5 tax/numbering/currency → 2.1 (`resolveEffectiveTaxRate`), 3.1 (numbering), 3.6 (snapshot at issue). ✓
- §6 snapshots/immutability → 3.6 (freeze, snapshot bill-to/tax/currency; `assertDraft` guards on every line op). ✓
- §7 payments → 3.7 (partial, overpayment reject, void payment). ✓
- §8 PDF/email/portal → 5.1 (render/store), 5.2 (email/PDF route), 5.3 (portal). ✓
- §9 service surface → all of Phase 3 (every listed fn present). ✓
- §10 routes → 4.2 + 5.2 (pdf) + 5.3 (portal). ✓
- §11 permissions → 1.3 (seed+grant) + 4.1 (registry). ✓
- §12 UI → Phase 6. ✓
- §13 AI tools → 4.3. ✓
- §14 testing → unit (2.1, 2.2, 3.1, 3.3, 5.1), integration (3.6–3.8), RLS forge (1.4, 5.1), routes (4.2), web (6.x). ✓
- §15 migration → 1.3 (+ 5.1). ✓  §16 events → 3.2 + emit calls in 3.6–3.8. ✓
- §18 defaults → encoded in 1.2/3.1/3.6 (currency, prefix, terms, void+reissue, labor non-taxable). ✓

**Type consistency:** `InvoiceActor`, `InvoiceServiceError(+Code)`, `InvoiceStatus`, `DraftLineSpec`, `computeLineTotal/computeInvoiceTotals/resolveEffectiveTaxRate/deriveInvoiceStatus`, `allocateInvoiceCounter/formatInvoiceNumber`, `emitInvoiceEvent`, `recomputeInvoiceTotals/recomputeInvoiceStatus` — names used identically across Tasks 2–5. Service fn names match spec §9 and the route imports in 4.2.

**Known executor checkpoints (verify against the live repo, not assumed):**
1. Exact import names/paths for `withSystemDbAccessContext` / `runOutsideDbContext` / `db` (`../db` vs `../db/index`), `getBullMQConnection`, `captureException`, `runWithSystemDbAccess` (worker) — copy from `ticketNumbers.ts` / `catalogEvents.ts` / `alertWorker.ts`.
2. Whether `withSystemDbAccessContext` wraps its callback in a single transaction; if not, wrap the issue/void bodies in `db.transaction` for atomic guard+flip (noted in 3.6).
3. `AuthContext` shape (`auth.user.id`, `auth.partnerId`, `auth.accessibleOrgIds`) — confirm against `middleware/auth.ts` (catalog route uses exactly these).
4. The `@breeze/shared` barrel path for re-exporting validators (2.2 step 4).
5. Playwright `chromium` availability in the API runtime/container for PDF render (5.1) — if not bundled, fall back to a lighter HTML→PDF lib; the `renderInvoiceHtml` split keeps that swap local.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-14-invoice-engine.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration (REQUIRED SUB-SKILL: superpowers:subagent-driven-development).

**2. Inline Execution** — execute tasks in this session with checkpoints (REQUIRED SUB-SKILL: superpowers:executing-plans).

**Note:** building should branch off the catalog branch (this plan's branch already does). Phases 1→6 are sequential PRs; each leaves the tree green. Phase 1 + the integration tests (3.6–3.8, 5.1) need a real local Postgres with the `.env.test` symlink and a non-`BYPASSRLS` role.

**Which approach?**
