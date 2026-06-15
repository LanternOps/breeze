# Product Catalog — Design Spec

**Status:** Design accepted 2026-06-14.
**Program:** Billing & Invoicing (sub-project 1 of 4). See
`2026-06-14-billing-architecture-overview.md` for cross-cutting conventions.

## 1. Purpose & scope

A partner-owned master price book of sellable items — **hardware, software, and
services** — that downstream billing features (invoice engine, recurring contracts,
Stripe payments) reference for pricing, cost/margin, and tax. Includes **bundles**: a
service item composed of component items, billed at one headline price, with
per-component control over what the customer sees while the full breakdown is retained
for accounting.

This is the foundation; it ships independently and is immediately useful (catalog-backed
ticket parts, a partner price book) before the invoice engine exists.

### In scope
- `catalog_items` (hardware/software/service) with pricing, cost basis, optional markup,
  tax flags, type-specific `attributes` jsonb, soft-archive.
- Per-customer price overrides (`catalog_item_org_pricing`).
- Bundles (`catalog_bundle_components`) with per-component customer visibility and
  internal revenue allocation.
- `ticket_parts.catalog_item_id` nullable FK (parts can be picked from the catalog).
- Service layer, routes, settings UI, light AI read tools, tests, RLS.

### Out of scope (documented; additive later)
- Inventory / stock levels (catalog defines items + pricing, not on-hand quantity).
- Distributor SKU mapping (Pax8/TechData/Sherweb) — future mapping table per the PSA
  pattern.
- Per-item currency (partner-level default only).
- Purchase orders / procurement.
- **Nested bundles** (a bundle containing another bundle) — explicitly cycle-rejected
  for now.
- Online payment, invoice rendering, contract generation — their own specs.

## 2. Data model

All new tables get RLS enabled + forced + policies in the creating migration (idempotent),
added to the `rls-coverage` allowlist in the same PR.

