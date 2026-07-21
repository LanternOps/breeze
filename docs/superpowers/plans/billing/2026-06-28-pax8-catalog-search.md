# Pax8 Catalog Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partners search the Pax8 product catalog and import products into the Breeze catalog (and onto quotes/contract lines), mirroring the existing TD SYNNEX import flow.

**Architecture:** Add a `products` data stream to the existing Pax8 client (reusing its OAuth + the existing `pax8Integrations` credentials), a `pax8CatalogService` that does a live-proxy search with a short-TTL Redis cache and imports via the existing `createCatalogItem`, four routes alongside the TD SYNNEX distributor routes, and one shared web lookup component mounted in three hosts (catalog tab, quote editor, contract editor).

**Tech Stack:** Hono + Zod (API), Drizzle ORM (Postgres), ioredis (cache), React + Vitest/jsdom (web), Vitest (API).

## Global Constraints

- **No new tables, no migration.** Reuse `pax8Integrations` (credentials) and `pax8ProductMappings` (dedup/linkage), both already partner-axis with RLS. Do not add to `rls-coverage.integration.test.ts`.
- **No AI title cleanup.** Do not add an `aiCleanup` flag for Pax8 (Pax8 names are already clean).
- **Pricing comes from Pax8, not markup.** `costBasis` = Pax8 `partnerBuyRate`; `unitPrice` = Pax8 suggested-retail (user-editable). Do not send `markupPercent`.
- **Partner-axis only.** Search = read permission; import = write permission + MFA, exactly like the EC Express routes.
- **Web mutations use `runAction`** (`apps/web/src/lib/runAction.ts`); 401 defers to the auth redirect, other errors are toasted.
- Money normalized to a 2-decimal string at the client/service boundary; route schemas validate `^-?\d+\.\d{2}$` for cost strings and `z.number().multipleOf(0.01)` for item prices.
- File-size soft cap ~500 lines; follow existing patterns in each file.

---

### Task 1: Pax8 client — product list + pricing

Add product/pricing fetching to the existing client, following the `listSubscriptions`/`normalizeSubscription` style.

**Files:**
- Modify: `apps/api/src/services/pax8Client.ts`
- Test: `apps/api/src/services/pax8Client.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: existing `Pax8Client`, `fetchPaged`, `requestJson`, `firstString`, `firstNumber`, `normalizeMoney`, `asRecord`, `nestedRecord`, `JsonRecord`.
- Produces:
  - `interface Pax8ProductRecord { pax8ProductId: string; name: string; vendorName: string | null; vendorSku: string | null; shortDescription: string | null; raw: JsonRecord }`
  - `interface Pax8ProductPriceRecord { commitmentTerm: string | null; billingTerm: string | null; partnerBuyRate: string | null; suggestedRetailPrice: string | null; currencyCode: string | null; raw: JsonRecord }`
  - `Pax8Client.listProducts(opts?: { limit?: number; vendorName?: string }): Promise<Pax8ProductRecord[]>`
  - `Pax8Client.getProductPricing(productId: string): Promise<Pax8ProductPriceRecord[]>`

- [ ] **Step 1: Write failing tests for the normalizers + methods**

Append to `apps/api/src/services/pax8Client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Pax8Client } from './pax8Client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function clientWithFetch(fetchImpl: (url: string) => Response) {
  return new Pax8Client({
    credentials: { clientId: 'id', clientSecret: 'secret', accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3_600_000) },
    fetch: async (url: string) => fetchImpl(url),
  });
}

describe('Pax8Client.listProducts', () => {
  it('normalizes products from a paged content envelope', async () => {
    const client = clientWithFetch((url) => {
      if (url.includes('/products')) {
        return jsonResponse({
          content: [
            { id: 'p1', name: 'Microsoft 365 Business Premium', vendor: { name: 'Microsoft' }, vendorSku: 'CFQ7' },
            { productId: 'p2', productName: 'Acronis Backup', vendorName: 'Acronis', sku: 'ACR-1' },
          ],
          last: true,
          page: 0,
        });
      }
      return jsonResponse({});
    });
    const rows = await client.listProducts({ limit: 10 });
    expect(rows).toEqual([
      { pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: expect.any(Object) },
      { pax8ProductId: 'p2', name: 'Acronis Backup', vendorName: 'Acronis', vendorSku: 'ACR-1', shortDescription: null, raw: expect.any(Object) },
    ]);
  });
});

