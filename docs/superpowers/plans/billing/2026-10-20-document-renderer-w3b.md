---
spec: docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md
feature_plan: docs/superpowers/plans/billing/2026-10-20-document-renderer.md
tracking_issue: LanternOps/breeze#9414
anchor_issue: LanternOps/breeze#9402
---
# One Document Renderer — W3b Implementation Plan (quote PDF through the shared module)

> **Sub-issue:** W3b = #9421 (feature parent #9414). PR carries `Closes #9421`, `Part of #9414`; branch `feature/9414-document-renderer/wave-9421`.

> **For agentic workers:** execute task by task. Red first on every task: write the failing assertion, watch it fail, then implement. Scoped runs: `cd apps/api && npx vitest run <path>`.

**Goal:** `quotePdf.ts` draws its pricing tables, totals box and pagination through `documentPdfTable.ts`, from `buildQuoteDocumentModel`, in the document's language. Description comes first (D3). The recurrence suffix rides on the unit and the amount cell (OD-11). `deviceSetCustomerText`, `lineTax`, `columnsFor` (and `recurrenceSuffix`, `renderLineTable`, `measureLineRow`, `renderRecurringSummary`) are deleted.

**Architecture:** `renderQuotePdf` keeps its pure, row-based signature (routes, lifecycle and contract callers are untouched). Inside, a pure adapter projects the rows it is handed into the customer quote DTO (`CustomerQuoteDocument`) — the same shape `assembleCustomerQuoteDocument` emits — and `buildQuoteDocumentModel` + `documentLabelsFor(locale)` produce the model. The DB-bound assembler is **not** called from the renderer: every caller already loaded and authorized its rows, and the renderer stays DB-free. `documentPdfTable.ts` gains: money suffix, line thumbnails (a gutter), a table label + keep-together lead, the per-table subtotal, and the totals `aside` box.

**Spec:** §3.8, §8.3, OD-6, OD-7, OD-11. Cover page, contents list, `richTextPdf.ts`, `calloutPdf.ts`, `tablePdf.ts`, agreements stay (OD-6/OD-7).

## Global Constraints
- No migration. No route, React or `packages/document-ui` change. `invoicePdf.ts` untouched (shared-module changes are additive and invoice goldens are re-checked).
- Money in the PDF = `formatMoneyForPdf(amount, currency, locale)` + `suffix.text`; money cells `lineBreak:false` + `fitFontSize`.
- Customer-visible layout change: **description column first**, QTY after it; the recurrence suffix on unit AND amount; totals box follows the on-screen rows (Subtotal/Tax only when taxed; first-period box as an aside).
- Typecheck with exit code: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `apps/api`.

## Tasks
### Task 1 — module: suffix, thumbnails, label+lead, subtotal, aside
- [ ] Red (`documentPdfTable.test.ts`): a `/mo` unit and amount print the suffix in both cells; CHF `CHF 1'234.50/mo` fits its unit and amount boxes at Helvetica 10 (and the 888'888.88 extreme shrinks, never wraps); a row with a thumbnail draws an image and indents the description by the gutter; a table `label` is drawn and kept with the header + first row; `subtotal` parts print joined; totals `aside` rows + note draw in a tinted box.
- [ ] Implement in `documentPdfTable.ts` (additive options; invoice behaviour unchanged).

### Task 2 — quote DTO adapter + model
- [ ] Red (`quotePdf.test.ts`): rows with a hidden line, an unknown recurrence and a missing lineTotal project to the DTO the builder expects (hidden line dropped; lineTotal = qty × unit; unknown recurrence → one_time).
- [ ] Implement `quotePdfDocument(...)` in `quotePdf.ts` (pure).

### Task 3 — pricing tables through the module
- [ ] Red: description x < qty x < unit x < amount x on a quote; `/mo` appears on the unit AND amount fragments; a block's label prints once; cadence group header; per-table subtotal; tax column only when taxed; multi-page quote repeats the column header and never splits a row.
- [ ] Replace `renderLineTable` / `measureLineRow` / `lineTableLeadHeight` with module calls; delete `deviceSetCustomerText`, `lineTax`, `columnsFor`, `recurrenceSuffix`.

### Task 4 — totals box
- [ ] Red: the summary prints the on-screen rows (Total vs Due on acceptance, deposit trio, recurring rows, first-period aside + note).
- [ ] Replace `renderRecurringSummary` with `drawDocumentTotals`.

### Task 5 — header labels
- [ ] Red: pt-BR quote prints localized eyebrow, date labels, `De`, `Preparado para`; en strings unchanged.
- [ ] Header strings and dates from `documentLabelsFor(locale)` / the model header (`formatDate` stays exported for the contract renderer).

### Task 6 — goldens
- [ ] Regenerate `quotePdf-classic-baseline*` with `pnpm --filter @breeze/api exec tsx scripts/regen-classic-pdf-baseline.ts` only after Tasks 1–5 are green; list each changed fixture and why in the PR.

### Task 7 — verify, PR, review
- [ ] `cd apps/api && npx vitest run services/quotePdf services/documentPdfTable services/customerDocument services/invoicePdf`; integration suites that render quote PDFs on a wt-stack; tsc exit code; open PR; `/pr-review-toolkit:review-pr`; post summary; stop.

## Review Focus
1. CHF money boxes with the suffix (Task 1).
2. Description-first is customer-visible on every quote PDF.
3. The totals box now matches the screen (Subtotal/Tax rows only when taxed; the old PDF always printed One-time).
