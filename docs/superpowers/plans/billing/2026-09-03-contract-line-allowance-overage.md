---
tracking_issue: LanternOps/breeze#3205
---

# Contract Line Included Quantity and Overage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a counted contract line carry a fixed allowance — "up to 25 devices included" — and dispose of the extras either by billing them at a second rate or by flagging them for a human, so that the two most common MSP contract shapes stop being expressed as a hand-retyped `manual` line.

**Architecture:** Three nullable columns and one new enum on `contract_lines`, guarded by one NULL-safe CHECK. One pure module (`contractAllowance.ts`) is the single definition of `counted → { billed, overage }` and of overage money; `resolveLineQty` (estimate, contracts list, MRR rollup) and `generateDueInvoice`'s own switch both route through it, so the four paths can never disagree on quantities. A billed overage becomes a **sibling** invoice line (`parentLineId = null`) inserted straight after its base line; a flagged overage writes nothing and is reported on the estimate, the generate result, the nightly worker log and the UI. Every money leg this wave touches goes through `multiplyToCurrency` / `toCents` / `fromCents` — no `Number(a) * b`.

**Tech Stack:** Postgres 16, Drizzle ORM, Hono, Zod 4.4.3, Vitest (unit + `vitest.integration.config.ts` real-DB suites), React + react-i18next (8 locales), Astro.

**Spec:** `docs/superpowers/specs/billing/2026-09-03-contract-line-allowance-overage-design.md`

**Wave:** #3205 W04 (wave sub-issue #4653; feature request #4607). Branch from `main` **after W03 merges**: `feature/3205-allowance-overage/wave-4653`.

---

## Global Constraints

The spec's binding rules. Every one of them is load-bearing; none is a preference.

1. **Fixed-allowance economics (settled in the roadmap, restated by the spec's decision 4).** With `included_quantity` set, the base line bills `included_quantity` **every period whether the count reaches it or not**, and `overage = max(0, counted − included)`. `counted = 0` still bills the allowance. There is no `min()` mode; if one is ever wanted it is a fourth column, not a reinterpretation.
2. **The overage invoice line is a SIBLING, not a child: `parentLineId = null`** (decision 8). Lineage is `sourceType: 'contract'`, `sourceId` = the contract line id, `sourceContractId` = the contract id; `insertLineAndRecompute`'s `max(sortOrder) + 1` puts it at `base.sortOrder + 1`. **This supersedes the roadmap's W04 brief**, which said `parentLineId` = the base invoice line: every existing parent-child consumer treats a child as a *bundle breakdown row* — `computeInvoiceProfit` filters `parentLineId === null` and would drop the overage revenue from margin entirely (`apps/web/src/components/billing/invoiceTypes.ts:271-284`), `InvoiceDocument`/`InvoiceDetail` indent and mute it on the customer-facing document, and `InvoiceEditor` renders children read-only so the operator could not edit or delete it. Consequences, all simplifications: **no `parentLineId` parameter on `addContractLine`** and **no change to the reissue clone** (it already copies `sourceType`/`sourceId`/`sourceContractId`/`sortOrder` verbatim for top-level lines).
3. **Exact-money primitives only, on every leg this wave touches.** `multiplyToCurrency(qty, price, currencyCode)` for a line value, `toCents`/`fromCents` for accumulation. `Number(l.unitPrice) * quantity` is removed from `listContracts`, `computeContractEstimate` and `summarizeActiveContractMrrByOrg`. Legs W04 does **not** touch are out of scope — a wholesale sweep is its own change.
4. **`included_quantity` ⇔ `overage_mode`, and `overage_unit_price` iff `overage_mode = 'bill'`.** All-or-nothing in the CHECK *and* in `contractLineInvariantIssues`, in **both** of W03's modes — a patch must never be able to create a row `add_line` would reject. `included_quantity > 0` and integral. `overage_unit_price >= 0` (zero means "itemised at no charge" and still writes a customer-visible zero-value line).
5. **A wave-2 `unresolved` line short-circuits the allowance**: a `per_device_group` line whose group is gone resolves to `{ counted: 0, billed: 0, included: null, overage: 0, overageMode: null, live: true, unresolved: 'group_deleted' }`. Reporting `billed: 25` for a line generation will refuse with `GROUP_DELETED` would put a number on the estimate no invoice can carry.
6. **Flagged overage never invoices silently.** `flag` writes no invoice line and no zero-quantity placeholder; it appears in `overages[]` with `mode: 'flag'` and drives one worker `console.warn`, one warning toast on manual generation, and the UI rendering. **Billed overage gets no worker warning** — it is on the invoice, so it is not silence.
7. **`generateDueInvoice` asserts an ambient transaction.** `assertInTransaction('generateDueInvoice')` is its first statement, before `lockContractRow`. Without a context every write lands on the bare pool with no GUC, where forced RLS on `breeze_app` silently matches 0 rows (#1375) — and W04 doubles the writes per line.
8. **`changeContractCurrency` is `CURRENCY_LOCKED` when any line carries a non-null `overage_unit_price`.** Its reprice loop writes only `unit_price` and cannot re-derive a hand-entered rate from a price book, so a catalog-linked line with an overage rate would silently keep a wrong-currency number. Same refusal class as the existing non-catalog refusal.
9. **Export policy: all three columns are `included`.** `contract_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`; the export-policy row is the only registration list that fires on a **new column**, and it fires here. No new table ⇒ no RLS, cascade, device-detach or org-merge registration.
10. **Migration ceiling: re-check before creating the file.** Run `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -3`. The floor is W02's `2026-10-06-100100-…`; this plan names `2026-10-07-100000-…`. If anything newer landed, bump the date past it and keep the `-100000-` time component. **`2026-08-06` is a closed date block** — never wedge a file into it.
11. **W02/W03 symbols come from their plans, not from this worktree's code.** This branch is cut after both merge. The names this plan uses, taken from the **W03 plan** (`docs/superpowers/plans/billing/2026-09-03-contract-line-editing.md`, which exists and is authoritative over the W04 spec's paraphrase of it):

    | Symbol | W03 plan anchor |
    |---|---|
    | `contractLineInvariantIssues(l: ContractLineShape, { mode: 'create' \| 'persisted' }): ContractLineInvariantIssue[]` | Task 1 Step 3 |
    | `ContractLineShape`, `PersistedContractLine`, `MergedContractLine` | Task 1 Step 3 / Step 5 |
    | `updateContractLineSchema` (strict, tri-state), `UpdateContractLineInput`, `patchHasKey(patch, key)` | Task 1 Step 5 |
    | `mergeContractLinePatch(current, patch, resolved?)` | Task 1 Step 5 |
    | `updateContractLine(contractId, lineId, patch, actor) → { line, audit }` | Task 4 Step 9 |
    | `diffLineAudit(before, after, c)` + `AUDITED_LINE_COLUMNS` | Task 4 Step 8 |
    | `withLineRefs(lines)`, `writeLineAudit(c, action, audit)`, `auditContractToolEvent(auth, action, audit)` | W03 file map |
    | `orgSnapshot(orgId, dc, groupIds)`, `resolvableLines(lines, snapshot)` | W02 plan Task 5 Step 4 |

    **Verify each before starting** — `grep -rn 'contractLineInvariantIssues\|updateContractLineSchema\|patchHasKey\|withLineRefs\|diffLineAudit\|AUDITED_LINE_COLUMNS' packages/shared/src apps/api/src` — and re-point this plan at whatever actually shipped. Nothing in the design depends on the spelling. Note the W04 **spec** quotes the helper as `contractLineInvariantIssues(l, { allowOrphanGroup })` and calls the audit differ `diffAudit`; both are stale paraphrases — the W03 plan's `{ mode }` and `diffLineAudit` are what ship.
12. **One test file at a time:** `cd apps/api && npx vitest run <path>` — never `pnpm --filter … test -- --run <path>` (the `--` is swallowed and the whole suite runs in watch mode). Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` with the test stack up and `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test` exported (the `worktree-stack` skill, or `docker compose -f docker-compose.test.yml up -d`). API typecheck: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`.
13. **New integration tests must live under `apps/api/src/__tests__/integration/`.** `vitest.integration.config.ts`'s `include` is a hand-curated list plus that one directory glob — a co-located `*.integration.test.ts` elsewhere runs in **zero** CI jobs.
14. **The integration harness TRUNCATEs the core tables before every test** (`src/__tests__/integration/setup.ts` `beforeEach`). Seed inline in each test; never memoize a fixture across tests. `devices.site_id` is NOT NULL — every seeded device needs a site in its own org.

### Explicitly NOT in this wave

The spec's open question 1 asks Todd to sign off on renaming #4547 (block hours)'s draft `included_hours` / `overage_rate` to W04's `included_quantity` / `overage_unit_price`. That edits a **different, unmerged spec** (`spec/4547-block-hours`) that another agent authored and that is awaiting his answers. **Do not touch it from this wave.** W04's obligation to #4547 is discharged entirely by `applyAllowance`'s `baseBillingMode` parameter and by the CHECK comment naming the DROP + re-ADD it will need — both of which are in this plan.

### One deliberate deviation from the spec

The spec's §"Allowance arithmetic" says the module "deliberately exposes no money function" and shows each caller writing `multiplyToCurrency(r.overage, l.overageUnitPrice!, cur)` inline. **This plan exports `overageValue(r, spec, currencyCode)` from `contractAllowance.ts` instead** (the wave brief asks for it), because the same expression otherwise appears in four callers and inline duplication is exactly how `Number(a) * b` creeps back in. The spec's stated reason for the "no money" rule — keeping the module free of the contract-line enum so #4547 can import it — is unaffected: `multiplyToCurrency` is a pure exact-decimal function from `@breeze/shared` with no DB and no enum. Everything else in the module is as specified.

---

## File map

| File | Change |
|---|---|
| `apps/api/src/services/contractAllowance.ts` (new, + `.test.ts`) | `applyAllowance`, `billsOverage`, `overageValue`, the three types |
| `packages/shared/src/validators/contracts.ts` (+ `.test.ts`) | `OVERAGE_MODES`, `ALLOWANCE_LINE_TYPES`, three fields on `contractLineInputSchema` + `updateContractLineSchema` + `ContractLineShape`, five rules in `contractLineInvariantIssues` (both modes), three columns through `mergeContractLinePatch` |
| `apps/api/migrations/2026-10-07-100000-contract-lines-allowance-overage.sql` (new) | `CREATE TYPE` + three `ADD COLUMN` + `contract_lines_allowance_chk`, one file |
| `apps/api/src/db/schema/contracts.ts` | `contractOverageModeEnum`, three Drizzle columns |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | three `included` columns on `contract_lines` |
| `apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts` (new) | full presence matrix against the real CHECK, enum labels, migration replay |
| `apps/api/src/services/contractService.ts` (+ `.test.ts`) | `resolveLineQty` shape, `OverageSummary`, estimate/list/MRR exact money, writers + representability, `changeContractCurrency` refusal, generation + `overages[]` |
| `apps/api/src/services/quoteToContract.ts` | three optional fields on `NewContractLineSpec` (W05 populates them) |
| `apps/api/src/db/index.ts` (+ new `assertInTransaction.test.ts`) | `assertInTransaction(label)` |
| `apps/api/src/services/invoiceService.ts` | `costBasis?: string \| null` input on `addContractLine`, non-catalog path only |
| `apps/api/src/__tests__/integration/contractLineAllowance.integration.test.ts` (new) | boundary matrix with tax, zero-price child, catalog base + price-book gap, per_seat, re-run, fault-injection rollback, missing-context guard |
| `apps/api/src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts` (new) | currency restamp refusal, void/reissue clone, the pinned `SOURCE_NOT_FOUND` limitation |
| `apps/api/src/services/accounting/quickbooksProvider.test.ts` | base + overage push, no `ItemRef` on the overage |
| `apps/api/src/jobs/contractWorker.ts` (+ `.test.ts`) | one `console.warn` per flagged overage |
| `apps/api/src/routes/contracts/contracts.test.ts` | estimate + generate carry the new fields |
| `apps/api/src/services/aiToolsContracts.ts` (+ `.manageContracts.test.ts`) | allowance prose on `line` and `patch` |
| `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` | allowance columns seeded and asserted in `contract_lines.json` |
| `apps/web/src/lib/api/contracts.ts`, `components/contracts/lineTypes.ts` | `OverageMode`, `OverageSummary`, line + estimate fields, `ALLOWANCE_TYPES` |
| `apps/web/src/components/contracts/AllowanceCell.tsx` (new) | `AllowanceCell` + `OverageNotice` |
| `apps/web/src/components/contracts/ContractEditor.tsx`, `ContractDetail.tsx` (+ new tests) | allowance block on the add form and W03's edit form, quantity cells, notice, flagged toast |
| `apps/web/src/components/billing/invoiceTypes.test.ts`, `InvoiceDocument.test.tsx` | decision-8 regression pins |
| `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` | 15 new keys × 8 locales |
| `apps/docs/src/content/docs/features/contracts.mdx` | "Included quantity and overage" section |

---

### Task 1: Allowance arithmetic module and the shared validator rules

**Files:**
- Create: `apps/api/src/services/contractAllowance.ts`
- Create: `apps/api/src/services/contractAllowance.test.ts`
- Modify: `packages/shared/src/validators/contracts.ts` (the `money` primitive is W03's; `contractLineInvariantIssues`, `ContractLineShape`, `contractLineInputSchema`, `updateContractLineSchema`, `mergeContractLinePatch` are all W03's)
- Modify: `packages/shared/src/validators/contracts.test.ts` (append; the W01/W02/W03 describes stay **unedited** — that is the parity proof)

**Interfaces:**

```ts
// apps/api/src/services/contractAllowance.ts
export type { OverageMode };                                  // re-exported from @breeze/shared
export type BaseBillingMode = 'included_units' | 'single_block';
export interface AllowanceSpec {
  includedQuantity: string | null;
  overageMode: OverageMode | null;
  overageUnitPrice: string | null;
}
export interface ResolvedQuantity {
  counted: number; billed: number; included: number | null; overage: number; overageMode: OverageMode | null;
}
export function applyAllowance(counted: number, spec: AllowanceSpec, baseBillingMode: BaseBillingMode): ResolvedQuantity;
export function billsOverage(r: ResolvedQuantity): boolean;
export function overageValue(r: ResolvedQuantity, spec: Pick<AllowanceSpec, 'overageUnitPrice'>, currencyCode: string): string;

// packages/shared/src/validators/contracts.ts
export const OVERAGE_MODES = ['bill', 'flag'] as const;
export type OverageMode = typeof OVERAGE_MODES[number];
export const ALLOWANCE_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
// ContractLineShape gains: includedQuantity?, overageMode?, overageUnitPrice? (all `| null`)
```

- [ ] **Step 1: Write the failing allowance-module test**

Create `apps/api/src/services/contractAllowance.test.ts`:

```ts
/**
 * #3205 W04 / #4607: the boundary matrix for the ONE definition of how a counted
 * quantity splits into billed + overage. Pure — no DB, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAllowance, billsOverage, overageValue,
  type AllowanceSpec, type ResolvedQuantity,
} from './contractAllowance';

const NONE: AllowanceSpec = { includedQuantity: null, overageMode: null, overageUnitPrice: null };
const BILL: AllowanceSpec = { includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' };
const FLAG: AllowanceSpec = { includedQuantity: '25.00', overageMode: 'flag', overageUnitPrice: null };

describe('applyAllowance — the boundary matrix (#4607)', () => {
  // counted, spec, expected { billed, included, overage, overageMode }, billsOverage
  it.each<[number, string, AllowanceSpec, Omit<ResolvedQuantity, 'counted'>, boolean]>([
    [0,  'none', NONE, { billed: 0,  included: null, overage: 0, overageMode: null }, false],
    [24, 'none', NONE, { billed: 24, included: null, overage: 0, overageMode: null }, false],
    [25, 'none', NONE, { billed: 25, included: null, overage: 0, overageMode: null }, false],
    [26, 'none', NONE, { billed: 26, included: null, overage: 0, overageMode: null }, false],
    // FIXED allowance: the base bills 25 even at counted 0.
    [0,  'bill', BILL, { billed: 25, included: 25, overage: 0, overageMode: 'bill' }, false],
    [24, 'bill', BILL, { billed: 25, included: 25, overage: 0, overageMode: 'bill' }, false],
    [25, 'bill', BILL, { billed: 25, included: 25, overage: 0, overageMode: 'bill' }, false],
    [26, 'bill', BILL, { billed: 25, included: 25, overage: 1, overageMode: 'bill' }, true],
    [0,  'flag', FLAG, { billed: 25, included: 25, overage: 0, overageMode: 'flag' }, false],
    [24, 'flag', FLAG, { billed: 25, included: 25, overage: 0, overageMode: 'flag' }, false],
    [25, 'flag', FLAG, { billed: 25, included: 25, overage: 0, overageMode: 'flag' }, false],
    // flag mode is OVER but never bills — the row that carries the design.
    [26, 'flag', FLAG, { billed: 25, included: 25, overage: 1, overageMode: 'flag' }, false],
  ])('counted %d, mode %s', (counted, _mode, spec, expected, bills) => {
    const r = applyAllowance(counted, spec, 'included_units');
    expect(r).toEqual({ counted, ...expected });
    expect(billsOverage(r)).toBe(bills);
  });

  it('no allowance is the identity under included_units', () => {
    for (const counted of [0, 1, 7, 1000]) {
      expect(applyAllowance(counted, NONE, 'included_units')).toEqual({
        counted, billed: counted, included: null, overage: 0, overageMode: null,
      });
    }
  });

  // The #4547 (block hours) contract: unit_price is the price of the whole block,
  // so the base quantity is 1 whether or not there is an allowance.
  it.each<[string, AllowanceSpec, number | null]>([
    ['without an allowance', NONE, null],
    ['with a bill allowance', { includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00' }, 10],
    ['with a flag allowance', { includedQuantity: '10.00', overageMode: 'flag', overageUnitPrice: null }, 10],
  ])('single_block always bills 1 %s', (_name, spec, included) => {
    for (const counted of [0, 9, 10, 11]) {
      const r = applyAllowance(counted, spec, 'single_block');
      expect(r.billed).toBe(1);
      expect(r.included).toBe(included);
      expect(r.overage).toBe(included === null ? 0 : Math.max(0, counted - included));
    }
  });

  it('a fractional includedQuantity parses (hours stay usable for #4547)', () => {
    const r = applyAllowance(9.25, { includedQuantity: '7.50', overageMode: 'bill', overageUnitPrice: '150.00' }, 'single_block');
    expect(r).toEqual({ counted: 9.25, billed: 1, included: 7.5, overage: 1.75, overageMode: 'bill' });
  });
});

describe('overageValue — exact decimal money (#4607)', () => {
  const over = (overage: number, mode: 'bill' | 'flag' = 'bill'): ResolvedQuantity =>
    ({ counted: 25 + overage, billed: 25, included: 25, overage, overageMode: mode });

  // A double gets this wrong: 0.02 * 7.25 === 0.14499999999999999 -> '0.14'.
  // multiplyToCurrency works in scaled-integer space: 0.145 -> half-up -> '0.15'.
  it('rounds half-up on the EXACT decimal, not on a double', () => {
    expect(overageValue(over(0.02), { overageUnitPrice: '7.25' }, 'USD')).toBe('0.15');
  });

  it('multiplies a whole overage at the stamped rate', () => {
    expect(overageValue(over(3), { overageUnitPrice: '12.00' }, 'USD')).toBe('36.00');
  });

  it('is the currency-scaled zero when nothing is billed', () => {
    expect(overageValue(over(0), { overageUnitPrice: '12.00' }, 'USD')).toBe('0.00');
    expect(overageValue(over(2, 'flag'), { overageUnitPrice: '12.00' }, 'USD')).toBe('0.00');
    expect(overageValue(over(0), { overageUnitPrice: null }, 'JPY')).toBe('0');
  });

  it('respects a zero-decimal currency', () => {
    expect(overageValue(over(3), { overageUnitPrice: '100' }, 'JPY')).toBe('300');
  });

  it('an overage rate of 0 is itemised at no charge, not skipped', () => {
    const r = over(1);
    expect(billsOverage(r)).toBe(true);
    expect(overageValue(r, { overageUnitPrice: '0.00' }, 'USD')).toBe('0.00');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractAllowance.test.ts`
Expected: FAIL — `Failed to resolve import "./contractAllowance"`.

- [ ] **Step 3: Implement the module**

Create `apps/api/src/services/contractAllowance.ts`:

```ts
/**
 * Pure allowance arithmetic (#3205 W04 / #4607). No DB, no I/O, no line-type
 * enum. The ONE definition of how a counted quantity splits into billed +
 * overage, called by resolveLineQty (estimate, contracts list, MRR rollup) AND
 * by generateDueInvoice's own switch, so the four paths can never disagree on
 * QUANTITIES.
 *
 * `baseBillingMode` is an explicit PARAMETER rather than a lineType switch so
 * this module never imports the contract-line enum — which is what lets #4547
 * (block hours) reuse it while it is itself extending that enum.
 *
 * The one money function, `overageValue`, is a single call to the shared
 * exact-decimal primitive `multiplyToCurrency` (scaled-integer multiply, one
 * half-up round at the currency's minor unit). It lives here, not inline in the
 * four callers, because a duplicated money expression is how `Number(a) * b`
 * creeps back in. It imports no enum and touches no DB, so #4547's reuse is
 * unaffected. Accumulation across lines stays with the callers (toCents /
 * fromCents), because only they know what a "period total" is.
 */
import { multiplyToCurrency, type OverageMode } from '@breeze/shared';

export type { OverageMode };

/**
 * 'included_units' — the base line bills the ALLOWANCE (unit_price is per unit).
 *                    Every W04 line type.
 * 'single_block'   — the base line bills 1 (unit_price is the price of the whole
 *                    block; included_quantity is an entitlement in another unit).
 *                    #4547's hour_block.
 */
export type BaseBillingMode = 'included_units' | 'single_block';

/** The three allowance columns as they come off a contract_lines row. */
export interface AllowanceSpec {
  includedQuantity: string | null;
  overageMode: OverageMode | null;
  overageUnitPrice: string | null;
}

export interface ResolvedQuantity {
  /** What the resolver measured: devices, seats, manualQuantity, or 1 for flat. */
  counted: number;
  /** The quantity that goes on the BASE invoice line. */
  billed: number;
  /** The allowance, or null when this line has none. */
  included: number | null;
  /** max(0, counted - included). 0 when there is no allowance. */
  overage: number;
  overageMode: OverageMode | null;
}

/**
 * FIXED allowance (roadmap, settled): with an allowance the base bills the
 * ALLOWANCE every period, whether the count reaches it or not. Never min().
 */
export function applyAllowance(
  counted: number, spec: AllowanceSpec, baseBillingMode: BaseBillingMode,
): ResolvedQuantity {
  const included = spec.includedQuantity === null ? null : Number(spec.includedQuantity);
  if (included === null) {
    return {
      counted,
      billed: baseBillingMode === 'single_block' ? 1 : counted,
      included: null,
      overage: 0,
      overageMode: null,
    };
  }
  return {
    counted,
    billed: baseBillingMode === 'single_block' ? 1 : included,
    included,
    overage: Math.max(0, counted - included),
    overageMode: spec.overageMode,
  };
}

/** True when this line owes an overage INVOICE line this period. */
export function billsOverage(r: ResolvedQuantity): boolean {
  return r.overageMode === 'bill' && r.overage > 0;
}

/**
 * The overage leg's money, exact in `currencyCode`. `'0.00'` (or the
 * zero-decimal currency's `'0'`) whenever nothing is billed — a flag-mode line,
 * a line inside its allowance, or a line with no rate — so a caller can always
 * add it without a branch. The overage leg is never catalog-priced, so this is
 * the same number the estimate and the invoice both show.
 */
export function overageValue(
  r: ResolvedQuantity,
  spec: Pick<AllowanceSpec, 'overageUnitPrice'>,
  currencyCode: string,
): string {
  const bills = billsOverage(r) && spec.overageUnitPrice !== null;
  return multiplyToCurrency(bills ? r.overage : 0, bills ? spec.overageUnitPrice! : '0', currencyCode);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractAllowance.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit the module**

```bash
git add apps/api/src/services/contractAllowance.ts apps/api/src/services/contractAllowance.test.ts
git commit -m "feat(billing): pure allowance arithmetic — applyAllowance, billsOverage, overageValue (#3205 W04)"
```

- [ ] **Step 6: Write the failing validator tests**

Append to `packages/shared/src/validators/contracts.test.ts`:

```ts
// #3205 W04 (#4607): included quantity + overage. The five rules live in
// contractLineInvariantIssues and are IDENTICAL in both modes — an allowance is
// equally legal on a new line and on a merged patch row, and a patch must never
// be able to create a row add_line would reject.
describe('allowance invariants (#3205 W04)', () => {
  const ALLOWANCE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
  // Minimum extra columns each type needs so ONLY the allowance rules can fire.
  const shapeFor = (lineType: string) => ({
    lineType,
    ...(lineType === 'per_device_role' ? { deviceRoles: ['server'] } : {}),
    ...(lineType === 'per_device_group' ? { deviceGroupId: '33333333-3333-4333-8333-333333333333', deviceGroupName: 'VIP' } : {}),
    ...(lineType === 'manual' ? { manualQuantity: '2' } : {}),
  }) as never;
  const paths = (l: unknown, mode: 'create' | 'persisted') =>
    contractLineInvariantIssues(l as never, { mode }).map((i) => i.path).sort();

  const allowance = { includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' } as const;

  it.each(['create', 'persisted'] as const)('accepts a bill allowance on all four counted types (%s mode)', (mode) => {
    for (const lineType of ALLOWANCE_TYPES) {
      expect(paths({ ...shapeFor(lineType), ...allowance }, mode)).toEqual([]);
    }
  });

  it.each(['create', 'persisted'] as const)('accepts a flag allowance with no price (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'flag' }, mode)).toEqual([]);
  });

  it.each(['create', 'persisted'] as const)('rejects any allowance column on flat and manual (%s mode)', (mode) => {
    for (const lineType of ['flat', 'manual'] as const) {
      expect(paths({ ...shapeFor(lineType), includedQuantity: '25', overageMode: 'flag' }, mode)).toContain('includedQuantity');
      expect(paths({ ...shapeFor(lineType), overageUnitPrice: '12.00' }, mode)).toContain('includedQuantity');
    }
  });

  it.each(['create', 'persisted'] as const)('requires includedQuantity and overageMode together (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25' }, mode)).toContain('overageMode');
    expect(paths({ ...shapeFor('per_device'), overageMode: 'flag' }, mode)).toContain('overageMode');
  });

  it.each(['create', 'persisted'] as const)('rejects a zero or fractional includedQuantity (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_seat'), includedQuantity: '0', overageMode: 'flag' }, mode)).toContain('includedQuantity');
    expect(paths({ ...shapeFor('per_seat'), includedQuantity: '25.5', overageMode: 'flag' }, mode)).toContain('includedQuantity');
    expect(paths({ ...shapeFor('per_seat'), includedQuantity: '25.00', overageMode: 'flag' }, mode)).toEqual([]);
  });

  it.each(['create', 'persisted'] as const)('ties overageUnitPrice to bill mode exactly (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'flag', overageUnitPrice: '12.00' }, mode)).toContain('overageUnitPrice');
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'bill' }, mode)).toContain('overageUnitPrice');
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '0.00' }, mode)).toEqual([]);
  });

  // The null-shaped read layer must reach the SAME verdicts as the
  // undefined-shaped write layer — the parity W03's present() refactor exists
  // to guarantee. An explicit null is "not applicable", never "set".
  it('a null-shaped merged row reaches the same verdicts as an omitted-key one', () => {
    const nulled = { ...shapeFor('per_device'), includedQuantity: null, overageMode: null, overageUnitPrice: null };
    expect(paths(nulled, 'persisted')).toEqual([]);
    expect(paths({ ...nulled, includedQuantity: '25' }, 'persisted')).toContain('overageMode');
    expect(paths({ ...shapeFor('flat'), includedQuantity: null, overageMode: null, overageUnitPrice: null }, 'persisted')).toEqual([]);
  });
});

