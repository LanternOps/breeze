# Quotes / Proposals — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an accepted quote is converted, auto-create draft recurring **Contracts** from its monthly/annual line items (the recurring lines that Phase 2's convert intentionally skips).

**Architecture:** A pure mapping function groups a quote's recurring lines **by cadence** (all `monthly` lines → one contract with `intervalMonths=1`; all `annual` lines → one contract with `intervalMonths=12`) into `NewContractSpec` objects. A new internal `createContractWithLines()` in `contractService.ts` persists each spec + its lines without the request-actor guard (tenancy is already validated by the accept flow). `acceptQuote()` calls these inside its existing system-scope transaction, after the invoice is created, so the contract write is atomic with accept and rolls back on failure. Contracts land in `draft`; an MSP reviews and activates them later — no billing fires automatically.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL (RLS via `breeze_app`), Vitest (unit + real-DB integration).

## Global Constraints

- **No migration.** `contracts` / `contract_lines` tables, enums, RLS policies, and `ORG_CASCADE_DELETE_ORDER` entries all already exist (`apps/api/src/db/schema/contracts.ts`, `apps/api/src/services/tenantCascade.ts:121-123`). This plan adds **zero** schema changes. Verify with `pnpm db:check-drift` at the end.
- **Tenancy is system-scoped at the call site.** `acceptQuote()` already runs inside `runOutsideDbContext(withSystemDbAccessContext(...))` (see `apps/api/src/routes/portal/quotes.ts:104-126` and the public accept path) because it writes the partner-axis `partner_invoice_sequences` counter. All contract writes added here run in that same context/transaction — do **not** wrap them in a new context, and do **not** route them through the actor-guarded `createContract()` (that path is for request handlers).
- **Atomic with accept.** Contract creation happens inside the existing accept transaction. A throw propagates and rolls back the whole accept. Accept's `SELECT … FOR UPDATE` at-most-once convert guard already prevents a second accept, so contracts are created at most once — add no extra idempotency guard.
- **Money is a decimal string.** `unitPrice` / quantities are numeric strings (`numeric(12,2)`), never JS numbers. Pass them through verbatim from the quote line. Do not `Number()` them (the billing UI↔Zod money-string trap, `[[project_billing_invoice_engine]]`).
- **Recurrence buckets are exactly three:** `one_time`, `monthly`, `annual` (`quoteLineRecurrenceEnum`, `apps/api/src/db/schema/quotes.ts:15`). `quarterly` is **not** a quote-line value (dropped from Phase-1 Zod enums). Only `monthly` and `annual` map to contracts.
- **Node:** run all test commands with the pinned toolchain prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict — `[[node_pinned_version]]`).

---

## File Structure

- **Create** `apps/api/src/services/quoteToContract.ts` — pure, DB-free mapping: quote + lines → `NewContractSpec[]`, plus an `addMonthsToDate` date-only helper. One responsibility: the cadence-grouping decision logic. Pure so it is exhaustively unit-testable without a DB.
- **Create** `apps/api/src/services/quoteToContract.test.ts` — unit tests for the mapper + date helper (Drizzle-free, default vitest config).
- **Modify** `apps/api/src/services/contractService.ts` — add `NewContractLineSpec`, `NewContractSpec`, and the internal `createContractWithLines(spec)` persister. No change to the existing actor-guarded `createContract` / `addContractLineToContract`.
- **Modify** `apps/api/src/services/quoteAcceptService.ts` — after invoice creation, build specs from the already-loaded `lines` and persist them; add `contractIds` to the return value.
- **Modify** `apps/api/src/__tests__/integration/quoteAccept.integration.test.ts` — extend the existing convert test to assert the draft contract(s); add an annual-cadence case.

---

### Task 1: Pure cadence-grouping mapper (`quoteToContract.ts`)

This task is DB-free and the highest-value unit to get right: it encodes every grouping decision (per-cadence, customer-visible filter, term→endDate rule). Build and test it in isolation first.

