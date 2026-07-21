# Quotes / Proposals — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the internal-facing foundation of the Quotes/Proposals subsystem — schema, migration, RBAC, totals math, service, RBAC-gated CRUD routes, block-based editor, and PDF — as a complete, testable vertical slice.

**Architecture:** New `quotes` subsystem modeled on `invoices`. Dual-axis (org_id + partner_id) tables with org-axis RLS (shape 1, `org_id` NOT NULL). A quote carries ordered content blocks (`quote_blocks`) and pricing lines (`quote_lines`, attachable to a `line_items` block), plus `quote_images` (bytea) and `quote_acceptances`. Totals are computed into one-time / monthly / annual recurring buckets. Internal routes are gated by new `QUOTES_*` permissions; the customer-portal view, public token acceptance, and accept→invoice conversion are deferred to Phase 2/3 (separate plans).

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (hand-written SQL migrations, RLS), Zod validators in `@breeze/shared`, pdfkit for PDF, Astro + React islands for web, Vitest (+ RLS/integration configs).

**Spec:** `docs/superpowers/specs/billing/2026-06-16-quotes-proposals-design.md`

**Scope note:** This plan covers spec §1 (data model), §2 (lifecycle, draft/sent only), §5 (internal routes + RBAC), §6 (internal web), §7 (validators/types), and the §8 tests that apply to the above. Spec §3 (convert-to-invoice), §4 (portal + public accept + e-sign), and the `sent→accepted/declined/expired` transitions are Phase 2/3.

**Conventions reused (read before starting):**
- Migrations: `apps/api/migrations/`, filename `YYYY-MM-DD-<slug>.sql`, idempotent, no inner `BEGIN/COMMIT`. Same-day ordering uses `-a-`/`-b-` infix.
- Reference files to mirror: `apps/api/src/db/schema/invoices.ts`, `apps/api/migrations/2026-06-15-d-recurring-contracts.sql`, `packages/shared/src/validators/invoices.ts`, `apps/api/src/routes/invoices/invoices.ts`, `apps/api/src/services/invoiceTypes.ts`.
- DB context: request paths use `withDbAccessContext`; bare pool is forbidden in request code.
- Node: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- API unit tests run with no DATABASE_URL — real-DB tests MUST be `*.integration.test.ts` under `apps/api/src/__tests__/integration/`.

---

## File Structure

**Create:**
- `apps/api/src/db/schema/quotes.ts` — Drizzle schema for all quote tables.
- `apps/api/migrations/2026-06-16-quotes.sql` — tables, RLS, permission rows + role seeding, catalog columns.
- `packages/shared/src/validators/quotes.ts` — Zod schemas + inferred types.
- `apps/api/src/services/quoteTypes.ts` — `QuoteActor`, error class, status/enum types.
- `apps/api/src/services/quoteMath.ts` — pure totals/recurrence-bucket computation.
- `apps/api/src/services/quoteMath.test.ts` — unit tests for the math.
- `apps/api/src/services/quoteService.ts` — CRUD for quotes, lines, blocks, images.
- `apps/api/src/routes/quotes/index.ts` — route aggregator + mount export.
- `apps/api/src/routes/quotes/quotes.ts` — CRUD + line/block/image routes.
- `apps/api/src/routes/quotes/quotes.test.ts` — route permission/wiring tests (mocked service).
- `apps/api/src/services/quotePdf.ts` — pdfkit renderer (blocks in order).
- `apps/api/src/__tests__/integration/quotes-rls.integration.test.ts` — functional cross-tenant forge test.
- `apps/web/src/lib/api/quotes.ts` — fetch wrappers.
- `apps/web/src/components/billing/quotes/quoteTypes.ts` — TS types + format helpers.
- `apps/web/src/components/billing/quotes/QuotesPage.tsx` — list view.
- `apps/web/src/components/billing/quotes/QuoteWorkspace.tsx` — tabs container.
- `apps/web/src/components/billing/quotes/QuoteEditor.tsx` — block + line editor with live totals.
- `apps/web/src/components/billing/quotes/QuoteDetail.tsx` — read view.
- `apps/web/src/pages/billing/quotes.astro` — list page.
- `apps/web/src/pages/billing/quotes/[id].astro` — workspace page.

**Modify:**
- `apps/api/src/db/schema/catalog.ts` — add `billingFrequency`, `commitmentTermMonths`.
- `apps/api/src/db/schema/index.ts` (or wherever schema barrel re-exports live) — export `./quotes`.
- `apps/api/src/services/permissions.ts:281` — add `QUOTES_*` constants after contracts.
- `packages/shared/src/index.ts` — export `./validators/quotes`.
- `packages/shared/src/validators/catalog.ts` — add the two new optional fields.
- `apps/api/src/index.ts` (route mount file) — mount `quoteRoutes` at `/api/v1/quotes`.
- `apps/api/src/services/tenantCascade.ts:58` — add quote tables to `ORG_CASCADE_DELETE_ORDER`.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:96` — add `partner_quote_sequences` to `PARTNER_TENANT_TABLES`.
- `apps/web/src/components/layout/Sidebar` (operations/billing nav) — add Quotes link near Invoices.

---

## Task 1: Catalog subscription fields (schema + validators)

Adds the two minimal fields quotes snapshot from catalog items. Self-contained; ships independently.

**Files:**
- Modify: `apps/api/src/db/schema/catalog.ts`
- Modify: `packages/shared/src/validators/catalog.ts`
- Test: `packages/shared/src/validators/catalog.test.ts`

- [ ] **Step 1: Add the failing validator test**

In `packages/shared/src/validators/catalog.test.ts`, add (create the file if missing, mirroring sibling validator tests):

```ts
import { describe, it, expect } from 'vitest';
import { createCatalogItemSchema } from './catalog';

