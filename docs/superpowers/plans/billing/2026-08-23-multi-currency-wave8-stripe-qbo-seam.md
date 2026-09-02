---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 8 — Stripe §10 Freeze + QBO Accounting Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor** line; a `codex` task is written to be self-contained (codex sees only that task's text — every path, signature, fixture shape and command it needs is inside the task).

**Goal:** Close spec §10 (Stripe) by **proving it is already complete and pinning that fact with a static contract test** — waves 5 and 6 shipped every §10 bullet — and then deliver spec §11 (accounting seam) plus bug **B8**: a fully typed `AccountingProvider` interface whose money-bearing payloads carry `currencyCode`, connect-time capture of the QBO realm home currency from `Preferences.CurrencyPrefs.HomeCurrency` into the existing-but-dead `accounting_connections.home_currency`, and the documented-but-never-built fail-closed invoice-push currency guard plus the payment pull-back conversion contract, both unit-tested now against the typed interface. The guard ships as a **primitive**: no push entrypoint exists to wire it into, so its enforcement (a single guarded coordinator plus a static call-site gate) is a recorded Phase-C obligation rather than a wave-8 claim.

**Architecture:** Four layers, strictly ordered.
1. **Stripe freeze (Task 1).** §10 is merged. The only wave-8 Stripe deliverable is a static contract test that pins the two production `checkout.sessions.create` implementations (`apps/api/src/services/invoiceCheckout.ts:105`, `apps/api/src/routes/portal/invoices.ts:264`) to `mapStripeCheckoutError`, so a third unguarded call site cannot appear. **No Stripe source file is edited in this wave.**
2. **Typed seam (Tasks 2-3).** `apps/api/src/services/accounting/types.ts` gains real payload DTOs (`AccountingCustomerPayload`, `AccountingItemPayload`, `AccountingInvoiceLinePayload`, `AccountingInvoiceLineMapping`, `AccountingInvoicePayload`, `AccountingVoidInvoicePayload`, `AccountingEntityMapping`) and a `fetchHomeCurrency` method; the four varargs methods get real parameter lists. A new pure module `apps/api/src/services/accounting/accountingCurrency.ts` carries the push **guard primitive** and the payment pull-back normalizer, whose parameter types are *derived* from `Parameters<AccountingProvider['pushInvoice']>` (not re-declared) so they can never drift from the interface. **Wave 8 ships the primitive, not its enforcement** — nothing calls it, because no push entrypoint exists; the enforcement obligation (a single guarded coordinator plus a static call-site gate) is written into the deferred Phase-C contract in Task 3.
3. **Home-currency capture (Tasks 4-7).** `quickbooksProvider.fetchHomeCurrency` reads `Preferences.CurrencyPrefs.HomeCurrency.value` from `/v3/company/{realmId}/preferences` (never CompanyInfo), a narrow realm-generation compare-and-set writer `updateHomeCurrency` persists it under a single-row `FOR UPDATE`, a real-DB suite proves partner-axis RLS and the stale-write rejection, and the OAuth callback wires capture in as a **non-fatal** post-persist step.
4. **Verification + PR (Task 8).**

**Tech Stack:** Hono + Drizzle ORM, Vitest (Drizzle-mock unit + real-DB integration under `vitest.integration.config.ts`), hand-written SQL migrations (**none in this wave — see Global Constraints**), Intuit QuickBooks Online v3 REST API (minorversion 70).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3780, branch `feature/3772-multi-currency/wave-3780`, worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8` (cut from `main` at `8066aedb0`, after waves 1-6 merged). Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §10 (Stripe), §11 (Accounting seam), §12 (non-goals), §13 wave 8, §14 (testing). Format precedent: `docs/superpowers/plans/billing/2026-08-22-multi-currency-wave6-org-currency-selection.md`.

## Global Constraints

- **Owner-fixed decisions, never relitigated:** no conversion on billing DOCUMENTS ever (FX is reporting-only and never persisted onto a document); the snapshots rule (a stamped currency is never reinterpreted from a mutable setting); per-currency price books with explicit gaps; ticket rate defaults are match-or-skip; **no bulk restamp of history**; VAT out of scope.
- **§10 IS DONE. DO NOT RE-IMPLEMENT IT.** Verified in this worktree at `8066aedb0`: account-currency cache columns (`apps/api/migrations/2026-08-31-b-stripe-account-currency-cache.sql`), capture-on-key-save (`apps/api/src/services/partnerStripe.ts:99`, `:145`, `:198-216`), TTL re-check (`partnerStripe.ts:81`, `:90`, `:439`), explicit refresh action + route (`partnerStripe.ts:317`; `apps/api/src/routes/stripeConnect/index.ts:101-137`), warn-don't-block mismatch (`packages/shared/src/utils/currency.ts:217`; consumed at `apps/api/src/services/invoiceService.ts:623-630`, `apps/api/src/routes/quotes/quotes.ts:154-162`, `apps/api/src/services/invoiceCheckout.ts:168-174`), friendly checkout error mapping (`apps/api/src/services/stripeCheckoutErrors.ts:15`), reconnect-required/unknown cache states (`partnerStripe.ts:401-478`), bootstrap + daily refresh job (`apps/api/src/jobs/stripeAccountCacheRefresh.ts`, registered `apps/api/src/index.ts:1440`, shutdown `:1676`). **No Stripe metadata change ships in this wave** — §10 contains no metadata requirement and the wave-8 brief does not list one.
- **NO MIGRATION.** `accounting_connections.home_currency` already exists: Drizzle `apps/api/src/db/schema/accounting.ts:15`, SQL `apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql:11` (`home_currency char(3)`, nullable, no FK). Nothing writes it today — that is B8's "dead column", and the fix is a writer, not DDL. Do **not** add `home_currency_refreshed_at`: §11 asks for connect-time capture, not a QBO TTL lifecycle, and the guard already fails closed on NULL. If a future task is nonetheless added, the filename is `apps/api/migrations/2026-09-04-<slug>.sql` (verify with `ls apps/api/migrations | sort | tail -4` → currently ends `2026-09-03-ai-agents-permissions.sql`), idempotent, no inner `BEGIN;`/`COMMIT;`.
- **NO FK from `home_currency` to `supported_currencies`, and no `currencyCodeSchema` validation of it.** It is a cache of an external fact, exactly like the Stripe account-currency columns (`apps/api/migrations/2026-08-31-b-stripe-account-currency-cache.sql` header: "A cache of an external fact — deliberately NOT FK'd to supported_currencies"). Breeze's curated list is 34 codes (`packages/shared/src/utils/currency.ts:23`) and deliberately excludes the 3-decimal set; a QBO realm may legitimately report a code outside it. Such a realm must stay **connectable** and its invoice push must **fail closed** — validation at connect time would break OAuth for a tenant Breeze simply cannot sell into. The only shape rule is `/^[A-Z]{3}$/` after `trim().toUpperCase()`.
- **NO tenancy registration work.** `accounting_connections` is shape 3 (partner-axis): partner FK `apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql:3`, RLS enabled + FORCED `:30-31`, four partner policies `:33-45`, already listed in `PARTNER_TENANT_TABLES` at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:195`. It has **no `org_id` and no `device_id`**, so it is correctly absent from `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`) and both device lists (`apps/api/src/routes/devices/core.ts`). CLAUDE.md's "a new COLUMN fires the export-policy contract" rule applies only to tables in `CORE_ORG_CASCADE_DELETE_ORDER`; this table is not one, and this wave adds no column anyway. Verify with `grep -rn accounting_connections apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/core.ts` → must stay **zero hits**.
- **Fail closed on unknown, unlike Stripe.** §10's Stripe posture is warn-don't-block because Stripe still presents the document's own currency correctly. A QBO push into a realm whose home currency is unknown or different silently mis-books a ledger, so the accounting guard **throws** on both mismatch and NULL. This divergence is deliberate; do not "harmonize" it.
- **Nothing is wired to a push or payment entrypoint in this wave**, because none exists: `pushInvoice`/`voidInvoice` are `NotImplemented: Phase C` and `reconcileChanges` is `NotImplemented: Phase D` (`apps/api/src/services/accounting/quickbooksProvider.ts:158-168`), and the `accounting_entity_mappings` table needed to resolve a remote invoice id is not in the repo. The guard and the normalizer ship as **pure, unit-tested functions with an explicit Phase-C/Phase-D integration contract recorded in this plan**, exactly as the spec §11 bullet requires ("the guard's unit contract is written now against the typed interface; its integration test lands with the push entrypoint").
- **Foreign-currency QBO push (`CurrencyRef` + `ExchangeRate`) stays DEFERRED beyond this program** (§11, §15). No code in this wave may add either field, an FX lookup, or a conversion.
- **Lock order:** the wave-6 global partial orders are untouched (`organizations -> invoices -> invoice_lines -> contracts -> contract_lines -> time_entries -> ticket_parts`; `organizations -> tickets -> time_entries -> ticket_parts`; `organizations -> contracts / catalog_items`). Wave-8 adds **exactly one** row lock, and it joins none of those orders: `updateHomeCurrency` (Task 5) opens a short transaction and takes `SELECT … FOR UPDATE` on the single `accounting_connections` row it is about to write, then releases at commit. `accounting_connections` is a leaf — no wave-8 code holds any other lock while it is held, no network call happens inside that transaction (the QBO fetch completes first, outside any DB context), and no helper added here may take an organization lock. The guard and the normalizer are pure. Every QBO fetch is wrapped in `runOutsideDbContext` (the #1105 connection-hold class).
- **Test stack for this worktree:** postgres `localhost:5441`, redis `localhost:6391` (already in the repo-root `.env.test`, loaded by `apps/api/vitest.integration.config.ts:5`). Integration invocation used throughout this plan:
  `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>`
- Unit tests follow the Drizzle mock-queue conventions in the `breeze-testing` skill. `pnpm test` green is not CI green — the integration config is a separate runner.
- Commit after every task. Every commit message ends with `(#3780)`.
- Line numbers below are pre-change references read from this worktree at `8066aedb0`; re-grep before editing if an earlier task has already moved them.

---

### Task 1: Freeze Stripe §10 with a static call-site contract test

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. Spec §10 (Stripe) is **already fully implemented** by earlier waves; this task adds **no Stripe behaviour** and must not edit any Stripe source file. Its only job is to pin the invariant that every production Stripe Checkout session creation maps its currency failures through `mapStripeCheckoutError`, so a future third call site cannot silently ship the raw Stripe message to a customer. There are exactly two production implementations today:

- `apps/api/src/services/invoiceCheckout.ts:105` — `session = await runOutsideDbContext(() => stripe.checkout.sessions.create({` ; maps at `:145` (`const mapped = mapStripeCheckoutError(err, inv.currencyCode);`)
- `apps/api/src/routes/portal/invoices.ts:264` — same shape; imports at `:25`, maps at `:308`

Other files mention the string only inside comments (`apps/api/src/middleware/selfManagedDbContextRoutes.ts:36`, `apps/api/src/routes/invoicesPublic.ts:210`, `apps/api/src/routes/portal/quotes.ts:319`, `apps/api/src/services/quotePay.ts:25`, `apps/api/src/services/stripeCheckoutErrors.ts:3`), and `apps/api/src/services/quotePay.ts:42` delegates to `createInvoicePayLink` so it inherits the mapping. The test must therefore ignore comment-only occurrences.

**Files:**
- Create: `apps/api/src/services/stripeCheckoutCallSites.test.ts`

**Interfaces:**
- Produces: no exported runtime API — a static AST contract test (same spirit as `apps/api/src/config/composeBindMounts.test.ts`, which parses tracked files and fails on a contract violation, but parsing TypeScript rather than matching strings).
- Consumes: `node:fs`, `node:path`, `typescript` (already a devDependency: `apps/api/package.json:109`).

- [ ] **Step 1: Write the failing test.** The check must count **call expressions**, not files, and must prove each call is *enclosed* by an error path that calls the mapper — a third call added to an existing file, or a mapper that is only imported and never called, must both fail. Use the TypeScript compiler API (`typescript` is already a devDependency: `apps/api/package.json:109`). Create `apps/api/src/services/stripeCheckoutCallSites.test.ts` with exactly this content:
```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Multi-currency §10 freeze (#3780).
 *
 * Spec §10 requires that a Stripe Checkout currency failure reaches the customer
 * as a friendly, actionable message — never the raw Stripe error. That is
 * implemented by `mapStripeCheckoutError` (services/stripeCheckoutErrors.ts) and
 * wired into BOTH production `checkout.sessions.create` call sites. This test
 * pins the invariant: a THIRD call site that forgets the mapping fails here
 * instead of shipping a raw Stripe string to a payer.
 *
 * It parses the AST rather than grepping, because both cheap textual checks are
 * false-negative prone: counting FILES misses a second call added to a file that
 * already has one, and asserting the mapper's NAME appears in the file is
 * satisfied by an unused import.
 *
 * Wave 8 adds no Stripe behaviour; §10 was completed in waves 5-6.
 */
const SRC_ROOT = join(__dirname, '..');

/** Source-relative path -> the exact number of permitted call expressions. */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'services/invoiceCheckout.ts': 1,
  'routes/portal/invoices.ts': 1,
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** True when SOME enclosing try statement's catch clause CALLS mapStripeCheckoutError. */
function isGuardedByMapper(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!ts.isTryStatement(cur) || !cur.catchClause) continue;
    let callsMapper = false;
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'mapStripeCheckoutError') callsMapper = true;
      ts.forEachChild(n, walk);
    };
    walk(cur.catchClause);
    if (callsMapper) return true;
  }
  return false;
}

interface CheckoutCall {
  file: string;
  line: number;
  guarded: boolean;
}

function findCheckoutCalls(absPath: string): CheckoutCall[] {
  const source = readFileSync(absPath, 'utf8');
  // Cheap pre-filter; the AST below is the authority.
  if (!source.includes('checkout.sessions.create')) return [];
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const rel = relative(SRC_ROOT, absPath).split('\\').join('/');
  const calls: CheckoutCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf).endsWith('checkout.sessions.create')) {
      calls.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        guarded: isGuardedByMapper(node, sf),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

describe('Stripe checkout call-site contract (multi-currency §10)', () => {
  const calls = listSourceFiles(SRC_ROOT).flatMap(findCheckoutCalls);

  it('has exactly the known production checkout.sessions.create CALLS, counted per call', () => {
    const counts: Record<string, number> = {};
    for (const call of calls) counts[call.file] = (counts[call.file] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_CALL_SITES);
    expect(calls).toHaveLength(
      Object.values(EXPECTED_CALL_SITES).reduce((sum, n) => sum + n, 0),
    );
  });

  it('encloses every call in an error path that CALLS mapStripeCheckoutError', () => {
    const unguarded = calls.filter((call) => !call.guarded).map((call) => `${call.file}:${call.line}`);
    expect(unguarded, 'checkout.sessions.create without a catch that calls mapStripeCheckoutError').toEqual([]);
  });

  it('keeps the customer-safe currency message on the shared mapper', async () => {
    const mod = await import('./stripeCheckoutErrors');
    expect(typeof mod.mapStripeCheckoutError).toBe('function');
    expect(mod.CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE).toBeTruthy();
  });
});
```
- [ ] **Step 2: Run it.** `pnpm --filter @breeze/api exec vitest run src/services/stripeCheckoutCallSites.test.ts` → all three cases PASS on the current tree (this is a freeze, not a red-first feature). Both production calls are already inside a `try` whose `catch` calls the mapper (`apps/api/src/services/invoiceCheckout.ts:103-150`, `apps/api/src/routes/portal/invoices.ts:262-314`), so the enclosure case is green without touching a Stripe file.
- [ ] **Step 3: Prove it is not vacuous, on BOTH false-negative paths.** Each mutation is temporary; restore with `git checkout -- <file>` and re-run Step 2 to green before moving on.
  1. **Unused-import path.** In `apps/api/src/routes/portal/invoices.ts:308`, replace `const mapped = mapStripeCheckoutError(err, inv.currencyCode);` with `const mapped = null;` — leaving the import in place. Re-run: the *enclosure* case must FAIL naming `routes/portal/invoices.ts`. (A file-level string search would have passed here — that is the point.)
  2. **Second-call-in-an-existing-file path.** Add a real second call OUTSIDE any `try`: immediately after the restored `try`/`catch` block in `apps/api/src/services/invoiceCheckout.ts`, insert `await stripe.checkout.sessions.create({ mode: 'payment' } as never);`. Re-run: the *count* case must FAIL (`services/invoiceCheckout.ts: 2`, not the expected `1`) **and** the enclosure case must FAIL. (A file-counting test would have passed here — the second point.)
- [ ] **Step 4: Confirm no Stripe source changed.** `git status --porcelain` must list only `apps/api/src/services/stripeCheckoutCallSites.test.ts`.
- [ ] **Step 5: Run the Stripe suites unchanged** to record the §10 baseline:
```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/partnerStripe.test.ts \
  src/services/stripeCheckoutErrors.test.ts \
  src/services/invoiceCheckout.test.ts \
  src/routes/stripeConnect/index.test.ts \
  src/routes/portal/invoices.test.ts \
  src/jobs/stripeAccountCacheRefresh.test.ts
```
All PASS. Record the file/test counts in the commit body.
- [ ] **Step 6: Commit** — `test(api): pin Stripe checkout call sites to the friendly currency-error mapper (#3780)`.

---

### Task 2: Type the `AccountingProvider` interface (B8)

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. Bug **B8**: four methods on the accounting provider contract are untyped varargs (`apps/api/src/services/accounting/types.ts:61-64`), so nothing forces an accounting payload to carry the document's currency. Spec §11: "Type the `AccountingProvider` interface now — `pushInvoice`/`upsertCustomer`/`upsertItem`/`voidInvoice` get real payload types including `currencyCode` (they are untyped varargs today; nothing shipped, so no migration cost)."

**There are ZERO production callers of those four methods.** The only implementations are the `NotImplemented` stubs in `apps/api/src/services/accounting/quickbooksProvider.ts:150-164`, and the only other reference is the registry type at `apps/api/src/services/accounting/providerRegistry.ts:4-13`. (Every other repo hit for `voidInvoice` is `invoiceService.voidInvoice` — an unrelated function.) So this change has no production blast radius.

Money values stay **major-unit decimal strings**, matching the storage non-goal in spec §12 ("Storage stays `numeric` major units (no integer-cents migration)"). Quantity is a string too, so no binary float enters at the provider boundary. Arity follows the Phase-A design doc's interface sketch (`docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md:109-121`, the four methods at `:116-119`): `upsertCustomer(conn, customer, mapping)`, `upsertItem(conn, item, mapping)`, `pushInvoice(conn, invoice, lineMappings)` — with **one deliberate extension**: `voidInvoice` becomes `voidInvoice(conn, invoice, mapping)`. The Phase-A sketch has `voidInvoice(conn, mapping)`, but multi-currency §11 requires **all four** methods to receive real payloads carrying `currencyCode`, and a void that carries no currency sits outside the typed contract — a realm whose home currency changed after the push would void into a mismatched ledger with nothing in the type system to catch it. Nothing calls the method (zero production callers, below), so the extension costs nothing now and is unavailable later.

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts` (add DTOs — including `AccountingVoidInvoicePayload` — after `RemoteRef` at `:37-41`; document `ChangeSet.payments[].amountMinor` at `:43-51`; replace the interface body at `:54-67`)
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts` (import list `:4-12`; stub signatures `:150-164`)
- Create: `apps/api/src/services/accounting/types.test.ts`

**Interfaces:**
- Produces: `AccountingEntityMapping`, `AccountingCustomerPayload`, `AccountingItemPayload`, `AccountingInvoiceLinePayload`, `AccountingInvoiceLineMapping`, `AccountingInvoicePayload`, `AccountingVoidInvoicePayload`, and the retyped `AccountingProvider` (including a new `fetchHomeCurrency(conn: AccountingConnection): Promise<string | null>` — implemented in a later task; the stub added here throws).
- Consumes: existing `AccountingConnection` (`apps/api/src/services/accounting/accountingConnectionService.ts:10-28`), `RemoteAddress` (`types.ts:19`), `RemoteRef` (`types.ts:37`).

- [ ] **Step 1: Write the failing type test.** Create `apps/api/src/services/accounting/types.test.ts`:
```ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  AccountingCustomerPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingItemPayload,
  AccountingProvider,
  AccountingVoidInvoicePayload,
} from './types';
import type { AccountingConnection } from './accountingConnectionService';

describe('AccountingProvider is fully typed (B8, multi-currency §11)', () => {
  it('pushInvoice takes a connection, a currency-bearing invoice payload and line mappings', () => {
    expectTypeOf<Parameters<AccountingProvider['pushInvoice']>>().toEqualTypeOf<
      [AccountingConnection, AccountingInvoicePayload, readonly AccountingInvoiceLineMapping[]]
    >();
    expectTypeOf<AccountingInvoicePayload['currencyCode']>().toEqualTypeOf<string>();
  });

  it('upsertCustomer and upsertItem carry currency and a nullable remote mapping', () => {
    expectTypeOf<Parameters<AccountingProvider['upsertCustomer']>>().toEqualTypeOf<
      [AccountingConnection, AccountingCustomerPayload, AccountingEntityMapping | null]
    >();
    expectTypeOf<Parameters<AccountingProvider['upsertItem']>>().toEqualTypeOf<
      [AccountingConnection, AccountingItemPayload, AccountingEntityMapping | null]
    >();
    expectTypeOf<AccountingCustomerPayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingItemPayload['currencyCode']>().toEqualTypeOf<string>();
  });

  it('voidInvoice takes a connection, a currency-bearing void payload and a required mapping', () => {
    expectTypeOf<Parameters<AccountingProvider['voidInvoice']>>().toEqualTypeOf<
      [AccountingConnection, AccountingVoidInvoicePayload, AccountingEntityMapping]
    >();
    expectTypeOf<AccountingVoidInvoicePayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingVoidInvoicePayload['invoiceId']>().toEqualTypeOf<string>();
  });

  it('exposes a provider-neutral home-currency fetch for the connect flow', () => {
    expectTypeOf<Parameters<AccountingProvider['fetchHomeCurrency']>>().toEqualTypeOf<[AccountingConnection]>();
    expectTypeOf<ReturnType<AccountingProvider['fetchHomeCurrency']>>().toEqualTypeOf<Promise<string | null>>();
  });

  it('keeps all money as major-unit decimal strings (spec §12: no integer-cents storage)', () => {
    expectTypeOf<AccountingInvoicePayload['total']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingItemPayload['unitPrice']>().toEqualTypeOf<string>();
  });
});
```
- [ ] **Step 2: Run it and watch it fail.** `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p apps/api/tsconfig.json` → fails (the DTOs do not exist and the methods are varargs). Note: `vitest run --typecheck` does NOT collect `*.test.ts` (its default include is `**/*.test-d.ts`), so `tsc` — which CI runs as the `typecheck` job — is what actually enforces this file.
- [ ] **Step 3: Add the DTOs.** In `apps/api/src/services/accounting/types.ts`, insert immediately after the `RemoteRef` interface (currently ending at `:41`):
```ts
/** A previously-synced remote entity, for update-vs-create decisions. */
export interface AccountingEntityMapping {
  remoteEntityId: string;
  remoteSyncToken: string | null;
}

export interface AccountingCustomerPayload {
  organizationId: string;
  displayName: string;
  billingEmail: string | null;
  taxId: string | null;
  billAddr?: RemoteAddress;
  shipAddr?: RemoteAddress;
  /** The organization's stamped billing currency (ISO 4217, uppercase). */
  currencyCode: string;
}

export interface AccountingItemPayload {
  catalogItemId: string;
  name: string;
  description: string | null;
  /** Major-unit decimal string — storage stays numeric major units (spec §12). */
  unitPrice: string;
  currencyCode: string;
  incomeAccountRef?: string;
}

export interface AccountingInvoiceLinePayload {
  invoiceLineId: string;
  description: string;
  /** Decimal string; never a float, so no binary rounding enters at this seam. */
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable: boolean;
}

export interface AccountingInvoiceLineMapping {
  invoiceLineId: string;
  remoteItemRef: RemoteRef | null;
}

export interface AccountingInvoicePayload {
  invoiceId: string;
  docNumber: string | null;
  /** ISO date (YYYY-MM-DD). */
  txnDate: string;
  dueDate: string | null;
  customerRef: RemoteRef;
  /** The invoice's STAMPED currency. Never re-derived from the org (snapshots rule). */
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  lines: readonly AccountingInvoiceLinePayload[];
}

/**
 * A void carries a payload too, so no accounting method sits outside the typed
 * currency contract (multi-currency §11). Deliberately wider arity than the
 * Phase-A sketch, which had `voidInvoice(conn, mapping)`.
 */
export interface AccountingVoidInvoicePayload {
  invoiceId: string;
  docNumber: string | null;
  /** The invoice's STAMPED currency, carried so the guard applies on the way out too. */
  currencyCode: string;
}
```
- [ ] **Step 4: Document the minor-unit contract on `ChangeSet`.** In the same file, replace the `payments` array element type inside `ChangeSet` (`:45-51`) with:
```ts
  payments: Array<{
    remoteInvoiceId: string;
    remotePaymentId: string;
    /**
     * Provider-reported INTEGER MINOR UNITS. Before applying, assert that
     * `currency` equals the target invoice's stamped currency and convert
     * exactly once with `fromMinorUnits` — see
     * services/accounting/accountingCurrency.ts (multi-currency §11).
     */
    amountMinor: number;
    /** Provider-reported ISO 4217 code for this payment. */
    currency: string;
    txnDate: string;
  }>;
```
- [ ] **Step 5: Retype the interface.** Replace the four varargs lines (`types.ts:61-64`) and add the new method, so the interface body reads:
```ts
export interface AccountingProvider {
  readonly provider: AccountingProviderId;
  buildAuthUrl(state: string): string;
  exchangeCode(code: string, realmId: string): Promise<ConnectionTokens>;
  refresh(refreshToken: string): Promise<ConnectionTokens>;
  /**
   * The realm/organization's home currency, normalized to an uppercase
   * three-letter code, or null when the provider does not report one.
   * NOT restricted to Breeze's curated supported-currency list — it is a cache
   * of an external fact (multi-currency §11).
   */
  fetchHomeCurrency(conn: AccountingConnection): Promise<string | null>;
  listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteCustomer[]>;
  listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteEntity[]>;
  upsertCustomer(
    conn: AccountingConnection,
    customer: AccountingCustomerPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef>;
  upsertItem(
    conn: AccountingConnection,
    item: AccountingItemPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef>;
  pushInvoice(
    conn: AccountingConnection,
    invoice: AccountingInvoicePayload,
    lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<RemoteRef>;
  voidInvoice(
    conn: AccountingConnection,
    invoice: AccountingVoidInvoicePayload,
    mapping: AccountingEntityMapping,
  ): Promise<void>;
  reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>;
  verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean;
}
```
- [ ] **Step 6: Update the QuickBooks stubs.** In `apps/api/src/services/accounting/quickbooksProvider.ts`, extend the type import block at `:4-12` to include the new DTOs:
```ts
import type {
  AccountingCustomerPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingItemPayload,
  AccountingProvider,
  AccountingVoidInvoicePayload,
  ChangeSet,
  ConnectionTokens,
  RemoteAddress,
  RemoteCustomer,
  RemoteEntity,
  RemoteRef,
} from './types';
```
and replace the four stub bodies at `:150-164` with typed parameter lists (the thrown errors stay identical — Phase B/C are still unbuilt), plus a temporary `fetchHomeCurrency` stub that Task 4 replaces:
```ts
  async fetchHomeCurrency(_conn: AccountingConnection): Promise<string | null> {
    throw new Error('NotImplemented: fetchHomeCurrency');
  }

  async upsertCustomer(
    _conn: AccountingConnection,
    _customer: AccountingCustomerPayload,
    _mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase B');
  }

  async upsertItem(
    _conn: AccountingConnection,
    _item: AccountingItemPayload,
    _mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase B');
  }

  async pushInvoice(
    _conn: AccountingConnection,
    _invoice: AccountingInvoicePayload,
    _lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase C');
  }

  async voidInvoice(
    _conn: AccountingConnection,
    _invoice: AccountingVoidInvoicePayload,
    _mapping: AccountingEntityMapping,
  ): Promise<void> {
    throw new Error('NotImplemented: Phase C');
  }
```
- [ ] **Step 7: Run the type test and the accounting unit suites.**
```bash
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p apps/api/tsconfig.json  # types.test.ts is enforced by tsc (CI typecheck job), NOT by vitest --typecheck
pnpm --filter @breeze/api exec vitest run \
  src/services/accounting/providerRegistry.test.ts \
  src/services/accounting/quickbooksProvider.test.ts \
  src/services/accounting/accountingTokens.test.ts \
  src/services/accounting/quickbooksCustomerImport.test.ts
```
All PASS. If `quickbooksCustomerImport.test.ts:48` or `accountingTokens.test.ts:21` now fail to compile because their partial provider stubs no longer satisfy the widened interface, fix the TEST by casting the factory return (`as unknown as AccountingProvider`) — never by loosening the interface.
- [ ] **Step 8: Typecheck the app.** `pnpm --filter @breeze/api build` → clean.
- [ ] **Step 9: Commit** — `feat(api): type the AccountingProvider payloads with currencyCode (B8) (#3780)`.

---

### Task 3: The accounting currency contract — push guard PRIMITIVE + payment pull-back

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. **Task 2 must be complete** — this task consumes the shapes it added to `apps/api/src/services/accounting/types.ts` — but it imports `AccountingProvider` and `ChangeSet` **only**, deriving the invoice payload type from `Parameters<AccountingProvider['pushInvoice']>[1]` instead of importing `AccountingInvoicePayload` by name.

**What this task does and does not deliver.** It ships the guard as a *pure primitive with a unit contract*, exactly as spec §11 scopes it ("the guard's unit contract is written now against the typed interface; its integration test lands with the push entrypoint"). It does **not** make the guard unbypassable, because there is nothing to bypass: the only `pushInvoice` is `NotImplemented: Phase C` (`apps/api/src/services/accounting/quickbooksProvider.ts:158`) and no caller exists. Enforcement is a Phase-C obligation, recorded verbatim in the deferred contract in Step 6: Phase C must expose **one guarded coordinator** (`pushInvoiceToAccounting`) as the sole sanctioned way to reach the transport method, add a static call-site gate proving no other module calls `provider.pushInvoice`/`voidInvoice` directly (the Task-1 AST technique), and land the integration test. Do not describe this wave as "the guard is enforced" in the PR body — it is "the guard exists, is typed to the interface, and Phase C is contractually blocked from shipping without wiring it".

Two spec §11 requirements land here, both as **pure functions with no DB and no network**:

1. *"Implement the documented-but-never-built guard: invoice push (when Phase C ships) hard-blocks with a clear error when `invoice.currencyCode !== connection.homeCurrency`. The guard's unit contract is written now against the typed interface; its integration test lands with the push entrypoint."*
2. *"Payment pull-back (`ChangeSet.payments[]` — minor units + own currency) must convert via `fromMinorUnits` and assert currency equality with the invoice before applying."*

Fail-closed rules that must not be softened: a **null/blank** `homeCurrency` throws (unknown is NOT a match — a push into a realm of unknown currency mis-books a ledger); a currency **mismatch** throws with no conversion offered (foreign-currency QBO push via `CurrencyRef`/`ExchangeRate` is deferred beyond this program); cross-currency payments are an explicit non-goal (spec §12: "a payment always matches its invoice's currency").

`fromMinorUnits` is exported from `@breeze/shared` (implementation `packages/shared/src/utils/currency.ts:72`): it returns a **fixed-2 major-unit string**, and for a zero-decimal currency it does NOT divide (`1234 JPY → "1234.00"`, `1234 USD → "12.34"`). It throws on a non-finite input.

Error-class shape follows the existing local precedent `QbImportError` (`apps/api/src/services/accounting/quickbooksCustomerImport.ts:40-49`): literal-narrowed `code` + `status` so a future route needs no `as` cast.

**Files:**
- Create: `apps/api/src/services/accounting/accountingCurrency.ts`
- Create: `apps/api/src/services/accounting/accountingCurrency.test.ts`

**Interfaces:**
- Produces:
```ts
export type AccountingCurrencyContractErrorCode =
  | 'ACCOUNTING_HOME_CURRENCY_UNKNOWN'
  | 'ACCOUNTING_INVOICE_CURRENCY_MISMATCH'
  | 'ACCOUNTING_PAYMENT_CURRENCY_MISMATCH'
  | 'ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID';
export class AccountingCurrencyContractError extends Error { readonly status: 409 | 502; readonly code: AccountingCurrencyContractErrorCode }
/** Derived from the interface, never re-declared — the guard cannot drift from what pushInvoice receives. */
type AccountingPushInvoicePayload = Parameters<AccountingProvider['pushInvoice']>[1];
export function assertAccountingInvoicePushCurrency(
  connection: Pick<AccountingConnection, 'provider' | 'homeCurrency'>,
  invoice: Pick<AccountingPushInvoicePayload, 'currencyCode'>,
): void;
export interface NormalizedAccountingPayment { invoiceId: string; remoteInvoiceId: string; remotePaymentId: string; amount: string; currencyCode: string; txnDate: string }
export function normalizeAccountingPayment(
  payment: ChangeSet['payments'][number],
  invoice: Pick<AccountingPushInvoicePayload, 'invoiceId' | 'currencyCode'>,
): NormalizedAccountingPayment;
```
- Consumes: `fromMinorUnits` from `@breeze/shared`; `AccountingConnection`; `AccountingProvider`, `ChangeSet` from `./types` (the invoice payload type is derived from `AccountingProvider`, so `AccountingInvoicePayload` is **not** imported by name — that indirection is what stops a future rename or reshape from silently leaving the guard typed against a dead shape).

- [ ] **Step 1: Write the failing tests.** Create `apps/api/src/services/accounting/accountingCurrency.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  AccountingCurrencyContractError,
  assertAccountingInvoicePushCurrency,
  normalizeAccountingPayment,
} from './accountingCurrency';
import type { AccountingProvider, ChangeSet } from './types';
import type { AccountingConnection } from './accountingConnectionService';

// Bind the fixture to the TYPED provider interface so this contract can never
// drift from the shape pushInvoice actually receives (B8, multi-currency §11).
type PushInvoiceArgs = Parameters<AccountingProvider['pushInvoice']>;

function invoicePayload(currencyCode: string): PushInvoiceArgs[1] {
  return {
    invoiceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    docNumber: 'INV-2026-0001',
    txnDate: '2026-09-04',
    dueDate: '2026-10-04',
    customerRef: { id: '42' },
    currencyCode,
    subtotal: '100.00',
    taxTotal: '0.00',
    total: '100.00',
    lines: [],
  };
}

function connection(homeCurrency: string | null): Pick<AccountingConnection, 'provider' | 'homeCurrency'> {
  return { provider: 'quickbooks', homeCurrency };
}

function payment(overrides: Partial<ChangeSet['payments'][number]> = {}): ChangeSet['payments'][number] {
  return {
    remoteInvoiceId: '999',
    remotePaymentId: '1234',
    amountMinor: 1234,
    currency: 'USD',
    txnDate: '2026-09-04',
    ...overrides,
  };
}

describe('assertAccountingInvoicePushCurrency', () => {
  it('passes when the invoice currency equals the realm home currency', () => {
    expect(() => assertAccountingInvoicePushCurrency(connection('USD'), invoicePayload('USD'))).not.toThrow();
  });

  it('normalizes case and whitespace on both sides', () => {
    expect(() => assertAccountingInvoicePushCurrency(connection(' usd '), invoicePayload('Usd'))).not.toThrow();
  });

  it('BLOCKS a currency mismatch and names both codes', () => {
    try {
      assertAccountingInvoicePushCurrency(connection('USD'), invoicePayload('EUR'));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingCurrencyContractError);
      const e = err as AccountingCurrencyContractError;
      expect(e.code).toBe('ACCOUNTING_INVOICE_CURRENCY_MISMATCH');
      expect(e.status).toBe(409);
      expect(e.message).toContain('EUR');
      expect(e.message).toContain('USD');
      // Foreign-currency push (CurrencyRef/ExchangeRate) is deferred beyond this
      // program — the message must not promise it.
      expect(e.message).not.toMatch(/exchange rate|will be converted/i);
    }
  });

  it('FAILS CLOSED when the home currency was never captured', () => {
    for (const unknown of [null, '', '   ']) {
      try {
        assertAccountingInvoicePushCurrency(connection(unknown), invoicePayload('USD'));
        throw new Error('expected a throw');
      } catch (err) {
        const e = err as AccountingCurrencyContractError;
        expect(e.code).toBe('ACCOUNTING_HOME_CURRENCY_UNKNOWN');
        expect(e.status).toBe(409);
        expect(e.message).toMatch(/reconnect/i);
      }
    }
  });
});

describe('normalizeAccountingPayment', () => {
  it('converts two-decimal minor units to a major-unit string', () => {
    const out = normalizeAccountingPayment(payment({ amountMinor: 1234, currency: 'USD' }), {
      invoiceId: 'inv-1',
      currencyCode: 'USD',
    });
    expect(out).toEqual({
      invoiceId: 'inv-1',
      remoteInvoiceId: '999',
      remotePaymentId: '1234',
      amount: '12.34',
      currencyCode: 'USD',
      txnDate: '2026-09-04',
    });
  });

  it('does NOT divide a zero-decimal currency', () => {
    const out = normalizeAccountingPayment(payment({ amountMinor: 1234, currency: 'JPY' }), {
      invoiceId: 'inv-2',
      currencyCode: 'JPY',
    });
    expect(out.amount).toBe('1234.00');
    expect(out.currencyCode).toBe('JPY');
  });

  it('normalizes a lowercase provider code', () => {
    const out = normalizeAccountingPayment(payment({ currency: 'usd' }), { invoiceId: 'inv-3', currencyCode: 'USD' });
    expect(out.currencyCode).toBe('USD');
  });

  it('asserts currency equality BEFORE converting (cross-currency payments are a non-goal)', () => {
    try {
      normalizeAccountingPayment(payment({ currency: 'USD' }), { invoiceId: 'inv-4', currencyCode: 'EUR' });
      throw new Error('expected a throw');
    } catch (err) {
      const e = err as AccountingCurrencyContractError;
      expect(e.code).toBe('ACCOUNTING_PAYMENT_CURRENCY_MISMATCH');
      expect(e.status).toBe(409);
      expect(e.message).toContain('USD');
      expect(e.message).toContain('EUR');
    }
  });

  it('rejects a non-positive, non-integer, non-finite or unsafe minor amount', () => {
    // 0 is not a payment; a negative amount is a refund/credit memo, which spec
    // §12 puts out of scope — applying one through this path would INCREASE the
    // invoice balance.
    for (const bad of [Number.NaN, 12.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, 0, -1, -1234]) {
      try {
        normalizeAccountingPayment(payment({ amountMinor: bad }), { invoiceId: 'inv-5', currencyCode: 'USD' });
        throw new Error(`expected a throw for ${bad}`);
      } catch (err) {
        const e = err as AccountingCurrencyContractError;
        expect(e.code).toBe('ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID');
        expect(e.status).toBe(502);
      }
    }
  });
});
```
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingCurrency.test.ts` → fails (module does not exist).
- [ ] **Step 3: Implement the module.** Create `apps/api/src/services/accounting/accountingCurrency.ts`:
```ts
import { fromMinorUnits } from '@breeze/shared';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingProvider, ChangeSet } from './types';

