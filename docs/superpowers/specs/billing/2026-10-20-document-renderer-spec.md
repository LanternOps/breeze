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
| D14 | Paper theme | The portal pins a white paper token block on `[data-doc-theme]` (`apps/portal/src/styles/globals.css:556-593`), so neither dark mode nor the chrome accent reaches the document. Web has no such block, so its Preview paints with the web app's own tokens. It does so even where it stamps the theme: `QuoteDocument.tsx:574` stamps `data-doc-theme` and `InvoiceDocument.tsx` does not. The logged-in portal invoice omits the theme too (`InvoiceDetailView.tsx:263`, `<DocumentPaper>` with no `docTheme`), while the public invoice passes it. |
| D15 | Accent delivery | Web sets the accent with inline `style` attributes: `InvoiceDocument.tsx:125,145,286,291` and `QuoteDocument.tsx:457,572,589,710,718,730,735`. `QuoteDocument.tsx:297,310` also put `textAlign` in a `style` attribute. The portal uses one nonced `<style>` element plus `.doc-accent-*` classes (`apps/portal/src/lib/docAccent.ts`, `globals.css:539-547`), because its CSP sends `style-src-attr 'none'` (`apps/portal/src/lib/csp.ts:47`). A web component moved into the portal unchanged would render an unstyled grey rule, and only in production. |
| D16 | Label language | Web Preview labels follow the **staff user's UI language** (`useTranslation('billing')`, `InvoiceDocument.tsx:73`; dates via `i18n.language`, `:40`). Portal labels are hard-coded English. PDF labels follow the **document's** locale (`resolveRenderLocale`, `invoicePdf.ts:101`). So a pt-BR technician previews in Portuguese an invoice that the customer receives in English. |
| D17 | Accent on the public invoice | The public invoice page deliberately fetches client-side, for rate-limit reasons (`apps/portal/src/pages/invoice/[token].astro:2-7`). `PublicDocumentLayout.astro:38` emits the nonced accent `<style>` only when the accent is known at SSR, and the invoice page passes none. The customer's public invoice therefore uses the app primary colour instead of the partner's brand colour. |
| D18 | Money and date locale | The portal formats money in the **browser's** language, and in English during SSR (`portalLocale()`, `apps/portal/src/lib/money.ts:11-14`). The PDF uses the document locale. The web Preview uses the staff UI language. |
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
  src/hostComponents.ts   # DocumentHostComponents: Image, and nothing else for now
  src/document.css        # paper tokens, fonts, .doc-accent-*, condensed theme, cover geometry, isolation
  src/tokens.ts           # the host tokens the package relies on (§3.5)
  src/__tests__/noStyleAttribute.test.tsx
  src/__fixtures__/       # shared parity fixtures + committed normalized-markup snapshots
```

### 3.2 The view-model contract

The model is built **only** from the customer DTO (§3.4). It holds display-ready values: strings already formatted in the document's locale and currency, plus booleans for what to show. Components hold no business rules: no visibility filtering, no tax maths, no fallback chains. That is what lets two apps render the same thing.

```ts
// packages/shared/src/documents/model.ts
export interface DocumentAssetRef { kind: 'logo' | 'cover' | 'block_image' | 'line_thumb'; id: string }

export interface DocumentBranding {
  logo: DocumentAssetRef | null;   // or a data:/https logo URL, carried as-is
  wordmark: string | null;         // partner name, else seller name
  theme: DocumentThemeId;          // 'classic' | 'condensed'
  pageSize: DocumentPageSize;      // 'a4' | 'letter' (sets the cover aspect, OD-5)
  seller: { name: string | null; lines: string[]; phone: string | null; email: string | null; website: string | null } | null;
}

export interface DocumentHeaderModel {
  eyebrow: string;                 // "Invoice" / "Proposal"
  number: string;                  // "INV-0042", or the draft fallback label
  subtitle: string | null;         // a proposal's title
  status: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } | null;
  dates: { label: string; value: string }[];
  billTo: { label: string; name: string; addressLines: string[]; taxId: string | null } | null;
}

