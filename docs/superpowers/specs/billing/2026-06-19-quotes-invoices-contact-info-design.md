# Quotes & Invoices — Seller Contact Info, Memo, Terms & Footer

**Date:** 2026-06-19
**Status:** Design approved, pending spec review
**Scope:** Add a seller/MSP "From" contact block and a "Terms & Conditions" block (payment terms + disclaimers) to both quotes and invoices, and surface the existing memo + footer consistently across both. The customer "Bill To" block already exists and is unchanged.

## Problem

Quotes and invoices render the customer ("Bill To" / "Prepared For") at the top, but there is **no seller/MSP "From" block** — the `partners` table has only `name` + `billingEmail`, no address/phone/website. There is also no dedicated place for **payment terms or disclaimers**. A customer receiving a document can't see who it's from, how to reach them, or the terms that apply.

## What already exists (confirmed in code)

| Concept | Invoices | Quotes | Default source |
|---|---|---|---|
| Customer "Bill To" | `billToName`, `billToAddress` (jsonb), `billToTaxId`, `billToTaxExempt` | `billToName`, `billToAddress`, `billToTaxId` | snapshot at issue |
| Memo (note above footer) | `notes` (`invoicePdf.ts:157,268`) | `introNotes` (`quotePdf.ts:287`) | none (per-doc) |
| Footer (bottom line) | `terms` — used as `footer = terms ?? branding.footer` (`invoicePdf.ts:273,303`); snapshotted from `partner.invoiceFooter` at issue (`invoiceService.ts:474`) | `terms` — `footer = terms ?? branding.footer` (`quotePdf.ts:353`); falls back to `partner.invoiceFooter` live at render (`quotes.ts:107`), not snapshotted | `partner.invoiceFooter` |

> Naming note: the doc column `terms` is, despite its name, the **footer** line. We keep it as-is (renaming a shipped column is churn + data risk) and give the new Terms & Conditions block its own clearly-named column.

## Goals

1. A seller "From" block at the top of every quote and invoice: company name, address, phone, email, website.
2. A "Terms & Conditions" block (payment terms + disclaimers combined into one free-text block), with a reusable partner-level default, editable per document, on both doc types.
3. Memo and footer surfaced **consistently** (uniform label + placement) across quotes and invoices — reusing the existing columns, no duplicates.

## Non-goals

