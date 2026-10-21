---
tracking_issue: LanternOps/breeze#9414
anchor_issue: LanternOps/breeze#9402
spec: docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md
---
# One Document Renderer for Quotes and Invoices — Feature Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the **feature-level** plan (waves, PR boundaries, contracts, ownership). The bite-sized TDD plan for W1 is `2026-10-20-document-renderer-w1.md`; W2–W5 get theirs when each wave starts.

**Goal:** Every surface that presents a quote or an invoice for reading (web Preview, portal public link, portal logged-in page, and later the PDF and the Detail description cell) renders from one server projection, one React-free view model and one React composition, so a fix lands everywhere at once and the Preview caption "This is what your customer sees" is true.

**Architecture:** Three layers (spec §3.1). (1) `apps/api/src/services/customerDocument.ts` is the only code that turns rows into the customer DTO; every customer route and the new staff `customer-view` routes call it, and eligibility stays in the routes. (2) `packages/shared/src/documents/` holds the DTO types, view-model types, pure builders and the document label maps (no React), so the PDF can use them too. (3) A new workspace package `packages/document-ui` (`@breeze/document-ui`) holds the complete React composition plus `document.css`; both Astro apps import it and render under `[data-document-root]`.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), React 19 islands in Astro (web, portal), Tailwind v4 CSS-first, pdfkit, Vitest (jsdom for UI), Playwright.

**Spec:** `docs/superpowers/specs/billing/2026-10-20-document-renderer-spec.md` (approved 2026-10-20; OD-1 A, OD-2 a, OD-3 a, OD-4 a, OD-5 a, OD-6 a, OD-7 a, OD-8 a, OD-10 a, OD-11 a; **OD-9 pending Todd**, see below). Spec PR #9405, head `ace7193058`; read it from `origin/spec/9402-document-renderer` until it merges.

