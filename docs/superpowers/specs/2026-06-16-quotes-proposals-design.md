# Quotes / Proposals — Design Spec

**Date:** 2026-06-16
**Status:** Approved (brainstorm) — pending implementation plan
**Author:** Todd Hebebrand + Claude

## Summary

A new **Quotes** (Proposals) subsystem for Breeze RMM, modeled on the existing
Invoices system and reusing the shared catalog picker, pdfkit PDF/email
machinery, and the Stripe pay-link flow. A quote is a richer document than an
invoice: alongside line items it carries an **ordered list of content blocks**
(headings, rich text, images, pricing tables) so it reads like a proposal, and
that block model is the natural foundation for the future slide-deck view.

Customers receive a **public tokenized link** (same pattern as the invoice
Stripe pay-link) where they review, **accept + e-sign** (built-in typed
signature, tamper-evident), which **auto-creates an invoice** they pay through
the existing #1422 flow.

Lives under `/api/v1/quotes` (API) and `/quotes` (web), beside Invoices and
Contracts.

## Scope decisions (from brainstorm)

- **Sequencing:** Quotes-first. Only the minimal catalog fields quotes need to
  represent a subscription line are added now; the full Catalog SaaS overhaul
  (per-seat tiers, etc.) is a **separate later spec**.
- **E-sign:** Built-in token-based accept + typed signature now, structured
  behind an `AcceptanceProvider` interface so a DocuSign/PandaDoc adapter can be
  added later **without a data-model change**. No third-party dependency or
  per-document cost in this phase.
- **Payment:** Accept → auto-create invoice → pay via the existing invoice +
  Stripe pay-link machinery. No new payment code.
- **Content model:** Ordered block list (heading / rich_text / image /
  line_items), future-proofing the slide-deck view.
- **Accept conversion (§4):** **Option (a)** — conversion creates a single
  invoice; recurring lines shown as their first-period amount. The
  recurring→Contract tie-in is deferred to Phase 4.

## Existing patterns this builds on

| Concern | Reuse from |
|---|---|
| Header + line-item tables, dual-axis RLS, numbering sequences | `invoices` / `invoice_lines` / `partner_invoice_sequences` |
| Shared item search/add | `apps/web/src/components/catalog/CatalogItemPicker.tsx` |
| Live totals side-panel UX | `ContractEditor` estimate panel |
| PDF generation (pdfkit, bytea storage) | `services/invoicePdf.ts`, `invoice_documents` |
| Email send + portal branding | `services/email.ts`, `services/invoicePdf.ts` |
| Public tokenized link | invoice Stripe pay-link (`services/invoiceCheckout.ts`) |
| Image bytea storage + serve | `services/avatarStorage.ts` (user avatars) |

## 1. Data model (new tables)

All tenant-scoped tables use **dual-axis `(org_id, partner_id)` RLS** like
`invoices`/`contracts`, with policies added in the **same migration** that
creates the table (idempotent, per CLAUDE.md). All new `org_id` tables must be
registered in the contract test allowlist, the `core.ts` device-delete lists,
and `tenantCascade.ts` `ORG_CASCADE_DELETE_ORDER`.

### `quotes` — header
- `id, partner_id, org_id, site_id, quote_number, status, currency_code`
- `issue_date, expiry_date, accepted_at, declined_at, converted_at`
- Totals: `subtotal, tax_rate, tax_total, total`
- **Recurring buckets:** `one_time_total, monthly_recurring_total,
  annual_recurring_total` — proposals for M365-style deals must show
  "$X upfront + $Y/mo".
- Bill-to: `bill_to_name, bill_to_address (jsonb), bill_to_tax_id`
- `intro_notes, terms` (free text; richer content lives in blocks)
- `converted_invoice_id` (set on accept → invoice created)
- `pdf_document_ref, pdf_sha256, sent_at, first_viewed_at, viewed_at`
- `created_by, created_at, updated_at`
- Indices mirror invoices: `(org_id, status)`, `(partner_id, status)`,
  `(org_id, issue_date)`, partial on `expiry_date` where status IN
  ('sent','viewed').