export interface DocumentLineRow {
  key: string;                     // stable server line id (never an array index)
  title: string;                   // never empty: '—' or the localised labor label
  blurb: string | null;            // rendered with whitespace-pre-line (fixes D1 by construction)
  workDate: string | null;         // formatted
  qtyText: string; unitText: string; taxText: string | null; amountText: string;
  recurrenceTag: string | null;    // quotes: "Monthly" / "Annual"
  note: string | null;             // worked-vs-billed disclosure
  descriptor: string[];            // quote device-set lines
  ticketText: string | null;       // the logged-in portal's per-line ticket (invoicePaper's showLineTicket)
  thumbnail: DocumentAssetRef | null;
  isChild: boolean;                // bundle component (D10, OD-9)
}

export interface DocumentLineGroup {
  key: string;
  header: { title: string; category: string | null } | null;   // ticket group (D9, OD-9)
  days: { key: string; header: { date: string; hours: string; total: string } | null; rows: DocumentLineRow[] }[];
}

export interface DocumentLineTableModel {
  label: string | null;            // quote pricing-table label
  showTax: boolean;
  columns: { description: string; qty: string; unitPrice: string; tax: string; amount: string };
  groups: DocumentLineGroup[];
  subtotal: { label: string; value: string } | null;   // quote per-table subtotal
  emptyText: string | null;
}

export interface DocumentTotalsRow { key: string; label: string; value: string; emphasis?: 'rule' | 'hero' | 'muted' }
export interface DocumentTotalsModel { rows: DocumentTotalsRow[]; footnote: string | null; depositStrip: string | null }

export interface InvoiceDocumentModel {
  kind: 'invoice';
  locale: string;                  // resolved document locale (§3.7)
  branding: DocumentBranding;
  header: DocumentHeaderModel;
  notes: string | null;
  lines: DocumentLineTableModel;
  totals: DocumentTotalsModel;
  terms: { short: string | null; full: { label: string; text: string; meta: string } | null };
  footer: string | null;
}

export type QuoteBlockModel =
  | { kind: 'rich_text'; key: string; html: string }            // server-sanitized (quoteBlocks.tsx:251-254)
  | { kind: 'table'; key: string; model: QuoteTableBlock }       // alignment as classes, never style
  | { kind: 'callout'; key: string; tone: string; html: string }
  | { kind: 'image'; key: string; image: DocumentAssetRef | null; caption: string | null; width: string | null }
  | { kind: 'line_items'; key: string; table: DocumentLineTableModel }
  | { kind: 'contract'; key: string; agreementId: string };    // rendered in DocumentAgreements

