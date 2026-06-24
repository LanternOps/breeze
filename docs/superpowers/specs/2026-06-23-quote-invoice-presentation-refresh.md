# Quote & Invoice Presentation Refresh

**Date:** 2026-06-23
**Status:** Phase 1 implemented; Phases 2–3 planned
**Branch:** worktree `quotes-pdf-preview-templates`

## Problem

1. **Preview regression.** The quote "Preview" tab fetched the PDF as a blob and
   framed it in an `<iframe>`. Browsers delegate that to the built-in PDF viewer,
   which *downloads* the file instead of rendering it whenever the user/Chrome is
   set to "Download PDFs instead of opening them." The code and CSP were correct
   and unchanged since the feature shipped — the regression is browser-side PDF
   handling, not a code change.
2. **Templates look unfinished.** The downloadable quote/invoice PDFs and the
   customer-facing web views should look professional and complete.
3. **No web preview of the customer view.** Staff had no way to preview what the
   customer actually sees (the portal proposal page) from inside the dashboard —
   the portal only serves *sent* quotes, so it can't preview drafts.

## Approach

Render the **customer-facing document as HTML** in the Preview tab instead of
embedding a PDF. HTML always renders inline (kills the download regression), shows
exactly what the customer sees, works for drafts, and is far easier to make
beautiful. "Download PDF" stays for the actual file.

One **premium visual language** — clean, typographic, generous whitespace, a
single partner-brand accent, a commanding totals block (Stripe-invoice /
PandaDoc-proposal sensibility) — applied across all renderers. The app is a
product-UI register, but a customer-facing proposal/invoice is the one surface
that earns a "Committed" accent (the partner's own `primaryColor`, app blue as
fallback).

**Code sharing:** no cross-app React infra (none exists; `@breeze/shared` is
types/validators/utils). The PDF renderer is necessarily its own implementation
(jsPDF), so the source of truth is this design spec, not shared components. Pure
formatters are duplicated locally per repo convention.

## Phase 1 — Preview tab → customer web view (DONE)

- **API:** new `resolveQuoteBranding(quote)` (`apps/api/src/services/quoteBranding.ts`)
  returns `{ partnerName, logoUrl, primaryColor, footer, currencyCode, seller }`.
  `GET /quotes/:id` now returns `{ quote, blocks, lines, branding }`; the PDF route
  was refactored to use the same helper (one source of truth, no second
  round-trip). Reads run on the request's RLS-scoped `db`.
- **Web types:** `QuoteBranding` + optional `branding` on `QuoteDetail`
  (`quoteTypes.ts`).
- **Web component:** `QuoteDocument.tsx` — presentational customer document
  (accent top rule, logo/wordmark + seller "From", status + dates, "Prepared for",
  intro, block walk incl. authed images, recurrence-tagged pricing tables, totals
  with "Due on acceptance" + recurring breakdown, Terms, footer). Default export
  `QuoteDocumentPreview` wraps it with org-name resolution + a Download PDF button.
- **Wiring:** `QuoteWorkspace` Preview tab renders `QuoteDocumentPreview` (old
  PDF-iframe `QuotePreview` removed).
- **Tests:** `QuoteDocument.test.tsx` (inline render, no iframe, content/states).
  Web quote suite 20/20, API quote suite 16/16, both typechecks clean.

### Follow-up (cleanup, not blocking)
- `apps/web/src/lib/csp.ts` + `astro.config.mjs` + `middleware.ts` still allow
  `blob:` in `frame-src` (added in #1750 for the old PDF-iframe preview). The
  preview no longer frames a blob PDF, so it's now only needed by the HelpPanel
  docs iframe path. Left in place to avoid churning the CSP drift guard; the
  comment referencing `QuotePreview` is stale and can be updated when CSP is next
  touched.

## Phase 2 — Customer web views polish (DONE)

New shared `apps/portal/src/components/portal/documentShell.tsx` (`DocumentPaper` /
`DocumentHeader` / `DocumentTerms` / `DocumentFooter`) gives the portal one premium
"paper" look. `PublicQuoteView`, `QuoteDetailView`, and `InvoiceDetailView` now
render through it (accent top rule from the partner color; app primary fallback;
the authed portal views omit the logo since the portal chrome already carries the
partner brand). Shared `quoteBlocks.tsx` pricing table gets the same overflow-safe,
recurrence-grouped styling. Portal `astro check` clean; portal suite 52/52.

## Phase 3 — PDF templates polish (DONE)

`quotePdf.ts` and `invoicePdf.ts` (pdfkit, **not** jsPDF) refreshed: dark partner
wordmark + accent eyebrow ("PROPOSAL"/"INVOICE") + larger document number, a filled
table-header bar, an accent-emphasised primary figure ("Due on acceptance" /
"Balance due" / "Total"), a widened quote-summary label column (fixes the 14pt
"Due on acceptance" wrap/overlap), and pricing **section labels** in the quote PDF
for parity with the web. Verified by rendering sample PDFs (pdftoppm). API PDF tests
14/14 pass.
