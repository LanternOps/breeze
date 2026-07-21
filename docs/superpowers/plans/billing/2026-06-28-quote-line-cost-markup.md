# Quote builder cost / markup% / net profit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a quote builder see and drive per-line cost, markup%, SKU, part#, and net profit inside the editor, with a net-profit summary in the rail — never exposed to the customer.

**Architecture:** Snapshot `unit_cost` / `sku` / `part_number` onto `quote_lines` at add-time (editable after). Add pure markup/profit helpers to the shared quote-math module so the editor's optimistic rail and any server use share one implementation. Surface the data in a compact internal strip beneath each pricing row and a "Margin" section in the live-totals rail; both gated to the editor surface only.

**Tech Stack:** PostgreSQL + Drizzle, Zod (`@breeze/shared`), Hono API, Astro + React (web), Vitest.

## Global Constraints

- **Internal-only:** `unit_cost`, markup%, and net profit must never appear in `QuoteDocument`, the PDF, or the public/portal/accept payloads. Markup% and net are derived (never persisted).
- **Net excludes tax** (tax is pass-through). Net is over **billed (`customerVisible`) lines** only.
- **Markup% = (price − cost) / cost.** Cost is the fixed base; editing markup% sets unit price.
- **Money is `numeric(12,2)` strings** end to end; cents math via the existing `toCents`/`fromCents`/`roundHalfUp` discipline in `quoteMath.ts`. Never round unitPrice before multiplying.
- **Migrations:** idempotent (`IF NOT EXISTS`), never edit a shipped migration, no inner `BEGIN/COMMIT`. This migration must sort AFTER `2026-07-03-quote-invoice-line-name.sql`.
- **Sequencing:** shares files with the in-flight line-name feature (`quoteTypes.ts`, `QuoteEditor.tsx`, schema, validators). Land after that settles / rebased on it.
- Run web tests with `cd apps/web && npx vitest run <path>`; shared with `cd packages/shared && npx vitest run <path>`; API with `pnpm test --filter=@breeze/api -- <path>`.

---

### Task 1: Migration — add cost/identifier columns to `quote_lines`

**Files:**
- Create: `apps/api/migrations/2026-07-04-quote-line-cost-identifiers.sql`

**Interfaces:**
- Produces: `quote_lines.unit_cost numeric(12,2) null`, `quote_lines.sku varchar(100) null`, `quote_lines.part_number varchar(100) null`.

- [ ] **Step 1: Write the migration**

```sql
-- Internal builder economics: per-line cost + identifier snapshots on quote_lines.
-- Internal-only — never serialized to the customer document / portal payload.
-- Nullable: a manual line may carry no cost (unknown), and legacy lines have none.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS sku varchar(100);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS part_number varchar(100);
```

- [ ] **Step 2: Apply + verify it's idempotent**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift (schema in Task 2 matches). Re-applying the migration is a no-op (the `IF NOT EXISTS` guards).

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-07-04-quote-line-cost-identifiers.sql
git commit -m "feat(quotes): add unit_cost/sku/part_number to quote_lines"
```

---

### Task 2: Drizzle schema + client types

**Files:**
- Modify: `apps/api/src/db/schema/quotes.ts` (the `quoteLines` pgTable)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts` (the `QuoteLine` interface)
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (the `LineUpdate` type)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `QuoteLine.unitCost: string | null`, `QuoteLine.sku: string | null`, `QuoteLine.partNumber: string | null`; `LineUpdate` gains `unitCost?: number | null`, `sku?: string | null`, `partNumber?: string | null`.

- [ ] **Step 1: Add columns to the Drizzle table**

In `quoteLines` (after `billingFrequency`, before `sortOrder`):

```ts
  // Internal builder economics — never serialized to the customer document.
  unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
  sku: varchar('sku', { length: 100 }),
  partNumber: varchar('part_number', { length: 100 }),
```

- [ ] **Step 2: Add fields to the client `QuoteLine` type**

In `quoteTypes.ts`, in `interface QuoteLine` (after `parentLineId`):

```ts
  /** Internal-only economics/identifiers (builder view); never on the customer doc. */
  unitCost: string | null;
  sku: string | null;
  partNumber: string | null;
```

