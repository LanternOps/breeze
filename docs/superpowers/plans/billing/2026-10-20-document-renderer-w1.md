---
spec: docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md
feature_plan: docs/superpowers/plans/billing/2026-10-20-document-renderer.md
tracking_issue: LanternOps/breeze#9402
---
# One Document Renderer — W1 Implementation Plan (invoice on screen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@breeze/document-ui` with its CSS and CI wiring (W1a), one server assembler and a staff `customer-view` route for invoices (W1b), and the invoice rendered by one composition on the web Preview, the portal public link and the logged-in portal (W1c). Three PRs.

**Architecture:** W1a adds the package and moves the portal's document CSS into it, with no behaviour change. W1b adds React-free DTO/model/builder/labels in `packages/shared/src/documents/` and `apps/api/src/services/customerDocument.ts`; the public and portal invoice routes and the new staff route return the assembler's output. W1c renders that output through `InvoiceDocumentView` on all three surfaces and deletes the old renderers, behind DOM parity tests against one committed snapshot set.

**Tech Stack:** Tailwind v4 (CSS-first), React 19, Astro islands, Hono, Drizzle, Vitest (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md`. File:line refs are against `origin/main` @ `f05560b9d0` (verified 2026-10-20; see the feature plan for the four corrected refs). Read the feature plan's Global Constraints, OD-9 section and Spec adjustments first; every task inherits them.

## Global Constraints (W1 subset, verbatim values)

- No migration, no schema change. Test API is the gate.
- Hidden lines (`customer_visible = false`) never reach a customer DTO in any mode. #8604 withholding runs only in `toCustomerInvoiceLine`.
- `@import '@breeze/document-ui/document.css';` above `@import 'tailwindcss'`, no `layer()`. `@source '../../../../packages/document-ui/src/**/*.{ts,tsx}';`.
- `--primary: var(--paper-primary, 225 62% 48%)` inside the paper block. Web light `:root` gains `--paper-primary: 225 62% 48%;` (its light `--primary`, `apps/web/src/styles/globals.css:34262`).
- Density exclusion suffix: `:not([data-document-root], [data-document-root] *)`.
- The package writes no `style` attribute and imports nothing from `apps/*`, no i18next.
- `OD9_CUSTOMER_PROJECTION.screen = { ticketSubject: false, bundleNesting: false }`, `.pdf = { ticketSubject: true, bundleNesting: false }`.
- 8 web locales: `de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`.
- Scoped tests: `cd <pkg dir> && npx vitest run <path>`. Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`.
- Fixtures use invented names only (`Example MSP`, `Acme Dental`, `INV-0042`).

## Review Focus

Each line names the input, the expected behaviour and the task that pins it:

1. **Web `data-density='dense'` around the Preview** → the paper keeps its padding. Task 3 (`densityIsolation.test.ts`, both modes, root and descendant) + Task 18 (dense screenshot equals comfortable).
2. **Draft invoice, NULL line-detail columns, partner `invoiceLineShowNote = false`** → the staff DTO withholds the time-entry note (labor label as title, empty blurb). Task 10.
3. **Void invoice in each mode** → public route returns its no-amounts payload without calling the assembler; portal and staff DTOs carry `displayStatus: 'void'` and the lines. Task 10 (assembler) + Task 11 (public route spy).
4. **Issued invoice, `lineShowNote = false`, time-entry line whose description is the tech's note** → the note string is absent from the `customer-view` JSON. Task 12.
5. **CHF invoice (prefix-code currency) and `₹` (WinAnsi-unsafe)** → `DocumentMoney.text` uses the document locale's form; `amount` and `currency` are raw so the PDF can re-format (W3). Task 7 (`documentMoney` tests) + Task 13 fixture `invoice-chf`.

## Model routing

- **W1a (Tasks 1–6): sonnet.** Mechanical; each step has a test.
- **W1b (Tasks 7–12): opus** implementer and reviewer. Tasks 7–8 (pure types/builder) may be typed by sonnet from this plan; Tasks 9–12 (characterization pins, assembler, routes, auth) stay opus.
- **W1c (Tasks 13–18): sonnet.**

---

# W1a — Package scaffold, CSS, CI (PR 1)

Branch `feature/9402-document-renderer/wave-<W1 sub-issue#>-w1a` from `origin/main`. PR title `feat(document-ui): package scaffold, document.css and CI job (#9402 W1a)`. Body `Part of #<W1 sub-issue>`, states "no behaviour change" and the `release-build-check.yml` run id.

### Task 1: Package scaffold, `DocumentPaper`, no-style-attribute test

**Files:**
- Create: `packages/document-ui/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/tokens.ts`, `src/DocumentPaper.tsx`, `src/__tests__/setup.ts`, `src/__tests__/noStyleAttribute.test.tsx`, `src/__tests__/documentPaper.test.tsx`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Produces: `DocumentPaper({ theme, testId, children }: { theme: DocumentThemeId; testId?: string; children: ReactNode }): JSX.Element` — root `<article data-document-root data-doc-theme={theme} data-testid={testId ?? 'document-root'} className="doc-paper …">` with the accent bar `<div className="doc-accent-bg h-1.5" aria-hidden />` first. `DocumentThemeId` from `@breeze/shared` (`packages/shared/src/types/publicQuote.ts:61`).
- Produces: `DOCUMENT_HOST_TOKENS: readonly string[]` in `src/tokens.ts` — every CSS custom property the package and `document.css` read that the host must define: `paper-primary`, `primary-foreground`, `background`, `foreground`, `muted`, `muted-foreground`, `border`, `card`, `card-foreground`, `font-display` (extend with any `var(--x)` the paper block reads that it does not itself set; Task 2's test enforces the list is complete).
- Produces: `PACKAGE_PROBE_CLASS = 'sm:px-[3.25rem]'` exported from `DocumentPaper.tsx` and used on its root (the built-CSS tests in Task 4 look for it).

- [ ] **Step 1: Write the failing tests**

`noStyleAttribute.test.tsx`: a `renderAll()` helper renders every exported component with every fixture (for now: `DocumentPaper` with `theme` `classic` and `condensed`), then `expect(container.querySelectorAll('[style]')).toHaveLength(0)`. W1c extends `renderAll()`.

`documentPaper.test.tsx`:
```ts
it('stamps the root attributes the CSS and parity tests key on', () => {
  const { container } = render(<DocumentPaper theme="condensed">x</DocumentPaper>);
  const root = container.firstElementChild!;
  expect(root.hasAttribute('data-document-root')).toBe(true);
  expect(root.getAttribute('data-doc-theme')).toBe('condensed');
  expect(root.getAttribute('data-testid')).toBe('document-root');
  expect(root.className).toContain(PACKAGE_PROBE_CLASS);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd packages/document-ui && npx vitest run`
Expected: FAIL (module `../DocumentPaper` not found).

- [ ] **Step 3: Implement**

`package.json`: name `@breeze/document-ui`, `private`, `type: module`, `main`/`types` `./src/index.ts`, `exports: { ".": "./src/index.ts", "./document.css": "./src/document.css" }`, scripts `{ "test": "vitest", "typecheck": "tsc --noEmit" }`, `dependencies: { "@breeze/shared": "workspace:*", "lucide-react": <web's version> }`, `peerDependencies: { react: "^19.2.7", "react-dom": "^19.2.7" }`, devDependencies = `office-addin-core`'s minus `@types/office-js`. `tsconfig.json` = `office-addin-core`'s with `types: ["vitest/globals", "vite/client"]`. `vitest.config.ts` = `office-addin-core`'s. `src/document.css` can be an empty file for now (Task 2 fills it). `src/index.ts` exports `DocumentPaper`, `PACKAGE_PROBE_CLASS`, `DOCUMENT_HOST_TOKENS`. Run `pnpm install` at the repo root.

- [ ] **Step 4: Run to verify it passes, then typecheck**

Run: `cd packages/document-ui && npx vitest run` → PASS (2 files).
Run: `cd packages/document-ui && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` → `exit=0`.

- [ ] **Step 5: Commit** — `feat(document-ui): scaffold @breeze/document-ui with DocumentPaper (#9402)`

### Task 2: `document.css` takes the portal's document rules

**Files:**
- Modify: `packages/document-ui/src/document.css`, `apps/portal/src/styles/globals.css` (delete `:527-533` condensed, `:539-547` `.doc-accent-*`, `:552-554` `.signature-preview`, `:556-593` paper block), `apps/portal/src/components/portal/documentShell.tsx` (`DocumentPaper` root gains `data-document-root`), `apps/portal/src/styles/paperTokens.test.ts`, `apps/portal/src/lib/noInlineStyles.test.ts` (doc comment only: `globals.css` → `@breeze/document-ui/document.css`)
- Create: `packages/document-ui/src/__tests__/paperTokens.test.ts`

**Interfaces:**
- Produces: `document.css` selectors `[data-document-root]` (paper tokens + `--primary: var(--paper-primary, 225 62% 48%)`), `[data-document-root][data-doc-theme='condensed']` (condensed rules), `.doc-accent-bg`, `.doc-accent-text`, `.doc-accent-border`, `.signature-preview`, `.doc-paper`. Font `@import`s the condensed theme needs go at the top of `document.css`.

- [ ] **Step 1: Write the failing tests**

Package `paperTokens.test.ts` reads `../document.css` with `readFileSync` and asserts:
```ts
it('the paper paints its accent from the host light primary, with a literal fallback', () => {
  for (const t of ['primary', 'primary-on-tint', 'ring']) expect(PAPER.get(t), t).toBe('var(--paper-primary, 225 62% 48%)');
});
it('every other paper token is a literal HSL triplet', () => {
  for (const [t, v] of PAPER) if (!['primary', 'primary-on-tint', 'ring'].includes(t)) expect(v, t).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
});
it('every var() the paper block reads but does not set is a DOCUMENT_HOST_TOKENS entry', () => { /* parse var(--x) in document.css minus PAPER keys ⊆ DOCUMENT_HOST_TOKENS */ });
it('condensed rules are scoped under [data-document-root]', () => {
  expect(CSS).toMatch(/\[data-document-root\]\[data-doc-theme='condensed'\]/);
  expect(CSS).not.toMatch(/(^|\n)\[data-doc-theme/);
});
```
Portal `paperTokens.test.ts`: change `PAPER` to read the block from `createRequire(import.meta.url).resolve('@breeze/document-ui/document.css')` with selector `/\n\[data-document-root\]/`; the `primary`/`primary-on-tint`/`ring` expectation becomes `'var(--paper-primary, 225 62% 48%)'`; every other assertion (light values, seven chrome accents) is unchanged.

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/document-ui && npx vitest run src/__tests__/paperTokens.test.ts` → FAIL (block not found).
Run: `cd apps/portal && npx vitest run src/styles/paperTokens.test.ts` → FAIL (block not found in document.css).

- [ ] **Step 3: Move the rules**

Cut the four portal blocks into `document.css`, re-keying `[data-doc-theme]` → `[data-document-root]` and `[data-doc-theme='condensed'] …` → `[data-document-root][data-doc-theme='condensed'] …`. Add `data-document-root` to the portal `DocumentPaper` root element in `documentShell.tsx` (the portal's quote and invoice pages render through it, so the moved rules keep matching). Do not wire the import yet (Task 3) — the portal is unstyled between Steps 3 and Task 3; commit both tasks before pushing.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/document-ui && npx vitest run` → PASS. Run: `cd apps/portal && npx vitest run src/styles/paperTokens.test.ts src/lib/noInlineStyles.test.ts` → PASS.

- [ ] **Step 5: Commit** — `refactor(document-ui): move the portal's document paper rules into document.css (#9402)`

### Task 3: Wire both apps; web `--paper-primary`; density isolation; token presence

**Files:**
- Modify: `apps/portal/src/styles/globals.css` (header comment `:5-7`; import above `:26`; `@source`), `apps/web/src/styles/globals.css` (header comment `:7-14`; import above `:35`; `@source`; `--paper-primary` in light `:root` beside `:34262`; every `[data-density='compact'] main …` rule from `:34539` and `[data-density='dense'] main …` rule from `:34595` gains the exclusion), `apps/web/package.json` and `apps/portal/package.json` (`"@breeze/document-ui": "workspace:*"`)
- Create: `apps/web/src/styles/densityIsolation.test.ts`, `apps/web/src/styles/tokenPresence.test.ts`, `apps/portal/src/styles/tokenPresence.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_HOST_TOKENS` (Task 1).

- [ ] **Step 1: Write the failing tests**

`densityIsolation.test.ts` parses `globals.css` into rules (a small regex rule splitter is enough; the file has no nested `{` inside density rules) and for every selector containing `[data-density=`:
```ts
it.each(['compact', 'dense'])('%s: no density rule can match the document root or anything inside it', (mode) => {
  const offenders = densitySelectors(mode).filter((s) => !s.includes(':not([data-document-root], [data-document-root] *)'));
  expect(offenders).toEqual([]);
});
it('finds the density rules it guards', () => { expect(densitySelectors('compact').length).toBeGreaterThan(10); expect(densitySelectors('dense').length).toBeGreaterThan(10); });
```
Then a jsdom check: build `<div data-density="dense"><main><article data-document-root class="p-8"><p class="p-8"></p></article></main></div>`, and for each offender-free selector assert `!el.matches(selector)` for both the article and the `<p>` (`Element.matches` accepts the selector list).

`tokenPresence.test.ts` (each app): parse that app's `globals.css` light `:root` (and, for the portal, every `:root[data-accent=…]` light block) and assert every `DOCUMENT_HOST_TOKENS` entry is declared. Also assert the `@import '@breeze/document-ui/document.css'` line appears before `@import 'tailwindcss'` and that the four-level `@source` line is present verbatim.

- [ ] **Step 2: Run to see them fail**

Run: `cd apps/web && npx vitest run src/styles/densityIsolation.test.ts src/styles/tokenPresence.test.ts` → FAIL (offenders listed; `paper-primary` missing; import missing).
Run: `cd apps/portal && npx vitest run src/styles/tokenPresence.test.ts` → FAIL (import missing).

- [ ] **Step 3: Implement** — add the dependency, the import (beside the fontsource imports, above `tailwindcss`), the `@source`, `--paper-primary`, and the `:not(…)` on each density selector (append to the selector's last compound before any pseudo-element). Extend each header comment with one line: "`@breeze/document-ui/document.css` is imported here, above tailwindcss, for the same reason."

- [ ] **Step 4: Run to verify they pass** (same commands) → PASS. Then `cd apps/web && npx vitest run src/styles` and `cd apps/portal && npx vitest run src/styles src/lib/noInlineStyles.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(web,portal): import document.css; isolate the document from web density rules (#9402)`

### Task 4: Built-CSS tests

**Files:**
- Create: `apps/web/src/styles/documentCss.build.test.ts`, `apps/portal/src/styles/documentCss.build.test.ts`
- Modify: `apps/web/package.json`, `apps/portal/package.json` (devDependency `@tailwindcss/node` at the version `@tailwindcss/vite` resolves to, and `@tailwindcss/oxide` if `compile` needs the scanner separately)

**Interfaces:**
- Consumes: `PACKAGE_PROBE_CLASS` (Task 1).

- [ ] **Step 1: Write the failing test** (same file shape in both apps)

```ts
it('the built stylesheet carries document.css and package-only utilities', async () => {
  const css = await buildAppCss(); // compile globals.css with @tailwindcss/node + scan @source globs, as @tailwindcss/vite does
  expect(css).toContain('[data-document-root]');
  expect(css).toContain('.doc-accent-bg');
  expect(css).toMatch(/sm\\:px-\\\[3\\.25rem\\\]/); // PACKAGE_PROBE_CLASS, escaped as Tailwind emits it
});
it('the probe class is package-only (otherwise the @source assertion proves nothing)', () => {
  expect(rgAppSources(PACKAGE_PROBE_CLASS)).toEqual([]); // walk apps/<app>/src for the literal
});
```

- [ ] **Step 2: Run to see it fail** — temporarily comment out the `@source` line in that app's `globals.css`, run `cd apps/web && npx vitest run src/styles/documentCss.build.test.ts` → FAIL on the probe; restore it. (This is the control proving the test can see a wrong `@source`.)

- [ ] **Step 3: Implement `buildAppCss()`** with `compile()` from `@tailwindcss/node` (`base` = the styles dir, `onDependency` no-op) and a `Scanner` over the compiler's `sources`/`@source` globs; feed candidates to `compiler.build(candidates)`. If the pinned version's API cannot do this in-process, fall back to a `build-web`/`build-portal` CI step that greps the emitted CSS for the same three strings, and say so in the PR body.

- [ ] **Step 4: Run to verify it passes** in both apps → PASS.

- [ ] **Step 5: Commit** — `test(web,portal): built CSS includes document.css and package utilities (#9402)`

### Task 5: `test-document-ui` CI job wired into `ci-success`

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/scripts/ci-area-gating.test.mjs`

- [ ] **Step 1: Write the failing assertions** in `ci-area-gating.test.mjs`, beside the `test-shared` block (`:357-366`):

```js
test('test-document-ui runs the package suite and typecheck, gated on code AND app (#9402)', () => {
  assert.match(job('test-document-ui'), new RegExp(`^    if: ${escape(APP_IF)}$`, 'mu'));
  assert.match(job('test-document-ui'), /^        run: pnpm --filter @breeze\/document-ui exec vitest run$/mu);
  assert.match(job('test-document-ui'), /^        run: pnpm --filter=@breeze\/document-ui typecheck$/mu);
});
test('ci-success needs test-document-ui and asserts it in both branches (#9402)', () => {
  assert.match(workflow, /^  ci-success:\n(?:.*\n)*?    needs: \[[^\]]*\btest-document-ui\b[^\]]*\]/mu);
  assert.match(summary, /^          TEST_DOCUMENT_UI_RESULT: \$\{\{ needs\.test-document-ui\.result \}\}$/mu);
  assert.match(summary, /\[\[ "\$\{TEST_DOCUMENT_UI_RESULT\}" != "success" \]\]/u);
  assert.match(summary, /\[\[ "\$\{TEST_DOCUMENT_UI_RESULT\}" != "skipped" \]\]/u);
});
```
Add `'test-document-ui'` to the never-area-gated list (`:369-370`).

- [ ] **Step 2: Run to see it fail**

Run: `node --test .github/scripts/ci-area-gating.test.mjs` → FAIL (job not found).

- [ ] **Step 3: Implement** — copy `test-office-addin-core` (`ci.yml:1140-1168`) to a `test-document-ui` job after it: `name: Test Document UI`, `if:` = `test-shared`'s (`:1116`), steps ending `run: pnpm --filter @breeze/document-ui exec vitest run` and `run: pnpm --filter=@breeze/document-ui typecheck`. Add `test-document-ui` to `ci-success.needs` (`:4543`), `TEST_DOCUMENT_UI_RESULT: ${{ needs.test-document-ui.result }}` after `TEST_SHARED_RESULT` (`:4576`), `[[ "${TEST_DOCUMENT_UI_RESULT}" != "success" ]] || \` after `:4660`, and `[[ "${TEST_DOCUMENT_UI_RESULT}" != "skipped" ]] || \` after `:4734`.

- [ ] **Step 4: Run to verify it passes** — `node --test .github/scripts/ci-area-gating.test.mjs` → PASS. Also run `node --test .github/scripts/*.test.mjs` → PASS (the classifier tests are siblings).

- [ ] **Step 5: Commit** — `ci: run @breeze/document-ui tests and typecheck, required by ci-success (#9402)`

### Task 6: Docker manifest lines

**Files:**
- Modify: `apps/web/Dockerfile` (after `:28-29`), `apps/portal/Dockerfile` (after `:25`), `docker/Dockerfile.web` (after `:9-10`; and `COPY --from=deps /app/packages/document-ui/node_modules ./packages/document-ui/node_modules` beside `:15-18`), `docker/Dockerfile.web.dev` (after `:17`), `docker/Dockerfile.portal.dev` (after `:13`)

- [ ] **Step 1: Write the failing check** — there is no unit test for Dockerfiles; the red is a real build. Run: `docker build -f apps/portal/Dockerfile .` → FAIL at `pnpm install --frozen-lockfile` (the lockfile names `packages/document-ui`, whose manifest is absent). Record the error line.

- [ ] **Step 2: Add** `COPY packages/document-ui/package.json ./packages/document-ui/` to all five files.

- [ ] **Step 3: Verify** — `docker build -f apps/portal/Dockerfile .` and `docker build -f docker/Dockerfile.web .` → succeed. After pushing, `gh workflow run release-build-check.yml --ref <branch>` (builds `apps/web/Dockerfile`); record the run id. CI's `build-smoke-images` builds the other two.

- [ ] **Step 4: Commit** — `build: copy the document-ui manifest into every web/portal image (#9402)`

**W1a exit:** `cd packages/document-ui && npx vitest run`; `cd apps/web && npx vitest run src/styles src/lib/i18n`; `cd apps/portal && npx vitest run src/styles src/lib`; typecheck exit 0 in `packages/document-ui`, `apps/web`, `apps/portal`; `node --test .github/scripts/ci-area-gating.test.mjs`; a manual look at one portal invoice and one portal quote on a wt-stack shows no visual change (or skip and say so).

---

# W1b — Invoice assembler and customer-view route (PR 2)

Branch `feature/9402-document-renderer/wave-<W1 sub-issue#>-w1b` from `origin/main` (independent of W1a). PR title `feat(billing): one customer-document assembler for invoices + staff customer-view route (#9402 W1b)`. Body `Part of #<W1 sub-issue>`; states "no `mcpCoverage.ts` entry changes (coverage is keyed by route file and `invoices/invoices.ts` is covered at `:510`)", "customer-view is a GET: no `runActionAllowlist.ts` change", and lists the additive response keys.

### Task 7: Shared document types, money, dates, English labels

**Files:**
- Create: `packages/shared/src/documents/model.ts`, `dto.ts`, `money.ts`, `dates.ts`, `labels/types.ts`, `labels/en.ts`, `labels/index.ts`, `index.ts`, `money.test.ts`, `dates.test.ts`, `labels/labels.test.ts`
- Modify: `packages/shared/package.json` (`exports["./documents"] = "./src/documents/index.ts"`)

**Interfaces (produces):**
- `model.ts`: spec §3.2's `SanitizedHtml`, `DocumentAssetRef`, `DocumentMoney`, `DocumentDate`, `DocumentBranding`, `DocumentHeaderModel`, `DocumentLineRow<Tax>`, `DocumentGroupHeader`, `DocumentLineGroup<Tax>`, `DocumentLineTableModel`, `DocumentTotalsRow`, `DocumentTotalsModel`, `InvoiceDocumentModel` — verbatim, with one addition: `LineTableBase` gains `notTaxableText: string` (the screen-reader text for an `'exempt'` tax cell; components hold no strings, so it rides in the model). Re-use `DocumentThemeId`/`DocumentPageSize` from `../types/publicQuote`. (Quote types are W2a's `quoteModel.ts`.)
- `dto.ts`:
```ts
export type CustomerDocumentMode = 'public' | 'portal' | 'staff';
export interface CustomerInvoiceLineDto {
  id: string; ticketNumber: string | null; ticketCategory: string | null;
  name: string | null; description: string; quantity: string; unitPrice: string;
  taxable: boolean; lineTotal: string; workedMinutes: number | null; workDate: string | null;
  ticketSubject?: string | null; isChild?: boolean;   // present only when OD9_CUSTOMER_PROJECTION enables them
}
export interface CustomerInvoiceHeaderDto {
  id: string; invoiceNumber: string | null; status: InvoiceStatus; displayStatus: InvoiceStatus | null;
  currencyCode: string; issueDate: string | null; dueDate: string | null;
  subtotal: string; taxRate: string | null; taxTotal: string; total: string;
  amountPaid: string; balance: string; depositDue: string | null;
  billToName: string | null; notes: string | null; sellerSnapshot: SellerSnapshot | null;
  termsAndConditions: string | null; lineGrouping: 'entry' | 'day';
}
export interface CustomerDocumentBrandingDto {
  partnerName: string | null; contactEmail: string | null; logoUrl: string | null;
  primaryColor: string | null; theme: DocumentThemeId; pageSize: DocumentPageSize;
}
export interface CustomerInvoiceDocument {
  invoice: CustomerInvoiceHeaderDto; lines: CustomerInvoiceLineDto[];
  branding: CustomerDocumentBrandingDto; documentLocale: string;
}
```
  (`InvoiceStatus` from `packages/shared/src/types/billing-enums.ts:23`. There is no shared `SellerSnapshot`: the API (`apps/api/src/services/sellerSnapshot.ts`) and the portal (`apps/portal/src/lib/api.ts:484`) each declare one. Add `DocumentSellerSnapshot` to `dto.ts`, structurally equal to the API's, and add a type-level assertion in Task 10 that the API's type is assignable to it.)
- `money.ts`: `documentMoney(amount: string | number, currency: string, locale: string, suffix?: { text: string; srText: string } | null): DocumentMoney` — `text` via the shared `formatMoney(value, currency, locale)` (`packages/shared/src/utils/currency.ts:194`), `amount` = the input as a decimal string, unchanged.
- `dates.ts`: `documentDate(iso: string, locale: string): DocumentDate` — `YYYY-MM-DD` is formatted as a UTC calendar date (`{ year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }`), `iso` unchanged.
- `labels/types.ts`: `interface DocumentLabels` — every invoice string the document prints: `invoiceEyebrow`, `draftNumber`, `issued`, `due`, `billTo`, `notes`, `terms`, `termsFull`, `columns: { description, qty, unitPrice, tax, amount }`, `empty`, `laborLine`, `ticketHeader(n: string): string`, `ticketTitle(n: string, subject: string): string`, `workedVsBilled(worked: string, billed: string): string`, `notTaxable`, `totals: { subtotal, tax(pct: string | null): string, total, paid, balance, balanceDue }`, `deposit: { due(deposit: string, paid: string, total: string): (string | { strong: string })[]; paid(remaining: string): (string | { strong: string })[] }` (returns `DocumentTotalsModel.depositStrip.parts`), `status: Record<InvoiceStatus, string>`, `perMonth`/`perYear` `{ text, srText }` (OD-11, used by W2).
- `labels/en.ts`: `DOCUMENT_LABELS_EN` — copy the portal's English verbatim (`invoicePaper.tsx` "Description", "Qty", "Price", "Tax", "Amount", "Subtotal", "Total", "Paid", "Balance", "Balance due", the deposit sentences; `lib/invoiceStatus.ts` `STATUS_LABELS`; `lineWorkedVsBilledNote`'s `"<w> h worked · <b> h billed"`; "Ticket #N").
- `labels/index.ts`: `documentLabelsFor(locale: string): DocumentLabels` → `DOCUMENT_LABELS_EN` for every locale in W1 (W3a adds pt-BR).

- [ ] **Step 1: Write the failing tests**

```ts
// money.test.ts
it('formats in the document locale and keeps the raw amount for the PDF', () => {
  const m = documentMoney('1234.5', 'CHF', 'de-CH');
  expect(m).toEqual({ text: formatMoney('1234.5', 'CHF', 'de-CH'), amount: '1234.5', currency: 'CHF', suffix: null });
});
it('INR keeps its symbol on screen; amount stays raw for the glyph-safe PDF path', () => {
  expect(documentMoney('99', 'INR', 'en-IN').text).toContain('₹');
  expect(documentMoney('99', 'INR', 'en-IN').amount).toBe('99');
});
// dates.test.ts
it('a calendar date never shifts by timezone', () => {
  expect(documentDate('2026-03-01', 'en')).toEqual({ text: 'Mar 01, 2026', iso: '2026-03-01' });
  expect(documentDate('2026-03-01', 'pt-BR').text).toBe(new Intl.DateTimeFormat('pt-BR', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }).format(new Date('2026-03-01T00:00:00Z')));
});
// labels.test.ts
it('every locale falls back to English in W1', () => { expect(documentLabelsFor('fr-FR')).toBe(DOCUMENT_LABELS_EN); });
it('English matches the strings the portal prints today', () => {
  expect(DOCUMENT_LABELS_EN.totals.balanceDue).toBe('Balance due');
  expect(DOCUMENT_LABELS_EN.workedVsBilled('1.5', '2')).toBe('1.5 h worked · 2 h billed');
  expect(DOCUMENT_LABELS_EN.ticketHeader('42')).toBe('Ticket #42');
});
```

- [ ] **Step 2: Run to see them fail** — `cd packages/shared && npx vitest run src/documents` → FAIL (modules missing).
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Verify** — `cd packages/shared && npx vitest run src/documents` → PASS; `cd packages/shared && npx vitest run src/browserSafeBarrel.test.ts` → PASS; typecheck `packages/shared` exit 0.
- [ ] **Step 5: Commit** — `feat(shared): document view-model types, money/date formatting and English labels (#9402)`

### Task 8: `buildInvoiceDocumentModel` and DTO fixtures

**Files:**
- Create: `packages/shared/src/documents/invoiceBuilder.ts`, `invoiceBuilder.test.ts`, `fixtures/invoiceDtos.ts`
- Modify: `packages/shared/src/documents/index.ts`

**Interfaces:**
- Consumes: Task 7 types; `groupLinesByDay` (`:159`), `lineWorkedVsBilled` (`:94`) from `packages/shared/src/utils/invoiceLineDetail.ts` (dates go through Task 7's `documentDate`, not `formatWorkDate`); `computeChargeNow` (`packages/shared/src/utils/depositMath.ts:20`).
- Produces: `buildInvoiceDocumentModel(dto: CustomerInvoiceDocument, labels: DocumentLabels): InvoiceDocumentModel`; `INVOICE_DTO_FIXTURES: Record<InvoiceFixtureName, CustomerInvoiceDocument>` with `InvoiceFixtureName = 'issued' | 'draft' | 'taxed' | 'untaxed' | 'deposit' | 'paid' | 'dayGrouping' | 'withheldNote' | 'chf' | 'inr' | 'empty' | 'void' | 'multilineBlurb' | 'condensed'`.

Rules the builder owns (portal semantics win: the customer is the reader):
- Groups by `ticketNumber` in first-seen order (the portal's `groupInvoiceLinesByTicket`); a group's header is `{ kind: 'ticket', title: labels.ticketHeader(n), category }`, or `labels.ticketTitle(n, subject)` when the line carries `ticketSubject`; lines without a ticket form a group with `header: null`.
- `lineGrouping === 'day'` → `days` via `groupLinesByDay` with `{ date, hours, total }`; else one day bucket with `header: null`.
- Row: `key = line.id`; `title = (name ?? description).trim() || '—'`; `blurb = name ? description.trim() || null : null`; `workDate` only when grouping is `entry`; `note = labels.workedVsBilled(...)` from `workedMinutes` vs `quantity` (null when equal or absent); `isChild = line.isChild === true`; `ticketText = null`; `descriptor = []`; `thumbnail = null`.
- Tax column iff `Number(taxTotal) > 0`; per-row tax = the portal's `lineTax` rule (`taxable && rate > 0` → `round(cents × rate)/100`, else `'exempt'`).
- Totals rows: Subtotal; Tax (pct = `taxRate × 100` to 3 dp, or no pct) — always; Total (`ruleAbove: 'neutral'`); Paid with `sign: 'minus'` only when `amountPaid > 0`; hero row `paid ? labels.totals.balance : labels.totals.balanceDue` with `ruleAbove: 'accent'`, `weight: 'hero'`. `depositStrip` when `depositDue > 0` and status ≠ `paid`, using `computeChargeNow`.
- Header: `eyebrow = labels.invoiceEyebrow`; `number = invoiceNumber ?? labels.draftNumber`; `status` from `displayStatus` (null → no pill) with tone map `sent→info`, `partially_paid→warning`, `overdue→danger`, `paid→success`, `draft|void→neutral`; dates Issued/Due when present; `billTo` null when `billToName` is blank.
- `branding.wordmark = partnerName ?? seller?.name ?? null`; `logo = logoUrl ? { kind: 'url', url } : null`.
- `notes`, `terms.full` (`termsAndConditions`), `footer = null`.
- Throws `DocumentModelError` if any row title is empty after the fallback (cannot happen; the assertion guards future edits).

- [ ] **Step 1: Write the failing tests** — one `it` per fixture asserting the decisive fields, plus:
```ts
it('a multi-line blurb keeps its newlines in the model', () => {
  const m = build('multilineBlurb'); expect(firstRow(m).blurb).toBe('Line one\nLine two');
});
it('the tax column and row types agree', () => {
  expect(build('untaxed').lines.columns.tax).toBeNull();
  expect(allRows(build('untaxed')).every(r => r.tax === null)).toBe(true);
  expect(typeof build('taxed').lines.columns.tax).toBe('string');
});
it('withheld note: labor label as title, no blurb, no note', () => {
  const r = firstRow(build('withheldNote')); expect(r.title).toBe('Labor'); expect(r.blurb).toBeNull(); expect(r.note).toBeNull();
});
it('no subject and flat children while the DTO omits them (OD-9 pending)', () => {
  const m = build('taxed'); expect(m.lines.groups[0].header).toEqual({ kind: 'ticket', title: 'Ticket #42', category: 'Support' });
  expect(allRows(m).some(r => r.isChild)).toBe(false);
});
it('subject and nesting render when the projection carries them', () => {
  const dto = withLines(fx.taxed, l => ({ ...l, ticketSubject: 'Printer offline', isChild: true }));
  expect(buildInvoiceDocumentModel(dto, EN).lines.groups[0].header).toMatchObject({ title: 'Ticket #42: Printer offline' });
});
it('the same DTO always yields the same model', () => { expect(build('deposit')).toEqual(build('deposit')); });
it('paid: Balance, no deposit strip; unpaid deposit: strip present', () => { /* … */ });
it('draft has no status pill and the draft number label', () => { /* displayStatus null */ });
```
- [ ] **Step 2: Run** — `cd packages/shared && npx vitest run src/documents/invoiceBuilder.test.ts` → FAIL.
- [ ] **Step 3: Implement** the builder and fixtures. Fixture data: invented names, ids `00000000-0000-4000-8000-0000000000NN`.
- [ ] **Step 4: Verify** → PASS; typecheck exit 0.
- [ ] **Step 5: Commit** — `feat(shared): build the invoice document model from the customer DTO (#9402)`

### Task 9: Characterization pins for today's public and portal invoice responses

This task inverts red-first deliberately: it records today's behaviour on unmodified routes, so Task 11 can prove it only adds keys.

**Files:**
- Create: `apps/api/src/routes/invoicesPublic.customerDocumentPin.test.ts`, `apps/api/src/routes/portal/invoices.customerDocumentPin.test.ts`, `apps/api/src/routes/__fixtures__/customerInvoicePin.ts` (one issued invoice row, partner, portal_branding, three lines: a taxable ticket line, a time-entry line with `workedMinutes`, and a `customerVisible = false` line)

- [ ] **Step 1: Write the tests with placeholder pins** using the Drizzle-mock idiom of the existing `invoicesPublic.test.ts` / `portal/invoices.test.ts` (mock `../db` selects in call order; real `toCustomerInvoiceLine`). Each test does `const body = await res.json(); expect(body).toEqual(PIN)` with `PIN = 'REPLACE_ME'`, and separately asserts the hidden line's description is absent from `JSON.stringify(body)`.
- [ ] **Step 2: Run to harvest** — `cd apps/api && npx vitest run src/routes/invoicesPublic.customerDocumentPin.test.ts src/routes/portal/invoices.customerDocumentPin.test.ts` → FAIL; the diff prints the actual JSON.
- [ ] **Step 3: Pin** the harvested JSON as `PIN` constants with `// Recorded at origin/main f05560b9d0 before customerDocument.ts existed. Task 11 may only ADD the declared keys.`
- [ ] **Step 4: Verify** → PASS (4 tests).
- [ ] **Step 5: Commit** — `test(billing): pin today's public and portal invoice payloads (#9402)`

### Task 10: `customerDocument.ts` — loader, assembler, modes, OD-9 switch

**Files:**
- Create: `apps/api/src/services/customerDocument.ts`, `apps/api/src/services/customerDocument.test.ts`
- Modify: `apps/api/src/services/invoiceService.ts` (export `resolveDocumentLineDetail` at `:967`; `toCustomerInvoiceLine` (`:1055`) gains `id` and the optional OD-9 fields from its source; delete `projectCustomerInvoiceLine` (`:1086`); `CustomerInvoiceLine` becomes an alias of `CustomerInvoiceLineDto`; `getCustomerInvoice` (`:1125`) becomes org guard + `assembleCustomerInvoiceDocument(inv, 'portal')`, returning `{ invoice, lines, partnerId }` as today)

**Interfaces (produces):**
```ts
export { type CustomerDocumentMode } from '@breeze/shared/documents';
export const OD9_CUSTOMER_PROJECTION = { screen: { ticketSubject: false, bundleNesting: false }, pdf: { ticketSubject: true, bundleNesting: false } } as const;
export class CustomerDocumentModeError extends Error {}           // programming error, never an HTTP response
export async function loadCustomerInvoiceLines(invoice: InvoiceRow, opts: { detail: InvoiceLineDetail; surface: 'screen' | 'pdf' }): Promise<CustomerInvoiceLineDto[]>;
export async function loadCustomerDocumentBranding(invoice: InvoiceRow): Promise<CustomerDocumentBrandingDto>;
export function invoiceDisplayStatus(status: InvoiceStatus): InvoiceStatus | null;   // draft → null, else status
export async function assembleCustomerInvoiceDocument(invoice: InvoiceRow, mode: CustomerDocumentMode, opts?: { surface?: 'screen' | 'pdf' }): Promise<CustomerInvoiceDocument>;
```
- `loadCustomerInvoiceLines`: one query = the union of today's two (`getCustomerInvoice` `:1132-1155` and `invoicesPublic.ts:136-156`): `invoiceLines.invoiceId = id AND invoiceLines.orgId = invoice.orgId AND customerVisible = true`, tickets left-joined on `tickets.orgId = invoice.orgId AND deletedAt IS NULL`, ordered by `sortOrder`; selects `id` and `parentLineId` too. Maps through `toCustomerInvoiceLine(row, detail, invoice.documentLocale ?? 'en')`, then adds `ticketSubject` / `isChild` only when `OD9_CUSTOMER_PROJECTION[surface]` enables them.
- `assembleCustomerInvoiceDocument`: `mode !== 'staff' && invoice.status === 'draft'` → throw `CustomerDocumentModeError`. `detail = mode === 'staff' && invoice.status === 'draft' ? await resolveDocumentLineDetail(invoice) : customerLineDetail(invoice)` (resolved **before** projection). Header = `toCustomerInvoiceHeader(invoice)` + `displayStatus`. `documentLocale = invoice.documentLocale ?? resolvePartnerDocumentLocale(partner) ?? 'en'` (`quoteBranding.ts:155` uses the same resolver).
- `loadCustomerDocumentBranding`: today's public `brandingBlock` fields (`invoicesPublic.ts:197-212`), with `partnerName` **nullable** (the public route keeps its `?? 'Invoice'` at the envelope). Partner-axis reads go through `runOutsideDbContext(() => withSystemDbAccessContext(…))` keyed on `invoice.partnerId` (precedent `routes/portal/invoices.ts` branding read); `portal_branding` reads under the caller's context.

- [ ] **Step 1: Write the failing tests** (`customerDocument.test.ts`, mocked db as in `invoiceService.test.ts`):
```ts
describe.each(['public', 'portal', 'staff'] as const)('%s mode', (mode) => {
  it('never returns a hidden line', async () => { /* row source returns only visible rows; assert the WHERE includes customerVisible + orgId (inspect the mocked and() args) */ });
  it('a void invoice assembles with displayStatus void', async () => { /* Review Focus 3 */ });
});
it('a draft is accepted in staff mode only', async () => {
  await expect(assembleCustomerInvoiceDocument(draft, 'public')).rejects.toBeInstanceOf(CustomerDocumentModeError);
  await expect(assembleCustomerInvoiceDocument(draft, 'portal')).rejects.toBeInstanceOf(CustomerDocumentModeError);
  await expect(assembleCustomerInvoiceDocument(draft, 'staff')).resolves.toMatchObject({ invoice: { displayStatus: null } });
});
it('staff mode resolves draft defaults before projection (partner showNote=false withholds the note)', async () => { /* Review Focus 2 */ });
it('an issued invoice uses its frozen columns even in staff mode (partner defaults ignored)', async () => {});
it('OD-9 screen: no ticketSubject / isChild keys on any line', async () => {
  const doc = await assembleCustomerInvoiceDocument(issued, 'portal');
  for (const l of doc.lines) { expect(l).not.toHaveProperty('ticketSubject'); expect(l).not.toHaveProperty('isChild'); }
});
it('OD-9 pdf surface: ticketSubject present, isChild absent', async () => {});
it('every line carries its invoice_lines id', async () => {});
it('documentLocale: invoice → partner → en', async () => {});
```
- [ ] **Step 2: Run** — `cd apps/api && npx vitest run src/services/customerDocument.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** per the interfaces. Update `invoiceService.test.ts` cases for `projectCustomerInvoiceLine` (delete) and `toCustomerInvoiceLine` (now carries `id`).
- [ ] **Step 4: Verify** — `cd apps/api && npx vitest run src/services/customerDocument.test.ts src/services/invoiceService` → PASS (check the file count includes every `invoiceService*.test.ts`); typecheck `apps/api` exit 0.
- [ ] **Step 5: Commit** — `feat(billing): customer-document assembler for invoices (#9402)`

### Task 11: Public and portal invoice routes return the assembler's output

**Files:**
- Modify: `apps/api/src/routes/invoicesPublic.ts` (`GET /:token` non-void branch, `:136-195`), `apps/api/src/routes/portal/invoices.ts` (`GET /invoices/:id`, `:120-218`), both `*.customerDocumentPin.test.ts` (Task 9), `apps/api/src/routes/invoicesPublic.test.ts`, `apps/api/src/routes/portal/invoices.test.ts` (mock call order changes)

- [ ] **Step 1: Change the pins to the target** — in each pin test, replace `expect(body).toEqual(PIN)` with:
```ts
expect(stripAdditive(body, PUBLIC_ADDITIVE)).toEqual(PIN);
expect(body.documentLocale).toBe('en');
expect(body.invoice.displayStatus).toBe(PIN.invoice.status);
expect(body.lines.map((l: { id: string }) => l.id)).toEqual(VISIBLE_LINE_IDS);
```
with `PUBLIC_ADDITIVE = ['invoice.displayStatus', 'lines[].id', 'documentLocale']` and `PORTAL_ADDITIVE = [...PUBLIC_ADDITIVE, 'branding.contactEmail', 'branding.theme', 'branding.pageSize']`; the portal test also asserts `body.branding.theme` equals the fixture invoice's frozen theme (D14). Add to the public pin file: `it('void invoices never reach the assembler', …)` (spy on `assembleCustomerInvoiceDocument`, expect not called; body equals today's void payload).
- [ ] **Step 2: Run** — `cd apps/api && npx vitest run src/routes/invoicesPublic.customerDocumentPin.test.ts src/routes/portal/invoices.customerDocumentPin.test.ts` → FAIL (`documentLocale` undefined).
- [ ] **Step 3: Implement** — public: after the void branch, `const doc = await assembleCustomerInvoiceDocument(inv, 'public')`; envelope `invoice: { ...doc.invoice, paidAt: inv.paidAt }`, `lines: doc.lines`, `branding: { ...doc.branding, partnerName: doc.branding.partnerName ?? 'Invoice' }` (key order as today), `documentLocale: doc.documentLocale`; everything else unchanged, `markViewed` stays where it is. Portal: load `getOwnedInvoiceOr404(id)`, keep the org guard (404 body unchanged) and the draft 404 (`:134-135`), then the assembler with `'portal'`; drop the route's own partner/branding reads; envelope `invoice`, `lines` (no re-projection), `branding: doc.branding`, `documentLocale`.
- [ ] **Step 4: Verify** — `cd apps/api && npx vitest run src/routes/invoicesPublic src/routes/portal/invoices` → PASS (report the file count); typecheck exit 0.
- [ ] **Step 5: Commit** — `refactor(billing): public and portal invoice routes serve the assembled customer document (#9402)`

### Task 12: `GET /invoices/:id/customer-view`

**Files:**
- Modify: `apps/api/src/routes/invoices/invoices.ts` (new route directly after `:65-76`)
- Create: `apps/api/src/routes/invoices/customerViewRoute.test.ts`

**Interfaces:**
- Produces: `GET /invoices/:id/customer-view` → `200 { data: CustomerInvoiceDocument }`. Middleware `scopes, readPerm, zValidator('param', idParam)` (`:21-22`); handler `const inv = await getOwnedInvoiceOr404(id); requireInvoiceAccess(invoiceActorFrom(c), inv); return c.json({ data: await assembleCustomerInvoiceDocument(inv, 'staff') });` inside the same `try { … } catch (err) { return handleServiceError(c, err); }` as `:65`.

- [ ] **Step 1: Write the failing tests** (mirror `invoices.test.ts`/`authScope.test.ts` setup for actors):
```ts
it('serves a draft', …);                                    // 200, displayStatus null
it('never stamps the view', () => { expect(markViewed).not.toHaveBeenCalled(); /* and no db.update on invoices */ });
it('returns no token', () => { const s = JSON.stringify(body); expect(s).not.toMatch(/token/i); expect(s).not.toContain(FIXTURE_PUBLIC_TOKEN); });
it.each([
  ['a site-restricted caller outside the invoice site', siteRestrictedActor],
  ['a caller whose accessible orgs exclude the invoice org', foreignOrgActor],
  ['a caller without invoices:read', noReadPermActor],
])('%s is rejected exactly as GET /invoices/:id rejects it', async (_n, actor) => {
  const detail = await get(`/invoices/${ID}`, actor); const view = await get(`/invoices/${ID}/customer-view`, actor);
  expect(view.status).toBe(detail.status); expect(await view.json()).toEqual(await detail.json());
});
it('hidden lines are absent', …);
it('withheld note on an issued invoice never appears in the body', …);   // Review Focus 4
it('lives in a route file mcpCoverage already covers (keyed by file; no entry change)', () => {
  expect(MCP_COVERAGE['invoices/invoices.ts']).toBeDefined();   // MCP_COVERAGE from services/mcpCoverage.ts:204
});
```
- [ ] **Step 2: Run** — `cd apps/api && npx vitest run src/routes/invoices/customerViewRoute.test.ts` → FAIL (404 for the new path).
- [ ] **Step 3: Implement** the route.
- [ ] **Step 4: Verify** — `cd apps/api && npx vitest run src/routes/invoices src/services/customerDocument.test.ts src/__tests__/mcp-coverage.test.ts` → PASS; typecheck exit 0.
- [ ] **Step 5: Commit** — `feat(billing): GET /invoices/:id/customer-view for the staff Preview (#9402)`

**W1b exit:** `cd packages/shared && npx vitest run`; `cd apps/api && npx vitest run src/services/customerDocument.test.ts src/services/invoiceService src/routes/invoicesPublic src/routes/portal/invoices src/routes/invoices` and then the full `cd apps/api && npx vitest run` once (catches `orgMerge`-style full-suite-only reds); typecheck `packages/shared` and `apps/api` exit 0. No integration suite (no schema/RLS change).

---

# W1c — Invoice on screen (PR 3)

Branch `feature/9402-document-renderer/wave-<W1 sub-issue#>-w1c` from `origin/main` **after W1a, W1b and #9401 (PR #9406) have merged** (see the feature plan's "#9401 interaction" for what to do if #9406 is still open). PR title `feat(billing): one invoice document on the web Preview and both portal pages (#9402 W1c)`. Body `Closes #<W1 sub-issue>`, `Part of #9402`, the behaviour-change list from the feature plan, and the Playwright variants that ran.

### Task 13: Invoice composition in `@breeze/document-ui`

**Files:**
- Create: `packages/document-ui/src/DocumentHeader.tsx`, `DocumentLineTable.tsx`, `DocumentLineDescription.tsx`, `DocumentTotals.tsx`, `DocumentNotes.tsx`, `DocumentTerms.tsx`, `InvoiceDocumentView.tsx`, `hostComponents.ts`, `src/__fixtures__/normalize.ts`, `src/__fixtures__/invoice-<fixture>.snap.html` (one per `InvoiceFixtureName` except `void`), `src/__tests__/invoiceDocumentView.test.tsx`, `src/__tests__/snapshots.test.tsx`
- Modify: `packages/document-ui/src/index.ts`, `src/__tests__/noStyleAttribute.test.tsx` (`renderAll()` covers every new component × every invoice fixture), `apps/portal/src/components/portal/documentShell.tsx` (`useDeepLinkedDisclosure` and `DocumentTermsCollapsible` move to `DocumentTerms.tsx`; `documentShell.tsx` re-exports them until W2b)

**Interfaces (produces):**
```ts
export interface DocumentHostComponents {
  Image(props: { asset: DocumentAssetRef; alt: string; className?: string }): JSX.Element | null;
  AgreementFile(props: { asset: DocumentAssetRef; title: string }): JSX.Element | null;
}
export interface DocumentSlots { beforePaper?: ReactNode; afterTotals?: ReactNode; signature?: ReactNode; afterPaper?: ReactNode }
export function InvoiceDocumentView(props: { model: InvoiceDocumentModel; components: DocumentHostComponents; slots?: DocumentSlots }): JSX.Element;
export interface DocumentLineDescriptionProps { title: string; blurb: string | null; workDate: DocumentDate | null; note: string | null; descriptor: string[]; ticketText: string | null; qtyFold: string | null }
export function DocumentLineDescription(props: DocumentLineDescriptionProps): JSX.Element;   // W5's lineDescriptionProps() returns this type
export function normalizeDocumentRoot(container: ParentNode): string;   // [data-document-root] outerHTML, [data-slot] emptied, React useId values stripped, attributes sorted
export const STAND_IN_COMPONENTS: DocumentHostComponents;              // <img data-asset="kind:id">, <a data-asset="kind:id">
```
Markup rules: slots render inside `<div data-slot="before-paper|after-totals|signature|after-paper">` (empty `div` when absent, so the normalized markup is stable); test ids `document-line-<rowKey>`, `document-line-blurb-<rowKey>`, `document-day-<iso>`, `document-totals-hero`, `document-deposit`; blurb `<p className="whitespace-pre-line …">`; dates `<time dateTime={iso}>`; money `<span>` text plus `<span className="sr-only">` for `suffix.srText`; phone fold `sm:hidden` qty × unit under the title (D13); `'exempt'` renders `—` with an `sr-only` `lines.notTaxableText`; the qty fold is `` `${row.qty} × ${row.unit.text}` ``. Use the portal's current classes (`invoicePaper.tsx`, `documentShell.tsx:39,139-146`) as the visual baseline.

- [ ] **Step 1: Write the failing tests**
```ts
it('blurb keeps literal newlines and pre-line wrapping', () => {
  const { getByTestId } = renderInvoice('multilineBlurb');
  const p = getByTestId(`document-line-blurb-${MULTILINE_ROW_ID}`);
  expect(p.className).toContain('whitespace-pre-line'); expect(p.textContent).toBe('Line one\nLine two');
});
it('no tax column header and no tax cells when columns.tax is null', …);
it('hero row shows Balance due and the accent rule', …);
it('a slot is rendered inside its data-slot container', …);
it.each(FIXTURE_NAMES)('%s matches its committed normalized snapshot', async (name) => {
  const html = normalizeDocumentRoot(renderInvoice(name).container);
  expect(html).toBe(readFileSync(snapPath(name), 'utf8'));
});
```
- [ ] **Step 2: Run** — `cd packages/document-ui && npx vitest run` → FAIL.
- [ ] **Step 3: Implement**; generate each `.snap.html` once with a `WRITE_SNAPSHOTS=1` branch in `snapshots.test.tsx`, then **read every snapshot by eye** (newlines in the blurb, Balance due, deposit strip, day headers) before committing; the branch must not run in CI (`if (process.env.WRITE_SNAPSHOTS === '1' && !process.env.CI)`).
- [ ] **Step 4: Verify** — `cd packages/document-ui && npx vitest run` → PASS (incl. `noStyleAttribute`); typecheck exit 0; `cd apps/portal && npx vitest run src/components/portal` → PASS (re-exports intact).
- [ ] **Step 5: Commit** — `feat(document-ui): invoice document composition (#9402)`

### Task 14: Portal `useDocumentAccent`

**Files:**
- Create: `apps/portal/src/lib/useDocumentAccent.ts`, `apps/portal/src/lib/useDocumentAccent.test.tsx`

**Interfaces:**
- Produces: `useDocumentAccent(ref: RefObject<HTMLElement | null>, color: string | null | undefined): void` — `const c = sanitizeAccentColor(color)` (`apps/portal/src/lib/docAccent.ts:37`); when `c`, `ref.current.style.setProperty('--doc-accent', c)`; when not, `removeProperty`. Never touches `document.documentElement`, never `setAttribute('style', …)`.

- [ ] **Step 1: Write the failing tests** — sets the property for `#0a7c5c`; a hostile `red;background:url(x)` leaves no `--doc-accent`; `document.documentElement.style.getPropertyValue('--doc-accent')` stays `''`; changing `color` updates it.
- [ ] **Step 2: Run** — `cd apps/portal && npx vitest run src/lib/useDocumentAccent.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS. (`noInlineStyles.test.ts` stays green: a CSSOM write is not a `style=` attribute in source.)
- [ ] **Step 5: Commit** — `feat(portal): useDocumentAccent sets the brand accent on client-fetched documents (#9402)`

### Task 15: Web Preview renders the customer view

**Files:**
- Modify: `apps/web/src/components/billing/InvoiceDocument.tsx` (delete `LineRow`, `InvoiceDocument` and their helpers; keep only `InvoiceDocumentPreview`), `apps/web/src/components/billing/InvoiceWorkspace.tsx` (`:252` passes `detail`), `apps/web/src/components/billing/InvoiceDocument.test.tsx` (rewrite), `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`, `apps/web/src/lib/i18n/extractionQuality.test.ts` (`:54-57` entry removed)
- Delete: `apps/web/src/components/billing/InvoiceDocument.linebreaks.test.tsx` (from #9401; the package blurb test replaces it)
- Create: `apps/web/src/components/billing/documentHostComponents.tsx` (web `DocumentHostComponents`: `Image` = authenticated fetch → object URL, as `QuoteDocument.tsx:30-33` `DocImage`/`DocLineThumb` do; `AgreementFile` = `null` until W2b)

**Interfaces:**
- Consumes: `GET /invoices/:id/customer-view` (Task 12), `buildInvoiceDocumentModel`, `documentLabelsFor`, `InvoiceDocumentView`.
- Produces: `InvoiceDocumentPreview({ detail }: { detail: InvoiceDetailData })` — `useEffect` keyed on `[detail]` fetches `fetchWithAuth(\`/invoices/${detail.invoice.id}/customer-view\`)`; a stale response (an older request finishing after a newer one) is discarded; renders a loading line, an error line with retry, or `<div className="…" ref={accentRef}>` wrapping `<InvoiceDocumentView model={model} components={webHostComponents} />` with `--doc-accent` set from `model`'s branding primary colour on the wrapper (outside the package). Keeps the caption and the Download PDF button.

- [ ] **Step 1: Write the failing tests** (`InvoiceDocument.test.tsx`; mock `fetchWithAuth`):
```ts
it('renders the customer view, not the staff payload', async () => { /* staff detail has a hidden line + internal note; customer-view fixture lacks both; assert neither text appears */ });
it('refetches when the workspace reloads', async () => {
  const { rerender } = render(<InvoiceDocumentPreview detail={detailA} />); await settle();
  rerender(<InvoiceDocumentPreview detail={{ ...detailA }} />); await settle();
  expect(fetchWithAuth).toHaveBeenCalledTimes(2);
});
it('fetches on every mount of the Preview tab', …);
it('discards a stale response', …);
it('labels come from the document locale, not the staff UI language', async () => { /* i18n.changeLanguage('pt-BR'); fixture documentLocale 'en' → 'Balance due' */ });
```
- [ ] **Step 2: Run** — `cd apps/web && npx vitest run src/components/billing/InvoiceDocument.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Delete the body-only `invoiceDocument` keys from all 8 locales: `billTo`, `documentType`, `due`, `empty`, `fallbackTitle`, `issued`, `laborLine`, `terms`, `ticketWork`, `table.*`, `totals.*`. Keep `preview.*` and `ticketHeader` (`InvoiceDetail.tsx:528`). Remove the `invoiceDocument.totals.tax` entry from `extractionQuality.test.ts`.
- [ ] **Step 4: Verify** — `cd apps/web && npx vitest run src/components/billing/InvoiceDocument.test.tsx src/components/billing/InvoiceWorkspace src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts` → PASS; typecheck `apps/web` exit 0.
- [ ] **Step 5: Commit** — `feat(web): invoice Preview renders the customer document from customer-view (#9402)`

### Task 16: Portal invoice pages render `InvoiceDocumentView`

**Files:**
- Modify: `apps/portal/src/components/portal/PublicInvoiceView.tsx` (`:232-257` paper → `<InvoiceDocumentView>`; the void branch `:106-130` stays host policy and keeps today's markup; payment rail, notices and pay states become `slots`), `apps/portal/src/components/portal/InvoiceDetailView.tsx` (same; gains `initial?: InvoiceDetail | null` mirroring `PublicInvoiceView.tsx:33,40`; theme now from `detail.branding.theme`, D14), `apps/portal/src/lib/api.ts` (`InvoiceDetail` and `PublicInvoiceDetail` gain `documentLocale`, `invoice.displayStatus`, line `id`; `InvoiceDetail.branding` becomes `CustomerDocumentBrandingDto`), `PublicInvoiceView.test.tsx`, `PublicInvoiceView.autopay.test.tsx`, `InvoiceDetailView.test.tsx` (selectors move to `document-*` test ids)
- Create: `apps/portal/src/components/portal/documentHostComponents.tsx` (`Image` = plain `<img>` with the host URL; logo URLs pass through)
- Delete: `apps/portal/src/components/portal/invoicePaper.tsx`, `invoicePaper.linebreaks.test.tsx`

**Interfaces:**
- Consumes: `buildInvoiceDocumentModel(toInvoiceDto(detail), documentLabelsFor(detail.documentLocale))` where `toInvoiceDto` picks `invoice`/`lines`/`branding`/`documentLocale` from the route envelope (one helper in `apps/portal/src/lib/invoiceDocument.ts`, used by both views); `useDocumentAccent` (Task 14) on the public view's host wrapper.

- [ ] **Step 1: Write the failing tests**
```ts
it('logged-in invoice uses the document theme (D14)', () => {
  render(<InvoiceDetailView initial={fixtureWithTheme('condensed')} />);
  expect(screen.getByTestId('document-root').getAttribute('data-doc-theme')).toBe('condensed');
});
it('public invoice sets the partner accent on its wrapper after the client fetch (D17)', async () => { /* wrapper style.getPropertyValue('--doc-accent') === '#0a7c5c' */ });
it('void public invoice keeps its no-amounts state', …);
it('Pay button and notices render in slots outside the document root', …);
```
- [ ] **Step 2: Run** — `cd apps/portal && npx vitest run src/components/portal/PublicInvoiceView src/components/portal/InvoiceDetailView` → FAIL.
- [ ] **Step 3: Implement**; delete `invoicePaper.tsx` and its test; `rg -n "invoicePaper" apps/portal` → no hits. Old test ids (`public-invoice`, `invoice-document`, `invoice-line-*-<index>`, `invoice-day-*`) become `document-root` / `document-line-*-<lineId>` / `document-day-*`: `rg -n "public-invoice|invoice-document|invoice-line-|invoice-day-" apps/portal/src e2e-tests` and update every hit (host-chrome ids such as the Pay button keep their names).
- [ ] **Step 4: Verify** — same command → PASS; `cd apps/portal && npx vitest run` (whole portal suite, it is small) → PASS; typecheck `apps/portal` exit 0.
- [ ] **Step 5: Commit** — `feat(portal): both invoice pages render the shared invoice document (#9402)`

### Task 17: Cross-app DOM parity

**Files:**
- Create: `apps/web/src/components/billing/InvoiceDocument.parity.test.tsx`, `apps/portal/src/components/portal/InvoiceViews.parity.test.tsx`

**Interfaces:**
- Consumes: `INVOICE_DTO_FIXTURES` (Task 8), `normalizeDocumentRoot`, `STAND_IN_COMPONENTS`, the committed `packages/document-ui/src/__fixtures__/invoice-*.snap.html` (Task 13).

- [ ] **Step 1: Write the tests**
```ts
// web: each fixture is served by a mocked fetchWithAuth for /customer-view; the Preview is rendered with STAND_IN_COMPONENTS injected (export a test seam `components?` prop defaulting to webHostComponents)
it.each(FIXTURES)('web Preview %s equals the shared snapshot', async (name) => {
  expect(normalizeDocumentRoot(await renderPreview(name))).toBe(readSnap(name));
});
// portal: PublicInvoiceView initial={envelope(name)} and InvoiceDetailView initial={envelope(name)}
it.each(FIXTURES)('public and logged-in %s equal the shared snapshot', (name) => {
  expect(normalizeDocumentRoot(renderPublic(name))).toBe(readSnap(name));
  expect(normalizeDocumentRoot(renderLoggedIn(name))).toBe(readSnap(name));
});
```
- [ ] **Step 2: Run** — `cd apps/web && npx vitest run src/components/billing/InvoiceDocument.parity.test.tsx` and `cd apps/portal && npx vitest run src/components/portal/InvoiceViews.parity.test.tsx`. Expected: PASS if Tasks 13–16 are right. **Prove the test can fail**: temporarily add a class to one element in `DocumentTotals.tsx`, rerun, see both FAIL, revert. Record that in the PR body.
- [ ] **Step 3: Commit** — `test(web,portal): invoice DOM parity against one committed snapshot set (#9402)`

### Task 18: W1 Playwright slice

**Files:**
- Create: `e2e-tests/tests/document-renderer.spec.ts`

- [ ] **Step 1: Write the spec** (`data-testid` selectors only):
  1. Public invoice under the production portal CSP: collect `securitypolicyviolation` events and console CSP errors → expect none; `getComputedStyle(document-root's accent bar).backgroundColor` equals the seeded partner accent (D17).
  2. Screenshot pair: web Preview `[data-testid="document-root"]` vs public page `[data-testid="document-root"]` for the same seeded issued invoice at 1280 px → `toHaveScreenshot` with a shared name per variant and a small `maxDiffPixelRatio` (the two apps' Tailwind builds may differ by sub-pixel font metrics; tune once, state the value).
  3. Web `data-density='dense'` Preview screenshot equals the comfortable one (Review Focus 1).
- [ ] **Step 2: Run on a per-worktree stack** — `pnpm wt-stack up` with the production CSP enabled for the portal (see `apps/portal/src/lib/docAccent.ts` header for how the stack sets it), seed one issued invoice with a partner accent, `cd e2e-tests && npx playwright test tests/document-renderer.spec.ts`. Expected: PASS. Then `pnpm wt-stack down` and say what was left running.
- [ ] **Step 3: Commit** — `test(e2e): document renderer W1 slice — public invoice CSP + Preview/public parity (#9402)`

**W1c exit:** `cd packages/document-ui && npx vitest run`; `cd apps/web && npx vitest run src/components/billing src/lib/i18n src/lib/__tests__`; `cd apps/portal && npx vitest run`; typecheck exit 0 in `packages/document-ui`, `apps/web`, `apps/portal`; Playwright slice green with variants listed; `rg -n "invoicePaper|mirrors the dashboard" apps/portal/src apps/web/src/components/billing/InvoiceDocument.tsx` → no hits.
