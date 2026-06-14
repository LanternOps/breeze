# Product Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a partner-owned product catalog (hardware/software/service items) with per-org price overrides, cost+markup pricing, and bundles that carry per-component customer visibility plus internal revenue allocation — the pricing foundation for the invoice engine, recurring contracts, and Stripe payments.

**Architecture:** Three new tenant-scoped tables (`catalog_items` partner-axis, `catalog_item_org_pricing` org-axis, `catalog_bundle_components` partner-axis with denormalized `partner_id`). All logic lives in `catalogService.ts`; Hono routes / AI tools / MCP are thin consumers. Pricing math is extracted into pure functions for direct unit testing; DB-touching paths are covered by route tests (Drizzle-mocked) and a real-DB RLS forge test. `ticket_parts` gains a nullable `catalog_item_id`.

**Tech Stack:** Hono (TypeScript) + Drizzle ORM + PostgreSQL (RLS) + Zod (`@breeze/shared`) + Vitest + React islands (apps/web). Hand-written idempotent SQL migration.

**Spec:** `docs/superpowers/specs/2026-06-14-product-catalog-design.md`
**Architecture frame:** `docs/superpowers/specs/2026-06-14-billing-architecture-overview.md`

**Conventions reminder (from CLAUDE.md):**
- Node: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- API unit/route tests: `pnpm --filter @breeze/api test -- <file>` (single file, single fork — see memory on suite flakiness).
- Never edit a shipped migration; idempotent SQL only.
- New tenant table → RLS in the creating migration + allowlist + forge test in the same PR.

---

## File Structure

**Create:**
- `packages/shared/src/validators/catalog.ts` — Zod schemas + inferred types
- `apps/api/src/db/schema/catalog.ts` — Drizzle tables + enums
- `apps/api/src/services/catalogPricing.ts` — pure pricing/validation helpers (no DB)
- `apps/api/src/services/catalogPricing.test.ts`
- `apps/api/src/services/catalogService.ts` — service layer (DB + events)
- `apps/api/src/services/aiToolsCatalog.ts` — AI read tools
- `apps/api/src/routes/catalog/catalog.ts` — item CRUD + list routes
- `apps/api/src/routes/catalog/pricing.ts` — org override routes
- `apps/api/src/routes/catalog/bundles.ts` — bundle component + economics routes
- `apps/api/src/routes/catalog/index.ts` — sub-router mount
- `apps/api/src/routes/catalog/catalog.test.ts` — route tests
- `apps/api/migrations/2026-06-14-product-catalog.sql` — schema + RLS + ticket_parts + permissions
- `apps/web/src/components/settings/CatalogSettingsPage.tsx` — settings tab shell
- `apps/web/src/components/settings/CatalogItemsTab.tsx` — item list + editor
- `packages/shared/src/validators/catalog.test.ts`

**Modify:**
- `packages/shared/src/validators/index.ts` — re-export catalog validators
- `apps/api/src/db/schema/index.ts` — re-export `./catalog`
- `apps/api/src/services/permissions.ts` — add `CATALOG_READ/WRITE/DELETE`
- `apps/api/src/db/seed.ts` — DEFAULT_PERMISSIONS + role grants
- `apps/api/src/routes/index.ts` (or wherever route hubs mount) — mount catalog routes
- `apps/api/src/services/aiTools.ts` — register catalog tools
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist
- `apps/api/src/db/schema/timeTracking.ts` — add `catalogItemId` to `ticketParts`

---

## Task 1: Shared validators (Zod schemas + types)

**Files:**
- Create: `packages/shared/src/validators/catalog.ts`
- Create: `packages/shared/src/validators/catalog.test.ts`
- Modify: `packages/shared/src/validators/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/validators/catalog.test.ts
import { describe, it, expect } from 'vitest';
import {
  createCatalogItemSchema,
  updateCatalogItemSchema,
  orgPriceOverrideSchema,
  setBundleComponentsSchema
} from './catalog';

describe('createCatalogItemSchema', () => {
  it('accepts a minimal valid hardware item', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware',
      name: 'Dell Latitude 5440',
      unitPrice: 1299.0
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const r = createCatalogItemSchema.safeParse({ itemType: 'service', name: '', unitPrice: 10 });
    expect(r.success).toBe(false);
  });

  it('rejects a negative price', () => {
    const r = createCatalogItemSchema.safeParse({ itemType: 'service', name: 'X', unitPrice: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown item type', () => {
    const r = createCatalogItemSchema.safeParse({ itemType: 'widget', name: 'X', unitPrice: 1 });
    expect(r.success).toBe(false);
  });

  it('defaults billingType to one_time and taxable to true', () => {
    const r = createCatalogItemSchema.parse({ itemType: 'service', name: 'Onsite hour', unitPrice: 150 });
    expect(r.billingType).toBe('one_time');
    expect(r.taxable).toBe(true);
  });
});

describe('updateCatalogItemSchema', () => {
  it('requires at least one field', () => {
    expect(updateCatalogItemSchema.safeParse({}).success).toBe(false);
  });
});

describe('orgPriceOverrideSchema', () => {
  it('accepts a valid override', () => {
    expect(orgPriceOverrideSchema.safeParse({ unitPrice: 99.5 }).success).toBe(true);
  });
  it('rejects negative price', () => {
    expect(orgPriceOverrideSchema.safeParse({ unitPrice: -5 }).success).toBe(false);
  });
});

describe('setBundleComponentsSchema', () => {
  it('accepts a list of components', () => {
    const r = setBundleComponentsSchema.safeParse({
      components: [
        { componentItemId: '11111111-1111-1111-1111-111111111111', quantity: 2, showOnInvoice: true, revenueAllocation: 10 }
      ]
    });
    expect(r.success).toBe(true);
  });
  it('rejects zero/negative quantity', () => {
    const r = setBundleComponentsSchema.safeParse({
      components: [{ componentItemId: '11111111-1111-1111-1111-111111111111', quantity: 0 }]
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared test -- catalog.test.ts`
Expected: FAIL — cannot find module `./catalog`.

- [ ] **Step 3: Write the validators**

```typescript
// packages/shared/src/validators/catalog.ts
import { z } from 'zod';

export const catalogItemTypeSchema = z.enum(['hardware', 'software', 'service']);
export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

export const catalogBillingTypeSchema = z.enum(['one_time', 'recurring']);
export type CatalogBillingType = z.infer<typeof catalogBillingTypeSchema>;

const money = z.number().nonnegative().multipleOf(0.01);

export const createCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema,
  name: z.string().min(1).max(255),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.default('one_time'),
  unitPrice: money,
  costBasis: money.nullable().optional(),
  markupPercent: z.number().min(0).max(100_000).multipleOf(0.01).nullable().optional(),
  unitOfMeasure: z.string().max(50).default('each'),
  taxable: z.boolean().default(true),
  taxCategory: z.string().max(100).nullable().optional(),
  isBundle: z.boolean().default(false),
  attributes: z.record(z.string(), z.unknown()).default({})
});
export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

export const updateCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema.optional(),
  name: z.string().min(1).max(255).optional(),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.optional(),
  unitPrice: money.optional(),
  costBasis: money.nullable().optional(),
  markupPercent: z.number().min(0).max(100_000).multipleOf(0.01).nullable().optional(),
  unitOfMeasure: z.string().max(50).optional(),
  taxable: z.boolean().optional(),
  taxCategory: z.string().max(100).nullable().optional(),
  isBundle: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export type UpdateCatalogItemInput = z.infer<typeof updateCatalogItemSchema>;

export const orgPriceOverrideSchema = z.object({ unitPrice: money });
export type OrgPriceOverrideInput = z.infer<typeof orgPriceOverrideSchema>;

export const bundleComponentSchema = z.object({
  componentItemId: z.string().uuid(),
  quantity: z.number().positive().multipleOf(0.01),
  showOnInvoice: z.boolean().default(false),
  revenueAllocation: money.nullable().optional()
});
export type BundleComponentInput = z.infer<typeof bundleComponentSchema>;

export const setBundleComponentsSchema = z.object({
  components: z.array(bundleComponentSchema).max(200)
});
export type SetBundleComponentsInput = z.infer<typeof setBundleComponentsSchema>;

export const listCatalogQuerySchema = z.object({
  itemType: catalogItemTypeSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  isBundle: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional()
});
export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;
```