/**
 * DERIVED from the provider interface, never re-declared. If Task 2's
 * pushInvoice payload is renamed or reshaped, this file stops compiling instead
 * of quietly guarding a shape nothing sends.
 */
type AccountingPushInvoicePayload = Parameters<AccountingProvider['pushInvoice']>[1];

/**
 * The accounting-seam currency contract (multi-currency spec §11, bug B8).
 *
 * Deliberately fail-closed, and deliberately STRICTER than the Stripe posture in
 * §10. Stripe warns-but-allows on a currency mismatch because the checkout still
 * presents the document's own currency; a QuickBooks push into a realm whose home
 * currency is different (or unknown) silently mis-books a ledger, so both cases
 * block. Foreign-currency push (CurrencyRef + ExchangeRate) is deferred beyond
 * this program: there is no conversion anywhere in this file.
 *
 * Pure by construction — no DB, no network, no clock. The Phase-C push entrypoint
 * and the Phase-D payment applier call these; neither exists yet.
 */
export type AccountingCurrencyContractErrorCode =
  | 'ACCOUNTING_HOME_CURRENCY_UNKNOWN'
  | 'ACCOUNTING_INVOICE_CURRENCY_MISMATCH'
  | 'ACCOUNTING_PAYMENT_CURRENCY_MISMATCH'
  | 'ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID';