describe('contractLineInputSchema — allowance fields (#3205 W04)', () => {
  const base = { description: 'Endpoints', unitPrice: '10.00', taxable: true } as const;
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v);

  it('accepts a bill allowance and a flag allowance', () => {
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' }).success).toBe(true);
    expect(parse({ ...base, lineType: 'per_seat', includedQuantity: '25', overageMode: 'flag' }).success).toBe(true);
  });

  it('rejects the five violations through the schema too', () => {
    expect(parse({ ...base, lineType: 'flat', includedQuantity: '25', overageMode: 'flag' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', overageMode: 'bill', overageUnitPrice: '1.00' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '0', overageMode: 'flag' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25.5', overageMode: 'flag' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'flag', overageUnitPrice: '12.00' }).success).toBe(false);
  });

  it('rejects null and a negative price at the TYPE layer, before any invariant runs', () => {
    // .optional(), never .nullable() — the add schema omits absent keys.
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: null, overageMode: null }).success).toBe(false);
    // money's ^\d+(\.\d{1,2})?$ is non-negative by construction.
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '-1.00' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'sometimes' }).success).toBe(false);
  });
});

describe('updateContractLineSchema — allowance fields (#3205 W04)', () => {
  const parse = (v: unknown) => updateContractLineSchema.safeParse(v);

  it('accepts null for all three (removing an allowance is a legitimate edit)', () => {
    const out = parse({ includedQuantity: null, overageMode: null, overageUnitPrice: null });
    expect(out.success).toBe(true);
    expect(Object.keys(out.data!).sort()).toEqual(['includedQuantity', 'overageMode', 'overageUnitPrice']);
  });

  it('preserves key ABSENCE, so an omitted field is unchanged (Zod 4.4.3 tri-state)', () => {
    const out = parse({ includedQuantity: '25', overageMode: 'flag' });
    expect(out.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out.data!, 'overageUnitPrice')).toBe(false);
  });

  it('rejects a negative or non-money price and an unknown mode', () => {
    expect(parse({ overageUnitPrice: '-1.00' }).success).toBe(false);
    expect(parse({ overageMode: 'sometimes' }).success).toBe(false);
  });
});

describe('mergeContractLinePatch carries the allowance columns (#3205 W04)', () => {
  const current = {
    lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
  } as never;

  it('an omitted key preserves the current value', () => {
    expect(mergeContractLinePatch(current, { description: 'x' } as never)).toMatchObject({
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
    });
  });

  it('all three nulls remove the allowance and the merged row is valid', () => {
    const merged = mergeContractLinePatch(current, { includedQuantity: null, overageMode: null, overageUnitPrice: null } as never);
    expect(merged).toMatchObject({ includedQuantity: null, overageMode: null, overageUnitPrice: null });
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' })).toEqual([]);
  });

  it('clearing only includedQuantity leaves a row the persisted rules reject', () => {
    const merged = mergeContractLinePatch(current, { includedQuantity: null } as never);
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' }).map((i) => i.path)).toContain('overageMode');
  });
});
```

Add `contractLineInvariantIssues`, `updateContractLineSchema` and `mergeContractLinePatch` to the file's existing import from `./contracts` if W03 did not already import them there.

- [ ] **Step 7: Run to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: FAIL — the allowance keys are stripped by `contractLineInputSchema`, rejected as unrecognized by the strict `updateContractLineSchema`, and every invariant expectation returns `[]`.

- [ ] **Step 8: Implement the validator changes**

In `packages/shared/src/validators/contracts.ts`, beside `CONTRACT_LINE_TYPES`:

```ts
// #3205 W04 (#4607): what happens to the units above included_quantity.
// 'bill' adds a second invoice line at overage_unit_price; 'flag' invoices
// nothing and reports the excess for a human. The DB twin is the
// contract_overage_mode enum.
export const OVERAGE_MODES = ['bill', 'flag'] as const;
export type OverageMode = typeof OVERAGE_MODES[number];

/** Line types that accept an allowance (#4607). The DB twin is the type list in
 *  contract_lines_allowance_chk. #4547's hour_block joins this set. */
export const ALLOWANCE_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
const ALLOWANCE_LINE_TYPE_SET: ReadonlySet<string> = new Set(ALLOWANCE_LINE_TYPES);
```

`ContractLineShape` (W03) gains:

```ts
  // #3205 W04: all three are NULL together on a line with no allowance, and
  // always NULL on flat/manual.
  includedQuantity?: string | null;
  overageMode?: OverageMode | null;
  overageUnitPrice?: string | null;
```

In `contractLineInvariantIssues`, append these five rules **before the `return issues`**, outside any `mode` branch (they are identical in both modes on purpose — see the comment):

```ts
  // ---- #3205 W04 (#4607): included quantity + overage ----------------------
  // IDENTICAL IN BOTH MODES, deliberately: an allowance is equally legal on a
  // new line and on a merged patch row, so a patch can never create a row that
  // add_line would have rejected. Every rule below has a NULL-safe twin in
  // contract_lines_allowance_chk.
  const hasAllowanceColumn =
    present(l.includedQuantity) || present(l.overageMode) || present(l.overageUnitPrice);
  if (hasAllowanceColumn && !ALLOWANCE_LINE_TYPE_SET.has(l.lineType)) {
    issues.push({ path: 'includedQuantity', message: 'an allowance is only valid on per_device, per_device_role, per_device_group and per_seat lines' });
  }
  // Two-way, like deviceRoles: an allowance with no disposition for the extras
  // is the silent under-bill this wave removes.
  if (present(l.includedQuantity) !== present(l.overageMode)) {
    issues.push({ path: 'overageMode', message: "includedQuantity and overageMode must be set together — choose overageMode 'flag' to cap without billing; clear all three to remove an allowance" });
  }
  // 0 included with 'bill' is arithmetically a plain per-unit line at the
  // overage rate; one spelling only.
  if (present(l.includedQuantity) && !(Number(l.includedQuantity) > 0)) {
    issues.push({ path: 'includedQuantity', message: 'includedQuantity must be greater than 0' });
  }
  // You cannot include 25.5 devices or 25.5 seats. (#4547 scopes this rule when
  // hour_block joins ALLOWANCE_LINE_TYPES — hours are fractional.)
  if (present(l.includedQuantity) && !Number.isInteger(Number(l.includedQuantity))) {
    issues.push({ path: 'includedQuantity', message: 'includedQuantity must be a whole number of devices or seats' });
  }
  // A price is present iff it is actually charged. A rate parked on a 'flag'
  // line reads as a charge on the detail page and in the tenant export.
  if (present(l.overageUnitPrice) !== (l.overageMode === 'bill')) {
    issues.push({ path: 'overageUnitPrice', message: "overageUnitPrice is required for overageMode 'bill' and not allowed for 'flag'" });
  }
```

`contractLineInputSchema` gains three **`.optional()`** fields (never `.nullable()` — a `null` must fail at the type layer like every other add field), beside `deviceRoles`:

```ts
  // #3205 W04: the allowance. money's ^\d+(\.\d{1,2})?$ already excludes
  // negatives; the > 0 / integral / pairing rules are in the invariant table.
  includedQuantity: money.optional(),
  overageMode: z.enum(OVERAGE_MODES).optional(),
  overageUnitPrice: money.optional(),
```

`updateContractLineSchema` (W03) gains all three as **`.nullable().optional()`** — the `siteId` treatment, not the `deviceRoles` one, because clearing an allowance leaves the perfectly valid pre-W04 shape:

```ts
  // #3205 W04: nullable because REMOVING an allowance is a legitimate edit and
  // leaves a valid row (unlike clearing deviceRoles/deviceGroupId). The two-way
  // rule runs on the MERGED row, so `{ includedQuantity: null }` alone is a 400
  // INVALID_LINE_PATCH naming the fix; the edit form's "remove allowance"
  // control sends all three nulls in one patch.
  includedQuantity: money.nullable().optional(),
  overageMode: z.enum(OVERAGE_MODES).nullable().optional(),
  overageUnitPrice: money.nullable().optional(),
```

`PersistedContractLine` (W03) gains the three as required read-layer fields — `includedQuantity: string | null; overageMode: OverageMode | null; overageUnitPrice: string | null;` — and `mergeContractLinePatch` merges them exactly like `siteId`, through `patchHasKey`, because all three are tri-state:

```ts
    // #3205 W04: tri-state like siteId — key present (even as null) is a change,
    // key absent leaves the current value. `patch.x ?? current.x` would be wrong:
    // it cannot tell "remove the allowance" from "leave it alone".
    includedQuantity: patchHasKey(patch, 'includedQuantity') ? (patch.includedQuantity ?? null) : current.includedQuantity,
    overageMode: patchHasKey(patch, 'overageMode') ? (patch.overageMode ?? null) : current.overageMode,
    overageUnitPrice: patchHasKey(patch, 'overageUnitPrice') ? (patch.overageUnitPrice ?? null) : current.overageUnitPrice,
```

- [ ] **Step 9: Run to verify they pass — including the untouched W01/W02/W03 describes**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. The pre-existing describes must pass **with no edits** — that is the proof the allowance rules changed no existing behaviour.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts
git commit -m "feat(shared): allowance fields and the five overage invariants on contract lines (#3205 W04)"
```

---

### Task 2: Migration, Drizzle, export policy, the real-DB CHECK matrix, and the writers

**Files:**
- Create: `apps/api/migrations/2026-10-07-100000-contract-lines-allowance-overage.sql`
- Modify: `apps/api/src/db/schema/contracts.ts:15-17` (enum) and the `contractLines` table body
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `contract_lines` row)
- Create: `apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts`
- Modify: `apps/api/src/services/contractService.ts` — `addContractLineToContract` (`:866-913`), `createContractWithLinesDetailed` (`:1234-1268`), W03's `updateContractLine`
- Modify: `apps/api/src/services/quoteToContract.ts` (`NewContractLineSpec`)
- Test: `apps/api/src/services/contractService.test.ts`

**Interfaces:**
- Produces: `contract_lines.included_quantity numeric(12,2) NULL`, `.overage_mode contract_overage_mode NULL`, `.overage_unit_price numeric(12,2) NULL`; `contractOverageModeEnum`; `contractLines.includedQuantity | overageMode | overageUnitPrice` in Drizzle; `NewContractLineSpec.includedQuantity? | overageMode? | overageUnitPrice?`.

- [ ] **Step 1: Re-check the migration ceiling**

Run: `ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -3`
Expected (after W02 merges): `… 2026-10-06-100000-contract-line-type-per-device-group.sql`, `2026-10-06-100100-contract-lines-device-group.sql`. If anything sorts after `2026-10-07-100000`, bump this task's date past it and use that name everywhere below.

- [ ] **Step 2: Write the failing constraint matrix**

Create `apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts`:

```ts
/**
 * Real-DB truth table for the #3205 W04 (#4607) allowance invariants on
 * contract_lines, as breeze_app (forced RLS, no bypass). Mirrors
 * contractLinesDeviceRolesConstraints / contractLinesDeviceGroupConstraints.
 *
 * The point of the full PRESENCE MATRIX (all 8 null/non-null combinations of
 * the three columns, on all six line types) is that a CHECK passes on TRUE *or
 * NULL* — so every conjunct has to be proven to REJECT rather than abstain. A
 * three-valued comparison like `overage_mode <> 'bill'` would silently admit
 * rows and no single-case test would notice.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { partners, organizations, contracts } from '../../db/schema';

const MIGRATION = '2026-10-07-100000-contract-lines-allowance-overage.sql';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `AP ${sfx}`, slug: `ap-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'AOrg', slug: `ao-${sfx}` })
      .returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Allowance', intervalMonths: 1,
      startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgId: o!.id, contractId: c!.id };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

/** Insert one line, supplying only the per-type columns the OTHER CHECKs need,
 *  so a rejection can only ever come from contract_lines_allowance_chk. */