- Seller tax/VAT/registration ID (declined — only the customer's tax ID appears, in Bill To).
- Per-customer / per-document overrides of the seller profile (partner-level only).
- A separate structured payment-terms mechanism — the existing `partner.invoiceTermsDays` → `dueDate` is unchanged; the new T&C block is supplementary free text.
- Retroactively backfilling a From block onto already-issued documents (snapshot semantics).
- Logo handling — already provided via branding; the From block is text-only.
- A new `memo` column — both docs already have a memo-equivalent column (`invoices.notes`, `quotes.introNotes`); we relabel/reposition rather than add schema.

## Key design decision: snapshot at issue

The seller "From" details, the Terms & Conditions block, and the footer are **copied onto the document when it is issued**, exactly as `billTo*` already works. They are not rendered live from the current partner profile after issue.

Rationale: consistency with the existing Bill To snapshot model, and historical accuracy (if an MSP later changes its address or terms, previously-issued documents stay faithful to what the customer received).

Consequences:
- Documents issued before this ships have no `sellerSnapshot`/`termsAndConditions` and won't gain them retroactively; renderers degrade gracefully when a snapshot or any field is absent.
- Quote footer becomes snapshot-at-issue too (today it falls back live at render). At issue we set `terms` from `partner.invoiceFooter` when empty, mirroring invoices — making both doc types consistent.

## Data model

### `partners` — editable source of truth (`apps/api/src/db/schema/orgs.ts`)
New fields:

| Field | Type | Notes |
|---|---|---|
| `billingCompanyName` | `varchar(255)` null | Legal/billing name; falls back to `partners.name` |
| `billingPhone` | `varchar(40)` null | |
| `billingWebsite` | `varchar(255)` null | |
| `billingAddressLine1` | `varchar(255)` null | |
| `billingAddressLine2` | `varchar(255)` null | |
| `billingAddressCity` | `varchar(120)` null | |
| `billingAddressRegion` | `varchar(120)` null | |
| `billingAddressPostalCode` | `varchar(40)` null | |
| `billingAddressCountry` | `char(2)` null | ISO-3166 alpha-2 |
| `billingTermsAndConditions` | `text` null | Partner default for the T&C block |

Reused as-is: `billingEmail`, `invoiceFooter` (footer default), `invoiceTermsDays`.

### `invoices` and `quotes` (`schema/invoices.ts`, `schema/quotes.ts`)
Add to **both**:

| Field | Type | Notes |
|---|---|---|
| `sellerSnapshot` | `jsonb` null | `{ name, addressLine1, addressLine2, city, region, postalCode, country, phone, email, website }` captured at issue (single jsonb, mirrors `billToAddress`) |
| `termsAndConditions` | `text` null | The T&C block; defaulted from `partner.billingTermsAndConditions` at issue, editable per doc |

Unchanged/reused: memo (`invoices.notes` / `quotes.introNotes`), footer (`terms` on both).

### Migration
Single date-prefixed migration `apps/api/migrations/2026-06-19-quotes-invoices-contact-fields.sql`:
- Idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for all new columns on `partners`, `invoices`, `quotes`.
- **No new tables → no RLS policy changes and no `rls-coverage` allowlist edits** (all three tables already have RLS).
- No data backfill. Run `pnpm db:check-drift` after.

## Behavior

### At issue time (invoice + quote lifecycle)
1. Build `sellerSnapshot` from the partner profile (`billingCompanyName ?? name`, address parts, phone, `billingEmail`, website); store only present fields.
2. Default `termsAndConditions` from `partner.billingTermsAndConditions` when the doc's value is empty.
3. Default footer (`terms`) from `partner.invoiceFooter` when empty — now for quotes too (was live fallback).
4. Memo (`notes` / `introNotes`) is whatever the user typed; no default.

After issue these are frozen — not re-resolved from the partner.

### Draft create/update
- Continue accepting memo (`notes` / `introNotes`).
- Accept `termsAndConditions` in create/update payloads; editor pre-fills it from `partner.billingTermsAndConditions` as a starting point.

## Rendering surfaces

Document layout (all surfaces): **From** top-left (beneath logo), **Bill To / Prepared For** top-right → line items → totals → **Memo** ("Notes") → **Terms & Conditions** → **footer** at the very bottom. Each block renders only the fields present.

| Surface | File(s) | Change |
|---|---|---|
| Invoice PDF/HTML | `apps/api/src/services/invoicePdf.ts` | Add From block + T&C block (memo + footer already render) |
| Quote PDF | `apps/api/src/services/quotePdf.ts` | Add From block + T&C block (introNotes + footer already render) |
| Web invoice | `apps/web/src/components/billing/InvoiceDetail.tsx`, `InvoiceEditor.tsx` | Show From; add T&C field; memo relabeled "Memo" |
| Web quote | `apps/web/src/components/billing/quotes/QuoteEditor.tsx` + quote view | Same |
| Portal (customer) | `apps/portal/src/components/portal/InvoiceDetailView.tsx`, `quoteBlocks.tsx` | Show From / Bill To / memo / T&C / footer |

Drafts (web/editor) show a **live preview** of the From block from the current partner profile (no snapshot yet); issued documents render the frozen `sellerSnapshot`.

### Partner settings UI
Extend the existing partner billing settings (where `invoiceNumberPrefix`, `invoiceFooter`, `defaultTaxRate` already live) with the company-contact fields and the `billingTermsAndConditions` default. Single place the MSP maintains its From details, default footer, and default terms.

## API & shared

- **Partner settings update route** + Zod validator: accept new `billing*` contact fields + `billingTermsAndConditions` (`packages/shared/src/validators/`).
- **Issue logic** (`invoiceService.ts`, `quoteLifecycle.ts`): build `sellerSnapshot`; default `termsAndConditions` + footer as above.
- **Invoice/quote create/update**: accept `termsAndConditions`.
- **Shared types** (`packages/shared/src/types/`): seller-snapshot shape + new partner/invoice/quote fields.

> Billing UI↔Zod payload caution (prior billing lesson): keep editor payloads consistent with validator expectations (`undefined` vs `null` for optional text) and add a test exercising the real payload — a class of bug that has bitten billing twice and slipped past unit tests.

## Testing

- **Validators**: new partner contact fields, `termsAndConditions` accepted/rejected correctly.
- **Issue logic** (real-DB integration, `src/__tests__/integration/*.integration.test.ts`): `sellerSnapshot` built from partner; `termsAndConditions` + footer defaulted only when empty; none re-resolved after issue (frozen); quote footer now snapshotted.
- **Renderers**: From / T&C appear on web + portal; absent fields degrade gracefully; issued docs use the snapshot, drafts use the live partner preview.
- Follow `breeze-testing` conventions; tests alongside source.

## Rollout

Ships dark-compatible: existing issued documents simply lack From/T&C until reissued; nothing breaks. No env vars, no new tables, no RLS changes.
