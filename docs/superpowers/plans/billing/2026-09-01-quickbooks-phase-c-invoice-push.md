# QuickBooks Phase C — Invoice Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push issued Breeze invoices to QuickBooks Online (auto-on-issue via BullMQ or manual, partner-configurable), push Void on void, surface per-invoice sync status, and land the multi-currency seams (realm `MultiCurrencyEnabled` capture, settings refresh, customer currency persistence) so foreign-currency push is a branch later, not a rewrite.

**Architecture:** One guarded coordinator (`pushInvoiceToAccounting` / `voidInvoiceInAccounting` in a new `accountingInvoicePush.ts`) is the ONLY caller of `provider.pushInvoice`/`voidInvoice` — enforced by an AST call-site gate test. The QBO provider stays transport-only. Auto-push rides a new `accounting-sync` BullMQ worker enqueued post-commit from `issueInvoice`/`voidInvoice`. Invoice mapping rows reuse `accounting_entity_mappings` (constraints + partner trigger arms already shipped in Phase B). Home-currency-only push for now (quorum ruling 2026-09-01): foreign-currency invoices get a clear, typed per-invoice error, never a silent skip.

**Tech Stack:** Hono, Drizzle, BullMQ, Vitest (unit + real-Postgres integration), React (web), QBO REST v3 minorversion=70.

**Spec:** `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md` (§ Push: Invoice, § Tax handling, § Observability). The in-code Phase C contract at `apps/api/src/services/accounting/accountingCurrency.ts:143-186` is binding. Quorum ruling: ship the home-currency rule + multi-currency seams now; foreign push (CurrencyRef, no ExchangeRate) is the next slice.

## Global Constraints

- Branch off **main AFTER PR #4372 (Phase B) merges**. Commit this plan file as the first commit.
- Migration file MUST be named `2026-09-30-quickbooks-invoice-push.sql` — it must sort after `2026-09-28-quickbooks-entity-mappings.sql` (Phase B, newest committed). Never use today's real date. Idempotent; no inner BEGIN/COMMIT.
- Money is **major-unit decimal strings** end-to-end; convert to JSON number only at the QBO wire (`Number(...)`), and compare totals in integer cents.
- Every QBO HTTP call wraps in `runOutsideDbContext(...)`; every new accounting route that triggers one registers in `SELF_MANAGED_DB_CONTEXT_ROUTES` (`apps/api/src/middleware/selfManagedDbContextRoutes.ts:50-64`).
- Never persist or rethrow a raw QBO response body — sanitize to `QuickBooks rejected the <label> sync (HTTP <status>)` (pattern: `accountingMappingService.ts:826-840`).
- All DB writes follow the zero-row-throw pattern (`.returning({id})` + length check) — a zero-row match is an RLS-context bug, not a no-op.
- BullMQ jobIds must not contain colons.
- Web mutations wrap in `runAction`; new UI strings go through i18n (`t(...)`) with en + all locale files updated (tr-TR parity test is enforced).
- `sync_status` value `'synced_with_tax_variance'` already exists in Postgres; the API and web type unions must be widened wherever this plan touches them.
- The partner-wide-write-coverage exemption at `apps/api/src/__tests__/partner-wide-write-coverage.test.ts:170` asserts accounting workers/erasure run under **system context** — the new worker must honor that.
- Run `pnpm --filter @breeze/api test --run <path>` (never insert `--` before `--run`); integration suites need the real DB (`npx vitest run -c vitest.integration.config.ts <path>` from apps/api).

---

## File Structure

```
apps/api/migrations/2026-09-30-quickbooks-invoice-push.sql          (new)
apps/api/src/db/schema/accounting.ts                                 (modify: 3 new columns)
apps/api/src/services/accounting/types.ts                            (modify: RemoteCustomer.currencyCode, InvoicePushResult, RealmSettings, fetchRealmSettings)
apps/api/src/services/accounting/quickbooksProvider.ts               (modify: pushInvoice, voidInvoice, fetchRealmSettings)
apps/api/src/services/accounting/accountingInvoicePush.ts            (new: the guarded coordinator)
apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts (new: AST gate)
apps/api/src/services/accounting/accountingMappingService.ts         (modify: export resolveConnectionAndToken, persist remoteCurrencyCode, unlink-without-token fix)
apps/api/src/services/accounting/accountingConnectionService.ts      (modify: DTO + multiCurrencyEnabled)
apps/api/src/services/accounting/accountingTokens.ts                 (modify: per-connection refresh lock)
apps/api/src/jobs/accountingSyncWorker.ts                            (new)
apps/api/src/services/workerRegistry.ts                              (modify: register worker)
apps/api/src/services/invoiceService.ts                              (modify: post-commit enqueue hooks)
apps/api/src/routes/accounting/index.ts                              (modify: push routes, settings refresh, remote-candidates)
apps/api/src/routes/invoices/invoices.ts                             (modify: accountingSync on GET /:id)
apps/api/src/middleware/selfManagedDbContextRoutes.ts                (modify)
apps/api/src/services/tenantCascade.ts                               (modify: invoice/payment erasure arms)
apps/api/src/services/orgMerge.ts                                    (modify: invoice/payment merge arms)
apps/api/src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts (new — name mandated by accountingCurrency.ts contract)
apps/web/src/components/billing/AccountingSyncCard.tsx               (new: invoice-detail rail card)
apps/web/src/components/billing/InvoiceDetail.tsx / invoiceTypes.ts  (modify)
apps/web/src/components/billing/InvoicesPage.tsx                     (modify: bulk push)
apps/web/src/components/integrations/QuickbooksIntegration.tsx       (modify: settings refresh + multi-currency badge)
apps/web/src/components/integrations/QuickbooksMappingWorkbench.tsx  (modify: candidate search, variance status)
docs/integrations/quickbooks-sandbox-verification.md                 (modify: Phase C section)
apps/docs/src/content/docs/features/accounting-integrations.mdx      (modify)
```