function insertLine(f: F, opts: {
  lineType: string;
  includedQuantity?: string | null;
  overageMode?: string | null;
  overageUnitPrice?: string | null;
}) {
  const roles = opts.lineType === 'per_device_role' ? sql`ARRAY['server']::text[]` : sql`NULL`;
  // A group line needs a stamped name and no site (contract_lines_device_group_chk);
  // a NULL device_group_id is the legal post-deletion state, so no group row is needed.
  const groupName = opts.lineType === 'per_device_group' ? sql`'VIP'` : sql`NULL`;
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_lines
      (contract_id, org_id, line_type, description, unit_price, taxable,
       device_roles, device_group_name, manual_quantity,
       included_quantity, overage_mode, overage_unit_price)
    VALUES
      (${f.contractId}::uuid, ${f.orgId}::uuid, ${opts.lineType}::contract_line_type, 'a', 10.00, true,
       ${roles}, ${groupName}, ${opts.lineType === 'manual' ? sql`2.00` : sql`NULL`},
       ${opts.includedQuantity ?? null}::numeric,
       ${opts.overageMode ?? null}::contract_overage_mode,
       ${opts.overageUnitPrice ?? null}::numeric)
    RETURNING id
  `));
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

async function expectRejected(op: () => Promise<unknown>, label: string): Promise<void> {
  try { await op(); } catch (error) {
    expect(pgErrorFields(error), label).toEqual({ code: '23514', constraint: 'contract_lines_allowance_chk' });
    return;
  }
  throw new Error(`expected contract_lines_allowance_chk to reject: ${label}`);
}

const ALLOWANCE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
const NON_ALLOWANCE_TYPES = ['flat', 'manual'] as const;
const I = '25.00';
const P = '12.00';
/** [includedQuantity, overageMode, overageUnitPrice] presence, 8 combinations. */
const PRESENCE: Array<[boolean, boolean, boolean]> = [
  [false, false, false], [false, false, true], [false, true, false], [false, true, true],
  [true, false, false], [true, false, true], [true, true, false], [true, true, true],
];

describe('contract_lines allowance invariants (real DB) #3205 W04', () => {
  it('presence matrix on every allowance type, in both modes', async () => {
    const f = await seed();
    for (const lineType of ALLOWANCE_TYPES) {
      for (const mode of ['bill', 'flag'] as const) {
        for (const [hasI, hasM, hasP] of PRESENCE) {
          const opts = {
            lineType,
            includedQuantity: hasI ? I : null,
            overageMode: hasM ? mode : null,
            overageUnitPrice: hasP ? P : null,
          };
          // Accepted iff: no allowance at all, OR (I and M set) and the price is
          // present exactly when the mode is 'bill'.
          const accepted = (!hasI && !hasM && !hasP) || (hasI && hasM && hasP === (mode === 'bill'));
          const label = `${lineType}/${mode} I=${hasI} M=${hasM} P=${hasP}`;
          if (accepted) await expect(insertLine(f, opts), label).resolves.toBeDefined();
          else await expectRejected(() => insertLine(f, opts), label);
        }
      }
    }
  });

  it('rejects every allowance column on flat and manual, and accepts them with none', async () => {
    const f = await seed();
    for (const lineType of NON_ALLOWANCE_TYPES) {
      await expect(insertLine(f, { lineType })).resolves.toBeDefined();
      await expectRejected(() => insertLine(f, { lineType, includedQuantity: I, overageMode: 'flag' }), `${lineType} I+M`);
      await expectRejected(() => insertLine(f, { lineType, includedQuantity: I }), `${lineType} I only`);
      await expectRejected(() => insertLine(f, { lineType, overageMode: 'flag' }), `${lineType} M only`);
      await expectRejected(() => insertLine(f, { lineType, overageUnitPrice: P }), `${lineType} P only`);
    }
  });

  it('rejects a zero or fractional included_quantity, and accepts a zero overage price', async () => {
    const f = await seed();
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: '0.00', overageMode: 'flag' }), 'zero included');
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: '25.50', overageMode: 'flag' }), 'fractional included');
    // 0.00 = "itemised at no charge" — still writes a customer-visible line.
    await expect(insertLine(f, { lineType: 'per_device', includedQuantity: I, overageMode: 'bill', overageUnitPrice: '0.00' })).resolves.toBeDefined();
  });

  it('contract_overage_mode carries exactly {bill, flag}', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'contract_overage_mode' ORDER BY e.enumsortorder
    `)) as unknown as Array<{ enumlabel: string }>;
    expect(rows.map((r) => r.enumlabel)).toEqual(['bill', 'flag']);
  });

  it('re-applying the migration is a no-op and the CHECK still fires', async () => {
    const f = await seed();
    const migrationSql = readFileSync(join(__dirname, '../../../migrations/', MIGRATION), 'utf8');
    // getTestDb() is the superuser client — the same shape the other migration
    // replay tests use for DDL.
    await getTestDb().execute(sql.raw(migrationSql));
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: I }), 'after replay');
    await expect(insertLine(f, { lineType: 'per_device', includedQuantity: I, overageMode: 'flag' })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run:
```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts
```
Expected: FAIL — `column "included_quantity" of relation "contract_lines" does not exist`.

- [ ] **Step 4: Write the migration**

`apps/api/migrations/2026-10-07-100000-contract-lines-allowance-overage.sql`:

```sql
-- #3205 wave 4 / #4607: included quantity + overage on counted contract lines.
-- Spec: docs/superpowers/specs/billing/2026-09-03-contract-line-allowance-overage-design.md
--
-- ONE file, deliberately. The wave 1 / wave 2 two-file split exists ONLY because
-- ALTER TYPE ... ADD VALUE cannot have its new value USED in the transaction that
-- adds it, and autoMigrate wraps each file in one transaction. CREATE TYPE has no
-- such restriction: 2026-10-03-partner-trust-probation.sql and
-- 2026-09-25-ticket-push-preferences.sql both create an enum and use it in the
-- same file. One file is also atomic — an enum with no consumer is dead weight
-- if a second file fails.

DO $$ BEGIN
  CREATE TYPE contract_overage_mode AS ENUM ('bill', 'flag');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS included_quantity numeric(12,2);
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS overage_mode contract_overage_mode;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS overage_unit_price numeric(12,2);

-- The DB twin of contractLineInvariantIssues (packages/shared/src/validators/
-- contracts.ts). Every conjunct is NULL-SAFE: a CHECK passes on TRUE *or NULL*,
-- so a three-valued comparison like `overage_mode <> 'bill'` would silently
-- admit rows. Each side of every `=` below is a non-null boolean, and the CASE
-- is total.
--
-- Depends on wave 2: 'per_device_group' must already exist on contract_line_type
-- (2026-10-06-100000-contract-line-type-per-device-group.sql). This file sorts
-- after it, so the value is committed and usable here.
--
-- #4547 (block hours) extends this constraint: add 'hour_block' to the type list
-- and exempt it from the integrality conjunct, by DROP + re-ADD in its own file.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_allowance_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_allowance_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat') THEN
    -- All-or-nothing: an allowance with no disposition for the extras is the
    -- silent under-bill this wave removes. Choose 'flag' to cap without billing.
    ((included_quantity IS NULL) = (overage_mode IS NULL))
    -- 0 included is a plain per-unit line at the overage rate; one spelling only.
    AND (included_quantity IS NULL OR included_quantity > 0)
    -- You cannot include 25.5 devices or 25.5 seats.
    AND (included_quantity IS NULL OR included_quantity = floor(included_quantity))
    -- A price is present iff it is actually charged. A rate parked on a 'flag'
    -- line reads as a charge on the detail page and in the tenant export.
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  ELSE
    included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  END
);
```

No new index: nothing queries by allowance. Locks: one `CREATE TYPE`, three nullable metadata-only `ADD COLUMN`s, one CHECK validated over a small table — sub-second on every tenant.

- [ ] **Step 5: Drizzle schema**

`apps/api/src/db/schema/contracts.ts`, beside `contractLineTypeEnum`:

```ts
// #3205 W04 (#4607): what happens to the units above included_quantity.
export const contractOverageModeEnum = pgEnum('contract_overage_mode', ['bill', 'flag']);
```

In `contractLines`, after `deviceRoles`:

```ts
  // #4607: allowance + overage. All three are NULL together on a line with no
  // allowance, and NULL on flat/manual. The invariants live in
  // contract_lines_allowance_chk (SQL-only, like contract_lines_device_roles_chk)
  // and in contractLineInvariantIssues. included_quantity is the FIXED quantity
  // the base line bills every period — not a cap on a variable count.
  includedQuantity: numeric('included_quantity', { precision: 12, scale: 2 }),
  overageMode: contractOverageModeEnum('overage_mode'),
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }),
```

- [ ] **Step 6: Export policy — the one registration list a new COLUMN fires**

`apps/api/src/services/tenantExportPolicyRegistry.ts`, the `contract_lines` row: append `"included_quantity","overage_mode","overage_unit_price"` to its `included` array, after `"device_roles"` (and after W02's `"device_group_id","device_group_name"`). All three are ordinary customer data: none is `json`/`jsonb`/`bytea`, none matches `SUSPICIOUS_NAME_PARTS`. Nothing else in any registration list changes — no new table means no RLS, cascade, device-detach or org-merge work (spec decision 16).

- [ ] **Step 7: Write the failing writer tests**

Append to `apps/api/src/services/contractService.test.ts` (same queued-chain mock style as the existing `contractService currency representability guard (W6-G3-1)` describe):

```ts
describe('allowance writers (#3205 W04)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const jpyContract = { id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'JPY' };
  const usdContract = { ...jpyContract, currencyCode: 'USD' };

  it('rejects an unrepresentable overage price BEFORE any insert (adopted from #4547 finding 20)', async () => {
    queueResult([jpyContract]); // lockContract
    await expect(svc.addContractLineToContract('c1', {
      lineType: 'per_device', description: 'Endpoints', unitPrice: '1000', taxable: false,
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.50',
    } as never, actor)).rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    // The insert never ran: only the lock consumed a queued result.
    expect(results.length).toBe(0);
  });

  it('checks the overage price on a CATALOG-linked line too — the overage leg is never catalog-priced', async () => {
    queueResult([jpyContract]);
    vi.mocked(resolvePrice).mockResolvedValue({ unitPrice: '1000', taxable: true, source: 'price_book' } as never);
    await expect(svc.addContractLineToContract('c1', {
      lineType: 'per_device', description: 'Endpoints', catalogItemId: 'cat1',
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.50',
    } as never, actor)).rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
  });

  it('persists the three columns on an allowance type and nulls them elsewhere', async () => {
    queueResult([usdContract]);
    queueResult([{ id: 'l1' }]);
    await svc.addContractLineToContract('c1', {
      lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: false,
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    } as never, actor);
    expect(vi.mocked(db.values)).toHaveBeenCalledWith(expect.objectContaining({
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    }));

    vi.clearAllMocks();
    queueResult([usdContract]);
    queueResult([{ id: 'l2' }]);
    await svc.addContractLineToContract('c1', {
      lineType: 'flat', description: 'Base fee', unitPrice: '10.00', taxable: false,
    } as never, actor);
    expect(vi.mocked(db.values)).toHaveBeenCalledWith(expect.objectContaining({
      includedQuantity: null, overageMode: null, overageUnitPrice: null,
    }));
  });

  it('W03 updateContractLine checks the MERGED row overage price', async () => {
    queueResult([jpyContract]);                                     // lockContract
    queueResult([{                                                  // the current line
      id: 'l1', contractId: 'c1', orgId: 'org1', lineType: 'per_device', description: 'Endpoints',
      unitPrice: '1000', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null,
      deviceRoles: null, deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '1200',
    }]);
    await expect(svc.updateContractLine('c1', 'l1', { overageUnitPrice: '12.50' } as never, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
  });
});

// #3205 W04: the KWD case is a REJECTION, not a three-decimal rounding case —
// CURRENCY_CODES is a 34-entry allowlist with no KWD/BHD/OMR/TND and
// minorUnitExponent returns 0 | 2 only. There is no three-decimal money to
// design for, and a test that pretends otherwise would encode a false contract.
describe('three-decimal currencies are not supported at all (#3205 W04)', () => {
  it('KWD is not a known currency', () => {
    expect(isKnownCurrency('KWD')).toBe(false);
    expect(isKnownCurrency('BHD')).toBe(false);
    expect(isKnownCurrency('USD')).toBe(true);
  });
});
```

Import `isKnownCurrency` from `@breeze/shared` at the top of that test file (and `resolvePrice` from the already-mocked `./catalogService`, matching how the wave-3 describes reference it).

- [ ] **Step 8: Run to verify they fail, then implement the writers**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts`
Expected: the four allowance-writer cases FAIL (the columns are dropped on insert and no representability check runs); the KWD case passes immediately — it pins an existing property so a later wave cannot quietly add a three-decimal currency without revisiting the money design.

Then implement:

`apps/api/src/services/contractService.ts`. Define once at module level, beside `BILLABLE_DEVICE_ROLE_SET`:

```ts
// #3205 W04: the types contract_lines_allowance_chk lets carry an allowance.
// Mirrors ALLOWANCE_LINE_TYPES in @breeze/shared; kept local so the writers do
// not import a value they only need as a membership test.
const ALLOWANCE_LINE_TYPE_SET: ReadonlySet<string> = new Set(ALLOWANCE_LINE_TYPES);

/** The three allowance columns normalised for an insert: present only on a type
 *  that may carry them, NULL everywhere else (same shape as the manualQuantity /
 *  deviceRoles / siteId normalisation beside it). */
function allowanceColumnsFor(input: {
  lineType: string;
  includedQuantity?: string | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: string | null;
}) {
  const on = ALLOWANCE_LINE_TYPE_SET.has(input.lineType);
  return {
    includedQuantity: on ? (input.includedQuantity ?? null) : null,
    overageMode: on ? (input.overageMode ?? null) : null,
    overageUnitPrice: on ? (input.overageUnitPrice ?? null) : null,
  };
}
```

Import `ALLOWANCE_LINE_TYPES` from `@breeze/shared` on the existing line 6 import.

In `addContractLineToContract`, after the `assertRepresentable(unitPrice, c.currencyCode)` call in the non-catalog branch and before the insert:

```ts
    const allowance = allowanceColumnsFor(input);
    // W6-G3-1, extended by #4607 (adopted from #4547's Codex finding 20): the
    // overage rate is the template for every future generated invoice line, so
    // an unrepresentable ¥12.50 must fail HERE, not months later inside the
    // billing transaction where it rolls back the whole contract's generation.
    // Note this runs on BOTH branches: a catalog-linked base line still carries
    // a hand-entered overage rate (the overage leg is never catalog-priced).
    if (allowance.overageUnitPrice !== null) assertRepresentable(allowance.overageUnitPrice, c.currencyCode);
```

and spread `...allowance,` into the `tx.insert(contractLines).values({ … })` object.

The same two changes in `createContractWithLinesDetailed`'s insert loop (using `l` as the input and `spec.currencyCode` as the currency).

**W03's `updateContractLine`** (its plan's Task 4 Step 9) needs three edits:

1. Immediately after the `contractLineInvariantIssues(merged, { mode: 'persisted' })` check and before the ownership checks:

```ts
    // #3205 W04: the merged row's overage rate must be representable in the
    // contract's currency, beside the unitPrice calls the transition table
    // already makes. Runs whenever the patch supplies a price — the overage leg
    // is never catalog-resolved, so nothing else can correct it later.
    if (patchHasKey(patch, 'overageUnitPrice') && merged.overageUnitPrice !== null) {
      assertRepresentable(merged.overageUnitPrice, c.currencyCode);
    }
```

2. Three more columns in the `tx.update(contractLines).set({ … })` object, beside `sortOrder`:

```ts
        includedQuantity: merged.includedQuantity,
        overageMode: merged.overageMode,
        overageUnitPrice: merged.overageUnitPrice,
```

3. `'includedQuantity'`, `'overageMode'`, `'overageUnitPrice'` added to `AUDITED_LINE_COLUMNS`, so `diffLineAudit` reports them in `changedFields` — **column names only**, never values, per W03's no-free-text rule (they are numbers and an enum, but the rule is a shape rule and the exception list stays empty).

`apps/api/src/services/quoteToContract.ts`, `NewContractLineSpec`:

```ts
  /** #3205 W04: allowance carried from a device-set quote line. W05 populates
   *  these; W04 leaves every quote-accepted line's allowance null. */
  includedQuantity?: string | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: string | null;
```

- [ ] **Step 9: Migrate, check drift, run everything this task touches**

Run:
```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test
pnpm db:migrate && pnpm db:check-drift
npx vitest run src/services/contractService.test.ts
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```
Expected: all PASS; drift clean. `tenant-export-policy` is the suite that fails if the three columns are unclassified — if it is green *before* step 6, the columns were not added.

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-10-07-100000-contract-lines-allowance-overage.sql \
  apps/api/src/db/schema/contracts.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts \
  apps/api/src/services/quoteToContract.ts \
  apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts
git commit -m "feat(billing): contract_lines allowance columns, NULL-safe CHECK, export policy, writers (#3205 W04)"
```

---

### Task 3: Service quantities — `resolveLineQty`, the estimate shape, exact money in list and MRR

**Files:**
- Modify: `apps/api/src/services/contractService.ts` — imports (`:1-38`), `resolveLineQty` (`:229-250` pre-W02; post-W02 it also takes group ids), `ContractEstimate` (`:252-259`), `computeContractEstimate` (`:261-281`), `listContracts` (`:174-183`), `summarizeActiveContractMrrByOrg` (`:427-443`)
- Test: `apps/api/src/services/contractService.test.ts`

**Interfaces:**

```ts
// contractService.ts
export interface OverageSummary {
  contractLineId: string;
  /** The materialized overage invoice line ('bill' mode) or null ('flag' mode). W07
   *  attaches device evidence to it. */
  invoiceLineId: string | null;
  /** Carried so a toast/log can name the line without a second fetch (the same
   *  reason PriceBookGap carries itemName). */
  description: string;
  counted: number;
  included: number;
  overage: number;
  mode: 'bill' | 'flag';
}
export interface ContractEstimate {
  currencyCode: string;
  periodTotal: string;
  lines: Array<{
    lineId: string; lineType: ContractLineRow['lineType'];
    /** The BASE invoice quantity — `billed`. Meaning unchanged for a line with no allowance. */
    quantity: number;
    /** multiplyToCurrency(quantity, unitPrice). The invariant value === qty × unitPrice still holds. */
    value: string;
    live: boolean;
    counted: number; included: number | null; overage: number; overageMode: 'bill' | 'flag' | null;
    /** multiplyToCurrency(overage, overageUnitPrice), or the currency's zero. NEVER folded into `value`. */
    overageValue: string;
    unresolved?: 'group_deleted';  // wave 2
  }>;
  uncoveredDevices: UncoveredDevices | null;
  /** One entry per allowance line that is OVER, in either mode. [] when none. */
  overages: OverageSummary[];
}
// resolveLineQty (private) returns ResolvedQuantity & { live: boolean; unresolved?: 'group_deleted' }
```

> **W02 note:** if W02 moved `ContractEstimate` into `contractTypes.ts` (its plan's file map says so, though the interface is at `contractService.ts:252` on this branch), edit it there instead — `grep -rn 'lines: Array<{ lineId' apps/api/src`.

- [ ] **Step 1: Write the failing service unit tests**

Append to `apps/api/src/services/contractService.test.ts`:

```ts
// #3205 W04 (#4607): the estimate carries the allowance split, and every money
// leg it touches goes through the exact-decimal primitives.
describe('computeContractEstimate — allowance and overage (#3205 W04)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const contract = { id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'active', currencyCode: 'USD' };
  const lineRow = (p: Record<string, unknown>) => ({
    id: 'l1', contractId: 'c1', orgId: 'org1', description: 'Endpoints', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: null, overageMode: null, overageUnitPrice: null, ...p,
  });
  const snapshotOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, role: 'workstation', siteId: null }));

  async function estimateWith(line: Record<string, unknown>, deviceCount: number) {
    vi.mocked(snapshotContractDevices).mockResolvedValue(snapshotOf(deviceCount));
    queueResult([contract]);                                  // getOwnedContractOr404
    queueResult([lineRow({ lineType: 'per_device', ...line })]); // lines
    return svc.computeContractEstimate('c1', actor);
  }

  it('bills the ALLOWANCE at counted 0 — the fixed-allowance rule', async () => {
    const out = await estimateWith({ includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' }, 0);
    expect(out.lines[0]).toMatchObject({
      quantity: 25, value: '250.00', counted: 0, included: 25, overage: 0,
      overageMode: 'bill', overageValue: '0.00',
    });
    expect(out.periodTotal).toBe('250.00');
    expect(out.overages).toEqual([]);
  });

  it('at 26 with bill mode: base 25, overage 1 priced separately, period total is their cent-exact sum', async () => {
    const out = await estimateWith({ includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' }, 26);
    expect(out.lines[0]).toMatchObject({ quantity: 25, value: '250.00', counted: 26, overage: 1, overageValue: '12.00' });
    expect(out.periodTotal).toBe('262.00');
    expect(out.overages).toEqual([{ contractLineId: 'l1', description: 'Endpoints', counted: 26, included: 25, overage: 1, mode: 'bill' }]);
  });

  it('at 26 with flag mode: nothing extra is priced, but the excess is reported', async () => {
    const out = await estimateWith({ includedQuantity: '25.00', overageMode: 'flag' }, 26);
    expect(out.lines[0]).toMatchObject({ quantity: 25, value: '250.00', overage: 1, overageMode: 'flag', overageValue: '0.00' });
    expect(out.periodTotal).toBe('250.00');
    expect(out.overages[0]).toMatchObject({ mode: 'flag', overage: 1 });
  });

  it('a line inside its allowance is not an overage entry, in either mode', async () => {
    for (const mode of [{ overageMode: 'bill', overageUnitPrice: '12.00' }, { overageMode: 'flag' }]) {
      results.length = 0;
      const out = await estimateWith({ includedQuantity: '25.00', ...mode }, 24);
      expect(out.overages).toEqual([]);
    }
  });

  it('a line with no allowance is unchanged: quantity === counted and value === qty × unitPrice', async () => {
    const out = await estimateWith({}, 26);
    expect(out.lines[0]).toMatchObject({
      quantity: 26, value: '260.00', counted: 26, included: null, overage: 0, overageMode: null, overageValue: '0.00',
    });
    expect(out.periodTotal).toBe('260.00');
  });

  it('a wave-2 group line whose group is gone bills nothing and carries no allowance', async () => {
    // Decision 7: reporting billed: 25 for a line generation will refuse with
    // GROUP_DELETED would put a number on the estimate no invoice can carry.
    // A group line IS a device line, so coverage still asks for the snapshot.
    vi.mocked(snapshotContractDevices).mockResolvedValue([]);
    queueResult([contract]);
    queueResult([lineRow({
      lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired group',
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
    })]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.lines[0]).toMatchObject({
      quantity: 0, value: '0.00', counted: 0, included: null, overage: 0,
      overageMode: null, overageValue: '0.00', unresolved: 'group_deleted',
    });
    expect(out.periodTotal).toBe('0.00');
    expect(out.overages).toEqual([]);
  });

  it('flat, manual and per_seat all return the six-field shape', async () => {
    vi.mocked(countContractSeats).mockResolvedValue(4);
    queueResult([contract]);
    queueResult([
      lineRow({ id: 'lf', lineType: 'flat' }),
      lineRow({ id: 'lm', lineType: 'manual', manualQuantity: '3.00' }),
      lineRow({ id: 'ls', lineType: 'per_seat', includedQuantity: '2.00', overageMode: 'flag' }),
    ]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.lines.map((l) => [l.quantity, l.counted, l.included, l.overage, l.overageMode])).toEqual([
      [1, 1, null, 0, null],
      [3, 3, null, 0, null],
      [2, 4, 2, 2, 'flag'],
    ]);
    expect(out.overages).toEqual([
      { contractLineId: 'ls', description: 'Endpoints', counted: 4, included: 2, overage: 2, mode: 'flag' },
    ]);
  });

  it('a JPY contract has no fractional yen anywhere', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(snapshotOf(26));
    queueResult([{ ...contract, currencyCode: 'JPY' }]);
    queueResult([lineRow({ lineType: 'per_device', unitPrice: '1000', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '1200' })]);
    const out = await svc.computeContractEstimate('c1', actor);
    expect(out.lines[0]).toMatchObject({ value: '25000', overageValue: '1200' });
    expect(out.periodTotal).toBe('26200.00'); // numeric(_,2) major units, no fractional yen
  });
});

describe('listContracts estimatedPeriodValue with allowances (#3205 W04)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('includes a billed overage and excludes a flagged one', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => ({ id: `d${i}`, role: 'workstation', siteId: null })),
    );
    const rows = [
      { id: 'cb', orgId: 'org1', currencyCode: 'USD' },
      { id: 'cf', orgId: 'org1', currencyCode: 'USD' },
    ];
    const base = {
      contractId: '', orgId: 'org1', lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00',
      taxable: true, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null,
      deviceGroupId: null, deviceGroupName: null, sortOrder: 0, includedQuantity: '25.00',
    };
    queueResult(rows);                                                   // contracts page
    queueResult([                                                        // all lines for the page
      { ...base, id: 'lb', contractId: 'cb', overageMode: 'bill', overageUnitPrice: '12.00' },
      { ...base, id: 'lf', contractId: 'cf', overageMode: 'flag', overageUnitPrice: null },
    ]);
    const out = await svc.listContracts({ orgId: 'org1' }, actor) as Array<{ id: string; estimatedPeriodValue: string }>;
    expect(out.find((c) => c.id === 'cb')!.estimatedPeriodValue).toBe('262.00');
    expect(out.find((c) => c.id === 'cf')!.estimatedPeriodValue).toBe('250.00');
  });
});
```

For the MRR rollup, add one case to the existing `summarizeActiveContractMrrByOrg (#3779)` describe by copying its nearest test's queue order and varying the fixture: **a catalog-linked base line with a `bill` allowance rolls up the CATALOG-resolved base price plus the STAMPED overage rate** (the overage leg is never catalog-resolved — spec decision 13). Assert the monthly figure equals `roundToCurrency((25 × catalogPrice + overage × stampedOverageRate) / intervalMonths, currency)`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts`
Expected: FAIL — estimate lines carry no `counted`/`overage`/`overageValue`, `overages` is `undefined`, and the allowance is ignored so `quantity` is the raw count.

- [ ] **Step 3: Implement — imports and `resolveLineQty`**

`apps/api/src/services/contractService.ts`. Extend the `@breeze/shared` import (line 6) with `multiplyToCurrency, toCents, fromCents, ALLOWANCE_LINE_TYPES` and add:

```ts
import { applyAllowance, billsOverage, overageValue, type ResolvedQuantity } from './contractAllowance';
```

Beside the cache declarations:

```ts
/** A wave-2 group line whose group is gone: all-zero, no allowance, so the
 *  estimate never shows a number the invoice cannot carry (generation refuses
 *  with GROUP_DELETED). #3205 W04 decision 7. */
const UNRESOLVED_QTY: ResolvedQuantity = {
  counted: 0, billed: 0, included: null, overage: 0, overageMode: null,
};

/** One line's contribution to a period total, in integer cents: the base leg at
 *  `unitPrice` plus the overage leg at the line's stamped `overageUnitPrice`.
 *  Both legs go through the exact-decimal primitives — `Number(a) * b` is what
 *  turned 0.02 × 7.25 into 0.14. `overageValue` is the currency's zero whenever
 *  the line is not billing an overage, so there is no branch here. */
function lineCents(r: ResolvedQuantity, unitPrice: string, l: ContractLineRow, currencyCode: string): number {
  return toCents(multiplyToCurrency(r.billed, unitPrice, currencyCode))
    + toCents(overageValue(r, l, currencyCode));
}
```

Replace `resolveLineQty` (keeping W02's group arm and cache signature):

```ts
/**
 * The one quantity resolver for the estimate, the contracts list and the MRR
 * rollup. EVERY branch routes through applyAllowance — including flat and
 * manual, where contract_lines_allowance_chk forbids an allowance and the
 * function is the identity — so a future allowance-bearing type cannot be
 * forgotten in one branch (#3205 W04).
 */
async function resolveLineQty(
  orgId: string, line: ContractLineRow, dc: DeviceCache, sc: SeatCache,
): Promise<ResolvedQuantity & { live: boolean; unresolved?: 'group_deleted' }> {
  switch (line.lineType) {
    case 'flat':
      return { ...applyAllowance(1, line, 'included_units'), live: false };
    case 'manual':
      return { ...applyAllowance(Number(line.manualQuantity ?? '0'), line, 'included_units'), live: false };
    case 'per_device':
    case 'per_device_role': {
      assertRoleLineHasRoles(line);
      const counted = quantityFor(await orgSnapshot(orgId, dc), line);
      return { ...applyAllowance(counted, line, 'included_units'), live: true };
    }
    case 'per_device_group': {
      if (line.deviceGroupId === null) return { ...UNRESOLVED_QTY, live: true, unresolved: 'group_deleted' };
      const snapshot = await orgSnapshot(orgId, dc, [line.deviceGroupId]);
      if (!snapshot.groups.has(line.deviceGroupId)) return { ...UNRESOLVED_QTY, live: true, unresolved: 'group_deleted' };
      return { ...applyAllowance(quantityFor(snapshot, line), line, 'included_units'), live: true };
    }
    case 'per_seat': {
      if (!sc.has(orgId)) sc.set(orgId, await countContractSeats(orgId));
      return { ...applyAllowance(sc.get(orgId)!, line, 'included_units'), live: true };
    }
    default: {
      // Exhaustiveness: a new line type is a compile error here, not a silent qty 0.
      const _exhaustive: never = line.lineType;
      throw new ContractServiceError(`Unknown contract line type: ${String(line.lineType)}`, 500, 'INVALID_STATE');
    }
  }
}
```

- [ ] **Step 4: Implement — estimate, list, MRR**

`ContractEstimate` and the new `OverageSummary` per the **Interfaces** block above.

`computeContractEstimate`'s loop becomes:

```ts
  let cents = 0;
  const out: ContractEstimate['lines'] = [];
  const overages: OverageSummary[] = [];
  for (const l of lines) {
    const r = await resolveLineQty(contract.orgId, l, dc, sc);
    const value = multiplyToCurrency(r.billed, l.unitPrice, contract.currencyCode);
    const oValue = overageValue(r, l, contract.currencyCode);
    cents += toCents(value) + toCents(oValue);
    out.push({
      lineId: l.id, lineType: l.lineType, quantity: r.billed, value, live: r.live,
      counted: r.counted, included: r.included, overage: r.overage, overageMode: r.overageMode,
      overageValue: oValue,
      ...(r.unresolved ? { unresolved: r.unresolved } : {}),
    });
    // Either mode: an over line the operator can act on. 'bill' is on the
    // invoice, 'flag' is not — the UI and the worker branch on `mode`.
    if (r.overageMode !== null && r.overage > 0) {
      overages.push({
        contractLineId: l.id, invoiceLineId: overageInvoiceLineId, description: l.description,
        counted: r.counted, included: r.included!, overage: r.overage, mode: r.overageMode,
      });
    }
  }
```

and the return becomes `{ currencyCode: contract.currencyCode, periodTotal: fromCents(cents), lines: out, uncoveredDevices, overages }`.

`listContracts`' per-contract loop body (post-W02, inside its `try`):

```ts
      let cents = 0;
      for (const l of byContract.get(c.id) ?? []) {
        const r = await resolveLineQty(c.orgId, l, dc, sc);
        cents += lineCents(r, l.unitPrice, l, c.currencyCode);
      }
```
with `estimatedPeriodValue: fromCents(cents)` replacing `total.toFixed(2)`.

`summarizeActiveContractMrrByOrg`'s inner loop:

```ts
    let cents = 0;
    for (const l of byContract.get(c.id) ?? []) {
      const r = await resolveLineQty(c.orgId, l, dc, sc);
      // The BASE leg may be catalog-resolved; the overage leg never is
      // (decision 13), so lineCents reads the stamped overage_unit_price.
      const unitPrice = l.catalogItemId
        ? (resolvedUnitPrice(l.catalogItemId, c.currencyCode, c.orgId) ?? l.unitPrice)
        : l.unitPrice;
      cents += lineCents(r, unitPrice, l, c.currencyCode);
    }
    const periodValue = Number(fromCents(cents));
```
The `const months = …` / `roundToCurrency(periodValue / months, c.currencyCode)` lines below are unchanged.

- [ ] **Step 5: Run**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head && npx vitest run src/services/contractService.test.ts src/services/contractAllowance.test.ts`
Expected: tsc clean except `generateDueInvoice` (Task 4, which has not been updated yet — it still destructures the old `resolveLineQty` shape only if W02 wired it there; if tsc is clean, so much the better); the listed suites PASS, including the pre-existing `computeContractEstimate — per_device_role + uncoveredDevices (#3205)` describe **after** its expected-object literals gain the new fields.

> The wave-1 estimate assertions (`expect(out.lines).toEqual([{ lineId, lineType, quantity, value, live }])`) will fail on the widened shape. Update them to the full object — do **not** loosen them to `toMatchObject`; the exact shape is the contract the web types mirror.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts
git commit -m "feat(billing): resolveLineQty returns the allowance split; estimate/list/MRR use exact money (#3205 W04)"
```

---

### Task 4: Generation — the sibling overage line, `overages[]`, and the transaction guard

**Files:**
- Modify: `apps/api/src/db/index.ts` (beside `hasDbAccessContext`, `:752-754`)
- Create: `apps/api/src/db/assertInTransaction.test.ts`
- Modify: `apps/api/src/services/invoiceService.ts:347-453` (`addContractLine`)
- Modify: `apps/api/src/services/contractService.ts:1002-1189` (`GenerateResult`, `generateDueInvoice`)
- Create: `apps/api/src/__tests__/integration/contractLineAllowance.integration.test.ts`

**Interfaces:**

```ts
// apps/api/src/db/index.ts
export function assertInTransaction(label: string): void;
// apps/api/src/services/invoiceService.ts — addContractLine's input gains:
    costBasis?: string | null;
// apps/api/src/services/contractService.ts
export interface GenerateResult { …; overages: OverageSummary[]; }   // always present, [] at every early return
```

- [ ] **Step 1: Write the failing guard test**

Create `apps/api/src/db/assertInTransaction.test.ts`:

```ts
/**
 * #3205 W04 decision 14: generateDueInvoice does multi-statement all-or-nothing
 * writes and does NOT open its own transaction. Without an ambient context every
 * write lands on the bare pool with no RLS GUC, where forced RLS on breeze_app
 * silently matches 0 rows (#1375) — a half-written invoice with no error. This
 * guard turns that into a loud throw. No database is needed: the predicate is
 * AsyncLocalStorage-only.
 */
import { describe, expect, it } from 'vitest';
import {
  assertInTransaction,
  hasDbAccessContext,
  __runInDbContextForTests as runInDbContextForTests,
} from './index';

describe('assertInTransaction (#3205 W04)', () => {
  it('precondition: a bare test has no DB access context', () => {
    expect(hasDbAccessContext()).toBe(false);
  });

  it('throws outside a context, naming the caller and the failure mode', () => {
    expect(() => assertInTransaction('generateDueInvoice')).toThrowError(
      /^generateDueInvoice must run inside withDbAccessContext \/ withSystemDbAccessContext/,
    );
    expect(() => assertInTransaction('generateDueInvoice')).toThrowError(/silently affects 0 rows/);
  });

  it('passes inside a context', () => {
    runInDbContextForTests(() => {
      expect(() => assertInTransaction('generateDueInvoice')).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/db/assertInTransaction.test.ts`
Expected: FAIL — `assertInTransaction` is not exported from `./index`.

- [ ] **Step 3: Implement `assertInTransaction`**

`apps/api/src/db/index.ts`, immediately after `hasDbAccessContext` (`:754`):

```ts
/**
 * Throw unless the caller is inside an active withDbAccessContext /
 * withSystemDbAccessContext. Use at the top of a function that performs a
 * multi-statement all-or-nothing write and does NOT open its own transaction,
 * where a missing context means each write lands on the bare pool with no GUC —
 * and forced RLS on breeze_app silently matches 0 rows (#1375), leaving a
 * half-written document with no error.
 *
 * Note: __runInDbContextForTests satisfies this without a real transaction. That
 * is deliberate and TEST ONLY (see its doc); production callers must use the
 * context helpers, both of which open baseDb.transaction.
 */
export function assertInTransaction(label: string): void {
  if (!hasDbAccessContext()) {
    throw new Error(
      `${label} must run inside withDbAccessContext / withSystemDbAccessContext — `
      + 'without one every write lands on the bare pool with no RLS GUC and silently affects 0 rows',
    );
  }
}
```

- [ ] **Step 4: Run, then write the failing generation integration test**

Run: `cd apps/api && npx vitest run src/db/assertInTransaction.test.ts` → PASS.

Create `apps/api/src/__tests__/integration/contractLineAllowance.integration.test.ts`:

```ts
/**
 * #3205 W04 (#4607) acceptance bar: the allowance boundary matrix against real
 * Postgres as breeze_app, asserting QUANTITIES, per-line totals, subtotal, TAX
 * and total — because 'bill' at N+1 changes the tax base, which quantities alone
 * would not catch.
 *
 * Canonical fixture: included_quantity = 25, unit_price = 10.00,
 * overage_unit_price = 12.00, taxable, org tax rate 0.10, USD.
 *
 * setup.ts TRUNCATEs before every test, so each test seeds its own org inline.
 * devices.site_id is NOT NULL — every billable device gets the org's site.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ side effects are not the correctness under test (same
// rationale as multiCurrencyWave6ContractBilling.integration.test.ts).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contracts, devices, invoiceLines, invoices,
  organizationUsers, organizations, partners, roles, sites, users,
} from '../../db/schema';
import { computeContractEstimate, generateDueInvoice, type ContractActorT } from '../../services/contractService';
import { createCatalogItemWithPrice } from './db-utils';

const SWEEP_AT = new Date('2026-07-01T06:00:00Z');
const TAX_RATE = '0.10000';

interface Fixture { partnerId: string; orgId: string; siteId: string; contractId: string; actor: ContractActorT }

async function seed(opts: { devices?: number; currency?: string } = {}): Promise<Fixture> {
  const currency = opts.currency ?? 'USD';
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `OV ${sfx}`, slug: `ov-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: currency, partnerId: p!.id, name: 'OVOrg', slug: `ov-${sfx}`, taxRate: TAX_RATE })
      .returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `HQ-${sfx}` }).returning({ id: sites.id });
    const n = opts.devices ?? 0;
    if (n > 0) {
      await db.insert(devices).values(Array.from({ length: n }, (_, i) => ({
        orgId: o!.id, siteId: s!.id, agentId: `ov-${sfx}-${i}`, hostname: `ov-${i}`, status: 'online' as const,
        deviceRole: 'workstation', osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0',
      })));
    }
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Allowance contract', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: currency, billingTiming: 'advance',
    }).returning({ id: contracts.id });
    return {
      partnerId: p!.id, orgId: o!.id, siteId: s!.id, contractId: c!.id,
      actor: { userId: null as unknown as string, partnerId: p!.id, accessibleOrgIds: [o!.id] },
    };
  });
}

/** Insert a contract line directly: the writers are covered by their own unit
 *  tests, and the catalog/price-book variants below need shapes the writers
 *  deliberately refuse to create. */
async function addLine(f: Fixture, o: Partial<typeof contractLines.$inferInsert> = {}) {
  const [row] = await withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, lineType: 'per_device', description: 'Endpoints',
    unitPrice: '10.00', taxable: true, ...o,
  }).returning({ id: contractLines.id }));
  return row!.id;
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ subtotal: invoices.subtotal, taxTotal: invoices.taxTotal, total: invoices.total })
    .from(invoices).where(eq(invoices.id, invoiceId)).limit(1));
  return row!;
}

async function readLines(invoiceId: string) {
  return withSystemDbAccessContext(() => db.select({
    description: invoiceLines.description, quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice,
    lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible,
    costBasis: invoiceLines.costBasis, catalogItemId: invoiceLines.catalogItemId,
    parentLineId: invoiceLines.parentLineId, sourceId: invoiceLines.sourceId,
    sourceContractId: invoiceLines.sourceContractId, sortOrder: invoiceLines.sortOrder,
  }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
}

const BILL = { includedQuantity: '25.00', overageMode: 'bill' as const, overageUnitPrice: '12.00' };
const FLAG = { includedQuantity: '25.00', overageMode: 'flag' as const, overageUnitPrice: null };
const NONE = { includedQuantity: null, overageMode: null, overageUnitPrice: null };

describe('allowance + overage generation (real DB) #3205 W04', () => {
  // counted, mode, base qty, subtotal, tax, total, overage line?, overages[] length
  it.each<[number, 'none' | 'bill' | 'flag', string, string, string, string, boolean, number]>([
    [0,  'none', '0.00',  '0.00',   '0.00',  '0.00',   false, 0],
    [24, 'none', '24.00', '240.00', '24.00', '264.00', false, 0],
    [25, 'none', '25.00', '250.00', '25.00', '275.00', false, 0],
    [26, 'none', '26.00', '260.00', '26.00', '286.00', false, 0],
    [0,  'bill', '25.00', '250.00', '25.00', '275.00', false, 0],
    [24, 'bill', '25.00', '250.00', '25.00', '275.00', false, 0],
    [25, 'bill', '25.00', '250.00', '25.00', '275.00', false, 0],
    [26, 'bill', '25.00', '250.00', '25.00', '275.00', true,  1],
    [0,  'flag', '25.00', '250.00', '25.00', '275.00', false, 0],
    [24, 'flag', '25.00', '250.00', '25.00', '275.00', false, 0],
    [25, 'flag', '25.00', '250.00', '25.00', '275.00', false, 0],
    [26, 'flag', '25.00', '250.00', '25.00', '275.00', false, 1],
  ])('counted %d, mode %s', async (counted, mode, baseQty, subtotal, tax, total, hasOverageLine, overageCount) => {
    const f = await seed({ devices: counted });
    const spec = mode === 'bill' ? BILL : mode === 'flag' ? FLAG : NONE;
    const lineId = await addLine(f, spec);

    // The estimate and generation must agree on counted / billed / overage —
    // and, because every line in this matrix is non-catalog, on MONEY too.
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]).toMatchObject({ counted, quantity: Number(baseQty) });
    expect(est.overages).toHaveLength(overageCount);
    expect(est.periodTotal).toBe(hasOverageLine ? '262.00' : subtotal);

    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(res.generated).toBe(true);
    expect(res.overages).toHaveLength(overageCount);

    const lines = await readLines(res.invoiceId!);
    expect(lines).toHaveLength(hasOverageLine ? 2 : 1);
    expect(lines[0]).toMatchObject({ description: 'Endpoints', quantity: baseQty, unitPrice: '10.00' });

    if (hasOverageLine) {
      // The sibling: a real, editable, customer-visible charge — NOT a bundle child.
      expect(lines[1]).toMatchObject({
        description: 'Overage: 1 above 25 included — Endpoints',
        quantity: '1.00', unitPrice: '12.00', lineTotal: '12.00',
        taxable: true, customerVisible: true, catalogItemId: null,
        parentLineId: null, sourceId: lineId, sourceContractId: f.contractId,
      });
      expect(lines[1]!.sortOrder).toBe(lines[0]!.sortOrder + 1);
      // 'bill' at 26 moves the TAX BASE — the reason this matrix asserts tax.
      expect(await readInvoice(res.invoiceId!)).toEqual({ subtotal: '262.00', taxTotal: '26.20', total: '288.20' });
    } else {
      expect(await readInvoice(res.invoiceId!)).toEqual({ subtotal, taxTotal: tax, total });
    }

    if (overageCount > 0) {
      expect(res.overages[0]).toEqual({
        contractLineId: lineId, description: 'Endpoints', counted, included: 25, overage: 1, mode,
      });
    }
  });

  it('flag mode at 26 writes EXACTLY one invoice line — it never silently invoices', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, FLAG);
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(await readLines(res.invoiceId!)).toHaveLength(1);
    expect(res.overages[0]!.mode).toBe('flag');
  });

  it('an overage price of 0.00 still writes a customer-visible zero-value line', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, { includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '0.00' });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ quantity: '1.00', unitPrice: '0.00', lineTotal: '0.00', customerVisible: true });
    // Totals are identical to the flag row: the count is on the document, at no charge.
    expect(await readInvoice(res.invoiceId!)).toEqual({ subtotal: '250.00', taxTotal: '25.00', total: '275.00' });
  });

  it('a catalog-priced base bills the allowance at the CURRENT catalog price; the overage leg is untouched', async () => {
    const f = await seed({ devices: 24 });
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerId, name: 'Managed endpoint', unitPrice: '11.00', currencyCode: 'USD', costBasis: '4.00' });
    await addLine(f, { ...BILL, catalogItemId: item.id, unitPrice: '10.00' });  // stamp 10.00, book 11.00
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines).toHaveLength(1);                       // 24 < 25: no overage
    expect(lines[0]).toMatchObject({ quantity: '25.00', unitPrice: '11.00', lineTotal: '275.00' });
    expect(res.priceBookGaps).toEqual([]);
  });

  it('a catalog line with no price in the contract currency reports a price-book gap and still bills the allowance', async () => {
    const f = await seed({ devices: 26 });
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerId, name: 'EUR-only item', unitPrice: '9.00', currencyCode: 'EUR' });
    const lineId = await addLine(f, { ...BILL, catalogItemId: item.id, unitPrice: '10.00' });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(res.priceBookGaps).toEqual([{ contractLineId: lineId, catalogItemId: item.id, itemName: 'Endpoints', currencyCode: 'USD' }]);
    const lines = await readLines(res.invoiceId!);
    // Base billed at the stamp; the overage leg is NEVER catalog-priced, so it
    // can never itself be a gap (contractService.ts's gap push requires catalogItemId).
    expect(lines[0]).toMatchObject({ quantity: '25.00', unitPrice: '10.00' });
    expect(lines[1]).toMatchObject({ quantity: '1.00', unitPrice: '12.00', catalogItemId: null });
    expect(res.priceBookGaps).toHaveLength(1);
  });

  it('the overage line inherits the MATERIALIZED base line taxable flag and per-unit cost basis', async () => {
    const f = await seed({ devices: 26 });
    // The catalog resolver owns taxability on a catalog line and ignores the
    // contract line's flag — so reading l.taxable could tax the overage
    // differently from the thing it is an overage of (decision 9).
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerId, name: 'Taxable item', unitPrice: '10.00', currencyCode: 'USD', costBasis: '4.00' });
    await addLine(f, { ...BILL, catalogItemId: item.id, taxable: false });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines[1]!.taxable).toBe(lines[0]!.taxable);
    expect(lines[1]!.costBasis).toBe(lines[0]!.costBasis);
    expect(lines[1]!.costBasis).not.toBeNull();
  });

  it('per_seat carries the same shapes', async () => {
    const f = await seed();
    await withSystemDbAccessContext(async () => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const [r] = await db.insert(roles)
        .values({ name: `SeatRole ${sfx}`, scope: 'organization', partnerId: f.partnerId, orgId: f.orgId })
        .returning({ id: roles.id });
      const seatUsers = await db.insert(users).values(Array.from({ length: 3 }, (_, i) => ({
        partnerId: f.partnerId, orgId: f.orgId, email: `seat-${sfx}-${i}@x.io`, name: `Seat ${i}`, status: 'active' as const,
      }))).returning({ id: users.id });
      await db.insert(organizationUsers).values(seatUsers.map((u) => ({ orgId: f.orgId, userId: u.id, roleId: r!.id })));
    });
    await addLine(f, { lineType: 'per_seat', description: 'Seats', includedQuantity: '2.00', overageMode: 'bill', overageUnitPrice: '12.00' });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines[0]).toMatchObject({ quantity: '2.00' });
    expect(lines[1]).toMatchObject({ description: 'Overage: 1 above 2 included — Seats', quantity: '1.00', parentLineId: null });
  });

  it('a second run is skipped as already_billed and writes no second overage line', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, BILL);
    const first = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const again = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(again).toMatchObject({ generated: false, skipped: 'already_billed', priceBookGaps: [], overages: [] });
    expect(await readLines(first.invoiceId!)).toHaveLength(2);
    const allInvoices = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(allInvoices).toHaveLength(1);
  });

  it('ATOMICITY: a failing overage insert rolls back the base line, the invoice, the claim and the pointer', async () => {
    const f = await seed({ devices: 27 });
    // overage = 2 at 9999999999.99 overflows the child line_total's
    // numeric(12,2) (max 9999999999.99) -> Postgres 22003 AFTER the base line
    // committed inside the same transaction.
    await addLine(f, { includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '9999999999.99' });
    await expect(withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT))).rejects.toThrow();

    const [inv] = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(inv).toBeUndefined();
    const claims = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractId)));
    expect(claims).toHaveLength(0);
    const [c] = await withSystemDbAccessContext(() => db.select({ nextBillingAt: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, f.contractId)));
    expect(c!.nextBillingAt).toBe('2026-07-01');

    // And the rerun, once the rate is sane, creates exactly one invoice and one claim.
    await withSystemDbAccessContext(() => db.update(contractLines)
      .set({ overageUnitPrice: '12.00' }).where(eq(contractLines.contractId, f.contractId)));
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(res.generated).toBe(true);
    expect(await readLines(res.invoiceId!)).toHaveLength(2);
    const claimsAfter = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractId)));
    expect(claimsAfter).toHaveLength(1);
  });

  it('DEFENCE IN DEPTH: a forged unrepresentable rate throws at materialization instead of writing a bad line', async () => {
    // The write-time assertRepresentable is the real guard (Task 2). This proves
    // the second one — addContractLine's non-catalog assertRepresentable
    // (invoiceService.ts:436) — still fires for a row that got in around it.
    const f = await seed({ devices: 26, currency: 'JPY' });
    await addLine(f, { unitPrice: '1000', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.50' });
    await expect(withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT)))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE' });
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM invoices WHERE org_id = ${f.orgId}::uuid`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses to run with no ambient DB context, BEFORE any write (decision 14)', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, BILL);
    await expect(runOutsideDbContext(() => generateDueInvoice(f.contractId, SWEEP_AT)))
      .rejects.toThrow(/generateDueInvoice must run inside withDbAccessContext/);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM invoices WHERE org_id = ${f.orgId}::uuid`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run:
```bash
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLineAllowance.integration.test.ts
```
Expected: FAIL — every allowance row bills the raw count, no second line is written, `res.overages` is `undefined`, and the missing-context case writes an invoice instead of throwing.

- [ ] **Step 6: Implement — `addContractLine` takes a cost basis**

`apps/api/src/services/invoiceService.ts`, `addContractLine`'s input type (`:349-360`) gains:

```ts
    /**
     * #3205 W04: per-unit cost basis for a DERIVED line (an overage) that
     * inherits its origin line's basis, so computeInvoiceProfit does not report
     * it as pure margin. Honoured on the NON-CATALOG path only — on the catalog
     * path the price resolver stays authoritative for cost as well as price.
     */
    costBasis?: string | null;
```

and the non-catalog branch (`:433-442`) sets it after the representability/negative guards:

```ts
      costBasis = input.costBasis ?? null;
```

Nothing else in `invoiceService.ts` changes: the overage line is a top-level sibling, so `recomputeInvoiceTotals` already sums it (`:154-169`), the customer projection already includes it (`:794`), `issueInvoice`/`voidInvoice` already dedupe `source_id` (`:1169-1174`, `:1594-1596`), and the reissue clone already copies `sourceType`/`sourceId`/`sourceContractId`/`costBasis`/`sortOrder` verbatim for `parentLineId === null` rows (`:1662-1673`).

- [ ] **Step 7: Implement — generation**

`apps/api/src/services/contractService.ts`. Import `assertInTransaction` from `'../db'` (beside `db`).

`GenerateResult` gains:

```ts
  /** Allowance lines that were OVER this run, in either mode (#3205 W04).
   *  Always present (`[]` when none / nothing generated), like priceBookGaps.
   *  `mode: 'flag'` entries were NOT invoiced — the worker warns and the
   *  generate UI toasts on exactly those. */
  overages: OverageSummary[];
```

Add `overages: []` to **all five** early returns (`:1068`, `:1070`, `:1083`, `:1099`, `:1170`).

First statement of `generateDueInvoice`, **before** `lockContractRow`:

```ts
  // #3205 W04 decision 14: this function does multi-statement all-or-nothing
  // writes and does not open its own transaction — both callers wrap it in
  // runOutsideDbContext(() => withSystemDbAccessContext(...)). Without one, every
  // write below lands on the bare pool with no RLS GUC and silently affects 0
  // rows (#1375). W04 doubles the writes per line, so the window widens.
  assertInTransaction('generateDueInvoice');
```

The line loop keeps its switch, its `never` guard and its per-branch **string** quantity, so nothing changes for a line with no allowance:

```ts
  const priceBookGaps: PriceBookGap[] = [];
  const overages: OverageSummary[] = [];
  for (const l of lines) {
    let quantity: string;
    switch (l.lineType) { /* unchanged, including the `never` default */ }

    // The ONE definition of the split, shared with resolveLineQty.
    const r = applyAllowance(Number(quantity), l, 'included_units');
    if (r.included !== null) quantity = r.billed.toFixed(2);   // the allowance overrides the count

    const { line: baseLine, pricedFrom } = await addContractLine(inv.id, {
      description: l.description, quantity, unitPrice: l.unitPrice, taxable: l.taxable,
      catalogItemId: l.catalogItemId, sourceId: l.id, contractId
    }, actor);
    // A non-catalog line is always its own snapshot — only a CATALOG line billed
    // at the snapshot is a price-book gap.
    if (l.catalogItemId && pricedFrom === 'contract_snapshot') {
      priceBookGaps.push({ contractLineId: l.id, catalogItemId: l.catalogItemId, itemName: l.description, currencyCode: c.currencyCode });
    }

    let overageInvoiceLineId: string | null = null;
    if (billsOverage(r)) {
      // A SIBLING, not a child (decision 8): every parent/child consumer treats
      // a child as a bundle breakdown row — computeInvoiceProfit would drop this
      // line's revenue from margin, the customer document would indent and mute
      // a real charge, and InvoiceEditor would render it uneditable.
      // insertLineAndRecompute's max(sortOrder)+1 puts it at base.sortOrder + 1,
      // so it reads directly under its base line on every ordered surface.
      // Capture the materialized overage line: W07 evidence rows attach to its id.
      const { line: overageInvoiceLine } = await addContractLine(inv.id, {
        description: `Overage: ${r.overage} above ${r.included} included — ${l.description}`,
        quantity: r.overage.toFixed(2),
        unitPrice: l.overageUnitPrice!,   // non-null under 'bill' by contract_lines_allowance_chk
        // From the MATERIALIZED base line: on a catalog-linked base the resolver
        // owns taxability and ignores the contract line's flag (decision 9).
        taxable: baseLine.taxable,
        // Per-unit; keeps the overage out of computeInvoiceProfit's "pure margin".
        costBasis: baseLine.costBasis,
        catalogItemId: null,              // never catalog-priced (decision 13)
        sourceId: l.id,                   // same contract line; issue/void dedupe source ids
        contractId,
        // parentLineId is deliberately NOT set.
      }, actor);
      overageInvoiceLineId = overageInvoiceLine.id;
    }
    // Either mode: 'bill' is on the invoice, 'flag' is the money left on the table.
    if (r.overageMode !== null && r.overage > 0) {
      overages.push({
        contractLineId: l.id, invoiceLineId: overageInvoiceLineId, description: l.description,
        counted: r.counted, included: r.included!, overage: r.overage, mode: r.overageMode,
      });
    }
  }
```

and the success return becomes `{ generated: true, invoiceId: inv.id, autoIssue: c.autoIssue, actor, priceBookGaps, uncoveredDevices, overages }`.

Description text is English and server-side, like every other generated line description — stored invoice line text is never localized (`document_locale` is an issue-time snapshot for rendering labels).

- [ ] **Step 8: Run everything this task touches**

Run:
```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head
npx vitest run src/db/assertInTransaction.test.ts src/services/invoiceService.test.ts src/services/contractService.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLineAllowance.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts
```
Expected: tsc clean; all PASS. The multi-currency contract-billing suite is the regression check that a contract with **no** allowance bills exactly as before.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db/index.ts apps/api/src/db/assertInTransaction.test.ts \
  apps/api/src/services/invoiceService.ts apps/api/src/services/contractService.ts \
  apps/api/src/__tests__/integration/contractLineAllowance.integration.test.ts
git commit -m "feat(billing): generate a sibling overage line, report overages[], assert an ambient transaction (#3205 W04)"
```

---

### Task 5: Lifecycle — currency restamp refusal, void/reissue, QuickBooks push

**Files:**
- Modify: `apps/api/src/services/contractService.ts:797-839` (`changeContractCurrency`)
- Test: `apps/api/src/services/contractService.test.ts`
- Create: `apps/api/src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.test.ts` (the `pushInvoice` describe, beside `taxConn` at `:264`)

**Interfaces:**
- Produces: no new error code — `changeContractCurrency` reuses 409 `CURRENCY_LOCKED`. `addContractLine`/`invoiceService` are unchanged from Task 4.

- [ ] **Step 1: Write the failing unit test**

Append to the existing `changeContractCurrency` describes in `apps/api/src/services/contractService.test.ts`:

```ts
// #3205 W04 decision 15: the reprice loop writes only unit_price and cannot
// re-derive a hand-entered overage rate from a price book, so a catalog-linked
// line carrying one would silently keep a wrong-currency number.
describe('changeContractCurrency refuses a stamped overage rate (#3205 W04)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const draft = { id: 'c1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' };

  it('409 CURRENCY_LOCKED under reprice', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: 'cat1', overageUnitPrice: '12.00' }]);
    await expect(svc.changeContractCurrency('c1', { currencyCode: 'EUR', reprice: true }, actor))
      .rejects.toMatchObject({ status: 409, code: 'CURRENCY_LOCKED' });
  });

  it('409 CURRENCY_LOCKED under a bare restamp too', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: 'cat1', overageUnitPrice: '12.00' }]);
    await expect(svc.changeContractCurrency('c1', { currencyCode: 'EUR' }, actor))
      .rejects.toMatchObject({ status: 409, code: 'CURRENCY_LOCKED' });
  });

  it('a flag-mode line (no rate) does not block a reprice', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: 'cat1', overageUnitPrice: null }]);
    vi.mocked(resolvePrice).mockResolvedValue({ unitPrice: '9.00', taxable: true, source: 'price_book' } as never);
    queueResult([]);                     // the per-line unit_price UPDATE
    queueResult([{ ...draft, currencyCode: 'EUR' }]);
    await expect(svc.changeContractCurrency('c1', { currencyCode: 'EUR', reprice: true }, actor))
      .resolves.toMatchObject({ currencyCode: 'EUR' });
  });

  it('clearLines still proceeds — it deletes the lines and the rate with them', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', catalogItemId: null, overageUnitPrice: '12.00' }]);
    queueResult([]);                     // the DELETE
    queueResult([{ ...draft, currencyCode: 'EUR' }]);
    await expect(svc.changeContractCurrency('c1', { currencyCode: 'EUR', clearLines: true }, actor))
      .resolves.toMatchObject({ currencyCode: 'EUR' });
  });
});
```

(Match the surrounding describes' `resolvePrice` mock name and queue order — the existing `changeContractCurrency reprice (…#3775)` describe is the template.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts`
Expected: the first two cases FAIL (the reprice path succeeds; the bare restamp throws the generic "N line(s) priced in USD" refusal, which happens to share the code — assert the **message** names the overage rate so the two are distinguishable, or assert `resolvePrice` was not called on the reprice path).

- [ ] **Step 3: Implement**

`apps/api/src/services/contractService.ts`, `changeContractCurrency`. Widen the line select (`:797-798`):

```ts
    const lineRows = await tx.select({
      id: contractLines.id, catalogItemId: contractLines.catalogItemId,
      overageUnitPrice: contractLines.overageUnitPrice,
    }).from(contractLines).where(eq(contractLines.contractId, contractId)).orderBy(contractLines.id);
```

and open the `if (lineRows.length > 0) {` block with:

```ts
      // #3205 W04 decision 15: the reprice loop writes only unit_price
      // (`:822`) and cannot re-derive a hand-entered overage rate from a price
      // book, so a catalog-linked line with one would keep a wrong-currency
      // number that every future invoice would carry. Refused for BOTH reprice
      // and a bare restamp; clearLines is still allowed, because it deletes the
      // lines — and the rate with them.
      const withOverageRate = lineRows.filter((l) => l.overageUnitPrice !== null).length;
      if (withOverageRate > 0 && !input.clearLines) {
        throw new ContractServiceError(
          `${withOverageRate} line(s) carry an overage rate priced in ${c.currencyCode} that cannot be re-derived from a price book — clear the allowance on those lines, or pass clearLines to remove all lines`,
          409, 'CURRENCY_LOCKED'
        );
      }
```

- [ ] **Step 4: Write the failing lifecycle integration test**

Create `apps/api/src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts`:

```ts
/**
 * #3205 W04 (#4607) lifecycle: what happens to a generated overage line after
 * generation — void/reissue, issue, and the currency restamp refusal — against
 * real Postgres as breeze_app.
 *
 * The reissue assertions are the proof of decision 8: the overage is a TOP-LEVEL
 * sibling, so the existing clone (which copies sourceType/sourceId/
 * sourceContractId/quantity/unitPrice/costBasis/taxable/customerVisible/
 * lineTotal/sortOrder verbatim for parentLineId IS NULL rows) needed no change.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractLines, contracts, devices, invoiceLines, invoices, organizations, partners, sites, users,
} from '../../db/schema';
import { changeContractCurrency, generateDueInvoice, type ContractActorT } from '../../services/contractService';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';

const SWEEP_AT = new Date('2026-07-01T06:00:00Z');

async function seedOver(): Promise<{ orgId: string; partnerId: string; contractId: string; lineId: string; actor: ContractActorT }> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `LC ${sfx}`, slug: `lc-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'LCOrg', slug: `lc-${sfx}`, taxRate: '0.10000' })
      .returning({ id: organizations.id });
    // issueInvoice stamps created_by; a real user keeps that FK resolvable.
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `lc-${sfx}@x.io`, name: 'LC', status: 'active' })
      .returning({ id: users.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `HQ-${sfx}` }).returning({ id: sites.id });
    await db.insert(devices).values(Array.from({ length: 26 }, (_, i) => ({
      orgId: o!.id, siteId: s!.id, agentId: `lc-${sfx}-${i}`, hostname: `lc-${i}`, status: 'online' as const,
      deviceRole: 'workstation', osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0',
    })));
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Over contract', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
      createdBy: u!.id,
    }).returning({ id: contracts.id });
    const [l] = await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: 'per_device', description: 'Endpoints',
      unitPrice: '10.00', taxable: true,
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
    }).returning({ id: contractLines.id });
    return {
      orgId: o!.id, partnerId: p!.id, contractId: c!.id, lineId: l!.id,
      actor: { userId: u!.id, partnerId: p!.id, accessibleOrgIds: [o!.id] },
    };
  });
}

