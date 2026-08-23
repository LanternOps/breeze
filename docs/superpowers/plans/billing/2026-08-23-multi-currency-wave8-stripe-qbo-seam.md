---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 8 — Stripe §10 Freeze + QBO Accounting Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor** line; a `codex` task is written to be self-contained (codex sees only that task's text — every path, signature, fixture shape and command it needs is inside the task).

**Goal:** Close spec §10 (Stripe) by **proving it is already complete and pinning that fact with a static contract test** — waves 5 and 6 shipped every §10 bullet — and then deliver spec §11 (accounting seam) plus bug **B8**: a fully typed `AccountingProvider` interface whose money-bearing payloads carry `currencyCode`, connect-time capture of the QBO realm home currency from `Preferences.CurrencyPrefs.HomeCurrency` into the existing-but-dead `accounting_connections.home_currency`, and the documented-but-never-built fail-closed invoice-push currency guard plus the payment pull-back conversion contract, both unit-tested now against the typed interface.

**Architecture:** Four layers, strictly ordered.
1. **Stripe freeze (Task 1).** §10 is merged. The only wave-8 Stripe deliverable is a static contract test that pins the two production `checkout.sessions.create` implementations (`apps/api/src/services/invoiceCheckout.ts:105`, `apps/api/src/routes/portal/invoices.ts:264`) to `mapStripeCheckoutError`, so a third unguarded call site cannot appear. **No Stripe source file is edited in this wave.**
2. **Typed seam (Tasks 2-3).** `apps/api/src/services/accounting/types.ts` gains real payload DTOs (`AccountingCustomerPayload`, `AccountingItemPayload`, `AccountingInvoiceLinePayload`, `AccountingInvoiceLineMapping`, `AccountingInvoicePayload`, `AccountingEntityMapping`) and a `fetchHomeCurrency` method; the four varargs methods get real parameter lists. A new pure module `apps/api/src/services/accounting/accountingCurrency.ts` carries the push guard and the payment pull-back normalizer, both bound to the typed interface via `Parameters<AccountingProvider['pushInvoice']>` so they can never drift from it.
3. **Home-currency capture (Tasks 4-7).** `quickbooksProvider.fetchHomeCurrency` reads `Preferences.CurrencyPrefs.HomeCurrency.value` from `/v3/company/{realmId}/preferences` (never CompanyInfo), a narrow compare-and-set writer `updateHomeCurrency` persists it, a real-DB suite proves partner-axis RLS and the stale-write rejection, and the OAuth callback wires capture in as a **non-fatal** post-persist step.
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
- **Lock order:** unchanged by this wave. The declared global partial orders from wave 6 stand (`organizations -> invoices -> invoice_lines -> contracts -> contract_lines -> time_entries -> ticket_parts`; `organizations -> tickets -> time_entries -> ticket_parts`; `organizations -> contracts / catalog_items`). Wave-8 code acquires **no** row locks: the guard and normalizer are pure, and the OAuth callback runs a short credential upsert, then an HTTP call with **no ambient DB context**, then a short single-row `UPDATE`. Every QBO fetch is wrapped in `runOutsideDbContext` (the #1105 connection-hold class). No helper added here may take an organization lock.
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
- Produces: no exported runtime API — a static source-scanning contract test (same technique as `apps/api/src/config/composeBindMounts.test.ts`, which parses tracked files and fails on a contract violation).
- Consumes: `node:fs`, `node:path`.

- [ ] **Step 1: Write the failing test.** Create `apps/api/src/services/stripeCheckoutCallSites.test.ts` with exactly this content:
```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
 * Wave 8 adds no Stripe behaviour; §10 was completed in waves 5-6.
 */
const SRC_ROOT = join(__dirname, '..');

const EXPECTED_CALL_SITES = [
  'services/invoiceCheckout.ts',
  'routes/portal/invoices.ts',
].sort();

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

/** Strips // line comments and block comments so a mention in prose never counts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('Stripe checkout call-site contract (multi-currency §10)', () => {
  const files = listSourceFiles(SRC_ROOT);

  const callSites = files
    .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('checkout.sessions.create'))
    .map((file) => relative(SRC_ROOT, file).split('\\').join('/'))
    .sort();

  it('has exactly the two known production checkout.sessions.create call sites', () => {
    expect(callSites).toEqual(EXPECTED_CALL_SITES);
  });

  it('maps currency failures through mapStripeCheckoutError at every call site', () => {
    for (const relPath of callSites) {
      const source = readFileSync(join(SRC_ROOT, relPath), 'utf8');
      expect(source, `${relPath} creates a Stripe Checkout session without mapStripeCheckoutError`)
        .toContain('mapStripeCheckoutError');
    }
  });

  it('keeps the customer-safe currency message on the shared mapper', async () => {
    const mod = await import('./stripeCheckoutErrors');
    expect(typeof mod.mapStripeCheckoutError).toBe('function');
    expect(mod.CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE).toBeTruthy();
  });
});
```
- [ ] **Step 2: Run it.** `pnpm --filter @breeze/api exec vitest run src/services/stripeCheckoutCallSites.test.ts` → all three cases PASS on the current tree (this is a freeze, not a red-first feature).
- [ ] **Step 3: Prove it is not vacuous.** Temporarily delete the string `mapStripeCheckoutError` from the import line `apps/api/src/routes/portal/invoices.ts:25` (change it to `import { CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE } from '../../services/stripeCheckoutErrors';` and comment out the usage at `:308`), re-run the command from Step 2, and confirm the second case FAILS. Then `git checkout -- apps/api/src/routes/portal/invoices.ts` to restore it exactly.
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

Money values stay **major-unit decimal strings**, matching the storage non-goal in spec §12 ("Storage stays `numeric` major units (no integer-cents migration)"). Quantity is a string too, so no binary float enters at the provider boundary. Arity follows the Phase-A design doc `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md:120-127`: `upsertCustomer(conn, customer, mapping)`, `upsertItem(conn, item, mapping)`, `pushInvoice(conn, invoice, lineMappings)`, `voidInvoice(conn, mapping)`.

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts` (add DTOs after `RemoteRef` at `:37-41`; document `ChangeSet.payments[].amountMinor` at `:43-51`; replace the interface body at `:54-67`)
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts` (import list `:4-12`; stub signatures `:150-164`)
- Create: `apps/api/src/services/accounting/types.test.ts`

**Interfaces:**
- Produces: `AccountingEntityMapping`, `AccountingCustomerPayload`, `AccountingItemPayload`, `AccountingInvoiceLinePayload`, `AccountingInvoiceLineMapping`, `AccountingInvoicePayload`, and the retyped `AccountingProvider` (including a new `fetchHomeCurrency(conn: AccountingConnection): Promise<string | null>` — implemented in a later task; the stub added here throws).
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

  it('voidInvoice takes a connection and a required mapping', () => {
    expectTypeOf<Parameters<AccountingProvider['voidInvoice']>>().toEqualTypeOf<
      [AccountingConnection, AccountingEntityMapping]
    >();
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
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @breeze/api exec vitest run --typecheck src/services/accounting/types.test.ts` → fails (the DTOs do not exist and the methods are varargs).
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
    _mapping: AccountingEntityMapping,
  ): Promise<void> {
    throw new Error('NotImplemented: Phase C');
  }
```
- [ ] **Step 7: Run the type test and the accounting unit suites.**
```bash
pnpm --filter @breeze/api exec vitest run --typecheck src/services/accounting/types.test.ts
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

### Task 3: The accounting currency contract — push guard + payment pull-back

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. **Task 2 must be complete** — this task imports the DTOs it added to `apps/api/src/services/accounting/types.ts` (`AccountingInvoicePayload`, `AccountingProvider`, `ChangeSet`).

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
export function assertAccountingInvoicePushCurrency(
  connection: Pick<AccountingConnection, 'provider' | 'homeCurrency'>,
  invoice: Pick<AccountingInvoicePayload, 'currencyCode'>,
): void;
export interface NormalizedAccountingPayment { invoiceId: string; remoteInvoiceId: string; remotePaymentId: string; amount: string; currencyCode: string; txnDate: string }
export function normalizeAccountingPayment(
  payment: ChangeSet['payments'][number],
  invoice: Pick<AccountingInvoicePayload, 'invoiceId' | 'currencyCode'>,
): NormalizedAccountingPayment;
```
- Consumes: `fromMinorUnits` from `@breeze/shared`; `AccountingConnection`; `AccountingInvoicePayload`, `ChangeSet` from `./types`.

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

  it('rejects a non-integer, non-finite or unsafe minor amount instead of producing NaN', () => {
    for (const bad of [Number.NaN, 12.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
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
import type { AccountingInvoicePayload, ChangeSet } from './types';

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
  invoice: Pick<AccountingInvoicePayload, 'currencyCode'>,
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
  invoice: Pick<AccountingInvoicePayload, 'invoiceId' | 'currencyCode'>,
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

  if (!Number.isSafeInteger(payment.amountMinor)) {
    throw new AccountingCurrencyContractError(
      `Payment ${payment.remotePaymentId} reported a non-integer minor-unit amount; refusing to guess a major-unit value.`,
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
  Restore again and re-run Step 4 to green before continuing.
- [ ] **Step 6: Record the deferred integration contract** by appending this comment block to the bottom of `apps/api/src/services/accounting/accountingCurrency.ts`:
```ts
/*
 * DEFERRED INTEGRATION CONTRACT (multi-currency §11, wave 8 → Phase C/D).
 *
 * No integration test ships with this module because no push or payment
 * entrypoint exists yet: QuickbooksProvider.pushInvoice / voidInvoice are
 * `NotImplemented: Phase C` and reconcileChanges is `NotImplemented: Phase D`,
 * and the entity-mapping table that would resolve a remote invoice id is not in
 * the repo. When those entrypoints ship, they MUST bring:
 *
 *  1. apps/api/src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts —
 *     seed a USD QBO connection + an EUR invoice, call the real push entrypoint,
 *     assert ACCOUNTING_INVOICE_CURRENCY_MISMATCH, assert NO QBO request was
 *     made and NO sync/mapping state was persisted; plus a null-home-currency
 *     case asserting ACCOUNTING_HOME_CURRENCY_UNKNOWN with reconnect guidance.
 *     assertAccountingInvoicePushCurrency must run immediately after the typed
 *     connection + invoice payload are loaded and BEFORE any network call.
 *  2. A Phase-D suite proving normalizeAccountingPayment runs AFTER the remote
 *     invoice mapping is resolved and BEFORE any invoice_payments row is written,
 *     and that re-delivering the same remotePaymentId applies at most once.
 */
```
Re-run Step 4's command to confirm the file still compiles and passes.
- [ ] **Step 7: Commit** — `feat(api): fail-closed accounting currency guard + payment pull-back conversion (#3780)`.

---

### Task 4: Fetch the QBO realm home currency from `Preferences.CurrencyPrefs`

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. **Task 2 must be complete** (it added the `fetchHomeCurrency` member to `AccountingProvider` and a throwing stub to `QuickbooksProvider`). Spec §11: *"At connect, fetch the realm's home currency from **`Preferences.CurrencyPrefs.HomeCurrency`** (not CompanyInfo) and persist it to the existing-but-dead `accounting_connections.home_currency`."*

Intuit returns `HomeCurrency` as a **reference object**, so the code is at `Preferences.CurrencyPrefs.HomeCurrency.value` — not a bare string, and never from CompanyInfo. The endpoint is `GET {base}/v3/company/{realmId}/preferences?minorversion=70`.

Follow the HTTP conventions already in the file at `apps/api/src/services/accounting/quickbooksProvider.ts:103-144` exactly: realmId/accessToken preconditions (`:107-108`), the `runOutsideDbContext(() => fetch(...))` wrapper (`:118` — mandatory; a QBO round-trip must never hold a pooled DB connection, the #1105 class), `Authorization: Bearer` + `Accept: application/json` headers, and the non-2xx path that throws an `Error` carrying `status` and a 500-char-truncated `body` (`:128-134`). Module constants already present: `qboApiBase` (`:21`), `QBO_API_MINOR_VERSION = '70'` (`:18`).

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

  it('throws a typed error carrying status and a truncated body on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(900), { status: 403 }));

    await expect(quickbooksProvider.fetchHomeCurrency(conn())).rejects.toMatchObject({
      status: 403,
      body: 'x'.repeat(500),
    });
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
      const body = await response.text().catch(() => '');
      const err = new Error(`QuickBooks preferences request failed with ${response.status}`);
      (err as Error & { status?: number; body?: string }).status = response.status;
      (err as Error & { status?: number; body?: string }).body = body.slice(0, 500);
      throw err;
    }

    return mapQboHomeCurrency(await response.json() as QboRawPreferences);
  }
```
- [ ] **Step 5: Run the suite.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts` → all PASS (existing `mapQboAddress`/`mapQboCustomer`/`listRemoteCustomers` cases included).
- [ ] **Step 6: Typecheck.** `pnpm --filter @breeze/api build` → clean.
- [ ] **Step 7: Commit** — `feat(api): read the QBO realm home currency from Preferences.CurrencyPrefs (#3780)`.

---

### Task 5: Compare-and-set writer for `accounting_connections.home_currency`

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave8`, branch `feature/3772-multi-currency/wave-3780`. The `home_currency` column exists (`apps/api/src/db/schema/accounting.ts:15`; SQL `apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql:11`) but nothing writes it — bug **B8**'s dead column. **No migration is needed or permitted in this task.**

The write must be a **narrow UPDATE**, not a second `upsertConnection`: an upsert could resurrect a disconnected row with default status/settings but no usable credentials. It must also be a **compare-and-set on `updated_at`**: the unique `(partner_id, provider)` index (`apps/api/src/db/schema/accounting.ts:28-29`) means a reconnect to a *different realm* reuses the same row id, so without a version predicate a slow Preferences response from realm A could overwrite realm B's freshly captured currency.

Follow the existing precedent in the same file: `updateTokens` (`apps/api/src/services/accounting/accountingConnectionService.ts:187-213`) and `markStatus` (`:215-237`) both use `.returning({ id: accountingConnections.id })` and **throw** on zero rows, because an RLS-context mismatch would otherwise fail silently (comment at `:193-195`).

**Files:**
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts` (insert the new function between `updateTokens`, ending `:213`, and `markStatus`, starting `:215`)
- Modify: `apps/api/src/services/accounting/accountingConnectionService.test.ts` (its `makeMockDb` helper at `:4-48` already returns `[{ id: ID }]` from `update().set().where().returning()`)

**Interfaces:**
- Produces:
```ts
export async function updateHomeCurrency(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  expectedUpdatedAt: Date,
  homeCurrency: string,
): Promise<void>;
```
- Consumes: `and`, `eq` from `drizzle-orm` (already imported at `:1`), `accountingConnections` (`:2`), `DbExecutor` (`:57`).

- [ ] **Step 1: Write the failing tests.** Append to `apps/api/src/services/accounting/accountingConnectionService.test.ts` inside the existing `describe('accountingConnectionService', ...)` block. `makeMockDb` returns a fixed `[{ id: ID }]` from `update`, so add a local variant for the zero-row case:
```ts
  it('updateHomeCurrency normalizes the code and compare-and-sets on updatedAt', async () => {
    const captured: { row?: any } = {};
    const db = makeMockDb(captured);
    const setSpy = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'x' }]) })) }));
    db.update = vi.fn(() => ({ set: setSpy })) as any;
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await updateHomeCurrency(
      db,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '11111111-1111-1111-1111-111111111111',
      new Date('2026-09-04T00:00:00Z'),
      ' cad ',
    );

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ homeCurrency: 'CAD' }));
  });

  it('updateHomeCurrency accepts a code Breeze cannot bill in (external fact)', async () => {
    const captured: { row?: any } = {};
    const db = makeMockDb(captured);
    const setSpy = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'x' }]) })) }));
    db.update = vi.fn(() => ({ set: setSpy })) as any;
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await updateHomeCurrency(db, 'c1', 'p1', new Date(), 'BHD');

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ homeCurrency: 'BHD' }));
  });

  it('updateHomeCurrency rejects a malformed external value without touching the db', async () => {
    const captured: { row?: any } = {};
    const db = makeMockDb(captured);
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', new Date(), 'DOLLARS')).rejects.toThrow(/home currency/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('updateHomeCurrency throws when no row matched (stale updatedAt or wrong RLS context)', async () => {
    const captured: { row?: any } = {};
    const db = makeMockDb(captured);
    db.update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    })) as any;
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', new Date(), 'USD')).rejects.toThrow(/matched no accounting_connections row/);
  });
```
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingConnectionService.test.ts` → the four new cases fail (`updateHomeCurrency` is not exported).
- [ ] **Step 3: Implement the writer.** Insert into `apps/api/src/services/accounting/accountingConnectionService.ts` between `updateTokens` and `markStatus`:
```ts
/**
 * Persists the provider-reported home currency (multi-currency §11, bug B8).
 *
 * Narrow UPDATE, never a second upsertConnection: an upsert would resurrect a
 * disconnected row with default settings and no usable credentials.
 *
 * Compare-and-set on `expectedUpdatedAt`: the unique (partner_id, provider)
 * index means a reconnect to a DIFFERENT realm reuses this row id, so a slow
 * Preferences response from the previous realm must not overwrite the new one.
 *
 * The value is a cache of an EXTERNAL fact — it is not validated against
 * supported_currencies and carries no FK, because a realm may legitimately run
 * a currency Breeze cannot bill in. The only shape rule is ISO-4217-looking.
 */
export async function updateHomeCurrency(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  expectedUpdatedAt: Date,
  homeCurrency: string
): Promise<void> {
  const normalized = homeCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Refusing to persist a malformed accounting home currency: ${JSON.stringify(homeCurrency)}`);
  }

  const updated = await db
    .update(accountingConnections)
    .set({
      homeCurrency: normalized,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.updatedAt, expectedUpdatedAt)
    ))
    .returning({ id: accountingConnections.id });
  if (updated.length === 0) {
    throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}); the connection changed underneath the capture or the DB context is wrong`);
  }
}
```
- [ ] **Step 4: Run the suite.** `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingConnectionService.test.ts` → all PASS.
- [ ] **Step 5: Prove non-vacuity of the zero-row guard.** Temporarily change `if (updated.length === 0)` to `if (false)` and re-run — the fourth new case must FAIL. Restore it.
- [ ] **Step 6: Confirm no tenancy-registration contract fired.** `accounting_connections` has no `org_id` and no `device_id`, and this task adds no column:
```bash
grep -rn accounting_connections apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/core.ts
git diff --name-only -- apps/api/migrations
```
Both must print **nothing**.
- [ ] **Step 7: Commit** — `feat(api): compare-and-set writer for accounting_connections.home_currency (#3780)`.

---

### Task 6: Real-DB proof — home-currency persistence under partner-axis RLS

**Executor: claude**

Prove the Task-5 writer against real Postgres as the unprivileged `breeze_app` role: partner isolation, the stale-`updatedAt` rejection, and that a non-Breeze currency code persists (no FK, no curated-list validation). Mock-only coverage cannot prove any of the three.

**Files:**
- Create: `apps/api/src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts`

**Interfaces:**
- Produces: no runtime API.
- Consumes: `updateHomeCurrency` (Task 5), `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `type DbAccessContext` from `../../db`, `accountingConnections` from `../../db/schema`, `createPartner` from `./db-utils`. Shape precedent to copy verbatim (including the `import './setup'` first line, the `it.runIf(!!process.env.DATABASE_URL)` gate, the per-test re-seed rule, and the non-vacuity `rolbypassrls` guard): `apps/api/src/__tests__/integration/accounting-connections-rls.integration.test.ts:1-66`.

- [ ] **Step 1: Write the suite.** Create `apps/api/src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts` covering exactly these cases, each re-seeding its own partners (the integration setup truncates tenant data between tests, so a memoized fixture is vacuous):
  1. **system context writes the currency** — seed a connection under `withSystemDbAccessContext`, read back its `updatedAt`, call `updateHomeCurrency(db, id, partnerId, updatedAt, 'cad')`, then re-select and assert `home_currency === 'CAD'`.
  2. **stale `updatedAt` is rejected and does not overwrite** — capture `updatedAt`, perform a second unrelated `UPDATE ... SET updated_at = now()` on the row, then call `updateHomeCurrency` with the ORIGINAL timestamp and assert it rejects with `/matched no accounting_connections row/` **and** that `home_currency` is still `null`.
  3. **partner isolation** — seed the connection under partner B; calling `updateHomeCurrency` inside `withDbAccessContext(partnerCtx(partnerA.id), ...)` must reject with the same zero-row error (RLS hides the row), and a system re-select must show `home_currency` still `null`.
  4. **legitimate partner-A update inside a partner context succeeds** — proves case 3 is not vacuous.
  5. **a code outside Breeze's curated list persists** — `updateHomeCurrency(..., 'BHD')` succeeds and reads back `'BHD'`, proving there is no FK to `supported_currencies` and no `currencyCodeSchema` gate on this column.
  6. **the non-vacuity role guard** — copy the `current_user` / `rolbypassrls` assertion from `accounting-connections-rls.integration.test.ts:53-65` so a mis-symlinked `.env.test` fails loudly instead of passing every isolation case.
- [ ] **Step 2: Run it** (postgres `localhost:5441`, redis `localhost:6391`, from the repo-root `.env.test`):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts
```
All cases PASS.
- [ ] **Step 3: Prove case 2 is not vacuous.** Temporarily drop the `eq(accountingConnections.updatedAt, expectedUpdatedAt)` predicate from `updateHomeCurrency` and re-run — case 2 must FAIL. Restore it and re-run to green.
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
- Consumes: `updateHomeCurrency` from `../../services/accounting/accountingConnectionService`; `providerClient.fetchHomeCurrency` from the registry client already resolved at `:225`.

- [ ] **Step 1: Write the failing tests.** In `apps/api/src/routes/accounting/index.test.ts`:
  - add `fetchHomeCurrency: vi.fn()` and `updateHomeCurrency: vi.fn()` to the hoisted `mocks` object (`:26-33`);
  - add `updateHomeCurrency: mocks.updateHomeCurrency` to the `accountingConnectionService` mock factory (`:82-86`);
  - add `fetchHomeCurrency: mocks.fetchHomeCurrency` to the provider stub returned by `getAccountingProvider` (`:92-98`) — **without this the callback throws `providerClient.fetchHomeCurrency is not a function`**;
  - in `beforeEach` (`:105-112`), give `upsertConnection` a default resolved connection so the callback has a row to update: `mocks.upsertConnection.mockResolvedValue({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', partnerId: authState.partnerId, provider: 'quickbooks', updatedAt: new Date('2026-09-04T00:00:00Z'), homeCurrency: null })` and `mocks.fetchHomeCurrency.mockResolvedValue('CAD')`;
  - extend the existing "callback is NOT behind authMiddleware" case (`:163-187`) to assert `upsertConnection` was called with `expect.objectContaining({ homeCurrency: null })`;
  - add these cases:
    1. **captures and persists** — redirect contains `connected=1`; `fetchHomeCurrency` called with the object `upsertConnection` resolved; `updateHomeCurrency` called with `(expect.anything(), 'aaaaaaaa-…', partnerId, new Date('2026-09-04T00:00:00Z'), 'CAD')`.
    2. **Preferences failure is non-fatal** — `mocks.fetchHomeCurrency.mockRejectedValueOnce(new Error('qbo 403'))`; still 302 to `connected=1`; `updateHomeCurrency` NOT called.
    3. **missing home currency is non-fatal** — `mockResolvedValueOnce(null)`; still `connected=1`; `updateHomeCurrency` NOT called.
    4. **lost compare-and-set is non-fatal** — `mocks.updateHomeCurrency.mockRejectedValueOnce(new Error('updateHomeCurrency matched no accounting_connections row'))`; still `connected=1`.
    5. **credential-persist failure short-circuits** — `mocks.upsertConnection.mockRejectedValueOnce(new Error('boom'))`; redirect contains `error=persist_failed`; `fetchHomeCurrency` NOT called.
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
      await withSystemDbAccessContext(() => updateHomeCurrency(
        db,
        connection.id,
        state.partnerId,
        connection.updatedAt as Date,
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
- [ ] **Step 9: Audit the logging.** `grep -n "console\.\(error\|warn\)" apps/api/src/routes/accounting/index.ts` — every call must pass only `{ partnerId, provider }`; no `query.code`, `realmId`, token, or QBO body may appear.
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
pnpm --filter @breeze/api exec vitest run --typecheck src/services/accounting/types.test.ts
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
git diff --name-only main...HEAD | grep -Ei 'stripe|invoiceCheckout|partnerStripe' || echo 'no stripe source touched'
```
The only permitted match is the new `apps/api/src/services/stripeCheckoutCallSites.test.ts`.
- [ ] **Step 7: Sweep for a forgotten caller of the four newly-typed methods.**
```bash
grep -rn "pushInvoice\|upsertCustomer\|upsertItem\|fetchHomeCurrency" apps/api/src ee | grep -v "\.test\."
```
Every hit must be the interface (`types.ts`), the QuickBooks implementation, or the OAuth callback's `fetchHomeCurrency` call. A `pushInvoice`/`voidInvoice` caller appearing here means Phase C started inside this wave — stop and remove it.
- [ ] **Step 8: One independent review round** (repo policy: at most one, unless a fix itself touches a high-blast-radius surface — re-review any fix that changes the OAuth/RLS context sequencing or the compare-and-set predicate in Task 5/7).
- [ ] **Step 9: Push the branch and OPEN the PR** — `gh pr create --base main --head feature/3772-multi-currency/wave-3780`. Title: `feat: multi-currency wave 8 — Stripe §10 freeze + typed QBO accounting seam (#3780)`. Body must state: §10 was already complete in waves 5-6 and this wave adds only the call-site freeze test (list the eight verified §10 bullets with their file:line); the typed `AccountingProvider` payloads carrying `currencyCode` (B8) and that zero production callers existed, so there is no blast radius; `Preferences.CurrencyPrefs.HomeCurrency.value` capture (never CompanyInfo) into the previously-dead `accounting_connections.home_currency`; the explicit `homeCurrency: null` on reconnect and the `updated_at` compare-and-set, with the realm-generation race they prevent; the non-fatal capture policy; the fail-closed guard (mismatch AND unknown both block) and why it diverges from Stripe's warn-don't-block; the payment pull-back order (equality asserted before `fromMinorUnits`); the deferred Phase-C/Phase-D integration contract recorded in `accountingCurrency.ts`; **no migration and no tenancy/cascade/export registration change**, with the greps that prove it; and that foreign-currency QBO push (`CurrencyRef`/`ExchangeRate`) plus cross-currency payments remain out of scope. The PR targets `main` (not stacked), so Integration Tests run on the PR itself. Body ends with `Closes #3780`.
- [ ] **Step 10: STOP.** This task ends at an open PR. Do not merge — the orchestrator runs the review round and merges.

---

## Self-Review Notes

- **Spec coverage — §10.** Every bullet was verified as merged in this worktree at `8066aedb0` before writing a task, and each is cited with a file:line in Global Constraints: account-currency + country cache on key save, `refreshed_at` stamp, explicit refresh action + route, TTL re-check, warn-don't-block mismatch, friendly `checkout.sessions.create` mapping, reconnect-required/unknown states, bootstrap + daily job, invoice currency passed to checkout, `stripeReconcile` mismatch guard. The wave's only §10 deliverable is Task 1's static freeze, which pins the one invariant a future PR could quietly break (a third checkout call site with no error mapping). §13's wave-8 phrase "Stripe metadata polish" is deliberately **not** implemented: §10 states no metadata requirement, the wave-8 brief's deliverables list does not include one, and adding a currency field to `checkout.sessions.create` metadata would edit two shipped Stripe call sites for no spec-required benefit. Flagged here for the owner rather than silently built or silently dropped.
- **Spec coverage — §11.** "Type the interface now" → Task 2 (all four methods, every money-bearing payload carrying `currencyCode`, arity matched to the Phase-A design doc). "At connect, fetch from `Preferences.CurrencyPrefs.HomeCurrency` (not CompanyInfo)" → Task 4 (the mapper reads `.value` because Intuit returns a reference object; a test asserts the URL contains `/preferences` and NOT `companyinfo`) and Task 7 (the connect wiring). "Persist to the existing-but-dead `accounting_connections.home_currency`" → Tasks 5-7, with Task 6 proving it against real Postgres under partner RLS. "Implement the documented-but-never-built guard… unit contract now, integration test with the push entrypoint" → Task 3, with the deferred integration contract written into the module itself so Phase C cannot ship without it. "Payment pull-back must convert via `fromMinorUnits` and assert currency equality before applying" → Task 3's `normalizeAccountingPayment`, where the equality assertion precedes the conversion and the order is asserted by a test. "`CurrencyRef` + `ExchangeRate` deferred" → Global Constraints forbid both; Task 3's mismatch message is explicitly tested not to promise conversion.
- **Bug B8.** Both halves of the claim were re-verified against this worktree, not taken on trust: the four varargs are at `types.ts:61-64`, and `home_currency` has **zero** writers (its only mentions are the migration, the schema, the service field/passthroughs and four test fixtures). Zero production callers of the four methods means Task 2 is a free, non-breaking retype.
- **Type consistency.** Money is a major-unit decimal `string` in every DTO (spec §12 keeps `numeric` major-unit storage), and `quantity` is a string too so no binary float enters the seam. `ChangeSet.payments[].amountMinor` stays a `number` (unchanged shape — it is the provider's wire format) and gains a doc comment naming `fromMinorUnits` as the only sanctioned conversion. `fromMinorUnits` returns fixed-2 for both exponents (`1234 JPY → "1234.00"`, `1234 USD → "12.34"`, `packages/shared/src/utils/currency.ts:72-76`), which matches `invoice_payments.amount numeric(_,2)`; the Task-3 tests pin both branches. The guard and the normalizer bind their fixtures to `Parameters<AccountingProvider['pushInvoice']>` rather than re-declaring the payload shape, so Task 2 and Task 3 cannot drift.
- **Deliberate divergence from §10, stated once and not relitigated.** Stripe warns; accounting blocks. A Stripe mismatch still charges the payer in the document's own currency, whereas a QBO push into a differently-denominated (or unknown) realm mis-books a ledger with no in-band signal. Hence both `ACCOUNTING_INVOICE_CURRENCY_MISMATCH` and `ACCOUNTING_HOME_CURRENCY_UNKNOWN` are hard 409s.
- **No FK, no `currencyCodeSchema`, no migration.** `home_currency` caches an external fact, exactly like the Stripe account-currency columns whose migration header records the same reasoning. Breeze's curated 34-code list excludes the 3-decimal currencies; a realm reporting one must remain connectable and be blocked at push, not at connect. Task 4 and Task 5 each carry a test asserting a non-Breeze code (`BHD`) round-trips, so a later "tidy-up" that adds validation reds immediately.
- **Concurrency.** Wave 8 acquires no row locks and adds no edge to the wave-6 partial orders. Two races were designed against explicitly: (a) a reconnect to a different realm reusing the same `(partner_id, provider)` row — solved by the explicit `homeCurrency: null` on upsert plus the `updated_at` compare-and-set; (b) a QBO round-trip holding a pooled connection — solved by `runOutsideDbContext` on the fetch and by keeping both writes as short, separate system-context statements.
- **Test-breakage analysis, done before writing the tasks.** Real breaks: `apps/api/src/routes/accounting/index.test.ts` (the provider stub at `:92-98` lacks `fetchHomeCurrency`, and `upsertConnection` resolves `undefined` today — both fixed in Task 7 Step 1). Extensions, not breaks: `quickbooksProvider.test.ts` (its `conn()` fixture already sets `homeCurrency: 'USD'`), `accountingConnectionService.test.ts`. Conditional-only risk: the partial provider stubs in `quickbooksCustomerImport.test.ts:48` and `accountingTokens.test.ts:21` — Task 2 Step 7 says to cast the test, never to loosen the interface. Unaffected and asserted so: `providerRegistry.test.ts`, `accounting-connections-rls.integration.test.ts`, every Stripe suite, and all four tenancy-contract suites (no `org_id`, no new column).
- **Deliberate scope calls flagged for the owner:** (a) Stripe metadata polish NOT built, reasoned above; (b) no `home_currency_refreshed_at` and no refresh job — a QBO realm's home currency is effectively immutable, §11 asks only for connect-time capture, and the guard fails closed on NULL, so the recovery path is "reconnect", not a sweep; (c) `homeCurrency` IS added to the `GET /accounting/:provider` response (one additive field) so an operator can see whether capture succeeded — but **no UI and no locale keys ship in this wave**, keeping the 8-locale `localeParity.test.ts` contract untouched; (d) a manual `POST /:provider/refresh-currency` route was considered and rejected as unrequested surface — reconnect already re-captures.
- **Placeholders:** none. Every file path, line number, signature, command and code block above was read from this worktree at `8066aedb0`. Line numbers are pre-change references — re-grep before editing if an earlier task has already moved them.