- [ ] **Step 3: Extend `LineUpdate` in the editor**

In `QuoteEditor.tsx`, the `LineUpdate` type:

```ts
type LineUpdate = Partial<{
  name: string | null;
  description: string | null;
  quantity: number;
  unitPrice: number;
  taxable: boolean;
  recurrence: QuoteLineRecurrence;
  unitCost: number | null;
  sku: string | null;
  partNumber: string | null;
}>;
```

- [ ] **Step 4: Verify drift-free**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/quotes.ts apps/web/src/components/billing/quotes/quoteTypes.ts apps/web/src/components/billing/quotes/QuoteEditor.tsx
git commit -m "feat(quotes): schema + client types for line cost/sku/part#"
```

---

### Task 3: Validators — accept cost/sku/part# on add + update

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts`
- Test: `packages/shared/src/validators/quotes.test.ts`

**Interfaces:**
- Consumes: existing `money` (≥0 numeric-string), `quoteLineInputSchema`, `updateQuoteLineSchema`, `catalogQuoteLineSchema`.
- Produces: those schemas accept optional `unitCost` (money|null), `sku` (≤100|null), `partNumber` (≤100|null); `catalogQuoteLineSchema` accepts optional `partNumber`.

- [ ] **Step 1: Write the failing test**

In `quotes.test.ts`:

```ts
import { quoteLineInputSchema, updateQuoteLineSchema, catalogQuoteLineSchema } from './quotes';

it('manual line accepts cost/sku/partNumber', () => {
  const r = quoteLineInputSchema.safeParse({
    sourceType: 'manual', name: 'Widget', quantity: '1', unitPrice: '10', taxable: false,
    unitCost: '6.50', sku: 'WID-1', partNumber: 'MPN-9',
  });
  expect(r.success).toBe(true);
});
it('update line accepts cost/sku/partNumber and rejects negative cost', () => {
  expect(updateQuoteLineSchema.safeParse({ unitCost: '6.50', sku: 'X', partNumber: 'Y' }).success).toBe(true);
  expect(updateQuoteLineSchema.safeParse({ unitCost: '-1' }).success).toBe(false);
});
it('catalog line accepts an optional partNumber override', () => {
  expect(catalogQuoteLineSchema.safeParse({ catalogItemId: '00000000-0000-0000-0000-000000000001', quantity: '1', partNumber: 'MPN-1' }).success).toBe(true);
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `cd packages/shared && npx vitest run src/validators/quotes.test.ts`
Expected: FAIL (schemas strip/reject the new keys).

- [ ] **Step 3: Extend the schemas**

In `quoteLineInputSchema` object (before the `.refine`), add:

```ts
  unitCost: money.nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  partNumber: z.string().max(100).nullable().optional(),
```

In `updateQuoteLineSchema`, add the same three lines.

In `catalogQuoteLineSchema`, add `partNumber: z.string().max(100).nullable().optional()` (used by the distributor-import add path to snapshot the mfg part#).

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd packages/shared && npx vitest run src/validators/quotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.test.ts
git commit -m "feat(quotes): validators accept line cost/sku/part#"
```

---

### Task 4: Shared math — markup, price-from-markup, net profit

**Files:**
- Modify: `packages/shared/src/utils/quoteMath.ts`
- Test: `packages/shared/src/utils/quoteMath.test.ts`

**Interfaces:**
- Consumes: `toCents`, `fromCents`, `roundHalfUp`, `computeLineTotal`, `QuoteLineForMath`.
- Produces:
  - `markupPct(price, cost): number | null`
  - `priceFromMarkup(cost, markupPct: number): string`
  - `QuoteLineForMath.unitCost?: string | null`
  - `interface QuoteProfit { oneTimeNet, monthlyRecurringNet, annualRecurringNet, totalCost: string; linesMissingCost: number }`
  - `computeQuoteProfit(lines: QuoteLineForMath[]): QuoteProfit`

- [ ] **Step 1: Write the failing tests**

In `quoteMath.test.ts`:

