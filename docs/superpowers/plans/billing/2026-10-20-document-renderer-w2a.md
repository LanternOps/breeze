---
spec: docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md
feature_plan: docs/superpowers/plans/billing/2026-10-20-document-renderer.md
tracking_issue: LanternOps/breeze#9414
anchor_issue: LanternOps/breeze#9402
wave_issue: LanternOps/breeze#9418
---
# One Document Renderer — W2a Implementation Plan (quote assembler and routes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Every task is red first: write the assertion, watch it fail, then implement.

**Goal:** One server projection for quotes. `assembleCustomerQuoteDocument` in `apps/api/src/services/customerDocument.ts` becomes the only code that turns quote rows into the customer DTO; the public token route, the logged-in portal route and a new staff `GET /quotes/:id/customer-view` all return it. A pure `buildQuoteDocumentModel(dto, labels)` in `packages/shared/src/documents/` turns that DTO into the `QuoteDocumentModel` W2b renders. The logged-in portal route stops spreading the raw quote row (D19).

**Wave:** W04 = #9418, PR 4 of feature #9414. Branch `feature/9414-document-renderer/wave-9418` from `origin/main`. PR title `feat(billing): one customer-document assembler for quotes and a staff customer-view route (#9414 W2a)`. Body `Closes #9418`, `Part of #9414`.

**Spec:** §3.2 (quote model types), §3.4 (assembler, modes, staff routes), §8.1. Read the feature plan's Global Constraints, OD-9 section and "File ownership W2 vs W3a" first; every task inherits them. Line numbers below were checked against `origin/main` @ `9e0add3cef` (W1b merged); find code by symbol.

## Constraints (W2a subset)