**Citations verified against `origin/main` @ `f05560b9d013efd143a151fa8f37bd3f2e11e3b6`** (2026-10-20; main had not moved past the spec's SHA). An independent pass re-checked every spec `path:line` this plan carries. All hold except:
- `quoteBlocks.tsx:221-230` (heading block) is **`:239-247`** (`<h2>` at `:244`).
- `quoteBlocks.tsx:115-121` (cadence group) is **`:123-129`**; `RECURRENCE_GROUPS` (labels and suffixes) is `:27-30`.
- `quoteBlocks.tsx:182` (unit-price suffix) is **`:165`**; `:173` (amount suffix) holds.
- `ci.yml:4660-4663`: the office-addin-core conditions are `:4661` and `:4663`; `:4660` is `TEST_SHARED_RESULT`.
- Web has **8** `billing.json` locales, not 7: `de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. Every "all locales" step below means all 8.

Re-verify before each wave starts; a wave that branches from a later main re-runs the check for the files it owns.

## Global Constraints

- **No schema change in any wave** (spec §4). No table, column, migration, RLS policy, cascade, merge or export-policy entry. If a wave finds it needs a column (OD-5 (b) would add data to `quotes.cover_page`, an org-cascade table), it stops: the four registration lists in `docs/agents/tenancy-rls.md` apply and the column needs a `CORE_TENANT_EXPORT_POLICY` classification (`jsonb` → `excludedOpen`). With no migration, **Test API is the gate** for most waves. The org-cascade and export-policy suites are untouched. The exception is W1b, which adds one real-DB assembler test and retargets one existing integration test (see W1b).
- **Customer visibility does not change** (spec §5). Hidden (`customer_visible = false`) lines never reach any customer DTO in any mode. The #8604 withholding (`toCustomerInvoiceLine`, `invoiceService.ts:1055-1080`) runs only on the server. OD-9 data stays off screens until Todd rules.
- **The builders are pure and take no surface argument** (spec §3.2). The same DTO always yields the same model. Hosts differ only in `DocumentHostComponents` (§3.6) and `slots` (§3.3).
- **The package never writes a `style` attribute** (`noStyleAttribute.test.tsx`), never imports i18next or editor code, never imports either app. React and React-DOM are peer dependencies (`packages/office-addin-core/package.json` precedent).
- **Document locale governs everything printed** (spec §3.7): `documentLocale ?? partner locale ?? 'en'`, resolved by the assembler and carried in the DTO. No document component reads `navigator.language` or the viewer's i18next language. The staff chrome around the Preview stays in the staff user's language.
- **CSS wiring** (spec §3.5): `@import '@breeze/document-ui/document.css';` sits **above** `@import 'tailwindcss'` with no `layer()`; `@source '../../../../packages/document-ui/src/**/*.{ts,tsx}';` (four levels, both `globals.css` files live at `apps/<app>/src/styles/`).
- **Web density isolation**: every `[data-density=…]` rule that rewrites utilities under `main` gains `:not([data-document-root], [data-document-root] *)`.
- **Accent delivery**: portal SSR pages keep the nonced `<style>` (`PublicDocumentLayout.astro:38`); client-fetched portal pages use `useDocumentAccent(ref, color)` (CSSOM `style.setProperty` on a host wrapper, never `<html>`); web sets `--doc-accent` on a wrapper `<div>` outside the package.
- **Web mutations**: none are added. `customer-view` is a GET, so `runActionAllowlist.ts` does not change and `no-silent-mutations.test.ts` stays green untouched.
- **Locale keys**: deleting a `billing.json` key deletes it from all 8 locales (`apps/web/src/lib/i18n/localeParity.test.ts`). Also run `keyUsage.test.ts`, `extractionQuality.test.ts` (its `REVIEWED_ADJACENCIES` names `components/billing/InvoiceDocument.tsx: invoiceDocument.totals.tax` at `:55`) and `humanizedKeyRegression.test.ts`.
- **MCP coverage**: `apps/api/src/services/mcpCoverage.ts` keys coverage by route file (`'invoices/invoices.ts'` at `:510`, `'quotes/quotes.ts'` at `:632`). The new routes live in those files, so **no coverage entry changes**. A PR that says otherwise is wrong.
- **Scoped test commands**: `cd apps/<pkg> && npx vitest run <path>` or `cd packages/<pkg> && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>`. Vitest path filters are substring matches; check the reported file count.
- **Typecheck**: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in each touched package. Read the exit code; never pipe to `tail`.
- **Stacked PRs get no CI**: if a PR's base is not `main`, run `gh workflow run CI --ref <branch>` and record the run id in the PR body.
- **Public repo**: no customer names, hostnames, IPs or infra in code, fixtures or PR text. Fixture names are invented (`Example MSP`, `Acme Dental`).

## OD-9 (pending Todd): what ships until the ruling, and the switch

OD-9 asks whether customer documents show (a) the ticket subject in the ticket group header and (b) bundle children indented. Until Todd rules, screens ship **today's portal behaviour** (no subject, flat children) and the PDF keeps its subject. The switch is one constant in the assembler, so the projection itself carries or withholds the data (a builder-only flag would leave the data on the wire):

```ts
// apps/api/src/services/customerDocument.ts (W1b)
/** OD-9 (#9402) — pending Todd. Flip the line for a surface when the ruling lands. */
export const OD9_CUSTOMER_PROJECTION = {
  screen: { ticketSubject: false, bundleNesting: false }, // web Preview + portal public + portal logged-in (W1 invoices, W2 quotes)
  pdf:    { ticketSubject: true,  bundleNesting: false }, // invoicePdf/quotePdf via the assembler (W3); keeps today's PDF subject
} as const;
```

- `ticketSubject: true` adds `ticketSubject` to each projected invoice line; the builder then titles the group `Ticket #N: subject`.
- `bundleNesting: true` adds `isChild: line.parentLineId != null` to each projected line (invoices and quotes); the builder sets `DocumentLineRow.isChild` from it.
- **Ruling (a) for both**: flip `screen` to `{ ticketSubject: true, bundleNesting: true }` and `pdf.bundleNesting` to `true`, then regenerate the parity snapshots (`packages/document-ui/src/__fixtures__/*.snap.html`) and the PDF goldens. **Ruling (b)**: set `pdf.ticketSubject` to `false` (and regenerate PDF goldens); the web Preview already lost the subject in W1.
- The orchestrator flips it in a one-commit PR, `fix(documents): apply the OD-9 ruling (#9402)`. Both branches are tested from W1b on, so the flip needs no new code.

## Review Focus

Five inputs the spec implies but no task tests by default. Each one gets a pinned test in the wave that owns the code:

1. **CHF money boxes with the recurrence suffix.** A monthly quote line in CHF (`CHF 1'234.50/mo`) must fit the unit and amount cells at Helvetica 10 / bold 14 without wrapping, and the screen shows the suffix after both (OD-11). → W2b (`QuoteBlocks` renders the suffix span in both cells for a CHF fixture) and W3b (`documentPdfTable.test.ts` extends the CHF box measurement with the suffix).
2. **Dense or compact mode on web.** With `data-density='dense'` on the web shell, the Preview's paper keeps its own padding (it must not shrink to the dense utility rewrite). → W1a (`densityIsolation.test.ts` fails if any density selector can match `[data-document-root]` or a descendant) and W1c (Playwright: Preview under `dense` matches Preview under `comfortable`).
3. **A draft with partner-default line detail.** A draft invoice whose own line-detail columns are NULL and whose partner has `invoiceLineShowNote = false`: the staff Preview must withhold the time-entry note exactly as issuing will freeze it. → W1b (`customerDocument.test.ts` "staff mode resolves draft defaults before projection").
4. **A void or superseded document in each mode.** Void invoice: public route keeps its no-amounts state and never calls the assembler; portal serves it with `displayStatus` `void`; staff Preview renders it. Superseded quote: public 410, portal serves with the "Replaced" notice, staff serves. → W1b (void invoice × 3 modes) and W2a (superseded quote × 3 modes).
5. **An issued invoice with a withheld note, seen through the staff Preview.** Issued, `lineShowNote = false`, a `time_entry` line whose description holds the technician's note: the Preview shows the localised labor label and never the note. The old Preview reapplied rules in the browser from the staff payload, so this is the leak the assembler closes. → W1b (`customerViewRoute.test.ts` asserts the note string is absent from the JSON body).

---

## Wave list

Each wave ships on its own. **#9401 (PR #9406) lands first**; W1c deletes files #9401 edits, and W3a rewrites the column geometry #9401 changes.

| Wave | PR | Scope | Depends on | Model tier |
|---|---|---|---|---|
| **W1a** | 1 | `packages/document-ui` scaffold + `document.css` + both `globals.css` wirings + density isolation + web `--paper-primary` + `paperTokens.test.ts` move + `test-document-ui` CI job in `ci-success` + 5 Dockerfiles + built-CSS tests | — | **sonnet** |
| **W1b** | 2 | Shared invoice DTO/model/builder/labels; `customerDocument.ts` invoice assembler; public + portal invoice routes through it; `GET /invoices/:id/customer-view` | — (parallel with W1a; file-disjoint) | **opus** (customer-data visibility, reuses auth middleware) |
| **W1c** | 3 | Invoice composition in `document-ui`; web Preview, portal public + logged-in invoice swap; delete `invoicePaper.tsx` + `InvoiceDocument.tsx` body + body-only keys; DOM parity; W1 Playwright slice | W1a + W1b merged; #9401 merged | **sonnet** |
| **W2a** | 4 | Quote DTO/model/builder; `assembleCustomerQuoteDocument`; portal quote route stops spreading the raw row (D19); public quote route through the assembler; `GET /quotes/:id/customer-view` | W1b | **opus** (customer-data visibility) |
| **W2b** | 5 | `QuoteBlocks`, `DocumentAgreements`, `DocumentCover` (current geometry), `QuoteDocumentView`; swap web Preview, `PublicQuoteView`, `QuoteDetailView`; delete `quoteBlocks.tsx`, `documentShell.tsx`, `quoteAgreements.tsx`, `QuoteDocument.tsx` body; `Closes #6649` | W1c + W2a | **sonnet** |
| **W3a** | 6 | `documentPdfTable.ts`; invoice PDF draws through it from the shared model; theme fonts; pt-BR labels move; delete `renderInvoiceHtml` + golden | W1b (+ #9401) | **sonnet** |
| **W3b** | 7 | Quote PDF through `documentPdfTable.ts`; description first (D3); OD-11 unit-column suffix; regenerate quote goldens | W2a + W3a | **sonnet** |
| **W4** | 8 | OD-5 cover geometry + editor crop display + full Playwright matrix under the production CSP | W2b | **sonnet** |
| **W5** | 9 | `lineDescriptionProps` presenter; `DocumentLineDescription` in `InvoiceDetail`/`QuoteDetail` description cells; delete orphaned `lineTitle`/`lineBlurb` | W2b | **sonnet** |

Why opus for W1b and W2a: they decide which rows and fields leave the server for a customer and add a staff read route that must reject exactly as the detail route does. A wrong join or a missed mode branch leaks a hidden line or a withheld note into a page that claims to be the customer view. Everything else renders a model whose content those two waves fixed, and the parity tests catch drift.

Branch naming (`CLAUDE.md`): `feature/9414-document-renderer/wave-<sub-issue#>`. Feature #9414 was registered with one sub-issue per PR unit (W01 #9415 W1a · W02 #9416 W1b · W03 #9417 W1c · W04 #9418 W2a · W05 #9419 W2b · W06 #9420 W3a · W07 #9421 W3b · W08 #9422 W4 · W09 #9423 W5), so every PR carries `Closes #<its sub-issue>` and `Part of #9414`. W2b's body also carries `Closes #6649`.

Parallel lanes: **W1a ∥ W1b** → W1c → (**W2a → W2b**) ∥ **W3a** → W3b; then **W4 ∥ W5** (file-disjoint, see below).

---

## W1 — Package and invoice on screen (three PRs)

**Ships on its own:** the invoice reads the same on the web Preview, the public link and the logged-in portal, with line breaks preserved (D1), one header/totals/notes/terms layout (D7, D8, D11, D12), the phone fold on every surface (D13), the real theme on the logged-in page (D14), the partner accent on the public invoice (D17), and money and dates in the document's locale on screen (D18 for screens).

**Why three PRs:** W1a is build and CI plumbing with no behaviour change; a reviewer judges it on CI wiring and CSS cascade. W1b is the who-sees-what consolidation, reviewed on visibility and auth. W1c is the visible swap, reviewed on parity. Any one can be rejected without the others.

### W1a — Package scaffold, CSS, CI (PR 1; base `main`)

**Scope**
- `packages/document-ui/`: `package.json` (`@breeze/document-ui`; `exports` `"."` and `"./document.css": "./src/document.css"`; peers `react`/`react-dom` `^19.2.7`; deps `@breeze/shared` `workspace:*`, `lucide-react`; deps also `@fontsource/hanken-grotesk` and `@fontsource/literata` (the classic document fonts, today loaded only by the portal); devDeps copied from `office-addin-core` minus `@types/office-js`), `tsconfig.json`, `vitest.config.ts` (jsdom), `src/index.ts`, `src/tokens.ts`, `src/DocumentPaper.tsx` (root primitive only; unused by any app until W1c), `src/document.css`, `src/__tests__/noStyleAttribute.test.tsx`, `src/__tests__/paperTokens.test.ts` (the paper-block half of `apps/portal/src/styles/paperTokens.test.ts`; see adjustment 6).
- `document.css`: the portal paper token block (`apps/portal/src/styles/globals.css:556-593`), `.doc-accent-*` (`:539-547`), the portal condensed rules (`:527-533`) and `.signature-preview` move here. The paper block and the condensed rules are re-keyed under `[data-document-root]`; `.doc-accent-*` and `.signature-preview` **stay global classes**, because pages outside any document root use the accent (`AuthLayout.astro:59`, `TrustEmbedCard.astro:18`, `TrustPageView.tsx:67`, `TrustDocumentsList.tsx:27,34`, `trust/access/*`). `--primary: var(--paper-primary, 225 62% 48%)`. **The document owns its fonts:** `document.css` imports the Hanken Grotesk and Literata fontsource files and defines `--doc-font-sans`/`--doc-font-display` plus a `.doc-font-display` class inside `[data-document-root]`, because neither font token is a `:root` token (the portal declares `--font-display` in `@theme inline`, `globals.css:79`; web has none and loads neither font). Package components use `doc-font-display`, never the host's `font-display` utility. The portal's `DocumentPaper` (`documentShell.tsx`) gains `data-document-root` so the moved rules still match (the only portal markup change). Web's own condensed rules (`apps/web/src/styles/globals.css:34654-34665`) stay until W2b deletes `QuoteDocument.tsx`'s body.
- Both `globals.css`: the import above `tailwindcss`, the four-level `@source`. Web adds `--paper-primary` to its light `:root` (equal to its light `--primary`) and the density `:not(…)` exclusions (compact from `:34539`, dense from `:34595`).
- Tests: `tokenPresence.test.ts` in each app (parses that app's `globals.css` light `:root`, fails if a `DOCUMENT_HOST_TOKENS` entry is missing; the portal's accent blocks are checked for `paper-primary` only). `DOCUMENT_HOST_TOKENS` lists only the tokens the package reads **without a fallback** and does not set itself, `densityIsolation.test.ts` (web), `documentCss.build.test.ts` in each app.
- CI: `test-document-ui` job beside `test-office-addin-core` (`ci.yml:1140`), gated `APP_IF` like `test-shared` (`:1116`); `ci-success` `needs` (`:4543`), `TEST_DOCUMENT_UI_RESULT` env (beside `:4576-4577`), `!= "success"` in the app branch (beside `:4660`) and `!= "skipped"` in the no-app branch (beside `:4734`); `.github/scripts/ci-area-gating.test.mjs` gains the same four assertions it has for `test-shared` (`:357-366`) plus an entry in the never-area-gated list (`:369-370`).
- Dockerfiles (spec §8.4): `COPY packages/document-ui/package.json ./packages/document-ui/` in `apps/web/Dockerfile` (beside `:28-29`), `apps/portal/Dockerfile` (beside `:25`), `docker/Dockerfile.web` (beside `:9-10`; plus the `COPY --from=deps` node_modules line beside `:15-18`), `docker/Dockerfile.web.dev` (beside `:17`), `docker/Dockerfile.portal.dev` (beside `:13`). The two dev Dockerfiles also copy package **source** explicitly (`Dockerfile.web.dev:25-26`, `Dockerfile.portal.dev:18`), so each gains `COPY packages/document-ui ./packages/document-ui`, and `docker-compose.dev.yml` (web service `:160-174`, and the portal service) gains the `packages/document-ui/src` + `package.json` bind mounts and the `node_modules` exclusion that `packages/shared` has (run `composeBindMounts.test.ts`). Builder stages (`apps/web/Dockerfile:57`, `apps/portal/Dockerfile:53`) already copy all of `packages/`.

**No behaviour change:** no app renders a package component; the moved portal rules match the same elements through `data-document-root`; the density exclusions match nothing on web yet; `--paper-primary` has no web consumer yet.

**CI that catches what:** `test-document-ui` (package tests + typecheck), `test-web`/`test-portal` (token presence, density, built CSS), `lint` runs the `.github/scripts` tests, `build-smoke-images` (`ci.yml:3545`) builds `apps/portal/Dockerfile` and `docker/Dockerfile.web` and is what catches a missing manifest line. `apps/web/Dockerfile` is built only by the release and security workflows; `release-build-check.yml` also runs on any `pull_request` that touches `apps/web/Dockerfile` (`:4-8`), so W1a triggers it automatically. Record its run id in the PR body (dispatch it by hand only if it did not run).

**Tier: sonnet.** No customer data; every step has a mechanical test.

### W1b — Invoice assembler and customer-view route (PR 2; base `main`)

**Scope**
- `packages/shared/src/documents/`: `model.ts` (common + invoice types from spec §3.2; quote types land in W2a's `quoteModel.ts`), `dto.ts` (`CustomerInvoiceDocument` and friends), `money.ts` (`documentMoney`), `dates.ts` (`documentDate`), `labels/types.ts` (`DocumentLabels`), `labels/en.ts` (`DOCUMENT_LABELS_EN`), `labels/index.ts` (`documentLabelsFor(locale)`; English for every locale in W1), `invoiceBuilder.ts` (`buildInvoiceDocumentModel`), `fixtures/invoiceDtos.ts`, `index.ts`. New package export `"./documents": "./src/documents/index.ts"` (not re-exported from the root barrel; keeps `browserSafeBarrel.test.ts` untouched).
- `apps/api/src/services/customerDocument.ts`: `CustomerDocumentMode`, `OD9_CUSTOMER_PROJECTION`, `loadCustomerInvoiceLines(invoice, opts)`, `assembleCustomerInvoiceDocument(invoice, mode, opts)`, `loadCustomerDocumentBranding(invoice)`. `projectCustomerInvoiceLine` (`invoiceService.ts:1086`) is folded in and deleted; `resolveDocumentLineDetail` (`invoiceService.ts:967`) is exported; the projection gains `id`; the header gains `displayStatus`.
- Routes: `routes/invoicesPublic.ts` (`GET /:token`, non-void branch) and `routes/portal/invoices.ts` (`GET /invoices/:id`) take `invoice`, `lines` and `branding` from the assembler and add `documentLocale`; `routes/invoices/invoices.ts` gains `GET /:id/customer-view` beside `:65`.
- `getCustomerInvoice` (`invoiceService.ts:1125`) is **deleted**. It is the third copy of the customer row filter, and wrapping it around the assembler would turn a draft PDF request into a 500: the portal PDF route (`routes/portal/invoices.ts:250-259`) only catches `InvoiceServiceError` and answers drafts with 404 *after* the call. Its replacement is `getPortalInvoiceRowOr404(id, orgId)` in `invoiceService.ts` (`getOwnedInvoiceOr404` + the org guard, 404 on mismatch, returns the row). The portal detail and PDF routes both call it and keep their own draft 404. `invoicePdf.integration.test.ts:13-39` (the portal org-guard cases) is retargeted to `getPortalInvoiceRowOr404` + the assembler. `customerDocument.ts` imports `invoiceService.ts`, never the reverse (no import cycle).

**Plan adjustment (vs. spec §3.4):** the assembler takes the **row the route already authorized** (`invoice: InvoiceRow`) instead of an id. Each route has already loaded the row to decide eligibility (public `resolve(token)`, portal org guard, staff `requireInvoiceAccess`); re-reading it inside the assembler would add a query and a gap between the eligibility check and the assembly. `loadCustomerInvoiceLines(invoice)` already took the row in the spec.

**Contracts every later wave relies on** (full signatures in the W1 plan, Tasks 7–12):
- `CustomerInvoiceDocument = { invoice: CustomerInvoiceHeaderDto; lines: CustomerInvoiceLineDto[]; branding: CustomerDocumentBrandingDto; documentLocale: string }`.
- `buildInvoiceDocumentModel(dto: CustomerInvoiceDocument, labels: DocumentLabels): InvoiceDocumentModel`.
- `assembleCustomerInvoiceDocument(invoice: InvoiceRow, mode: CustomerDocumentMode, opts?: { surface?: 'screen' | 'pdf' }): Promise<CustomerInvoiceDocument>`.
- `GET /invoices/:id/customer-view` → `200 { data: CustomerInvoiceDocument }`.

**Regression pin.** Before the routes change, a characterization test records today's public and portal JSON for one issued fixture. After the change, each response with the declared additive keys removed must deep-equal the pin. The public route wraps its body in `{ data }` (`invoicesPublic.ts:204`); the portal route does not (`portal/invoices.ts:203`). Additive keys: public: `data.invoice.displayStatus`, `data.lines[].id`, `data.documentLocale`. Portal: `invoice.displayStatus`, `lines[].id`, `documentLocale`, plus `branding.contactEmail`, `branding.theme`, `branding.pageSize` (the last two fix D14). Any other difference fails the PR.

**Route tests must prove** (`customerViewRoute.test.ts`): no `markViewed`/`viewedAt`/`firstViewedAt` write; the exact allowlisted key sets of `data` and `data.invoice` (no token, no internal field); a site-restricted caller outside the invoice's site gets **403 `SITE_DENIED`** and a foreign-org caller gets the detail route's concrete status, each asserted as a literal **and** compared with the detail route; for an issued invoice, `data` deep-equals `{ invoice, lines, branding, documentLocale }` picked from the portal route's response (spec §8.1; status is raw in both modes, so it is equal too); a draft is served. Assembler tests (`customerDocument.test.ts`) prove the row filter carries `customerVisible` and `orgId` (by inspecting the query), a draft is accepted only in `staff` mode (a non-staff mode throws `CustomerDocumentModeError`), branding failures are fail-soft, the OD-9 switch branches, and the Review Focus 3–5 cases. **Hidden lines in a mocked DB prove nothing** (the filter is SQL), so W1b adds one real-DB test, `customerDocument.integration.test.ts`: an invoice with a hidden line and a partner locale, assembled under a real portal-user context, a staff context and the public route's system context. It asserts the hidden line is absent, the partner-axis reads return rows (not the silent zero rows of the #1375 class) and `documentLocale` is the partner's. a draft is accepted only in `staff` mode (a non-staff mode throws `CustomerDocumentModeError`), the OD-9 switch branches, and the Review Focus 3–5 cases.

**CI:** `test-shared` (builder, labels, money), `test-api` (assembler, routes), **`integration-test`** (`customerDocument.integration.test.ts` and the retargeted `invoicePdf.integration.test.ts`). Run both locally on a per-worktree stack (`pnpm wt-stack up` … `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/customerDocument.integration.test.ts src/services/invoicePdf.integration.test.ts` … `pnpm wt-stack down`). There is no tenancy or RLS change: the assembler adds `invoiceLines.orgId` to the public row filter, which narrows the result and never widens it.

**Tier: opus.** Implementer and reviewer.

### W1c — Invoice on screen (PR 3; base `main` after W1a, W1b and #9401 merge)

**Scope**
- `packages/document-ui/src/`: `DocumentHeader`, `DocumentLineTable`, `DocumentLineDescription`, `DocumentTotals`, `DocumentNotes`, `DocumentTerms` (with `useDeepLinkedDisclosure`, moved from `documentShell.tsx:184`; `documentShell.tsx` keeps a re-export until W2b deletes it), `InvoiceDocumentView`, `hostComponents.ts`; fixtures + committed normalized snapshots under `src/__fixtures__/`.
- Portal: `src/lib/useDocumentAccent.ts` (D17); `PublicInvoiceView.tsx` and `InvoiceDetailView.tsx` render `<InvoiceDocumentView>` (and `InvoiceDetailView` gains `initial`); delete `invoicePaper.tsx` and `invoicePaper.linebreaks.test.tsx`; `api.ts` invoice types gain `documentLocale`/`displayStatus`/line `id`.
- Web: `InvoiceDocument.tsx` shrinks to `InvoiceDocumentPreview` (fetches `GET /invoices/:id/customer-view`; refetches when the workspace's `detail` changes, i.e. on every `reload()`, and on each mount of the Preview tab); `InvoiceWorkspace.tsx` passes what it needs; delete `InvoiceDocument.linebreaks.test.tsx`; rewrite `InvoiceDocument.test.tsx`.
- Locales: delete the body-only `invoiceDocument.*` keys from all 8 `billing.json` (keep `preview.*` and `ticketHeader`, which `InvoiceDetail.tsx:528` uses); update `extractionQuality.test.ts:55` and remove the four deleted keys from `apps/web/src/locales/humanizedKeyBaseline.json:731-734` (its stale-entry check, `humanizedKeyRegression.test.ts:105`, runs under `src/locales`).
- Parity: `apps/web/src/components/billing/InvoiceDocument.parity.test.tsx` and `apps/portal/src/components/portal/InvoiceViews.parity.test.tsx` compare normalized `[data-document-root]` against the same committed `packages/document-ui/src/__fixtures__/invoice-*.snap.html`.
- Playwright: `e2e-tests/tests/document-renderer.spec.ts` — the W1 slice (spec §8.2).

**#9401 interaction.** PR #9406 adds `whitespace-pre-line` in `InvoiceDocument.tsx:43`, `InvoiceDetail.tsx:536` and `invoicePaper.tsx:102`, adds `*.linebreaks.test.tsx` beside each, and widens the invoice PDF description column. W1c deletes two of those files' bodies (and both linebreaks tests); the package's `DocumentLineDescription` carries `whitespace-pre-line` by construction and its own blurb test replaces them. `InvoiceDetail.tsx`'s fix and test stay (W5 replaces that cell). **If #9406 is still open when W1c is ready:** do not merge W1c first. Ask the orchestrator to merge #9406 (it is the shipping stop-gap). If it is blocked for longer than W1c's review, W1c rebases onto main as-is; when #9406 later rebases, its `InvoiceDocument.tsx`/`invoicePaper.tsx` hunks conflict as modify/delete and its author drops them along with the two linebreaks tests. Say which path happened in the W1c PR body.

**Behaviour changes the PR body must list** (each follows from "the Preview shows what the customer sees"): the Preview's header, totals ("Balance due", Paid shown as `−`, Tax row always), notes after the totals and collapsible terms now match the portal; the Preview loses the ticket subject and the bundle `↳` indent (OD-9 pending); a blank `billToName` no longer falls back to the org name on the Preview (the customer never saw that fallback); the logged-in portal loses its per-line "Ticket #N" line (it repeated the group header; the two portal pages must produce identical markup); the old `invoice-line-*-<index>` test ids become the package's `document-line-*-<lineId>` ids.

**CI:** `test-document-ui`, `test-web` (parity, i18n), `test-portal` (parity, accent hook), `build-smoke-images`. The Playwright slice runs on a per-worktree stack (`pnpm wt-stack up`, production portal CSP; see `docs/agents/local-stacks.md`); record which variants ran.

**Tier: sonnet.** The model content is fixed by W1b; DOM parity and the slice are the gate.

---

## W2 — Quotes on screen (two PRs)

**Ships on its own:** a proposal reads the same on the web Preview, the public link and the logged-in portal, cover included (current portal geometry), with one block walk, one agreements disclosure and the portal's alignment classes. Fixes D5 (Preview gets the cover), D7, D12, D15, D19, and the quote half of D14/D16/D18 on screen.

### W2a — Quote assembler and routes (PR 4; base `main` after W1b)

- `packages/shared/src/documents/`: `quoteModel.ts` (spec §3.2 quote types: `QuoteTableBlock`, `QuoteBlockModel` incl. `heading` (`quoteBlocks.tsx:239-247`), `AgreementBody`, `QuoteDocumentModel`), `quoteDto.ts` (`CustomerQuoteDocument`), `quoteBuilder.ts` (`buildQuoteDocumentModel(dto, labels)`; cadence groups from `RECURRENCE_GROUPS` `quoteBlocks.tsx:27-30`; suffix on unit **and** amount (OD-11); `cells.length === columns.length` and non-empty titles asserted), quote keys appended to `labels/types.ts` + `labels/en.ts`, `fixtures/quoteDtos.ts`.
- `customerDocument.ts`: `loadCustomerQuoteRows(quote)`, `assembleCustomerQuoteDocument(quote, mode, opts)`. Wraps `toPublicQuoteHeader` (`publicQuoteDto.ts:88`). Modes: `public` keeps `toPublicStatus` (`:53-75`: `sent`→`viewed`, throws on `draft`, 410 on `superseded`); `portal` keeps the raw status and serves superseded; `staff` accepts any status. `displayStatus` everywhere. `SanitizedHtml` is cast only here, after the existing server sanitizer.
- Routes: `routes/quotesPublic.ts` and `routes/portal/quotes.ts` (stop the raw spread at `:99`, D19) through the assembler; `routes/quotes/quotes.ts` gains `GET /:id/customer-view` beside `:125` (same `scopes` + `readPerm` (`QUOTES_READ`, `:44-45`), `getQuote`-equivalent ownership: raw select then `assertQuoteAccess` (`quoteTypes.ts:206`); **no** `refreshDraftQuoteTaxRate` side effect (`:131` writes; the customer view must not)).
- Tests: as W1b, plus the portal quote route asserts the assembler's field shape (no raw-row keys such as `internalNotes`, cost or margin columns) and still serves a superseded quote (`QuoteDetailView.tsx:216`). Characterization pin for the public quote route (additive keys only); the portal quote route is pinned against the **new** shape, with the removed raw-row keys listed in the PR body (that removal is D19's fix).
- **Tier: opus.**

### W2b — Quote composition and swap (PR 5; base `main` after W1c and W2a)

- `packages/document-ui/src/`: `QuoteBlocks.tsx`, `DocumentAgreements.tsx` (lazy PDF body via `components.AgreementFile`, print expansion), `DocumentCover.tsx` (current portal geometry `documentShell.tsx:55-96`; W4 changes it), `QuoteDocumentView.tsx` (`h2` number when `cover !== null`; `slots.signature` builds links from `model.agreements`), cover/agreements CSS into `document.css`; quote fixtures and snapshots.
- Swap web `QuoteDocument.tsx` Preview (inert "Your customer signs here" signature slot), portal `PublicQuoteView.tsx`, `QuoteDetailView.tsx` (gains `initial`; its inline totals go away).
- Delete `quoteBlocks.tsx`, `quoteBlocks.test.tsx` (assertions worth keeping move to package tests), `documentShell.tsx`, `quoteAgreements.tsx`, the `QuoteDocument.tsx` body, web's condensed rules (`globals.css:34654-34665`, now in `document.css`), body-only `quotes.document.*` keys from all 8 locales. The portal `testIdPrefix` values `public-quote`/`quote` go away; update the Playwright selectors in `e2e-tests/tests/quote-contract-proposal.spec.ts` and any portal spec that uses them.
- Playwright: add the quote pair to `document-renderer.spec.ts`.
- PR body: `Closes #6649`.
- **Tier: sonnet.**

**File ownership W2 vs W3a (they run in parallel):** W2a and W3a both touch **`packages/shared/src/documents/labels/types.ts`**, **`labels/en.ts`** and **`documents/index.ts`** (W2a adds quote keys and exports; W3a adds `labels/pt-BR.ts`, PDF-only keys and the pt-BR branch of `documentLabelsFor`). Each appends its keys in its own clearly-commented section at the end of the interface/object; the second to merge rebases. Nothing else overlaps: W2 never edits `invoicePdf.ts`, `quotePdf.ts`, `documentPdfTable.ts` or `apps/api/src/i18n/`; W3a never edits `customerDocument.ts` (it calls `assembleCustomerInvoiceDocument(inv, mode, { surface: 'pdf' })`, which W1b already ships), the quote routes or any React file.

## W3 — PDF module (two PRs)

**Ships on its own:** the PDF prints the same strings as the screen in the document's language, with the description first and the same width on both kinds, theme fonts on invoices, and one pagination routine.

### W3a — `documentPdfTable.ts` + invoice PDF (PR 6; base `main` after W1b and #9401; parallel with W2)

- `apps/api/src/services/documentPdfTable.ts`: `documentColumnsFor(doc, { showTax })` (description first; 0.42 taxed / 0.57 untaxed; money cells 0.155/0.16, total 0.19, summary 0.24 — #9401 already moved the invoice to these fractions, so this extracts rather than changes invoice x-coordinates), `measureDocumentLineRow`, `drawDocumentLineRow`, `drawDocumentTotals`; fonts from `PdfThemeFonts`; money via `formatMoneyForPdf(DocumentMoney.amount, …)` (`pdfMoney.ts:53`), cells `lineBreak: false` + `fitFontSize` (`pdfFitText.ts:18`); break before draw (`invoicePdf.ts:529-533`); column header repeats after a break.
- `invoicePdf.ts`: rows from `assembleCustomerInvoiceDocument(inv, mode, { surface: 'pdf' })` → `buildInvoiceDocumentModel` → the module; theme fonts (`registerThemeFonts`); header strings and dates from `documentLabelsFor(locale)` (D16, D18); delete `renderInvoiceHtml` (`:201`), the stale header line `:5`, `lineTax` (`:116`) and the golden HTML snapshot; meaningful assertions from `invoicePdf.test.ts:6`, `invoicePdf.lineDetail.test.ts:7`, `invoicePdf.golden.test.ts:6` move to builder or PDF-output tests.
- **The header DTO grows** `billToAddress`, `billToTaxId` and `terms` (short terms), because today's invoice PDF prints all three (`invoicePdf.ts:218,289,321`). W1 leaves them out, and the builder fills `billTo.addressLines: []`, `taxId: null`, `terms.short: null`. W3a adds them to `CustomerInvoiceHeaderDto` and `toCustomerInvoiceHeader`, adds them to the W1b pin's additive-key lists, and regenerates the parity snapshots, because the screens start showing them too. The customer already receives this data in the emailed PDF, so this is not a visibility change. Say so in the PR body.
- `packages/shared/src/documents/labels/pt-BR.ts` from `apps/api/src/i18n/locales/pt-BR/pdf.json` (the document keys; delete them from `pdf.json` and from the en `pdf.json` if they become unused — check `tApi` callers first, `invoicePdf.ts:134,145`).
- Goldens: regenerate the invoice fixtures that pin coordinates; add a multi-page invoice fixture; PR lists each changed fixture and why.
- **Tier: sonnet.**

### W3b — Quote PDF (PR 7; base `main` after W2a and W3a)

- `quotePdf.ts` line tables, totals box and pagination through the module; description first (D3: today `colQtyX: left` at `:394`/`:409`); OD-11 suffix in the unit column (`:707` today puts it on the total only); delete `deviceSetCustomerText` (`:60`), `lineTax` (`:88`), `columnsFor` (`:386-421`); header labels/dates from the shared labels (`:1178-1179`, `:48`). Cover page, TOC and `richTextPdf.ts`/`calloutPdf.ts`/`tablePdf.ts` stay (OD-6, OD-7).
- CHF box test extended with the suffix (Review Focus 1); multi-page quote fixture; regenerate quote goldens.
- **Tier: sonnet.**

**CI (W3):** `test-api` only. **No migration.**

## W4 — Cover geometry and screenshot matrix (PR 8; base `main` after W2b)

- OD-5 (a): `DocumentCover` renders at the PDF page aspect from `branding.pageSize` (A4 1:1.414, Letter 1:1.294) with a centre crop and the title band from 62% of the height (`quotePdf.ts:999`), as aspect/position **classes** in `document.css` (no style attribute). The editor's cover upload shows the same crop (the cover editor in `apps/web/src/components/billing/quotes/`; find it by the `cover_page` field).
- Full Playwright matrix (spec §8.2) under the production portal CSP: both kinds × Preview/public/logged-in × desktop/390 px × classic/condensed × web density compact/dense × one non-English document locale. PR states which variants ran.
- **Tier: sonnet.**

## W5 — Detail reuse (PR 9; base `main` after W2b; parallel with W4)

- `packages/shared/src/documents/lineDescription.ts`: `lineDescriptionProps(line, labels)` for a **staff** row (never zipped with customer rows by position, OD-4).
- `InvoiceDetail.tsx` (`LineItemsTable` at `:495`, blurb cell `:536`) and `QuoteDetail.tsx` (`:656`, `:670`) description cells render `<DocumentLineDescription {...lineDescriptionProps(line, labels)} />`. Cost, margin, hidden-line marker, `InvoiceLineDevices` and the stacked-card phone layout (`shared/LineItemsTable.tsx:36-57`) stay.
- Delete web `lineTitle`/`lineBlurb` helpers with no remaining caller (grep). #9401's `InvoiceDetail.linebreaks.test.tsx` keeps passing (the package cell carries `whitespace-pre-line`).
- **Tier: sonnet.**

**W4 ∥ W5 ownership:** W4 owns `DocumentCover.tsx`, `document.css`, the cover editor and `e2e-tests/tests/document-renderer.spec.ts`; W5 owns `DocumentLineDescription.tsx`, `lineDescription.ts`, `InvoiceDetail.tsx`, `QuoteDetail.tsx`. Disjoint.

---

## Exit checklist (feature)

- [ ] Every surface in spec §3.3 renders from `customerDocument.ts` → `packages/shared/src/documents` → `@breeze/document-ui` (or `documentPdfTable.ts` for PDFs).
- [ ] D1–D20 each fixed or explicitly deferred with a reason (OD-9 rows: D9, D10).
- [ ] `invoicePaper.tsx`, `quoteBlocks.tsx`, `documentShell.tsx`, `quoteAgreements.tsx`, `renderInvoiceHtml` and every "mirrors the dashboard" comment are gone (`rg -n "mirror" apps/portal/src/components/portal apps/web/src/components/billing`).
- [ ] The Preview captions (`billing.json:1615`, `:2203`) are true; parity tests green in `test-web` and `test-portal`.
- [ ] `test-document-ui` is in `ci-success` with both branches asserted.
- [ ] OD-9 ruling applied (or still pending, with the switch untouched and the issue saying so).
- [ ] #6649 closed by W2b; #9402 closed by the last wave's PR.

## Spec adjustments forced by current main

1. **Assembler input is the authorized row**, not an id (W1b, above). The route already loaded it for eligibility.
2. **8 web locales**, not 7 (de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR).
3. **`invoiceDocument.ticketHeader` and `invoiceDocument.preview.*` survive W1c**: `InvoiceDetail.tsx:528` uses `ticketHeader`, and the Preview chrome uses `preview.*`. `extractionQuality.test.ts:55` names `invoiceDocument.totals.tax` and must be updated in the same PR.
4. **#9401 already moves the invoice PDF to 0.42/0.57** (PR #9406), so W3a extracts that geometry rather than introducing it. W3a branches after #9406 merges.
5. **The logged-in portal's per-line ticket** (`showLineTicket`, `InvoiceDetailView.tsx:277`) is dropped so the two portal pages produce identical document markup; `DocumentLineRow.ticketText` stays in the model for quotes/future use and is `null` for invoices.
6. **`paperTokens.test.ts` splits rather than moves.** It compares the paper block with the **portal's** light palette (`LIGHT.get(token)`) and the portal's seven chrome-accent blocks. The paper-block assertions (which tokens are pinned, and `--primary`/`--primary-on-tint`/`--ring` = `var(--paper-primary, 225 62% 48%)`) move to the package. The palette-coherence assertions stay in the portal test, which now reads the paper block from `@breeze/document-ui/document.css`. The `225 62% 48%` fallback is web's light primary, not the portal's (`155 32% 24%`); it only applies to a host that forgot `--paper-primary`, which `tokenPresence.test.ts` forbids.
7. **`apps/portal/src/lib/noInlineStyles.test.ts`** scans only `apps/portal/src`. The package's own `noStyleAttribute.test.tsx` covers package components, so the two together cover everything the portal renders. Its doc comment names `globals.css` as the home of `.doc-accent-*`/`.signature-preview`; W1a updates it to `document.css`.
8. **A site-restricted caller gets 403 `SITE_DENIED`, not 404.** Spec §8.1 says the customer-view routes 404 a caller without org or site access. The detail route they must match answers a site miss with 403 (`requireSiteAccess`, `invoiceService.ts:102`). The plan follows the detail route, so access is exactly "can read this document", and the tests pin the literal statuses.
9. **`getCustomerInvoice` is deleted** rather than kept as a wrapper (see W1b). This touches one integration test, so W1b runs the Integration Tests job.
10. **The document owns its fonts.** `document.css` imports Hanken Grotesk and Literata, because neither app has a `:root` font token for the package to read and web loads neither font.

None of these reopens a §7 decision.