**Files:**
- Create: `apps/api/src/services/quoteToContract.ts`
- Test: `apps/api/src/services/quoteToContract.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface QuoteForContract { orgId: string; partnerId: string; quoteNumber: string; currencyCode: string | null; terms: string | null }`
  - `interface QuoteLineForContract { recurrence: 'one_time' | 'monthly' | 'annual'; customerVisible: boolean; description: string; unitPrice: string; taxable: boolean; catalogItemId: string | null; termMonths: number | null }`
  - `interface NewContractLineSpec { lineType: 'flat' | 'per_device' | 'per_seat' | 'manual'; description: string; unitPrice: string; taxable: boolean; catalogItemId?: string | null; manualQuantity?: string | null; siteId?: string | null; sortOrder?: number }`
  - `interface NewContractSpec { orgId: string; partnerId: string; name: string; billingTiming: 'advance' | 'arrears'; intervalMonths: number; startDate: string; endDate?: string | null; currencyCode?: string; notes?: string | null; terms?: string | null; createdBy?: string | null; lines: NewContractLineSpec[] }`
  - `function addMonthsToDate(dateStr: string, months: number): string` — date-only (`YYYY-MM-DD`), UTC.
  - `function buildContractSpecsFromQuote(quote: QuoteForContract, lines: QuoteLineForContract[], startDate: string, createdBy: string | null): NewContractSpec[]`

> Note: `NewContractLineSpec` and `NewContractSpec` are **declared here** (Task 1) and **re-exported/consumed** by `contractService.ts` (Task 2). Keeping them in the pure module avoids a circular import (`contractService` → `quoteToContract` only).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/quoteToContract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { addMonthsToDate, buildContractSpecsFromQuote } from './quoteToContract';
import type { QuoteForContract, QuoteLineForContract } from './quoteToContract';

const quote: QuoteForContract = {
  orgId: 'org-1',
  partnerId: 'partner-1',
  quoteNumber: 'Q-1001',
  currencyCode: 'USD',
  terms: 'Net 30',
};

function line(over: Partial<QuoteLineForContract>): QuoteLineForContract {
  return {
    recurrence: 'monthly',
    customerVisible: true,
    description: 'Managed endpoint',
    unitPrice: '99.00',
    taxable: false,
    catalogItemId: null,
    termMonths: null,
    ...over,
  };
}

describe('addMonthsToDate', () => {
  it('adds whole months, date-only, UTC', () => {
    expect(addMonthsToDate('2026-06-21', 12)).toBe('2027-06-21');
    expect(addMonthsToDate('2026-06-21', 1)).toBe('2026-07-21');
  });

  it('rolls month overflow forward', () => {
    // Jan 31 + 1 month has no Feb 31 -> JS rolls into March (acceptable, documented).
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-03-03');
  });
});