const readLines = (invoiceId: string) => withSystemDbAccessContext(() => db.select({
  description: invoiceLines.description, quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice,
  lineTotal: invoiceLines.lineTotal, parentLineId: invoiceLines.parentLineId, sourceId: invoiceLines.sourceId,
  sourceContractId: invoiceLines.sourceContractId, sortOrder: invoiceLines.sortOrder,
}).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));

describe('overage line lifecycle (real DB) #3205 W04', () => {
  it('issues an invoice carrying a base line and its overage sibling on one source id', async () => {
    const f = await seedOver();
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    // Two invoice lines share one contract-line source id — already a supported
    // shape (issueInvoice/voidInvoice dedupe source ids), and contract lines
    // carry no billing_status, so there is no double-claim hazard.
    const before = await readLines(res.invoiceId!);
    expect(before.map((l) => l.sourceId)).toEqual([f.lineId, f.lineId]);
    await withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, f.actor as never));
    const [inv] = await withSystemDbAccessContext(() => db
      .select({ status: invoices.status, total: invoices.total })
      .from(invoices).where(eq(invoices.id, res.invoiceId!)).limit(1));
    expect(inv).toMatchObject({ status: 'sent', total: '288.20' });
  });

  it('void-with-reissue clones BOTH lines as top-level, with lineage and order preserved', async () => {
    const f = await seedOver();
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    await withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, f.actor as never));
    const original = await readLines(res.invoiceId!);

    const reissued = await withSystemDbAccessContext(() => voidInvoice(res.invoiceId!, 'wrong count', { reissue: true }, f.actor as never));
    const draftId = reissued.invoice.id;
    const clone = await readLines(draftId);

    expect(clone).toHaveLength(2);
    expect(clone.every((l) => l.parentLineId === null)).toBe(true);   // decision 8
    expect(clone.map((l) => [l.description, l.quantity, l.unitPrice, l.lineTotal]))
      .toEqual(original.map((l) => [l.description, l.quantity, l.unitPrice, l.lineTotal]));
    expect(clone.map((l) => l.sourceId)).toEqual([f.lineId, f.lineId]);
    expect(clone.map((l) => l.sourceContractId)).toEqual([f.contractId, f.contractId]);
    expect(clone[1]!.sortOrder).toBe(clone[0]!.sortOrder + 1);
    const [draft] = await withSystemDbAccessContext(() => db
      .select({ total: invoices.total }).from(invoices).where(eq(invoices.id, draftId)).limit(1));
    expect(draft!.total).toBe('288.20');
  });

  it('PINS the accepted pre-existing limitation: removing the contract line wedges the reissued draft', async () => {
    // Not a W04 behaviour change — issueInvoice has always thrown 409
    // SOURCE_NOT_FOUND for a source_id whose contract line is gone
    // (invoiceService.ts:1194-1199), and removeContractLine is permitted on
    // active contracts. W04 merely doubles the lines carrying the dead id.
    const f = await seedOver();
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    await withSystemDbAccessContext(() => issueInvoice(res.invoiceId!, f.actor as never));
    const reissued = await withSystemDbAccessContext(() => voidInvoice(res.invoiceId!, 'redo', { reissue: true }, f.actor as never));
    await withSystemDbAccessContext(() => db.delete(contractLines).where(eq(contractLines.id, f.lineId)));
    await expect(withSystemDbAccessContext(() => issueInvoice(reissued.invoice.id, f.actor as never)))
      .rejects.toMatchObject({ status: 409, code: 'SOURCE_NOT_FOUND' });
  });

  it('changeContractCurrency refuses while a bill-mode rate is stamped, and proceeds once it is cleared', async () => {
    const f = await seedOver();
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'draft' }).where(eq(contracts.id, f.contractId)));
    await expect(withSystemDbAccessContext(() => changeContractCurrency(f.contractId, { currencyCode: 'EUR', reprice: true }, f.actor)))
      .rejects.toMatchObject({ status: 409, code: 'CURRENCY_LOCKED' });
    await withSystemDbAccessContext(() => db.update(contractLines)
      .set({ includedQuantity: null, overageMode: null, overageUnitPrice: null })
      .where(eq(contractLines.id, f.lineId)));
    await expect(withSystemDbAccessContext(() => changeContractCurrency(f.contractId, { currencyCode: 'EUR', clearLines: true }, f.actor)))
      .resolves.toMatchObject({ currencyCode: 'EUR' });
  });
});
```

- [ ] **Step 5: Add the QuickBooks push case**

In `apps/api/src/services/accounting/quickbooksProvider.test.ts`, inside the `pushInvoice` describe that defines `taxConn` (`:264`):

```ts
  it('pushes a contract base line and its overage sibling, the overage with no ItemRef (#3205 W04)', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '311', SyncToken: '0' } });

    await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      subtotal: '262.00', taxTotal: '26.20', total: '288.20',
      lines: [
        line({ invoiceLineId: 'base', description: 'Endpoints', quantity: '25.00', unitPrice: '10.00', lineTotal: '250.00', taxable: true }),
        line({ invoiceLineId: 'over', description: 'Overage: 1 above 25 included — Endpoints', quantity: '1.00', unitPrice: '12.00', lineTotal: '12.00', taxable: true }),
      ],
    }), [{ invoiceLineId: 'base', remoteItemRef: { id: '77' } }]); // the overage is never catalog-linked

    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body.Line).toHaveLength(2);
    expect(body.Line[0].SalesItemLineDetail).toMatchObject({ ItemRef: { value: '77' }, Qty: 25, UnitPrice: 10, TaxCodeRef: { value: 'TAX' } });
    expect(body.Line[1]).toMatchObject({ Amount: 12, Description: 'Overage: 1 above 25 included — Endpoints' });
    expect(body.Line[1].SalesItemLineDetail).not.toHaveProperty('ItemRef');
    expect(body.Line[1].SalesItemLineDetail).toMatchObject({ Qty: 1, UnitPrice: 12, TaxCodeRef: { value: 'TAX' } });
  });
