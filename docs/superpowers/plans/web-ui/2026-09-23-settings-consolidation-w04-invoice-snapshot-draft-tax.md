---
tracking_issue: LanternOps/breeze#6223
wave_issue: LanternOps/breeze#6227
---

# Settings consolidation W04 (#6227): invoice presentation snapshot at issue + backfill, draft invoice tax

> **For agentic workers:** execute task-by-task, red first. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An issued invoice keeps the theme and page size it was issued with (settings audit rule 6, "one snapshot moment"), and a persisted draft's totals use the same org → partner tax resolution that issue applies (rule 5, "one resolver per concept", audit finding M18).

**Contract:** the Codex xhigh quorum of 2026-09-23 (GH W04 amendments 1–8) is binding. Where the positions doc (`docs/superpowers/plans/web-ui/2026-09-17-settings-consolidation-wave2-design-positions.md`, its "W03") disagrees, the quorum wins.

**Tech stack:** Hono + Drizzle (API), hand-written idempotent SQL migration, Vitest unit + real-Postgres integration suites.

## Current facts (re-verified on `origin/main` 8aa16554a4, 2026-09-23)

| Fact | Where |
|---|---|
| `invoices` has no presentation columns; it already snapshots `document_locale`, `device_appendix`, `seller_snapshot` at issue | `apps/api/src/db/schema/invoices.ts:54-117` |
| Public invoice route reads the partner's **live** `documentTheme`/`documentPageSize` for every status | `apps/api/src/routes/invoicesPublic.ts:108-112,170-181` |
| In-app preview forges `presentationSnapshot: null` into `resolveQuoteBranding`, which then falls through to the partner's live columns | `apps/api/src/routes/invoices/invoices.ts:59-72`, `services/quoteBranding.ts:82-106` |
| `resolveThemeId` / `resolvePageSize` normalize anything unknown to `classic` / `a4` | `services/documentThemes.ts:104-110` |
| Normal issue writer: one system tx, reads `partners` row after all locks, stamps `taxRate`, `documentLocale`, `deviceAppendix`, … | `services/invoiceService.ts:1334-1511` (partner read `:1442`, update `:1467-1504`) |
| Quote-accept direct issue writer (never calls `issueInvoice`): stamps seller snapshot, locale, appendix from the accepted quote | `services/quoteAcceptService.ts:338-345` (partner read), `:491-537` (issue fields) |
| Quotes freeze `presentationSnapshot = { theme, pageSize }` at send | `services/quoteLifecycle.ts:219-228` |
| Recurring contract children and void/reissue drafts issue through `issueInvoice` | `jobs/contractWorker.ts`, `routes/contracts/generate.ts`, `invoiceService.ts:2114-2334` |
| Persisted draft recompute is **org-only**: `effectiveRateForOrg` passes `partnerRate: null` | `services/invoiceService.ts:189-215` |
| Draft detail already *previews* the org→partner rate via `resolveOrgTaxRate` (read-only, #6338) | `services/invoiceService.ts:789-833` |
| `resolveOrgTaxRate` reads `partners` via `readWithPartnerAxisVisibility`, which opens a SECOND pooled transaction unless ambient scope is `system` | `services/taxRateResolver.ts:47-74`, `db/partnerAxisRead.ts:55-72` |
| Every `recomputeInvoiceTotals` caller is partner- or system-scoped (invoice routes `requireScope('partner','system')`; AI billing tools gate on partner/system at the tool layer; contract worker is system) | `routes/invoices/invoices.ts`, `services/aiToolsBilling.ts:150,312,348` |
| `invoices` export policy entry | `services/tenantExportPolicyRegistry.ts:373` |
| Newest committed migration | `2026-10-28-120000-software-catalog-soft-delete.sql` |
| `invoiceService.issue.integration.test.ts` is NOT in `vitest.integration.config.ts`'s include list (runs in no CI job) → new integration suites go under `src/__tests__/integration/` | `vitest.integration.config.ts:13-60` |

## Decisions

1. **Two typed nullable columns** `invoices.document_theme varchar(16)` + `invoices.document_page_size varchar(8)`, each with a CHECK (`classic|condensed`, `letter|a4`). NULL = "not frozen yet" (a draft → live partner preview). Not JSONB (quorum amendment 1).
2. **One resolver** `resolveInvoicePresentation(invoice, partner)` in `services/invoicePresentation.ts`: invoice column → partner live column → `resolveThemeId`/`resolvePageSize` default. Each field resolves independently (a half-stamped row cannot exist after the backfill, but the resolver must not depend on that). Consumers: public invoice route (`brandingBlock`) and in-app preview (new `resolveInvoiceBranding` in `quoteBranding.ts`, sharing the quote helper's body so the preview stops forging `presentationSnapshot: null`). Stamping also goes through it (`resolveInvoicePresentation({documentTheme: null, …}, partner)` = "the partner's value now").
3. **Stamp at issue in both writers.** `issueInvoice`: `inv.documentTheme ?? resolved.theme` — the same `??`-keeps-a-prior-stamp rule `documentLocale` uses (a draft never carries one today; the rule just keeps the two-writer contract symmetric). Quote accept: map the accepted quote's frozen `presentationSnapshot` (theme/pageSize) through the resolver with the partner row as fallback — same precedence as `quoteBranding`, so the invoice matches the proposal the customer signed. Contract children and void/reissue drafts inherit nothing: they are fresh drafts that stamp their own at issue (amendment 4).
4. **Backfill** `2026-10-29-100100-invoice-presentation-snapshot.sql` (same file as the DDL, ordered DDL → backfill): elect system scope first, batch `UPDATE … WHERE id IN (SELECT … LIMIT 5000)` loops over `status <> 'draft' AND document_theme IS NULL` (and the same for page size), normalize the partner value with the same CASE as the TS resolvers, `RAISE WARNING` the cumulative count. Partner current value = exactly what those invoices render today, so the backfill changes no customer-visible output.
5. **Export policy:** both columns `included` (scalar enums, not credentials, not open containers).
6. **M18 draft tax:** new `resolveOrgTaxRateOn(dbc, { orgId, partnerId })` in `taxRateResolver.ts` reads BOTH `organizations` and `partners` on the caller's executor (the locked tx) — no escalation, no second connection (amendment 6). All callers hold partner/system scope, where the `partners` row is RLS-visible. Fail closed: a missing org row → `OrgNotVisibleForTaxError`; a missing partner row (FK guarantees it exists, so absence = RLS hid it) → new `PartnerNotVisibleForTaxError` rather than a silent org-only rate. `resolveOrgTaxRate` and the new variant share one pure core so the precedence cannot drift. `effectiveRateForOrg(inv, dbc)` becomes a thin wrapper that keeps the persisted fraction format (`'0.00000'` when no tax). Issue keeps its own re-resolution (already org→partner at issue time, `invoiceService.ts:1449`).
7. **Non-goals:** PDF theming (`invoicePdf.ts` stays A4/Helvetica — amendment 7); `sellerSnapshot.ts` / partner company identity (W05); organization payment terms (W06); any web UI change (the API response shape `branding.theme/pageSize` is unchanged).

## Settings rule 9 statement (for the PR body)

- **Home:** Billing → Settings → Invoice appearance (partner `document_theme` / `document_page_size`, unchanged). **Level:** partner default, snapshotted on the invoice at issue. **Resolver:** `resolveInvoicePresentation` (presentation), `resolveOrgTaxRate` / `resolveOrgTaxRateOn` (tax — one core). **Places configured:** 1 before → 1 after (no new setting; the invoice columns are snapshots, not settings).

## File map

| File | Change |
|---|---|
| `apps/api/migrations/2026-10-29-100100-invoice-presentation-snapshot.sql` | new: columns + CHECKs + batched counted backfill |
| `apps/api/src/db/schema/invoices.ts` | two columns + CHECKs |
| `apps/api/src/services/invoicePresentation.ts` (+ `.test.ts`) | new resolver |
| `apps/api/src/services/quoteBranding.ts` | extract shared body; add `resolveInvoiceBranding` |
| `apps/api/src/routes/invoices/invoices.ts` | use `resolveInvoiceBranding` |
| `apps/api/src/routes/invoicesPublic.ts` (+ test) | `brandingBlock` uses the resolver with the invoice row |
| `apps/api/src/services/invoiceService.ts` (+ test) | stamp at issue; draft recompute via `resolveOrgTaxRateOn` |
| `apps/api/src/services/quoteAcceptService.ts` (+ test) | stamp from the quote snapshot |
| `apps/api/src/services/taxRateResolver.ts` (+ test) | shared core + tx-aware variant + `PartnerNotVisibleForTaxError` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | invoices entry: two `included` columns |
| `apps/api/src/__tests__/integration/invoicePresentationSnapshot.integration.test.ts` | new: stamping, freeze, backfill, draft tax |

## Tasks

### Task 1 — resolver (unit, red first)
- [ ] `invoicePresentation.test.ts`: stamped row wins over partner; NULL row → partner; unknown/NULL partner → `classic`/`a4`; fields resolve independently; unknown stored value normalizes.
- [ ] Run → red (module missing). Implement `resolveInvoicePresentation`. Green.

### Task 2 — tax resolver variant (unit, red first)
- [ ] `taxRateResolver.test.ts`: `resolveOrgTaxRateOn(executor, …)` uses the passed executor for both reads and never calls `readWithPartnerAxisVisibility`; org rate > partner rate > 0; exempt → null; missing org → `OrgNotVisibleForTaxError`; missing partner → `PartnerNotVisibleForTaxError`.
- [ ] Red, implement shared core, green; existing `resolveOrgTaxRate` tests stay green.

### Task 3 — schema + migration + export policy
- [ ] Drizzle columns + CHECKs; migration (DDL + batched counted system-scope backfill); export-policy `included`.
- [ ] `migrationRlsScope.test.ts`, `autoMigrate.test.ts`, `check-migration-naming.sh` green.

### Task 4 — stamping in both issue writers + draft tax (integration, red first)
- [ ] New integration suite asserts: (a) draft has NULL theme/page size; `issueInvoice` stamps the partner's current values; a later partner change does not alter the issued invoice's public `branding`, while a draft's public preview follows the partner. (b) quote accept stamps the quote's frozen snapshot even after the partner changed its default between send and accept. (c) void+reissue draft is NULL and stamps its own at issue. (d) a draft for an org with no own rate persists the PARTNER rate in `tax_rate`/`tax_total`; after the partner rate changes, the next draft mutation recomputes to it, and issue stamps the rate current at issue. (e) backfill: legacy non-draft rows with NULL columns get the partner's normalized current values, drafts stay NULL, a re-run is a no-op, WARNING count reported. (f) export-policy registry lists both columns.
- [ ] Run → red. Implement `invoiceService` + `quoteAcceptService` stamping + `effectiveRateForOrg` switch. Green.

### Task 5 — consumers
- [ ] `invoicesPublic.test.ts`: stamped invoice renders its own theme even when the partner row says otherwise; red → implement `brandingBlock(inv, partner, brand)` → green.
- [ ] `routes/invoices/invoices.test.ts`: detail route calls `resolveInvoiceBranding` with the invoice (no forged null); implement.
- [ ] Update affected unit mocks in `invoiceService.test.ts` / `quoteAcceptService*.test.ts` (partner select now carries theme columns; recompute reads partner).

### Task 6 — verify
- [ ] `tsc --noEmit` (12 GB heap, exit code checked); targeted vitest (unit + integration); `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; export-policy integration suites; `pnpm db:check-drift` against the test stack; tear the stack down.
