---
tracking_issue: LanternOps/breeze#9402
---
# One document renderer for quotes and invoices — Spec

**Status:** draft for approval, 2026-10-20. Todd pre-approved the direction ("go ahead with recommendation"). Every Open Decision in §7 still carries a recommendation for the record.
**Tracking:** LanternOps/breeze#9402. Folds in #6649 (the quote half). Related: #9401 (invoice stop-gap, ships first) and #9350 (portal-wide customer view, stays separate).
**Advisor quorum:** Claude Opus (author) + Codex `gpt-6-astra` xhigh, read-only. Codex agreed with the recommended strategy and added amendments, all adopted. Verdict in §10.

All file:line references are against `origin/main` at `f05560b9d0` and were re-checked by an independent pass. #9401 quotes line numbers for three invoice files that are a few lines off on that SHA; the numbers below are the corrected ones.

## 1. Problem

Quotes and invoices are each drawn by separate, hand-written renderers on every surface:

| Surface | Invoice | Quote |
|---|---|---|
| Editor | `InvoiceWorkspace.tsx` editor tab | `quotes/QuoteLineRows.tsx` (blurb at `:246`) |
| Web Preview tab | `InvoiceDocument.tsx` | `quotes/QuoteDocument.tsx` |
| Web Detail tab | `InvoiceDetail.tsx` (`LineItemsTable` at `:495`) | `quotes/QuoteDetail.tsx` (`LineItemsTable` at `:656`) |
| Portal, public token link | `PublicInvoiceView.tsx` → `invoicePaper.tsx` | `PublicQuoteView.tsx` → `quoteBlocks.tsx` + inline totals |
| Portal, logged in | `InvoiceDetailView.tsx` → `invoicePaper.tsx` | `QuoteDetailView.tsx` → `quoteBlocks.tsx` + a second copy of the inline totals |
| PDF (pdfkit) | `apps/api/src/services/invoicePdf.ts` | `apps/api/src/services/quotePdf.ts` |
| HTML (test-only) | `renderInvoiceHtml` (`invoicePdf.ts:201`). Imported by `invoicePdf.test.ts:6`, `invoicePdf.lineDetail.test.ts:7` and `invoicePdf.golden.test.ts:6`, and by no production code. | — |

Web paths are under `apps/web/src/components/billing/`, portal paths under `apps/portal/src/components/portal/`.

Nothing is shared between the two apps. `apps/portal` is a separate Astro app, and `packages/shared` has no React (`packages/shared/package.json` has no `react` dependency). The portal files say in their header comments that they "mirror" the web files (`documentShell.tsx:5`, `quoteBlocks.tsx:2-3`), so each fix lands on one surface only. Todd, 2026-10-20: "It should be the exact same code for both, really, so we don't have this digression."

### 1.1 Verified drift

