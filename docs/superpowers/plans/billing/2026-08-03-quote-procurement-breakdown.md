# Quote Procurement Breakdown (Vendor Snapshot + Order Tracking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the MSP-facing "To be ordered" quote breakdown real procurement data — snapshotted vendor identity on quote lines, a header+lines order-tracking model (`quote_orders` / `quote_order_lines`), Pax8 cross-reference badges, group-by-vendor, and CSV/TSV export.

**Architecture:** Phase 1 snapshots vendor identity (`procurement_source`, `vendor_sku`, `manufacturer`) onto `quote_lines` server-side in `addCatalogLine` via a normalizer over the three `catalog_items.attributes` shapes, and fixes the dropped `part_number`. Phase 1.5 adds breakdown UX (grouping, export, Pax8 badges). Phase 2 adds the fulfillment tables with derived (never persisted) per-line status, a `quotes:fulfill` permission, and Mark-ordered/receive UI. Spec: `docs/superpowers/specs/billing/2026-08-03-quote-procurement-breakdown-design.md`.

**Tech Stack:** Hono + Drizzle + hand-written SQL migrations (idempotent, no inner BEGIN), Zod validators in `packages/shared`, React islands + Vitest/jsdom, shape-1 org RLS.

## Global Constraints

- Node is pinned: run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any pnpm/npx command (shell state does not persist between commands).
- All API test commands: `cd apps/api && npx vitest run <file>` (unit) or `npx vitest run -c vitest.integration.config.ts <file>` (integration; needs local Postgres on 5433 per `apps/api/src/__tests__/integration/README` conventions).
- Web tests: `cd apps/web && npx vitest run <file>`.
- Migrations: idempotent (`IF NOT EXISTS` / `DO $$`), NO inner `BEGIN;`/`COMMIT;`, filename `2026-08-03-<a|b|c>-<slug>.sql` (adjust the date to the actual implementation date, keep the `-a-`/`-b-`/`-c-` infixes so same-day files sort deterministically). Never edit a shipped migration.
- Every new `quote_lines` column and every column of each new table MUST be registered in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`) in the same PR — enforced only by the Integration Tests CI job, so run it locally.
- New i18n keys go to ALL 7 locales (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR`) in the same commit; locale-invariant values (e.g. "SKU") need a reviewed baseline bump in `apps/web/src/lib/i18n/translationCoverage.test.ts`.
- Web mutations wrap requests in `runAction` (`apps/web/src/lib/runAction.ts`).
- Customer-facing quote routes must NEVER serialize `unit_cost`, the new vendor columns, or any fulfillment data.
- Commit after every task (checkpoint commits are cheap context-loss insurance).

---

## Phase 1 — Vendor snapshot on quote_lines

### Task 1: Migration + Drizzle columns + export-policy registration

**Files:**
- Create: `apps/api/migrations/2026-08-03-a-quote-line-vendor-snapshot.sql`
- Modify: `apps/api/src/db/schema/quotes.ts` (quoteLines table, after `partNumber` at ~line 150)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `"quote_lines"` entry)

**Interfaces:**
- Produces: `quoteLines.procurementSource` (`procurement_source` varchar(40)), `quoteLines.vendorSku` (`vendor_sku` varchar(100)), `quoteLines.manufacturer` (`manufacturer` varchar(255)) — all nullable. Later tasks read/write these exact names.

- [ ] **Step 1: Write the migration**

```sql
-- Vendor identity snapshot on quote lines (procurement breakdown spec,
-- docs/superpowers/specs/billing/2026-08-03-quote-procurement-breakdown-design.md).
-- Nullable on purpose: historical lines stay NULL (no backfill — deriving an
-- "add-time" snapshot from today's catalog would fabricate data).
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS procurement_source varchar(40);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS vendor_sku varchar(100);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS manufacturer varchar(255);
```

- [ ] **Step 2: Add the Drizzle columns**

In `apps/api/src/db/schema/quotes.ts`, directly after `partNumber: varchar('part_number', { length: 100 }),`:

```ts
  // Vendor identity snapshotted at add-time from catalog_items.attributes
  // (never joined live: the distributor price table is partner-axis RLS and the
  // attributes jsonb has three incompatible shapes). NULL = unknown/manual.
  procurementSource: varchar('procurement_source', { length: 40 }),
  vendorSku: varchar('vendor_sku', { length: 100 }),
  manufacturer: varchar('manufacturer', { length: 255 }),
```