describe('catalog subscription fields', () => {
  it('accepts billingFrequency + commitmentTermMonths', () => {
    const parsed = createCatalogItemSchema.parse({
      itemType: 'software', name: 'Microsoft 365 Business Premium',
      billingType: 'recurring', unitPrice: 22, unitOfMeasure: 'seat',
      taxable: true, isBundle: false,
      billingFrequency: 'monthly', commitmentTermMonths: 12,
    });
    expect(parsed.billingFrequency).toBe('monthly');
    expect(parsed.commitmentTermMonths).toBe(12);
  });

  it('rejects an unknown billingFrequency', () => {
    expect(() => createCatalogItemSchema.parse({
      itemType: 'software', name: 'x', billingType: 'recurring',
      unitPrice: 1, unitOfMeasure: 'seat', taxable: true, isBundle: false,
      billingFrequency: 'weekly',
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/catalog.test.ts`
Expected: FAIL (`billingFrequency` stripped/unknown or schema rejects valid input).

- [ ] **Step 3: Add the fields to the shared validators**

In `packages/shared/src/validators/catalog.ts`, add the enum and extend create/update schemas:

```ts
export const catalogBillingFrequencySchema = z.enum(['monthly', 'quarterly', 'annual']);
```

Add to `createCatalogItemSchema` object (and `.partial()`-equivalent `updateCatalogItemSchema`):

```ts
  billingFrequency: catalogBillingFrequencySchema.nullable().optional(),
  commitmentTermMonths: z.number().int().min(1).max(120).nullable().optional(),
```

- [ ] **Step 4: Add the Drizzle columns**

In `apps/api/src/db/schema/catalog.ts`, add the enum near the existing enums:

```ts
export const catalogBillingFrequencyEnum = pgEnum('catalog_billing_frequency', ['monthly', 'quarterly', 'annual']);
```

Add columns inside the `catalogItems` table object after `billingType`:

```ts
  billingFrequency: catalogBillingFrequencyEnum('billing_frequency'),
  commitmentTermMonths: integer('commitment_term_months'),
```

Add `integer` to the `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 5: Run validator test, confirm pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/catalog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/catalog.ts packages/shared/src/validators/catalog.ts packages/shared/src/validators/catalog.test.ts
git commit -m "feat(catalog): add billingFrequency + commitmentTermMonths for subscription items"
```

---

## Task 2: QUOTES_* permission constants

**Files:**
- Modify: `apps/api/src/services/permissions.ts`

- [ ] **Step 1: Add the constants**

In `apps/api/src/services/permissions.ts`, immediately after the `CONTRACTS_*` block (ends at line 281), insert:

```ts
  // Quotes / Proposals (billing program — sub-project 4)
  QUOTES_READ: { resource: 'quotes', action: 'read' },
  QUOTES_WRITE: { resource: 'quotes', action: 'write' },
  QUOTES_SEND: { resource: 'quotes', action: 'send' },
```

- [ ] **Step 2: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors (pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` are known per CLAUDE.md).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/permissions.ts
git commit -m "feat(quotes): register QUOTES_READ/WRITE/SEND permissions"
```

---

## Task 3: Shared validators + types

**Files:**
- Create: `packages/shared/src/validators/quotes.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/validators/quotes.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/validators/quotes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createQuoteSchema, quoteLineInputSchema, quoteBlockInputSchema, listQuotesQuerySchema,
} from './quotes';

describe('quote validators', () => {
  it('accepts a minimal create payload', () => {
    const q = createQuoteSchema.parse({ orgId: '11111111-1111-1111-1111-111111111111' });
    expect(q.currencyCode).toBe('USD');
  });

  it('parses a recurring catalog line with term', () => {
    const line = quoteLineInputSchema.parse({
      sourceType: 'catalog', catalogItemId: '22222222-2222-2222-2222-222222222222',
      description: 'M365', quantity: 10, unitPrice: 22, taxable: true,
      recurrence: 'monthly', termMonths: 12,
    });
    expect(line.recurrence).toBe('monthly');
  });

  it('rejects a heading block with no text', () => {
    expect(() => quoteBlockInputSchema.parse({ blockType: 'heading', content: {} })).toThrow();
  });

  it('defaults list limit to 50', () => {
    expect(listQuotesQuerySchema.parse({}).limit).toBe(50);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/quotes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the validators**

`packages/shared/src/validators/quotes.ts`:

```ts
import { z } from 'zod';

const money = z.number().nonnegative().multipleOf(0.01);
const positiveQty = z.number().positive().multipleOf(0.01);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const taxRate = z.number().min(0).max(1);

export const quoteStatusSchema = z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted']);
export const quoteLineRecurrenceSchema = z.enum(['one_time', 'monthly', 'annual']);
export const quoteLineSourceTypeSchema = z.enum(['catalog', 'bundle', 'manual']);
export const quoteBlockTypeSchema = z.enum(['heading', 'rich_text', 'image', 'line_items']);

// Block content shapes, discriminated by blockType.
const headingContent = z.object({ text: z.string().min(1).max(300), level: z.number().int().min(1).max(3).default(2) });
const richTextContent = z.object({ html: z.string().max(50_000) });
const imageContent = z.object({ imageId: z.string().uuid(), caption: z.string().max(500).optional(), width: z.number().int().min(50).max(2000).optional() });
const lineItemsContent = z.object({ label: z.string().max(200).optional() });

export const quoteBlockInputSchema = z.discriminatedUnion('blockType', [
  z.object({ blockType: z.literal('heading'), content: headingContent }),
  z.object({ blockType: z.literal('rich_text'), content: richTextContent }),
  z.object({ blockType: z.literal('image'), content: imageContent }),
  z.object({ blockType: z.literal('line_items'), content: lineItemsContent }),
]);

export const quoteLineInputSchema = z.object({
  sourceType: quoteLineSourceTypeSchema,
  catalogItemId: z.string().uuid().optional(),
  blockId: z.string().uuid().optional(),
  description: z.string().min(1).max(2000),
  quantity: positiveQty,
  unitPrice: money,
  taxable: z.boolean(),
  customerVisible: z.boolean().default(true),
  recurrence: quoteLineRecurrenceSchema.default('one_time'),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  billingFrequency: z.enum(['monthly', 'quarterly', 'annual']).nullable().optional(),
});

export const catalogQuoteLineSchema = z.object({ catalogItemId: z.string().uuid(), quantity: positiveQty, blockId: z.string().uuid().optional() });
export const bundleQuoteLineSchema = z.object({ bundleId: z.string().uuid(), quantity: positiveQty, blockId: z.string().uuid().optional() });

export const updateQuoteLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional(),
  recurrence: quoteLineRecurrenceSchema.optional(),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createQuoteSchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  currencyCode: z.string().length(3).default('USD'),
  expiryDate: isoDate.optional(),
  introNotes: z.string().max(5000).optional(),
  terms: z.string().max(20_000).optional(),
});

export const updateQuoteSchema = z.object({
  siteId: z.string().uuid().nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  introNotes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  taxRate: taxRate.nullable().optional(),
  billToName: z.string().max(255).nullable().optional(),
});

export const reorderBlocksSchema = z.object({ blockIds: z.array(z.string().uuid()).min(1) });

export const listQuotesQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: quoteStatusSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;
export type QuoteBlockInput = z.infer<typeof quoteBlockInputSchema>;
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;
```

- [ ] **Step 4: Export from the shared barrel**

In `packages/shared/src/index.ts`, add alongside the other validator exports:

```ts
export * from './validators/quotes';
```

- [ ] **Step 5: Run test, confirm pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/quotes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.test.ts packages/shared/src/index.ts
git commit -m "feat(quotes): shared Zod validators and types"
```

---

## Task 4: Drizzle schema

**Files:**
- Create: `apps/api/src/db/schema/quotes.ts`
- Modify: `apps/api/src/db/schema/index.ts` (schema barrel)

- [ ] **Step 1: Write the schema file**

`apps/api/src/db/schema/quotes.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, customType, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

// bytea mapped to Buffer (same pattern as users.avatarData).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});

export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted'
]);
export const quoteLineSourceTypeEnum = pgEnum('quote_line_source_type', ['catalog', 'bundle', 'manual']);
export const quoteLineRecurrenceEnum = pgEnum('quote_line_recurrence', ['one_time', 'monthly', 'annual']);
export const quoteBlockTypeEnum = pgEnum('quote_block_type', ['heading', 'rich_text', 'image', 'line_items']);

function sqlNumberPresent(t: { quoteNumber: unknown }): SQL { return sql`${t.quoteNumber} IS NOT NULL`; }
function sqlOpenForExpiry(t: { status: unknown }): SQL { return sql`${t.status} IN ('sent','viewed')`; }

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id'),
  quoteNumber: varchar('quote_number', { length: 40 }),
  status: quoteStatusEnum('status').notNull().default('draft'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  issueDate: date('issue_date'),
  expiryDate: date('expiry_date'),
  acceptedAt: timestamp('accepted_at'),
  declinedAt: timestamp('declined_at'),
  convertedAt: timestamp('converted_at'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 6, scale: 3 }),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  oneTimeTotal: numeric('one_time_total', { precision: 12, scale: 2 }).notNull().default('0'),
  monthlyRecurringTotal: numeric('monthly_recurring_total', { precision: 12, scale: 2 }).notNull().default('0'),
  annualRecurringTotal: numeric('annual_recurring_total', { precision: 12, scale: 2 }).notNull().default('0'),
  billToName: varchar('bill_to_name', { length: 255 }),
  billToAddress: jsonb('bill_to_address'),
  billToTaxId: varchar('bill_to_tax_id', { length: 100 }),
  introNotes: text('intro_notes'),
  terms: text('terms'),
  convertedInvoiceId: uuid('converted_invoice_id'),
  pdfDocumentRef: text('pdf_document_ref'),
  pdfSha256: char('pdf_sha256', { length: 64 }),
  sentAt: timestamp('sent_at'),
  firstViewedAt: timestamp('first_viewed_at'),
  viewedAt: timestamp('viewed_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('quotes_org_status_idx').on(t.orgId, t.status),
  index('quotes_partner_status_idx').on(t.partnerId, t.status),
  index('quotes_org_issue_date_idx').on(t.orgId, t.issueDate),
  index('quotes_expiry_idx').on(t.expiryDate).where(sqlOpenForExpiry(t)),
  uniqueIndex('quotes_partner_number_uq').on(t.partnerId, t.quoteNumber).where(sqlNumberPresent(t)),
  uniqueIndex('quotes_id_org_uq').on(t.id, t.orgId)
]);

export const quoteBlocks = pgTable('quote_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  blockType: quoteBlockTypeEnum('block_type').notNull(),
  content: jsonb('content').notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_blocks_quote_sort_idx').on(t.quoteId, t.sortOrder),
  index('quote_blocks_org_idx').on(t.orgId)
]);

export const quoteLines = pgTable('quote_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  blockId: uuid('block_id').references((): AnyPgColumn => quoteBlocks.id, { onDelete: 'set null' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: quoteLineSourceTypeEnum('source_type').notNull(),
  catalogItemId: uuid('catalog_item_id'),
  parentLineId: uuid('parent_line_id').references((): AnyPgColumn => quoteLines.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  taxable: boolean('taxable').notNull().default(false),
  customerVisible: boolean('customer_visible').notNull().default(true),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull().default('0'),
  recurrence: quoteLineRecurrenceEnum('recurrence').notNull().default('one_time'),
  termMonths: integer('term_months'),
  billingFrequency: varchar('billing_frequency', { length: 20 }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_lines_quote_sort_idx').on(t.quoteId, t.sortOrder),
  index('quote_lines_block_idx').on(t.blockId),
  index('quote_lines_org_idx').on(t.orgId)
]);

export const quoteImages = pgTable('quote_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  imageData: bytea('image_data').notNull(),
  mime: varchar('mime', { length: 64 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_images_quote_idx').on(t.quoteId),
  index('quote_images_org_idx').on(t.orgId)
]);

export const quoteAcceptances = pgTable('quote_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  signerName: varchar('signer_name', { length: 255 }).notNull(),
  signerEmail: varchar('signer_email', { length: 255 }),
  signedAt: timestamp('signed_at').defaultNow().notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
  quoteSha256: char('quote_sha256', { length: 64 }).notNull(),
  acceptanceTokenJti: varchar('acceptance_token_jti', { length: 128 }),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_acceptances_quote_idx').on(t.quoteId),
  index('quote_acceptances_org_idx').on(t.orgId)
]);

export const partnerQuoteSequences = pgTable('partner_quote_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.partnerId, t.year] })
]);
```

- [ ] **Step 2: Export from the schema barrel**

In `apps/api/src/db/schema/index.ts`, add: `export * from './quotes';` (place near the `./invoices` and `./contracts` exports).

- [ ] **Step 3: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/quotes.ts apps/api/src/db/schema/index.ts
git commit -m "feat(quotes): Drizzle schema for quote tables"
```

---

## Task 5: SQL migration (tables + RLS + permissions + catalog columns)

**Files:**
- Create: `apps/api/migrations/2026-06-16-quotes.sql`

- [ ] **Step 1: Write the migration**

Mirror `2026-06-15-d-recurring-contracts.sql` exactly for structure. `apps/api/migrations/2026-06-16-quotes.sql`:

```sql
-- Quotes / Proposals (billing program sub-project 4). Idempotent throughout.
-- Depends on partners/organizations/users/catalog_items from earlier migrations.

-- Catalog subscription fields (minimal, quotes-driven).
DO $$ BEGIN
  CREATE TYPE catalog_billing_frequency AS ENUM ('monthly','quarterly','annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS billing_frequency catalog_billing_frequency;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS commitment_term_months INTEGER;

DO $$ BEGIN CREATE TYPE quote_status AS ENUM
  ('draft','sent','viewed','accepted','declined','expired','converted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE quote_line_source_type AS ENUM ('catalog','bundle','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE quote_line_recurrence AS ENUM ('one_time','monthly','annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE quote_block_type AS ENUM ('heading','rich_text','image','line_items');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  site_id UUID,
  quote_number VARCHAR(40),
  status quote_status NOT NULL DEFAULT 'draft',
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  issue_date DATE,
  expiry_date DATE,
  accepted_at TIMESTAMP,
  declined_at TIMESTAMP,
  converted_at TIMESTAMP,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,3),
  tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  one_time_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  monthly_recurring_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  annual_recurring_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  bill_to_name VARCHAR(255),
  bill_to_address JSONB,
  bill_to_tax_id VARCHAR(100),
  intro_notes TEXT,
  terms TEXT,
  converted_invoice_id UUID,
  pdf_document_ref TEXT,
  pdf_sha256 CHAR(64),
  sent_at TIMESTAMP,
  first_viewed_at TIMESTAMP,
  viewed_at TIMESTAMP,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_site_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_converted_invoice_fkey
    FOREIGN KEY (converted_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- dual-axis composite FK: (org_id, partner_id) must reference a real org of that partner
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_org_partner_fkey
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS quotes_org_status_idx ON quotes (org_id, status);
CREATE INDEX IF NOT EXISTS quotes_partner_status_idx ON quotes (partner_id, status);
CREATE INDEX IF NOT EXISTS quotes_org_issue_date_idx ON quotes (org_id, issue_date);
CREATE INDEX IF NOT EXISTS quotes_expiry_idx ON quotes (expiry_date) WHERE status IN ('sent','viewed');
CREATE UNIQUE INDEX IF NOT EXISTS quotes_partner_number_uq ON quotes (partner_id, quote_number) WHERE quote_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quotes_id_org_uq ON quotes (id, org_id);

CREATE TABLE IF NOT EXISTS quote_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  block_type quote_block_type NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_blocks_quote_sort_idx ON quote_blocks (quote_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_blocks_org_idx ON quote_blocks (org_id);

CREATE TABLE IF NOT EXISTS quote_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  block_id UUID REFERENCES quote_blocks(id) ON DELETE SET NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_type quote_line_source_type NOT NULL,
  catalog_item_id UUID,
  parent_line_id UUID REFERENCES quote_lines(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  recurrence quote_line_recurrence NOT NULL DEFAULT 'one_time',
  term_months INTEGER,
  billing_frequency VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_catalog_item_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS quote_lines_quote_sort_idx ON quote_lines (quote_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_lines_block_idx ON quote_lines (block_id);
CREATE INDEX IF NOT EXISTS quote_lines_org_idx ON quote_lines (org_id);

CREATE TABLE IF NOT EXISTS quote_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  image_data BYTEA NOT NULL,
  mime VARCHAR(64) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_images_quote_idx ON quote_images (quote_id);
CREATE INDEX IF NOT EXISTS quote_images_org_idx ON quote_images (org_id);

CREATE TABLE IF NOT EXISTS quote_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  signer_name VARCHAR(255) NOT NULL,
  signer_email VARCHAR(255),
  signed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ip_address VARCHAR(64),
  user_agent TEXT,
  quote_sha256 CHAR(64) NOT NULL,
  acceptance_token_jti VARCHAR(128),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_acceptances_quote_idx ON quote_acceptances (quote_id);
CREATE INDEX IF NOT EXISTS quote_acceptances_org_idx ON quote_acceptances (org_id);

CREATE TABLE IF NOT EXISTS partner_quote_sequences (
  partner_id UUID NOT NULL REFERENCES partners(id),
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, year)
);

-- RLS: shape 1 (direct org_id) on the five org-scoped tables.
-- partner_quote_sequences is partner-axis (shape 3) — handled below.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['quotes','quote_blocks','quote_lines','quote_images','quote_acceptances']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_select ON %I FOR SELECT USING (public.breeze_has_org_access(org_id))', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON %I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_update ON %I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON %I FOR DELETE USING (public.breeze_has_org_access(org_id))', tbl);
  END LOOP;
END $$;

-- partner_quote_sequences: partner-axis flat policy (mirror partner_invoice_sequences).
ALTER TABLE partner_quote_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_quote_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON partner_quote_sequences;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON partner_quote_sequences;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON partner_quote_sequences;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON partner_quote_sequences;
CREATE POLICY breeze_partner_isolation_select ON partner_quote_sequences
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON partner_quote_sequences
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON partner_quote_sequences
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON partner_quote_sequences
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- Permissions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='quotes' AND action='read') THEN
    INSERT INTO permissions (resource, action, description) VALUES ('quotes','read','View quotes/proposals, lines, and blocks');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='quotes' AND action='write') THEN
    INSERT INTO permissions (resource, action, description) VALUES ('quotes','write','Create/edit/delete draft quotes, lines, and blocks');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='quotes' AND action='send') THEN
    INSERT INTO permissions (resource, action, description) VALUES ('quotes','send','Issue and send quotes to customers');
  END IF;
END $$;

-- Seed read/write/send onto partner-scope system roles that hold tickets:write
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource='tickets' AND p1.action='write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope='partner'
JOIN permissions p2 ON p2.resource='quotes' AND p2.action IN ('read','write','send')
WHERE NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id);

-- Seed read onto partner-scope system roles that hold only tickets:read (viewers)
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource='tickets' AND p1.action='read'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope='partner'
JOIN permissions p2 ON p2.resource='quotes' AND p2.action='read'
WHERE NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id);
```

- [ ] **Step 2: Apply the migration locally**

Ensure local Postgres is up, then run the migration via the API's migrate path:

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts`
Expected: applies `2026-06-16-quotes.sql` with no error; re-running is a no-op.
(If the project has no standalone migrate entrypoint, apply by booting the API once against the dev DB, which runs `autoMigrate` at startup.)

- [ ] **Step 3: Verify no schema drift**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift`
Expected: no drift between `apps/api/src/db/schema/*` and the DB.

- [ ] **Step 4: Manually verify RLS as breeze_app (forge an unauthorized insert)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "INSERT INTO quotes (partner_id, org_id) VALUES (gen_random_uuid(), gen_random_uuid());"
```
Expected: `ERROR: new row violates row-level security policy for table "quotes"`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-16-quotes.sql
git commit -m "feat(quotes): migration — tables, RLS, permissions, catalog subscription columns"
```

---

## Task 6: Cascade + RLS-coverage registration

Required so org deletion / GDPR erasure cleans up quotes, and so the RLS contract test recognizes the partner-axis sequence table. (Per memory: org_id tables must be in `ORG_CASCADE_DELETE_ORDER`; only the Integration Tests job catches a miss.)

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Add quote tables to ORG_CASCADE_DELETE_ORDER**

In `apps/api/src/services/tenantCascade.ts`, inside the `ORG_CASCADE_DELETE_ORDER` array (starts line 58), add — placed so children precede parents, before the `contracts`/`invoices` block is fine since there are no cross-FKs from those to quotes:

```ts
  'quote_acceptances',
  'quote_images',
  'quote_lines',
  'quote_blocks',
  'quotes',
```

(Do NOT add `partner_quote_sequences` — it has no `org_id`, so it is not part of org cascade. Same as `partner_invoice_sequences`.)

- [ ] **Step 2: Add the sequence table to the RLS partner allowlist**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, find `PARTNER_TENANT_TABLES` (line 96) and add an entry mirroring `partner_invoice_sequences`. The map value is the partner-id column name:

```ts
  ['partner_quote_sequences', 'partner_id'],
```

(The five org-scoped quote tables are auto-discovered by their `org_id` column — no allowlist entry needed.)

- [ ] **Step 3: Run the cascade contract test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts`
Expected: PASS (every `org_id` table is represented in the delete order).

- [ ] **Step 4: Run the RLS coverage contract test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run -c vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS (all quote tables have RLS forced + four policies).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(quotes): register quote tables in tenant cascade + RLS coverage allowlist"
```

---

## Task 7: Totals / recurrence-bucket math (pure, TDD)

Isolated pure function so the bucket logic is unit-tested without a DB.

**Files:**
- Create: `apps/api/src/services/quoteMath.ts`
- Test: `apps/api/src/services/quoteMath.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/quoteMath.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeQuoteTotals, type QuoteLineForMath } from './quoteMath';

const line = (over: Partial<QuoteLineForMath>): QuoteLineForMath => ({
  quantity: '1', unitPrice: '0', taxable: false, recurrence: 'one_time', customerVisible: true, ...over,
});

describe('computeQuoteTotals', () => {
  it('buckets one-time vs monthly vs annual', () => {
    const r = computeQuoteTotals([
      line({ quantity: '2', unitPrice: '500', recurrence: 'one_time', taxable: true }),   // 1000 one-time
      line({ quantity: '10', unitPrice: '22', recurrence: 'monthly', taxable: true }),      // 220/mo
      line({ quantity: '1', unitPrice: '1200', recurrence: 'annual', taxable: false }),     // 1200/yr
    ], 0.1);
    expect(r.oneTimeTotal).toBe('1000.00');
    expect(r.monthlyRecurringTotal).toBe('220.00');
    expect(r.annualRecurringTotal).toBe('1200.00');
    // subtotal = first invoice basis = one-time + first monthly + first annual period
    expect(r.subtotal).toBe('2420.00');
    // tax applies only to taxable lines (1000 + 220 = 1220) * 0.1 = 122.00
    expect(r.taxTotal).toBe('122.00');
    expect(r.total).toBe('2542.00');
  });

  it('excludes non-customer-visible lines from totals', () => {
    const r = computeQuoteTotals([
      line({ quantity: '1', unitPrice: '100', recurrence: 'one_time', customerVisible: false }),
    ], 0);
    expect(r.subtotal).toBe('0.00');
  });

  it('treats null taxRate as zero tax', () => {
    const r = computeQuoteTotals([line({ quantity: '1', unitPrice: '100', recurrence: 'one_time', taxable: true })], null);
    expect(r.taxTotal).toBe('0.00');
    expect(r.total).toBe('100.00');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/quoteMath.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the math**

`apps/api/src/services/quoteMath.ts`:

```ts
export interface QuoteLineForMath {
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  customerVisible: boolean;
  recurrence: 'one_time' | 'monthly' | 'annual';
}

export interface QuoteTotals {
  subtotal: string;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
}

// Work in integer cents to avoid float drift, then format to 2dp strings.
function cents(n: string): number { return Math.round(parseFloat(n) * 100); }
function fmt(c: number): string { return (c / 100).toFixed(2); }

export function computeQuoteTotals(lines: QuoteLineForMath[], taxRate: number | null): QuoteTotals {
  let oneTime = 0, monthly = 0, annual = 0, taxableBasis = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    const lineCents = Math.round((cents(l.quantity) / 100) * cents(l.unitPrice));
    if (l.recurrence === 'monthly') monthly += lineCents;
    else if (l.recurrence === 'annual') annual += lineCents;
    else oneTime += lineCents;
    if (l.taxable) taxableBasis += lineCents;
  }
  // First-invoice basis: one-time + first monthly period + first annual period.
  const subtotal = oneTime + monthly + annual;
  const tax = taxRate ? Math.round(taxableBasis * taxRate) : 0;
  return {
    subtotal: fmt(subtotal),
    taxTotal: fmt(tax),
    total: fmt(subtotal + tax),
    oneTimeTotal: fmt(oneTime),
    monthlyRecurringTotal: fmt(monthly),
    annualRecurringTotal: fmt(annual),
  };
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/quoteMath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteMath.ts apps/api/src/services/quoteMath.test.ts
git commit -m "feat(quotes): pure totals/recurrence-bucket math"
```

---

## Task 8: Quote service (CRUD, lines, blocks, images)

**Files:**
- Create: `apps/api/src/services/quoteTypes.ts`
- Create: `apps/api/src/services/quoteService.ts`

- [ ] **Step 1: Write the types file**

`apps/api/src/services/quoteTypes.ts` (mirror `invoiceTypes.ts`):

```ts
export type QuoteStatus = 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';

export interface QuoteActor {
  userId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
}

export type QuoteServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE' | 'ORG_DENIED' | 'QUOTE_NOT_FOUND' | 'NOT_A_DRAFT'
  | 'LINE_NOT_FOUND' | 'BLOCK_NOT_FOUND' | 'IMAGE_NOT_FOUND' | 'INVALID_IMAGE'
  | 'CATALOG_ITEM_NOT_FOUND' | 'INVALID_STATE';

export class QuoteServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: QuoteServiceErrorCode
  ) {
    super(message);
    this.name = 'QuoteServiceError';
  }
}
```

- [ ] **Step 2: Write the service**

`apps/api/src/services/quoteService.ts`. Follows the invoiceService pattern: every public function runs inside `withDbAccessContext` for the actor, resolves the partner, guards org access, recomputes totals after any line change. Key functions:

```ts
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { withDbAccessContext } from '../db';
import { quotes, quoteLines, quoteBlocks, quoteImages } from '../db/schema/quotes';
import { catalogItems } from '../db/schema/catalog';
import { computeQuoteTotals, type QuoteLineForMath } from './quoteMath';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import type { CreateQuoteInput, UpdateQuoteInput, QuoteLineInput, QuoteBlockInput, ListQuotesQuery } from '@breeze/shared';

function resolvePartner(actor: QuoteActor): string {
  if (!actor.partnerId) throw new QuoteServiceError('Partner could not be resolved', 403, 'PARTNER_UNRESOLVABLE');
  return actor.partnerId;
}
function assertOrg(actor: QuoteActor, orgId: string): void {
  if (actor.accessibleOrgIds && !actor.accessibleOrgIds.includes(orgId)) {
    throw new QuoteServiceError('Org access denied', 403, 'ORG_DENIED');
  }
}

export async function createQuote(input: CreateQuoteInput, actor: QuoteActor) {
  const partnerId = resolvePartner(actor);
  assertOrg(actor, input.orgId);
  return withDbAccessContext(actor, async (db) => {
    const [row] = await db.insert(quotes).values({
      partnerId, orgId: input.orgId, siteId: input.siteId ?? null,
      currencyCode: input.currencyCode, expiryDate: input.expiryDate ?? null,
      introNotes: input.introNotes ?? null, terms: input.terms ?? null,
      createdBy: actor.userId,
    }).returning();
    return row;
  });
}

async function recomputeAndPersist(db: any, quoteId: string): Promise<void> {
  const [q] = await db.select({ taxRate: quotes.taxRate }).from(quotes).where(eq(quotes.id, quoteId));
  const lines = await db.select({
    quantity: quoteLines.quantity, unitPrice: quoteLines.unitPrice, taxable: quoteLines.taxable,
    customerVisible: quoteLines.customerVisible, recurrence: quoteLines.recurrence,
  }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], q?.taxRate ? parseFloat(q.taxRate) : null);
  await db.update(quotes).set({
    subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total,
    oneTimeTotal: totals.oneTimeTotal, monthlyRecurringTotal: totals.monthlyRecurringTotal,
    annualRecurringTotal: totals.annualRecurringTotal, updatedAt: new Date(),
  }).where(eq(quotes.id, quoteId));
}

async function loadDraft(db: any, quoteId: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertOrg(actor, q.orgId);
  if (q.status !== 'draft') throw new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT');
  return q;
}

export async function getQuote(id: string, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
    if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
    assertOrg(actor, q.orgId);
    const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder);
    return { quote: q, blocks, lines };
  });
}

