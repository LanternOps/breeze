# Billing Enum SSOT + UX Cleanup (F1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three duplicated invoice-domain enums (`InvoiceStatus`, `PaymentMethod`, `InvoiceLineSourceType`) into a single `as const` tuple source in `packages/shared`, consumed by the Drizzle schema, API service types, Zod validators, web, and portal — then a timeboxed billing-UI papercut sweep.

**Architecture:** One canonical module exports three `as const` tuples plus derived union types. Every other layer derives from them: the Drizzle `pgEnum` spreads the tuple (same name/values/order ⇒ no migration, no drift), service types re-export, Zod uses `z.enum([...tuple])`, and both frontends import the tuples for their label/color maps and filter options. A guardrail test pins the Drizzle pgEnum to the shared tuple so future drift fails CI.

**Tech Stack:** TypeScript, Drizzle ORM (`drizzle-orm/pg-core` `pgEnum`), Zod v4, Vitest, Astro + React (web + portal). `@breeze/shared` is a typecheck-only workspace package (no build step); web and portal both already carry the `@breeze/shared` tsconfig path alias.

## Global Constraints

- **No DB migration.** pgEnum names, values, and **value order** must stay byte-identical (`draft, sent, partially_paid, overdue, paid, void` / `cash, check, bank_transfer, card, other` / `time_entry, part, catalog, bundle, manual, contract`). Reordering breaks Postgres enums and `db:check-drift`.
- **Behavior-neutral.** No existing billing test's expectations may change; if one does, the refactor is wrong.
- **Out of scope:** the quote/contract/catalog enums (`quotes.ts`, `contracts.ts`, `catalog.ts`) — do not touch them.
- **Node:** prefix toolchain commands with the pinned Node so pnpm's engine-strict passes: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **Test runner:** for a single API/web/shared test file use `pnpm --filter <pkg> exec vitest run <path>` — `pnpm --filter <pkg> test -- <file>` runs the whole suite. The full API suite has known parallel flakiness; verify your changes on the affected files single-fork and trust CI for the full run.
- **`db:check-drift`** needs `DATABASE_URL` exported (e.g. `postgresql://breeze:breeze@localhost:5432/breeze`).
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Canonical billing enum tuples in `@breeze/shared`

**Files:**
- Create: `packages/shared/src/types/billing-enums.ts`
- Modify: `packages/shared/src/types/index.ts` (add a barrel re-export)
- Test: `packages/shared/src/types/billing-enums.test.ts`

**Interfaces:**
- Produces: `INVOICE_STATUSES`, `PAYMENT_METHODS`, `INVOICE_LINE_SOURCE_TYPES` (`readonly` `as const` string tuples) and the derived types `InvoiceStatus`, `PaymentMethod`, `InvoiceLineSourceType`. All importable from `@breeze/shared`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/billing-enums.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  INVOICE_LINE_SOURCE_TYPES,
} from './billing-enums';

