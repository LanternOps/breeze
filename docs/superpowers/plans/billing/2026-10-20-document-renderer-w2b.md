# Document Renderer — W2b: Quote composition and swap (#9419)

> Feature #9414 · wave #9419 · base `main` after W1c (#9479) and W2a (#9448). Spec:
> `docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md` §3.2, §3.3, §3.5, §3.6, §8.1, §8.2.
> Pattern: the W1 plan (`…-document-renderer-w1.md`) Tasks 13–18. Closes #9419 and #6649.

**Goal:** the quote on screen comes from one composition — `QuoteDocumentView` in
`@breeze/document-ui`, fed by `buildQuoteDocumentModel` — on the web Preview, the
public proposal link and the logged-in portal. The three portal mirrors
(`quoteBlocks.tsx`, `documentShell.tsx`, `quoteAgreements.tsx`) and the web
`QuoteDocument.tsx` body are deleted.

**Rigor:** medium. Red first on every task; DOM parity (package snapshots read by both hosts) and the Playwright quote pair are the gate. No migration, no `apps/api` change.

## Facts from W2a that shape the work
- Model asset refs: `line_thumb` → line id, `agreement_file` → contract block id, `block_image`/`cover` → image id. Hosts resolve them from the DTO (`line.imageUrl`, `block.content.fileUrl`) they already hold.
- `terms.short` is `{ label, text }`; `AgreementBody` has `authored | uploaded | terms`; cover and agreement bodies carry their own labels.
- Status pill = `displayStatus` (sent → "Viewed" on every surface); the public page gains the pill.
- The staff draft Preview uses the stored tax rate (no refresh, by design).

## Tasks (each: failing test → implement → run → commit)

### Task 1 — pt-BR quote labels
Red: `labels.test.ts` asserts `DOCUMENT_LABELS_PT_BR.quote` is not the English object, has the same key structure, and `eyebrow === 'Proposta'`. Green: port the pt-BR `quotes.document.*` strings from `apps/web/src/locales/pt-BR/billing.json` into a real `quote` section (same keys, function-valued where English is). Drop the `DOCUMENT_LABELS_EN` import if unused.

### Task 2 — `QuoteBlocks.tsx` (package)
Red: `quoteDocumentView.test.tsx` renders the `blocks` fixture and asserts heading level classes, rich_text/callout/table markup (alignment classes, tinted header, zebra, caption), image figure with `width` attribute and unavailable fallback, `line_items` through `DocumentLineTable` with cadence headers, the subtotal row, and the CHF-monthly suffix span in both unit and amount cells. Green: `QuoteBlocks.tsx` (map over `QuoteBlockModel`), table subtotal row added to `DocumentLineTable` (`table.subtotal`), cadence suffix via `DocumentMoney`. Assertions worth keeping from the portal `quoteBlocks.test.tsx` move here.

### Task 3 — `DocumentAgreements.tsx` (package)
Red: authored/uploaded/terms rows, `#agreement-<id>` deep link opens a row, uploaded bodies mount `components.AgreementFile` only while open (lazy), print expansion (`beforeprint`) opens every row, lone-row heading suppressed. Green: port `AgreementRow`/`DocumentAgreements` from `documentShell.tsx`, bodies from `quoteAgreements.tsx`, strings from the model.

### Task 4 — `DocumentCover.tsx` (package)
Red: cover renders `h1` title, optional image via `components.Image`, prepared-for/by `dl` with the model's labels; absent when `cover === null`. Green: port `documentShell.tsx:55-96` geometry unchanged (W4 owns geometry).

### Task 5 — totals aside + `QuoteDocumentView.tsx` + CSS
Red: `DocumentTotals` renders `aside` (first-period box + note); `QuoteDocumentView` renders cover → header (`h2` number when a cover exists) → intro notes → blocks → totals → short terms → `signature` slot (default links built from `model.agreements`) → agreements → footer. Green: implement; move cover/agreement CSS into `document.css`; export from `index.ts`.

### Task 6 — fixtures and committed snapshots
Red: `snapshots.test.tsx` iterates `QUOTE_DTO_FIXTURES` against `quote-<name>.snap.html`. Green: `renderQuote.tsx`, `quoteSnapshotPath`, generate with `WRITE_SNAPSHOTS=1`, **read each snapshot by eye** before committing.

### Task 7 — portal swap
Red: `QuoteViews.parity.test.tsx` renders `PublicQuoteView` and `QuoteDetailView` for every fixture against the package snapshots. Green: `lib/quoteDocument.ts` (`toQuoteDto` envelope → DTO with rolling-deploy defaults, `quoteModelFor`), portal quote host components (`line_thumb` → `publicApiPath(line.imageUrl)`, `block_image`/`cover` → the page's image route, `AgreementFile` → iframe + download), both views render `QuoteDocumentView` with `slots.signature` = `SignaturePanel`; `QuoteDetailView` gains `initial`; the "Replaced" notice stays host policy. Delete `quoteBlocks.tsx`, `quoteBlocks.test.tsx`, `documentShell.tsx`, `quoteAgreements.tsx`. Update existing portal tests for the new test ids (`public-quote`/`quote` prefixes go away).

### Task 8 — web swap
Red: `QuoteDocument.parity.test.tsx` — the Preview, fed each fixture through a mocked `GET /quotes/:id/customer-view`, equals the package snapshot. Green: `QuoteDocumentPreview` (fetch, refetch on `detail` change and Preview-tab mount, loading/error/retry, accent via CSSOM, inert signature slot "Your customer signs here"), web host components (authed object URLs; agreement file iframe), delete the old body, its two tests, web's condensed rules in `globals.css`, and the body-only `quotes.document.*` keys from all 8 `billing.json` (+ `humanizedKeyBaseline.json` / `extractionQuality` entries); add `quotes.document.preview.{loading,loadError,retry,signatureInert}`. `QuoteDetail.tsx` never imported the body (only a comment named `DocContractFile`): comment updated, behaviour untouched.

### Task 9 — Playwright
Add the public-quote and Preview pair to `e2e-tests/tests/document-renderer.spec.ts` (accent under `style-src-attr 'none'`, cover H1, agreements lazy PDF). Update `quote-contract-proposal.spec.ts` selectors for removed test ids.

### Task 10 — verification
`cd packages/document-ui && npx vitest run` · web `components/billing/quotes src/lib/i18n src/locales` · portal `components/portal src/lib` · `tsc` in each package (read exit codes) · Playwright pair on a wt-stack · prove the parity test can fail.
