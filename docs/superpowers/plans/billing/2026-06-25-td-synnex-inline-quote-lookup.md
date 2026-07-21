# TD SYNNEX EC Express — inline quote lookup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tech search TD SYNNEX EC Express by SKU inside the quote editor's pricing table, then one-click import the item to the partner catalog and add it as a catalog-sourced quote line.

**Architecture:** Pure frontend. A new thin web API client (`distributors.ts`) wraps the three existing `/catalog/distributors/td-synnex-ec/*` routes (unchanged). The quote editor gains a third add-line mode, "Search distributor", gated on EC Express being configured+enabled and the user having `catalog:write`. A new `DistributorLookup` subcomponent does search → edit sell price → "Import & add", reusing the editor's existing `addCatalog` handler to create the quote line.

**Tech Stack:** Astro + React islands, TypeScript, Vitest + jsdom + Testing Library, `fetchWithAuth`, `runAction`.

## Global Constraints

- Spec: `docs/superpowers/specs/billing/2026-06-25-td-synnex-inline-quote-lookup-design.md`.
- Web mutation handlers MUST wrap POST/PUT/PATCH/DELETE in `runAction` (`apps/web/src/lib/runAction.ts`); the `no-silent-mutations` test guards this.
- Catch pattern: `if (err instanceof ActionError && err.status === 401) return;` then `if (!(err instanceof ActionError)) showToast({ type: 'error', … })` — non-401 ActionError is already toasted by `runAction`.
- DOM hooks for tests use `data-testid` only.
- Route prefix is `/catalog/distributors/td-synnex-ec/…` (mounted under `/catalog`).
- Backend is untouched in this plan.
- EC product shape (`TdSynnexEcProduct`): `{ source:'td_synnex_ec_express', synnexSku, mfgPartNo, status, name, description, currency, cost:number|null, msrp:number|null, discount, totalQty, warehouses, weight, parcelShippable, raw }`.
- Default sell price = `product.msrp ?? product.cost` (matches existing `sellPriceDefault`); markup default is out of scope.
- Run web tests with: `pnpm --filter @breeze/web exec vitest run <path>`.

---

### Task 1: Web API client `distributors.ts`

**Files:**
- Create: `apps/web/src/lib/api/distributors.ts`
- Test: `apps/web/src/lib/api/distributors.test.ts`

**Interfaces:**
- Consumes: `fetchWithAuth` from `../../stores/auth` (returns `Promise<Response>`).
- Produces:
  - `interface EcWarehouseStock { code: string|null; available: number; onOrder: number; bo: number; eta: string|null }`
  - `interface EcProduct { source:'td_synnex_ec_express'; synnexSku: string; mfgPartNo: string|null; status: string|null; name: string; description: string|null; currency: string|null; cost: number|null; msrp: number|null; discount: number|null; totalQty: number|null; warehouses: EcWarehouseStock[]; weight: number|null; parcelShippable: string|null; raw: Record<string, unknown> }`
  - `interface EcStatus { configured: boolean; enabled: boolean; region?: string; settings?: { defaultWarehouse?: string; hideZeroInv?: boolean; defaultMarkupPercent?: number } }`
  - `interface EcImportItem { name: string; sku: string|null; description: string|null; unitPrice: number; costBasis: number|null }`
  - `ecExpressStatus(): Promise<Response>` → `GET /catalog/distributors/td-synnex-ec/status`
  - `ecExpressLookup(q: string): Promise<Response>` → `GET /catalog/distributors/td-synnex-ec/lookup?q=<encoded>`
  - `ecExpressImport(body: { product: EcProduct; item: EcImportItem }): Promise<Response>` → `POST /catalog/distributors/td-synnex-ec/import`
  - `sellPriceDefault(product: EcProduct): string` — `(product.msrp ?? product.cost)` → `.toFixed(2)`, or `''` when both null.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/api/distributors.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { ecExpressStatus, ecExpressLookup, ecExpressImport, sellPriceDefault, type EcProduct } from './distributors';

const product: EcProduct = {
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: 'MFG-1', status: 'Active',
  name: 'Widget', description: 'A widget', currency: 'USD', cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
};

beforeEach(() => { fetchWithAuth.mockReset(); fetchWithAuth.mockResolvedValue(new Response('{}')); });