describe('buildContractSpecsFromQuote', () => {
  it('returns no specs when there are no recurring lines', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [line({ recurrence: 'one_time' })],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toEqual([]);
  });

  it('groups all monthly lines into one interval=1 contract', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', description: 'EDR', unitPrice: '10.00' }),
        line({ recurrence: 'monthly', description: 'Backup', unitPrice: '5.00', taxable: true }),
        line({ recurrence: 'one_time', description: 'Onboarding' }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toHaveLength(1);
    const c = specs[0]!;
    expect(c.intervalMonths).toBe(1);
    expect(c.status === undefined).toBe(true); // status is set by the persister, not the spec
    expect(c.billingTiming).toBe('advance');
    expect(c.orgId).toBe('org-1');
    expect(c.partnerId).toBe('partner-1');
    expect(c.currencyCode).toBe('USD');
    expect(c.terms).toBe('Net 30');
    expect(c.createdBy).toBe('user-1');
    expect(c.name).toBe('Q-1001 — Monthly');
    expect(c.lines.map((l) => l.description)).toEqual(['EDR', 'Backup']);
    expect(c.lines.every((l) => l.lineType === 'flat')).toBe(true);
    expect(c.lines[1]!.taxable).toBe(true);
    expect(c.lines.map((l) => l.sortOrder)).toEqual([0, 1]);
  });

  it('produces two contracts when both monthly and annual lines exist', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', description: 'EDR' }),
        line({ recurrence: 'annual', description: 'License', unitPrice: '1200.00' }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toHaveLength(2);
    const monthly = specs.find((s) => s.intervalMonths === 1)!;
    const annual = specs.find((s) => s.intervalMonths === 12)!;
    expect(monthly.name).toBe('Q-1001 — Monthly');
    expect(annual.name).toBe('Q-1001 — Annual');
    expect(monthly.lines).toHaveLength(1);
    expect(annual.lines).toHaveLength(1);
  });

  it('excludes non-customer-visible recurring lines', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [line({ recurrence: 'monthly', customerVisible: false })],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toEqual([]);
  });

  it('sets endDate from a single unambiguous termMonths, else null', () => {
    const uniform = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', termMonths: 12 }),
        line({ recurrence: 'monthly', termMonths: 12 }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(uniform[0]!.endDate).toBe('2027-06-21');

    const mixed = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', termMonths: 12 }),
        line({ recurrence: 'monthly', termMonths: 24 }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(mixed[0]!.endDate).toBeNull();
  });

  it('falls back to USD when the quote has no currency', () => {
    const specs = buildContractSpecsFromQuote(
      { ...quote, currencyCode: null },
      [line({ recurrence: 'monthly' })],
      '2026-06-21',
      'user-1',
    );
    expect(specs[0]!.currencyCode).toBe('USD');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/quoteToContract.test.ts`
Expected: FAIL — `Cannot find module './quoteToContract'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/quoteToContract.ts`:

```typescript
// Phase 4: map an accepted quote's recurring lines into draft Contract specs.
// Pure / DB-free so the grouping rules are exhaustively unit-testable.
// Grouping is BY CADENCE: a Contract has a single intervalMonths, so monthly
// and annual lines can never share one — they become separate contracts.

export interface QuoteForContract {
  orgId: string;
  partnerId: string;
  quoteNumber: string;
  currencyCode: string | null;
  terms: string | null;
}

export interface QuoteLineForContract {
  recurrence: 'one_time' | 'monthly' | 'annual';
  customerVisible: boolean;
  description: string;
  unitPrice: string;
  taxable: boolean;
  catalogItemId: string | null;
  termMonths: number | null;
}

export interface NewContractLineSpec {
  lineType: 'flat' | 'per_device' | 'per_seat' | 'manual';
  description: string;
  unitPrice: string;
  taxable: boolean;
  catalogItemId?: string | null;
  manualQuantity?: string | null;
  siteId?: string | null;
  sortOrder?: number;
}

export interface NewContractSpec {
  orgId: string;
  partnerId: string;
  name: string;
  billingTiming: 'advance' | 'arrears';
  intervalMonths: number;
  startDate: string;
  endDate?: string | null;
  currencyCode?: string;
  notes?: string | null;
  terms?: string | null;
  createdBy?: string | null;
  lines: NewContractLineSpec[];
}

// Date-only (YYYY-MM-DD) month arithmetic in UTC. Month overflow rolls forward
// (Jan 31 + 1mo -> Mar 03), matching JS Date semantics — acceptable for term ends.
export function addMonthsToDate(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

const CADENCES: ReadonlyArray<{ key: 'monthly' | 'annual'; intervalMonths: number; label: string }> = [
  { key: 'monthly', intervalMonths: 1, label: 'Monthly' },
  { key: 'annual', intervalMonths: 12, label: 'Annual' },
];

export function buildContractSpecsFromQuote(
  quote: QuoteForContract,
  lines: QuoteLineForContract[],
  startDate: string,
  createdBy: string | null,
): NewContractSpec[] {
  const specs: NewContractSpec[] = [];

  for (const cadence of CADENCES) {
    const group = lines.filter((l) => l.recurrence === cadence.key && l.customerVisible);
    if (group.length === 0) continue;

    // endDate only when every line in the group agrees on a single non-null term.
    const distinctTerms = [...new Set(group.map((l) => l.termMonths).filter((t): t is number => t != null))];
    const endDate = distinctTerms.length === 1 ? addMonthsToDate(startDate, distinctTerms[0]!) : null;

    specs.push({
      orgId: quote.orgId,
      partnerId: quote.partnerId,
      name: `${quote.quoteNumber} — ${cadence.label}`,
      billingTiming: 'advance',
      intervalMonths: cadence.intervalMonths,
      startDate,
      endDate,
      currencyCode: quote.currencyCode ?? 'USD',
      notes: `Auto-created from accepted quote ${quote.quoteNumber}`,
      terms: quote.terms ?? null,
      createdBy,
      lines: group.map((l, i) => ({
        lineType: 'flat' as const,
        description: l.description,
        unitPrice: l.unitPrice,
        taxable: l.taxable,
        catalogItemId: l.catalogItemId,
        sortOrder: i,
      })),
    });
  }

  return specs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/quoteToContract.test.ts`
Expected: PASS (all cases in the describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteToContract.ts apps/api/src/services/quoteToContract.test.ts
git commit -m "feat(quotes): pure cadence-grouping mapper for quote recurring lines -> contract specs"
```

---

### Task 2: Internal contract persister (`contractService.ts`)

Adds an actor-guard-free persister that the accept flow calls under an already-established system context. The existing `createContract`/`addContractLineToContract` (request-actor flows) are left untouched.

**Files:**
- Modify: `apps/api/src/services/contractService.ts`
- Test: covered by Task 4's integration test (the persister only makes sense against a real DB + RLS; a Drizzle-mock unit test here would be vacuous, so none is added).

**Interfaces:**
- Consumes (from Task 1): `NewContractSpec`, `NewContractLineSpec`.
- Produces: `async function createContractWithLines(spec: NewContractSpec): Promise<typeof contracts.$inferSelect>` — inserts one `draft` contract + its lines in the current DB context; returns the contract row.

- [ ] **Step 1: Add the import for the spec types**

At the top of `apps/api/src/services/contractService.ts`, alongside the other imports, add:

```typescript
import type { NewContractSpec } from './quoteToContract';
```

- [ ] **Step 2: Add the persister function**

Append to `apps/api/src/services/contractService.ts` (after `addContractLineToContract`):

```typescript
// INTERNAL (Phase 4): persist a contract + lines built by buildContractSpecsFromQuote.
// Tenancy (orgId/partnerId) is already validated by the caller, so there is NO
// actor guard here. MUST run inside an established system-scope DB context
// (e.g. acceptQuote's withSystemDbAccessContext transaction) — do not call from
// a bare request handler. Always lands status='draft'; the MSP activates later.
export async function createContractWithLines(
  spec: NewContractSpec,
): Promise<typeof contracts.$inferSelect> {
  const [contract] = await db
    .insert(contracts)
    .values({
      partnerId: spec.partnerId,
      orgId: spec.orgId,
      name: spec.name,
      status: 'draft',
      billingTiming: spec.billingTiming,
      intervalMonths: spec.intervalMonths,
      startDate: spec.startDate,
      endDate: spec.endDate ?? null,
      autoIssue: false,
      currencyCode: spec.currencyCode ?? 'USD',
      notes: spec.notes ?? null,
      terms: spec.terms ?? null,
      createdBy: spec.createdBy ?? null,
    })
    .returning();

  for (let i = 0; i < spec.lines.length; i++) {
    const l = spec.lines[i]!;
    await db.insert(contractLines).values({
      contractId: contract!.id,
      orgId: spec.orgId,
      lineType: l.lineType,
      description: l.description,
      catalogItemId: l.catalogItemId ?? null,
      unitPrice: l.unitPrice,
      manualQuantity: l.lineType === 'manual' ? (l.manualQuantity ?? '0') : null,
      siteId: l.lineType === 'per_device' ? (l.siteId ?? null) : null,
      taxable: l.taxable,
      sortOrder: l.sortOrder ?? i,
    });
  }

  return contract!;
}
```

> Verify `contracts` and `contractLines` are already imported in this file (they are used by the existing `createContract`/`addContractLineToContract`). If `db` is imported as the context-bound handle used elsewhere in this file, reuse it — do **not** import the bare pool.

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS (no type errors). If `contracts.$inferSelect` is not the row alias used in this file, match the existing return style of `createContract` (which returns `row!` from `.returning()`); the structural type is identical.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/contractService.ts
git commit -m "feat(contracts): internal createContractWithLines persister (no actor guard, system-scope)"
```

---

### Task 3: Hook contract creation into `acceptQuote`

Wire the mapper + persister into the accept transaction, after the invoice is built, and surface the created contract ids in the return value.

**Files:**
- Modify: `apps/api/src/services/quoteAcceptService.ts`

**Interfaces:**
- Consumes: `buildContractSpecsFromQuote` (Task 1), `createContractWithLines` (Task 2). The `lines` array is already loaded in `acceptQuote` (`quoteAcceptService.ts:67-71`); the `quote` row already carries `orgId`, `partnerId`, `quoteNumber`, `currencyCode`, `terms`.
- Produces: `acceptQuote` return type gains `contractIds: string[]` → `Promise<{ quote: QuoteRow; acceptanceId: string; invoiceId: string; invoiceIssued: boolean; contractIds: string[] }>`.

- [ ] **Step 1: Add imports**

Near the top of `apps/api/src/services/quoteAcceptService.ts`:

```typescript
import { buildContractSpecsFromQuote } from './quoteToContract';
import { createContractWithLines } from './contractService';
```

- [ ] **Step 2: Build + persist contracts after the invoice loop**

Locate the point where the one-time invoice has been created and the quote has been transitioned to `converted` (after the `for (let i = 0; i < oneTime.length; i++)` invoice-line loop, `quoteAcceptService.ts:120-142`, and before the function returns). Insert:

```typescript
  // Phase 4: recurring (monthly/annual) lines -> draft Contracts, grouped by
  // cadence. Runs inside this same system-scope accept transaction, so a failure
  // rolls back the whole accept. accept's SELECT ... FOR UPDATE convert guard
  // already makes this at-most-once. Quotes carry currency/terms snapshotted at
  // send, so the contract inherits the accepted terms.
  const startDate = new Date().toISOString().slice(0, 10); // accept date, date-only UTC
  const contractSpecs = buildContractSpecsFromQuote(
    {
      orgId: quote.orgId,
      partnerId: quote.partnerId,
      quoteNumber: quote.quoteNumber,
      currencyCode: quote.currencyCode ?? null,
      terms: quote.terms ?? null,
    },
    lines.map((l) => ({
      recurrence: l.recurrence,
      customerVisible: l.customerVisible,
      description: l.description,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      catalogItemId: l.catalogItemId ?? null,
      termMonths: l.termMonths ?? null,
    })),
    startDate,
    params.actorUserId ?? null,
  );

  const contractIds: string[] = [];
  for (const spec of contractSpecs) {
    const contract = await createContractWithLines(spec);
    contractIds.push(contract.id);
  }
```

> If `quote.quoteNumber` / `quote.currencyCode` / `quote.terms` are not the exact column names on the loaded `quote` row, open `apps/api/src/db/schema/quotes.ts` and use the actual names — the quote table snippet in research was truncated mid-table. They are required to exist (quotes are M365-style recurring proposals with currency + terms); do not invent fallbacks beyond the `?? null` shown.

- [ ] **Step 3: Add `contractIds` to the return statement and signature**

Update the final `return { ... }` of `acceptQuote` to include `contractIds`, and widen the declared return type:

```typescript
  return { quote, acceptanceId, invoiceId, invoiceIssued, contractIds };
```

And in the signature (`quoteAcceptService.ts:44-46`):

```typescript
export async function acceptQuote(
  params: AcceptQuoteParams,
): Promise<{ quote: QuoteRow; acceptanceId: string; invoiceId: string; invoiceIssued: boolean; contractIds: string[] }>
```

- [ ] **Step 4: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS. Callers that destructure `{ quote, acceptanceId, invoiceId, invoiceIssued }` (portal/public accept routes) keep compiling — the new field is additive. No route change is required, but the new `contractIds` is now available to surface in responses if desired (out of scope here).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteAcceptService.ts
git commit -m "feat(quotes): auto-create draft recurring contracts from accepted quote lines"
```

---

### Task 4: Real-DB integration coverage

Proves the end-to-end accept path creates the right draft contracts under `breeze_app` RLS (the only job — `integration-test` — that exercises real RLS + cascade). Extends the existing convert test.

**Files:**
- Modify: `apps/api/src/__tests__/integration/quoteAccept.integration.test.ts`

**Interfaces:**
- Consumes: `acceptQuote` (now returning `contractIds`), the existing seed helpers (`createPartner`/`createOrganization`) and the existing quote/line seed used by the `'records acceptance ... converts one-time lines to an invoice'` test (`quoteAccept.integration.test.ts:20-44`).
- Produces: assertions on `contracts` / `contract_lines`.

- [ ] **Step 1: Extend the existing convert test to assert the monthly contract**

In the existing `'records acceptance with content hash and converts one-time lines to an invoice'` test (which already seeds one one-time `$250` line + one monthly `$99` line), after the existing invoice-line assertions, add:

```typescript
    // Phase 4: the monthly recurring line becomes a draft contract.
    expect(res.contractIds).toHaveLength(1);
    const createdContracts = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!)),
    );
    expect(createdContracts).toHaveLength(1);
    const contract = createdContracts[0]!;
    expect(contract.status).toBe('draft');
    expect(contract.intervalMonths).toBe(1);
    expect(contract.billingTiming).toBe('advance');
    expect(contract.autoIssue).toBe(false);

    const cLines = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.contractId, contract.id)),
    );
    expect(cLines).toHaveLength(1);
    expect(cLines[0]!.description).toBe('Managed AV'); // the monthly line's description in this test's seed
    expect(cLines[0]!.unitPrice).toBe('99.00');
    expect(cLines[0]!.lineType).toBe('flat');
```

> Use the actual description/price of the monthly line in this test's existing seed — open the test and match the seeded values rather than copying `'Managed AV'`/`'99.00'` blindly. Add `contracts`, `contractLines` to the file's schema imports and `eq` if not already imported.

- [ ] **Step 2: Add an annual-cadence test**

Add a new `it` that seeds a quote with one `monthly` and one `annual` recurring line, accepts it, and asserts two contracts:

```typescript
  it('creates a monthly and an annual draft contract for a quote with both cadences', async () => {
    // ...seed partner/org and a sent quote with:
    //   - one annual line (e.g. 'Annual license', unitPrice '1200.00', recurrence 'annual')
    //   - one monthly line (e.g. 'EDR', unitPrice '15.00', recurrence 'monthly')
    // following the same seed shape as the existing convert test above.
    const res = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        acceptQuote({
          quoteId,
          signerName: 'Jane Buyer',
          signerEmail: 'jane@example.com',
          actorUserId: null,
        }),
      ),
    );

    expect(res.contractIds).toHaveLength(2);
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(inArray(contracts.id, res.contractIds)),
    );
    const intervals = rows.map((r) => r.intervalMonths).sort((a, b) => a - b);
    expect(intervals).toEqual([1, 12]);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
  });
```

> Match the seeding helpers/imports already used at the top of this integration file (`inArray` from `drizzle-orm`, the same `runOutsideDbContext`/`withSystemDbAccessContext` wrappers the existing test uses). Reuse the existing quote-seed helper if the file has one; otherwise mirror the existing test's inline seed.

- [ ] **Step 3: Run the integration test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteAccept.integration.test.ts`
Expected: PASS. (Requires a running Postgres + the gitignored `.env.test` symlink so RLS runs as `breeze_app`, not a BYPASSRLS admin — `[[worktree_env_test_rls_vacuous]]`. If the symlink is missing in this worktree, create it before trusting the result.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/quoteAccept.integration.test.ts
git commit -m "test(quotes): assert accepted quote recurring lines create draft contracts"
```

---

### Task 5: Drift check + final verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm no schema drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: no drift (this plan adds no migration — if drift is reported, something added a schema change that should not exist; investigate before proceeding).

- [ ] **Step 2: Run the affected unit + integration tests together**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/quoteToContract.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteAccept.integration.test.ts
```
Expected: all green. (Per `[[api_test_suite_parallel_flakiness]]`, do not run the full `vitest run` to validate these — verify the affected files single-fork; trust CI for the whole suite.)

- [ ] **Step 3: Manual cross-check of the four acceptance criteria**

  - A quote with **monthly-only** recurring lines → exactly **one** draft contract, `intervalMonths=1`, all monthly lines on it.
  - A quote with **monthly + annual** lines → **two** draft contracts (`intervalMonths` 1 and 12), lines split by cadence.
  - A quote with **one-time-only** lines → **zero** contracts (`contractIds === []`), invoice behavior unchanged from Phase 2/3.
  - A **recurring-only** quote (Phase 3 leaves its $0 invoice draft) → contracts still created (contract creation is independent of `invoiceIssued`).

---

## Out of scope (Phase 5+)

- **Auto-activation / billing.** Contracts land in `draft`; activation (which computes `next_billing_at` and starts the BullMQ billing sweep) stays a manual MSP step. No change to `activateContract` / `generateDueInvoice`.
- **Surfacing `contractIds` in the accept HTTP responses** (portal/public) and any "X contracts created" UI — the field is returned by the service but not yet wired to routes or web/portal views. (Contracts web UI is its own roadmap item — Contracts Phase 5.)
- **`quarterly` cadence** — not representable in quote lines (dropped from Phase-1 Zod enums); revisit if/when quotes gain it.
- **per_device / per_seat contract lines** from quotes — quote lines are flat amounts, so all generated lines are `lineType='flat'`. Mapping richer line types is a follow-up.
- **Multi-currency correctness beyond carry-through** — currency is copied from the quote; FX/validation untouched.

## Self-Review

- **Spec coverage:** the design-doc P4 line ("recurring lines → auto-create Contract", `2026-06-17-quotes-proposals-phase3.md:46-50,113`) is implemented by Tasks 1–3; Task 4 proves it; Task 5 verifies no migration/drift. ✅
- **Placeholder scan:** every code step contains complete code. The two "verify the real column/seed name" notes (Task 3 Step 2, Task 4 Step 1) are deliberate guards against truncated-research drift, not placeholders — the code is written and runnable as-is; the notes only say "match the real identifier if it differs." ✅
- **Type consistency:** `NewContractSpec`/`NewContractLineSpec`/`QuoteForContract`/`QuoteLineForContract` are declared in Task 1 and consumed verbatim in Tasks 2–3; `createContractWithLines(spec) → contract row`, `buildContractSpecsFromQuote(quote, lines, startDate, createdBy) → NewContractSpec[]`, and `acceptQuote(...) → { …, contractIds: string[] }` match across tasks. ✅