export async function listQuotes(query: ListQuotesQuery, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    const conds = [] as any[];
    if (query.orgId) { assertOrg(actor, query.orgId); conds.push(eq(quotes.orgId, query.orgId)); }
    if (query.status) conds.push(eq(quotes.status, query.status));
    if (query.cursor) conds.push(lt(quotes.id, query.cursor));
    const rows = await db.select().from(quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(quotes.createdAt)).limit(query.limit);
    return rows;
  });
}

export async function updateQuote(id: string, input: UpdateQuoteInput, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    await loadDraft(db, id, actor);
    await db.update(quotes).set({ ...input, updatedAt: new Date() }).where(eq(quotes.id, id));
    await recomputeAndPersist(db, id);
    return (await db.select().from(quotes).where(eq(quotes.id, id)))[0];
  });
}

export async function deleteDraftQuote(id: string, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    await loadDraft(db, id, actor);
    await db.delete(quotes).where(eq(quotes.id, id));
  });
}

export async function addBlock(quoteId: string, input: QuoteBlockInput, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    const q = await loadDraft(db, quoteId, actor);
    const [{ max }] = await db.select({ max: sql<number>`COALESCE(MAX(${quoteBlocks.sortOrder}), -1)` }).from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId));
    const [row] = await db.insert(quoteBlocks).values({
      quoteId, orgId: q.orgId, blockType: input.blockType, content: input.content, sortOrder: (max ?? -1) + 1,
    }).returning();
    return row;
  });
}