describe('distributors client', () => {
  it('status hits the status route', async () => {
    await ecExpressStatus();
    expect(fetchWithAuth).toHaveBeenCalledWith('/catalog/distributors/td-synnex-ec/status');
  });

  it('lookup encodes the query', async () => {
    await ecExpressLookup('a b/c');
    expect(fetchWithAuth).toHaveBeenCalledWith('/catalog/distributors/td-synnex-ec/lookup?q=a%20b%2Fc');
  });

  it('import POSTs product + item', async () => {
    await ecExpressImport({ product, item: { name: 'Widget', sku: 'ABC123', description: null, unitPrice: 100, costBasis: 80 } });
    const [url, opts] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/catalog/distributors/td-synnex-ec/import');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).item.unitPrice).toBe(100);
    expect(JSON.parse(opts.body).product.synnexSku).toBe('ABC123');
  });

  it('sellPriceDefault prefers msrp, falls back to cost, then empty', () => {
    expect(sellPriceDefault(product)).toBe('100.00');
    expect(sellPriceDefault({ ...product, msrp: null })).toBe('80.00');
    expect(sellPriceDefault({ ...product, msrp: null, cost: null })).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/api/distributors.test.ts`
Expected: FAIL — cannot resolve `./distributors`.

- [ ] **Step 3: Write the client**

```ts
// apps/web/src/lib/api/distributors.ts
import { fetchWithAuth } from '../../stores/auth';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BASE = '/catalog/distributors/td-synnex-ec';

export interface EcWarehouseStock {
  code: string | null;
  available: number;
  onOrder: number;
  bo: number;
  eta: string | null;
}

export interface EcProduct {
  source: 'td_synnex_ec_express';
  synnexSku: string;
  mfgPartNo: string | null;
  status: string | null;
  name: string;
  description: string | null;
  currency: string | null;
  cost: number | null;
  msrp: number | null;
  discount: number | null;
  totalQty: number | null;
  warehouses: EcWarehouseStock[];
  weight: number | null;
  parcelShippable: string | null;
  raw: Record<string, unknown>;
}

export interface EcStatus {
  configured: boolean;
  enabled: boolean;
  region?: string;
  settings?: { defaultWarehouse?: string; hideZeroInv?: boolean; defaultMarkupPercent?: number };
}

export interface EcImportItem {
  name: string;
  sku: string | null;
  description: string | null;
  unitPrice: number;
  costBasis: number | null;
}

export function ecExpressStatus(): Promise<Response> {
  return fetchWithAuth(`${BASE}/status`);
}

export function ecExpressLookup(q: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/lookup?q=${encodeURIComponent(q)}`);
}

export function ecExpressImport(body: { product: EcProduct; item: EcImportItem }): Promise<Response> {
  return fetchWithAuth(`${BASE}/import`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Default sell price: MSRP, else reseller cost, else blank. Mirrors the
 *  existing TdSynnexEcExpressPanel.sellPriceDefault. */
export function sellPriceDefault(product: EcProduct): string {
  const value = product.msrp ?? product.cost;
  return value === null || value === undefined ? '' : value.toFixed(2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/api/distributors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/distributors.ts apps/web/src/lib/api/distributors.test.ts
git commit -m "feat(web): distributors API client for TD SYNNEX EC Express lookup"
```

---

### Task 2: `DistributorLookup` subcomponent

**Files:**
- Create: `apps/web/src/components/billing/quotes/DistributorLookup.tsx`
- Test: `apps/web/src/components/billing/quotes/DistributorLookup.test.tsx`

**Interfaces:**
- Consumes: `ecExpressLookup`, `sellPriceDefault`, `type EcProduct` from `../../../lib/api/distributors`.
- Produces a default-exported component:
  ```ts
  interface DistributorLookupProps {
    blockId: string;
    busy: boolean;
    onImportAdd: (product: EcProduct, sellPrice: number) => void; // parent does import+addLine
  }
  ```
  - Search input `data-testid={`quote-distributor-search-${blockId}`}` + submit button `quote-distributor-search-btn-${blockId}`.
  - Each result row `data-testid={`quote-distributor-result-${product.synnexSku}`}` with an editable price input `quote-distributor-price-${product.synnexSku}` (prefilled via `sellPriceDefault`) and an "Import & add" button `quote-distributor-add-${product.synnexSku}`.
  - "Import & add" is disabled when `busy` or the price doesn't parse to a finite ≥0 number; on click calls `onImportAdd(product, parsedPrice)`.
  - Lookup itself is a read (no mutation) → call `ecExpressLookup` directly; on non-ok response show an inline error message `quote-distributor-error-${blockId}` (do NOT use runAction — it's a GET).

**Note on the parsed-price guard:** reuse a local `toMoney(value: string): number | null` (trim → `Number` → `Number.isFinite` → `Number(parsed.toFixed(2))`), identical to the panel's helper.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/billing/quotes/DistributorLookup.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ecExpressLookup = vi.fn();
vi.mock('../../../lib/api/distributors', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/distributors')>()),
  ecExpressLookup: (...a: unknown[]) => ecExpressLookup(...a),
}));

import DistributorLookup from './DistributorLookup';
import type { EcProduct } from '../../../lib/api/distributors';

const product: EcProduct = {
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: 'MFG-1', status: 'Active',
  name: 'Widget', description: 'A widget', currency: 'USD', cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
};
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => { ecExpressLookup.mockReset(); });

describe('DistributorLookup', () => {
  it('searches and lists results with a prefilled price', async () => {
    ecExpressLookup.mockResolvedValue(ok([product]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-result-ABC123'));
    expect((screen.getByTestId('quote-distributor-price-ABC123') as HTMLInputElement).value).toBe('100.00');
  });

  it('calls onImportAdd with the (possibly edited) price', async () => {
    ecExpressLookup.mockResolvedValue(ok([product]));
    const onImportAdd = vi.fn();
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={onImportAdd} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-result-ABC123'));
    fireEvent.change(screen.getByTestId('quote-distributor-price-ABC123'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    expect(onImportAdd).toHaveBeenCalledWith(product, 120);
  });

  it('shows an inline error when lookup fails', async () => {
    ecExpressLookup.mockResolvedValue(new Response('{"error":"nope"}', { status: 500 }));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-error-b1'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/DistributorLookup.test.tsx`
Expected: FAIL — cannot resolve `./DistributorLookup`.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/billing/quotes/DistributorLookup.tsx
import { useState } from 'react';
import { ecExpressLookup, sellPriceDefault, type EcProduct } from '../../../lib/api/distributors';

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
}

interface DistributorLookupProps {
  blockId: string;
  busy: boolean;
  onImportAdd: (product: EcProduct, sellPrice: number) => void;
}

export default function DistributorLookup({ blockId, busy, onImportAdd }: DistributorLookupProps) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<EcProduct[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = await ecExpressLookup(q);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Lookup failed.');
        setProducts([]);
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: EcProduct[] } | null;
      const results = body?.data ?? [];
      setProducts(results);
      setPrices(Object.fromEntries(results.map((p) => [p.synnexSku, sellPriceDefault(p)])));
    } catch {
      setError('Lookup failed.');
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
          placeholder="SYNNEX SKU or mfg part #"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }}
          data-testid={`quote-distributor-search-${blockId}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          data-testid={`quote-distributor-search-btn-${blockId}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-destructive" data-testid={`quote-distributor-error-${blockId}`}>{error}</p>
      )}

      {products.map((p) => {
        const priceVal = prices[p.synnexSku] ?? '';
        const parsed = toMoney(priceVal);
        return (
          <div key={p.synnexSku} data-testid={`quote-distributor-result-${p.synnexSku}`} className="rounded-md border bg-background/40 p-3 text-sm">
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              SKU {p.synnexSku}{p.status ? ` · ${p.status}` : ''}
              {p.cost != null ? ` · cost ${p.currency ?? 'USD'} ${p.cost.toFixed(2)}` : ''}
              {p.msrp != null ? ` · MSRP ${p.msrp.toFixed(2)}` : ''}
              {p.totalQty != null ? ` · ${p.totalQty} avail` : ''}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Sell price</label>
              <input
                type="number" min="0" step="0.01"
                value={priceVal}
                onChange={(e) => setPrices((s) => ({ ...s, [p.synnexSku]: e.target.value }))}
                data-testid={`quote-distributor-price-${p.synnexSku}`}
                className="h-9 w-28 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => { if (parsed != null) onImportAdd(p, parsed); }}
                disabled={busy || parsed == null}
                data-testid={`quote-distributor-add-${p.synnexSku}`}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Import &amp; add
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/DistributorLookup.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/quotes/DistributorLookup.tsx apps/web/src/components/billing/quotes/DistributorLookup.test.tsx
git commit -m "feat(web): DistributorLookup subcomponent for quote editor"
```

---

### Task 3: Parent handler `importAndAddDistributor` + EC-active gate in `QuoteEditor`

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx`
- Test: `apps/web/src/components/billing/quotes/QuoteEditor.distributor.test.tsx` (new)

**Interfaces:**
- Consumes: `ecExpressStatus`, `ecExpressImport`, `type EcProduct` from `../../../lib/api/distributors`; existing `addCatalogLine` from `../../../lib/api/quotes`; existing `listCatalog`, `type CatalogItem` from `../../../lib/api/catalog`; existing `runAction`, `handleActionError`; existing `can` from `usePermissions`.
- Produces (passed down to `BlockCard` in Task 4):
  - `ecActive: boolean` — `status.configured && status.enabled && can('catalog','write')`.
  - `onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void`.

**Handler behavior:** wrap `ecExpressImport` in `runAction` (it's a POST). On success, parse the returned `{ data: CatalogItem }` and add a catalog line via the no-guard `doAddCatalog(blockId, item)`. On an `ActionError` with `code === 'DUPLICATE_SKU'` (confirmed: `CatalogServiceError('…SKU already exists', 409, 'DUPLICATE_SKU')` in `catalogService.ts`; `ActionError` exposes `.code` and `.status`), resolve the existing item by SKU and add it instead. Refresh catalog after success.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/billing/quotes/QuoteEditor.distributor.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ecExpressStatus = vi.fn();
const ecExpressImport = vi.fn();
const addCatalogLine = vi.fn();
const listCatalog = vi.fn();

vi.mock('../../../lib/api/distributors', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/distributors')>()),
  ecExpressStatus: (...a: unknown[]) => ecExpressStatus(...a),
  ecExpressImport: (...a: unknown[]) => ecExpressImport(...a),
}));
vi.mock('../../../lib/api/quotes', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/quotes')>()),
  addCatalogLine: (...a: unknown[]) => addCatalogLine(...a),
}));
vi.mock('../../../lib/api/catalog', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/catalog')>()),
  listCatalog: (...a: unknown[]) => listCatalog(...a),
}));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail } from './quoteTypes';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const newItem = { id: 'cat-1', sku: 'ABC123', name: 'Widget', unitPrice: '120.00', isBundle: false };

// Minimal detail with one line_items block.
const detail: QuoteDetail = {
  quote: { id: 'q1', currencyCode: 'USD', termsAndConditions: '', status: 'draft' } as never,
  blocks: [{ id: 'blk1', blockType: 'line_items', sortOrder: 0, content: {} } as never],
  lines: [],
};

beforeEach(() => {
  ecExpressStatus.mockResolvedValue(ok({ configured: true, enabled: true }));
  listCatalog.mockResolvedValue(ok([]));
  ecExpressImport.mockResolvedValue(ok(newItem));
  addCatalogLine.mockResolvedValue(ok({ id: 'line-1' }));
});

describe('QuoteEditor distributor mode', () => {
  it('shows the distributor mode when EC Express is active', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-line-mode-blk1-distributor'));
  });

});
```

> This task only needs the **mode-visible gate** test. The full import→addCatalogLine flow (which also mocks `ecExpressLookup`) is added in Task 4 once the panel renders — don't write a vacuous wiring test here.

- [ ] **Step 2: Wire the gate + handler in `QuoteEditor`**

Add imports near the existing api imports (around line 14–16). `ActionError` is
already exported from `runAction`; import it alongside the existing
`runAction`/`handleActionError`:

```tsx
import { runAction, handleActionError, ActionError } from '../../../lib/runAction';
import { ecExpressStatus, ecExpressImport, type EcProduct } from '../../../lib/api/distributors';
```

Add state + status load next to the existing catalog load (after `loadCatalog`, ~line 105):

```tsx
const [ecActive, setEcActive] = useState(false);
const canCatalogWrite = can('catalog', 'write');

const loadEcStatus = useCallback(async () => {
  if (!canCatalogWrite) { setEcActive(false); return; }
  const res = await ecExpressStatus();
  if (!res.ok) return; // optional context; never block the editor
  const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
  setEcActive(Boolean(body?.data?.configured && body?.data?.enabled));
}, [canCatalogWrite]);

useEffect(() => { void loadEcStatus(); }, [loadEcStatus]);
```

**(a)** First refactor the existing `addCatalog` (~line 214) into a guard-free
core `doAddCatalog` + a public `addCatalog` wrapper, so the new handler can reuse
the line-insert without tripping the inner `if (busy) return;`:

```tsx
const doAddCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
  await runAction({
    request: () => addCatalogLine(quote.id, { catalogItemId: item.id, quantity: 1, blockId }),
    errorFallback: 'Could not add the catalog item.',
    successMessage: 'Item added',
    onUnauthorized: UNAUTHORIZED,
  });
  refresh();
}, [quote.id, refresh]);

const addCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
  if (busy) return;
  setBusy(true);
  try { await doAddCatalog(blockId, item); }
  catch (err) { handleActionError(err, 'Could not add the catalog item.'); }
  finally { setBusy(false); }
}, [busy, doAddCatalog]);
```

**(b)** Add a `resolveCatalogBySku` helper (used by the duplicate-SKU fallback):

```tsx
const resolveCatalogBySku = useCallback(async (sku: string): Promise<CatalogItem | null> => {
  const fromState = catalog.find((i) => i.sku === sku);
  if (fromState) return fromState;
  const res = await listCatalog({ search: sku, isActive: true, limit: 200 });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
  return (body?.data ?? []).find((i) => i.sku === sku) ?? null;
}, [catalog]);
```

**(c)** Add the import-and-add handler. It calls `doAddCatalog` (not the public
`addCatalog`) so the outer `busy` guard owns the lifecycle. The catch branches
**only** on the confirmed `DUPLICATE_SKU` code; anything else is surfaced:

```tsx
const importAndAddDistributor = useCallback(async (blockId: string, product: EcProduct, sellPrice: number) => {
  if (busy) return;
  setBusy(true);
  try {
    let item: CatalogItem;
    try {
      item = await runAction<CatalogItem>({
        request: () => ecExpressImport({
          product,
          item: {
            name: product.name,
            sku: product.synnexSku || product.mfgPartNo || null,
            description: product.description ?? null,
            unitPrice: sellPrice,
            costBasis: product.cost != null && Number.isFinite(product.cost) ? Number(product.cost.toFixed(2)) : null,
          },
        }),
        errorFallback: 'Could not import the distributor item.',
        // no success toast here — the "Item added" toast from doAddCatalog is the meaningful one
        onUnauthorized: UNAUTHORIZED,
        parseSuccess: (d) => (d as { data: CatalogItem }).data,
      });
    } catch (err) {
      // Already in the catalog → resolve the existing item and add that line.
      if (err instanceof ActionError && err.code === 'DUPLICATE_SKU') {
        const existing = await resolveCatalogBySku(product.synnexSku);
        if (existing) { await doAddCatalog(blockId, existing); void loadCatalog(); return; }
      }
      handleActionError(err, 'Could not import the distributor item.');
      return;
    }
    await doAddCatalog(blockId, item);
    void loadCatalog(); // surface the new item in the catalog picker too
  } finally {
    setBusy(false);
  }
}, [busy, doAddCatalog, resolveCatalogBySku, loadCatalog]);
```

**(d)** Pass the two new props into the `BlockCard` render (Task 4 consumes
them): add `ecActive={ecActive}` and `onImportAddDistributor={importAndAddDistributor}`
to the `<BlockCard … />` element.

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuoteEditor.distributor.test.tsx`
Expected: PASS — the "distributor mode visible when EC active" gate test is green. (BlockCard doesn't render the mode button until Task 4, so this passes once the gate + props are wired and the existing manual/catalog modes still render. If the mode button isn't visible yet because BlockCard is unchanged, this single gate test is allowed to stay red until Task 4 — note it and proceed.)