```ts
import { markupPct, priceFromMarkup, computeQuoteProfit } from './quoteMath';

it('markupPct: (price-cost)/cost, null when cost absent/zero', () => {
  expect(markupPct('130', '100')).toBeCloseTo(30);
  expect(markupPct('130', null)).toBeNull();
  expect(markupPct('130', '0')).toBeNull();
});
it('priceFromMarkup: cost*(1+m), cent-rounded', () => {
  expect(priceFromMarkup('100', 30)).toBe('130.00');
  expect(priceFromMarkup('9.99', 50)).toBe('14.99'); // 14.985 -> 14.99
});
it('computeQuoteProfit: net by cadence, excl tax, billed-only, flags missing cost', () => {
  const line = (o: Partial<import('./quoteMath').QuoteLineForMath>) => ({
    quantity: '1', unitPrice: '0', taxable: false, customerVisible: true, recurrence: 'one_time' as const, ...o,
  });
  const r = computeQuoteProfit([
    line({ unitPrice: '130', unitCost: '100' }),                       // one-time net 30
    line({ unitPrice: '40', unitCost: '25', recurrence: 'monthly' }),  // monthly net 15
    line({ unitPrice: '50', unitCost: null }),                         // missing cost
    line({ unitPrice: '99', unitCost: '50', customerVisible: false }), // excluded (not billed)
  ]);
  expect(r.oneTimeNet).toBe('30.00');
  expect(r.monthlyRecurringNet).toBe('15.00');
  expect(r.totalCost).toBe('125.00');
  expect(r.linesMissingCost).toBe(1);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd packages/shared && npx vitest run src/utils/quoteMath.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement the helpers**

Add `unitCost?: string | null;` to `QuoteLineForMath`. Append to `quoteMath.ts`:

```ts
/** markup on cost = (price − cost) / cost · 100. Null when cost is absent/≤0. */
export function markupPct(price: string | number, cost: string | number | null | undefined): number | null {
  if (cost === null || cost === undefined || cost === '') return null;
  const c = Number(cost); const p = Number(price);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(p)) return null;
  return ((p - c) / c) * 100;
}

/** Unit price from a target markup% on cost, cent-rounded (round-half-up). */
export function priceFromMarkup(cost: string | number, markupPctValue: number): string {
  const c = Number(cost);
  if (!Number.isFinite(c) || !Number.isFinite(markupPctValue)) return '0.00';
  return fromCents(roundHalfUp(c * (1 + markupPctValue / 100) * 100));
}

export interface QuoteProfit {
  oneTimeNet: string;
  monthlyRecurringNet: string;
  annualRecurringNet: string;
  totalCost: string;
  /** Count of billed lines with no cost — excluded from net, so the figure is partial. */
  linesMissingCost: number;
}

/** Net = revenue − cost, EXCLUDING tax, over billed (customerVisible) lines, split
 *  by cadence. Lines with no unitCost are excluded and counted in linesMissingCost. */
export function computeQuoteProfit(lines: QuoteLineForMath[]): QuoteProfit {
  let oneTimeNet = 0, monthlyNet = 0, annualNet = 0, totalCost = 0, missing = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    if (l.unitCost === null || l.unitCost === undefined || l.unitCost === '') { missing++; continue; }
    const revenueCents = toCents(computeLineTotal(l.quantity, l.unitPrice));
    const costCents = toCents(computeLineTotal(l.quantity, l.unitCost));
    const netCents = revenueCents - costCents;
    totalCost += costCents;
    if (l.recurrence === 'monthly') monthlyNet += netCents;
    else if (l.recurrence === 'annual') annualNet += netCents;
    else oneTimeNet += netCents;
  }
  return {
    oneTimeNet: fromCents(oneTimeNet),
    monthlyRecurringNet: fromCents(monthlyNet),
    annualRecurringNet: fromCents(annualNet),
    totalCost: fromCents(totalCost),
    linesMissingCost: missing,
  };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd packages/shared && npx vitest run src/utils/quoteMath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/quoteMath.ts packages/shared/src/utils/quoteMath.test.ts
git commit -m "feat(quotes): shared markup + net-profit math"
```

---

### Task 5: API service — snapshot on add, persist on update, never leak cost

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` (catalog-add, manual-add, update-line, and the public/portal serialization)
- Test: `apps/api/src/services/quoteService.test.ts` (or the existing quote service test file; create a co-located test if none)