export async function addManualLine(quoteId: string, input: QuoteLineInput, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    const q = await loadDraft(db, quoteId, actor);
    const lineTotal = (parseFloat(input.quantity as unknown as string) * parseFloat(input.unitPrice as unknown as string)).toFixed(2);
    const [{ max }] = await db.select({ max: sql<number>`COALESCE(MAX(${quoteLines.sortOrder}), -1)` }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    const [row] = await db.insert(quoteLines).values({
      quoteId, orgId: q.orgId, blockId: input.blockId ?? null, sourceType: input.sourceType,
      catalogItemId: input.catalogItemId ?? null, description: input.description,
      quantity: String(input.quantity), unitPrice: String(input.unitPrice), taxable: input.taxable,
      customerVisible: input.customerVisible, lineTotal, recurrence: input.recurrence,
      termMonths: input.termMonths ?? null, billingFrequency: input.billingFrequency ?? null,
      sortOrder: (max ?? -1) + 1,
    }).returning();
    await recomputeAndPersist(db, quoteId);
    return row;
  });
}

// addCatalogLine: load the catalog item, SNAPSHOT recurrence/term/frequency/price,
// then delegate to the same insert path.
export async function addCatalogLine(quoteId: string, catalogItemId: string, quantity: number, blockId: string | undefined, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    const q = await loadDraft(db, quoteId, actor);
    const [item] = await db.select().from(catalogItems).where(eq(catalogItems.id, catalogItemId));
    if (!item) throw new QuoteServiceError('Catalog item not found', 404, 'CATALOG_ITEM_NOT_FOUND');
    const recurrence = item.billingType === 'recurring'
      ? (item.billingFrequency === 'annual' ? 'annual' : 'monthly')
      : 'one_time';
    const lineTotal = (quantity * parseFloat(item.unitPrice)).toFixed(2);
    const [{ max }] = await db.select({ max: sql<number>`COALESCE(MAX(${quoteLines.sortOrder}), -1)` }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    const [row] = await db.insert(quoteLines).values({
      quoteId, orgId: q.orgId, blockId: blockId ?? null, sourceType: 'catalog', catalogItemId,
      description: item.name, quantity: String(quantity), unitPrice: item.unitPrice, taxable: item.taxable,
      customerVisible: true, lineTotal, recurrence,
      termMonths: item.commitmentTermMonths ?? null, billingFrequency: item.billingFrequency ?? null,
      sortOrder: (max ?? -1) + 1,
    }).returning();
    await recomputeAndPersist(db, quoteId);
    return row;
  });
}