> Sequencing note: the `quote-line-mode-blk1-distributor` button is added in Task 4. If you prefer strict red→green per task, move the gate assertion to Task 4 and have Task 3 assert only that `ecExpressStatus` was called on mount (`await waitFor(() => expect(ecExpressStatus).toHaveBeenCalled())`). Either is fine; pick one and keep the suite green at each commit.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.distributor.test.tsx
git commit -m "feat(web): EC Express gate + import-and-add handler in QuoteEditor"
```

---

### Task 4: Render the third mode in `BlockCard`

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (the `BlockCard` function, ~lines 486–705)
- Test: extend `apps/web/src/components/billing/quotes/QuoteEditor.distributor.test.tsx`

**Interfaces:**
- Consumes (new `BlockCard` props): `ecActive: boolean`, `onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void`.
- Produces: a third mode button `quote-line-mode-${block.id}-distributor` and the `DistributorLookup` panel when that mode is selected.

- [ ] **Step 1: Extend the test**

Add to `QuoteEditor.distributor.test.tsx` (drive the full path; also mock `ecExpressLookup`):

```tsx
// add to the top-level distributors mock:
//   ecExpressLookup: (...a) => ecExpressLookup(...a)
// and `const ecExpressLookup = vi.fn();` with the others.

it('full import & add flow from the distributor panel', async () => {
  ecExpressLookup.mockResolvedValue(ok([{
    source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: null, status: 'Active',
    name: 'Widget', description: null, currency: 'USD', cost: 80, msrp: 100, discount: null,
    totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
  }]));
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => screen.getByTestId('quote-line-mode-blk1-distributor'));
  fireEvent.click(screen.getByTestId('quote-line-mode-blk1-distributor'));
  fireEvent.change(screen.getByTestId('quote-distributor-search-blk1'), { target: { value: 'ABC123' } });
  fireEvent.click(screen.getByTestId('quote-distributor-search-btn-blk1'));
  await waitFor(() => screen.getByTestId('quote-distributor-add-ABC123'));
  fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
  await waitFor(() => expect(ecExpressImport).toHaveBeenCalled());
  expect(addCatalogLine).toHaveBeenCalledWith('q1', expect.objectContaining({ catalogItemId: 'cat-1', blockId: 'blk1' }));
});

