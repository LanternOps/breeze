---
spec: docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md
feature_plan: docs/superpowers/plans/billing/2026-10-20-document-renderer.md
tracking_issue: LanternOps/breeze#9414
anchor_issue: LanternOps/breeze#9402
---
# One Document Renderer — W3a Implementation Plan (shared PDF line table + invoice PDF)

> **Sub-issue:** W3a = #9420 (feature parent #9414). PR carries `Closes #9420`, `Part of #9414`; branch `feature/9414-document-renderer/wave-9420`.

> **For agentic workers:** execute task by task with superpowers:executing-plans. Red first on every task: write the failing assertion, watch it fail, then implement. Scoped runs: `cd <pkg> && npx vitest run <path>`.

**Goal:** `apps/api/src/services/documentPdfTable.ts` owns the PDF line table, pagination and totals box. The invoice PDF is drawn from `assembleCustomerInvoiceDocument(inv, mode, { surface: 'pdf' })` → `buildInvoiceDocumentModel` → the module, in the document's language and the partner's theme fonts. `renderInvoiceHtml` is deleted.

**Architecture:** shared labels gain a pt-BR map and a small PDF-only section; the customer header DTO gains `billToAddress`, `billToTaxId`, `terms`; the builder fills the model's bill-to and short-terms slots; `customerDocument.ts` exposes the pure line projection and resolves the unstamped-draft locale from the partner; `documentPdfTable.ts` extracts the #9401 geometry; `invoicePdf.ts` keeps its pure row-based entry (`renderInvoicePdfBuffer`, projecting rows through the same pure function the assembler uses) and `renderInvoicePdf` goes through the assembler.

**Spec:** §3.7, §3.8, §8.3, OD-6, OD-7, OD-11. Quote half, `quotePdf.ts`, `richTextPdf/calloutPdf/tablePdf`, React and `packages/document-ui` are untouched (W3b / OD-7).

## Global Constraints

- No migration, no schema change. Header DTO additions are values the customer already receives in the emailed PDF (`invoicePdf.ts` printed bill-to address, tax id and terms), so this is not a visibility change.
- W2a runs in parallel: append to `labels/types.ts`, `labels/en.ts` and `documents/index.ts` only in a clearly commented "W3a" section at the end.
- Invoice x-coordinates do not move beyond what #9401 set (description 0.42 taxed / 0.57 untaxed; money 0.155 / 0.16; qty 0.08 / 0.085; summary 0.24).
- Money in the PDF = `formatMoneyForPdf(DocumentMoney.amount, DocumentMoney.currency, locale)`; money cells `lineBreak: false` + `fitFontSize`.
- Typecheck with exit codes: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `apps/api` and `packages/shared`.

## Tasks

### Task 1 — pt-BR labels + PDF-only keys (shared)
- [ ] Red: `labels.test.ts` — `documentLabelsFor('pt-BR')` is not the English map; `.totals.balanceDue === 'Saldo devedor'`, `.columns.qty === 'Qtd'`, `.workedVsBilled('1,5','2') === '1,5 h trabalhadas · 2 h faturadas'`, `.laborLine === 'Mão de obra'`; every locale not in the registry still returns English; every key of `DOCUMENT_LABELS_EN` exists in pt-BR (structure parity, recursive).
- [ ] Add `pdf: { from, taxId(v), payOnline, category(c) }` to `DocumentLabels` + en (W3a section), `labels/pt-BR.ts`, registry in `documentLabelsFor`, export from `documents/index.ts`.

### Task 2 — header DTO: `billToAddress`, `billToTaxId`, `terms`
- [ ] Red: `invoiceBuilder.test.ts` — a DTO with address/tax id/terms yields `header.billTo.addressLines` (line1, line2, "city, region, postal", country, blanks dropped), `taxId`, `terms.short`; null address → `[]`. Red: `invoiceService.test.ts` header keyset pin lists the three new keys; W1b pins (`invoicesPublic.customerDocumentPin`, portal pin, `customerViewRoute`) updated additive-only.
- [ ] `dto.ts` (`billToAddress: DocumentBillToAddress | null`), `toCustomerInvoiceHeader`, builder, fixtures; shared `documentAddressLines` helper reused by `documentSellerLines`.