- [ ] **Step 3: Register the columns in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, the `"quote_lines"` entry: append `"procurement_source","vendor_sku","manufacturer"` to its `included` array (keep it one line, matching the file's style).

- [ ] **Step 4: Apply + drift-check**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift`
Expected: migration applies; drift check clean. Re-run `pnpm db:migrate` once more — must be a no-op (idempotency).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-08-03-a-quote-line-vendor-snapshot.sql apps/api/src/db/schema/quotes.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): vendor snapshot columns on quote_lines"
```

### Task 2: Vendor-identity normalizer (pure, TDD)

**Files:**
- Create: `apps/api/src/services/catalogVendorIdentity.ts`
- Test: `apps/api/src/services/catalogVendorIdentity.test.ts`

**Interfaces:**
- Produces: `vendorIdentityFromAttributes(attributes: unknown): VendorIdentity` and `export interface VendorIdentity { procurementSource: string | null; vendorSku: string | null; manufacturer: string | null; mfgPartNo: string | null }`. Task 3 calls it from `addCatalogLine`.

**The three real attribute shapes it must normalize** (verified in code — do not invent variants):
1. EC Express / nightly (`tdSynnexEcExpress.ts:552`): `attributes.distributor = { source: 'td_synnex_ec_express' | 'td_synnex_price_file', synnexSku, mfgPartNo, raw: { manufacturer? }, ... }` → source `'td_synnex'`, vendorSku = `synnexSku`, manufacturer from `manufacturer` (top level, added in Task 4) else `raw.manufacturer`.
2. Digital Bridge (`tdSynnexDigitalBridge.ts:580`): `attributes.distributor = { provider: 'td_synnex_digital_bridge', sku, manufacturerPartNumber, vendor, ... }` → source `'td_synnex'`, vendorSku = `sku`, manufacturer = `vendor`, mfgPartNo = `manufacturerPartNumber`.
3. Pax8 (`pax8CatalogService.ts:165`): `attributes.pax8 = { source: 'pax8', vendorName, vendorSku, ... }` → source `'pax8'`, vendorSku = `vendorSku`, manufacturer = `vendorName`, mfgPartNo = null.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { vendorIdentityFromAttributes } from './catalogVendorIdentity';

describe('vendorIdentityFromAttributes', () => {
  it('normalizes an EC Express / nightly distributor shape', () => {
    expect(vendorIdentityFromAttributes({
      distributor: {
        source: 'td_synnex_price_file', synnexSku: '7724459', mfgPartNo: 'JL679A',
        manufacturer: 'HPE Aruba', raw: { manufacturer: 'IGNORED when top-level set' },
      },
    })).toEqual({ procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE Aruba', mfgPartNo: 'JL679A' });
  });

  it('falls back to raw.manufacturer for pre-Task-4 EC imports', () => {
    expect(vendorIdentityFromAttributes({
      distributor: { source: 'td_synnex_ec_express', synnexSku: '123', mfgPartNo: null, raw: { manufacturer: 'Lenovo' } },
    })).toEqual({ procurementSource: 'td_synnex', vendorSku: '123', manufacturer: 'Lenovo', mfgPartNo: null });
  });

  it('normalizes the Digital Bridge provider shape', () => {
    expect(vendorIdentityFromAttributes({
      distributor: { provider: 'td_synnex_digital_bridge', sku: 'DB-1', manufacturerPartNumber: 'MPN-9', vendor: 'Cisco' },
    })).toEqual({ procurementSource: 'td_synnex', vendorSku: 'DB-1', manufacturer: 'Cisco', mfgPartNo: 'MPN-9' });
  });

  it('normalizes the Pax8 shape', () => {
    expect(vendorIdentityFromAttributes({
      pax8: { source: 'pax8', vendorName: 'Microsoft', vendorSku: 'CFQ7TTC0LH18' },
    })).toEqual({ procurementSource: 'pax8', vendorSku: 'CFQ7TTC0LH18', manufacturer: 'Microsoft', mfgPartNo: null });
  });

  it('returns all-null for manual/absent/malformed attributes', () => {
    const empty = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };
    expect(vendorIdentityFromAttributes(null)).toEqual(empty);
    expect(vendorIdentityFromAttributes({})).toEqual(empty);
    expect(vendorIdentityFromAttributes({ distributor: 'not-an-object' })).toEqual(empty);
    expect(vendorIdentityFromAttributes(42)).toEqual(empty);
  });

  it('clamps values to the column widths', () => {
    const out = vendorIdentityFromAttributes({ pax8: { vendorName: 'x'.repeat(300), vendorSku: 'y'.repeat(150) } });
    expect(out.manufacturer!.length).toBe(255);
    expect(out.vendorSku!.length).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/services/catalogVendorIdentity.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/**
 * Normalize the three incompatible vendor shapes stored in
 * catalog_items.attributes into one snapshot for quote_lines:
 *  - EC Express / nightly:  attributes.distributor.source ('td_synnex_*')
 *  - Digital Bridge:        attributes.distributor.provider
 *  - Pax8:                  attributes.pax8
 * Defensive on purpose: attributes is an open jsonb written by three services
 * across many releases — any unrecognized shape degrades to all-null, never throws.
 */
export interface VendorIdentity {
  procurementSource: string | null;
  vendorSku: string | null;
  manufacturer: string | null;
  mfgPartNo: string | null;
}

const EMPTY: VendorIdentity = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function vendorIdentityFromAttributes(attributes: unknown): VendorIdentity {
  const attrs = rec(attributes);
  if (!attrs) return EMPTY;

  const pax8 = rec(attrs.pax8);
  if (pax8) {
    return {
      procurementSource: 'pax8',
      vendorSku: str(pax8.vendorSku, 100),
      manufacturer: str(pax8.vendorName, 255),
      mfgPartNo: null,
    };
  }

  const dist = rec(attrs.distributor);
  if (!dist) return EMPTY;

  if (typeof dist.provider === 'string' && dist.provider === 'td_synnex_digital_bridge') {
    return {
      procurementSource: 'td_synnex',
      vendorSku: str(dist.sku, 100),
      manufacturer: str(dist.vendor, 255),
      mfgPartNo: str(dist.manufacturerPartNumber, 100),
    };
  }

  if (typeof dist.source === 'string' && dist.source.startsWith('td_synnex')) {
    const raw = rec(dist.raw);
    return {
      procurementSource: 'td_synnex',
      vendorSku: str(dist.synnexSku, 100),
      manufacturer: str(dist.manufacturer, 255) ?? (raw ? str(raw.manufacturer, 255) : null),
      mfgPartNo: str(dist.mfgPartNo, 100),
    };
  }
  return EMPTY;
}
```

- [ ] **Step 4: Run to verify pass** — same command → 6 passed.

- [ ] **Step 5: Commit** — `git add apps/api/src/services/catalogVendorIdentity.{ts,test.ts} && git commit -m "feat(api): catalog vendor-identity normalizer"`

### Task 3: Snapshot in addCatalogLine + clone + validators + customer-DTO allowlist

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` — `toCustomerLines` (~line 34), `cloneQuote` insert (~line 449), `addCatalogLine` (~line 939)
- Modify: `packages/shared/src/validators/quotes.ts` — `quoteLineInputSchema` (~line 50), `updateQuoteLineSchema` (~line 77)
- Test: `packages/shared/src/validators/quotes.test.ts` (add cases), `apps/api/src/services/quoteService.customerLines.test.ts` (create)

**Interfaces:**
- Consumes: `vendorIdentityFromAttributes` (Task 2).
- Produces: quote line payloads now carry `procurementSource`/`vendorSku`/`manufacturer` (camelCase, API + web). `toCustomerLines` becomes an allowlist — later columns are hidden-by-default on portal/public paths.

- [ ] **Step 1: Failing validator tests** — in `packages/shared/src/validators/quotes.test.ts` add:

```ts
it('accepts vendor snapshot fields on manual lines and clamps lengths', () => {
  const ok = quoteLineInputSchema.safeParse({
    sourceType: 'manual', name: 'Switch', quantity: 1, unitPrice: 100, taxable: false,
    procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE Aruba',
  });
  expect(ok.success).toBe(true);
  const tooLong = quoteLineInputSchema.safeParse({
    sourceType: 'manual', name: 'Switch', quantity: 1, unitPrice: 100, taxable: false,
    procurementSource: 'x'.repeat(41),
  });
  expect(tooLong.success).toBe(false);
});
```

- [ ] **Step 2: Run to verify fail** — `cd packages/shared && npx vitest run src/validators/quotes.test.ts` → FAIL (unrecognized key is stripped, but the too-long case only fails once the field exists → the `ok` case passes trivially; assert `ok.data` contains `procurementSource` to make it genuinely red: `expect((ok as any).data.procurementSource).toBe('td_synnex')`).

- [ ] **Step 3: Extend the validators** — add to BOTH `quoteLineInputSchema` and `updateQuoteLineSchema` (after their `partNumber` line):

```ts
  procurementSource: z.string().max(40).nullable().optional(),
  vendorSku: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(255).nullable().optional(),
```

- [ ] **Step 4: Service plumbing** — in `apps/api/src/services/quoteService.ts`:

(a) `addCatalogLine`: import `{ vendorIdentityFromAttributes }` from `./catalogVendorIdentity`; after the catalog item loads, add `const vendor = vendorIdentityFromAttributes(item.attributes);` and extend the insert values (after `partNumber`):

```ts
    partNumber: options?.partNumber ?? vendor.mfgPartNo,
    procurementSource: vendor.procurementSource,
    vendorSku: vendor.vendorSku,
    manufacturer: vendor.manufacturer,
```

(This is the `part_number` bug fix: the web editor never passes `options.partNumber`, so distributor `mfgPartNo` now lands server-side.)

(b) `addManualLine` (~line 899): pass `input.procurementSource ?? null`, `input.vendorSku ?? null`, `input.manufacturer ?? null` through the insert values. `updateLine` likewise for the three optional fields (mirror how `sku`/`partNumber` updates are already applied).

(c) `cloneQuote` insert (~line 449): after `partNumber: line.partNumber,` add:

```ts
        procurementSource: line.procurementSource,
        vendorSku: line.vendorSku,
        manufacturer: line.manufacturer,
```

(d) **Rewrite `toCustomerLines` as an allowlist** (replaces the strip-spread — today's output minus nothing, so behavior is identical, but every FUTURE internal column is hidden by default):

```ts
/**
 * Customer-facing projection of a quote line (public quote URL, portal, PDF).
 * ALLOWLIST, not a strip: new internal columns (vendor identity, fulfillment,
 * economics) are excluded by default. sku/partNumber stay customer-visible by
 * design; unitCost and the procurement snapshot never leave the MSP surface.
 */
const CUSTOMER_LINE_FIELDS = [
  'id', 'quoteId', 'blockId', 'orgId', 'sourceType', 'catalogItemId', 'parentLineId',
  'name', 'description', 'quantity', 'unitPrice', 'taxable', 'customerVisible',
  'lineTotal', 'recurrence', 'termMonths', 'billingFrequency', 'depositEligible',
  'itemType', 'sku', 'partNumber', 'imageId', 'sortOrder', 'createdAt',
] as const;
export type CustomerQuoteLine<T> = Pick<T & Record<string, unknown>, (typeof CUSTOMER_LINE_FIELDS)[number] & keyof T>;
export function toCustomerLines<T extends Record<string, unknown>>(lines: T[]) {
  return lines.map((line) => Object.fromEntries(
    CUSTOMER_LINE_FIELDS.filter((f) => f in line).map((f) => [f, line[f]]),
  ) as CustomerQuoteLine<T>);
}
```

- [ ] **Step 5: Failing customer-DTO test** — create `apps/api/src/services/quoteService.customerLines.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toCustomerLines } from './quoteService';

const full = {
  id: 'l1', quoteId: 'q1', blockId: null, orgId: 'o1', sourceType: 'catalog', catalogItemId: 'c1',
  parentLineId: null, name: 'Laptop', description: null, quantity: '1.00', unitPrice: '600.00',
  taxable: false, customerVisible: true, lineTotal: '600.00', recurrence: 'one_time',
  termMonths: null, billingFrequency: null, depositEligible: false, itemType: 'hardware',
  sku: 'LT-100', partNumber: 'MFG-9', imageId: null, sortOrder: 0, createdAt: new Date(),
  // internal-only:
  unitCost: '450.00', procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE',
};

describe('toCustomerLines', () => {
  it('emits exactly the customer allowlist — never cost or vendor identity', () => {
    const [line] = toCustomerLines([full]);
    expect(line).not.toHaveProperty('unitCost');
    expect(line).not.toHaveProperty('procurementSource');
    expect(line).not.toHaveProperty('vendorSku');
    expect(line).not.toHaveProperty('manufacturer');
    // and keeps the deliberately customer-visible identifiers:
    expect(line.sku).toBe('LT-100');
    expect(line.partNumber).toBe('MFG-9');
    expect(line.unitPrice).toBe('600.00');
  });
});
```

- [ ] **Step 6: Run all three test files** — shared validators, `catalogVendorIdentity.test.ts`, `quoteService.customerLines.test.ts` → all pass. Then run the existing quote route/service suites to catch fallout: `cd apps/api && npx vitest run src/routes/quotes src/services/quoteService` → all pass (the portal/public route tests exercise `toCustomerLines`).

- [ ] **Step 7: Typecheck** — `npx tsc --noEmit -p apps/api` (from repo root via turbo if configured; otherwise `cd apps/api && npx tsc --noEmit`). Expected: clean.

- [ ] **Step 8: Commit** — `git commit -m "feat(api): snapshot vendor identity onto quote lines; customer DTO allowlist"` (add the five touched files).

### Task 4: manufacturer end-to-end in the EC import contract

**Files:**
- Modify: `apps/api/src/routes/catalog/distributors.ts` — `ecProductSchema` (~line 259)
- Modify: `apps/api/src/services/tdSynnexEcExpress.ts` — product type + `attributes.distributor` payload (~line 552) + the live-lookup normalizer (~line 344, field currently only in `raw`)
- Modify: `apps/web/src/lib/api/distributors.ts` — `EcProduct` (~line 15)
- Modify: `apps/web/src/components/billing/quotes/nightlyProduct.ts` — `nightlyToEcProduct` (~line 86): lift `manufacturer` from `raw` to the top level (keep the `raw.manufacturer` copy for old data)
- Test: extend `apps/api/src/routes/catalog/distributors.test.ts` (or the existing co-located EC route test) + `apps/web/src/components/billing/quotes/nightlyProduct.test.ts` if present (create the assertion in the existing describe otherwise)

**Interfaces:**
- Produces: `EcProduct.manufacturer: string | null` (web + API + persisted `attributes.distributor.manufacturer`). Task 2's normalizer already prefers it over `raw.manufacturer`.

- [ ] **Step 1: Failing schema test** — assert `ecProductSchema.parse({...validProduct, manufacturer: 'HPE Aruba'})` preserves the field and that `manufacturer` longer than 255 fails.
- [ ] **Step 2: Add to `ecProductSchema`**: `manufacturer: z.string().max(255).nullable(),` (next to `mfgPartNo`). Because the schema is strict about shape, also add `manufacturer: null` defaults wherever fixtures construct products in tests.
- [ ] **Step 3: API service**: add `manufacturer: string | null` to the `TdSynnexEcProduct` type; in the live SOAP normalizer set it from the response's manufacturer field if present, else `null`; in the import payload (~line 555) add `manufacturer: product.manufacturer,` inside `attributes.distributor`.
- [ ] **Step 4: Web**: add `manufacturer: string | null;` to `EcProduct`; in `nightlyToEcProduct` set top-level `manufacturer: product.manufacturer ?? null`. In `DistributorLookup.tsx` the manufacturer display (~line 262) reads its existing source — switch it to `product.manufacturer` where it currently digs into `raw`.
- [ ] **Step 5: Run** — the distributors route tests, `DistributorLookup.test.tsx`, and web typecheck. Expected: pass/clean.
- [ ] **Step 6: Commit** — `git commit -m "feat: manufacturer end-to-end in the TD SYNNEX import contract"`.

### Task 5: Breakdown UI — vendor column (web)

**Files:**
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts` — `QuoteLine` interface (~line 168)
- Modify: `apps/web/src/components/billing/quotes/QuoteOrderBreakdown.tsx`
- Modify: `apps/web/src/locales/*/billing.json` (7 files) + `apps/web/src/lib/i18n/translationCoverage.test.ts` baselines if needed
- Test: `apps/web/src/components/billing/quotes/QuoteDetail.orderBreakdown.test.tsx`

**Interfaces:**
- Consumes: API now returns `procurementSource`/`vendorSku`/`manufacturer` on lines (Task 3).
- Produces: `QuoteLine.procurementSource/vendorSku/manufacturer: string | null` (optional, `?:`, so pre-column fixtures stay assignable — matches the file's existing convention for `imageId`).

- [ ] **Step 1: Failing test** — add to `QuoteDetail.orderBreakdown.test.tsx`:

```ts
it('shows vendor identity when snapshotted', async () => {
  render(<QuoteDetail detail={acceptedDetail([
    line({ id: 'l-1', sku: 'LT-100', procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE Aruba' }),
  ])} />);
  await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
  const row = screen.getByTestId('quote-order-breakdown-line-l-1');
  expect(row).toHaveTextContent('TD SYNNEX');
  expect(row).toHaveTextContent('7724459'); // vendorSku wins over sku
  expect(row).toHaveTextContent('HPE Aruba');
});
```

(Also extend the `line()` fixture with `procurementSource: null, vendorSku: null, manufacturer: null` defaults.)

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — in `QuoteOrderBreakdown.tsx`: add a Vendor column header after Item; cell renders `sourceLabel` + manufacturer:

```tsx
const SOURCE_LABELS: Record<string, string> = { td_synnex: 'TD SYNNEX', pax8: 'Pax8' };
// in the row:
<td className="px-3 py-2 text-muted-foreground">
  {l.procurementSource ? (SOURCE_LABELS[l.procurementSource] ?? l.procurementSource) : na}
  {l.manufacturer && <div className="text-xs">{l.manufacturer}</div>}
</td>
```

SKU cell becomes `{l.vendorSku || l.sku || na}`. Bump the tfoot label `colSpan` from 5 to 6 and the header/table accordingly. Add `quotes.detail.orderBreakdown.table.vendor` = "Vendor" to en + 6 locales (de "Anbieter", es "Proveedor", fr "Fournisseur" ×2, it "Fornitore", pt "Fornecedor").
- [ ] **Step 4: Run the full breakdown + i18n suites** — `npx vitest run src/components/billing/quotes/QuoteDetail.orderBreakdown.test.tsx src/lib/i18n` → pass (bump reviewed baselines only if a value is locale-invariant).
- [ ] **Step 5: Commit** — `git commit -m "feat(web): vendor column on the to-be-ordered breakdown"`.

---

## Phase 1.5 — Breakdown optimizations

### Task 6: Group-by-vendor + CSV/TSV export

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteOrderBreakdown.tsx`
- Modify: locales ×7
- Test: `QuoteDetail.orderBreakdown.test.tsx`

**Interfaces:**
- Consumes: `toCsv`/`rowsToCsv`/`escapeTsvCell` from `apps/web/src/lib/csvExport.ts`, `downloadBlob` from `apps/web/src/components/reports/reportExport.ts`.

- [ ] **Step 1: Failing tests**

```ts
it('groups lines by vendor with Unknown last, preserving sort order within groups', async () => {
  render(<QuoteDetail detail={acceptedDetail([
    line({ id: 'l-1', sku: 'A', procurementSource: 'td_synnex', sortOrder: 1 }),
    line({ id: 'l-2', sku: 'B', procurementSource: null, sortOrder: 0 }),
    line({ id: 'l-3', sku: 'C', procurementSource: 'pax8', sortOrder: 2 }),
  ])} />);
  await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
  const headers = screen.getAllByTestId(/quote-order-breakdown-group-/).map((el) => el.dataset.testid);
  expect(headers).toEqual([
    'quote-order-breakdown-group-td_synnex',
    'quote-order-breakdown-group-pax8',
    'quote-order-breakdown-group-unknown',
  ]);
});

it('suppresses group headers when every line shares one vendor', async () => {
  render(<QuoteDetail detail={acceptedDetail([
    line({ id: 'l-1', sku: 'A', procurementSource: 'td_synnex' }),
    line({ id: 'l-2', sku: 'B', procurementSource: 'td_synnex' }),
  ])} />);
  await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
  expect(screen.queryAllByTestId(/quote-order-breakdown-group-/)).toHaveLength(0);
});

it('downloads CSV without cost columns when the margin toggle is off', async () => {
  // spy: vi.spyOn(URL, 'createObjectURL') + capture the Blob text
});
```

For the CSV test capture the blob: `const blobs: Blob[] = []; vi.stubGlobal('URL', { ...URL, createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL: vi.fn() });` click `quote-order-breakdown-export-csv`, then `const text = await blobs[0].text(); expect(text).not.toContain('450.00'); expect(text).toContain('LT-100');`.

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement grouping** — pure helper in the same file:

```ts
export function groupByVendor(lines: QuoteLine[]): { key: string; lines: QuoteLine[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, QuoteLine[]>();
  for (const l of lines) {
    const key = l.procurementSource ?? 'unknown';
    if (!buckets.has(key)) { buckets.set(key, []); if (key !== 'unknown') order.push(key); }
    buckets.get(key)!.push(l);
  }
  const keys = [...order, ...(buckets.has('unknown') ? ['unknown'] : [])];
  return keys.map((key) => ({ key, lines: buckets.get(key)! }));
}
```

Render one `<tbody>` per group; when `groups.length > 1` emit a full-width group header row `data-testid={'quote-order-breakdown-group-' + key}` labeled `SOURCE_LABELS[key] ?? t('quotes.detail.orderBreakdown.unknownVendor')`.

- [ ] **Step 4: Implement export** — header buttons (icon buttons beside the item count):

```tsx
function exportRows(lines: QuoteLine[], showCost: boolean, currency: string) {
  return lines.map((l) => ({
    item: lineTitle(l),
    vendor: l.procurementSource ?? '',
    manufacturer: l.manufacturer ?? '',
    sku: l.vendorSku || l.sku || '',
    partNumber: l.partNumber ?? '',
    qty: formatQuantity(l.quantity),
    ...(showCost ? {
      unitCost: l.unitCost ?? '',
      extCost: l.unitCost === null ? '' : computeLineTotal(l.quantity, l.unitCost),
      currency,
    } : {}),
  }));
}
// CSV: downloadBlob(new Blob([toCsv(exportRows(lines, showCost, currency))], { type: 'text/csv' }), `quote-${quoteNumber}-to-be-ordered.csv`)
// TSV: navigator.clipboard.writeText(<same rows through the tab-separated helper>) then showToast success
```

Use the exact export names found in `lib/csvExport.ts` (`toCsv`, `rowsToCsv`, `escapeTsvCell`) — check its `export {}` block and use the row-object helper it provides; pass `quoteNumber` into `QuoteOrderBreakdown` as a new prop (`quoteNumber: string`), supplied from `QuoteDetail` (`quote.quoteNumber`). New i18n keys: `orderBreakdown.exportCsv` ("Download CSV"), `orderBreakdown.copyTsv` ("Copy for spreadsheet"), `orderBreakdown.copied` ("Copied"), `orderBreakdown.unknownVendor` ("Other / unknown vendor") ×7 locales.

- [ ] **Step 5: Run + commit** — breakdown suite + i18n suites green; `git commit -m "feat(web): vendor grouping + CSV/TSV export on the order breakdown"`.

### Task 7: Pax8 cross-reference badges

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` — `getQuote` pax8 block (~line 493)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts` — `QuoteDetail` interface
- Modify: `apps/web/src/components/billing/quotes/QuoteOrderBreakdown.tsx`, `QuoteDetail.tsx`
- Test: `apps/api/src/routes/quotes/quotes.test.ts` (or the co-located getQuote test file), `QuoteDetail.orderBreakdown.test.tsx`

**Interfaces:**
- Produces (API → web): `detail.pax8Order?: { id: string; status: string; lines: { sourceQuoteLineId: string | null; submitState: string; quantity: string | null }[] } | null` — ADDITIVE next to the existing `pax8OrderId`/`pax8OrderLineCount` (kept for the existing rail card).

- [ ] **Step 1: API** — extend the existing summary select to also fetch `pax8Orders.status`, and replace the count-only line query with:

```ts
const pax8LineRows = pax8OrderSummary
  ? await db.select({
      sourceQuoteLineId: pax8OrderLines.sourceQuoteLineId,
      submitState: pax8OrderLines.submitState,
      quantity: pax8OrderLines.quantity,
    }).from(pax8OrderLines).where(and(
      eq(pax8OrderLines.orderId, pax8OrderSummary.pax8OrderId),
      eq(pax8OrderLines.partnerId, q.partnerId),
      eq(pax8OrderLines.orgId, q.orgId),
    ))
  : [];
```

Return `pax8Order: pax8OrderSummary ? { id, status, lines: pax8LineRows } : null` and derive the legacy `pax8OrderLineCount` from `pax8LineRows.length` (drop the separate count query).
- [ ] **Step 2: API test** — extend the existing getQuote test fixture: staged order with two lines → response carries both `sourceQuoteLineId`s and the order `status`; quote without an order → `pax8Order: null` and `pax8OrderLineCount: 0`. Run → pass.
- [ ] **Step 3: Web badge** — `QuoteDetail` passes `pax8Order` into `QuoteOrderBreakdown`; build `const pax8ByLine = new Map(pax8Order?.lines.filter(l => l.sourceQuoteLineId).map(l => [l.sourceQuoteLineId!, l]))`. In the item cell, when `pax8ByLine.has(l.id)` render a badge whose label is state-accurate (never "fulfilled"):

```ts
// order.status 'awaiting_details' | 'draft'      → t('…pax8Badge.staged')   "Staged in Pax8"
// line.submitState 'submitted'/'succeeded'        → t('…pax8Badge.ordered')  "Ordered via Pax8"
// line.submitState 'failed' or order.status 'failed' → t('…pax8Badge.failed') "Pax8 failed" (danger tone)
```

testid `quote-order-breakdown-pax8-${l.id}`. Keys ×7 locales.
- [ ] **Step 4: Web test** — badge shows "Staged in Pax8" for an `awaiting_details` order; absent for unmatched lines. Run breakdown + i18n suites → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: pax8 staged-order cross-reference on the order breakdown"`.

---

## Phase 2 — Order tracking (quote_orders + quote_order_lines)

### Task 8: Schema + migration + registrations

**Files:**
- Create: `apps/api/migrations/2026-08-03-b-quote-orders.sql`
- Modify: `apps/api/src/db/schema/quotes.ts` (append both tables), `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (two new entries)

**Interfaces:**
- Produces: Drizzle tables `quoteOrders`, `quoteOrderLines` with the exact columns below; Tasks 9–12 depend on these names.

- [ ] **Step 1: Drizzle tables** (append to `apps/api/src/db/schema/quotes.ts`; `users` import already exists in the file — verify, else import from `./users`):

```ts
export const quoteOrders = pgTable('quote_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  procurementSource: varchar('procurement_source', { length: 40 }),
  vendorName: varchar('vendor_name', { length: 255 }),
  orderRef: varchar('order_ref', { length: 120 }),
  orderedBy: uuid('ordered_by').references(() => users.id, { onDelete: 'set null' }),
  orderedAt: timestamp('ordered_at').defaultNow().notNull(),
  notes: text('notes'),
  // Double-click / retry dedupe: the client sends a UUID per Mark-ordered submit.
  clientRequestId: uuid('client_request_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('quote_orders_quote_idx').on(t.quoteId),
  index('quote_orders_org_idx').on(t.orgId),
  uniqueIndex('quote_orders_id_quote_org_uq').on(t.id, t.quoteId, t.orgId),
  uniqueIndex('quote_orders_client_request_uq').on(t.quoteId, t.clientRequestId)
    .where(sql`${t.clientRequestId} IS NOT NULL`),
  foreignKey({
    columns: [t.quoteId, t.orgId], foreignColumns: [quotes.id, quotes.orgId],
    name: 'quote_orders_quote_org_fkey',
  }).onDelete('cascade'),
]);

export const quoteOrderLines = pgTable('quote_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  quoteId: uuid('quote_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  quoteLineId: uuid('quote_line_id').notNull(),
  orderedQty: numeric('ordered_qty', { precision: 12, scale: 2 }).notNull(),
  receivedQty: numeric('received_qty', { precision: 12, scale: 2 }).notNull().default('0'),
  trackingNumber: varchar('tracking_number', { length: 120 }),
  eta: date('eta'),
  receivedAt: timestamp('received_at'),
  cancelledAt: timestamp('cancelled_at'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('quote_order_lines_order_idx').on(t.orderId),
  index('quote_order_lines_org_idx').on(t.orgId),
  index('quote_order_lines_quote_line_idx').on(t.quoteLineId),
  foreignKey({
    columns: [t.orderId, t.quoteId, t.orgId],
    foreignColumns: [quoteOrders.id, quoteOrders.quoteId, quoteOrders.orgId],
    name: 'quote_order_lines_order_fkey',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.quoteLineId, t.quoteId], foreignColumns: [quoteLines.id, quoteLines.quoteId],
    name: 'quote_order_lines_quote_line_fkey',
  }).onDelete('cascade'),
]);
```

Add `date` and `sql`/`uniqueIndex`/`foreignKey` to the file's drizzle imports if missing.

- [ ] **Step 2: Migration** — `2026-08-03-b-quote-orders.sql`:

```sql
-- Order tracking for won quotes: PO-style header + per-line allocations.
-- Spec: docs/superpowers/specs/billing/2026-08-03-quote-procurement-breakdown-design.md
-- Composite FKs prove header/allocation/quote-line all share one quote + org
-- (same construction as pax8_order_lines). All FKs cascade so the org-erasure
-- cascade order can never hit an FK violation regardless of list position.

-- Composite FK targets need unique indexes on the referenced columns.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_id_org_uq ON quotes (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_lines_id_quote_uq ON quote_lines (id, quote_id);

CREATE TABLE IF NOT EXISTS quote_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  procurement_source varchar(40),
  vendor_name varchar(255),
  order_ref varchar(120),
  ordered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ordered_at timestamp NOT NULL DEFAULT now(),
  notes text,
  client_request_id uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT quote_orders_quote_org_fkey FOREIGN KEY (quote_id, org_id)
    REFERENCES quotes (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS quote_orders_quote_idx ON quote_orders (quote_id);
CREATE INDEX IF NOT EXISTS quote_orders_org_idx ON quote_orders (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_orders_id_quote_org_uq ON quote_orders (id, quote_id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_orders_client_request_uq
  ON quote_orders (quote_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quote_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  quote_line_id uuid NOT NULL,
  ordered_qty numeric(12,2) NOT NULL,
  received_qty numeric(12,2) NOT NULL DEFAULT 0,
  tracking_number varchar(120),
  eta date,
  received_at timestamp,
  cancelled_at timestamp,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT quote_order_lines_order_fkey FOREIGN KEY (order_id, quote_id, org_id)
    REFERENCES quote_orders (id, quote_id, org_id) ON DELETE CASCADE,
  CONSTRAINT quote_order_lines_quote_line_fkey FOREIGN KEY (quote_line_id, quote_id)
    REFERENCES quote_lines (id, quote_id) ON DELETE CASCADE,
  CONSTRAINT quote_order_lines_qty_chk CHECK (ordered_qty > 0 AND received_qty >= 0 AND received_qty <= ordered_qty)
);
CREATE INDEX IF NOT EXISTS quote_order_lines_order_idx ON quote_order_lines (order_id);
CREATE INDEX IF NOT EXISTS quote_order_lines_org_idx ON quote_order_lines (org_id);
CREATE INDEX IF NOT EXISTS quote_order_lines_quote_line_idx ON quote_order_lines (quote_line_id);

-- Shape-1 org RLS, enabled + FORCED in the creating migration (never deferred).
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['quote_orders','quote_order_lines'] LOOP
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO breeze_app', tbl);
  END LOOP;
END $$;
```

(Check the pax8 orders migration `apps/api/migrations/2026-07-13-*pax8*.sql` for the exact GRANT convention used and mirror it.) NOTE: `gen_random_uuid()` requires pgcrypto NOT be assumed — check how the quotes migration generates defaults (`2026-06-16-quotes.sql`) and copy its mechanism exactly (memory: `gen_random_bytes` is unavailable; `gen_random_uuid()` is core in PG13+ and used by existing migrations — verify with a grep before writing).

- [ ] **Step 3: Cascade + export registrations** — add `'quote_order_lines'` and `'quote_orders'` to `CORE_ORG_CASCADE_DELETE_ORDER` in alphabetical position (`quote_lines` < `quote_order_lines` < `quote_orders` — verify with the test), and add both export-policy entries:

```ts
  "quote_order_lines": tablePolicy("org_id", {"included":["id","order_id","quote_id","org_id","quote_line_id","ordered_qty","received_qty","tracking_number","eta","received_at","cancelled_at","notes","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "quote_orders": tablePolicy("org_id", {"included":["id","quote_id","org_id","procurement_source","vendor_name","order_ref","ordered_by","ordered_at","notes","client_request_id","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 4: Apply, re-apply, drift-check** — `pnpm db:migrate` twice (second run no-op) + `pnpm db:check-drift` clean.
- [ ] **Step 5: RLS forge check** — `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and attempt a cross-tenant `INSERT INTO quote_orders (quote_id, org_id) VALUES ('<real quote>', '<OTHER org>')` under an org context → must fail with `new row violates row-level security policy` (composite FK also rejects).
- [ ] **Step 6: Commit** — `git commit -m "feat(api): quote_orders + quote_order_lines schema, RLS, registrations"`.

### Task 9: `quotes:fulfill` permission

**Files:**
- Create: `apps/api/migrations/2026-08-03-c-quotes-fulfill-permission.sql`
- Modify: `packages/shared/src/constants/permissions.ts` (~line 68), `apps/api/src/routes/permissionsCatalog.ts` (`ACTION_LABELS`)

**Interfaces:**
- Produces: `PERMISSIONS.QUOTES_FULFILL = { resource: 'quotes', action: 'fulfill' }`; ACTION_LABELS gains `fulfill: 'Fulfill'`. Task 11's routes gate on it.

- [ ] **Step 1: Constant + label** — add `QUOTES_FULFILL: { resource: 'quotes', action: 'fulfill' },` after `QUOTES_SEND` and `fulfill: 'Fulfill',` to `ACTION_LABELS`.
- [ ] **Step 2: Migration** (mirrors `2026-07-11-ai-sessions-read-all-permission.sql`):

```sql
-- quotes:fulfill — mark accepted-quote lines ordered/received. Deliberately NOT
-- quotes:write (documented as draft editing) so read-only viewers and
-- draft-editors don't inherit procurement mutation rights.
INSERT INTO permissions (resource, action, description)
SELECT 'quotes', 'fulfill', 'Record procurement orders and receipts against accepted quotes'
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'quotes' AND action = 'fulfill');

-- Grant to every system role that already holds quotes:write.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT rp.role_id, p_new.id
  FROM role_permissions rp
  JOIN permissions p_write ON p_write.id = rp.permission_id
    AND p_write.resource = 'quotes' AND p_write.action = 'write'
  JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE
  CROSS JOIN (SELECT id FROM permissions WHERE resource='quotes' AND action='fulfill' LIMIT 1) p_new
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'quotes-fulfill: granted to % system role(s)', n;
END $$;
```

- [ ] **Step 3: Run** — `pnpm db:migrate` (twice, idempotent) and `cd apps/api && npx vitest run src/routes/permissionsCatalog.test.ts` (label-parity guard) → pass.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): quotes:fulfill permission"`.

### Task 10: Shared fulfillment math + validators (TDD)

**Files:**
- Create: `packages/shared/src/utils/quoteFulfillment.ts` + `quoteFulfillment.test.ts`
- Modify: `packages/shared/src/validators/quotes.ts`, `packages/shared/src/index.ts` (re-export barrel — mirror how `quoteMath` is exported)

**Interfaces:**
- Produces:
  - `type QuoteLineFulfillmentStatus = 'not_ordered' | 'ordered' | 'partially_received' | 'received'`
  - `deriveLineFulfillment(allocations: { orderedQty: string | number; receivedQty: string | number | null; cancelledAt: string | Date | null }[]): QuoteLineFulfillmentStatus`
  - Validators: `createQuoteOrderSchema`, `updateQuoteOrderSchema`, `updateQuoteOrderLineSchema` (exact shapes below).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { deriveLineFulfillment } from './quoteFulfillment';

const a = (orderedQty: string, receivedQty: string, cancelledAt: string | null = null) =>
  ({ orderedQty, receivedQty, cancelledAt });

describe('deriveLineFulfillment', () => {
  it('not_ordered when no allocations or all cancelled', () => {
    expect(deriveLineFulfillment([])).toBe('not_ordered');
    expect(deriveLineFulfillment([a('2.00', '0', '2026-08-01T00:00:00Z')])).toBe('not_ordered');
  });
  it('ordered when nothing received', () => {
    expect(deriveLineFulfillment([a('2.00', '0')])).toBe('ordered');
  });
  it('partially_received across multiple allocations', () => {
    expect(deriveLineFulfillment([a('2.00', '2.00'), a('3.00', '0')])).toBe('partially_received');
  });
  it('received when totals meet, ignoring cancelled allocations', () => {
    expect(deriveLineFulfillment([a('2.00', '2.00'), a('5.00', '0', '2026-08-01T00:00:00Z')])).toBe('received');
  });
  it('handles fractional quantities exactly (cents-scaled integer math)', () => {
    expect(deriveLineFulfillment([a('0.30', '0.10'), a('0.30', '0.20')])).toBe('partially_received');
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd packages/shared && npx vitest run src/utils/quoteFulfillment.test.ts`.
- [ ] **Step 3: Implement** (reuse `toCents` from `./quoteMath` — numeric(12,2) quantities scale to exact integers):

```ts
import { toCents } from './quoteMath';

export type QuoteLineFulfillmentStatus = 'not_ordered' | 'ordered' | 'partially_received' | 'received';

export interface FulfillmentAllocationLike {
  orderedQty: string | number;
  receivedQty: string | number | null;
  cancelledAt: string | Date | null;
}

/** Derived, never persisted: absence of an active allocation IS "not ordered". */
export function deriveLineFulfillment(allocations: FulfillmentAllocationLike[]): QuoteLineFulfillmentStatus {
  const active = allocations.filter((x) => !x.cancelledAt);
  if (active.length === 0) return 'not_ordered';
  const ordered = active.reduce((s, x) => s + toCents(x.orderedQty), 0);
  const received = active.reduce((s, x) => s + toCents(x.receivedQty ?? 0), 0);
  if (received <= 0) return 'ordered';
  return received < ordered ? 'partially_received' : 'received';
}
```

- [ ] **Step 4: Validators** — in `packages/shared/src/validators/quotes.ts` (reuse the file's existing `positiveQty` helper):

```ts
export const createQuoteOrderSchema = z.object({
  clientRequestId: z.string().guid(),
  procurementSource: z.string().max(40).nullable().optional(),
  vendorName: z.string().max(255).nullable().optional(),
  orderRef: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  trackingNumber: z.string().max(120).nullable().optional(),
  eta: isoDate.optional(),
  lines: z.array(z.object({
    quoteLineId: z.string().guid(),
    orderedQty: positiveQty,
  })).min(1).max(200),
});

export const updateQuoteOrderSchema = z.object({
  vendorName: z.string().max(255).nullable().optional(),
  orderRef: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateQuoteOrderLineSchema = z.object({
  receivedQty: positiveQty.optional(),
  trackingNumber: z.string().max(120).nullable().optional(),
  eta: isoDate.nullable().optional(),
  cancelled: z.boolean().optional(),
});
```

Add validator tests: `createQuoteOrderSchema` rejects an empty `lines` array and a missing `clientRequestId`; `updateQuoteOrderLineSchema` accepts `{ cancelled: true }`.
- [ ] **Step 5: Run shared suite + barrel export** — `npx vitest run src/utils/quoteFulfillment.test.ts src/validators/quotes.test.ts` → pass; export `quoteFulfillment` from the same barrel that exports `quoteMath`.
- [ ] **Step 6: Commit** — `git commit -m "feat(shared): quote fulfillment derivation + order validators"`.

### Task 11: quoteOrderService + routes + audit

**Files:**
- Create: `apps/api/src/services/quoteOrderService.ts`
- Modify: `apps/api/src/routes/quotes/quotes.ts` (mount the three endpoints; add `fulfillPerm`), `apps/api/src/services/quoteService.ts` (`getQuote` returns orders)
- Test: `apps/api/src/routes/quotes/quoteOrders.test.ts` (create — mirror the mocking style of the sibling `routes/quotes/lifecycle.test.ts`, which mounts the real router with mocked `getUserPermissions`)

**Interfaces:**
- Consumes: `createQuoteOrderSchema`/`updateQuoteOrderSchema`/`updateQuoteOrderLineSchema`, `deriveLineFulfillment`, `PERMISSIONS.QUOTES_FULFILL`, tables from Task 8, `writeAuditEvent` (`services/auditEvents.ts`, input: `{ orgId, action, resourceType, resourceId?, details?, ... }`).
- Produces:
  - `createQuoteOrder(quoteId: string, input: CreateQuoteOrderInput, actor: QuoteActor): Promise<QuoteOrderWithLines>`
  - `updateQuoteOrder(quoteId, orderId, input, actor): Promise<QuoteOrder>`
  - `updateQuoteOrderLine(quoteId, orderId, lineId, input, actor): Promise<QuoteOrderLine>`
  - `listQuoteOrders(quoteId): Promise<QuoteOrderWithLines[]>` (used by `getQuote`)
  - Routes: `POST /:id/orders`, `PATCH /:id/orders/:orderId`, `PATCH /:id/orders/:orderId/lines/:lineId` — all `scopes` + `fulfillPerm`.

- [ ] **Step 1: Failing route tests** — cover, at HTTP level: (1) POST creates header + allocations and returns them; (2) POST with the same `clientRequestId` twice returns the SAME order id (idempotent — service catches the 23505 from `quote_orders_client_request_uq`, re-reads, returns); (3) POST 403 without `quotes:fulfill` even when `quotes:write` is held; (4) POST 409 when the quote status is not `accepted`/`converted`; (5) POST 400 when a `quoteLineId` belongs to another quote; (6) line PATCH `{ cancelled: true }` stamps `cancelledAt`; (7) line PATCH `receivedQty` above `orderedQty` → 400 (validate in service before hitting the DB CHECK, so the client gets a clean message).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement the service.** Key requirements, all in `quoteOrderService.ts`:

```ts
// Skeleton — mirror quoteService's error type + actor guard conventions.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { quotes, quoteLines, quoteOrders, quoteOrderLines } from '../db/schema/quotes';
import { QuoteServiceError, assertQuoteAccess, type QuoteActor } from './quoteService'; // export these from quoteService if not already

const FULFILLABLE_STATUSES = ['accepted', 'converted'] as const;

export async function createQuoteOrder(quoteId: string, input: CreateQuoteOrderInput, actor: QuoteActor) {
  return db.transaction(async (tx) => {
    const [q] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
    assertQuoteAccess(actor, q);
    if (!FULFILLABLE_STATUSES.includes(q.status as never)) {
      throw new QuoteServiceError('Only accepted or converted quotes can be fulfilled', 409, 'QUOTE_NOT_FULFILLABLE');
    }
    const lineIds = input.lines.map((l) => l.quoteLineId);
    const owned = await tx.select({ id: quoteLines.id }).from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), inArray(quoteLines.id, lineIds)));
    if (owned.length !== lineIds.length) {
      throw new QuoteServiceError('Line does not belong to this quote', 400, 'QUOTE_LINE_MISMATCH');
    }
    try {
      const [order] = await tx.insert(quoteOrders).values({
        quoteId, orgId: q.orgId,
        procurementSource: input.procurementSource ?? null,
        vendorName: input.vendorName ?? null,
        orderRef: input.orderRef ?? null,
        orderedBy: actor.userId ?? null,
        notes: input.notes ?? null,
        clientRequestId: input.clientRequestId,
      }).returning();
      const lines = await tx.insert(quoteOrderLines).values(input.lines.map((l) => ({
        orderId: order!.id, quoteId, orgId: q.orgId, quoteLineId: l.quoteLineId,
        orderedQty: String(l.orderedQty),
        trackingNumber: input.trackingNumber ?? null,
        eta: input.eta ?? null,
      }))).returning();
      return { ...order!, lines };
    } catch (err) {
      if (isUniqueViolation(err, 'quote_orders_client_request_uq')) {
        // Retry of a committed submit: return the existing order (idempotent).
        const [existing] = await tx.select().from(quoteOrders).where(and(
          eq(quoteOrders.quoteId, quoteId), eq(quoteOrders.clientRequestId, input.clientRequestId),
        )).limit(1);
        const lines = await tx.select().from(quoteOrderLines).where(eq(quoteOrderLines.orderId, existing!.id));
        return { ...existing!, lines };
      }
      throw err;
    }
  });
}
```

(`isUniqueViolation`: check `err.code === '23505'` and constraint name — grep the repo for an existing 23505 helper and reuse it; `actor.userId` — use the actual field name on `QuoteActor`, check its definition at the top of quoteService.) `updateQuoteOrderLine` validates `receivedQty <= orderedQty` (cents-compare via `toCents`) and maps `{ cancelled: true }` → `cancelledAt: new Date()`; both PATCH functions verify the order belongs to the quote AND the quote passes `assertQuoteAccess`.
- [ ] **Step 4: Routes** — in `routes/quotes/quotes.ts` add `const fulfillPerm = requirePermission(PERMISSIONS.QUOTES_FULFILL.resource, PERMISSIONS.QUOTES_FULFILL.action);` and the three endpoints following the file's exact one-line try/catch style. After each successful mutation write an audit event (IDs and counts ONLY — no tracking numbers, refs, or notes):

```ts
writeAuditEvent(c, {
  orgId: order.orgId, action: 'quote_order_created', resourceType: 'quote',
  resourceId: quoteId, details: { orderId: order.id, lineCount: order.lines.length },
});
```

(actions: `quote_order_created` / `quote_order_updated` / `quote_order_line_updated`).
- [ ] **Step 5: `getQuote` returns orders** — in `quoteService.getQuote`, alongside the pax8 block: `const orders = await listQuoteOrders(id);` and include `orders` in the return. `listQuoteOrders` = header select + `inArray` line select, grouped in JS.
- [ ] **Step 6: Hash regression test** — add to the existing `quoteContentHash` test file: build a hashable quote, compute `computeQuoteSha256`, then compute again for the same lines with `procurementSource/vendorSku/manufacturer` set — hashes MUST be identical (the mapper enumerates fields explicitly; this test pins that contract against future refactors).
- [ ] **Step 7: Run** — new route tests + full `src/routes/quotes` + `src/services` unit suites → pass. Typecheck clean.
- [ ] **Step 8: Commit** — `git commit -m "feat(api): quote order tracking service + routes + audit"`.

### Task 12: RLS + cascade integration coverage

**Files:**
- Create: `apps/api/src/__tests__/integration/quoteOrdersRls.integration.test.ts` (mirror the structure of the existing quote RLS integration suite — find it with `ls apps/api/src/__tests__/integration/ | grep -i quote`)
- Modify (verify only): `rls-coverage.integration.test.ts` needs NO allowlist entry (direct `org_id` ⇒ auto-discovered) — run it to confirm.

- [ ] **Step 1: Write the forge tests** — as `breeze_app` under org A's context: cross-org INSERT into `quote_orders` → expect SQLSTATE 42501 (RLS); allocation referencing another quote's line → FK violation; `received_qty > ordered_qty` → 23514 CHECK.
- [ ] **Step 2: Run the contract suites** — `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/quoteOrdersRls.integration.test.ts` → ALL pass (cascade test also proves the alphabetical position + FK direction from Task 8).
- [ ] **Step 3: Commit** — `git commit -m "test(api): quote orders RLS forge + contract coverage"`.

### Task 13: Fulfillment UI — status chips, Mark ordered, receive/cancel

**Files:**
- Create: `apps/web/src/components/billing/quotes/QuoteOrderTracking.tsx` (dialog + allocation rows), colocated test `QuoteOrderTracking.test.tsx`
- Modify: `apps/web/src/components/billing/quotes/QuoteOrderBreakdown.tsx` (selection + chips), `quoteTypes.ts` (types below), `QuoteDetail.tsx` (pass `detail.orders` + `onChanged`), `apps/web/src/lib/api/quotes.ts` (three fetch helpers), locales ×7
- Test: extend `QuoteDetail.orderBreakdown.test.tsx`

**Interfaces:**
- Consumes: `deriveLineFulfillment` + `QuoteLineFulfillmentStatus` from `@breeze/shared`; API endpoints from Task 11.
- Produces (types in `quoteTypes.ts`):

```ts
export interface QuoteOrderLine {
  id: string; orderId: string; quoteLineId: string; orderedQty: string; receivedQty: string;
  trackingNumber: string | null; eta: string | null; receivedAt: string | null;
  cancelledAt: string | null; notes: string | null; createdAt: string;
}
export interface QuoteOrder {
  id: string; quoteId: string; procurementSource: string | null; vendorName: string | null;
  orderRef: string | null; orderedBy: string | null; orderedAt: string; notes: string | null;
  lines: QuoteOrderLine[];
}
// QuoteDetail gains: orders?: QuoteOrder[];
```

- [ ] **Step 1: Failing tests** — (1) a line whose allocations sum to received shows chip "Received" (`quote-order-breakdown-status-<lineId>`); (2) selecting two rows and clicking `quote-order-breakdown-mark-ordered` opens the dialog with both lines and their remaining quantities prefilled; (3) submitting POSTs to `/quotes/q-1/orders` with a `clientRequestId` and the selected `quoteLineId`s (assert via the mocked `fetchWithAuth`); (4) the Mark-ordered button is absent without the `quotes` `fulfill` permission (extend the test's permission fixture).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: API helpers** in `lib/api/quotes.ts` (follow the file's existing `fetchWithAuth` wrapper style):

```ts
export const createQuoteOrder = (quoteId: string, body: unknown) =>
  fetchWithAuth(`/quotes/${quoteId}/orders`, { method: 'POST', body: JSON.stringify(body) });
export const updateQuoteOrder = (quoteId: string, orderId: string, body: unknown) =>
  fetchWithAuth(`/quotes/${quoteId}/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const updateQuoteOrderLine = (quoteId: string, orderId: string, lineId: string, body: unknown) =>
  fetchWithAuth(`/quotes/${quoteId}/orders/${orderId}/lines/${lineId}`, { method: 'PATCH', body: JSON.stringify(body) });
```

- [ ] **Step 4: Implement** — in `QuoteOrderBreakdown`: build `allocationsByLine = new Map<string, QuoteOrderLine[]>` from `orders`, chip = `deriveLineFulfillment(allocationsByLine.get(l.id) ?? [])` with i18n labels (`orderBreakdown.status.notOrdered/ordered/partiallyReceived/received`); row checkboxes gated on `can('quotes','fulfill')` (add `fulfill` to the web `PermissionAction` union if the permissions helper enumerates actions); "Mark ordered" button opens `QuoteOrderTracking` dialog (vendor prefilled from the selection's common `procurementSource`, qty inputs defaulting to unordered remainder, single order-ref/tracking/eta fields). Dialog submit: `crypto.randomUUID()` as `clientRequestId`, wrap in `runAction`, then `onChanged()` to reload the quote. Allocation rows under each line (indented, small): tracking, eta, received qty input + "Mark received" (PATCH `receivedQty: orderedQty`) + cancel action, all `runAction`-wrapped. i18n keys ×7 locales; baseline bumps only for locale-invariants.
- [ ] **Step 5: Run** — full `src/components/billing/quotes` + `src/lib/i18n` suites → pass. Typecheck clean.
- [ ] **Step 6: Commit** — `git commit -m "feat(web): quote order tracking UI (mark ordered / receive / cancel)"`.

### Task 14: Final verification sweep

- [ ] **Step 1: Full local suites** — `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/web test`, `pnpm --filter @breeze/shared test` → green.
- [ ] **Step 2: Contract suites again** (they do NOT run in `pnpm test`): rls-coverage, tenantCascade, tenant-export-policy, tenantExportErasureRoundtrip, quoteOrdersRls under `vitest.integration.config.ts` → green.
- [ ] **Step 3: Manual smoke** — `pnpm dev`; accept a quote with one TD SYNNEX line, one Pax8 line, one manual service line: breakdown shows vendor groups + Pax8 badge; Mark ordered → chips flip; receive → Received; CSV downloads; portal + public quote views show NO vendor/cost/fulfillment fields (view source of the JSON response).
- [ ] **Step 4: Commit any fixes; open the PR** referencing the spec doc. If the branch is stacked (base ≠ main), dispatch CI per branch: `gh workflow run CI --ref <branch>`.

---

## Self-review notes (already applied)

- Spec coverage: Phase 1 → Tasks 1–5; Phase 1.5 → Tasks 6–7; Phase 2 → Tasks 8–13; traps 1 (allowlist DTO) → Task 3, 2 (hash) → Task 11 Step 6, 3 (clone) → Task 3, 4 (export policy) → Tasks 1/8, 5 (no pax8 index needed) → Task 7 queries by order id, 6 (org-scope only) → no system context anywhere. Phase 3 (cost drift) intentionally has no tasks — deferred by spec.
- Type consistency: `procurementSource`/`vendorSku`/`manufacturer` camelCase everywhere; `deriveLineFulfillment` + `QuoteLineFulfillmentStatus` defined once in Task 10 and consumed in Task 13; `createQuoteOrder(quoteId, input, actor)` defined in Task 11 and consumed via the Task 13 fetch helpers.
- Known verify-at-implementation points (flagged inline, not placeholders): the GRANT convention in the pax8 migration, the uuid-default mechanism used by existing quote migrations, the exact `QuoteActor` user-id field, the repo's existing 23505 helper, and the exact `lib/csvExport.ts` export names.
