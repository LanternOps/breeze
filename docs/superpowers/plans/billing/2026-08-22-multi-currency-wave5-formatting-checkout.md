---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 5 — Formatting & Checkout Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor:** line — `codex` tasks are self-contained (codex sees only that task's text; run them via the `delegating-to-codex` skill with the task text as the prompt, `high` reasoning, explicit file list), `claude` tasks are sweeps / UI / cross-module wiring and stay with Claude subagents.

**Goal:** One money formatter everywhere money is rendered (API PDFs + emails, portal, web ticketing/catalog files, contract templates), a `document_locale` snapshot on invoices and quotes so regenerated documents never reflow when the partner changes language, currency-neutral locale catalogs, AI tools that expose `currencyCode` and refuse to sum across currencies, and Stripe readiness: a cached connected-account `default_currency`/`country` with refresh + TTL, a warn-don't-block mismatch notice, and a friendly mapping for `checkout.sessions.create` currency failures (spec §9, §10, bug B7).

**Architecture:** `packages/shared/src/utils/currency.ts` already ships the Intl formatter as `formatCurrencyAmount`; this wave renames it to the spec's `formatMoney(value, code, locale)` (alias kept) and every renderer imports it. Locale for server documents is a stamped column (`invoices.document_locale`, `quotes.document_locale`) written once at issue/send from `partners.settings.language` via a single `resolvePartnerDocumentLocale` helper; render paths read `row.documentLocale ?? resolvePartnerDocumentLocale(partner)` so drafts and legacy rows still render. The Stripe cache is three new columns on the existing partner-axis `stripe_connect_accounts` row, written at key-save time and refreshed lazily (24h TTL, best-effort) or explicitly (`POST /partner/stripe-connect/refresh`). The checkout warning is computed from the cached column (never a live Stripe call on the pay path) and returned beside the URL only to partner-facing callers.

**Tech Stack:** Hono + Drizzle ORM, hand-written SQL migrations, Vitest (Drizzle-mock unit + real-DB integration on postgres `:5438` / redis `:6388` — `.env.test` is already set for this worktree), pdfkit, React (web + portal), i18next locale catalogs (8 locales, parity-tested).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3777, branch `feature/3772-multi-currency/wave-3777`, worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave5`. Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §9 (formatting & locale), §10 (Stripe), §3 bug table B7. Waves 1–2 are merged into this branch; waves 3 (catalog price books) and 4 (ticketing currency snapshots) are NOT — interim currency sources for catalog/ticket surfaces are called out per task and are shape-compatible with what those waves add.

## Global Constraints

- **No conversion, ever.** Formatting changes the glyphs, never the number. The Stripe mismatch is a warning, never a block and never a recompute.
- **Snapshots rule.** `document_locale` is stamped once (issue for invoices, first send for quotes) and never overwritten — resend, void-and-reissue, clone, and quote→invoice/contract do NOT copy it; the new draft stamps at its own issue/send. No bulk restamp of history (migration adds nullable columns, no backfill).
- **Owner-fixed, never relitigate:** no conversion on billing documents; per-currency price books with explicit gaps (wave 3); match-or-skip rate defaults (wave 4); no bulk restamp.
- **AI-budget `$` stays.** `aiCostTracker.ts`, `clientAiUsage.ts`, `settings.json` `dailyBudget`/`monthlyBudget`, `ai.json:251-252` are provider spend in USD — out of scope.
- **Migrations:** `2026-08-31-<slug>.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`), no inner `BEGIN`/`COMMIT`, no backfill. Confirm with `ls apps/api/migrations | sort | tail` that nothing later-sorting has landed before naming.
- **Export-policy contract fires on new columns:** `invoices`/`quotes` are in `CORE_ORG_CASCADE_DELETE_ORDER`, so `document_locale` MUST be classified in `tenantExportPolicyRegistry.ts` in the same task (Integration-only failure otherwise). `stripe_connect_accounts` has no `org_id` → no cascade/export entry.
- **Lock order untouched.** The `issueInvoice` locale stamp is a pure key addition to the existing guarded `.set({...})` using the `partner` row already read inside the transaction; never read `stripe_connect_accounts` inside `issueInvoice` (partner-axis row, RLS-invisible under org scope, new lock class).
- **No pooled connection across a Stripe round-trip (#1448 / #1105 class).** `runOutsideDbContext` only swaps the ambient `db` proxy — it does NOT release the request transaction the auth middleware opened around the handler (`apps/api/src/middleware/selfManagedDbContextRoutes.ts:1-22` spells this out). Every route that calls Stripe inside its handler must therefore be registered in `SELF_MANAGED_DB_CONTEXT_ROUTES` (so no request transaction is opened at all) and manage its own short `withSystemDbAccessContext` blocks around each DB phase: read → Stripe HTTP call truly outside any context → write in a fresh short context. Today `POST /invoices/:id/pay-link` and `POST /portal/invoices/:id/pay` are registered; `/partner/stripe-connect` is NOT, so the existing `POST /key` probe already runs inside a held transaction (latent). This wave registers `POST /key`, `GET /` (lazy TTL refresh), and the new `POST /refresh` (Task 9) and restructures the service so each DB phase is its own short system context (Task 8). `stripe_connect_accounts` is partner-axis, so a system context is the right scope for those reads/writes (the `:101-110` pre-check already does this).
- **Locale catalogs:** value-only edits are parity-safe; any NEW key or interpolation token added to `en` must be added to all 7 siblings (`apps/web/src/lib/i18n/localeParity.test.ts`).
- **Error codes (new):** `STRIPE_CURRENCY_UNSUPPORTED` (409, partner-facing; customer-facing paths return a generic 409). Warning code: `CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT`.
- Commit after every task; typecheck via the repo's turbo typecheck + targeted tests per task; full unit + integration suites before PR.

---

### Task 1: Shared `formatMoney` + `SUPPORTED_LOCALES`

**Executor:** codex

**Files:**
- Modify: `packages/shared/src/utils/currency.ts:103-113` (rename `formatCurrencyAmount` → `formatMoney`, keep alias)
- Create: `packages/shared/src/utils/locale.ts`, `packages/shared/src/utils/locale.test.ts`
- Modify: `packages/shared/src/utils/index.ts` (add `export * from './locale';`)
- Test: `packages/shared/src/utils/currency.test.ts:47-52`

**Interfaces:**
- Produces: `export function formatMoney(value: string | number | null | undefined, currency: string, locale?: string): string` — `Intl.NumberFormat(locale, { style: 'currency', currency })`; `null`/`undefined`/non-finite → `0`; unknown code → `` `${safe.toFixed(2)} ${CODE}` `` (never throws). `locale` undefined → Intl runtime default (web passes its resolved locale, which may be undefined). `export const formatCurrencyAmount = formatMoney;` (deprecated alias — only the existing test uses it).
- Produces: `export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR'] as const satisfies readonly SupportedLocale[];` and `export function isSupportedLocale(value: unknown): value is SupportedLocale` in `locale.ts` (import the `SupportedLocale` type from `../types`, which defines exactly that union at `packages/shared/src/types/index.ts:17`). The API duplicates this array at `apps/api/src/routes/users.ts:48` and `apps/api/src/routes/orgs.ts:468`; Task 2 switches them to the shared const.

- [ ] **Step 1: Write failing tests.** In `currency.test.ts` add a `formatMoney` block: `formatMoney('1234.5', 'USD', 'en-US') === '$1,234.50'`; `formatMoney('1000.00', 'JPY', 'en-US') === '¥1,000'`; `formatMoney(1234.5, 'EUR', 'de-DE') === '1.234,50 €'`; `formatMoney(888888.88, 'CHF', 'de-CH')` starts with `'CHF'` (prefix-code locale); `formatMoney(-5, 'USD', 'en-US') === '-$5.00'`; `formatMoney(null, 'USD', 'en-US') === '$0.00'`; `formatMoney('abc', 'USD', 'en-US') === '$0.00'`; `formatMoney('12.00', 'ZZ1', 'en-US') === '12.00 ZZ1'`; `formatMoney(5, 'us', 'en-US') === '5.00 US'` (trim+uppercase before the fallback); `formatMoney(1, 'USD', undefined)` does not throw and contains `'1'`; `formatCurrencyAmount === formatMoney`. Create `locale.test.ts`: `SUPPORTED_LOCALES` has 8 entries, includes `'en'` and `'tr-TR'`, `isSupportedLocale('fr-CA') === true`, `isSupportedLocale('fr') === false`, `isSupportedLocale(42) === false`.
- [ ] **Step 2: Run** `pnpm --filter @breeze/shared test currency locale` → FAIL (no `formatMoney` export, no `locale.ts`).
- [ ] **Step 3: Implement** — replace lines 98-113 of `currency.ts` with:

```ts
/**
 * THE money formatter (spec §9 — one formatter everywhere). Intl currency
 * style with a graceful fallback: an invalid/unknown code renders as
 * "12.00 XYZ" instead of throwing. `locale` undefined → the runtime default
 * (the web passes its resolved preference, which may be undefined).
 */
export function formatMoney(value: string | number | null | undefined, currency: string, locale?: string): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  const code = String(currency ?? '').trim().toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(safe);
  } catch {
    return `${safe.toFixed(2)} ${code}`;
  }
}

/** @deprecated use formatMoney — kept so no caller breaks mid-rename. */
export const formatCurrencyAmount = formatMoney;
```

Create `locale.ts`:

```ts
import type { SupportedLocale } from '../types';

/** Runtime twin of the SupportedLocale union (types/index.ts) — the single
 *  source for validators and the document-locale default (#3777). */
export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR'] as const satisfies readonly SupportedLocale[];

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
```

Add `export * from './locale';` to `utils/index.ts`.
- [ ] **Step 4: Run** the two test files → PASS. Run `pnpm --filter @breeze/shared build` (downstream packages consume `dist`).
- [ ] **Step 5: Commit** — `feat(shared): formatMoney (spec name) + SUPPORTED_LOCALES runtime const (#3777)`.

### Task 2: `document_locale` columns, export-policy registration, `resolvePartnerDocumentLocale`

**Executor:** claude

**Files:**
- Create: `apps/api/migrations/2026-08-31-a-document-locale.sql`
- Modify: `apps/api/src/db/schema/invoices.ts:58` (after `sellerSnapshot`), `apps/api/src/db/schema/quotes.ts:77` (after `presentationSnapshot`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:187` (`invoices`), `:254` (`quotes`) — add `"document_locale"` to each `included` array
- Create: `apps/api/src/services/documentLocale.ts`, `apps/api/src/services/documentLocale.test.ts`
- Modify: `apps/api/src/routes/users.ts:48`, `apps/api/src/routes/orgs.ts:468` (replace the local `supportedLocales` const with `SUPPORTED_LOCALES` from `@breeze/shared`)
- Test: `apps/api/src/__tests__/integration/documentLocale.integration.test.ts` (new, column + export-policy assertions)

**Interfaces:**
- Produces: `invoices.documentLocale: varchar('document_locale', { length: 16 })` (nullable, no default) and the same on `quotes`. Null = draft/legacy → render resolves from the partner at render time (Tasks 4–6).
- Produces: `export function resolvePartnerDocumentLocale(partner: { settings?: unknown } | null | undefined): SupportedLocale` — returns `partner.settings.language` when `isSupportedLocale`, else `'en'`. Tolerates `undefined` partner, `null` settings, non-object settings (unit fixtures in `quoteLifecycle.test.ts:324` pass partner rows without `settings`).
- Tenancy contract: both tables are org-scoped (RLS shape 1, already enforced) and in `CORE_ORG_CASCADE_DELETE_ORDER` → the **only** registration step is the export-policy `included` bucket (a 16-char locale tag is ordinary customer data, not an open container). `pnpm db:check-drift` must be clean.

Migration content (exactly this):

```sql
-- Multi-currency wave 5 (#3777, spec §9): render-locale snapshot stamped at
-- issue (invoices) / first send (quotes) from the partner's language setting,
-- so a regenerated PDF never reflows when the partner later switches language.
-- Nullable, no default, NO backfill (owner rule: no bulk restamp of history) —
-- a NULL renders with the partner's live language at render time.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_locale varchar(16);
ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS document_locale varchar(16);
```

- [ ] **Step 1: Write failing tests.** `documentLocale.test.ts`: `{ settings: { language: 'de-DE' } }` → `'de-DE'`; `{ settings: { language: 'xx' } }` → `'en'`; `{ settings: null }` → `'en'`; `{}` → `'en'`; `undefined` → `'en'`. `documentLocale.integration.test.ts` (copy the seed shape from `apps/api/src/services/invoiceService.issue.integration.test.ts:35-72`): insert an invoice and a quote with `documentLocale: 'fr-CA'` inside `withSystemDbAccessContext`, read them back, assert the value round-trips; and assert `information_schema.columns` has `document_locale` on both tables with `character_maximum_length = 16`.
- [ ] **Step 2: Run** — unit FAILS (module missing); integration FAILS (column missing). Also run `pnpm --filter @breeze/api test tenantExportPolicy` after the schema edit in Step 3 to see the `unclassified` failure shape (`apps/api/src/services/tenantExportPolicy.test.ts:55`) before registering.
- [ ] **Step 3: Implement** — migration + the two Drizzle columns (comment: `// Render-locale snapshot, stamped once at issue/send (#3777). NULL = resolve from partner at render.`), the registry entries, and:

```ts
// apps/api/src/services/documentLocale.ts
import { isSupportedLocale, type SupportedLocale } from '@breeze/shared';

/** Partner language → document render locale. Single source for the stamp at
 *  issue/send AND the render-time fallback for unstamped (draft/legacy) rows. */
export function resolvePartnerDocumentLocale(partner: { settings?: unknown } | null | undefined): SupportedLocale {
  const language = (partner?.settings as { language?: unknown } | null | undefined)?.language;
  return isSupportedLocale(language) ? language : 'en';
}
```

Replace the two API-local `supportedLocales` arrays with `import { SUPPORTED_LOCALES } from '@breeze/shared'` (keep the local identifier by `const supportedLocales = SUPPORTED_LOCALES;` if it keeps the diff small — `z.enum(SUPPORTED_LOCALES)` needs the readonly tuple, which the shared const is).
- [ ] **Step 4: Run** `pnpm db:migrate && pnpm db:check-drift` (no drift), `pnpm --filter @breeze/api test documentLocale autoMigrate tenantExportPolicy users orgs` → PASS; integration file → PASS; `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(api): document_locale snapshot columns + export-policy registration (#3777)`.

### Task 3: Stripe account-currency cache columns

**Executor:** codex

**Files:**
- Create: `apps/api/migrations/2026-08-31-b-stripe-account-currency-cache.sql`
- Modify: `apps/api/src/db/schema/stripePayments.ts:23-46` (`stripeConnectAccounts`)
- Test: `apps/api/src/__tests__/integration/stripeAccountCurrencyCache.integration.test.ts` (new)

**Interfaces:**
- Produces three nullable columns on `stripe_connect_accounts`: `default_currency char(3)`, `account_country char(2)`, `account_refreshed_at timestamp` → Drizzle `defaultCurrency: char('default_currency', { length: 3 })`, `accountCountry: char('account_country', { length: 2 })`, `accountRefreshedAt: timestamp('account_refreshed_at')`.
- Tenancy contract (complete — nothing else to register): `stripe_connect_accounts` is a **partner-axis** table (RLS shape 3, policy `breeze_has_partner_access(partner_id)` shipped in `apps/api/migrations/2026-06-16-stripe-payments.sql`, allowlisted at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:235` as `['stripe_connect_accounts','partner_id']`). It has NO `org_id`, so it is in no cascade list and has no export-policy entry — adding columns requires no registry change and no policy change. Do NOT add an FK from `default_currency` to `supported_currencies`: it caches an external fact (Stripe may report a currency outside Breeze's curated list), it is never a document currency.
- Style precedent: `apps/api/migrations/2026-06-21-stripe-partner-api-key.sql` (plain `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on this same table). Migrations are wrapped in a transaction by the runner — no `BEGIN`/`COMMIT`.

Migration content (exactly this):

```sql
-- Multi-currency wave 5 (#3777, spec §10): cache the connected Stripe account's
-- default_currency + country (retrieved when the API key is saved, refreshed
-- on demand / after a TTL) so checkout can warn when a document's currency
-- differs from what the account settles in. A cache of an external fact —
-- deliberately NOT FK'd to supported_currencies. Partner-axis table; RLS and
-- policies already in place (2026-06-16-stripe-payments.sql).
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS default_currency char(3);
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS account_country char(2);
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS account_refreshed_at timestamp;
```

- [ ] **Step 1: Write the failing integration test** — inside `withSystemDbAccessContext` (import `db, withSystemDbAccessContext` from `'../../db'`), insert a partner (`db.insert(partners).values({ name, slug, type: 'msp', plan: 'pro', status: 'active' })`, schema `../../db/schema`), then `db.insert(stripeConnectAccounts).values({ partnerId, stripeAccountId: 'acct_cache_' + suffix, status: 'connected', defaultCurrency: 'EUR', accountCountry: 'DE', accountRefreshedAt: new Date() })`, read back, assert all three; assert `information_schema.columns` lists the three columns. Run with `pnpm --filter @breeze/api test:integration stripeAccountCurrencyCache` (the worktree's `.env.test` points at postgres `:5438`).
- [ ] **Step 2: Run** → FAIL (columns missing / Drizzle type error).
- [ ] **Step 3: Implement** the migration and the three Drizzle columns (place after `livemode`, with the comment `// Cached connected-account facts (#3777 §10); null until the key is saved under wave 5.`).
- [ ] **Step 4: Run** `pnpm db:migrate && pnpm db:check-drift` → no drift; integration test → PASS; `pnpm --filter @breeze/api test autoMigrate` → PASS.
- [ ] **Step 5: Commit** — `feat(api): cache Stripe account default_currency/country on stripe_connect_accounts (#3777)`.

### Task 4: Invoice PDF + email adopt the shared formatter with a threaded locale

**Executor:** claude

**Files:**
- Modify: `apps/api/src/services/invoicePdf.ts:37-47` (`InvoiceBranding` + `locale`), `:53-58` (delete private `formatMoney`), `:114` (`renderInvoiceHtml`), `:228-231` (`renderInvoicePdfBuffer`), `:282-286` (column widths), `:389-421` (`loadInvoiceForRender`), `:534-547` (`buildInvoiceEmailAmounts`), `:659` (its call site)
- Test: `apps/api/src/services/invoicePdf.test.ts` (extend), `apps/api/src/services/invoicePdf.integration.test.ts` (re-run)

**Interfaces:**
- Produces: `InvoiceBranding.locale?: string | null` (resolved render locale). `renderInvoiceHtml` / `renderInvoicePdfBuffer` compute `const locale = invoice.documentLocale ?? branding.locale ?? 'en';` beside the existing `currency` and call `formatMoney(v, currency, locale)` from `@breeze/shared` at every former `formatMoney` site (`:139,:146,:197-201`, `:319,:322,:338`).
- Produces: `buildInvoiceEmailAmounts(inv: { total; depositDue; amountPaid; balance; currencyCode: string | null; documentLocale?: string | null }, locale?: string)` — locale precedence `inv.documentLocale ?? locale ?? 'en'`; the `:659` call site passes `resolvePartnerDocumentLocale(partner)` (the `deliverInvoiceEmail` partner select at `:616` must add `settings: partners.settings`).
- `loadInvoiceForRender` adds `locale: invoice.documentLocale ?? resolvePartnerDocumentLocale(partner)` to the returned branding (the full `partners` row is already selected at `:393`). No signature change for `renderInvoicePdf` callers (`jobs/invoiceWorker.ts:61`, `routes/invoicesPublic.ts:170`, `routes/portal/invoices.ts:126`, `routes/invoices/pdf.ts:28`).
- PDF width headroom (line rows): Intl prefix-code output (`CHF 888,888.88` ≈ 73pt at Helvetica 10) exceeds the taxed `colNumW = contentWidth * 0.15` (≈ 74pt on A4, < 2pt margin). Rebalance the taxed layout to `colDescW 0.44`, `colQtyX 0.46`, `colTaxX 0.64`, `colAmtX 0.83`, `colNumW 0.17`; untaxed stays `0.18` / `0.62` / `0.80` / `0.60`. The test in Step 1 is the arbiter — tune until it passes.
- PDF width headroom (totals block): `drawTotal` (`:332-340`) draws the emphasised total at **Helvetica-Bold 14** into the same `colNumW` box the 10pt line rows use — `CHF 1’000’000.00` at bold 14 is ≈ 100pt, far over 0.17 × 495 ≈ 84pt (even `$1,000,000.00` is tight today). Give the totals their own box the way `quotePdf` already does with `colSummaryNumW`: `const colSummaryNumW = contentWidth * 0.22; const colSummaryAmtX = right - colSummaryNumW;`, draw the amount in `drawTotal` at `colSummaryAmtX` with `width: colSummaryNumW`, and compute `labelW = colSummaryAmtX - labelX - 4`. Widen to `0.24` if the bold-14 measurement in Step 1(e) still fails — never shrink the font. Export the fractions as `invoiceColumnsFor(doc, showTax)` (mirroring `quotePdf.columnsFor`) so the tests measure the real numbers instead of literals.

- [ ] **Step 1: Write failing tests** in `invoicePdf.test.ts`: (a) `renderInvoiceHtml` with `currencyCode: 'EUR'`, `documentLocale: 'de-DE'` contains `'1.000,00 €'` (fixture total `1000.00`); (b) `documentLocale: null` + `branding.locale: 'fr-FR'` renders French formatting (`'1 000,00 €'`); (c) `buildInvoiceEmailAmounts({ …, currencyCode: 'JPY', documentLocale: 'en' })` → `total === '¥1,000'`; (d) width: build a `PDFDocument({ size: 'A4', margin: 50 })`, `const c = invoiceColumnsFor(doc, true)` / `(doc, false)`, `doc.font('Helvetica').fontSize(10)`, assert `c.colNumW >= doc.widthOfString(formatMoney(888888.88, 'CHF', 'de-CH')) + 2` for both layouts (mirror the `quotePdf.test.ts:125-135` measurement style); (e) totals: `doc.font('Helvetica-Bold').fontSize(14)`, assert `c.colSummaryNumW >= doc.widthOfString(formatMoney(1000000, 'CHF', 'de-CH')) + 2` and `c.colSummaryAmtX + c.colSummaryNumW ≈ right`. Existing USD/`$` assertions (`:92-94,:107,:178-200`) must stay green unchanged — Intl `en-US` USD output is byte-identical.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test invoicePdf` → new cases FAIL.
- [ ] **Step 3: Implement** — delete the private formatter, `import { formatMoney } from '@breeze/shared'`, `import { resolvePartnerDocumentLocale } from './documentLocale'`, thread `locale` as specified, rebalance the taxed columns and add the totals box (update the `:280-282` comment: money columns are sized for prefix-code currencies, and totals have their own wider box for the bold-14 emphasis row). Keep `InvoiceRow` typed from the schema so `documentLocale` is available without a cast.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test invoicePdf` + `invoicePdf.integration.test.ts` + `email.test.ts` + `routes/invoices` + `routes/portal/invoices` → PASS.
- [ ] **Step 5: Commit** — `feat(api): invoice PDF/email render money via shared formatMoney with a stamped/resolved locale (#3777)`.

### Task 5: Quote PDF, branding, and route render sites adopt the formatter; money-column headroom

**Executor:** claude

**Files:**
- Modify: `apps/api/src/services/quotePdf.ts:32-37` (`formatMoney` export → delegating, new signature), `:84-95` (`QuotePdfBranding.locale`), `:97-103` (`QuoteHeader.documentLocale`), `:211-242` (`columnsFor`), `:435,:438,:442,:458-460,:532-534,:594` (call sites), `:772` (the `currency` const inside `renderQuotePdf`, which starts at `:758` — add `locale` beside it)
- Modify: `apps/api/src/services/quoteBranding.ts:20-38` (`QuoteBranding.locale: string`), `:45-57` (`QuoteBrandingSource.documentLocale: string | null`), `:95` (resolve)
- Modify: `apps/api/src/routes/portal/quotes.ts:113-123` (partner select adds `settings: partners.settings`), `:153-157` (branding adds `locale`)
- Modify: `apps/api/src/services/quoteLifecycle.ts:406-411` (`emailBranding` adds `locale: frozenQuote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow)`)
- Test: `apps/api/src/services/quotePdf.test.ts:118-140` (extend width test), `quotePdf.classicRegression.test.ts` (re-run), `routes/portal/quotes.test.ts`, `quoteBranding.test.ts` if present (grep)

**Interfaces:**
- Produces: `export function formatMoney(amount: string | number | null | undefined, currency: string, locale?: string): string` in `quotePdf.ts` — body is `return sharedFormatMoney(amount, currency, locale);` (import `{ formatMoney as sharedFormatMoney } from '@breeze/shared'`). Export name kept because `contractTemplateRender.ts:26` and `routes/portal/quotes.test.ts` import it; Task 6b moves contractTemplateRender to the shared import directly, after which this re-export is only a compatibility shim.
- Produces: `QuotePdfBranding.locale?: string | null`; `QuoteHeader.documentLocale?: string | null`; `renderQuotePdf` computes `const locale = quote.documentLocale ?? branding.locale ?? 'en';` beside `currency` and passes it to every `formatMoney` call.
- Produces: `resolveQuoteBranding` returns `locale: quote.documentLocale ?? resolvePartnerDocumentLocale(partner)` (the full partner row is already selected at `:60-64`). Callers `routes/quotes/quotes.ts:100,:270` pass the Drizzle quote row, which has `documentLocale` after Task 2 — no call-site change.
- Column headroom (A4 is the narrower page; `contentWidth = 495.28`): money cells draw with `lineBreak: false`, so overflow overprints. The existing width test (`quotePdf.test.ts:108-135`) asserts `colDescW >= 0.48` (taxed) / `>= 0.55` (untaxed) — a prefix-code layout cannot satisfy 0.48 on the taxed page (`0.08 + 2 × 0.155 + 0.19` leaves 0.42 for the description), so the taxed assertion is **deliberately relaxed to `>= 0.42`** with a comment naming `CHF 888,888.88`; the untaxed `0.55` floor still holds. Rebalance `columnsFor` (current values at `:211-246`):
  - taxed: `colQtyW 0.07`, `colDescX 0.08`, `colDescW 0.42`, `colUnitX 0.50`, `colNumW 0.155`, `colTaxX 0.655`, `colAmtX 0.81`, `colAmtW 0.19`, `colSummaryAmtX 0.78`, `colSummaryNumW 0.22`
  - untaxed: `colQtyW 0.07`, `colDescX 0.08`, `colDescW 0.57` (unchanged), `colUnitX 0.65`, `colNumW 0.16`, `colAmtX 0.81`, `colAmtW 0.19`, `colSummaryAmtX 0.78`, `colSummaryNumW 0.22`
  Arithmetic check: `CHF 888,888.88` at Helvetica 10 ≈ 73pt → `colNumW >= 0.152`; with `/mo` ≈ 90pt → `colAmtW >= 0.186`; `CHF 1’000’000.00` at Helvetica-Bold 14 ≈ 100pt → `colSummaryNumW >= 0.206`. The widened summary box must still leave the summary label box wide enough for its widest bold-12 label — the existing assertion in the same test guards it. The Step 1 measurements are the arbiter; if any fails, widen the money box (and shrink the description) rather than shrinking the font.

- [ ] **Step 1: Extend the width test** (`quotePdf.test.ts:108-135`): change the taxed `colDescW` floor from `0.48` to `0.42` (comment: prefix-code currencies need 0.155/0.155/0.19 money boxes), keep the untaxed `0.55`; alongside the `$` strings assert, for both layouts, `colNumW >= widthOf(formatMoney(888888.88, 'CHF', 'de-CH')) + 2`, `colAmtW >= widthOf(formatMoney(888888.88, 'CHF', 'de-CH') + '/mo') + 2`, and at Helvetica-Bold 14 `colSummaryNumW >= widthOf(formatMoney(1000000, 'CHF', 'de-CH')) + 2`; keep `colAmtX + colAmtW ≈ right` and `colSummaryAmtX + colSummaryNumW ≈ right`. Add a render test: quote fixture with `currencyCode: 'EUR'`, `documentLocale: 'de-DE'`, a line `12000.00` → positioned text contains `'12.000,00 €'`; and `documentLocale: null` + `branding.locale: 'pt-BR'` → `'R$ 12.000,00'`.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test quotePdf` → width + locale cases FAIL.
- [ ] **Step 3: Implement** the formatter delegation, the branding/header fields, `columnsFor` rebalance (update the `:200-210` comment block: boxes are sized for prefix-code currencies like `CHF 888,888.88`), `resolveQuoteBranding.locale`, the portal route's partner select + branding, and `quoteLifecycle`'s `emailBranding.locale`.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test quotePdf quoteBranding routes/portal/quotes routes/quotes quoteLifecycle contractTemplateRender` → PASS (the classic-regression PDF operator fixtures are USD-only; if the column rebalance shifts x-offsets in those fixtures, regenerate them per that file's header instructions and commit the new fixtures in the same commit).
- [ ] **Step 5: Commit** — `feat(api): quote PDF renders via shared formatMoney with stamped/resolved locale; money columns sized for prefix-code currencies (#3777)`.

### Task 6a: `quoteLifecycle` email total uses the shared formatter

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts:32-36` (delete `formatMoneyish`), `:427` (call site)
- Test: `apps/api/src/services/quoteLifecycle.test.ts` (re-run; add one assertion)

**Interfaces:**
- Consumes: `formatMoney(value, currency, locale)` from `@breeze/shared` (Task 1) and `resolvePartnerDocumentLocale(partner)` from `./documentLocale` (Task 2; signature `(partner: { settings?: unknown } | null | undefined) => string`, returns `'en'` for a missing/invalid language).
- Produces: at `:427` `total: formatMoney(quote.total, quote.currencyCode, frozenQuote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow))` — `frozenQuote` and `partnerRow` are both in scope inside `deliverQuoteEmail` (destructured at `:343`); `quotes.documentLocale` exists on the Drizzle row type after Task 2.
- Self-contained context: `formatMoneyish` is a private 4-line helper (`toLocaleString('en-US')`, `$` only for USD, `"1,234.50 EUR"` otherwise). `buildQuoteTemplate` (`./quoteEmail`) takes the pre-formatted string and is unchanged. The test file keeps `quotePdf`'s real formatter via `importOriginal` (`:52-56`) and mocks `partnerRow` as `{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null }` (no `settings`), which the helper tolerates.

- [ ] **Step 1: Write the failing assertion** — in the existing send-path test that inspects the email template input (grep `buildQuoteTemplate` / `total:` in `quoteLifecycle.test.ts`), change the quote fixture to `currencyCode: 'EUR'` with `total: '1200.00'` and a partnerRow `settings: { language: 'de-DE' }`; expect the template `total` to be `'1.200,00 €'` (currently `'1,200.00 EUR'`).
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test quoteLifecycle` → FAIL.
- [ ] **Step 3: Implement** — delete `formatMoneyish` and its doc comment, add `import { formatMoney } from '@breeze/shared';` and `import { resolvePartnerDocumentLocale } from './documentLocale';`, update `:427`.
- [ ] **Step 4: Run** → PASS (all other cases keep USD/en output byte-identical).
- [ ] **Step 5: Commit** — `refactor(api): quote email total via shared formatMoney (#3777)`.

### Task 6b: `contractTemplateRender` totals use the shared formatter with the document's resolved locale

**Executor:** claude

**Files:**
- Modify: `apps/api/src/services/contractTemplateRender.ts:26` (import), `:86-92` (`loadContractBlockRenderData` — unchanged), `:277-298` (`resolveAutoVariables`), `:477-482` (`renderContractBlocksForClient`), `:542-551` (`loadContractPdfInputs`)
- Modify callers (pass the resolved locale): `apps/api/src/services/quoteLifecycle.ts:399` (`loadContractPdfInputs(blocks, frozenQuote, emailBranding.locale)` — Task 5 adds `locale` to `emailBranding`), `apps/api/src/routes/quotes/quotes.ts:105,:316`, `apps/api/src/routes/portal/quotes.ts:73,:148`, `apps/api/src/routes/quotesPublic.ts:73`
- Test: `apps/api/src/services/contractTemplateRender.test.ts:130-145` (extend); re-run `routes/quotes`, `routes/portal/quotes`, `routes/quotesPublic`, `quoteLifecycle`

**Interfaces:**
- Consumes: `formatMoney(value, currency, locale)` from `@breeze/shared`; `resolvePartnerDocumentLocale` from `./documentLocale` (Task 2); `QuoteBranding.locale` / `QuotePdfBranding.locale` (Task 5).
- Produces: `resolveAutoVariables(quote: QuoteRow, opts?: { effectiveDate?: string | Date; locale?: string | null })` — `const locale = quote.documentLocale ?? opts?.locale ?? 'en';` and formats `totals.one_time/monthly/annual/total` with `formatMoney(x, currency, locale)`. `renderContractBlocksForClient(blocks, quote, fileUrlFor, locale?: string | null)` and `loadContractPdfInputs(blocks, quote, locale?: string | null)` forward `locale` into `resolveAutoVariables`. Rule (same as the PDFs): a stamped `documentLocale` always wins; an unstamped draft preview uses the partner's CURRENT language (the `locale` the caller resolved for the surrounding quote PDF/detail), so contract totals never disagree with the quote totals on the same page; `'en'` only when the caller has nothing (unit tests, legacy callers).
- Callers pass what they already resolved for the quote: `routes/quotes/quotes.ts:105` already has `branding` from `resolveQuoteBranding(detail.quote)` three lines above (`:102`) — pass `branding.locale`; `:316` and `routes/portal/quotes.ts:148` likewise have `branding` from Task 5 — pass `branding.locale`; `routes/portal/quotes.ts:73` and `routes/quotesPublic.ts:73` serve sent quotes (stamped) — pass `quote.documentLocale` (no partner read needed; `null` → `'en'` only for pre-wave-5 sent quotes, which also rendered `en` before). Change the `:26` import to `import { formatDate, contractUploadedMarker, type ContractPdfBlockData } from './quotePdf';` + `import { formatMoney } from '@breeze/shared';`. Update the `:277-279` doc comment accordingly.
- `QuoteRow` is `typeof quotes.$inferSelect` (`:53`) and carries `documentLocale: string | null` after the schema change.

- [ ] **Step 1: Write failing tests** — fixture quote with `currencyCode: 'EUR'`, `documentLocale: 'de-DE'`, `oneTimeTotal: '810.00'` → `'totals.one_time' === '810,00 €'`; same fixture with `documentLocale: null` and `opts.locale: 'fr-FR'` → `'810,00 €'` (fr spacing: `'810,00 €'`); `documentLocale: null`, no `opts.locale` → `'€810.00'` (en); `documentLocale: 'de-DE'` + `opts.locale: 'fr-FR'` → the stamp wins (`'810,00 €'` de). Existing `'$810.00'` / `'$0.00'` assertions (`:138-141`) stay (USD fixture, null locale → en). Route tests: `routes/quotes/quotes.test.ts` detail case asserts `renderContractBlocksForClient` is called with the resolved locale (spy via `vi.mock('../../services/contractTemplateRender')`).
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test contractTemplateRender routes/quotes` → FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test contractTemplateRender routes/quotes routes/portal/quotes routes/quotesPublic quoteLifecycle` → PASS.
- [ ] **Step 5: Commit** — `refactor(api): contract template totals via shared formatMoney with the document's resolved locale (#3777)`.

### Task 7: Stamp `document_locale` at invoice issue and quote send

**Executor:** claude

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:893-915` (`issueInvoice` guarded `.set`), `:1154-1158` (reissue comment), `:427-436` (`getInvoice` — no change here; listed so the executor confirms `documentLocale` is returned implicitly by `select()`)
- Modify: `apps/api/src/services/quoteLifecycle.ts:195-214` (`sendQuote` claim `.set`), `:233-242` (`frozenQuote`)
- Modify: `apps/api/src/services/quoteAcceptService.ts:244-272` (the accept path ISSUES the converted invoice inline — `issueFields.status = 'sent'` at `:264`, with `sellerSnapshot` copied from the quote at `:269` — it never goes through `issueInvoice`, so it must stamp `document_locale` itself; partner select at `:245-247` adds `settings: partners.settings`)
- Modify (comments only, behaviour unchanged — verify no locale copy): `apps/api/src/services/quoteService.ts:499-530` (`cloneQuote`, `sellerSnapshot: null` at `:529`), `apps/api/src/services/quoteAcceptService.ts:172-181` (the draft insert — no copy), `:318-326` (quote→contract — contracts have no locale column)
- Test: `apps/api/src/services/invoiceService.test.ts` (issue `.set` assertions), `apps/api/src/services/quoteLifecycle.test.ts` (claim `.set` assertions), `apps/api/src/__tests__/integration/documentLocaleStamping.integration.test.ts` (new)

**Interfaces:**
- Produces: `issueInvoice` adds `documentLocale: inv.documentLocale ?? resolvePartnerDocumentLocale(partner)` to the `:895` `.set({...})`. `partner` is the row already read at `:874` inside the transaction (after all locks — the B10 order `invoice → lines → contracts → contract_lines → time_entries → ticket_parts` is untouched; this is a key addition with no new reads and no new lock class).
- Produces: `sendQuote` adds `documentLocale: quote.documentLocale ?? resolvePartnerDocumentLocale(partnerRow)` to the claim `.set` (`partnerRow` read at `:130`) and includes `documentLocale` in `frozenQuote` (`:233-242`) so the same-request PDF + email (Tasks 5, 6a) render with the stamped value. `resendQuote` (`:638`) never writes the column.
- Produces: quote accept (`quoteAcceptService.ts:244-272`) sets `issueFields.documentLocale = quote.documentLocale ?? resolvePartnerDocumentLocale(partner)` inside the existing `if (oneTime.length > 0)` block (the invoice is issued at that moment, so that IS its issue-time stamp; the accepted quote's locale is the natural value — the same rule `sellerSnapshot` follows one line below). When `oneTime.length === 0` the invoice stays a draft and stamps at its own later `issueInvoice`.
- Invariant: never overwrite — the `??` on the existing row value means a draft cloned from a sent quote (which `cloneQuote` does NOT copy — `documentLocale` stays null on the clone, comment it) or a reissued draft (`voidInvoice` insert at `:1158` does NOT copy — add to the existing comment: "document_locale is likewise NOT copied: it is an issue-time snapshot, restamped when this draft issues") stamps fresh from the partner's language at its own issue/send.

- [ ] **Step 1: Write failing tests.** Unit: in `invoiceService.test.ts` issue suite, partner mock row gains `settings: { language: 'fr-CA' }`; assert the guarded update payload includes `documentLocale: 'fr-CA'`; a second case with the draft already carrying `documentLocale: 'de-DE'` asserts `'de-DE'` survives. In `quoteLifecycle.test.ts` send suites (`queueSendPath` at `:723`), partnerRow `settings: { language: 'it-IT' }` → claim `.set` includes `documentLocale: 'it-IT'`; partnerRow without `settings` → `'en'`. Integration `documentLocaleStamping.integration.test.ts` (seed per `invoiceService.issue.integration.test.ts:35-72`, partner `settings: { language: 'pt-BR' }`): (a) draft → `issueInvoice` → row `documentLocale === 'pt-BR'`; (b) partner language changed to `'de-DE'` afterwards → `renderInvoicePdf` still formats as `pt-BR` (assert the PDF text contains `'R$'`... the fixture is a `BRL` org, total `1000.00` → `'R$ 1.000,00'` in extracted text) and the column is unchanged; (c) `voidInvoice(..., { reissue: true })` → new draft has `documentLocale === null`; issuing it stamps `'de-DE'`; (d) quote: `sendQuote` stamps `'pt-BR'`, `resendQuote` after the language change leaves it `'pt-BR'`, `cloneQuote` → null; (e) accept a sent quote with a one-time line (seed per `quoteAcceptService.integration.test.ts` if present, else the route-level accept test's seed) after the partner language changed to `'de-DE'` → the converted invoice is `status 'sent'` with `documentLocale === 'pt-BR'` (the quote's stamp, not the partner's current language). Unit: `quoteAcceptService.test.ts` asserts the `issueFields` update payload carries `documentLocale`.
- [ ] **Step 2: Run** — unit payload assertions FAIL (no key); integration FAILS (null column).
- [ ] **Step 3: Implement** the two `.set` additions, the accept-path `issueFields.documentLocale` + widened partner select, the `frozenQuote` field, and the three comments.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test invoiceService quoteLifecycle quoteService quoteAcceptService` + the new integration file + `invoiceService.issue.integration.test.ts` + `invoiceIssueRace.integration.test.ts` (lock order regression) → PASS.
- [ ] **Step 5: Commit** — `feat(api): stamp document_locale at invoice issue / quote send; never restamped (#3777)`.

### Task 8: Stripe cache service — capture on save, status fields, refresh, TTL, error mapping

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/partnerStripe.ts` (whole file is 228 lines; edits at `:36-38`, `:47-51`, `:56-63`, `:118-146`, `:167`, `:176-201`, `:209-219`)
- Context (B1, read before editing): after Task 9 registers `/partner/stripe-connect` routes as self-managed, these handlers run with NO ambient DB context. Every DB touch in this file that those routes reach must therefore sit inside its own short `withSystemDbAccessContext` (partner-axis table → system scope is correct; the `:101-110` pre-check is the precedent), and every Stripe HTTP call must sit outside any context. Callers that still run inside a request transaction (`invoiceCheckout.ts:77-80` already wraps `getPartnerStripeClient` in `runOutsideDbContext(() => withSystemDbAccessContext(...))`) are unaffected.
- Create: `apps/api/src/services/stripeCheckoutErrors.ts`, `apps/api/src/services/stripeCheckoutErrors.test.ts`
- Modify: `apps/api/src/services/invoiceTypes.ts:27-57` (add `| 'STRIPE_CURRENCY_UNSUPPORTED'` after `'STRIPE_INIT_FAILED'`)
- Test: `apps/api/src/services/partnerStripe.test.ts` (extend; fixture at `:83` `accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit' })` lacks `default_currency`/`country` → must map to `null`)

**Interfaces (all in `partnerStripe.ts` unless noted):**
- `savePartnerStripeKey(input): Promise<{ stripeAccountId: string; last4: string; livemode: boolean; defaultCurrency: string | null; accountCountry: string | null; accountRefreshedAt: Date }>` — from the existing `accounts.retrieve()` result capture `const defaultCurrency = account.default_currency ? account.default_currency.toUpperCase() : null; const accountCountry = account.country ?? null;` and write `defaultCurrency, accountCountry, accountRefreshedAt: now` in BOTH the `.values({...})` (`:121-132`) and the `.onConflictDoUpdate.set({...})` (`:135-145`). Move that upsert (and its 23505 catch, `:147-167`) into `runOutsideDbContext(() => withSystemDbAccessContext(async () => { ... }))` — the route no longer opens a request transaction (Task 9), so the write needs its own context; as a bonus the 23505 mapping can no longer be clobbered at commit by an outer transaction (the `#2189` comment's consequence 2 disappears — update that comment, keep the pre-check). The Drizzle columns `defaultCurrency`, `accountCountry`, `accountRefreshedAt` exist on `stripeConnectAccounts` (Task 3).
- `PartnerStripeStatus` connected arm gains `defaultCurrency: string | null; accountCountry: string | null; accountRefreshedAt: Date | null`; `getPartnerStripeStatus` returns them from the row.
- `getPartnerStripeClient(partnerId): Promise<{ stripe: Stripe; stripeAccountId: string; defaultCurrency: string | null }>` — add `defaultCurrency: stripeConnectAccounts.defaultCurrency` to the `:178` select and return it; signature and context behaviour otherwise unchanged (callers wrap it) (the checkout warning reads this — no second query on the pay path, and no refresh on the pay path: a stale value only makes the warning stale).
- `export const STRIPE_ACCOUNT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;`
- `export async function refreshPartnerStripeAccount(partnerId: string): Promise<{ defaultCurrency: string | null; accountCountry: string | null; accountRefreshedAt: Date }>` — `const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId))` (propagates `NO_STRIPE_KEY` / `STRIPE_KEY_UNREADABLE` as-is), then `const account = await runOutsideDbContext(() => (stripe.accounts.retrieve as unknown as () => Promise<Stripe.Account>)())` — the HTTP call runs outside any DB context (the `:101-110` / `invoiceCheckout.ts:100-102` pattern: never hold a pooled connection across the Stripe round-trip). Map a thrown Stripe error exactly like `:64-77` (transient types → message "Could not reach Stripe right now — try again in a moment.", else "Stripe rejected the stored key — reconnect Stripe.") as `PartnerStripeError(..., 'INVALID_STRIPE_KEY')`. Then `withSystemDbAccessContext(() => db.update(stripeConnectAccounts).set({ defaultCurrency, accountCountry, accountRefreshedAt: now, updatedAt: now }).where(eq(stripeConnectAccounts.partnerId, partnerId)))` and return the three values.
- `getPartnerStripeStatus` and `disconnectPartnerStripe` keep their bodies but are called by Task 9 from inside `withSystemDbAccessContext` (route-level wrap) — no change here.
- `export async function getStripeAccountCurrency(partnerId: string): Promise<{ defaultCurrency: string | null; accountCountry: string | null; accountRefreshedAt: Date | null; stale: boolean }>` — reads the row inside `withSystemDbAccessContext` (`select({ defaultCurrency, accountCountry, accountRefreshedAt, status })`); not connected → all null, `stale: false`; `stale = accountRefreshedAt === null || Date.now() - accountRefreshedAt.getTime() > STRIPE_ACCOUNT_CACHE_TTL_MS`; when stale, `try { return { ...(await refreshPartnerStripeAccount(partnerId)), stale: false }; } catch (err) { console.warn('[partnerStripe] account cache refresh failed — serving stale value', { partnerId, message }); return { …cached, stale: true }; }`. Callers: the GET status route (Task 9) and the web-facing invoice/quote warning (Task 10) — never the checkout hot path.
- `stripeCheckoutErrors.ts`:

```ts
import { InvoiceServiceError } from './invoiceTypes';

/** True when a Stripe error from checkout.sessions.create is a currency the
 *  connected account cannot present/settle (spec §10 friendly mapping). */
export function isStripeCurrencyUnsupportedError(err: unknown): boolean {
  const e = err as { type?: string; code?: string; param?: string; message?: string } | null;
  if (!e || e.type !== 'StripeInvalidRequestError') return false;
  if (e.code === 'currency_not_supported') return true;
  if (typeof e.param === 'string' && /currency/i.test(e.param)) return true;
  return typeof e.message === 'string' && /currenc/i.test(e.message);
}

/** Partner-facing mapping. Returns null for anything that is not a currency failure
 *  so the caller rethrows the original error untouched. */
export function mapStripeCheckoutError(err: unknown, currency: string): InvoiceServiceError | null {
  if (!isStripeCurrencyUnsupportedError(err)) return null;
  const code = currency.toUpperCase();
  return new InvoiceServiceError(
    `Your Stripe account cannot accept payments in ${code}. Enable ${code} in your Stripe Dashboard (Settings → Payments → Currencies) or record this payment manually.`,
    409,
    'STRIPE_CURRENCY_UNSUPPORTED',
  );
}

/** Customer-safe wording for portal/public callers (never leaks account setup detail). */
export const CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE = 'Online payment is not available for this invoice — please contact the sender.';
```

- `InvoiceServiceError` (`invoiceTypes.ts:59-68`) is `new InvoiceServiceError(message, status: 400|403|404|409|500, code?: InvoiceServiceErrorCode)`.

- [ ] **Step 1: Write failing tests.** `partnerStripe.test.ts`: (a) `accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'eur', country: 'DE' })` → `savePartnerStripeKey` resolves with `defaultCurrency: 'EUR'`, `accountCountry: 'DE'`, `accountRefreshedAt` a `Date`; `dbMocks.insertedValues[0]` and `dbMocks.upsertConfigs[0].set` both include `defaultCurrency: 'EUR'`, `accountCountry: 'DE'`; (b) the existing `{ id: 'acct_unit' }` fixture → both `null` (update the `:92` `toEqual` to the new shape); (c) `getPartnerStripeStatus` with a connected row carrying the three columns returns them; (d) `refreshPartnerStripeAccount`: queue a connected row (`apiKey: 'enc(sk_test_x)'`, `status: 'connected'`, `stripeAccountId`), `accountsRetrieveMock` → `{ id, default_currency: 'gbp', country: 'GB' }` → resolves `{ defaultCurrency: 'GBP', accountCountry: 'GB', accountRefreshedAt }`; extend the `db` mock with an `update: vi.fn(() => ({ set: vi.fn((vals) => { dbMocks.updatedValues.push(vals); return { where: vi.fn(() => Promise.resolve()) }; }) }))` and assert the update payload; `accountsRetrieveMock.mockRejectedValue({ type: 'StripeConnectionError' })` → rejects `PartnerStripeError` and NO update is issued; (e) `getStripeAccountCurrency`: fresh row (`accountRefreshedAt: new Date()`) → returns cached, `stale: false`, `accountsRetrieveMock` not called; row with `accountRefreshedAt` 25h ago → refresh attempted, returns refreshed values; 25h-old row + retrieve rejects → returns the cached values with `stale: true`. `stripeCheckoutErrors.test.ts`: `{ type: 'StripeInvalidRequestError', code: 'currency_not_supported' }` → mapped 409 `STRIPE_CURRENCY_UNSUPPORTED` with message containing `'CHF'` for `currency 'chf'`; `{ type: 'StripeInvalidRequestError', param: 'line_items[0][price_data][currency]' }` → mapped; `{ type: 'StripeInvalidRequestError', message: 'Invalid currency: xyz' }` → mapped; `{ type: 'StripeCardError' }` → `null`; `new Error('boom')` → `null`.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test partnerStripe stripeCheckoutErrors` → FAIL.
- [ ] **Step 3: Implement** everything in the Interfaces block. Keep all existing error messages and the `#2189` pre-check logic byte-identical.
- [ ] **Step 4: Run** → PASS; also `pnpm --filter @breeze/api test invoiceCheckout routes/portal/invoices routes/stripeConnect` (the widened `getPartnerStripeClient` return is additive; these must stay green untouched). The `partnerStripe.test.ts` `db` mock must also stub `withSystemDbAccessContext`/`runOutsideDbContext` as pass-throughs (`vi.mock('../db', ...)` already exists at the top of that file — extend it) and assert `savePartnerStripeKey` performs the upsert inside them (spy call order: pre-check → upsert).
- [ ] **Step 5: Commit** — `feat(api): cache Stripe account currency/country at key save; refresh + TTL re-check; checkout currency error mapping (#3777)`.

### Task 9: `stripe-connect` routes expose the cache and add `POST /refresh`

**Executor:** codex

**Files:**
- Modify: `apps/api/src/routes/stripeConnect/index.ts:34-65` (POST /key — wrap the DB-touching service calls, response gains the three fields), `:68-83` (GET — wrap + lazy refresh), new `POST /refresh` handler after GET
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts:31-33` (add three entries next to the pay-link ones: `{ method: 'POST', pattern: /^\/api\/v1\/partner\/stripe-connect\/key\/?$/ }`, `{ method: 'GET', pattern: /^\/api\/v1\/partner\/stripe-connect\/?$/ }`, `{ method: 'POST', pattern: /^\/api\/v1\/partner\/stripe-connect\/refresh\/?$/ }` — each with a one-line comment naming the Stripe call it protects; `DELETE /` stays on the normal request transaction, it never calls Stripe)
- Test: `apps/api/src/routes/stripeConnect/index.test.ts` (extend; mocks at `:81-83` and `:121`), `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts` (add the three paths to `MATCH`, with and without trailing slash, and `DELETE /api/v1/partner/stripe-connect` to the non-match list)

**Interfaces:**
- Consumes (Task 8, `../../services/partnerStripe`): `savePartnerStripeKey` now resolves `{ stripeAccountId, last4, livemode, defaultCurrency, accountCountry, accountRefreshedAt }`; `getPartnerStripeStatus` connected arm carries `defaultCurrency, accountCountry, accountRefreshedAt`; `getStripeAccountCurrency(partnerId)` → `{ defaultCurrency, accountCountry, accountRefreshedAt, stale }` (lazy TTL refresh, never throws); `refreshPartnerStripeAccount(partnerId)` → `{ defaultCurrency, accountCountry, accountRefreshedAt }` (throws `PartnerStripeError` with `.status` 400/409/500 and `.message`).
- Context handling (B1): once registered as self-managed these handlers have NO ambient DB context, so every service call that touches the DB but does not manage its own context is wrapped at the route: GET → `const status = await runOutsideDbContext(() => withSystemDbAccessContext(() => getPartnerStripeStatus(auth.partnerId)))`; POST `/key` → `savePartnerStripeKey` manages its own phases after Task 8 (call it bare); `POST /refresh` → `refreshPartnerStripeAccount` manages its own phases (call it bare); `getStripeAccountCurrency` manages its own (call it bare). Import `runOutsideDbContext, withSystemDbAccessContext` from `'../../db'`. `writeRouteAudit` already works from a self-managed route (precedent: `routes/accounting/customers.ts`, registered at `selfManagedDbContextRoutes.ts:39-40`). `stripe_connect_accounts` is partner-axis and the handler has already passed `requirePermission` + the `auth.partnerId` guard, so the system-scope read returns only this partner's row by `where`.
- Produces: POST `/key` and GET `/` connected responses gain `defaultCurrency: string | null`, `accountCountry: string | null`, `accountRefreshedAt: string | null` (ISO via `toISOString()`; null stays null). GET calls `getStripeAccountCurrency(auth.partnerId)` after `getPartnerStripeStatus` when connected and responds with the (possibly refreshed) values — a stale cache self-heals on the settings page load, and because the route is self-managed the Stripe round-trip inside that refresh holds no pooled connection.
- Produces: `POST /refresh` — `requirePermission(PERMISSIONS.BILLING_MANAGE…)`, **no** `requireMfa()` (read-only against Stripe, writes only cache columns), no body; calls `refreshPartnerStripeAccount(auth.partnerId)`; `writeRouteAudit(c, { orgId: null, action: 'stripe_connect.account_refreshed', resourceType: 'partner', resourceId: auth.partnerId, details: { defaultCurrency, accountCountry } })`; responds `{ status: 'connected', defaultCurrency, accountCountry, accountRefreshedAt: <ISO> }`; `PartnerStripeError` → `c.json({ error: err.message }, err.status)` exactly like the POST `/key` catch at `:57-64`. Follow the `:85-101` DELETE handler shape for the auth/partner-context guard.

- [ ] **Step 1: Write failing tests** in `index.test.ts` (the file already mocks the three service functions; add `getStripeAccountCurrency` and `refreshPartnerStripeAccount` to the same `vi.mock` factory): (a) GET connected → body includes `defaultCurrency: 'EUR'`, `accountCountry: 'DE'`, `accountRefreshedAt: '2026-08-22T00:00:00.000Z'` (mock returns a `Date`); (b) POST `/key` → body includes the three fields; (c) POST `/refresh` → 200 with the refreshed values and `refreshPartnerStripeAccount` called with the auth partnerId; (d) POST `/refresh` when the service throws `new PartnerStripeError('…', 'NO_STRIPE_KEY')` → 409 `{ error }`; (e) POST `/refresh` without BILLING_MANAGE → 403 (copy the file's existing permission-denied case); (f) `selfManagedDbContextRoutes.test.ts`: the three new paths match, `DELETE /api/v1/partner/stripe-connect` does not. Update the existing GET exact-shape assertion for the new fields; the route test's `../../db` mock must expose `runOutsideDbContext`/`withSystemDbAccessContext` pass-throughs.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test routes/stripeConnect` → FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(api): stripe-connect routes self-manage DB context; status exposes cached account currency; POST /refresh (#3777)`.

### Task 10: Checkout warn-don't-block + friendly currency error; detail reads expose the account currency

**Executor:** claude

**Files:**
- Create: `packages/shared/src/types/stripeAccount.ts` (export from `packages/shared/src/types/index.ts`)
- Modify: `apps/api/src/services/invoiceCheckout.ts:49-51` (return type), `:77-80` (destructure `defaultCurrency`), `:100-140` (try/catch around `sessions.create`), `:158` (return)
- Modify: `apps/api/src/routes/portal/invoices.ts:212-250` (try/catch), `:268` (response unchanged — customer path never returns the warning)
- Modify: `apps/api/src/routes/invoicesPublic.ts:216-221` (customer-safe wording branch adds `STRIPE_CURRENCY_UNSUPPORTED`)
- Modify: `apps/api/src/services/invoiceService.ts:427-436` (`getInvoice` return adds `stripeAccountCurrency`, `currencyWarning`)
- Modify: `apps/api/src/services/aiToolsBilling.ts:342-343` (`create_pay_link` output already serialises the full return — includes `warning` automatically; add the description sentence in Task 14 instead)
- Test: `apps/api/src/services/invoiceCheckout.test.ts`, `apps/api/src/routes/portal/invoices.test.ts`, `apps/api/src/routes/invoicesPublic.test.ts`, `apps/api/src/services/invoiceService.test.ts` (getInvoice case), `apps/api/src/routes/invoices/stripe.test.ts`

**Interfaces:**
- Shared type:

```ts
// packages/shared/src/types/stripeAccount.ts
/** Warn-don't-block (multi-currency spec §10): the document's currency differs from
 *  the connected Stripe account's default. Stripe still presents the document
 *  currency; the partner bears the FX spread on settlement. */
export interface StripeCurrencyWarning {
  code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT';
  documentCurrency: string;
  accountCurrency: string;
  message: string;
}
```

- Helper (add to `packages/shared/src/utils/currency.ts`, tested in `currency.test.ts`): `export function buildStripeCurrencyWarning(documentCurrency: string, accountCurrency: string | null | undefined): StripeCurrencyWarning | null` — `null` when `accountCurrency` is null/empty or equal (case-insensitive) to `documentCurrency`; otherwise the object with `message: \`This document is in ${DOC} but your Stripe account settles in ${ACC}. Stripe will present ${DOC} to the customer and convert it on settlement — you bear the FX spread and any conversion fee.\``.
- `createInvoicePayLink(...): Promise<{ url: string; warning?: StripeCurrencyWarning }>` — `warning` set from `buildStripeCurrencyWarning(inv.currencyCode, defaultCurrency)` (the `defaultCurrency` now returned by `getPartnerStripeClient`; no extra query, no refresh). Wrap the `sessions.create` call: `catch (err) { const mapped = mapStripeCheckoutError(err, inv.currencyCode); if (mapped) throw mapped; throw err; }`. Partner-facing callers (`routes/invoices/stripe.ts:19` via `handleServiceError`, `aiToolsBilling.ts:343`) surface the 409 message verbatim; the public route (`invoicesPublic.ts:208-221`) maps `STRIPE_CURRENCY_UNSUPPORTED` to `CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE` 409 and returns only `{ data: { url } }` (drop `warning`).
- Portal pay route (`routes/portal/invoices.ts:212`): same try/catch; on a mapped error `console.error('[portal/invoices] Stripe rejected currency', { invoiceId: inv.id, currency: inv.currencyCode, message })` and `return c.json({ error: CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE, code: 'STRIPE_CURRENCY_UNSUPPORTED' }, 409)`; response on success stays `{ url }` (no warning to customers).
- `getInvoice` returns `{ invoice, lines, stripeConnected, stripeAccountCurrency: conn?.status === 'connected' ? conn.defaultCurrency ?? null : null, currencyWarning: conn?.status === 'connected' ? buildStripeCurrencyWarning(inv.currencyCode, conn.defaultCurrency) : null }` — `getConnection` (`stripeConnectService.ts:13`) already returns the full row, so the new columns arrive with no query change and no Stripe call.

- [ ] **Step 1: Write failing tests.** `currency.test.ts`: `buildStripeCurrencyWarning('EUR', 'USD')` → object with both codes and a message containing `'FX spread'`; `('EUR', 'eur')` → null; `('EUR', null)` → null. `invoiceCheckout.test.ts`: `getPartnerStripeClientMock` resolves `{ ...partnerClient(), defaultCurrency: 'USD' }` with an EUR invoice → result `{ url, warning: { code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT', documentCurrency: 'EUR', accountCurrency: 'USD', message } }`; same currency → `toEqual({ url })` (existing assertions at `:85` keep passing because `warning` is omitted, not `undefined` — build the return object conditionally); `sessionsCreateMock.mockRejectedValue(Object.assign(new Error('Invalid currency: chf'), { type: 'StripeInvalidRequestError', code: 'currency_not_supported' }))` → rejects `InvoiceServiceError` with `code 'STRIPE_CURRENCY_UNSUPPORTED'`, `status 409`, message containing `'CHF'`; a `StripeCardError` rejection propagates unchanged. `routes/portal/invoices.test.ts`: same rejection → 409 body `{ error: 'Online payment is not available for this invoice — please contact the sender.', code: 'STRIPE_CURRENCY_UNSUPPORTED' }`; success body is exactly `{ url }` even when `defaultCurrency` differs. `invoicesPublic.test.ts`: mapped error → 409 customer-safe body; success → `{ data: { url } }` only. `invoiceService.test.ts`: `getInvoice` with a connected row `defaultCurrency: 'USD'` and an EUR invoice → `stripeAccountCurrency: 'USD'`, `currencyWarning.code === 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT'`; disconnected → both null.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** as specified (shared type + helper first, `pnpm --filter @breeze/shared build`, then API).
- [ ] **Step 4: Run** `pnpm --filter @breeze/shared test currency` + `pnpm --filter @breeze/api test invoiceCheckout routes/portal/invoices routes/invoicesPublic invoiceService routes/invoices/stripe aiToolsBilling` → PASS.
- [ ] **Step 5: Commit** — `feat(api): Stripe currency-mismatch warning on pay links + invoice detail; friendly STRIPE_CURRENCY_UNSUPPORTED mapping (#3777)`.

### Task 11: Web — retire USD-only `timeFormat.formatMoney`; ticketing/catalog surfaces pass a currency

**Executor:** claude

**Files:**
- Modify: `apps/web/src/lib/timeFormat.ts:21-25` (delete `formatMoney` + its `formatCurrency` import if unused), `apps/web/src/lib/__tests__/timeFormat.test.ts:31-45` (delete the `formatMoney` describe; keep the elapsed-seconds cases)
- Modify: `apps/web/src/components/billing/shared/format.ts:10-24` (delegate to shared)
- Create: `apps/web/src/lib/usePartnerCurrency.ts`, `apps/web/src/lib/__tests__/usePartnerCurrency.test.tsx`
- Modify: `apps/api/src/routes/tickets/parts.ts:65-71` (`GET /:id/parts` rows gain `currencyCode`), `:94-100` (`GET /:id/billing-summary` gains `currencyCode`); `apps/api/src/routes/tickets/parts.test.ts` (extend)
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx:7-12,125,129`, `apps/web/src/components/tickets/TicketPartsCard.tsx:6,11-20,203-215`, `apps/web/src/components/settings/CatalogItemsTab.tsx:9,429-430,474-475`, `apps/web/src/components/catalog/CatalogItemPicker.tsx:2,9-13,115`, `apps/web/src/components/settings/TicketCategoriesPage.tsx:10,89`
- Modify: `apps/web/src/lib/api/catalog.ts:10-11` (comment: prices render in the partner currency until wave 3 price books)
- Test: `TicketTimeBilling.test.tsx`, `TicketPartsCard.test.tsx`, `CatalogItemsTab.test.tsx`, `CatalogItemsTab.permissions.test.tsx`, `TicketCategoriesPage.test.tsx`, `format.test.ts`, new `CatalogItemPicker.test.tsx`

**Interfaces:**
- `billing/shared/format.formatMoney(value, currencyCode = 'USD')` body becomes `return sharedFormatMoney(value, currencyCode || 'USD', resolvedFormattingLocale());` (import `{ formatMoney as sharedFormatMoney } from '@breeze/shared'`; `resolvedFormattingLocale()` may return `undefined`, which the shared signature accepts). `format.test.ts:27` `formatMoney(5, 'US') === '5.00 US'` still holds (shared fallback uppercases + suffixes the code). `sumByCurrency`/`formatDate` untouched; the `invoiceTypes.ts:188` / `quoteTypes.ts:362` re-exports keep working.
- `usePartnerCurrency(): string` — fetches `/orgs/partners/me` once per page (module-level promise cache of the RESOLVED value only — a rejected/401/non-OK response must NOT be cached, so the next mount retries), returns `p.currencyCode ?? 'USD'`, `'USD'` until loaded; 401 → leave `'USD'` (the page-level auth redirect handles it). Export `resetPartnerCurrencyCache()` and call it from the logout path (`apps/web/src/lib/auth.ts` — grep `logout`) so a partner switch in the same tab never shows the previous partner's currency; tests call it in `beforeEach`. Interim source for catalog prices (wave 3 adds per-item price books) and partner-level category rates (wave 4 adds rate currencies).
- Interim-source rule (spec §2 reconciliation): pre-wave-3/4 these rows store NO currency, so the partner/org default that applied at their creation is the only context they have — labelling them with it is strictly better than today's hard-coded `$` and is not a read-time reinterpretation of a stored currency (there is none to reinterpret). Every interim read carries a `// INTERIM (#3777): replaced by <wave-3 price book | wave-4 currency_code snapshot>` comment so the later wave's executor can grep `INTERIM (#3777)` and swap the source for the row's own column; if wave 3/4 merges first, the executor of this task uses the row column directly and skips the interim read.
- API interim (shape-compatible with wave 4's `ticket_parts.currency_code` / entry snapshots): both ticket routes select `organizations.currencyCode` for `ticket.orgId` (one query) and return it — parts rows as `{ ...part, currencyCode }`, billing-summary as `{ time, parts, currencyCode }`.
- Components: `TicketTimeBilling` formats with `formatMoney(summary.time.billableAmount, summary.currencyCode)` from `@/components/billing/shared/format`; `TicketPartsCard` uses `part.currencyCode`; `CatalogItemsTab` uses `usePartnerCurrency()`; `TicketCategoriesPage`'s module-level helper becomes `defaultsSummary(c: Category, currencyCode: string)` (it is not a component, so it cannot call the hook — the page component calls `usePartnerCurrency()` once and passes the value at the `:89` call site, formatting with `formatMoney(c.defaultHourlyRate, currencyCode)` from `@/components/billing/shared/format` instead of the USD-default `formatCurrency`); `CatalogItemPicker` gains an optional `currencyCode?: string` prop (default `usePartnerCurrency()` inside) so quote/ticket pickers can pass the document currency later.

- [ ] **Step 1: Write failing tests.** `parts.test.ts`: billing-summary and parts-list responses include `currencyCode` from the ticket's org (mock the org select → `'EUR'`). `TicketTimeBilling.test.tsx`: summary fixture `currencyCode: 'EUR'` → text contains `'€150.00'`; `TicketPartsCard.test.tsx`: rows with `currencyCode: 'GBP'` → `'2 × £99.00'`; new `CatalogItemPicker.test.tsx`: `currencyCode="EUR"` prop → `'€12.00'`; `CatalogItemsTab.test.tsx`: mock `/orgs/partners/me` → `{ currencyCode: 'CAD' }` → a price cell renders `'CA$…'`; `usePartnerCurrency.test.tsx`: resolves from the mocked fetch, defaults to `'USD'`, fetches once across two mounts. Delete the `timeFormat.formatMoney` describe.
- [ ] **Step 2: Run** `pnpm --filter @breeze/web test timeFormat format TicketTimeBilling TicketPartsCard CatalogItemsTab CatalogItemPicker TicketCategoriesPage usePartnerCurrency` + `pnpm --filter @breeze/api test routes/tickets/parts` → FAIL.
- [ ] **Step 3: Implement** — API routes first, then the hook, then the five components (every former `timeFormat.formatMoney` import now points at `@/components/billing/shared/format`), then delete `timeFormat.formatMoney`. `git grep -n "timeFormat'" apps/web/src | grep formatMoney` must return nothing.
- [ ] **Step 4: Run** the same suites + `pnpm --filter @breeze/web test no-silent-mutations keyUsage` → PASS; turbo typecheck for web + api.
- [ ] **Step 5: Commit** — `feat(web,api): ticketing/catalog money renders in the org/partner currency via the shared formatter (#3777)`.

### Task 12: Web — Stripe settings card (cache + refresh) and currency-mismatch warnings on invoice/quote detail

**Executor:** claude

**Files:**
- Modify: `apps/web/src/components/integrations/StripePaymentsIntegration.tsx:12-17` (state type), `:33-47` (load), new `refreshAccount` callback, `:144-177` (connected row)
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx:51` (read `detail.currencyWarning`), `:563-568` (render the warning beside the Stripe nudge), `apps/web/src/components/billing/invoiceTypes.ts` (detail type gains `stripeAccountCurrency?: string | null; currencyWarning?: StripeCurrencyWarning | null`)
- Modify: `apps/web/src/components/billing/quotes/QuoteActions.tsx:384-390` (read `defaultCurrency` from `/partner/stripe-connect`), render the warning in the deposit/pay-link messaging block (`:1267-1300`)
- Modify (new keys, all 8 locales): `apps/web/src/locales/*/integrations.json` (`stripePaymentsIntegration.defaultCurrency`, `.accountCountry`, `.refreshedAt`, `.refresh`, `.refreshing`, `.refreshed`, `.couldNotRefresh`, `.notCached`), `apps/web/src/locales/*/billing.json` (`invoiceDetail.payments.currencyMismatch`, `quotes.actions.currencyMismatch` — both with `{{documentCurrency}}` and `{{accountCurrency}}` tokens)
- Test: `apps/web/src/components/integrations/StripePaymentsIntegration.test.tsx` (new), `apps/web/src/components/billing/InvoiceDetail.test.tsx` (extend), `apps/web/src/components/billing/quotes/QuoteActions.test.tsx` (extend), `localeParity.test.ts`, `keyUsage.test.ts`

**Interfaces:**
- `ConnectState` gains `defaultCurrency?: string | null; accountCountry?: string | null; accountRefreshedAt?: string | null`. Connected row shows `defaultCurrency` (or `notCached`) + `accountCountry` + "Refreshed <relative/short date>" and a **Refresh** button: `runAction({ request: () => fetchWithAuth('/partner/stripe-connect/refresh', { method: 'POST' }), errorFallback: t('…couldNotRefresh'), successMessage: t('…refreshed'), onUnauthorized: UNAUTHORIZED })` then `load()`. `data-testid`s: `stripe-connect-currency`, `stripe-connect-refresh-button`.
- Warning copy (en), interpolated: `invoiceDetail.payments.currencyMismatch`: "This invoice is in {{documentCurrency}} but your Stripe account settles in {{accountCurrency}}. Stripe will present {{documentCurrency}} to the customer and convert it on settlement — you bear the FX spread and any conversion fee." `quotes.actions.currencyMismatch`: same sentence with "quote". Render only when `stripeConnected && currencyWarning` (invoice) / `stripeStatus === 'connected' && stripeDefaultCurrency && stripeDefaultCurrency !== quote.currencyCode` (quote); `data-testid="invoice-stripe-currency-warning"` / `"quote-stripe-currency-warning"`. Amber info tone, never blocks the pay-link action.
- The web never calls Stripe and never computes the warning from anything but the API's cached value.

- [ ] **Step 1: Write failing tests.** `StripePaymentsIntegration.test.tsx` (mock `fetchWithAuth` like `TicketTimeBilling.test.tsx:14`): connected body with `defaultCurrency: 'EUR'`, `accountCountry: 'DE'`, `accountRefreshedAt` → the currency cell shows `EUR`; clicking Refresh POSTs `/partner/stripe-connect/refresh` and re-loads; `defaultCurrency: null` → shows the `notCached` copy. `InvoiceDetail.test.tsx`: detail with `stripeConnected: true`, `currencyWarning: { code, documentCurrency: 'EUR', accountCurrency: 'USD', message }` → warning test-id present, text contains `EUR` and `USD`; `currencyWarning: null` → absent. `QuoteActions.test.tsx`: `/partner/stripe-connect` → `{ status: 'connected', defaultCurrency: 'USD' }` with an EUR quote → warning present; USD quote → absent.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — components, the shared type import (`StripeCurrencyWarning` from `@breeze/shared`), and the locale keys in all 8 catalogs (translate the sentence per locale; keep both interpolation tokens identical — `localeParity.test.ts:413` enforces it).
- [ ] **Step 4: Run** the three component suites + `pnpm --filter @breeze/web test localeParity keyUsage translationCoverage no-silent-mutations` → PASS.
- [ ] **Step 5: Commit** — `feat(web): Stripe account currency cache + refresh in settings; currency-mismatch warnings on invoice/quote detail (#3777)`.

### Task 13: Portal — one `money()` helper on the shared formatter

**Executor:** claude

**Files:**
- Create: `apps/portal/src/lib/money.ts`, `apps/portal/src/lib/money.test.ts`
- Modify: `apps/portal/src/components/portal/quoteBlocks.tsx:11-18` (re-export from the lib instead of defining), `PublicInvoiceView.tsx:28-35`, `InvoiceDetailView.tsx:18-25`, `InvoiceList.tsx:13-20`, `QuoteList.tsx:37-44` (delete the local copies, import `money` from `@/lib/money`)
- Test: `apps/portal/src/components/portal/PublicQuoteView.test.tsx:73-76`, `quoteBlocks.test.tsx`, `InvoiceDetailView.test.tsx` (re-run)

**Interfaces:**
- `export function money(value: string | number | null | undefined, currencyCode: string | null | undefined): string` → `formatMoney(value, currencyCode || 'USD', portalLocale())` where `portalLocale()` returns `navigator.language` when `typeof navigator !== 'undefined' && navigator.language`, else `'en'` (SSR-safe — Astro renders these views on the server first). Spec §9: the portal uses the browser locale; portal i18n beyond that is a listed follow-up (§15).
- `quoteBlocks.tsx` keeps exporting `money` (`export { money } from '@/lib/money';`) so `PublicQuoteView.tsx:4` / `QuoteDetailView.tsx` imports are untouched.

- [ ] **Step 1: Write failing tests.** `money.test.ts` (jsdom, `navigator.language` is `en-US`): `money('1234.5', 'USD') === '$1,234.50'`; `money('1000', 'JPY') === '¥1,000'`; `money('12', 'ZZ1') === '12.00 ZZ1'`; `money(null, 'EUR') === '€0.00'`; with `Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true })` → `money('1234.5', 'EUR') === '1.234,50 €'`; with `navigator` stubbed to `undefined` via `vi.stubGlobal('navigator', undefined)` → falls back to `'en'` without throwing.
- [ ] **Step 2: Run** `pnpm --filter @breeze/portal test money` → FAIL.
- [ ] **Step 3: Implement** the lib, replace the five copies, keep the `quoteBlocks` re-export. `git grep -n "toLocaleString('en-US'" apps/portal/src` must return nothing money-related.
- [ ] **Step 4: Run** `pnpm --filter @breeze/portal test` → PASS (the `$` assertions in `PublicQuoteView.test.tsx` hold under jsdom's `en-US`).
- [ ] **Step 5: Commit** — `refactor(portal): single money() helper on the shared formatter with browser locale (#3777)`.

### Task 14: AI tools expose `currencyCode` and forbid cross-currency sums

**Executor:** codex

**Files:**
- Modify: `apps/api/src/services/aiToolsBilling.ts:131-133` (`list_invoices` description), `:174-175` (`get_invoice`), `:202-205` (`manage_invoices`), `:236` (`payment` param), `:342-343` (no code change — the `create_pay_link` return now carries `warning`; document it in the `manage_invoices` description)
- Modify: `apps/api/src/services/aiToolsQuotes.ts:125-126` (`list_quotes`), `:167-171` (`get_quote`), `:233-240` (`manage_quotes`), `:327-331` (`line` param text)
- Modify: `apps/api/src/services/aiToolsTicketing.ts:354-357` (`hourlyRate`), `:684` (`log_time_entry` output)
- Modify: `apps/api/src/services/aiToolsContracts.ts:89`, `:130`, `:157` (descriptions)
- Test: `apps/api/src/services/aiToolsBilling.manageInvoices.test.ts`, `aiToolsQuotes.test.ts`, `aiToolsTicketing.test.ts` (extend with description assertions), `apps/api/src/services/aiToolsContracts.test.ts` (NEW — no test exists for this file; create it mirroring `aiToolsQuotes.test.ts`'s registry setup and assert only the three descriptions), `aiAgentSdkTools.mcpCoverage.test.ts` (re-run)

**Interfaces (exact text to append — these are string concatenations in `description:` fields):**
- Billing `list_invoices` / `get_invoice` / Quotes `list_quotes` / `get_quote`: append `' Every document carries a 3-letter currencyCode and all of its amounts (subtotal, tax, total, balance, line totals) are in that currency. NEVER add amounts from documents with different currencyCode values — group by currencyCode first and report one total per currency.'`
- Contracts `list_contracts` / `get_contract` (`:89-92`, `:130-133`): contracts have no subtotal/tax/balance — append the contract-shaped sentence instead: `' Every contract carries a 3-letter currencyCode; its line unitPrice values, per-period totals and the invoices it generates are all in that currency. NEVER add amounts from contracts with different currencyCode values — group by currencyCode first and report one total per currency.'`
- `manage_invoices`: append `' Money inputs (line unitPrice, payment amount) are in the invoice\'s currencyCode. create_pay_link may return a `warning` (code CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT) when the invoice currency differs from the partner\'s Stripe account currency — relay it to the user; it does not block the link.'`; `payment` param description → `'Payment fields (amount in the invoice\'s currencyCode, method, ...)'`.
- `manage_quotes`: append `' Money inputs (line unitPrice) are in the quote\'s currencyCode; totals in the response are in that currency.'`; the `line` param description (`:327-331`) replaces `'unitPrice,'` with `'unitPrice (in the quote\'s currencyCode),'`.
- `manage_contracts` (`:157`): append `' Contract line prices and totals are in the contract\'s currencyCode.'`
- Ticketing `hourlyRate` description → `'Override hourly rate in the ticket organization\'s currency (log_time_entry; defaults from ticket category / org rate)'`. All three time-entry outputs — `log_time_entry` (`:684`), `start_timer` (`:694-716`), `stop_timer` (`:718-727`) — return `JSON.stringify({ timeEntry: entry, currencyCode })` via one local helper `async function entryCurrency(entry: { orgId: string | null }): Promise<string | null>`: `time_entries.org_id` is NULLABLE (`db/schema/timeTracking.ts:25` — standalone/non-ticket entries), so `entry.orgId === null` → `currencyCode: null` (explicit, never omitted); otherwise one query `db.select({ currencyCode: organizations.currencyCode }).from(organizations).where(eq(organizations.id, entry.orgId)).limit(1)` (`organizations` from `'../db/schema'`). `// INTERIM (#3777)`: wave 4 stamps `time_entries.currency_code` and replaces this read with the row's own column. `stop_timer` is the output that carries the computed billable amount, so it is the one that most needs the label.
- MCP (`routes/mcpServer.ts`) and the Agent-SDK bridge (`aiAgentSdkTools.ts:2221` `registryDescription('get_quote')`) read the same registry — no separate edit.

- [ ] **Step 1: Write failing tests** — in each of the four tool test files add a case asserting the registered definition's `description` contains `'currencyCode'` (and for billing/quotes/contracts list+get, `'group by currencyCode'`); ticketing: `hourlyRate.description` contains `"organization's currency"`; `log_time_entry` and `stop_timer` executions return JSON with `currencyCode: 'EUR'` when the org select mock yields `'EUR'`, and `log_time_entry` for an entry with `orgId: null` returns `currencyCode: null` (follow that file's existing `db` mock queue pattern).
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test aiToolsBilling aiToolsQuotes aiToolsTicketing aiToolsContracts` → FAIL.
- [ ] **Step 3: Implement** the text edits and the three output changes (one helper).
- [ ] **Step 4: Run** the same + `aiAgentSdkTools.mcpCoverage` → PASS.
- [ ] **Step 5: Commit** — `feat(api): AI tools expose currencyCode and instruct per-currency grouping (#3777)`.

### Task 15: Locale catalogs — currency-neutral hourly-rate labels and zero-total warning

**Executor:** codex

**Files:**
- Modify (values only, keys unchanged): `apps/web/src/locales/en/settings.json:2254,2755`; `de-DE:2201,2702`; `es-419:2201,2702`; `fr-CA:2249,2750`; `fr-FR:2201,2702`; `it-IT:2249,2750`; `pt-BR:2254,2755`; `tr-TR:2254,2755` — the `ticketCategoriesPage.defaultHourlyRate` and `orgTicketSettingsEditor.billing.hourlyRate` labels
- Modify (new `{{zero}}` token in all 8, explicit list): `apps/web/src/locales/en/billing.json:890`, `de-DE/billing.json:890`, `es-419/billing.json:890`, `fr-CA/billing.json:890`, `fr-FR/billing.json:890`, `it-IT/billing.json:890`, `pt-BR/billing.json:890`, `tr-TR/billing.json:890` — key `quotes.actions.sendConfirm.zeroTotalWarning` (tr-TR currently reads `0,00 ABD dolarıdır`, not `$0.00` — replace the whole value as listed below)
- Modify consumers: `apps/web/src/components/billing/quotes/QuotesPage.tsx:646`, `apps/web/src/components/billing/quotes/QuoteActions.tsx:1118`
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`, `OrgTicketSettingsEditor.test.tsx`, `QuotesPage.test.tsx`, `QuoteActions.test.tsx`

**Interfaces:**
- Labels: drop the trailing ` ($)` / ` (US$)` parenthetical — the input is a bare number; the currency is shown by the rate summary (`ticketCategoriesPage.hourlyRate: "{{rate}}/h"`, already neutral, formatted in the partner currency by Task 11). Exact values: en `"Default hourly rate"`; de-DE `"Standardstundensatz"`; es-419 `"Tarifa por hora predeterminada"`; fr-CA/fr-FR `"Taux horaire par défaut"`; it-IT `"Tariffa oraria predefinita"`; pt-BR `"Taxa horária padrão"`; tr-TR `"Varsayılan saatlik ücret"` — both keys in each file.
- `zeroTotalWarning` becomes an interpolation: en `"This quote totals {{zero}} — check that its items are priced before sending."`; de-DE `"Dieses Angebot beträgt {{zero}} — prüfen Sie vor dem Senden, ob die Positionen bepreist sind."`; es-419 `"Esta cotización totaliza {{zero}} — verifica que sus ítems tengan precio antes de enviar."`; fr-CA/fr-FR `"Ce devis totalise {{zero}} — vérifiez que ses lignes sont tarifées avant l'envoi."`; it-IT `"Il totale di questo preventivo è {{zero}}: verifica che gli elementi abbiano un prezzo prima dell'invio."`; pt-BR `"Este orçamento totaliza {{zero}} — verifique se os itens têm preço antes de enviar."`; tr-TR `"Bu fiyat teklifinin toplamı {{zero}} — göndermeden önce öğelerinin fiyatlandırıldığını kontrol edin."`. Both consumers pass `{ zero: formatMoney(0, q.currencyCode) }` (QuotesPage has `q`; QuoteActions has `quote`). `QuoteActions.tsx:22` already imports `formatMoney` via the `./quoteTypes` re-export — keep that import; `QuotesPage.tsx` does NOT import `formatMoney` at all — add `import { formatMoney } from '../shared/format';` (or extend its existing `./quoteTypes` import if it has one — grep first). `localeParity.test.ts:413-422` requires the same token set in all 8 — hence all 8 change together.
- AI-budget labels (`settings.json:116-117,1246,1248`, `ai.json:251-252`) are deliberately untouched.

- [ ] **Step 1: Write failing tests** — `QuotesPage.test.tsx` / `QuoteActions.test.tsx`: a zero-total EUR quote renders the warning containing `'€0.00'`; `TicketCategoriesPage.test.tsx`: the label text equals `'Default hourly rate'` (no `$`).
- [ ] **Step 2: Run** `pnpm --filter @breeze/web test QuotesPage QuoteActions TicketCategoriesPage localeParity` → FAIL.
- [ ] **Step 3: Implement** the 16 label edits, the 8 warning edits, and the two consumer call sites.
- [ ] **Step 4: Run** the same + `OrgTicketSettingsEditor keyUsage translationCoverage` → PASS. `git grep -n '(\$)\|(US\$)' apps/web/src/locales` must list only the AI-budget keys.
- [ ] **Step 5: Commit** — `feat(web): currency-neutral hourly-rate labels; zero-total warning formats the quote currency (#3777)`.

### Task 16: Full-suite verification + PR

**Executor:** claude

- [ ] **Step 1:** `pnpm --filter @breeze/shared test && pnpm --filter @breeze/shared build`; `pnpm --filter @breeze/api test`; `pnpm --filter @breeze/web test`; `pnpm --filter @breeze/portal test`; the API integration config end-to-end against `:5438` (`integration_suite_needs_fsync_off_tmpfs_locally` if it looks hung) including `rls-coverage`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `autoMigrate`; `pnpm db:check-drift`; turbo typecheck for api/web/portal/shared.
- [ ] **Step 2: Sweep for stragglers** — every hit must be either shared-formatter-backed or on the AI-budget/out-of-scope list: `git grep -n "toLocaleString('en-US'" -- apps packages ee`, `git grep -n "formatMoneyish\|formatCurrencyAmount" -- apps ee` (expect only the shared alias + its test), `git grep -n "timeFormat'" apps/web/src | grep formatMoney` (expect none), `git grep -n "style: 'currency'" -- apps | grep -v "packages/shared\|i18n/format.ts"` (expect none outside the two locale-source helpers), `git grep -n '"\$\|\$0\.00\|(\$)' apps/web/src/locales` (expect only AI-budget keys). Also run the wider patterns `git grep -n "toFixed(2)\|formatNumber(\|formatCurrency(\|money(\|formatMoney(" -- apps/web/src apps/portal/src apps/api/src` and classify every monetary hit. Recorded exceptions (already currency-code-prefixed or not customer-facing money): distributor cost displays (`TdSynnex*Panel.tsx` `${currency} ${formatNumber(cost)}`), `apps/web/src/components/billing/quotes/DistributorLookup.tsx:264-265` (`{{currency}} {{amount}}` cost; `msrp` is an unlabelled distributor-feed figure), `apps/web/src/components/contracts/ContractPax8Drawer.tsx:32-35` (`priceEach` with `{{currency}}`), `apps/web/src/components/settings/marginMath.ts:36` (`Profit {currency} {number}` — code-prefixed, neutral), `apps/api/src/services/catalogEnrichmentService.ts:160-166` (`priceGuidanceFrom` — AI price-guidance prose, `$` only when the currency is USD/unknown, code-prefixed otherwise; not a rendered stored amount), `PartnerDashboard.tsx:573,584` (MRR, wave 7), and the AI-budget/cost displays (`AiCostIndicator`, `clientAi/*Tab`, `AiUsagePage`, `PartnerAiBudgetsTab`, `PolicyEditor` — provider spend in USD).
- [ ] **Step 3: Re-check the export-policy blind spot** — `grep -n 'document_locale' apps/api/src/services/tenantExportPolicyRegistry.ts` shows both tables.
- [ ] **Step 4:** Push, open PR against `main` (not stacked): title `feat: multi-currency wave 5 — formatting & checkout readiness (#3777)`; body summarises: shared `formatMoney` adoption (API PDFs/emails, contract templates, portal, web ticketing/catalog), `document_locale` snapshots (stamp-once rule, no backfill), locale-catalog neutrality, AI tool currency exposure, Stripe cache/refresh/TTL + warn-don't-block + friendly currency error, the two migrations, the interim currency sources that waves 3/4 replace (catalog → partner currency; ticket parts/summary → org currency), and the recorded exceptions; ends with `Closes #3777`.
- [ ] **Step 5:** One review round (repo policy), then `gh pr merge --squash --admin` on green.

## Self-Review Notes

- Spec §9 coverage: one formatter — Task 1 (shared), 4 (invoicePdf), 5 (quotePdf + branding), 6a (quoteLifecycle), 6b (contractTemplateRender), 11 (web `timeFormat` retirement + `billing/shared/format` delegation + the four named files), 13 (four+ portal copies — five found, all replaced). Locale sources — web keeps `resolvedFormattingLocale` (Task 11), portal uses `navigator.language` (Task 13), server documents snapshot `document_locale` at issue/send defaulting from the partner language (Tasks 2, 7) with contract templates on the same path (6b). Locale catalogs — Task 15 (AI-budget `$` kept). AI tools — Task 14 (`currencyCode` exposure, group-don't-sum, `hourlyRate` wording). PDF width headroom — Tasks 4 and 5 with measured assertions.
- Spec §10 coverage: cache `default_currency` + `country` at key save with `refreshed_at` (Tasks 3, 8), explicit refresh (Tasks 8, 9, 12), TTL re-check (Task 8 — lazy on status read, never on the pay path), warn-don't-block with FX-spread copy (Tasks 10, 12, 14), friendly `checkout.sessions.create` currency error (Tasks 8, 10). Reconcile/settle untouched as the spec requires.
- B7 table row: `invoicePdf.ts:47`/`quotePdf.ts:32`/`quoteLifecycle.ts:32` (verified at `:53`, `:32`, `:33` in this worktree), portal `quoteBlocks.tsx:11` et al., `lib/timeFormat.formatMoney` consumers — all placed.
- Deliberate scope calls, flagged for the owner: (a) `document_locale` is NOT copied on clone/reissue (stamp-once at the new document's own issue/send — keeps the snapshot semantics identical to `sellerSnapshot`); quote→invoice is the one exception and only because accept ISSUES the invoice inline (`quoteAcceptService.ts:264`) — it stamps the quote's locale at that moment, exactly as it copies `sellerSnapshot`; (b) interim currency sources: catalog prices and partner-level category rates render in the partner currency until wave 3/4, ticket parts/summary carry the org currency from the API until wave 4's snapshots (response shapes chosen to be column-compatible); (c) the portal pay path and the public link never surface the mismatch warning (customer-facing); (d) `POST /refresh` is BILLING_MANAGE without MFA — it writes only cache columns; (e) `zeroTotalWarning` gains a `{{zero}}` token in all 8 locales rather than rewording.
- Type consistency checked: `formatMoney(value, currency, locale?)` is the one signature across shared, `quotePdf` shim, web `billing/shared/format` (2-arg, delegates), portal `money` (2-arg, delegates); `resolvePartnerDocumentLocale` returns `SupportedLocale` (string-compatible everywhere it is spread into `varchar(16)`); `StripeCurrencyWarning` is the single warning shape for API responses, `getInvoice`, and the web.
- Integration runs for this worktree use `.env.test` (postgres `:5438`, redis `:6388`); local `pnpm test` still does not run the export-policy suites — Task 2 Step 4 and Task 16 Step 1 run them explicitly.
- Codex review (2026-08-22) folded in: B1 self-managed DB context for the three Stripe-calling `/partner/stripe-connect` routes (Tasks 8, 9, global constraint); M1 contract-template locale threaded from the callers (Task 6b, now claude — 6 files); M2 invoice totals get their own bold-14 box (Task 4); M3 quote column numbers re-derived so the existing description-width floor is relaxed explicitly, not silently violated (Task 5); M4 wider sweep patterns + recorded exceptions (Task 16); M5 contract-shaped AI wording (Task 14); M6 `currencyCode` on all three time-entry outputs, nullable for standalone entries (Task 14); m1–m3 applied (explicit locale file list, `QuotesPage` import, partner-currency cache invalidation). Rejected: B2 (asked to block catalog/ticket labelling on waves 3/4 — contradicts the owner's wave-3/4/5 parallelisation; pre-wave rows store no currency, so the creation-time default is their only context and beats today's hard-coded `$`; mitigated with the `INTERIM (#3777)` marker rule in Task 11) and m4 (`:772` is the `currency` const inside `renderQuotePdf`, which begins at `:758` — wording clarified). Own finding added: quote accept issues the converted invoice inline and bypasses `issueInvoice`, so Task 7 stamps `document_locale` there too.