### Task 3 — assembler: pure projection + unstamped-draft locale
- [ ] Red (`customerDocument.test.ts`): an unstamped draft whose partner locale is pt-BR, with a time-entry line and the note withheld, projects the labor title `Mão de obra`; stamped locale still wins.
- [ ] Split `loadCustomerInvoiceLines` into the query and a pure `projectCustomerInvoiceLines(rows, { invoice, detail, surface, locale, projection? })`; `assembleCustomerInvoiceDocument` loads branding+partner first and passes the resolved document locale. `toCustomerInvoiceLine` takes its labor label from `documentLabelsFor(locale).laborLine`; `accountingInvoicePush.ts` the same (English). Break the `invoiceService → invoicePdf` import by moving the SQL helpers + `resolveDraftBillTo` to `invoiceRenderHelpers.ts` (re-exported from `invoicePdf.ts`).

### Task 4 — `documentPdfTable.ts`
- [ ] Red (`documentPdfTable.test.ts`): `documentColumnsFor` fractions (taxed/untaxed, description first, right edges meet); CHF `CHF 888'888.88` fits its money box at 10pt; a 3-line description measures taller than 1-line and the row draws title/qty/amount on one baseline; a row that does not fit moves whole to the next page; the column header repeats after the break (text `Description` appears on both pages); a ticket group header never sits alone at a page bottom; totals: muted/regular/strong/hero weights, `sign: 'minus'` prints `-`, a value list joins with ` + `, rules above; condensed fonts are used when passed.
- [ ] Implement `documentColumnsFor`, `measureDocumentLineRow`, `drawDocumentLineRow`, `drawDocumentColumnHeader`, `drawDocumentLineTable` (pagination), `drawDocumentTotals`.

### Task 5 — invoice PDF through the module
- [ ] Red (`invoicePdf.test.ts` PDF-output rewrite): header strings come from the document locale (pt-BR: `FATURA`-style eyebrow = `Fatura`, `Emitida:`, `Vencimento:`, `Cobrar de`, column headers); dates in the document locale; bill-to address + tax id + fallback email drawn; theme fonts selected (condensed registers `Doc-Body`); ticket-header + category; per-day headers; note OFF/worked OFF; billed-vs-worked; empty terms prints no footer; pay-online link; no `en-US`-only date.
- [ ] Rewrite `renderInvoicePdfBuffer` (pure, rows → DTO via `projectCustomerInvoiceLines` + `toCustomerInvoiceHeader`) over a new pure `drawInvoicePdf(dto, extras)`; `renderInvoicePdf` assembles via `assembleCustomerInvoiceDocument(…, { surface: 'pdf' })`. Delete `renderInvoiceHtml`, `lineTax`, `lineText/lineNote/lineDate`, the stale header comment, the HTML golden snapshot; `loadInvoiceForRender` stops loading lines.
- [ ] Move the meaningful assertions of `invoicePdf.test.ts`, `.lineDetail.test.ts`, `.golden.test.ts` to builder tests (title/blurb, ticket grouping, worked-vs-billed already in `invoiceBuilder.test.ts`) or PDF-output tests.

### Task 6 — goldens, multi-page fixture, i18n cleanup
- [ ] Regenerate `invoicePdf.golden.test.ts.snap` only after the red/green pair of Task 5; list each changed fixture and why in the PR. Add a multi-page invoice fixture (page count, header repeat, totals on the last page).
- [ ] Delete `invoice.*` from en + pt-BR `pdf.json` (callers: `invoicePdf.ts`, `invoiceService.ts`, `accountingInvoicePush.ts`, `i18n.test.ts` — all moved); quote keys stay for W3b. `i18n.test.ts` asserts on `pdf:quote.title`.

### Task 7 — verify, PR, review
- [ ] `cd apps/api && npx vitest run services/documentPdfTable services/invoicePdf services/customerDocument routes/invoicesPublic routes/portal/invoices routes/invoices i18n services/invoiceService`; `cd packages/shared && npx vitest run documents`; integration on a per-worktree stack; tsc in both packages; open PR; `/pr-review-toolkit:review-pr`; post the summary; stop.

## Review Focus

1. Unpaid invoice: the model always carries Total + Balance due rows, so the PDF now prints both (the old PDF printed one emphasised Total). Task 4/5.
2. Two number-less tickets no longer get separate "Ticket work" groups (the model groups by ticket number, portal semantics). Task 5.
3. Unstamped draft in a pt-BR partner prints the localised labor label. Task 3.
4. CHF / long-figure money still fits (fitFontSize). Task 4.