### `quote_blocks` — ordered proposal content
- `id, quote_id (FK cascade), org_id, block_type, sort_order`
- `block_type` enum: `heading | rich_text | image | line_items`
- `content (jsonb)` — shape depends on type:
  - `heading`: `{ text, level }`
  - `rich_text`: `{ html }` (sanitized server-side on write)
  - `image`: `{ image_id, caption, width }` (refs `quote_images`)
  - `line_items`: `{ label }` (anchor; lines attach via `block_id`)

### `quote_lines` — pricing (mirrors `invoice_lines` + recurrence)
- `id, quote_id (FK cascade), block_id (nullable FK → quote_blocks), org_id`
- `source_type` enum: `catalog | bundle | manual`
- `catalog_item_id, parent_line_id` (bundle expansion, like invoices)
- `description, quantity, unit_price, taxable, customer_visible, line_total,
  sort_order`
- **`recurrence`** enum: `one_time | monthly | annual`
- **`term_months`** (int, nullable) — commitment term, e.g. 12 for M365
- **`billing_frequency`** (nullable) — snapshot for display
- Recurrence/term/frequency/price are **snapshotted from the catalog item at
  add-time** so a later catalog edit never mutates a sent quote.

### `quote_images` — bytea-in-Postgres (avatar pattern)
- `id, quote_id (FK cascade), org_id, image_data (bytea), mime, byte_size,
  sha256, created_at`
- Magic-byte sniff on upload (PNG/JPEG/WebP), size cap (reuse avatar limits).
- Served via the tokenized public endpoint for the acceptance page, and via an
  authed endpoint for the editor preview. Zero external config; RLS-protected.
- Rationale: S3 exists in the codebase but is unused for user content; bytea
  matches the avatar/invoice-PDF precedent and is simpler to ship.

### `quote_acceptances` — tamper-evident audit
- `id, quote_id, org_id, signer_name, signer_email, signed_at, ip_address,
  user_agent, quote_sha256` (hash of rendered quote content at accept time),
  `acceptance_token_jti`
- Behind an `AcceptanceProvider` interface (built-in typed-signature provider
  now; vendor adapter later) so the data model is provider-agnostic.

### `partner_quote_sequences` — numbering
- `(partner_id, year)` PK, auto-incrementing quote numbers per partner per year
  (copy of `partner_invoice_sequences`).

### Catalog enhancement (minimal, quotes-driven)
Add two nullable columns to `catalog_items`:
- `billing_frequency` (`monthly | quarterly | annual`)
- `commitment_term_months` (int)

These feed the snapshot onto quote lines. The full catalog SaaS overhaul stays a
separate later spec. Update `catalog.ts` validators accordingly.

## 2. Status lifecycle

```
draft → sent → (viewed) → accepted | declined | expired
accepted → converted
```
- `expiry_date` reached → `expired` via a background sweep (like invoice overdue
  marking).
- `accepted` stamps the acceptance record **and** auto-creates the invoice
  (status → `converted`, `converted_invoice_id` set).
- Edits allowed only in `draft`. A sent quote is `declined` (with reason) or
  superseded by a new revision.

## 3. Accept → invoice conversion (Phase 1, option a)

On acceptance, reuse invoice machinery: create a **draft invoice** from the
quote's lines (one-time lines + first-period amount for recurring lines), copy
bill-to, then run the existing issue/pay-link path so the customer pays through
the #1422 flow.

**Deferred (Phase 4):** instead of folding recurring lines into the one-time
invoice, spin up a recurring **Contract** for subscription lines while invoicing
only one-time items — fully tying Quotes ↔ Invoices ↔ Contracts together.

## 4. Public acceptance page + e-sign

- `GET /quotes/public/:token` — unauthenticated; serves quote JSON + images by
  signed token (JWT with `jti`, like pay-link). Stamps `first_viewed_at`.