export interface QuoteDocumentModel {
  kind: 'quote';
  locale: string;
  branding: DocumentBranding;
  cover: { title: string; image: DocumentAssetRef | null; preparedFor: string | null; preparedBy: string | null; eyebrow: string } | null;
  header: DocumentHeaderModel;     // the number is an h2 when cover !== null
  introNotes: string | null;
  blocks: QuoteBlockModel[];       // includes the trailing default pricing table for un-blocked lines
  totals: DocumentTotalsModel;
  terms: { short: string | null };
  agreements: { id: string; title: string; meta: string; body: AgreementBody }[];
  footer: string | null;
}
```

Builders:

```ts
buildInvoiceDocumentModel(dto: CustomerInvoiceDocument, labels: DocumentLabels): InvoiceDocumentModel
buildQuoteDocumentModel(dto: CustomerQuoteDocument, labels: DocumentLabels): QuoteDocumentModel
```

The builders are pure and take no surface argument, so the same DTO always yields the same model. Hosts differ only in two things: the `DocumentHostComponents` they pass to the view (§3.6), and their slots (§3.3).

### 3.3 Surfaces mapped onto the model

| Surface | Invoice | Quote |
|---|---|---|
| Web Preview | `InvoiceDocumentPreview` fetches `GET /invoices/:id/customer-view`, builds the model and renders `<InvoiceDocumentView>`. It keeps the Download PDF button. | The same with `/quotes/:id/customer-view` and `<QuoteDocumentView>`, cover included. The signature slot renders an inert "Your customer signs here" placeholder. |
| Portal public | `PublicInvoiceView` keeps its fetch, payment rail, notices and void state. The paper becomes `<InvoiceDocumentView>`. | `PublicQuoteView` keeps its fetch, `SignaturePanel` and accept/decline. The paper becomes `<QuoteDocumentView slots={{ signature }}>`. |
| Portal logged in | `InvoiceDetailView`, the same as public. | `QuoteDetailView`, the same as public. Its own copy of the totals goes away. |
| Web Detail | `LineItemsTable` stays. Its description cell renders `<DocumentLineDescription>` (OD-4). | The same for `QuoteDetail`. |
| PDF | `invoicePdf.ts` draws its line table, totals box and pagination through `documentPdfTable.ts` (§3.8). | `quotePdf.ts` does the same. |

**What stays in the package and what goes to the host.** The package handles document interactions that are safe for any reader: agreement disclosure, deep links, lazy PDF bodies and print expansion. Anything that mutates is a host slot. `InvoiceDocumentView` and `QuoteDocumentView` take `slots?: { beforePaper?, afterTotals?, signature?, afterPaper? }`, which carry the payment rails, notices, the signature panel and the accept/decline feedback. Whole-page states are host policy rendered outside the document: void, superseded, link unavailable, and online payment unavailable. The parity test serializes `[data-document-root]` with the slot containers emptied.

**Preview freshness.** The Preview's customer-view query is invalidated whenever the editor saves, so the Preview never shows a stale DTO. This uses the same invalidation the workspace already does for its detail query.

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

**Assembler.** `customerDocument.ts` exports `assembleCustomerInvoiceDocument(invoice, rows, brand, opts)` and `assembleCustomerQuoteDocument(quote, blocks, rows, brand, opts)`. They wrap the existing serialization boundaries (`toCustomerInvoiceHeader`/`toCustomerInvoiceLine`, `toPublicQuoteHeader`) and add branding, presentation and the resolved `documentLocale`. The public routes, the logged-in portal routes (replacing the raw spread at `routes/portal/quotes.ts:99`) and the new staff routes all return its output. `opts` carries two explicit parameters:

1. **Line detail.** An issued document always uses the frozen columns (`customerLineDetail`, `invoiceService.ts:1046`). A draft first resolves the partner default with the same resolver the staff detail uses (`resolveDocumentLineDetail`, defined `invoiceService.ts:967`, called `:961`), because that is what it will freeze to at issue. Draft defaults are resolved *before* the projection, never inside it.
2. **Status mapping.** `toPublicQuoteHeader` maps `sent` to `viewed` and throws on `draft` (`publicQuoteDto.ts:53-60`). The assembler takes the status mapping as a parameter. Public and portal routes keep today's mapping and refusals. The staff route passes the raw status. The customer DTO's `status` union widens for that one caller.

Eligibility stays in the routes and does not move: portal draft refusal (`routes/portal/invoices.ts:134-135`), public link revocation and supersession (`isPublicLinkDead`, `quotesPublic.ts:87`), void and superseded screens.

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
  - the condensed theme rules (portal `:527-533`, web `globals.css:34654-34666`) and their font imports;
  - the cover geometry (OD-5) and `.signature-preview`.

  The document owns its fonts and tokens inside `[data-document-root]`, so neither the host's font stack nor its dark mode reaches the paper.
- **Wiring.** Each app's `globals.css` adds `@import '@breeze/document-ui/document.css';` after `@import 'tailwindcss'`. It also adds `@source '../../../packages/document-ui/src/**/*.{ts,tsx}';`, so its Tailwind build sees the package's class names. `apps/word-addin/src/index.css:10` uses this mechanism for `office-addin-core`.
- **Isolation from host overrides.** Web density modes rewrite utility spacing under `main` with `!important` (`apps/web/src/styles/globals.css:34539` onward, e.g. `[data-density='compact'] main .p-8`). A Preview inside `main` would be re-spaced. Those selectors gain `:not([data-document-root] *)`, and a web test fails if a `[data-density]` rule can match inside the document root. Any other host rule that targets bare utilities under `main` gets the same exclusion.
- **Token contract.** `packages/document-ui/src/tokens.ts` lists the host `@theme` tokens the package still relies on outside the paper block. A test in each app parses that app's `globals.css` and fails if any listed token is missing.
- **Accent.** `--doc-accent` stays the host's job, and the package never writes a `style` attribute. `noStyleAttribute.test.tsx` renders every component with every fixture and fails on any element that carries `style`. Today's `textAlign` style attributes (`QuoteDocument.tsx:297,310`) become alignment classes, as the portal already does (`quoteBlocks.tsx:199-207`). Hosts deliver the accent as follows:
  - **Portal SSR pages:** the nonced `<style>` from `PublicDocumentLayout.astro:38`, as today.
  - **Portal client-fetched pages** (the public invoice, D17): a portal-only `useDocumentAccent(color)` hook. It sets the value through CSSOM (`document.documentElement.style.setProperty('--doc-accent', sanitized)`) after `sanitizeAccentColor` (`docAccent.ts`). CSP's `style-src-attr` governs style attributes in markup, not CSSOM writes from an allowed script. The Playwright run under the production CSP (§8.2) is the proof that this holds, and if it fails there, the fallback is a nonced `<style>` element created from the page's nonce.
  - **Web:** sets the variable on a wrapper `<div>` outside the package, as it does now.

DOM parity does not catch two Tailwind builds emitting different CSS for the same class. The screenshot matrix (§8.2) is the guard for that.

### 3.6 Images and assets

Image delivery differs per host:
- The public portal uses plain URLs: `/quotes/public/:token/images/:id` (`PublicQuoteView.tsx:188,216-218`).
- The web needs an **authenticated fetch turned into an object URL**, because a bare `img src` would 401 (`QuoteDocument.tsx:30-31`, `DocLineThumb`/`DocImage`).

The model therefore carries `DocumentAssetRef`s, not URLs. The view takes `components: DocumentHostComponents` with one member, `Image({ asset, alt, className })`. In the portal, `Image` is a plain `<img>` with a host-built URL. In the web, it is the existing authenticated-fetch image. Parity fixtures use a deterministic `Image` that renders `<img data-asset="kind:id">`, so markup compares exactly. Real asset loading is tested inside each app's existing Astro island.

### 3.7 Strings and language

- `packages/shared/src/documents/labels.ts` exports `type DocumentLabels` and `DOCUMENT_LABELS_EN`, the single source of the English defaults. The type covers every string the document prints, with pluralised read-time and interpolated device-set text as small functions.
- **The document's locale governs everything printed**: labels, money, dates and plurals. The chain is `invoice.documentLocale ?? partner locale ?? 'en'`, the same one the PDF uses (`resolveRenderLocale`, `invoicePdf.ts:101`). The assembler resolves it and puts it in the DTO, and the builder formats with it. No component reads `navigator.language` or the viewer's i18next language, so SSR and hydration produce the same text (D18). The staff UI around the Preview stays in the staff user's language.
- **Locales.** English ships in W1. Other locales are taken from the API's `pdf` namespace where the string already exists (`apps/api/src/i18n/locales/{en,pt-BR}/pdf.json`), so the document reads the same on screen and in the PDF in pt-BR. A locale without document labels falls back to English on every surface, which is what the portal does today. (OD-3)
- Web's `invoiceDocument.*` and `quotes.document.*` keys in `billing.json` that only the document body uses are deleted from all 7 locales, keeping `localeParity` green. Preview chrome keys (the caption, Download PDF) stay.

### 3.8 PDF module

A new `apps/api/src/services/documentPdfTable.ts` is used by both `invoicePdf.ts` and `quotePdf.ts`. It takes the same `DocumentLineTableModel` and `DocumentTotalsModel` the screen renders, so PDF and screen print the same strings. Each kind's totals *semantics* (recurring, deposit, balance) stay in its builder; the module owns only geometry and drawing.

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
- **What stays.** Headers, the cover page and the quote-only block renderers (`richTextPdf.ts`, `calloutPdf.ts`, `tablePdf.ts`) stay where they are (OD-6, OD-7).

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
- (a) A typed `DocumentLabels` with the English map in `packages/shared`. The **document** locale picks labels, money, dates and plurals. Other locales are filled from the API `pdf` namespace.
- (b) Web passes i18next output in the viewer's language and the portal passes English. This was the orchestrator's starting position.
- (c) Package-owned JSON for each web locale, registered as a web i18next namespace.
- **Recommend (a).** (b) keeps D16 and D18: the Preview would show the staff user's language, not the customer's. (c) translates the document into 7 languages that the PDF and the portal do not speak.

**OD-4. Detail tab.**
- (a) Keep `LineItemsTable` and render `DocumentLineDescription` in its description cell.
- (b) Turn Detail into `DocumentLineTable` with an `internalColumns` slot.
- (c) Leave Detail alone.
- **Recommend (a), amended by the quorum.** Detail is a staff workbench: cost, margin, the hidden-line marker, the stateful `InvoiceLineDevices` that must render once, and a stacked-card phone layout (`apps/web/src/components/billing/shared/LineItemsTable.tsx:36-57`). The drift that hurt (D1) is in the description cell, and (a) shares exactly that cell. Detail shares the description *props*: a shared `lineDescriptionProps(line, labels)` presenter runs on each staff row. It does not use customer model rows, because `CustomerInvoiceLine` has no ids (`invoiceService.ts:976-1000`) and hidden staff rows have no customer counterpart. Staff rows and customer rows are never zipped by position. (b) would put staff-only columns into the customer component's API.

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
- **Recommend (a).** DOM parity is fast, runs in the existing `test-web` and `test-portal` jobs, and catches content drift. The screenshot matrix catches the risk of two Tailwind builds, density overrides and production CSP, which DOM parity cannot see.

## 8. Test and rollout notes

### 8.1 Unit and parity (vitest)

- **`packages/document-ui`.** Component tests (jsdom) and `noStyleAttribute.test.tsx`. For both kinds, a blurb test asserts `whitespace-pre-line` and the literal `\n` in the rendered text.
- **`packages/shared/src/documents`.** Builder tests for each fixture: draft, issued, taxed, untaxed, deposit, recurring, day grouping, withheld note, prefix-code currency, `pt-BR` locale and empty.
- **Cross-app DOM parity.** One fixture set lives in `packages/document-ui/src/__fixtures__/`. A web test renders the Preview wrapper with each fixture DTO. A portal test renders `PublicInvoiceView`/`InvoiceDetailView` and `PublicQuoteView`/`QuoteDetailView` with the same DTOs through their `initial` test seam (e.g. `PublicInvoiceView`'s `initial?: PublicInvoiceDetail`). Each normalizes `[data-document-root]` (slots emptied, React ids stripped) and compares it to **one committed snapshot per fixture in the package**, so the web and portal tests compare against the same file.
- **`apps/web`.** `localeParity` after the key deletions, the token-presence test, and the density-isolation test (§3.5).
- **`apps/portal`.** The token-presence test, and `useDocumentAccent` sanitization: the hook drops a hostile colour.
- **`apps/api`.**
  - `documentPdfTable.test.ts` checks geometry on A4 and Letter, CHF prefix fit at 10 and bold 14 (the measurement style of the existing CHF tests in `invoicePdf.test.ts`/`quotePdf.test.ts`), and pagination with a row taller than the remaining page.
  - The `customerDocument.ts` assembler is tested once per caller mode.
  - The customer-view routes are tested for: a draft is allowed; `markViewed` is never called; no token is minted; a caller without access to the org or site gets 404; and for an issued document, the response deep-equals what the portal route returns.
  - The logged-in portal quote route test asserts that its response now equals the public DTO shape (D19).

### 8.2 Screenshot matrix (Playwright)

One spec under `e2e-tests/tests/` loads the web Preview and the portal pages for a seeded invoice and a seeded quote, and diffs the document element (`data-testid="document-root"`) across:
- both kinds;
- Preview vs public vs logged-in;
- desktop and 390 px;
- classic and condensed;
- web density compact;
- one non-English document locale.

It runs against the **production portal CSP** (the stack sets the prod CSP rather than dev's deleted header; see `docAccent.ts`), so D15 and D17 regressions show up. Where a variant needs a separate run, the PR states which variants ran.

### 8.3 PDF goldens

W3 changes PDF coordinates for invoices (wider description, theme fonts) and for quotes (column order). W3 regenerates every golden fixture that pins x-coordinates, and its PR lists which fixtures changed and why. Multi-page fixtures for both kinds are added. The pure `%PDF-` buffer tests stay.

### 8.4 CI jobs (per `docs/agents/testing.md`)

- A new `test-document-ui` job goes beside `test-office-addin-core` (`.github/workflows/ci.yml:1140`). It runs both test and typecheck, is added to `ci-success`'s `needs` (`:4543`), and is added to the `changes` path classifier. Without it, the package's tests do not run in CI.
- `test-shared` runs the builders. `test-web` and `test-portal` run the parity tests. `test-api` runs the PDF module, the assembler and the route tests.
- There is no migration, so **Test API is enough**: no integration or RLS contract suite is touched.
- **Dockerfiles.** Both copy every package's `package.json` explicitly in the deps stage: `apps/web/Dockerfile:28-29` and `apps/portal/Dockerfile:25`. `apps/web/Dockerfile:17-18` warns that ordinary workspace builds do not catch a missing manifest. Each needs `COPY packages/document-ui/package.json ./packages/document-ui/` added there. The builder stages already copy all of `packages/` as source (`apps/web/Dockerfile:57`, `apps/portal/Dockerfile:53`), so they need no change. `build-web` and `build-portal` catch a miss.

### 8.5 Rollout

There is no flag. Each wave swaps a surface whole, behind its parity test. A wave that cannot make its parity test pass does not ship that surface.

## 9. Wave sketch

Each wave can ship on its own. #9401 lands first; W1 supersedes it by deleting its class fixes along with the files they live in.

- **W1: package and invoice on screen.**
  - Scaffold `packages/document-ui`, its CI job and the Dockerfile manifest lines; add `document.css` and both `globals.css` imports, with the density isolation.
  - Add the invoice model, builder and English labels in `packages/shared/src/documents`.
  - Add `assembleCustomerInvoiceDocument` and route the public, portal and new staff `GET /invoices/:id/customer-view` through it.
  - Add the portal `useDocumentAccent` (fixes D17).
  - Swap the web invoice Preview, portal `PublicInvoiceView` and `InvoiceDetailView` (theme fixed, D14).
  - Delete `invoicePaper.tsx` and the `InvoiceDocument.tsx` body.
  - Add the invoice DOM parity tests.
  - Files: the new package, `packages/shared/src/documents/*`, `apps/api/src/services/customerDocument.ts`, `routes/invoices/invoices.ts`, `routes/invoicesPublic.ts`, `routes/portal/invoices.ts`, `InvoiceDocument.tsx`, `PublicInvoiceView.tsx`, `InvoiceDetailView.tsx`, both `globals.css`, `ci.yml`, both Dockerfiles.
- **W2: quotes on screen.**
  - Add the quote model and builder, `QuoteBlocks`, `DocumentAgreements` and the cover (current portal geometry for now).
  - Add `assembleCustomerQuoteDocument`. The logged-in portal quote route stops spreading the raw row (D19). Add `GET /quotes/:id/customer-view`.
  - Swap the web quote Preview, `PublicQuoteView` and `QuoteDetailView`.
  - Delete `quoteBlocks.tsx`, `documentShell.tsx`, `quoteAgreements.tsx` and the `QuoteDocument.tsx` body.
  - Closes #6649.
- **W3: PDF module.**
  - Add `documentPdfTable.ts`. `invoicePdf.ts` and `quotePdf.ts` draw line tables, totals and pagination through it from the shared models.
  - Invoice PDFs get theme fonts.
  - Delete `renderInvoiceHtml` and its golden snapshot. Regenerate the goldens.
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

One place where this spec goes further than Codex: for the client-fetch accent, the spec prefers a CSSOM write over a nonced `<style>` update. A CSSOM write needs no nonce plumbing into a client island, and the nonced `<style>` stays as the fallback. The production-CSP Playwright run (§8.2) settles it.