export class AccountingCurrencyContractError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502,
    readonly code: AccountingCurrencyContractErrorCode,
  ) {
    super(message);
    this.name = 'AccountingCurrencyContractError';
  }
}

function normalizeCode(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return code.length > 0 ? code : null;
}

function providerLabel(provider: AccountingConnection['provider']): string {
  return provider === 'xero' ? 'Xero' : 'QuickBooks';
}

/**
 * Hard-blocks an invoice push whose stamped currency is not the realm's home
 * currency, and blocks equally when the home currency was never captured.
 */
export function assertAccountingInvoicePushCurrency(
  connection: Pick<AccountingConnection, 'provider' | 'homeCurrency'>,
  invoice: Pick<AccountingPushInvoicePayload, 'currencyCode'>,
): void {
  const label = providerLabel(connection.provider);
  const home = normalizeCode(connection.homeCurrency);
  if (!home) {
    throw new AccountingCurrencyContractError(
      `${label} home currency is unavailable, so this invoice cannot be pushed safely. Reconnect ${label} to capture it, then retry.`,
      409,
      'ACCOUNTING_HOME_CURRENCY_UNKNOWN',
    );
  }

  const invoiceCurrency = normalizeCode(invoice.currencyCode);
  if (invoiceCurrency !== home) {
    throw new AccountingCurrencyContractError(
      `Invoice currency ${invoiceCurrency ?? 'unknown'} does not match the connected ${label} home currency ${home}. Cross-currency accounting pushes are not supported.`,
      409,
      'ACCOUNTING_INVOICE_CURRENCY_MISMATCH',
    );
  }
}