describe('Pax8Client.getProductPricing', () => {
  it('normalizes the cost + suggested retail per term', async () => {
    const client = clientWithFetch((url) => {
      if (url.includes('/pricing')) {
        return jsonResponse({
          content: [
            { commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: 18.5, suggestedRetailPrice: 22, currencyCode: 'USD' },
            { commitmentTerm: 'Monthly', billingTerm: 'Monthly', partnerBuyRate: '20', suggestedRetailPrice: '25.00', currency: 'USD' },
          ],
          last: true,
        });
      }
      return jsonResponse({});
    });
    const rows = await client.getProductPricing('p1');
    expect(rows[0]).toEqual({ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD', raw: expect.any(Object) });
    expect(rows[1]).toMatchObject({ commitmentTerm: 'Monthly', partnerBuyRate: '20.00', suggestedRetailPrice: '25.00', currencyCode: 'USD' });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm --filter @breeze/api exec vitest run src/services/pax8Client.test.ts`
Expected: FAIL — `listProducts`/`getProductPricing` are not functions.

- [ ] **Step 3: Implement the normalizers + methods**

In `apps/api/src/services/pax8Client.ts`, add the interfaces near `Pax8SubscriptionRecord` (after line 36):

```ts
export interface Pax8ProductRecord {
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  shortDescription: string | null;
  raw: JsonRecord;
}

export interface Pax8ProductPriceRecord {
  commitmentTerm: string | null;
  billingTerm: string | null;
  partnerBuyRate: string | null;        // OUR cost
  suggestedRetailPrice: string | null;  // end-customer list price
  currencyCode: string | null;
  raw: JsonRecord;
}
```

Add normalizers near `normalizeSubscription` (after line 189):

```ts
function normalizeProduct(value: unknown): Pax8ProductRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = firstString(record, ['id', 'productId', 'product_id']);
  const name = firstString(record, ['name', 'productName', 'product_name']);
  if (!id || !name) return null;
  const vendor = nestedRecord(record, 'vendor');
  return {
    pax8ProductId: id,
    name,
    vendorName: firstString(record, ['vendorName', 'vendor_name']) ?? (vendor ? firstString(vendor, ['name', 'vendorName']) : null),
    vendorSku: firstString(record, ['vendorSku', 'vendor_sku', 'vendorSkuId', 'sku', 'skuId']),
    shortDescription: firstString(record, ['shortDescription', 'short_description', 'description']),
    raw: record,
  };
}

function normalizeProductPrice(value: unknown): Pax8ProductPriceRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    commitmentTerm: firstString(record, ['commitmentTerm', 'commitment_term', 'term']),
    billingTerm: firstString(record, ['billingTerm', 'billing_term', 'period', 'billingPeriod']),
    partnerBuyRate: normalizeMoney(record.partnerBuyRate ?? record.buyRate ?? record.cost ?? record.unitCost ?? null),
    suggestedRetailPrice: normalizeMoney(record.suggestedRetailPrice ?? record.msrp ?? record.retailPrice ?? record.listPrice ?? record.price ?? null),
    currencyCode: firstString(record, ['currencyCode', 'currency']),
    raw: record,
  };
}
```

Add the public methods after `listSubscriptions` (after line 223):

```ts
async listProducts(opts: { limit?: number; vendorName?: string } = {}): Promise<Pax8ProductRecord[]> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (opts.vendorName) query.vendorName = opts.vendorName;
  const rows = await this.fetchPaged('/products', opts.limit, query);
  return rows.map(normalizeProduct).filter((row): row is Pax8ProductRecord => row !== null);
}

async getProductPricing(productId: string): Promise<Pax8ProductPriceRecord[]> {
  const payload = await this.requestJson(`/products/${encodeURIComponent(productId)}/pricing`);
  return extractArray(payload).map(normalizeProductPrice).filter((row): row is Pax8ProductPriceRecord => row !== null);
}
```

Extend `fetchPaged` (line 225) to forward extra query params:

```ts
private async fetchPaged(path: string, limit?: number, extraQuery: Record<string, string | number | boolean | undefined> = {}): Promise<unknown[]> {
  const all: unknown[] = [];
  let page = 0;
  while (page < MAX_PAGES) {
    const payload = await this.requestJson(path, { ...extraQuery, page, size: Math.min(limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) });
    const rows = extractArray(payload);
    all.push(...rows);
    if (limit && all.length >= limit) return all.slice(0, limit);
    const state = extractPageState(payload);
    if (!state.hasNext || rows.length === 0) break;
    page = state.page + 1;
  }
  return all;
}
```

> **Verification item:** confirm the real Pax8 `/v1/products` query params and `/v1/products/{id}/pricing` field names against Pax8 docs. The normalizers already try multiple candidate keys, so a field-name difference only needs an extra key added to the relevant array.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/pax8Client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pax8Client.ts apps/api/src/services/pax8Client.test.ts
git commit -m "feat(pax8): add product list + pricing to the Pax8 API client"
```

---

### Task 2: pax8CatalogService — status, cached search, pricing, import

**Files:**
- Create: `apps/api/src/services/pax8CatalogService.ts`
- Test: `apps/api/src/services/pax8CatalogService.test.ts`

**Interfaces:**
- Consumes: `createPax8ClientForIntegration` (`pax8SyncService.ts`), `Pax8ProductRecord`/`Pax8ProductPriceRecord` (Task 1), `createCatalogItem`/`CatalogActor` (`catalogService.ts`), `getRedis` (`./redis`), `db` (`../db`), `pax8Integrations`/`pax8ProductMappings` (`../db/schema/pax8`).
- Produces:
  - `class Pax8CatalogError extends Error { status: number; code?: string }`
  - `getPax8CatalogStatus(actor): Promise<{ configured: boolean; enabled: boolean }>`
  - `searchPax8Products(input: { q: string; vendor?: string; limit: number }, actor): Promise<Pax8ProductRecord[]>`
  - `getPax8ProductPricing(productId: string, actor): Promise<Pax8ProductPriceRecord[]>`
  - `importPax8CatalogItem(input: Pax8ImportInput, actor): Promise<typeof catalogItems.$inferSelect>` where
    `interface Pax8ImportInput { product: { source: 'pax8'; pax8ProductId: string; name: string; vendorName: string | null; vendorSku: string | null; commitmentTerm: string | null; billingTerm: string | null; partnerBuyRate: string | null; currency: string | null; raw: Record<string, unknown> }; item: { name: string; sku?: string | null; description?: string | null; unitPrice: number; costBasis?: number | null; taxable?: boolean } }`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/pax8CatalogService.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn() },
  createPax8ClientForIntegration: vi.fn(),
  createCatalogItem: vi.fn(),
  getRedis: vi.fn(() => null),
}));

vi.mock('../db', () => ({ db: mocks.db }));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: mocks.createPax8ClientForIntegration }));
vi.mock('./catalogService', async (orig) => ({ ...(await orig<typeof import('./catalogService')>()), createCatalogItem: mocks.createCatalogItem }));
vi.mock('./redis', () => ({ getRedis: mocks.getRedis }));

import { searchPax8Products, importPax8CatalogItem, getPax8CatalogStatus, Pax8CatalogError } from './pax8CatalogService';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
const integration = { id: 'int-1', partnerId: 'p1', isActive: true };

function selectChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows) };
}
function insertChain() {
  return { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([{ id: 'map-1' }]) };
}

beforeEach(() => {
  mocks.db.select.mockReset(); mocks.db.insert.mockReset();
  mocks.createPax8ClientForIntegration.mockReset(); mocks.createCatalogItem.mockReset();
  mocks.getRedis.mockReturnValue(null);
});