- [ ] **Step 4: Re-export from the validators index**

Add to `packages/shared/src/validators/index.ts` (follow the existing `export * from './<name>'` style):

```typescript
export * from './catalog';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared test -- catalog.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Build shared package so `@breeze/shared` exports resolve for the API**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/validators/catalog.ts packages/shared/src/validators/catalog.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(catalog): zod validators for catalog items, overrides, bundles"
```

---

## Task 2: Drizzle schema (catalog tables + enums) and ticket_parts column

**Files:**
- Create: `apps/api/src/db/schema/catalog.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/db/schema/timeTracking.ts`

> No standalone unit test here — the schema is exercised by the migration drift check (Task 3) and downstream tests. This task is a self-contained, compilable change.

- [ ] **Step 1: Write the schema file**

```typescript
// apps/api/src/db/schema/catalog.ts
import {
  pgTable, uuid, text, varchar, boolean, numeric, jsonb, timestamp, pgEnum,
  index, uniqueIndex
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const catalogItemTypeEnum = pgEnum('catalog_item_type', ['hardware', 'software', 'service']);
export const catalogBillingTypeEnum = pgEnum('catalog_billing_type', ['one_time', 'recurring']);

// Partner-axis (RLS shape 3). partner_id is the isolation axis.
export const catalogItems = pgTable('catalog_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  itemType: catalogItemTypeEnum('item_type').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  sku: varchar('sku', { length: 100 }),
  description: text('description'),
  billingType: catalogBillingTypeEnum('billing_type').notNull().default('one_time'),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 12, scale: 2 }),
  markupPercent: numeric('markup_percent', { precision: 6, scale: 2 }),
  unitOfMeasure: varchar('unit_of_measure', { length: 50 }).notNull().default('each'),
  taxable: boolean('taxable').notNull().default(true),
  taxCategory: varchar('tax_category', { length: 100 }),
  isBundle: boolean('is_bundle').notNull().default(false),
  attributes: jsonb('attributes').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('catalog_items_partner_type_idx').on(t.partnerId, t.itemType),
  index('catalog_items_partner_active_idx').on(t.partnerId, t.isActive),
  uniqueIndex('catalog_items_partner_sku_uq').on(t.partnerId, t.sku).where(
    // partial: only enforce uniqueness when sku is present
    // (drizzle .where on uniqueIndex emits a partial unique index)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t.sku as any).isNotNull?.() ?? undefined
  )
]);

// Org-axis (RLS shape 1, direct org_id). Per-customer sell-price override.
export const catalogItemOrgPricing = pgTable('catalog_item_org_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogItemId: uuid('catalog_item_id').notNull().references(() => catalogItems.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('catalog_item_org_pricing_item_org_uq').on(t.catalogItemId, t.orgId),
  index('catalog_item_org_pricing_org_idx').on(t.orgId)
]);

// Partner-axis via denormalized partner_id (RLS shape 3, flat policy — avoids the
// nested-EXISTS bound-param bug; also enforces components share the bundle's partner).
export const catalogBundleComponents = pgTable('catalog_bundle_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  bundleItemId: uuid('bundle_item_id').notNull().references(() => catalogItems.id, { onDelete: 'cascade' }),
  componentItemId: uuid('component_item_id').notNull().references(() => catalogItems.id, { onDelete: 'restrict' }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull().default('1'),
  showOnInvoice: boolean('show_on_invoice').notNull().default(false),
  revenueAllocation: numeric('revenue_allocation', { precision: 12, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('catalog_bundle_components_bundle_comp_uq').on(t.bundleItemId, t.componentItemId),
  index('catalog_bundle_components_partner_idx').on(t.partnerId)
]);
```

> If the partial-unique `.where(...)` expression above does not type-check against the installed drizzle version, replace it with a plain `uniqueIndex('catalog_items_partner_sku_uq').on(t.partnerId, t.sku)` here and rely on the migration's partial unique index (Task 3) as the source of truth. The Drizzle schema is only used for drift detection and typed queries; the migration is authoritative for the partial predicate.

- [ ] **Step 2: Re-export from the schema index**

Add to the end of `apps/api/src/db/schema/index.ts` (matching the existing `export * from './<name>';` list):

```typescript
export * from './catalog';
```

- [ ] **Step 3: Add `catalogItemId` to `ticketParts`**

In `apps/api/src/db/schema/timeTracking.ts`, import `catalogItems` and add the column to the `ticketParts` table definition. Add to the imports near the top:

```typescript
import { catalogItems } from './catalog';
```

Add this column inside the `ticketParts` `pgTable('ticket_parts', { ... })` column object (place it after `addedBy`):

```typescript
  catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id, { onDelete: 'set null' }),
```

