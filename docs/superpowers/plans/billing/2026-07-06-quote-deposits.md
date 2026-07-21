# Quote Deposits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Test-writing conventions (Drizzle mock patterns, coverage checklist): use the **breeze-testing** skill before writing any test file.

**Goal:** Quotes can require a deposit (percent of the one-time total, or the sum of flagged "deposit-eligible" lines, typically hardware); acceptance issues one full invoice carrying `deposit_due`; Stripe/portal payment collects the deposit first and the balance later; balance due date is editable on issued invoices; category-broken-out subtotals appear in editor, portal, and PDF.

**Spec:** `docs/superpowers/specs/billing/2026-07-05-quote-deposits-design.md` (approved). Read it before starting any task.

**Architecture:** All deposit math lives in `@breeze/shared` (`quoteMath.ts` for quote-side, new `depositMath.ts` for invoice-side charge-now), so API, web editor, portal, and PDF agree penny-for-penny. `quotes.deposit_amount` is a stored snapshot recomputed on every edit; `invoices.deposit_due` is snapshotted at acceptance; the pay-amount rule (`deposit unpaid → charge deposit remainder, else balance`) is applied in the two checkout entry points. No new tables — three tables gain columns, so no RLS work.

**Tech Stack:** Drizzle + hand-written SQL migration, Hono routes, Zod validators in `packages/shared`, Vitest (+ one real-Postgres integration test), React (web editor + portal).

## Global Constraints

- **Money discipline:** integer cents, single round-half-up at the cent boundary (`toCents`/`fromCents`/`roundHalfUp` in `packages/shared/src/utils/quoteMath.ts`). Never compare money strings; compare cents.
- **Issued financial documents are immutable** — the ONLY new mutation on issued invoices is the due-date carve-out (scheduling metadata), which must be audit-logged.
- **Migration:** one idempotent file `apps/api/migrations/2026-07-06-quote-deposits.sql` (`ADD COLUMN IF NOT EXISTS`, enum via `DO $$ ... EXCEPTION`), no inner `BEGIN;`/`COMMIT;`, never edit shipped migrations.
- **Content-hash backward compatibility:** `computeQuoteSha256` must produce IDENTICAL hashes for existing no-deposit quotes (conditional field inclusion) — old `quote_acceptances.quote_sha256` values must stay verifiable.
- **Quote editing is draft-only** (`loadDraft` guard) — deposit config follows the same rule; quotes are issue-once so no post-send drift.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`).
- **Deposit validity rule (from spec):** deposit types other than `none` require ≥1 one-time customer-visible line; computed deposit must be `> 0` and `< dueOnAcceptanceTotal` (100% is "no deposit" — rejected).
- Run `pnpm test --filter=@breeze/shared` / `--filter=@breeze/api` after each shared/API task; `pnpm db:check-drift` after the schema task (needs `DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze`).

---

### Task 1: Shared quote-side deposit math + category breakdown

**Files:**
- Modify: `packages/shared/src/utils/quoteMath.ts`
- Test: `packages/shared/src/utils/quoteMath.test.ts` (extend if it exists, create otherwise)

**Interfaces:**
- Consumes: existing `toCents`, `fromCents`, `computeLineTotal`, `computeQuoteTotals`.
- Produces (later tasks rely on these exact names):
  - `type QuoteDepositType = 'none' | 'percent' | 'selected_lines'`
  - `interface QuoteDepositConfig { type: QuoteDepositType; percent?: number | string | null }`
  - `QuoteLineForMath` gains `depositEligible?: boolean; itemType?: 'hardware' | 'software' | 'service' | null`
  - `computeQuoteTotals(lines, taxRate, deposit?)` — third arg optional; existing callers unchanged
  - `QuoteTotals` gains `depositDueTotal: string | null` and `categoryBreakdown: QuoteCategorySubtotal[]`
  - `interface QuoteCategorySubtotal { category: 'hardware' | 'software' | 'service' | 'other'; oneTimeTotal: string; monthlyTotal: string; annualTotal: string }`
  - `validateQuoteDeposit(lines, taxRate, deposit): { ok: true; depositDueTotal: string | null } | { ok: false; code: string; message: string }`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/utils/quoteMath.test.ts` (create the file with the standard Vitest header if absent):

```ts
import { describe, it, expect } from 'vitest';
import { computeQuoteTotals, validateQuoteDeposit, type QuoteLineForMath } from './quoteMath';

const line = (over: Partial<QuoteLineForMath>): QuoteLineForMath => ({
  quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true,
  recurrence: 'one_time', ...over,
});

describe('deposit math', () => {
  it('percent deposit = percent of dueOnAcceptanceTotal (one-time + one-time tax)', () => {
    const lines = [
      line({ unitPrice: '1000.00', taxable: true }),
      line({ unitPrice: '500.00', recurrence: 'monthly' }), // recurring excluded
    ];
    // dueOnAcceptance = 1000 + 10% tax = 1100.00; 30% => 330.00
    const t = computeQuoteTotals(lines, 0.1, { type: 'percent', percent: 30 });
    expect(t.dueOnAcceptanceTotal).toBe('1100.00');
    expect(t.depositDueTotal).toBe('330.00');
  });

  it('percent deposit rounds half-up at the cent boundary', () => {
    // 33.335 => 33.34 (dueOnAcceptance 100.00, 33.335%)
    const t = computeQuoteTotals([line({ unitPrice: '100.00' })], null, { type: 'percent', percent: 33.335 });
    expect(t.depositDueTotal).toBe('33.34');
  });

  it('selected_lines deposit sums flagged one-time lines + tax on flagged taxable lines', () => {
    const lines = [
      line({ unitPrice: '6200.00', taxable: true, depositEligible: true, itemType: 'hardware' }),
      line({ unitPrice: '1100.00', taxable: false, depositEligible: true, itemType: 'hardware' }),
      line({ unitPrice: '2400.00', taxable: true, depositEligible: false }),           // not flagged
      line({ unitPrice: '99.00', depositEligible: true, recurrence: 'monthly' }),      // recurring never counts
      line({ unitPrice: '50.00', depositEligible: true, customerVisible: false }),     // hidden never counts
    ];
    // 6200 + 1100 + 10% of 6200 = 7920.00
    const t = computeQuoteTotals(lines, 0.1, { type: 'selected_lines' });
    expect(t.depositDueTotal).toBe('7920.00');
  });

  it('depositDueTotal is null for type none / missing config', () => {
    expect(computeQuoteTotals([line({})], null).depositDueTotal).toBeNull();
    expect(computeQuoteTotals([line({})], null, { type: 'none' }).depositDueTotal).toBeNull();
  });

  it('categoryBreakdown groups by itemType with manual lines under other, omitting empty categories', () => {
    const lines = [
      line({ unitPrice: '6200.00', itemType: 'hardware' }),
      line({ unitPrice: '1100.00', itemType: 'hardware' }),
      line({ unitPrice: '300.00', itemType: 'service', recurrence: 'monthly' }),
      line({ unitPrice: '2400.00' }), // manual, no itemType
      line({ unitPrice: '10.00', customerVisible: false, itemType: 'software' }), // hidden excluded entirely
    ];
    const t = computeQuoteTotals(lines, null);
    expect(t.categoryBreakdown).toEqual([
      { category: 'hardware', oneTimeTotal: '7300.00', monthlyTotal: '0.00', annualTotal: '0.00' },
      { category: 'service', oneTimeTotal: '0.00', monthlyTotal: '300.00', annualTotal: '0.00' },
      { category: 'other', oneTimeTotal: '2400.00', monthlyTotal: '0.00', annualTotal: '0.00' },
    ]);
  });
});

describe('validateQuoteDeposit', () => {
  it('accepts a valid percent deposit', () => {
    const r = validateQuoteDeposit([line({ unitPrice: '1000.00' })], null, { type: 'percent', percent: 30 });
    expect(r).toEqual({ ok: true, depositDueTotal: '300.00' });
  });
  it('type none is always ok with null total', () => {
    expect(validateQuoteDeposit([], null, { type: 'none' })).toEqual({ ok: true, depositDueTotal: null });
  });
  it('rejects deposit without one-time customer-visible lines', () => {
    const r = validateQuoteDeposit([line({ recurrence: 'monthly' })], null, { type: 'percent', percent: 30 });
    expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES' });
  });
  it('rejects percent type without a usable percent', () => {
    expect(validateQuoteDeposit([line({})], null, { type: 'percent', percent: null }))
      .toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
    expect(validateQuoteDeposit([line({})], null, { type: 'percent', percent: 100 }))
      .toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
  });
  it('rejects selected_lines with no eligible one-time line', () => {
    const r = validateQuoteDeposit([line({ depositEligible: false })], null, { type: 'selected_lines' });
    expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_NO_ELIGIBLE_LINES' });
  });
  it('rejects deposit >= dueOnAcceptanceTotal (all lines flagged = "no deposit")', () => {
    const r = validateQuoteDeposit([line({ depositEligible: true })], null, { type: 'selected_lines' });
    expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_NOT_BELOW_TOTAL' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/shared test -- quoteMath`