export async function updateLine(quoteId: string, lineId: string, input: Record<string, unknown>, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    await loadDraft(db, quoteId, actor);
    const [line] = await db.select().from(quoteLines).where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));
    if (!line) throw new QuoteServiceError('Line not found', 404, 'LINE_NOT_FOUND');
    const next = { ...line, ...input };
    const lineTotal = (parseFloat(String(next.quantity)) * parseFloat(String(next.unitPrice))).toFixed(2);
    await db.update(quoteLines).set({ ...input, lineTotal }).where(eq(quoteLines.id, lineId));
    await recomputeAndPersist(db, quoteId);
    return (await db.select().from(quoteLines).where(eq(quoteLines.id, lineId)))[0];
  });
}

export async function removeLine(quoteId: string, lineId: string, actor: QuoteActor) {
  return withDbAccessContext(actor, async (db) => {
    await loadDraft(db, quoteId, actor);
    await db.delete(quoteLines).where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));
    await recomputeAndPersist(db, quoteId);
  });
}
```

> Note for the implementer: confirm the exact `withDbAccessContext` signature in `apps/api/src/db/index.ts` (the research notes it wraps the callback in a transaction and exposes a scoped `db`). Match the call shape used in `invoiceService.ts`. The bundle-line expansion (`addBundleLine`) mirrors invoices' `addBundleLine` — port it in a follow-up step if time-boxed; manual + catalog lines are sufficient for the editor MVP.

- [ ] **Step 3: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors. Fix any signature mismatch against the real `withDbAccessContext`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/quoteTypes.ts apps/api/src/services/quoteService.ts
git commit -m "feat(quotes): quote service — CRUD, lines, blocks with snapshot + totals recompute"
```