- **No schema change, no migration, no RLS change.** The assembler adds `orgId` + `customerVisible` to the SQL row filter, which only narrows. `quote_blocks`/`quote_lines` are in `orgMergeRegistry.ts` with `quotes`, so `org_id` moves with the quote on a merge.
- **Visibility.** Hidden lines (`customer_visible = false`) are filtered **in SQL** in every mode. Today both routes read every line and filter in JS. The quote **line** keyset stays `CUSTOMER_LINE_FIELDS` (`quoteService.ts`) minus `imageId`/`catalogItemId`, plus `imageUrl` — unchanged. The **header** keyset is `PublicQuoteHeader` (`toPublicQuoteHeader`) + `displayStatus`, for every mode.
- **D19.** The portal detail route returns the assembler's header plus three route-level fields the portal page reads (`supersededByQuoteId`, `acceptanceOrigin`, `acceptedAt` — `QuoteDetailView.tsx`). Every other raw `quotes` column it spreads today is removed (list in Task 5).
- **Modes** (spec §3.4): `public` keeps `toPublicStatus` (`sent`→`viewed`, plain `Error` on `draft`, 410 `QUOTE_SUPERSEDED` on `superseded`); `portal` keeps the raw status and serves `superseded`; `staff` accepts any status. A draft outside staff mode throws `CustomerDocumentModeError` (W1b's class) before anything else. `displayStatus` everywhere: `draft`→`null`, `sent`→`viewed`, else the raw status.
- **`SanitizedHtml`** is cast in exactly one function in `customerDocument.ts`, applied to blocks that already passed `sanitizeQuoteBlocksForRead` and `renderContractBlocksForClient`. No new sanitizer and no sanitizer change.
- **OD-9.** `OD9_CUSTOMER_PROJECTION.screen.bundleNesting = false` → no `isChild` key on quote lines (omitted, never `undefined`). Quote lines already carry `parentLineId` today (`CUSTOMER_LINE_FIELDS`); that does not change, and the builder nests only from `isChild`.
- **OD-11.** The cadence suffix (`/mo`, `/yr`) rides on `unit` **and** `amount` (`DocumentMoney.suffix`).
- **Staff route.** `GET /quotes/:id/customer-view` sits beside `GET /:id` in `routes/quotes/quotes.ts` with the same `scopes` + `readPerm` + `zValidator('param', idParam)`. It does a raw select then `assertQuoteAccess` (the `getQuote` ownership path), calls **no** `refreshDraftQuoteTaxRate`, **no** `markQuoteViewed`, mints no token and writes no audit row. `mcpCoverage.ts` is keyed by route file (`'quotes/quotes.ts'`): **no entry changes**.
- **File ownership vs W3a (#9420, parallel).** W2a appends to `packages/shared/src/documents/labels/types.ts`, `labels/en.ts` and `documents/index.ts` **only** inside a section headed `// ---- W2a (#9418): quote document ----` at the end of the interface / object / file. Never edits `invoicePdf.ts`, `quotePdf.ts`, `documentPdfTable.ts`, `apps/api/src/i18n/`, any React file or `packages/document-ui`. The invoice half of `customerDocument.ts` is untouched except to share `CustomerDocumentModeError`, `OD9_CUSTOMER_PROJECTION` and `DocumentSurface`.
- **Commands.** `cd packages/shared && npx vitest run <path>`; `cd apps/api && npx vitest run <path>` (substring filters — check the file count). Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `packages/shared` and `apps/api`; read the exit code.
- **Fixtures** use invented names (`Example MSP`, `Acme Dental`, `Q-0042`) and ids `00000000-0000-4000-8000-0000000000NN`.

## Decisions this plan makes (each stated in the PR body)

1. **The DTO keeps today's public wire shape.** `CustomerQuoteDocument = { quote, blocks, lines, branding, documentLocale }` where `quote`/`blocks`/`lines`/`branding` are exactly what the public route returns today (pin, Task 3). `presentation` stays an **envelope** field the routes derive from `branding.theme`/`pageSize`; it is not duplicated in the DTO.
2. **Asset paths are a route input.** Line thumbnails and uploaded contract files are host-specific URLs (public: `/quotes/public/<token>/…`; portal: `/portal/quotes/<id>/…`; staff: `/quotes/<id>/images/<imageId>` or `/catalog/<catalogItemId>/image`, and `/quotes/<id>/contract-file/<blockId>`). The assembler takes `assets: CustomerQuoteAssetPaths` from the route. In the model, `thumbnail` is `{ kind: 'line_thumb', id: <line id> }` and an uploaded agreement is `{ kind: 'agreement_file', id: <block id> }`; the host's `Image`/`AgreementFile` component (W2b) resolves the ref with its own URL scheme. (The spec comment on `DocumentAssetRef.id` — "the line's uploaded image id" — describes the PDF; the customer DTO never carries line image ids.)
3. **Staff mode resolves a draft's seller before projection**, exactly as sending will freeze it: `quote.sellerSnapshot ?? buildSellerSnapshot(partner)` (`quoteLifecycle.ts` send path). Issued quotes always read their frozen snapshot. The customer receives this snapshot after send, so this is not a visibility change.
4. **Branding reads fail closed, as both quote routes do today.** (The invoice assembler is fail-soft because the invoice portal route was.) Both reads move to their own system context keyed on the authorized row, like W1b.
5. **Builder semantics where the two portal pages disagree** (W2b's PR lists the visible results): the header shows `quote.title` as the subtitle (logged-in page); the status pill is the logged-in page's label map applied to `displayStatus`, so the public page gains a "Viewed" pill (spec: "`sent` → Viewed"); `hasRecurring` is "a recurring line **or** a non-zero recurring header total" (logged-in page; the public page omitted the header half).
6. **Model additions** (additive to spec §3.2, components hold no strings): the image block gains `unavailableText`; `AgreementBody` gains `{ kind: 'terms'; text: string }` (the T&C row, today `TermsBody`) and the authored/uploaded bodies carry their unavailable/download text; the line-table `columns` keeps W1b's `notTaxable`.
7. **The view stamp moves after assembly** on both routes (today it runs mid-read); a stamp still never fails the render.
8. **The quote half lives in `apps/api/src/services/customerQuoteDocument.ts`**, not in `customerDocument.ts` (found during Task 6's wide run). It needs `quoteService`, whose import graph reaches modules that read `db` at load (`jobs/peripheralJobs.ts`); in `customerDocument.ts` it would load into every invoice route that imports the invoice half (`invoices/bulk.test.ts` went red on its partial `db` mock). The new module imports `CustomerDocumentModeError`, `OD9_CUSTOMER_PROJECTION` and `DocumentSurface` from `customerDocument.ts`, which is unchanged from W1b. Wherever this plan says "the quote half of `customerDocument.ts`", read `customerQuoteDocument.ts`; W3b imports the quote assembler from there.

## Review Focus (W2a)

1. **Superseded quote × 3 modes** → public: route 410 before the assembler (`isPublicLinkDead`) and the assembler itself throws 410 in public mode; portal: served, raw `status: 'superseded'`, `displayStatus: 'superseded'`, `supersededByQuoteId` still set; staff: served. Task 4 + Task 5 + Task 6.
2. **Hidden line with an internal description** never appears in any mode → real-DB test (Task 4) + JSON-absence in the route tests.
3. **Draft** → portal and public refuse before the assembler (404) and the assembler throws `CustomerDocumentModeError` if called; staff serves it with `displayStatus: null` and the partner-derived seller. Task 4 + Task 6.
4. **The staff route rejects exactly as `GET /quotes/:id`**: site miss 403 `SITE_DENIED`, foreign org 403 `ORG_DENIED`, missing `quotes:read` 403, organization-scoped token 403, missing quote 404 — status **and** body equal to the detail route, and no `refreshDraftQuoteTaxRate` write. Task 6.
5. **CHF monthly line** → `unit.suffix` and `amount.suffix` are both `{ text: '/mo', srText: 'per month' }` and `text` is the `de-CH` money form. Task 2.

---

### Task 1: Quote DTO and quote labels

**Files:**
- Create: `packages/shared/src/documents/quoteDto.ts`, `packages/shared/src/documents/quoteLabels.test.ts`
- Modify (W2a section only): `labels/types.ts`, `labels/en.ts`, `documents/index.ts`

**Produces (`quoteDto.ts`):**
```ts
export type CustomerQuoteStatus = 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted' | 'superseded';
/** The pill the customer's public link would show: sent reads as viewed; a draft has none. */
export type CustomerQuoteDisplayStatus = Exclude<CustomerQuoteStatus, 'draft' | 'sent'>;
export interface CustomerQuoteHeaderDto extends Omit<PublicQuoteHeader, 'status'> {
  status: CustomerQuoteStatus;                      // public: toPublicStatus-mapped; portal/staff: raw
  displayStatus: CustomerQuoteDisplayStatus | null;
}
export type CustomerQuoteBlockDto = { id; quoteId; orgId; sortOrder: number; createdAt: string } & (
  | { blockType: 'heading'; content: { text?: string; level?: number } }
  | { blockType: 'rich_text'; content: { html?: SanitizedHtml } }
  | { blockType: 'image'; content: { imageId?: string; caption?: string; width?: number } }
  | { blockType: 'line_items'; content: { label?: string; showSubtotal?: boolean } }
  | { blockType: 'table'; content: { columns: { label: SanitizedHtml; align?: 'left'|'center'|'right' }[]; rows: { cells: SanitizedHtml[] }[]; caption?: string; zebra?: boolean; headerStyle?: 'accent'|'plain' } }
  | { blockType: 'callout'; content: { variant: 'info'|'accent'|'warn'; title?: string; html: SanitizedHtml } }
  | { blockType: 'contract'; content: { label?: string; templateName: string; versionNumber: number; sourceType: 'authored'|'uploaded'; renderedHtml: SanitizedHtml | null; fileUrl: string | null } });
export interface CustomerQuoteLineDto { /* CUSTOMER_LINE_FIELDS minus imageId/catalogItemId, typed from the quote_lines columns */ imageUrl: string | null; isChild?: boolean }
export interface CustomerQuoteBrandingDto { partnerName: string | null; logoUrl; primaryColor; secondaryColor; supportEmail; supportPhone: string | null; theme: DocumentThemeId; pageSize: DocumentPageSize }
export interface CustomerQuoteDocument { quote: CustomerQuoteHeaderDto; blocks: CustomerQuoteBlockDto[]; lines: CustomerQuoteLineDto[]; branding: CustomerQuoteBrandingDto; documentLocale: string }
```
`createdAt` is typed `string`: the assembler converts the row `Date` with `toISOString()`, which is byte-identical to what `JSON.stringify` sends today.

**Labels (W2a section of `DocumentLabels`):** `quote: { eyebrow, draftNumber, issued, validUntil, preparedFor, preparedBy, columns: { description, qty, unitPrice, tax, amount }, pricing, cadence: { one_time, monthly, annual }, tableSubtotal, imageAlt, imageUnavailable, deviceSet: { devices, seats, inGroup(name), atSite(set, site), estimated(set), includesBilled(n, price), includesFlagged(n) }, category(c), totals: { firstPeriodSubtotal, subtotal, tax(pct), monthlyRecurring, annualRecurring, dueOnAcceptance, depositDueNow, remainingBalance, total, firstPeriodTotal, recurringNote }, terms, agreement: { fallbackTitle, termsTitle, pdfMeta, unavailableMeta, readMinutes(n), termsMeta(sections, minutes), footer(name, version), contentUnavailable, fileUnavailable, download }, status: Record<CustomerQuoteDisplayStatus, string> }`. English copied verbatim from `quoteBlocks.tsx`, `PublicQuoteView.tsx`, `QuoteDetailView.tsx` (`STATUS_LABELS`), `documentShell.tsx` (`DocumentCover`, `termsMeta`) and `quoteAgreements.tsx`. Device-role nouns come from `DEVICE_ROLE_NOUNS` (`@breeze/shared`), as today.

- [ ] **Step 1 (red):** `quoteLabels.test.ts` asserts the English strings the portal prints today: `columns.unitPrice === 'Unit price'`, `cadence.monthly === 'Monthly'`, `totals.remainingBalance === 'Remaining balance (due per terms)'`, `deviceSet.estimated('seats') === 'Estimated quantity — billed at the actual number of seats each billing period.'`, `agreement.termsMeta(2, 3) === '2 sections · ~3 min read'`, `agreement.termsMeta(0, 1) === '~1 min read'`, `agreement.footer('MSA', 2) === 'MSA — v2'`, `status.superseded === 'Replaced'`, `status.converted === 'Accepted'`, `category('hardware') === 'Hardware'`; and that `documentLabelsFor('fr-FR').quote` is the English map.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/documents/quoteLabels.test.ts` → FAIL (no `quote` key).
- [ ] **Step 3:** Implement `quoteDto.ts` and the labels section.
- [ ] **Step 4:** test PASS; `cd packages/shared && npx vitest run src/documents` PASS; typecheck `packages/shared` exit 0.
- [ ] **Step 5:** Commit `feat(shared): customer quote DTO and quote document labels (#9418)`.

### Task 2: `quoteModel.ts`, `buildQuoteDocumentModel`, quote fixtures

**Files:**
- Create: `packages/shared/src/documents/quoteModel.ts`, `quoteBuilder.ts`, `quoteBuilder.test.ts`, `fixtures/quoteDtos.ts`
- Modify (W2a section): `documents/index.ts`

**Produces:** spec §3.2 `QuoteTableBlock`, `QuoteBlockModel` (with `heading`), `AgreementBody`, `QuoteDocumentModel` plus Decision 6's additions; `buildQuoteDocumentModel(dto: CustomerQuoteDocument, labels: DocumentLabels): QuoteDocumentModel`; `QUOTE_DTO_FIXTURES: Record<QuoteFixtureName, CustomerQuoteDocument>` with `QuoteFixtureName = 'issued' | 'draft' | 'taxed' | 'untaxed' | 'recurring' | 'deposit' | 'cover' | 'blocks' | 'agreements' | 'deviceSet' | 'chfMonthly' | 'inr' | 'empty' | 'superseded' | 'multilineBlurb'`.

Rules the builder owns (port of `quoteBlocks.tsx`, `PublicQuoteView.tsx`/`QuoteDetailView.tsx` totals, `documentShell.tsx` cover/header, `quoteAgreements.tsx`):
- **Block walk** in `sortOrder`. `heading` → always (level `≤1`→1, `2`→2, else 3; text `String(text ?? '')`). `rich_text` → omitted when `html` is blank. `image` → `image: imageId ? { kind: 'block_image', id } : null`, `alt = caption || imageAlt`, `caption || null`, `width` finite > 0 else `null`, `unavailableText`. `table` → omitted without columns or rows; `align` default `left`; `headerStyle: 'plain' ? 'plain' : 'tinted'`; `zebra === true`; `caption || null`; row key `<blockId>:<i>`; **throws `DocumentModelError` when a row's `cells.length !== columns.length`** (the schema and the read sanitizer make this a programming error). `callout` → omitted when `html` is blank; tone `warn`/`accent`/else `neutral`; `title || null`. `contract` → never a body block. `line_items` → a pricing table over the lines whose `blockId` is the block's id, label `content.label || pricing`, subtotal when `showSubtotal === true`; omitted when it has no lines. Unknown types → omitted. Lines with **no** `blockId` form a trailing `line_items` block keyed `default-pricing` (label `pricing`, no subtotal). A line whose `blockId` names a non-`line_items` block is dropped, as today.
- **Pricing table**: groups in `RECURRENCE_GROUPS` order (`one_time`, `monthly`, `annual`; missing recurrence → `one_time`), empty groups dropped, group header `{ kind: 'cadence', label }` only when more than one group; one day bucket with `header: null`. Columns `labels.quote.columns`; the tax column iff `Number(taxTotal) > 0` (+ `notTaxable`); row tax: the portal `lineTax` rule (`taxable && rate > 0` → rounded cents, else `'exempt'`), no suffix. Row: `key = line.id`; `title = (name ?? description ?? '').trim() || '—'`; `blurb = name ? description.trim() || null : null`; `qty = String(Number(quantity))`; `unit`/`amount` carry the cadence suffix (`perMonth`/`perYear`, OD-11); `descriptor` = the device-set sentences; `thumbnail = imageUrl ? { kind: 'line_thumb', id: line.id } : null`; `isChild = line.isChild === true`; `workDate`, `note`, `ticketText` `null`. Table subtotal parts: per group, the sum of `lineTotal` in integer cents, with the group's suffix.
- **Totals**: rows in order — when taxed: `firstPeriodSubtotal`/`subtotal` (by `hasRecurring`) and `tax(pct)`; `monthlyRecurring` (suffix) when a monthly line exists and `hasRecurring`; `annualRecurring` likewise; one muted row per category when `categoryBreakdown.length > 1` (value = the non-zero parts, recurring ones suffixed); then with a deposit (`depositDueTotal != null`): `dueOnAcceptance` (strong, accent rule), `depositDueNow` (hero), `remainingBalance` (integer-cent difference); without: `hasRecurring ? dueOnAcceptance : total` (hero, accent rule). `dueOnAcceptance = dueOnAcceptanceTotal ?? oneTimeTotal ?? total`. `aside = hasRecurring ? { rows: [firstPeriodTotal = total], note: recurringNote } : null`. `depositStrip = null`.
- **Header**: eyebrow `quote.eyebrow`; `number = quoteNumber ?? quote.draftNumber`; `subtitle = title || null`; status from `displayStatus` (tones: `viewed`→info, `accepted`/`converted`→success, `declined`/`expired`→danger, `superseded`→neutral); dates Issued / Valid until; `billTo = cover ? null : billToName?.trim() ? { label: preparedFor, name, addressLines: [], taxId: null } : null`.
- **Cover** (`coverPage?.enabled`): `title = cover.title || quote.title || quoteNumber || eyebrow`; `image` ref `cover`; `preparedFor = cover.preparedForName || billToName || null`; `preparedBy = showPreparedBy ? partnerName : null`; `eyebrow`.
- **Agreements**: contract blocks in `sortOrder` → `{ id, anchor: 'agreement-<id>', title: label || templateName || fallbackTitle, meta, body }` (authored: `html = renderedHtml`, meta `readMinutes(htmlReadMinutes(html))` or `unavailableMeta`; uploaded: `file = fileUrl ? { kind: 'agreement_file', id } : null`, meta `pdfMeta`); then T&C when `termsAndConditions.trim()` → `{ id: 'terms', anchor: 'terms', title: termsTitle, meta: termsMeta(parseTermsSections(text).sectionCount, textReadMinutes(text)), body: { kind: 'terms', text } }`.
- `introNotes || null`; `terms.short = quote.terms || null`; `footer = null`; branding exactly as `buildInvoiceDocumentModel` (wordmark = partnerName ?? seller name; url logo; seller lines).

- [ ] **Step 1 (red):** `quoteBuilder.test.ts` — one `it` per fixture on its decisive fields, plus: the OD-11 CHF case (Review Focus 5); `superseded` builds with a neutral "Replaced" pill; `cover` → `header.billTo === null` and cover fields; `blocks` → kinds in order, empty rich_text/callout/table omitted, heading levels, alignment values, table cell-count mismatch throws `DocumentModelError`; orphan lines → trailing `default-pricing`; a line bound to a non-`line_items` block is dropped; `deviceSet` → descriptor sentences; `recurring` → cadence headers and aside; `deposit` → the three deposit rows and the integer-cent remainder; `isChild` absent → flat, present → nested; the same DTO always yields the same model; every row title non-empty.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/documents/quoteBuilder.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `cd packages/shared && npx vitest run src/documents src/browserSafeBarrel.test.ts` PASS; typecheck exit 0.
- [ ] **Step 5:** Commit `feat(shared): build the quote document model from the customer DTO (#9418)`.

### Task 3: Characterization pins for today's public and portal quote responses

Records today's behaviour on unmodified routes, so Task 5 can prove the public route only **adds** keys and the portal route loses exactly the listed raw-row keys.

**Files:**
- Create: `apps/api/src/routes/__fixtures__/customerQuotePin.ts` (one sent quote row with every `quotes` column populated with a sentinel where internal — accept-token jti, send job id, pdf ref, decline reason, `billToAddress`/`billToTaxId`, `presentationSnapshot`, `revisionOfQuoteId`… — a partner, a `portal_branding` row, blocks (heading, rich_text, line_items, table, callout, image) and three lines: one-time taxable with an image, monthly, and a `customerVisible = false` line whose description is `HIDDEN-QUOTE-LINE`), `apps/api/src/routes/quotesPublic.customerDocumentPin.test.ts`, `apps/api/src/routes/portal/quotes.customerDocumentPin.test.ts`
- Mocks: `tableKeyedDb` for `../db` (so the pin survives the query-order change), `quoteAcceptToken`, `orgMerge`, `publicLinkOrgGate`, `quoteLifecycle.markQuoteViewed`, `quoteAcceptCheckout.isPayOnAcceptAvailable` stubbed.

- [ ] **Step 1:** Each test does `expect(body).toEqual(PIN)` with `PIN = 'REPLACE_ME'`. Do **not** assert hidden-line absence here: the mocked DB returns the rows registered, so the JS filter that exists today is the only thing filtering.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/quotesPublic.customerDocumentPin.test.ts src/routes/portal/quotes.customerDocumentPin.test.ts` → FAIL; harvest the printed JSON.
- [ ] **Step 3:** Pin it as `PUBLIC_PIN` / `PORTAL_PIN` with `// Recorded at origin/main 9e0add3cef before the quote assembler existed. Task 5 may only ADD the declared keys (public) / REMOVE the declared raw keys (portal).` Frozen from here: `git diff <Task 3 commit> -- apps/api/src/routes/__fixtures__/customerQuotePin.ts` must be empty at the end of W2a.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `test(billing): pin today's public and portal quote payloads (#9418)`.

### Task 4: The quote assembler

**Files:**
- Modify: `apps/api/src/services/publicQuoteDto.ts` (extract `toCustomerQuoteHeaderFields(row, totals)` = every `PublicQuoteHeader` key except `status`; `toPublicQuoteHeader` = those fields + `status: toPublicStatus(row.status)`, behaviour unchanged; export `toPublicQuoteStatus`), `apps/api/src/services/quoteService.ts` (extract `getAccessibleQuoteRow(id, actor)` = the raw select + 404 `QUOTE_NOT_FOUND` + `assertQuoteAccess` that `getQuote` opens with; `getQuote` calls it), `apps/api/src/services/customerDocument.ts` (quote half, below the invoice half)
- Create: `apps/api/src/services/customerDocument.quote.test.ts`, `apps/api/src/services/customerDocument.quote.integration.test.ts`; register the latter in `apps/api/vitest.integration.config.ts` beside `customerDocument.integration.test.ts`

**Interfaces (produces):**
```ts
export interface CustomerQuoteAssetPaths {
  lineImage(line: { id: string; imageId: string | null; catalogItemId: string | null }): string;
  contractFile(blockId: string): string;
}
export function quoteDisplayStatus(status: QuoteRow['status']): CustomerQuoteDisplayStatus | null;
export async function loadCustomerQuoteRows(quote: QuoteRow): Promise<{ blocks: …; lines: … }>;
export async function assembleCustomerQuoteDocument(
  quote: QuoteRow, mode: CustomerDocumentMode,
  opts: { assets: CustomerQuoteAssetPaths; surface?: DocumentSurface; projection?: Od9Projection },
): Promise<CustomerQuoteDocument>;
```
- `loadCustomerQuoteRows`: blocks `WHERE quote_id = quote.id AND org_id = quote.orgId ORDER BY sort_order` → `sanitizeQuoteBlocksForRead`; lines `WHERE quote_id = quote.id AND org_id = quote.orgId AND customer_visible = true ORDER BY sort_order` → `toCustomerLines`. Both on the caller's context (system for public, org for portal, partner for staff), as today.
- `assembleCustomerQuoteDocument`: draft outside staff → `CustomerDocumentModeError`; rows; partner (`name`, `settings`, `documentTheme`, `documentPageSize` + the seller billing columns) and `portal_branding` (`logoUrl`, `primaryColor`, `supportEmail`, `supportPhone`) each in `runOutsideDbContext(() => withSystemDbAccessContext(…))` keyed on `quote.partnerId`/`quote.orgId`; `documentLocale = quote.documentLocale ?? resolvePartnerDocumentLocale(partner)`; `blocks = renderContractBlocksForClient(rawBlocks, quote, assets.contractFile, documentLocale)` → the single `SanitizedHtml` cast + `createdAt` ISO; `totals = computeQuoteTotals(...)` exactly as both routes do today; `lines = attachCustomerLineImages(...)` with `assets.lineImage`, then `isChild` only when `projection[surface].bundleNesting`; header: `mode === 'public' ? toPublicQuoteHeader(row', totals) : { ...toCustomerQuoteHeaderFields(row', totals), status: quote.status }` + `displayStatus`, where `row'` has the staff-draft seller (Decision 3); branding: `{ partnerName: partner?.name ?? null, ...resolveDocumentBrand(brand, partner?.settings), supportEmail, supportPhone, theme, pageSize }` with `theme`/`pageSize` from `presentationSnapshot ?? partner` (`resolveThemeId`/`resolvePageSize`).

- [ ] **Step 1 (red):** `customerDocument.quote.test.ts` (`tableKeyedDb`):
```ts
describe.each(['public', 'portal', 'staff'] as const)('%s mode', (mode) => {
  it('the line query filters quoteId, orgId and customerVisible in SQL', …);   // renderSql(where) params
  it('the block query filters quoteId and orgId', …);
  it('a superseded quote: public throws 410 QUOTE_SUPERSEDED, portal/staff serve raw status', …);
});
it('a draft is accepted in staff mode only (CustomerDocumentModeError otherwise)', …);
it('displayStatus: draft→null, sent→viewed, superseded→superseded, accepted→accepted', …);
it('public maps sent→viewed in status; portal and staff keep sent', …);
it('header keyset is exactly PublicQuoteHeader + displayStatus in every mode (listed literally)', …);
it('staff draft: seller resolved from the partner; issued: the frozen snapshot wins', …);
it('documentLocale: quote stamp → partner language → en', …);
it('asset paths come from the route (line images, uploaded contract files)', …);
it('OD-9 screen: no isChild key; projection with bundleNesting: isChild from parentLineId', …);
it('partner and branding read in their own system context; a failing read rejects (fail closed)', …);
it('createdAt leaves as the ISO string JSON.stringify would produce', …);
```
  `customerDocument.quote.integration.test.ts` (real DB, seeding style of `customerDocument.integration.test.ts`): a sent quote with a `customerVisible = false` line whose description is a sentinel, a partner with `settings.language = 'pt-BR'`, a `portal_branding` row, and a draft; assembled under the portal-user context, a staff context and the system context. Asserts: the sentinel is absent; partner-axis reads returned rows (`partnerName`, `logoUrl`); `documentLocale === 'pt-BR'`; the header has no raw-row key (`acceptTokenJti`, `sendJobId`, `pdfDocumentRef`, `declineReason`, `presentationSnapshot`…); the draft is refused in portal mode and served in staff mode with the partner-derived seller.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/customerDocument.quote.test.ts` → FAIL (exports missing). On a per-worktree stack: `npx vitest run --config vitest.integration.config.ts src/services/customerDocument.quote.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd apps/api && npx vitest run src/services/customerDocument src/services/publicQuoteDto src/services/quoteService` → PASS (report the file count); integration PASS on the stack; typecheck `apps/api` exit 0.
- [ ] **Step 5:** Commit `feat(billing): customer-document assembler for quotes (#9418)`.

### Task 5: Public and portal quote routes return the assembler's output (D19)

**Files:**
- Modify: `apps/api/src/routes/quotesPublic.ts` (`GET /:token`, the live branch), `apps/api/src/routes/portal/quotes.ts` (`GET /quotes/:id`), both Task 3 pin tests, and any existing FIFO-mock route tests whose call order or expectations change (`quotesPublic.test.ts`, `quotesPublic.superseded.test.ts`, `portal/quotes.test.ts`, `portal/quotes.acceptance.test.ts`)

- [ ] **Step 1 (red): change the pins to the target.**
  - Public: `expect(stripKeys(body, ['data.quote.displayStatus', 'data.documentLocale'])).toEqual(PUBLIC_PIN)`; `body.data.quote.displayStatus === 'viewed'`; `body.data.documentLocale === 'en'`.
  - Portal: `expect(stripKeys(body, ['data.quote.displayStatus', 'data.documentLocale'])).toEqual(withoutKeys(PORTAL_PIN, D19_REMOVED_QUOTE_KEYS, NORMALIZED))`, where `D19_REMOVED_QUOTE_KEYS` is listed literally (every raw `quotes` column not in `PublicQuoteHeader` except `acceptedAt`) and `NORMALIZED` replaces `coverPage`/`sellerSnapshot` with their `toPublic*` forms; `Object.keys(body.data.quote).sort()` equals the literal header keyset + `['acceptanceOrigin', 'acceptedAt', 'supersededByQuoteId']`; the JSON has no sentinel from the pin row's internal columns.
  - Portal: a superseded quote is served 200 with `status: 'superseded'`, `displayStatus: 'superseded'` and `supersededByQuoteId`.
  - Public: a dead link still answers today's 410 body and never calls the assembler (spy).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/quotesPublic.customerDocumentPin.test.ts src/routes/portal/quotes.customerDocumentPin.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - **Public:** inside the existing system context, after the dead-link branch: `const doc = await assembleCustomerQuoteDocument(quote, 'public', { assets: { lineImage: (l) => \`/quotes/public/${enc(token)}/line-image/${l.id}\`, contractFile: (b) => \`/quotes/public/${enc(token)}/contract-file/${b}\` } })`, then the best-effort `markQuoteViewed`. Payload `{ quote: doc.quote, blocks: doc.blocks, lines: doc.lines, branding: { ...doc.branding, partnerName: doc.branding.partnerName ?? 'Proposal' }, presentation: { theme, pageSize }, documentLocale }`; `payOnAccept` unchanged. Keep the `QuoteServiceError`/`ContractTemplateServiceError` mapping.
  - **Portal:** keep the row read and the draft 404; `assembleCustomerQuoteDocument(quote, 'portal', { assets: { lineImage: (l) => \`/portal/quotes/${id}/line-image/${l.id}\`, contractFile: (b) => \`/portal/quotes/${id}/contract-file/${b}\` } })`; best-effort stamp; successor + acceptance reads unchanged; payload `quote: { ...doc.quote, supersededByQuoteId, acceptanceOrigin, acceptedAt: quote.acceptedAt }`, `blocks`, `lines`, `branding` (as public), `presentation`, `documentLocale`. Drop the route's own partner/branding/lines/blocks/totals code.
- [ ] **Step 4:** `cd apps/api && npx vitest run src/routes/quotesPublic src/routes/portal/quotes` → PASS (report the file count); typecheck exit 0.
- [ ] **Step 5:** Commit `refactor(billing): public and portal quote routes serve the assembled customer document (D19) (#9418)`.

### Task 6: `GET /quotes/:id/customer-view`

**Files:**
- Modify: `apps/api/src/routes/quotes/quotes.ts` (new route directly after `GET /:id`)
- Create: `apps/api/src/routes/quotes/customerViewRoute.test.ts` (W1b's `routes/invoices/customerViewRoute.test.ts` pattern: real router, real `requireScope`, `tableKeyedDb` whose writes throw, test actor injected through the mocked `authMiddleware`)

**Produces:** `GET /quotes/:id/customer-view` → `200 { data: CustomerQuoteDocument }`. Handler: `const quote = await getAccessibleQuoteRow(id, quoteActorFrom(c)); return c.json({ data: await assembleCustomerQuoteDocument(quote, 'staff', { assets: STAFF_ASSETS(id) }) });` inside `try { … } catch (err) { return handleServiceError(c, err); }`.

- [ ] **Step 1 (red):**
```ts
it('serves an issued quote as { data: CustomerQuoteDocument }', …);
it('serves a draft (displayStatus null) and never calls refreshDraftQuoteTaxRate (no write; tax rate unchanged)', …);
it('serves a superseded quote (Review Focus 1, staff mode)', …);
it('never stamps the view and writes nothing', …);            // markQuoteViewed spy; tableKeyedDb throws on writes
it('returns exactly the allowlisted keys (no token, no internal field)', …);   // data, data.quote, branding, line keys literal; no sentinel
it.each([siteRestricted 403, foreignOrg 403, noReadPerm 403, orgScoped 403])('%s is rejected exactly as GET /quotes/:id', …);  // status + text equal
it('a site miss carries SITE_DENIED; a foreign org ORG_DENIED (same as the detail route)', …);
it('a rejected caller reads only the quotes table', …);
it('a missing quote is the same 404 as the detail route; a non-uuid id the same 400', …);
it("an issued quote equals the portal route's document fields (spec §8.1)", …);   // asset paths normalised to the line/block id, envelope extras dropped
it('a hidden line never appears in the body', …);
it('lives in a route file mcpCoverage already covers (keyed by file; no entry change)', …);
```
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/quotes/customerViewRoute.test.ts` → FAIL (404).
- [ ] **Step 3:** Implement the route.
- [ ] **Step 4:** `cd apps/api && npx vitest run src/routes/quotes src/services/customerDocument src/__tests__/mcp-coverage.test.ts` → PASS; typecheck exit 0.
- [ ] **Step 5:** Commit `feat(billing): GET /quotes/:id/customer-view for the staff Preview (#9418)`.

**W2a exit:** `cd packages/shared && npx vitest run src/documents`; `cd apps/api && npx vitest run customerDocument quotesPublic portal/quotes quotes/quotes publicQuoteDto` and `src/routes/quotes`; typecheck `packages/shared` and `apps/api` exit 0; integration (`customerDocument.integration.test.ts` + `customerDocument.quote.integration.test.ts`) green on a per-worktree stack, then `pnpm wt-stack down`. `git diff <Task 3 commit> -- apps/api/src/routes/__fixtures__/customerQuotePin.ts` empty.