export interface NormalizedAccountingPayment {
  invoiceId: string;
  remoteInvoiceId: string;
  remotePaymentId: string;
  /** Major-unit fixed-2 string, ready for invoice_payments.amount. */
  amount: string;
  currencyCode: string;
  txnDate: string;
}

/**
 * Converts one provider-reported payment into Breeze's major-unit shape.
 *
 * ORDER IS LOAD-BEARING: currency equality is asserted BEFORE any conversion, so
 * a cross-currency payment can never be silently reinterpreted at the invoice's
 * minor-unit exponent (spec §12 non-goal: a payment always matches its invoice's
 * currency).
 */
export function normalizeAccountingPayment(
  payment: ChangeSet['payments'][number],
  invoice: Pick<AccountingPushInvoicePayload, 'invoiceId' | 'currencyCode'>,
): NormalizedAccountingPayment {
  const paymentCurrency = normalizeCode(payment.currency);
  const invoiceCurrency = normalizeCode(invoice.currencyCode);

  if (!paymentCurrency || !invoiceCurrency || paymentCurrency !== invoiceCurrency) {
    throw new AccountingCurrencyContractError(
      `Payment currency ${paymentCurrency ?? 'unknown'} does not match invoice currency ${invoiceCurrency ?? 'unknown'}. Cross-currency payments are not supported.`,
      409,
      'ACCOUNTING_PAYMENT_CURRENCY_MISMATCH',
    );
  }

  // Strictly POSITIVE. Zero is not a payment, and a negative amount is a refund
  // or credit memo — spec §12 puts credit memos out of scope, and applying one
  // here would INCREASE the invoice balance through the payment path. Provider
  // refund/credit events are unsupported until a dedicated flow exists.
  if (!Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0) {
    throw new AccountingCurrencyContractError(
      `Payment ${payment.remotePaymentId} reported a minor-unit amount that is not a positive safe integer; refunds and credit memos are not supported and a non-integer value would be a guess.`,
      502,
      'ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID',
    );
  }

  return {
    invoiceId: invoice.invoiceId,
    remoteInvoiceId: payment.remoteInvoiceId,
    remotePaymentId: payment.remotePaymentId,
    amount: fromMinorUnits(payment.amountMinor, paymentCurrency),
    currencyCode: paymentCurrency,
    txnDate: payment.txnDate,
  };
}
```
- [ ] **Step 4: Run the tests.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingCurrency.test.ts` → all PASS.
- [ ] **Step 5: Prove non-vacuity, twice.** The file is new and untracked, so `git checkout --` cannot restore it — copy it aside first (`cp apps/api/src/services/accounting/accountingCurrency.ts /tmp/ac.bak`), then:
  1. Delete the whole `if (!paymentCurrency || !invoiceCurrency || paymentCurrency !== invoiceCurrency)` block and re-run — the "asserts currency equality BEFORE converting" case must FAIL.
  2. Restore (`cp /tmp/ac.bak apps/api/src/services/accounting/accountingCurrency.ts`), then change `if (!home)` to `if (false)` and re-run — the "FAILS CLOSED when the home currency was never captured" case must FAIL.
  3. Restore again, then weaken the amount check to `if (!Number.isSafeInteger(payment.amountMinor))` (dropping `|| payment.amountMinor <= 0`) and re-run — the "rejects a non-positive…" case must FAIL on `0`, proving the refund/credit-memo exclusion is real and not inherited from the integer check.
  Restore again and re-run Step 4 to green before continuing.
- [ ] **Step 6: Record the deferred enforcement + integration contract** by appending this comment block to the bottom of `apps/api/src/services/accounting/accountingCurrency.ts`:
```ts
/*
 * DEFERRED ENFORCEMENT + INTEGRATION CONTRACT (multi-currency §11, wave 8 → Phase C/D).
 *
 * WHAT THIS MODULE IS TODAY: a guard PRIMITIVE with a unit contract. It is
 * called by nothing, because nothing can push: QuickbooksProvider.pushInvoice /
 * voidInvoice are `NotImplemented: Phase C`, reconcileChanges is
 * `NotImplemented: Phase D`, and the entity-mapping table that would resolve a
 * remote invoice id is not in the repo. Exporting a pure function does NOT stop
 * a future caller from reaching `provider.pushInvoice` directly — this comment
 * is advisory, so Phase C must convert it into a mechanical gate:
 *
 *  1. ONE GUARDED COORDINATOR. Phase C exposes exactly one sanctioned entry —
 *     `pushInvoiceToAccounting(...)` — which loads the connection and the typed
 *     payload, calls assertAccountingInvoicePushCurrency FIRST, and only then
 *     reaches the provider transport. `provider.pushInvoice` / `voidInvoice`
 *     stay transport-only and are never called from anywhere else.
 *  2. A STATIC CALL-SITE GATE, using the AST technique in
 *     apps/api/src/services/stripeCheckoutCallSites.test.ts: parse apps/api/src
 *     + ee, find every call expression whose callee ends in `.pushInvoice` or
 *     `.voidInvoice` on an AccountingProvider, and fail unless the enclosing
 *     module is the coordinator itself. That is what makes the guard
 *     unbypassable rather than merely available.
 *  3. apps/api/src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts —
 *     seed a USD QBO connection + an EUR invoice, call the real coordinator,
 *     assert ACCOUNTING_INVOICE_CURRENCY_MISMATCH, assert NO QBO request was
 *     made and NO sync/mapping state was persisted; plus a null-home-currency
 *     case asserting ACCOUNTING_HOME_CURRENCY_UNKNOWN with reconnect guidance.
 *     assertAccountingInvoicePushCurrency must run immediately after the typed
 *     connection + invoice payload are loaded and BEFORE any network call.
 *  4. A Phase-D payment applier that follows the ESTABLISHED INVOICE-FIRST LOCK
 *     ORDER (invoiceService.recordPayment, apps/api/src/services/invoiceService.ts:1305-1314:
 *     "ONE transaction, invoice row lock FIRST"). Concretely, in one transaction:
 *       a. SELECT the invoice row FOR UPDATE;
 *       b. re-read currency and recompute the balance from invoice_payments
 *          UNDER that lock (the header balance column is only a cache of the sum);
 *       c. resolve the remote-invoice mapping and call normalizeAccountingPayment
 *          against the LOCKED invoice's stamped currency;
 *       d. claim the unique (connection, remotePaymentId) mapping and insert the
 *          invoice_payments row and recompute the header IN THE SAME transaction,
 *          so a re-delivered remotePaymentId applies at most once.
 *     A Phase-D suite must prove the ordering (normalize after mapping
 *     resolution, before any invoice_payments write) and the at-most-once
 *     property under concurrent re-delivery.
 */
```
Re-run Step 4's command to confirm the file still compiles and passes.
- [ ] **Step 7: Commit** — `feat(api): fail-closed accounting currency guard + payment pull-back conversion (#3780)`.