---

## Task 9: Routes + mount (RBAC-gated)

**Files:**
- Create: `apps/api/src/routes/quotes/quotes.ts`
- Create: `apps/api/src/routes/quotes/index.ts`
- Create: `apps/api/src/routes/quotes/quotes.test.ts`
- Modify: `apps/api/src/index.ts` (route mount)

- [ ] **Step 1: Write the failing route test**

`apps/api/src/routes/quotes/quotes.test.ts` (mirror existing mocked route tests; mock the service + auth middleware so this runs in the no-DB unit job):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/quoteService', () => ({
  listQuotes: vi.fn(async () => [{ id: 'q1' }]),
  createQuote: vi.fn(async () => ({ id: 'q1' })),
  getQuote: vi.fn(async () => ({ quote: { id: 'q1' }, blocks: [], lines: [] })),
}));

// Mock auth middleware to inject a partner actor with the required permission.
vi.mock('../../middleware/auth', async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    requireScope: () => async (_c: any, next: any) => next(),
    requirePermission: () => async (_c: any, next: any) => next(),
  };
});

import { quoteCrudRoutes } from './quotes';

function ctx() {
  // minimal Hono test via app.request
  const { Hono } = require('hono');
  const app = new Hono();
  app.use('*', async (c: any, next: any) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['o1'] }); await next(); });
  app.route('/', quoteCrudRoutes);
  return app;
}