- [ ] **Step 4: Type-check the API package**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors in `db/schema/catalog.ts` or `timeTracking.ts`. (Pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` per CLAUDE.md are acceptable.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/catalog.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/timeTracking.ts
git commit -m "feat(catalog): drizzle schema for catalog tables + ticket_parts.catalog_item_id"
```

---

## Task 3: Migration (enums, tables, RLS, ticket_parts column, permissions)

**Files:**
- Create: `apps/api/migrations/2026-06-14-product-catalog.sql`

> Re-date the filename to the actual execution date if later. If another migration must run between table creation and policies, split with `-a-`/`-b-` infixes; everything here is ordered correctly within one idempotent file, so one file is fine.

- [ ] **Step 1: Write the migration**

```sql
-- Product Catalog: items, per-org pricing, bundles. Plus ticket_parts.catalog_item_id
-- and catalog permissions. Idempotent; partner-axis (shape 3) + org-axis (shape 1).

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE catalog_item_type AS ENUM ('hardware','software','service');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE catalog_billing_type AS ENUM ('one_time','recurring');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. catalog_items (partner-axis)
CREATE TABLE IF NOT EXISTS catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  item_type catalog_item_type NOT NULL,
  name VARCHAR(255) NOT NULL,
  sku VARCHAR(100),
  description TEXT,
  billing_type catalog_billing_type NOT NULL DEFAULT 'one_time',
  unit_price NUMERIC(12,2) NOT NULL,
  cost_basis NUMERIC(12,2),
  markup_percent NUMERIC(6,2),
  unit_of_measure VARCHAR(50) NOT NULL DEFAULT 'each',
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  tax_category VARCHAR(100),
  is_bundle BOOLEAN NOT NULL DEFAULT FALSE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS catalog_items_partner_type_idx ON catalog_items (partner_id, item_type);
CREATE INDEX IF NOT EXISTS catalog_items_partner_active_idx ON catalog_items (partner_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_partner_sku_uq ON catalog_items (partner_id, sku) WHERE sku IS NOT NULL;

-- 3. catalog_item_org_pricing (org-axis, direct org_id)
CREATE TABLE IF NOT EXISTS catalog_item_org_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  unit_price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_item_org_pricing_item_org_uq ON catalog_item_org_pricing (catalog_item_id, org_id);
CREATE INDEX IF NOT EXISTS catalog_item_org_pricing_org_idx ON catalog_item_org_pricing (org_id);

-- 4. catalog_bundle_components (partner-axis via denormalized partner_id)
CREATE TABLE IF NOT EXISTS catalog_bundle_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  bundle_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  component_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  show_on_invoice BOOLEAN NOT NULL DEFAULT FALSE,
  revenue_allocation NUMERIC(12,2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_bundle_components_bundle_comp_uq ON catalog_bundle_components (bundle_item_id, component_item_id);
CREATE INDEX IF NOT EXISTS catalog_bundle_components_partner_idx ON catalog_bundle_components (partner_id);

-- 5. RLS: catalog_items (partner-axis + system bypass)
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY catalog_items_partner_access ON catalog_items
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. RLS: catalog_bundle_components (partner-axis via denormalized partner_id + system bypass)
ALTER TABLE catalog_bundle_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_bundle_components FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY catalog_bundle_components_partner_access ON catalog_bundle_components
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7. RLS: catalog_item_org_pricing (org-axis)
ALTER TABLE catalog_item_org_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_org_pricing FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON catalog_item_org_pricing;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON catalog_item_org_pricing;
DROP POLICY IF EXISTS breeze_org_isolation_update ON catalog_item_org_pricing;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON catalog_item_org_pricing;
CREATE POLICY breeze_org_isolation_select ON catalog_item_org_pricing
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON catalog_item_org_pricing
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON catalog_item_org_pricing
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON catalog_item_org_pricing
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 8. ticket_parts.catalog_item_id
ALTER TABLE ticket_parts ADD COLUMN IF NOT EXISTS catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL;

-- 9. catalog permissions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'catalog' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('catalog', 'read', 'View product catalog items and pricing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'catalog' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('catalog', 'write', 'Create and update catalog items, pricing, and bundles');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'catalog' AND action = 'delete') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('catalog', 'delete', 'Archive/delete catalog items');
  END IF;
END $$;

-- 10. Grant catalog perms to roles already holding the matching tickets perm,
--     restricted to partner-scope system roles (catalog is partner-internal).
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'read'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'catalog' AND p2.action = 'read'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'catalog' AND p2.action = 'write'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'catalog' AND p2.action = 'delete'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
```

- [ ] **Step 2: Apply migrations against the local DB**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api db:migrate
```
Expected: the new migration applies without error; re-running is a no-op.

- [ ] **Step 3: Verify no schema drift**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift between `db/schema/catalog.ts` + `timeTracking.ts` and the migration.

- [ ] **Step 4: Run the migration ordering regression test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- autoMigrate.test.ts`
Expected: PASS (filename sorts correctly).

- [ ] **Step 5: Verify isolation as `breeze_app` (manual forge)**

Run (managed-PG note: locally a postgres container exists; this is the local check):
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
"INSERT INTO catalog_items (partner_id, item_type, name, unit_price) VALUES ('00000000-0000-0000-0000-000000000000','service','forged',1);"
```
Expected: `ERROR: new row violates row-level security policy for table "catalog_items"` (no tenant context set).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-14-product-catalog.sql
git commit -m "feat(catalog): migration — catalog tables, RLS, ticket_parts col, permissions"
```

---

## Task 4: Pure pricing & validation helpers (unit-tested, no DB)

**Files:**
- Create: `apps/api/src/services/catalogPricing.ts`
- Create: `apps/api/src/services/catalogPricing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/catalogPricing.test.ts
import { describe, it, expect } from 'vitest';
import {
  deriveUnitPrice,
  resolvePriceFrom,
  detectBundleProblems,
  computeBundleEconomicsFrom
} from './catalogPricing';

describe('deriveUnitPrice', () => {
  it('derives from cost + markup when no explicit price given', () => {
    expect(deriveUnitPrice({ explicitPrice: undefined, costBasis: '100.00', markupPercent: '25.00' })).toBe('125.00');
  });
  it('prefers explicit price over markup derivation', () => {
    expect(deriveUnitPrice({ explicitPrice: 199, costBasis: '100.00', markupPercent: '25.00' })).toBe('199.00');
  });
  it('returns explicit price when no markup/cost', () => {
    expect(deriveUnitPrice({ explicitPrice: 50, costBasis: null, markupPercent: null })).toBe('50.00');
  });
});

describe('resolvePriceFrom', () => {
  const item = { unitPrice: '100.00', costBasis: '60.00', taxable: true, taxCategory: 'GST' };
  it('uses the org override when present', () => {
    const r = resolvePriceFrom(item, { unitPrice: '80.00' });
    expect(r).toEqual({ unitPrice: '80.00', costBasis: '60.00', taxable: true, taxCategory: 'GST', source: 'org_override' });
  });
  it('falls back to the item price when no override', () => {
    const r = resolvePriceFrom(item, null);
    expect(r.unitPrice).toBe('100.00');
    expect(r.source).toBe('item');
  });
});

describe('detectBundleProblems', () => {
  const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  it('rejects a bundle containing itself', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: A, quantity: 1 }],
      componentMeta: new Map([[A, { isBundle: false, partnerId: 'p1' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('SELF_REFERENCE');
  });
  it('rejects a component that is itself a bundle', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 1 }],
      componentMeta: new Map([[B, { isBundle: true, partnerId: 'p1' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('NESTED_BUNDLE');
  });
  it('rejects a component from a different partner', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 1 }],
      componentMeta: new Map([[B, { isBundle: false, partnerId: 'p2' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('CROSS_PARTNER');
  });
  it('rejects a missing component', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 1 }],
      componentMeta: new Map(),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('COMPONENT_NOT_FOUND');
  });
  it('returns no problems for a valid set', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 2 }],
      componentMeta: new Map([[B, { isBundle: false, partnerId: 'p1' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toEqual([]);
  });
});

describe('computeBundleEconomicsFrom', () => {
  it('sums component costs and computes margin against the headline price', () => {
    const r = computeBundleEconomicsFrom({
      headlinePrice: '100.00',
      components: [
        { quantity: '2', costBasis: '10.00', revenueAllocation: '40.00' },
        { quantity: '1', costBasis: '30.00', revenueAllocation: '60.00' }
      ]
    });
    expect(r.totalCost).toBe('50.00');     // 2*10 + 1*30
    expect(r.margin).toBe('50.00');        // 100 - 50
    expect(r.allocationTotal).toBe('100.00');
    expect(r.allocationMatchesHeadline).toBe(true);
  });
  it('flags allocation mismatch', () => {
    const r = computeBundleEconomicsFrom({
      headlinePrice: '100.00',
      components: [{ quantity: '1', costBasis: '10.00', revenueAllocation: '40.00' }]
    });
    expect(r.allocationMatchesHeadline).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- catalogPricing.test.ts`
Expected: FAIL — cannot find module `./catalogPricing`.

- [ ] **Step 3: Write the helpers**

```typescript
// apps/api/src/services/catalogPricing.ts
// Pure money/bundle helpers. Money is carried as fixed-2-decimal strings to match
// numeric(12,2) columns. No DB, no I/O — fully unit-testable.

function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return Math.round(Number(v) * 100);
}
function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function deriveUnitPrice(input: {
  explicitPrice: number | undefined;
  costBasis: string | null;
  markupPercent: string | null;
}): string {
  if (input.explicitPrice !== undefined) return Number(input.explicitPrice).toFixed(2);
  if (input.costBasis !== null && input.markupPercent !== null) {
    const cost = toCents(input.costBasis);
    const marked = Math.round(cost * (1 + Number(input.markupPercent) / 100));
    return fromCents(marked);
  }
  return '0.00';
}

export interface ResolvedPrice {
  unitPrice: string;
  costBasis: string | null;
  taxable: boolean;
  taxCategory: string | null;
  source: 'org_override' | 'item';
}

export function resolvePriceFrom(
  item: { unitPrice: string; costBasis: string | null; taxable: boolean; taxCategory: string | null },
  override: { unitPrice: string } | null
): ResolvedPrice {
  return {
    unitPrice: override ? override.unitPrice : item.unitPrice,
    costBasis: item.costBasis,
    taxable: item.taxable,
    taxCategory: item.taxCategory,
    source: override ? 'org_override' : 'item'
  };
}

export type BundleProblem =
  | 'SELF_REFERENCE'
  | 'NESTED_BUNDLE'
  | 'CROSS_PARTNER'
  | 'COMPONENT_NOT_FOUND'
  | 'DUPLICATE_COMPONENT';

export function detectBundleProblems(args: {
  bundleId: string;
  bundlePartnerId: string;
  components: Array<{ componentItemId: string; quantity: number }>;
  componentMeta: Map<string, { isBundle: boolean; partnerId: string }>;
}): BundleProblem[] {
  const problems = new Set<BundleProblem>();
  const seen = new Set<string>();
  for (const c of args.components) {
    if (seen.has(c.componentItemId)) problems.add('DUPLICATE_COMPONENT');
    seen.add(c.componentItemId);
    if (c.componentItemId === args.bundleId) problems.add('SELF_REFERENCE');
    const meta = args.componentMeta.get(c.componentItemId);
    if (!meta) { problems.add('COMPONENT_NOT_FOUND'); continue; }
    if (meta.isBundle) problems.add('NESTED_BUNDLE');
    if (meta.partnerId !== args.bundlePartnerId) problems.add('CROSS_PARTNER');
  }
  return [...problems];
}

export function computeBundleEconomicsFrom(args: {
  headlinePrice: string;
  components: Array<{ quantity: string; costBasis: string | null; revenueAllocation: string | null }>;
}): {
  headlinePrice: string;
  totalCost: string;
  margin: string;
  marginPct: number;
  allocationTotal: string;
  allocationMatchesHeadline: boolean;
} {
  let costCents = 0;
  let allocCents = 0;
  let anyAllocation = false;
  for (const c of args.components) {
    costCents += Math.round((toCents(c.costBasis) * Number(c.quantity || '0')));
    if (c.revenueAllocation !== null && c.revenueAllocation !== undefined) {
      anyAllocation = true;
      allocCents += toCents(c.revenueAllocation);
    }
  }
  const headlineCents = toCents(args.headlinePrice);
  const marginCents = headlineCents - costCents;
  return {
    headlinePrice: fromCents(headlineCents),
    totalCost: fromCents(costCents),
    margin: fromCents(marginCents),
    marginPct: headlineCents === 0 ? 0 : Math.round((marginCents / headlineCents) * 10000) / 100,
    allocationTotal: fromCents(allocCents),
    allocationMatchesHeadline: anyAllocation ? allocCents === headlineCents : true
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- catalogPricing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/catalogPricing.ts apps/api/src/services/catalogPricing.test.ts
git commit -m "feat(catalog): pure pricing/bundle helpers with unit tests"
```

---

## Task 5: catalogService — items, overrides, bundles, resolvers

**Files:**
- Create: `apps/api/src/services/catalogService.ts`

> DB-touching service. Coverage comes via the route tests (Task 7, Drizzle-mocked) and the RLS forge test (Task 8). This task wires the pure helpers (Task 4) into DB operations and lifecycle events. No new standalone test file — the build/type-check is the gate here, behavior is asserted in Tasks 7-8.

- [ ] **Step 1: Write the service**

```typescript
// apps/api/src/services/catalogService.ts
import { and, asc, eq, gt, ilike, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { catalogItems, catalogItemOrgPricing, catalogBundleComponents } from '../db/schema';
import { emitCatalogEvent } from './catalogEvents';
import { isPgUniqueViolation } from '../utils/pgErrors';
import {
  deriveUnitPrice, resolvePriceFrom, detectBundleProblems, computeBundleEconomicsFrom,
  type ResolvedPrice
} from './catalogPricing';
import type {
  CreateCatalogItemInput, UpdateCatalogItemInput, OrgPriceOverrideInput,
  BundleComponentInput, ListCatalogQuery
} from '@breeze/shared';

export type CatalogServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ITEM_NOT_FOUND'
  | 'NOT_A_BUNDLE'
  | 'DUPLICATE_SKU'
  | 'BUNDLE_SELF_REFERENCE'
  | 'BUNDLE_NESTED'
  | 'BUNDLE_CROSS_PARTNER'
  | 'BUNDLE_COMPONENT_NOT_FOUND'
  | 'BUNDLE_DUPLICATE_COMPONENT';

export class CatalogServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
    public code?: CatalogServiceErrorCode
  ) {
    super(message);
    this.name = 'CatalogServiceError';
  }
}

export interface CatalogActor {
  userId: string;
  partnerId: string | null;
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new CatalogServiceError('Catalog is partner-scoped; no partner in context', 400, 'PARTNER_UNRESOLVABLE');
  }
  return actor.partnerId;
}

export async function createCatalogItem(input: CreateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const unitPrice = deriveUnitPrice({
    explicitPrice: input.unitPrice,
    costBasis: input.costBasis ?? null,
    markupPercent: input.markupPercent ?? null
  });
  try {
    const rows = await db.insert(catalogItems).values({
      partnerId,
      itemType: input.itemType,
      name: input.name,
      sku: input.sku ?? null,
      description: input.description ?? null,
      billingType: input.billingType,
      unitPrice,
      costBasis: input.costBasis != null ? input.costBasis.toFixed(2) : null,
      markupPercent: input.markupPercent != null ? input.markupPercent.toFixed(2) : null,
      unitOfMeasure: input.unitOfMeasure,
      taxable: input.taxable,
      taxCategory: input.taxCategory ?? null,
      isBundle: input.isBundle,
      attributes: input.attributes,
      createdBy: actor.userId
    }).returning();
    const item = rows[0]!;
    await emitCatalogEvent({ type: 'catalog.item.created', catalogItemId: item.id, partnerId, actorUserId: actor.userId });
    return item;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
    }
    throw err;
  }
}

async function getOwnedItemOr404(id: string, partnerId: string) {
  const rows = await db.select().from(catalogItems)
    .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).limit(1);
  const item = rows[0];
  if (!item) throw new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND');
  return item;
}

export async function updateCatalogItem(id: string, input: UpdateCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const existing = await getOwnedItemOr404(id, partnerId);

  // Recompute derived price if markup/cost changed and no explicit price supplied.
  const nextCost = input.costBasis !== undefined ? input.costBasis : (existing.costBasis != null ? Number(existing.costBasis) : null);
  const nextMarkup = input.markupPercent !== undefined ? input.markupPercent : (existing.markupPercent != null ? Number(existing.markupPercent) : null);
  const unitPrice = input.unitPrice !== undefined
    ? input.unitPrice.toFixed(2)
    : deriveUnitPrice({ explicitPrice: undefined, costBasis: nextCost != null ? nextCost.toFixed(2) : null, markupPercent: nextMarkup != null ? nextMarkup.toFixed(2) : null });

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.itemType !== undefined) patch.itemType = input.itemType;
  if (input.name !== undefined) patch.name = input.name;
  if (input.sku !== undefined) patch.sku = input.sku;
  if (input.description !== undefined) patch.description = input.description;
  if (input.billingType !== undefined) patch.billingType = input.billingType;
  if (input.unitPrice !== undefined || input.costBasis !== undefined || input.markupPercent !== undefined) patch.unitPrice = unitPrice;
  if (input.costBasis !== undefined) patch.costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
  if (input.markupPercent !== undefined) patch.markupPercent = input.markupPercent != null ? input.markupPercent.toFixed(2) : null;
  if (input.unitOfMeasure !== undefined) patch.unitOfMeasure = input.unitOfMeasure;
  if (input.taxable !== undefined) patch.taxable = input.taxable;
  if (input.taxCategory !== undefined) patch.taxCategory = input.taxCategory;
  if (input.isBundle !== undefined) patch.isBundle = input.isBundle;
  if (input.attributes !== undefined) patch.attributes = input.attributes;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  try {
    const rows = await db.update(catalogItems).set(patch)
      .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).returning();
    await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: id, partnerId, actorUserId: actor.userId });
    return rows[0]!;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU');
    }
    throw err;
  }
}

export async function archiveCatalogItem(id: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  await getOwnedItemOr404(id, partnerId);
  const rows = await db.update(catalogItems).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(catalogItems.id, id), eq(catalogItems.partnerId, partnerId))).returning();
  await emitCatalogEvent({ type: 'catalog.item.archived', catalogItemId: id, partnerId, actorUserId: actor.userId });
  return rows[0]!;
}

export async function listCatalogItems(query: ListCatalogQuery, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const conditions = [eq(catalogItems.partnerId, partnerId)];
  if (query.itemType) conditions.push(eq(catalogItems.itemType, query.itemType));
  if (query.isActive !== undefined) conditions.push(eq(catalogItems.isActive, query.isActive));
  if (query.isBundle !== undefined) conditions.push(eq(catalogItems.isBundle, query.isBundle));
  if (query.search) conditions.push(ilike(catalogItems.name, `%${query.search}%`));
  if (query.cursor) conditions.push(gt(catalogItems.id, query.cursor));
  const rows = await db.select().from(catalogItems)
    .where(and(...conditions)).orderBy(asc(catalogItems.id)).limit(query.limit);
  return rows;
}

export async function getCatalogItem(id: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const item = await getOwnedItemOr404(id, partnerId);
  const overrides = await db.select().from(catalogItemOrgPricing).where(eq(catalogItemOrgPricing.catalogItemId, id));
  const components = item.isBundle
    ? await db.select().from(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, id))
    : [];
  return { item, overrides, components };
}

export async function setOrgPriceOverride(itemId: string, orgId: string, input: OrgPriceOverrideInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  await getOwnedItemOr404(itemId, partnerId); // ensures the item is this partner's
  const unitPrice = input.unitPrice.toFixed(2);
  const rows = await db.insert(catalogItemOrgPricing)
    .values({ catalogItemId: itemId, orgId, unitPrice })
    .onConflictDoUpdate({
      target: [catalogItemOrgPricing.catalogItemId, catalogItemOrgPricing.orgId],
      set: { unitPrice, updatedAt: new Date() }
    }).returning();
  return rows[0]!;
}

export async function removeOrgPriceOverride(itemId: string, orgId: string, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  await getOwnedItemOr404(itemId, partnerId);
  await db.delete(catalogItemOrgPricing)
    .where(and(eq(catalogItemOrgPricing.catalogItemId, itemId), eq(catalogItemOrgPricing.orgId, orgId)));
  return { ok: true };
}

export async function setBundleComponents(bundleId: string, components: BundleComponentInput[], actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const bundle = await getOwnedItemOr404(bundleId, partnerId);
  if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');

  const ids = components.map((c) => c.componentItemId);
  const metaRows = ids.length
    ? await db.select({ id: catalogItems.id, isBundle: catalogItems.isBundle, partnerId: catalogItems.partnerId })
        .from(catalogItems).where(inArray(catalogItems.id, ids))
    : [];
  const componentMeta = new Map(metaRows.map((r) => [r.id, { isBundle: r.isBundle, partnerId: r.partnerId }]));

  const problems = detectBundleProblems({
    bundleId, bundlePartnerId: partnerId,
    components: components.map((c) => ({ componentItemId: c.componentItemId, quantity: c.quantity })),
    componentMeta
  });
  if (problems.includes('SELF_REFERENCE')) throw new CatalogServiceError('A bundle cannot contain itself', 400, 'BUNDLE_SELF_REFERENCE');
  if (problems.includes('NESTED_BUNDLE')) throw new CatalogServiceError('A bundle component cannot itself be a bundle', 400, 'BUNDLE_NESTED');
  if (problems.includes('CROSS_PARTNER')) throw new CatalogServiceError('Components must belong to the same partner', 400, 'BUNDLE_CROSS_PARTNER');
  if (problems.includes('COMPONENT_NOT_FOUND')) throw new CatalogServiceError('One or more components were not found', 404, 'BUNDLE_COMPONENT_NOT_FOUND');
  if (problems.includes('DUPLICATE_COMPONENT')) throw new CatalogServiceError('Duplicate component in bundle', 400, 'BUNDLE_DUPLICATE_COMPONENT');

  // Replace-set: delete existing, insert new.
  await db.delete(catalogBundleComponents).where(eq(catalogBundleComponents.bundleItemId, bundleId));
  if (components.length) {
    await db.insert(catalogBundleComponents).values(components.map((c) => ({
      partnerId,
      bundleItemId: bundleId,
      componentItemId: c.componentItemId,
      quantity: c.quantity.toFixed(2),
      showOnInvoice: c.showOnInvoice,
      revenueAllocation: c.revenueAllocation != null ? c.revenueAllocation.toFixed(2) : null
    })));
  }
  await emitCatalogEvent({ type: 'catalog.item.updated', catalogItemId: bundleId, partnerId, actorUserId: actor.userId });
  return getCatalogItem(bundleId, actor);
}

export async function resolvePrice(catalogItemId: string, orgId: string | null, actor: CatalogActor): Promise<ResolvedPrice> {
  const partnerId = requirePartner(actor);
  const item = await getOwnedItemOr404(catalogItemId, partnerId);
  let override: { unitPrice: string } | null = null;
  if (orgId) {
    const rows = await db.select({ unitPrice: catalogItemOrgPricing.unitPrice }).from(catalogItemOrgPricing)
      .where(and(eq(catalogItemOrgPricing.catalogItemId, catalogItemId), eq(catalogItemOrgPricing.orgId, orgId))).limit(1);
    override = rows[0] ?? null;
  }
  return resolvePriceFrom(
    { unitPrice: item.unitPrice, costBasis: item.costBasis, taxable: item.taxable, taxCategory: item.taxCategory },
    override
  );
}

export async function computeBundleEconomics(bundleId: string, orgId: string | null, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const bundle = await getOwnedItemOr404(bundleId, partnerId);
  if (!bundle.isBundle) throw new CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE');
  const headline = orgId ? (await resolvePrice(bundleId, orgId, actor)).unitPrice : bundle.unitPrice;

  const comps = await db.select({
    componentItemId: catalogBundleComponents.componentItemId,
    quantity: catalogBundleComponents.quantity,
    revenueAllocation: catalogBundleComponents.revenueAllocation,
    costBasis: catalogItems.costBasis
  }).from(catalogBundleComponents)
    .innerJoin(catalogItems, eq(catalogItems.id, catalogBundleComponents.componentItemId))
    .where(eq(catalogBundleComponents.bundleItemId, bundleId));

  return computeBundleEconomicsFrom({
    headlinePrice: headline,
    components: comps.map((c) => ({ quantity: c.quantity, costBasis: c.costBasis, revenueAllocation: c.revenueAllocation }))
  });
}
```

- [ ] **Step 2: Write the lifecycle event emitter (mirror `timeEntryEvents.ts` exactly)**

Create `apps/api/src/services/catalogEvents.ts`. This mirrors the verified `timeEntryEvents.ts` pattern: a lazily-created BullMQ queue + fire-and-forget enqueue that never throws into the caller (a Redis outage must not fail the mutation).

```typescript
// apps/api/src/services/catalogEvents.ts
import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

export const CATALOG_EVENTS_QUEUE = 'catalog-events';

interface CatalogEventEnvelope {
  catalogItemId: string;
  partnerId: string;
  actorUserId?: string | null;
}

export type CatalogEvent = CatalogEventEnvelope & {
  type: 'catalog.item.created' | 'catalog.item.updated' | 'catalog.item.archived';
};

let queue: Queue | null = null;

export function getCatalogEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(CATALOG_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design (timeEntryEvents.ts pattern): a Redis outage must
// never fail the user-facing mutation that emitted the event.
export async function emitCatalogEvent(event: CatalogEvent): Promise<void> {
  try {
    await getCatalogEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[CatalogEvents] failed to enqueue', event.type, `catalogItemId=${event.catalogItemId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
```

> No queue consumer is required for this sub-project — emitting onto the queue is the
> extensibility seam (future workflows/invoicing subscribe later). This matches how
> `time_entry.*` events are emitted before any dedicated worker consumes them.

- [ ] **Step 3: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors in `catalogService.ts` / `catalogEvents.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/catalogService.ts apps/api/src/services/catalogEvents.ts
git commit -m "feat(catalog): catalogService (items, overrides, bundles, price resolver) + events"
```

---

## Task 6: Permissions constant + seed grants

**Files:**
- Modify: `apps/api/src/services/permissions.ts`
- Modify: `apps/api/src/db/seed.ts`

- [ ] **Step 1: Add the PERMISSIONS entries**

In `apps/api/src/services/permissions.ts`, inside the `PERMISSIONS` object (next to `TICKETS_*`), add:

```typescript
  // Catalog (billing/invoicing program)
  CATALOG_READ: { resource: 'catalog', action: 'read' },
  CATALOG_WRITE: { resource: 'catalog', action: 'write' },
  CATALOG_DELETE: { resource: 'catalog', action: 'delete' },
```

- [ ] **Step 2: Add the permission definitions to seed DEFAULT_PERMISSIONS**

In `apps/api/src/db/seed.ts`, find the `DEFAULT_PERMISSIONS` array and add:

```typescript
  { resource: 'catalog', action: 'read', description: 'View product catalog items and pricing' },
  { resource: 'catalog', action: 'write', description: 'Create and update catalog items, pricing, and bundles' },
  { resource: 'catalog', action: 'delete', description: 'Archive/delete catalog items' },
```

- [ ] **Step 3: Grant catalog perms to partner-scope system roles**

In `apps/api/src/db/seed.ts`, in the `SYSTEM_ROLES` array:
- `Partner Admin` already has `'*:*'` — no change.
- Add to `Partner Technician`'s `permissions` array: `'catalog:read', 'catalog:write'`
- Add to `Partner Viewer`'s `permissions` array: `'catalog:read'`

(Org-scope roles get no catalog access — catalog is partner-internal in v1.)

- [ ] **Step 4: Run the seed against the local DB to confirm no crash**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api db:seed
```
Expected: completes; logs show catalog permissions seeded and granted (re-run is idempotent).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/permissions.ts apps/api/src/db/seed.ts
git commit -m "feat(catalog): catalog permission resource + partner-role grants"
```

---

## Task 7: Routes + route tests

**Files:**
- Create: `apps/api/src/routes/catalog/catalog.ts`
- Create: `apps/api/src/routes/catalog/pricing.ts`
- Create: `apps/api/src/routes/catalog/bundles.ts`
- Create: `apps/api/src/routes/catalog/index.ts`
- Create: `apps/api/src/routes/catalog/catalog.test.ts`
- Modify: the API route hub that mounts feature routers (where `ticketsRoutes` is mounted)

- [ ] **Step 1: Write the failing route test**

```typescript
// apps/api/src/routes/catalog/catalog.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/catalogService', () => ({
  createCatalogItem: vi.fn(),
  updateCatalogItem: vi.fn(),
  archiveCatalogItem: vi.fn(),
  listCatalogItems: vi.fn(),
  getCatalogItem: vi.fn(),
  CatalogServiceError: class CatalogServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Mock auth middleware to inject a partner-scoped actor with catalog perms.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner' });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { catalogRoutes } from './index';
import * as svc from '../../services/catalogService';

function app() {
  // catalogRoutes already applies authMiddleware internally
  return catalogRoutes;
}

describe('catalog routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /catalog creates an item', async () => {
    (svc.createCatalogItem as any).mockResolvedValue({ id: 'c1', name: 'X' });
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'service', name: 'Onsite hour', unitPrice: 150 })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('c1');
    expect(svc.createCatalogItem).toHaveBeenCalledOnce();
  });

  it('POST /catalog rejects invalid body (negative price)', async () => {
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'service', name: 'X', unitPrice: -1 })
    });
    expect(res.status).toBe(400);
    expect(svc.createCatalogItem).not.toHaveBeenCalled();
  });

  it('GET /catalog lists items', async () => {
    (svc.listCatalogItems as any).mockResolvedValue([{ id: 'c1' }]);
    const res = await app().request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('maps CatalogServiceError to its status code', async () => {
    (svc.createCatalogItem as any).mockRejectedValue(new (svc as any).CatalogServiceError('dupe', 409, 'DUPLICATE_SKU'));
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'service', name: 'X', unitPrice: 1 })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('DUPLICATE_SKU');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- catalog.test.ts`
Expected: FAIL — cannot find `./index`.

- [ ] **Step 3: Write the item routes**

```typescript
// apps/api/src/routes/catalog/catalog.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createCatalogItemSchema, updateCatalogItemSchema, listCatalogQuerySchema
} from '@breeze/shared';
import {
  createCatalogItem, updateCatalogItem, archiveCatalogItem, listCatalogItems, getCatalogItem,
  CatalogServiceError, type CatalogActor
} from '../../services/catalogService';

export const catalogItemRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const idParam = z.object({ id: z.string().uuid() });

export function catalogActorFrom(c: { get: (k: string) => any }): CatalogActor {
  const auth = c.get('auth');
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

catalogItemRoutes.get('/', scopes, readPerm, zValidator('query', listCatalogQuerySchema), async (c) => {
  try {
    const rows = await listCatalogItems(c.req.valid('query'), catalogActorFrom(c));
    return c.json({ data: rows });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.post('/', scopes, writePerm, zValidator('json', createCatalogItemSchema), async (c) => {
  try {
    const item = await createCatalogItem(c.req.valid('json'), catalogActorFrom(c));
    return c.json({ data: item });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    const data = await getCatalogItem(c.req.valid('param').id, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateCatalogItemSchema), async (c) => {
  try {
    const item = await updateCatalogItem(c.req.valid('param').id, c.req.valid('json'), catalogActorFrom(c));
    return c.json({ data: item });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.post('/:id/archive', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const item = await archiveCatalogItem(c.req.valid('param').id, catalogActorFrom(c));
    return c.json({ data: item });
  } catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 4: Write the pricing routes**

```typescript
// apps/api/src/routes/catalog/pricing.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { orgPriceOverrideSchema } from '@breeze/shared';
import { setOrgPriceOverride, removeOrgPriceOverride, CatalogServiceError } from '../../services/catalogService';
import { catalogActorFrom } from './catalog';

export const catalogPricingRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const param = z.object({ id: z.string().uuid(), orgId: z.string().uuid() });

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

catalogPricingRoutes.put('/:id/pricing/:orgId', scopes, writePerm, zValidator('param', param), zValidator('json', orgPriceOverrideSchema), async (c) => {
  const p = c.req.valid('param');
  try {
    const row = await setOrgPriceOverride(p.id, p.orgId, c.req.valid('json'), catalogActorFrom(c));
    return c.json({ data: row });
  } catch (err) { return handleServiceError(c, err); }
});

catalogPricingRoutes.delete('/:id/pricing/:orgId', scopes, writePerm, zValidator('param', param), async (c) => {
  const p = c.req.valid('param');
  try {
    const row = await removeOrgPriceOverride(p.id, p.orgId, catalogActorFrom(c));
    return c.json({ data: row });
  } catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 5: Write the bundle routes**

```typescript
// apps/api/src/routes/catalog/bundles.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { setBundleComponentsSchema } from '@breeze/shared';
import { setBundleComponents, computeBundleEconomics, CatalogServiceError } from '../../services/catalogService';
import { catalogActorFrom } from './catalog';

export const catalogBundleRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const idParam = z.object({ id: z.string().uuid() });
const econQuery = z.object({ orgId: z.string().uuid().optional() });

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

catalogBundleRoutes.put('/:id/components', scopes, writePerm, zValidator('param', idParam), zValidator('json', setBundleComponentsSchema), async (c) => {
  try {
    const data = await setBundleComponents(c.req.valid('param').id, c.req.valid('json').components, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});

catalogBundleRoutes.get('/:id/economics', scopes, readPerm, zValidator('param', idParam), zValidator('query', econQuery), async (c) => {
  try {
    const data = await computeBundleEconomics(c.req.valid('param').id, c.req.valid('query').orgId ?? null, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 6: Write the sub-router index (mount order: literal paths before /:id)**

```typescript
// apps/api/src/routes/catalog/index.ts
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { catalogItemRoutes } from './catalog';
import { catalogPricingRoutes } from './pricing';
import { catalogBundleRoutes } from './bundles';

export const catalogRoutes = new Hono();

catalogRoutes.use('*', authMiddleware);
// pricing + bundles use /:id/<literal> — register before the generic item /:id handlers
catalogRoutes.route('/', catalogPricingRoutes);
catalogRoutes.route('/', catalogBundleRoutes);
catalogRoutes.route('/', catalogItemRoutes);
```

- [ ] **Step 7: Mount in the API route hub**

Find where `ticketsRoutes` is mounted (the main app/route hub — search: `app.route('/tickets'` or `.route('/tickets'`). Add the import and mount alongside it:

```typescript
import { catalogRoutes } from './routes/catalog';
// ...
app.route('/catalog', catalogRoutes);
```

(Match the exact mounting style used for `tickets` in that file — `app` vs a sub-hub variable.)

- [ ] **Step 8: Run the route test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- catalog.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/catalog/
git add <the route hub file you modified>
git commit -m "feat(catalog): REST routes (items, pricing, bundles) + route tests"
```

---

## Task 8: RLS coverage allowlist + cross-tenant forge test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/catalog-rls.integration.test.ts`

> Requires a real DB with `breeze_app` (non-BYPASSRLS) and the `.env.test` symlink present (see memory: a missing `.env.test` makes RLS tests vacuously pass on a BYPASSRLS admin connection). Confirm the role with `SELECT rolbypassrls FROM pg_roles WHERE rolname='breeze_app';` → must be `f`.

- [ ] **Step 1: Add catalog tables to the allowlists**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`:

Add to `PARTNER_TENANT_TABLES`:
```typescript
  ['catalog_items', 'partner_id'],
  ['catalog_bundle_components', 'partner_id'],
```

`catalog_item_org_pricing` has a direct `org_id` column and is auto-discovered as a shape-1 org table; it needs no allowlist entry. If the test's `ORG_AXIS_POLICY_EXCLUDED_TABLES` mechanism flags the two partner-axis tables (they carry no `org_id`), add them there too:
```typescript
  'catalog_items',
  'catalog_bundle_components',
```

- [ ] **Step 2: Run the coverage test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test:rls-coverage` (or the documented command: `vitest --config vitest.config.rls-coverage.ts`)
Expected: PASS — all three catalog tables recognized as RLS-covered.

- [ ] **Step 3: Write the functional forge test**

```typescript
// apps/api/src/__tests__/integration/catalog-rls.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { catalogItems, catalogItemOrgPricing } from '../../db/schema';
import { eq } from 'drizzle-orm';
// Use the project's existing integration test harness for creating two partners +
// orgs and obtaining their access contexts. Mirror an existing *-rls.integration.test.ts
// (e.g. the time-entries or custom-field-definitions forge test) for setup/teardown.

describe('catalog RLS isolation (breeze_app)', () => {
  // IMPLEMENTER: seed partnerA/orgA and partnerB/orgB via the shared integration
  // fixtures used by the sibling *-rls.integration.test.ts files. Pseudocode below
  // shows the assertions; wire the real context helpers from that harness.

  it('partner B cannot read partner A catalog items', async () => {
    // Arrange: create an item under partner A (system context)
    const item = await withSystemDbAccessContext(async () => {
      const r = await /* db */ (globalThis as any).db.insert(catalogItems).values({
        partnerId: (globalThis as any).partnerA, itemType: 'service', name: 'A-only', unitPrice: '10.00'
      }).returning();
      return r[0];
    });

    // Act + Assert: partner B context sees zero rows
    const rowsB = await withDbAccessContext({ scope: 'partner', partnerId: (globalThis as any).partnerB } as any, async (tx: any) => {
      return tx.select().from(catalogItems).where(eq(catalogItems.id, item.id));
    });
    expect(rowsB).toHaveLength(0);
  });

  it('org B cannot read an org-A price override', async () => {
    const ov = await withSystemDbAccessContext(async () => {
      const r = await (globalThis as any).db.insert(catalogItemOrgPricing).values({
        catalogItemId: (globalThis as any).itemA, orgId: (globalThis as any).orgA, unitPrice: '5.00'
      }).returning();
      return r[0];
    });
    const rowsB = await withDbAccessContext({ scope: 'org', orgId: (globalThis as any).orgB, accessibleOrgIds: [(globalThis as any).orgB] } as any, async (tx: any) => {
      return tx.select().from(catalogItemOrgPricing).where(eq(catalogItemOrgPricing.id, ov.id));
    });
    expect(rowsB).toHaveLength(0);
  });

  it('a forged cross-partner insert is rejected by RLS', async () => {
    await expect(
      withDbAccessContext({ scope: 'partner', partnerId: (globalThis as any).partnerB } as any, async (tx: any) => {
        return tx.insert(catalogItems).values({
          partnerId: (globalThis as any).partnerA, itemType: 'service', name: 'forged', unitPrice: '1.00'
        });
      })
    ).rejects.toThrow(/row-level security/i);
  });
});
```

> IMPLEMENTER: replace the `(globalThis as any)` placeholders by copying the exact fixture/context-setup block from the nearest existing `*-rls.integration.test.ts` (the ticketing forge tests are the closest analog). The three assertions (cross-partner read = 0 rows, cross-org override read = 0 rows, forged insert throws RLS error) are the required coverage.

- [ ] **Step 4: Run the forge test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test:integration -- catalog-rls.integration.test.ts`
Expected: PASS (3 cases). If it passes suspiciously fast with no DB, re-check `.env.test` symlink + `rolbypassrls=f`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/catalog-rls.integration.test.ts
git commit -m "test(catalog): RLS coverage allowlist + cross-tenant forge tests"
```

---

## Task 9: AI read tools

**Files:**
- Create: `apps/api/src/services/aiToolsCatalog.ts`
- Modify: `apps/api/src/services/aiTools.ts`

- [ ] **Step 1: Write the tool registration**

```typescript
// apps/api/src/services/aiToolsCatalog.ts
import { and, asc, eq, ilike } from 'drizzle-orm';
import { db } from '../db';
import { catalogItems } from '../db/schema';
import type { AiTool, AiToolTier } from './aiToolsTypes'; // match the import used by aiToolsTicketing.ts

export function registerCatalogTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('search_catalog', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'search_catalog',
      description: 'Search the partner product catalog (hardware, software, services, and bundles) by name or type. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Name substring to match' },
          itemType: { type: 'string', enum: ['hardware', 'software', 'service'], description: 'Filter by item type' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      const partnerId = auth.partnerId;
      if (!partnerId) return JSON.stringify({ error: 'Catalog is partner-scoped; no partner in context' });
      const conditions = [eq(catalogItems.partnerId, partnerId), eq(catalogItems.isActive, true)];
      if (input.itemType) conditions.push(eq(catalogItems.itemType, input.itemType as 'hardware' | 'software' | 'service'));
      if (input.search) conditions.push(ilike(catalogItems.name, `%${String(input.search)}%`));
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      const rows = await db.select({
        id: catalogItems.id, name: catalogItems.name, itemType: catalogItems.itemType,
        sku: catalogItems.sku, unitPrice: catalogItems.unitPrice, isBundle: catalogItems.isBundle
      }).from(catalogItems).where(and(...conditions)).orderBy(asc(catalogItems.name)).limit(limit);
      return JSON.stringify({ items: rows, showing: rows.length });
    }
  });

  aiTools.set('get_catalog_item', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'get_catalog_item',
      description: 'Get full detail for one catalog item by id, including bundle components if it is a bundle. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: { catalogItemId: { type: 'string', description: 'Catalog item UUID' } },
        required: ['catalogItemId']
      }
    },
    handler: async (input, auth) => {
      const partnerId = auth.partnerId;
      if (!partnerId) return JSON.stringify({ error: 'Catalog is partner-scoped; no partner in context' });
      const rows = await db.select().from(catalogItems)
        .where(and(eq(catalogItems.id, String(input.catalogItemId)), eq(catalogItems.partnerId, partnerId))).limit(1);
      if (!rows[0]) return JSON.stringify({ error: 'Catalog item not found' });
      return JSON.stringify({ item: rows[0] });
    }
  });
}
```

> IMPLEMENTER: match the exact `AiTool`/`AiToolTier` import path and the `handler(input, auth)` signature used by `aiToolsTicketing.ts` (open it to confirm the types module name). Adjust if the project's tool type lives elsewhere.

- [ ] **Step 2: Register in the aiTools hub**

In `apps/api/src/services/aiTools.ts`, find where `registerTicketingTools(...)` is called and add alongside it:

```typescript
import { registerCatalogTools } from './aiToolsCatalog';
// ... in the same place registerTicketingTools(aiTools) is invoked:
registerCatalogTools(aiTools);
```

- [ ] **Step 3: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiToolsCatalog.ts apps/api/src/services/aiTools.ts
git commit -m "feat(catalog): AI read tools (search_catalog, get_catalog_item)"
```

---

## Task 10: Web settings UI — Catalog tab + item list/editor

**Files:**
- Create: `apps/web/src/components/settings/CatalogSettingsPage.tsx`
- Create: `apps/web/src/components/settings/CatalogItemsTab.tsx`
- Modify: the settings navigation/page that hosts settings sections (where `TicketingSettingsPage` is referenced/routed)

> UI verification is manual (Playwright/feature-testing later). This task delivers a working list + create/edit + archive flow using the established `runAction` + `data-testid` patterns. Bundle builder and per-org pricing panels are included as part of the editor.

- [ ] **Step 1: Write the settings page shell**

```tsx
// apps/web/src/components/settings/CatalogSettingsPage.tsx
import CatalogItemsTab from './CatalogItemsTab';

export default function CatalogSettingsPage() {
  return (
    <div className="space-y-6" data-testid="catalog-settings-page">
      <div>
        <h1 className="text-xl font-semibold">Product Catalog</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage hardware, software, and service items, per-customer pricing, and bundles.
        </p>
      </div>
      <CatalogItemsTab />
    </div>
  );
}
```

- [ ] **Step 2: Write the items tab (list + create/edit drawer + archive)**

```tsx
// apps/web/src/components/settings/CatalogItemsTab.tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';

interface CatalogItem {
  id: string;
  itemType: 'hardware' | 'software' | 'service';
  name: string;
  sku: string | null;
  unitPrice: string;
  costBasis: string | null;
  isBundle: boolean;
  isActive: boolean;
}

const EMPTY_FORM = { itemType: 'service', name: '', sku: '', unitPrice: '', costBasis: '', isBundle: false };

export default function CatalogItemsTab() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const res = await fetchWithAuth('/catalog?isActive=true');
      if (res.ok) {
        const body = (await res.json()) as { data: CatalogItem[] };
        setItems(body.data ?? []);
      } else setError(true);
    } catch { setError(true); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setEditId(null); setForm(EMPTY_FORM); setEditorOpen(true); };
  const openEdit = (it: CatalogItem) => {
    setEditId(it.id);
    setForm({
      itemType: it.itemType, name: it.name, sku: it.sku ?? '',
      unitPrice: it.unitPrice, costBasis: it.costBasis ?? '', isBundle: it.isBundle
    });
    setEditorOpen(true);
  };

  const save = useCallback(() => {
    const body: Record<string, unknown> = {
      itemType: form.itemType,
      name: form.name.trim(),
      sku: form.sku.trim() || null,
      unitPrice: Number(form.unitPrice),
      costBasis: form.costBasis ? Number(form.costBasis) : null,
      isBundle: form.isBundle
    };
    const req = editId
      ? fetchWithAuth(`/catalog/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
      : fetchWithAuth('/catalog', { method: 'POST', body: JSON.stringify(body) });
    runAction(() => req, {
      onSuccess: async () => { setEditorOpen(false); await load(); },
      onError: (e) => { handleActionError(e); }
    });
  }, [form, editId, load]);

  const archive = useCallback((id: string) => {
    runAction(() => fetchWithAuth(`/catalog/${id}/archive`, { method: 'POST' }), {
      onSuccess: async () => { await load(); },
      onError: (e) => { handleActionError(e); }
    });
  }, [load]);

  if (loading) return <div data-testid="catalog-items-loading">Loading…</div>;
  if (error) return <div data-testid="catalog-items-error">Failed to load catalog.</div>;

  return (
    <div className="space-y-4" data-testid="catalog-items-tab">
      <div className="flex justify-end">
        <button type="button" onClick={openCreate} data-testid="catalog-add-item"
          className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
          Add item
        </button>
      </div>

      <table className="w-full text-sm" data-testid="catalog-items-table">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-2">Name</th><th>Type</th><th>SKU</th><th>Price</th><th>Bundle</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id} data-testid={`catalog-item-row-${it.id}`} className="border-t">
              <td className="py-2">{it.name}</td>
              <td>{it.itemType}</td>
              <td>{it.sku ?? '—'}</td>
              <td>{it.unitPrice}</td>
              <td>{it.isBundle ? 'Yes' : '—'}</td>
              <td className="text-right">
                <button type="button" onClick={() => openEdit(it)} data-testid={`catalog-edit-${it.id}`} className="mr-2 underline">Edit</button>
                <button type="button" onClick={() => archive(it.id)} data-testid={`catalog-archive-${it.id}`} className="underline text-destructive">Archive</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editorOpen && (
        <div className="rounded border p-4 space-y-3" data-testid="catalog-item-editor">
          <select value={form.itemType} onChange={(e) => setForm({ ...form, itemType: e.target.value })} data-testid="catalog-form-type">
            <option value="hardware">Hardware</option>
            <option value="software">Software</option>
            <option value="service">Service</option>
          </select>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" data-testid="catalog-form-name" />
          <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="SKU (optional)" data-testid="catalog-form-sku" />
          <input value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} placeholder="Unit price" inputMode="decimal" data-testid="catalog-form-price" />
          <input value={form.costBasis} onChange={(e) => setForm({ ...form, costBasis: e.target.value })} placeholder="Cost basis (optional)" inputMode="decimal" data-testid="catalog-form-cost" />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.isBundle} onChange={(e) => setForm({ ...form, isBundle: e.target.checked })} data-testid="catalog-form-bundle" />
            This item is a bundle
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={save} data-testid="catalog-form-save" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Save</button>
            <button type="button" onClick={() => setEditorOpen(false)} data-testid="catalog-form-cancel" className="rounded border px-3 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

> The bundle component builder and the per-org pricing panel hang off the editor via the
> `PUT /catalog/:id/components` and `PUT /catalog/:id/pricing/:orgId` endpoints. Add them
> as a follow-up sub-step once the item CRUD is verified working in the browser — they
> reuse the same `runAction` + `fetchWithAuth` pattern shown above. (Kept out of the first
> commit to keep this task reviewable; they are not new backend surface.)

- [ ] **Step 3: Wire the page into settings navigation**

Find the settings host (where `TicketingSettingsPage` is routed/rendered — e.g. an Astro page under `apps/web/src/pages/settings/` or a settings nav component) and add a "Product Catalog" entry that renders `CatalogSettingsPage`. Match the existing registration pattern exactly (same nav array / route shape used for Ticketing Settings).

- [ ] **Step 4: Type-check + build web**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit`
Expected: no new errors in the new components.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/CatalogSettingsPage.tsx apps/web/src/components/settings/CatalogItemsTab.tsx
git add <the settings nav/page file you modified>
git commit -m "feat(catalog): settings UI — catalog item list, create/edit, archive"
```

---

## Task 11: Final verification sweep

- [ ] **Step 1: Run all new/affected API tests (single fork)**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- catalogPricing.test.ts catalog.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared test -- catalog.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Run RLS coverage + forge (real DB)**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test:rls-coverage
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test:integration -- catalog-rls.integration.test.ts
```
Expected: PASS.

- [ ] **Step 3: Drift + type-check**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: no drift; no new type errors.

- [ ] **Step 4: Manual smoke (optional, recommended)**

Start the stack, log in as a partner admin, open Settings → Product Catalog, create a hardware item, a service item, mark one as a bundle and add the service as a component, then confirm it lists. Confirm an org-scope user gets 403 on `GET /catalog`.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin docs/2026-06-14-billing-catalog-spec
gh pr create --title "feat(catalog): product catalog (items, per-org pricing, bundles)" \
  --body "Implements docs/superpowers/specs/2026-06-14-product-catalog-design.md (sub-project 1 of the billing/invoicing program). Partner-axis catalog_items + bundles, org-axis per-customer pricing, ticket_parts.catalog_item_id, RLS + forge tests, AI read tools, settings UI."
```

> Branch note: the catalog implementation rides on `docs/2026-06-14-billing-catalog-spec` (which already holds the two spec docs). If a clean feature branch is preferred, branch the implementation off `main` separately before Task 1.

---

## Self-Review Notes (for the executor)

- **Money handling:** all monetary values cross the wire as JS numbers (validated `multipleOf(0.01)`) and are stored as fixed-2 strings to match `numeric(12,2)`. The pure helpers in `catalogPricing.ts` are the single place that does cent math — keep rounding there.
- **RLS gotchas baked in:** `catalog_bundle_components` carries a denormalized `partner_id` (flat policy, avoids the nested-EXISTS bound-param bug). The forge test is mandatory — the rls-coverage contract test alone does NOT prove the second-axis/override isolation.
- **Vacuous-RLS trap:** if forge tests pass with no DB activity, fix the `.env.test` symlink and confirm `breeze_app` has `rolbypassrls = f`.
- **Suite flakiness:** verify via single-file single-fork runs; trust CI for the full suite.
- **`emitCatalogEvent`** mirrors `timeEntryEvents.ts` (BullMQ enqueue, fire-and-forget). No consumer is needed in this sub-project — the queue is the subscribe-later seam for invoicing/workflows.
- **Two remaining `IMPLEMENTER` callouts are intentional** (not vague TODOs): the RLS forge-test fixtures (copy the partner/org setup block from the nearest `*-rls.integration.test.ts`) and the AI-tool type import path (confirm against `aiToolsTicketing.ts`). Both require reading one existing file the executor will have open; the required behavior/assertions are fully specified.