describe('billing enum tuples (canonical source)', () => {
  it('invoice statuses match the shipped pgEnum values and order', () => {
    expect([...INVOICE_STATUSES]).toEqual([
      'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void',
    ]);
  });
  it('payment methods match the shipped pgEnum values and order', () => {
    expect([...PAYMENT_METHODS]).toEqual([
      'cash', 'check', 'bank_transfer', 'card', 'other',
    ]);
  });
  it('invoice line source types match the shipped pgEnum values and order', () => {
    expect([...INVOICE_LINE_SOURCE_TYPES]).toEqual([
      'time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/types/billing-enums.test.ts`
Expected: FAIL — cannot resolve `./billing-enums`.

- [ ] **Step 3: Create the canonical module**

Create `packages/shared/src/types/billing-enums.ts`:

```ts
/**
 * Single source of truth for the invoice-domain enums. Every layer derives
 * from these tuples: the Drizzle pgEnum (spreads the tuple), the API service
 * types (re-export), the Zod validators (z.enum), and the web + portal UIs.
 * The values and ORDER are load-bearing — they mirror the shipped Postgres
 * enums, so changing order is a breaking DB change, not a refactor.
 */
export const INVOICE_STATUSES = [
  'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void',
] as const;

export const PAYMENT_METHODS = [
  'cash', 'check', 'bank_transfer', 'card', 'other',
] as const;

export const INVOICE_LINE_SOURCE_TYPES = [
  'time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type InvoiceLineSourceType = (typeof INVOICE_LINE_SOURCE_TYPES)[number];
```

- [ ] **Step 4: Re-export from the types barrel**

In `packages/shared/src/types/index.ts`, add (alongside the existing `export * from './...'` lines):

```ts
export * from './billing-enums';
```

(The package root `packages/shared/src/index.ts` already does `export * from './types'`, so these become importable from `@breeze/shared`.)

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/types/billing-enums.test.ts`
Expected: PASS (3 tests).
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/billing-enums.ts packages/shared/src/types/billing-enums.test.ts packages/shared/src/types/index.ts
git commit -m "refactor(billing): add canonical invoice enum tuples to @breeze/shared

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Drizzle `pgEnum` derives from the tuples + guardrail drift test

**Files:**
- Modify: `apps/api/src/db/schema/invoices.ts:9-17`
- Test: `apps/api/src/db/schema/invoices.enums.test.ts` (create)

**Interfaces:**
- Consumes: `INVOICE_STATUSES`, `PAYMENT_METHODS`, `INVOICE_LINE_SOURCE_TYPES` from `@breeze/shared`.
- Produces: unchanged exports `invoiceStatusEnum`, `invoiceLineSourceTypeEnum`, `paymentMethodEnum` (same pgEnum names/values).

- [ ] **Step 1: Write the failing guardrail test**

Create `apps/api/src/db/schema/invoices.enums.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  INVOICE_LINE_SOURCE_TYPES,
} from '@breeze/shared';
import {
  invoiceStatusEnum,
  invoiceLineSourceTypeEnum,
  paymentMethodEnum,
} from './invoices';

describe('invoice pgEnum ⇄ @breeze/shared tuple parity', () => {
  it('invoice_status pgEnum equals the shared tuple (order-sensitive)', () => {
    expect(invoiceStatusEnum.enumValues).toEqual([...INVOICE_STATUSES]);
  });
  it('payment_method pgEnum equals the shared tuple (order-sensitive)', () => {
    expect(paymentMethodEnum.enumValues).toEqual([...PAYMENT_METHODS]);
  });
  it('invoice_line_source_type pgEnum equals the shared tuple (order-sensitive)', () => {
    expect(invoiceLineSourceTypeEnum.enumValues).toEqual([...INVOICE_LINE_SOURCE_TYPES]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes for the current hard-coded enums first**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/schema/invoices.enums.test.ts`
Expected: PASS — the current literals already equal the tuple. (This proves the test is correct *before* the rewire; it is the safety net that catches an accidental value/order change in Step 3.)

- [ ] **Step 3: Rewire the pgEnums to spread the tuples**

In `apps/api/src/db/schema/invoices.ts`, add to the imports near the top:

```ts
import { INVOICE_STATUSES, INVOICE_LINE_SOURCE_TYPES, PAYMENT_METHODS } from '@breeze/shared';
```

Replace lines 9-17:

```ts
export const invoiceStatusEnum = pgEnum('invoice_status', [...INVOICE_STATUSES]);
export const invoiceLineSourceTypeEnum = pgEnum('invoice_line_source_type', [...INVOICE_LINE_SOURCE_TYPES]);
export const paymentMethodEnum = pgEnum('payment_method', [...PAYMENT_METHODS]);
```

- [ ] **Step 4: Run the guardrail test + typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/schema/invoices.enums.test.ts`
Expected: PASS (3 tests).
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck`
Expected: no errors (the spread satisfies `pgEnum`'s `[string, ...string[]]` param).

- [ ] **Step 5: Verify no schema drift (load-bearing)**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift. This proves the pgEnum DDL is byte-identical. If drift appears, a value or order changed — revert Step 3 and re-check the tuple.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/invoices.ts apps/api/src/db/schema/invoices.enums.test.ts
git commit -m "refactor(billing): derive invoice pgEnums from shared tuples + drift guardrail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: API service types re-export from `@breeze/shared`

**Files:**
- Modify: `apps/api/src/services/invoiceTypes.ts:1-6`

**Interfaces:**
- Consumes: `InvoiceStatus`, `PaymentMethod`, `InvoiceLineSourceType` types from `@breeze/shared`.
- Produces: same three type names still exported from `./invoiceTypes` (so existing `import { InvoiceStatus } from './invoiceTypes'` callers are unaffected).

- [ ] **Step 1: Replace the local unions with a re-export**

In `apps/api/src/services/invoiceTypes.ts`, replace lines 1-6:

```ts
export type {
  InvoiceStatus,
  InvoiceLineSourceType,
  PaymentMethod,
} from '@breeze/shared';
```

Leave the rest of the file (`InvoiceActor`, `InvoiceServiceErrorCode`, `InvoiceServiceError`) untouched.

- [ ] **Step 2: Typecheck the API package**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck`
Expected: no errors — the re-exported types are structurally identical, so every consumer still compiles.

- [ ] **Step 3: Run the invoice service unit tests (smoke)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/invoiceMath.test.ts src/services/invoiceService.test.ts`
Expected: PASS, unchanged counts.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/invoiceTypes.ts
git commit -m "refactor(billing): re-export invoice service types from shared SSOT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Shared Zod validators derive from the tuples

**Files:**
- Modify: `packages/shared/src/validators/invoices.ts:57,70`
- Test: `packages/shared/src/validators/invoices.test.ts` (create if absent, else extend)

**Interfaces:**
- Consumes: `INVOICE_STATUSES`, `PAYMENT_METHODS` from the sibling types module.

- [ ] **Step 1: Write the failing test**

Create or extend `packages/shared/src/validators/invoices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { INVOICE_STATUSES, PAYMENT_METHODS } from '../types/billing-enums';
import { recordPaymentSchema, listInvoicesQuerySchema } from './invoices';

describe('invoice validators derive from the enum SSOT', () => {
  it('recordPaymentSchema accepts every canonical payment method', () => {
    for (const method of PAYMENT_METHODS) {
      const parsed = recordPaymentSchema.parse({
        amount: 10, method, receivedAt: '2026-06-21',
      });
      expect(parsed.method).toBe(method);
    }
  });
  it('recordPaymentSchema rejects an unknown method', () => {
    expect(() => recordPaymentSchema.parse({
      amount: 10, method: 'crypto', receivedAt: '2026-06-21',
    })).toThrow();
  });
  it('listInvoicesQuerySchema accepts every canonical status', () => {
    for (const status of INVOICE_STATUSES) {
      const parsed = listInvoicesQuerySchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes against the current literals**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/invoices.test.ts`
Expected: PASS — current hard-coded `z.enum` literals already accept these. (Net that catches any value change in Step 3.)

- [ ] **Step 3: Rewire the Zod enums**

In `packages/shared/src/validators/invoices.ts`, add to the top imports:

```ts
import { INVOICE_STATUSES, PAYMENT_METHODS } from '../types/billing-enums';
```

Line 57 — replace the `method` enum:

```ts
  method: z.enum([...PAYMENT_METHODS]),
```

Line 70 — replace the `status` enum:

```ts
  status: z.enum([...INVOICE_STATUSES]).optional(),
```

- [ ] **Step 4: Run the validator test + typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/invoices.test.ts`
Expected: PASS.
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/invoices.ts packages/shared/src/validators/invoices.test.ts
git commit -m "refactor(billing): derive invoice Zod enums from shared tuples

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Web frontend consumes the shared tuples

**Files:**
- Modify: `apps/web/src/components/billing/invoiceTypes.ts:32-35`
- Modify: `apps/web/src/components/billing/InvoicesPage.tsx:8-15,26-34`
- Test: `apps/web/src/components/billing/invoiceTypes.test.ts` (extend)

**Interfaces:**
- Consumes: `InvoiceStatus`, `PaymentMethod`, `INVOICE_STATUSES` from `@breeze/shared`.
- Produces: `invoiceTypes.ts` still exports `InvoiceStatus`, `PaymentMethod`, `STATUS_LABELS`, `STATUS_COLORS`, `PAYMENT_METHOD_LABELS`, `statusLabel`, etc. (unchanged surface).

- [ ] **Step 1: Write the failing test**

Extend `apps/web/src/components/billing/invoiceTypes.test.ts`:

```ts
import { INVOICE_STATUSES } from '@breeze/shared';
import { STATUS_LABELS, STATUS_COLORS } from './invoiceTypes';

it('STATUS_LABELS and STATUS_COLORS cover exactly the canonical statuses', () => {
  expect(Object.keys(STATUS_LABELS).sort()).toEqual([...INVOICE_STATUSES].sort());
  expect(Object.keys(STATUS_COLORS).sort()).toEqual([...INVOICE_STATUSES].sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/billing/invoiceTypes.test.ts`
Expected: FAIL — `@breeze/shared` `INVOICE_STATUSES` not yet imported here (or assertion not present).

- [ ] **Step 3: Replace the local unions with shared imports**

In `apps/web/src/components/billing/invoiceTypes.ts`, replace lines 32-35:

```ts
export type { InvoiceStatus, PaymentMethod } from '@breeze/shared';
```

Then ensure the `Record<InvoiceStatus, ...>` / `Record<PaymentMethod, ...>` maps further down still compile by adding, near the top of the file:

```ts
import type { InvoiceStatus, PaymentMethod } from '@breeze/shared';
```

(The `export type { ... } from` re-exports for downstream consumers; the `import type` brings the names into local scope for the `Record` maps. Keep both.)

- [ ] **Step 4: Derive the status filter options from the tuple**

In `apps/web/src/components/billing/InvoicesPage.tsx`, add `STATUS_LABELS` to the existing import block (lines 8-15):

```ts
import {
  type InvoiceStatus,
  type InvoiceSummary,
  STATUS_COLORS,
  STATUS_LABELS,
  statusLabel,
  formatDate,
  formatMoney,
} from './invoiceTypes';
import { INVOICE_STATUSES } from '@breeze/shared';
```

Replace the hard-coded `STATUS_OPTIONS` array (lines 26-34):

```ts
const STATUS_OPTIONS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  ...INVOICE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
];
```

(`STATUS_LABELS` values are identical to the previous literals — `Draft`, `Sent`, `Partially paid`, `Overdue`, `Paid`, `Void` — so the rendered dropdown is unchanged.)

- [ ] **Step 5: Run web tests + astro check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/billing/invoiceTypes.test.ts src/components/billing/InvoicesPage.test.tsx`
Expected: PASS.
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web check` (astro check — plain tsc skips `.astro`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/invoiceTypes.ts apps/web/src/components/billing/InvoicesPage.tsx apps/web/src/components/billing/invoiceTypes.test.ts
git commit -m "refactor(billing): web consumes shared invoice enum SSOT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Portal frontend consumes the shared tuples (+ build resolution)

**Files:**
- Modify: `apps/portal/src/lib/api.ts:300`
- Modify: `apps/portal/src/components/portal/InvoiceList.tsx` (label map + status switch)
- Modify: `apps/portal/src/components/portal/InvoiceDetailView.tsx` (label map + `PAYABLE_STATUSES` type)
- Possibly modify: `apps/portal/astro.config.mjs` (only if vite can't resolve `@breeze/shared` at build — see Step 3)

**Interfaces:**
- Consumes: `InvoiceStatus`, `INVOICE_STATUSES` from `@breeze/shared`.

- [ ] **Step 1: Replace the portal-local `InvoiceStatus` union with a shared import**

In `apps/portal/src/lib/api.ts`, replace line 300:

```ts
export type { InvoiceStatus } from '@breeze/shared';
```

In `InvoiceList.tsx` and `InvoiceDetailView.tsx`, leave the label maps and status `switch`/`Set` as-is for now (they reference the type, which is now the shared one) — but change any local `InvoiceStatus` type imports to come from `../../lib/api` (which now re-exports the shared type) so there is a single portal entry point. No literal value changes.

- [ ] **Step 2: Typecheck the portal package**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/portal exec astro check`
Expected: no errors. The tsconfig path alias (`apps/portal/tsconfig.json` → `"@breeze/shared": ["../../packages/shared/src"]`) resolves the types.

- [ ] **Step 3: Verify the portal *build* resolves `@breeze/shared` at runtime**

Astro/vite does not automatically honor tsconfig `paths`; portal currently imports nothing from `@breeze/shared`, so this is the first runtime use. Run a build:

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/portal build`

- **If the build succeeds:** done — Astro resolved the alias. Continue to Step 4.
- **If the build fails with "Cannot resolve `@breeze/shared`":** add an explicit vite alias to `apps/portal/astro.config.mjs`. Inside the `defineConfig({...})`, add (merging with any existing `vite` key):

```js
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // ...existing config...
  vite: {
    resolve: {
      alias: {
        '@breeze/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    },
  },
});
```

Re-run the build; expected: success.

- [ ] **Step 4: Run portal tests (if any billing tests exist)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/portal exec vitest run src/components/portal`
Expected: PASS (or "no test files" — portal's harness is thin; do not add new harness here).

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/components/portal/InvoiceList.tsx apps/portal/src/components/portal/InvoiceDetailView.tsx apps/portal/astro.config.mjs
git commit -m "refactor(billing): portal consumes shared invoice enum SSOT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Timeboxed billing-UI papercut sweep

This is an exploratory task, not TDD. Its deliverable is: confirmation that #1418 does not reproduce, a short list of papercuts found, cheap fixes folded in, and GitHub issues filed for anything larger — all summarized in the PR description.

**Files:** none predetermined (depends on findings).

- [ ] **Step 1: Confirm #1418 does not reproduce**

Local app per `e2e_local_docker_pr_testing` (creds `admin@breeze.local` / `BreezeAdmin123!` on `:4321`, `PUBLIC_API_URL=http://localhost`). Open a draft invoice, click **Issue**, and confirm the header/status updates to "Issued/Sent" **without** a manual reload (this is the already-merged `InvoiceEditor.tsx:235` `refresh()` behavior). Note the result.

- [ ] **Step 2: Run a bounded sweep of the billing UI**

Using Playwright MCP, walk: invoices list (`/billing/invoices`), invoice detail/workspace, partner & org billing settings, quotes list. Look specifically for: stale headers/badges after an action, broken optimistic refresh, mislabeled enum values, label drift between web and portal. **Timebox to one pass** — do not deep-dive into individual features.

- [ ] **Step 3: Triage findings**

For each papercut: if it's a single-component, no-schema/no-API fix, fold it in (with a focused component test where practical) and commit it on this branch. If it needs API/schema work or is non-trivial, **file a GitHub issue** (use the `github-issues` conventions) and do **not** fix it here — this keeps F1 bounded.

- [ ] **Step 4: Commit any folded-in fixes + record the sweep**

```bash
git add -A
git commit -m "fix(billing): UI papercuts from F1 sweep (see PR for full list)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Record in the PR description: #1418 verification result, papercuts found, which were fixed vs. filed (with issue numbers).

---

## Final verification (before PR)

- [ ] **Grep-clean:** no hand-typed duplicates of the three enums remain outside the canonical module. Run:
  `git grep -nE "partially_paid|bank_transfer" -- 'apps/**' 'packages/**' | grep -vE "billing-enums|\.test\.|STATUS_LABELS|STATUS_COLORS|PAYMENT_METHOD_LABELS"` and confirm every remaining hit is a label-map *key* or switch-case (keyed off the shared type), not a redefined union/`z.enum`/`pgEnum` literal.
- [ ] **Drift:** `pnpm db:check-drift` clean.
- [ ] **Typecheck:** `pnpm --filter @breeze/api typecheck`, `pnpm --filter @breeze/shared typecheck`, `pnpm --filter @breeze/web check`, `pnpm --filter @breeze/portal exec astro check` — all clean.
- [ ] **Targeted tests** from Tasks 1–6 green.
- [ ] Push branch, open PR; let CI run the full suites (don't chase the known parallel flakiness locally).

## Self-review notes (plan author)

- **Spec coverage:** canonical source (Task 1), Drizzle (Task 2), service types (Task 3), Zod (Task 4), web (Task 5), portal (Task 6), guardrail test (Task 2 Step 1), drift gate (Task 2 Step 5), UX sweep + #1418 verify (Task 7) — every spec section maps to a task.
- **No migration / order-preservation** is enforced by the Task 2 guardrail test running green on the *pre-rewire* literals (Step 2) and the `db:check-drift` gate (Step 5).
- **Type consistency:** `INVOICE_STATUSES`/`PAYMENT_METHODS`/`INVOICE_LINE_SOURCE_TYPES` and `InvoiceStatus`/`PaymentMethod`/`InvoiceLineSourceType` are the only new identifiers and are used verbatim across all tasks.