describe('quote routes', () => {
  beforeEach(() => vi.clearAllMocks());
  it('GET / returns data array', async () => {
    const res = await ctx().request('/');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ id: 'q1' }]);
  });
  it('POST / creates a quote', async () => {
    const res = await ctx().request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: '11111111-1111-1111-1111-111111111111' }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/quotes/quotes.test.ts`
Expected: FAIL (module `./quotes` not found).

- [ ] **Step 3: Write the routes**

`apps/api/src/routes/quotes/quotes.ts` (mirror `invoices/invoices.ts` exactly):

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createQuoteSchema, updateQuoteSchema, quoteLineInputSchema, catalogQuoteLineSchema,
  updateQuoteLineSchema, quoteBlockInputSchema, listQuotesQuerySchema,
} from '@breeze/shared';
import {
  createQuote, getQuote, listQuotes, updateQuote, deleteDraftQuote,
  addManualLine, addCatalogLine, updateLine, removeLine, addBlock,
} from '../../services/quoteService';
import { QuoteServiceError, type QuoteActor } from '../../services/quoteTypes';

export const quoteCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const idParam = z.object({ id: z.string().uuid() });
const lineParam = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });

export function quoteActorFrom(c: { get: (k: string) => unknown }): QuoteActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
function handle(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

quoteCrudRoutes.get('/', scopes, readPerm, zValidator('query', listQuotesQuerySchema), async (c) => {
  try { return c.json({ data: await listQuotes(c.req.valid('query'), quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.post('/', scopes, writePerm, zValidator('json', createQuoteSchema), async (c) => {
  try { return c.json({ data: await createQuote(c.req.valid('json'), quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await getQuote(c.req.valid('param').id, quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateQuoteSchema), async (c) => {
  try { return c.json({ data: await updateQuote(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { await deleteDraftQuote(c.req.valid('param').id, quoteActorFrom(c)); return c.json({ data: { ok: true } }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.post('/:id/blocks', scopes, writePerm, zValidator('param', idParam), zValidator('json', quoteBlockInputSchema), async (c) => {
  try { return c.json({ data: await addBlock(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', quoteLineInputSchema), async (c) => {
  try { return c.json({ data: await addManualLine(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.post('/:id/lines/catalog', scopes, writePerm, zValidator('param', idParam), zValidator('json', catalogQuoteLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addCatalogLine(c.req.valid('param').id, b.catalogItemId, b.quantity, b.blockId, quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.patch('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), zValidator('json', updateQuoteLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await updateLine(p.id, p.lineId, c.req.valid('json'), quoteActorFrom(c)) }); } catch (e) { return handle(c, e); }
});
quoteCrudRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try { const p = c.req.valid('param'); await removeLine(p.id, p.lineId, quoteActorFrom(c)); return c.json({ data: { ok: true } }); } catch (e) { return handle(c, e); }
});
```

`apps/api/src/routes/quotes/index.ts`:

```ts
import { Hono } from 'hono';
import { quoteCrudRoutes } from './quotes';

export const quoteRoutes = new Hono();
quoteRoutes.route('/', quoteCrudRoutes);
```

- [ ] **Step 4: Mount the routes**

In `apps/api/src/index.ts` (or the route-mount file), find where `invoiceRoutes` is mounted (`app.route('/api/v1/invoices', invoiceRoutes)` or similar) and add directly after it:

```ts
import { quoteRoutes } from './routes/quotes';
// ...
app.route('/api/v1/quotes', quoteRoutes);
```

- [ ] **Step 5: Run route test, confirm pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/quotes/quotes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/quotes/ apps/api/src/index.ts
git commit -m "feat(quotes): RBAC-gated CRUD routes mounted at /api/v1/quotes"
```

---

## Task 10: Functional RLS forge integration test

Per memory: the contract test (Task 6) does NOT prove a real cross-tenant insert fails — only a functional `breeze_app` test does. Also guards against the dual-axis blindspot.

**Files:**
- Create: `apps/api/src/__tests__/integration/quotes-rls.integration.test.ts`

- [ ] **Step 1: Write the test**

Model it on the existing billing RLS integration tests (e.g. a sibling `*-rls.integration.test.ts`). It seeds two partners/orgs fresh per `it` (TRUNCATE-per-test is on), opens a `breeze_app` connection scoped to org A, and asserts:

```ts
import { describe, it, expect } from 'vitest';
// import the integration harness used by sibling tests (withBreezeAppContext / seedOrg helpers)

describe('quotes RLS (breeze_app)', () => {
  it('blocks inserting a quote for an org the caller cannot access', async () => {
    // seed partner A + org A, partner B + org B
    // open breeze_app connection in org A context
    // attempt INSERT INTO quotes (partner_id=B, org_id=B) → expect RLS violation
  });

  it('allows inserting + selecting a quote within the caller org', async () => {
    // org A context: INSERT quotes(org A) succeeds; SELECT returns it
  });

  it('hides another org quote from SELECT', async () => {
    // seed a quote in org B via system context; org A SELECT returns 0 rows
  });
});
```

Fill in the bodies using the same seed/context helpers the neighboring billing integration tests import (do not memoize fixtures across tests — re-seed per `it`, per memory note on vacuous RLS tests).

- [ ] **Step 2: Run it**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts src/__tests__/integration/quotes-rls.integration.test.ts`
Expected: PASS — the cross-tenant insert raises `new row violates row-level security policy`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/quotes-rls.integration.test.ts
git commit -m "test(quotes): functional breeze_app cross-tenant RLS forge test"
```

---

## Task 11: PDF rendering (blocks in order)

**Files:**
- Create: `apps/api/src/services/quotePdf.ts`
- Modify: `apps/api/src/routes/quotes/quotes.ts` (add `GET /:id/pdf`)

- [ ] **Step 1: Write the renderer**

`apps/api/src/services/quotePdf.ts`. Reuse the pdfkit setup from `invoicePdf.ts` (same fonts/branding helpers). Export a pure `renderQuotePdf(quote, blocks, lines, branding): Promise<Buffer>` that walks blocks by `sortOrder`:
- `heading` → bold text at the block's level size.
- `rich_text` → paragraph text (strip HTML to text for v1; rich formatting later).
- `image` → fetch bytes from `quote_images` by `content.imageId`, embed via `doc.image(buffer, ...)`.
- `line_items` → a pricing table of the lines whose `blockId` matches, with a recurring-summary footer (one-time / monthly / annual totals from the quote header).
Lines with no `blockId` render in a default trailing table.

```ts
import PDFDocument from 'pdfkit';
// import the shared branding/format helpers used by invoicePdf.ts

export async function renderQuotePdf(
  quote: any, blocks: any[], lines: any[],
  loadImage: (imageId: string) => Promise<{ data: Buffer } | null>,
  branding: { logoUrl?: string | null; primaryColor?: string | null; footer?: string | null },
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // header (logo + quote number + bill-to) — copy invoicePdf header layout
  for (const b of [...blocks].sort((a, z) => a.sortOrder - z.sortOrder)) {
    if (b.blockType === 'heading') { doc.fontSize(b.content.level === 1 ? 20 : b.content.level === 2 ? 16 : 13).font('Helvetica-Bold').text(b.content.text).moveDown(0.5); }
    else if (b.blockType === 'rich_text') { doc.fontSize(11).font('Helvetica').text(stripHtml(b.content.html)).moveDown(0.5); }
    else if (b.blockType === 'image') { const img = await loadImage(b.content.imageId); if (img) { doc.image(img.data, { fit: [b.content.width ?? 400, 400] }); if (b.content.caption) doc.fontSize(9).fillColor('#666').text(b.content.caption); doc.fillColor('#000').moveDown(0.5); } }
    else if (b.blockType === 'line_items') { renderLineTable(doc, lines.filter((l) => l.blockId === b.id)); }
  }
  const orphanLines = lines.filter((l) => !l.blockId);
  if (orphanLines.length) renderLineTable(doc, orphanLines);
  renderRecurringSummary(doc, quote);
  if (branding.footer) doc.fontSize(8).fillColor('#888').text(branding.footer, 50, doc.page.height - 60);
  doc.end();
  return done;
}

function stripHtml(html: string): string { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function renderLineTable(doc: PDFKit.PDFDocument, lines: any[]): void { /* qty | desc | unit | total columns; copy invoicePdf table layout */ }
function renderRecurringSummary(doc: PDFKit.PDFDocument, quote: any): void { /* One-time: $X | Monthly: $Y/mo | Annual: $Z/yr | First invoice total: $total */ }
```

- [ ] **Step 2: Add the PDF route**

In `apps/api/src/routes/quotes/quotes.ts`, add (uses read permission):

```ts
quoteCrudRoutes.get('/:id/pdf', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    const { quote, blocks, lines } = await getQuote(c.req.valid('param').id, quoteActorFrom(c));
    const { renderQuotePdf } = await import('../../services/quotePdf');
    // loadImage + branding: resolve via the same helpers invoicePdf uses
    const pdf = await renderQuotePdf(quote, blocks, lines, async () => null, {});
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `inline; filename="quote-${quote.quoteNumber ?? quote.id}.pdf"`);
    return c.body(pdf);
  } catch (e) { return handle(c, e); }
});
```

- [ ] **Step 3: Smoke-test the renderer**

Add a quick unit test `apps/api/src/services/quotePdf.test.ts` that renders a quote with one heading + one line_items block and asserts the returned Buffer starts with `%PDF`:

```ts
import { describe, it, expect } from 'vitest';
import { renderQuotePdf } from './quotePdf';
it('produces a PDF buffer', async () => {
  const buf = await renderQuotePdf(
    { id: 'q1', quoteNumber: 'Q-1', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
    [{ id: 'b1', blockType: 'heading', sortOrder: 0, content: { text: 'Proposal', level: 1 } }, { id: 'b2', blockType: 'line_items', sortOrder: 1, content: {} }],
    [{ id: 'l1', blockId: 'b2', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
    async () => null, {},
  );
  expect(buf.subarray(0, 4).toString()).toBe('%PDF');
});
```

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/quotePdf.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/quotePdf.ts apps/api/src/services/quotePdf.test.ts apps/api/src/routes/quotes/quotes.ts
git commit -m "feat(quotes): pdfkit renderer for block-based proposal + GET /:id/pdf"
```

---

## Task 12: Web — API client + types

**Files:**
- Create: `apps/web/src/lib/api/quotes.ts`
- Create: `apps/web/src/components/billing/quotes/quoteTypes.ts`

- [ ] **Step 1: Write the API client**

`apps/web/src/lib/api/quotes.ts` — mirror `apps/web/src/lib/api/invoices.ts`. Wrap mutations in `runAction` (per CLAUDE.md). Functions: `listQuotes(params)`, `getQuote(id)`, `createQuote(body)`, `updateQuote(id, body)`, `deleteQuote(id)`, `addBlock(id, body)`, `addManualLine(id, body)`, `addCatalogLine(id, body)`, `updateLine(id, lineId, body)`, `removeLine(id, lineId)`, `quotePdfUrl(id)`.

```ts
import { runAction } from '../runAction';
import { apiFetch } from './client'; // use whatever the invoices client imports

export interface QuoteSummary { id: string; quoteNumber: string | null; status: string; total: string; orgId: string; createdAt: string; }

export async function listQuotes(params: { orgId?: string; status?: string; limit?: number } = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
  const res = await apiFetch(`/api/v1/quotes?${qs}`);
  return (await res.json()).data as QuoteSummary[];
}
export async function getQuote(id: string) {
  const res = await apiFetch(`/api/v1/quotes/${id}`);
  return (await res.json()).data;
}
export function createQuote(body: { orgId: string; [k: string]: unknown }) {
  return runAction(() => apiFetch('/api/v1/quotes', { method: 'POST', body: JSON.stringify(body) }));
}
// ...updateQuote, deleteQuote, addBlock, addManualLine, addCatalogLine, updateLine, removeLine all via runAction
export function quotePdfUrl(id: string) { return `/api/v1/quotes/${id}/pdf`; }
```

- [ ] **Step 2: Write the types/format helpers**

`apps/web/src/components/billing/quotes/quoteTypes.ts` — copy `invoiceTypes.ts` (formatMoney, formatDate, status→color map) and adapt the status set to the quote statuses; add a `formatRecurrence` helper (`one_time`→"one-time", `monthly`→"/mo", `annual`→"/yr").

- [ ] **Step 3: Type-check the web app**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no new errors (per memory, `astro check` — not plain tsc — catches `.astro` issues).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api/quotes.ts apps/web/src/components/billing/quotes/quoteTypes.ts
git commit -m "feat(web): quotes API client + types"
```

---

## Task 13: Web — list page + workspace shell

**Files:**
- Create: `apps/web/src/components/billing/quotes/QuotesPage.tsx`
- Create: `apps/web/src/components/billing/quotes/QuoteWorkspace.tsx`
- Create: `apps/web/src/pages/billing/quotes.astro`
- Create: `apps/web/src/pages/billing/quotes/[id].astro`
- Modify: billing/operations sidebar nav

- [ ] **Step 1: QuotesPage**

Copy `InvoicesPage.tsx` structure: search box, status filter, table of quote number / org / status chip / total / created date, "New quote" button (calls `createQuote` then navigates to `/billing/quotes/<id>`). Use `quoteTypes.ts` helpers. UI state (status filter) via `window.location.hash` per CLAUDE.md.

- [ ] **Step 2: QuoteWorkspace**

Copy `InvoiceWorkspace.tsx` tab shell with three tabs (Editor / Preview / Detail). Editor + Detail load `QuoteEditor` / `QuoteDetail` (Task 14). Preview tab embeds the PDF via `<iframe src={quotePdfUrl(id)} />`. Active tab tracked in `window.location.hash`.

- [ ] **Step 3: Astro pages**

`apps/web/src/pages/billing/quotes.astro` renders `<QuotesPage client:load />` inside the app layout (copy `billing/invoices.astro`).
`apps/web/src/pages/billing/quotes/[id].astro` reads the `[id]` param and renders `<QuoteWorkspace id={id} client:load />` (copy `billing/invoices/[id].astro`).

- [ ] **Step 4: Sidebar nav**

Add a "Quotes" item next to "Invoices" in the billing/operations sidebar (the same nav file edited by commit #1435/#1440). Link to `/billing/quotes`. Gate visibility on the `quotes:read` permission using the same permission-check helper the Invoices item uses.

- [ ] **Step 5: Verify it renders**

Run the web app and load `/billing/quotes`:
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no errors. Then manually load the page in dev (`pnpm dev`) and confirm the list renders + "New quote" creates and navigates.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuotesPage.tsx apps/web/src/components/billing/quotes/QuoteWorkspace.tsx apps/web/src/pages/billing/quotes.astro apps/web/src/pages/billing/quotes/ apps/web/src/components/layout/
git commit -m "feat(web): quotes list page, workspace shell, sidebar nav"
```

---

## Task 14: Web — block + line editor and detail view

**Files:**
- Create: `apps/web/src/components/billing/quotes/QuoteEditor.tsx`
- Create: `apps/web/src/components/billing/quotes/QuoteDetail.tsx`

- [ ] **Step 1: QuoteEditor**

The novel component. Renders the ordered block list with add/reorder controls and, inside `line_items` blocks, the shared catalog picker. Layout: main column (blocks) + right rail (live totals). Behaviors:
- "Add block" menu → heading / rich text / image / pricing table → POST `/quotes/:id/blocks`, refetch.
- Heading/rich_text blocks edit inline (PATCH not required for v1 — re-create or add an `updateBlock` endpoint in a follow-up; for v1, blocks are add/remove only, edited via local state then saved on add). Keep v1 scope: add + remove blocks; reorder via the reorder endpoint is a follow-up.
- Inside a pricing-table block: render its lines (qty / desc / unit / recurrence chip / total), an inline manual-line row, and the shared picker:

```tsx
import { CatalogItemPicker } from '../../catalog/CatalogItemPicker';
// onPick → addCatalogLine(quoteId, { catalogItemId, quantity: 1, blockId: block.id }) → refetch
```
- "Save manual line to catalog" checkbox on a manual line → after adding the line, also POST to `/api/v1/catalog` with the line's fields (reuse `apps/web/src/lib/api/catalog.ts`).
- Right rail "Live totals": read `oneTimeTotal`, `monthlyRecurringTotal`, `annualRecurringTotal`, `total` from the quote (refetched after each line mutation) and render with `formatMoney` + the recurring labels. This mirrors the ContractEditor estimate panel.
- All mutations through the `quotes.ts` client (so `runAction` surfaces failures).

- [ ] **Step 2: QuoteDetail**

Read-only view of a non-draft quote: header (number, status chip, org, dates), the rendered blocks, the line tables grouped by block, and the recurring summary. "Download PDF" links to `quotePdfUrl(id)`. (Send / accept actions are Phase 2 — leave a disabled "Send" affordance or omit.)

- [ ] **Step 3: Verify in browser**

`pnpm dev`, create a quote, add a heading block, add a pricing-table block, add a catalog item (pick a recurring M365-style item) and a manual line, confirm the right-rail totals update with separate one-time vs monthly buckets, open the Preview tab and confirm the PDF renders the blocks.

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteDetail.tsx
git commit -m "feat(web): quote block+line editor with live recurring totals and detail view"
```

---

## Final verification

- [ ] **API unit suite (affected files, single fork — per memory on parallel flakiness):**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --pool=forks --poolOptions.forks.singleFork=true src/services/quoteMath.test.ts src/services/quotePdf.test.ts src/routes/quotes/quotes.test.ts`
Expected: all PASS.

- [ ] **Shared suite:**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/quotes.test.ts src/validators/catalog.test.ts`
Expected: all PASS.

- [ ] **Integration (real DB) — RLS + cascade + coverage:**

Run the three integration tests from Tasks 6 and 10. Expected: all PASS.

- [ ] **Drift + type-check:**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL=... pnpm db:check-drift` and `pnpm --filter @breeze/api exec tsc --noEmit` and `pnpm --filter @breeze/web exec astro check`. Expected: clean (modulo known pre-existing errors).

- [ ] **Open the PR** on branch `feat/quotes-proposals` once green.

---

## Deferred to later plans (NOT in this plan)

- **Phase 2:** `sent`/`viewed` transitions, send-email, customer-portal view (`apps/portal/` + `portal/quotes.ts`), public tokenized acceptance page, built-in e-sign accept (`quote_acceptances` write + content hash), `quote_images` upload endpoint + serve.
- **Phase 3:** accept → convert-to-invoice, portal pay + public pay-link, expiry sweep.
- **Phase 4 (optional):** recurring lines → auto-create Contract.
- **Bundle lines** (`addBundleLine`) if not ported in Task 8.