### 2.1 `catalog_items` — RLS shape 3 (partner-axis)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `partner_id` | uuid NOT NULL | FK → partners; RLS axis (`breeze_has_partner_access`) |
| `item_type` | enum NOT NULL | `catalog_item_type` = `hardware \| software \| service` |
| `name` | varchar(255) NOT NULL | |
| `sku` | varchar(100) | `UNIQUE(partner_id, sku)` partial index `WHERE sku IS NOT NULL` |
| `description` | text | |
| `billing_type` | enum NOT NULL | `catalog_billing_type` = `one_time \| recurring`; default `one_time`. Connects service items to recurring contracts |
| `unit_price` | numeric(12,2) NOT NULL | sell price (the customer-facing amount) |
| `cost_basis` | numeric(12,2) | what the MSP pays; nullable; drives margin |
| `markup_percent` | numeric(6,2) | optional; see pricing rules §3 |
| `unit_of_measure` | varchar(50) | e.g. `each`, `hour`, `device`, `seat`; default `each` |
| `taxable` | boolean NOT NULL | default `true` |
| `tax_category` | varchar(100) | optional; maps to external tax code later |
| `is_bundle` | boolean NOT NULL | default `false` |
| `attributes` | jsonb NOT NULL | default `{}`; type-specific extras (manufacturer/model, license term, vendor, …) |
| `is_active` | boolean NOT NULL | default `true`; soft-archive (never hard-delete priced history) |
| `created_by` | uuid | FK → users, nullable |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(partner_id, item_type)`, `(partner_id, is_active)`, partial unique
`(partner_id, sku)`.

### 2.2 `catalog_item_org_pricing` — RLS shape 1 (direct `org_id`)

Per-customer sell-price override. Cost is **not** overridden per org (cost is the MSP's,
not the customer's).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `catalog_item_id` | uuid NOT NULL | FK → catalog_items, ON DELETE CASCADE |
| `org_id` | uuid NOT NULL | FK → organizations; RLS axis (`breeze_has_org_access`) |
| `unit_price` | numeric(12,2) NOT NULL | override sell price for this org |
| `created_at` / `updated_at` | timestamptz | `UNIQUE(catalog_item_id, org_id)` |

> **Two-axis safety note:** `catalog_item_id`'s parent is partner-scoped while this row
> is org-scoped; both live under the same partner. RLS uses the org axis. Because the
> rls-coverage contract test does **not** catch a missing second axis, this table gets a
> functional `breeze_app` cross-tenant forge test asserting an org user cannot read/write
> override rows for another org, and cannot reference a `catalog_item_id` from another
> partner (enforced by an app-layer same-partner check in the service, since the FK alone
> won't prove partner identity).

### 2.3 `catalog_bundle_components` — RLS shape 3 (partner-axis via parent)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `bundle_item_id` | uuid NOT NULL | FK → catalog_items (the parent bundle), ON DELETE CASCADE |
| `component_item_id` | uuid NOT NULL | FK → catalog_items (the component), ON DELETE RESTRICT |
| `quantity` | numeric(12,2) NOT NULL | default `1` |
| `show_on_invoice` | boolean NOT NULL | default `false`; customer visibility (see §4) |
| `revenue_allocation` | numeric(12,2) | optional; portion of bundle price attributed to this component for accounting/recognition. Internal-only |
| `created_at` / `updated_at` | timestamptz | `UNIQUE(bundle_item_id, component_item_id)` |

RLS axis: the partner of `bundle_item_id`. Policy joins to `catalog_items` on
`bundle_item_id` and applies `breeze_has_partner_access(partner_id)`. Per the nested-EXISTS
bound-param lesson, prefer a denormalized `partner_id` column on this table (NOT NULL,
copied from the bundle at insert, app-enforced equal to the component's partner) so the
policy is flat — this also enforces "components must be same partner."

> Decision: add `partner_id` to `catalog_bundle_components` (denormalized, RLS flat).

## 3. Pricing rules

`unit_price` is authoritative — it is always what the item sells for. `markup_percent` is
a convenience:
- If `markup_percent` is set **and** the caller doesn't supply an explicit price, the
  service derives `unit_price = round(cost_basis × (1 + markup_percent/100), 2)`.
- A manually entered `unit_price` always wins and is stored verbatim; `markup_percent`
  is retained for display ("priced at cost + X%") but does not override.
- Margin (reported, not stored): `unit_price − cost_basis` (and `%`).

**Org override precedence** (`resolvePrice`): org override `unit_price` → item
`unit_price`. Cost basis always from the item. Returns `source ∈ {org_override, item}`.

## 4. Bundles

A bundle is a `catalog_items` row with `is_bundle = true` (typically `item_type =
service`) and one headline `unit_price`. Components live in `catalog_bundle_components`.

**Pricing model (decided): headline price + descriptive components.**
- The bundle's `unit_price` is the **only** charge the customer sees.
- A component with `show_on_invoice = true` renders as a `$0 / "included"` descriptive
  sub-line (transparency: "your plan includes …").
- A component with `show_on_invoice = false` is omitted from the customer view entirely.
- All components — visible or hidden — contribute **cost** (each component's
  `cost_basis × quantity`) so bundle COGS/margin is computed automatically.
- `revenue_allocation` is internal-only: it splits the headline price across components
  for accounting/recognition and external sync (QB/Xero). It never appears on the
  customer PDF. It is optional; if absent, allocation is left to the accounting-sync
  spec (e.g. proportional by component `unit_price`).

**`computeBundleEconomics(bundleId, orgId)`** returns: headline price (org-resolved),
total COGS (sum of component costs), margin + %, and an allocation reconciliation
(sum of `revenue_allocation` vs headline price — warn if set-but-mismatched).

**Validation:** a bundle cannot contain itself; a component cannot itself be a bundle
(nested bundles rejected); all components must share the bundle's `partner_id`.

**How the invoice engine will consume a bundle (forward reference, not built here):**
adding a bundle to an invoice expands into a parent `invoice_line` (`source_type =
bundle`, headline price, `customer_visible = true`) plus child lines per component
(`parent_line_id` = parent, `customer_visible = show_on_invoice`, `unit_price = 0` for
display, carrying snapshot `cost_basis` and allocated revenue for accounting). This is
why the shared architecture fixes `customer_visible` + `parent_line_id` on invoice lines
from day one.

## 5. `ticket_parts` change

Add `catalog_item_id uuid` nullable, FK → `catalog_items` ON DELETE SET NULL. When a
part is added from the catalog, the service snapshots `description`, `unit_price`,
`cost_basis` from the resolved item (org-aware) into the existing part columns — the part
row stays self-contained (catalog edits don't mutate existing parts). Free-text parts
(no `catalog_item_id`) are unchanged. Migration is idempotent (`ADD COLUMN IF NOT
EXISTS`).

## 6. Service layer — `catalogService.ts`

All logic here; routes/AI tools/MCP are thin consumers. Mirrors the
`ticketService`/`timeEntryService` structure (typed `CatalogServiceError`, actor object).

- `createCatalogItem(input, actor)` / `updateCatalogItem(id, input, actor)`
- `archiveCatalogItem(id, actor)` / `unarchiveCatalogItem(id, actor)` (soft via `is_active`)
- `listCatalogItems(filters)` — `{ itemType?, isActive?, isBundle?, search?, limit, cursor }`
- `getCatalogItem(id)` — item + components (resolved names) + org-override list
- `setOrgPriceOverride(itemId, orgId, unitPrice, actor)` / `removeOrgPriceOverride(itemId, orgId, actor)`
- `setBundleComponents(bundleId, components[], actor)` — replace-set; validates cycles,
  nested-bundle rejection, same-partner, positive quantities
- `resolvePrice(catalogItemId, orgId)` → `{ unitPrice, costBasis, taxable, taxCategory, source }`
- `computeBundleEconomics(bundleId, orgId)` → `{ headlinePrice, totalCost, margin, marginPct, allocation }`
- Emits `catalog.item.created | catalog.item.updated | catalog.item.archived` via the
  existing lifecycle dispatch point.

## 7. Routes — `routes/catalog/`

Thin Hono handlers (auth + validation + service call). Split per File Size Guideline:
- `catalog.ts` — item CRUD + list (`GET /catalog`, `POST /catalog`, `GET /catalog/:id`,
  `PATCH /catalog/:id`, `POST /catalog/:id/archive`)
- `pricing.ts` — org overrides (`PUT /catalog/:id/pricing/:orgId`, `DELETE …`)
- `bundles.ts` — `PUT /catalog/:id/components`, `GET /catalog/:id/economics`
- `index.ts` — registration, mounted in the API route hub.

**AuthZ:** new `catalog` permission resource with `read` / `write` actions. Granted to
partner-scope system roles (Partner Admin, Partner Technician) via a seed update + a
hardened grant migration (`is_system = true`, `NOT EXISTS` guard — the report-permissions
precedent lesson). Org-scope users get no catalog access in v1 (catalog is partner-internal;
they pick items indirectly through invoices/quotes later). All mutations behind
`requirePermission('catalog', 'write')`.

## 8. UI — Settings → Catalog

New tab in the partner settings hub (alongside existing ticketing-config tabs). React
islands, `data-testid` only, all mutations via `runAction`.
- **Item list:** filter by type + active, search by name/SKU; columns name, type, SKU,
  price, margin, bundle badge, active toggle.
- **Item editor** (drawer): type, name, SKU, description, billing_type, unit_price,
  cost_basis, markup_percent (with live derived-price preview), unit_of_measure,
  taxable, tax_category, type-specific `attributes` fields.
- **Bundle builder** (when `is_bundle`): add/remove component items (search the catalog),
  per-component quantity, `show_on_invoice` toggle, optional `revenue_allocation`; live
  economics panel (COGS, margin, allocation reconciliation).
- **Org pricing** (panel on item editor): list/add/remove per-org overrides.

## 9. AI tools (light)

`aiToolsCatalog.ts` registered in the `aiTools` hub: `search_catalog`, `get_catalog_item`
(tier 2 reads), thin wrappers over `catalogService`. Write tools deferred. The MCP server
exposes these automatically via the registry.

## 10. Testing

Per `breeze-testing` conventions:
- `catalogService` unit tests: price resolution (org-override precedence), markup
  derivation vs manual price, soft-archive, bundle cycle + nested-bundle + cross-partner
  rejection, bundle economics + allocation reconciliation.
- Route tests (Vitest + Drizzle mocks) for each route file, incl. permission gating.
- Validator tests in `packages/shared` (Zod schemas for item, override, components).
- **RLS:** `catalog_items`, `catalog_item_org_pricing`, `catalog_bundle_components` added
  to `rls-coverage` allowlist + run locally against a real DB. **Functional `breeze_app`
  cross-tenant forge test** on `catalog_item_org_pricing` (org axis) and on
  `catalog_bundle_components` (partner axis), asserting cross-tenant insert/select fails
  with `new row violates row-level security policy`.
- Migration idempotency covered by `autoMigrate.test.ts` (ordering) + manual re-apply.

## 11. Migration

Single dated migration `2026-06-14-…-product-catalog.sql` (or `-a-`/`-b-` infixes if
table-then-policy ordering requires it), idempotent throughout:
1. Enums `catalog_item_type`, `catalog_billing_type`.
2. Tables `catalog_items`, `catalog_item_org_pricing`, `catalog_bundle_components`
   (with denormalized `partner_id`), indexes, RLS enable+force+policies.
3. `ALTER TABLE ticket_parts ADD COLUMN IF NOT EXISTS catalog_item_id …`.
4. `catalog` permission rows + grant to partner-scope system roles (guarded).

Run `pnpm db:check-drift` after schema edits.

## 12. References
- Program frame: `2026-06-14-billing-architecture-overview.md`
- Ticketing extensibility guarantees: `2026-06-09-native-ticketing-design.md` §8a
- RLS patterns: `CLAUDE.md` (six tenancy shapes), `rls-coverage.integration.test.ts`
- Existing billing surface: `apps/api/src/db/schema/timeTracking.ts`
  (`time_entries`, `ticket_parts`)
- Connection/mapping pattern: `apps/api/src/db/schema/integrations.ts`,
  `apps/api/src/routes/psa.ts`