---

### Task 4: Fetch the QBO realm home currency from `Preferences.CurrencyPrefs`

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. **Task 2 must be complete** (it added the `fetchHomeCurrency` member to `AccountingProvider` and a throwing stub to `QuickbooksProvider`). Spec §11: *"At connect, fetch the realm's home currency from **`Preferences.CurrencyPrefs.HomeCurrency`** (not CompanyInfo) and persist it to the existing-but-dead `accounting_connections.home_currency`."*

Intuit returns `HomeCurrency` as a **reference object**, so the code is at `Preferences.CurrencyPrefs.HomeCurrency.value` — not a bare string, and never from CompanyInfo. The endpoint is `GET {base}/v3/company/{realmId}/preferences?minorversion=70`.

Follow the HTTP conventions already in the file at `apps/api/src/services/accounting/quickbooksProvider.ts:103-144`: realmId/accessToken preconditions (`:107-108`), the `runOutsideDbContext(() => fetch(...))` wrapper (`:118` — mandatory; a QBO round-trip must never hold a pooled DB connection, the #1105 class), and `Authorization: Bearer` + `Accept: application/json` headers — **with one deliberate divergence**. `listRemoteCustomers` attaches a 500-char-truncated response `body` to the thrown error (`:128-134`); this method must **not**. Its error is the one that reaches `captureException` in the OAuth callback (Task 7), and a QBO error body can carry realm, company and customer detail — so sending it to Sentry would violate this plan's own "never capture a QBO body" rule. Throw a **sanitized** error carrying only `status` and `operation`, with the realm id absent from the message too. Module constants already present: `qboApiBase` (`:21`), `QBO_API_MINOR_VERSION = '70'` (`:18`).

**Files:**
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts` (add `QboRawPreferences` + `mapQboHomeCurrency` beside `QboRawCustomer` at `:32-43`; replace the `fetchHomeCurrency` stub added in Task 2)
- Modify: `apps/api/src/services/accounting/quickbooksProvider.test.ts` (append a new `describe`; the file already has a `conn()` fixture at `:6-18` with `environment: 'sandbox'`, `realmId: 'realm123'`, `accessToken: 'tok'`, and `afterEach(() => vi.restoreAllMocks())` at `:20`)

**Interfaces:**
- Produces: `export interface QboRawPreferences`, `export function mapQboHomeCurrency(raw: QboRawPreferences): string | null`, and `QuickbooksProvider.fetchHomeCurrency(conn: AccountingConnection): Promise<string | null>`.
- Consumes: `runOutsideDbContext` (already imported at `:2`), `qboApiBase`, `QBO_API_MINOR_VERSION`.

- [ ] **Step 1: Write the failing tests.** Append to `apps/api/src/services/accounting/quickbooksProvider.test.ts` (and add `mapQboHomeCurrency` to the existing import from `./quickbooksProvider` at `:3`):
```ts
describe('mapQboHomeCurrency', () => {
  it('reads Preferences.CurrencyPrefs.HomeCurrency.value and normalizes it', () => {
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: ' cad ' } } } })).toBe('CAD');
  });

  it('returns null when any level is missing', () => {
    expect(mapQboHomeCurrency({})).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: {} })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: {} } })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: null } } })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: null } } } })).toBeNull();
  });

  it('returns null for a non three-letter value rather than persisting junk', () => {
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'DOLLARS' } } } })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: '' } } } })).toBeNull();
  });

  it('accepts a code OUTSIDE Breeze supported currencies — it is an external fact', () => {
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'BHD' } } } })).toBe('BHD');
  });
});

describe('fetchHomeCurrency', () => {
  const prefsBody = { Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } } };

  it('calls the sandbox preferences endpoint with minorversion 70 and a bearer token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(prefsBody), { status: 200 }));

    await expect(quickbooksProvider.fetchHomeCurrency(conn())).resolves.toBe('CAD');

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('sandbox-quickbooks.api.intuit.com');
    expect(url).toContain('/v3/company/realm123/preferences');
    expect(url).toContain('minorversion=70');
    expect(url).not.toContain('companyinfo');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('uses the production host for a production connection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(prefsBody), { status: 200 }));

    await quickbooksProvider.fetchHomeCurrency(conn({ environment: 'production' }));

    expect(String(fetchMock.mock.calls[0]![0])).toContain('https://quickbooks.api.intuit.com');
  });

  it('returns null when QBO omits CurrencyPrefs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ Preferences: {} }), { status: 200 }));

    await expect(quickbooksProvider.fetchHomeCurrency(conn())).resolves.toBeNull();
  });

  it('throws a SANITIZED typed error on a non-2xx — status and operation only, never the QBO body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ Fault: { Error: [{ Detail: 'realm 4620816365 customer Acme Ltd' }] } }), { status: 403 }),
    );

    const err = await quickbooksProvider.fetchHomeCurrency(conn()).catch(
      (e: Error & { status?: number; operation?: string; body?: string }) => e,
    );

    expect(err.status).toBe(403);
    expect(err.operation).toBe('fetchHomeCurrency');
    // This error is handed to captureException by the OAuth callback, so it must
    // carry no provider payload, no realm id and no token.
    expect(err.body).toBeUndefined();
    expect(JSON.stringify({ message: err.message, ...err })).not.toContain('Acme Ltd');
    expect(err.message).not.toContain('realm123');
    expect(err.message).not.toContain('tok');
  });

  it('rejects when the connection lacks a realmId or an access token', async () => {
    await expect(quickbooksProvider.fetchHomeCurrency(conn({ realmId: null }))).rejects.toThrow(/realmId/);
    await expect(quickbooksProvider.fetchHomeCurrency(conn({ accessToken: null }))).rejects.toThrow(/access token/);
  });
});
```
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts` → the new cases fail (`mapQboHomeCurrency` is not exported; `fetchHomeCurrency` throws `NotImplemented`).
- [ ] **Step 3: Add the raw type and the pure mapper.** In `apps/api/src/services/accounting/quickbooksProvider.ts`, insert immediately after the `QboRawCustomer` interface (currently ending at `:43`):
```ts
/**
 * QBO Preferences response. `HomeCurrency` is a REFERENCE object, so the code
 * lives at `.value` — and it comes from Preferences, never CompanyInfo
 * (multi-currency §11).
 */
export interface QboRawPreferences {
  Preferences?: {
    CurrencyPrefs?: {
      HomeCurrency?: { value?: string | null } | null;
    } | null;
  };
}

/**
 * Normalizes the realm's home currency to an uppercase three-letter code.
 * Deliberately NOT validated against Breeze's curated supported-currency list:
 * a realm may legitimately run a currency Breeze cannot bill in, and that must
 * stay connectable — the invoice-push guard blocks it later instead.
 */
export function mapQboHomeCurrency(raw: QboRawPreferences): string | null {
  const value = raw.Preferences?.CurrencyPrefs?.HomeCurrency?.value;
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
```
- [ ] **Step 4: Implement the method.** Replace the `fetchHomeCurrency` stub added in Task 2 with:
```ts
  // NOTE: like listRemoteCustomers, this assumes `conn.accessToken` is already
  // valid and issues no DB queries. The fetch runs OUTSIDE any DB context so a
  // QBO round-trip never holds a pooled connection (#1105 class).
  async fetchHomeCurrency(conn: AccountingConnection): Promise<string | null> {
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const url = `${qboApiBase(conn.environment)}/v3/company/${conn.realmId}/preferences?minorversion=${QBO_API_MINOR_VERSION}`;
    const response = await runOutsideDbContext(() =>
      fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${conn.accessToken}`,
          Accept: 'application/json',
        },
      })
    );

    if (!response.ok) {
      // DELIBERATELY sanitized, unlike listRemoteCustomers: this error is passed
      // to captureException by the OAuth callback (multi-currency §11), and a QBO
      // fault body can carry realm/company/customer detail. Status + operation are
      // enough to triage; the body is never read, so it cannot leak.
      const err = new Error(`QuickBooks preferences request failed with ${response.status}`);
      (err as Error & { status?: number; operation?: string }).status = response.status;
      (err as Error & { status?: number; operation?: string }).operation = 'fetchHomeCurrency';
      throw err;
    }

    return mapQboHomeCurrency(await response.json() as QboRawPreferences);
  }
```
- [ ] **Step 5: Run the suite.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts` → all PASS (existing `mapQboAddress`/`mapQboCustomer`/`listRemoteCustomers` cases included).
- [ ] **Step 6: Typecheck.** `pnpm --filter @breeze/api build` → clean.
- [ ] **Step 7: Commit** — `feat(api): read the QBO realm home currency from Preferences.CurrencyPrefs (#3780)`.

---

### Task 5: Realm-generation compare-and-set writer for `accounting_connections.home_currency`

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. The `home_currency` column exists (`apps/api/src/db/schema/accounting.ts:15`; SQL `apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql:11`) but nothing writes it — bug **B8**'s dead column. **No migration is needed or permitted in this task.**

The write must be a **narrow UPDATE**, not a second `upsertConnection`: an upsert could resurrect a disconnected row with default status/settings but no usable credentials.

It must also be a **realm-generation compare-and-set**, and `updated_at` alone is not good enough to be that generation token. `upsertConnection` stamps an **application** timestamp (`const now = new Date()`, `apps/api/src/services/accounting/accountingConnectionService.ts:126`, written to `updatedAt` in both the insert values `:144` and the conflict `updateSet` `:168`), so two reconnects landing inside the same millisecond can carry the **same** `updatedAt` — and a stale realm-A Preferences response would then satisfy a timestamp-only predicate and overwrite realm B's freshly captured currency, which is precisely the mis-booking this writer exists to prevent. Adding a generation column would be DDL, which this wave forbids, so the identity check uses what is already on the row: **lock the row (`SELECT … FOR UPDATE`), decrypt its current `realm_id`, and require it to equal the realm the capture was started for** — then also require `updated_at` to be unchanged as a second, cheaper barrier against a same-realm double capture. Both comparisons happen under the lock, inside one short transaction with no network call in it. (The realm id is stored encrypted with a random IV, so it cannot be compared as ciphertext in SQL — hence the lock-then-decrypt shape rather than an extra `WHERE`.)

Follow the existing precedent in the same file: `updateTokens` (`apps/api/src/services/accounting/accountingConnectionService.ts:187-213`) and `markStatus` (`:215-237`) both use `.returning({ id: accountingConnections.id })` and **throw** on zero rows, because an RLS-context mismatch would otherwise fail silently (comment at `:193-195`).

**Files:**
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts` (insert the new function between `updateTokens`, ending `:213`, and `markStatus`, starting `:215`)
- Modify: `apps/api/src/services/accounting/accountingConnectionService.test.ts` (its `makeMockDb` helper at `:4-48` has no `transaction` and no lock-select, so Step 1 adds a local `makeCasDb` alongside it rather than reshaping the helper the existing cases depend on)

**Interfaces:**
- Produces:
```ts
/** DbExecutor plus the transaction handle this writer needs for its row lock. */
export type DbTransactor = DbExecutor & {
  transaction: <T>(fn: (tx: DbExecutor) => Promise<T>) => Promise<T>;
};

export async function updateHomeCurrency(
  db: DbTransactor,
  connectionId: string,
  partnerId: string,
  expected: { updatedAt: Date; realmId: string | null },
  homeCurrency: string,
): Promise<void>;
```
- Consumes: `and`, `eq` from `drizzle-orm` (already imported at `:1`), `accountingConnections` (`:2`), `DbExecutor` (`:57`), the module-private `decryptNullable` (`:66-69`).

- [ ] **Step 1: Write the failing tests.** Append to `apps/api/src/services/accounting/accountingConnectionService.test.ts` inside the existing `describe('accountingConnectionService', ...)` block. The existing `makeMockDb` (`:4-48`) has no `transaction` and no lock-select, so add this local helper above the new cases (it builds the row's `realm_id` ciphertext with the real `encryptSecret`, which the suite already exercises indirectly through `upsertConnection`):
```ts
  function makeCasDb(row: Record<string, unknown> | null, updatedRows: Array<{ id: string }> = [{ id: 'x' }]) {
    const setSpy = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => updatedRows) })),
    }));
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: vi.fn(async () => (row ? [row] : [])) })),
          })),
        })),
      })),
      insert: vi.fn(),
      update: vi.fn(() => ({ set: setSpy })),
      delete: vi.fn(),
    } as any;
    const db = { ...tx, transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    return { db, tx, setSpy };
  }

  async function casRow(realmId: string | null, updatedAt: Date) {
    const { encryptSecret } = await import('../secretCrypto');
    return {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      partnerId: '11111111-1111-1111-1111-111111111111',
      realmIdEncrypted: realmId === null ? null : encryptSecret(realmId),
      updatedAt,
      homeCurrency: null,
    };
  }