it('hides the distributor mode when EC Express is inactive', async () => {
  ecExpressStatus.mockResolvedValue(ok({ configured: true, enabled: false }));
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => screen.getByTestId('quote-block-add-line-blk1'));
  expect(screen.queryByTestId('quote-line-mode-blk1-distributor')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuoteEditor.distributor.test.tsx`
Expected: FAIL — no `quote-line-mode-blk1-distributor` element.

- [ ] **Step 3: Modify `BlockCard`**

Add the new props to `BlockCard`'s signature/type (alongside `onAddCatalog` etc.):

```tsx
  ecActive, onImportAddDistributor,
```
```tsx
  ecActive: boolean;
  onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void;
```

Import `DistributorLookup` and `EcProduct` at the top of the file:

```tsx
import DistributorLookup from './DistributorLookup';
// EcProduct comes from the distributors import added in Task 3
```

Widen the mode state and the mode-button list. Replace:

```tsx
const [mode, setMode] = useState<'catalog' | 'manual'>('catalog');
```
with:
```tsx
const [mode, setMode] = useState<'catalog' | 'manual' | 'distributor'>('catalog');
```

Replace the mode-button map (lines ~617–629). The available modes depend on `ecActive`:

```tsx
{(['catalog', 'manual', ...(ecActive ? ['distributor'] as const : [])] as const).map((m) => (
  <button
    key={m}
    type="button"
    onClick={() => setMode(m)}
    data-testid={`quote-line-mode-${block.id}-${m}`}
    className={`rounded-md border px-3 py-1 text-xs font-medium ${
      mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
    }`}
  >
    {m === 'catalog' ? 'Catalog item' : m === 'manual' ? 'Manual line' : 'Search distributor'}
  </button>
))}
```

Add the distributor panel branch. After the existing `mode === 'catalog' ? (…) : (… manual …)` ternary, restructure to handle three modes. Simplest: change the outer ternary to an explicit conditional block:

```tsx
{mode === 'distributor' ? (
  <DistributorLookup
    blockId={block.id}
    busy={busy}
    onImportAdd={(product, sellPrice) => onImportAddDistributor(block.id, product, sellPrice)}
  />
) : mode === 'catalog' ? (
  /* …existing catalog picker JSX unchanged… */
) : (
  /* …existing manual-line JSX unchanged… */
)}
```

Finally, pass the props from the parent map (in the `sortedBlocks.map(...)` render) — already added in Task 3 Step 3.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuoteEditor.distributor.test.tsx`
Expected: PASS — full flow + inactive-hide both green.

- [ ] **Step 5: Typecheck + full web suite for the touched files**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes src/lib/api/distributors.test.ts`
Expected: 0 type errors; all quote + client tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.distributor.test.tsx
git commit -m "feat(web): render Search-distributor mode in quote pricing block"
```

---

### Task 5: Guard rails — `no-silent-mutations` + astro check

**Files:**
- Possibly modify: `apps/web/src/lib/runActionAllowlist.ts` (only if the new file trips the guard)
- Verify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces:** none produced.

- [ ] **Step 1: Run the guard test**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS. The new mutation (`ecExpressImport`) is invoked **through `runAction`** in `QuoteEditor`, so it should pass without an allowlist entry. The `DistributorLookup` lookup is a GET (not a mutation) and must not be flagged.

- [ ] **Step 2: If it fails**, read the failure. If it flags `distributors.ts` because `ecExpressImport` is a bare POST helper (the guard may scan api modules), add a one-line allowlist entry in `apps/web/src/lib/runActionAllowlist.ts` with a comment that the caller (`QuoteEditor.importAndAddDistributor`) wraps it in `runAction`. Re-run.

- [ ] **Step 3: Astro check**

Run: `cd apps/web && pnpm astro check`
Expected: 0 errors (matches the repo's CI gate; `tsc` alone skips `.astro`).

- [ ] **Step 4: Commit (only if a file changed)**

```bash
git add apps/web/src/lib/runActionAllowlist.ts
git commit -m "test(web): allowlist EC Express import helper (wrapped by runAction in QuoteEditor)"
```

---

## Self-Review

**Spec coverage:**
- Thin client `distributors.ts` → Task 1. ✓
- Third `distributor` mode gated on active+permission → Tasks 3 (gate) + 4 (render). ✓
- `DistributorLookup` subcomponent → Task 2. ✓
- Import→addCatalogLine happy path → Task 3 handler + Task 4 full-flow test. ✓
- Duplicate-SKU fallback (resolve by `search`, match `item.sku`) → Task 3 `resolveCatalogBySku`. ✓
- MFA 403 → handled by `runAction`/`handleActionError` (ActionError 401 redirect + non-401 toast); EC errors surfaced. ✓
- Default sell price `msrp ?? cost` → Task 1 `sellPriceDefault`. ✓
- `runAction` for mutations / `no-silent-mutations` green → Task 5. ✓
- Tests for hidden-when-inactive, lookup render, import-then-add, dup-SKU, 403 → Tasks 2–4. ✓

**Placeholder scan:** no `TODO`/`TBD` in code steps. Task 3's gate test and Task 4's full-flow test are both concrete; the Task-3/Task-4 sequencing of the mode-button assertion is called out explicitly with two valid orderings.

**Type consistency:** `EcProduct`, `EcImportItem`, `EcStatus`, `sellPriceDefault`, `ecExpressStatus/Lookup/Import` names are consistent across Tasks 1→4. `doAddCatalog`/`addCatalog`/`importAndAddDistributor`/`resolveCatalogBySku` consistent within Tasks 3/4. `onImportAdd` (child prop on `DistributorLookup`) vs `onImportAddDistributor` (parent→`BlockCard` prop) are intentionally distinct and wired in Task 4.

**Resolved before drafting (no open unknowns):** `ActionError` exposes `.code`/`.status` (`runAction.ts:4-13`); the duplicate-SKU code is `'DUPLICATE_SKU'` / 409 (`catalogService.ts:120,201`); the distributor routes live under `/catalog/distributors/td-synnex-ec/*`; the `status` payload includes `settings.defaultMarkupPercent` but v1 mirrors the panel's `msrp ?? cost` default.
