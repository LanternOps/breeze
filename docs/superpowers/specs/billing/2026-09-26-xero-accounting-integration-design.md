# Xero Accounting Integration — Design

**Date:** 2026-09-26
**Status:** Design (approved in brainstorm 2026-09-26; pending written-spec review)
**Parent:** `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md` — this is its **Phase E**.
**Predecessors (all shipped):** QuickBooks Phase A (connection), customer import, B (customer/item mapping), C (invoice push), D (payment pull-back), D2 (payment push).

## Why this exists

MSPs keep their books in QuickBooks Online **or Xero** (Xero dominates UK/AU/NZ — most of the EU-region partner base). QuickBooks is fully integrated; Xero is an enum value with no provider. The parent spec promised Xero as "a second `AccountingProvider` implementation, no core rework."

**That promise does not hold.** A codebase audit (2026-09-26) found the provider *interface* and *schema* are mostly neutral, but every caller is pinned to `'quickbooks'` and several QBO mechanics live in core services:

- `(partner, 'quickbooks')` hardcoded in invoice push, payment push, mapping service, sync + reconcile workers, invoice service, routes (`z.enum(['quickbooks'])`), and the web UI (`/accounting/quickbooks/...`).
- QBO fault parsing in core (`qboFaultOf`, `isQboPaymentLinkedRefusal`, `e.qboError === 'invalid_grant'`); `'quickbooks_error'` drives worker retry classification.
- QBO concepts in core logic: SyncToken as the "edited remotely" signal, `requestid` replay-cache idempotency, `PrivateNote` adoption marker, 21-char PaymentRefNum cap, QBO payment-method names, the `'Deleted in QuickBooks'` sentinel, CDC 30-day-window `ChangeSet` semantics.
- OAuth callback requires `realmId`; OAuth state does not record the provider; no tenant-selection step.
- No 429 / Retry-After handling and no per-connection rate limiting anywhere.
- Job payloads carry no provider/connection; `stripeReconcile.ts` / `stripeReversalState.ts` update payment mappings without an `integration_id` filter.

So this program first makes the core provider-neutral (no QBO behaviour change), then adds Xero wave by wave.

