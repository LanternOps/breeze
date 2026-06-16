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

Customers review and **accept + e-sign** (built-in typed signature,
tamper-evident) either in the **customer portal** (`apps/portal/`, like the
existing portal invoices) or via a **public tokenized link** for recipients
without a portal account. Acceptance **auto-creates an invoice** they pay
through the existing #1422 flow. Internal MSP access is RBAC-scoped with new
`QUOTES_*` permissions.

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
- **Customer portal:** Quotes are viewable and acceptable in the customer
  portal (`apps/portal/`), following the existing portal-invoices pattern.
  Two customer-facing access paths share one accept path (§4):
  authenticated portal users, and a **public tokenized link** for recipients
  who don't yet have a portal account (typical for prospects).
- **RBAC:** Internal MSP access is gated by new `QUOTES_*` permissions,
  registered and seeded exactly like the existing `INVOICES_*` / `CATALOG_*` /
  `CONTRACTS_*` modules (which are already RBAC-scoped). Portal/customer users
  have no permission model — access is implicit via org-bound portal session.

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

## 4. Customer-facing access + e-sign

Quotes reach customers through **two paths that funnel into one accept flow**:

**(a) Customer portal (`apps/portal/`)** — for org users with portal accounts.
Mirrors the existing portal-invoices implementation:
- New `apps/api/src/routes/portal/quotes.ts` under `portalAuthMiddleware`
  (no RBAC; org-bound by session, like `portal/invoices.ts`). Endpoints:
  `GET /portal/quotes`, `GET /portal/quotes/:id`, `GET /portal/quotes/:id/pdf`,
  `POST /portal/quotes/:id/accept`, `POST /portal/quotes/:id/decline`.
  Filters out drafts; scoped by `eq(quotes.org_id, session.orgId)` as
  defense-in-depth atop RLS.
- New portal pages `apps/portal/src/pages/quotes/index.astro` + `[id].astro`,
  components `QuoteList.tsx` / `QuoteDetailView.tsx`, a sidebar nav entry in
  `PortalSidebar.tsx`, and client methods in `apps/portal/src/lib/api.ts`.
- On accept, the acceptance record's signer identity comes from the
  authenticated `portal_user`.

**(b) Public tokenized link** — for recipients without a portal account
(prospects). Same mechanism as the invoice pay-link:
- `GET /quotes/public/:token` — unauthenticated; serves quote JSON + images by
  signed token (JWT with `jti`). Stamps `first_viewed_at`.
- Public Astro page in `apps/portal/` (alongside login/branding, the existing
  pre-auth surface) renders blocks top-to-bottom (headings, rich text,
  sanitized images, pricing tables with the recurring summary), with **Accept &
  Sign** / **Decline** actions.
- On accept, signer types their full name; identity comes from the typed
  signature + token claims.

**Shared accept logic (both paths):** record signer name/email/IP/UA + content
hash → `quote_acceptances`, transition status to `accepted`, auto-create the
invoice (§3). Portal users are then routed to the existing
`POST /portal/invoices/:id/pay`; token users redirect to the invoice's public
pay-link.

## 5. API routes

`quoteRoutes`, mounted at `/api/v1/quotes`, split following the invoices layout:

- `quotes.ts` — CRUD + line/block management: `POST /:id/lines`,
  `/:id/lines/catalog`, `/:id/lines/bundle`, `/:id/blocks`, block reorder,
  image upload `POST /:id/images` (multipart).
- `lifecycle.ts` — `issue`, `send`, `decline`, `expire`.
- `accept.ts` + public sub-router — token view + accept + convert.
- `pdf.ts` — `GET /:id/pdf` via pdfkit, rendering blocks in order.

Use `withDbAccessContext` for request paths; post-commit email runs outside DB
context (like contracts `generate`).

### RBAC (internal MSP side)

Quotes follow the identical permission pattern already used by Invoices,
Catalog, and Contracts (all of which are RBAC-scoped today via
`requirePermission(...)`):

1. **Register constants** in `apps/api/src/services/permissions.ts` `PERMISSIONS`:
   `QUOTES_READ` (`quotes:read`), `QUOTES_WRITE` (`quotes:write`),
   `QUOTES_SEND` (`quotes:send`). Conversion reuses `INVOICES_WRITE`.
2. **Gate every internal route** with
   `requirePermission(PERMISSIONS.QUOTES_*.resource, .action)` (read on GETs,
   write on mutations, send on issue/send) — exactly as `invoices/invoices.ts`.
3. **Seed via migration** (`apps/api/migrations/YYYY-MM-DD-quotes.sql`,
   idempotent): create the three `permissions` rows, then grant them to the
   built-in **partner-scope** system roles that already hold `tickets:write`
   (read+write+send) / `tickets:read` (read only), with `NOT EXISTS` guards —
   copying `2026-06-15-d-recurring-contracts.sql`.

**Portal/customer side has no RBAC.** `portal/quotes.ts` uses
`portalAuthMiddleware` only; authorization is the org-bound portal session
(a customer can act only on their own org's quotes). This matches
`portal/invoices.ts` and is the correct model for self-service acceptance.

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
- API client: `apps/web/src/lib/api/quotes.ts`; types/format helpers in
  `quoteTypes.ts` (mirror `invoiceTypes.ts`).

**Customer-facing (`apps/portal/`)** — see §4:
- `pages/quotes/index.astro` + `[id].astro`, `QuoteList.tsx` /
  `QuoteDetailView.tsx`, `PortalSidebar.tsx` nav entry, `lib/api.ts` methods
  (`getQuotes`, `getQuote`, `acceptQuote`, `declineQuote`) — mirror the portal
  invoices files.
- Public tokenized acceptance page (pre-auth, alongside portal login):
  `pages/quote/[token].astro` + `PublicQuoteView.tsx`.
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
- RBAC: route tests asserting `QUOTES_READ`/`WRITE`/`SEND` gates return 403
  without the permission; confirm the migration seeds them onto partner-scope
  system roles.
- Portal: a portal user can list/view/accept only their own org's non-draft
  quotes (cross-org returns 404); accept from portal records the
  `portal_user` as signer.

## 9. Phasing

1. **Phase 1:** schema + migrations + RLS + `QUOTES_*` permissions/seeding,
   internal CRUD (RBAC-gated), block editor, catalog fields, PDF render.
2. **Phase 2:** send + customer portal view (`portal/quotes`) + public
   tokenized acceptance page + built-in e-sign accept.
3. **Phase 3:** accept → convert-to-invoice + pay-link (portal pay + public
   pay-link).
4. **Phase 4 (optional):** recurring lines → auto-create Contract.

## Open items

- None blocking. Phase 4 (recurring→Contract) is explicitly deferred.
