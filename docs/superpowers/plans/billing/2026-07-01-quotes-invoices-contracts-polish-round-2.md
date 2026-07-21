# Quotes / Invoices / Contracts Polish Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the Quotes, Invoices, and Contracts surfaces onto a shared component kit and bring the invoice/contract editors up to the quote editor's interaction quality, per the 2026-07-01 design critique (`.impeccable/critique/2026-07-01T22-01-07Z__apps-web-src-components-billing.md`).

**Architecture:** Extract best-of-breed patterns (identified per-pattern in the critique) into `apps/web/src/components/billing/shared/`, then adopt them in all three surfaces; then backport the quote editor's save/validation grammar to the invoice and contract editors; then a final polish sweep. Each task is one reviewable PR-sized unit and leaves all tests green.

**Tech Stack:** React 19 islands in Astro, Tailwind 4 (token classes, `dark:` variants), Vitest + jsdom + Testing Library, `runAction` for mutations, `data-testid` selectors (E2E convention).

## Global Constraints

- Decisions locked by the user: keep the 3-tab workspace for invoices; contract editor moves to **blur-autosave** (quote-editor grammar); all three phases in scope.
- Every mutation handler goes through `runAction` (`apps/web/src/lib/runAction.ts`) — see CLAUDE.md catch pattern; do not add entries to `runActionAllowlist.ts` (adopted surfaces already comply).
- Tests live alongside sources (`Foo.tsx` → `Foo.test.tsx`). Run web tests with `cd apps/web && pnpm vitest run <file>`; full suite `pnpm test --filter=@breeze/web`.
- All interactive elements query-able by `data-testid`; keep every existing `data-testid` working (E2E depends on them). New interactive elements get new testids.
- Tailwind semantic tokens only (`text-muted-foreground`, `bg-card`, `border-border`, status tokens via `STATUS_PILL` roles); no raw palette hues (`emerald-500`) in new code; every new visual has a `dark:` story via tokens.
- Client-side UI state in `window.location.hash`, never query params.
- Preserve behaviors called out as strengths: block-remove message counting child lines, Issued/Sent distinction, sticky actions column, distributor pre-check, reorder burst-coalescing, hash-persisted filters.
- Never edit shipped migrations; no schema changes are needed in this plan (all data already exists — e.g. `convertedInvoiceId`, `acceptedAt`).
- Files touched here are large; do not split files beyond what a task specifies (CLAUDE.md: no proactive splitting).
- Commit per task step with conventional-commit messages; branch is `ToddHebebrand/quotes-invoices-contracts-polishing-round-2`.

**Verification stack:** worktree stack is running at `http://localhost:32801` (`.breeze-stack.json`, admin `admin@breeze.local` / `BreezeAdmin123!`). Use it to eyeball each task's result on `/billing/quotes`, `/billing/invoices`, `/contracts`.

---

## Phase 1 — Shared billing kit

### Task 1: `StatusPill` + shared `format.ts`