## Decisions (brainstorm, 2026-09-26)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Full QBO parity**: connect, contact/item mapping + reconciliation, contact import, auto/manual invoice push + void, payment pull-back (webhook + sweep), payment push. | Parity is what MSP owners check; the core is shared so the marginal cost of each piece is the provider method. |
| D2 | **One active accounting provider per partner**, DB-enforced. | One set of books is reality; keeps invoice/payment routing unambiguous. Both-at-once would require connection-scoping every job, mapping and Stripe path for a rare case. |
| D3 | **One Xero organisation (tenant) per partner.** Tenant picker after OAuth; unchosen tenant connections are removed from the grant. | Matches D2; each tenant connection counts toward Xero's commercial connection cap. |
| D4 | **Approach A — neutralize the core, then add Xero.** Rejected: B (parallel Xero stack — two copies of the outbox/adoption/void-with-payments logic that drift; every fix like #7134/#7135 lands twice), C (`if (provider === 'xero')` branches — QBO concepts stay in core; unworkable at a third provider, e.g. CONTPAQi #4610). | Long-term maintainability; the existing QBO suite guards the refactor. |
| D5 | App credentials are **env vars** (`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_WEBHOOK_KEY`), same model as `QBO_*`. Self-hosters register their own Xero app. | Same as QBO; no per-partner app registration. |
| D6 | Remote entity types keep Breeze's canonical vocabulary (`Customer`/`Item`/`Invoice`/`Payment`). A Xero Contact is stored as `Customer`. | Avoids churning the `accounting_entity_mappings` entity-pair CHECK; the label is Breeze's, not the provider's. |

### Commercial constraint (not a design input, but a launch gate)

Xero moved to tiered developer pricing on 2026-03-02: **Starter** is free and capped at **5 connections** and **1,000 calls/day per org**; **Core** (50) / **Plus** (1,000) / **Advanced** (10,000) are paid, require **app certification**, and allow 5,000 calls/day per org. Self-hosters fit in Starter — so the 1,000/day budget is the design constraint for every self-hosted install. **Hosted needs certification before the 6th partner connects** — so the UI follows Xero's certification rules from day one (branded connect button, clean disconnect, error states). Tier choice and certification are an owner action, not a wave.

## Scope boundaries

- Breeze stays the system of record. One-way push + payment pull-back; no two-way merge.
- **Out of scope** (same as QBO): credit notes / overpayments / prepayments. A remote allocation that reduces `AmountDue` without a Payment is **not observed** by v1 (the neutral `ChangeSet` carries payments and deletions, not live balances) — a known limitation shared with QBO, tracked as a follow-up for both providers; multi-currency beyond the existing stamped-currency guard; tracking categories; purchase-side (bills, suppliers); Xero-originated invoices.
- **No new tables.** Three new nullable columns on `accounting_connections`; one unique-index change. No external-ref columns on core tables.

## Program decomposition (feature + 5 waves)

```
W01 · Core neutralization            (no QBO behaviour change; the seam everything else uses)
W02 · Xero connection                (OAuth, tenant picker, tokens, settings, disconnect)
W03 · Contacts, items, import        (mapping workbench, reconciliation, contact import)
W04 · Invoice push + void
W05 · Payments                        (pull via webhook + If-Modified-Since sweep; push)
```

W02–W05 are strictly sequential. W01 must merge before W02. Each wave is its own plan and PR(s).

---

## W01 — Core neutralization

**Acceptance:** the entire existing QuickBooks unit + integration suite passes unchanged; the neutral-core guard test passes.

### Active-connection resolution
- New `resolveActiveConnection(partnerId)` (in `accountingConnectionService.ts`) returns the partner's single accounting connection (any provider) or null. It replaces every `(partner, 'quickbooks')` lookup: `accountingInvoicePush.ts`, `accountingPaymentPush.ts`, `accountingMappingService.ts` (`resolveConnection` / `resolveConnectionAndToken`), `accountingSyncWorker.ts`, `accountingReconcileWorker.ts`, `invoiceService.ts`, routes.
- **One-provider constraint:** migration replaces unique index `accounting_connections_partner_provider_idx (partner_id, provider)` with a unique index on `(partner_id)`. Safe: disconnect deletes the row (`accountingConnectionService.ts` disconnect path), and production holds only `quickbooks` rows. Migration asserts no partner has >1 row (RAISE WARNING with count, then fail) before swapping the index. Connecting provider B while a provider-A row exists → **409** `accounting_provider_conflict` ("Disconnect QuickBooks first"); the web greys out the other provider's card.
- **Jobs carry `connectionId`.** Sync-job payloads add `connectionId`; the sync and reconcile workers load by id and **drop** (log + complete, not fail) a job whose connection no longer exists or whose provider changed — covers a provider switch with jobs in flight. **A job's destination is never reinterpreted.** Jobs enqueued before deploy (no `connectionId`) were QBO work by construction: they run only if the partner's active connection is `quickbooks`, and are dropped otherwise. (W01 ships before any Xero connection can exist, so the legacy queue drains long before a switch is possible; the rule is the backstop.)
- Hardening: `stripeReconcile.ts` / `stripeReversalState.ts` payment-mapping updates filter by `integration_id`.

### Neutral error model
- New `AccountingProviderError extends Error` with `kind: 'reauth' | 'rate_limited' | 'validation' | 'not_found' | 'stale_version' | 'payment_linked' | 'duplicate_doc_number' | 'transient'`, plus `retryAfterMs?`, `providerCode?`, `providerMessage?`, `httpStatus?`.
- `quickbooksProvider.ts` translates its faults into this type at its boundary (`quickbooksFault.ts` stays, but is only imported by the provider). Core (`accountingInvoicePush.ts`, `accountingPaymentPush.ts`, `accountingTokens.ts`, `accountingSyncWorker.ts`) branches on `kind` only.
- Persisted error-code strings: existing `'quickbooks_error'` values remain readable (no data migration); new writes use `'provider_error'`. Any enum/union that includes `'quickbooks_error'` gains `'provider_error'`.

### QBO mechanics move behind the provider
Extend `AccountingProvider` (and the pinned `types.test.ts` contract) with:

| Concern | Interface addition | QBO | Xero |
|---|---|---|---|
| Remote version token (existing `remote_sync_token` column, not renamed) | results return `remoteVersion: string \| null` | SyncToken | `UpdatedDateUTC` |
| Idempotency | **stays provider-owned.** Core passes the identities it passes today (`invoiceId`, `invoicePaymentId`, `pushGeneration`); each provider derives its own key | `requestid` — **byte-identical to today** (`invoiceId` for invoice create; `invoicePaymentId` / `invoicePaymentId:g<n>` for payments). Changing it would let a create accepted pre-deploy with a lost response be retried post-deploy under a new key → a duplicate in the customer's books. A unit test pins the exact QBO keys. | `Idempotency-Key` header, one deterministic key **per immutable request variant** (see W04) |
| Payment adoption marker | `paymentMarker: { embed(ref, marker): string; extract(text): string \| null }` | `PrivateNote` | payment `Reference` |
| Limits | `limits: { paymentRefMax: number; rate: RateLimitSpec }` | 21 chars | provider-declared |
| Payment method | `ChangeSet` payments carry neutral `method` | QBO names mapped in provider | Xero mapped in provider |
| Remote-deleted label | `displayName` used by the sentinel | "QuickBooks" | "Xero" |

The `'Deleted in QuickBooks'` equality sentinel (`types.ts`) becomes a provider-labelled constant plus a stable machine code; comparisons use the code. `ChangeSet` docs drop CDC/30-day wording in favour of "changes since cursor"; the QBO backfill-over-30-days path stays inside the QBO provider.

### Provider capabilities (wave gating)
- `AccountingProvider` gains `capabilities: { connect, mapping, customerImport, invoicePush, paymentPull, paymentPush }`. Enforced at **every** layer: routes (409 `capability_unavailable`), producers (issue-time enqueue, payment fan-out, sweeps don't enqueue), workers (drop + log), and UI (hidden controls).
- QBO declares all true. Xero is registered in W02 with only `connect`; W03–W05 flip their capabilities as they land. This is what lets each Xero wave ship independently: a W02-connected Xero row defaults to `push_mode='auto'` / `pull_payments=true` / `push_payments=true` (`accountingConnectionService.ts` insert defaults), and without capability gates the generalized workers would call Xero methods that do not exist yet.

### Invoice totals invariant (both providers)
- Before any push, core asserts that the pushed lines sum to Breeze's `subtotal` and that `taxTotal`/`total` match Breeze. `invoiceMath.computeInvoiceTotals` excludes `customerVisible = false` lines from totals, while `loadInvoiceLinesOrdered` sends **all** lines; a hidden line with a non-zero price would inflate the remote invoice. A mismatch fails fast (`validation`, `invoice_totals_mismatch`) and is surfaced on the invoice — never pushed.
- After a push, both `remoteTaxTotal` **and** `remoteTotal` are compared (today only tax is compared, `accountingInvoicePush.ts` ~L863); a total mismatch marks the mapping as drifted rather than synced.
- **Pre-work (before W01 planning):** determine whether invoices can carry priced hidden lines today (quote-acceptance copies `customerVisible`). If yes, that is a live QBO bug — file and fix it separately; W01 then encodes the rule (hidden lines sent at zero, or omitted) for both providers.

### Rate limiting (both providers)
- Per-connection Redis limiter, spec from `provider.limits.rate` (Xero: 60 calls/min and 5 concurrent per tenant; QBO: its published per-realm limits), plus a **per-provider app-wide** limiter (Xero: 10,000 calls/min across all tenants).
- A `rate_limited` error re-queues the job with the `Retry-After` delay instead of consuming a retry attempt. Daily-limit exhaustion also resumes from `Retry-After` — Xero's daily windows do **not** reset at UTC midnight.
- Daily budget is **tier-aware**: `XERO_DAILY_CALL_LIMIT` (default `1000`, the Starter limit; hosted sets its tier's value), refined by the live `X-DayLimit-Remaining` header per connection. Below 20% remaining, background sweeps (reconcile, mapping sweep, import paging) defer; invoice/payment pushes keep priority.

### Webhooks
- `/webhooks/quickbooks` URL unchanged (registered with Intuit).
- Shared helper `routeWebhookToConnection(provider, realmFingerprint)` → `enqueueAccountingReconcile(conn.id, partnerId)`; both provider routes call it. (Xero route itself ships in W05.)

### API + web
- Route param `provider` becomes `z.enum(['quickbooks', 'xero'])`; `validateProviderConfig` returns an explicit error for an unconfigured provider instead of `null`.
- OAuth state records the provider; callback redirect `?accounting=<provider>`.
- Web: a generic `AccountingIntegration` shell with provider cards (a card shows only when its provider is configured server-side); `QuickbooksIntegration`, `QuickbooksMappingWorkbench`, `QuickbooksCustomerImport`, `AccountingSyncCard`, `InvoicesPage` push actions take the provider as a parameter. i18n keys generalized (`accounting.*`, provider name interpolated). `invoiceTypes.ts` `provider`/`source` unions gain `'xero'`.
- `quickbooksCustomerImport.ts` → provider-neutral `accountingCustomerImport.ts` (it only calls `listRemoteCustomers`); `QbImportError` → `AccountingImportError`.

### Mechanical guard
New unit test: no file under `services/accounting/` (other than `*Provider.ts`, `quickbooksFault.ts`, `providerRegistry.ts`, and an explicit allowlist) and no file under `jobs/`/`routes/accounting/` may contain the literal `'quickbooks'` or import a `qbo*` / `quickbooksFault` symbol. The allowlist starts empty for core push/pull/mapping services.

---

## W02 — Xero connection

### OAuth
- Authorization-code flow against `login.xero.com/identity/connect/authorize`; token exchange / refresh at `identity.xero.com/connect/token` (HTTP Basic client auth).
- Scopes: `offline_access` + contacts, invoices/transactions, payments, settings read. **The plan pins exact scope strings from Xero's current docs** — Xero is moving new apps to granular scopes; do not ship the deprecated broad `accounting.transactions` if the app is granular-only.
- Callback does not require `realmId`. After exchange: `GET https://api.xero.com/connections?authEventId=<id>` — the `authEventId` claim from the access token scopes the list to tenants authorised **in this OAuth flow**. Unfiltered `/connections` also returns the user's earlier connections to the app, which may belong to **another Breeze partner** (an accountant serving several MSPs); those are never shown and never touched.
  - Exactly one `ORGANISATION` tenant → auto-select.
  - Several → insert the row with `status = 'pending_tenant'`, tokens encrypted, `realm_id` null; UI shows a picker (tenant name + id). `pending_tenant` rows are excluded by `resolveActiveConnection`, still count for the one-provider index (so a half-finished connect blocks a QBO connect — the UI offers "cancel"), and are reaped after 1 hour.
  - Zero → error "no Xero organisation authorised".
- On selection: store tenantId in `realm_id_encrypted` + `realm_id_fingerprint`, and the Xero connection id in the new `provider_connection_ref` column (varchar 64, not secret). `DELETE /connections/{id}` only for unchosen connections **from the same `authEventId`** that are not held by any other `accounting_connections` row (checked by tenant fingerprint) — best-effort, logged.
- Connecting a tenant already held by another partner is refused by the existing `(provider, realm_id_fingerprint)` unique index → 409 "This Xero organisation is connected to another Breeze account".

### Tokens
- Access token 30 min (existing 5-min refresh buffer applies). Refresh token rotates on every refresh; lifetime is a sliding 60 days that Xero does not return — the provider sets `refresh_token_expires_at = now + 60d` on exchange and every refresh. (Without this, `accountingTokens.ts` flags reauth immediately on a missing expiry.)
- Row-lock rotation logic unchanged. Xero `invalid_grant` → `AccountingProviderError{kind:'reauth'}`.

### Organisation settings capture (`fetchRealmSettings`)
- `GET /Organisation` → `BaseCurrency` → `home_currency` (existing mismatch guard unchanged); `IsDemoCompany` → UI badge (not persisted; fetched with status).
- `GET /Currencies` → `multi_currency_enabled = count > 1`.
- `environment` is always `production` for Xero (no sandbox; testing uses the Demo Company).

### Settings (new columns, nullable, provider-neutral)
| Column | Xero meaning | QBO |
|---|---|---|
| `default_income_account_ref` (existing) | revenue `AccountCode` | unchanged |
| `default_tax_code_ref` (existing) | `TaxType` for taxable lines | unchanged |
| `default_exempt_tax_code_ref` (**new**, varchar 64) | `TaxType` for non-taxable lines | ignored |
| `default_payment_account_ref` (**new**, varchar 64) | bank `AccountCode`/`AccountID` payments are applied to | ignored |
| `provider_connection_ref` (**new**, varchar 64) | Xero connection id (for targeted disconnect) | ignored |

Pickers: `GET /Accounts` (active `REVENUE`/`SALES`; and `Type=="BANK"`), `GET /TaxRates` where `CanApplyToRevenue`. **Adding columns to `accounting_connections`:** partner-axis table, not in `CORE_TENANT_EXPORT_POLICY` (org-axis only) — confirm during planning that no export/erasure registry needs the new columns.

### Disconnect
Best-effort `DELETE /connections/{provider_connection_ref}` before the existing delete path; a failure is logged and never blocks disconnect. **Never** call the token-revocation endpoint on disconnect: revocation removes *all* of the authorising user's connections to the app, which can include another Breeze partner's Xero connection.

---

## W03 — Contacts, items, import

### Contacts (org → Xero Contact, stored as `Customer`)
- `listRemoteCustomers(conn, query)` honours `query` via Xero `searchTerm`; pages at 1000; returns archived contacts flagged (shown with a badge, not suggested by default).
- **Idempotent create via `ContactNumber = breeze:<orgId>`** (API-only external-id field). Before any create, look up by `ContactNumber`; a hit is adopted instead of creating a duplicate.
- Xero enforces unique contact names: a duplicate-name rejection maps to `kind:'validation'` with a structured `duplicate_name` code → the workbench shows "A contact named X already exists — link it?" Never auto-retried.
- Addresses/phones via existing `addressMapping.ts` (Xero `STREET`/`POBOX`, `DEFAULT`/`MOBILE`).
- Update sends `ContactID`; `UpdatedDateUTC` is the remote version.

### Items (catalog item → Xero Item)
- `Code` (unique, ≤30): catalog SKU if it fits, else `slug(name)` truncated + `-` + 6-char hash of the Breeze item id; on collision, adopt if its `Description`/marker identifies it as ours, else suffix.
- `Name` ≤50 (truncated), `IsSold=true`, never tracked inventory. `SalesDetails`: `UnitPrice`, `AccountCode` (item's mapped account → connection default), `TaxType`.
- Idempotent create via lookup-by-Code first.

### Import
`accountingCustomerImport.ts` (from W01) with Xero contacts → Orgs + Sites; dedupe via `organization_external_links` (`system = 'xero'`). Supplier-only contacts hidden by default with a "show all contacts" toggle (Xero sets `IsCustomer` only after a first sales invoice).

---

## W04 — Invoice push + void

### Push (triggers unchanged: auto-on-issue or manual)
Same `AccountingInvoicePayload`. Xero provider maps to `PUT/POST /Invoices?unitdp=4`:

| Xero | From |
|---|---|
| `Type` | `ACCREC` |
| `Contact.ContactID` | contact mapping |
| `Date` / `DueDate` | `txnDate` / `dueDate ?? txnDate` (Xero requires `DueDate` to authorise) |
| `InvoiceNumber` | `docNumber` |
| `CurrencyCode` | stamped `currencyCode` |
| `Status` | `AUTHORISED` (payments can only apply to approved invoices; Breeze is SoR) |
| `LineAmountTypes` | `Exclusive` |
| `Reference` | `breeze:<invoiceId>` — adoption key on retry (lookup before create), alongside `Idempotency-Key` |
| line `Description`/`Quantity`/`UnitAmount` | payload line |
| line `ItemCode` | item mapping, if mapped |
| line `AccountCode` | item's account → `default_income_account_ref` |
| line `TaxType` | `taxable ? default_tax_code_ref : default_exempt_tax_code_ref` |
| line `TaxAmount` | allocated (below) |

**Tax allocation.** Breeze stores tax as an invoice total; Xero computes per line. The provider allocates `taxTotal` across taxable lines pro-rata by `lineTotal`, largest-remainder at 2dp so cents sum exactly, and sends `TaxAmount` per line. Response `TotalTax` / `Total` feed the existing `remoteTaxTotal` / `remoteTotal` drift check.

**Idempotency (Xero replay window is 6 minutes; a reused key with a different body/URL/method is rejected).**
- Key = `sha256(invoiceId, pushGeneration, variant)` truncated, where `variant ∈ {with-number, without-number}` — one key per immutable request body, so the duplicate-number fallback never reuses a key with a changed body.
- The key only protects fast retries. **Adoption is the primary protection:** before any create — and always after an uncertain outcome (timeout, 5xx, lost response) — look up by `Reference = breeze:<invoiceId>`; a hit is adopted, never re-created. The same rule applies to contacts (`ContactNumber`), items (`Code`) and payments (`Reference` marker).

**Duplicate invoice number.** Mirror QBO's single retry without `InvoiceNumber` (its own `without-number` key), recorded in sync status — once W04's lab run confirms how Xero rejects duplicates (`kind:'duplicate_doc_number'`).

**Push preconditions** (fail fast with `validation`, surfaced on the invoice): taxable line present and `default_tax_code_ref` null; non-taxable line present and `default_exempt_tax_code_ref` null; no income account.

### Void
`POST /Invoices/{id}` `{Status: 'VOIDED'}` for `AUTHORISED`; `{Status: 'DELETED'}` for `DRAFT`. Xero refuses to void with payments applied → `kind:'payment_linked'` → existing void-with-payments flow. Returned `UpdatedDateUTC` persisted as remote version.

### Re-push
Updates the adopted invoice (Breeze invoices are immutable post-issue; a re-push resends identical content).

---

## W05 — Payments

### Webhook
`POST /webhooks/xero`: verify `x-xero-signature` = base64(HMAC-SHA256(rawBody, `XERO_WEBHOOK_KEY`)) with a constant-time compare; respond **exactly 200** on valid (including intent-to-receive with empty `events`) and **401** on invalid, empty body. For each event's `tenantId`: fingerprint → `routeWebhookToConnection('xero', fp)`. Xero has no payment webhook; an `INVOICE` UPDATE event is the doorbell.

### Pull (`reconcileChanges(conn, since)`)
- `GET /Payments` with `If-Modified-Since: since`, paged; keep `PaymentType == ACCRECPAYMENT`, `Status ∈ {AUTHORISED, DELETED}`.
- `GET /Invoices` with `If-Modified-Since`, `Statuses=VOIDED,DELETED` for remote voids/deletes.
- A Xero payment applies to exactly one invoice → existing `"<paymentId>/<invoiceId>"` mapping id.
- Cursor = max `UpdatedDateUTC` seen, minus 5-min overlap, in existing `cdc_cursor`. The existing scheduled sweep is the backstop. No 30-day window, so no backfill path.
- Our pushed payment with a changed `UpdatedDateUTC` → existing "edited remotely" flow.
- Credit-note/overpayment/prepayment allocations are not observed in v1 (see Scope boundaries).

### Push (`createPayment` / `deletePayment`)
- `PUT /Payments` `{Invoice:{InvoiceID}, Account:{Code|AccountID: default_payment_account_ref}, Date, Amount, CurrencyRate?, Reference}`. `Reference` carries the adoption marker + cheque / Stripe `pi_` ref, truncated per `limits.paymentRefMax`.
- Idempotency: `Idempotency-Key` header + adoption lookup by marker in `Reference` before create.
- Delete: `POST /Payments/{id}` `{Status:'DELETED'}` (Xero payments are deleted, never edited). A bank-reconciled payment refuses deletion → `kind:'validation'`, surfaced, not retried.
- `default_payment_account_ref` null → payment push disabled with a settings warning. `push_payments_since` horizon unchanged.

---

## Tenancy / contracts

- No new tables. `accounting_connections` and `accounting_entity_mappings` stay partner-axis (RLS shape 3), already in `rls-coverage.integration.test.ts`; org erasure (`tenantCascade.ts` custom step), org merge (`orgMerge.ts`) and partner erasure are unchanged.
- New columns (`default_exempt_tax_code_ref`, `default_payment_account_ref`, `provider_connection_ref`) are plain varchar refs, not secrets.
- Tokens use the existing encrypted columns (`encryptedColumnRegistry.ts` already describes `realm_id_encrypted` as "QBO realmId / Xero tenantId").
- `organization_external_links.system` is free-form; `'xero'` needs no migration.
- `partner-wide-write-coverage.test.ts` allowlist: any new writer to `accounting_connections` must be added.

## Config

- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_WEBHOOK_KEY` in `config/env.ts`, `validate.ts`, `.env.example`, and the `api` service `environment:` block of every compose file; `envComposeParity.test.ts` updated; system connections registry (`system/connections/registry.ts`) gains a Xero entry.
- The Xero card appears only when `XERO_CLIENT_ID` is set.

## Testing

- **Unit:** `xeroProvider.test.ts` mirrors `quickbooksProvider.test.ts` (fetch-mock factory, `conn()` factory, payloads from Xero API docs, fake timers for cursor/expiry). Tax allocation gets a property-style test (cents always sum to `taxTotal`). W01 guard test. Error-kind mapping table test per provider.
- **Integration:** one-provider unique index → 409; reconcile worker consuming a Xero `ChangeSet`; webhook 200/401 intent-to-receive; job-drop on provider switch; existing accounting RLS/cascade suites.
- **Lab:** `docs/integrations/xero-demo-verification.md` (Xero counterpart of `quickbooks-sandbox-verification.md`) run against the Xero Demo Company per wave from W02. It settles the open verification items below.

## Open verification items (settled in the lab, not assumed)

1. Does Xero accept per-line `TaxAmount` overrides that differ from its own calculation? Fallback: let Xero calculate; drift check flags differences.
2. How Xero rejects a duplicate `InvoiceNumber` (error shape → `duplicate_doc_number`).
3. Exact granular scope strings for a newly registered app.
4. That the first access token always carries an `authEventId` claim. If it is ever missing, fail closed (ask the user to reconnect) — diffing `/connections` before/after is **not** an acceptable fallback, since it cannot distinguish another partner's concurrent connect.

## Advisor quorum (2026-09-26)

Fable draft + independent Codex (`gpt-6-astra`, xhigh) review. Codex raised 8 findings; all were verified against the code / Xero docs and adopted:

| # | Finding | Resolution |
|---|---|---|
| 1 | Core-derived idempotency keys would change QBO `requestid`s mid-flight → duplicates | Keys stay provider-owned; QBO keys pinned byte-identical |
| 2 | Hidden lines excluded from Breeze totals but pushed; only tax compared | Totals invariant pre-push + total compare post-push; pre-work to check for a live QBO bug |
| 3 | Unfiltered `/connections` cleanup and grant revocation can sever another partner's connection | `authEventId` filter; targeted `DELETE /connections/{id}`; no revocation on disconnect |
| 4 | Legacy jobs resolved against the current connection could write QBO work into Xero | Legacy jobs bind to `quickbooks` only |
| 5 | W02–W04 not independently shippable (auto-push/pull defaults reach unimplemented methods) | Provider capabilities enforced in routes, producers, workers, UI |
| 6 | 6-minute Xero replay window; changed body under same key is rejected | Key per immutable request variant; adoption lookup after uncertain outcomes |
| 7 | Allocation-drift warning undeliverable with current `ChangeSet` | Descoped to a documented limitation + follow-up for both providers |
| 8 | Starter is 1,000/day; daily windows aren't UTC-midnight; app-wide 10k/min | Tier-aware budget, `Retry-After` resume, app-wide limiter |

## Rollout

- Owner: register the hosted Xero app; choose tier / pursue certification before the 6th hosted connection.
- Docs page under `apps/docs` (Integrations → Xero), mirroring the QuickBooks page.
- Feature tracked via feature-lifecycle (parent issue + W01–W05 sub-issues).