describe('searchPax8Products', () => {
  it('filters the partner product list by substring (cache miss path)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createPax8ClientForIntegration.mockResolvedValue({
      integration,
      client: { listProducts: vi.fn().mockResolvedValue([
        { pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} },
        { pax8ProductId: 'p2', name: 'Acronis Backup', vendorName: 'Acronis', vendorSku: 'ACR', shortDescription: null, raw: {} },
      ]) },
    });
    const res = await searchPax8Products({ q: 'microsoft', limit: 20 }, actor);
    expect(res).toHaveLength(1);
    expect(res[0]!.pax8ProductId).toBe('p1');
  });

  it('throws Pax8CatalogError when no active integration', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([]));
    await expect(searchPax8Products({ q: 'x', limit: 20 }, actor)).rejects.toBeInstanceOf(Pax8CatalogError);
  });
});

describe('importPax8CatalogItem', () => {
  it('creates a recurring software catalog item and upserts the product mapping', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-1', name: 'Microsoft 365 Business Premium' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, costBasis: 18.5, taxable: true } }, actor);
    expect(item.id).toBe('item-1');
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg).toMatchObject({ itemType: 'software', billingType: 'recurring', billingFrequency: 'monthly', unitPrice: 22, costBasis: 18.5 });
    expect((arg.attributes as any).pax8.pax8ProductId).toBe('p1');
    expect(mocks.db.insert).toHaveBeenCalled();
  });
});

describe('getPax8CatalogStatus', () => {
  it('reports configured + enabled from the active integration', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    expect(await getPax8CatalogStatus(actor)).toEqual({ configured: true, enabled: true });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm --filter @breeze/api exec vitest run src/services/pax8CatalogService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/pax8CatalogService.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { pax8Integrations, pax8ProductMappings } from '../db/schema/pax8';
import { catalogItems } from '../db/schema/catalog';
import { createPax8ClientForIntegration } from './pax8SyncService';
import { createCatalogItem, type CatalogActor } from './catalogService';
import type { Pax8ProductRecord, Pax8ProductPriceRecord } from './pax8Client';
import { getRedis } from './redis';
import type { CreateCatalogItemInput } from '@breeze/shared';

const CACHE_TTL_SECONDS = 600;
const PRODUCT_FETCH_LIMIT = 5000;

export class Pax8CatalogError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code?: string) {
    super(message);
    this.name = 'Pax8CatalogError';
  }
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) throw new Pax8CatalogError('Partner scope required', 403, 'NO_PARTNER');
  return actor.partnerId;
}

async function getActiveIntegration(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(pax8Integrations)
    .where(and(eq(pax8Integrations.partnerId, partnerId), eq(pax8Integrations.isActive, true)))
    .limit(1);
  return row ?? null;
}

export async function getPax8CatalogStatus(actor: CatalogActor): Promise<{ configured: boolean; enabled: boolean }> {
  const row = await getActiveIntegration(actor);
  return { configured: row !== null, enabled: row !== null };
}

async function loadPartnerProducts(actor: CatalogActor, vendor?: string): Promise<Pax8ProductRecord[]> {
  const integration = await getActiveIntegration(actor);
  if (!integration) throw new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED');

  const partnerId = requirePartner(actor);
  const cacheKey = `pax8:products:${partnerId}${vendor ? `:${vendor.toLowerCase()}` : ''}`;
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as Pax8ProductRecord[];
    } catch { /* cache is best-effort */ }
  }

  const { client } = await createPax8ClientForIntegration(integration.id);
  const products = await client.listProducts({ limit: PRODUCT_FETCH_LIMIT, vendorName: vendor });
  if (redis) {
    try { await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(products)); } catch { /* best-effort */ }
  }
  return products;
}

export async function searchPax8Products(
  input: { q: string; vendor?: string; limit: number },
  actor: CatalogActor,
): Promise<Pax8ProductRecord[]> {
  const needle = input.q.trim().toLowerCase();
  const products = await loadPartnerProducts(actor, input.vendor);
  const matched = products.filter((p) =>
    p.name.toLowerCase().includes(needle) ||
    (p.vendorName?.toLowerCase().includes(needle) ?? false) ||
    (p.vendorSku?.toLowerCase().includes(needle) ?? false));
  return matched.slice(0, input.limit);
}

export async function getPax8ProductPricing(productId: string, actor: CatalogActor): Promise<Pax8ProductPriceRecord[]> {
  const integration = await getActiveIntegration(actor);
  if (!integration) throw new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED');
  const { client } = await createPax8ClientForIntegration(integration.id);
  return client.getProductPricing(productId);
}

export interface Pax8ImportInput {
  product: {
    source: 'pax8';
    pax8ProductId: string;
    name: string;
    vendorName: string | null;
    vendorSku: string | null;
    commitmentTerm: string | null;
    billingTerm: string | null;
    partnerBuyRate: string | null;
    currency: string | null;
    raw: Record<string, unknown>;
  };
  item: {
    name: string;
    sku?: string | null;
    description?: string | null;
    unitPrice: number;
    costBasis?: number | null;
    taxable?: boolean;
  };
}

// Pax8 billing terms map onto the catalog's billing_frequency enum; anything we
// don't recognise falls back to monthly (the safest recurring default).
function mapBillingFrequency(billingTerm: string | null): 'monthly' | 'quarterly' | 'annual' {
  const t = (billingTerm ?? '').toLowerCase();
  if (t.includes('year') || t.includes('annual')) return 'annual';
  if (t.includes('quarter')) return 'quarterly';
  return 'monthly';
}