```

This needs no production change: `loadInvoiceLinesOrdered` takes **all** lines ordered by `sort_order` with no visibility or parentage filter (`accountingInvoicePush.ts:151-159`), a null `catalogItemId` yields no mapping (`:530-531`), and the provider omits `ItemRef` when there is none (`quickbooksProvider.ts:623-631`).

- [ ] **Step 6: Run**

Run:
```bash
cd apps/api && npx vitest run src/services/contractService.test.ts src/services/accounting/quickbooksProvider.test.ts
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts
```
Expected: all PASS. The wave-6 void/reissue suite (its bundle parent/child assertions at `:272-282`) must stay green **untouched** — the overage sibling changed nothing about bundle cloning.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts \
  apps/api/src/services/accounting/quickbooksProvider.test.ts \
  apps/api/src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts
git commit -m "feat(billing): CURRENCY_LOCKED on a stamped overage rate; pin reissue, issue and QuickBooks push (#3205 W04)"
```

---

### Task 6: Worker warning, route plumbing, AI tool descriptions

**Files:**
- Modify: `apps/api/src/jobs/contractWorker.ts` (after the `uncoveredDevices` warning, `:87-92`)
- Modify: `apps/api/src/jobs/contractWorker.test.ts`
- Modify: `apps/api/src/routes/contracts/contracts.test.ts` (beside the estimate case at `:315`)
- Modify: `apps/api/src/services/aiToolsContracts.ts` (the `line` description at `:185-198`, and W03's `patch` description for `update_line`)
- Modify: `apps/api/src/services/aiToolsContracts.manageContracts.test.ts`

**Interfaces:** no new exports. `routes/contracts/generate.ts:55` returns the `GenerateResult` verbatim and `routes/contracts/contracts.ts:67` returns the estimate verbatim, so `overages` rides along with **no route change** — the route tests exist to pin that.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/jobs/contractWorker.test.ts`, in the existing sweep describe:

```ts
  it('warns once per FLAGGED overage and never for a billed one (#3205 W04)', async () => {
    dueRows.push({ id: 'c1' });
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false,
      actor: { userId: null, partnerId: 'p1', accessibleOrgIds: ['org1'] },
      priceBookGaps: [], uncoveredDevices: null,
      overages: [
        { contractLineId: 'cl-1', description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'flag' },
        { contractLineId: 'cl-2', description: 'Servers', counted: 12, included: 10, overage: 2, mode: 'bill' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(res).toEqual({ billed: 1, failed: 0 });
      // Billed overage is on the invoice — that is not silence, so no warning.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('flagged overage'), 'c1', 'cl-1', 'Endpoints', 30, 25, 5,
      );
    } finally { warn.mockRestore(); }
  });

  it('an empty overages array warns nothing and leaves the other warnings intact', async () => {
    dueRows.push({ id: 'c1' });
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false,
      actor: { userId: null, partnerId: 'p1', accessibleOrgIds: ['org1'] },
      priceBookGaps: [], uncoveredDevices: { total: 2, byRole: { unknown: 2 } }, overages: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('uncovered devices'), 'c1', 2, '{"unknown":2}');
    } finally { warn.mockRestore(); }
  });