| # | What | Where it differs |
|---|---|---|
| D1 | Invoice line blurb loses line breaks | These lack `whitespace-pre-line`: web Preview `InvoiceDocument.tsx:43`, web Detail `InvoiceDetail.tsx:536`, portal `invoicePaper.tsx:102`. The quote equivalents have it: `QuoteDocument.tsx:208`, `QuoteDetail.tsx:670`, `quoteBlocks.tsx:153`. |
| D2 | PDF description width | Invoice `invoiceColumnsFor` (`invoicePdf.ts:371-404`) gives the description 0.28 of the width taxed and 0.40 untaxed. Quote `columnsFor` (`quotePdf.ts:386-421`) gives 0.42 and 0.57. |
| D3 | PDF column order | The invoice PDF runs description, qty, unit, tax, amount. The quote PDF puts **qty first**: `colQtyX: left` at `quotePdf.ts:394` and `:409`, description at `left + 0.08` (`:390`). Every on-screen table puts the description first. |
| D4 | PDF fonts | The invoice PDF's line drawing (a `drawLine` closure inside `renderInvoicePdfBuffer`, `invoicePdf.ts:507-567`) hard-codes Helvetica. The quote PDF uses the document theme's fonts (`registerThemeFonts`, `quotePdf.ts:1118`). The portal applies the theme to invoices (`PublicInvoiceView.tsx:109,232`, `docTheme={branding.theme}`), so a 'condensed' invoice is condensed on screen and Helvetica in its PDF. |
| D5 | Quote cover page | The web Preview has none: `QuoteDocument.tsx` never renders a cover. The portal draws `DocumentCover` (`documentShell.tsx:55-96`). The PDF draws a full-page portrait cover (`renderCoverPage`, `quotePdf.ts:943-1072`). |
| D6 | Cover crop | The PDF draws the image full-bleed on a portrait page, with the title band starting at 62% of the page height (`quotePdf.ts:999`, `bandTop = doc.page.height * 0.62`). The portal draws `h-48 w-full object-cover sm:h-64`, a centre-cropped landscape strip (`documentShell.tsx:68`). An image designed for the PDF loses its top and bottom in the portal (#6649 comment, Q-2026-0001). |
| D7 | Header | The web Preview shows the number as a sans `text-[1.75rem]` `<p>`, then an "Invoice"/"Proposal" type label, then a `StatusPill` (`InvoiceDocument.tsx:158-168`, `QuoteDocument.tsx:602-609`). It has a short accent rule under the logo (`InvoiceDocument.tsx:145`). The portal shows an accent eyebrow, a serif `font-display` `<h1>` number and a `markChipClass` status, with a full-width accent bar at the top of the paper (`documentShell.tsx:39,139-146`). |
| D8 | Bill-to and notes | The web Preview puts a "Bill to" block under the header with the invoice notes directly beneath it (`InvoiceDocument.tsx:181-191`). The portal puts "Bill to" inside the header, and the notes in a "Notes" block **after** the totals (`PublicInvoiceView.tsx:253`). |
| D9 | Ticket group header | The web Preview shows "Ticket #N: subject" (`InvoiceDocument.tsx:218-222`). The portal shows "Ticket #N" with no subject (`invoicePaper.tsx:62`), because `CustomerInvoiceLine` carries no subject (`invoiceService.ts:976-1000`). The PDF shows "Ticket #N: subject" plus a "Category: …" line (`invoicePdf.ts:495-505`). Three surfaces give three answers. |
| D10 | Bundle child lines | The web Preview indents components with "↳" (`InvoiceDocument.tsx:29-37`). The customer payload has no `parentLineId` (`toCustomerInvoiceLine`, `invoiceService.ts:1055-1080`), so the portal prints them flat. |
| D11 | Invoice totals | The web Preview says "Amount due", shows Paid as a positive figure, shows the Tax row only when tax is non-zero, and sets the balance in sans (`InvoiceDocument.tsx:260-299`). The portal says "Balance due" or "Balance", shows Paid as "−", always shows the Tax row, adds a deposit strip, and sets the balance in serif (`invoicePaper.tsx:126-159`). |
| D12 | Terms | The web Preview shows a plain pre-wrapped block (`InvoiceDocument.tsx:303-310`). The portal shows a collapsible `<details>` with detected sections and a contents list (`DocumentTermsCollapsible`, `documentShell.tsx:277`). |
| D13 | Phone layout | Below `sm`, the portal folds Qty × Price under the description (`invoicePaper.tsx:101`). The web Preview forces `min-w-[30rem]` and scrolls sideways (`InvoiceDocument.tsx:201`). |
| D14 | Paper theme | The portal pins a white paper token block on `[data-doc-theme]` (`apps/portal/src/styles/globals.css:556-593`), so neither dark mode nor the chrome accent reaches the document. Web has no such block, so its Preview paints with the web app's own tokens. It does so even where it stamps the theme: `QuoteDocument.tsx:574` stamps `data-doc-theme` and `InvoiceDocument.tsx` does not. The logged-in portal invoice passes no `docTheme` (`InvoiceDetailView.tsx:263`), so it always renders `classic` (`documentShell.tsx:36` default), while the public invoice passes the real theme. |
| D15 | Accent delivery | Web sets the accent with inline `style` attributes: `InvoiceDocument.tsx:125,145,286,291` and `QuoteDocument.tsx:457,572,589,710,718,730,735`. `QuoteDocument.tsx:297,310` also put `textAlign` in a `style` attribute. The portal uses one nonced `<style>` element plus `.doc-accent-*` classes (`apps/portal/src/lib/docAccent.ts`, `globals.css:539-547`), because its CSP sends `style-src-attr 'none'` (`apps/portal/src/lib/csp.ts:47`). Move a web component into the portal unchanged and its server-rendered markup draws an unstyled grey rule, but only in production. |
| D16 | Label language | Web Preview labels follow the **staff user's UI language** (`useTranslation('billing')`, `InvoiceDocument.tsx:73`; dates via `i18n.language`, `:40`). Portal labels are hard-coded English. PDF labels are hard-coded English (`'DESCRIPTION'`, `'QTY'`, `` `Issued: ` ``, `` `Due: ` `` at `invoicePdf.ts:472-488`, and the same pattern at `quotePdf.ts:1178-1179`). The exceptions are two invoice line strings (`tApi` at `invoicePdf.ts:134,145`), which follow the document locale. `apps/api/src/i18n/locales/pt-BR/pdf.json` has keys for the rest, but no code reads them. So a pt-BR technician previews in Portuguese an invoice that the customer receives in English. |
| D17 | Accent on the public invoice | The public invoice page deliberately fetches client-side, for rate-limit reasons (`apps/portal/src/pages/invoice/[token].astro:2-7`). `PublicDocumentLayout.astro:38` emits the nonced accent `<style>` only when the accent is known at SSR, and the invoice page passes none. The customer's public invoice therefore uses the app primary colour instead of the partner's brand colour. |
| D18 | Money and date locale | The portal formats money in the **browser's** language, and in English during SSR (`portalLocale()`, `apps/portal/src/lib/money.ts:11-14`). The PDF formats money in the document locale, but always formats dates as `en-US` (`invoicePdf.ts:109`, `quotePdf.ts:48`). The web Preview uses the staff UI language for both. |
| D19 | Server payload per host | The public quote route serializes through `toPublicQuoteHeader` (`apps/api/src/services/publicQuoteDto.ts:88`). The logged-in portal quote route spreads the raw quote row into its response (`apps/api/src/routes/portal/quotes.ts:99`). The two portal pages for one quote receive differently shaped data, so sharing JSX alone would not make them agree. |
| D20 | Preview caption | `billing.json` says "This is what your customer sees on their proposal link." (`apps/web/src/locales/en/billing.json:1615`) and "…on their invoice." (`:2203`). D5–D19 make both false. |

Wherever two renderers exist, they disagree, and a customer or Todd is the one who finds it. D19 is the second half of the problem: the hosts are not fed the same data either, so a shared component needs a shared server projection behind it.

## 2. Users and scope

- **Partner staff** (technicians, billing admins) use the Preview tab to check a draft before sending it, and the Detail tab to work on the document (internal cost and margin, devices, hidden lines).
- **Customer contacts** read the document on the public token link (no login) or in the logged-in portal, and receive the PDF by email.

"Every surface" means every surface that **presents the document to be read**. The editors and the Detail workbench stay staff tools with their own layouts. They share the line-description presenter (OD-4), not the document composition.

**In scope:**
- Document content: the line table (title, blurb with preserved line breaks, work date, worked-vs-billed note, ticket and day grouping, device-set descriptor, thumbnails, tax column), totals, header with from/bill-to, intro notes, terms, the quote cover, and quote content blocks. Both document kinds.
- Surfaces: the web Preview, the web Detail tab (its customer-visible description cell only), the portal public page and the portal logged-in page.
- One server-side customer-document assembler that feeds all of those surfaces.
- One PDF line-table, totals and pagination module for both PDF services.
- One theme source that both apps consume.
- Parity tests.

**Tenancy.** No new tables and no new columns. The cover-crop recommendation (OD-5) avoids a focal-point column on purpose. If a later wave adds one, it lands on `quotes`, which is an org-cascade table. Per `docs/agents/tenancy-rls.md`, it would then need a `CORE_TENANT_EXPORT_POLICY` classification (a `jsonb` column is `excludedOpen`). Cascade, merge and RLS registration would not change, because the table is already registered. The new staff read routes (§3.4) run under the caller's `withDbAccessContext`, with the same org and site checks as the existing detail routes.

## 3. Proposed design

### 3.1 Shape

The design has three layers. They are split so that the PDF services can use the first two:

1. **Server assembler** (`apps/api/src/services/customerDocument.ts`, new). This is the one function per document kind that turns rows into the customer DTO. The public route, the logged-in portal route, the new staff customer-view route and the PDF service all call it. Eligibility (whether the caller may see this document now) stays in each route. The assembler only shapes data.
2. **`packages/shared/src/documents/`** (pure TypeScript, no React). It holds the view-model types `InvoiceDocumentModel` and `QuoteDocumentModel`, their builders from the customer DTO, and the label maps. `apps/api`, `apps/web` and `apps/portal` can all import it.
3. **`packages/document-ui`** (new workspace package `@breeze/document-ui`). It holds the React components that render a model, including the **complete document composition**: blocks, agreements and terms disclosure, not only the primitives. Keeping a separate composition per app would preserve the drift. React and React-DOM are peer dependencies, as in `packages/office-addin-core/package.json`. The package imports `@breeze/shared` and nothing from either app. It has no i18next and no editor dependencies.

```
packages/document-ui/
  package.json            # peer: react, react-dom; deps: @breeze/shared, lucide-react
  src/index.ts
  src/DocumentPaper.tsx   # [data-document-root][data-doc-theme] root, accent bar, padding
  src/DocumentHeader.tsx  # logo/wordmark, seller "From", eyebrow, number, status, dates, bill-to
  src/DocumentCover.tsx   # quote cover (OD-5 geometry)
  src/DocumentLineTable.tsx       # table shell, ticket and day groups, rows
  src/DocumentLineDescription.tsx # the description cell: title, date, qty fold, blurb, note, descriptor, ticket
  src/DocumentTotals.tsx  # renders a DocumentTotalsModel (the invoice and quote rules live in the builders)
  src/DocumentNotes.tsx
  src/DocumentTerms.tsx   # short terms + collapsible T&C (useDeepLinkedDisclosure moves here from documentShell.tsx:184)
  src/DocumentAgreements.tsx      # quote contract blocks + T&C rows, lazy PDF body, print expansion
  src/QuoteBlocks.tsx     # rich_text, table, callout, image, line_items, contract
  src/InvoiceDocumentView.tsx
  src/QuoteDocumentView.tsx
  src/hostComponents.ts   # DocumentHostComponents: Image, AgreementFile (§3.6)
  src/document.css        # paper tokens, fonts, .doc-accent-*, condensed theme, cover geometry, isolation
  src/tokens.ts           # the host tokens the package relies on (§3.5)
  src/__tests__/noStyleAttribute.test.tsx
  src/__fixtures__/       # shared parity fixtures + committed normalized-markup snapshots
```

### 3.2 The view-model contract

The model is built **only** from the customer DTO (§3.4). It holds display-ready values, formatted in the document's locale and currency, and booleans for what to show. Components hold no business rules: no visibility filtering, no tax maths, no fallback chains. That is what lets two apps render the same thing.

Money is the one exception to "only strings". The PDF re-derives a glyph-safe string from the raw amount: `formatMoneyForPdf` (`apps/api/src/services/pdfMoney.ts:53`) falls back to the currency code when the symbol form is not WinAnsi-safe, for example `₹` or the narrow no-break space that `fr-FR` emits. So money travels as `DocumentMoney`.

```ts
// packages/shared/src/documents/model.ts
declare const sanitized: unique symbol;
/** HTML that passed the assembler's server-side sanitizer. Only the assembler casts to it;
 *  every dangerouslySetInnerHTML sink in the package accepts only this type. */
export type SanitizedHtml = string & { readonly [sanitized]: true };

export interface DocumentAssetRef {
  kind: 'logo' | 'cover' | 'block_image' | 'line_thumb' | 'agreement_file';
  /** line_thumb: the line's uploaded image id, else its catalog item id (quotePdf.ts:579-585). */
  id: string;
}

export interface DocumentMoney {
  text: string;             // screen form, document locale
  amount: string;           // decimal string, for the PDF's glyph-safe re-format
  currency: string;
  suffix: { text: string; srText: string } | null;   // "/mo" + "per month" (OD-11)
}

export interface DocumentDate { text: string; iso: string }   // <time dateTime={iso}>

export interface DocumentBranding {
  logo: { kind: 'asset'; ref: DocumentAssetRef } | { kind: 'url'; url: string } | null;
  logoAlt: string;
  wordmark: string | null;           // partner name, else seller name
  theme: DocumentThemeId;            // 'classic' | 'condensed'
  pageSize: DocumentPageSize;        // 'a4' | 'letter'; sets the cover aspect (OD-5)
  seller: { name: string | null; lines: string[]; phone: string | null; email: string | null; website: string | null } | null;
}

export interface DocumentHeaderModel {
  eyebrow: string;                   // "Invoice" / "Proposal"
  number: string;                    // "INV-0042", or the draft fallback label
  subtitle: string | null;           // a proposal's title
  status: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } | null;
  dates: { label: string; value: DocumentDate }[];
  billTo: { label: string; name: string; addressLines: string[]; taxId: string | null } | null;  // null when a cover carries "Prepared for"
}

export interface DocumentLineRow<Tax extends DocumentMoney | 'exempt' | null> {
  key: string;                       // server line id (§3.4 adds it to the invoice projection)
  title: string;                     // non-empty: '—' or the localised labor label (builder asserts)
  blurb: string | null;              // rendered with whitespace-pre-line (fixes D1 by construction)
  workDate: DocumentDate | null;
  qty: string;
  unit: DocumentMoney;
  tax: Tax;                          // 'exempt' renders '—' with srText "Not taxable"
  amount: DocumentMoney;
  note: string | null;               // worked-vs-billed disclosure
  descriptor: string[];              // quote device-set lines
  ticketText: string | null;         // the logged-in portal's per-line ticket (invoicePaper's showLineTicket)
  thumbnail: DocumentAssetRef | null;
  isChild: boolean;                  // bundle component (D10, OD-9)
}

export type DocumentGroupHeader =
  | { kind: 'ticket'; title: string; category: string | null }   // invoices (D9, OD-9)
  | { kind: 'cadence'; label: string }                           // quotes: One-time / Monthly / Annual (quoteBlocks.tsx:115-121)
  | null;

export interface DocumentLineGroup<Tax extends DocumentMoney | 'exempt' | null> {
  key: string;
  header: DocumentGroupHeader;
  days: { key: string; header: { date: DocumentDate; hours: string; total: DocumentMoney } | null; rows: DocumentLineRow<Tax>[] }[];
}

interface LineTableBase { label: string | null; subtotal: { label: string; parts: DocumentMoney[] } | null; emptyText: string | null }
/** The tax column is shown iff `columns.tax` is a string; rows are typed to match, so the two cannot disagree. */
export type DocumentLineTableModel =
  | (LineTableBase & { columns: { description: string; qty: string; unitPrice: string; tax: string; amount: string }; groups: DocumentLineGroup<DocumentMoney | 'exempt'>[] })
  | (LineTableBase & { columns: { description: string; qty: string; unitPrice: string; tax: null; amount: string }; groups: DocumentLineGroup<null>[] });

export interface DocumentTotalsRow {
  key: string;
  label: string;
  value: DocumentMoney | DocumentMoney[];        // a list renders joined with ' + ', stacked when too wide
  weight: 'muted' | 'regular' | 'strong' | 'hero';
  ruleAbove: 'none' | 'neutral' | 'accent';
  sign?: 'minus';                                 // "Paid −$100.00"
}
export interface DocumentTotalsModel {
  rows: DocumentTotalsRow[];
  aside: { rows: DocumentTotalsRow[]; note: string } | null;    // the quote's tinted first-period box
  depositStrip: { parts: (string | { strong: string })[] } | null;
}

export interface InvoiceDocumentModel {
  kind: 'invoice';
  locale: string;                    // resolved document locale (§3.7)
  branding: DocumentBranding;
  header: DocumentHeaderModel;
  notes: string | null;
  lines: DocumentLineTableModel;
  totals: DocumentTotalsModel;
  terms: { short: string | null; full: { label: string; text: string; meta: string } | null };
  footer: string | null;
}

export interface QuoteTableBlock {
  columns: { label: SanitizedHtml; align: 'left' | 'center' | 'right' }[];
  rows: { key: string; cells: SanitizedHtml[] }[];   // builder asserts cells.length === columns.length
  headerStyle: 'plain' | 'tinted';
  zebra: boolean;
  caption: string | null;
}

export type QuoteBlockModel =
  | { kind: 'heading'; key: string; level: 1 | 2 | 3; text: string }      // quoteBlocks.tsx:221-230
  | { kind: 'rich_text'; key: string; html: SanitizedHtml }
  | { kind: 'table'; key: string; table: QuoteTableBlock }               // alignment as classes, never style
  | { kind: 'callout'; key: string; tone: 'neutral' | 'warn' | 'accent'; title: string | null; html: SanitizedHtml }
  | { kind: 'image'; key: string; image: DocumentAssetRef | null; alt: string; caption: string | null; width: number | null }
  | { kind: 'line_items'; key: string; table: DocumentLineTableModel };
// Contract blocks are not body blocks (today they render null in the body); they appear only in `agreements`, in block order.

export type AgreementBody =
  | { kind: 'authored'; html: SanitizedHtml | null; footer: string }
  | { kind: 'uploaded'; file: DocumentAssetRef | null; footer: string };     // lazy-mounted (derived from kind)

export interface QuoteDocumentModel {
  kind: 'quote';
  locale: string;
  branding: DocumentBranding;
  cover: { title: string; image: DocumentAssetRef | null; preparedFor: string | null; preparedBy: string | null; eyebrow: string } | null;
  header: DocumentHeaderModel;
  introNotes: string | null;
  blocks: QuoteBlockModel[];         // includes the trailing default pricing table for un-blocked lines
  totals: DocumentTotalsModel;
  terms: { short: string | null };
  agreements: { id: string; anchor: string; title: string; meta: string; body: AgreementBody }[];  // anchor: `agreement-<blockId>` | 'terms'
  footer: string | null;
}
```

Builders:

```ts
buildInvoiceDocumentModel(dto: CustomerInvoiceDocument, labels: DocumentLabels): InvoiceDocumentModel
buildQuoteDocumentModel(dto: CustomerQuoteDocument, labels: DocumentLabels): QuoteDocumentModel
```

The builders are pure and take no surface argument, so the same DTO always yields the same model. Hosts differ in only two things: the `DocumentHostComponents` they pass to the view (§3.6) and their slots (§3.3).

**Invariants that stay derived, not stored:**
- **Header level.** `QuoteDocumentView` renders the header number as an `h2` when `cover !== null` and as an `h1` otherwise. When a cover is present, the builder sets `header.billTo = null`, because the cover carries "Prepared for". This is today's `preparedForName={cover ? undefined : …}`.
- **Agreement links.** The signature slot builds its agreement links from `model.agreements`. This replaces `quoteAgreementLinks(blocks, …)`, which walks the raw blocks.
- **Test ids belong to the package.** The portal's two `testIdPrefix` values (`public-quote` and `quote`) go away, so the markup under `[data-document-root]` is identical across hosts. The Playwright selectors move with it.

### 3.3 Surfaces mapped onto the model

| Surface | Invoice | Quote |
|---|---|---|
| Web Preview | `InvoiceDocumentPreview` fetches `GET /invoices/:id/customer-view`, builds the model and renders `<InvoiceDocumentView>`. It keeps the Download PDF button. | The same with `/quotes/:id/customer-view` and `<QuoteDocumentView>`, cover included. The signature slot renders an inert "Your customer signs here" placeholder. |
| Portal public | `PublicInvoiceView` keeps its fetch, payment rail, notices and void state. The paper becomes `<InvoiceDocumentView>`. | `PublicQuoteView` keeps its fetch, `SignaturePanel` and accept/decline. The paper becomes `<QuoteDocumentView slots={{ signature }}>`. |
| Portal logged in | `InvoiceDetailView`, the same as public. | `QuoteDetailView`, the same as public. Its own copy of the totals goes away. |
| Web Detail | `LineItemsTable` stays. Its description cell renders `<DocumentLineDescription>` (OD-4). | The same for `QuoteDetail`. |
| PDF | `invoicePdf.ts` draws its line table, totals box and pagination through `documentPdfTable.ts` (§3.8). | `quotePdf.ts` does the same. |

**What stays in the package and what goes to the host.** The package handles document interactions that are safe for any reader: agreement disclosure, deep links, lazy PDF bodies and print expansion. Anything that mutates is a host slot. `InvoiceDocumentView` and `QuoteDocumentView` take `slots?: { beforePaper?, afterTotals?, signature?, afterPaper? }`, which carry the payment rails, notices, the signature panel and the accept/decline feedback. Whole-page states are host policy rendered outside the document: void, superseded, link unavailable, and online payment unavailable. The parity test serializes `[data-document-root]` with the slot containers emptied.

**Preview freshness.** The web app has no query cache. The workspace reloads its detail through `reload()` (`InvoiceWorkspace.tsx:117`). The Preview refetches customer-view whenever `reload()` runs and each time the Preview tab is shown, so it never shows a DTO older than the last save.

**Deleted:**
- `apps/portal/src/components/portal/invoicePaper.tsx`.
- `quoteBlocks.tsx`, including its line table, pricing table and block walk.
- `documentShell.tsx` and `quoteAgreements.tsx`. Their contents move into the package.
- The inline totals in `PublicQuoteView.tsx` and `QuoteDetailView.tsx`.
- The bodies of `InvoiceDocument.tsx` and `QuoteDocument.tsx`. Each shrinks to its Preview wrapper.
- The private `lineTitle`/`lineBlurb`/`deviceSetCustomerText`/`lineTax` copies in the portal and web files, plus `deviceSetCustomerText` and `lineTax` in `quotePdf.ts:60,88` and `invoicePdf.ts:116`. The builders own them.
- `renderInvoiceHtml`, with its golden snapshot and test cases. Assertions that still matter move to builder or PDF-output tests.
- Every "mirrors the dashboard" comment.

**The Preview caption becomes true.** It stays as written at `billing.json:1615,2203` once the Preview and the portal render the same component from the same DTO. A wave whose parity test cannot be made to pass rewords the caption for its document kind instead of shipping.

### 3.4 Customer-document assembler and customer-view routes

Today the web Preview reapplies the customer rules in the browser from the staff payload: `InvoiceDocument.tsx:87-90` filters on `customerVisible`, and `:32-33` calls `invoiceLineText`/`lineWorkDateToShow`. The portal receives lines already projected on the server (`toCustomerInvoiceLine`, `invoiceService.ts:1055`, called from `invoicesPublic.ts:194` and through `getCustomerInvoice` for `routes/portal/invoices.ts:126`). Two implementations of who-sees-what is the same mistake as two renderers. D19 shows that the portal's own two quote routes already disagree.

**Assembler.** `customerDocument.ts` owns the whole path from document id to customer DTO, including the row query. Today the customer row filter is already copied twice, and the copies differ: `invoicesPublic.ts:150-156` does not filter on `invoiceLines.orgId`, while `getCustomerInvoice` (`invoiceService.ts:1132-1155`) does. A third copy in the staff route would be one more place where a hidden line can leak into a Preview that claims to be the customer view.

The module exports:
- `loadCustomerInvoiceLines(invoice)` and `loadCustomerQuoteRows(quote)`. These are the single customer row queries (`customerVisible = true`, org-scoped joins).
- `assembleCustomerInvoiceDocument(invoiceId, mode)` and `assembleCustomerQuoteDocument(quoteId, mode)`. They call those loaders, then wrap the existing serialization boundaries (`toCustomerInvoiceHeader`/`toCustomerInvoiceLine`, `toPublicQuoteHeader`), and add branding, presentation and the resolved `documentLocale`.

`projectCustomerInvoiceLine` (`invoiceService.ts:1086`, used at `routes/portal/invoices.ts:208`) is a second fixed keyset over the same line. It is folded into the assembler, so a field added to the projection (such as an OD-9 field) cannot be dropped on one path.

The public routes, the logged-in portal routes (replacing the raw spread at `routes/portal/quotes.ts:99`) and the new staff routes all return the assembler's output. Each route supplies only eligibility and its `mode`.

**Line ids.** The invoice projection gains `id` (the `invoice_lines.id` already present in the staff payload). The model's row `key` and the package's test ids need a stable id. An array index changes with every edit; today the portal keys rows by `${title}-${index}`. The id is an opaque row identifier, not customer-visible content, so §5's rule on visibility is unchanged.

**Modes.** `mode` is `'public' | 'portal' | 'staff'`. It is an explicit parameter, not a fork, and it controls three things:

1. **Line detail.** Every mode uses the frozen columns for an issued document (`customerLineDetail`, `invoiceService.ts:1046`). For a draft (staff mode only), the assembler first resolves the partner default, using the resolver the staff detail already uses. That resolver is `resolveDocumentLineDetail`: defined at `invoiceService.ts:967`, called at `:961`, module-private today, and exported in W1. The partner default is what the draft will freeze to at issue. Draft defaults are resolved *before* the projection, never inside it.
2. **Status.** Today the three paths treat status differently:
   - `toPublicStatus` maps `sent` to `viewed`, throws on `draft`, and throws 410 on `superseded` (`publicQuoteDto.ts:53-75`).
   - The logged-in portal applies no mapping. It serves superseded quotes, which `QuoteDetailView.tsx:216` shows with a "Replaced" notice.

   The assembler keeps each path's behaviour. `'public'` keeps the mapping and the refusals. `'portal'` keeps the raw status and serves superseded documents. `'staff'` accepts any status, including `draft`.

   Every mode also emits `displayStatus`: the status label the customer's public link would show (`sent` → "Viewed", `draft` → none). The header renders `displayStatus` in every mode, so the Preview's pill is the customer's pill. The raw status stays in the staff workspace chrome.
3. **Eligibility errors.** Only the routes raise them. The assembler shapes data; it never decides who may see it.

Eligibility therefore stays in the routes: the portal draft refusal (`routes/portal/invoices.ts:134-135`), public link revocation and supersession (`isPublicLinkDead`, `quotesPublic.ts:87`), and the void and superseded screens.

**Staff routes.** Two new routes sit beside the existing detail routes:
- `GET /invoices/:id/customer-view` in `apps/api/src/routes/invoices/invoices.ts`, beside `:65`.
- `GET /quotes/:id/customer-view` in `apps/api/src/routes/quotes/quotes.ts`, beside `:125`.

Each uses the same `scopes` + `readPerm` middleware and the same org and site ownership lookup as its detail route, so access is exactly "can read this document". Each is free of side effects:
- It never stamps `viewedAt`/`firstViewedAt`, because `markViewed` is not called.
- It never mints or returns an accept or pay token.
- It writes no audit row, because it reads data the caller can already read on the detail route.

`apps/api/src/services/mcpCoverage.ts` keys coverage by route file, not by route, and both files are already covered (`'invoices/invoices.ts'` at `:510`, `'quotes/quotes.ts'` at `:632`). No coverage entry changes.

This is #9350's option (a) applied to a single document: a staff read of the customer read model, with no portal credential.

### 3.5 Theme, tokens and CSS isolation

Both apps use Tailwind v4 with CSS-first config, and neither has a `tailwind.config.*` (`@import 'tailwindcss'` in `apps/web/src/styles/globals.css:35` and `apps/portal/src/styles/globals.css:26`). The shared piece is therefore a stylesheet, not a preset.

- **`packages/document-ui/src/document.css`** holds everything document-scoped that is portal-only or duplicated today:
  - the `[data-doc-theme]` paper token block, moved from portal `globals.css:556-593`;
  - `.doc-accent-bg/-text/-border` (`:539-547`);
  - the condensed theme rules (portal `:527-533`, web `globals.css:34654-34665`) and their font imports;
  - the cover geometry (OD-5) and `.signature-preview`.

  The document owns its fonts and tokens inside `[data-document-root]`, so neither the host's font stack nor its dark mode reaches the paper. The portal's `src/styles/paperTokens.test.ts`, which pins the paper block today, moves into the package with the block.
- **Wiring.**
  - `packages/document-ui/package.json` exports `"./document.css": "./src/document.css"` beside `"."`. `office-addin-core` exports only `"."`, so this is a new pattern.
  - Each app's `globals.css` imports it **above** `@import 'tailwindcss'`, with no `layer()`, next to the existing fontsource imports. Both files' headers state this rule (web `:7-14`, portal `:5-7`): Vite's postcss-import drops any `@import` that is not first.
  - Each app also adds `@source '../../../../packages/document-ui/src/**/*.{ts,tsx}';`, four levels up, because both stylesheets sit at `apps/<app>/src/styles/`. The three-level path in `apps/word-addin/src/index.css:10` works only because that file is one directory higher.
  - A test in each app builds the CSS and asserts that a `document.css` selector and a package-only utility class both appear in the output. DOM parity cannot see a wrong `@source`.
- **Isolation from host overrides.** Web density modes `compact` (`apps/web/src/styles/globals.css:34539` onward) and `dense` (`:34595` onward) rewrite utility spacing under `main` with `!important`, e.g. `[data-density='compact'] main .p-8`. A Preview inside `main` would be re-spaced. Those selectors gain `:not([data-document-root], [data-document-root] *)`, which covers the root element as well as its descendants, because `DocumentPaper` itself carries padding. A web test fails if any `[data-density]` rule can match the document root or anything inside it. Any other host rule that targets bare utilities under `main` gets the same exclusion.
- **Token contract.** `packages/document-ui/src/tokens.ts` lists every host token the package reads, including the ones the paper block reads. The paper block sets `--primary: var(--paper-primary)`, and today only the portal's light theme blocks define `--paper-primary` (portal `globals.css:121,248-290`). W1 adds `--paper-primary` to web's light `:root` (equal to web's light `--primary`), and `document.css` writes `--primary: var(--paper-primary, 225 62% 48%)`. That gives a literal HSL-triplet fallback, matching how both apps store tokens and read them through `hsl(var(--primary))`. A test in each app parses that app's `globals.css` and fails if any listed token is missing.
- **Accent.** `--doc-accent` stays the host's job, and the package never writes a `style` attribute. `noStyleAttribute.test.tsx` renders every component with every fixture and fails on any element that carries `style`. Today's `textAlign` style attributes (`QuoteDocument.tsx:297,310`) become alignment classes, as the portal already does (`quoteBlocks.tsx:199-207`). Hosts deliver the accent as follows:
  - **Portal SSR pages:** the nonced `<style>` from `PublicDocumentLayout.astro:38`, as today.
  - **Portal client-fetched pages** (the public invoice, D17): a portal-only `useDocumentAccent(ref, color)` hook. It runs `sanitizeAccentColor` (`docAccent.ts`), then sets the value through CSSOM on a host wrapper element: `ref.current.style.setProperty('--doc-accent', sanitized)`. It does not write to `<html>`, because `PublicDocumentLayout` mounts `<ClientRouter />` and its navigations replace the attributes on `<html>`. `style-src-attr` governs `style` attributes set by the parser or by `setAttribute`, not CSSOM property writes such as `style.setProperty`. The W1 Playwright slice runs under the production CSP (§8.2) and proves it. If it fails there, the fallback is a nonced `<style>` element created from the page's nonce.
  - **Web:** sets the variable on a wrapper `<div>` outside the package, as it does now.

DOM parity does not catch two Tailwind builds emitting different CSS for the same class. The screenshot matrix (§8.2) is the guard for that.

### 3.6 Images and assets

Image delivery differs per host:
- The public portal uses plain URLs: `/quotes/public/:token/images/:id` (`PublicQuoteView.tsx:188,216-218`).
- The web needs an **authenticated fetch turned into an object URL**, because a bare `img src` would 401 (`QuoteDocument.tsx:30-31`, `DocLineThumb`/`DocImage`).

The model therefore carries `DocumentAssetRef`s, not URLs. The view takes `components: DocumentHostComponents`, which has two members:
- `Image({ asset, alt, className })`.
- `AgreementFile({ asset, title })`, which renders an uploaded agreement's PDF viewer and download link.

In the portal, both are plain elements with host-built URLs. In the web, both use the existing authenticated fetch. Parity fixtures use deterministic stand-ins: `<img data-asset="kind:id">` and `<a data-asset="kind:id">`. That way markup compares exactly. Real asset loading is tested inside each app's existing Astro island.

### 3.7 Strings and language

- `packages/shared/src/documents/labels.ts` exports `type DocumentLabels` and `DOCUMENT_LABELS_EN`, the single source of the English defaults. The type covers every string the document prints, with pluralised read-time and interpolated device-set text as small functions.
- **The document's locale governs everything printed**: labels, money, dates and plurals. The chain is `invoice.documentLocale ?? partner locale ?? 'en'`, the chain the PDF already uses for money (`resolveRenderLocale`, `invoicePdf.ts:101`). The assembler resolves it and puts it in the DTO. The builder formats everything with it, including the dates that the PDF prints as `en-US` today (D18). No component reads `navigator.language` or the viewer's i18next language, so SSR and hydration produce the same text. The staff UI around the Preview stays in the staff user's language.
- **Where the strings live.** The web and portal cannot import `apps/api`, so the document strings move **out of** the API's `pdf` namespace and **into** `packages/shared/src/documents/labels/{en,pt-BR}.ts`. The API's PDF code reads the same maps. Strings the document prints never live anywhere else, which gives the PDF and the screen one source.
- **Locales.** W1 ships English (`DOCUMENT_LABELS_EN`). W3 ships pt-BR: it moves the existing pt-BR strings from `apps/api/src/i18n/locales/pt-BR/pdf.json` into `labels/pt-BR.ts`, and switches the PDF headers' hard-coded `Issued:`/`Due:`/`Valid until:` and column labels (D16) to the shared labels. From W3 on, the document reads the same on screen and in the PDF in pt-BR. A locale without document labels falls back to English on every surface, which is what the portal does today. (OD-3)
- Web's `invoiceDocument.*` and `quotes.document.*` keys in `billing.json` that only the document body uses are deleted from all 7 locales, keeping `localeParity` green. Preview chrome keys (the caption, Download PDF) stay.

### 3.8 PDF module

A new `apps/api/src/services/documentPdfTable.ts` is used by both `invoicePdf.ts` and `quotePdf.ts`. It takes the same `DocumentLineTableModel` and `DocumentTotalsModel` the screen renders, so the PDF and the screen print the same strings. Money is the one exception: the PDF re-formats it from `DocumentMoney.amount` through `formatMoneyForPdf` to stay glyph-safe (§3.2). Each kind's totals *semantics* (recurring, deposit, balance) stay in its builder, and the module owns only geometry and drawing.

- **`documentColumnsFor(doc, { showTax })`** replaces `invoiceColumnsFor` and `columnsFor` with one geometry:
  - the description column first (fixes D3);
  - description width 0.42 taxed and 0.57 untaxed;
  - the quote PDF's money boxes: 0.155 or 0.16 per money cell, 0.19 for the total, 0.24 for the summary;
  - sized for prefix-code currencies at Helvetica 10 and bold 14, as `quotePdf.ts:380-385` documents.
- **Rows and pagination**, through `measureDocumentLineRow` and `drawDocumentLineRow`:
  - The cell content is the title (bold), date, blurb, note, descriptor, thumbnail and recurrence suffix. Each fragment is measured in the font and size it is drawn with.
  - Group and day headers are placed with the row they introduce. The column header repeats after every page break.
  - A row that will not fit breaks to a new page before any cell is drawn (from `invoicePdf.ts:529-533`).
  - Money cells use `lineBreak: false` + `fitFontSize` (`pdfFitText.ts:18`).
- **`drawDocumentTotals`** draws the totals box: its geometry and its emphasis row.
- **Fonts.** Both services pass their theme's `PdfThemeFonts`, which fixes D4 for invoices.
- **What stays.** Header layout, the cover page and the quote-only block renderers (`richTextPdf.ts`, `calloutPdf.ts`, `tablePdf.ts`) stay where they are (OD-6, OD-7). The header *strings* switch to the shared labels (§3.7).
- `renderInvoiceHtml` is deleted. The stale "used by email + portal" line at the top of `invoicePdf.ts:5` is deleted with it.

Both PDF services get their rows from the §3.4 assembler and keep their own loaders (`loadInvoiceForRender`, `invoicePdf.ts:819`).

## 4. Tenancy and data model impact

None. There is no new table, column, migration, RLS policy, cascade entry or export-policy entry. The new routes are reads under the existing `/invoices` and `/quotes` scopes, permissions and ownership checks. OD-5 option (b) would add data to the `cover_page` jsonb; §2 says what that would need.

## 5. Out of scope

- #9350, the whole-portal "view as customer" (dashboard, documents, reports).
- Editor UX (`QuoteLineRows.tsx`, the invoice editor tab). The editor keeps its own clamped blurb (`QuoteLineRows.tsx:246`).
- Changing which data is customer-visible. OD-9 raises two existing disagreements and asks for a ruling. No wave changes either one until the ruling is given.
- Detail-tab internal columns beyond the shared description cell.
- Email bodies, which summarise the document and do not render it.
- Localising the portal chrome around the document.

## 6. Alternatives considered

- **B: the Preview iframes the portal page** (#6649's preferred fix). It is pixel-identical by construction for the public page, because the real route brings the same CSS, fonts and runtime. It is not chosen; see OD-1 and §10.
- **C: A now, plus a "live page" button later.** "Copy share link" already opens the customer page for an issued document, without a new token kind. C adds nothing to A.
- **React inside `packages/shared`.** This saves one package. But every API import of `@breeze/shared` would carry React types and a `.tsx` build, and `test-shared` would need jsdom. A separate package keeps the server-side shared package free of React (OD-2).

## 7. Open Decisions

**OD-1. Renderer strategy.**
- (A) A shared React package, one view model per kind, and one server assembler with customer-view routes.
- (B) The Preview iframes the portal route using a staff preview token.
- (C) A, plus a later "open live page" button.
- **Recommend A.** B would require:
  - a staff credential, accepted by the portal on the very pages that carry Accept/Decline and Pay;
  - framing permission for those pages, which today send `frame-ancestors 'none'` (`apps/portal/src/lib/csp.ts:43`) and `X-Frame-Options: DENY` (`apps/portal/src/middleware.ts:42`). An exact-origin exception exists for the Trust Center embed (`csp.ts:112`), so this is possible but adds framing to the riskiest pages;
  - a replacement for the public routes' draft rejection and view stamping (`quotesPublic.ts:87,111-127`).

  B would also unify only the Preview with the public page, per document kind. It would leave the logged-in portal pages, quote-versus-invoice drift, the Detail tab and the PDF unsolved. C is A plus a button that already exists.

**OD-2. Package location.**
- (a) React in a new `packages/document-ui`. The model, builders and labels in `packages/shared/src/documents/`. The assembler in `apps/api`.
- (b) Everything, React included, in `packages/shared`.
- (c) Everything in `packages/document-ui`, including the model.
- **Recommend (a).** The PDF services need the model and labels without React. `office-addin-core` is the precedent for a React peer-dependency package with its own CI job.

**OD-3. Strings and locale.**
- (a) A typed `DocumentLabels`, one map per locale in `packages/shared/src/documents/labels/`, read by web, portal and the PDF. The **document** locale picks labels, money, dates and plurals. English ships in W1; pt-BR moves over from the API `pdf` namespace in W3.
- (b) Web passes i18next output in the viewer's language and the portal passes English. This was the orchestrator's starting position.
- (c) Package-owned JSON for each web locale, registered as a web i18next namespace.
- **Recommend (a).** (b) keeps D16 and D18: the Preview would show the staff user's language, not the customer's. (c) translates the document into 7 languages that the PDF and the portal do not speak.

**OD-4. Detail tab.**
- (a) Keep `LineItemsTable` and render `DocumentLineDescription` in its description cell.
- (b) Turn Detail into `DocumentLineTable` with an `internalColumns` slot.
- (c) Leave Detail alone.
- **Recommend (a), amended by the quorum.** Detail is a staff workbench: cost, margin, the hidden-line marker, the stateful `InvoiceLineDevices` that must render once, and a stacked-card phone layout (`apps/web/src/components/billing/shared/LineItemsTable.tsx:36-57`). The drift that hurt (D1) is in the description cell, and (a) shares exactly that cell. Detail shares the description *props*: a shared `lineDescriptionProps(line, labels)` presenter runs on each staff row. It does not use customer model rows. Hidden staff rows have no customer counterpart, and `CustomerInvoiceLine` had no ids until §3.4 added them (`invoiceService.ts:976-1000`). Staff rows and customer rows are never zipped by position. (b) would put staff-only columns into the customer component's API.

**OD-5. Cover crop parity.**
- (a) One geometry. The on-screen cover renders at the PDF page's aspect ratio (A4 1:1.414, Letter 1:1.294, from `pageSize`), with a centre crop and the title band from 62% of the height down, exactly as `renderCoverPage` draws it. The editor's cover upload shows that one crop.
- (b) A focal-point setting in the `cover_page` jsonb (`apps/api/src/db/schema/quotes.ts:75`), applied as `object-position` classes on screen and as an offset in pdfkit.
- (c) Separate portal and PDF cover images.
- **Recommend (a).** With one crop, the editor preview is the truth on every surface. (b) can be added later if partners ask. It would need a 9-position class set, because portal CSP forbids `object-position` in a style attribute. (c) doubles the authoring work to solve the same problem.

**OD-6. PDF module scope.**
- (a) Share the line table, pagination and totals-box geometry. Headers stay per service.
- (b) Share the line table only.
- (c) Share the line table, totals and header.
- **Recommend (a), widened by the quorum to include pagination.** The totals box shares the money-box sizing rule with the table, and both end at the right edge (`invoicePdf.ts:362-370`). The headers differ for real reasons: the quote has a cover page and a table of contents.

**OD-7. Quote-only PDF blocks.**
- (a) `richTextPdf.ts`, `calloutPdf.ts` and `tablePdf.ts` stay quote-only.
- (b) Generalise them for invoices.
- **Recommend (a).** Invoices have no content blocks, so there is nothing to share yet.

**OD-8. Where the customer projection runs for the Preview.**
- (a) On the server: one assembler, called by the `GET /invoices/:id/customer-view` and `GET /quotes/:id/customer-view` routes (§3.4).
- (b) In the browser: the web builds the customer DTO from the staff payload with a shared function.
- **Recommend (a).** The server already owns the #8604 withholding rules (`invoiceService.ts:1050-1080`). (b) would move them into the browser and keep two callers that can disagree about drafts.

**OD-9. Two existing customer-visibility disagreements (needs Todd).**
- **Ticket subject in the ticket group header.** The Preview and the PDF show it; the portal does not (D9). Options: (a) add `ticketSubject` to the customer projection, since the customer already receives it in the PDF; (b) drop it from the Preview and the PDF.
- **Bundle child lines.** The Preview indents them, but the projection does not carry `parentLineId` (D10). Options: (a) add an `isChild` flag to the projection; (b) render them flat everywhere.
- **Recommend (a) for both.** Neither exposes data the customer does not already get in the emailed PDF. This is a data-visibility ruling, and §5 keeps those out of scope. Until Todd rules, W1 ships the current portal behaviour (no subject, flat lines) on the screen surfaces. The PDF keeps its subject until W3, then follows the ruling.

**OD-10. Parity test form.**
- (a) Vitest DOM parity (shared fixtures through the web Preview wrapper and the portal views, compared against committed normalized `[data-document-root]` snapshots), plus a Playwright screenshot matrix.
- (b) Screenshot diff only.
- (c) DOM parity only.
- **Recommend (a).** DOM parity is fast, runs in the existing `test-web` and `test-portal` jobs, and catches content drift. The screenshot matrix catches what DOM parity cannot see: drift between the two Tailwind builds, density overrides, and the production CSP. W1 ships a minimal slice of the matrix; each later wave adds its own variants.

**OD-11. Recurrence suffix placement (quotes).**
The screen draws "/mo" after both the unit price and the amount, as a smaller muted span (`quoteBlocks.tsx:173,182`). The PDF draws it after the total only (`quotePdf.ts:707`).
- (a) Unit price and amount, on every surface.
- (b) Amount only, on every surface.
- **Recommend (a).** It is the customer-facing screen behaviour today. A monthly unit price without its cadence reads as one-time. In the PDF the unit cell shrinks to fit through `fitFontSize`, and the CHF box test is extended to include the suffix.

## 8. Test and rollout notes

### 8.1 Unit and parity (vitest)

- **`packages/document-ui`.** Component tests (jsdom) and `noStyleAttribute.test.tsx`. For both kinds, a blurb test asserts `whitespace-pre-line` and the literal `\n` in the rendered text.
- **`packages/shared/src/documents`.** Builder tests for each fixture: draft, issued, taxed, untaxed, deposit, recurring, day grouping, withheld note, prefix-code currency, a WinAnsi-unsafe currency (`₹`), and empty. W3 adds `pt-BR`. A builder assertion test covers non-empty titles and `cells.length === columns.length`.
- **Cross-app DOM parity.** One fixture set lives in `packages/document-ui/src/__fixtures__/`.
  - A web test renders the Preview wrapper with each fixture DTO.
  - A portal test renders `PublicInvoiceView`/`InvoiceDetailView` and `PublicQuoteView`/`QuoteDetailView` with the same DTOs through an `initial` test seam. Only the public views have that seam today (e.g. `PublicInvoiceView`'s `initial?: PublicInvoiceDetail`); W1 adds it to `InvoiceDetailView` and W2 to `QuoteDetailView`. Each normalizes `[data-document-root]` (slots emptied, React ids stripped) and compares it to **one committed snapshot per fixture in the package**, so the web and portal tests compare against the same file.
- **`apps/web`.** `localeParity` after the key deletions, the token-presence test, the density-isolation test covering both modes and the root element, and the built-CSS test (§3.5).
- **`apps/portal`.** The token-presence test, the built-CSS test, and `useDocumentAccent` sanitization: the hook drops a hostile colour.
- **`apps/api`.**
  - `documentPdfTable.test.ts` checks geometry on A4 and Letter, CHF prefix fit at 10 and bold 14 (the measurement style of the existing CHF tests in `invoicePdf.test.ts`/`quotePdf.test.ts`), and pagination with a row taller than the remaining page.
  - The `customerDocument.ts` assembler is tested once per mode. The tests check `public` mapping and refusals, `portal` raw status with superseded served, and `staff` with drafts. A hidden line never appears in any mode.
  - The customer-view routes are tested for:
    - a draft is allowed;
    - `markViewed` is never called;
    - no token is minted;
    - a caller without access to the org or site gets 404;
    - for an issued document, the response deep-equals the portal route's response, excluding the mode-dependent `status`. `displayStatus` must be equal.
  - The logged-in portal quote route test asserts that its response has the assembler's field shape (D19) and still serves a superseded quote.

### 8.2 Screenshot matrix (Playwright)

One spec under `e2e-tests/tests/` loads the web Preview and the portal pages for a seeded invoice and a seeded quote, and diffs the document element (`data-testid="document-root"`) across:
- both kinds;
- Preview vs public vs logged-in;
- desktop and 390 px;
- classic and condensed;
- web density compact and dense;
- one non-English document locale (from W3).

It runs against the **production portal CSP** (the stack sets the prod CSP rather than dev's deleted header; see `docAccent.ts`), so D15 and D17 regressions show up. Where a variant needs a separate run, the PR states which variants ran.

The matrix grows by wave:
- **W1** ships the slice its own changes need: the public invoice under the production CSP (accent present, no CSP violations), plus one invoice screenshot pair, Preview against public.
- **W2** adds quotes.
- **W3** adds the locale.
- **W4** adds the cover and the remaining variants.

### 8.3 PDF goldens

W3 changes PDF coordinates for invoices (wider description, theme fonts) and for quotes (column order). W3 regenerates every golden fixture that pins x-coordinates, and its PR lists which fixtures changed and why. Multi-page fixtures for both kinds are added. The pure `%PDF-` buffer tests stay.

### 8.4 CI jobs (per `docs/agents/testing.md`)

- A new `test-document-ui` job goes beside `test-office-addin-core` (`.github/workflows/ci.yml:1140`) and runs both test and typecheck. It is gated like `test-shared`, on code and app changes. `packages/**` already sets every area in the `changes` classifier, so the classifier needs no change. The job is registered in `.github/scripts/ci-area-gating.test.mjs`. Without this job, the package's tests do not run in CI.
- `ci-success` has no generic check over its `needs`. Wiring it takes three edits, as for `test-office-addin-core`:
  - add the job to `needs` (`:4543`);
  - add an env var mirroring `TEST_OFFICE_ADDIN_CORE_RESULT` (`:4577`);
  - add the matching success/skipped conditions (`:4660-4663` and `:4734-4735`).

  Without all three, a red `test-document-ui` still passes CI.
- `test-shared` runs the builders. `test-web` and `test-portal` run the parity tests. `test-api` runs the PDF module, the assembler and the route tests.
- There is no migration, so **Test API is enough**: no integration or RLS contract suite is touched.
- **Dockerfiles.**
  - **What changes.** Each Dockerfile copies the manifests of the packages in its own dependency graph (web: shared and extension-web-sdk at `apps/web/Dockerfile:28-29`; portal: shared at `apps/portal/Dockerfile:25`). Each gains `COPY packages/document-ui/package.json ./packages/document-ui/`. So do `docker/Dockerfile.web` (the CI smoke image, which also copies each package's `node_modules`, `:15-18`), `docker/Dockerfile.web.dev` and `docker/Dockerfile.portal.dev`.
  - **What does not.** The builder stages already copy all of `packages/` as source (`apps/web/Dockerfile:57`, `apps/portal/Dockerfile:53`), so they need no change.
  - **What catches a miss.** `apps/web/Dockerfile:17-24` warns that a plain workspace build cannot catch a missing manifest. `build-web` and `build-portal` run `pnpm build` (`ci.yml:1656,1703`), so they do not catch it. `build-smoke-images` (`:3545`) does: it builds `apps/portal/Dockerfile` and `docker/Dockerfile.web`. `apps/web/Dockerfile` itself is built only in the release and security workflows, so W1 runs `release-build-check.yml` by hand once.

### 8.5 Rollout

There is no flag. Each wave swaps a surface whole, behind its parity test. A wave that cannot make its parity test pass does not ship that surface.

## 9. Wave sketch

Each wave can ship on its own. #9401 lands first; W1 supersedes it by deleting its class fixes along with the files they live in.

- **W1: package and invoice on screen.**
  - Scaffold `packages/document-ui`, with the `./document.css` export. Add its CI job, fully wired into `ci-success`, and the Dockerfile manifest lines.
  - Add `document.css`. Wire both `globals.css` files (the import above `tailwindcss`, the four-level `@source`), add the density isolation, and add web's `--paper-primary`. Move `paperTokens.test.ts`.
  - Add the invoice model, builder and English labels in `packages/shared/src/documents`.
  - Add `customerDocument.ts` with `loadCustomerInvoiceLines` and `assembleCustomerInvoiceDocument`, plus line `id` in the projection. Export `resolveDocumentLineDetail`. Route the public, portal and new staff `GET /invoices/:id/customer-view` through the assembler.
  - Add the portal `useDocumentAccent` (fixes D17).
  - Swap the web invoice Preview, portal `PublicInvoiceView` and `InvoiceDetailView` (fixes the theme, D14). Add the `initial` seam to `InvoiceDetailView`. The Preview refetches on `reload()`.
  - Delete `invoicePaper.tsx` and the `InvoiceDocument.tsx` body. Delete the body-only `invoiceDocument.*` keys from all 7 `billing.json` locales.
  - Add the invoice DOM parity tests, the built-CSS tests, and the W1 Playwright slice (§8.2).
  - Files:
    - new: the `packages/document-ui` package, `packages/shared/src/documents/*`, `apps/api/src/services/customerDocument.ts`;
    - API: `services/invoiceService.ts`, `routes/invoices/invoices.ts`, `routes/invoicesPublic.ts`, `routes/portal/invoices.ts`;
    - web: `InvoiceDocument.tsx`, `InvoiceWorkspace.tsx`, `apps/web/src/locales/*/billing.json`;
    - portal: `PublicInvoiceView.tsx`, `InvoiceDetailView.tsx`, `apps/portal/src/styles/paperTokens.test.ts`;
    - shared: both `globals.css` files;
    - CI and build: `ci.yml`, `.github/scripts/ci-area-gating.test.mjs`, the five Dockerfiles in §8.4;
    - e2e: one spec under `e2e-tests/tests/`.
- **W2: quotes on screen.**
  - Add the quote model and builder, `QuoteBlocks`, `DocumentAgreements` and the cover (current portal geometry for now).
  - Add `assembleCustomerQuoteDocument`. The logged-in portal quote route stops spreading the raw row (D19). Add `GET /quotes/:id/customer-view`.
  - Swap the web quote Preview, `PublicQuoteView` and `QuoteDetailView`.
  - Delete `quoteBlocks.tsx`, `documentShell.tsx`, `quoteAgreements.tsx` and the `QuoteDocument.tsx` body.
  - Closes #6649.
- **W3: PDF module.**
  - Add `documentPdfTable.ts`. `invoicePdf.ts` and `quotePdf.ts` draw line tables, totals and pagination through it from the shared models.
  - Invoice PDFs get theme fonts. PDF dates and header and column labels switch to the shared labels in the document locale. The pt-BR strings move from `apps/api/src/i18n/locales/pt-BR/pdf.json` into `packages/shared/src/documents/labels/pt-BR.ts`.
  - Apply the OD-11 suffix rule to the PDF unit column.
  - Delete `renderInvoiceHtml`, its golden snapshot and the stale header line `invoicePdf.ts:5`. Regenerate the goldens.
  - Mostly API-only and file-disjoint from W2. Both need W1's model. W3's quote half needs W2's quote builder, so W3 runs the invoice half in parallel with W2 and the quote half after it.
- **W4: cover geometry and screenshot matrix.**
  - Apply the OD-5 geometry in `DocumentCover` and `document.css`.
  - The editor's cover upload shows the crop.
  - Add the Playwright matrix under the production CSP.
- **W5: Detail reuse.**
  - The `InvoiceDetail.tsx` and `QuoteDetail.tsx` description cells render `DocumentLineDescription` through `lineDescriptionProps`.
  - Delete web `lineTitle`/`lineBlurb` helpers that have no other caller.

## 10. Advisor quorum

**Claude position (author, before the quorum).** Strategy A, with refinements 2–10 as sent to Codex: React-free model and builders in `packages/shared`; the model built from a server customer projection through staff customer-view routes; labels by document locale; no style attributes and host-delivered accent; mutations as host slots; Detail keeps `LineItemsTable` with a shared description cell; a PDF module covering line table and totals geometry, with `renderInvoiceHtml` deleted and quote-only blocks staying; cover at the PDF aspect; no schema change.

**Codex `gpt-6-astra`, `model_reasoning_effort="xhigh"`, read-only sandbox, 2026-10-20. Verdict, verbatim (local file links shortened to `path:line`):**

> **AGREE: choose A, with amendments.** B best matches #6649's preferred mechanism: the actual portal route supplies the same CSS, fonts, and runtime at a matched viewport. Its security risk is manageable—a separate read-only capability and exact-origin framing can be safe; the portal already has origin-restricted framing support (`apps/portal/src/lib/csp.ts:112`). Reject B principally because it leaves quote/invoice, logged-in, Detail, and PDF duplication unresolved. It also requires replacing existing draft rejection/view-stamping behavior in `quotesPublic.ts:111–127`. C adds little beyond the existing share link.
>
> One correction: quote Preview **already applies the document theme**, at `QuoteDocument.tsx:574`. The missing cover and composition differences remain real.
>
> 2. **Agree.** Keep React-free types/builders in shared. Make document-ui own the complete document composition, including quote blocks and agreements; extracting primitives while retaining separate compositions preserves drift.
>
> 3. **Amend, strongly support.** Customer-view endpoints are preferable to client-side filtering, but extract a neutral customer-document assembler. Today's public quote serializer (`publicQuoteDto.ts:53`) rejects drafts/superseded quotes and maps sent→viewed; invoice customerLineDetail (`invoiceService.ts:1043`) assumes issued documents and ignores partner defaults. Preserve public eligibility rules separately; resolve draft defaults before projection.
>
> 4. **Amend.** Explicit document locale must govern money, dates, pluralization, and labels, without changing staff UI language. Portal currently chooses browser language versus English during SSR in `money.ts:11`; expose resolved locale in the DTO to prevent hydration differences.
>
> 5. **Amend.** No inline styles is correct, but nonce delivery needs a client-fetch path. Public invoice (`pages/invoice/[token].astro:2`) deliberately avoids SSR fetching and passes no accent; its layout (`PublicDocumentLayout.astro:38`) emits accent CSS only when initially available. Provide a host-managed nonced stylesheet update after fetching.
>
> 6. **Agree.** Keep mutation controls in host slots. Keep safe document interactions—agreement disclosure, lazy PDF viewing, print expansion—in the shared composition. Public unavailable/void/superseded screens remain host policy.
>
> 7. **Amend.** Preserve both staff workbenches, including editors, and explicitly narrow "every surface" to shared document presentation. Share description props, not necessarily customer model rows: CustomerInvoiceLine (`invoiceService.ts:976`) lacks IDs, and hidden staff rows have no customer counterpart. Never join these arrays positionally.
>
> 8. **Amend.** Share geometry **and pagination**: exact measure/draw fonts, repeated headers, group-heading placement, recurrence suffix widths, and totals layout. The 28% versus 42% discrepancy is specifically the taxed layout (invoice `invoicePdf.ts:383`, quote `quotePdf.ts:397`). Keep kind-specific totals semantics above geometry. Delete test-only `renderInvoiceHtml` after moving meaningful assertions to models/actual PDF output; leave quote-only block renderers intact.
>
> 9. **Agree.** Match resolved Letter/A4 proportions and the actual PDF title band, which starts at 62% page height (`quotePdf.ts:999`), across screen and editor.
>
> 10. **Agree.** Existing document-locale and presentation fields suffice; no schema addition is required.
>
> A will fail without these additional conditions:
>
> - **CSS isolation:** shared Tailwind scanning is insufficient. Web density rules (`apps/web/src/styles/globals.css:34539`) override document utility spacing with `!important`. Own document fonts/tokens and isolate layout from host density/dark-mode rules.
> - **One server assembler across all hosts:** logged-in quotes currently spread the raw quote (`routes/portal/quotes.ts:99`); logged-in invoices omit the document theme (`InvoiceDetailView.tsx:263`). Sharing JSX alone fixes neither.
> - **Assets and hydration:** staff images require authenticated fetch/object URLs (`QuoteDocument.tsx:30`); portal paths differ. Inject host asset resolvers. Compare deterministic fixture URLs, then test real asset loading inside existing Astro islands.
> - **Production wiring:** add manifests to both Docker dependency stages, package `@source`, and required package tests/typechecks through `ci-success`. The web Dockerfile explicitly warns (`apps/web/Dockerfile:17`) ordinary workspace builds miss manifest omissions. Keep i18next/editor dependencies outside the package.
> - **Verification:** one fixture/screenshot is insufficient. Exercise both kinds, public/logged-in/Preview, mobile/desktop, themes/density, locale, strict production CSP, and multipage PDFs. Refresh customer-view data after editor saves.
>
> The endpoint approach is sound **with existing staff authorization retained**—including org/site checks—and no view-stamping. Server projection already withholds sensitive line details (`invoiceService.ts:1051`); duplicating that policy in a staff-payload builder creates another drift point.
>
> **Overall verdict: approve A with a canonical server projection, complete shared document composition, isolated CSS, and production parity tests.**

**Resolution.** The quorum **agrees** on the strategy (A) and on every refinement. Its amendments were all adopted, and the claims were spot-checked against the code before being adopted:
- the server assembler, with eligibility kept in the routes (§3.4);
- the document locale governing money, dates and plurals (§3.7, D18);
- the client-fetch accent path (§3.5, D17);
- Detail sharing description props and never zipping rows (OD-4);
- PDF pagination in the shared module (§3.8, OD-6);
- CSS isolation from density rules (§3.5);
- host image components (§3.6);
- the widened test matrix (§8.2);
- Preview refetch after editor saves (§3.3).

Its correction on D14 (quote Preview stamps the theme) was confirmed, and D14 now says so. There was no disagreement to escalate.

**PR review round (one round).** `/pr-review-toolkit:review-pr` ran three reviewers on the spec: code, documentation accuracy and type design. Their findings were folded in:
- the `@source` path, which was one level short;
- the CSS import order (above `tailwindcss`) and the `./document.css` export;
- `--paper-primary` on web;
- the density exclusion of the root itself, and dense mode;
- full `ci-success` wiring;
- the W1 Playwright slice;
- line ids in the projection;
- assembler-owned row queries, with `projectCustomerInvoiceLine` folded in;
- per-mode status with `displayStatus`;
- one label source in `packages/shared`, with PDF dates and labels moving in W3;
- the Dockerfile and CI-job claims;
- `DocumentMoney`, so the PDF can stay glyph-safe;
- the tax-column union type;
- the missing `heading`, cadence-group, callout-title, `AgreementBody` and `QuoteTableBlock` types;
- `SanitizedHtml`;
- package-owned test ids;
- OD-11 (suffix placement).

One place where this spec goes further than Codex: for the client-fetch accent, the spec prefers a CSSOM write over a nonced `<style>` update. A CSSOM write needs no nonce plumbing into a client island, and the nonced `<style>` stays as the fallback. The production-CSP Playwright run (§8.2) settles it.
