# QuickBooks Online (and Xero) Accounting Integration — Design

**Date:** 2026-06-23
**Status:** Design (approved in brainstorm). Decomposed program; each phase gets its own spec → plan → implementation cycle.
**Predecessor / frame:** Billing v1.0 (Catalog #1365, Invoice Engine #1383, Recurring Contracts #1411, Stripe Payments #1422 — all merged) and the native ticketing/PSA system. This work is the one the billing architecture overview deliberately deferred: `docs/superpowers/specs/billing/2026-06-14-billing-architecture-overview.md` ("QB/Xero accounting sync — deferred, separate spec").

## Why this exists

Breeze owns the full billing lifecycle (catalog → quotes → invoices → contracts → Stripe payments) and a native PSA (tickets → time entries / parts → invoice lines). MSPs keep their **books** in QuickBooks Online (Xero next). Today there is no bridge: invoices issued in Breeze must be re-keyed into QBO by hand, and payments recorded in QBO never reflect back. This program builds that bridge with Breeze as the system of record.

The billing architecture overview pre-committed the shape of this work and laid down hard rules we inherit:
- External integration is **always** via dedicated **connection** tables + external-ref **mapping** tables — the `psaConnections`/`psaTicketMappings` pattern in `schema/integrations.ts`.
- **Never** add external-ref columns to core tables (`invoices`, `catalog_items`, `organizations`, …).
- The "accounting view" already exposes **all** invoice lines (including hidden bundle components) precisely so this sync gets a full revenue/COGS breakdown.
- "Adding QB/Xero sync later requires **zero** changes to catalog/invoice core schema."

## Decisions locked in brainstorm

1. **Sync model: one-way push + payment pull-back.** Breeze is the source of truth. Push Customers, Items, and Invoices **to** QBO; pull payment/paid-status **back**. No bidirectional merge.
2. **v1 entity scope: all four** — Customers (orgs → QBO Customer), Items (catalog → QBO Item), Invoices (issued → QBO Invoice), Payment pull-back (QBO → Breeze).
3. **Reconciliation: suggest-match, require confirm.** Breeze proposes matches against existing QBO entities by name/email; nothing is written to QBO until the user confirms each mapping or chooses "create new." Protects books MSPs already maintain.
4. **Invoice push trigger: auto-on-issue, partner-configurable.** Default auto (BullMQ, retried); a per-partner setting switches to manual-only.
5. **Payment pull-back: QBO webhooks (real-time) + CDC reconciliation, with a scheduled CDC backstop sweep** for dropped/duplicate events.
6. **Architecture: provider-abstraction seam (Approach 1).** A narrow `AccountingProvider` interface; QuickBooks Online is implementation #1, Xero is a second implementation behind the same interface. Both providers are a known committed requirement, so the abstraction is justified, not speculative.

## Scope boundaries

- **Ticketing is covered transitively, not directly.** Ticket time entries and ticket parts already become invoice lines (`sourceType = time_entries | ticket_parts`), so they reach QBO **through the invoice push** with full description/qty/rate. QBO has no ticket object — there is **no** separate ticket→QBO sync. Raw billable-time export independent of invoices is explicitly out of scope.
- **Breeze stays the system of record.** No editing QBO-origin data; no two-way merge.
- **Corrections:** v1 handles **void** (push Void to QBO). **CreditMemo** mapping is deferred until Billing v1.1 **E4** (credit notes) lands, then becomes a follow-on.
- **Multi-currency deferred.** v1 assumes the partner's Breeze currency matches their QBO home currency; a mismatch is detected at connect and **blocks push with a clear error** rather than guessing.
- **No external-ref columns on core tables** — all mapping lives in the dedicated mapping table.

## Program decomposition

Sequenced like Billing v1.0; each phase is its own spec → plan → build, sharing the Approach-1 seam.

```
Phase A · Accounting connection foundation   (the seam Xero reuses)
   OAuth connect/disconnect, token store + refresh + rotation,
   accounting_connections table, AccountingProvider interface,
   settings UI, connection health/status. QBO is impl #1.
        │
Phase B · Customer + Item mapping
   reconciliation UI (suggest→confirm), accounting_entity_mappings,
   push orgs→Customer, catalog→Item (+ default income account).
        │
Phase C · Invoice push
   auto(configurable)/manual push on issue, line mapping, tax override,
   void→QBO, per-invoice sync-status surfacing.
        │
Phase D · Payment pull-back
   QBO webhook endpoint (verifier token) + CDC reconciliation,
   periodic CDC backstop sweep, reflect payment/status onto Breeze invoice.
        │
Phase E · Xero  (later, follow-on spec)
   second AccountingProvider impl + Xero OAuth quirks. No core rework.
```

## Data model

Two new tables, both **partner-axis (RLS shape 3)** and provider-agnostic. They live in a new `schema/accounting.ts` (or extend `schema/integrations.ts`), following the connection + external-ref-mapping convention.

### `accounting_connections` — one row per (partner, provider)

```
id, partner_id (RLS axis), provider ('quickbooks' | 'xero'),
realm_id_encrypted              -- QBO realmId / Xero tenantId
access_token_encrypted,
refresh_token_encrypted,        -- ROTATES on every refresh; must re-persist each time
access_token_expires_at, refresh_token_expires_at,
environment ('sandbox' | 'production'),
home_currency,                  -- realm currency captured at connect; guards mismatch
default_income_account_ref,     -- required to create QBO Items
default_tax_code_ref,           -- maps Breeze tax onto a QBO TaxCode
push_mode ('auto' | 'manual'),  -- the partner-configurable trigger
webhook_verifier_token_encrypted,
cdc_cursor,                     -- last CDC "changedSince" watermark (backstop sweep)
status ('connected' | 'disconnected' | 'error' | 'reauth_required'),
last_sync_at, last_error, connected_by, created_at, updated_at
```

### `accounting_entity_mappings` — the external-ref table

No external IDs ever touch core tables.

```
id, integration_id (→ accounting_connections), partner_id (RLS axis),
breeze_entity_type ('org' | 'catalog_item' | 'invoice' | 'payment'),
breeze_entity_id,
remote_entity_type ('Customer' | 'Item' | 'Invoice' | 'Payment'),
remote_entity_id,
remote_sync_token,              -- QBO optimistic-concurrency token; required on every update
link_status ('suggested' | 'confirmed' | 'unlinked' | 'create_new'),
sync_status ('pending' | 'synced' | 'error' | 'synced_with_tax_variance'),
last_synced_at, last_error, created_at, updated_at
```

Constraints:
- Unique on `(integration_id, breeze_entity_type, breeze_entity_id)` **and** `(integration_id, remote_entity_type, remote_entity_id)` → idempotency in both directions; prevents double-create and double-link.
- Composite FK `(integration_id, partner_id) → accounting_connections(id, partner_id)`, plus partner-guarded FKs on the Breeze entity where it carries `partner_id` (the Pax8 cross-partner-leak prevention pattern), so a mapping cannot cross partners.
- Cascade-delete with the connection (and the partner-deletion path); added to the cascade contract in the same PR.

## The `AccountingProvider` interface

Narrow, in `apps/api/src/services/accounting/`. Provider-specific quirks (base URLs, tax-override shape, item income-account requirement, CDC query, webhook detail) live **inside** each implementation; the connection / mapping / UI / observability layers never see them.

```ts
interface AccountingProvider {
  readonly provider: 'quickbooks' | 'xero';
  buildAuthUrl(state): string;
  exchangeCode(code, realmId): ConnectionTokens;
  refresh(conn): ConnectionTokens;                   // returns ROTATED refresh token
  listRemoteCustomers(conn, query): RemoteEntity[];  // reconciliation UI
  listRemoteItems(conn, query): RemoteEntity[];
  upsertCustomer(conn, org, mapping): RemoteRef;
  upsertItem(conn, item, mapping): RemoteRef;
  pushInvoice(conn, invoice, lineMappings): RemoteRef;
  voidInvoice(conn, mapping): void;
  reconcileChanges(conn, sinceCursor): ChangeSet;    // CDC for payment pull-back
  verifyWebhook(headers, body, conn): boolean;
}
```

## OAuth & token model (QBO specifics that bite if missed)

- **App-level credentials in env** (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`). Breeze is one published Intuit app; partners click "Connect to QuickBooks" and complete OAuth — unlike Pax8, where each partner pastes their own credentials.
- Access token **expires in 60 minutes**; refresh inline with a 5-minute buffer (the `pax8Client.getAccessToken` pattern), and **persist the rotated refresh token every time** — permanently dropping it breaks the connection.
- Refresh token lives ~100 days; on expiry → `status = 'reauth_required'`, surfaced in the UI as "Reconnect QuickBooks."
- All `*_encrypted` columns registered in `encryptedColumnRegistry` and handled via `secretCrypto`.
- OAuth scope: `com.intuit.quickbooks.accounting`. Sandbox vs production base URLs selected by `environment`.

## Sync flows

### Push: Customer (Phase B)
1. On connect, the reconciliation UI calls `listRemoteCustomers` and proposes matches per org by name/email — **nothing is written** until the user confirms each (`link_status: suggested → confirmed | create_new`).
2. When an org's invoice needs pushing (or on explicit "sync customer"): `confirmed` → no-op; `create_new` → `upsertCustomer` POSTs a QBO Customer from `organizations` billing fields (name, address block, taxId, billing email); store `remote_entity_id` + `remote_sync_token`.

### Push: Item (Phase B)
Same reconcile→confirm flow. Creating a QBO Item **requires an income account**, so `upsertItem` uses the connection's `default_income_account_ref`. **Unmapped catalog item → ad-hoc invoice line** (description + amount, no ItemRef) rather than blocking the invoice.

### Push: Invoice (Phase C)
1. Invoice transitions to issued → if `push_mode = 'auto'`, enqueue a retried BullMQ push job; if `'manual'`, wait for the button (per-invoice or bulk). Dependency order: confirmed customer pushed first, then each line's item.
2. `pushInvoice` builds the QBO Invoice: `DocNumber ← invoiceNumber`, `TxnDate ← issueDate`, `DueDate`, `CustomerRef`, one `SalesItemLineDetail` per Breeze line (including hidden bundle components — accounting view sees all).
3. **DocNumber collision / custom-numbering off:** if QBO rejects a duplicate DocNumber or the realm auto-numbers, store QBO's assigned `DocNumber` back on the mapping and surface it; do not fail the push.
4. Result recorded on the invoice mapping (`sync_status`); failures land in the per-invoice **Accounting Sync panel** — never a silent no-op.
5. **Void:** voiding a Breeze invoice enqueues `voidInvoice` (QBO Void) using the stored `remote_sync_token`.

### Pull-back: Payment (Phase D) — webhook-primary, CDC-backstop
1. QBO posts to `/webhooks/qbo` (unauthenticated, like the Stripe webhook route). `verifyWebhook` validates the Intuit verifier-token HMAC.
2. Webhook payloads are thin ("Invoice 42 changed"), so Breeze then calls `reconcileChanges` (CDC) to fetch the actual Payment/Invoice state, match `remote_entity_id` → Breeze invoice, record an `invoicePayments` row, and recompute status via the existing `recomputeInvoiceStatus`. All in **system DB context** (no request user).
3. **Backstop:** a scheduled BullMQ worker (~every 15 min, the Pax8/Huntress cadence) runs `reconcileChanges` from `cdc_cursor` to catch dropped/duplicate webhooks, then advances the cursor. Idempotency via the unique payment mapping — a payment reflected twice is a no-op.

## Tax handling (the sharp edge)

Breeze computes its own `taxRate`/`taxTotal`. QBO's **Automated Sales Tax (AST)** wants to compute its own and can override line numbers. To keep **Breeze as source of truth**, v1 pushes the Breeze-computed tax as an **invoice-level `TxnTaxDetail` override** against the connection's `default_tax_code_ref`, honoring each line's `taxable` flag. Breeze's total is what lands in QBO.

**Known v1 limitation (documented, not silently wrong):** in AST-enabled US realms, QBO may still re-derive tax for some line/jurisdiction combinations. If QBO's computed tax diverges from Breeze's beyond a one-cent tolerance, mark the push `synced_with_tax_variance` and flag it in the panel rather than pretending it matched. Per-jurisdiction tax mapping is a v2 concern.

## Other known limitations (stated up front)

- Multi-currency deferred — currency mismatch blocks push with a clear error.
- CreditMemo deferred to Billing v1.1 E4; v1 handles void only.
- Partial / over-payments already supported by Breeze's multiple-`invoicePayments` model.
- A QBO-side customer/invoice we created being deleted → mapping flips to `error` / `reauth_required`, surfaced in the panel, never auto-resurrected.

## Multi-tenancy / RLS

- Both new tables use **shape 3 (partner-axis)**: `breeze_has_partner_access(partner_id)` policies on SELECT/INSERT/UPDATE/DELETE, with RLS `ENABLE` + `FORCE` in the **same migration** that creates each table.
- Composite FKs `(integration_id, partner_id)` and partner-guarded entity FKs so a mapping physically cannot reference another partner's connection or org.
- Same PR: add both tables to `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`, and wire the correct (partner-scoped) cascade list, verified via the integration suite.
- **Webhook + CDC sync run in system DB context** (`runOutsideDbContext` + `withSystemDbAccessContext`) — no request user — and `runOutsideDbContext` wraps every QBO HTTP call so a pooled connection is never held open across network I/O (the #1105 connection-hold class).
- Settings/management routes gate with `requireScope('partner','system')` + `requireMfa()` on credential-changing actions (the Pax8 convention).

## Observability

This integration is silent-failure-prone by nature, so surfacing is first-class:
- Every mapping carries `sync_status` + `last_error`. The **Accounting Sync panel** (in the invoice workspace + a connection-level dashboard) shows pending / synced / error / tax-variance counts with a per-row manual retry.
- Push/pull jobs emit billing events (`invoiceEvents.ts`) and audit-log entries; token-refresh failures and `reauth_required` raise a partner-visible banner.
- Web mutations (connect / disconnect / retry / confirm-mapping) wrap in `runAction` so success/failure is always surfaced.

## Testing strategy

- **Provider unit tests** (mocked QBO HTTP): token refresh + **rotation persistence**, auth-URL/state, tax-override shaping, DocNumber-collision fallback, CDC cursor advance, webhook verifier HMAC (valid + forged).
- **Integration tests** (real DB, `src/__tests__/integration/*.integration.test.ts`): RLS forge — cross-partner mapping insert must fail under `breeze_app`; idempotency — double webhook / double push is a no-op; cascade — deleting a connection removes its mappings; payment reconcile recomputes invoice status.
- **Reconciliation logic** unit-tested (name/email match scoring) so confirm-before-write proposals are deterministic.
- Route tests for settings/mapping/sync follow the established Drizzle-mock pattern.
- A QBO **sandbox** smoke path (manual, env-gated) documented for pre-tag verification — accounting/integration PRs are the class that regresses most.

## What's explicitly out of scope (YAGNI)

- Bidirectional sync / editing QBO-origin data.
- Raw billable-time export to QBO independent of invoices.
- Per-jurisdiction / line-level tax mapping (v2).
- Multi-currency (deferred).
- CreditMemo (gated on Billing v1.1 E4).
- A third provider abstraction beyond QBO + Xero (generalize for the second known case only).

## Next step

Brainstorm **Phase A (Accounting connection foundation)** into a full implementation spec, then writing-plans. Phases B–D and the Xero follow-on each get their own cycle.