```

`apps/api/src/routes/contracts/contracts.test.ts`:

```ts
  it('GET /:id/estimate returns the allowance fields and overages verbatim (#3205 W04)', async () => {
    const estimate = {
      currencyCode: 'USD', periodTotal: '262.00',
      lines: [{
        lineId: LINE_ID, lineType: 'per_device', quantity: 25, value: '250.00', live: true,
        counted: 26, included: 25, overage: 1, overageMode: 'bill', overageValue: '12.00',
      }],
      uncoveredDevices: null,
      overages: [{ contractLineId: LINE_ID, description: 'Endpoints', counted: 26, included: 25, overage: 1, mode: 'bill' }],
    };
    (svc.computeContractEstimate as any).mockResolvedValue(estimate);
    const res = await app().request(`/${CONTRACT_ID}/estimate`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: estimate });
  });

  it('POST /:id/lines accepts a valid allowance line and 400s on each violation (#3205 W04)', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID });
    const post = (body: unknown) => app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ok = {
      lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    };
    expect((await post(ok)).status).toBe(200);
    for (const bad of [
      { ...ok, overageMode: undefined, overageUnitPrice: undefined },  // included with no mode
      { ...ok, includedQuantity: undefined },                          // mode with no included
      { ...ok, includedQuantity: '0' },
      { ...ok, includedQuantity: '25.5' },
      { ...ok, overageMode: 'flag' },                                  // a price on a flag line
      { ...ok, lineType: 'flat' },                                     // an allowance on flat
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    // Only the valid body ever reached the service — the schema is the gate.
    expect(svc.addContractLineToContract).toHaveBeenCalledTimes(1);
  });

  it('POST /:id/generate returns overages verbatim (#3205 W04)', async () => {
    (svc.getContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'active' });
    const overages = [{ contractLineId: LINE_ID, description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'flag' }];
    (svc.generateDueInvoice as any).mockResolvedValue({
      generated: true, invoiceId: 'inv-1', autoIssue: false, priceBookGaps: [], uncoveredDevices: null, overages,
    });
    const res = await app().request(`/${CONTRACT_ID}/generate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.overages).toEqual(overages);
  });
```

`apps/api/src/services/aiToolsContracts.manageContracts.test.ts`:

```ts
  it('add_line accepts a bill allowance and rejects the pairing violations (#3205 W04)', async () => {
    const line = {
      lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    };
    await getTool().handler({ action: 'add_line', contractId: 'contract-1', line }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith(
      'contract-1', expect.objectContaining({ includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' }), actor,
    );

    const lonely = JSON.parse(await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line: { ...line, overageMode: undefined, overageUnitPrice: undefined } }, auth,
    ));
    expect(lonely.error).toMatch(/overageMode/);

    const onFlat = JSON.parse(await getTool().handler(
      { action: 'add_line', contractId: 'contract-1', line: { ...line, lineType: 'flat' } }, auth,
    ));
    expect(onFlat.error).toBeDefined();
  });

  it('update_line removes an allowance with three nulls and rejects a single null (#3205 W04)', async () => {
    await getTool().handler({
      action: 'update_line', contractId: 'contract-1', lineId: 'line-1',
      patch: { includedQuantity: null, overageMode: null, overageUnitPrice: null },
    }, auth);
    expect(contractService.updateContractLine).toHaveBeenCalledWith(
      'contract-1', 'line-1',
      { includedQuantity: null, overageMode: null, overageUnitPrice: null },
      actor,
    );

    vi.mocked(contractService.updateContractLine).mockRejectedValueOnce(
      new ContractServiceError('includedQuantity and overageMode must be set together', 400, 'INVALID_LINE_PATCH'),
    );
    const bad = JSON.parse(await getTool().handler({
      action: 'update_line', contractId: 'contract-1', lineId: 'line-1', patch: { includedQuantity: null },
    }, auth));
    expect(bad.code).toBe('INVALID_LINE_PATCH');
  });

  it('documents the allowance semantics on both the line and the patch descriptions (#3205 W04)', () => {
    const schema = getTool().definition.input_schema as { properties: Record<string, { description?: string }> };
    for (const key of ['line', 'patch']) {
      const desc = schema.properties[key]!.description!;
      expect(desc).toContain('includedQuantity');
      expect(desc).toContain('overageMode');
      expect(desc).toContain('overageUnitPrice');
      // The fixed-allowance rule is the one thing a model will otherwise get wrong.
      expect(desc).toMatch(/every period even when the live count is lower/i);
    }
  });
```

Add `updateContractLine: vi.fn().mockResolvedValue({ line: { id: 'line-1' }, audit: { changedFields: [] } })` to that file's `vi.mock('./contractService', …)` factory if W03 has not already.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/contractWorker.test.ts src/routes/contracts/contracts.test.ts src/services/aiToolsContracts.manageContracts.test.ts`
Expected: FAIL — no flagged-overage warning, no `overages` on the route responses, no allowance prose in either description.

- [ ] **Step 3: Implement the worker warning**

`apps/api/src/jobs/contractWorker.ts`, immediately after the `uncoveredDevices` warning block:

```ts
      // #3205 W04 (#4607): overage the operator chose NOT to auto-bill. Never
      // silent — the money is on the table and only a human can decide to raise
      // the allowance or add a line. BILLED overage gets no warning: it is on
      // the invoice, so it is not silence.
      for (const o of res.overages) {
        if (o.mode !== 'flag') continue;
        console.warn(
          '[contract-billing] flagged overage: contract %s line %s (%s) counted %d against %d included — %d over, NOT billed',
          row.id, o.contractLineId, o.description, o.counted, o.included, o.overage
        );
      }
```

- [ ] **Step 4: Implement the AI descriptions**

`apps/api/src/services/aiToolsContracts.ts`. Append to the `line` property's description string (`:185-198`), and to W03's `patch` description, this paragraph (identical text in both, so a model reading either learns the same rules):

```ts
              'Any of per_device, per_device_role, per_device_group and per_seat may carry an allowance: ' +
              'includedQuantity (a whole number, > 0) plus overageMode. With an allowance the line bills ' +
              'includedQuantity x unitPrice EVERY PERIOD EVEN WHEN THE LIVE COUNT IS LOWER — a fixed included ' +
              'quantity, not a cap on a variable count. overageMode "bill" adds a second invoice line for the ' +
              'units above the allowance at overageUnitPrice (required in that mode, in the contract\'s currency); ' +
              'overageMode "flag" bills nothing extra and instead reports the excess on the estimate, the generate ' +
              'result and the billing log for a human to act on. includedQuantity and overageMode must be supplied ' +
              'together, and overageUnitPrice only with "bill". On update_line: omitting a field leaves it ' +
              'unchanged; sending all three as null removes the allowance.',
```

Both actions already wrap the shared schemas (`contractLineInputSchema` for `add_line`, `updateContractLineSchema` for `update_line`), so the rules are enforced at runtime whatever the prose says. `aiToolSchemas.ts` and `aiAgentSdkTools.ts` need **no change**: both declare `line` and `patch` as `z.record(z.string(), z.unknown())` (`aiToolSchemas.ts:466-467`) — verified, and re-check before assuming.

- [ ] **Step 5: Run**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head && npx vitest run src/jobs/contractWorker.test.ts src/routes/contracts src/services/aiToolsContracts`
Expected: tsc clean; PASS. (`src/routes/contracts` and `src/services/aiToolsContracts` are substring filters — check the reported file count covers `contracts.test.ts`, `lines.test.ts` and the three `aiToolsContracts*` files.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/contractWorker.ts apps/api/src/jobs/contractWorker.test.ts \
  apps/api/src/routes/contracts/contracts.test.ts \
  apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiToolsContracts.manageContracts.test.ts
git commit -m "feat(billing): warn on flagged overage in the nightly sweep; allowance prose for add_line and update_line (#3205 W04)"
```

---

### Task 7: Web — allowance controls, cells, notice, toast, i18n

**Files:**
- Modify: `apps/web/src/lib/api/contracts.ts:55-84`
- Modify: `apps/web/src/components/contracts/lineTypes.ts`
- Create: `apps/web/src/components/contracts/AllowanceCell.tsx`
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx` (state `:136-147`; guards `:390-397`; `addLine` `:570-605`; line-row quantity cell `:925-931`; type-select `onChange` `:995`; the add-form block after the site select `:1095-1107`; Add button `:1152`; estimate panel `:1186`; plus W03's inline edit form)
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (generate handler `:163-210`; estimate stat `:330-345`; line rows `:375-392`)
- Create: `apps/web/src/components/contracts/ContractEditor.allowance.test.tsx`
- Create: `apps/web/src/components/contracts/ContractDetail.allowance.test.tsx`
- Modify: `apps/web/src/components/billing/invoiceTypes.test.ts`, `apps/web/src/components/billing/InvoiceDocument.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**

```ts
// apps/web/src/lib/api/contracts.ts
export type OverageMode = 'bill' | 'flag';
export interface OverageSummary {
  contractLineId: string;
  /** The materialized overage invoice line ('bill' mode) or null ('flag' mode). W07
   *  attaches device evidence to it. */
  invoiceLineId: string | null; description: string; counted: number; included: number; overage: number; mode: OverageMode;
}
// ContractEstimateLine gains: counted, included: number | null, overage, overageMode: OverageMode | null, overageValue: string
// ContractEstimate gains:     overages: OverageSummary[]
// ContractLine gains:         includedQuantity: string | null, overageMode: OverageMode | null, overageUnitPrice: string | null

// apps/web/src/components/contracts/lineTypes.ts
export const ALLOWANCE_TYPES: Set<ContractLineType>;

// apps/web/src/components/contracts/AllowanceCell.tsx
export default function AllowanceCell(props: { line: ContractLine; estimate?: ContractEstimateLine }): JSX.Element;
export function OverageNotice(props: { overages: OverageSummary[] | undefined }): JSX.Element | null;
```

- [ ] **Step 1: Write the failing web tests**

Create `apps/web/src/components/contracts/ContractEditor.allowance.test.tsx` by copying the whole mock preamble of `ContractEditor.roles.test.tsx` (lines 1-48 — same `vi.mock` set, same `resp` helper, same `contract` fixture) and appending:

```tsx
const line = (p: Partial<Record<string, unknown>> = {}) => ({
  id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Endpoints',
  catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null,
  taxable: true, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z', ...p,
});

const estimateLine = (p: Partial<Record<string, unknown>> = {}) => ({
  lineId: 'l1', lineType: 'per_device', quantity: 25, value: '250.00', live: true,
  counted: 26, included: 25, overage: 1, overageMode: 'bill', overageValue: '12.00', ...p,
});

describe('ContractEditor — allowance block (#3205 W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) return resp({ data: [] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
  });

  it('offers the allowance block only on the four counted types, and clears it on type change', async () => {
    renderEdit();
    expect(screen.queryByTestId('contract-line-allowance-toggle')).toBeNull();     // flat
    for (const lineType of ['per_device', 'per_device_role', 'per_device_group', 'per_seat']) {
      fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: lineType } });
      expect(await screen.findByTestId('contract-line-allowance-toggle')).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('contract-line-allowance-toggle'));
    fireEvent.change(await screen.findByTestId('contract-line-included-qty'), { target: { value: '25' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'manual' } });
    expect(screen.queryByTestId('contract-line-allowance-toggle')).toBeNull();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    // Switching away and back clears the allowance rather than smuggling it onto
    // a type the CHECK forbids it on.
    expect((await screen.findByTestId('contract-line-allowance-toggle') as HTMLInputElement).checked).toBe(false);
  });

  it('disables Add until the allowance is complete, in each mode', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();                       // no included qty
    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '25' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();                       // bill with no price
    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '12.00' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('contract-line-overage-flag'));
    // 'flag' needs no price — and must not send one.
    expect(screen.queryByTestId('contract-line-overage-price')).toBeNull();
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
  });

  it('sends the allowance keys only when the box is checked', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const plain = (api.addContractLine as any).mock.calls[0][1];
    expect(plain.includedQuantity).toBeUndefined();
    expect(plain.overageMode).toBeUndefined();
    expect(plain.overageUnitPrice).toBeUndefined();

    (api.addContractLine as any).mockClear();
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '25' } });
    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '12.00' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });

    (api.addContractLine as any).mockClear();
    fireEvent.click(screen.getByTestId('contract-line-overage-flag'));
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const flagged = (api.addContractLine as any).mock.calls[0][1];
    expect(flagged).toMatchObject({ includedQuantity: '25', overageMode: 'flag' });
    expect(flagged.overageUnitPrice).toBeUndefined();
  });

  it('renders all five AllowanceCell states in the line table', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: {
        currencyCode: 'USD', periodTotal: '0.00', uncoveredDevices: null, overages: [],
        lines: [
          estimateLine({ lineId: 'l-none', included: null, overage: 0, overageMode: null, counted: 7, quantity: 7, overageValue: '0.00' }),
          estimateLine({ lineId: 'l-within', counted: 18, quantity: 25, overage: 0, overageValue: '0.00' }),
          estimateLine({ lineId: 'l-bill' }),
          estimateLine({ lineId: 'l-flag', overageMode: 'flag', overageValue: '0.00' }),
        ],
      },
    }));
    renderEdit([
      line({ id: 'l-none' }),
      line({ id: 'l-within', includedQuantity: '25.00', overageMode: 'flag' }),
      line({ id: 'l-bill', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' }),
      line({ id: 'l-flag', includedQuantity: '25.00', overageMode: 'flag' }),
      line({ id: 'l-noest', includedQuantity: '25.00', overageMode: 'flag' }),   // no estimate line
    ]);
    expect((await screen.findByTestId('line-qty-0')).textContent).toBe('7');
    expect(screen.getByTestId('line-qty-1').textContent).toMatch(/18.*25/);
    expect(screen.getByTestId('line-qty-2').textContent).toMatch(/25.*1/);
    expect(screen.getByTestId('line-qty-2').querySelector('[data-testid="allowance-over-billed"]')).not.toBeNull();
    expect(screen.getByTestId('line-qty-3').querySelector('[data-testid="allowance-over-flagged"]')).not.toBeNull();
    // Never blank: the detail-page case where the estimate has not loaded.
    expect(screen.getByTestId('line-qty-4').querySelector('[data-testid="allowance-included-only"]')).not.toBeNull();
  });

  it('renders the overage digest under the coverage notice', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: {
        currencyCode: 'USD', periodTotal: '262.00', lines: [], uncoveredDevices: null,
        overages: [
          { contractLineId: 'l1', description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'flag' },
          { contractLineId: 'l2', description: 'Servers', counted: 12, included: 10, overage: 2, mode: 'bill' },
        ],
      },
    }));
    renderEdit();
    expect(await screen.findByTestId('contract-overage-flagged')).toHaveTextContent('Endpoints');
    expect(screen.getByTestId('contract-overage-billed')).toHaveTextContent('Servers');
  });
});
```

`renderEdit(lines?)` is `ContractEditor.roles.test.tsx`'s own helper — copy it verbatim; if its signature differs, use the shipped one and pass the fixture the same way that file does.

Create `apps/web/src/components/contracts/ContractDetail.allowance.test.tsx` by copying `ContractDetail.roles.test.tsx`'s preamble and asserting:

```tsx
  it('raises a warning toast for FLAGGED overage on generate, and none for billed', async () => {
    (api.generateContractInvoice as any).mockResolvedValue(resp({ data: {
      generated: true, invoiceId: 'inv-1', priceBookGaps: [], uncoveredDevices: null,
      overages: [
        { contractLineId: 'l1', description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'flag' },
        { contractLineId: 'l2', description: 'Servers', counted: 12, included: 10, overage: 2, mode: 'bill' },
      ],
    } }));
    renderDetail();
    fireEvent.click(await screen.findByTestId('contract-generate-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    const warnings = vi.mocked(showToast).mock.calls.filter(([a]) => (a as { type: string }).type === 'warning');
    expect(warnings).toHaveLength(1);                       // the billed one raises nothing
    expect((warnings[0]![0] as { message: string }).message).toContain('Endpoints');
    expect((warnings[0]![0] as { message: string }).message).not.toContain('Servers');
  });

  it('renders the allowance in the quantity cell and the digest under the estimate stat', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({ data: {
      currencyCode: 'USD', periodTotal: '262.00', uncoveredDevices: null,
      lines: [{
        lineId: 'l1', lineType: 'per_device', quantity: 25, value: '250.00', live: true,
        counted: 26, included: 25, overage: 1, overageMode: 'bill', overageValue: '12.00',
      }],
      overages: [{ contractLineId: 'l1', description: 'Endpoints', counted: 26, included: 25, overage: 1, mode: 'bill' }],
    } }));
    renderDetail([{
      id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Endpoints',
      catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, deviceRoles: null,
      deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null,
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
      taxable: true, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }]);
    const cell = await screen.findByTestId('contract-detail-line-qty-l1');
    expect(cell.querySelector('[data-testid="allowance-over-billed"]')).not.toBeNull();
    expect(cell.textContent).toMatch(/25.*1/);
    expect(await screen.findByTestId('contract-overage-billed')).toHaveTextContent('Endpoints');
    expect(screen.queryByTestId('contract-overage-flagged')).toBeNull();
  });
```

`renderDetail(lines?)` and the generate button's test id are `ContractDetail.roles.test.tsx` / `ContractDetail.generate.test.tsx`'s own helpers — copy them verbatim and pass the fixture the way those files do. `showToast` is mocked from `../shared/Toast`; assert on that mock, never on a Sonner DOM selector.

Append to `apps/web/src/components/billing/invoiceTypes.test.ts`:

```ts
import { computeInvoiceProfit, type InvoiceLine } from './invoiceTypes';

// #3205 W04 decision 8: the overage is a TOP-LEVEL sibling, so its revenue is
// counted. If it were a bundle child, computeInvoiceProfit's
// `parentLineId === null` filter would drop it and margin would be understated
// — the regression the rejected child design would have caused.
describe('computeInvoiceProfit counts a contract overage sibling (#3205 W04)', () => {
  const il = (p: Partial<InvoiceLine>): InvoiceLine => ({
    id: 'x', invoiceId: 'inv', sourceType: 'contract', parentLineId: null, catalogItemId: null,
    name: null, description: 'x', quantity: '1.00', unitPrice: '0.00', costBasis: null,
    revenueAllocation: null, taxable: true, customerVisible: true, lineTotal: '0.00',
    isUnapprovedTime: false, sortOrder: 0, ...p,
  });

  it('includes the overage line in revenue and cost', () => {
    const withOverage = computeInvoiceProfit([
      il({ id: 'base', quantity: '25.00', unitPrice: '10.00', costBasis: '4.00', lineTotal: '250.00', sortOrder: 1 }),
      il({ id: 'over', quantity: '1.00', unitPrice: '12.00', costBasis: '4.00', lineTotal: '12.00', sortOrder: 2 }),
    ]);
    const baseOnly = computeInvoiceProfit([
      il({ id: 'base', quantity: '25.00', unitPrice: '10.00', costBasis: '4.00', lineTotal: '250.00', sortOrder: 1 }),
    ]);
    expect(Number(withOverage.revenue)).toBeGreaterThan(Number(baseOnly.revenue));
    expect(withOverage.linesMissingCost).toBe(0);
  });
});
```

(Match `QuoteProfit`'s actual field names — `grep -n 'export interface QuoteProfit' -A 12 apps/web/src/components/billing/…` — and assert whichever field holds gross revenue.)

Append to `apps/web/src/components/billing/InvoiceDocument.test.tsx` a case asserting a `parentLineId: null` overage line renders **un-indented and un-muted** (no `pl-8`, no `↳` prefix) beside a real bundle child that does — the customer-facing proof of decision 8:

```tsx
  it('renders a contract overage sibling as an ordinary line, not a bundle child (#3205 W04)', () => {
    render(<InvoiceDocument {...props({ lines: [
      docLine({ id: 'base', description: 'Endpoints', quantity: '25.00', unitPrice: '10.00', lineTotal: '250.00', parentLineId: null, sortOrder: 1 }),
      docLine({ id: 'over', description: 'Overage: 1 above 25 included — Endpoints', quantity: '1.00', unitPrice: '12.00', lineTotal: '12.00', parentLineId: null, sortOrder: 2 }),
      docLine({ id: 'child', description: 'Bundle component', parentLineId: 'base', sortOrder: 3 }),
    ] })} />);
    const overCell = screen.getByText(/Overage: 1 above 25 included/).closest('td')!;
    expect(overCell.className).not.toContain('pl-8');
    expect(overCell.textContent).not.toContain('↳');
    const childCell = screen.getByText('Bundle component').closest('td')!;
    expect(childCell.className).toContain('pl-8');
  });
```

(`props()` / `docLine()` are that file's own fixture helpers — reuse whatever it already defines rather than adding new ones.)

Append to `apps/web/src/components/billing/InvoiceEditor.test.tsx` the operator-side half of the same proof: a `parentLineId: null` overage line renders as an **editable** row (its edit/remove affordance is present), where a bundle child renders read-only. Follow that file's existing "children are shown read-only nested under their parent" assertion (`InvoiceEditor.tsx:344-349`) and invert it for the sibling.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor.allowance.test.tsx src/components/contracts/ContractDetail.allowance.test.tsx src/components/billing/invoiceTypes.test.ts src/components/billing/InvoiceDocument.test.tsx`
Expected: FAIL — no allowance controls, no `AllowanceCell`, no flagged toast.

- [ ] **Step 3: Types and the shared line-type module**

`apps/web/src/lib/api/contracts.ts`, per the **Interfaces** block above, with these comments:

```ts
/** #3205 W04 (#4607): what happens to the units above includedQuantity. */
export type OverageMode = 'bill' | 'flag';

/** One allowance line that is OVER this period, in either mode. `bill` is on the
 *  invoice; `flag` is not — the UI branches on `mode`. */
export interface OverageSummary {
  contractLineId: string;
  /** The materialized overage invoice line ('bill' mode) or null ('flag' mode). W07
   *  attaches device evidence to it. */
  invoiceLineId: string | null;
  description: string;
  counted: number;
  included: number;
  overage: number;
  mode: OverageMode;
}
```

On `ContractEstimateLine`: `counted: number; included: number | null; overage: number; overageMode: OverageMode | null; overageValue: string;` — plus a comment that `quantity` is the BASE quantity (`billed`) and `overageValue` is **never** folded into `value`. On `ContractEstimate`: `overages: OverageSummary[];`. On `ContractLine`: the three nullable columns.

`apps/web/src/components/contracts/lineTypes.ts`:

```ts
/** Types that accept a fixed included quantity + overage disposition (#3205 W04).
 *  One copy, same reason AUTO_QTY_TYPES exists. Mirrors ALLOWANCE_LINE_TYPES in
 *  @breeze/shared and the type list in contract_lines_allowance_chk. */
export const ALLOWANCE_TYPES = new Set<ContractLineType>([
  'per_device', 'per_device_role', 'per_device_group', 'per_seat',
]);
```

- [ ] **Step 4: `AllowanceCell.tsx`**

Create `apps/web/src/components/contracts/AllowanceCell.tsx` (mirrors `DeviceCoverageNotice.tsx`, which exports a component plus a formatter):

```tsx
import { useTranslation } from 'react-i18next';
import type { ContractEstimateLine, ContractLine, OverageSummary } from '../../lib/api/contracts';
import { AUTO_QTY_TYPES } from './lineTypes';

/**
 * #3205 W04 (#4607): the quantity cell body for both contract tables. Five
 * states, so the operator can always tell an allowance from a raw count:
 *   no allowance          -> exactly as before (live count, manual qty, or 1)
 *   allowance, no estimate-> "25 included" from the row alone (never blank)
 *   within the allowance  -> "18 of 25 included"
 *   over, bill            -> "25 included · 3 over (billed)"
 *   over, flag            -> the same, amber, "(flagged)"
 */
export default function AllowanceCell(
  { line, estimate }: { line: ContractLine; estimate?: ContractEstimateLine },
) {
  const { t } = useTranslation('billing');
  // W02: a group line whose group was deleted has no resolvable quantity at all.
  if (estimate?.unresolved === 'group_deleted') return <>{t('contracts.shared.values.groupDeleted')}</>;

  const base = AUTO_QTY_TYPES.has(line.lineType)
    ? (estimate ? String(estimate.quantity) : <span className="text-muted-foreground">{t('contracts.shared.values.auto')}</span>)
    : (line.lineType === 'manual' ? (line.manualQuantity ?? '0') : '1');

  if (line.includedQuantity === null) return <>{base}</>;
  const included = Number(line.includedQuantity);

  if (!estimate) {
    return <span data-testid="allowance-included-only">{t('contracts.shared.allowance.includedOnly', { included })}</span>;
  }
  if (estimate.overage <= 0) {
    return (
      <span data-testid="allowance-within">
        {t('contracts.shared.allowance.includedOf', { counted: estimate.counted, included })}
      </span>
    );
  }
  const flagged = estimate.overageMode === 'flag';
  return (
    <span
      data-testid={flagged ? 'allowance-over-flagged' : 'allowance-over-billed'}
      className={flagged ? 'text-amber-600 dark:text-amber-500' : undefined}
    >
      {t(flagged ? 'contracts.shared.allowance.overFlagged' : 'contracts.shared.allowance.overBilled',
        { included, overage: estimate.overage })}
    </span>
  );
}

/**
 * The contract-level digest, rendered directly under <DeviceCoverageNotice /> in
 * both estimate panels. Flagged entries are amber (money left on the table that
 * only a human can act on); billed entries are muted (already on the invoice).
 */
export function OverageNotice({ overages }: { overages: OverageSummary[] | undefined }) {
  const { t } = useTranslation('billing');
  if (!overages || overages.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {overages.map((o) => (
        <p
          key={o.contractLineId}
          data-testid={o.mode === 'flag' ? 'contract-overage-flagged' : 'contract-overage-billed'}
          className={o.mode === 'flag'
            ? 'rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
            : 'text-xs text-muted-foreground'}
        >
          {t(o.mode === 'flag' ? 'contracts.shared.overage.flagged' : 'contracts.shared.overage.billed',
            { description: o.description, included: o.included, overage: o.overage })}
        </p>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: `ContractEditor.tsx`**

State, after `lineRoles` (`:143`):

```ts
  // #3205 W04: the add-form allowance. Cleared whenever lineType changes, so an
  // allowance can never be smuggled onto a type the CHECK forbids it on.
  const [lineAllowanceOn, setLineAllowanceOn] = useState(false);
  const [lineIncludedQty, setLineIncludedQty] = useState('');
  const [lineOverageMode, setLineOverageMode] = useState<OverageMode>('bill');
  const [lineOveragePrice, setLineOveragePrice] = useState('');
```

Guard, beside `roleLineMissingRoles` (`:396`):

```ts
  // #3205 W04: an allowance needs a quantity, and a price when extras are billed.
  const allowanceOn = lineAllowanceOn && ALLOWANCE_TYPES.has(lineType);
  const allowanceIncomplete = allowanceOn
    && (!lineIncludedQty.trim() || (lineOverageMode === 'bill' && !lineOveragePrice.trim()));
```

`estByLine` (`:336-340`) now maps the whole estimate line, not just the number:

```ts
  // Resolved live estimate per line — the whole line now, because AllowanceCell
  // needs counted/overage/overageMode as well as the base quantity (#3205 W04).
  const estByLine = useMemo(() => {
    const m = new Map<string, ContractEstimateLine>();
    for (const e of liveEstimate?.lines ?? []) m.set(e.lineId, e);
    return m;
  }, [liveEstimate]);
```

Line-row quantity cell (`:925-931`) becomes:

```tsx
                          <td className="px-3 py-2 text-right tabular-nums" data-testid={`line-qty-${idx}`}>
                            <AllowanceCell line={l} estimate={estByLine.get(l.id)} />
                          </td>
```

Type-select `onChange` (`:995`) also clears the allowance:

```ts
                      onChange={(e) => {
                        setLineType(e.target.value as ContractLineType);
                        setLineSiteId(''); setLineRoles([]);
                        setLineAllowanceOn(false); setLineIncludedQty(''); setLineOveragePrice(''); setLineOverageMode('bill');
                      }}
```

The allowance block, after the site select (`:1095-1107`):

```tsx
                  {ALLOWANCE_TYPES.has(lineType) && (
                    <fieldset className="flex flex-col gap-2 text-xs text-muted-foreground sm:col-span-2">
                      <label className="flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox" checked={lineAllowanceOn}
                          onChange={(e) => setLineAllowanceOn(e.target.checked)}
                          data-testid="contract-line-allowance-toggle"
                        />
                        {t('contracts.contractEditor.addLine.allowanceToggle')}
                      </label>
                      {lineAllowanceOn && (
                        <>
                          <span>{t('contracts.contractEditor.addLine.allowanceHint')}</span>
                          <label className="flex flex-col gap-1">
                            {t('contracts.contractEditor.addLine.includedQuantity')}
                            <input
                              type="number" min="1" step="1" value={lineIncludedQty}
                              onChange={(e) => setLineIncludedQty(e.target.value)}
                              data-testid="contract-line-included-qty"
                              className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                            />
                          </label>
                          <span>{t('contracts.contractEditor.addLine.overageMode')}</span>
                          <div className="flex flex-wrap gap-3 text-sm text-foreground">
                            <label className="inline-flex items-center gap-1.5">
                              <input
                                type="radio" name="overage-mode" checked={lineOverageMode === 'bill'}
                                onChange={() => setLineOverageMode('bill')}
                                data-testid="contract-line-overage-bill"
                              />
                              {t('contracts.contractEditor.addLine.overageBill')}
                            </label>
                            <label className="inline-flex items-center gap-1.5">
                              <input
                                type="radio" name="overage-mode" checked={lineOverageMode === 'flag'}
                                onChange={() => setLineOverageMode('flag')}
                                data-testid="contract-line-overage-flag"
                              />
                              {t('contracts.contractEditor.addLine.overageFlag')}
                            </label>
                          </div>
                          {lineOverageMode === 'bill' && (
                            <label className="flex flex-col gap-1">
                              {t('contracts.contractEditor.addLine.overageUnitPrice')}
                              <input
                                type="number" min="0" step="0.01" value={lineOveragePrice}
                                onChange={(e) => setLineOveragePrice(e.target.value)}
                                data-testid="contract-line-overage-price"
                                className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                              />
                            </label>
                          )}
                          {allowanceIncomplete && (
                            <span className="text-amber-600 dark:text-amber-500">
                              {t('contracts.contractEditor.addLine.allowanceRequired')}
                            </span>
                          )}
                        </>
                      )}
                    </fieldset>
                  )}
```

`addLine` (`:570-605`): add `allowanceIncomplete` to the early return and to the `useCallback` deps (with `lineAllowanceOn`, `lineIncludedQty`, `lineOverageMode`, `lineOveragePrice`), send the keys only when the box is checked, and reset them on success:

```ts
          includedQuantity: allowanceOn ? lineIncludedQty : undefined,
          overageMode: allowanceOn ? lineOverageMode : undefined,
          overageUnitPrice: allowanceOn && lineOverageMode === 'bill' ? lineOveragePrice : undefined,
```
```ts
      setLineAllowanceOn(false); setLineIncludedQty(''); setLineOveragePrice(''); setLineOverageMode('bill');
```

Add button `disabled` (`:1152`) gains `|| allowanceIncomplete`.

Estimate panel, right after `<DeviceCoverageNotice … />` (`:1186`):

```tsx
                <OverageNotice overages={liveEstimate?.overages} />
```

**W03's inline edit form** gets the same three controls on the open row, seeded from the line (`editDraft.includedQuantity` etc.), with the checkbox reflecting `line.includedQuantity !== null`. Patch construction follows W03's minimal-patch rule with **one exception, mirroring its unlink exception**: turning the allowance **off** sends `{ includedQuantity: null, overageMode: null, overageUnitPrice: null }` **together in one patch** — a single null is a 400 `INVALID_LINE_PATCH` by design. Turning it on, or changing it, sends whichever of the three differ, plus `overageUnitPrice: null` when switching `bill → flag` (the merged row must not keep a rate on a flag line). Save is disabled while the block is on and incomplete, reusing `allowanceIncomplete`'s predicate over the edit draft.

- [ ] **Step 6: `ContractDetail.tsx`**

Build the same per-line map from the loaded estimate and delegate the quantity cell (`:385-389`):

```tsx
  const estByLine = useMemo(() => {
    const m = new Map<string, ContractEstimateLine>();
    for (const e of estimate?.lines ?? []) m.set(e.lineId, e);
    return m;
  }, [estimate]);
```
```tsx
                      <td className="px-3 py-2 text-right" data-testid={`contract-detail-line-qty-${l.id}`}>
                        <AllowanceCell line={l} estimate={estByLine.get(l.id)} />
                      </td>
```

Estimate stat, right after `<DeviceCoverageNotice … />` (`:335`): `<OverageNotice overages={estimate?.overages} />`.

Generate handler, after the `uncoveredDevices` toast (`:199`):

```ts
      // #3205 W04: flagged overage is money left on the table. It is NOT on the
      // invoice the user is about to be navigated to, so this toast is the only
      // place they see it. Billed overage raises nothing — it is a line on the
      // invoice they are about to open.
      const flagged = (result?.data?.overages ?? []).filter((o) => o.mode === 'flag');
      if (flagged.length > 0) {
        showToast({
          type: 'warning',
          message: t('contracts.contractDetail.toast.flaggedOverage', {
            count: flagged.length,
            names: flagged.map((o) => o.description).join(', '),
          }),
        });
      }
```

Widen the `runAction` generic on `:167` with `overages?: OverageSummary[]`.

- [ ] **Step 7: i18n — 15 keys in eight locales**

`apps/web/src/locales/en/billing.json`. Inside `contracts.shared`, two new objects:

```json
      "allowance": {
        "includedOf": "{{counted}} of {{included}} included",
        "includedOnly": "{{included}} included",
        "overBilled": "{{included}} included · {{overage}} over (billed)",
        "overFlagged": "{{included}} included · {{overage}} over (flagged)"
      },
      "overage": {
        "flagged": "{{description}} — {{overage}} over {{included}} included, not billed",
        "billed": "{{description}} — {{overage}} over {{included}} included, billed at the overage rate"
      },
```

Inside `contracts.contractDetail.toast`:

```json
        "flaggedOverage": "{{count}} line(s) are over their included quantity and were not billed: {{names}}",
```

Inside `contracts.contractEditor.addLine`:

```json
        "allowanceToggle": "Include a fixed quantity, then handle extras",
        "allowanceHint": "The line bills the included quantity every period, even when fewer devices are counted.",
        "includedQuantity": "Included quantity",
        "overageMode": "Extras beyond the included quantity",
        "overageBill": "Bill extras",
        "overageFlag": "Flag extras for review",
        "overageUnitPrice": "Price per extra unit",
        "allowanceRequired": "Enter an included quantity, and a price when you bill extras.",
```

The same keys in the other seven locales. **`fr-CA` and `fr-FR` take the identical French string** (one column below, two files):

| key | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|
| allowance.includedOf | {{counted}} von {{included}} inbegriffen | {{counted}} de {{included}} incluidos | {{counted}} sur {{included}} inclus | {{counted}} di {{included}} inclusi | {{counted}} de {{included}} incluídos | {{included}} dahilden {{counted}} |
| allowance.includedOnly | {{included}} inbegriffen | {{included}} incluidos | {{included}} inclus | {{included}} inclusi | {{included}} incluídos | {{included}} dahil |
| allowance.overBilled | {{included}} inbegriffen · {{overage}} darüber (berechnet) | {{included}} incluidos · {{overage}} por encima (facturados) | {{included}} inclus · {{overage}} au-delà (facturés) | {{included}} inclusi · {{overage}} oltre (fatturati) | {{included}} incluídos · {{overage}} acima (faturados) | {{included}} dahil · {{overage}} fazla (faturalandı) |
| allowance.overFlagged | {{included}} inbegriffen · {{overage}} darüber (markiert) | {{included}} incluidos · {{overage}} por encima (marcados) | {{included}} inclus · {{overage}} au-delà (signalés) | {{included}} inclusi · {{overage}} oltre (segnalati) | {{included}} incluídos · {{overage}} acima (sinalizados) | {{included}} dahil · {{overage}} fazla (işaretlendi) |
| overage.flagged | {{description}} — {{overage}} über {{included}} inbegriffen, nicht berechnet | {{description}} — {{overage}} por encima de {{included}} incluidos, sin facturar | {{description}} — {{overage}} au-delà des {{included}} inclus, non facturés | {{description}} — {{overage}} oltre i {{included}} inclusi, non fatturati | {{description}} — {{overage}} acima dos {{included}} incluídos, não faturados | {{description}} — {{included}} dahilin {{overage}} üzerinde, faturalandırılmadı |
| overage.billed | {{description}} — {{overage}} über {{included}} inbegriffen, zum Überschreitungspreis berechnet | {{description}} — {{overage}} por encima de {{included}} incluidos, facturados a la tarifa de excedente | {{description}} — {{overage}} au-delà des {{included}} inclus, facturés au tarif de dépassement | {{description}} — {{overage}} oltre i {{included}} inclusi, fatturati alla tariffa di eccedenza | {{description}} — {{overage}} acima dos {{included}} incluídos, faturados pela tarifa de excedente | {{description}} — {{included}} dahilin {{overage}} üzerinde, aşım tarifesinden faturalandı |
| contractDetail.toast.flaggedOverage | {{count}} Position(en) liegen über der inbegriffenen Menge und wurden nicht berechnet: {{names}} | {{count}} línea(s) superan la cantidad incluida y no se facturaron: {{names}} | {{count}} ligne(s) dépassent la quantité incluse et n'ont pas été facturées : {{names}} | {{count}} riga/righe superano la quantità inclusa e non sono state fatturate: {{names}} | {{count}} linha(s) excedem a quantidade incluída e não foram faturadas: {{names}} | {{count}} satır dahil edilen miktarı aştı ve faturalandırılmadı: {{names}} |
| addLine.allowanceToggle | Feste Menge einschließen, Rest separat behandeln | Incluir una cantidad fija y gestionar los extras | Inclure une quantité fixe, puis gérer les extras | Includi una quantità fissa e gestisci le eccedenze | Incluir uma quantidade fixa e tratar os excedentes | Sabit bir miktar dahil et, fazlasını ayrıca yönet |
| addLine.allowanceHint | Die Position berechnet in jedem Zeitraum die inbegriffene Menge, auch wenn weniger Geräte gezählt werden. | La línea factura la cantidad incluida en cada período, incluso si se cuentan menos dispositivos. | La ligne facture la quantité incluse à chaque période, même si moins d'appareils sont comptés. | La riga fattura la quantità inclusa in ogni periodo, anche quando i dispositivi contati sono meno. | A linha cobra a quantidade incluída em todos os períodos, mesmo quando são contados menos dispositivos. | Satır, daha az cihaz sayılsa bile her dönem dahil edilen miktarı faturalandırır. |
| addLine.includedQuantity | Inbegriffene Menge | Cantidad incluida | Quantité incluse | Quantità inclusa | Quantidade incluída | Dahil edilen miktar |
| addLine.overageMode | Über die inbegriffene Menge hinaus | Extras por encima de la cantidad incluida | Au-delà de la quantité incluse | Oltre la quantità inclusa | Acima da quantidade incluída | Dahil edilen miktarın üzeri |
| addLine.overageBill | Extras berechnen | Facturar extras | Facturer les extras | Fattura le eccedenze | Faturar excedentes | Fazlasını faturalandır |
| addLine.overageFlag | Extras zur Prüfung markieren | Marcar extras para revisión | Signaler les extras pour examen | Segnala le eccedenze per revisione | Sinalizar excedentes para revisão | Fazlasını incelemek üzere işaretle |
| addLine.overageUnitPrice | Preis je zusätzlicher Einheit | Precio por unidad adicional | Prix par unité supplémentaire | Prezzo per unità aggiuntiva | Preço por unidade adicional | Ek birim başına fiyat |
| addLine.allowanceRequired | Geben Sie eine inbegriffene Menge an – und einen Preis, wenn Extras berechnet werden. | Ingresa una cantidad incluida y un precio si facturas los extras. | Saisissez une quantité incluse, et un prix si vous facturez les extras. | Inserisci una quantità inclusa e un prezzo se fatturi le eccedenze. | Informe uma quantidade incluída e um preço se faturar os excedentes. | Dahil edilen bir miktar girin; fazlasını faturalandırıyorsanız bir fiyat da girin. |

`tr-TR` parity is part of **this** change, not a follow-up — the locale-parity test fails otherwise.

- [ ] **Step 8: Run**

Run: `cd apps/web && npx vitest run src/components/contracts src/components/billing/invoiceTypes.test.ts src/components/billing/InvoiceDocument.test.tsx src/lib/i18n && npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: PASS, including every pre-existing `ContractEditor.*` / `ContractDetail.*` suite (their estimate fixtures need the new fields added — widen them, do not loosen the assertions) and the locale-parity test; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/api/contracts.ts apps/web/src/components/contracts apps/web/src/components/billing/invoiceTypes.test.ts apps/web/src/components/billing/InvoiceDocument.test.tsx apps/web/src/locales
git commit -m "feat(web): allowance controls, quantity cells, overage notice and flagged-overage toast (#3205 W04)"
```

---

### Task 8: Docs and the release-notes draft

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx:33-47`

- [ ] **Step 1: Edit the feature page**

After the site/catalog paragraph (and after W03's "Editing a line." paragraph), add:

```md
### Included quantity and overage

Any line that counts something — per device, per device role, per device group or per seat — can carry an **included quantity**: "up to 25 devices included". With an included quantity set, the line bills that quantity **every period, even when fewer are counted** — it is a fixed inclusion, not a cap on a variable count. Anything above it is handled one of two ways:

- **Bill extras.** A second, customer-visible line is added to the invoice for the units above the included quantity, at the overage price you set, directly under the line it belongs to. It is an ordinary line: it is taxed, it counts toward margin, and you can edit or remove it on a draft invoice.
- **Flag extras for review.** Nothing extra is invoiced. The excess is reported on the contract estimate, on the result of a manual **Generate now**, and in the nightly billing log, so somebody can decide whether to raise the included quantity or add a line.

The overage price must be valid in the contract's currency (a yen contract cannot have a ¥12.50 rate), and an overage price of zero is allowed — the extras are itemised on the customer's invoice at no charge. An included quantity must be a whole number greater than zero, and cannot go on a flat or manual line. While any line carries an overage price, the contract's currency cannot be restamped: clear the allowance (or the lines) first, because an overage price you typed by hand cannot be re-derived from a price book.
```

- [ ] **Step 2: Build and commit**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds.

```bash
git add apps/docs/src/content/docs/features/contracts.mdx
git commit -m "docs(contracts): included quantity and overage (#3205 W04)"
```

- [ ] **Step 3: Draft the release-notes entry (no repo file)**

The marketing release notes live outside this repo (`breezermm.com`, authored through the `update-breeze-release-notes` skill at release time). Paste this draft verbatim into the PR body under a `## Release notes` heading so the release author does not have to re-derive it:

> **Contracts — included quantity and overage.** A per-device, per-role, per-group or per-seat contract line can now include a fixed quantity — "up to 25 devices included" — and either bill the extras at a second rate or flag them for review. A billed overage becomes its own line on the invoice, directly under the line it belongs to, so the customer sees the count and the rate. A flagged overage is never invoiced silently: it shows on the contract estimate, on the result of Generate now, and in the nightly billing log.

---

### Task 9: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Full local verification on a fresh test stack**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json \
  && cd ../web && npx tsc --noEmit -p tsconfig.json \
  && cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
cd ../.. && pnpm lint
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run

# fresh DB
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test
cd apps/api && pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts \
  src/__tests__/integration/contractLineAllowance.integration.test.ts \
  src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractEstimate.integration.test.ts \
  src/__tests__/integration/contractDeviceRoles.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all green; drift clean.

- [ ] **Step 2: Extend the export/erasure round-trip**

`apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`: give the existing seeded `per_device_role` line (`:135-138`) an allowance, so no row count changes and W02's count assertion stays valid:

```ts
  await db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_roles,
                                included_quantity, overage_mode, overage_unit_price)
    VALUES (${contractId}, ${orgA}, 'per_device_role', 'Network gear', 25.00, false,
            ARRAY['switch','router','firewall']::text[], 10.00, 'bill', 30.00)
  `);
```

and, in the manifest test, read the archive entry and assert the three columns are actually exported (the export-policy registration is only *proven* by reading the file):

```ts
    // #3205 W04: the three allowance columns are classified `included`, so they
    // must be in the archive — the registry test proves classification, this
    // proves delivery.
    const clEntry = Object.entries(zip.files).find(([name]) => name.endsWith('contract_lines.json'))![1];
    const clRows = JSON.parse(await clEntry.async('string')) as Array<Record<string, unknown>>;
    expect(clRows.some((r) => r.included_quantity === '10.00' && r.overage_mode === 'bill' && r.overage_unit_price === '30.00')).toBe(true);
```

(Numeric columns come back as strings from postgres.js; if the export serialises them differently, assert the shape it actually produces — but assert the **values**, not just key presence.)

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` → PASS.

```bash
git add apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "test(billing): export/erasure round-trip carries the allowance columns (#3205 W04)"
```

- [ ] **Step 3: Manual verification**

- In psql as `breeze_app` (`docker exec -it <test-pg> psql -U breeze_app -d breeze_test`): insert a `flat` line with `included_quantity`, and a `per_device` line with `included_quantity` but no `overage_mode`. Both must fail with `new row violates check constraint "contract_lines_allowance_chk"`.
- `pnpm db:check-drift` clean.
- Generate on a `bill` contract that is over its allowance and confirm the invoice PDF, the web invoice detail and the customer/portal view all show the overage as an ordinary priced line **directly under its base line**, un-indented and un-muted.
- Generate on a `flag` contract that is over and confirm: no second line on the invoice, a warning toast naming the line, and the amber digest on the contract page.

- [ ] **Step 4: Tear down the test stack, push, open the PR**

```bash
git push -u origin feature/3205-allowance-overage/wave-4653
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): included quantity and overage on contract lines (#3205 W04)" --body "$(cat <<'BODY'
Closes #4653
Refs #3205
Refs #4607

Spec: `docs/superpowers/specs/billing/2026-09-03-contract-line-allowance-overage-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-03-contract-line-allowance-overage.md`

## What

- A counted contract line (`per_device`, `per_device_role`, `per_device_group`, `per_seat`) can carry a **fixed included quantity** plus a disposition for the extras. **Fixed-allowance economics:** the base line bills the allowance every period whether the count reaches it or not, and `overage = max(0, counted − included)` — `counted = 0` still bills 25.
- `overage_mode = 'bill'` writes a second, **top-level sibling** invoice line at `overage_unit_price`, immediately after its base line (`parent_line_id IS NULL`, `source_id` = the contract line, durable `source_contract_id`). It is a real charge: taxed, counted in margin, editable, pushed to QuickBooks, cloned by void/reissue. **This supersedes the roadmap brief's `parentLineId` = base line**: every existing parent/child consumer treats a child as a bundle breakdown row, and `computeInvoiceProfit` would have dropped the overage revenue from margin entirely.
- `overage_mode = 'flag'` invoices nothing and is loud in three places instead — the estimate, the generate result (`overages[]`) and one nightly `console.warn` — plus a warning toast on manual generation. Billed overage raises no warning: it is on the invoice.
- One pure module, `contractAllowance.ts`, is the single definition of the quantity split and of overage money; `resolveLineQty` (estimate, list, MRR) and `generateDueInvoice`'s own switch both route through it, so the four paths cannot disagree. Every money leg this wave touches now uses `multiplyToCurrency` + `toCents`/`fromCents` — the legs that previously did `Number(l.unitPrice) * quantity`.
- `generateDueInvoice` now fails fast unless it is inside an ambient DB access context (`assertInTransaction`). Both existing callers already comply; without one, forced RLS on `breeze_app` silently matches 0 rows (#1375) and W04 doubles the writes per line.
- `changeContractCurrency` is 409 `CURRENCY_LOCKED` while any line carries a stamped overage rate — the reprice loop writes only `unit_price` and cannot re-derive a hand-entered rate from a price book. No such rate exists before this release, so no contract's restamp behaviour changes on upgrade.

## Migrations

- `2026-10-07-100000-contract-lines-allowance-overage.sql` — one file: `CREATE TYPE contract_overage_mode AS ENUM ('bill','flag')`, three nullable columns, one **NULL-safe** `contract_lines_allowance_chk`. (`CREATE TYPE` has none of `ALTER TYPE … ADD VALUE`'s same-transaction restriction, which is the only reason waves 1 and 2 split their files.) Additive and idempotent; all three columns default NULL, so every existing line resolves through the identity branch and bills exactly as today.

## Registration lists

`contract_lines` was already in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`. Columns-only ⇒ the export policy is the one list that fires: the three columns are classified `included` (none is json/jsonb/bytea, none matches `SUSPICIOUS_NAME_PARTS`), asserted by both the policy contract test and the export/erasure round-trip.

## Tests

Pure allowance matrix (counted × mode, both base-billing modes, the `0.02 × 7.25 → '0.15'` double-killer); validator rules in **both** invariant modes with null/undefined parity; a real-DB **presence matrix** over all eight null/non-null combinations of the three columns on all six line types (a CHECK passes on NULL, so every conjunct is proven to reject rather than abstain); the full boundary matrix through `generateDueInvoice` asserting quantities, per-line totals, **subtotal, tax and total**; the zero-price child; a catalog base plus a price-book gap; `per_seat`; re-run idempotency; **fault-injection rollback** (only the overage insert fails → no invoice, no lines, no period claim, `next_billing_at` unchanged); the missing-context guard; void/reissue cloning both siblings; the pinned pre-existing `SOURCE_NOT_FOUND` limitation; QuickBooks push with no `ItemRef` on the overage; the currency-restamp refusal; the worker warning; route pass-through; AI `add_line`/`update_line`; export/erasure round-trip; and the web decision-8 regression pins (`computeInvoiceProfit` counts it, `InvoiceDocument` renders it un-indented).

## Known limitation (pre-existing, pinned not fixed)

Issuing a **reissued** draft after its contract line was removed still fails with 409 `SOURCE_NOT_FOUND` (`invoiceService.ts:1194-1199`; `removeContractLine` is permitted on active contracts). W04 doubles the number of invoice lines carrying that dead `source_id` but does not change the behaviour; a test documents it.

## Release notes

**Contracts — included quantity and overage.** A per-device, per-role, per-group or per-seat contract line can now include a fixed quantity — "up to 25 devices included" — and either bill the extras at a second rate or flag them for review. A billed overage becomes its own line on the invoice, directly under the line it belongs to, so the customer sees the count and the rate. A flagged overage is never invoiced silently: it shows on the contract estimate, on the result of Generate now, and in the nightly billing log.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
BODY
)"
```

Stop here. Do not merge. Report the PR URL and anything that was skipped or failed.