export async function importPax8CatalogItem(input: Pax8ImportInput, actor: CatalogActor) {
  const integration = await getActiveIntegration(actor);
  if (!integration) throw new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED');
  const { product, item } = input;

  const payload: CreateCatalogItemInput = {
    itemType: 'software',
    name: item.name,
    sku: item.sku ?? product.vendorSku ?? null,
    description: item.description ?? null,
    billingType: 'recurring',
    billingFrequency: mapBillingFrequency(product.billingTerm),
    unitPrice: item.unitPrice,
    costBasis: item.costBasis ?? (product.partnerBuyRate != null ? Number(product.partnerBuyRate) : undefined),
    unitOfMeasure: 'each',
    taxable: item.taxable ?? true,
    isBundle: false,
    attributes: {
      pax8: {
        source: product.source,
        pax8ProductId: product.pax8ProductId,
        vendorName: product.vendorName,
        vendorSku: product.vendorSku,
        commitmentTerm: product.commitmentTerm,
        billingTerm: product.billingTerm,
        currency: product.currency,
        raw: product.raw,
        importedAt: new Date().toISOString(),
      },
    },
  };

  const created = await createCatalogItem(payload, actor);

  // Dedup + linkage so subscription pricing-sync can later reconcile this product.
  await db
    .insert(pax8ProductMappings)
    .values({
      integrationId: integration.id,
      partnerId: integration.partnerId,
      pax8ProductId: product.pax8ProductId,
      vendorSkuId: product.vendorSku,
      productName: product.name,
      catalogItemId: created.id,
    })
    .onConflictDoUpdate({
      target: [pax8ProductMappings.integrationId, pax8ProductMappings.pax8ProductId],
      set: { catalogItemId: created.id, productName: product.name, vendorSkuId: product.vendorSku, updatedAt: new Date() },
    });

  return created;
}
```

> If `CreateCatalogItemInput`'s exact optional-field typing rejects `null` for `sku`/`description`, mirror the EC Express import (`?? undefined`). Adjust to whatever the shared type requires — `importEcExpressCatalogItem` in `tdSynnexEcExpress.ts` is the reference.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/pax8CatalogService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pax8CatalogService.ts apps/api/src/services/pax8CatalogService.test.ts
git commit -m "feat(pax8): add catalog search service (cached live proxy + import)"
```

---

### Task 3: API routes — `/distributors/pax8/*`

**Files:**
- Modify: `apps/api/src/routes/catalog/distributors.ts` (append after the EC Express block, line 298)
- Test: `apps/api/src/routes/catalog/distributors.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: Task 2 service exports, `catalogActorFrom` (`./catalog`), `requireScope`/`requirePermission`/`requireMfa` (`../../middleware/auth`), `PERMISSIONS` (`../../services/permissions`), `CatalogServiceError` (`../../services/catalogService`).
- Produces routes: `GET /distributors/pax8/status`, `GET /distributors/pax8/search`, `GET /distributors/pax8/pricing`, `POST /distributors/pax8/import`. They are auto-mounted via `catalogDistributorRoutes` (`apps/api/src/routes/catalog/index.ts:13`).

- [ ] **Step 1: Write the failing route tests**

Append to `apps/api/src/routes/catalog/distributors.test.ts` (match the file's existing harness; this is the shape):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({
  getPax8CatalogStatus: vi.fn(),
  searchPax8Products: vi.fn(),
  getPax8ProductPricing: vi.fn(),
  importPax8CatalogItem: vi.fn(),
}));
vi.mock('../../services/pax8CatalogService', () => ({ ...svc, Pax8CatalogError: class extends Error { status = 400; code = 'X'; } }));

// Reuse this file's existing app/test-client + auth helpers (see the EC Express tests above).

beforeEach(() => { Object.values(svc).forEach((f) => f.mockReset()); });

describe('GET /catalog/distributors/pax8/search', () => {
  it('returns matched products', async () => {
    svc.searchPax8Products.mockResolvedValue([{ pax8ProductId: 'p1', name: 'Microsoft 365', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} }]);
    const res = await testClient.get('/catalog/distributors/pax8/search?q=micro&limit=20', authHeadersPartner);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
  });

  it('rejects q shorter than 2 chars', async () => {
    const res = await testClient.get('/catalog/distributors/pax8/search?q=m', authHeadersPartner);
    expect(res.status).toBe(400);
  });
});

describe('POST /catalog/distributors/pax8/import', () => {
  it('requires MFA', async () => {
    const res = await testClient.post('/catalog/distributors/pax8/import', { /* valid body */ }, authHeadersPartnerNoMfa);
    expect(res.status).toBe(403);
  });
});
```

> Use whatever app bootstrap + auth-header helpers the existing `distributors.test.ts` already defines (the EC Express tests in the same file are the template). If the file does not yet exist, model it on `apps/api/src/services/tdSynnexEcExpress.test.ts` plus a Hono `app.request` harness used elsewhere in `routes/`.

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/catalog/distributors.test.ts`
Expected: FAIL — routes 404 / handlers undefined.

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/catalog/distributors.ts`, add imports at the top (after line 26):

```ts
import {
  getPax8CatalogStatus,
  searchPax8Products,
  getPax8ProductPricing,
  importPax8CatalogItem,
  Pax8CatalogError,
} from '../../services/pax8CatalogService';
```

Append at the end of the file (after line 298):

```ts
// ─── Pax8 product catalog ─────────────────────────────────────────────────────

const pax8SearchSchema = z.object({
  q: z.string().min(2).max(200),
  vendor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const pax8PricingSchema = z.object({ productId: z.string().min(1).max(64) });

const pax8ProductSchema = z.object({
  source: z.literal('pax8'),
  pax8ProductId: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  vendorName: z.string().max(255).nullable(),
  vendorSku: z.string().max(255).nullable(),
  commitmentTerm: z.string().max(120).nullable(),
  billingTerm: z.string().max(120).nullable(),
  partnerBuyRate: z.string().regex(/^-?\d+\.\d{2}$/).max(30).nullable(),
  currency: z.string().max(10).nullable(),
  raw: z.record(z.string(), z.unknown()).refine(
    (v) => JSON.stringify(v).length <= 200_000,
    { message: 'raw product payload is too large' },
  ),
});

const pax8ImportSchema = z.object({
  product: pax8ProductSchema,
  item: z.object({
    name: z.string().min(1).max(255),
    sku: z.string().max(100).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    unitPrice: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01),
    costBasis: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01).nullable().optional(),
    taxable: z.boolean().optional(),
  }),
});

function handlePax8Error(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof Pax8CatalogError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error('[pax8-catalog] unexpected error', err);
  throw err;
}

catalogDistributorRoutes.get('/distributors/pax8/status', scopes, readPerm, async (c) => {
  try { return c.json({ data: await getPax8CatalogStatus(catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});

catalogDistributorRoutes.get('/distributors/pax8/search', scopes, readPerm, zValidator('query', pax8SearchSchema), async (c) => {
  try { return c.json({ data: await searchPax8Products(c.req.valid('query'), catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});

catalogDistributorRoutes.get('/distributors/pax8/pricing', scopes, readPerm, zValidator('query', pax8PricingSchema), async (c) => {
  try { return c.json({ data: await getPax8ProductPricing(c.req.valid('query').productId, catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});

catalogDistributorRoutes.post('/distributors/pax8/import', scopes, writePerm, requireMfa(), zValidator('json', pax8ImportSchema), async (c) => {
  try { return c.json({ data: await importPax8CatalogItem(c.req.valid('json'), catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/catalog/distributors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/catalog/distributors.ts apps/api/src/routes/catalog/distributors.test.ts
git commit -m "feat(pax8): add /distributors/pax8 status/search/pricing/import routes"
```

