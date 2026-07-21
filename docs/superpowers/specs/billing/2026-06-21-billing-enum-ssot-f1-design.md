# F1 · Billing Enum SSOT + UX Cleanup — Design

**Date:** 2026-06-21
**Program:** Billing v1.1 (see `docs/superpowers/specs/billing/2026-06-21-billing-v1.1-roadmap.md`)
**Sub-project:** F1 (foundation, sequenced first)
**Size:** S · **Risk:** low · **DB migration:** none · **RLS/cascade surface:** none

## Goal

Collapse the three duplicated invoice-domain enums into a single source of truth in `packages/shared`, consumed by every layer (Drizzle schema, service types, Zod validators, web, portal). Bundle one known UX bug (#1418) and a timeboxed papercut sweep. The refactor is **behavior-neutral**: no enum value or order changes, so there is no DB migration and `db:check-drift` must remain clean.

## Problem

Each enum is hand-defined in multiple places that can silently drift:

| Enum | Values | Current definitions |
|------|--------|---------------------|
| `InvoiceStatus` | `draft, sent, partially_paid, overdue, paid, void` | `apps/api/src/db/schema/invoices.ts:9-11` (pgEnum) · `apps/api/src/services/invoiceTypes.ts:1-2` (TS union) · `packages/shared/src/validators/invoices.ts:70` (Zod) · web + portal literals |
| `PaymentMethod` | `cash, check, bank_transfer, card, other` | `invoices.ts:15-17` · `invoiceTypes.ts:5-6` · `validators/invoices.ts:57` · web + portal literals |
| `InvoiceLineSourceType` | `time_entry, part, catalog, bundle, manual, contract` | `invoices.ts:12-14` · `invoiceTypes.ts:3-4` · web/portal display maps |

Drift here is a real hazard: a status added to the pgEnum but not the Zod filter, or a method label hard-typed in the portal, produces 400s or mislabeled rows that no test catches.

**Out of scope (YAGNI):** the quote (`quotes.ts:11-16`), contract (`contracts.ts:8-16`), and catalog (`catalog.ts:9-11`) enums. They belong to separate domains and are not duplicated *within* themselves — do not haul them in.

## Architecture

### Canonical source

New file `packages/shared/src/types/billing-enums.ts`:

```ts
export const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void'] as const;
export const PAYMENT_METHODS = ['cash', 'check', 'bank_transfer', 'card', 'other'] as const;
export const INVOICE_LINE_SOURCE_TYPES = ['time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract'] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type InvoiceLineSourceType = (typeof INVOICE_LINE_SOURCE_TYPES)[number];
```

Re-export from the `packages/shared` barrel (`packages/shared/src/index.ts` / `types` index) so consumers import from `@breeze/shared`.

### Consumers rewired

1. **Drizzle schema** (`apps/api/src/db/schema/invoices.ts`): `pgEnum('invoice_status', [...INVOICE_STATUSES])`, `pgEnum('payment_method', [...PAYMENT_METHODS])`, `pgEnum('invoice_line_source_type', [...INVOICE_LINE_SOURCE_TYPES])`. **The pgEnum name, values, and order are unchanged** — drizzle generates the same DDL, so there is no schema drift and no migration. The spread (`[...]`) converts the `readonly` tuple to the mutable `[string, ...string[]]` that `pgEnum` expects.
2. **Service types** (`apps/api/src/services/invoiceTypes.ts`): delete the local unions; re-export the shared types (`export type { InvoiceStatus, PaymentMethod, InvoiceLineSourceType } from '@breeze/shared';`). Keep the file as the service-facing type surface so existing imports don't churn.
3. **Zod validators** (`packages/shared/src/validators/invoices.ts:57,70`): `z.enum([...PAYMENT_METHODS])` and `z.enum([...INVOICE_STATUSES])`. Same-package import (relative or barrel).
4. **Web** (`apps/web`): status-badge color/label maps, payment-method `<select>` options, list filters → import the tuples; delete hand-typed literals. Iterate the tuple to render options so a future value appears automatically.
5. **Portal** (`apps/portal`): customer-facing status labels / display maps → same treatment.

### Guardrail test

A unit test (in `packages/shared` or `apps/api`) asserting the Drizzle pgEnum's `.enumValues` deep-equals the shared tuple **including order**, for all three enums. This converts silent Drizzle↔shared drift into a CI failure. Order matters because Postgres enum ordering is positional and `db:check-drift` is order-sensitive.

## UX cleanup

1. **#1418 is already resolved (verify-only).** The originally-listed "stale Draft header after issue" bug (#1418) was **closed 2026-06-17** — `InvoiceEditor.tsx:235` already calls `refresh()` in the issue handler's `finally`, refetching and re-rendering. No fix is needed; the sweep below should simply confirm it does not reproduce.
2. **Timeboxed papercut sweep.** A single bounded Playwright pass over the billing UI (invoices list, invoice detail/workspace, settings) looking for cheap, obvious papercuts: stale headers after other actions, broken optimistic refresh, label drift, mislabeled enum values. **Fold in only obvious + cheap fixes** (single-component, no schema/API change). **File a GitHub issue** for anything larger so the sweep cannot balloon F1's scope. Record the sweep outcome (what was fixed vs. filed) in the PR description.

## Testing

- **Drift gate (load-bearing):** `pnpm db:check-drift` must report no drift after the pgEnum rewire. This is the primary proof the refactor is behavior-neutral.
- **Guardrail unit test:** pgEnum values === shared tuple (order-sensitive) for all three enums.
- **Type check:** `pnpm typecheck` across api / web / portal / shared — `@breeze/shared` has no build step, so consumers compile against its TS source directly; a broken re-export fails here.
- **Existing billing tests** stay green (the values/order are identical, so no behavioral test should change).
- **#1418:** component test for post-issue header refresh.
- **Validator negatives** for the rewired Zod enums are *not* added here — they belong to F2's test backlog; F1 only proves the enums still validate the same set.

## Known traps (from prior billing work)

- `@breeze/shared` has **no build script** — typecheck-only; apps import the TS source. A bad barrel export surfaces as a consumer type error, not a shared-package build error. (`migration-tooling-db-migrate-noop`)
- `readonly` `as const` tuples must be **spread** into `pgEnum(...)` and `z.enum(...)` or TS rejects them.
- **Do not reorder** enum values — reordering changes the Postgres enum and breaks drift/DB.
- **Do not** touch quote/contract/catalog enums.
- Watch the parallel-suite flakiness (`api_test_suite_parallel_flakiness`) — verify via single-fork on affected files, trust CI for the full run.

## Definition of done

- Three `as const` tuples in `packages/shared`, re-exported from the barrel.
- Drizzle, service types, Zod, web, and portal all derive from them; no hand-typed duplicates of these three enums remain (grep-clean).
- Guardrail test green; `db:check-drift` clean; typecheck green across all apps; existing billing tests green.
- #1418 confirmed non-reproducing (already closed); papercut sweep done with fixes folded in or issues filed, summarized in the PR.

## Next step

Invoke writing-plans to produce the F1 implementation plan.