**Interfaces:**
- Consumes: Task 2 schema columns; Task 3 validators (`quoteLineInputSchema`, `updateQuoteLineSchema`, `catalogQuoteLineSchema`); `catalog_items.cost_basis`, `catalog_items.sku`.
- Produces: catalog-add writes `unit_cost`=item.costBasis, `sku`=item.sku (and `part_number` when the add payload supplies an override); manual-add + update-line persist `unit_cost`/`sku`/`part_number`; the customer/portal quote payload omits `unit_cost`.

- [ ] **Step 1: Write the failing test (cost snapshot + no-leak)**

Add to the quote service test file. Use the file's existing harness/fixtures pattern (read the top of the file first to match its DB-mock or real-DB style):

```ts
it('catalog-add snapshots unit_cost and sku from the catalog item', async () => {
  // arrange: a catalog item with costBasis '100.00', sku 'SKU-1', unitPrice '130.00'
  // act: addCatalogLine(quoteId, { catalogItemId, quantity: 1, blockId })
  // assert: the inserted quote_line has unitCost === '100.00' and sku === 'SKU-1'
});

it('the customer/portal quote payload never includes unit_cost', async () => {
  // arrange: a quote with a line carrying unitCost '100.00'
  // act: the public serializer (getPublicQuote / portal payload builder)
  // assert: JSON.stringify(payload) does NOT contain 'unit_cost' or 'unitCost'
});
```