Expected: FAIL — `validateQuoteDeposit` not exported, `depositDueTotal` undefined.

- [ ] **Step 3: Implement in `quoteMath.ts`**

Extend `QuoteLineForMath` and `QuoteTotals`, add the deposit types, and rework `computeQuoteTotals`:

```ts
export type QuoteDepositType = 'none' | 'percent' | 'selected_lines';
export interface QuoteDepositConfig {
  type: QuoteDepositType;
  /** Required for type 'percent'. Whole-percent scale (30 = 30%), 2dp. */
  percent?: number | string | null;
}

export interface QuoteLineForMath {
  quantity: string;
  unitPrice: string;
  unitCost?: string | null;
  taxable: boolean;
  customerVisible: boolean;
  recurrence: 'one_time' | 'monthly' | 'annual';
  /** Counts toward a 'selected_lines' deposit (one-time lines only). */
  depositEligible?: boolean;
  /** Catalog item type snapshotted at add-time; null/undefined = manual → 'other'. */
  itemType?: 'hardware' | 'software' | 'service' | null;
}

export interface QuoteCategorySubtotal {
  category: 'hardware' | 'software' | 'service' | 'other';
  oneTimeTotal: string;
  monthlyTotal: string;
  annualTotal: string;
}

export interface QuoteTotals {
  // ...existing fields unchanged...
  dueOnAcceptanceTotal: string;
  /** Deposit due at acceptance, or null when no (valid) deposit is configured. */
  depositDueTotal: string | null;
  /** Per-category subtotals over customer-visible lines; empty categories omitted. */
  categoryBreakdown: QuoteCategorySubtotal[];
}
```

Inside `computeQuoteTotals(lines, taxRate, deposit?)`, accumulate two extra buckets in the existing loop (do NOT add a second pass):

```ts
export function computeQuoteTotals(
  lines: QuoteLineForMath[],
  taxRate: number | null,
  deposit?: QuoteDepositConfig | null,
): QuoteTotals {
  let oneTime = 0, monthly = 0, annual = 0, taxableBasis = 0, oneTimeTaxableBasis = 0;
  let eligibleCents = 0, eligibleTaxableCents = 0;
  const CATEGORY_ORDER = ['hardware', 'software', 'service', 'other'] as const;
  const cat: Record<string, { oneTime: number; monthly: number; annual: number }> = {};
  for (const l of lines) {
    if (!l.customerVisible) continue;
    const lineCents = toCents(computeLineTotal(l.quantity, l.unitPrice));
    if (l.recurrence === 'monthly') monthly += lineCents;
    else if (l.recurrence === 'annual') annual += lineCents;
    else oneTime += lineCents;
    if (l.taxable) {
      taxableBasis += lineCents;
      if (l.recurrence === 'one_time') oneTimeTaxableBasis += lineCents;
    }
    if (l.depositEligible && l.recurrence === 'one_time') {
      eligibleCents += lineCents;
      if (l.taxable) eligibleTaxableCents += lineCents;
    }
    const key = l.itemType ?? 'other';
    const bucket = (cat[key] ??= { oneTime: 0, monthly: 0, annual: 0 });
    if (l.recurrence === 'monthly') bucket.monthly += lineCents;
    else if (l.recurrence === 'annual') bucket.annual += lineCents;
    else bucket.oneTime += lineCents;
  }
  const subtotal = oneTime + monthly + annual;
  const rate = taxRate ?? 0;
  const taxCents = Math.floor(taxableBasis * rate + 0.5);
  const oneTimeTaxCents = Math.floor(oneTimeTaxableBasis * rate + 0.5);
  const dueOnAcceptanceCents = oneTime + oneTimeTaxCents;

  let depositCents: number | null = null;
  if (deposit && deposit.type === 'percent') {
    const pct = Number(deposit.percent);
    if (Number.isFinite(pct) && pct > 0) {
      depositCents = Math.floor(dueOnAcceptanceCents * (pct / 100) + 0.5);
    }
  } else if (deposit && deposit.type === 'selected_lines') {
    depositCents = eligibleCents + Math.floor(eligibleTaxableCents * rate + 0.5);
  }

  return {
    subtotal: fromCents(subtotal),
    taxTotal: fromCents(taxCents),
    total: fromCents(subtotal + taxCents),
    oneTimeTotal: fromCents(oneTime),
    monthlyRecurringTotal: fromCents(monthly),
    annualRecurringTotal: fromCents(annual),
    dueOnAcceptanceTotal: fromCents(dueOnAcceptanceCents),
    depositDueTotal: depositCents !== null ? fromCents(depositCents) : null,
    categoryBreakdown: CATEGORY_ORDER
      .filter((k) => cat[k])
      .map((k) => ({
        category: k,
        oneTimeTotal: fromCents(cat[k]!.oneTime),
        monthlyTotal: fromCents(cat[k]!.monthly),
        annualTotal: fromCents(cat[k]!.annual),
      })),
  };
}
```

Then the validator (below `computeQuoteTotals`):

```ts
export type QuoteDepositValidation =
  | { ok: true; depositDueTotal: string | null }
  | { ok: false; code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES' | 'DEPOSIT_PERCENT_INVALID'
      | 'DEPOSIT_NO_ELIGIBLE_LINES' | 'DEPOSIT_NOT_BELOW_TOTAL'; message: string };

/** Spec rule: deposit needs ≥1 one-time visible line; 0 < deposit < dueOnAcceptanceTotal. */
export function validateQuoteDeposit(
  lines: QuoteLineForMath[],
  taxRate: number | null,
  deposit: QuoteDepositConfig,
): QuoteDepositValidation {
  if (deposit.type === 'none') return { ok: true, depositDueTotal: null };
  const totals = computeQuoteTotals(lines, taxRate, deposit);
  if (toCents(totals.dueOnAcceptanceTotal) <= 0) {
    return { ok: false, code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES',
      message: 'A deposit needs at least one one-time, customer-visible line' };
  }
  if (deposit.type === 'percent') {
    const pct = Number(deposit.percent);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return { ok: false, code: 'DEPOSIT_PERCENT_INVALID', message: 'Deposit percent must be between 0 and 100 (exclusive)' };
    }
  }
  const depositCents = totals.depositDueTotal !== null ? toCents(totals.depositDueTotal) : 0;
  if (deposit.type === 'selected_lines' && depositCents <= 0) {
    return { ok: false, code: 'DEPOSIT_NO_ELIGIBLE_LINES', message: 'Flag at least one one-time line as deposit-eligible' };
  }
  if (depositCents >= toCents(totals.dueOnAcceptanceTotal)) {
    return { ok: false, code: 'DEPOSIT_NOT_BELOW_TOTAL',
      message: 'Deposit must be less than the amount due on acceptance — remove the deposit instead' };
  }
  return { ok: true, depositDueTotal: totals.depositDueTotal };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/shared test -- quoteMath`
Expected: PASS (including all pre-existing quoteMath tests — the third arg is optional).

- [ ] **Step 5: Ensure exports reach the package surface**

`computeQuoteTotals` is imported by the API as `@breeze/shared` re-export (`apps/api/src/services/quoteMath.ts`) and by web. Check `packages/shared/src/utils/index.ts` (or `packages/shared/src/index.ts`) exports `./utils/quoteMath` wholesale (`export * from`); if it enumerates names, add `validateQuoteDeposit`, `QuoteDepositConfig`, `QuoteDepositType`, `QuoteCategorySubtotal`.

