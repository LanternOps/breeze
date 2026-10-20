# Business Reports Phase 2: Client Profitability, MRR & Renewals, Quote Win Rate (Design Spec)

- **Issue:** #6830 (Phase 2 of #3198)
- **Date:** 2026-10-18, verified against `main` @ `23648a6246`
- **Status:** Draft. Awaiting Gate A (Todd). The Open Decisions are in §9.
- **Builds on:** `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` (Phase 1, approved), `docs/superpowers/plans/reports/2026-09-21-business-reports-INDEX.md` (Phase 1 W01–W03, merged)
- **Scope:** this spec only. The wave plans are written after Gate A.

## 1. Problem

MSP owners can now see SLA attainment, technician time, AR aging and AI usage from inside Breeze. They still cannot answer three money questions without exporting to a spreadsheet:

1. **Which clients make me money?** Revenue against what it cost to deliver, per client.
2. **What is my recurring revenue, and what is up for renewal?**
3. **How many of my quotes do I win?**

The issue body was written on 2026-08-31 against the Phase 1 spec. Several of its premises no longer match `main`, so this spec re-scopes from the code as built:

| Issue premise | `main` @ `23648a6246` | Effect on this spec |
|---|---|---|
| "MRR fails the computable-today bar. It needs per-device/per-seat quantity resolution on `contract_lines`" (Phase 1 spec fact 4) | **Solved.** `contract_lines.line_type` is now `flat / per_device / per_device_role / per_device_group / per_seat / manual / hour_block` (`schema/contracts.ts`). `resolveLineQty` (`services/contractService.ts`) resolves every type from one billable-device snapshot (`buildOrgDeviceSnapshot`, `services/contractSnapshot.ts`). `summarizeActiveContractMrrByOrg` (same file) already returns live, per-currency, interval-normalized MRR per org. It powers the partner dashboard (`routes/partner.ts`, `mrrByCurrency`). | MRR is now the cheapest of the three reports. The work is reuse, plus making the rollup's silent skips visible (§3.2, trap T3). |
| "`catalog_item_org_pricing` has no `cost_basis`, so per-customer margin falls back to partner-level `catalog_items.cost_basis`. Decide: add a per-org `cost_basis`, or report partner-level margin with a disclosure." | Every invoice line already carries a **cost snapshot**: `invoice_lines.cost_basis`, stamped at line creation only when the cost is in the invoice's currency and exact at its minor unit (`snapshotCost`, `services/catalogPricing.ts`). The internal invoice view already computes margin from it (`computeInvoiceProfit` in `apps/web/src/components/billing/invoiceTypes.ts`, built on `computeQuoteProfit` in `packages/shared/src/utils/quoteMath.ts`). | The issue's either/or does not apply. Margin is read from what was billed, not re-derived from today's catalog (§3.1, OD1). |
| Three reports exist | **Four** business types exist: `ai_usage_by_client` (#7608 W10) joined the Phase 1 trio in `BUSINESS_REPORT_TYPES` (`packages/shared/src/reportTypes.ts`). | Phase 2 follows the four-type registry pattern. AI pass-through margin is already reported there (§3.1). |
| Renewals need new data | `contracts.auto_renew / renewal_term_months / renewal_notice_days` and `contract_renewal_notices` (once-per-term idempotency) exist. The renewal sweep (`services/contractRenewal.ts`) sends advance notices and extends terms. | The renewals view is a read over existing columns. |
| Quote win rate needs instrumentation | `quotes` has `sent_at`, `first_viewed_at`, `accepted_at`, `declined_at`, `converted_at`, `expiry_date`, revision lineage (`revision_of_quote_id`, `revision_number`, `quotes_revision_of_uq`), and `one_time_total / monthly_recurring_total / annual_recurring_total`. | Pure SQL. Revision lineage is the subtle part (§3.3, trap T5). |
| Phase 2 includes ticket volume / backlog trend | Unchanged, but it shares no data, persona or permission with the three money reports. | Split out (OD6). |

Nothing in this phase needs a new table, route or job (§4).

## 2. Users & scope

- **Audience: MSP staff only.** All three types are `audience: 'msp_staff'` in the registry (`ReportTypeDef.audience`, `services/reportRegistry.ts`). Organization-scope callers (customer users, org API/MCP keys) never see them: writes return 403, and reads are hidden (excluded from lists, 404 by id). This rule is mechanical through `isMspStaffReportType` / `reportTypeHiddenFromCaller`, not new code. Nothing is portal-visible. None of the three types joins `MANAGED_EVIDENCE_REGISTRY` or `PORTAL_DEFINITIONS`.
- **Primary lens: partner scope** ("all my clients, grouped by org"), with an org-owned instance as the drill-down: `supportedScopes: ['organization', 'partner']` (`ORG_OR_PARTNER`), exactly like Phase 1. A partner-owned report needs `org_access = 'all'` (`partner_wide` authority, Phase 1 §3.1a). The partner org list is `resolvePartnerReportOrgIds` (active and trial orgs only), and each report prints `PARTNER_ORG_LIST_NOTE`. See trap T6 for why that exclusion matters more for MRR than for AR.
- **Permissions:** checked per type in the route layer from `BUSINESS_REPORT_REQUIRED_PERMISSIONS` (`packages/shared/src/reportTypes.ts`). The web gallery reads the same object (`apps/web/src/components/reports/businessReportAccess.ts`).

  | Type | Required grants | Why |
  |---|---|---|
  | `mrr_renewals` | `CONTRACTS_READ` | Contracts and their lines are the only source. |
  | `quote_win_rate` | `QUOTES_READ` | Quotes only. |
  | `client_profitability` | `INVOICES_READ`, `TIME_ENTRIES_READ` | Revenue and cost come from invoice lines. `INVOICES_READ` already returns `cost_basis`: `GET /invoices/:id` is gated by `readPerm` (`routes/invoices/invoices.ts`) and calls `getInvoice` (`services/invoiceService.ts`), which selects every `invoice_lines` column. The internal invoice view shows margin from that. No new cost-visibility grant is needed. Hours come from time entries, with the same all-entries scope R2 uses. |

- **Site-restricted authorities: refused, with a printed note** (the Phase 1 rule). Contracts, quotes and invoices do carry an optional `site_id`, but an org-wide contract line or invoice belongs to no site, so a site-filtered MRR or margin figure would be a wrong aggregate rather than a narrower one. `SITE_RESTRICTED_NOTE` (`services/businessReports/common.ts`) names only "tickets, time entries and invoices". W1 generalizes the wording to "this report's records", or adds a per-type note. A report refuses rather than printing a reassuring zero (the Phase 1 rule).

## 3. Proposed design

All three types reuse the Phase 1 engine unchanged: the registry entry (`ReportTypeDef`), `ReportScope` + `runInReportScope`, explicit `partner_id` / org-allowlist predicates in every query (RLS is the backstop, not the fence), period resolution in the owner's timezone (`resolveReportPeriod` / `resolveReportOwnerTimezone`, `services/businessReports/period.ts`), per-currency money rows with no FX, `notes: string[]` for disclosed approximations, `BUSINESS_DETAIL_ROW_CAP` (5,000) on detail rows with aggregates computed before the cap, scheduling and email via `reportScheduleWorker.ts`, and the prior-run baseline (`previousBaselineFor`).

### 3.1 R4: Client profitability (`client_profitability`)

**The question it answers:** for each client in the period, what did I bill, what did the billed goods and services cost me, and how much technician time did the client consume?

**Revenue and product cost: issued invoice lines.**

- **Invoices:** `status IN ('sent','partially_paid','overdue','paid')`. Never `draft`; never `void`. A replaced invoice is voided, so its replacement counts once. The period filters `invoices.issue_date`, a date column compared against the period's local dates in the owner timezone (the AR-aging `asOf` convention).
- **Lines:** top-level only (`parent_line_id IS NULL`) and `customer_visible = true`. These are exactly the rules of `computeInvoiceProfit` / `computeQuoteProfit`. A bundle's parent line carries the **whole** bundle cost, and its child component lines carry their own `cost_basis`, so folding over every line double-counts bundle costs (trap T1).
- **Formulas per line:** revenue = the stored `line_total`, which is pre-tax. It equals `computeLineTotal(quantity, unit_price)`, the same cents math `computeQuoteProfit` uses, so the report reconciles to invoice subtotals and the parity test proves the two agree. Cost = `quantity × cost_basis` when `cost_basis IS NOT NULL`. A line with `cost_basis IS NULL` goes into **unknown-cost revenue** and is never treated as zero cost. An explicit `0.00` cost is a known zero. These are the existing `linesMissingCost` semantics, and they matter because time-entry lines, hour-block overage lines and AI-usage lines are always stamped with a NULL cost (`services/invoiceAssembly.ts`).
- **Partial-cost bundles count as unknown cost.** `computeBundleEconomicsFrom` (`services/catalogPricing.ts`) counts a component with a NULL cost as 0, so a bundle parent's `cost_basis` can look complete when it is not. R4 treats a parent line as unknown-cost when any of its child lines has `cost_basis IS NULL`, and reports how many bundles this affected (trap T10). This is the one place R4 deliberately differs from `computeInvoiceProfit`. A follow-up can align the margin panels.
- **Gross margin** = revenue − cost over cost-bearing lines only. **Margin %** = gross margin ÷ cost-bearing revenue (`marginPct`). **Cost coverage %** = cost-bearing revenue ÷ total revenue, printed beside every margin figure. Without the coverage figure, a client billed mostly for labor would show a misleading margin computed from a sliver of its revenue.
- **Revenue mix by `invoice_lines.source_type`:**
  - recurring: `contract`
  - labor: `time_entry`
  - product: `part`, `catalog`, `bundle`, **and `manual` lines with a non-null `catalog_item_id`**. Quote acceptance writes one-time lines as `source_type = 'manual'` with the catalog item id carried over (`quoteAcceptService.ts`), so a source-type-only mapping would file every quote-sold product under "other".
  - AI: `ai_usage`
  - other: the remaining `manual` lines

  This is the column an owner reads first ("this client is 80% labor").
- **Parity:** the SQL fold must equal `computeInvoiceProfit` for any single invoice, except for the partial-cost bundle rule above. W3 pins this with a parity test over shared fixtures.
- **W3 prerequisite: stop dropping known cost at quote acceptance.** `quoteAcceptService.ts` writes `costBasis: null` on every one-time invoice line it creates, even though `quote_lines.unit_cost` holds the cost in the same currency (trap T9). As shipped, every product sold through an accepted quote would read as unknown-cost revenue. W3 stamps `unit_cost` through `snapshotCost` onto those lines. The fix is forward-only, and the report notes that invoices accepted before the fix carry no cost. A backfill is not proposed, because invoice lines carry no link back to their quote line.

**Labor: hours, not dollars, by default.** No internal labor cost rate exists anywhere. `billing_profiles.base_hourly_rate`, `billing_profile_*.hourly_rate`, `billing_profiles.default_hourly_rate` and `time_entries.hourly_rate` are all **bill** rates. The report therefore publishes, per org:

- **Hours worked** = `SUM(time_entries.duration_minutes) / 60` for completed entries (`ended_at IS NOT NULL`, the R2 rule, so running timers are excluded) with `started_at` in the period and `org_id` = the org, split by `coverage` (`billable` / `included` / `non_billable`; `is_billable` is the fallback when `coverage IS NULL`, as in R2). Included time is the cost to serve a managed contract, and it is the number an owner most needs beside contract revenue.
- **Effective hourly rate (service)** = (recurring + labor revenue) ÷ hours worked, per currency. Product resale and AI pass-through are excluded from the numerator, so a hardware-heavy month does not make a client look like an efficient service account. This is the standard MSP profitability measure, and it needs no cost data. **Total revenue per hour** is shown beside it. Both are null when no hours were worked.
- At partner scope, time with `org_id IS NULL` is reported once as an "internal / unattributed time" line, never spread across clients.
- Optional and approximate: see OD2 for a uniform `laborCostPerHour` config parameter that turns hours into an *estimated contribution after labor*.

**AI usage** revenue appears in the mix. Its cost is NULL on the invoice line because the Breeze cost is in USD and is never combined with a charge in the invoice currency (`aiUsageByClientReport.ts`). The report prints a note pointing to `ai_usage_by_client`, which already reports AI cost against charges.

**Timing disclosure:** this is invoiced (billed) revenue in the period, not accrual-recognized revenue. An annual contract invoiced in January lands entirely in January. Hours are counted when worked, and the invoices for that work may fall in a later period (arrears). Both effects are printed as notes. Spreading recurring revenue over its billing period is available as an option (OD3).

**Group-bys:** org (default), revenue source type, and at org scope the invoice itself (detail rows). **Detail rows:** one per org, with revenue, cost, margin, coverage, hours by coverage, and effective rate.

### 3.2 R5: MRR & renewals (`mrr_renewals`)

**The question it answers:** what do my active agreements bill per month right now, by client, and which agreements end soon?

**MRR source: `summarizeActiveContractMrrByOrg`, extended rather than re-implemented.** The rollup already does the following:

- It counts `status = 'active'` contracts that are not past their end. `isPastEndForReporting` applies the billing sweep's `isExpired` test, because `active` contracts flip to `expired` lazily at the next billing date.
- It resolves every line through `resolveLineQty` from one device snapshot, so it agrees with `computeContractEstimate` and with the next invoice.
- It prices catalog-linked lines through `resolvePriceFrom` (org override → price book → stamped snapshot).
- It normalizes each contract by `interval_months` and rounds in the contract's own currency.
- It groups by `currency_code` and never sums across currencies.

**W1 refactor: per-contract rows first, org totals derived.** The function today returns `Map<orgId, { currencyCode, amount }[]>`, summing cents inline, and loads only `status = 'active'` rows. W1 splits it as follows:

- `resolveContractMrrRows(orgIds, asOf, opts)` → `{ rows: ContractMrrRow[]; skipped: SkippedContract[] }`, where:
  - `ContractMrrRow = { contractId, orgId, status, inTermBasis: 'active' | 'billed_final_term', currencyCode, intervalMonths, baseMonthly, overageMonthly, mrr, endDate, autoRenew, renewalTermMonths }`
  - `SkippedContract = { contractId, orgId, reason: 'group_evaluation_failed' | 'site_deleted' }`
  - A deleted billed group still counts 0, as today, but sets a per-row `unresolvedGroup` flag that the report counts.
- `opts.statuses` selects which statuses to resolve. The report also asks for `paused` and `draft`, so it can print paused MRR and pending activation.
- `summarizeActiveContractMrrByOrg` becomes a thin fold over `rows`. Its signature and output are unchanged for `routes/partner.ts`, apart from the T8 correction below. Skipped contracts are logged as today.

A rollup that fails must fail loudly, never by omission (trap T3): the report prints every skipped contract and its reason.

**Eligibility is "in term", not `status = 'active'` (trap T8).** `generateDueInvoice` flips a contract to `expired` as soon as it bills a period whose *successor* starts at or after `end_date` (`contractService.ts`, "Advance the pointer … or expire"). Two cases follow:

- An **advance-billed** contract is `expired` for the whole of its final, paid, still-served period.
- A one-year contract billed annually in advance is `expired` right after its only invoice, so the shipped rollup never counts it at all.

W1 therefore adds one shared predicate, `contractInTermForReporting(c, asOf)`, used by both the report and the dashboard rollup. A contract is in term when all of the following hold:

- `start_date ≤ asOf`. A future-start contract is excluded.
- `end_date` is NULL, or `asOf < end_date`.
- Its status is either:
  - `active` and not `isPastEndForReporting` (trap T4), or
  - `expired`, with a `contract_billing_periods` row covering `asOf` (the prematurely flipped final term).

**Valuing a `billed_final_term` contract:** do not use live resolution. The expiry also runs `retireLiveHourBlocks`, so a live resolve would value its block fee at 0. Use the amount actually billed for the covering period instead: Σ top-level `invoice_lines.line_total` with `source_contract_id` = the contract on that period's `invoice_id`, divided by `interval_months`, split into base and overage the same way. This is exact, it needs no re-resolution, and it is labelled "final term (billed)" in the detail rows.

`paused`, `cancelled` and `draft` are never in term. Cancellation stamps no date and keeps `end_date`, so a cancelled contract drops out immediately. That is right for MRR. This changes the partner dashboard's MRR figure for affected partners, which is a correction, and the release note says so.

**Definitions:**

- **MRR** = Σ over counted contracts of (period value ÷ `interval_months`). Period value is the base leg at the resolved quantity plus the billed overage leg (`overage_mode = 'bill'`). The base and overage components are reported as separate columns, so "of which overage" is visible. `flag`-mode overage is not billed and is not MRR.
- **`hour_block` lines:** the block fee counts once per period. `resolveLineQty` returns quantity 1 for a live block and 0 for a retired one, and a `billed_final_term` contract uses its billed amount instead. Hours consumed and block-overage hours are usage, not MRR. They belong in R4.
- **ARR** = MRR × 12, per currency. A display convenience only, never a separate computation.
- **Not in MRR, but reported beside it:** `paused` contracts (count and their estimated MRR, as "paused MRR"), and `draft` contracts (count and estimated MRR as "pending activation"; quote acceptance creates contracts as drafts, `quoteAcceptService.ts`). This requires the rollup to accept a status parameter.
- **As-of = run time.** Contracts carry no status-change history (there is no `cancelled_at` and no status log), so a backdated MRR cannot be reconstructed. The config refuses an `asOf` key, so a past date can never be silently answered with today's number. Contract dates are UTC dates throughout billing (`todayISO`, `services/contractMath.ts`), and the report uses the same convention so it agrees with the sweep. A note says so.

**Renewals section.** In-term contracts, including `billed_final_term` ones, with `end_date` in `[asOf, asOf + horizon)`, where `renewalHorizonDays` is one of 30/60/90/180 and defaults to 90. Each row shows org, contract, `end_date`, days remaining, `auto_renew`, `renewal_term_months`, whether an `advance` notice exists in `contract_renewal_notices` for that `end_date` (and when it was sent), and **MRR at stake**: that contract's monthly value from the same rollup. Totals are split into auto-renewing and manual-renewal contracts, because only the manual ones need someone to act. Notice rows are bookkeeping only. The report does not derive a historical renewal rate from them. Two reconciliation lines:

- **Active but not in term:** every `status = 'active'` contract that fails `contractInTermForReporting`, with its reason. The reason is either "ended, awaiting expiry", which covers an arrears contract whose last period is over but not yet billed, or "starts on <date>". The line is defined as the complement of the predicate, not by a second test, so no active contract can fall between MRR and this line.
- **Evergreen:** the count and MRR of contracts with `end_date IS NULL`.

**Trend: no snapshot table in this phase (OD4).**

1. The scheduled run already carries the prior run's summary (`previousBaselineFor`). The PDF scorecard shows "MRR vs previous observation" per currency, labelled with that run's date. It is never labelled "vs last month", because the prior run may be from any date. History starts at the first scheduled run of a definition, and the report says so.
2. **Billed recurring revenue, last 12 months:** `invoice_lines` with `source_type = 'contract'` on issued invoices, top-level, by month in the owner timezone, per currency. This series is reconstructable and exact, and it is labelled "billed", never "MRR". Where the invoice is the invoice of a `contract_billing_periods` row, the line total is spread evenly across the months of `[period_start, period_end)`, so annual contracts do not spike. Lines without a billing period (interactive materialization) land in their issue month.

MRR movement analysis (new, expansion, contraction, churn) needs contract history and is out of scope (§5).

**Group-bys:** org (default), contract. Detail rows: one per contract, with org, name, status, interval, currency, base, overage, MRR, end date and auto-renew.

### 3.3 R6: Quote win rate (`quote_win_rate`)

**The question it answers:** of the opportunities I quoted in the period, how many and how much did I win, and how fast?

**Unit = the opportunity, not the quote row.** A declined or expired quote can be revised (`REVISABLE_STATUSES = sent, viewed, declined, expired`, `services/quoteTypes.ts`). Sending or accepting the revision retires the parent to `superseded` (`resolveParentToSupersede`, `services/quoteLifecycle.ts`). Counting rows would therefore score one won deal as a loss plus a win (trap T5). The lineage is linear: `quotes_revision_of_uq` allows one successor at most. The generator walks it with a recursive CTE from each root (`revision_of_quote_id IS NULL`). The CTE carries a depth guard as defense in depth, since the unique index already prevents cycles. Lineage walks are confined to one org by the composite `quotes_revision_of_fk (revision_of_quote_id, org_id)`.

- **Terminal version** = the latest version in the lineage whose status is not `draft`. A revision still being drafted leaves the parent's outcome standing, because the parent is superseded only on send or accept.
- **Cohort** = lineages whose **first** `sent_at` (minimum over versions) falls in the period, evaluated in the owner timezone. Never-sent lineages are excluded.
- **Outcome of the terminal version:**
  - **won:** `converted` or `accepted` (accept writes `converted` directly; `accepted` is kept for legacy rows).
  - **lost:** `declined`.
  - **expired:** `expired`, **or** `sent`/`viewed` with `expiry_date` before the as-of UTC date. This is the `isQuoteExpired` read-time rule, because the reaper (`jobs/quoteExpiryReaper.ts`) can lag (trap T5b).
  - **open:** `sent` or `viewed` and not past expiry.
  - `superseded` is never terminal, by construction.

**Formulas:**

- **Win rate (decided)** = won ÷ (won + lost + expired). This is the headline, printed beside the open count (OD5).
- **Close rate (cohort)** = won ÷ all cohort lineages, open included.
- **Value**, per currency, pre-tax (`computeQuoteTotals` sums line totals before tax; `total` also folds in the first recurring periods and tax, so it is never used), and taken from the terminal version: quoted vs won `one_time_total`, quoted vs won **monthly recurring value** (`monthly_recurring_total + annual_recurring_total / 12`), and a value-weighted win rate per currency.
- **Viewed rate** = lineages with any `first_viewed_at` ÷ cohort.
- **Time to close** = median days from first `sent_at` to `accepted_at` (won) and to `declined_at` (lost).
- **Maturity note:** a recent cohort still has open quotes, so its close rate understates the final rate. A note says so whenever open > 0.

**Group-bys:** org (default), quote author (`created_by` of the root, labelled "quote author"; there is no sales-owner field), currency. Detail rows: one per lineage, with number, org, versions, first sent date, outcome, outcome date, values, and decline reason (detail only, never aggregated).

**Quote → contract conversion is not measured.** Accepted quotes create draft contracts, but no durable `contracts.source_quote_id` exists. `contract_documents.quote_id` is set only when the quote carried a contract block. The won monthly recurring value is the honest proxy, and R5's "pending activation" line shows drafts that were never activated.

### 3.4 Exports, PDF and web: the Phase 1 per-type surface

For each type, following the shipped business types:

- **API/shared:** a registry entry (`services/reportRegistry.ts`) and a config schema in `services/reportConfigSchemas.ts` (a `looseObject` spreading `BUSINESS_SELECTOR_REFUSALS`, plus refusals of `asOf` for `mrr_renewals`). The generator lives in `services/businessReports/<type>Report.ts`. The summary type goes in `packages/shared/src/types/businessReports.ts`. A grants entry is added to `BUSINESS_REPORT_REQUIRED_PERMISSIONS` and the type is appended to `REPORT_TYPES` + `BUSINESS_REPORT_TYPES`.
- **PDF:** one module per type in `packages/shared/src/reportPdf/` (`clientProfitabilityPdf.ts`, `mrrRenewalsPdf.ts`, `quoteWinRatePdf.ts`) on the primitive kit, money through `moneyFormat.ts`. Each module adds a new arm to `buildReportPdfWithPalette` and widens `BuildOpts.summary`. The scorecard renders the `previous` baseline chip.
- **CSV/XLSX parity:** `apps/web/src/components/reports/reportExport.ts` emits raw numerics plus a `currency_code` column, never formatted strings (the Phase 1 rule). The export contains the detail rows plus one block of summary rows per currency. Each type ships a `reportExport.<type>.test.tsx`.
- **Web:** a "Business" template card plus `<Type>OptionsForm.tsx` (period / group-by / horizon / `laborCostPerHour` if OD2 lands), following `AiUsageByClientOptionsForm.tsx`. The form's keys are added to `BUSINESS_OPTION_CONFIG_KEYS` (`businessReportConfig.ts`). New strings go in all locale `reports.json` files (`apps/web/src/lib/i18n/localeParity.test.ts`), and new controls get a `data-testid`. Report create and save already go through the existing mutation path, which uses `runAction`, so no new mutation handler is added.
- **Docs:** `apps/docs/src/content/docs/features/reports.mdx` plus a release note per wave.

### 3.5 AI / MCP exposure: none in this phase

`generate_report` (`services/aiToolsFleet.ts`) lists only the six legacy types in its `reportType` enum. None of the four shipped business types is AI-reachable today. Phase 2 keeps that parity. Exposing all seven business types together is a separate follow-up (§5), and its audience gating already exists (`reportTypeHiddenFromCaller`, `reportAudienceCondition`). No route is added, so there is no `mcp-coverage.test.ts` entry. The line-keyed `SAFE_WRITE_SITES` contract tests are untouched because no AI write site changes.

## 4. Tenancy & data model impact

**New tables: none. New columns: none (unless OD1-B, OD2-C or OD8-B is chosen). New routes: none. New jobs: none.**

| Change | Contract obligations |
|---|---|
| `report_type` enum gains `client_profitability`, `mrr_renewals` and `quote_win_rate`, **one enum-only migration per wave** that adds that wave's type | Name it to sort after the newest committed migration at commit time (the newest today is `2026-12-31-170000-…`). Use `ALTER TYPE … ADD VALUE IF NOT EXISTS`, idempotent, with no `BEGIN`/`COMMIT` and no row writes, so no `breeze.scope` election is needed. The Drizzle `reportTypeEnum` is updated and pinned to `REPORT_TYPES` by the existing equality test. `REPORT_TYPES` order equals the enum order, appended at the end. Each wave adds its own value because `REPORT_GENERATORS` is `satisfies Record<ReportType, …>`, and an enum value without a generator does not compile. |
| `resolveContractMrrRows` extracted from `summarizeActiveContractMrrByOrg`, plus `contractInTermForReporting` (§3.2) | The `routes/partner.ts` output shape is unchanged. The existing contract MRR tests are extended, and the T8 correction is pinned by a test. |
| Read-only consumers of `contracts`, `contract_lines`, `contract_renewal_notices`, `contract_billing_periods`, `invoices`, `invoice_lines`, `time_entries`, `quotes` | No RLS, cascade or export-policy change. Every query carries explicit `partner_id` / org-allowlist predicates under `runInReportScope`. |

No new table means no `rls-coverage` allowlist entry, no `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry` / `CORE_TENANT_EXPORT_POLICY` registration, and no `workerReadinessManifest.ts` entry. If OD1-B, OD2-C or OD8-B is chosen, §4 grows by the obligations named in those options, and the PR states the tenancy shape (Partner-Wide First).

## 5. Out of scope

- **Ticket volume / backlog trend.** Split into its own issue (OD6).
- **FX conversion.** Every money figure is per currency (Phase 1 OD4 stands).
- **Backdated MRR, and MRR movement** (new / expansion / contraction / churn bridges). Both need contract status history, which does not exist (OD4).
- **Accrual or recognized revenue.** R4 reports billed revenue, with the spread option in OD3 only.
- **A per-technician cost-rate table, loaded labor cost, payroll integration** (OD2).
- **Quote → contract activation tracking** (OD8), and win rate for standalone signed agreements (#8865; agreements carry no price and no lost outcome).
- **AI/MCP exposure** of business reports (§3.5). File it as one follow-up covering all seven types.
- **Portal / client-facing views, the QBR multi-section pack, `/analytics` business metrics, mobile.** These are unchanged from the Phase 1 exclusions.
- **Accounting-system data** (Xero / QuickBooks sync). Breeze invoices are the source of truth.

## 6. Traps the as-built code sets (named so the plans pin each with a test)

- **T1: Bundle double count.** Parent bundle lines carry the full bundle cost, and their children carry their own costs. The fold must be top-level only (`parent_line_id IS NULL`). Test: an invoice with a visible-component bundle yields the same margin as `computeInvoiceProfit`.
- **T2: NULL cost is not zero cost.** Time, hour-block overage and AI lines are always NULL-cost. Summing `COALESCE(cost_basis, 0)` would report ~100% margin on labor. Test: an all-labor invoice yields null margin %, 0% cost coverage, and full unknown-cost revenue.
- **T3: The MRR rollup drops contracts silently.** `GROUP_EVALUATION_FAILED` and a deleted billed site skip the whole contract behind a `console.warn`; a deleted group counts as 0. The report must list skipped contracts and the reason, and print a "MRR excludes N contracts" note. Test: one contract with a broken group filter still appears in `skipped`.
- **T4: `active` does not mean running.** Ended contracts keep `active` until their next billing date. Always go through `isPastEndForReporting`; never filter `status = 'active'` alone.
- **T5: Revisions double-count quote outcomes**, and (T5b) the expiry reaper can lag: a `sent` quote past `expiry_date` is expired at report time. Tests: decline → revise → accept is one won lineage; a stale `sent` row past its expiry is counted as expired.
- **T6: The partner org list excludes suspended orgs.** A suspended client's contracts may still be billing. MRR therefore understates billed recurring revenue for suspended clients. This is consistent with AR (Phase 1), and `PARTNER_ORG_LIST_NOTE` discloses it. The R5 note names it explicitly because owners read MRR as a total.
- **T7: Date vs timestamp columns.** `invoices.issue_date` and contract dates are `date` columns, while `quotes.sent_at` and `time_entries.started_at` are timestamps. Each comparison must use the owner-timezone local date or instant consistently. Contract-side "today" stays UTC to agree with billing.
- **T8: `expired` does not mean ended.** Billing flips an advance-billed contract to `expired` when it bills the final period, so the period it just billed and is still serving drops out. A one-year contract billed annually in advance never appears in today's rollup. Test: an annual advance contract mid-term is in MRR; the same contract after `end_date` is not.
- **T9: Quote acceptance discards known cost.** One-time invoice lines created on accept are written with `costBasis: null` although `quote_lines.unit_cost` exists. The W3 prerequisite in §3.1 fixes this forward-only.
- **T10: Bundle cost treats missing component cost as 0** (`computeBundleEconomicsFrom`). R4 classifies such a bundle as unknown-cost (§3.1).
- **T11: Quantities are live and can disagree with the contract editor.** Seats are active Breeze users mapped to the org (`countContractSeats`), not licensed seats. `computeContractEstimate` prices with the line's stamped unit price, while the rollup and billing use the resolved catalog price. R5 follows billing, and its notes say quantities are counted at run time.

## 7. Wave split

Vertical slices: each wave ships one complete, user-visible report (API, PDF, export, web, locales, docs). The Phase 1 infrastructure makes a horizontal split unnecessary, and each wave can ship on its own.

| Wave | Content | Depends on | Blast radius |
|---|---|---|---|
| **W1: MRR & renewals** | Enum migration (`mrr_renewals`); `contractInTermForReporting` (T8) shared with the dashboard rollup; the `summarizeActiveContractMrrByOrg` return-shape change + status parameter + dashboard caller; generator, billed-recurring series, PDF, export, web form, locales, docs | OD4, OD7 | Medium: changes the dashboard MRR figure (a correction); enum migration |
| **W2: Quote win rate** | Enum migration (`quote_win_rate`); lineage CTE; generator, PDF, export, web, locales, docs | OD5, OD8 (can run in parallel with W1; serialize only the enum migration names) | Low (pure read) with OD8-A; **medium-high** with OD8-B (billing-table column + FK + export policy) |
| **W3: Client profitability** | The quote-accept cost stamp (T9, in its own commit); enum migration (`client_profitability`); the invoice-line fold with the `computeInvoiceProfit` parity test; hours and effective rate; OD2/OD3 outcomes; PDF, export, web, locales, docs | OD1–OD3 resolved; the T9 commit lands before the parity test | Medium: the T9 fix touches the accept transaction. **High** if OD1-B/OD2-C add schema. |

Order rationale: W1 is the most-asked-for report, and its quantity resolver is already built. W3 carries the most judgment and waits on Todd's OD1–OD3. W2 and W1 touch disjoint files apart from `REPORT_TYPES`, the registry and the locale files, so they can run in parallel. Run them serially if the merge-conflict cost on those shared files outweighs the time saved.

**What can start before every Open Decision closes:** W1 needs only OD4 and OD7, and both have agreed recommendations. W2 needs OD5 (agreed) and OD8, which is unresolved. With OD8-A, W2 can start immediately. W3 waits on OD2, which is unresolved. OD6 gates nothing in this spec.

## 8. Test & rollout notes

- **Generators:** unit tests with Drizzle mocks for each formula, each null-ratio case (a zero denominator yields null, never 0 or NaN, via `ratio` in `common.ts`), each trap T1–T7, per-currency grouping, and detail-cap truncation with aggregates computed before the cap. Each type also gets an integration test against real Postgres proving partner scope sees rows across ≥2 orgs and respects the org allowlist. Assert on bound parameters; don't scan SQL text for tokens.
- **Registry/shared:** the existing `REPORT_TYPES` ↔ `reportTypeEnum` equality test; `schemas.configParity.test.ts` gets a stored-config fixture per new type; `businessReportAccess.test.ts` pins grants identity; the audience test covers the new `msp_staff` types (org-scope caller → 403 on write, 404 on read).
- **Contract rollup change (W1):** the dashboard response is unchanged for healthy contracts; skipped contracts are surfaced, not dropped.
- **PDF / export:** per-type `reportPdf.<type>.test.ts` and `reportExport.<type>.test.tsx` (raw numerics plus currency code).
- **Web:** options-form tests, a template-gallery test, `localeParity`, and an E2E smoke test per type in the existing `e2e-tests/tests/business-reports.spec.ts` (`data-testid` selectors only).
- **CI:** no tenancy change, so Test API, Test Web and the usual integration shards suffice. Run the enum migration through `autoMigrate.test.ts` ordering.
- **Rollout:** no feature flag. A new enum value is inert until a report of that type exists. There are no new env vars. Release notes list each new report type for self-hosters.

## 9. Open Decisions

1. **Where does per-client cost come from?**
   - **A: The invoice-line snapshot (`invoice_lines.cost_basis`), plus coverage % and unknown-cost revenue. No schema.** Pro: margin on what was actually billed, in the invoice's currency, matching the invoice detail rail exactly; immune to later catalog edits. Con: lines invoiced with no cost stay unknown forever (no backfill).
   - **B: Add `cost_basis` to `catalog_item_org_pricing` (the issue's proposed fork).** Pro: lets a partner record per-client vendor cost. Con: vendor cost rarely varies per customer, so this is a new column on an org-axis table (an export-policy classification and its tests) for a rare case. It also changes nothing about margin on past invoices, which already carry their snapshot.
   - **C: Recompute from today's `catalog_items.cost_basis`.** Pro: covers lines that lacked a cost at billing time. Con: restates history whenever a catalog cost changes, and crosses currencies.
   - **Recommend A.** The snapshot already exists and is the source the product's own margin panel trusts. B can be revisited if a partner shows a real per-customer cost case.
2. **How is technician labor costed?**
   - **A: Hours plus effective hourly rate only (no labor dollars).** Pro: exact, with no invented data. Con: no "profit after labor" figure.
   - **B: A as the default, plus an optional uniform `laborCostPerHour` + currency config parameter producing a labelled *estimated contribution after labor*.** Pro: gives owners the number they want, honestly labelled, and mirrors the approved `weeklyCapacityHours` precedent (Phase 1 OD3). Con: one blended rate hides senior/junior cost differences.
   - **C: A new per-technician cost-rate table** (partner-owned; a `partner_id NOT NULL` shape needs a stated justification under Partner-Wide First, plus RLS, cascade, export policy and an HR-sensitivity review). Pro: accurate. Con: a tenancy migration for one consumer. Scheduling/dispatch is the natural second consumer and should shape the table.
   - **Recommend B** (Opus). It ships the headline owners ask for without schema, and C waits for a second consumer, exactly as Phase 1 deferred `technician_capacity`.
   - **Codex recommends A:** exclude labor dollars explicitly and defer full profitability. Its reason: a single invented rate can make an unprofitable client look profitable, and the report's credibility rests on every figure being sourced. **Unresolved quorum disagreement; Todd decides.** B is A plus an opt-in. With the parameter unset, B behaves exactly like A, so choosing B costs little if the figure is printed only when the parameter is set and always carries an "estimate" label.
3. **When is recurring revenue counted in R4?**
   - **A: At invoice `issue_date` (billed basis), with a note.** Pro: reconciles to invoices and AR. Con: annual contracts spike in their billing month.
   - **B: Spread contract-sourced revenue over its `contract_billing_periods` window** (the same allocation as R5's billed series). Pro: smoother per-period margin. Con: R4 then disagrees with invoice totals for the period, which needs a reconciliation line.
   - **Recommend A for v1**, with B's spread already present in R5's billed series. Revisit if owners report annual-contract distortion.
4. **Does MRR history need a materialized snapshot table?**
   - **A: No table. Use run-over-run baseline chips plus the reconstructable billed-recurring series (§3.2).** Pro: no tenancy work, and exact history from day one via invoices. Con: no contracted-MRR history before a definition's first scheduled run, and no churn/expansion bridge.
   - **B: A monthly `mrr_snapshots` table** (org-owned, Shape 1 RLS, cascade/merge/export registrations, plus a worker job in `workerReadinessManifest.ts`). Pro: true contracted-MRR history and movement analysis. Con: high-blast-radius schema plus a job, history only from deployment day anyway, and it duplicates what scheduled report runs already store.
   - **Recommend A.** Revisit B as its own feature if owners ask for churn bridges.
5. **What is the quote win-rate headline denominator?**
   - **A: Decided only, won ÷ (won + declined + expired), with the open count beside it.** Pro: stable once decided, and treats expiry as the loss it is in practice. Con: flatters a period with many open quotes.
   - **B: The cohort, won ÷ all sent.** Pro: no exclusion. Con: recent periods always look bad until their quotes settle.
   - **C: Exclude expired from the denominator** (won ÷ (won + declined)). Con: rewards letting quotes lapse instead of chasing a decline.
   - **Recommend A, showing B as a secondary figure.**
6. **Does ticket volume / backlog trend belong in this phase?**
   - **A: Split it into its own issue.** Pro: it is a service metric with a different persona and permission (`TICKETS_READ`), and an honest backlog trend needs reopen history that `tickets` does not keep (no status log). Con: the title of #6830 promised it.
   - **B: Add it as a fourth wave, reconstructing backlog from `created_at` / `resolved_at`** with a reopen disclosure.
   - **C (codex): Ship arrival volume, current backlog, and backlog-trend observations from scheduled runs in a fourth wave now; split out only the historical reconstruction.** Reopen clears `resolved_at` / `closed_at` (`ticketService.ts`), but status changes are already logged as `ticket_comments` rows with `comment_type = 'status_change'` and `old_value` / `new_value`. Audit that log's coverage, imports and deletion semantics before inventing a history table.
   - **Recommend A** (Opus). The orchestrator files the follow-up, and it should carry codex's C framing and the `status_change` comment lead as its starting point. The three money reports form one owner/finance pack, and a service report has no reason to wait on them or delay them. **Unresolved quorum disagreement on placement only.** Both sides agree a historical backlog needs the comment-log audit first.
7. **One `mrr_renewals` type, or separate `mrr` and `contract_renewals` types?**
   - **A: One type with two sections.** Pro: one contract resolution pass; renewals carry "MRR at stake" for free; one monthly owner report. Con: a renewals-only schedule (for an account manager) carries the MRR section too.
   - **B: Two types.** Pro: separate audiences. Con: two enum values, two of each surface, and duplicated resolution.
   - **Recommend A.** A section toggle in the options form covers the account-manager case if requested.
8. **Should W2 add a durable quote → contract link so conversion can be measured?**
   - **A: No column. Report won monthly recurring value (R6) and draft "pending activation" contracts (R5).** Pro: no schema change. Con: no per-quote "accepted but never activated" attribution.
   - **B (codex): Add nullable `contracts.source_quote_id`, stamped inside the accept transaction.** This needs a same-org composite FK `(source_quote_id, org_id) → quotes(id, org_id)` `DEFERRABLE INITIALLY IMMEDIATE` `ON DELETE SET NULL (source_quote_id)`, a `CORE_TENANT_EXPORT_POLICY` classification for the new column, an org-merge check (contracts and quotes move together), and a migration. Pro: real conversion and time-to-activation metrics going forward. Con: a schema change on a billing table, forward-only (legacy contracts stay unknown), for a metric no one has asked for yet.
   - **Recommend A** (Opus); codex recommends B. **Unresolved quorum disagreement; Todd decides.** If B is chosen, it belongs in W2 as its own commit, with the tenancy obligations above, and §4 grows accordingly.

## 10. Advisor quorum

My (Opus) position was written before consulting codex: `codex exec`, gpt-6-astra, read-only, `xhigh`, run 2026-10-18 on `main` @ `23648a6246`. Codex was given the facts to verify and the questions, not this draft.

**Agreed independently:**

- Margin comes from the `invoice_lines.cost_basis` snapshot, unknown cost is never zero, bundles count once, and there is no per-org cost column (OD1-A).
- No internal labor cost rate exists.
- MRR reuses the billing quantity and price resolver, per currency, `hour_block` as one fee, overage separated.
- No MRR snapshot table; scheduled runs are the observation history (OD4-A).
- Quote win rate is counted by revision lineage, with the decided-only denominator and the open count (OD5-A), and expiry follows the read-time UTC rule rather than waiting for the reaper.
- No new routes or jobs. `msp_staff`, partner/org scope and the site-restricted refusal are kept.

**Adopted from codex (each verified in code before adoption):**

- T8, premature `expired` on advance-billed final terms, and the in-term eligibility predicate with future-start exclusion.
- T9, quote acceptance writes `costBasis: null`; the fix is a W3 prerequisite.
- T10, bundle economics counts a missing component cost as 0.
- T11, seats are active Breeze users, and the editor estimate uses stamped prices while billing uses resolved prices.
- The "previous observation" labelling.
- Renewals split by auto-renew vs manual.

**Disagreements retained as Open Decisions:**

- OD2: labor. Codex: exclude labor dollars. Opus: opt-in uniform rate.
- OD6: ticket backlog. Codex: fourth wave with observed trends now. Opus: split the whole thing.
- OD8: `contracts.source_quote_id`. Codex: add it. Opus: defer.

**Spec review round** (one independent Sonnet reviewer; findings checked against code before acting). It reported 10 findings, and 8 were adopted:

- the per-contract `resolveContractMrrRows` shape;
- how a `billed_final_term` is valued, because its block is retired at expiry;
- reconciliation defined as the complement of the in-term predicate;
- `line_total` as revenue;
- the service-only effective-rate numerator, plus the completed-entries rule;
- pre-tax quote values and the lineage depth guard;
- quote-accepted `manual` lines with a catalog item classified as product;
- each wave's Open Decision dependencies.

Two were refuted with evidence:

- The `hour_block` arm does exist in `resolveLineQty`, and no `HOUR_BLOCK_NOT_ENABLED` throw exists.
- `INVOICES_READ` does return `cost_basis`, via `getInvoice`.