---

### Task 4: Web API client — Pax8 functions + types

**Files:**
- Modify: `apps/web/src/lib/api/distributors.ts` (append)

**Interfaces:**
- Consumes: `fetchWithAuth` (`../../stores/auth`), existing `JSON_HEADERS`.
- Produces: `Pax8Product`, `Pax8PriceOption`, `Pax8ImportItem` types; `pax8Status()`, `pax8Search(q, vendor?)`, `pax8Pricing(productId)`, `pax8Import(body)`.

- [ ] **Step 1: Append the client code**

In `apps/web/src/lib/api/distributors.ts`, add at the end:

```ts
const PAX8_BASE = '/catalog/distributors/pax8';

export interface Pax8Product {
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  shortDescription: string | null;
  raw: Record<string, unknown>;
}

export interface Pax8PriceOption {
  commitmentTerm: string | null;
  billingTerm: string | null;
  partnerBuyRate: string | null;        // cost
  suggestedRetailPrice: string | null;  // list price
  currencyCode: string | null;
}

export interface Pax8ImportItem {
  name: string;
  sku: string | null;
  description: string | null;
  unitPrice: number;
  costBasis: number | null;
}

export interface Pax8ImportProduct {
  source: 'pax8';
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  commitmentTerm: string | null;
  billingTerm: string | null;
  partnerBuyRate: string | null;
  currency: string | null;
  raw: Record<string, unknown>;
}

export function pax8Status(): Promise<Response> {
  return fetchWithAuth(`${PAX8_BASE}/status`);
}

export function pax8Search(q: string, vendor?: string): Promise<Response> {
  const params = new URLSearchParams({ q });
  if (vendor) params.set('vendor', vendor);
  return fetchWithAuth(`${PAX8_BASE}/search?${params.toString()}`);
}

export function pax8Pricing(productId: string): Promise<Response> {
  return fetchWithAuth(`${PAX8_BASE}/pricing?productId=${encodeURIComponent(productId)}`);
}

export function pax8Import(body: { product: Pax8ImportProduct; item: Pax8ImportItem }): Promise<Response> {
  return fetchWithAuth(`${PAX8_BASE}/import`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS (no type errors from the new exports).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api/distributors.ts
git commit -m "feat(pax8): web API client for Pax8 catalog search"
```

---

### Task 5: `Pax8ProductLookup` component

The reusable search → per-result term dropdown → sell-price editor → "Import & add" panel. Modeled on `DistributorLookup.tsx`.

**Files:**
- Create: `apps/web/src/components/billing/quotes/Pax8ProductLookup.tsx`
- Test: `apps/web/src/components/billing/quotes/Pax8ProductLookup.test.tsx`

**Interfaces:**
- Consumes: `pax8Search`, `pax8Pricing`, `Pax8Product`, `Pax8PriceOption` (Task 4), `computeMarginBreakdown`/`formatMarginSummary` (`../../settings/marginMath`).
- Produces: default export `Pax8ProductLookup` with props
  `{ blockId: string; busy: boolean; onImportAdd: (product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => void }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/billing/quotes/Pax8ProductLookup.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pax8Search = vi.fn();
const pax8Pricing = vi.fn();
vi.mock('../../../lib/api/distributors', () => ({
  pax8Search: (...a: unknown[]) => pax8Search(...a),
  pax8Pricing: (...a: unknown[]) => pax8Pricing(...a),
}));

import Pax8ProductLookup from './Pax8ProductLookup';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  pax8Search.mockReset(); pax8Pricing.mockReset();
  pax8Search.mockResolvedValue(ok([{ pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} }]));
  pax8Pricing.mockResolvedValue(ok([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD' }]));
});

describe('Pax8ProductLookup', () => {
  it('searches, loads pricing, defaults the sell price to list, and emits on import', async () => {
    const onImportAdd = vi.fn();
    render(<Pax8ProductLookup blockId="b1" busy={false} onImportAdd={onImportAdd} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-b1'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-b1'));
    await waitFor(() => screen.getByTestId('pax8-product-result-p1'));
    // term dropdown populated from pricing
    await waitFor(() => screen.getByTestId('pax8-product-term-p1'));
    const price = screen.getByTestId('pax8-product-price-p1') as HTMLInputElement;
    expect(price.value).toBe('22.00'); // defaults to suggested retail
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    expect(onImportAdd).toHaveBeenCalledTimes(1);
    const [product, term, sell] = onImportAdd.mock.calls[0];
    expect(product.pax8ProductId).toBe('p1');
    expect(term.partnerBuyRate).toBe('18.50');
    expect(sell).toBe(22);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/Pax8ProductLookup.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/billing/quotes/Pax8ProductLookup.tsx`:

```tsx
import { useState } from 'react';
import { pax8Search, pax8Pricing, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
import { computeMarginBreakdown, formatMarginSummary } from '../../settings/marginMath';

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
}

interface Props {
  blockId: string;
  busy: boolean;
  onImportAdd: (product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => void;
}

export default function Pax8ProductLookup({ blockId, busy, onImportAdd }: Props) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Pax8Product[]>([]);
  const [pricing, setPricing] = useState<Record<string, Pax8PriceOption[]>>({});
  const [termIndex, setTermIndex] = useState<Record<string, number>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPricing = async (productId: string) => {
    if (pricing[productId]) return;
    const res = await pax8Pricing(productId);
    const body = (await res.json().catch(() => null)) as { data?: Pax8PriceOption[] } | null;
    const options = body?.data ?? [];
    setPricing((s) => ({ ...s, [productId]: options }));
    setTermIndex((s) => ({ ...s, [productId]: 0 }));
    const first = options[0];
    if (first) setPrices((s) => ({ ...s, [productId]: first.suggestedRetailPrice ?? first.partnerBuyRate ?? '' }));
  };

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = await pax8Search(q);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Search failed.');
        setProducts([]);
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: Pax8Product[] } | null;
      const results = body?.data ?? [];
      setProducts(results);
      await Promise.all(results.map((p) => loadPricing(p.pax8ProductId)));
    } catch {
      setError('Search failed.');
      setProducts([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          placeholder="Product, vendor, or SKU"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }}
          data-testid={`pax8-product-search-${blockId}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          data-testid={`pax8-product-search-btn-${blockId}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <p className="text-xs text-destructive" data-testid={`pax8-product-error-${blockId}`}>{error}</p>}

      {products.map((p) => {
        const options = pricing[p.pax8ProductId] ?? [];
        const idx = termIndex[p.pax8ProductId] ?? 0;
        const term = options[idx];
        const cost = term?.partnerBuyRate != null ? Number(term.partnerBuyRate) : null;
        const priceVal = prices[p.pax8ProductId] ?? '';
        const parsed = toMoney(priceVal);
        const margin = computeMarginBreakdown(cost, parsed);
        return (
          <div key={p.pax8ProductId} data-testid={`pax8-product-result-${p.pax8ProductId}`} className="rounded-md border bg-background/40 p-3 text-sm">
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              {p.vendorName ?? 'Pax8'}{p.vendorSku ? ` · ${p.vendorSku}` : ''}
            </div>
            {options.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Term</label>
                <select
                  value={idx}
                  data-testid={`pax8-product-term-${p.pax8ProductId}`}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setTermIndex((s) => ({ ...s, [p.pax8ProductId]: next }));
                    const opt = options[next];
                    if (opt) setPrices((s) => ({ ...s, [p.pax8ProductId]: opt.suggestedRetailPrice ?? opt.partnerBuyRate ?? '' }));
                  }}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {options.map((o, i) => (
                    <option key={i} value={i}>
                      {[o.commitmentTerm, o.billingTerm].filter(Boolean).join(' / ') || `Option ${i + 1}`}
                      {o.partnerBuyRate ? ` — cost ${o.currencyCode ?? 'USD'} ${o.partnerBuyRate}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Sell price</label>
              <input
                type="number" min="0" step="0.01"
                value={priceVal}
                onChange={(e) => setPrices((s) => ({ ...s, [p.pax8ProductId]: e.target.value }))}
                data-testid={`pax8-product-price-${p.pax8ProductId}`}
                className="h-9 w-28 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => { if (parsed != null && term) onImportAdd(p, term, parsed); }}
                disabled={busy || parsed == null || !term}
                data-testid={`pax8-product-add-${p.pax8ProductId}`}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Import &amp; add
              </button>
            </div>
            {margin && (
              <p className={`mt-1.5 text-xs tabular-nums ${margin.profit < 0 ? 'text-destructive' : 'text-muted-foreground'}`} data-testid={`pax8-product-margin-${p.pax8ProductId}`}>
                {formatMarginSummary(margin, term?.currencyCode ?? 'USD')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/Pax8ProductLookup.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/quotes/Pax8ProductLookup.tsx apps/web/src/components/billing/quotes/Pax8ProductLookup.test.tsx
git commit -m "feat(pax8): Pax8ProductLookup search/term/import component"
```

---

### Task 6: `Pax8CatalogDrawer` component

The modal wrapper around `Pax8ProductLookup` that performs the import and reports the new catalog item. Modeled on `CatalogDistributorDrawer.tsx`.

**Files:**
- Create: `apps/web/src/components/settings/Pax8CatalogDrawer.tsx`
- Test: `apps/web/src/components/settings/Pax8CatalogDrawer.test.tsx`

**Interfaces:**
- Consumes: `pax8Import`, `Pax8Product`, `Pax8PriceOption`, `Pax8ImportProduct` (Task 4), `Pax8ProductLookup` (Task 5), `runAction`/`handleActionError` (`../../lib/runAction`), `showToast` (`../shared/Toast`), `CatalogItem` (`../../lib/api/catalog`).
- Produces: default export `Pax8CatalogDrawer` with props `{ open: boolean; onClose: () => void; onImported: (item: CatalogItem) => void }` — the same `onImported` contract as `CatalogDistributorDrawer`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/Pax8CatalogDrawer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pax8Import = vi.fn();
const pax8Search = vi.fn();
const pax8Pricing = vi.fn();
vi.mock('../../lib/api/distributors', () => ({
  pax8Import: (...a: unknown[]) => pax8Import(...a),
  pax8Search: (...a: unknown[]) => pax8Search(...a),
  pax8Pricing: (...a: unknown[]) => pax8Pricing(...a),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import Pax8CatalogDrawer from './Pax8CatalogDrawer';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  pax8Import.mockReset(); pax8Search.mockReset(); pax8Pricing.mockReset();
  pax8Search.mockResolvedValue(ok([{ pax8ProductId: 'p1', name: 'Microsoft 365', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} }]));
  pax8Pricing.mockResolvedValue(ok([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD' }]));
  pax8Import.mockResolvedValue(ok({ id: 'item-1', name: 'Microsoft 365' }));
});

describe('Pax8CatalogDrawer', () => {
  it('imports the selected product and reports the new item', async () => {
    const onImported = vi.fn();
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-pax8-catalog'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-pax8-catalog'));
    await waitFor(() => screen.getByTestId('pax8-product-add-p1'));
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(pax8Import).toHaveBeenCalled());
    const body = pax8Import.mock.calls[0][0];
    expect(body.product.source).toBe('pax8');
    expect(body.item).toMatchObject({ unitPrice: 22, costBasis: 18.5 });
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' })));
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/settings/Pax8CatalogDrawer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the drawer**

Create `apps/web/src/components/settings/Pax8CatalogDrawer.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { pax8Import, type Pax8Product, type Pax8PriceOption } from '../../lib/api/distributors';
import type { CatalogItem } from '../../lib/api/catalog';
import Pax8ProductLookup from '../billing/quotes/Pax8ProductLookup';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (item: CatalogItem) => void;
}

export default function Pax8CatalogDrawer({ open, onClose, onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  }, [open, onClose, busy]);

  const importAdd = useCallback((product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => {
    void (async () => {
      setBusy(true);
      try {
        const saved = await runAction<CatalogItem>({
          request: () => pax8Import({
            product: {
              source: 'pax8',
              pax8ProductId: product.pax8ProductId,
              name: product.name,
              vendorName: product.vendorName,
              vendorSku: product.vendorSku,
              commitmentTerm: term.commitmentTerm,
              billingTerm: term.billingTerm,
              partnerBuyRate: term.partnerBuyRate,
              currency: term.currencyCode,
              raw: product.raw,
            },
            item: {
              name: product.name,
              sku: product.vendorSku,
              description: product.shortDescription,
              unitPrice: sellPrice,
              costBasis: term.partnerBuyRate != null ? Number(term.partnerBuyRate) : null,
            },
          }),
          errorFallback: 'Could not import the Pax8 product.',
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
        showToast({ message: `Imported "${saved.name}" to the catalog`, type: 'success' });
        onImported(saved);
        onClose();
      } catch (err) {
        handleActionError(err, 'Could not import the Pax8 product.');
      } finally {
        setBusy(false);
      }
    })();
  }, [onImported, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      data-testid="pax8-catalog-modal"
    >
      <div ref={panelRef} className="mt-8 w-full max-w-2xl rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Import from Pax8</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Search the Pax8 catalog, pick a term, set your sell price, and add it to the catalog.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
            data-testid="pax8-catalog-close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="p-5">
          <Pax8ProductLookup blockId="pax8-catalog" busy={busy} onImportAdd={importAdd} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/settings/Pax8CatalogDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/Pax8CatalogDrawer.tsx apps/web/src/components/settings/Pax8CatalogDrawer.test.tsx
git commit -m "feat(pax8): Pax8CatalogDrawer import modal"
```

---

### Task 7: Mount in the catalog add flow (`CatalogItemsTab`)

**Files:**
- Modify: `apps/web/src/components/settings/CatalogItemsTab.tsx`

**Interfaces:**
- Consumes: `Pax8CatalogDrawer` (Task 6), `pax8Status` (Task 4). Mirrors the existing `ecActive` + `CatalogDistributorDrawer` wiring.

- [ ] **Step 1: Add the status gate, button, and drawer**

Add imports near the existing distributor imports:

```tsx
import Pax8CatalogDrawer from './Pax8CatalogDrawer';
import { ecExpressStatus, pax8Status } from '../../lib/api/distributors';
```

Add state next to `distributorOpen`/`ecActive` (near line 43):

```tsx
const [pax8Open, setPax8Open] = useState(false);
const [pax8Active, setPax8Active] = useState(false);
```

Add a status check beside the EC Express one (near line 84):

```tsx
useEffect(() => {
  if (!canWrite) return;
  void (async () => {
    try {
      const res = await pax8Status();
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
      setPax8Active(Boolean(body?.data?.configured && body?.data?.enabled));
    } catch { /* leave hidden */ }
  })();
}, [canWrite]);
```

Add a button beside the TD SYNNEX one (near line 270):

```tsx
{canWrite && pax8Active && (
  <button
    type="button"
    onClick={() => setPax8Open(true)}
    className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
    data-testid="catalog-import-pax8"
  >
    Import from Pax8
  </button>
)}
```

Mount the drawer beside `CatalogDistributorDrawer` (near line 487):

```tsx
<Pax8CatalogDrawer
  open={pax8Open}
  onClose={() => setPax8Open(false)}
  onImported={() => void load('active')}
/>
```

- [ ] **Step 2: Typecheck + run the tab's existing tests**

Run: `pnpm --filter @breeze/web exec tsc --noEmit && pnpm --filter @breeze/web exec vitest run src/components/settings`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/CatalogItemsTab.tsx
git commit -m "feat(pax8): add 'Import from Pax8' to the catalog tab"
```

---

### Task 8: Mount in the contract editor (`ContractEditor`)

Reuse the existing `onDistributorImported` line pre-fill callback (line 184) — the new drawer shares the same `onImported(item: CatalogItem)` contract.

**Files:**
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx`

**Interfaces:**
- Consumes: `Pax8CatalogDrawer` (Task 6), `pax8Status` (Task 4), existing `onDistributorImported`. Gated on `pax8Active` (catalog search needs only the integration, not an org).

- [ ] **Step 1: Add the status gate, button, and drawer**

Add the import beside `CatalogDistributorDrawer` (line 20):

```tsx
import Pax8CatalogDrawer from '../settings/Pax8CatalogDrawer';
```

Add `pax8Status` to the distributors import, and state beside `distributorOpen` (line 102):

```tsx
const [pax8CatalogOpen, setPax8CatalogOpen] = useState(false);
const [pax8Active, setPax8Active] = useState(false);
```

Add a status check inside the existing `can('contracts','write')` effect block (near line 170), or as its own effect:

```tsx
useEffect(() => {
  if (!can('contracts', 'write')) return;
  void (async () => {
    try {
      const res = await pax8Status();
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
      setPax8Active(Boolean(body?.data?.configured && body?.data?.enabled));
    } catch { /* leave hidden */ }
  })();
}, [can]);
```

Add a button in the integrations row (beside the TD SYNNEX `contract-import-distributor` button, near line 592). Note the row's outer gate already includes `ecActive || (pax8IntegrationId && orgId)`; extend it to `|| pax8Active` so the row shows when only Pax8 catalog search is available:

```tsx
{pax8Active && (
  <button
    type="button"
    onClick={() => setPax8CatalogOpen(true)}
    className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition hover:bg-muted"
    data-testid="contract-import-pax8-catalog"
  >
    Add from Pax8 catalog
  </button>
)}
```

Mount the drawer beside `CatalogDistributorDrawer` (near line 783):

```tsx
<Pax8CatalogDrawer
  open={pax8CatalogOpen}
  onClose={() => setPax8CatalogOpen(false)}
  onImported={onDistributorImported}
/>
```

- [ ] **Step 2: Typecheck + run contract tests**

Run: `pnpm --filter @breeze/web exec tsc --noEmit && pnpm --filter @breeze/web exec vitest run src/components/contracts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/contracts/ContractEditor.tsx
git commit -m "feat(pax8): add 'Add from Pax8 catalog' to the contract editor"
```

---

### Task 9: Mount in the quote editor (`QuoteEditor`)

Add a `pax8` line mode beside the existing `distributor` mode; on import, reuse the catalog-import-then-add-line pattern (`importAndAddDistributor`).

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx`

**Interfaces:**
- Consumes: `Pax8ProductLookup` (Task 5), `pax8Status`/`pax8Import` (Task 4), existing `doAddCatalog`/`loadCatalog`/`runScoped`/`runAction`/`resolveCatalogBySku`. Mirrors `importAndAddDistributor` (line 542) and the `distributor` mode (line 1320).

- [ ] **Step 1: Add Pax8 availability state**

Beside the existing `ecActive` state, add:

```tsx
const [pax8Active, setPax8Active] = useState(false);
```

In the effect that loads `ecExpressStatus`, add a parallel `pax8Status()` check:

```tsx
void (async () => {
  try {
    const res = await pax8Status();
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
    setPax8Active(Boolean(body?.data?.configured && body?.data?.enabled));
  } catch { /* leave hidden */ }
})();
```

- [ ] **Step 2: Add the import-and-add handler**

Beside `importAndAddDistributor` (line 542), add:

```tsx
const importAndAddPax8 = useCallback((blockId: string, product: Pax8Product, term: Pax8PriceOption, sellPrice: number) =>
  runScoped(`add-line:${blockId}`, async () => {
    let item = product.vendorSku ? await resolveCatalogBySku(product.vendorSku) : null;
    if (!item) {
      item = await runAction<CatalogItem>({
        request: () => pax8Import({
          product: {
            source: 'pax8', pax8ProductId: product.pax8ProductId, name: product.name,
            vendorName: product.vendorName, vendorSku: product.vendorSku,
            commitmentTerm: term.commitmentTerm, billingTerm: term.billingTerm,
            partnerBuyRate: term.partnerBuyRate, currency: term.currencyCode, raw: product.raw,
          },
          item: {
            name: product.name, sku: product.vendorSku, description: product.shortDescription,
            unitPrice: sellPrice, costBasis: term.partnerBuyRate != null ? Number(term.partnerBuyRate) : null,
          },
        }),
        errorFallback: 'Could not import the Pax8 product.',
        onUnauthorized: UNAUTHORIZED,
        parseSuccess: (d) => (d as { data: CatalogItem }).data,
      });
    }
    await doAddCatalog(blockId, item);
    void loadCatalog();
  }, 'Could not add the Pax8 product.'),
  [doAddCatalog, resolveCatalogBySku, loadCatalog, runScoped]);
```

Add the imports at the top of the file:

```tsx
import Pax8ProductLookup from './Pax8ProductLookup';
import { pax8Status, pax8Import, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
```

- [ ] **Step 3: Add the mode button + panel**

Extend the mode list (line 1320) to include `pax8` when active:

```tsx
{(['catalog', 'manual', ...(ecActive ? ['distributor'] as const : []), ...(pax8Active ? ['pax8'] as const : [])] as const).map((m) => (
  // ...existing button; label:
  // {m === 'catalog' ? 'Catalog item' : m === 'manual' ? 'Manual line' : m === 'distributor' ? 'Search distributor' : 'Search Pax8'}
))}
```

Add the panel beside the `distributor` panel (line 1338):

```tsx
{mode === 'pax8' ? (
  <Pax8ProductLookup
    blockId={block.id}
    busy={addLineBusy}
    onImportAdd={(product, term, sellPrice) => importAndAddPax8(block.id, product, term, sellPrice)}
  />
) : null}
```

- [ ] **Step 4: Typecheck + run quote tests**

Run: `pnpm --filter @breeze/web exec tsc --noEmit && pnpm --filter @breeze/web exec vitest run src/components/billing/quotes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx
git commit -m "feat(pax8): add Pax8 catalog search mode to the quote editor"
```

---

### Task 10: Full suite + manual smoke check

- [ ] **Step 1: Run API + web suites for the touched areas**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/services/pax8Client.test.ts src/services/pax8CatalogService.test.ts src/routes/catalog/distributors.test.ts
pnpm --filter @breeze/web exec vitest run src/components/billing/quotes src/components/settings src/components/contracts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck both packages**

Run: `pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke (requires a partner with an active Pax8 integration)**

With the dev stack up and MFA satisfied:
1. Catalog tab → "Import from Pax8" → search a known vendor (e.g. "Microsoft") → pick a term → confirm cost/list/margin → Import → item appears in the catalog with `attributes.pax8`.
2. Re-import the same product → no duplicate mapping row (upsert), catalog dedup behaves like TD SYNNEX.
3. Quote editor → "Search Pax8" mode → import drops a quote line.
4. Contract editor → "Add from Pax8 catalog" → pre-fills a line; Add Line persists it.

- [ ] **Step 4: Commit any fixes; otherwise the feature is complete.**

---

## Self-Review

**Spec coverage:**
- Live-proxy search + Redis cache → Task 1 (client), Task 2 (`loadPartnerProducts` cache).
- Cost = `partnerBuyRate`, sell = suggested retail, per-term → Task 1 pricing, Task 2 import mapping, Task 5 term dropdown.
- Import into catalog + `pax8ProductMappings` upsert → Task 2.
- Routes (status/search/pricing/import), read vs write+MFA → Task 3.
- Three entry points (catalog/quote/contract) via one shared component → Tasks 5–9.
- No new table / no migration / no AI cleanup → honored across all tasks (Global Constraints).
- RLS unchanged → Task 2 uses existing partner-axis tables; no allowlist change.

**Placeholder scan:** No TBD/TODO; every code step shows full code. The two `>` notes (Pax8 API field-name verification; `CreateCatalogItemInput` null-vs-undefined) are explicit fallbacks with a named reference implementation, not deferred work.

**Type consistency:** `Pax8ProductRecord`/`Pax8ProductPriceRecord` (API) ↔ `Pax8Product`/`Pax8PriceOption` (web) field names align; `onImportAdd(product, term, sellPrice)` signature is identical in Task 5 producer and Tasks 6/9 consumers; import body shape (`product` + `item`) matches `pax8ImportSchema` (Task 3) and `Pax8ImportInput` (Task 2).