Decisions locked here (do not relitigate mid-task):
1. **Home-currency-only push.** `assertAccountingInvoicePushCurrency` gates every push; additionally the customer mapping's persisted `remote_currency_code` (when known) must equal the invoice currency. Distinct error codes per failure mode (see Task 3).
2. **Provider `upsert` semantics for invoices**: no mapping row with a remoteEntityId → CREATE; mapping present → sparse UPDATE with SyncToken (re-push/retry path). Breeze invoices are immutable post-issue, so UPDATE only re-sends the same content after a partial failure.
3. **Ad-hoc lines** (unmapped catalog item / manual / time_entry / part lines): `SalesItemLineDetail` with **no ItemRef** (per spec); sandbox checklist verifies QBO's default-item behavior.
4. **All lines are pushed**, including hidden bundle children (zero-priced; parent rollup carries the money) — the spec's "accounting view sees all" rule.
5. **Auto-push enqueues unconditionally** from `issueInvoice`'s post-commit hook; the worker no-ops cheaply when there is no connected QBO connection or `push_mode = 'manual'`. Keeps the hook query-free.
6. **Manual push routes live on the accounting router** (partnerScopes + `requireMfa()` + `PERMISSIONS.INVOICES_WRITE`), consistent with every other accounting mutation.
7. **Invoice mapping rows are machine-managed**: `link_status` goes straight to `create_new` on first push (there is no reconcile/suggest workflow for invoices) and `confirmed` once synced. They never appear in the mapping workbench.
8. **`requireMappingWrite` stays a workbench-only middleware** — its binary else-branch is not extended; Task 5's routes use the invoice permission directly, and a regression test pins that `breezeEntityType: 'invoice'` is rejected by the workbench PUT/POST schema.

---

### Task 1: Provider — `pushInvoice`, `voidInvoice`, `fetchRealmSettings`

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts`
- Modify: `apps/api/src/services/accounting/types.test.ts`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts:413-427` (replace stubs), `:267-313` (fetchRealmSettings)
- Test: `apps/api/src/services/accounting/quickbooksProvider.test.ts` (extend)

**Interfaces:**
- Consumes: existing `qboRequest` helper (`quickbooksProvider.ts:442-474`), `AccountingInvoicePayload` / `AccountingInvoiceLineMapping` / `AccountingVoidInvoicePayload` (`types.ts:92-132`).
- Produces (later tasks rely on these exact names):
  ```ts
  // types.ts additions
  export interface InvoicePushResult extends RemoteRef {
    /** QBO's TxnTaxDetail.TotalTax from the response, major-unit string, null if absent. */
    remoteTaxTotal: string | null;
    /** QBO's TotalAmt from the response, major-unit string, null if absent. */
    remoteTotal: string | null;
  }
  export interface RealmSettings {
    homeCurrency: string | null;
    multiCurrencyEnabled: boolean | null;
  }
  // interface changes
  pushInvoice(...): Promise<InvoicePushResult>;        // return type widened from RemoteRef
  fetchRealmSettings(conn: AccountingConnection): Promise<RealmSettings>;  // REPLACES fetchHomeCurrency
  // RemoteCustomer gains: currencyCode?: string;      // QBO CurrencyRef.value from listing/create
  ```