```
Then the cases:
```ts
  it('updateHomeCurrency normalizes the code and writes under the row lock', async () => {
    const at = new Date('2026-09-04T00:00:00Z');
    const { db, tx, setSpy } = makeCasDb(await casRow('realm-A', at));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await updateHomeCurrency(
      db,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '11111111-1111-1111-1111-111111111111',
      { updatedAt: at, realmId: 'realm-A' },
      ' cad ',
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.select).toHaveBeenCalledTimes(1); // the FOR UPDATE lock read
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ homeCurrency: 'CAD' }));
  });

  it('updateHomeCurrency accepts a code Breeze cannot bill in (external fact)', async () => {
    const at = new Date('2026-09-04T00:00:00Z');
    const { db, setSpy } = makeCasDb(await casRow('realm-A', at));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await updateHomeCurrency(db, 'c1', 'p1', { updatedAt: at, realmId: 'realm-A' }, 'BHD');

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ homeCurrency: 'BHD' }));
  });

  it('updateHomeCurrency rejects a malformed external value without touching the db', async () => {
    const { db } = makeCasDb(await casRow('realm-A', new Date()));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: new Date(), realmId: 'realm-A' }, 'DOLLARS'))
      .rejects.toThrow(/home currency/i);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('updateHomeCurrency ABORTS when the row now belongs to a different realm — even at an IDENTICAL updatedAt', async () => {
    // The realm-generation race: two reconnects inside the same millisecond carry
    // the same application-stamped updatedAt, so a timestamp-only predicate would
    // let realm A's slow Preferences response overwrite realm B's currency.
    const sameMs = new Date('2026-09-04T00:00:00.000Z');
    const { db, setSpy } = makeCasDb(await casRow('realm-B', sameMs));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: sameMs, realmId: 'realm-A' }, 'USD'))
      .rejects.toThrow(/different realm/i);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('updateHomeCurrency throws on a stale updatedAt (same realm, reconnected since)', async () => {
    const { db, setSpy } = makeCasDb(await casRow('realm-A', new Date('2026-09-04T00:00:05Z')));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: new Date('2026-09-04T00:00:00Z'), realmId: 'realm-A' }, 'USD'))
      .rejects.toThrow(/matched no accounting_connections row/);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('updateHomeCurrency throws when the lock read returns nothing (deleted row or wrong RLS context)', async () => {
    const { db } = makeCasDb(null);
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: new Date(), realmId: 'realm-A' }, 'USD'))
      .rejects.toThrow(/matched no accounting_connections row/);
  });
