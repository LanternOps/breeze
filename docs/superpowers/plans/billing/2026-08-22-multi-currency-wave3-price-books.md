---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 3 — Price Books & Costs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task carries an **Executor:** line — `codex` tasks are fully self-contained (codex sees only that task's text); `claude` tasks may reference sibling tasks.

**Goal:** Sell prices move out of `catalog_items.unit_price` into a per-currency price book (`catalog_item_prices`, partner-axis RLS), org overrides and costs carry an explicit currency, `resolvePrice(itemId, targetCurrency, orgId, actor)` resolves override → price book → typed `NO_PRICE_FOR_CURRENCY` gap (never converts), every catalog-sourced document line (quote, invoice, contract) routes through the resolver, margin/bundle math refuses to compute across currencies, and the TD SYNNEX + Pax8 import seams write `cost_currency` from the feed (B4).

**Architecture:** Two same-day migrations (`2026-08-29-a-` creates + seeds the price book; `2026-08-29-b-` adds `catalog_items.cost_currency`, `catalog_item_org_pricing.partner_id` + `currency_code` with composite same-partner FKs). `catalogPricing.ts` stays pure (currency-aware resolver + bundle economics); `catalogService.ts` owns the DB resolver and gains `setItemPrice`/`removeItemPrice`/`listItemPrices`; the resolver takes a `DbExecutor` so document services call it on their already-locked transaction (lock order unchanged: document row → lines; price-book reads are plain SELECTs, never `FOR UPDATE`). `catalog_items.unit_price` stays as a deprecated read-mirror of the partner-currency row (drop is a later cleanup migration). Import services pass `costCurrency` from the feed; routes tighten `currency` to `currencyCodeSchema`. Web: price-book editor per currency, currency-aware pickers, margin guard copy.

**Tech Stack:** Hono + Drizzle ORM, hand-written SQL migrations, Vitest (Drizzle-mock unit + real-DB integration on postgres `localhost:5436` / redis `localhost:6386` via the worktree's `.env.test`), Astro + React islands, react-i18next (8 locales).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3775, branch `feature/3772-multi-currency/wave-3775`, worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave3`. Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §6 (schema, resolution, margins/bundles/imports), §3 bug B4, §14 (partner-RLS suite + export-policy new-column rule). Wave-2 precedent: `docs/superpowers/plans/billing/2026-08-21-multi-currency-wave2-document-correctness.md`.

## Global Constraints

- **No conversion, ever.** A missing price in the target currency is `NO_PRICE_FOR_CURRENCY` (409) — never another currency's number, never cost×markup in a different currency.
- **Per-currency price books with explicit gaps.** The price book is the only sell-price authority. `catalog_items.unit_price` is a deprecated mirror of the partner-currency row: written by the service for compatibility, **read by nothing** after this wave (the cleanup migration that drops it is out of scope).
- **Snapshots rule.** Document lines snapshot the resolved price at add-time. Contract lines keep their stamped `unit_price`; a billing run that finds a price-book gap bills that stamped snapshot (Task 8) rather than failing the run or converting — but the gap is **never silent**: `generateDueInvoice` returns it in `GenerateResult.priceBookGaps` and the contract worker logs one structured warning per gap (codex review, finding 3). Owner sign-off on "bill the snapshot" vs "skip the period" is still pending — see Self-Review (a).
- **Cost is one authority:** `catalog_items.cost_basis` + `cost_currency` (NOT NULL, no default — fail-loud like `organizations.currency_code`). Margin math only when `cost_currency === sell currency`; otherwise `marginAvailable: false` and the UI shows "cost in X — margin unavailable".
- **Minor-unit representability (spec §4 rounding rule).** Every price-book row, org override, and cost written by `catalogService` is validated with `isRepresentableInCurrency(value, currency)` from `@breeze/shared` (`PRICE_NOT_REPRESENTABLE` 400 — `100.50 JPY` is refused); markup-derived prices go through `roundToCurrency(value, costCurrency)`. Seeds/backfills never rewrite legacy values — they count and warn (forensic, like wave 1).
- **Tenancy:** `catalog_item_prices` = shape 3 partner-axis (`breeze_has_partner_access(partner_id)`), registered in `PARTNER_TENANT_TABLES` + its own partner-RLS suite. `catalog_item_org_pricing` stays shape 1 (org_id) but gains denormalized `partner_id` + composite FKs `(catalog_item_id, partner_id) → catalog_items(id, partner_id)` and `(org_id, partner_id) → organizations(id, partner_id)` for structural same-partner proof. Partner purge sweeps every `partner_id` table dynamically (`tenantCascade.ts:1017-1025`) — no cascade-list entry needed; the export-policy registry fires on the two NEW columns of `catalog_item_org_pricing`.
- **Migrations:** `2026-08-29-a-catalog-item-prices.sql` and `2026-08-29-b-catalog-cost-currency-and-org-pricing-currency.sql` (same-day dependent → `-a-`/`-b-` infix; `ls apps/api/migrations | sort | tail` must show `2026-08-28-billing-doc-currency-drop-default.sql` as the last file before adding). Idempotent, no inner `BEGIN`/`COMMIT`, row-count `RAISE WARNING` on every backfill/cleanup.
- **Lock ordering:** unchanged from wave 2 (invoice/quote/contract row → lines → sources). The resolver runs inside the document transaction **after** the document lock, with plain SELECTs on catalog tables. Catalog writers never lock document rows, so no new document edge exists. **Catalog-side order (new, Task 5):** every writer that touches an item and its price rows runs in ONE `db.transaction` and locks the `catalog_items` row `FOR UPDATE` first, then mutates `catalog_item_prices` / `catalog_item_org_pricing`, then writes the `unit_price` mirror — `setItemPrice`, `removeItemPrice`, `updateCatalogItem`, `setOrgPriceOverride`, `removeOrgPriceOverride` all follow item → prices → mirror (an item-first/price-first split is an AB/BA deadlock; codex review, finding 5).
- **Error codes:** `NO_PRICE_FOR_CURRENCY` (409) on `CatalogServiceError`, `QuoteServiceError`, `InvoiceServiceError`, `ContractServiceError`; `PRICE_BOOK_INCOMPLETE` (409) on catalog + invoice; `CURRENCY_MISMATCH` (400) reused for an override whose currency cannot be written; `PRICE_REQUIRED` (400) for a create with no price at all; `PRICE_NOT_REPRESENTABLE` (400) for an amount with more decimals than the currency's minor unit. `CatalogServiceError.status` stays `400 | 403 | 404 | 409`.
- Unit tests: Drizzle mock-queue conventions per the `breeze-testing` skill. Integration tests: `pnpm --filter @breeze/api test:integration <file>` from the worktree (`.env.test` pins `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5436/breeze_test`, `DATABASE_URL_APP=...breeze_app...`, `REDIS_URL=redis://localhost:6386`). `pnpm test` green ≠ CI green — run `test:integration` + `test:rls-coverage` before PR.
- Commit after every task; turbo typecheck + targeted tests per task; full integration suite + `pnpm db:check-drift` before PR.

---

### Task 1: `catalog_item_prices` table — migration, Drizzle schema, seed, RLS registration, partner-RLS suite

**Executor:** claude (tenancy)

**Files:**
- Create: `apps/api/migrations/2026-08-29-a-catalog-item-prices.sql`
- Modify: `apps/api/src/db/schema/catalog.ts` (add `catalogItemPrices` after `catalogItems` at `:50`; import `supportedCurrencies` from `./currency` and `foreignKey` from `drizzle-orm/pg-core`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:207-209` (`PARTNER_TENANT_TABLES` catalog block)
- Modify: `apps/api/src/__tests__/integration/tenantCascadePartner.integration.test.ts:117-139` (add `catalog_item_prices` row assertions)
- Create: `apps/api/src/__tests__/integration/catalogItemPricesPartnerRls.integration.test.ts`

**Interfaces:**
- Produces table `catalog_item_prices(id uuid PK, item_id uuid NOT NULL, partner_id uuid NOT NULL → partners(id), currency_code char(3) NOT NULL → supported_currencies(code), unit_price numeric(12,2) NOT NULL, created_at, updated_at)`, `UNIQUE (item_id, currency_code)`, composite FK `(item_id, partner_id) → catalog_items(id, partner_id) ON DELETE CASCADE` (the `catalog_items_id_partner_uq (id, partner_id)` unique index already exists — `catalog.ts:45`, migration `2026-06-18-a-pax8-billing-sync.sql:105`), index on `partner_id`, RLS enabled + forced, one `FOR ALL` policy `catalog_item_prices_partner_access` = `breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)`.
- Seed: one row per existing catalog item in the owning partner's current currency, copied from `catalog_items.unit_price` — **only when that partner currency is on `supported_currencies`** (wave 1 deliberately left off-list partner codes in place with the FK `NOT VALID`, `2026-08-27-b-org-currency-and-fks.sql:49-60`; an enforced FK on the new table would abort the whole migration on one `ZZZ`). Skipped items are counted and warned; non-representable values (cents under a zero-decimal currency) are counted and warned but seeded as-is (forensic, never rewritten).
- Drizzle export `catalogItemPrices` (auto-exported through `schema/index.ts:99`).

Migration content (exactly this):

```sql
-- Multi-currency wave 3 (#3775, spec §6): per-currency sell-price book.
-- Partner-axis RLS (shape 3) — partner_id is the isolation axis, mirroring
-- catalog_items / catalog_item_images. Composite ownership FK proves the row's
-- partner_id is the item's partner_id. Idempotent.
CREATE TABLE IF NOT EXISTS catalog_item_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  currency_code char(3) NOT NULL REFERENCES supported_currencies(code),
  unit_price numeric(12,2) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_item_prices_item_currency_uq ON catalog_item_prices (item_id, currency_code);
CREATE INDEX IF NOT EXISTS catalog_item_prices_partner_idx ON catalog_item_prices (partner_id);

DO $$ BEGIN
  ALTER TABLE catalog_item_prices
    ADD CONSTRAINT catalog_item_prices_item_partner_fk
    FOREIGN KEY (item_id, partner_id) REFERENCES catalog_items(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE catalog_item_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_prices FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'catalog_item_prices'
      AND policyname = 'catalog_item_prices_partner_access'
  ) THEN
    CREATE POLICY catalog_item_prices_partner_access ON catalog_item_prices
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- Seed: every existing item gets ONE price-book row in its partner's current
-- currency, copied from the legacy unit_price. ON CONFLICT keeps re-runs a no-op.
-- Wave 1 left off-list partner currency codes in place (partners FK is NOT VALID,
-- 2026-08-27-b-org-currency-and-fks.sql §3) — those items are SKIPPED (counted),
-- never rewritten, so one legacy code cannot abort this migration.
DO $$
DECLARE n integer; skipped integer; odd integer;
BEGIN
  INSERT INTO catalog_item_prices (item_id, partner_id, currency_code, unit_price)
  SELECT ci.id, ci.partner_id, upper(trim(p.currency_code)), ci.unit_price
  FROM catalog_items ci
  JOIN partners p ON p.id = ci.partner_id
  JOIN supported_currencies sc ON sc.code = upper(trim(p.currency_code))
  ON CONFLICT (item_id, currency_code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: seeded % catalog_item_prices rows from catalog_items.unit_price', n; END IF;

  SELECT count(*) INTO skipped
  FROM catalog_items ci JOIN partners p ON p.id = ci.partner_id
  WHERE NOT EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = upper(trim(p.currency_code)));
  IF skipped > 0 THEN RAISE WARNING 'multi-currency: % catalog_items NOT seeded — partner currency is off-list (left without a price-book row; fix the partner currency, then PUT /catalog/:id/prices/:code)', skipped; END IF;

  -- Zero-decimal partner currencies (JPY, KRW, CLP, ...) with a legacy cents
  -- value: seeded as-is (snapshots rule), counted for forensics.
  SELECT count(*) INTO odd
  FROM catalog_item_prices cp
  WHERE cp.currency_code IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF')
    AND cp.unit_price <> trunc(cp.unit_price);
  IF odd > 0 THEN RAISE WARNING 'multi-currency: % seeded price-book rows carry sub-unit amounts in a zero-decimal currency (left as-is; PRICE_NOT_REPRESENTABLE blocks new writes)', odd; END IF;
END $$;

COMMENT ON COLUMN catalog_items.unit_price IS
  'DEPRECATED (multi-currency wave 3): read-mirror of the partner-currency catalog_item_prices row. Readers use catalog_item_prices; dropped by a later cleanup migration.';
```

Drizzle table (append after `catalogItems`):

```ts
// Partner-axis (RLS shape 3). Per-currency sell price book (multi-currency
// wave 3). UNIQUE(item_id, currency_code); composite FK proves same partner.
export const catalogItemPrices = pgTable('catalog_item_prices', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  currencyCode: char('currency_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('catalog_item_prices_item_currency_uq').on(t.itemId, t.currencyCode),
  index('catalog_item_prices_partner_idx').on(t.partnerId),
  foreignKey({
    columns: [t.itemId, t.partnerId],
    foreignColumns: [catalogItems.id, catalogItems.partnerId],
    name: 'catalog_item_prices_item_partner_fk'
  }).onDelete('cascade')
]);
```

- [ ] **Step 1: Write the failing partner-RLS suite** `catalogItemPricesPartnerRls.integration.test.ts` (helpers copied from `psaConnectionsPartnerRls.integration.test.ts:37-62` — `SYSTEM_CTX`, `partnerContext`, `orgContext`; fixture seeded fresh per test under `withSystemDbAccessContext` like `catalog-rls.integration.test.ts:85-130`: partnerA/orgA/partnerB/orgB via `createPartner`/`createOrganization`, `itemA` under partnerA inserted WITHOUT `costCurrency` (the column does not exist until Task 2 — Task 2's fixture sweep adds it to this file; codex review, finding 2) and a price row `{ itemId: itemA.id, partnerId: partnerA.id, currencyCode: 'USD', unitPrice: '10.00' }`). Cases: (a) partner B ctx SELECT on `catalog_item_prices` WHERE `item_id = itemA.id` → 0 rows; (b) forged INSERT under partner B ctx with `partnerId: partnerA.id` → SQLSTATE `42501`; (c) partner B ctx UPDATE/DELETE of the A row → 0 rows affected (`.returning()` length 0); (d) system ctx INSERT `(itemA, partnerB)` → `23503` (composite FK rejects a foreign partner even for system writers); (e) org A ctx INSERT → `42501` (org tokens never write the price book); (f) `DELETE FROM catalog_items WHERE id = itemA.id` under system → price row gone (cascade); **positive proof** (an over-restrictive policy must fail too): (g) partner A ctx SELECT → 1 row, INSERT a second currency row `{ itemA, partnerA, 'EUR', '9.00' }` → returned, UPDATE it → 1 row affected, DELETE it → 1 row affected; (h) system ctx INSERT `(itemA, partnerA, 'GBP')` succeeds.
- [ ] **Step 2: Register + assert:** add `['catalog_item_prices', 'partner_id'],` directly after `['catalog_item_images', 'partner_id'],` in `rls-coverage.integration.test.ts` (extend the block comment: "catalog_item_prices (wave 3, #3775) — per-currency price book, composite FK to catalog_items(id, partner_id)"). In `tenantCascadePartner.integration.test.ts`: in the seed for `purge` and `control` insert one catalog item (no `costCurrency` yet — Task 2 adds it) + one price row each, then assert `countById('catalog_item_prices', 'partner_id', purge.partnerId)` is 0 and `...control.partnerId` is 1.
- [ ] **Step 3: Run to verify failure** — `pnpm --filter @breeze/api test:integration catalogItemPricesPartnerRls` → fails (relation does not exist); `rls-coverage` fails on the unknown table name.
- [ ] **Step 4: Create the migration + Drizzle table** (content above). Run `pnpm db:migrate` against the test DB, then `pnpm db:check-drift` → no drift (the composite FK name must match exactly).
- [ ] **Step 5: Run** `catalogItemPricesPartnerRls`, `rls-coverage`, `tenantCascadePartner`, `supportedCurrencies` integration files and `apps/api/src/db/autoMigrate.test.ts` → PASS.
- [ ] **Step 6: Commit** — `feat(api): catalog_item_prices price-book table with partner-axis RLS + seed (#3775)`.

### Task 2: `cost_currency` + org-override currency/partner columns — migration, Drizzle, export policy, fixture sweep

**Executor:** claude (tenancy + repo-wide fixture sweep)

**Files:**
- Create: `apps/api/migrations/2026-08-29-b-catalog-cost-currency-and-org-pricing-currency.sql`
- Modify: `apps/api/src/db/schema/catalog.ts:20-50` (`catalogItems` gains `costCurrency`), `:69-80` (`catalogItemOrgPricing` gains `partnerId`, `currencyCode`, two composite FKs, partner index)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:90` (`catalog_item_org_pricing` → add `"partner_id","currency_code"` to `included`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:204-206` (comment only: org_pricing stays shape 1 and now carries a denormalized `partner_id` for the composite FK — NOT dual-axis)
- Modify (fixtures now missing `costCurrency`/`currencyCode`/`partnerId` — re-grep `insert(catalogItems)`, `insert(catalogItemOrgPricing)`, `INSERT INTO catalog_items`, `INSERT INTO catalog_item_org_pricing` across `apps/` **and `ee/`** before finalizing): `apps/api/src/__tests__/integration/catalog-rls.integration.test.ts:95-130`, `catalogService.integration.test.ts`, `dbSavepointErrorIsolation.integration.test.ts`, `pax8OrdersPartnerRls.integration.test.ts`, `pax8OrderSubmit.integration.test.ts`, `quoteAcceptPax8Order.integration.test.ts`, `quoteDeposit.integration.test.ts`, `quoteService.integration.test.ts:92-112` (`seedCatalogItem` helper), **plus the two files Task 1 created/extended** (`catalogItemPricesPartnerRls.integration.test.ts`, `tenantCascadePartner.integration.test.ts`) — their item inserts gain `costCurrency: 'USD'` here, not in Task 1
- Create: `apps/api/src/__tests__/integration/catalogCurrencyColumns.integration.test.ts`

**Interfaces:**
- `catalog_items.cost_currency char(3) NOT NULL` (no default) → `supported_currencies`; Drizzle `costCurrency: char('cost_currency', { length: 3 }).notNull().references(() => supportedCurrencies.code)`.
- `catalog_item_org_pricing.partner_id uuid NOT NULL`, `currency_code char(3) NOT NULL` → `supported_currencies`; composite FKs `catalog_item_org_pricing_item_partner_fk (catalog_item_id, partner_id) → catalog_items(id, partner_id) ON DELETE CASCADE` and `catalog_item_org_pricing_org_partner_fk (org_id, partner_id) → organizations(id, partner_id)` (the `organizations_id_partner_id_unique` index exists — `orgs.ts:150`); index `catalog_item_org_pricing_partner_idx (partner_id)`. The original single-column FK `catalog_item_id → catalog_items(id) ON DELETE CASCADE` stays.
- Export policy: every column of `catalog_item_org_pricing` classified (`tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip` fire on the new columns).
- Partner purge side-effect: `cascadeDeletePartner` (`tenantCascade.ts:1017-1025`) discovers tables by `column_name = 'partner_id'`, so `catalog_item_org_pricing` is now swept by the partner purge as well as the org cascade (`tenantCascade.ts:113`). Both paths are idempotent DELETEs under system context — no list edit, but Task 1 Step 2's `tenantCascadePartner` extension must also seed one override row under `purge` and assert `countById('catalog_item_org_pricing', 'partner_id', purge.partnerId)` is 0 after the purge.

Migration content (exactly this):

```sql
-- Multi-currency wave 3 (#3775, spec §6): cost currency on catalog items;
-- org price overrides carry their currency + a denormalized partner_id with
-- composite FKs proving item, org, and override share one partner.
-- Depends on 2026-08-29-a-catalog-item-prices.sql (same-date -a-/-b- infix).

-- 1) catalog_items.cost_currency: add nullable, backfill from partner, SET NOT NULL, FK.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS cost_currency char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_items ci
  SET cost_currency = upper(trim(p.currency_code))
  FROM partners p
  WHERE p.id = ci.partner_id AND ci.cost_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled cost_currency on % catalog_items from partner default', n; END IF;
END $$;

ALTER TABLE catalog_items ALTER COLUMN cost_currency SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_cost_currency_fkey
    FOREIGN KEY (cost_currency) REFERENCES supported_currencies(code) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_items VALIDATE CONSTRAINT catalog_items_cost_currency_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE WARNING 'multi-currency: catalog_items has off-list cost_currency rows; catalog_items_cost_currency_fkey left NOT VALID';
END $$;

-- 2) catalog_item_org_pricing.partner_id: add, backfill from the item, audit
--    cross-partner overrides (isolation-breach artifacts — counted, then
--    deleted so the composite FKs can be added), SET NOT NULL.
ALTER TABLE catalog_item_org_pricing ADD COLUMN IF NOT EXISTS partner_id uuid;

DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_item_org_pricing op
  SET partner_id = ci.partner_id
  FROM catalog_items ci
  WHERE ci.id = op.catalog_item_id AND op.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled partner_id on % catalog_item_org_pricing rows from catalog_items', n; END IF;

  DELETE FROM catalog_item_org_pricing op
  USING organizations o
  WHERE o.id = op.org_id AND o.partner_id <> op.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Unconditional: a recorded 0 is the forensic evidence that no cross-tenant
  -- override ever existed (CLAUDE.md cleanup-statement rule).
  RAISE WARNING 'multi-currency: deleted % cross-partner catalog_item_org_pricing rows (org partner <> item partner) — tenant-isolation audit', n;
END $$;

ALTER TABLE catalog_item_org_pricing ALTER COLUMN partner_id SET NOT NULL;

-- 3) catalog_item_org_pricing.currency_code: backfill from the org's currency.
ALTER TABLE catalog_item_org_pricing ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_item_org_pricing op
  SET currency_code = o.currency_code
  FROM organizations o
  WHERE o.id = op.org_id AND op.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % catalog_item_org_pricing rows from organizations', n; END IF;
END $$;

ALTER TABLE catalog_item_org_pricing ALTER COLUMN currency_code SET NOT NULL;

-- NOT VALID + guarded validation: an org carrying a legacy off-list currency
-- (wave 1 left those in place) must not abort the migration.
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing ADD CONSTRAINT catalog_item_org_pricing_currency_code_fkey
    FOREIGN KEY (currency_code) REFERENCES supported_currencies(code) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing VALIDATE CONSTRAINT catalog_item_org_pricing_currency_code_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE WARNING 'multi-currency: catalog_item_org_pricing has off-list currency_code rows; catalog_item_org_pricing_currency_code_fkey left NOT VALID';
END $$;

-- 4) Composite same-partner FKs + partner index.
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing ADD CONSTRAINT catalog_item_org_pricing_item_partner_fk
    FOREIGN KEY (catalog_item_id, partner_id) REFERENCES catalog_items(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing ADD CONSTRAINT catalog_item_org_pricing_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS catalog_item_org_pricing_partner_idx ON catalog_item_org_pricing (partner_id);
```

Drizzle edits:

```ts
// catalogItems — after markupPercent (:32):
  // Multi-currency wave 3: currency of cost_basis. NOT NULL, no default —
  // every writer stamps it (createCatalogItem defaults to the partner currency).
  costCurrency: char('cost_currency', { length: 3 }).notNull().references(() => supportedCurrencies.code),
// and annotate :30:
  // DEPRECATED read-mirror of the partner-currency catalog_item_prices row
  // (multi-currency wave 3). Written for compatibility, read by nothing.
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),

// catalogItemOrgPricing — full replacement:
// Org-axis (RLS shape 1, direct org_id). Per-customer sell-price override in an
// explicit currency. partner_id is denormalized ONLY for the composite FKs that
// prove item, org, and override share one partner — the RLS axis stays org_id.
export const catalogItemOrgPricing = pgTable('catalog_item_org_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogItemId: uuid('catalog_item_id').notNull().references(() => catalogItems.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('catalog_item_org_pricing_item_org_uq').on(t.catalogItemId, t.orgId),
  index('catalog_item_org_pricing_org_idx').on(t.orgId),
  index('catalog_item_org_pricing_partner_idx').on(t.partnerId),
  foreignKey({ columns: [t.catalogItemId, t.partnerId], foreignColumns: [catalogItems.id, catalogItems.partnerId], name: 'catalog_item_org_pricing_item_partner_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.orgId, t.partnerId], foreignColumns: [organizations.id, organizations.partnerId], name: 'catalog_item_org_pricing_org_partner_fk' })
]);
```

- [ ] **Step 1: Write the failing integration test** `catalogCurrencyColumns.integration.test.ts`: (a) `db.insert(catalogItems)` without `costCurrency` → `23502`; (b) `information_schema.columns.column_default IS NULL` and `is_nullable = 'NO'` for `catalog_items.cost_currency`, `catalog_item_org_pricing.currency_code`, `catalog_item_org_pricing.partner_id`; (c) `pg_constraint` has `catalog_items_cost_currency_fkey`, `catalog_item_org_pricing_currency_code_fkey`, `catalog_item_org_pricing_item_partner_fk`, `catalog_item_org_pricing_org_partner_fk` (query `SELECT conname FROM pg_constraint WHERE conrelid = 'catalog_item_org_pricing'::regclass`); (d) a forged override `(itemA of partnerA, orgB of partnerB, partnerId: partnerA)` under system ctx → `23503`; (e) `costCurrency: 'ZZZ'` → `23503`.
- [ ] **Step 2: Run to verify failure** — columns absent.
- [ ] **Step 3: Create the migration + Drizzle edits + export-policy entry:** registry line becomes `"catalog_item_org_pricing": tablePolicy("org_id", {"included":["id","catalog_item_id","org_id","partner_id","currency_code","unit_price","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),`. `pnpm db:migrate` then `pnpm db:check-drift` → no drift.
- [ ] **Step 4: Fixture sweep** — every `insert(catalogItems)` in the files listed above gets `costCurrency: 'USD'`; every `insert(catalogItemOrgPricing)` gets `partnerId: <item's partner>, currencyCode: 'USD'`. **Price-book seeding for suites that call `addCatalogLine` directly** (they will hit `NO_PRICE_FOR_CURRENCY` once Task 7 lands — codex review, finding 11): `quoteDeposit.integration.test.ts:58-70` (`seedHardwareCatalogItem`) and `quoteAcceptPax8Order.integration.test.ts:52-62` (`db.insert(catalogItems)` inline) switch to the `createCatalogItemWithPrice` helper below (or insert a `catalogItemPrices` row `{ itemId, partnerId, currencyCode: 'USD', unitPrice }` right after the item) so each item has a USD price-book row. In `quoteService.integration.test.ts` `seedCatalogItem` (`:92-112`) add `costCurrency: values.costCurrency ?? 'USD'` AND insert a `catalogItemPrices` row `{ itemId, partnerId, currencyCode: values.priceCurrency ?? 'USD', unitPrice: values.unitPrice }` (Task 7 makes `addCatalogLine` read the book; seeding it here keeps that file green across both tasks). Add a shared helper to `db-utils.ts`: `export async function createCatalogItemWithPrice(opts: { partnerId: string; name: string; currencyCode: string; unitPrice: string; costBasis?: string | null; costCurrency?: string; itemType?: 'hardware' | 'software' | 'service' })` that inserts the item (`costCurrency: opts.costCurrency ?? opts.currencyCode`) and one price row, returning `{ id }`; and extend `CreatePartnerOptions` with `currencyCode?: string` (insert `currencyCode: options.currencyCode ?? 'USD'`) and `CreateOrganizationOptions` with `currencyCode?: string` (replace the literal `'USD'` at `:148` with `options.currencyCode ?? 'USD'`).
- [ ] **Step 5: Run** the new test + `catalog-rls`, `catalogService`, `quoteService`, `quoteDeposit`, `quoteAcceptPax8Order`, `pax8OrderSubmit`, `pax8OrdersPartnerRls`, `dbSavepointErrorIsolation`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `rls-coverage` integration files + `autoMigrate.test.ts` → PASS.
- [ ] **Step 6: Commit** — `feat(api): catalog cost_currency + org-override currency/partner columns with same-partner FKs (#3775)`.

### Task 3: Shared validators — price-book inputs, cost currency, override currency, reprice flag

**Executor:** codex

**Files:**
- Modify: `packages/shared/src/validators/catalog.ts` (`createCatalogItemSchema` `:42-68`, `updateCatalogItemSchema` `:71-88`, `orgPriceOverrideSchema` `:91`, `listCatalogQuerySchema` `:107-118`; add `import { currencyCodeSchema } from './currency';` after line 1)
- Modify: `packages/shared/src/validators/currency.ts:22-25` (`changeCurrencySchema` gains `reprice`)
- Test: `packages/shared/src/validators/catalog.test.ts` (extend), `packages/shared/src/validators/currency.test.ts` (extend; create the file if it does not exist, following `catalog.test.ts`'s `describe/it/expect` style)

**Interfaces (exact):**

```ts
// catalog.ts — new, exported, placed directly above createCatalogItemSchema
export const itemPriceInputSchema = z.object({
  currencyCode: currencyCodeSchema,
  unitPrice: money,
});
export type ItemPriceInput = z.infer<typeof itemPriceInputSchema>;

// createCatalogItemSchema field changes (all other fields unchanged):
  unitPrice: money.optional(),                       // legacy: price in the PARTNER currency
  prices: z.array(itemPriceInputSchema).max(40).optional(),
  costBasis: money.nullable().optional(),
  costCurrency: currencyCodeSchema.optional(),       // defaults server-side to the partner currency
// plus a .superRefine on the object: unique currencyCode within `prices`
// (message 'Duplicate currency in prices', path ['prices']); and at least one
// price source: unitPrice !== undefined || (prices?.length ?? 0) > 0 ||
// (costBasis != null && markupPercent != null)  (message 'A price is required:
// provide unitPrice, prices, or costBasis + markupPercent', path ['unitPrice']).

// updateCatalogItemSchema adds:
  costCurrency: currencyCodeSchema.optional(),
// (the existing .refine "At least one field is required" stays)

export const orgPriceOverrideSchema = z.object({
  unitPrice: money,
  currencyCode: currencyCodeSchema.optional(),       // defaults server-side to the org's currency
});

export const setItemPriceSchema = z.object({ unitPrice: money });
export type SetItemPriceInput = z.infer<typeof setItemPriceSchema>;

// listCatalogQuerySchema adds:
  currencyCode: currencyCodeSchema.optional(),       // "items priced in X" filter

// currency.ts:
export const changeCurrencySchema = z.object({
  currencyCode: currencyCodeSchema,
  clearLines: z.boolean().default(false),
  // Wave 3: re-resolve catalog-sourced lines from the price book in the new
  // currency inside the same transaction. Mutually exclusive with clearLines.
  reprice: z.boolean().default(false),
}).strict().refine((v) => !(v.clearLines && v.reprice), { message: 'clearLines and reprice are mutually exclusive', path: ['reprice'] });
```

Note: `createCatalogItemSchema` is currently a plain `z.object(...)`; adding `.superRefine` turns it into a `ZodEffects`. `apps/api/src/services/aiToolsCatalog.ts:76` wraps it as `z.object({ item: createCatalogItemSchema })` — that still works with a `ZodEffects` value, so no API change is needed.

- [ ] **Step 1: Write failing tests** in `catalog.test.ts`: create accepts `{ ..., prices: [{ currencyCode: 'eur', unitPrice: 10 }] }` with no `unitPrice` and normalizes to `'EUR'`; create with neither `unitPrice`, `prices`, nor cost+markup → fails with the 'A price is required' message; duplicate currency in `prices` → fails; `prices` with `'ZZZ'` → fails; `costCurrency: 'cad'` → `'CAD'`; `orgPriceOverrideSchema` accepts `{ unitPrice: 5 }` and `{ unitPrice: 5, currencyCode: 'gbp' }` → `'GBP'`; `setItemPriceSchema` rejects negative; `listCatalogQuerySchema` accepts `currencyCode=eur` → `'EUR'`. In `currency.test.ts`: `changeCurrencySchema` defaults `reprice: false`; `{ currencyCode: 'EUR', clearLines: true, reprice: true }` → fails on path `['reprice']`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/shared test catalog currency`.
- [ ] **Step 3: Implement** exactly the interfaces above.
- [ ] **Step 4: Run** `pnpm --filter @breeze/shared test` → PASS; `pnpm --filter @breeze/shared build` (the API consumes the built types).
- [ ] **Step 5: Commit** — `feat(shared): catalog price-book, cost-currency, and reprice validators (#3775)`.

### Task 4: Pure pricing helpers — currency-aware resolver + bundle economics

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/catalogPricing.ts` (`ResolvedPrice` `:26-32`, `resolvePriceFrom` `:34-45`, `computeBundleEconomicsFrom` `:74-105`; `deriveUnitPrice` `:12-24` and `detectBundleProblems` unchanged)
- Test: `apps/api/src/services/catalogPricing.test.ts` (rewrite the `resolvePriceFrom` and `computeBundleEconomicsFrom` describes; keep `deriveUnitPrice`/`detectBundleProblems` cases)

**Interfaces (exact — replace the existing definitions):**

```ts
export interface ResolvedPrice {
  unitPrice: string;                 // fixed-2-decimal, in currencyCode
  currencyCode: string;              // the TARGET currency the caller asked for
  costBasis: string | null;          // the item's cost — may be in another currency
  costCurrency: string;
  /** true only when costCurrency === currencyCode; callers must not compute margin otherwise */
  marginAvailable: boolean;
  taxable: boolean;
  taxCategory: string | null;
  source: 'org_override' | 'price_book';
}

/**
 * Pure resolution (spec §6): an org override IN THE TARGET CURRENCY wins; else
 * the price-book row for the target currency; else null — the typed gap the
 * caller turns into NO_PRICE_FOR_CURRENCY. Never converts, never falls
 * through to another currency's number.
 */
export function resolvePriceFrom(
  item: { costBasis: string | null; costCurrency: string; taxable: boolean; taxCategory: string | null },
  override: { unitPrice: string; currencyCode: string } | null,
  bookRow: { unitPrice: string } | null,
  targetCurrency: string
): ResolvedPrice | null {
  const common = {
    currencyCode: targetCurrency,
    costBasis: item.costBasis,
    costCurrency: item.costCurrency,
    marginAvailable: item.costCurrency === targetCurrency,
    taxable: item.taxable,
    taxCategory: item.taxCategory,
  };
  if (override && override.currencyCode === targetCurrency) {
    return { ...common, unitPrice: override.unitPrice, source: 'org_override' };
  }
  if (bookRow) return { ...common, unitPrice: bookRow.unitPrice, source: 'price_book' };
  return null;
}

export interface BundleEconomics {
  currencyCode: string;
  /** null when the bundle itself has no price in currencyCode */
  headlinePrice: string | null;
  /** every component has a price-book row in currencyCode AND headlinePrice !== null */
  priceBookComplete: boolean;
  /** every component's costCurrency === currencyCode (null cost still counts as 0, as before) */
  marginAvailable: boolean;
  /** null unless priceBookComplete && marginAvailable — never a partial sum */
  totalCost: string | null;
  margin: string | null;
  marginPct: number | null;
  allocationTotal: string;
  allocationMatchesHeadline: boolean;
  /** component item ids lacking a price in currencyCode (empty when complete) */
  missingPriceComponentIds: string[];
}

export function computeBundleEconomicsFrom(args: {
  currencyCode: string;
  headlinePrice: string | null;
  components: Array<{
    componentItemId: string;
    quantity: string;
    costBasis: string | null;
    costCurrency: string;
    revenueAllocation: string | null;
    hasPriceInCurrency: boolean;
  }>;
}): BundleEconomics
```

Behavior of `computeBundleEconomicsFrom`: `missingPriceComponentIds` = ids with `hasPriceInCurrency === false`; `priceBookComplete = headlinePrice !== null && missing.length === 0`; `marginAvailable = components.every(c => c.costCurrency === currencyCode)`; `allocationTotal`/`allocationMatchesHeadline` computed exactly as today (when `headlinePrice` is null, `allocationMatchesHeadline` is `!anyAllocation`); `totalCost`, `margin`, `marginPct` computed as today **only** when `priceBookComplete && marginAvailable`, else all three `null`. Keep `toCents`/`fromCents` as the 2-decimal accumulators (all catalog money columns are `numeric(12,2)`).

- [ ] **Step 1: Write failing tests** — `resolvePriceFrom`: (a) EUR override + EUR target → override, `source 'org_override'`, `currencyCode 'EUR'`; (b) USD override + EUR target + EUR book row → book row (`'price_book'`) — mismatched override is SKIPPED; (c) no override, no book row → `null`; (d) `costCurrency 'CAD'`, target `'USD'` → `marginAvailable false`; (e) `costCurrency 'USD'`, target `'USD'` → `true`. `computeBundleEconomicsFrom`: (f) complete + same-currency costs → totals as before (reuse the existing numeric fixtures); (g) one component `hasPriceInCurrency: false` → `priceBookComplete false`, `missingPriceComponentIds` lists it, `totalCost/margin/marginPct` all `null`; (h) complete but one component `costCurrency 'CAD'` with target `'USD'` → `marginAvailable false`, cost fields `null`, `allocationTotal` still computed; (i) `headlinePrice null` → `priceBookComplete false`; (j) allocation mismatch still reported when complete.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test catalogPricing.test`.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** → PASS. (`catalogService.ts` will fail typecheck until Task 5 — expected; do not touch it here.)
- [ ] **Step 5: Commit** — `feat(api): currency-aware pure price resolver and bundle economics (#3775)`.

### Task 5: `catalogService` — price-book CRUD, currency-aware create/update/override, DB resolver, bundle economics

**Executor:** claude (cross-module; transaction shape)

**Files:**
- Modify: `apps/api/src/services/catalogService.ts` (`:3` imports, `:15-26` error codes, `:87-126` `createCatalogItem`, `:136-221` `updateCatalogItem`, `:245-253` `getCatalogItem`, `:255-277` overrides, `:318-354` `resolvePrice`/`computeBundleEconomics`; new `setItemPrice`/`removeItemPrice`/`listItemPrices`)
- Modify: `apps/api/src/services/catalogEvents.ts:13-15` (add `'catalog.item.price_changed'` to the `type` union)
- Test: `apps/api/src/__tests__/integration/catalogService.integration.test.ts` (extend/rewrite the create, resolvePrice `:321-330`, `:550-566`, and economics `:568-590` cases), `apps/api/src/services/catalogService.test.ts` (new, Drizzle mock-queue unit tests for `createCatalogItem` price-map logic and `resolvePrice` query order)

**Interfaces (exact):**

```ts
export type CatalogServiceErrorCode = /* existing */ | 'NO_PRICE_FOR_CURRENCY' | 'PRICE_BOOK_INCOMPLETE' | 'PRICE_REQUIRED' | 'CURRENCY_MISMATCH' | 'PRICE_NOT_REPRESENTABLE';

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createCatalogItem(input: CreateCatalogItemInput, actor: CatalogActor)
// → one db.transaction: (1) read partners.currencyCode (PARTNER_UNRESOLVABLE if no row);
//   (2) costCurrency = input.costCurrency ?? partnerCurrency;
//   (3) priceMap = buildPriceMap(input, partnerCurrency, costCurrency) — see below;
//   (4) insert catalog_items with costCurrency and unitPrice = priceMap.get(partnerCurrency) ?? '0.00'
//       (.onConflictDoNothing() stays the FIRST statement so a duplicate SKU does not poison the tx);
//   (5) insert one catalog_item_prices row per map entry; (6) emit created event.

export async function setItemPrice(itemId: string, currencyCode: string, input: SetItemPriceInput, actor: CatalogActor)
// → ONE db.transaction: lockOwnedItemOr404(tx) (SELECT ... FOR UPDATE on catalog_items — item lock FIRST);
//   assertPriceInRange + assertRepresentable(unitPrice, currencyCode); upsert on (item_id, currency_code)
//   (target [catalogItemPrices.itemId, catalogItemPrices.currencyCode], set { unitPrice, updatedAt });
//   if currencyCode === partner currency also mirror catalog_items.unit_price (LAST);
//   emit 'catalog.item.price_changed' after commit; returns the price row.
export async function removeItemPrice(itemId: string, currencyCode: string, actor: CatalogActor): Promise<{ ok: true }>
// → ONE db.transaction: lock item FOR UPDATE; delete the row; if currencyCode === partner currency set catalog_items.unit_price = '0.00' (mirror has no source).
export async function listItemPrices(itemId: string, actor: CatalogActor)
// → getOwnedItemOr404; select rows ordered by currencyCode.

export async function getCatalogItem(id: string, actor: CatalogActor)
// → { item, prices, overrides, components } (prices = listItemPrices rows).

export async function setOrgPriceOverride(itemId: string, orgId: string, input: OrgPriceOverrideInput, actor: CatalogActor)
// → ONE db.transaction: lock item FOR UPDATE; read organizations {partnerId, currencyCode} (ORG_DENIED 403 if missing or org.partnerId !== item.partnerId);
//   currencyCode = input.currencyCode ?? org.currencyCode; assertRepresentable(unitPrice, currencyCode);
//   upsert { catalogItemId, orgId, partnerId: item.partnerId, currencyCode, unitPrice } on (catalogItemId, orgId)
//   with set { unitPrice, currencyCode, updatedAt }.

export async function listCatalogItems(query: ListCatalogQuery, actor: CatalogActor)
// → existing conditions PLUS: if query.currencyCode → conditions.push(sql`EXISTS (SELECT 1 FROM catalog_item_prices p
//   WHERE p.item_id = ${catalogItems.id} AND p.currency_code = ${query.currencyCode})`) (the validator already upper-cased it);
//   the select gains `prices: sql<Array<{ currencyCode: string; unitPrice: string }>>`COALESCE((SELECT json_agg(json_build_object(
//   'currencyCode', p.currency_code, 'unitPrice', p.unit_price::text) ORDER BY p.currency_code) FROM catalog_item_prices p
//   WHERE p.item_id = ${catalogItems.id}), '[]'::json)`` (`::text` — numeric must not become a JSON number) alongside the
//   item columns, so list consumers (web tab/pickers, Task 15/16) never read the unit_price mirror. Rows keep every existing column.

export async function resolvePrice(
  catalogItemId: string, targetCurrency: string, orgId: string | null, actor: CatalogActor, dbc: DbExecutor = db
): Promise<ResolvedPrice>
// → item via dbc (same owned-item predicate as getOwnedItemOr404, plain SELECT — never FOR UPDATE on the document path); override via dbc
//   WHERE catalogItemId AND orgId (currency compared in resolvePriceFrom); book row via dbc
//   WHERE itemId AND currencyCode = targetCurrency LIMIT 1; null → throw
//   new CatalogServiceError(`No price for "${item.name}" in ${targetCurrency} — add a price-book entry or enter a manual line`, 409, 'NO_PRICE_FOR_CURRENCY').
//   NEVER reads catalogItems.unitPrice.

export async function computeBundleEconomics(
  bundleId: string, targetCurrency: string, orgId: string | null, actor: CatalogActor, dbc: DbExecutor = db
): Promise<BundleEconomics>
// → headline: try resolvePrice(bundleId, targetCurrency, orgId, actor, dbc); on NO_PRICE_FOR_CURRENCY → null;
//   components: select componentItemId, quantity, revenueAllocation, catalogItems.costBasis, catalogItems.costCurrency,
//   leftJoin catalogItemPrices on (itemId = componentItemId AND currencyCode = targetCurrency) selecting priceId,
//   and — when orgId !== null — leftJoin catalogItemOrgPricing on (catalogItemId = componentItemId AND orgId = orgId
//   AND currencyCode = targetCurrency) selecting overrideId (a matching org override is a valid price per spec §6 resolution order);
//   hasPriceInCurrency = priceId !== null || overrideId !== null; pass to computeBundleEconomicsFrom.
```

`buildPriceMap` (module-private, pure, unit-tested):

```ts
function buildPriceMap(
  input: { unitPrice?: number; prices?: Array<{ currencyCode: string; unitPrice: number }>; costBasis?: number | null; markupPercent?: number | null },
  partnerCurrency: string, costCurrency: string
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of input.prices ?? []) map.set(p.currencyCode, p.unitPrice.toFixed(2));
  if (input.unitPrice !== undefined && !map.has(partnerCurrency)) map.set(partnerCurrency, Number(input.unitPrice).toFixed(2));
  // cost × markup derives a price ONLY in the cost's own currency, and only when
  // no explicit price exists for that currency (never "converts" by deriving elsewhere).
  if (!map.has(costCurrency) && input.costBasis != null && input.markupPercent != null) {
    map.set(costCurrency, deriveUnitPrice({ explicitPrice: undefined, costBasis: input.costBasis.toFixed(2), markupPercent: input.markupPercent.toFixed(2) }));
  }
  for (const [code, v] of map) { assertPriceInRange(v); assertRepresentable(v, code); }
  if (map.size === 0) throw new CatalogServiceError('A price is required', 400, 'PRICE_REQUIRED');
  return map;
}

// Spec §4: persisted amounts must be representable in the currency's minor unit.
function assertRepresentable(value: string, currencyCode: string): void {
  if (!isRepresentableInCurrency(value, currencyCode)) {   // from '@breeze/shared'
    throw new CatalogServiceError(`${value} is not representable in ${currencyCode}`, 400, 'PRICE_NOT_REPRESENTABLE');
  }
}
```

The derived entry uses `roundToCurrency(deriveUnitPrice(...), costCurrency)` (from `@breeze/shared`) rather than the raw 2-decimal derivation, so cost × markup in JPY lands on a whole yen. `createCatalogItem` also runs `assertRepresentable(costBasis, costCurrency)` when a cost is given.

`updateCatalogItem` rules: `input.costCurrency` → `patch.costCurrency`. The derived-price block (`:154-172`) becomes: `nextCostCurrency = input.costCurrency ?? existing.costCurrency`; if `input.unitPrice !== undefined` → upsert the **partner-currency** price row + mirror; else if `driverChanged && nextCost != null && nextMarkup != null` → upsert the derived price (`roundToCurrency(..., nextCostCurrency)`) into the row for `nextCostCurrency` (and mirror only if `nextCostCurrency === partnerCurrency`). Fetch the partner currency once (`partners.currencyCode`). Wrap everything in ONE `db.transaction` in the order **lock `catalog_items` row `FOR UPDATE` → update item → upsert price row → mirror** (today's `:204` does the item update first; `setItemPrice` must take the same item lock first, otherwise item-first vs price-first callers deadlock). Add `lockOwnedItemOr404(id, partnerId, tx)` next to `getOwnedItemOr404` (`.for('update')`), used by every writer listed in Global Constraints → Lock ordering. `assertRepresentable` runs on any explicit `unitPrice` (partner currency) and on `costBasis` (against `nextCostCurrency`).

- [ ] **Step 1: Write failing tests.** Unit (`catalogService.test.ts`, Drizzle mock queue per `breeze-testing`): `buildPriceMap` cases — explicit prices only; legacy `unitPrice` lands in partner currency; cost+markup derives into `costCurrency` only when no explicit price in that currency; derivation with `costCurrency 'CAD'` and partner `'USD'` + `unitPrice` → two rows (USD explicit, CAD derived); nothing → `PRICE_REQUIRED`. `resolvePrice` query order: item select → override select → price-book select, and `NO_PRICE_FOR_CURRENCY` when the book select returns `[]`; `buildPriceMap` with `prices: [{ JPY, 100.5 }]` → `PRICE_NOT_REPRESENTABLE`, `costBasis 1000, markupPercent 33.3, costCurrency 'JPY'` → derived row is a whole number; `setItemPrice` issues `SELECT ... FOR UPDATE` on `catalog_items` BEFORE the price upsert (assert the mock queue order). Integration (`catalogService.integration.test.ts`): (a) create with `prices: [EUR 10, USD 12]` under a USD partner → two `catalog_item_prices` rows, `item.unitPrice === '12.00'`, `costCurrency === 'USD'`; (b) `resolvePrice(item, 'EUR', orgA, actor)` → `10.00 price_book`; (c) set an override `{ unitPrice: 9, currencyCode: 'EUR' }` → resolve EUR → `9.00 org_override`; resolve USD → `12.00 price_book` (override skipped); (d) resolve `'GBP'` → `NO_PRICE_FOR_CURRENCY` 409; (e) `setItemPrice(item, 'GBP', { unitPrice: 8 })` then resolve GBP → `8.00`; `removeItemPrice` → gap again; (f) override for an org of ANOTHER partner → `ORG_DENIED` 403 (service check) — and a direct insert proves `23503` (Task 2 already covers the FK); (g) `computeBundleEconomics(bundle, 'USD', null, actor)` with one component lacking a USD price → `priceBookComplete false`, `missingPriceComponentIds` has it, `totalCost null`; add the USD price → complete, totals as before; (h) component `costCurrency 'CAD'` → `marginAvailable false`; (i) component with NO USD book row but a USD org override for `orgA` → `computeBundleEconomics(bundle, 'USD', orgA, …)` complete, `(bundle, 'USD', null, …)` incomplete; (j) `listCatalogItems({ currencyCode: 'EUR' })` returns only items with an EUR row and each row carries `prices` with string `unitPrice` values (`typeof === 'string'`); (k) `setOrgPriceOverride` with `{ unitPrice: 10.5, currencyCode: 'JPY' }` → `PRICE_NOT_REPRESENTABLE`. Update the existing `:321-330` 403 case and `:550-566`/`:568-590` to the new arity.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test catalogService.test` and `pnpm --filter @breeze/api test:integration catalogService`.
- [ ] **Step 3: Implement** every function above. Keep `getOwnedItemOr404` but add an optional `dbc: DbExecutor = db` parameter so the resolver's item read runs on the caller's transaction; add `lockOwnedItemOr404` (same predicate, `.for('update')`) for the writers. `listCatalogItems` gains the `currencyCode` predicate and the `prices` aggregate (the route in Task 6 needs no change for either).
- [ ] **Step 4: Run** unit + integration → PASS. Turbo typecheck for `@breeze/api` will still flag `invoiceService.ts`/`quoteService.ts`/`routes/catalog/*` callers — those move in Tasks 6-8; proceed.
- [ ] **Step 5: Commit** — `feat(api): catalogService price-book CRUD, currency-aware resolver and bundle economics (#3775)`.

### Task 6: Catalog routes — price-book endpoints, economics currency, list filter

**Executor:** codex

**Files:**
- Modify: `apps/api/src/routes/catalog/pricing.ts` (add three routes after the existing two at `:21-35`)
- Modify: `apps/api/src/routes/catalog/bundles.ts:16,30-34` (`econQuery` + call)
- Modify: `apps/api/src/routes/catalog/catalog.ts:41-50` (comment only: the list route passes the whole validated query object — including the new `currencyCode` — to `listCatalogItems`, which Task 5 already taught to filter on it and to return `prices`; no route code change) 
- Test: `apps/api/src/routes/catalog/catalog.test.ts` (the `computeBundleEconomics` assertions at `:528-540` change arity; add price-route cases)

**Context codex needs:** `catalogService` (already implemented) exports `setItemPrice(itemId: string, currencyCode: string, input: { unitPrice: number }, actor)`, `removeItemPrice(itemId, currencyCode, actor)`, `listItemPrices(itemId, actor)`, and `computeBundleEconomics(bundleId: string, targetCurrency: string, orgId: string | null, actor)`. `@breeze/shared` exports `setItemPriceSchema` and `currencyCodeSchema`. `catalogActorFrom` and the `handleServiceError` pattern already exist in `pricing.ts`. Routes are mounted at `/catalog` with `pricing.ts` registered before the generic `/:id` item routes (`routes/catalog/index.ts:12-17`), so `/:id/prices` and `/:id/prices/:currencyCode` need no mount-order change. The economics route must resolve a default currency when `currencyCode` is absent: read `organizations.currencyCode` when `orgId` is given, else `partners.currencyCode` for `auth.partnerId` — do these reads in the route with `db.select` (import `db` from `'../../db'` and `organizations`, `partners` from `'../../db/schema'`).

**Interfaces (exact):**

```ts
// pricing.ts
const priceParam = z.object({ id: z.string().guid(), currencyCode: currencyCodeSchema });

catalogPricingRoutes.get('/:id/prices', scopes, readPerm, zValidator('param', idParam), ...)          // → { data: rows }
catalogPricingRoutes.put('/:id/prices/:currencyCode', scopes, writePerm, zValidator('param', priceParam), zValidator('json', setItemPriceSchema), ...)   // → { data: row }
catalogPricingRoutes.delete('/:id/prices/:currencyCode', scopes, writePerm, zValidator('param', priceParam), ...)  // → { data: { ok: true } }
// readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action); idParam = z.object({ id: z.string().guid() })

// bundles.ts
const econQuery = z.object({ orgId: z.string().guid().optional(), currencyCode: currencyCodeSchema.optional() });
// handler: const q = c.req.valid('query'); const currency = q.currencyCode ?? await defaultCurrencyFor(q.orgId ?? null, auth.partnerId);
// computeBundleEconomics(id, currency, q.orgId ?? null, catalogActorFrom(c))
```

- [ ] **Step 1: Write failing route tests** in `catalog.test.ts` (mock `../../services/catalogService` like the file already does at `:4-13`, adding `setItemPrice`, `removeItemPrice`, `listItemPrices` to the mock): `PUT /catalog/:id/prices/eur` body `{ unitPrice: 10 }` → 200 and `setItemPrice` called with `(ITEM_ID, 'EUR', { unitPrice: 10 }, expect.anything())` (param normalized to uppercase); `PUT .../prices/zzz` → 400; `DELETE` → 200; `GET /:id/prices` → `{ data: [...] }`; economics with `?currencyCode=eur&orgId=ORG_ID` → `computeBundleEconomics(ITEM_ID, 'EUR', ORG_ID, expect.anything())`; economics without `currencyCode` → called with the partner currency the test's mocked `db.select` returns (mock `../../db` the way the file's sibling route tests do, returning `[{ currencyCode: 'USD' }]`). Update `:533` and `:540` to the 4-arg shape.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test routes/catalog/catalog.test`.
- [ ] **Step 3: Implement** the routes.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(api): price-book routes and currency-aware bundle economics endpoint (#3775)`.

### Task 7: Quote catalog lines route through the resolver (B3 kill of the direct `unit_price` read)

**Executor:** claude (lock-order surface)

**Files:**
- Modify: `apps/api/src/services/quoteService.ts:1163-1230` (`addCatalogLine`); import `resolvePrice, CatalogServiceError` from `./catalogService`
- Modify: `apps/api/src/services/quoteTypes.ts:25-60` (`QuoteServiceErrorCode` gains `'NO_PRICE_FOR_CURRENCY'`)
- Modify: `apps/api/src/services/aiToolsQuotes.ts` (description of `add_catalog_line` near `:413-425`: "fails with NO_PRICE_FOR_CURRENCY when the item has no price in the quote's currency — add a manual line instead")
- Test: `apps/api/src/services/quoteService.test.ts:254-292` (re-sequence), `apps/api/src/__tests__/integration/quoteService.integration.test.ts` (extend)

**Interfaces:**
- `addCatalogLine` keeps its signature. Inside the transaction, after `lockDraftQuote` and the partner-scoped item lookup (kept for name/description/sku/vendor/itemType/billing fields), call `resolvePrice(catalogItemId, q.currencyCode, q.orgId, catalogActor, tx)` where `catalogActor = { userId: actor.userId, partnerId: q.partnerId, accessibleOrgIds: actor.accessibleOrgIds }`. Map `CatalogServiceError` with code `NO_PRICE_FOR_CURRENCY` → `QuoteServiceError(err.message, 409, 'NO_PRICE_FOR_CURRENCY')`; rethrow others. Insert `unitPrice: resolved.unitPrice`, `lineTotal: computeLineTotal(qty, resolved.unitPrice, q.currencyCode)`, `taxable: resolved.taxable`, `unitCost: resolved.marginAvailable ? resolved.costBasis : null`.

- [ ] **Step 1: Write failing tests.** Unit: mock `./catalogService` (`resolvePrice: vi.fn()`) in `quoteService.test.ts`; the two `addCatalogLine` cases at `:254-292` assert the inserted `unitPrice` equals the mocked resolver's `'42.00'` (not the item row's `unitPrice`), `unitCost` is `null` when the mock returns `marginAvailable: false`, and `resolvePrice` was called with `('cat1', <quote currency>, <quote org>, expect.objectContaining({ partnerId: <quote partner> }), expect.anything())`. Add a case: resolver throws `CatalogServiceError('x', 409, 'NO_PRICE_FOR_CURRENCY')` → rejects with `QuoteServiceError` code `NO_PRICE_FOR_CURRENCY`. Integration (`quoteService.integration.test.ts`): EUR org quote (`createOrganization({ partnerId, currencyCode: 'EUR' })` from Task 2) + item with only a USD price → `addCatalogLine` rejects `NO_PRICE_FOR_CURRENCY` and the quote still has zero lines; add an EUR price row → line lands with the EUR price and EUR-rounded `lineTotal`; an org override in EUR beats the book.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the cut-over. Delete every read of `item.unitPrice` in `quoteService.ts` (grep: none may remain).
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test quoteService` + `test:integration quoteService quoteDeposit quoteAcceptPax8Order` → PASS.
- [ ] **Step 5: Commit** — `feat(api): quote catalog lines price through resolvePrice; NO_PRICE_FOR_CURRENCY gap (B3) (#3775)`.

### Task 8: Invoice + contract catalog lines route through the resolver; billing-run gap fallback

**Executor:** claude (lock-order surface, cross-service)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:164-178` (`addCatalogLine`), `:180-213` (`addBundleLine`), `:228-294` (`addContractLine`)
- Modify: `apps/api/src/services/invoiceTypes.ts:27-60` (`InvoiceServiceErrorCode` gains `'NO_PRICE_FOR_CURRENCY' | 'PRICE_BOOK_INCOMPLETE'`)
- Modify: `apps/api/src/services/contractService.ts:265-278` (`addContractLineToContract`), `:354-362` (`GenerateResult` gains `priceBookGaps`), `:386-390` + `:444-473` (`generateDueInvoice` comment + fallback contract), `apps/api/src/jobs/contractWorker.ts:65` (log each gap)
- Modify: `apps/api/src/services/contractTypes.ts:16-30` (`ContractServiceErrorCode` gains `'NO_PRICE_FOR_CURRENCY'`)
- Modify: `packages/shared/src/validators/contracts.ts:8-16` (`unitPrice: money.optional()` + refine: required unless `catalogItemId` is set — message 'unitPrice is required unless catalogItemId is set', path `['unitPrice']`; when `catalogItemId` IS set the server ignores any client `unitPrice`/`taxable` — the resolver is authoritative)
- Modify: `apps/api/src/services/aiToolsBilling.ts` (`add_catalog_line`/`add_bundle_line` descriptions near `:211`, `:271-274`) and `aiToolsContracts.ts` (`:214-218`) — mention the gap code
- Test: `apps/api/src/services/invoiceService.test.ts:43,98,649-680` (mock shape + arity), `invoiceService.siteScope.test.ts:37`, `apps/api/src/services/contractService.test.ts`, `apps/api/src/__tests__/integration/contractCurrency.integration.test.ts` (extend), `packages/shared/src/validators/contracts.test.ts` (extend)

**Interfaces:**
- `invoiceService.addCatalogLine`: `resolvePrice(catalogItemId, inv.currencyCode, inv.orgId, catalogActor, tx)`; `costBasis: resolved.marginAvailable ? resolved.costBasis : null`; `CatalogServiceError NO_PRICE_FOR_CURRENCY` → `InvoiceServiceError(msg, 409, 'NO_PRICE_FOR_CURRENCY')`.
- `invoiceService.addBundleLine`: `econ = computeBundleEconomics(bundleId, inv.currencyCode, inv.orgId, catalogActor, tx)`; if `econ.headlinePrice === null` → `InvoiceServiceError(..., 409, 'NO_PRICE_FOR_CURRENCY')`; if `!econ.priceBookComplete` → `InvoiceServiceError(\`Bundle has no ${inv.currencyCode} price for ${econ.missingPriceComponentIds.length} component(s)\`, 409, 'PRICE_BOOK_INCOMPLETE')`; parent `costBasis: econ.totalCost` (null when margin unavailable); child `costBasis: comp.costCurrency === inv.currencyCode ? comp.costBasis : null` (select `catalogItems.costCurrency` in the `:194-200` query).
- `invoiceService.addContractLine` catalog path: `resolvePrice(input.catalogItemId, inv.currencyCode, inv.orgId, catalogActor, tx)`; **on `NO_PRICE_FOR_CURRENCY` fall back to the contract line's stamped snapshot**: `unitPrice = Number(input.unitPrice).toFixed(2)`, `taxable = input.taxable`, `costBasis = null`. The B2 `CURRENCY_MISMATCH` guard at `:247-258` already proves the contract line snapshot is in the invoice's currency, so the fallback never crosses currencies. Other `CatalogServiceError`s still propagate. **The gap is surfaced, not swallowed:** `addContractLine` returns `{ line, pricedFrom: 'org_override' | 'price_book' | 'contract_snapshot' }` (today it returns the line; update the two callers), and `generateDueInvoice` collects every `contract_snapshot` into `GenerateResult.priceBookGaps: Array<{ contractLineId: string; catalogItemId: string; itemName: string; currencyCode: string }>` (always present, `[]` when none). `contractWorker.ts:65` logs `console.warn('[contract-billing] price-book gap: contract %s line %s item %s has no %s price — billed at the contract snapshot', …)` once per gap, and `routes/contracts/generate.ts:27` returns `priceBookGaps` in its response body so the manual "generate now" UI can show it. (Codex review, finding 3: the spec's "typed gap the caller must surface" is satisfied by the typed result + log; whether the run should instead skip the period is an owner call — Self-Review (a).)
- `contractService.addContractLineToContract`: **whenever `input.catalogItemId` is set** → `resolved = resolvePrice(input.catalogItemId, c.currencyCode, c.orgId, { userId: actor.userId, partnerId: c.partnerId, accessibleOrgIds: actor.accessibleOrgIds }, tx)`, insert `unitPrice: resolved.unitPrice`, `taxable: resolved.taxable` — any client-supplied `unitPrice`/`taxable` on a catalog line is ignored (spec §6: contract catalog lines route through the resolver; a tech who wants a different price adds a non-catalog line — codex review, finding 6); `NO_PRICE_FOR_CURRENCY` → `ContractServiceError(msg, 409, 'NO_PRICE_FOR_CURRENCY')`. Non-catalog lines still require and use `input.unitPrice`/`input.taxable` verbatim. This matches `generateDueInvoice`'s existing contract (`contractService.ts:388-390`: the catalog path already ignores the passed price).
- `generateDueInvoice`: no signature change; update the `:386-390` and `:444-446` comments to state the gap-fallback rule.

- [ ] **Step 1: Write failing tests.** Unit (`invoiceService.test.ts`): update the `resolvePrice` mock return at `:98` to the new `ResolvedPrice` shape (`currencyCode: 'USD', costCurrency: 'USD', marginAvailable: true, source: 'price_book'`); `:674` `toHaveBeenCalledWith(catalogItemId, 'USD', orgId, expect.objectContaining({...}), expect.anything())`; new cases: `addCatalogLine` with `marginAvailable: false` inserts `costBasis: null`; resolver gap → `NO_PRICE_FOR_CURRENCY`; `addBundleLine` with `priceBookComplete: false` → `PRICE_BOOK_INCOMPLETE` and no insert; `addContractLine` catalog path with resolver gap → inserts `input.unitPrice` (fallback) and does not throw. `contractService.test.ts`: `addContractLineToContract` with `catalogItemId` uses the mocked resolver's `unitPrice` AND `taxable` even when the input carries a different `unitPrice: 1` / `taxable: false`; `generateDueInvoice` with a mocked `addContractLine` returning `pricedFrom: 'contract_snapshot'` → `priceBookGaps` has one entry with the line/item ids; `contractWorker` test: one `console.warn` per gap. Shared: `contractLineInputSchema` accepts `{ lineType: 'flat', description, taxable: true, catalogItemId }` without `unitPrice` and rejects a flat line with neither. Integration (`contractCurrency.integration.test.ts`): EUR org + contract; catalog item with EUR price → `addContractLineToContract` without `unitPrice` stamps the EUR book price; `generateDueInvoice` bills the live EUR price; remove the EUR price row → the next run bills the contract line's stamped snapshot (no failure, no USD) AND returns `priceBookGaps` naming that line.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the four service edits + validator + tool descriptions.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test invoiceService contractService` + `test:integration contractCurrency contractWorker invoiceService.issue changeCurrency` + `pnpm --filter @breeze/shared test contracts` → PASS.
- [ ] **Step 5: Commit** — `feat(api): invoice and contract catalog lines resolve per-currency prices; billing-run gap falls back to the contract snapshot (#3775)`.

### Task 9: TD SYNNEX EC Express + price-file import writes `cost_currency` (B4)

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/tdSynnexEcExpress.ts:546-585` (`importEcExpressCatalogItem` payload; `product.currency` is `string | null` at `:86`)
- Test: `apps/api/src/services/tdSynnexEcExpress.test.ts` (the import assertions around `:425-428` use `toMatchObject` against the `createCatalogItem` payload — extend)

**Context codex needs:** `CreateCatalogItemInput` (from `@breeze/shared`) now has `costCurrency?: string` (ISO-4217 uppercase; the service defaults it to the partner currency when omitted) and `prices?: Array<{ currencyCode: string; unitPrice: number }>` alongside the legacy `unitPrice?: number` (which the service stores as the PARTNER-currency price). This function serves BOTH the live EC Express lookup and the nightly price-file rows (`product.source` is `'td_synnex_ec_express' | 'td_synnex_price_file'`; price-file rows always carry `currency` `'CAD'` or `'USD'`). `product.currency` is already normalized upstream (`str(d.currency)` at `:371`) but may be lowercase or null.

**Change (exact):** in the `payload` object, directly after `costBasis:` add

```ts
    // B4 (#3775): the feed's currency is the COST currency — stored as a real
    // column so margin math can refuse to compare CAD cost against USD sell.
    // The jsonb copy below stays for traceability. Null feed currency → omit
    // (createCatalogItem defaults to the partner currency).
    costCurrency: product.currency ? product.currency.trim().toUpperCase() : undefined,
```

Leave `unitPrice: item.unitPrice` (partner-currency sell price entered by the tech) and the `attributes.distributor.currency` jsonb copy unchanged.

- [ ] **Step 1: Write failing tests** — import with `product.currency: 'cad'` → `createCatalogItem` called with `expect.objectContaining({ costCurrency: 'CAD' })`; `product.currency: null` → payload has no `costCurrency` key (`expect.not.objectContaining({ costCurrency: expect.anything() })`); a `source: 'td_synnex_price_file'` product with `currency: 'USD'` → `'USD'`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test tdSynnexEcExpress.test`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(api): TD SYNNEX EC Express / price-file import records cost_currency from the feed (B4) (#3775)`.

### Task 10: TD SYNNEX Digital Bridge import writes `cost_currency`; drop the silent-USD default

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/tdSynnexDigitalBridge.ts:444` (normalizer) and `:567-596` (`importTdSynnexCatalogItem` payload)
- Test: `apps/api/src/services/tdSynnexDigitalBridge.test.ts` (normalizer + import assertions around `:436-498` use `toMatchObject` — extend)

**Context codex needs:** `CreateCatalogItemInput` (from `@breeze/shared`) now has `costCurrency?: string` (ISO-4217 uppercase; the service defaults to the partner currency when omitted). The normalized product's `currency` field type is `string | null` (route schema `apps/api/src/routes/catalog/distributors.ts:126` is `z.string().max(10).nullable()` — Task 12 tightens it; do not edit that file here).

**Changes (exact):**
1. `:444`: `currency: pickString(product, ['currency', 'currencyCode']) ?? 'USD',` → `currency: pickString(product, ['currency', 'currencyCode']),` — a feed that omits currency must not mint USD (B4); the import then defaults to the partner currency.
2. In `catalogInput` directly after `markupPercent:` add
   ```ts
       // B4 (#3775): feed currency is the cost currency (real column, not jsonb-only).
       costCurrency: input.product.currency ? input.product.currency.trim().toUpperCase() : undefined,
   ```
   Keep the jsonb `attributes.distributor.currency` copy.

- [ ] **Step 1: Write failing tests** — normalizer: product without a currency key → `currency: null` (not `'USD'`); product `{ currencyCode: 'cad' }` → `'cad'` passes through (normalization to uppercase happens at import). Import: `product.currency: 'cad'` → `createCatalogItem` called with `expect.objectContaining({ costCurrency: 'CAD' })`; `product.currency: null` → no `costCurrency` key.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test tdSynnexDigitalBridge.test`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(api): TD SYNNEX Digital Bridge import records cost_currency; no silent USD default (B4) (#3775)`.

### Task 11: Pax8 import writes `cost_currency`

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/pax8CatalogService.ts:153-181` (`importPax8CatalogItem` payload; `product.currency: string | null` at `:94`)
- Test: `apps/api/src/services/pax8CatalogService.test.ts` (import assertions around `:74-88` use `toMatchObject` — extend)

**Context codex needs:** `CreateCatalogItemInput` (from `@breeze/shared`) now has `costCurrency?: string` (ISO-4217 uppercase; the service defaults to the partner currency when omitted). `costBasis` at `:161` comes from `item.costBasis ?? product.partnerBuyRate`; the buy rate is denominated in `product.currency`.

**Change (exact):** directly after `costBasis:` in `payload` add

```ts
    // B4 (#3775): partnerBuyRate is denominated in the feed currency — store it
    // as the cost currency (real column) so margin math can refuse cross-currency
    // comparisons. Null → omit (service defaults to the partner currency).
    costCurrency: product.currency ? product.currency.trim().toUpperCase() : undefined,
```

Keep `attributes.pax8.currency`.

- [ ] **Step 1: Write failing tests** — `product.currency: 'eur'` → `createCatalogItem` called with `expect.objectContaining({ costCurrency: 'EUR' })`; `null` → no `costCurrency` key; the existing duplicate-SKU reuse path is unaffected (existing test stays green).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test pax8CatalogService.test`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(api): Pax8 import records cost_currency from the feed (B4) (#3775)`.

### Task 12: Distributor route schemas — ISO currency on every feed payload

**Executor:** codex

**Files:**
- Modify: `apps/api/src/routes/catalog/distributors.ts:126` (Digital Bridge `productSchema.currency`), `:272` (`ecProductSchema.currency`), `:416` (`pax8ProductSchema.currency`)
- Test: `apps/api/src/routes/catalog/distributors.test.ts` (extend)

**Context codex needs:** `@breeze/shared` exports `currencyCodeSchema` (Zod: `z.string().transform(trim+uppercase).refine(isKnownCurrency)`), already imported elsewhere in the API as `import { currencyCodeSchema } from '@breeze/shared';`. The three `currency` fields are currently `z.string().max(10).nullable()` — free text that lets a feed smuggle `'usd '` or `'CA$'` into `cost_currency` (the import services uppercase/trim but cannot reject off-list codes before the DB FK turns it into a 500).

**Change (exact):** each of the three lines becomes `currency: currencyCodeSchema.nullable(),`. Add `currencyCodeSchema` to the file's `@breeze/shared` import (or add the import if the file has none).

- [ ] **Step 1: Write failing tests** — for each of the three import endpoints (Digital Bridge `POST /catalog/distributors/td-synnex/import`, EC Express import, Pax8 import — use the file's existing request-building helpers and mocked services): `product.currency: 'cad'` → 200 and the service mock receives `currency: 'CAD'`; `product.currency: 'CA$'` → 400; `product.currency: null` → 200.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test routes/catalog/distributors.test`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(api): distributor import payloads validate currency against the supported list (B9) (#3775)`.

### Task 13: AI / MCP catalog tools expose the price book

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/aiToolsCatalog.ts:76-78` (payload schemas), `:89-108` (`AI_ITEM_FIELDS`), `:215-281` (`search_catalog`), `:339-400` (`get_catalog_item`), `:402-491` (`manage_catalog`)
- Test: `apps/api/src/services/aiToolsCatalog.test.ts:26,224-306` and `apps/api/src/services/aiToolsCatalog.manageCatalog.test.ts` (extend)

**Context codex needs:** Schema `catalogItemPrices` (`apps/api/src/db/schema/catalog.ts`) has columns `id, itemId, partnerId, currencyCode, unitPrice, createdAt, updatedAt`. `catalogItems` gained `costCurrency` (string). `catalogItemOrgPricing` gained `currencyCode`, `partnerId`. `catalogService` exports `setItemPrice(itemId, currencyCode, { unitPrice }, actor)`, `removeItemPrice(itemId, currencyCode, actor)`, `listItemPrices(itemId, actor)`. `@breeze/shared` exports `setItemPriceSchema` (`{ unitPrice }`) and `currencyCodeSchema`. `catalogItems.unitPrice` is a deprecated mirror — AI output must stop presenting it as "the price". `MANAGE_CATALOG_REQUIRED` (earlier in the file) maps action → required params; `missingParamsJson` builds the error.

**Changes (exact):**
1. `AI_ITEM_FIELDS`: add `'costCurrency'` after `'costBasis'`; remove `'unitPrice'` (the mirror). `AI_ITEM_ORG_REDACTED_FIELDS` stays `['costBasis', 'markupPercent']` (cost currency alone is not secret).
2. `search_catalog`: replace `unitPrice: catalogItems.unitPrice` in the select with a JSON aggregate of the price book: `prices: sql<Array<{ currencyCode: string; unitPrice: string }>>\`COALESCE((SELECT json_agg(json_build_object('currencyCode', p.currency_code, 'unitPrice', p.unit_price::text) ORDER BY p.currency_code) FROM catalog_item_prices p WHERE p.item_id = ${catalogItems.id}), '[]'::json)\`` (`::text` is required — a bare `numeric` becomes a JSON number and breaks the declared `unitPrice: string` contract). Add an optional input `currencyCode` (string, "only return items that have a price in this currency") that, when present, adds `sql\`EXISTS (SELECT 1 FROM catalog_item_prices p WHERE p.item_id = ${catalogItems.id} AND p.currency_code = ${code})\`` to `conditions` (uppercase/trim the input first). Description: "Each item lists `prices` per currency (no conversion); an item with no price in a document's currency needs a manual line."
3. `get_catalog_item`: after `sanitized`, fetch `prices` via `db.select({ currencyCode: catalogItemPrices.currencyCode, unitPrice: catalogItemPrices.unitPrice }).from(catalogItemPrices).where(and(eq(catalogItemPrices.itemId, item.id), eq(catalogItemPrices.partnerId, partnerId))).orderBy(asc(catalogItemPrices.currencyCode))` and include `prices` in both return shapes.
4. `manage_catalog`: add actions `'set_price'` (required: `catalogId`, `currencyCode`, `price`) and `'remove_price'` (required: `catalogId`, `currencyCode`); input_schema gains `currencyCode: { type: 'string', description: 'ISO-4217 currency code for set_price / remove_price' }` and `price: { type: 'object', description: 'Price-book fields for set_price: { unitPrice }' }`; `const pricePayload = z.object({ price: setItemPriceSchema });` and `const currencyParam = currencyCodeSchema;`; switch cases call `setItemPrice(String(input.catalogId), currencyParam.parse(input.currencyCode), pricePayload.parse({ price: input.price }).price, actor)` and `removeItemPrice(...)`. `overridePayload` automatically accepts `currencyCode` via the updated shared schema. Update the tool description: "…, per-currency price-book entries (set_price / remove_price), organization price overrides (with currency), and bundle components."

- [ ] **Step 1: Write failing tests** — `search_catalog` select map includes `prices` and no longer includes `unitPrice` (`:26` column-map assertion); `currencyCode: 'eur'` input adds the EXISTS condition (assert the bound param `'EUR'` appears in the generated SQL — follow the file's existing where-clause inspection pattern); `get_catalog_item` output contains `prices: [...]` with string `unitPrice` values; `search_catalog` aggregate SQL contains `p.unit_price::text`; `manage_catalog set_price` with `{ catalogId, currencyCode: 'eur', price: { unitPrice: 10 } }` calls `setItemPrice(id, 'EUR', { unitPrice: 10 }, actor)`; `set_price` without `currencyCode` → VALIDATION_ERROR JSON; `remove_price` calls `removeItemPrice`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test aiToolsCatalog`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(api): AI catalog tools expose per-currency price books (#3775)`.

### Task 14: Change-currency `reprice` for catalog-sourced lines (quotes, invoices, contracts)

**Executor:** claude (lock-order surface, three services)

**Files:**
- Modify: `apps/api/src/services/quoteService.ts:916-947` (`changeQuoteCurrency`), `apps/api/src/services/invoiceService.ts:365-406` (`changeInvoiceCurrency`), `apps/api/src/services/contractService.ts:234-263` (`changeContractCurrency`)
- Routes already validate with `changeCurrencySchema` (Task 3 added `reprice`) — no route change.
- Test: co-located unit tests + `apps/api/src/__tests__/integration/changeCurrency.integration.test.ts` (extend)

**Interfaces:**
- All three: `input: { currencyCode: string; clearLines?: boolean; reprice?: boolean }`. Inside the existing transaction, after the document lock and the no-op check:
  - `reprice: true`: load lines; partition into repriceable (`quote_lines.sourceType === 'catalog' && catalogItemId !== null`; `invoice_lines.sourceType === 'catalog' && catalogItemId !== null` — bundle parents/children and contract/time/part lines are NOT repriceable; `contract_lines.catalogItemId !== null`) and the rest. If the rest is non-empty → `CURRENCY_LOCKED` 409 with message `"<n> non-catalog line(s) cannot be repriced — pass clearLines instead"`. For each repriceable line (ordered by id): `resolved = resolvePrice(line.catalogItemId, input.currencyCode, doc.orgId, catalogActor, tx)`; update `unitPrice = resolved.unitPrice`, `lineTotal = computeLineTotal(quantity, resolved.unitPrice, input.currencyCode)` (quotes/invoices), `unitCost`/`costBasis = resolved.marginAvailable ? resolved.costBasis : null`. Any `NO_PRICE_FOR_CURRENCY` aborts the whole transaction (re-thrown as the document's error class, 409, `NO_PRICE_FOR_CURRENCY`, message listing the offending catalog item name) — atomic, no partial reprice.
  - Then the existing restamp + totals recompute runs (`recomputeAndPersist` for quotes; for invoices replace the `computeInvoiceTotals([], …)` shortcut with `recomputeInvoiceTotals(invoiceId, undefined, tx)` after the header restamp so repriced lines are summed in the new currency; contracts have no header totals).
  - `clearLines` behaviour is unchanged; the validator makes the two flags mutually exclusive.

- [ ] **Step 1: Write failing tests.** Unit per service: draft with one catalog line, `reprice: true`, mocked resolver returns `'20.00'` → line update + header restamp issued, `CURRENCY_LOCKED` not thrown; draft with a manual line + `reprice` → `CURRENCY_LOCKED`; resolver gap → `NO_PRICE_FOR_CURRENCY` and no header update. Integration (`changeCurrency.integration.test.ts`): USD quote with two catalog lines whose items have USD+EUR prices → `reprice` to EUR → both lines carry the EUR book prices, totals recomputed in EUR, header EUR; remove one item's EUR price → `reprice` fails 409 and the quote is byte-identical to before (lines, totals, header). Same two cases for an invoice draft and a draft contract.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** in all three services.
- [ ] **Step 4: Run** unit + `test:integration changeCurrency` → PASS.
- [ ] **Step 5: Commit** — `feat(api): change-currency reprice for catalog-sourced lines via the price book (#3775)`.

### Task 15: Web — catalog API client, item editor price-book + cost currency, items tab

**Executor:** claude (UI)

**Files:**
- Modify: `apps/web/src/lib/api/catalog.ts` (`:9-11` comment, `CatalogItem` `:21-39`, `OrgPriceOverride` `:81-86`, `CatalogItemDetail` `:89-93`, `BundleEconomics` `:96-103`, `getBundleEconomics` `:222-225`, `setOrgPriceOverride` `:230-236`, `computeMargin` `:261-270`; new `ItemPrice`, `listItemPrices`, `setItemPrice`, `removeItemPrice`)
- Modify: `apps/web/src/components/settings/CatalogItemEditorDrawer.tsx` (`:81-82` state, `:133-134` load, `:231-287` override handlers, `:349-351` margin preview, `:386-387` save payload, `:572-606` price/cost inputs + margin row, `:782` override row)
- Modify: `apps/web/src/components/settings/CatalogItemsTab.tsx` (`:9` import, `:203-206`, `:375-377`, `:383`, `:429-432`, `:472-475`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` (`catalogItemEditorDrawer`, `catalogItemsTab` namespaces)
- Test: `apps/web/src/lib/api/catalog.test.ts`, `apps/web/src/components/settings/CatalogItemEditorDrawer.test.tsx`, `CatalogItemsTab.test.tsx`, `apps/web/src/lib/i18n/localeParity.test.ts`, `keyUsage.test.ts`

**Interfaces:**

```ts
// lib/api/catalog.ts
export interface ItemPrice { id: string; itemId: string; currencyCode: string; unitPrice: string; }
export interface CatalogItem { /* existing */ costCurrency: string; prices: ItemPrice[]; /* list + detail both carry the price book (Task 5 aggregate) */ /** @deprecated server mirror — web code must not read it (Task 19 grep); removed with the cleanup migration */ unitPrice: string; }
export interface OrgPriceOverride { id: string; catalogItemId: string; orgId: string; currencyCode: string; unitPrice: string; }
export interface CatalogItemDetail { item: CatalogItem; prices: ItemPrice[]; overrides: OrgPriceOverride[]; components: BundleComponentRow[]; }
export interface BundleEconomics { currencyCode: string; headlinePrice: string | null; priceBookComplete: boolean; marginAvailable: boolean; totalCost: string | null; margin: string | null; marginPct: number | null; allocationTotal: string; allocationMatchesHeadline: boolean; missingPriceComponentIds: string[]; }
export function listItemPrices(id: string): Promise<Response>                                    // GET /catalog/:id/prices
export function setItemPrice(id: string, currencyCode: string, unitPrice: number): Promise<Response>  // PUT /catalog/:id/prices/:currencyCode  body { unitPrice }
export function removeItemPrice(id: string, currencyCode: string): Promise<Response>              // DELETE
export function getBundleEconomics(id: string, opts: { orgId?: string; currencyCode?: string } = {}): Promise<Response>
export function setOrgPriceOverride(id: string, orgId: string, unitPrice: number, currencyCode?: string): Promise<Response>
/** null when cost is absent, price <= 0, OR the currencies differ (margin unavailable) */
export function computeMargin(unitPrice, costBasis, priceCurrency: string, costCurrency: string): number | null
```

Editor drawer: replace the single `unitPrice` input with a price-book list — one row per currency `{ currencyCode, unitPrice }` seeded from `detail.prices` on edit (and a single partner-currency row on create). **Partner currency source:** `GET /orgs/partners/me` → `currencyCode` (`apps/api/src/routes/orgs.ts:351`; web precedent `PartnerBillingSettings.tsx:74-78`) — fetched once when the drawer opens into `partnerCurrency: string | null`; while `null` the price-book section renders a loading state and the Save/Create button is disabled. **Never default to `'USD'`** — the org store's `Partner`/`Organization` types carry no currency (`orgStore.ts:8-22`) and a USD fallback would mint USD price rows for non-USD partners (codex review, finding 4). Rows use the existing select from `currencyOptions` in `apps/web/src/lib/currencies.ts`, an "Add currency" select (`currencyOptions(current)`) and per-row remove; a `costCurrency` select beside `costBasis` (default partner currency); margin preview = `computeMargin(priceInPartnerCurrency, costBasis, partnerCurrency, costCurrency)` and shows `t('catalogItemEditorDrawer.marginUnavailableCostIn', { currency })` when currencies differ. Create sends `{ ..., prices: rows, costCurrency }` (no `unitPrice`); edit saves non-price fields via PATCH (`costCurrency` included) and diffs price rows via `setItemPrice`/`removeItemPrice`. Override form gains a currency select defaulting to the chosen org's currency (`organizations[].currencyCode` — already on the org list shape; if absent from the list payload, default to partner currency); override rows show `currencyCode unitPrice`.

Items tab: the list payload now carries `prices` (Task 5 aggregate), so the tab **stops reading `unitPrice`** (sort at `:203`, margin at `:205-206`, cells at `:375-377`/`:429-432`): `const partnerPrice = (it) => it.prices.find(p => p.currencyCode === partnerCurrency)?.unitPrice ?? null` (partner currency from `GET /orgs/partners/me`, same fetch as the drawer — lift it into a tiny `usePartnerCurrency()` hook in `apps/web/src/lib/usePartnerCurrency.ts` shared by both); price column shows `formatMoney(partnerPrice(it), partnerCurrency)` from `apps/web/src/components/billing/shared/format.ts:14` (replace the USD-only `lib/timeFormat.formatMoney` import) or `—` when the item has no partner-currency row, plus a small "+N" badge when `prices.length > 1` (`t('catalogItemsTab.nMoreCurrencies', { count: prices.length - 1 })`); the price sort compares `partnerPrice` (nulls last); margin column uses the 4-arg `computeMargin(partnerPrice(it), it.costBasis, partnerCurrency, it.costCurrency)` and renders `—` with title `marginUnavailableCostIn` when null; bundle economics calls `getBundleEconomics(id, { currencyCode: partnerCurrency })` and renders `t('catalogItemsTab.incompletePriceBook')` when `!priceBookComplete`, `t('catalogItemsTab.marginUnavailable')` when `!marginAvailable`.

Locale keys (add to `en` and mirror the English string into the other 7 locales — translation polish is a follow-up; `localeParity` only needs the key): `catalogItemEditorDrawer.priceBook`, `.addCurrencyPrice`, `.removePrice`, `.costCurrency`, `.marginUnavailableCostIn` ("Cost in {{currency}} — margin unavailable"), `.overrideCurrency`, `.noPricesYet`; `catalogItemsTab.nMoreCurrencies` ("+{{count}} currencies"), `.incompletePriceBook` ("Incomplete price book"), `.marginUnavailable` ("Margin unavailable").

- [ ] **Step 1: Write failing tests** — `catalog.test.ts`: `computeMargin('100', '50', 'USD', 'USD')` → 50; `computeMargin('100', '50', 'USD', 'CAD')` → null; `setItemPrice` hits `PUT /catalog/ID/prices/EUR` with `{ unitPrice: 10 }`; `getBundleEconomics('ID', { currencyCode: 'EUR' })` → `?currencyCode=EUR`. Drawer: renders one price row per `detail.prices`; "Add currency" adds an EUR row; create posts `prices` + `costCurrency`; the create row's currency is the mocked `/orgs/partners/me` currency (`'EUR'` in the test — assert no `'USD'` row is created) and Create is disabled until that fetch resolves; margin row shows the unavailable copy when `costCurrency` differs. Tab: price cell comes from `prices` (an item with `unitPrice: '999.00'` but `prices: [{ EUR 10 }]` under an EUR partner shows `10`), "+1" badge with two currencies, margin `—` when currencies differ; economics shows "Incomplete price book".
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web test catalog CatalogItemEditorDrawer CatalogItemsTab`.
- [ ] **Step 3: Implement** + add the locale keys to all 8 files.
- [ ] **Step 4: Run** the three suites + `localeParity` + `keyUsage` + `translationCoverage` → PASS.
- [ ] **Step 5: Commit** — `feat(web): catalog price-book editor, cost currency, margin guard (#3775)`.

### Task 16: Web — currency-aware catalog picker in quote, invoice, contract, ticket editors

**Executor:** claude (UI)

**Files:**
- Modify: `apps/web/src/components/catalog/CatalogItemPicker.tsx` (`:2` import, `Props` `:9-19`, `:115` price cell)
- Modify: `apps/web/src/components/billing/quotes/QuoteBlockCard.tsx:682-688` (pass `currencyCode`), `apps/web/src/components/billing/quotes/QuoteEditor.tsx:1392-1402` (`doAddCatalog` gap toast)
- Modify: `apps/web/src/components/billing/InvoiceEditor.tsx:749` (pass `currencyCode`), `:350-360` (gap toast)
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx:308`, `:524-535`, `:995-1003` (no client-side price; server resolves)
- Modify: `apps/web/src/components/tickets/TicketPartsCard.tsx:21,59-65` (new `currencyCode?: string` prop; prefill from that currency's price when present, else blank — wave-4 boundary), `apps/web/src/components/tickets/TicketWorkbench.tsx:1051` (pass `currencyCode` — the workbench has `ticket.orgId` at `:329`; look the org up in the org store), `apps/web/src/stores/orgStore.ts:15-22` (`Organization` gains `currencyCode: string` — `GET /orgs` returns the full row, `routes/orgs.ts:310`, which already includes `currency_code`)
- Modify: `apps/web/src/locales/*/common.json` (`CatalogItemPicker`), `*/billing.json` (quote/invoice editor error keys), `*/tickets.json` if the parts card needs a key
- Test: `CatalogItemPicker.test.tsx` (create if absent), `QuoteEditor.test.tsx`/`InvoiceEditor.test.tsx`/`ContractEditor.test.tsx` (extend), `TicketPartsCard.test.tsx` (exists — extend for the `currencyCode` prop), `TicketWorkbench` test if one covers the parts card, i18n suites

**Interfaces:**
- `CatalogItemPicker` `Props` gains `currencyCode: string` (required) and `prices?: Record<string, ItemPrice[]>` is NOT added — instead the picker receives items whose list payload already includes `prices` (Task 5's `listCatalogItems` aggregate; the web `CatalogItem` type gained `prices: ItemPrice[]` in Task 15). The price cell shows `formatMoney(priceFor(item, currencyCode), currencyCode)` or `t('CatalogItemPicker.noPriceInCurrency', { currency })` (muted) when absent; items without a price remain selectable (the server returns the gap; the editor toasts).
- Quote/invoice editors: on `NO_PRICE_FOR_CURRENCY` error code from `runAction` (`ActionError.code`), toast `t('quotes.editor.errors.noPriceForCurrency', { currency })` / `t('invoiceEditor.errors.noPriceForCurrency', { currency })` — "No {{currency}} price for this item. Add one in the catalog or enter a manual line."
- `ContractEditor`: `:308` and `:1001` stop copying `it.unitPrice`. For a catalog pick the price input becomes **read-only** showing the contract-currency price from `it.prices` (or the `noPriceInCurrency` copy, with the add button disabled — the server would refuse with `NO_PRICE_FOR_CURRENCY` anyway); `:530` **omits `unitPrice` and `taxable` whenever `catalogItemId` is set** (the server resolves both — Task 8). A tech who wants a custom price clears the catalog selection and adds a manual (non-catalog) line, where `unitPrice` stays required. `:995-1003` same rule.
- `TicketPartsCard.pickCatalogItem`: `setUnitPrice` from `it.prices` in `props.currencyCode` when the prop is present and a row exists (fall back to `''`), `setCostBasis` only when `it.costCurrency === props.currencyCode`. The card today receives only `ticketId` (`TicketPartsCard.tsx:21`) — `TicketWorkbench.tsx:1051` passes `currencyCode={orgs.find(o => o.id === ticket.orgId)?.currencyCode}` from the org store (type extended above).

- [ ] **Step 1: Write failing tests** — picker shows the EUR price when `currencyCode='EUR'` and the item has `prices: [{EUR}]`, shows the no-price copy otherwise; quote editor toasts the gap message when the POST returns `{ code: 'NO_PRICE_FOR_CURRENCY' }` (409); contract editor omits `unitPrice`/`taxable` from the POST body for a catalog pick and disables Add when the item has no contract-currency price; `TicketPartsCard` with `currencyCode='EUR'` prefills the EUR price and leaves cost blank when `costCurrency` is `'USD'`; `TicketWorkbench` passes the org's currency.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (API list aggregation + web).
- [ ] **Step 4: Run** the touched web suites + i18n suites + `pnpm --filter @breeze/api test catalogService` → PASS.
- [ ] **Step 5: Commit** — `feat(web): currency-aware catalog picker and gap handling in quote/invoice/contract editors (#3775)`.

### Task 17: Web — distributor import panels send `costCurrency`; margin preview guard

**Executor:** claude (UI)

**Files:**
- Modify: `apps/web/src/components/settings/TdSynnexEcExpressPanel.tsx` (import body near `:267`; margin preview `:485-493`), `TdSynnexCatalogPanel.tsx` (import body `:302-312`; preview `:585-593`), `Pax8CatalogDrawer.tsx:49-57`, `CatalogDistributorDrawer.tsx:55-56`, `apps/web/src/components/billing/quotes/DistributorLookup.tsx:230,264,300-305`, `QuoteEditor.tsx:1421-1449` (`importAndAddPax8`), `:1451-1480` (`importAndAddDistributor`)
- Modify: `apps/web/src/components/settings/marginMath.ts` (add `marginGuard(feedCurrency: string | null, partnerCurrency: string): boolean`)
- Modify: locales `settings.json` (`tdSynnexEcExpressPanel`, `tdSynnexCatalogPanel`, `pax8CatalogDrawer`), `billing.json` (`quotes.distributorLookup`) ×8
- Test: `TdSynnexEcExpressPanel.test.tsx`, `TdSynnexCatalogPanel.test.tsx`, `Pax8CatalogDrawer.test.tsx`, `DistributorLookup.test.tsx`, `QuoteEditor.distributor.test.tsx`, `marginMath.test.ts`

**Interfaces:**
- Every import POST body's `product.currency` stays as-is (the API route now validates it as ISO — Task 12) and the `item` object is unchanged; the API services derive `costCurrency` from `product.currency` (Tasks 9-11). Web change is therefore: (1) ensure `product.currency` is sent uppercase/trimmed (`.toUpperCase()` on the value read from the lookup result) and never coerced to `'USD'` when the feed gave null — send `currency: null` **explicitly** (the Task 12 route schema is `currencyCodeSchema.nullable()`, NOT optional: an `undefined` value is dropped by JSON serialization and the request 400s; codex review, finding 15) (audit each `?? 'USD'`/`t('...uSD')` fallback at `TdSynnexEcExpressPanel.tsx:429,433,493`, `TdSynnexCatalogPanel.tsx:524,593`, `DistributorLookup.tsx:264,305` — display fallbacks may stay for labels but must not feed the POST body); (2) margin previews (`formatMarginSummary`) render only when `marginGuard(product.currency, partnerCurrency)` is true; otherwise show `t('<ns>.marginUnavailableCostIn', { currency: product.currency })`.

- [ ] **Step 1: Write failing tests** — each panel: a product with `currency: 'CAD'` under a USD partner hides the margin summary and shows the guard copy; `currency: 'USD'` shows the summary; the POST body `product.currency` is `'CAD'` (not `'USD'`) and is literally `null` (key present) when the feed gave null. `marginMath.test.ts`: `marginGuard('CAD','USD')` false, `marginGuard(null,'USD')` true (unknown feed currency → assume partner currency, matching the API default), `marginGuard('usd','USD')` true.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** + locale keys (`marginUnavailableCostIn` in each namespace, 8 locales).
- [ ] **Step 4: Run** the suites + i18n suites → PASS.
- [ ] **Step 5: Commit** — `feat(web): distributor imports carry feed currency; margin preview guarded by cost currency (#3775)`.

### Task 18: Docs — product catalog + distributor integrations describe price books and the gap

**Executor:** codex

**Files:**
- Modify: `apps/docs/src/content/docs/features/product-catalog.mdx` (pricing sections — the file describes a single "unit price", cost basis/markup, per-org overrides, and bundle economics)
- Modify: `apps/docs/src/content/docs/features/distributor-integrations.mdx` (import sections that mention cost/currency)
- Modify: `apps/docs/src/content/docs/features/mcp-server.mdx` (tool table rows for `search_catalog`, `get_catalog_item`, `manage_catalog`)

**Context codex needs (the behaviour to document, all shipped in this branch):** Catalog items carry a **price book**: one sell price per currency (`Settings → Catalog → item → Price book`, API `PUT /catalog/:id/prices/:currencyCode`). A document (quote/invoice/contract) only accepts a catalog item that has a price in the **document's** currency; otherwise the line is refused with `NO_PRICE_FOR_CURRENCY` and the tech adds a manual line or a price-book entry — Breeze never converts. Per-organization overrides carry a currency and apply only when it matches the document currency. Cost basis has a **cost currency** (defaults to the partner currency; distributor imports from TD SYNNEX and Pax8 set it from the feed); margin and markup-derived prices compute only when cost currency equals the sell currency — otherwise the UI shows "Cost in CAD — margin unavailable". Bundle economics compute per currency and show "Incomplete price book" when a component lacks a price in that currency. The draft change-currency action gained a `reprice` option that re-resolves catalog lines from the price book (manual lines still require `clearLines`). MCP: `search_catalog` returns `prices` per currency and accepts `currencyCode`; `get_catalog_item` includes `prices`; `manage_catalog` gained `set_price`/`remove_price`.

- [ ] **Step 1:** Rewrite the pricing prose in `product-catalog.mdx` (price book, overrides with currency, cost currency + margin guard, bundle "incomplete price book", gap behaviour on documents, reprice); update `distributor-integrations.mdx` import sections (cost currency from the feed, margin guard); update the three MCP table rows.
- [ ] **Step 2:** `pnpm --filter @breeze/docs build` (or the docs package's build script) → no broken links/MDX errors.
- [ ] **Step 3: Commit** — `docs: catalog price books, cost currency, and gap behaviour (#3775)`.

### Task 19: Full-suite verification + PR

**Executor:** claude

- [ ] **Step 1:** `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/shared test`, `pnpm --filter @breeze/web test`, turbo typecheck, `pnpm db:check-drift`, then `pnpm --filter @breeze/api test:integration` and `test:rls-coverage` against `:5436` (see `integration_suite_needs_fsync_off_tmpfs_locally` if it looks hung).
- [ ] **Step 2:** Blind-spot greps — every hit must be accounted for: `git grep -n "catalogItems.unitPrice\|item.unitPrice\|\.unit_price" -- 'apps/api/src' 'ee/'` (only `catalogService` mirror writes and the migration comment may remain); `git grep -n "\.unitPrice" -- 'apps/web/src/components/settings/CatalogItem*' 'apps/web/src/components/catalog' 'apps/web/src/components/tickets/TicketPartsCard.tsx' 'apps/web/src/components/contracts/ContractEditor.tsx'` (no hit may read a catalog item's `unitPrice` mirror — line rows' own `unitPrice` are fine); `git grep -n "insert(catalogItems\|insert(catalogItemOrgPricing\|INSERT INTO catalog_item" -- 'apps/' 'ee/'` (every insert stamps `costCurrency` / `partnerId` + `currencyCode`); `git grep -n "resolvePrice(\|computeBundleEconomics(" -- 'apps/api/src'` (all calls carry the target currency); `git grep -n "?? 'USD'" -- 'apps/web/src/components/settings' 'apps/web/src/components/billing/quotes/DistributorLookup.tsx'` (display-only).
- [ ] **Step 3:** Verify as `breeze_app` (`docker exec -it <test-pg> psql -U breeze_app -d breeze_test`): forge a `catalog_item_prices` insert under a foreign partner context → `new row violates row-level security policy`.
- [ ] **Step 4:** Push, open PR: title `feat: multi-currency wave 3 — catalog price books & costs (#3775)`, body summarizes the price-book model, resolver + gap contract, B4 import fix, tenancy registration (shape 3 + composite FKs + export-policy columns), the billing-run snapshot fallback decision, and the `reprice` option; PR targets `main` (not stacked) so Integration Tests run on the PR; body ends with `Closes #3775`.
- [ ] **Step 5:** One review round (repo policy), then merge on green with `gh pr merge --squash --admin`. File the cleanup follow-up issue: drop `catalog_items.unit_price` (+ Drizzle column, mirror writes in `catalogService`) once no reader remains — reference #3772.

## Self-Review Notes

- Spec §6 schema: Task 1 (`catalog_item_prices`, shape 3, `PARTNER_TENANT_TABLES`, partner-RLS suite, seed, `unit_price` deprecated mirror), Task 2 (`cost_currency`, org-override `currency_code` + same-partner FK, export-policy new-column registration). Partner cascade is dynamic (`tenantCascade.ts:1017-1025`) — no list entry; `catalogItemPricesPartnerRls` + `tenantCascadePartner` assert it functionally.
- Spec §6 resolution: Task 4 (pure), Task 5 (DB; `dbc` param so document services resolve on the locked tx), Tasks 7-8 (quote catalog lines, invoice catalog/bundle/contract lines, contract line add). Never reads `unit_price`; never converts.
- Spec §6 margins/bundles/imports: Task 4/5 (`marginAvailable`, `priceBookComplete`, null totals — never a partial sum), Tasks 9-12 (B4 on EC Express + price-file rows + Digital Bridge + Pax8; route ISO validation), Tasks 15/17 (guard copy). "Third feed" = the nightly price file, whose rows import through `importEcExpressCatalogItem` with `source: 'td_synnex_price_file'` (Task 9) and through the Digital Bridge panel (Task 10) — no separate SFTP→catalog service exists.
- Optional wave-3 deliverable (reprice in change-currency): Task 14, atomic, catalog lines only.
- Deliberate scope calls, flagged for the owner: (a) **billing-run gap fallback** — `generateDueInvoice` bills the contract line's stamped snapshot when the price book has no row in the contract currency (Task 8) and reports the gap in `GenerateResult.priceBookGaps` + a worker warning per gap (never silent — codex finding 3); the alternative (skip the period and leave it unclaimed) was rejected because an unbilled period is worse than billing the agreed price, the B2 guard guarantees the snapshot is in the invoice currency, and the owner's "snapshots rule" favours the contract's stamped price — **owner to confirm before Task 8 is implemented**; (b) `NO_PRICE_FOR_CURRENCY` and `PRICE_BOOK_INCOMPLETE` are **409** (keeps `CatalogServiceError.status` union unchanged; spec fixes no status); (c) `cost_currency` is NOT NULL with **no default** (fail-loud, matching `organizations.currency_code`), which is why Task 2 sweeps eight integration fixtures; (d) `catalog_item_org_pricing` keeps shape-1 org RLS and gains `partner_id` purely for the composite FKs — it is not promoted to dual-axis, and the dynamic partner purge now sweeps it too (asserted in `tenantCascadePartner`); (e) cross-partner override rows found by migration `-b-` are deleted with a counted warning (they cannot satisfy the composite FK and are isolation-breach artifacts); (f) Task 5's `listCatalogItems` carries an aggregated `prices` array (and the `currencyCode` filter) so the items tab and every picker read the price book — not the `unit_price` mirror — without N+1 detail fetches; (g) catalog catalog-line `unitPrice`/`taxable` from clients are ignored on contracts (resolver authoritative), matching the existing billing-run contract; (h) partner currency in the web comes only from `GET /orgs/partners/me` — no `'USD'` fallback anywhere on a write path.
- Codex review (2026-08-22, read-only, `high`) folded in: findings 1, 2, 4-16 applied as written above; finding 3 applied as "surface the gap" (typed result + log) while keeping the snapshot fallback pending the owner call recorded in (a).
- No placeholders: every task names exact files, signatures, and test cases; codex tasks (3, 4, 6, 9-13, 18) are self-contained (Task 6's list-filter dependency now lives in Task 5, so its brief is complete).