Run: `pnpm --filter @breeze/shared build` (or `pnpm --filter @breeze/shared typecheck` if that's the script) — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/quoteMath.ts packages/shared/src/utils/quoteMath.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): deposit math + category breakdown in quote totals"
```

---

### Task 2: Shared invoice-side charge-now rule

**Files:**
- Create: `packages/shared/src/utils/depositMath.ts`
- Test: `packages/shared/src/utils/depositMath.test.ts`
- Modify: `packages/shared/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `computeChargeNow(inv: { depositDue: string | null; amountPaid: string; balance: string }): { amount: string; isDeposit: boolean }`
  - Used by `invoiceCheckout.ts`, `routes/portal/invoices.ts` (Task 7), the portal invoice UI and web invoice UI (Tasks 10–11).

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/utils/depositMath.test.ts
import { describe, it, expect } from 'vitest';
import { computeChargeNow } from './depositMath';

describe('computeChargeNow', () => {
  it('no deposit → full balance', () => {
    expect(computeChargeNow({ depositDue: null, amountPaid: '0.00', balance: '10000.00' }))
      .toEqual({ amount: '10000.00', isDeposit: false });
  });
  it('deposit unpaid → deposit amount', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '0.00', balance: '10000.00' }))
      .toEqual({ amount: '3000.00', isDeposit: true });
  });
  it('deposit partly paid (manual check) → deposit remainder', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '1000.00', balance: '9000.00' }))
      .toEqual({ amount: '2000.00', isDeposit: true });
  });
  it('deposit satisfied → remaining balance', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '3000.00', balance: '7000.00' }))
      .toEqual({ amount: '7000.00', isDeposit: false });
  });
  it('overpaid past deposit → remaining balance', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '5000.00', balance: '5000.00' }))
      .toEqual({ amount: '5000.00', isDeposit: false });
  });
  it('never charges more than the balance (deposit > balance edge)', () => {
    // total 10000, deposit 3000, but 8000 already paid → balance 2000 < deposit remainder
    expect(computeChargeNow({ depositDue: '9000.00', amountPaid: '8000.00', balance: '2000.00' }))
      .toEqual({ amount: '1000.00', isDeposit: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test -- depositMath`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/utils/depositMath.ts
import { toCents, fromCents } from './quoteMath';

/**
 * The single pay-amount rule (spec §"Pay-amount rule"):
 *   chargeNow = deposit set && amountPaid < depositDue ? depositDue − amountPaid : balance
 * Clamped to the invoice balance so a concurrent manual payment can never push a
 * Stripe charge past what is owed. Pure + browser-safe: shared by the API
 * checkout paths and the portal/web "Pay" button labels.
 */
export function computeChargeNow(inv: {
  depositDue: string | null;
  amountPaid: string;
  balance: string;
}): { amount: string; isDeposit: boolean } {
  const balanceCents = toCents(inv.balance);
  const depositCents = inv.depositDue !== null ? toCents(inv.depositDue) : 0;
  const paidCents = toCents(inv.amountPaid);
  if (depositCents > 0 && paidCents < depositCents) {
    return { amount: fromCents(Math.min(depositCents - paidCents, balanceCents)), isDeposit: true };
  }
  return { amount: inv.balance, isDeposit: false };
}
```

Export from `packages/shared/src/index.ts` alongside the quoteMath exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared test -- depositMath`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/depositMath.ts packages/shared/src/utils/depositMath.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): computeChargeNow pay-amount rule for deposit invoices"
```

---

### Task 3: Schema columns + migration

**Files:**
- Modify: `apps/api/src/db/schema/quotes.ts`, `apps/api/src/db/schema/invoices.ts`
- Create: `apps/api/migrations/2026-07-06-quote-deposits.sql`

**Interfaces:**
- Produces columns later tasks read/write: `quotes.deposit_type/deposit_percent/deposit_amount`, `quote_lines.deposit_eligible/item_type`, `invoices.deposit_due`. Drizzle property names: `depositType`, `depositPercent`, `depositAmount`, `depositEligible`, `itemType`, `depositDue`.

- [ ] **Step 1: Drizzle schema edits**

`apps/api/src/db/schema/quotes.ts` — add the enum next to the other enums, import `catalogItemTypeEnum`:

```ts
import { catalogItemTypeEnum } from './catalog';

export const quoteDepositTypeEnum = pgEnum('quote_deposit_type', ['none', 'percent', 'selected_lines']);
```

In the `quotes` table, after `annualRecurringTotal`:

```ts
  depositType: quoteDepositTypeEnum('deposit_type').notNull().default('none'),
  // Whole-percent scale (30.00 = 30%), only meaningful for deposit_type='percent'.
  depositPercent: numeric('deposit_percent', { precision: 5, scale: 2 }),
  // Stored snapshot of the computed deposit due; recomputed on every draft edit.
  depositAmount: numeric('deposit_amount', { precision: 12, scale: 2 }),
```

In `quoteLines`, after `unitCost`:

```ts
  // Counts toward a 'selected_lines' deposit. Catalog hardware defaults it on.
  depositEligible: boolean('deposit_eligible').notNull().default(false),
  // Catalog item type snapshotted at add-time (null for manual lines) — drives
  // the per-category subtotal breakdown without a portal-invisible catalog join.
  itemType: catalogItemTypeEnum('item_type'),
```

`apps/api/src/db/schema/invoices.ts` — in `invoices`, after `balance`:

```ts
  // Deposit due at acceptance, snapshotted from the quote. NULL = ordinary invoice.
  depositDue: numeric('deposit_due', { precision: 12, scale: 2 }),
```

- [ ] **Step 2: Migration**

`apps/api/migrations/2026-07-06-quote-deposits.sql`:

```sql
-- Quote deposits (spec: docs/superpowers/specs/billing/2026-07-05-quote-deposits-design.md).
-- Columns only — no new tables, RLS untouched.

DO $$ BEGIN
  CREATE TYPE quote_deposit_type AS ENUM ('none', 'percent', 'selected_lines');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_type quote_deposit_type NOT NULL DEFAULT 'none';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_percent numeric(5,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_amount numeric(12,2);

ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS deposit_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS item_type catalog_item_type;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deposit_due numeric(12,2);
```

- [ ] **Step 3: Verify drift + migration apply**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```
Expected: no drift. (The migration runner applies pending files on API boot; `apps/api/src/db/autoMigrate.test.ts` covers ordering — run `pnpm --filter @breeze/api test -- autoMigrate` and expect PASS.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/quotes.ts apps/api/src/db/schema/invoices.ts apps/api/migrations/2026-07-06-quote-deposits.sql
git commit -m "feat(quotes): deposit columns on quotes/quote_lines/invoices + migration"
```

---

### Task 4: Shared Zod validators

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts`
- Test: `packages/shared/src/validators/quotes.test.ts` (extend/create)

**Interfaces:**
- Produces: `quoteDepositTypeSchema`; `updateQuoteSchema` gains `depositType`, `depositPercent`; `quoteLineInputSchema` and `updateQuoteLineSchema` gain `depositEligible`. Route handlers (existing quote routes) pick these up with no route changes since they validate with these schemas.

- [ ] **Step 1: Write failing tests**

```ts
// append to packages/shared/src/validators/quotes.test.ts
import { updateQuoteSchema, quoteLineInputSchema, updateQuoteLineSchema } from './quotes';

describe('deposit validator fields', () => {
  it('accepts deposit config on quote update', () => {
    expect(updateQuoteSchema.parse({ depositType: 'percent', depositPercent: 30 }))
      .toMatchObject({ depositType: 'percent', depositPercent: 30 });
    expect(updateQuoteSchema.parse({ depositType: 'none', depositPercent: null }))
      .toMatchObject({ depositType: 'none', depositPercent: null });
  });
  it('rejects out-of-range percent', () => {
    expect(updateQuoteSchema.safeParse({ depositPercent: 0 }).success).toBe(false);
    expect(updateQuoteSchema.safeParse({ depositPercent: 100 }).success).toBe(false);
    expect(updateQuoteSchema.safeParse({ depositPercent: 12.345 }).success).toBe(false);
  });
  it('accepts depositEligible on line create and update', () => {
    const base = { sourceType: 'manual', name: 'x', quantity: 1, unitPrice: 5, taxable: false };
    expect(quoteLineInputSchema.parse({ ...base, depositEligible: true })).toMatchObject({ depositEligible: true });
    expect(quoteLineInputSchema.parse(base)).toMatchObject({ depositEligible: false }); // default
    expect(updateQuoteLineSchema.parse({ depositEligible: true })).toMatchObject({ depositEligible: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared test -- validators/quotes`
Expected: FAIL — unknown keys stripped / percent accepted.

- [ ] **Step 3: Implement**

In `packages/shared/src/validators/quotes.ts`:

```ts
export const quoteDepositTypeSchema = z.enum(['none', 'percent', 'selected_lines']);
// Whole-percent, 2dp, exclusive bounds per spec (100% = "no deposit" — rejected).
const depositPercent = z.number().gt(0).lt(100).multipleOf(0.01);
```

Add to `updateQuoteSchema`:

```ts
  depositType: quoteDepositTypeSchema.optional(),
  depositPercent: depositPercent.nullable().optional(),
```

Add to `quoteLineInputSchema` (before the `.refine`):

```ts
  depositEligible: z.boolean().default(false),
```

Add to `updateQuoteLineSchema`:

```ts
  depositEligible: z.boolean().optional(),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @breeze/shared test -- validators/quotes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.test.ts
git commit -m "feat(shared): deposit fields in quote validators"
```

---

### Task 5: quoteService — persist config, snapshot itemType, recompute deposit

**Files:**
- Modify: `apps/api/src/services/quoteService.ts`
- Test: `apps/api/src/services/quoteService.test.ts` (extend; if the service has no unit test file, create one following the Drizzle mock pattern from the breeze-testing skill)

**Interfaces:**
- Consumes: Task 1 (`computeQuoteTotals` 3-arg, `validateQuoteDeposit`), Task 3 columns, Task 4 input types.
- Produces: `getQuote` returns `quote.depositDueTotal: string | null` and `quote.categoryBreakdown` (derived, non-persisted) alongside the existing `dueOnAcceptanceTotal`; `updateQuote` accepts/validates `depositType`/`depositPercent` (throws `QuoteServiceError(400)` with the validator's code); every line mutation keeps `quotes.deposit_amount` fresh.

- [ ] **Step 1: Write failing tests** — cover: (a) `updateQuote` with `depositType:'percent', depositPercent:30` persists config and recompute stores `deposit_amount`; (b) `updateQuote` with a deposit invalid for the current lines throws code `DEPOSIT_REQUIRES_ONE_TIME_LINES`; (c) `addCatalogLine` on a `hardware` catalog item sets `depositEligible: true` and `itemType: 'hardware'`, a `service` item sets `false`/`'service'`; (d) `getQuote` returns `depositDueTotal` and `categoryBreakdown`. Use the existing Drizzle mock pattern in the sibling test files.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- quoteService` → FAIL.

- [ ] **Step 3: Implement.**

**(a) `recomputeAndPersist`** — widen the selects and persist `depositAmount`:

```ts
async function recomputeAndPersist(quoteId: string): Promise<void> {
  const [q] = await db.select({
    taxRate: quotes.taxRate,
    depositType: quotes.depositType,
    depositPercent: quotes.depositPercent,
  }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const lines = await db.select({
    quantity: quoteLines.quantity,
    unitPrice: quoteLines.unitPrice,
    taxable: quoteLines.taxable,
    customerVisible: quoteLines.customerVisible,
    recurrence: quoteLines.recurrence,
    depositEligible: quoteLines.depositEligible,
    itemType: quoteLines.itemType,
  }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
  const deposit = { type: q?.depositType ?? 'none', percent: q?.depositPercent ?? null } as const;
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], q?.taxRate ? parseFloat(q.taxRate) : null, deposit);
  await db.update(quotes).set({
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    oneTimeTotal: totals.oneTimeTotal,
    monthlyRecurringTotal: totals.monthlyRecurringTotal,
    annualRecurringTotal: totals.annualRecurringTotal,
    // Null when no deposit configured OR the config is currently unsatisfiable
    // (e.g. the last one-time line was deleted) — sendQuote re-validates hard.
    depositAmount: totals.depositDueTotal,
    updatedAt: new Date(),
  }).where(eq(quotes.id, quoteId));
}
```

**(b) `updateQuote`** — after the existing field mapping, before the `db.update`:

```ts
  if (input.depositType !== undefined || input.depositPercent !== undefined) {
    const q = await loadDraft(id, actor); // already loaded above — reuse that variable instead of re-fetching
    const lines = await db.select({
      quantity: quoteLines.quantity, unitPrice: quoteLines.unitPrice,
      taxable: quoteLines.taxable, customerVisible: quoteLines.customerVisible,
      recurrence: quoteLines.recurrence, depositEligible: quoteLines.depositEligible,
    }).from(quoteLines).where(eq(quoteLines.quoteId, id));
    const nextType = input.depositType ?? q.depositType;
    const nextPercent = input.depositPercent !== undefined ? input.depositPercent : q.depositPercent;
    const effectiveTaxRate = (input.taxRate !== undefined ? input.taxRate : (q.taxRate ? parseFloat(q.taxRate) : null));
    const check = validateQuoteDeposit(lines as QuoteLineForMath[], effectiveTaxRate === null ? null : Number(effectiveTaxRate), {
      type: nextType, percent: nextPercent,
    });
    if (!check.ok) throw new QuoteServiceError(check.message, 400, check.code);
    set.depositType = nextType;
    set.depositPercent = nextType === 'percent' && nextPercent != null ? Number(nextPercent).toFixed(2) : null;
  }
```

(NOTE to implementer: `loadDraft(id, actor)` is already called at the top of `updateQuote` — capture its return value `const q = await loadDraft(id, actor);` instead of the current discard, and import `validateQuoteDeposit` from `./quoteMath` after re-exporting it there: add `validateQuoteDeposit` to the re-export list in `apps/api/src/services/quoteMath.ts`.)

**(c) `addCatalogLine`** — in the `.values({...})`:

```ts
    depositEligible: item.itemType === 'hardware',
    itemType: item.itemType,
```

**(d) `addManualLine`** — in the `.values({...})`:

```ts
    depositEligible: input.depositEligible ?? false,
    itemType: null,
```

**(e) `updateLine`** — input type gains `depositEligible?: boolean`; in the `set` construction:

```ts
  if (input.depositEligible !== undefined) set.depositEligible = input.depositEligible;
```

**(f) `getQuote`** — pass the deposit config and surface the derived fields:

```ts
  const totals = computeQuoteTotals(
    lines as QuoteLineForMath[],
    q.taxRate ? parseFloat(q.taxRate) : null,
    { type: q.depositType, percent: q.depositPercent },
  );
  return {
    quote: {
      ...q,
      dueOnAcceptanceTotal: totals.dueOnAcceptanceTotal,
      depositDueTotal: totals.depositDueTotal,
      categoryBreakdown: totals.categoryBreakdown,
    },
    blocks, lines,
  };
```

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/api test -- quoteService` → PASS (including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteService.ts apps/api/src/services/quoteService.test.ts apps/api/src/services/quoteMath.ts
git commit -m "feat(quotes): deposit config on quote edit, itemType snapshot, deposit recompute"
```

---

### Task 6: Content hash covers deposit terms (backward compatible)

**Files:**
- Modify: `apps/api/src/services/quoteContentHash.ts`
- Test: `apps/api/src/services/quoteContentHash.test.ts` (extend/create)

**Interfaces:**
- Consumes: quote/line rows now carrying deposit fields (passed by `acceptQuote`, which already passes full rows).
- Produces: same function name/signature; hash unchanged for no-deposit quotes.

- [ ] **Step 1: Write failing tests**

```ts
it('hash is UNCHANGED for quotes without a deposit (backward compat with stored acceptances)', () => {
  const quote = { id: 'q1', currencyCode: 'USD', subtotal: '10.00', taxTotal: '0.00', total: '10.00',
    oneTimeTotal: '10.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00' };
  const legacy = computeQuoteSha256(quote as any, [], []);
  const withNone = computeQuoteSha256({ ...quote, depositType: 'none', depositPercent: null, depositAmount: null } as any, [], []);
  expect(withNone).toBe(legacy);
});

it('deposit config and line eligibility change the hash', () => {
  const quote = { id: 'q1', currencyCode: 'USD', subtotal: '10.00', taxTotal: '0.00', total: '10.00',
    oneTimeTotal: '10.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00' };
  const line = { id: 'l1', description: 'x', quantity: '1', unitPrice: '10.00', lineTotal: '10.00',
    recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 };
  const base = computeQuoteSha256(quote as any, [], [line as any]);
  const withDeposit = computeQuoteSha256(
    { ...quote, depositType: 'percent', depositPercent: '30.00', depositAmount: '3.00' } as any, [], [line as any]);
  const withFlag = computeQuoteSha256(quote as any, [], [{ ...line, depositEligible: true } as any]);
  expect(withDeposit).not.toBe(base);
  expect(withFlag).not.toBe(base);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- quoteContentHash` → the second test FAILS (fields ignored today).

- [ ] **Step 3: Implement** — widen the hashable types and include CONDITIONALLY:

```ts
type HashableQuote = {
  id: string; currencyCode: string;
  subtotal: string; taxTotal: string; total: string;
  oneTimeTotal: string; monthlyRecurringTotal: string; annualRecurringTotal: string;
  depositType?: string | null; depositPercent?: string | null; depositAmount?: string | null;
};
type HashableLine = {
  // ...existing fields...
  depositEligible?: boolean;
};
```

In `computeQuoteSha256`, after building `canonical` (typed as a mutable record):

```ts
  // Deposit terms are part of what the customer signs. Included ONLY when a
  // deposit is configured so every pre-deposit acceptance hash stays verifiable.
  if (quote.depositType && quote.depositType !== 'none') {
    (canonical.quote as Record<string, unknown>).deposit = {
      type: quote.depositType,
      percent: quote.depositPercent ?? null,
      amount: quote.depositAmount ?? null,
    };
  }
```

And in the line mapper, spread conditionally:

```ts
      .map((l) => ({
        id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        lineTotal: l.lineTotal, recurrence: l.recurrence, taxable: l.taxable,
        customerVisible: l.customerVisible, sortOrder: l.sortOrder,
        ...(l.depositEligible ? { depositEligible: true } : {}),
      })),
```

- [ ] **Step 4: Run tests** — both new tests + all existing hash tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteContentHash.ts apps/api/src/services/quoteContentHash.test.ts
git commit -m "feat(quotes): fold deposit terms into the signed content hash (backward compatible)"
```

---

### Task 7: Send-time validation + acceptance snapshots deposit_due

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts` (sendQuote), `apps/api/src/services/quoteAcceptService.ts`
- Test: `apps/api/src/services/quoteAcceptService.test.ts`, `apps/api/src/services/quoteLifecycle.test.ts` (extend)

**Interfaces:**
- Consumes: `validateQuoteDeposit` (Task 1), `quotes.depositType/depositPercent/depositAmount`, `invoices.depositDue` (Task 3).
- Produces: issued acceptance invoices carry `depositDue`; a quote whose deposit config became unsatisfiable cannot be sent (409 `DEPOSIT_INVALID`).

- [ ] **Step 1: Write failing tests** — (a) `sendQuote` on a draft with `depositType:'percent'` but zero one-time lines throws 409 with code `DEPOSIT_INVALID`; (b) `acceptQuote` on a quote with `depositAmount:'300.00'`, `depositType:'percent'` issues the invoice with `depositDue:'300.00'`; (c) `acceptQuote` on a no-deposit quote leaves `depositDue` null (assert the insert/update mock received no `depositDue` or null). Follow the existing mock setups in those test files.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- quoteAcceptService quoteLifecycle` → FAIL.

- [ ] **Step 3: Implement.**

**`sendQuote`** (`quoteLifecycle.ts`) — it already loads `quote`, `blocks`, `lines` before claiming the send. After the existing pre-claim guards add:

```ts
  // A deposit config can silently become unsatisfiable while drafting (e.g. the
  // last one-time line was deleted after the deposit was set) — recompute stores
  // NULL then, and this hard gate stops the quote going out with broken terms.
  if (quote.depositType && quote.depositType !== 'none') {
    const check = validateQuoteDeposit(
      lines as QuoteLineForMath[],
      quote.taxRate ? parseFloat(quote.taxRate) : null,
      { type: quote.depositType, percent: quote.depositPercent },
    );
    if (!check.ok) {
      throw new QuoteServiceError(`Cannot send: ${check.message}`, 409, 'DEPOSIT_INVALID');
    }
  }
```

(Import `validateQuoteDeposit` + `QuoteLineForMath` from `./quoteMath`.)

**`acceptQuote`** (`quoteAcceptService.ts`) — inside the `if (oneTime.length > 0)` issue branch, alongside the other `issueFields` assignments:

```ts
    // Deposit terms travel from the signed quote onto the issued invoice.
    // depositAmount was validated < dueOnAcceptanceTotal at send and the quote
    // is locked since, so it is safe to snapshot verbatim.
    if (quote.depositType !== 'none' && quote.depositAmount !== null) {
      issueFields.depositDue = quote.depositAmount;
    }
```

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/api test -- quoteAcceptService quoteLifecycle` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteLifecycle.ts apps/api/src/services/quoteAcceptService.ts \
        apps/api/src/services/quoteAcceptService.test.ts apps/api/src/services/quoteLifecycle.test.ts
git commit -m "feat(quotes): send-time deposit validation; acceptance snapshots deposit_due onto the invoice"
```

---

### Task 8: Checkout charges the deposit first (both entry points)

**Files:**
- Modify: `apps/api/src/services/invoiceCheckout.ts`, `apps/api/src/routes/portal/invoices.ts` (the `/pay` handler)
- Test: `apps/api/src/services/invoiceCheckout.test.ts` (extend/create), `apps/api/src/routes/portal/invoices.test.ts` (extend if present)

**Interfaces:**
- Consumes: `computeChargeNow` (Task 2), `invoices.depositDue` (Task 3).
- Produces: Stripe Checkout `unit_amount` = charge-now; line description `Deposit — Invoice X` when in deposit phase; `invoice_stripe_payments.amount` = charge-now; idempotency key stays `inv_${id}_${minor}` (amount-sensitive, so deposit vs balance sessions never collide).

- [ ] **Step 1: Write failing tests** — mock Stripe client (existing pattern in `stripe.test.ts` / checkout tests): (a) invoice with `depositDue:'3000.00'`, `amountPaid:'0.00'`, `balance:'10000.00'` → session created with `unit_amount` = 300000, product name starts `Deposit — `, mapping row amount `'3000.00'`; (b) same invoice after deposit paid (`amountPaid:'3000.00'`, `balance:'7000.00'`) → `unit_amount` 700000, plain product name; (c) no-deposit invoice unchanged (`unit_amount` = full balance).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- invoiceCheckout` → FAIL.

- [ ] **Step 3: Implement.** In BOTH `invoiceCheckout.ts` and the portal `/pay` handler, replace the balance-only block:

```ts
import { computeChargeNow } from '@breeze/shared';
// ...
  const chargeNow = computeChargeNow({
    depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance,
  });
  const chargeMinor = toMinorUnits(chargeNow.amount, inv.currencyCode);
  if (chargeMinor <= 0) { /* keep the existing NOTHING_TO_PAY handling */ }
```

Then use `chargeMinor` for `unit_amount`, the idempotency key (`inv_${inv.id}_${chargeMinor}` — same shape, now amount = charge-now), and the mapping row `amount: chargeNow.amount`; and label:

```ts
        product_data: {
          name: chargeNow.isDeposit
            ? `Deposit — Invoice ${inv.invoiceNumber ?? inv.id}`
            : `Invoice ${inv.invoiceNumber ?? inv.id}`,
        },
```

Keep `metadata.invoice_balance_cents` (webhook/settle reads it) but set it to `String(chargeMinor)` — grep `invoice_balance_cents` in `stripeSettle.ts`/`stripeReconcile.ts` first: if either compares it against the invoice balance, update that comparison to the session amount semantics (the settle path records what Stripe actually settled, so this is expected to be display-only — verify, don't assume).

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/api test -- invoiceCheckout portal/invoices stripe` → PASS (settle/reconcile suites must stay green: they are amount-agnostic).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceCheckout.ts apps/api/src/routes/portal/invoices.ts \
        apps/api/src/services/invoiceCheckout.test.ts
git commit -m "feat(billing): Stripe checkout charges deposit-first via computeChargeNow"
```

---

### Task 9: Due-date carve-out on issued invoices + richer payment-request email

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts` (new `updateIssuedDueDate`), `apps/api/src/routes/invoices/invoices.ts` (new PATCH route), `apps/api/src/services/email.ts` (`buildInvoiceTemplate`), `apps/api/src/services/invoicePdf.ts` (`sendInvoiceEmail`)
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/routes/invoices/invoices.test.ts`, `apps/api/src/services/email.test.ts` (extend each)

**Interfaces:**
- Consumes: `recomputeInvoiceStatus` (existing), `computeChargeNow` (Task 2).
- Produces: `PATCH /invoices/:id/due-date` body `{ dueDate: 'YYYY-MM-DD' }` → updated invoice + audit entry `invoice.due_date.updated`; `buildInvoiceTemplate` gains optional `amountDueNow?: string; amountPaid?: string` params; `POST /invoices/:id/send` (existing route, unchanged path) now shows "Amount due now" for deposit invoices — this IS the "Request balance payment" action.

- [ ] **Step 1: Write failing tests** — (a) `updateIssuedDueDate` on `status:'sent'` updates dueDate and returns old/new in audit payload; (b) it re-derives status: an `overdue` invoice moved to a future due date flips back to `partially_paid`/`sent` (assert `recomputeInvoiceStatus`-driven update); (c) it 409s (`INVALID_STATE`) on `draft`, `paid`, `void`; (d) route test: PATCH `/:id/due-date` with a bad date 400s, with a good date 200s and writes audit (mock `writeRouteAudit`, assert action `invoice.due_date.updated` with `{ oldDueDate, newDueDate }` in details); (e) `buildInvoiceTemplate({ ...base, amountDueNow: '$7,000.00', amountPaid: '$3,000.00' })` renders "Amount due now" and "Paid to date".

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

**Service** (`invoiceService.ts`, near `updateInvoice`):

```ts
/**
 * Due-date carve-out (deposit spec): the ONE field editable on an ISSUED invoice.
 * Due date is scheduling metadata, not signed financial content — the immutability
 * rule (billing-v1.1 roadmap) covers money/lines, which stay locked. Status is
 * re-derived so pushing the date out un-flags a premature 'overdue'.
 */
export async function updateIssuedDueDate(invoiceId: string, dueDate: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireOrgAccess(actor, inv.orgId);
  if (!['sent', 'partially_paid', 'overdue'].includes(inv.status)) {
    throw new InvoiceServiceError('Due date can only be changed on an open issued invoice', 409, 'INVALID_STATE');
  }
  const oldDueDate = inv.dueDate;
  await db.update(invoices).set({ dueDate, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  await recomputeInvoiceStatus(invoiceId); // overdue ↔ partially_paid/sent keys off due date
  const updated = await getOwnedInvoiceOr404(invoiceId);
  return { invoice: updated, audit: { orgId: inv.orgId, invoiceId, oldDueDate, newDueDate: dueDate } };
}
```

**Route** (`routes/invoices/invoices.ts`):

```ts
import { updateIssuedDueDate } from '../../services/invoiceService';
import { writeRouteAudit } from '../../services/auditEvents';

const dueDateSchema = z.object({ dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD') });

invoiceCrudRoutes.patch('/:id/due-date', scopes, writePerm, zValidator('param', idParam), zValidator('json', dueDateSchema), async (c) => {
  try {
    const { invoice, audit } = await updateIssuedDueDate(c.req.valid('param').id, c.req.valid('json').dueDate, invoiceActorFrom(c));
    writeRouteAudit(c, {
      orgId: audit.orgId,
      action: 'invoice.due_date.updated',
      resourceType: 'invoice',
      resourceId: audit.invoiceId,
      details: { oldDueDate: audit.oldDueDate, newDueDate: audit.newDueDate },
    });
    return c.json({ data: invoice });
  } catch (err) { return handleServiceError(c, err); }
});
```

(Register BEFORE the generic `patch('/:id', ...)`? Not needed — Hono matches `/:id/due-date` exactly; but add it ABOVE the `/:id/lines/:lineId` handlers for readability.)

**Email template** (`email.ts`) — `InvoiceEmailParams` gains `amountDueNow?: string; amountPaid?: string`; in `buildInvoiceTemplate` replace the `dueLine` construction:

```ts
  const dueNow = params.amountDueNow ?? params.total;
  const dueLine = params.dueDate
    ? `<p style="${BODY_PARA}">Amount due now: <strong>${escapeHtml(dueNow)}</strong> by <strong>${escapeHtml(params.dueDate)}</strong>.</p>`
    : `<p style="${BODY_PARA}">Amount due now: <strong>${escapeHtml(dueNow)}</strong>.</p>`;
  const paidLine = params.amountPaid
    ? `<p style="${MUTED_PARA}">Paid to date: ${escapeHtml(params.amountPaid)} of ${escapeHtml(params.total)}.</p>`
    : '';
```

…insert `${paidLine}` after `${dueLine}` in `body`, and mirror both in the `text` array. Keep the wording "Amount due now" for ALL invoices (it equals the total when no deposit exists — no behavioral fork in copy).

**Send path** (`invoicePdf.ts` `sendInvoiceEmail`) — where `buildInvoiceTemplate` is called:

```ts
    const chargeNow = computeChargeNow({ depositDue: invoice.depositDue, amountPaid: invoice.amountPaid, balance: invoice.balance });
    const template = buildInvoiceTemplate({
      // ...existing params...
      amountDueNow: formatMoney(chargeNow.amount, invoice.currencyCode ?? 'USD'),
      amountPaid: Number(invoice.amountPaid) > 0 ? formatMoney(invoice.amountPaid, invoice.currencyCode ?? 'USD') : undefined,
    });
```

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/api test -- invoiceService invoices email invoicePdf` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/routes/invoices/invoices.ts \
        apps/api/src/services/email.ts apps/api/src/services/invoicePdf.ts \
        apps/api/src/services/invoiceService.test.ts apps/api/src/routes/invoices/invoices.test.ts apps/api/src/services/email.test.ts
git commit -m "feat(billing): due-date edit on issued invoices + deposit-aware payment request email"
```

---

### Task 10: Quote PDF + portal/public quote payloads and views

**Files:**
- Modify: `apps/api/src/services/quotePdf.ts`, `apps/api/src/routes/portal/quotes.ts`, `apps/api/src/routes/quotesPublic.ts`, `apps/portal/src/components/portal/QuoteDetailView.tsx`, `apps/portal/src/components/portal/PublicQuoteView.tsx`, `apps/portal/src/components/portal/quoteBlocks.tsx` (whichever of the three renders the totals summary — grep `dueOnAcceptanceTotal` to find the exact spots)
- Test: `apps/api/src/services/quotePdf.test.ts` (extend)

**Interfaces:**
- Consumes: `quote.depositType/depositAmount`, derived `depositDueTotal`/`categoryBreakdown` (Task 5), `computeQuoteTotals` for the renderer-side breakdown.
- Produces: customer-facing summary shows category subtotals and, when a deposit is set, bold "Deposit due on acceptance" + "Remaining balance (due per terms)".

- [ ] **Step 1: PDF renderer.** `QuoteHeader` type in `quotePdf.ts` gains `depositType?: string | null; depositAmount?: string | null; categoryBreakdown?: { category: string; oneTimeTotal: string; monthlyTotal: string; annualTotal: string }[]`. In `renderRecurringSummary` (currently `quotePdf.ts:311`):

Category breakdown — insert after the divider (`y += 8;`), before the One-time row, muted rows only when >1 category:

```ts
  const breakdown = quote.categoryBreakdown ?? [];
  if (breakdown.length > 1) {
    for (const b of breakdown) {
      const label = b.category === 'other' ? 'Other' : b.category[0]!.toUpperCase() + b.category.slice(1);
      const parts: string[] = [];
      if (Number(b.oneTimeTotal) > 0) parts.push(formatMoney(b.oneTimeTotal, currency));
      if (Number(b.monthlyTotal) > 0) parts.push(`${formatMoney(b.monthlyTotal, currency)}/mo`);
      if (Number(b.annualTotal) > 0) parts.push(`${formatMoney(b.annualTotal, currency)}/yr`);
      doc.font('Helvetica').fontSize(9).fillColor('#9ca3af');
      doc.text(label, labelX, y, { width: labelW, align: 'left' });
      doc.text(parts.join(' + '), c.colAmtX - 60, y, { width: c.colNumW + 60, align: 'right' });
      y += 12;
    }
    y += 4;
  }
```

Deposit rows — replace the single emphasis row:

```ts
  const hasDeposit = quote.depositType && quote.depositType !== 'none' && quote.depositAmount != null;
  if (hasDeposit) {
    drawRow('Deposit due on acceptance', quote.depositAmount, '', { emphasis: true });
    const remainderCents = toCents(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal) - toCents(quote.depositAmount);
    drawRow('Remaining balance (due per terms)', fromCents(remainderCents), '', { bold: true });
  } else {
    drawRow('Due on acceptance', quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, '', { emphasis: true });
  }
```

(Import `toCents`/`fromCents` from `@breeze/shared`.) The callers that build `QuoteHeader` (PDF route, `quoteLifecycle.sendQuote`, portal PDF path) must pass `categoryBreakdown` — compute it there via `computeQuoteTotals(lines, taxRate, depositConfig)` if not already flowing from `getQuote`.

- [ ] **Step 2: PDF test.** Extend `quotePdf.test.ts`: render a quote with `depositType:'percent', depositAmount:'330.00', dueOnAcceptanceTotal:'1100.00'` and hardware+other lines; assert the PDF buffer is produced and (using the existing text-extraction helper in that test file, if present) contains `Deposit due on acceptance` and `Remaining balance`; assert a no-deposit quote still renders `Due on acceptance`. Run: `pnpm --filter @breeze/api test -- quotePdf` → PASS.

- [ ] **Step 3: Portal/public API payloads.** Grep `dueOnAcceptanceTotal` in `apps/api/src/routes/portal/quotes.ts` and `apps/api/src/routes/quotesPublic.ts`. Wherever the quote payload is serialized with it, the handlers either reuse `getQuote` (then nothing to do — Task 5 added the fields) or compute totals locally — in that case pass the deposit config third arg and add to the payload:

```ts
    depositType: quote.depositType,
    depositAmount: quote.depositAmount,
    depositDueTotal: totals.depositDueTotal,
    categoryBreakdown: totals.categoryBreakdown,
```

Lines serialized through `toCustomerLines` keep `depositEligible`/`itemType` automatically (only `unitCost` is stripped) — that is fine and intended (the customer can see what the deposit covers).

- [ ] **Step 4: Portal components.** In the totals/summary section of `QuoteDetailView.tsx` and `PublicQuoteView.tsx` (shared summary lives in `quoteBlocks.tsx` if both import it — follow the existing `dueOnAcceptanceTotal` rendering):

```tsx
  {quote.categoryBreakdown && quote.categoryBreakdown.length > 1 && (
    <div className="text-sm text-muted-foreground space-y-0.5" data-testid="quote-category-breakdown">
      {quote.categoryBreakdown.map((b) => (
        <div key={b.category} className="flex justify-between">
          <span className="capitalize">{b.category}</span>
          <span>
            {[
              Number(b.oneTimeTotal) > 0 ? fmt(b.oneTimeTotal) : null,
              Number(b.monthlyTotal) > 0 ? `${fmt(b.monthlyTotal)}/mo` : null,
              Number(b.annualTotal) > 0 ? `${fmt(b.annualTotal)}/yr` : null,
            ].filter(Boolean).join(' + ')}
          </span>
        </div>
      ))}
    </div>
  )}
  {quote.depositDueTotal ? (
    <>
      <div className="flex justify-between text-lg font-semibold" data-testid="quote-deposit-due">
        <span>Deposit due on acceptance</span><span>{fmt(quote.depositDueTotal)}</span>
      </div>
      <div className="flex justify-between text-sm" data-testid="quote-deposit-remainder">
        <span>Remaining balance (due per terms)</span>
        <span>{fmt(String(Number(quote.dueOnAcceptanceTotal) - Number(quote.depositDueTotal)))}</span>
      </div>
    </>
  ) : (/* keep the existing "Due on acceptance" row */)}
```

Match the file's existing formatting helper (`fmt` above is a placeholder — use whatever the component already uses for money). Use `data-testid` attributes as shown (E2E convention). Extend the components' local types with the new payload fields.

- [ ] **Step 5: Verify + commit.** Run `pnpm --filter @breeze/api test -- quotePdf portal quotesPublic` and `pnpm --filter @breeze/portal test` (if the portal app has a test script; otherwise `pnpm --filter @breeze/portal build` for type-checking). Expected: PASS/clean.

```bash
git add apps/api/src/services/quotePdf.ts apps/api/src/services/quotePdf.test.ts \
        apps/api/src/routes/portal/quotes.ts apps/api/src/routes/quotesPublic.ts apps/portal/src
git commit -m "feat(quotes): deposit + category breakdown on PDF, portal and public quote views"
```

---

### Task 11: Portal invoice view — deposit strip + deposit-aware Pay button

**Files:**
- Modify: `apps/api/src/routes/portal/invoices.ts` (list select), `apps/portal/src/components/portal/InvoiceDetailView.tsx`, `apps/portal/src/components/portal/InvoiceList.tsx`
- Test: portal component tests alongside, if the app has them; otherwise type-check via build

**Interfaces:**
- Consumes: `computeChargeNow` from `@breeze/shared` (browser-safe), `invoices.depositDue` (detail payload carries the full row already; the LIST select must add `depositDue: invoices.depositDue`).

- [ ] **Step 1: API list payload.** In the portal `GET /invoices` select (`routes/portal/invoices.ts:43-53`), add `depositDue: invoices.depositDue`.

- [ ] **Step 2: Detail view.** In `InvoiceDetailView.tsx`, near the balance display:

```tsx
import { computeChargeNow } from '@breeze/shared';
// ...
const chargeNow = computeChargeNow({
  depositDue: invoice.depositDue ?? null,
  amountPaid: invoice.amountPaid,
  balance: invoice.balance,
});
```

Render (only when `invoice.depositDue`):

```tsx
  <div className="rounded-md border p-3 text-sm" data-testid="invoice-deposit-strip">
    {chargeNow.isDeposit
      ? <>Deposit of <strong>{fmt(invoice.depositDue)}</strong> due — {fmt(invoice.amountPaid)} of {fmt(invoice.total)} paid.</>
      : <>Deposit paid — remaining balance {fmt(invoice.balance)}.</>}
  </div>
```

And the Pay button label: `chargeNow.isDeposit ? \`Pay deposit ${fmt(chargeNow.amount)}\` : \`Pay ${fmt(chargeNow.amount)}\`` (the server charges the same rule, so label and charge can't diverge).

- [ ] **Step 3: List badge.** In `InvoiceList.tsx` rows where status is badged, add when `inv.depositDue`:

```tsx
  {Number(inv.amountPaid) < Number(inv.depositDue) ? (
    <span className="badge-warning" data-testid="deposit-unpaid-badge">Deposit unpaid</span>
  ) : (
    <span className="badge-success" data-testid="deposit-paid-badge">Deposit paid</span>
  )}
```

(Use the file's existing badge component/classes — these class names are placeholders; match siblings exactly.)

- [ ] **Step 4: Verify + commit.** `pnpm --filter @breeze/portal build` (and tests if present) → clean.

```bash
git add apps/api/src/routes/portal/invoices.ts apps/portal/src
git commit -m "feat(portal): deposit strip, deposit-aware pay button and list badges on invoices"
```

---

### Task 12: Web MSP UI — quote editor deposit controls, invoice detail, badges

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts` (types + payloads), `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (totals rail + per-line toggle), `apps/web/src/components/billing/quotes/QuoteDocument.tsx` (preview summary — mirror Task 10's portal rendering), `apps/web/src/components/billing/quotes/QuotesPage.tsx` (list badge), `apps/web/src/components/billing/InvoiceDetail.tsx` (deposit strip + due-date edit + request payment), `apps/web/src/components/billing/InvoicesPage.tsx` (list badge), `apps/web/src/lib/api/…` invoice client (due-date PATCH)
- Modify: `apps/api/src/services/quoteService.ts` — NO; list badge needs `listQuotes` join (see Step 5, modifies `quoteService.ts` `listQuotes`)
- Test: co-located component tests where siblings have them (jsdom); the deposit-math wiring itself is covered by shared tests

- [ ] **Step 1: API client types.** In `apps/web/src/lib/api/quotes.ts` extend the Quote type with `depositType: 'none' | 'percent' | 'selected_lines'; depositPercent: string | null; depositAmount: string | null; depositDueTotal?: string | null; categoryBreakdown?: { category: string; oneTimeTotal: string; monthlyTotal: string; annualTotal: string }[]`, the line type with `depositEligible: boolean; itemType: 'hardware' | 'software' | 'service' | null`, and the update-quote/update-line payload types with the corresponding optional fields. Do the same for the invoice client type (`depositDue: string | null`) and add:

```ts
export async function updateInvoiceDueDate(id: string, dueDate: string) {
  return apiPatch(`/invoices/${id}/due-date`, { dueDate }); // follow the file's existing request helper
}
```

- [ ] **Step 2: QuoteEditor totals rail.** The rail already computes optimistic totals via the shared `computeQuoteTotals` — pass the deposit config third arg from editor state so the live deposit figure updates mid-edit. Add a "Deposit" section to the rail:

```tsx
  <div className="space-y-2" data-testid="quote-deposit-controls">
    <Label>Deposit</Label>
    <Select value={quote.depositType} onValueChange={(v) => saveDeposit({ depositType: v })}>
      <SelectItem value="none">No deposit</SelectItem>
      <SelectItem value="percent">Percent of due-on-acceptance</SelectItem>
      <SelectItem value="selected_lines">Selected lines</SelectItem>
    </Select>
    {quote.depositType === 'percent' && (
      <Input type="number" min={0.01} max={99.99} step={0.01}
        value={depositPercentDraft}
        onBlur={() => saveDeposit({ depositPercent: Number(depositPercentDraft) })}
        data-testid="deposit-percent-input" />
    )}
    {liveTotals.depositDueTotal && (
      <div className="flex justify-between font-medium" data-testid="deposit-due-figure">
        <span>Deposit due</span><span>{fmt(liveTotals.depositDueTotal)}</span>
      </div>
    )}
  </div>
```

`saveDeposit` wraps the existing quote-header PATCH in `runAction` (the editor already has a header-update path — extend its payload). Surface the API's 400 `DEPOSIT_*` message via the standard `runAction` failure toast. Render the category breakdown under the totals (same shape as Task 10 Step 4).

- [ ] **Step 3: Per-line toggle.** In the line row editor (where `taxable`/`customerVisible` toggles live), when `quote.depositType === 'selected_lines'`, show a checkbox bound to `line.depositEligible`, PATCHing via the existing line-update call with `{ depositEligible: checked }` (`data-testid="line-deposit-eligible"`). New catalog hardware lines arrive pre-checked from the API (Task 5) — no client defaulting.

- [ ] **Step 4: Invoice detail (web).** In `InvoiceDetail.tsx`: same deposit strip as the portal (Task 11 Step 2, reuse `computeChargeNow`); an inline due-date editor visible when `['sent','partially_paid','overdue'].includes(invoice.status)` calling `updateInvoiceDueDate` through `runAction` (`data-testid="invoice-due-date-edit"`); and ensure the existing "Send invoice" action reads naturally as the request-payment action — relabel the button to `Request payment` when `Number(invoice.amountPaid) > 0 && Number(invoice.balance) > 0`, keeping the same POST `/invoices/:id/send` call.

- [ ] **Step 5: List badges.** `InvoicesPage.tsx`: same badge condition as portal (Task 11 Step 3). `QuotesPage.tsx` + `listQuotes` (API): join the converted invoice so the badge reflects money state — in `apps/api/src/services/quoteService.ts` `listQuotes`, change the final select to a left join:

```ts
  const rows = await db.select({
    quote: quotes,
    invoiceDepositDue: invoices.depositDue,
    invoiceAmountPaid: invoices.amountPaid,
  }).from(quotes)
    .leftJoin(invoices, eq(invoices.id, quotes.convertedInvoiceId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(quotes.createdAt), desc(quotes.id))
    .limit(query.limit);
  return rows.map((r) => ({ ...r.quote, invoiceDepositDue: r.invoiceDepositDue, invoiceAmountPaid: r.invoiceAmountPaid }));
```

(Import `invoices` from `../db/schema/invoices`. Update the `listQuotes` unit test mocks for the new shape.) Badge logic in `QuotesPage.tsx`: `depositType !== 'none'` → show `Deposit` chip; if `status === 'converted'` and `invoiceDepositDue` present → `Deposit paid`/`Deposit unpaid` per `invoiceAmountPaid >= invoiceDepositDue`.

- [ ] **Step 6: Verify + commit.** `pnpm --filter @breeze/web test` and `pnpm --filter @breeze/api test -- quoteService` → PASS; `pnpm --filter @breeze/web build` → clean.

```bash
git add apps/web/src apps/api/src/services/quoteService.ts apps/api/src/services/quoteService.test.ts
git commit -m "feat(web): quote deposit controls, invoice deposit strip, due-date edit, deposit badges"
```

---

### Task 13: MCP/AI tools

**Files:**
- Modify: `apps/api/src/services/aiToolsQuotes.ts` (`manage_quotes`), the invoice read/manage tool in `apps/api/src/services/aiToolsBilling*.ts` (grep `manage_invoices` / `get_invoice` for the exact file)
- Test: `apps/api/src/services/aiToolsQuotes.test.ts` (extend)

- [ ] **Step 1: Write failing test** — `manage_quotes` update action accepts `depositType`/`depositPercent` and passes them to `updateQuote`; quote read output includes `depositType`, `depositAmount`, `depositDueTotal`; line update accepts `depositEligible`.

- [ ] **Step 2: Implement.** In `aiToolsQuotes.ts`: add the three fields to the tool's input JSON schema (mirror how `taxRate` is declared — same optional/nullable conventions), thread them through the update-quote and update-line calls (the service validates; surface `QuoteServiceError.message` as the tool error string per the file's existing error handling), and include the deposit fields + `depositDueTotal`/`categoryBreakdown` in the serialized quote output. In the billing tool file: add `depositDue` and a derived `depositPaid: amountPaid >= depositDue` boolean to invoice serialization.

- [ ] **Step 3: Verify + commit.** `pnpm --filter @breeze/api test -- aiToolsQuotes aiToolsBilling` → PASS.

```bash
git add apps/api/src/services/aiToolsQuotes.ts apps/api/src/services/aiToolsQuotes.test.ts apps/api/src/services/aiToolsBilling*.ts
git commit -m "feat(ai): deposit fields in manage_quotes and invoice tools"
```

---

### Task 14: End-to-end integration test (real Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/quoteDeposit.integration.test.ts` (match the placement/naming of existing quote/invoice integration tests — if they live elsewhere, e.g. next to services as `*.integration.test.ts`, follow that; check how `invoicePdf.integration.test.ts` and the RLS suites bootstrap fixtures and copy that harness)

- [ ] **Step 1: Write the test** (this is the spec's required happy path):

1. Seed partner/org; create a draft quote; add a hardware catalog line ($6,200 taxable), a manual labor line ($2,400), a monthly line ($300); set 10% tax.
2. `updateQuote` with `{ depositType: 'selected_lines' }` → `deposit_amount` = `6820.00` (6200 + 620 tax); catalog line has `depositEligible=true`, `itemType='hardware'`.
3. Send → accept (`acceptQuote` with signer) → assert: invoice issued with `total='9460.00'` (8600 + 860 tax), `depositDue='6820.00'`; quote `converted`; monthly line produced a draft contract.
4. `computeChargeNow(invoice)` → `{ amount: '6820.00', isDeposit: true }`.
5. `recordPayment` of `6820.00` → status `partially_paid`, `balance='2640.00'`; `computeChargeNow` now → `{ amount: '2640.00', isDeposit: false }`.
6. `updateIssuedDueDate` to a future date succeeds and is reflected.
7. `recordPayment` of `2640.00` → status `paid`.
8. Also assert the content hash stored on `quote_acceptances` differs from the same quote hashed with deposit stripped (deposit terms were signed).

- [ ] **Step 2: Run it** — integration config, real DB (see `vitest.integration.config.ts`; DB on :5433 per the integration-run conventions — copy the invocation from an existing integration suite's header comment or CI job):

```bash
pnpm --filter @breeze/api test:integration -- quoteDeposit
```
Expected: PASS.

- [ ] **Step 3: Full suites + drift check**

```bash
pnpm test --filter=@breeze/shared --filter=@breeze/api
pnpm db:check-drift
```
Expected: all green, no drift.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/quoteDeposit.integration.test.ts
git commit -m "test(quotes): deposit accept→deposit→balance integration happy path"
```

---

## Self-review notes (already applied)

- **Spec coverage:** deposit config/editor (T4/T5/T12), per-line toggle + catalog defaulting (T4/T5/T12), category breakdown (T1/T10/T12), accept snapshot + content hash (T6/T7), pay-amount rule both entry points (T2/T8), due-date carve-out + audit (T9), request-payment email (T9/T12), portal views (T10/T11), badges (T11/T12), MCP (T13), integration test (T14). Void+reissue needs NO code: `depositDue` simply isn't copied by the reissue path (verify in T7's tests if the reissue builder copies columns explicitly — if it clones the row wholesale, add an explicit `depositDue: null` there).
- **Out of scope (per spec):** fixed-dollar deposits, partner default percent, payment plans, accounting push.
- **Type consistency:** `computeChargeNow` consumes `{ depositDue, amountPaid, balance }` money strings everywhere; `depositDueTotal` (quote-derived) vs `depositAmount` (quote-persisted) vs `depositDue` (invoice-persisted) naming is deliberate and used consistently above.