**Files:**
- Create: `apps/web/src/components/billing/shared/StatusPill.tsx`
- Create: `apps/web/src/components/billing/shared/StatusPill.test.tsx`
- Create: `apps/web/src/components/billing/shared/format.ts`
- Create: `apps/web/src/components/billing/shared/format.test.ts`
- Modify: `apps/web/src/components/billing/invoiceTypes.ts` (re-export formatters from shared; keep `STATUS_PILL` as source of truth or move it — see below)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts` (delete duplicate `formatMoney`/`formatDate`, re-export from shared)
- Modify: `apps/web/src/lib/api/contracts.ts:174-180` (delete `CONTRACT_STATUS_COLORS` raw-palette map; replace with STATUS_PILL role mapping)
- Modify: `apps/web/src/components/contracts/ContractsList.tsx`, `ContractDetail.tsx`, `ContractWorkspace.tsx` (render `<StatusPill>`; delete the two local `formatDate` copies at `ContractsList.tsx:63`, `ContractDetail.tsx:52`)
- Modify: `apps/web/src/components/billing/quotes/QuotesPage.tsx`, `QuoteDetail.tsx`, `InvoicesPage.tsx`, `InvoiceDetail.tsx`, `InvoiceDocument.tsx`, `QuoteDocument.tsx` (replace inline status spans with `<StatusPill>`)

**Interfaces:**
- Produces: `StatusPill({ role, label, className?, testId? })` where `role: 'success' | 'warning' | 'danger' | 'info' | 'neutral'` (exactly the existing `STATUS_PILL` roles in `invoiceTypes.ts:124-146`); renders `<span>` with the STATUS_PILL classes for `role`, an `sr-only` prefix `Status:` (the quotes pattern from `QuotesPage.tsx:455-456` — NOT `aria-label` on a span), and visible `label`.
- Produces: `formatMoney(cents: number, currencyCode?: string): string` and `formatDate(iso: string | null | undefined): string` in `shared/format.ts` — move the implementations from `invoiceTypes.ts` verbatim (they are the canonical copies per critique). `invoiceTypes.ts` and `quoteTypes.ts` re-export them so no import site breaks.
- Produces: `CONTRACT_STATUS_ROLES: Record<ContractStatus, {role: StatusPillRole, label: string}>` — active→success, draft→neutral, paused→warning, cancelled→neutral (keep any existing line-through styling as `className`), expired→warning.

- [ ] **Step 1: Write failing tests** — `StatusPill.test.tsx`: renders visible label; renders `sr-only` text `Status:` (assert `screen.getByText('Status:')` has class `sr-only`); applies STATUS_PILL classes per role; no `aria-label` attribute. `format.test.ts`: `formatMoney(112500)` → `$1,125.00`; `formatMoney(0, 'EUR')` includes `€` or `EUR`; `formatDate(null)` → the same fallback string invoiceTypes' current impl returns (read it first, assert exact).
- [ ] **Step 2: Run tests, verify they fail** — `cd apps/web && pnpm vitest run src/components/billing/shared/`
- [ ] **Step 3: Implement `StatusPill.tsx` and `format.ts`** (move code from invoiceTypes, don't rewrite the math). Update `invoiceTypes.ts`/`quoteTypes.ts` to re-export.
- [ ] **Step 4: Run tests, verify pass; run existing suites** — `pnpm vitest run src/components/billing` must stay green (they cover formatters via existing tests).
- [ ] **Step 5: Adopt in all six render sites + contracts role map; delete dead local copies.** Grep for `CONTRACT_STATUS_COLORS` and both local `formatDate` definitions to confirm zero remaining references.
- [ ] **Step 6: Full web test run + visual check** on the stack (contracts pill green must now match invoices "Paid" green; VoiceOver-style check: pill text includes hidden "Status:").
- [ ] **Step 7: Commit** — `feat(web): shared StatusPill + billing format helpers; contracts on semantic status roles`

### Task 2: `SortableTh` + shared skeletons; Contracts gains search/sort/skeletons

**Files:**
- Create: `apps/web/src/components/billing/shared/SortableTh.tsx` (+ `SortableTh.test.tsx`)
- Create: `apps/web/src/components/billing/shared/TableSkeleton.tsx`
- Modify: `QuotesPage.tsx:260-287,573-602` and `InvoicesPage.tsx:311-338,830-859` (delete verbatim-duplicate `SortHeader`/`SortHeaderLeft`, use `SortableTh`)
- Modify: `ContractsList.tsx` (add search box over name/org — same client-side filter pipeline as quotes; add sort on Name/Org/Status/Est-per-period/Start; replace spinner at `:273-275` with `TableSkeleton`; delete the vestigial `useMemo` at `:152`)

**Interfaces:**
- Produces: `SortableTh({ label, sortKey, activeSort, direction, onSort, align?: 'left' | 'right', testId? })` — renders `<th aria-sort=...>` with button; extracted from the existing quotes/invoices implementation (they are identical — lift, parameterize alignment, keep markup/classes byte-compatible so visual output is unchanged).
- Produces: `TableSkeleton({ rows?: number, cols: number })` — the 6-row skeleton block pattern from `QuotesPage.tsx:359-368`, generalized to column count.

- [ ] **Step 1: Failing tests** — `SortableTh.test.tsx`: renders `aria-sort="ascending"` when active+asc, `none` when inactive; clicking calls `onSort(sortKey)`. Contracts: extend `ContractsList` tests — typing in new search box (`data-testid="contracts-search"`) filters rows by name; loading state renders skeleton rows not a spinner (assert by testid `table-skeleton`).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement; adopt in quotes+invoices (pure refactor, snapshots of table headers unchanged) and contracts (new capability).**
- [ ] **Step 4: Run `pnpm vitest run src/components/billing src/components/contracts` — green.**
- [ ] **Step 5: Commit** — `feat(web): shared SortableTh/TableSkeleton; contracts list gains search, sort, skeletons`

### Task 3: `ListFilterBar` semantics + `BulkActionBar` fixes

**Files:**
- Modify: `apps/web/src/components/billing/bulk/BulkActionBar.tsx` (bar reserves its own space; accept optional `draftCount` label awareness from contracts)
- Modify: `QuotesPage.tsx` (add `hasActiveFilters` + filtered-empty branch + Clear-filters button; fix `writeFilters` bare-`#` residue at `:69`)
- Modify: `InvoicesPage.tsx` (same filtered-empty branch; keep its existing Clear button; fix `:71` hash residue)
- Modify: `ContractsList.tsx:321-323` (drop the manual `pb-14` once the bar reserves space)

