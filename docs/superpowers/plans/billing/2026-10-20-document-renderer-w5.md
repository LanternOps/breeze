# Document renderer W5 — Detail description cells reuse `DocumentLineDescription` (#9423)

Feature plan: `2026-10-20-document-renderer.md` §W5. Spec OD-4 (a): Detail keeps `LineItemsTable`; only the description cell is shared, through a **staff-row presenter**. Staff rows and customer rows are never zipped by position.

**Files:** `packages/shared/src/documents/lineDescription.ts` (+test), `apps/web/.../InvoiceDetail.tsx`, `quotes/QuoteDetail.tsx`, `invoiceTypes.ts` / `quotes/quoteTypes.ts` (helper cleanup). Not touched: W4 files, portal, API, PDF.

## Tasks (red first)

- [ ] **T1 presenter.** `lineDescriptionProps(line, labels)` → `DocumentLineDescriptionProps`: title/blurb (legacy fallback: title = name ?? description; blurb only when a distinct name exists), optional work date, worked-vs-billed note (via `labels.workedVsBilled`), ticket text, `descriptor: []`, `qtyFold: null`. Test in `lineDescription.test.ts` first.
- [ ] **T2 Detail hidden row.** Test: an internal-only line (`customerVisible=false`) renders in Detail's internal view with the hidden marker, next to a visible line — never dropped. Green before and after (guards the refactor).
- [ ] **T3 InvoiceDetail / QuoteDetail** render `<DocumentLineDescription {...lineDescriptionProps(l, labels)} />`. Host keeps: ticket chip, child-line arrow, hidden marker, `InvoiceLineDevices`, cost/margin columns. `InvoiceDetail.linebreaks.test.tsx` stays green; add the same for QuoteDetail.
- [ ] **T4 cleanup.** Grep every caller of web `lineTitle`/`lineBlurb`; delete only helpers with none left.
- [ ] **T5 gates.** shared `vitest run documents`; web `vitest run components/billing/InvoiceDetail components/billing/quotes/QuoteDetail components/billing/shared`; tsc (shared, document-ui, web) with exit codes.