- Web: a public Astro page renders blocks top-to-bottom (headings, rich text,
  sanitized images, pricing tables with the recurring summary), with **Accept &
  Sign** / **Decline** actions.
- Accept: customer types full name (typed signature); record
  name/email/IP/UA + content hash → `quote_acceptances`, transition to
  accepted, create invoice, redirect to the invoice pay-link.

## 5. API routes

`quoteRoutes`, mounted at `/api/v1/quotes`, split following the invoices layout:

- `quotes.ts` — CRUD + line/block management: `POST /:id/lines`,
  `/:id/lines/catalog`, `/:id/lines/bundle`, `/:id/blocks`, block reorder,
  image upload `POST /:id/images` (multipart).
- `lifecycle.ts` — `issue`, `send`, `decline`, `expire`.
- `accept.ts` + public sub-router — token view + accept + convert.
- `pdf.ts` — `GET /:id/pdf` via pdfkit, rendering blocks in order.
- Permissions: `QUOTES_READ, QUOTES_WRITE, QUOTES_SEND`; reuse `INVOICES_WRITE`
  for the conversion side.

Use `withDbAccessContext` for request paths; post-commit email runs outside DB
context (like contracts `generate`).

## 6. Web components

Under `apps/web/src/components/billing/quotes/`:
- `QuotesPage.tsx` — list/search/filter (mirror `InvoicesPage`).
- `QuoteWorkspace.tsx` — tabs: **Editor / Preview / Detail**.
- `QuoteEditor.tsx` — block-based editor: add/reorder blocks; within a
  `line_items` block use the shared **`CatalogItemPicker`**; "save manual line
  to catalog" checkbox on manual lines; live totals side panel (one-time +
  recurring buckets), reusing the contract-estimate UX.
- `QuoteDetail.tsx` — sent/accepted view, acceptance record, convert/invoice
  link.
- Public: `apps/web/src/pages/quote/[token].astro` + `PublicQuoteView.tsx`.
- API client: `apps/web/src/lib/api/quotes.ts`; types/format helpers in
  `quoteTypes.ts` (mirror `invoiceTypes.ts`).
- All mutations wrapped in `runAction` per CLAUDE.md.
- UI state via `window.location.hash`, not query params.

## 7. Shared types/validators

New `packages/shared/src/validators/quotes.ts`:
- Block schemas (per `block_type`), line schema with `recurrence`/`term_months`,
  create/update quote, accept payload (signer name/email).
- Money: `^\d+(\.\d{1,2})?$`; dates: `^\d{4}-\d{2}-\d{2}$` (match
  invoices/contracts).
- Corresponding TS types in `packages/shared/src/types/`.

## 8. Testing

- **RLS forge tests** for every new tenant table + allowlist entries in
  `rls-coverage.integration.test.ts` (functional `breeze_app` cross-tenant
  insert must fail — the contract test alone does not catch a missing axis).
- **Cascade:** register new `org_id` tables in `core.ts` device-delete lists
  **and** `tenantCascade.ts` `ORG_CASCADE_DELETE_ORDER` (+ `AUDIT_ADMIN` if
  append-only); only the Integration Tests job catches misses.
- Route tests with Drizzle mocks; validator coverage.
- **Integration test** for the accept → convert → invoice flow (in
  `src/__tests__/integration/*.integration.test.ts`).
- Public token path: verify unauth access is token-gated and that a tampered
  quote hash mismatches the recorded acceptance.

## 9. Phasing

1. **Phase 1:** schema + migrations + RLS, CRUD, block editor, catalog fields,
   PDF render.
2. **Phase 2:** send + public acceptance page + built-in e-sign accept.
3. **Phase 3:** accept → convert-to-invoice + pay-link.
4. **Phase 4 (optional):** recurring lines → auto-create Contract.

## Open items

- None blocking. Phase 4 (recurring→Contract) is explicitly deferred.