**Interfaces:**
- Consumes: contracts' `hasActiveFilters` branching pattern (`ContractsList.tsx:163,289-318`) — port the logic, don't re-invent: filtered-empty state says "No quotes match these filters" + `Clear filters` button (testid `quotes-clear-filters` / reuse `invoices-clear-filters`); first-run keeps the existing teaching empty state.
- Produces: `BulkActionBar` renders an in-flow spacer (or `position: sticky` bottom) such that the last table row is never occluded; callers need no padding hacks.

- [ ] **Step 1: Failing tests** — QuotesPage: with `status=declined` in hash and zero rows, renders `quotes-filtered-empty` (not the teaching empty), Clear button resets hash to no residue (`window.location.hash === ''` and no trailing `#` — use `history.replaceState` pattern if the bare-`#` can't be avoided via assignment). BulkActionBar: selecting rows does not change table container's scroll height overlap — assert the bar container includes the spacer element (testid `bulk-bar-spacer`).
- [ ] **Step 2: Verify fail.** — note existing bulk tests: `QuotesPage.bulk.test.tsx`, `InvoicesPage.bulk.test.tsx`, `ContractsList.bulk.test.tsx` must stay green.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Suite green; visual check: select a row near viewport bottom on quotes — last row visible above bar.**
- [ ] **Step 5: Commit** — `fix(web): filtered-empty states + clear filters on quotes/invoices; BulkActionBar reserves its own space`

### Task 4: `DocumentWorkspace` + `usePdfDownload`

**Files:**
- Create: `apps/web/src/components/billing/shared/DocumentWorkspace.tsx` (+ test)
- Create: `apps/web/src/components/billing/shared/usePdfDownload.ts`
- Modify: `QuoteWorkspace.tsx`, `InvoiceWorkspace.tsx` → thin wrappers over `DocumentWorkspace` (~190 duplicated lines deleted)
- Modify: `InvoiceDetail.tsx:115-136`, `InvoiceDocument.tsx:235-256` (delete both inline `downloadPdf` copies; use `usePdfDownload`)
- Modify: `apps/web/src/components/billing/quotes/useQuotePdfDownload.ts` → re-export of `usePdfDownload(path, filename)` specialization
- Modify: `InvoiceWorkspace.tsx` header: gains action slot (Issue / Issue & Send / Download PDF / Delete draft surfaced from `InvoiceDetail`/`InvoiceEditor` as appropriate for status), and the status pill in the header (contracts pattern). `ContractWorkspace.tsx:104-109`: align header composition (back + truncating title + StatusPill + actions) — add `truncate` + `min-w-0` so long names can't wreck the row.

**Interfaces:**
- Produces: `DocumentWorkspace({ backHref, backLabel, title, statusPill?: ReactNode, actions?: ReactNode, tabs: {id, label, hidden?}[], activeTab, onTabChange, children })` — lifts the existing WAI-ARIA tablist implementation with roving tabindex + Home/End verbatim from `QuoteWorkspace.tsx:88-101`; tab state stays in `window.location.hash`.
- Produces: `usePdfDownload({ path, filename }): { download: () => Promise<void>, downloading: boolean }` — generalized from `useQuotePdfDownload` (authed fetch → blob → object URL → anchor click → revoke), error surfaced via `runAction`/toast like the current hook.
- Header layout must handle the disabled-primary-action case without wrapping into page center (critique browser finding): actions cluster is `flex items-center gap-2 flex-wrap justify-end`, disabled-reason hint rendered below the cluster (`text-xs text-muted-foreground text-right`), not inline between buttons.

- [ ] **Step 1: Failing tests** — DocumentWorkspace: renders tablist with `aria-selected`, ArrowRight moves focus (fireEvent.keyDown), hidden tab absent; header renders title + actions slot. usePdfDownload: mocks fetch, asserts blob URL anchor download + revoke (mirror the existing `useQuotePdfDownload` test if present; else write one).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement; port both workspaces; wire invoice header actions (Issue button visible from any tab for drafts — behavior handlers already exist in `InvoiceDetail`/`InvoiceEditor`, lift them up via props, don't duplicate logic).**
- [ ] **Step 4: All existing workspace/permission tests green** (`QuoteWorkspace`, `InvoiceWorkspace.test.tsx`, `ContractWorkspace.permissions.test.tsx`); visual check on the stack: invoice draft header shows actions; long contract name truncates.
- [ ] **Step 5: Commit** — `refactor(web): shared DocumentWorkspace + usePdfDownload; invoice header actions; contract title truncation`

---

## Phase 2 — Behavior parity

### Task 5: Keyboard-accessible list rows (P0)

**Files:**
- Modify: `QuotesPage.tsx:427-431`, `InvoicesPage.tsx:548-553` (+ mobile `DataCard` at `:604`), `ContractsList.tsx:345-351`

**Interfaces:**
- The Number/Name cell content becomes a real `<a href={detailUrl}>` styled as the current text (`text-foreground` + `hover:underline`, `focus-visible` ring token), `data-testid` preserved on the row plus new `*-row-link` testids. Row `onClick` stays for pointer convenience; the anchor's click must `stopPropagation` to avoid double navigation. Mobile invoice `DataCard`: wrap title in the same anchor.

- [ ] **Step 1: Failing tests** — each list: the row contains a link with `href` `/billing/quotes/<id>` (resp. invoices/contracts); link is focusable (`tabIndex` not `-1`).
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Suites green; manual: Tab from search box reaches first row link, Enter opens detail.**
- [ ] **Step 5: Commit** — `fix(web): billing/contract list rows keyboard-accessible via real links`

### Task 6: Invoice editor parity backport (P1)

**Files:**
- Modify: `apps/web/src/components/billing/InvoiceEditor.tsx` (the whole editing grammar), tests in `InvoiceEditor.test.tsx`

**Interfaces (all consumed from `QuoteEditor.tsx` — read these before coding):**
- Scoped pending: replace the single `busy` boolean (`InvoiceEditor.tsx:39,138-155`) with the `runScoped(key, fn)` pattern from `QuoteEditor.tsx:189-215` — key per line-field (`qty-<lineId>`, `price-<lineId>`, `notes`, `addLine`), only the in-flight control disables.
- Commit guards: port `commitQty`/`commitPrice` semantics from `QuoteEditor.tsx:297-326` — clamp/reject NaN, qty>0, price≥0, numeric compare (not string compare — fixes the `3.00` vs `3` redundant PATCH at `:621`), keep-input + inline explanation on invalid.
- Dirty/saved cues: port `fieldRing` (amber dirty ring → green saved pulse) + `SrSaved` polite announcement from `QuoteEditor.tsx:97-125`.
- Resync guard: port the edited-flag resync (`QuoteEditor.tsx:1704-1743`) for qty/price so a background refresh cannot clobber mid-keystroke edits (`InvoiceEditor.tsx:576`).
- `addLine` validates `manualQty`/`manualPrice` with the same guards before POST (`InvoiceEditor.tsx:104`).

- [ ] **Step 1: Failing tests** — qty blur with `abc` does not PATCH and shows inline error; qty blur with `-1` rejected; price `3.00` over `3` does not PATCH; while one line's PATCH is in flight, another line's input is not disabled; background `invoice` prop refresh while a field is edited does not overwrite the field's draft value.
- [ ] **Step 2: Verify fail (existing `InvoiceEditor.test.tsx` stays green throughout).**
- [ ] **Step 3: Implement (largest task in the plan — port, don't reinvent; same helper names as QuoteEditor for grep-ability).**
- [ ] **Step 4: Suite green + manual stack check: edit two lines rapidly, no global freeze; amber/green rings behave as on quotes.**
- [ ] **Step 5: Commit** — `fix(web): invoice editor gets quote-editor save grammar (scoped pending, validation, dirty rings, resync guard)`

### Task 7: Contract editor — blur-autosave, grouping, confirms, Pax8 dialog

**Files:**
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx` (+ its tests)
- Modify: `apps/web/src/components/contracts/ContractPax8Drawer.tsx:79-152` (rebuild on `shared/Dialog`)

**Interfaces:**
- Save model (user decision): **blur-autosave** for existing contracts — each header field PATCHes on blur via `runAction` with the quote editor's `fieldRing`/`SrSaved` grammar (port as in Task 6). The **create** flow (`/contracts/new`) keeps its explicit `Create contract` button (nothing exists to PATCH yet).
- Form grouping: split the flat ~12-field card (`ContractEditor.tsx:393-528`) into three fieldsets with `<legend>`-style section labels: **Schedule** (org, name, billing timing, cadence, custom interval, start), **Renewal** (end date, auto-issue, auto-renew + conditionals), **Content** (notes, terms). Pure layout regrouping — no field behavior changes beyond autosave.
- `intervalCustom` empty → inline error message ("Enter the number of {units}") instead of silently disabled save (`ContractEditor.tsx:451`).
- Line Remove gets `ConfirmDialog` (same copy pattern as `QuoteEditor.tsx:561-565`: name the line).
- Pax8 drawer: `shared/Dialog` provides role/aria-modal/focus trap; keep drawer styling via Dialog's className hooks; Escape and overlay-click behavior preserved.

- [ ] **Step 1: Failing tests** — blur on name field PATCHes contract with new name; invalid custom interval shows inline error text; Remove line opens confirm naming the line, cancel keeps it; Pax8 drawer root has `role="dialog"` and `aria-modal="true"`, focus lands inside on open.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: All contract tests green (`ContractEditor`, `ContractDetail.*`, `ContractWorkspace.permissions`, `ContractPax8Drawer`); manual: edit an active contract's name, amber→green ring; Tab stays inside Pax8 drawer.**
- [ ] **Step 5: Commit** — `feat(web): contract editor blur-autosave + grouped form + remove confirm; Pax8 drawer on shared Dialog`

### Task 8: Quote lifecycle strip + converted-invoice link (P1)

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteDetail.tsx:144-165` (+ test)
- Modify: `QuoteActions.tsx` (post-send success copy gains "what happens next")

**Interfaces:**
- Consumes: `quote.sentAt`, `viewedAt`, `acceptedAt`, `declinedAt`, `convertedInvoiceId` (`quoteTypes.ts:47-52`) — all already returned by the API (verify with a quick curl on the stack before coding; if absent from the list-serializer, they ARE on the detail response the component already holds).
- Produces: a compact lifecycle `<dl>` in the summary card: `Sent {formatDate} · Viewed {…} · Accepted {…}` (render only non-null stages; declined shows `Declined {…}` in danger text). When `convertedInvoiceId` is set: a link `View invoice →` to `/billing/invoices/{convertedInvoiceId}` (testid `quote-view-invoice`).
- Post-send toast/confirm copy: after successful send, the success toast reads `Proposal sent — we'll mark it Viewed and Accepted as {customer} opens and signs.`

- [ ] **Step 1: Failing tests** — accepted quote renders `Accepted` with formatted date; converted quote renders link with correct href; draft renders no lifecycle strip.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Green + manual check.**
- [ ] **Step 5: Commit** — `feat(web): quote lifecycle timestamps + converted-invoice link`

---

## Phase 3 — Polish sweep

### Task 9: A11y + feedback polish

**Files/changes (one PR, each item independently verifiable):**
- `QuoteEditor.tsx:1035-1041` — debounce the Live-totals `role="status"` sentence to commit-time (blur / 800ms trailing), not per keystroke.
- `QuotesPage.tsx:443-447`, `InvoicesPage.tsx:566-570` — drop the redundant `DRAFT` chip in the Number column (Status column already says Draft); show em-dash for missing number.
- Toast container placement — quote editor toasts overlap the Terms panel (browser finding): audit shared toast anchor; bottom-right is fine but must clear the right rail (`z` + offset), smallest fix wins.
- 403 → `AccessDenied` on quotes list and contracts list (port from `InvoicesPage.tsx:85-87,340-346`).
- `QuoteDocument.tsx:324-329`, `InvoiceDocument.tsx:228-233` — customer-facing fallback: replace `orgId.slice(0,8)` with `"—"` (never leak UUID fragments into "Prepared for").

- [ ] **Step 1-4: per item — failing test where testable (redundant chip absence, AccessDenied rendering, document fallback string), implement, green.**
- [ ] **Step 5: Commit** — `fix(web): billing a11y/feedback polish (SR debounce, 403 views, chip dedupe, safe doc fallbacks)`

### Task 10: Money honesty + branding + stat cards

**Files/changes (one PR):**
- Multi-currency summary strips (`QuotesPage.tsx:199-204`, `InvoicesPage.tsx:296-305`, `ContractsList.tsx:166-170`): when rows span >1 `currencyCode`, render per-currency totals (`$12,300 + €4,100`) instead of one mislabeled sum — small helper `sumByCurrency(rows): {code, cents}[]` in `shared/format.ts` with tests.
- `InvoiceDocument.tsx:55-57` — add the partner branding header the quote document already renders (`QuoteDocument.tsx` letterhead block + `useAuthedImage` loader); customers get consistent branded documents.
- Extract `StatCard` from Invoices' clickable stat-filter cards (`InvoicesPage.tsx` summary strip) into `shared/StatCard.tsx`; quotes + contracts adopt (quotes: Draft count → status filter; contracts: MRR stays static display).
- Quote editor line-grid width (browser finding): give the description/name input a sane `min-w` and let Recurrence shrink (`min-w-0` on the flex row) so the grid is usable at 1280px; Total column must be visible without horizontal scroll at ≥1280px viewport with the rail open.

- [ ] **Step 1-4: per item — `sumByCurrency` unit tests (mixed currencies → two entries, single → one), StatCard click test (fires filter callback), InvoiceDocument branding render test, implement, green; manual stack check at 1280px viewport.**
- [ ] **Step 5: Commit** — `feat(web): per-currency totals, branded invoice document, shared StatCard, editor grid width fixes`

---

## Self-review notes

- Spec coverage: every P0/P1/P2 from the critique maps to a task (P0→5; P1s→3,6,7,8; P2s→1,2,3,4,7,10); below-cut minors→9,10. Divergence-table rows all land in Phase 1 tasks except 403 (Task 9) and StatCard (Task 10).
- Type consistency: `StatusPillRole` union defined in Task 1 and consumed in Tasks 4 (header pill) and 1's contracts map; `usePdfDownload` signature consistent between Task 4 create and adoption sites; `runScoped`/`fieldRing`/`SrSaved` names reused verbatim from QuoteEditor in Tasks 6-7 for grep-ability.
- Deliberately out of scope (would need product decisions not yet made): undo system, keyboard shortcuts, pagination/virtualization, single-page invoice redesign (user chose tabs), quote acceptance-portal changes, PDF permission vocabulary unification (`quotes:read` vs `invoices:export` — flag for RBAC review, don't change).