```
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingConnectionService.test.ts` → the six new cases fail (`updateHomeCurrency` is not exported).
- [ ] **Step 3: Implement the writer.** Insert into `apps/api/src/services/accounting/accountingConnectionService.ts` between `updateTokens` and `markStatus` (and export `DbTransactor` beside `DbExecutor` at `:57-62`):
```ts
/**
 * DbExecutor plus the transaction handle. Declared separately so the existing
 * mock-injecting callers of DbExecutor are untouched; production passes the real
 * request-scoped `db`, which has `.transaction`.
 */
export type DbTransactor = DbExecutor & {
  transaction: <T>(fn: (tx: DbExecutor) => Promise<T>) => Promise<T>;
};

/**
 * Persists the provider-reported home currency (multi-currency §11, bug B8).
 *
 * Narrow UPDATE, never a second upsertConnection: an upsert would resurrect a
 * disconnected row with default settings and no usable credentials.
 *
 * REALM-GENERATION compare-and-set, under a row lock. The unique
 * (partner_id, provider) index means a reconnect to a DIFFERENT realm reuses this
 * row id, so a slow Preferences response from the previous realm must not
 * overwrite the new one. `updated_at` alone cannot decide that: upsertConnection
 * stamps an APPLICATION timestamp, so two reconnects in the same millisecond can
 * share it. The realm id is the real identity — it is compared after decryption
 * under FOR UPDATE (the ciphertext uses a random IV, so SQL cannot compare it),
 * with the timestamp kept as a second barrier against a same-realm double capture.
 *
 * The value is a cache of an EXTERNAL fact — it is not validated against
 * supported_currencies and carries no FK, because a realm may legitimately run
 * a currency Breeze cannot bill in. The only shape rule is ISO-4217-looking.
 *
 * Lock note: this is the only row lock wave 8 takes. It is a single leaf-table
 * row, held across no other lock and no network call.
 */
export async function updateHomeCurrency(
  db: DbTransactor,
  connectionId: string,
  partnerId: string,
  expected: { updatedAt: Date; realmId: string | null },
  homeCurrency: string
): Promise<void> {
  const normalized = homeCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Refusing to persist a malformed accounting home currency: ${JSON.stringify(homeCurrency)}`);
  }

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(accountingConnections)
      .where(and(
        eq(accountingConnections.id, connectionId),
        eq(accountingConnections.partnerId, partnerId)
      ))
      .limit(1)
      .for('update');

    // Zero rows means deleted underneath the capture OR hidden by RLS — both are
    // "do not write", and both must be loud (the updateTokens/markStatus
    // precedent at :193-195: a silent no-op hides an RLS-context mistake).
    if (!row) {
      throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}); it was deleted underneath the capture or the DB context is wrong`);
    }

    if (decryptNullable(row.realmIdEncrypted) !== expected.realmId) {
      throw new Error(`updateHomeCurrency aborted: connection ${connectionId} now points at a different realm than the capture started for`);
    }

    if (row.updatedAt === null || row.updatedAt.getTime() !== expected.updatedAt.getTime()) {
      throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}) at the expected generation; the connection changed underneath the capture`);
    }

    const updated = await tx
      .update(accountingConnections)
      .set({
        homeCurrency: normalized,
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingConnections.id, connectionId),
        eq(accountingConnections.partnerId, partnerId)
      ))
      .returning({ id: accountingConnections.id });
    if (updated.length === 0) {
      throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}) on write; the DB context is wrong`);
    }
  });
}
```
- [ ] **Step 4: Run the suite.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingConnectionService.test.ts` → all PASS.
- [ ] **Step 5: Prove non-vacuity of BOTH generation checks.** (a) Temporarily delete the `decryptNullable(row.realmIdEncrypted) !== expected.realmId` block and re-run — the "ABORTS when the row now belongs to a different realm" case must FAIL, which is the whole reason the lock exists. (b) Restore it, then delete the `row.updatedAt` comparison and re-run — the "stale updatedAt" case must FAIL. Restore both and re-run Step 4 to green.
- [ ] **Step 6: Confirm no tenancy-registration contract fired.** `accounting_connections` has no `org_id` and no `device_id`, and this task adds no column:
```bash
grep -rn accounting_connections apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/core.ts
git diff --name-only -- apps/api/migrations
```
Both must print **nothing**.
- [ ] **Step 7: Commit** — `feat(api): realm-generation compare-and-set writer for accounting_connections.home_currency (#3780)`.

---

### Task 6: Real-DB proof — home-currency persistence under partner-axis RLS

**Executor: claude**

Prove the Task-5 writer against real Postgres as the unprivileged `breeze_app` role: partner isolation, the realm-generation abort (including the same-millisecond reconnect a timestamp-only predicate would let through), the stale-`updatedAt` rejection, and that a non-Breeze currency code persists (no FK, no curated-list validation). Mock-only coverage cannot prove any of these — in particular, only a real DB proves the `FOR UPDATE` read is subject to the same RLS policy as the write.

**Files:**
- Create: `apps/api/src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts`

**Interfaces:**
- Produces: no runtime API.
- Consumes: `updateHomeCurrency` (Task 5), `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `type DbAccessContext` from `../../db`, `accountingConnections` from `../../db/schema`, `createPartner` from `./db-utils`. Shape precedent to copy verbatim (including the `import './setup'` first line, the `it.runIf(!!process.env.DATABASE_URL)` gate, the per-test re-seed rule, and the non-vacuity `rolbypassrls` guard): `apps/api/src/__tests__/integration/accounting-connections-rls.integration.test.ts:1-66`.

- [ ] **Step 1: Write the suite.** Create `apps/api/src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts` covering exactly these cases, each re-seeding its own partners (the integration setup truncates tenant data between tests, so a memoized fixture is vacuous):
  1. **system context writes the currency** — seed a connection under `withSystemDbAccessContext` (via `upsertConnection`, so `realm_id` is encrypted exactly as production writes it), read back its `updatedAt`, call `updateHomeCurrency(db, id, partnerId, { updatedAt, realmId: 'realm-A' }, 'cad')`, then re-select and assert `home_currency === 'CAD'`.
  2. **stale `updatedAt` is rejected and does not overwrite** — capture `updatedAt`, perform a second unrelated `UPDATE ... SET updated_at = now()` on the row, then call `updateHomeCurrency` with the ORIGINAL timestamp (same realm) and assert it rejects with `/matched no accounting_connections row/` **and** that `home_currency` is still `null`.
  3. **same-millisecond reconnect to a DIFFERENT realm is aborted** — the race a timestamp-only predicate cannot catch. Seed realm A, capture `{ updatedAt, realmId: 'realm-A' }`, then reconnect the SAME `(partner, provider)` row to realm B via `upsertConnection` **with `updatedAt` forced to the identical timestamp** (a direct `UPDATE ... SET realm_id_encrypted = <realm-B ciphertext>, updated_at = <the captured value>` under system context reproduces the same-millisecond collision deterministically — do not rely on wall-clock timing). Then run realm A's late capture: it must reject with `/different realm/i` and leave `home_currency` `null`. Finally, prove the row is still writable for realm B: `updateHomeCurrency(..., { updatedAt: <same>, realmId: 'realm-B' }, 'CAD')` succeeds.
  4. **partner isolation** — seed the connection under partner B; calling `updateHomeCurrency` inside `withDbAccessContext(partnerCtx(partnerA.id), ...)` must reject with the zero-row error (RLS hides the row from the locking read), and a system re-select must show `home_currency` still `null`.
  5. **legitimate partner-A update inside a partner context succeeds** — proves case 4 is not vacuous.
  6. **a code outside Breeze's curated list persists** — `updateHomeCurrency(..., 'BHD')` succeeds and reads back `'BHD'`, proving there is no FK to `supported_currencies` and no `currencyCodeSchema` gate on this column.
  7. **the non-vacuity role guard** — copy the `current_user` / `rolbypassrls` assertion from `accounting-connections-rls.integration.test.ts:53-65` so a mis-symlinked `.env.test` fails loudly instead of passing every isolation case.
- [ ] **Step 2: Run it** (postgres `localhost:5441`, redis `localhost:6391`, from the repo-root `.env.test`):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts
```
All cases PASS.
- [ ] **Step 3: Prove cases 2 and 3 are not vacuous.** (a) Temporarily drop the `row.updatedAt` comparison from `updateHomeCurrency` and re-run — case 2 must FAIL. (b) Restore it, then drop the realm comparison and re-run — case 3 must FAIL (and would have passed under any `updated_at`-only design, which is the finding this test exists for). Restore both and re-run to green.
- [ ] **Step 4: Re-run the neighbouring RLS suite** to prove nothing regressed:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accounting-connections-rls.integration.test.ts
```
- [ ] **Step 5: Commit** — `test(api): real-DB proof for accounting home-currency compare-and-set under partner RLS (#3780)`.

---

### Task 7: Capture the home currency in the OAuth callback (non-fatal)

**Executor: claude**

Wire Tasks 4 and 5 into the QuickBooks OAuth callback (`apps/api/src/routes/accounting/index.ts:210-263`), which today exchanges the code (`:228`) and upserts credentials (`:243-253`) with no currency at all. This is the cross-module step: OAuth, system DB context (there is no request auth context on this route — see the comment at `:237-241`), realm-generation races, and a failure path that must NOT break connecting.

Sequence, exactly:

```text
verify state + binding cookie
  -> exchangeCode                 (runOutsideDbContext, already there)
  -> upsertConnection             (withSystemDbAccessContext) WITH homeCurrency: null
  -> fetchHomeCurrency            (runOutsideDbContext, NON-FATAL)
  -> updateHomeCurrency           (withSystemDbAccessContext, compare-and-set, NON-FATAL)
  -> redirect connected=1
```

Two rules that are load-bearing:
- The initial upsert must pass `homeCurrency: null` **explicitly**. `upsertConnection`'s conflict `updateSet` is built with `stripUndefined` (`accountingConnectionService.ts:153-169`), so omitting the field leaves a PREVIOUS realm's currency in place across a reconnect — exactly the mis-booking this guard exists to prevent. Passing `null` clears it, and unknown fails closed.
- A Preferences failure, a missing `HomeCurrency`, or a lost compare-and-set is **non-fatal**: log `{ partnerId, provider }` only (never the code, realm id, tokens, or the QBO body — the discipline already in place at `:230-232`), leave `home_currency` NULL, and still redirect `connected=1`. The connection remains usable for customer import; only the future push is blocked, with the guard's reconnect message.

**Files:**
- Modify: `apps/api/src/routes/accounting/index.ts` (import block `:12-16`; callback `:242-262`; `GET /:provider` response `:288-296`)
- Modify: `apps/api/src/routes/accounting/index.test.ts` (hoisted `mocks` object `:26-33`; the connection-service mock `:82-86`; the provider-registry mock `:92-98`; the callback cases `:163-241`)

**Interfaces:**
- Produces: no new exported API. `GET /accounting/:provider` gains one response field, `homeCurrency: string | null` (operators need to see whether capture succeeded; no UI or locale work ships in this wave).
- Consumes: `updateHomeCurrency` from `../../services/accounting/accountingConnectionService`; `providerClient.fetchHomeCurrency` from the registry client already resolved at `:225`. `db` (`../../db`) satisfies `DbTransactor` — it exposes `.transaction`; no cast is needed, and if one appears, the wrong handle is being passed.

- [ ] **Step 1: Write the failing tests.** In `apps/api/src/routes/accounting/index.test.ts`:
  - add `fetchHomeCurrency: vi.fn()` and `updateHomeCurrency: vi.fn()` to the hoisted `mocks` object (`:26-33`);
  - add `updateHomeCurrency: mocks.updateHomeCurrency` to the `accountingConnectionService` mock factory (`:82-86`);
  - add `fetchHomeCurrency: mocks.fetchHomeCurrency` to the provider stub returned by `getAccountingProvider` (`:92-98`) — **without this the callback throws `providerClient.fetchHomeCurrency is not a function`**;
  - move the inline `captureException: vi.fn()` in the `../../services/sentry` mock (`:88-90`) into the hoisted `mocks` object as `captureException: vi.fn()` and reference it from the factory, so the new telemetry case can inspect what was captured;
  - in `beforeEach` (`:105-112`), give `upsertConnection` a default resolved connection so the callback has a row to update: `mocks.upsertConnection.mockResolvedValue({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', partnerId: authState.partnerId, provider: 'quickbooks', realmId: 'realm-A', updatedAt: new Date('2026-09-04T00:00:00Z'), homeCurrency: null })` and `mocks.fetchHomeCurrency.mockResolvedValue('CAD')`;
  - extend the existing "callback is NOT behind authMiddleware" case (`:163-187`) to assert `upsertConnection` was called with `expect.objectContaining({ homeCurrency: null })`;
  - add these cases:
    1. **captures and persists** — redirect contains `connected=1`; `fetchHomeCurrency` called with the object `upsertConnection` resolved; `updateHomeCurrency` called with `(expect.anything(), 'aaaaaaaa-…', partnerId, { updatedAt: new Date('2026-09-04T00:00:00Z'), realmId: tokens.realmId }, 'CAD')` — the realm id comes from the exchanged **tokens**, i.e. the realm this capture is for, which is what makes the Task-5 generation check meaningful.
    2. **Preferences failure is non-fatal** — `mocks.fetchHomeCurrency.mockRejectedValueOnce(new Error('qbo 403'))`; still 302 to `connected=1`; `updateHomeCurrency` NOT called.
    3. **missing home currency is non-fatal** — `mockResolvedValueOnce(null)`; still `connected=1`; `updateHomeCurrency` NOT called.
    4. **lost compare-and-set is non-fatal** — `mocks.updateHomeCurrency.mockRejectedValueOnce(new Error('updateHomeCurrency matched no accounting_connections row'))`; still `connected=1`.
    5. **credential-persist failure short-circuits** — `mocks.upsertConnection.mockRejectedValueOnce(new Error('boom'))`; redirect contains `error=persist_failed`; `fetchHomeCurrency` NOT called.
    5b. **captured telemetry carries no QBO body, realm or token** — `mocks.fetchHomeCurrency.mockRejectedValueOnce(Object.assign(new Error('QuickBooks preferences request failed with 403'), { status: 403, operation: 'fetchHomeCurrency' }))`; assert `mocks.captureException` was called, and that `JSON.stringify({ message: captured.message, ...captured })` contains none of: a `body` key, the realm id (`'realm-A'` and the callback's `query.realmId`), the access token, or the authorization code. This is the executable form of the plan's "never capture a QBO body" rule — Task 4 throws a sanitized error precisely so this passes.
    6. **status route exposes the captured currency** — extend the existing "status returns connection status without token fields" case (`:123-152`, whose fixture already sets `homeCurrency: null` at `:134`) with a second `getConnection` fixture carrying `homeCurrency: 'CAD'` and assert `body.homeCurrency === 'CAD'`, plus that the disconnected branch (`:280-286`) returns `homeCurrency: null`.
- [ ] **Step 2: Run and watch it fail.** `pnpm --filter @breeze/api exec vitest run src/routes/accounting/index.test.ts`.
- [ ] **Step 3: Import the writer.** Extend the import at `apps/api/src/routes/accounting/index.ts:12-16`:
```ts
import {
  deleteConnection,
  getConnection,
  updateHomeCurrency,
  upsertConnection,
} from '../../services/accounting/accountingConnectionService';
import type { AccountingConnection } from '../../services/accounting/accountingConnectionService';
```
(the `type` import is needed by Step 4 — `let connection;` with no annotation is an implicit `any` under this package's `noImplicitAny`.)
- [ ] **Step 4: Capture the connection and clear the stale currency.** Replace the persist block at `:242-259` with:
```ts
  let connection: AccountingConnection;
  try {
    connection = await withSystemDbAccessContext(() => upsertConnection(db, state.partnerId, provider, {
      realmId: tokens.realmId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      environment: QBO_ENVIRONMENT as 'sandbox' | 'production',
      // Explicit null, not omission: upsertConnection's conflict set strips
      // undefined, so omitting this would carry a PREVIOUS realm's home currency
      // across a reconnect. Unknown must fail closed at push time instead
      // (multi-currency §11).
      homeCurrency: null,
      status: 'connected',
      lastError: null,
      connectedBy: state.userId,
    }));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.error('[accounting] QuickBooks connection persist failed', { partnerId: state.partnerId, provider });
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect('/integrations?accounting=quickbooks&error=persist_failed#accounting');
  }
```
- [ ] **Step 5: Add the non-fatal capture** immediately after that block and before the `deleteCookie` at `:261`:
```ts
  // Capture the realm's home currency (multi-currency §11). NON-FATAL by design:
  // the connection is already live and usable for customer import, and the
  // invoice-push guard fails closed on a NULL home currency, so a Preferences
  // outage must never turn a successful OAuth grant into a connect error.
  // The QBO call runs with no ambient DB context; the write is a short
  // compare-and-set on the row we just persisted.
  try {
    const homeCurrency = await runOutsideDbContext(() => providerClient.fetchHomeCurrency(connection));
    if (homeCurrency && connection.updatedAt) {
      // The generation this capture belongs to: the row as we just wrote it
      // (updatedAt) AND the realm we just exchanged for. A reconnect to another
      // realm in between — even inside the same millisecond — aborts the write.
      await withSystemDbAccessContext(() => updateHomeCurrency(
        db,
        connection.id,
        state.partnerId,
        { updatedAt: connection.updatedAt as Date, realmId: tokens.realmId },
        homeCurrency,
      ));
    } else {
      console.warn('[accounting] QuickBooks home currency unavailable', { partnerId: state.partnerId, provider });
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.warn('[accounting] QuickBooks home currency capture failed', { partnerId: state.partnerId, provider });
  }
```
- [ ] **Step 6: Expose it on the status route.** In the `GET /:provider` handler, add `homeCurrency: null,` to the disconnected payload (`:280-286`) and `homeCurrency: connection.homeCurrency,` to the connected payload (`:288-296`). Do not add it to `settingsSchema` (`:73-79`) — it is a captured external fact, not a partner setting, and `PATCH /:provider/settings` must never accept it.
- [ ] **Step 7: Run the route suite.** `pnpm --filter @breeze/api exec vitest run src/routes/accounting/index.test.ts src/routes/accounting/customers.test.ts` → all PASS, including the pre-existing state/cookie/CSRF/expiry cases at `:154-241`.
- [ ] **Step 8: Prove the non-fatal path is not vacuous.** Temporarily remove the `try`/`catch` around the capture block and re-run — case 2 ("Preferences failure is non-fatal") must FAIL with an unhandled error. Restore it.
- [ ] **Step 9: Audit the logging AND the telemetry.** `grep -n "console\.\(error\|warn\)" apps/api/src/routes/accounting/index.ts` — every call must pass only `{ partnerId, provider }`; no `query.code`, `realmId`, token, or QBO body may appear. Then `grep -n "captureException" apps/api/src/routes/accounting/index.ts` and confirm each captured error is either a sanitized provider error (Task 4 attaches only `status` + `operation`) or a local error whose message contains no secret — console discipline alone does not protect Sentry, which is the path case 5b pins.
- [ ] **Step 10: Commit** — `feat(api): capture the QBO realm home currency at connect, non-fatally (#3780)`.

---

### Task 8: Full verification + PR

**Executor: claude**

- [ ] **Step 1: Unit + build.**
```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm build
```
- [ ] **Step 2: The wave-8 accounting surface, one invocation.**
```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/accounting/types.test.ts \
  src/services/accounting/accountingCurrency.test.ts \
  src/services/accounting/quickbooksProvider.test.ts \
  src/services/accounting/accountingConnectionService.test.ts \
  src/services/accounting/accountingTokens.test.ts \
  src/services/accounting/providerRegistry.test.ts \
  src/services/accounting/quickbooksCustomerImport.test.ts \
  src/routes/accounting/index.test.ts \
  src/routes/accounting/customers.test.ts \
  src/services/stripeCheckoutCallSites.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p apps/api/tsconfig.json  # types.test.ts is enforced by tsc (CI typecheck job), NOT by vitest --typecheck
```
- [ ] **Step 3: The §10 Stripe baseline, unchanged.**
```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/partnerStripe.test.ts \
  src/services/stripeCheckoutErrors.test.ts \
  src/services/invoiceCheckout.test.ts \
  src/routes/stripeConnect/index.test.ts \
  src/routes/portal/invoices.test.ts \
  src/jobs/stripeAccountCacheRefresh.test.ts
```
- [ ] **Step 4: Integration (postgres `:5441` / redis `:6391`).**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts \
  src/__tests__/integration/accounting-connections-rls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
(If the integration run looks hung, it isn't — see the `integration_suite_needs_fsync_off_tmpfs_locally` note.)
- [ ] **Step 5: Prove the "no migration, no registration" claims.**
```bash
git diff --name-only main...HEAD -- apps/api/migrations          # must be EMPTY
grep -rn accounting_connections apps/api/src/services/tenantCascade.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/core.ts   # must be EMPTY
grep -n "accounting_connections" apps/api/src/__tests__/integration/rls-coverage.integration.test.ts  # PARTNER_TENANT_TABLES, unchanged
```
- [ ] **Step 6: Prove the §10 freeze held.**
```bash
git diff --name-only main...HEAD -- apps/api/src | grep -Ei 'stripe|invoiceCheckout|partnerStripe' || echo 'no stripe source touched'
```
Scoped to `apps/api/src` deliberately: an unscoped diff also matches this plan document (`docs/superpowers/plans/billing/2026-08-23-multi-currency-wave8-stripe-qbo-seam.md` contains "stripe" in its name), which would make the check permanently "fail" against its own record. Within `apps/api/src` the only permitted match is the new `apps/api/src/services/stripeCheckoutCallSites.test.ts`.
- [ ] **Step 7: Sweep for a forgotten caller of ALL FOUR newly-typed methods.** `voidInvoice` must be in the sweep — it is one of the four retyped methods, and it is the one an unrelated function shares a name with, so filter rather than omit:
```bash
# The three uniquely-named methods plus the new fetch.
grep -rn "pushInvoice\|upsertCustomer\|upsertItem\|fetchHomeCurrency" apps/api/src ee | grep -v "\.test\."

# voidInvoice: every hit that is NOT invoiceService's unrelated function. The
# accounting one is only ever reached through a provider handle, so it appears as
# `.voidInvoice(` on a provider/registry value.
grep -rn "voidInvoice" apps/api/src ee | grep -v "\.test\." | grep -v "invoiceService"
grep -rn "provider\w*\.voidInvoice(\|providerClient\.voidInvoice(" apps/api/src ee
```
Every hit in the first command must be the interface (`types.ts`), the QuickBooks implementation, or the OAuth callback's `fetchHomeCurrency` call. The second command's hits must be only `types.ts` and `quickbooksProvider.ts`; the third must print **nothing**. A `pushInvoice`/`voidInvoice` **caller** appearing anywhere means Phase C started inside this wave — stop and remove it (and note that Phase C, when it does ship, owes the guarded coordinator plus the static call-site gate recorded at the bottom of `accountingCurrency.ts`).
- [ ] **Step 8: One independent review round** (repo policy: at most one, unless a fix itself touches a high-blast-radius surface — re-review any fix that changes the OAuth/RLS context sequencing or the compare-and-set predicate in Task 5/7).
- [ ] **Step 9: Push the branch and OPEN the PR** — `gh pr create --base main --head feature/3772-multi-currency/wave-3780`. Title: `feat: multi-currency wave 8 — Stripe §10 freeze + typed QBO accounting seam (#3780)`. Body must state: §10 was already complete in waves 5-6 and this wave adds only the call-site freeze test (list the eight verified §10 bullets with their file:line); the typed `AccountingProvider` payloads carrying `currencyCode` (B8), including the deliberate `voidInvoice(conn, invoice, mapping)` arity extension beyond the Phase-A sketch, and that zero production callers existed, so there is no blast radius; `Preferences.CurrencyPrefs.HomeCurrency.value` capture (never CompanyInfo) into the previously-dead `accounting_connections.home_currency`; the explicit `homeCurrency: null` on reconnect and the realm-generation compare-and-set (row `FOR UPDATE`, decrypted realm id compared, `updated_at` as a second barrier), with the same-millisecond reconnect race it prevents and why an `updated_at`-only predicate could not; the non-fatal capture policy; the fail-closed guard PRIMITIVE (mismatch AND unknown both block) and why it diverges from Stripe's warn-don't-block — stated honestly as "the guard exists and is typed to the interface; enforcement is a Phase-C obligation (one guarded coordinator + a static call-site gate) recorded in `accountingCurrency.ts`", not as "pushes are guarded today"; the payment pull-back order (equality asserted before `fromMinorUnits`) and its positive-amount rule (zero and negative are rejected — refunds/credit memos are §12 non-goals and would otherwise raise an invoice balance through the payment path); the Phase-D contract's invoice-first lock order; the deferred Phase-C/Phase-D integration contract recorded in `accountingCurrency.ts`; **no migration and no tenancy/cascade/export registration change**, with the greps that prove it; and that foreign-currency QBO push (`CurrencyRef`/`ExchangeRate`) plus cross-currency payments remain out of scope. The PR targets `main` (not stacked), so Integration Tests run on the PR itself. Body ends with `Closes #3780`.
- [ ] **Step 10: STOP.** This task ends at an open PR. Do not merge — the orchestrator runs the review round and merges.

---

## Self-Review Notes

- **Spec coverage — §10.** Every bullet was verified as merged in this worktree at `8066aedb0` before writing a task, and each is cited with a file:line in Global Constraints: account-currency + country cache on key save, `refreshed_at` stamp, explicit refresh action + route, TTL re-check, warn-don't-block mismatch, friendly `checkout.sessions.create` mapping, reconnect-required/unknown states, bootstrap + daily job, invoice currency passed to checkout, `stripeReconcile` mismatch guard. The wave's only §10 deliverable is Task 1's static freeze, which pins the one invariant a future PR could quietly break (a third checkout call site with no error mapping). §13's wave-8 phrase "Stripe metadata polish" is deliberately **not** implemented: §10 states no metadata requirement, the wave-8 brief's deliverables list does not include one, and adding a currency field to `checkout.sessions.create` metadata would edit two shipped Stripe call sites for no spec-required benefit. Flagged here for the owner rather than silently built or silently dropped.
- **Spec coverage — §11.** "Type the interface now" → Task 2 (all four methods, every money-bearing payload carrying `currencyCode`; arity follows the Phase-A design doc `:116-119`, except `voidInvoice`, which deliberately gains the payload argument so no method sits outside the currency contract). "At connect, fetch from `Preferences.CurrencyPrefs.HomeCurrency` (not CompanyInfo)" → Task 4 (the mapper reads `.value` because Intuit returns a reference object; a test asserts the URL contains `/preferences` and NOT `companyinfo`) and Task 7 (the connect wiring). "Persist to the existing-but-dead `accounting_connections.home_currency`" → Tasks 5-7, with Task 6 proving it against real Postgres under partner RLS. "Implement the documented-but-never-built guard… unit contract now, integration test with the push entrypoint" → Task 3, which ships the guard as a typed primitive with its unit contract — honestly scoped, since nothing can call it yet — and records the Phase-C enforcement obligation (one guarded coordinator, a static call-site gate over `.pushInvoice`/`.voidInvoice`, then the integration test) inside the module itself. "Payment pull-back must convert via `fromMinorUnits` and assert currency equality before applying" → Task 3's `normalizeAccountingPayment`, where the equality assertion precedes the conversion and the order is asserted by a test. "`CurrencyRef` + `ExchangeRate` deferred" → Global Constraints forbid both; Task 3's mismatch message is explicitly tested not to promise conversion.
- **Bug B8.** Both halves of the claim were re-verified against this worktree, not taken on trust: the four varargs are at `types.ts:61-64`, and `home_currency` has **zero** writers (its only mentions are the migration, the schema, the service field/passthroughs and four test fixtures). Zero production callers of the four methods means Task 2 is a free, non-breaking retype.
- **Codex review, folded in (2026-08-23).** Seven majors and three minors were checked against this worktree; eight were applied and none were rejected on the merits: `voidInvoice` gained a currency-bearing payload (Task 2) even though the Phase-A sketch omits one, because §11 says all four methods; the guard is now described as a primitive with a Phase-C enforcement contract — a guarded coordinator plus a static call-site gate — and its parameter type is DERIVED from `Parameters<AccountingProvider['pushInvoice']>[1]` rather than re-declared (Task 3); Task 1's freeze test parses the TypeScript AST, counts call expressions per file and proves each call is enclosed by a `catch` that CALLS the mapper (the file-count and unused-import false negatives are both mutation-tested); Task 4's error is sanitized to `status` + `operation` with **no** response body, because Task 7 hands it to `captureException` and console discipline does not protect Sentry (Task 7 gains an executable assertion); Task 5's compare-and-set became a realm-generation check under a row lock, since `upsertConnection` stamps an application `new Date()` (`accountingConnectionService.ts:126`) and two same-millisecond reconnects can share `updated_at`; `normalizeAccountingPayment` now requires a strictly positive amount (zero is not a payment, negative is a refund/credit memo — a §12 non-goal that would have INCREASED an invoice balance); the deferred Phase-D contract now states the established invoice-first lock order (`invoiceService.ts:1305-1314`); and the two minors — Task 8's Stripe grep matching this plan file, and the sweep omitting `voidInvoice` — are fixed. The tenancy/DDL findings were "no defect", consistent with the constraints above.
- **Type consistency.** Money is a major-unit decimal `string` in every DTO (spec §12 keeps `numeric` major-unit storage), and `quantity` is a string too so no binary float enters the seam. `ChangeSet.payments[].amountMinor` stays a `number` (unchanged shape — it is the provider's wire format) and gains a doc comment naming `fromMinorUnits` as the only sanctioned conversion. `fromMinorUnits` returns fixed-2 for both exponents (`1234 JPY → "1234.00"`, `1234 USD → "12.34"`, `packages/shared/src/utils/currency.ts:72-76`), which matches `invoice_payments.amount numeric(_,2)`; the Task-3 tests pin both branches. The guard and the normalizer bind their fixtures to `Parameters<AccountingProvider['pushInvoice']>` rather than re-declaring the payload shape, so Task 2 and Task 3 cannot drift.
- **Deliberate divergence from §10, stated once and not relitigated.** Stripe warns; accounting blocks. A Stripe mismatch still charges the payer in the document's own currency, whereas a QBO push into a differently-denominated (or unknown) realm mis-books a ledger with no in-band signal. Hence both `ACCOUNTING_INVOICE_CURRENCY_MISMATCH` and `ACCOUNTING_HOME_CURRENCY_UNKNOWN` are hard 409s.
- **No FK, no `currencyCodeSchema`, no migration.** `home_currency` caches an external fact, exactly like the Stripe account-currency columns whose migration header records the same reasoning. Breeze's curated 34-code list excludes the 3-decimal currencies; a realm reporting one must remain connectable and be blocked at push, not at connect. Task 4 and Task 5 each carry a test asserting a non-Breeze code (`BHD`) round-trips, so a later "tidy-up" that adds validation reds immediately.
- **Concurrency.** Wave 8 adds no edge to the wave-6 partial orders and takes exactly one row lock: a single `accounting_connections` row, `FOR UPDATE`, inside `updateHomeCurrency`'s short transaction, with no other lock and no network call held across it. Three races were designed against explicitly: (a) a reconnect to a different realm reusing the same `(partner_id, provider)` row — solved by the explicit `homeCurrency: null` on upsert plus the realm-generation check under the lock; (b) the degenerate form of (a) where both reconnects land in the same millisecond and therefore share an application-stamped `updated_at` — which is exactly why the realm id, not the timestamp, is the generation token (the timestamp remains as a cheaper second barrier for a same-realm double capture), proven by a real-DB case in Task 6; (c) a QBO round-trip holding a pooled connection — solved by `runOutsideDbContext` on the fetch and by keeping the capture write out of the credential upsert.
- **Test-breakage analysis, done before writing the tasks.** Real breaks: `apps/api/src/routes/accounting/index.test.ts` (the provider stub at `:92-98` lacks `fetchHomeCurrency`, and `upsertConnection` resolves `undefined` today — both fixed in Task 7 Step 1). Extensions, not breaks: `quickbooksProvider.test.ts` (its `conn()` fixture already sets `homeCurrency: 'USD'`), `accountingConnectionService.test.ts`. Conditional-only risk: the partial provider stubs in `quickbooksCustomerImport.test.ts:48` and `accountingTokens.test.ts:21` — Task 2 Step 7 says to cast the test, never to loosen the interface. Unaffected and asserted so: `providerRegistry.test.ts`, `accounting-connections-rls.integration.test.ts`, every Stripe suite, and all four tenancy-contract suites (no `org_id`, no new column).
- **Deliberate scope calls flagged for the owner:** (a) Stripe metadata polish NOT built, reasoned above; (b) no `home_currency_refreshed_at` and no refresh job — a QBO realm's home currency is effectively immutable, §11 asks only for connect-time capture, and the guard fails closed on NULL, so the recovery path is "reconnect", not a sweep; (c) `homeCurrency` IS added to the `GET /accounting/:provider` response (one additive field) so an operator can see whether capture succeeded — but **no UI and no locale keys ship in this wave**, keeping the 8-locale `localeParity.test.ts` contract untouched; (d) a manual `POST /:provider/refresh-currency` route was considered and rejected as unrequested surface — reconnect already re-captures.
- **Placeholders:** none. Every file path, line number, signature, command and code block above was read from this worktree at `8066aedb0`. Line numbers are pre-change references — re-grep before editing if an earlier task has already moved them.