- [ ] **Step 1: Write failing type-contract + provider tests.** In `types.test.ts` update the pinned tuples: `pushInvoice` returns `Promise<InvoicePushResult>`, `fetchHomeCurrency` is gone, `fetchRealmSettings` returns `Promise<RealmSettings>`. In `quickbooksProvider.test.ts` add (using the file's existing `mockFetch`/connection fixtures):

```ts
describe('pushInvoice', () => {
  it('POSTs a create body with DocNumber, CustomerRef, per-line SalesItemLineDetail and TxnTaxDetail override', async () => {
    mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '0', DocNumber: 'INV-2026-0042', TotalAmt: 107.0, TxnTaxDetail: { TotalTax: 7.0 } } });
    const result = await provider.pushInvoice(conn, invoicePayload({
      docNumber: 'INV-2026-0042', subtotal: '100.00', taxTotal: '7.00', total: '107.00',
      customerRef: { id: '55' },
      lines: [line({ description: 'Onsite support', quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00', taxable: true })],
    }), [{ invoiceLineId: 'l1', remoteItemRef: { id: '77' } }]);
    const body = JSON.parse(lastFetchInit().body as string);
    expect(body.DocNumber).toBe('INV-2026-0042');
    expect(body.CustomerRef).toEqual({ value: '55' });
    expect(body.Line[0]).toMatchObject({
      DetailType: 'SalesItemLineDetail', Amount: 100, Description: 'Onsite support',
      SalesItemLineDetail: { ItemRef: { value: '77' }, Qty: 2, UnitPrice: 50, TaxCodeRef: { value: 'TAX' } },
    });
    expect(body.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: conn.defaultTaxCodeRef }, TotalTax: 7 });
    expect(result).toEqual({ id: '310', syncToken: '0', docNumber: 'INV-2026-0042', remoteTaxTotal: '7', remoteTotal: '107' });
  });
  it('omits ItemRef for an unmapped line and sets TaxCodeRef NON when not taxable', ...);
  it('sends sparse update with Id + SyncToken when a mapping is provided, and throws without a sync token', ...);
  it('omits TxnTaxDetail entirely when the connection has no defaultTaxCodeRef', ...);
  it('retries once WITHOUT DocNumber on a 400 Duplicate Document Number fault and returns QBO’s assigned DocNumber', ...);
  it('throws with attached status/body (sliced) on non-ok, and never sends CurrencyRef', ...);
});
describe('voidInvoice', () => {
  it('POSTs invoice?operation=void with Id + SyncToken from the mapping', ...);
  it('throws when the mapping has no remoteSyncToken', ...);
});
describe('fetchRealmSettings', () => {
  it('returns homeCurrency + MultiCurrencyEnabled from Preferences and null/null on sanitized failure', ...);
});
```
Each `...` body is written out in full during implementation with the same fixture helpers; expected values as in the table:

| Case | Wire expectation |
|---|---|
| unmapped line | `SalesItemLineDetail` present, **no** `ItemRef` key; `TaxCodeRef {value:'NON'}` when `taxable:false` |
| sparse update | body has `sparse: true, Id: '310', SyncToken: '3'`; missing token → `Error('QuickBooks Invoice update requires the current SyncToken')` before any fetch |
| no defaultTaxCodeRef | `TxnTaxDetail` absent from body (QBO derives); coordinator still records variance from response |
| DocNumber collision | first response: 400 with body containing `Duplicate Document Number`; second request body has no `DocNumber`; result.docNumber = response's `DocNumber` |
| voidInvoice | path `invoice?operation=void&minorversion=70`, body `{ Id, SyncToken }` |
| fetchRealmSettings | reads `Preferences[0].CurrencyPrefs.{HomeCurrency,MultiCurrencyEnabled}`, keeps the 8s abort budget and sanitized `preferencesError` path of the old `fetchHomeCurrency` |

- [ ] **Step 2: Run to verify failure.** `cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts src/services/accounting/types.test.ts` — expect FAIL (`NotImplemented: Phase C`, missing exports).
- [ ] **Step 3: Implement.** In `types.ts`: add `InvoicePushResult`, `RealmSettings`, `currencyCode?: string` on `RemoteCustomer`; change `pushInvoice` return type; replace `fetchHomeCurrency` with `fetchRealmSettings`. In `quickbooksProvider.ts`:
  - Rename/reshape `fetchHomeCurrency` → `fetchRealmSettings` (same HTTP call + abort budget + sanitized error; additionally read `MultiCurrencyEnabled`, coercing non-boolean to `null`).
  - `pushInvoice`: build body per the tests; `Number(...)` conversion at the wire only; `sparse/Id/SyncToken` when `mapping?.remoteEntityId`; guard missing sync token pre-fetch; single retry without `DocNumber` when status 400 and attached body matches `/Duplicate Document Number/i`; response guard `parsed.Invoice?.Id`; map `TotalAmt`/`TxnTaxDetail?.TotalTax` to strings via `String(...)` (null when absent).
  - `voidInvoice`: `qboRequest(conn, 'invoice?operation=void&minorversion=70', 'QuickBooks invoice void', { method:'POST', body: JSON.stringify({ Id: mapping.remoteEntityId, SyncToken: mapping.remoteSyncToken }) })`; guard token pre-fetch.
  - `upsertCustomer` + `listRemoteCustomers`: surface `CurrencyRef.value` as `currencyCode` on returned entities (create response and query rows).
  - Update every `fetchHomeCurrency` caller (`routes/accounting/index.ts` OAuth callback + tests) to `fetchRealmSettings().homeCurrency` — leave persisting `multiCurrencyEnabled` to Task 2.
- [ ] **Step 4: Run to verify pass** (same command), plus `npx vitest run src/routes/accounting` (callers updated).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(accounting): implement QBO invoice push/void transport and realm settings fetch"`

---

### Task 2: Migration + connection/mapping columns + settings refresh

**Files:**
- Create: `apps/api/migrations/2026-09-30-quickbooks-invoice-push.sql`
- Modify: `apps/api/src/db/schema/accounting.ts`, `accountingConnectionService.ts`, `accountingMappingService.ts` (persist customer currency), `routes/accounting/index.ts` (callback persists multiCurrencyEnabled; new `POST /:provider/settings/refresh`), `middleware/selfManagedDbContextRoutes.ts`
- Test: `accountingConnectionService.test.ts`, `accountingMappingService.test.ts`, `routes/accounting/index.test.ts`, `apps/api/src/db/autoMigrate.test.ts` (auto-covers naming)

**Interfaces:**
- Produces:
  - Columns: `accounting_connections.multi_currency_enabled boolean` (nullable = unknown); `accounting_entity_mappings.remote_currency_code char(3)` (nullable); `accounting_entity_mappings.remote_doc_number varchar(40)` (nullable — QBO-assigned DocNumber on collision).
  - `AccountingConnection` DTO gains `multiCurrencyEnabled: boolean | null` (mapped in `mapConnection`).
  - `refreshRealmSettings(partnerId: string, provider: 'quickbooks'): Promise<{ homeCurrency: string | null; multiCurrencyEnabled: boolean | null }>` exported from `accountingConnectionService.ts` (uses `updateHomeCurrency`'s CAS when currency changed; plain guarded UPDATE for the flag).
  - Route `POST /accounting/:provider/settings/refresh` (auth, partnerScopes, requireMfa) → `{ homeCurrency, multiCurrencyEnabled }`, audits `accounting.settings.refresh`.

- [ ] **Step 1: Write the migration** (idempotent):
```sql
-- 2026-09-30-quickbooks-invoice-push.sql
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS multi_currency_enabled boolean;
ALTER TABLE accounting_entity_mappings ADD COLUMN IF NOT EXISTS remote_currency_code char(3);
ALTER TABLE accounting_entity_mappings ADD COLUMN IF NOT EXISTS remote_doc_number varchar(40);
```
(No RLS changes — both tables already ENABLE+FORCE with partner policies; no new table.)
- [ ] **Step 2: Failing tests.** Schema drift: run `pnpm db:migrate && pnpm db:check-drift` after editing `schema/accounting.ts` — drift check red until both sides agree. Unit: `accountingConnectionService.test.ts` — `refreshRealmSettings` persists both fields and aborts home-currency write on CAS conflict (reuse `AccountingHomeCurrencyCasAbortError` fixtures); `mapConnection` surfaces `multiCurrencyEnabled`. `accountingMappingService.test.ts` — `saveMappingDecision('confirmed')` persists `remoteCurrencyCode` from the live listing row; `syncMappedEntity` create-path persists it from the create response. Route test: callback stores `multiCurrencyEnabled`; refresh route returns 409 mapping for `reauth_required`, 404 when not connected, audits.
- [ ] **Step 3: Implement.** Schema columns; DTO + `mapConnection`; `refreshRealmSettings` (resolve connection → live token → `provider.fetchRealmSettings` → persist; wrap the QBO call in `runOutsideDbContext`); OAuth callback persists the flag alongside `home_currency`; mapping service threads `currencyCode` from `RemoteCustomer` into `upsertMappingRow`/`persistRemoteRef` writes (org rows only; null for items). Register the refresh route in `SELF_MANAGED_DB_CONTEXT_ROUTES`.
- [ ] **Step 4: Verify.** Targeted vitest files green; `pnpm db:check-drift` clean; `npx vitest run src/db/autoMigrate.test.ts` green (naming/order).
- [ ] **Step 5: Commit.** `feat(accounting): capture realm multi-currency flag, customer currency, and settings refresh`

---

### Task 3: The guarded coordinator + AST call-site gate

**Files:**
- Create: `apps/api/src/services/accounting/accountingInvoicePush.ts`
- Create: `apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts` (model: `apps/api/src/services/stripeCheckoutCallSites.test.ts`)
- Modify: `accountingMappingService.ts` (export `resolveConnectionAndToken`; widen `MappingProposal['syncStatus']` union with `'synced_with_tax_variance'`)
- Test: `apps/api/src/services/accounting/accountingInvoicePush.test.ts`

**Interfaces:**
- Consumes: `resolveConnectionAndToken(partnerId, provider)` (newly exported), `syncMappedEntity`, `assertAccountingInvoicePushCurrency` + `AccountingCurrencyContractError` (`accountingCurrency.ts`), `getAccountingProvider`, `InvoicePushResult` (Task 1), mapping helpers (`persistRemoteRef`-equivalent writes are reimplemented locally against the invoice row — see Step 3).
- Produces:
```ts
export type AccountingInvoicePushErrorCode =
  | 'not_connected' | 'reauth_required' | 'invoice_not_pushable'   // draft or unknown invoice
  | 'customer_not_mapped'                                           // org mapping absent / not confirmed|create_new
  | 'home_currency_unknown' | 'currency_mismatch'                   // realm-level (from assert)
  | 'customer_currency_mismatch'                                    // mapping.remoteCurrencyCode ≠ invoice.currencyCode
  | 'quickbooks_error' | 'record_failed';                           // 502s; record_failed = remote ok, local persist failed (never retry)
export class AccountingInvoicePushError extends Error {
  constructor(readonly code: AccountingInvoicePushErrorCode, readonly status: 404 | 409 | 502, message: string);
}
export interface InvoicePushOutcome {
  mappingId: string; remoteEntityId: string; docNumber: string | null;
  syncStatus: 'synced' | 'synced_with_tax_variance';
  taxVarianceCents: number | null;
}
export async function pushInvoiceToAccounting(invoiceId: string, partnerId: string): Promise<InvoicePushOutcome>;
export async function voidInvoiceInAccounting(invoiceId: string, partnerId: string): Promise<void>;  // no-op if never pushed
```

- [ ] **Step 1: Failing unit tests** (`accountingInvoicePush.test.ts`, Drizzle-mock pattern from `accountingMappingService.test.ts`). Core cases, each a real test:
  1. Draft invoice (`invoiceNumber IS NULL`) → `invoice_not_pushable` 409, no provider call.
  2. Currency guard runs **before** any provider call: home currency null → `home_currency_unknown`; invoice EUR vs home USD → `currency_mismatch`; error message distinguishes single-currency realm (`multiCurrencyEnabled !== true`: "enable multi-currency in QuickBooks or invoice in USD") from multi-currency realm ("foreign-currency push is not yet supported") — assert on both messages.
  3. Org mapping `remoteCurrencyCode` 'EUR' ≠ invoice 'USD' → `customer_currency_mismatch` 409 (null `remoteCurrencyCode` passes — unknown is not a mismatch).
  4. Org mapping missing or `link_status='unlinked'/'suggested'` → `customer_not_mapped` 409.
  5. Dependency chain: org mapping `create_new`/`pending` → `syncMappedEntity` called for the org first; line items with `confirmed|create_new` mappings synced before the invoice; unmapped catalog line → pushed ad-hoc (lineMappings entry `remoteItemRef: null`), NOT an error.
  6. Happy path: provider gets payload with **all** lines (hidden zero-priced children included), stamped `currencyCode`, ISO dates; mapping row upserted `link_status:'create_new'→'confirmed'`, `sync_status:'synced'`, `remote_doc_number` persisted when the result's docNumber differs from the invoice number.
  7. Tax variance: `remoteTaxTotal '7.02'` vs invoice `taxTotal '7.00'` (2¢ > 1¢ tolerance) → `sync_status:'synced_with_tax_variance'`, `taxVarianceCents: 2`; 1¢ diff → plain `synced`.
  8. Provider failure → mapping `sync_status:'error'` + sanitized `last_error` (assert exact string `QuickBooks rejected the invoice sync (HTTP 500)`), rethrown as `quickbooks_error` 502.
  9. Remote-succeeded/local-persist-zero-rows → `record_failed` 502 with "do not retry" text embedding the remote id.
  10. Void: never-pushed invoice → resolves without provider call; pushed invoice → `provider.voidInvoice` with stored mapping; mapping `sync_status` stays `synced`, `last_error` null; provider void failure → `error` + sanitized message.
  11. Idempotent re-push: existing synced mapping → provider called with mapping (sparse update path), no duplicate insert (unique-violation mapped like `upsertMappingRow` does).
- [ ] **Step 2: Failing AST gate test.** Copy the walker from `stripeCheckoutCallSites.test.ts`; scan `apps/api/src` + `ee` for member calls `.pushInvoice(`/`.voidInvoice(`; allowlist exactly `services/accounting/accountingInvoicePush.ts` and `services/accounting/quickbooksProvider.test.ts` (+ the coordinator's own test via mock — mocks don't hit the AST since they're property accesses in tests; allowlist test files by `/\.test\.ts$/` exclusion like the Stripe gate does). Run: fails only if implementation puts calls elsewhere — write it to pass against the intended layout and verify it FAILS when you add a temporary decoy call in a scratch file.
- [ ] **Step 3: Implement `accountingInvoicePush.ts`.** Order inside `pushInvoiceToAccounting`:
  1. `resolveConnectionAndToken` (reuse — maps reauth/not-connected; translate `AccountingMappingError` codes into the push error type).
  2. Load invoice + lines directly (partner-guarded: `WHERE id = ? AND partner_id = ?`; select the minimal line columns; ORDER BY sortOrder) — do NOT reuse `getInvoice` (it does a Stripe lookup).
  3. Reject unless `invoiceNumber !== null && status !== 'draft'` (void handled by the void entrypoint; pushing a voided invoice → `invoice_not_pushable`).
  4. `assertAccountingInvoicePushCurrency(conn, { currencyCode })`, catching `AccountingCurrencyContractError` to re-raise with the realm-aware message (case 2 above).
  5. Org mapping load; `customer_currency_mismatch` check; run `syncMappedEntity({ breezeEntityType:'org', ... })` when not yet synced; same per line for mapped catalog items; build `lineMappings`.
  6. Upsert the invoice mapping row (`link_status:'create_new'`, `sync_status:'pending'`) before the provider call; call `provider.pushInvoice` wrapped in `runOutsideDbContext`; on success persist remote ref + variance status + `remote_doc_number` with zero-row-throw; on failure `markMappingError`-equivalent + sanitized rethrow.
  7. Cents comparison helper: `Math.round(Number(a)*100)` on decimal strings (values are DB `numeric(12,2)` strings — exact).
  All DB access via the ambient context (callers provide request context or system context — the service itself does not wrap, mirroring `accountingMappingService`).
- [ ] **Step 4: Run** `npx vitest run src/services/accounting` — all green, including the widened `syncStatus` union ripple in `accountingMappingService.test.ts`.
- [ ] **Step 5: Commit.** `feat(accounting): guarded invoice push/void coordinator with AST call-site gate`

---

### Task 4: BullMQ worker, auto-push hooks, refresh lock

**Files:**
- Create: `apps/api/src/jobs/accountingSyncWorker.ts` (template: `apps/api/src/jobs/invoiceWorker.ts`)
- Modify: `apps/api/src/services/workerRegistry.ts`, `apps/api/src/services/invoiceService.ts:1268-1278` (issue hook) and `:1581` area (void hook), `apps/api/src/services/accounting/accountingTokens.ts`
- Test: `apps/api/src/jobs/accountingSyncWorker.test.ts`, `accountingTokens.test.ts` (extend), `invoiceService` tests (hook emission)

**Interfaces:**
- Produces:
```ts
export const ACCOUNTING_SYNC_QUEUE = 'accounting-sync';
export type AccountingSyncJobData =
  | { type: 'push-invoice'; invoiceId: string; partnerId: string }
  | { type: 'void-invoice'; invoiceId: string; partnerId: string };
export async function enqueueAccountingInvoicePush(invoiceId: string, partnerId: string): Promise<void>;  // jobId `accounting-push-${invoiceId}`
export async function enqueueAccountingInvoiceVoid(invoiceId: string, partnerId: string): Promise<void>;  // jobId `accounting-void-${invoiceId}`
export function createAccountingSyncWorker(): Worker<AccountingSyncJobData>;
export function initializeAccountingSyncWorkers(): void; export function shutdownAccountingSyncWorkers(): Promise<void>;
```

- [ ] **Step 1: Failing tests.**
  - Worker handler (exported for direct test like `invoiceWorker`'s): no QBO connection → returns without calling the coordinator; connection with `pushMode:'manual'` → skips push jobs but **still processes void jobs** (books must not keep a voided invoice open); `pushMode:'auto'` → calls `pushInvoiceToAccounting` inside `runOutsideDbContext(withSystemDbAccessContext(...))` (assert via the mocked context helpers, contractWorker pattern); typed 409s (`customer_not_mapped`, `currency_mismatch`, …) are **terminal** — logged, no rethrow (retrying cannot fix them; the mapping row already carries the error); `quickbooks_error`/unexpected errors rethrow so BullMQ retries; `record_failed` is terminal (never retry).
  - Enqueue helpers: options `{ attempts: 5, backoff: { type:'exponential', delay: 5000 }, removeOnComplete:{count:100}, removeOnFail:{count:500} }`, colon-free jobIds, try/catch + `captureException` wrapper.
  - Hooks: `issueInvoice` fires `enqueueAccountingInvoicePush` post-commit next to `enqueueInvoicePdfRender` (fire-and-forget, its own try/catch); `voidInvoice` fires `enqueueAccountingInvoiceVoid` after `emitInvoiceEvent`. Assert both via mocks in the existing invoiceService test files; also assert bulk paths inherit (they call the same service functions).
  - Token lock (`accountingTokens.test.ts`): when a refresh is needed, `getValidAccessToken` opens a transaction, `SELECT ... FOR UPDATE`s the connection row, re-reads expiry, and returns the fresh token without a second refresh when another caller already rotated it (double-checked locking); rotation persist still zero-row-throws.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.** Worker: concurrency 2; `attachWorkerObservability`; connection lookup + pushMode check inside the handler under system context; registry entry in `workerRegistry.ts` (`load:` dynamic import, mirror the `invoiceWorker` entry) — **run the worker-closure tool to determine `placement`, do not guess** (`workerRegistry.ts:47-50`); no scheduleRegistry entry (no repeatables in Phase C). Token lock via `db.transaction` + `FOR UPDATE` re-check (the `accountingTokens.ts:42-45` NOTE is now due — delete the note, land the lock).
- [ ] **Step 4: Run** worker/service/token tests + `npx vitest run src/services/workerRegistry` contract tests.
- [ ] **Step 5: Commit.** `feat(accounting): accounting-sync worker with auto push/void on issue and refresh locking`

---

### Task 5: API routes + invoice detail sync status

**Files:**
- Modify: `apps/api/src/routes/accounting/index.ts` (POST `/:provider/invoices/:invoiceId/push`, POST `/:provider/invoices/push-bulk`, GET `/:provider/remote-candidates`), `apps/api/src/routes/invoices/invoices.ts` (GET `/:id` gains `accountingSync`), `apps/api/src/services/invoiceService.ts` (`getInvoice` returns it), `middleware/selfManagedDbContextRoutes.ts`
- Modify: `accountingMappingService.ts` — unlink-without-live-token fix (Phase B follow-up)
- Test: `routes/accounting/index.test.ts`, new `routes/accounting/invoicePush.test.ts`, `routes/invoices` tests, `middleware/selfManagedDbContextRoutes.test.ts`

**Interfaces:**
- Produces:
  - `POST /accounting/:provider/invoices/:invoiceId/push` — auth, partnerScopes, `requireMfa()`, `requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action)` (system scope bypasses, same shape as `requireMappingWrite`'s scope check); calls `pushInvoiceToAccounting` synchronously; 200 `{ syncStatus, docNumber, taxVarianceCents }`; `AccountingInvoicePushError` → its status + `{ error: code, message }`; audits `accounting.invoice.push` with `resourceType:'accounting_mapping'`.
  - `POST /accounting/:provider/invoices/push-bulk` — same gates; body `{ invoiceIds: string[] }` (zod, max 100); enqueues `enqueueAccountingInvoicePush` per id after a partner-ownership filter; returns `{ enqueued, skipped }`; audits.
  - `GET /accounting/:provider/remote-candidates?entityType=org|catalog_item&q=...` — auth + partnerScopes; calls `listRemoteCustomers`/`listRemoteItems` with the query; returns `[{ id, displayName, email?, sku?, currencyCode? }]` (Phase B follow-up: replaces manual remote-ID entry).
  - `getInvoice` result gains `accountingSync: { provider: 'quickbooks'; syncStatus: MappingSyncStatus; lastSyncedAt: string | null; lastError: string | null; remoteDocNumber: string | null } | null` — from a partner-context mapping read; `null` when no connection/mapping or the read is org-scoped (RLS hides partner rows — fail closed, field stays null).
  - `saveMappingDecision(decision:'unlinked')` no longer resolves a live access token (local-only decision) — expired-grant partners can unlink (Phase B follow-up gate #2).

- [ ] **Step 1: Failing route tests.** Push route: 200 happy path; 409 pass-through with code preserved; MFA + permission negative tests (org-scoped token 403; missing invoice permission 403); MISSING provider 404. Bulk: ownership filter (foreign invoiceId lands in `skipped`); cap. Candidates: query threading + reauth 409. `getInvoice`: `accountingSync` present for partner scope, `null` under org scope (mock RLS-empty read). Unlink fix: `saveMappingDecision` with `decision:'unlinked'` succeeds while `getValidAccessToken` mock throws `ReauthRequiredError`. selfManagedDbContextRoutes test updated for the three new entries.
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement** (route bodies follow the existing `handleMappingError` + `writeRouteAudit` shapes; bulk uses `runBulkIsolated`-style ownership filtering via one `inArray` select on invoices).
- [ ] **Step 4: Run** all touched route/middleware/service tests.
- [ ] **Step 5: Commit.** `feat(accounting): invoice push routes, sync status on invoice detail, remote candidate search, expired-grant unlink`

---

### Task 6: Erasure + merge cleanup and lifecycle integration tests (red first)

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:603-631` (replace the Phase-C TODO with `invoice`/`payment` arms), `apps/api/src/services/orgMerge.ts:822-845` (same)
- Test: `apps/api/src/__tests__/integration/tenantCascadeExecution.integration.test.ts` (extend seed at `:120-139`), `orgMergeCustomExecutors.integration.test.ts` (extend `:989-1045`)

**Interfaces:** none new — SQL arms only. `POST_PASS_FIXUP_TABLES` (`orgMergeRegistry.ts:78`) already classifies the table; no registry change.

- [ ] **Step 1: RED — extend the integration seeds first.** Seed an `invoice` mapping row (breeze_entity_id = an invoice belonging to the erased/loser org) and a `payment` mapping row (breeze_entity_id = an invoice_payments row on that invoice), plus control rows on the surviving/control org. Assert erasure deletes exactly the erased org's invoice+payment mapping rows (count bump on `tablesDeleted.accounting_entity_mappings`) and merge drops the loser's (dropped count) while survivors persist. Run both suites against real Postgres — MUST FAIL (rows survive).
- [ ] **Step 2: Implement the arms.** Erasure (`tenantCascade.ts`), joining through the org's invoices:
```ts
{
  table: 'accounting_entity_mappings',
  clearSql: (orgId) => sql`
    DELETE FROM accounting_entity_mappings m
    WHERE (m.breeze_entity_type = 'org' AND m.breeze_entity_id = ${orgId}::uuid)
       OR (m.breeze_entity_type = 'invoice' AND m.breeze_entity_id IN (
             SELECT id FROM invoices WHERE org_id = ${orgId}::uuid))
       OR (m.breeze_entity_type = 'payment' AND m.breeze_entity_id IN (
             SELECT p.id FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
              WHERE i.org_id = ${orgId}::uuid))
  `,
},
```
Merge (`orgMerge.ts` post-pass): invoices MOVE to the survivor during merge, so invoice/payment mappings stay valid — **delete only rows whose invoice no longer exists** (defensive orphan sweep) and keep the existing org-row delete. Verify against the merge engine's actual invoice handling first (`grep -n invoices apps/api/src/services/orgMerge.ts`): if invoices are moved, the arm is the orphan sweep + updated comment; if any merge path deletes loser invoices, mirror the erasure join for those. Update both TODO comments to describe what now exists.
- [ ] **Step 3: GREEN.** Re-run both integration suites + `rls-coverage` + `orgMerge` unit tests.
- [ ] **Step 4: Commit.** `fix(accounting): clear invoice/payment mapping rows on org erasure and merge`

---

### Task 7: Web UI

**Files:**
- Create: `apps/web/src/components/billing/AccountingSyncCard.tsx`
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx` (rail, after `invoice-detail-from`), `invoiceTypes.ts:110-124` (`accountingSync?`), `InvoicesPage.tsx` (bulk action), `apps/web/src/components/integrations/QuickbooksIntegration.tsx` (refresh settings button + multi-currency line), `QuickbooksMappingWorkbench.tsx` (candidate search via `GET /accounting/quickbooks/remote-candidates` replacing manual-ID input; `MappingSyncStatus` union + `synced_with_tax_variance` rendering)
- Test: `AccountingSyncCard.test.tsx` (new), extend `InvoiceDetail`/`InvoicesPage`/`QuickbooksIntegration`/`QuickbooksMappingWorkbench` tests
- i18n: `apps/web/src/i18n/` en + ALL locale files (tr-TR parity enforced)

**Interfaces:**
- Consumes: `invoice.accountingSync` (Task 5 shape), `POST /accounting/quickbooks/invoices/:id/push`, `POST /accounting/quickbooks/invoices/push-bulk`, `POST /accounting/quickbooks/settings/refresh`, `GET /accounting/quickbooks/remote-candidates`.
- Produces: `AccountingSyncCard({ invoiceId, sync, canPush, onChanged })` — rail card (`rounded-lg border bg-card p-4`, h3 heading convention, `data-testid="invoice-detail-accounting-sync"`), rendered only when `accountingSync !== null`… plus a "Push to QuickBooks" affordance when `sync.syncStatus` is `pending`/`error` and `can('invoices','write')`.

- [ ] **Step 1: Failing component tests.** Card: renders status pill per state (pending / synced / error with `lastError` text / tax-variance badge with distinct copy + `remoteDocNumber` line when present); Push button wraps `runAction`, disabled while in-flight, calls `onChanged` on success; hidden entirely when `accountingSync` is null (org scope / not connected). InvoicesPage: bulk "Push to QuickBooks" appears only when `can('invoices','write')` and ≥1 selected, POSTs ids, shows the `{enqueued, skipped}` toast, clears selection. Workbench: candidate search box queries the endpoint (debounced), selecting a candidate feeds the existing `decide(p,'confirmed',remoteId)` path; `synced_with_tax_variance` renders its own label, not "pending". Integration card: "Refresh settings" button POSTs and re-renders home currency + a multi-currency yes/no line.
- [ ] **Step 2: Verify failures** (`pnpm --filter @breeze/web test --run src/components/billing/AccountingSyncCard.test.tsx` etc.).
- [ ] **Step 3: Implement** following the rail-card/BulkActionBar/fetchWithAuth patterns cited in the file-structure notes; every mutation through `runAction`; all copy through `t(...)` with keys added to every locale file.
- [ ] **Step 4: Run** the four web test files + `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` + the i18n parity suite.
- [ ] **Step 5: Commit.** `feat(web): invoice accounting sync card, bulk QBO push, candidate search, settings refresh`

---

### Task 8: Currency integration test, docs, sandbox checklist

**Files:**
- Create: `apps/api/src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts` (exact name mandated by `accountingCurrency.ts:143-186`)
- Modify: `docs/integrations/quickbooks-sandbox-verification.md`, `apps/docs/src/content/docs/features/accounting-integrations.mdx`, `accountingCurrency.ts` trailing contract comment (mark items 1–3 delivered; item 4 remains Phase D)

**Interfaces:** consumes everything; produces no code contracts.

- [ ] **Step 1: Write the integration test** (real Postgres, seeded partner/org/invoice/connection): (a) EUR invoice + USD-home connection → push throws `currency_mismatch` and the mapping row records `sync_status:'error'` with the sanitized message — no provider HTTP mock is even reached (assert fetch-spy not called); (b) home currency NULL → `home_currency_unknown`; (c) USD/USD with mocked provider → mapping `synced`, unique-constraint idempotency on double push (second call updates, row count stays 1). Run — RED against a stubbed coordinator only if wiring is missing; must be GREEN by end of task.
- [ ] **Step 2: Docs.** Sandbox checklist gains a Phase C section (the quorum's sandbox list): invoice create with mapped + ad-hoc lines; TxnTaxDetail override lands and AST realm variance flags; DocNumber collision fallback; void; `MultiCurrencyEnabled` visible in Preferences on both realm types; foreign push into a single-currency realm errors (never books 1:1); customer-currency mismatch fault text captured. Feature docs page documents push modes, sync statuses (incl. tax variance), and the home-currency limitation with its exact error copy.
- [ ] **Step 3: Full verification sweep.** `pnpm --filter @breeze/api test` (unit), integration + RLS configs (`npx vitest run -c vitest.integration.config.ts`, `-c vitest.config.rls.ts`), `pnpm --filter @breeze/web test`, `pnpm db:check-drift`, `pnpm lint`, tsc via turbo build of api+web.
- [ ] **Step 4: Commit.** `test(accounting): invoice push currency integration suite; docs + sandbox checklist for Phase C`

---

## Self-review notes (kept for executors)

- Spec coverage: auto/manual push (T4/T5), dependency order (T3), DocNumber fallback (T1/T3), tax override + variance (T1/T3), void (T1/T3/T4), sync panel (T5/T7), erasure/merge (T6), observability/audit (T5, sanitized errors throughout), Phase B follow-up gates #2 unlink and #4 candidate search (T5/T7). Payment pull-back, CDC, webhooks = Phase D. CreditMemo out (no credit-note schema). Foreign-currency push deliberately out (quorum ruling; seams landed in T1/T2).
- The `types.test.ts` tuple pins WILL break in T1 — updating them is intentional, not collateral.
- `requireMappingWrite` untouched; a schema-level regression test in T5 pins that the workbench routes still reject `breezeEntityType:'invoice'`.
- T6 merge-arm shape depends on how orgMerge moves invoices — the task says verify first; do not copy the erasure join blindly.