(Fill the arrange/act with the file's existing helpers — mirror a neighbouring add/serialize test exactly.)

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test --filter=@breeze/api -- quoteService`
Expected: FAIL.

- [ ] **Step 3: Implement**

- In the catalog-add path: when building the insert values, set `unitCost: item.costBasis ?? null`, `sku: item.sku ?? null`, and `partNumber: input.partNumber ?? null` (the new optional override).
- In the manual-add path: pass `unitCost`, `sku`, `partNumber` from the validated input through to the insert.
- In `updateLine`: include `unitCost`, `sku`, `partNumber` in the patchable column set.
- In the public/portal serializer: select an explicit column list that EXCLUDES `unit_cost` (and never derive markup/net there). If the serializer currently spreads the whole row, switch it to an explicit allow-list of customer-safe fields (`sku`/`part_number` are acceptable on the portal; `unit_cost` is NOT). Read the serializer first; keep `unit_cost` out.

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --filter=@breeze/api -- quoteService`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteService.ts apps/api/src/services/quoteService.test.ts
git commit -m "feat(quotes): snapshot line cost/sku on add, keep cost off the customer payload"
```

---

### Task 6: Web API client — send cost/sku/part# from the editor

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts` (the `addManualLine`, `updateLine`, `addCatalogLine` request bodies/types)

**Interfaces:**
- Consumes: Task 3 validator shapes.
- Produces: `addManualLine` body accepts `unitCost?: number | null`, `sku?: string | null`, `partNumber?: string | null`; `updateLine` body accepts the same; `addCatalogLine` accepts optional `partNumber`.

- [ ] **Step 1: Extend the client payload types**

In `quotes.ts`, widen the `addManualLine` and `updateLine` body parameter types to include `unitCost?: number | null; sku?: string | null; partNumber?: string | null;`, and add `partNumber?: string` to the `addCatalogLine` body. (These are pass-through to `fetchWithAuth` JSON bodies — match the existing typing style in the file.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "lib/api/quotes" || echo CLEAN`
Expected: CLEAN.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api/quotes.ts
git commit -m "feat(quotes): web client sends line cost/sku/part#"
```

---

### Task 7: Editor — per-line internal strip + markup↔price

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (`EditableLineRow`, the read-only line row, the manual-add form, and `BlockCard` state)
- Test: `apps/web/src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx` (create)

**Interfaces:**
- Consumes: `markupPct`, `priceFromMarkup` (Task 4); `LineUpdate` with cost/sku/part# (Task 2); `onEditLine` (existing); `onLineDraft` (existing).
- Produces: an internal strip rendering `data-testid`s `quote-line-sku-<id>`, `quote-line-partnumber-<id>`, `quote-line-cost-<id>`, `quote-line-markup-<id>`, `quote-line-net-<id>`; manual-add inputs `quote-manual-cost-<blockId>`, `quote-manual-sku-<blockId>`, `quote-manual-partnumber-<blockId>`.

- [ ] **Step 1: Write the failing test**

```tsx
// Mirror the auth/permission mock setup from QuoteEditor.editline.test.tsx (copy its header).
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// ...mocks for stores/auth, lib/api/quotes (updateLine), permissions (quotes:write)...

it('editing markup% sets the unit price from cost', async () => {
  // render editor with one line: unitCost '100.00', unitPrice '130.00'
  const markup = await screen.findByTestId(/quote-line-markup-/);
  expect((markup as HTMLInputElement).value).toBe('30'); // (130-100)/100
  fireEvent.change(markup, { target: { value: '50' } });
  fireEvent.blur(markup);
  // price field reflects 150.00 optimistically and updateLine is called with unitPrice 150
  await waitFor(() => expect((screen.getByTestId(/quote-line-price-/) as HTMLInputElement).value).toBe('150.00'));
});

it('net shows price-minus-cost times qty, and "—" when cost is absent', async () => {
  // line A: cost 100 price 130 qty 2 -> net $60.00 ; line B: cost null -> "—"
  expect(screen.getByTestId('quote-line-net-A')).toHaveTextContent('$60.00');
  expect(screen.getByTestId('quote-line-net-B')).toHaveTextContent('—');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx`
Expected: FAIL (no strip / testids).

- [ ] **Step 3: Implement the strip in `EditableLineRow`**

Add local state seeded from the line: `cost` (`line.unitCost ?? ''`), `sku` (`line.sku ?? ''`), `partNumber` (`line.partNumber ?? ''`), each with an `*Edited` ref + resync effect mirroring the existing `name`/`desc` pattern. Add `import { markupPct, priceFromMarkup } from '@breeze/shared';`.

Derive (no separate markup state — it's a function of price+cost):
```ts
const mk = markupPct(price, cost);                       // number | null
const markupStr = mk === null ? '' : String(Number(mk.toFixed(2)));
const netCents = cost === '' ? null
  : toCents(computeLineTotal(effQty, effPrice)) - toCents(computeLineTotal(effQty, cost));
```
Commit handlers:
```ts
const commitCost = () => { costEdited.current = false;
  const n = Number(cost);
  if (cost.trim() === '') { if (line.unitCost !== null) void edit({ unitCost: null }); return; }
  if (!Number.isFinite(n) || n < 0) { handleActionError(new Error('cost'), 'Enter a cost of 0 or more.'); setCost(line.unitCost ?? ''); return; }
  if (n !== Number(line.unitCost)) void edit({ unitCost: n });
};
const commitSku = () => { skuEdited.current = false; if (sku.trim() !== (line.sku ?? '')) void edit({ sku: sku.trim() || null }); };
const commitPartNumber = () => { partEdited.current = false; if (partNumber.trim() !== (line.partNumber ?? '')) void edit({ partNumber: partNumber.trim() || null }); };
const onMarkupCommit = (raw: string) => {
  const m = Number(raw);
  if (cost.trim() === '' || !Number.isFinite(m)) return;          // need a cost base
  const nextPrice = priceFromMarkup(cost, m);
  setPrice(nextPrice); priceEdited.current = false;
  if (Number(nextPrice) !== Number(line.unitPrice)) void edit({ unitPrice: Number(nextPrice) });
};
```
Render, as a new row beneath the main `<tr>` (a second `<tr>` with a single full-width `<td colSpan={7}>`), a muted internal band:
```tsx
<tr className="border-0" data-testid={`quote-line-internal-${line.id}`}>
  <td colSpan={7} className="px-2 pb-2">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-2 py-1 text-xs text-[hsl(220_12%_40%)] dark:text-muted-foreground">
      <span className="font-medium uppercase tracking-wide">Internal</span>
      <label className="flex items-center gap-1">SKU
        <input value={sku} onChange={(e)=>{setSku(e.target.value);skuEdited.current=true;}} onBlur={commitSku} disabled={busy}
          data-testid={`quote-line-sku-${line.id}`} className="h-6 w-28 rounded border bg-background px-1 text-foreground" /></label>
      <label className="flex items-center gap-1">PN
        <input value={partNumber} onChange={(e)=>{setPartNumber(e.target.value);partEdited.current=true;}} onBlur={commitPartNumber} disabled={busy}
          data-testid={`quote-line-partnumber-${line.id}`} className="h-6 w-28 rounded border bg-background px-1 text-foreground" /></label>
      <label className="flex items-center gap-1">Cost
        <input type="number" min="0" step="0.01" value={cost} onChange={(e)=>{setCost(e.target.value);costEdited.current=true;}} onBlur={commitCost} disabled={busy}
          data-testid={`quote-line-cost-${line.id}`} className="h-6 w-20 rounded border bg-background px-1 text-right tabular-nums text-foreground" /></label>
      <label className="flex items-center gap-1">Markup
        <input type="number" step="0.1" defaultValue={markupStr} key={markupStr} onBlur={(e)=>onMarkupCommit(e.target.value)} disabled={busy || cost.trim()===''}
          data-testid={`quote-line-markup-${line.id}`} className="h-6 w-16 rounded border bg-background px-1 text-right tabular-nums text-foreground" />%</label>
      <span className="ml-auto">net <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${line.id}`}>{netCents === null ? '—' : formatMoney(fromCents(netCents), currency)}</span></span>
    </div>
  </td>
</tr>
```
(Import `fromCents` from `@breeze/shared`; `markupStr` is `key`ed so the uncontrolled markup input re-seeds when price/cost change.) Extend the existing `onDraft` payload to include `unitCost: cost || null` so the rail recompute (Task 8) sees live cost.

For the **read-only** line row, render the same band but with plain text values (no inputs), gated identically.

- [ ] **Step 4: Add cost/sku/part# to the manual-add form**

In `BlockCard`, add state `const [cost,setCost]=useState(''); const [sku,setSku]=useState(''); const [partNumber,setPartNumber]=useState('');` and inputs in the manual panel (testids `quote-manual-cost-${block.id}`, `quote-manual-sku-${block.id}`, `quote-manual-partnumber-${block.id}`). Pass them through `onAddManual` (extend its form object + `addManual` in the parent + `addManualLine` call to include `unitCost: Number(cost)||null` when non-empty, `sku||null`, `partNumber||null`). Clear them in the success reset.

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd apps/web && npx vitest run src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx`
Expected: PASS. Then run the full editor suite for regressions: `npx vitest run src/components/billing/quotes`.
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx
git commit -m "feat(quotes): per-line internal cost/markup/net strip in the editor"
```

---

### Task 8: Rail — internal net-profit summary

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (the live-totals rail card)
- Test: `apps/web/src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx` (add cases)

**Interfaces:**
- Consumes: `computeQuoteProfit` (Task 4); the editor's existing `lines` + `lineDrafts` (drafts now carry `unitCost` from Task 7).
- Produces: rail testids `quote-margin-net-onetime`, `quote-margin-net-monthly`, `quote-margin-net-annual`, `quote-margin-cost`, `quote-margin-missing-cost`.

- [ ] **Step 1: Write the failing test**

```tsx
it('rail shows net profit by cadence and flags lines missing cost', async () => {
  // two billed lines: one-time cost 100/price 130, monthly cost 25/price 40; plus one line with no cost
  expect(screen.getByTestId('quote-margin-net-onetime')).toHaveTextContent('$30.00');
  expect(screen.getByTestId('quote-margin-net-monthly')).toHaveTextContent('$15.00');
  expect(screen.getByTestId('quote-margin-missing-cost')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the Margin section**

Near the existing `optimisticTotals` memo, add a profit memo over the SAME merged line set used for totals (each merged line already includes `unitCost` once Task 7 feeds it into `lineDrafts`; for non-draft lines fall back to `l.unitCost`):

```ts
import { computeQuoteProfit } from '@breeze/shared';
const profit = useMemo(() => computeQuoteProfit(lines.map((l) => {
  const d = lineDrafts[l.id];
  return {
    quantity: d?.quantity ?? l.quantity,
    unitPrice: d?.unitPrice ?? l.unitPrice,
    taxable: d?.taxable ?? l.taxable,
    customerVisible: l.customerVisible,
    recurrence: d?.recurrence ?? l.recurrence,
    unitCost: d?.unitCost ?? l.unitCost,
  };
})), [lines, lineDrafts]);
```
Render, inside the live-totals card and gated on `canWrite`, an internal block (visually marked internal) after the totals `<dl>`:
```tsx
{canWrite && (
  <div className="mt-3 rounded-md bg-muted/40 p-2 text-sm" data-testid="quote-margin">
    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[hsl(220_12%_40%)] dark:text-muted-foreground">Margin (internal)</div>
    <dl className="space-y-1 tabular-nums">
      <div className="flex justify-between"><dt className="text-muted-foreground">Cost</dt><dd data-testid="quote-margin-cost">{formatMoney(profit.totalCost, currency)}</dd></div>
      <div className="flex justify-between"><dt className="text-muted-foreground">Net (one-time)</dt><dd data-testid="quote-margin-net-onetime">{formatMoney(profit.oneTimeNet, currency)}</dd></div>
      {Number(profit.monthlyRecurringNet) !== 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Net (monthly)</dt><dd data-testid="quote-margin-net-monthly">{formatMoney(profit.monthlyRecurringNet, currency)}<span className="text-xs text-muted-foreground">/mo</span></dd></div>}
      {Number(profit.annualRecurringNet) !== 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Net (annual)</dt><dd data-testid="quote-margin-net-annual">{formatMoney(profit.annualRecurringNet, currency)}<span className="text-xs text-muted-foreground">/yr</span></dd></div>}
    </dl>
    {profit.linesMissingCost > 0 && (
      <p className="mt-1 text-xs text-warning" data-testid="quote-margin-missing-cost">
        {profit.linesMissingCost} line{profit.linesMissingCost === 1 ? '' : 's'} without a cost — net is partial.
      </p>
    )}
  </div>
)}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd apps/web && npx vitest run src/components/billing/quotes`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx
git commit -m "feat(quotes): internal net-profit summary in the editor rail"
```

---

### Task 9: Guardrail — cost never reaches the customer document

**Files:**
- Test: `apps/web/src/components/billing/quotes/QuoteDocument.test.tsx` (add a case)

**Interfaces:**
- Consumes: `QuoteDocument` (unchanged), a line fixture carrying `unitCost`/`sku`/`partNumber`.

- [ ] **Step 1: Write the test**

```tsx
it('never renders internal cost/markup/net on the customer document', () => {
  const detail = /* fixture with a line: unitCost '100.00', unitPrice '130.00', sku 'SKU-1' */;
  const { container } = render(<QuoteDocument detail={detail} customerName="Acme" />);
  expect(container.textContent).not.toMatch(/markup/i);
  expect(container.textContent).not.toContain('100.00'); // the cost value
  // the price 130.00 SHOULD appear; assert the cost specifically does not
});
```

- [ ] **Step 2: Run**

Run: `cd apps/web && npx vitest run src/components/billing/quotes/QuoteDocument.test.tsx`
Expected: PASS immediately (Document never read cost). If it FAILS, the document is leaking cost — fix the document, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteDocument.test.tsx
git commit -m "test(quotes): assert customer document omits internal cost/markup"
```

---

## Self-Review

- **Spec coverage:** data model → T1/T2; shared math (markup/price/net) → T4; validators → T3; API snapshot + no-leak → T5; web client → T6; editor strip + markup↔price + manual-add → T7; rail net → T8; customer-doc guardrail → T9. SKU snapshot + editable part# → T2/T3/T5/T7. Net-excludes-tax + billed-only + missing-cost flag → T4/T8. ✓
- **Deferred (per spec, no task):** catalog manufacturer-part-number column; `QuoteDetail` margin; margin permission; SKU/PN on customer doc. ✓ (intentional)
- **Type consistency:** `unitCost`/`sku`/`partNumber` names consistent across schema, validators, client type, `LineUpdate`, `QuoteLineForMath`, and `computeQuoteProfit`. `priceFromMarkup`/`markupPct`/`computeQuoteProfit` signatures match their call sites in T7/T8. ✓
- **Placeholder scan:** T5's test arrange/act intentionally defers to the file's existing harness (the service test style varies and must be matched in-place) — every other task carries complete code. ✓
